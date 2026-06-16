// M21 — integration tests for per-phase tool/test telemetry persistence (additive capture).

import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  persistPhaseToolTelemetry,
  PHASE_TELEMETRY_FILES,
} from "./run_stage5_vexp_swe_bench_smoke";
import { parseOrderedToolCalls } from "../../src/capsule/toolCallLog";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "m21-")); }

const STREAM = [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "python -m pytest tests/test_x.py::test_y -xvs" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 passed", is_error: false }] } }),
].join("\n") + "\n";

// 1. Stream copy persists the first-pass stream + enriched/test artifacts per label.
test("first-pass: stream copy + enriched tool calls + test commands are persisted", async () => {
  const dir = await tmp();
  const meta = await persistPhaseToolTelemetry(dir, STREAM, "first_pass");
  const files = await readdir(dir);
  assert.ok(files.includes(PHASE_TELEMETRY_FILES.first_pass.stream));
  assert.ok(files.includes(PHASE_TELEMETRY_FILES.first_pass.toolCalls));
  assert.ok(files.includes(PHASE_TELEMETRY_FILES.first_pass.testCommands));
  // stream copied byte-for-byte
  assert.equal(await readFile(path.join(dir, PHASE_TELEMETRY_FILES.first_pass.stream), "utf8"), STREAM);
  // enriched call carries the captured output
  const calls = JSON.parse(await readFile(path.join(dir, PHASE_TELEMETRY_FILES.first_pass.toolCalls), "utf8"));
  assert.equal(calls[0].output, "1 passed");
  assert.equal(calls[0].phase, "first_pass");
  // derived test command recorded with conservative patch state
  const tests = JSON.parse(await readFile(path.join(dir, PHASE_TELEMETRY_FILES.first_pass.testCommands), "utf8"));
  assert.equal(tests.length, 1);
  assert.equal(tests[0].testFramework, "pytest");
  assert.deepEqual(tests[0].selectedTests, ["tests/test_x.py::test_y"]);
  assert.equal(tests[0].patchState, "first_pass_before_model_patch");
  assert.equal(meta.testCommandCount, 1);
  assert.equal(meta.toolCallsWithOutput, 1);
});

// 2. Revision stream is persisted under SEPARATE, revision-named artifacts.
test("revision-phase: telemetry persisted under separate file names", async () => {
  const dir = await tmp();
  await persistPhaseToolTelemetry(dir, STREAM, "pivot_revision");
  const files = await readdir(dir);
  assert.ok(files.includes(PHASE_TELEMETRY_FILES.pivot_revision.stream));
  assert.ok(files.includes(PHASE_TELEMETRY_FILES.pivot_revision.toolCalls));
  assert.ok(files.includes(PHASE_TELEMETRY_FILES.pivot_revision.testCommands));
  // names are distinct from the first-pass set (no collision)
  assert.notEqual(PHASE_TELEMETRY_FILES.pivot_revision.stream, PHASE_TELEMETRY_FILES.first_pass.stream);
  assert.notEqual(PHASE_TELEMETRY_FILES.pivot_revision.toolCalls, PHASE_TELEMETRY_FILES.first_pass.toolCalls);
  const tests = JSON.parse(await readFile(path.join(dir, PHASE_TELEMETRY_FILES.pivot_revision.testCommands), "utf8"));
  assert.equal(tests[0].phase, "pivot_revision");
  assert.equal(tests[0].patchState, "revision_phase_before_revised_patch");
});

// 11. Existing ordered tool-call telemetry remains backward compatible and SEPARATE.
test("existing _tool_calls.json schema is untouched (additive artifacts only)", async () => {
  // The legacy parser still yields the documented OrderedToolCall shape.
  const ordered = parseOrderedToolCalls(STREAM);
  assert.equal(ordered.length, 1);
  assert.deepEqual(Object.keys(ordered[0]!).sort(), ["args", "category", "index", "output_summary", "path", "query", "tool"]);
  // The new artifacts use different file names, so they never overwrite `_tool_calls.json`.
  const dir = await tmp();
  await writeFile(path.join(dir, "_tool_calls.json"), "[]\n");
  await persistPhaseToolTelemetry(dir, STREAM, "first_pass");
  assert.equal(await readFile(path.join(dir, "_tool_calls.json"), "utf8"), "[]\n"); // unchanged
  assert.notEqual(PHASE_TELEMETRY_FILES.first_pass.toolCalls, "_tool_calls.json");
});

// Best-effort: empty stream ⇒ no files written, no throw.
test("empty stream is handled honestly (no artifacts, no throw)", async () => {
  const dir = await tmp();
  const meta = await persistPhaseToolTelemetry(dir, "", "first_pass");
  assert.equal(meta.phaseStreamFile, null);
  assert.equal(meta.toolCallCount, 0);
  assert.deepEqual(await readdir(dir), []);
});
