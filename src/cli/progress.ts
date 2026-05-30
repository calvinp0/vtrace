export type ProgressEvent =
  | { kind: "phase_begin"; phase: string; label: string; total?: number }
  | { kind: "phase_progress"; phase: string; index: number; total: number; item?: string }
  | { kind: "phase_end"; phase: string; note?: string }
  | { kind: "done"; summary?: string };

export interface ProgressReporter {
  report(event: ProgressEvent): void;
}

export const nullProgressReporter: ProgressReporter = {
  report(): void {},
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GLYPH_SUCCESS = "✔";
const GLYPH_BAR_FULL = "█";
const GLYPH_BAR_EMPTY = "░";
const BAR_WIDTH = 30;
const LABEL_COLUMN_WIDTH = 28;
const SPINNER_INTERVAL_MS = 80;

export interface RendererClock {
  setInterval: (cb: () => void, ms: number) => { stop: () => void };
}

const defaultClock: RendererClock = {
  setInterval: (cb, ms) => {
    const id = setInterval(cb, ms);
    const maybeUnref = (id as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") {
      maybeUnref.call(id);
    }
    return { stop: () => clearInterval(id) };
  },
};

/**
 * Gate logic for deciding whether progress should be written to stderr.
 *
 * Defaults preserve CLI-terminal behavior exactly:
 *   - JSON mode: suppress (stdout must stay machine-parseable without stderr interleaving).
 *   - `quiet` flag or VTRACE_NO_PROGRESS=1: suppress (explicit opt-out).
 *   - No TTY on stderr: suppress (don't spam pipes, CI, or other non-interactive consumers).
 *
 * The VTRACE_PROGRESS_STREAM=1 escape hatch forces progress on when stderr is not a TTY,
 * so that a parent process (e.g. the VS Code extension spawning via pipes) can stream
 * per-phase/per-file progress by opting in explicitly. Terminal users never set this
 * var, so their experience is byte-identical to today.
 */
export function selectProgressReporter(input: {
  stream: NodeJS.WritableStream & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  isJsonOutput?: boolean;
  quiet?: boolean;
  now?: () => number;
  clock?: RendererClock;
}): ProgressReporter {
  const isTTY = input.stream.isTTY === true;
  const forceStream = input.env.VTRACE_PROGRESS_STREAM === "1";
  const disabled = (input.isJsonOutput === true)
    || input.quiet === true
    || input.env.VTRACE_NO_PROGRESS === "1"
    || (!isTTY && !forceStream);

  if (disabled) {
    return nullProgressReporter;
  }

  return createCliProgressReporter({
    stream: input.stream,
    isTTY,
    now: input.now,
    clock: input.clock,
  });
}

export function createCliProgressReporter(options: {
  stream: NodeJS.WritableStream;
  isTTY: boolean;
  now?: () => number;
  clock?: RendererClock;
}): ProgressReporter {
  if (options.isTTY) {
    return createFancyTtyReporter({
      stream: options.stream,
      clock: options.clock ?? defaultClock,
    });
  }

  return createPlainStreamReporter({ stream: options.stream });
}

// --- Non-TTY plain reporter --------------------------------------------------
//
// Newline-delimited, no ANSI escapes, no \r updates. The VS Code extension
// reads this stream and depends on the per-line shape; do not change it.

export interface ProgressRenderState {
  lastIndex: number;
  lastPhase: string | null;
}

export interface ShouldEmitInput {
  state: Readonly<ProgressRenderState>;
  event: ProgressEvent;
}

export function shouldEmitPlain(input: ShouldEmitInput): boolean {
  const { event, state } = input;

  if (event.kind !== "phase_progress") {
    return true;
  }

  if (event.phase !== state.lastPhase) {
    return true;
  }

  if (event.index === event.total) {
    return true;
  }

  const countStep = Math.max(1, Math.ceil(event.total / 100));
  const countGap = event.index - state.lastIndex;
  return countGap >= countStep;
}

function createPlainStreamReporter(options: {
  stream: NodeJS.WritableStream;
}): ProgressReporter {
  const state: ProgressRenderState = {
    lastIndex: 0,
    lastPhase: null,
  };

  return {
    report(event) {
      if (!shouldEmitPlain({ state, event })) {
        return;
      }

      options.stream.write(`${formatPlainLine(event)}\n`);

      state.lastPhase = "phase" in event ? event.phase : state.lastPhase;
      state.lastIndex = event.kind === "phase_progress" ? event.index : 0;
    },
  };
}

function formatPlainLine(event: ProgressEvent): string {
  switch (event.kind) {
    case "phase_begin":
      return event.total === undefined
        ? `==> ${event.label}`
        : `==> ${event.label} (${event.total} items)`;
    case "phase_progress": {
      const suffix = event.item === undefined ? "" : `  ${event.item}`;
      return `    [${event.phase}] ${event.index}/${event.total}${suffix}`;
    }
    case "phase_end":
      return event.note === undefined
        ? `    done: ${event.phase}`
        : `    done: ${event.phase} (${event.note})`;
    case "done":
      return event.summary === undefined ? "==> complete" : `==> ${event.summary}`;
  }
}

// --- TTY fancy reporter ------------------------------------------------------
//
// Interactive layout:
//   - Phases with a known total show a progress bar redrawn in place.
//   - Phases with an unknown total show a spinner ticked by the injected clock.
//   - On phase_end, the line is finalized with a check glyph and committed
//     with a newline.

interface ActivePhase {
  readonly phase: string;
  readonly label: string;
  total: number | undefined;
  index: number;
  item: string | undefined;
  frame: number;
  ticker?: { stop: () => void };
}

function createFancyTtyReporter(options: {
  stream: NodeJS.WritableStream;
  clock: RendererClock;
}): ProgressReporter {
  const { stream, clock } = options;
  let active: ActivePhase | null = null;

  const redrawActive = (): void => {
    if (active === null) {
      return;
    }
    stream.write(`\r[2K${renderActiveLine(active)}`);
  };

  const finalizeActive = (note: string | undefined): void => {
    if (active === null) {
      return;
    }
    if (active.ticker !== undefined) {
      active.ticker.stop();
      active.ticker = undefined;
    }
    stream.write(`\r[2K${renderCompletedLine(active, note)}\n`);
    active = null;
  };

  return {
    report(event) {
      switch (event.kind) {
        case "phase_begin": {
          // If an earlier phase never closed, close it implicitly so the
          // cursor lands on a clean line before the new phase opens.
          if (active !== null) {
            finalizeActive(undefined);
          }
          active = {
            phase: event.phase,
            label: event.label,
            total: event.total,
            index: 0,
            item: undefined,
            frame: 0,
          };
          redrawActive();
          if (event.total === undefined) {
            const ticker = clock.setInterval(() => {
              if (active === null) {
                return;
              }
              active.frame = (active.frame + 1) % SPINNER_FRAMES.length;
              redrawActive();
            }, SPINNER_INTERVAL_MS);
            active.ticker = ticker;
          }
          return;
        }
        case "phase_progress": {
          if (active === null || active.phase !== event.phase) {
            return;
          }
          active.index = event.index;
          active.total = event.total;
          active.item = event.item;
          // Advance the frame so the spinner-glyph used in the prefix
          // visibly updates alongside the bar fill, even on very fast runs.
          active.frame = (active.frame + 1) % SPINNER_FRAMES.length;
          redrawActive();
          return;
        }
        case "phase_end": {
          if (active === null || active.phase !== event.phase) {
            // Stale phase_end (e.g., for a phase that was never opened in
            // this reporter). Ignore to avoid corrupting the active line.
            return;
          }
          finalizeActive(event.note);
          return;
        }
        case "done": {
          if (active !== null) {
            finalizeActive(undefined);
          }
          if (event.summary !== undefined) {
            stream.write(`${event.summary}\n`);
          }
          return;
        }
      }
    },
  };
}

function renderActiveLine(active: ActivePhase): string {
  const spinner = SPINNER_FRAMES[active.frame % SPINNER_FRAMES.length];
  const label = padLabel(active.label);

  if (active.total === undefined || active.total === 0) {
    return `${spinner} ${label}`;
  }

  const bar = renderBar(active.index, active.total);
  const count = `${formatCount(active.index)}/${formatCount(active.total)}`;
  return `${spinner} ${label} ${bar} ${count}`;
}

function renderCompletedLine(
  active: ActivePhase,
  note: string | undefined,
): string {
  const label = padLabel(active.label);
  const noteText = note === undefined ? "" : ` ${note}`;
  return `${GLYPH_SUCCESS} ${label}${noteText}`;
}

function renderBar(index: number, total: number): string {
  if (total <= 0) {
    return GLYPH_BAR_EMPTY.repeat(BAR_WIDTH);
  }
  const clampedIndex = Math.max(0, Math.min(index, total));
  const filled = Math.round((clampedIndex / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return `${GLYPH_BAR_FULL.repeat(filled)}${GLYPH_BAR_EMPTY.repeat(empty)}`;
}

function padLabel(label: string): string {
  if (label.length >= LABEL_COLUMN_WIDTH) {
    return label;
  }
  return `${label}${" ".repeat(LABEL_COLUMN_WIDTH - label.length)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
