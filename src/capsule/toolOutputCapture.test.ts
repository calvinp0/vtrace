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

// ===== M22 — test-output semantics, provenance, patch-state =====
import {
  parsePytestOutcome,
  outcomeMismatch,
  classifyTestProvenance,
  classifyTestPatchState,
} from "./toolOutputCapture";

// 1. FAILURES section ⇒ failed.
test("pytest output with FAILURES parses as failed", () => {
  const out = "test session starts\n=================================== FAILURES ===================================\n_ test_x _\nassert 1 == 2\n=========================== 1 failed in 0.10s ============================";
  const r = parsePytestOutcome(out);
  assert.equal(r.status, "failed");
  assert.equal(r.confidence, "high");
});

// 2. ERRORS section / N errors ⇒ error.
test("pytest output with ERRORS parses as error", () => {
  const out = "==================================== ERRORS ====================================\n_ ERROR collecting test_x.py _\n=========================== 1 error in 0.05s ============================";
  assert.equal(parsePytestOutcome(out).status, "error");
});

// 3. Traceback / ImportError ⇒ error (the M21.1 real case).
test("pytest output with Traceback/ImportError parses as error", () => {
  const out = "Traceback (most recent call last):\n  ...\nImportError: cannot import name 'environmentfilter' from 'jinja2'";
  const r = parsePytestOutcome(out);
  assert.equal(r.status, "error");
  assert.equal(r.confidence, "high");
  assert.ok(r.evidence.some((e) => e.includes("ImportError") || e.includes("Traceback")));
});

// 4. "passed" summary ⇒ passed.
test("pytest output with passed summary parses as passed", () => {
  const out = "tests/test_x.py::test_y PASSED\n=========================== 1 passed in 0.20s ============================";
  assert.equal(parsePytestOutcome(out).status, "passed");
});

// 5. Pipeline-masked: raw success=true but failure output ⇒ classified failed/error + mismatch.
test("pipeline-masked success=true with failure output is classified failed/error", () => {
  const out = "Traceback (most recent call last):\nImportError: boom";
  const parsed = parsePytestOutcome(out);
  assert.ok(parsed.status === "error" || parsed.status === "failed");
  assert.equal(outcomeMismatch(true, parsed), true); // raw success disagrees
  assert.equal(outcomeMismatch(false, parsed), false); // no mismatch when raw already failing
});

// 6. Truncated ambiguous output ⇒ unknown or failed_or_error (never pass).
test("truncated ambiguous output is not a pass", () => {
  const r1 = parsePytestOutcome("collecting ... an error occurred while", { truncated: true });
  assert.ok(r1.status === "failed_or_error" || r1.status === "unknown");
  assert.notEqual(r1.status, "passed");
  const r2 = parsePytestOutcome("some neutral text with no summary", { truncated: true });
  assert.equal(r2.status, "unknown");
});

// 7. Raw success is preserved separately from parsed outcome.
test("raw success is preserved separately from parsed outcome", () => {
  // parser never reads success; outcomeMismatch is the only bridge, and both inputs are explicit.
  const parsed = parsePytestOutcome("1 passed in 0.1s");
  assert.equal(parsed.status, "passed");
  assert.equal(outcomeMismatch(true, parsed), false);
  // a null raw success never fabricates a mismatch
  assert.equal(outcomeMismatch(null, parsePytestOutcome("1 failed in 0.1s")), false);
});

// 8. Provenance: exact FAIL_TO_PASS match ⇒ injected_metadata (or ambiguous if also discovered).
test("provenance marks exact FAIL_TO_PASS match as injected_metadata or ambiguous", () => {
  const injected = classifyTestProvenance({
    selectedTests: ["tests/test_domain_py.py::test_parse_annotation"],
    injectedTestNames: ["tests/test_domain_py.py::test_parse_annotation"],
    priorCommandText: ["Read sphinx/domains/python.py", "git diff"],
  });
  assert.equal(injected.classification, "injected_metadata");

  const both = classifyTestProvenance({
    selectedTests: ["tests/test_domain_py.py::test_parse_annotation"],
    injectedTestNames: ["tests/test_domain_py.py::test_parse_annotation"],
    priorCommandText: ["grep -rn test_parse_annotation tests/"],
  });
  assert.equal(both.classification, "ambiguous");

  const discovered = classifyTestProvenance({
    selectedTests: ["tests/test_z.py::test_w"],
    injectedTestNames: ["tests/other.py::test_other"],
    priorCommandText: ["grep -rn test_w tests/test_z.py"],
  });
  assert.equal(discovered.classification, "agent_discovered");

  const none = classifyTestProvenance({ selectedTests: ["a::b"], injectedTestNames: null, priorCommandText: [] });
  assert.equal(none.classification, "unknown");
});

// 9. Patch-state never claims final-patch verification without proof.
test("patch-state classifier never claims final-patch verification", () => {
  const pre = classifyTestPatchState({ phase: "first_pass", editToolBeforeTest: false });
  assert.equal(pre.patchState, "pre_patch_state");
  assert.equal(pre.canVerifyFinalPatch, false);

  const afterEdit = classifyTestPatchState({ phase: "first_pass", editToolBeforeTest: true });
  assert.equal(afterEdit.patchState, "after_observed_edit_state");
  assert.equal(afterEdit.canVerifyFinalPatch, false); // edit observed, still NOT proven final

  const rev = classifyTestPatchState({ phase: "pivot_revision", editToolBeforeTest: true });
  assert.equal(rev.patchState, "revision_phase_state");
  assert.equal(rev.canVerifyFinalPatch, false);
});

// ===== M23 — fair revision verification policy =====
import {
  fairProvenance,
  classifyVerificationPatchState,
  hasEnvironmentFailureMarkers,
  assessFairVerification,
  buildFairVerificationReport,
  classifyTestEnvironmentOutcome,
  type TestCommandEvent,
  type VerificationPolicy,
} from "./toolOutputCapture";

// A passing pytest event over a discovered test, used as the "best case" baseline.
function eventOf(over: Partial<TestCommandEvent> = {}): TestCommandEvent {
  return {
    phase: "pivot_revision",
    command: "pytest tests/test_z.py::test_w -xvs",
    testFramework: "pytest",
    selectedTests: ["tests/test_z.py::test_w"],
    outputSummary: "1 passed in 0.10s",
    exitCode: null,
    success: true,
    patchState: "revision_phase_before_revised_patch",
    parsedOutcome: parsePytestOutcome("1 passed in 0.10s"),
    ...over,
  };
}

// M23-3 / M23-4. Exact FAIL_TO_PASS match ⇒ injected_metadata ⇒ NOT allowed for fair
// verification, even under the opt-in policy.
test("M23: FAIL_TO_PASS-matching selected test is injected_metadata and not fair", () => {
  const a = assessFairVerification({
    policy: "agent_discovered",
    event: eventOf({ selectedTests: ["tests/test_domain_py.py::test_parse_annotation"] }),
    injectedTestNames: ["tests/test_domain_py.py::test_parse_annotation"],
    priorCommandText: ["Read sphinx/domains/python.py", "git diff"], // no discovery of the test
    editToolBeforeTest: true,
  });
  assert.equal(a.verificationProvenance.classification, "injected_metadata");
  assert.equal(a.verificationProvenance.allowedForFairVerification, false);
  assert.ok(typeof a.verificationProvenance.disallowReason === "string");
  assert.equal(a.fairVerificationUsable, false);
  assert.ok(a.fairVerificationBlockers.some((b) => b.includes("injected_metadata")));
});

// M23-4 (unit). fairProvenance maps the four classes to the right allow flag.
test("M23: fairProvenance allows only agent_discovered", () => {
  assert.equal(
    fairProvenance({ classification: "agent_discovered", evidence: [] }).allowedForFairVerification,
    true,
  );
  for (const c of ["injected_metadata", "ambiguous", "unknown"] as const) {
    const p = fairProvenance({ classification: c, evidence: [] });
    assert.equal(p.allowedForFairVerification, false);
    assert.ok(p.disallowReason && p.disallowReason.length > 0);
  }
});

// M23-5. A test discovered via prior grep/read of the repo classifies as agent_discovered.
test("M23: test discovered by prior repo exploration classifies as agent_discovered", () => {
  const a = assessFairVerification({
    policy: "agent_discovered",
    event: eventOf({ selectedTests: ["tests/test_z.py::test_w"] }),
    injectedTestNames: ["tests/other.py::test_other"], // does NOT match the selected test
    priorCommandText: ["grep -rn test_w tests/test_z.py"], // discovery evidence
    editToolBeforeTest: true,
  });
  assert.equal(a.verificationProvenance.classification, "agent_discovered");
  assert.equal(a.verificationProvenance.allowedForFairVerification, true);
  assert.ok(a.verificationProvenance.evidence.length > 0);
});

// M23-6. Ambiguous provenance (matches injected AND discovered) ⇒ not allowed.
test("M23: ambiguous provenance is not allowed for fair verification", () => {
  const a = assessFairVerification({
    policy: "agent_discovered",
    event: eventOf({ selectedTests: ["tests/test_z.py::test_w"] }),
    injectedTestNames: ["tests/test_z.py::test_w"], // matches
    priorCommandText: ["grep -rn test_w tests/test_z.py"], // also discovered ⇒ ambiguous
    editToolBeforeTest: true,
  });
  assert.equal(a.verificationProvenance.classification, "ambiguous");
  assert.equal(a.verificationProvenance.allowedForFairVerification, false);
  assert.equal(a.fairVerificationUsable, false);
});

// M23-7. Parsed outcome passed + agent_discovered, but patch-state cannot verify the final
// patch (no proof) ⇒ still NOT usable.
test("M23: passed + agent_discovered but unverifiable patch-state is not usable", () => {
  const a = assessFairVerification({
    policy: "agent_discovered",
    event: eventOf(), // 1 passed, discovered below
    injectedTestNames: null,
    priorCommandText: ["grep -rn test_w tests/test_z.py"],
    editToolBeforeTest: true,
  });
  assert.equal(a.verificationProvenance.classification, "agent_discovered");
  assert.equal(a.verificationPatchState.canVerifyFinalPatch, false);
  assert.equal(a.fairVerificationUsable, false);
  assert.ok(a.fairVerificationBlockers.some((b) => b.includes("cannot verify the final patch")));
});

// M23-8. A failing/error parsed outcome blocks fair verification.
test("M23: failing/error parsed outcome blocks fair verification", () => {
  const failing = eventOf({
    outputSummary: "1 failed in 0.10s",
    parsedOutcome: parsePytestOutcome("=== FAILURES ===\n1 failed in 0.10s"),
  });
  const a = assessFairVerification({
    policy: "agent_discovered",
    event: failing,
    injectedTestNames: null,
    priorCommandText: ["grep -rn test_w tests/test_z.py"],
    editToolBeforeTest: true,
  });
  assert.equal(a.fairVerificationUsable, false);
  assert.ok(a.fairVerificationBlockers.some((b) => b.includes('not "passed"')));
});

// M23-9. Environment/import failure markers block fair verification.
test("M23: env/import failure evidence blocks fair verification", () => {
  assert.equal(hasEnvironmentFailureMarkers("ImportError: boom").found, true);
  assert.equal(hasEnvironmentFailureMarkers("1 passed in 0.1s").found, false);
  const importErr = eventOf({
    outputSummary: "Traceback (most recent call last):\nImportError: cannot import name 'environmentfilter'",
    parsedOutcome: parsePytestOutcome("Traceback (most recent call last):\nImportError: x"),
  });
  const a = assessFairVerification({
    policy: "agent_discovered",
    event: importErr,
    injectedTestNames: null,
    priorCommandText: ["grep -rn test_w tests/test_z.py"],
    editToolBeforeTest: true,
  });
  assert.equal(a.fairVerificationUsable, false);
  assert.ok(a.fairVerificationBlockers.some((b) => b.includes("environment/import")));
});

// M23-10. final_patch_verified is NEVER emitted without explicit proof+evidence.
test("M23: final_patch_verified requires explicit proof", () => {
  const noProof = classifyVerificationPatchState({ phase: "pivot_revision", editToolBeforeTest: true });
  assert.equal(noProof.classification, "revision_phase_state");
  assert.equal(noProof.canVerifyFinalPatch, false);

  const emptyEvidence = classifyVerificationPatchState({
    phase: "pivot_revision",
    editToolBeforeTest: true,
    finalPatchProof: { applied: true, evidence: ["  "] },
  });
  assert.notEqual(emptyEvidence.classification, "final_patch_verified");
  assert.equal(emptyEvidence.canVerifyFinalPatch, false);

  const proven = classifyVerificationPatchState({
    phase: "pivot_revision",
    editToolBeforeTest: true,
    finalPatchProof: { applied: true, evidence: ["installed revised patch, then ran the test"] },
  });
  assert.equal(proven.classification, "final_patch_verified");
  assert.equal(proven.canVerifyFinalPatch, true);
});

// M23-11. Existing additive test-command artifacts stay backward compatible: deriveTestCommands
// output shape is unchanged (no fair-verification fields leaked into it).
test("M23: deriveTestCommands output shape is unchanged (backward compatible)", () => {
  const calls = parseEnrichedToolCalls(streamWith("pytest tests/test_x.py::test_y", "1 passed", false), "first_pass");
  const events = deriveTestCommands(calls);
  assert.equal(events.length, 1);
  assert.deepEqual(
    Object.keys(events[0]!).sort(),
    ["command", "exitCode", "outputSummary", "parsedOutcome", "patchState", "phase", "selectedTests", "success", "testFramework"],
  );
});

// M23: policy=none always blocks (default behavior carries no fair-verification claim).
test("M23: policy=none yields a not-enabled blocker and is never usable", () => {
  const a = assessFairVerification({
    policy: "none",
    event: eventOf(),
    injectedTestNames: null,
    priorCommandText: ["grep -rn test_w tests/test_z.py"],
    editToolBeforeTest: true,
  });
  assert.equal(a.verificationPolicy, "none");
  assert.equal(a.fairVerificationUsable, false);
  assert.ok(a.fairVerificationBlockers.some((b) => b.includes("policy not enabled")));
});

// M23: buildFairVerificationReport wires prior in-phase exploration into provenance.
test("M23: buildFairVerificationReport derives prior-exploration context per phase", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "g1", name: "Bash", input: { command: "grep -rn test_w tests/test_z.py" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "tests/test_z.py:10:def test_w" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest tests/test_z.py::test_w -xvs" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 passed in 0.1s" }] } }),
  ].join("\n");
  const calls = parseEnrichedToolCalls(lines, "pivot_revision");
  const report = buildFairVerificationReport({ calls, policy: "agent_discovered", injectedTestNames: null });
  assert.equal(report.length, 1);
  assert.equal(report[0]!.assessment.verificationProvenance.classification, "agent_discovered");
  assert.ok(report[0]!.priorCommandText.some((c) => c.includes("grep")));
  // Patch-state still cannot verify the final patch ⇒ not usable today.
  assert.equal(report[0]!.assessment.fairVerificationUsable, false);
});

const _policyTypeCheck: VerificationPolicy = "agent_discovered";
void _policyTypeCheck;

// ===== M28 — strict search→read/output discovery gate =====
import {
  computeDiscoveryEvidence,
  type DiscoveryEvidence,
  type PriorCallSignal,
} from "./toolOutputCapture";

const SELECTED = ["tests/test_z.py::test_w"];

// Helper: classify provenance with structured discovery evidence (the M28 strict path).
function classifyWithDiscovery(
  discoveryEvidence: DiscoveryEvidence,
  injectedTestNames: readonly string[] | null = null,
): ReturnType<typeof classifyTestProvenance> {
  return classifyTestProvenance({
    selectedTests: SELECTED,
    injectedTestNames,
    priorCommandText: [],
    discoveryEvidence,
  });
}

const NO_DISCOVERY: DiscoveryEvidence = {
  priorSearchCommands: [],
  priorReadCommands: [],
  priorOutputsWithTestNode: [],
  matchedTestFiles: [],
  matchedTestNames: [],
};

// M28-6. The M23.1 signature — the agent ran a test it never discovered (no prior search of the
// repo tests) — must NOT classify as agent_discovered under the strict gate.
test("M28: a test command with no test-file discovery is not agent_discovered", () => {
  // No structured discovery at all, but some unrelated exploration happened.
  const p = classifyTestProvenance({
    selectedTests: SELECTED,
    injectedTestNames: ["tests/other.py::test_other"],
    priorCommandText: ["Read sphinx/domains/python.py", "git diff"],
    discoveryEvidence: NO_DISCOVERY,
  });
  assert.notEqual(p.classification, "agent_discovered");
  assert.equal(p.classification, "ambiguous");
  assert.equal(fairProvenance(p).allowedForFairVerification, false);
});

// M28-7. A prior SEARCH over the repo tests followed by a READ of the discovered test file
// classifies as agent_discovered when the selected test is not injected.
test("M28: prior search + read of the relevant test file classifies as agent_discovered", () => {
  const evidence = computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      { command: "grep -rn test_w tests/", path: null, category: "other", output: "tests/test_z.py:10:def test_w" },
      { command: "cat tests/test_z.py", path: null, category: "other", output: "def test_w(): ..." },
    ],
  });
  assert.ok(evidence.priorSearchCommands.length > 0);
  assert.ok(evidence.priorReadCommands.length > 0);
  const p = classifyWithDiscovery(evidence, ["tests/other.py::test_other"]);
  assert.equal(p.classification, "agent_discovered");
  assert.equal(fairProvenance(p).allowedForFairVerification, true);
});

// M28-7b. A Read TOOL (category "read") of the test file, after a search, also satisfies the gate.
test("M28: prior search + Read-tool of the test file classifies as agent_discovered", () => {
  const evidence = computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      { command: "rg test_w", path: null, category: "search", output: null },
      { command: null, path: "tests/test_z.py", category: "read", output: null },
    ],
  });
  const p = classifyWithDiscovery(evidence);
  assert.equal(p.classification, "agent_discovered");
});

// M28-8. A lone weak grep (a search with no subsequent read and no output that surfaced the node)
// stays ambiguous — never agent_discovered, never allowed for fair verification.
test("M28: a weak grep without read/output evidence is ambiguous, not agent_discovered", () => {
  const evidence = computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      // A grep that mentions the test but returned no captured output (no read either).
      { command: "grep -rn test_w tests/test_z.py", path: null, category: "other", output: null },
    ],
  });
  assert.ok(evidence.priorSearchCommands.length > 0);
  assert.equal(evidence.priorReadCommands.length, 0);
  assert.equal(evidence.priorOutputsWithTestNode.length, 0);
  const p = classifyWithDiscovery(evidence);
  assert.equal(p.classification, "ambiguous");
  assert.equal(fairProvenance(p).allowedForFairVerification, false);
});

// M28-9. An exact injected-metadata match is disallowed even when a full discovery chain exists.
test("M28: injected exact match stays disallowed even with discovery evidence", () => {
  const evidence = computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      { command: "grep -rn test_w tests/", path: null, category: "other", output: "tests/test_z.py:10:def test_w" },
      { command: "cat tests/test_z.py", path: null, category: "other", output: "def test_w(): ..." },
    ],
  });
  const p = classifyWithDiscovery(evidence, ["tests/test_z.py::test_w"]); // injected exact match
  assert.notEqual(p.classification, "agent_discovered");
  assert.equal(fairProvenance(p).allowedForFairVerification, false);
});

// M28: buildFairVerificationReport attaches the structured discovery evidence and the strict gate
// credits a search whose OUTPUT surfaced the node (no separate read needed).
test("M28: buildFairVerificationReport attaches discoveryEvidence and credits search+output", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "g1", name: "Bash", input: { command: "grep -rn test_w tests/test_z.py" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "tests/test_z.py:10:def test_w" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest tests/test_z.py::test_w -xvs" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1 passed in 0.1s" }] } }),
  ].join("\n");
  const calls = parseEnrichedToolCalls(lines, "pivot_revision");
  const report = buildFairVerificationReport({ calls, policy: "agent_discovered", injectedTestNames: null });
  assert.equal(report.length, 1);
  assert.equal(report[0]!.assessment.verificationProvenance.classification, "agent_discovered");
  assert.ok(report[0]!.discoveryEvidence.priorSearchCommands.length > 0);
  assert.ok(report[0]!.discoveryEvidence.priorOutputsWithTestNode.length > 0);
});

// M28-12. Backward compatibility: a captured calls array with NO output fields (legacy artifact)
// still derives test commands and a report — discoveryEvidence is simply empty, not a crash.
test("M28: backward compatibility for legacy captured calls without outputs", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest tests/test_x.py::test_y" } }] } }),
  ].join("\n");
  const calls = parseEnrichedToolCalls(lines, "first_pass");
  // deriveTestCommands shape unchanged (no discovery fields leak into the event).
  const events = deriveTestCommands(calls);
  assert.deepEqual(
    Object.keys(events[0]!).sort(),
    ["command", "exitCode", "outputSummary", "parsedOutcome", "patchState", "phase", "selectedTests", "success", "testFramework"],
  );
  // The report builds, with an (empty) discoveryEvidence object present.
  const report = buildFairVerificationReport({ calls, policy: "agent_discovered", injectedTestNames: null });
  assert.equal(report.length, 1);
  const de: DiscoveryEvidence = report[0]!.discoveryEvidence;
  assert.equal(de.priorSearchCommands.length, 0);
  assert.notEqual(report[0]!.assessment.verificationProvenance.classification, "agent_discovered");
  // A legacy direct call with no discoveryEvidence keeps the lenient heuristic (backward compat).
  const legacy = classifyTestProvenance({
    selectedTests: ["tests/test_z.py::test_w"],
    injectedTestNames: null,
    priorCommandText: ["grep -rn test_w tests/test_z.py"],
  });
  assert.equal(legacy.classification, "agent_discovered");
});

// M28: a PriorCallSignal type smoke check (additive shape).
const _priorCallType: PriorCallSignal = { command: null, path: null, category: "other", output: null };
void _priorCallType;

// ===== M28.4 — discovered hidden-match provenance (selected test coincides with a withheld label) =====

const HIDDEN = ["tests/test_z.py::test_w"]; // SELECTED is exactly this node

// Strong discovery: a file-targeted search (references the node) + a read of the test file.
function strongDiscoveryEvidence(): DiscoveryEvidence {
  return computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      { command: "grep -rn test_w tests/", path: null, category: "search", output: "tests/test_z.py:10:def test_w" },
      { command: "cat tests/test_z.py", path: null, category: "read", output: "def test_w(): ..." },
    ],
  });
}

// M28.4-1 / Case A. A prompt-EXPOSED exact label match is injection contamination ⇒ disallowed,
// even when the agent also performed a full discovery chain.
test("M28.4: a prompt-exposed exact label match is injected_metadata and disallowed", () => {
  const p = classifyTestProvenance({
    selectedTests: SELECTED,
    injectedTestNames: HIDDEN,
    priorCommandText: [],
    discoveryEvidence: strongDiscoveryEvidence(),
    promptExposedTestNames: HIDDEN, // the label WAS shown to the agent
  });
  assert.equal(p.classification, "injected_metadata");
  assert.equal(fairProvenance(p).allowedForFairVerification, false);
});

// M28.4-2 / Case B. Hidden match, sanitized (not exposed), NO discovery ⇒ disallowed.
test("M28.4: a sanitized hidden match with no discovery is disallowed", () => {
  const p = classifyTestProvenance({
    selectedTests: SELECTED,
    injectedTestNames: HIDDEN,
    priorCommandText: [],
    discoveryEvidence: NO_DISCOVERY,
    promptExposedTestNames: [], // sanitized: not exposed
  });
  assert.notEqual(p.classification, "agent_discovered_hidden_match");
  assert.equal(fairProvenance(p).allowedForFairVerification, false);
});

// M28.4-3 / Case C. Hidden match, sanitized, broad grep only (searched=false, output only) ⇒ disallowed.
test("M28.4: a sanitized hidden match with broad grep-only discovery stays disallowed", () => {
  const evidence = computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      // Broad grep over a directory: the COMMAND/PATH does not name the node, only the OUTPUT does.
      { command: null, path: "tests", category: "search", output: "tests/test_z.py:10:def test_w" },
    ],
  });
  assert.equal(evidence.priorSearchCommands.length, 0); // not a file-targeted search
  assert.ok(evidence.priorOutputsWithTestNode.length > 0);
  const p = classifyTestProvenance({
    selectedTests: SELECTED,
    injectedTestNames: HIDDEN,
    priorCommandText: [],
    discoveryEvidence: evidence,
    promptExposedTestNames: [],
  });
  assert.notEqual(p.classification, "agent_discovered_hidden_match");
  assert.equal(fairProvenance(p).allowedForFairVerification, false);
});

// M28.4-4 / Case D. Hidden match, sanitized, strong search+read ⇒ agent_discovered_hidden_match, ALLOWED.
test("M28.4: a sanitized hidden match with repo search + test-file read becomes agent_discovered_hidden_match", () => {
  const p = classifyTestProvenance({
    selectedTests: SELECTED,
    injectedTestNames: HIDDEN,
    priorCommandText: [],
    discoveryEvidence: strongDiscoveryEvidence(),
    promptExposedTestNames: [], // sanitized: not exposed
  });
  assert.equal(p.classification, "agent_discovered_hidden_match");
  assert.equal(fairProvenance(p).allowedForFairVerification, true);
});

// M28.4-5. Allowed via search+OUTPUT evidence (strong), but NOT via output alone (weak).
test("M28.4: a sanitized hidden match is allowed only when discovery is strong", () => {
  const strong = computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      { command: "grep -rn test_w tests/", path: null, category: "search", output: "tests/test_z.py:10:def test_w" },
    ],
  });
  const pStrong = classifyTestProvenance({
    selectedTests: SELECTED, injectedTestNames: HIDDEN, priorCommandText: [],
    discoveryEvidence: strong, promptExposedTestNames: [],
  });
  assert.equal(pStrong.classification, "agent_discovered_hidden_match");
  assert.equal(fairProvenance(pStrong).allowedForFairVerification, true);

  const weak = computeDiscoveryEvidence({
    selectedTests: SELECTED,
    priorCalls: [
      { command: null, path: "tests", category: "search", output: "tests/test_z.py:10:def test_w" },
    ],
  });
  const pWeak = classifyTestProvenance({
    selectedTests: SELECTED, injectedTestNames: HIDDEN, priorCommandText: [],
    discoveryEvidence: weak, promptExposedTestNames: [],
  });
  assert.equal(fairProvenance(pWeak).allowedForFairVerification, false);
});

// M28.4-6 / Case E. A non-hidden discovered test stays agent_discovered and allowed.
test("M28.4: a non-hidden discovered test stays agent_discovered and allowed", () => {
  const p = classifyTestProvenance({
    selectedTests: SELECTED,
    injectedTestNames: ["tests/other.py::test_other"], // does not match SELECTED
    priorCommandText: [],
    discoveryEvidence: strongDiscoveryEvidence(),
    promptExposedTestNames: [],
  });
  assert.equal(p.classification, "agent_discovered");
  assert.equal(fairProvenance(p).allowedForFairVerification, true);
});

// M28.4-7. The M28.3 real-artifact shape (broad grep, output surfaced node, no read, exact hidden
// match) stays ineligible — for exposure UNKNOWN (null) and exposure KNOWN-and-sanitized ([]).
test("M28.4: an M28.3-style broad-grep-only hidden match stays ineligible (exposure null and [])", () => {
  const sel = ["tests/test_domain_py.py::test_parse_annotation"];
  const evidence = computeDiscoveryEvidence({
    selectedTests: sel,
    priorCalls: [
      { command: null, path: "tests", category: "search", output: "tests/test_domain_py.py:239:def test_parse_annotation():" },
    ],
  });
  for (const exposure of [null, [] as string[]]) {
    const p = classifyTestProvenance({
      selectedTests: sel,
      injectedTestNames: sel,
      priorCommandText: [],
      discoveryEvidence: evidence,
      promptExposedTestNames: exposure,
    });
    assert.notEqual(p.classification, "agent_discovered_hidden_match");
    assert.equal(fairProvenance(p).allowedForFairVerification, false);
  }
});

// M28.4-10. The prompt-sanitization signal is what flips the verdict: same strong-discovery hidden
// match is fair when sanitized, injected when exposed, and conservatively ambiguous when unknown.
test("M28.4: prompt-sanitization evidence flips a discovered hidden match from injected to fair", () => {
  const base = {
    selectedTests: SELECTED,
    injectedTestNames: HIDDEN,
    priorCommandText: [] as string[],
    discoveryEvidence: strongDiscoveryEvidence(),
  };
  const sanitized = classifyTestProvenance({ ...base, promptExposedTestNames: [] });
  assert.equal(sanitized.classification, "agent_discovered_hidden_match");
  assert.equal(fairProvenance(sanitized).allowedForFairVerification, true);

  const exposed = classifyTestProvenance({ ...base, promptExposedTestNames: HIDDEN });
  assert.equal(exposed.classification, "injected_metadata");
  assert.equal(fairProvenance(exposed).allowedForFairVerification, false);

  // Exposure UNKNOWN ⇒ conservative pre-M28.4 behavior (ambiguous, disallowed).
  const unknown = classifyTestProvenance({ ...base });
  assert.equal(unknown.classification, "ambiguous");
  assert.equal(fairProvenance(unknown).allowedForFairVerification, false);
});

// ===== M24 — explicit in-loop test environment classification =====

// The real sphinx-7462 head: pytest loads a plugin, whose import chain breaks on a host
// jinja2 that lacks `environmentfilter` — all BEFORE any test is collected.
const SPHINX_IMPORT_HEAD = [
  "Traceback (most recent call last):",
  '  File "/home/calvin/miniforge3/lib/python3.12/site-packages/_pytest/config/__init__.py", line 879, in import_plugin',
  "    __import__(importspec)",
  '  File ".../sphinx/util/rst.py", line 22, in <module>',
  "    from jinja2 import environmentfilter",
  "ImportError: cannot import name 'environmentfilter' from 'jinja2'",
].join("\n");

// M24-1. A plugin/import traceback BEFORE collection ⇒ test_error_environment (no signal).
test("M24: import/plugin traceback before collection => test_error_environment", () => {
  const c = classifyTestEnvironmentOutcome({
    parsedOutcome: parsePytestOutcome(SPHINX_IMPORT_HEAD),
    output: SPHINX_IMPORT_HEAD,
  });
  assert.equal(c.classification, "test_error_environment");
  assert.equal(c.targetTestExecuted, false);
});

// M24-2. A selected test's assertion failure (it ran) ⇒ test_failed.
test("M24: selected test assertion failure => test_failed", () => {
  const out = [
    "collected 1 item",
    "tests/test_z.py::test_w FAILED",
    "=================================== FAILURES ===================================",
    "____ test_w ____",
    "    assert 1 == 2",
    "E   assert 1 == 2",
    "1 failed in 0.05s",
  ].join("\n");
  const c = classifyTestEnvironmentOutcome({ parsedOutcome: parsePytestOutcome(out), output: out });
  assert.equal(c.classification, "test_failed");
  assert.equal(c.targetTestExecuted, true);
});

// M24-3. The selected test is collected/runs, then ERRORS in its body/fixture ⇒ test_error_target.
test("M24: selected test errors after collection => test_error_target", () => {
  const out = [
    "collected 1 item",
    "tests/test_z.py::test_w ERROR",
    "==================================== ERRORS ====================================",
    "_________________ ERROR at setup of test_w _________________",
    "Traceback (most recent call last):",
    "  File \"tests/test_z.py\", line 10, in fixture",
    "    raise RuntimeError('boom')",
    "RuntimeError: boom",
    "ERROR tests/test_z.py::test_w - RuntimeError: boom",
    "1 error in 0.05s",
  ].join("\n");
  const c = classifyTestEnvironmentOutcome({ parsedOutcome: parsePytestOutcome(out), output: out });
  assert.equal(c.classification, "test_error_target");
  assert.equal(c.targetTestExecuted, true);
});

// M24-4. No tests collected (e.g. all deselected) ⇒ test_not_run.
test("M24: no tests collected => test_not_run", () => {
  const out = "collected 0 items\n\nno tests ran in 0.01s";
  const c = classifyTestEnvironmentOutcome({ parsedOutcome: parsePytestOutcome(out), output: out });
  assert.equal(c.classification, "test_not_run");
  assert.equal(c.targetTestExecuted, false);
});

// M24-4b. A clean pass ⇒ test_passed.
test("M24: passing run => test_passed", () => {
  const out = "collected 1 item\ntests/test_z.py::test_w PASSED\n1 passed in 0.10s";
  const c = classifyTestEnvironmentOutcome({ parsedOutcome: parsePytestOutcome(out), output: out });
  assert.equal(c.classification, "test_passed");
  assert.equal(c.targetTestExecuted, true);
});

// M24-4c. Output with no recognizable pytest runner evidence ⇒ unknown.
test("M24: command failure with no runner evidence => unknown", () => {
  const out = "bash: pytest: command not found";
  const c = classifyTestEnvironmentOutcome({ parsedOutcome: parsePytestOutcome(out), output: out });
  assert.equal(c.classification, "unknown");
});

// M24-5. An environment failure blocks fairVerificationUsable and is surfaced as the explicit
// test_error_environment classification on the assessment.
test("M24: environment failure blocks fairVerificationUsable and is classified", () => {
  const importErr = eventOf({
    selectedTests: ["tests/test_z.py::test_w"],
    outputSummary: SPHINX_IMPORT_HEAD.slice(0, 1024),
    parsedOutcome: parsePytestOutcome(SPHINX_IMPORT_HEAD),
  });
  const a = assessFairVerification({
    policy: "agent_discovered",
    event: importErr,
    injectedTestNames: null,
    priorCommandText: ["grep -rn test_w tests/test_z.py"], // discovered ⇒ provenance not the blocker
    editToolBeforeTest: true,
    fullOutput: SPHINX_IMPORT_HEAD,
  });
  assert.equal(a.environmentClassification.classification, "test_error_environment");
  assert.equal(a.environmentClassification.targetTestExecuted, false);
  assert.equal(a.fairVerificationUsable, false);
});

// M24-6. The raw parsedOutcome is preserved separately and unchanged by the classification.
test("M24: raw parsedOutcome remains separate from environment classification", () => {
  const parsed = parsePytestOutcome(SPHINX_IMPORT_HEAD);
  const c = classifyTestEnvironmentOutcome({ parsedOutcome: parsed, output: SPHINX_IMPORT_HEAD });
  // classifier does not mutate the parsed outcome…
  assert.equal(parsed.status, "error");
  assert.deepEqual(parsePytestOutcome(SPHINX_IMPORT_HEAD), parsed);
  // …and reports a DIFFERENT, more specific label than the raw status.
  assert.equal(c.classification, "test_error_environment");
  assert.notEqual(c.classification, parsed.status);
});
