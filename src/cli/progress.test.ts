import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  nullProgressReporter,
  selectProgressReporter,
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

test("selectProgressReporter returns nullProgressReporter when VEXB_NO_PROGRESS=1 even on a TTY", () => {
  const stream = makeFakeStream({ isTTY: true });
  const reporter = selectProgressReporter({
    stream,
    env: { VEXB_NO_PROGRESS: "1" },
  });

  assert.equal(reporter, nullProgressReporter);
});

test("selectProgressReporter returns nullProgressReporter when stderr is not a TTY and VEXB_PROGRESS_STREAM is unset", () => {
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

test("VEXB_PROGRESS_STREAM=1 forces progress on even when stderr is not a TTY, using newline-delimited output", () => {
  const stream = makeFakeStream({ isTTY: false });
  const reporter = selectProgressReporter({
    stream,
    env: { VEXB_PROGRESS_STREAM: "1" },
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

test("VEXB_PROGRESS_STREAM=1 does NOT override VEXB_NO_PROGRESS=1 or --json (stronger opt-outs win)", () => {
  const streamOne = makeFakeStream({ isTTY: false });
  const reporterNoProgress = selectProgressReporter({
    stream: streamOne,
    env: { VEXB_PROGRESS_STREAM: "1", VEXB_NO_PROGRESS: "1" },
  });
  assert.equal(reporterNoProgress, nullProgressReporter);

  const streamTwo = makeFakeStream({ isTTY: false });
  const reporterJson = selectProgressReporter({
    stream: streamTwo,
    env: { VEXB_PROGRESS_STREAM: "1" },
    isJsonOutput: true,
  });
  assert.equal(reporterJson, nullProgressReporter);
});

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
