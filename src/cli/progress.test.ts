import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createCliProgressReporter,
  nullProgressReporter,
  selectProgressReporter,
  type RendererClock,
} from "./progress";

test("selectProgressReporter returns nullProgressReporter for JSON output", () => {
  const stream = makeFakeStream({ isTTY: true });
  const reporter = selectProgressReporter({
    stream,
    env: {},
    isJsonOutput: true,
  });

  assert.equal(reporter, nullProgressReporter);
});

test("selectProgressReporter returns nullProgressReporter when VTRACE_NO_PROGRESS=1 even on a TTY", () => {
  const stream = makeFakeStream({ isTTY: true });
  const reporter = selectProgressReporter({
    stream,
    env: { VTRACE_NO_PROGRESS: "1" },
  });

  assert.equal(reporter, nullProgressReporter);
});

test("selectProgressReporter returns nullProgressReporter when stderr is not a TTY and VTRACE_PROGRESS_STREAM is unset", () => {
  const stream = makeFakeStream({ isTTY: false });
  const reporter = selectProgressReporter({
    stream,
    env: {},
  });

  assert.equal(reporter, nullProgressReporter);
});

test("selectProgressReporter returns an active reporter when stderr is a TTY", () => {
  const stream = makeFakeStream({ isTTY: true });
  const reporter = selectProgressReporter({
    stream,
    env: {},
  });

  assert.notEqual(reporter, nullProgressReporter);

  reporter.report({ kind: "phase_begin", phase: "parse", label: "Parsing", total: 3 });
  assert.match(stream.written, /Parsing/);
});

test("VTRACE_PROGRESS_STREAM=1 forces progress on even when stderr is not a TTY, using newline-delimited output", () => {
  const stream = makeFakeStream({ isTTY: false });
  const reporter = selectProgressReporter({
    stream,
    env: { VTRACE_PROGRESS_STREAM: "1" },
  });

  assert.notEqual(reporter, nullProgressReporter);

  reporter.report({ kind: "phase_begin", phase: "parse", label: "Parsing files", total: 2 });
  reporter.report({ kind: "phase_end", phase: "parse", note: "ok" });

  // Non-TTY mode MUST use newline-delimited lines (no \r carriage returns, no ANSI codes) —
  // otherwise the VS Code extension's line-buffered reader will never see discrete lines.
  assert.ok(stream.written.includes("\n"), "non-TTY output must be newline-delimited");
  assert.doesNotMatch(stream.written, /\r/, "non-TTY output must not use carriage-return updates");
  assert.doesNotMatch(stream.written, /\[/u, "non-TTY output must not emit ANSI escape codes");
  assert.match(stream.written, /Parsing files/);
  assert.match(stream.written, /done: parse/);
});

test("VTRACE_PROGRESS_STREAM=1 does NOT override VTRACE_NO_PROGRESS=1 or --json (stronger opt-outs win)", () => {
  const streamOne = makeFakeStream({ isTTY: false });
  const reporterNoProgress = selectProgressReporter({
    stream: streamOne,
    env: { VTRACE_PROGRESS_STREAM: "1", VTRACE_NO_PROGRESS: "1" },
  });
  assert.equal(reporterNoProgress, nullProgressReporter);

  const streamTwo = makeFakeStream({ isTTY: false });
  const reporterJson = selectProgressReporter({
    stream: streamTwo,
    env: { VTRACE_PROGRESS_STREAM: "1" },
    isJsonOutput: true,
  });
  assert.equal(reporterJson, nullProgressReporter);
});

test("selectProgressReporter suppresses progress when quiet=true even on a TTY", () => {
  const stream = makeFakeStream({ isTTY: true });
  const reporter = selectProgressReporter({
    stream,
    env: {},
    quiet: true,
  });

  assert.equal(reporter, nullProgressReporter);
});

test("fancy TTY reporter renders spinner + progress bar + check glyph for known totals", () => {
  const stream = makeFakeStream({ isTTY: true });
  const clock = makeStubClock();
  const reporter = createCliProgressReporter({
    stream,
    isTTY: true,
    clock,
  });

  reporter.report({ kind: "phase_begin", phase: "parse", label: "Parsing files", total: 4 });
  reporter.report({ kind: "phase_progress", phase: "parse", index: 1, total: 4 });
  reporter.report({ kind: "phase_progress", phase: "parse", index: 4, total: 4 });
  reporter.report({ kind: "phase_end", phase: "parse", note: "done: 4 parsed" });

  // Progress bar uses full + empty glyphs from a known set.
  assert.match(stream.written, /█/, "expected bar fill glyph");
  assert.match(stream.written, /░/, "expected bar empty glyph");
  assert.match(stream.written, /4\/4/, "expected current/total count");
  // A spinner glyph from the braille set is drawn at phase begin.
  assert.match(stream.written, /[⠇⠠⡀⢀⠋⠙⠹⡹⡶⡧]/u);
  // phase_end commits with the success glyph and the user-supplied note.
  assert.match(stream.written, /✔ Parsing files\s+done: 4 parsed/);
  // Output uses inline redraws, not a stream of newline-delimited bar frames.
  assert.equal(countOccurrences(stream.written, "\n"), 1);
  // Spinner ticker is cleaned up by phase_end.
  assert.equal(clock.activeTickerCount, 0);
});

test("fancy TTY reporter shows a spinner for unknown-total phases and stops it on phase_end", () => {
  const stream = makeFakeStream({ isTTY: true });
  const clock = makeStubClock();
  const reporter = createCliProgressReporter({
    stream,
    isTTY: true,
    clock,
  });

  reporter.report({ kind: "phase_begin", phase: "resolve", label: "Resolving imports" });
  assert.equal(clock.activeTickerCount, 1, "spinner ticker starts when total is unknown");

  // Advance two spinner ticks.
  clock.tickAll();
  clock.tickAll();
  reporter.report({ kind: "phase_end", phase: "resolve", note: "ok" });

  assert.match(stream.written, /Resolving imports/);
  assert.match(stream.written, /✔ Resolving imports\s+ok/);
  assert.equal(clock.activeTickerCount, 0, "phase_end must stop the spinner ticker");
});

test("fancy TTY reporter writes a `done` summary as a separate committed line", () => {
  const stream = makeFakeStream({ isTTY: true });
  const reporter = createCliProgressReporter({
    stream,
    isTTY: true,
    clock: makeStubClock(),
  });

  reporter.report({ kind: "phase_begin", phase: "scan", label: "Scanning", total: 1 });
  reporter.report({ kind: "phase_end", phase: "scan", note: "1 file" });
  reporter.report({ kind: "done", summary: "index complete" });

  assert.match(stream.written, /index complete\n$/);
});

interface StubClock extends RendererClock {
  tickAll: () => void;
  activeTickerCount: number;
}

function makeStubClock(): StubClock {
  const tickers: Array<{ cb: () => void; active: boolean }> = [];

  return {
    setInterval(cb) {
      const entry = { cb, active: true };
      tickers.push(entry);
      return {
        stop: () => {
          entry.active = false;
        },
      };
    },
    tickAll(): void {
      for (const t of tickers) {
        if (t.active) {
          t.cb();
        }
      }
    },
    get activeTickerCount(): number {
      return tickers.filter((t) => t.active).length;
    },
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function makeFakeStream(options: { isTTY: boolean }) {
  const state = { written: "", isTTY: options.isTTY };
  return {
    get written() { return state.written; },
    isTTY: state.isTTY,
    write(chunk: string | Uint8Array) {
      state.written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  };
}
