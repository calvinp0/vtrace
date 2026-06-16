// M21 — pure tests for enriched tool-call + test-command capture.

import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  parseEnrichedToolCalls,
  deriveTestCommands,
  classifyTestFramework,
  isTestCommand,
  extractSelectedTests,
  clipToBytes,
  OUTPUT_MAX_BYTES,
  OUTPUT_SUMMARY_MAX_BYTES,
} from "./toolOutputCapture";

// Build a stream where a tool_result is NESTED in a `user` event (the real adapter shape).
function streamWith(command: string, resultContent: string | null, isError?: boolean): string {
  const id = "toolu_abc123";
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  }));
  if (resultContent !== null) {
    const block: Record<string, unknown> = { type: "tool_result", tool_use_id: id, content: resultContent };
    if (isError !== undefined) block.is_error = isError;
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [block] } }));
  }
  return lines.join("\n") + "\n";
}

// 3. Parser extracts Bash command + output from a nested tool_result.
test("parser extracts Bash command output from a synthetic stream with nested tool_result", () => {
  const stream = streamWith("python -m pytest tests/test_x.py::test_y -xvs", "1 passed in 0.3s", false);
  const calls = parseEnrichedToolCalls(stream, "first_pass");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, "Bash");
  assert.equal(calls[0]!.command, "python -m pytest tests/test_x.py::test_y -xvs");
  assert.equal(calls[0]!.output, "1 passed in 0.3s");
  assert.equal(calls[0]!.outputSummary, "1 passed in 0.3s");
  assert.equal(calls[0]!.success, true); // is_error=false ⇒ success
  assert.equal(calls[0]!.truncated, false);
});

// 4. Parser bounds/truncates long output.
test("parser bounds and truncates long output", () => {
  const big = "x".repeat(OUTPUT_MAX_BYTES + 5000);
  const calls = parseEnrichedToolCalls(streamWith("pytest", big), "first_pass");
  const c = calls[0]!;
  assert.equal(c.truncated, true);
  assert.ok(Buffer.byteLength(c.output ?? "", "utf8") <= OUTPUT_MAX_BYTES);
  assert.ok(Buffer.byteLength(c.outputSummary ?? "", "utf8") <= OUTPUT_SUMMARY_MAX_BYTES);
});

// 5. Parser handles missing output gracefully.
test("parser handles missing output gracefully", () => {
  const calls = parseEnrichedToolCalls(streamWith("pytest tests/test_x.py", null), "first_pass");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.output, null);
  assert.equal(calls[0]!.outputSummary, null);
  assert.equal(calls[0]!.success, null); // no is_error ⇒ unknown, not guessed
  assert.equal(calls[0]!.exitCode, null);
});

// 6. pytest command is classified as a test command.
test("pytest command is classified as a test command", () => {
  assert.equal(classifyTestFramework("python -m pytest tests/test_x.py"), "pytest");
  assert.equal(classifyTestFramework("pytest -k foo"), "pytest");
  assert.equal(isTestCommand("python -m pytest tests/test_x.py"), true);
  // other frameworks
  assert.equal(classifyTestFramework("python -m unittest pkg.tests.test_x"), "unittest");
  assert.equal(classifyTestFramework("tox -e py39"), "tox");
  assert.equal(classifyTestFramework("bun test"), "bun");
  assert.equal(classifyTestFramework("npm run test"), "npm");
  assert.equal(classifyTestFramework("cargo test"), "cargo");
  assert.equal(classifyTestFramework("go test ./..."), "go");
});

// 7. python -m pytest selected test path is extracted.
test("python -m pytest selected test path is extracted", () => {
  const cmd = "python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs";
  assert.deepEqual(extractSelectedTests(cmd, "pytest"), ["tests/test_domain_py.py::test_parse_annotation"]);
  // a plain test file path (no node id) is also captured
  assert.deepEqual(extractSelectedTests("pytest tests/test_x.py", "pytest"), ["tests/test_x.py"]);
});

// 8. non-test Bash command is not classified as a test.
test("non-test Bash command is not classified as a test", () => {
  assert.equal(classifyTestFramework("git diff"), "unknown");
  assert.equal(isTestCommand("git diff"), false);
  assert.equal(isTestCommand("python -c \"print(1)\""), false);
  const calls = parseEnrichedToolCalls(streamWith("git diff", "diff output"), "first_pass");
  assert.equal(deriveTestCommands(calls).length, 0);
});

// 9. revision-phase test command gets phase=pivot_revision.
test("revision-phase test command gets phase=pivot_revision", () => {
  const calls = parseEnrichedToolCalls(streamWith("pytest tests/test_x.py", "1 passed", false), "pivot_revision");
  const events = deriveTestCommands(calls);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.phase, "pivot_revision");
  assert.equal(events[0]!.testFramework, "pytest");
  assert.equal(events[0]!.success, true);
});

// 10. patchState is conservative ("before"/phase-derived), never asserts an "after" state.
test("patchState is conservative and never claims a verified final patch", () => {
  const fp = deriveTestCommands(parseEnrichedToolCalls(streamWith("pytest a/test_x.py", "ok"), "first_pass"));
  assert.equal(fp[0]!.patchState, "first_pass_before_model_patch");
  const rev = deriveTestCommands(parseEnrichedToolCalls(streamWith("pytest a/test_x.py", "ok"), "pivot_revision"));
  assert.equal(rev[0]!.patchState, "revision_phase_before_revised_patch");
  for (const e of [...fp, ...rev]) assert.ok(!e.patchState.includes("after"));
});

// Extra: clipToBytes is byte-accurate.
test("clipToBytes clips by UTF-8 bytes and flags truncation", () => {
  assert.deepEqual(clipToBytes("abc", 10), { value: "abc", truncated: false });
  const r = clipToBytes("abcdef", 3);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.value, "utf8") <= 3);
});

// Extra: tool_result matched by id even when interleaved out of order.
test("tool_result is matched to tool_use by id", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "id1", name: "Bash", input: { command: "pytest a" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "id2", name: "Read", input: { file_path: "/f.py" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "id1", content: "PYTEST OUT" }] } }),
  ].join("\n");
  const calls = parseEnrichedToolCalls(lines, "first_pass");
  const bash = calls.find((c) => c.tool === "Bash")!;
  assert.equal(bash.output, "PYTEST OUT");
  assert.equal(calls.find((c) => c.tool === "Read")!.output, null);
});
