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

/**
 * Gate logic for deciding whether progress should be written to stderr.
 *
 * Defaults preserve CLI-terminal behavior exactly:
 *   - JSON mode: suppress (stdout must stay machine-parseable without stderr interleaving).
 *   - VTRACE_NO_PROGRESS=1: suppress (existing explicit opt-out).
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
  now?: () => number;
}): ProgressReporter {
  const isTTY = input.stream.isTTY === true;
  const forceStream = input.env.VTRACE_PROGRESS_STREAM === "1";
  const disabled = (input.isJsonOutput === true)
    || input.env.VTRACE_NO_PROGRESS === "1"
    || (!isTTY && !forceStream);

  if (disabled) {
    return nullProgressReporter;
  }

  return createCliProgressReporter({
    stream: input.stream,
    isTTY,
    now: input.now,
  });
}

export interface ProgressRenderState {
  lastEmitMs: number;
  lastIndex: number;
  lastPhase: string | null;
  lastKind: ProgressEvent["kind"] | null;
}

export interface ShouldEmitInput {
  state: Readonly<ProgressRenderState>;
  event: ProgressEvent;
  nowMs: number;
  isTTY: boolean;
}

/**
 * Throttle policy for progress emissions.
 *
 * Trade-offs:
 *   - Emit every event: most responsive, spams non-TTY logs (CI, pipes).
 *   - Long time gap: feels laggy on slow hardware, stutters on fast machines.
 *   - Every Nth item: counter visibly advances but may skip the last < N items.
 *
 * Phase boundaries (phase_begin, phase_end, done) MUST always emit — they form
 * the skeleton of the output. Only `phase_progress` events are throttled here.
 */
export function shouldEmit(input: ShouldEmitInput): boolean {
  const { event, state, nowMs } = input;

  if (event.kind !== "phase_progress") {
    return true;
  }

  if (event.phase !== state.lastPhase) {
    return true;
  }

  if (event.index === event.total) {
    return true;
  }

  const timeGapMs = nowMs - state.lastEmitMs;
  const countStep = Math.max(1, Math.ceil(event.total / 100));
  const countGap = event.index - state.lastIndex;
  return timeGapMs >= 50 || countGap >= countStep;
}

export function createCliProgressReporter(options: {
  stream: NodeJS.WritableStream;
  isTTY: boolean;
  now?: () => number;
}): ProgressReporter {
  const state: ProgressRenderState = {
    lastEmitMs: 0,
    lastIndex: 0,
    lastPhase: null,
    lastKind: null,
  };
  const now = options.now ?? Date.now;
  const { stream, isTTY } = options;

  return {
    report(event) {
      const nowMs = now();

      if (!shouldEmit({ state, event, nowMs, isTTY })) {
        return;
      }

      const line = formatEvent(event);

      if (isTTY) {
        const needsNewline =
          state.lastKind === "phase_progress" && event.kind !== "phase_progress";
        if (needsNewline) {
          stream.write("\n");
        }
        stream.write(`\r\u001B[2K${line}`);
        if (event.kind !== "phase_progress") {
          stream.write("\n");
        }
      } else {
        stream.write(`${line}\n`);
      }

      state.lastEmitMs = nowMs;
      state.lastKind = event.kind;
      state.lastPhase = "phase" in event ? event.phase : state.lastPhase;
      if (event.kind === "phase_progress") {
        state.lastIndex = event.index;
      } else {
        state.lastIndex = 0;
      }
    },
  };
}

function formatEvent(event: ProgressEvent): string {
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
