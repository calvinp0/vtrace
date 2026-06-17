// M21 — enriched tool-call + test-command capture from agent stream-json.
//
// `toolCallLog.ts` recovers the ORDERED tool calls but leaves `output_summary` null in
// real captures, because the external adapter emits `tool_result` NESTED inside a `user`
// event's content array (keyed by `tool_use_id`), not as a top-level `tool_result` event.
// This module is the ADDITIVE, PURE core that:
//   - matches tool_result → tool_use by id and attaches bounded output + success/exitCode,
//   - tags each call with its run phase (first_pass | pivot_revision),
//   - derives structured test-command events (pytest/unittest/tox/npm/bun/cargo/go) with
//     the selected tests and a CONSERVATIVE patch-state label.
//
// It NEVER changes retrieval, ranking, scoring, candidate generation, prompts, or patches,
// reads no gold labels, and is intentionally honest: when the stream does not expose an
// output / exit code, the field stays null rather than being guessed. It does NOT parse
// pytest stdout to fabricate pass/fail — `success` comes only from the stream's `is_error`.

import { isBashTool, toolCategory, type ToolCategory } from "./toolCallLog";

export type RunPhase = "first_pass" | "pivot_revision";

export type TestFramework =
  | "pytest"
  | "unittest"
  | "tox"
  | "npm"
  | "bun"
  | "cargo"
  | "go"
  | "unknown";

// Conservative patch-state labels. A test observed inside an agent loop ran BEFORE that
// phase's final patch was extracted (extraction happens after the loop ends), so we never
// claim a test verified a final/after patch — only "before" or "unknown".
export type PatchState =
  | "first_pass_before_model_patch"
  | "revision_phase_before_revised_patch"
  | "unknown";

// Strict bounds so a large Read dump / long test log cannot bloat the persisted artifact.
export const OUTPUT_MAX_BYTES = 8 * 1024; // 8k full(ish) output
export const OUTPUT_SUMMARY_MAX_BYTES = 1024; // 1k head summary

export interface EnrichedToolCall {
  index: number;
  phase: RunPhase;
  tool: string;
  category: ToolCategory;
  /** Bash/shell command, when this call is a shell tool. */
  command: string | null;
  /** Conventional file target, when present. */
  path: string | null;
  /** Bounded captured output (≤ OUTPUT_MAX_BYTES), or null when the stream had none. */
  output: string | null;
  /** Bounded head summary (≤ OUTPUT_SUMMARY_MAX_BYTES), or null. */
  outputSummary: string | null;
  /** Process exit code when the stream exposes one (rare) — else null. */
  exitCode: number | null;
  /** Success from the stream's `is_error` flag (success = !is_error) — else null. */
  success: boolean | null;
  /** True when `output` was clipped to the byte bound. */
  truncated: boolean;
}

export interface TestCommandEvent {
  phase: RunPhase;
  command: string;
  testFramework: TestFramework;
  selectedTests: string[];
  outputSummary: string | null;
  exitCode: number | null;
  /** RAW tool success from the stream `is_error` — unreliable behind `... | head` pipelines. */
  success: boolean | null;
  patchState: PatchState;
  /** M22: outcome parsed from the OUTPUT TEXT (trustworthy where `success` is masked). */
  parsedOutcome: ParsedTestOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PATH_KEYS = ["file_path", "filePath", "path", "file", "filename", "notebook_path"];
const COMMAND_KEYS = ["command", "cmd", "script", "command_line"];

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// Flatten a tool_result `content` (string, or array of {type:"text",text} blocks) to text.
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
      else parts.push(JSON.stringify(block));
    }
    return parts.join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

// Byte-aware clip (UTF-8). Returns the clipped string and whether anything was removed.
export function clipToBytes(text: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { value: text, truncated: false };
  const clipped = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return { value: clipped, truncated: true };
}

function exitCodeFrom(block: Record<string, unknown>): number | null {
  for (const key of ["exit_code", "exitCode", "returncode", "return_code", "status"]) {
    const v = block[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

interface PendingCall extends EnrichedToolCall {
  toolUseId: string | null;
}

function pushToolUse(calls: PendingCall[], block: Record<string, unknown>, phase: RunPhase): void {
  const tool = typeof block.name === "string" ? block.name : "unknown";
  const args = isRecord(block.input) ? block.input : {};
  calls.push({
    index: calls.length,
    phase,
    tool,
    category: toolCategory(tool),
    command: isBashTool(tool) ? firstString(args, COMMAND_KEYS) : null,
    path: firstString(args, PATH_KEYS),
    output: null,
    outputSummary: null,
    exitCode: null,
    success: null,
    truncated: false,
    toolUseId: typeof block.id === "string" ? block.id : null,
  });
}

function attachResult(calls: PendingCall[], block: Record<string, unknown>): void {
  const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
  // Prefer an id match; fall back to the most recent call still awaiting output.
  let target: PendingCall | undefined;
  if (id !== null) target = calls.find((c) => c.toolUseId === id);
  if (target === undefined) {
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]!.output === null) { target = calls[i]; break; }
    }
  }
  if (target === undefined) return;
  const text = contentToString(block.content);
  const full = clipToBytes(text, OUTPUT_MAX_BYTES);
  const summary = clipToBytes(text, OUTPUT_SUMMARY_MAX_BYTES);
  target.output = full.value;
  target.truncated = full.truncated;
  target.outputSummary = summary.value;
  target.exitCode = exitCodeFrom(block);
  if (typeof block.is_error === "boolean") target.success = !block.is_error;
}

// Parse the captured stream-json into ENRICHED tool calls with bounded outputs, matching
// tool_result→tool_use by id. Tolerant: skips non-JSON / unexpected lines. Handles both
// the real shape (tool_result nested in `user` events) and top-level tool_use/tool_result.
export function parseEnrichedToolCalls(streamJson: string, phase: RunPhase): EnrichedToolCall[] {
  const calls: PendingCall[] = [];
  for (const line of streamJson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : null;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_use") pushToolUse(calls, block, phase);
        }
      }
    } else if (event.type === "user") {
      const message = isRecord(event.message) ? event.message : null;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_result") attachResult(calls, block);
        }
      }
    } else if (event.type === "tool_use") {
      pushToolUse(calls, event, phase);
    } else if (event.type === "tool_result") {
      attachResult(calls, event);
    }
  }
  // Drop the internal id before returning the public shape.
  return calls.map(({ toolUseId: _toolUseId, ...rest }) => rest);
}

// Classify a shell command's test framework. Returns "unknown" for non-test commands.
export function classifyTestFramework(command: string): TestFramework {
  const c = command.toLowerCase();
  if (/\bpython[0-9.]*\s+-m\s+pytest\b/.test(c) || /(^|[\s;&|(])pytest\b/.test(c)) return "pytest";
  if (/\bpython[0-9.]*\s+-m\s+unittest\b/.test(c) || /(^|[\s;&|(])unittest\b/.test(c)) return "unittest";
  if (/(^|[\s;&|(])tox\b/.test(c)) return "tox";
  if (/(^|[\s;&|(])bun\s+test\b/.test(c)) return "bun";
  if (/(^|[\s;&|(])npm\s+(run\s+)?test\b/.test(c)) return "npm";
  if (/(^|[\s;&|(])cargo\s+test\b/.test(c)) return "cargo";
  if (/(^|[\s;&|(])go\s+test\b/.test(c)) return "go";
  return "unknown";
}

export function isTestCommand(command: string): boolean {
  return classifyTestFramework(command) !== "unknown";
}

// Best-effort extraction of the selected tests from a test command. Conservative: only
// pytest/unittest yield specific selectors today (documented); others return [].
export function extractSelectedTests(command: string, framework: TestFramework): string[] {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("-"));
  if (framework === "pytest") {
    return tokens.filter((t) => t.includes("::") || /(^|\/)(test_[^/\s]+|[^/\s]+_test)\.py$/.test(t));
  }
  if (framework === "unittest") {
    // Dotted node ids that mention a test (e.g. pkg.tests.test_x.TestY.test_z), not files.
    return tokens.filter((t) => t.includes(".") && /test/i.test(t) && !t.endsWith(".py"));
  }
  return [];
}

function patchStateForPhase(phase: RunPhase): PatchState {
  return phase === "first_pass"
    ? "first_pass_before_model_patch"
    : "revision_phase_before_revised_patch";
}

// Derive a single structured test-command event from one enriched call, or null when the
// call is not a known test command. Shared by `deriveTestCommands` and the M23 fair-
// verification report so the event shape stays identical across both.
function deriveTestCommandEvent(call: EnrichedToolCall): TestCommandEvent | null {
  if (call.command === null || !isBashTool(call.tool)) return null;
  const framework = classifyTestFramework(call.command);
  if (framework === "unknown") return null;
  const parsedOutcome =
    framework === "pytest"
      ? parsePytestOutcome(call.output, { truncated: call.truncated })
      : { framework, status: "unknown" as const, evidence: ["no parser for framework"], confidence: "low" as const };
  return {
    phase: call.phase,
    command: call.command,
    testFramework: framework,
    selectedTests: extractSelectedTests(call.command, framework),
    outputSummary: call.outputSummary,
    exitCode: call.exitCode,
    success: call.success,
    patchState: patchStateForPhase(call.phase),
    parsedOutcome,
  };
}

// Derive structured test-command events from enriched tool calls. One event per shell
// call whose command classifies as a known test framework. patchState is conservative
// (phase-derived "before" label) — we never assert a test ran against a final patch.
export function deriveTestCommands(calls: readonly EnrichedToolCall[]): TestCommandEvent[] {
  const events: TestCommandEvent[] = [];
  for (const call of calls) {
    const event = deriveTestCommandEvent(call);
    if (event !== null) events.push(event);
  }
  return events;
}

// ===========================================================================================
// M22 — semantic analysis of captured test outputs (PURE, no fs/Docker/oracle).
//
// M21.1 found three gaps that must be closed before captured tests can inform a FAIR
// adoption decision: (1) `success` from `is_error` is defeated by `... | head` pipelines,
// (2) the selected test name may come from injected FAIL_TO_PASS metadata rather than the
// agent's own exploration, and (3) the patch state is conservative and never proves a test
// ran against the FINAL patch. These analyzers make those three things explicit and honest.
// ===========================================================================================

export type ParsedTestStatus = "passed" | "failed" | "error" | "failed_or_error" | "unknown";

export interface ParsedTestOutcome {
  framework: TestFramework;
  status: ParsedTestStatus;
  evidence: string[];
  confidence: "low" | "medium" | "high";
}

const PYTEST_ERROR_MARKERS = [
  "Traceback (most recent call last)",
  "INTERNALERROR",
  "ImportError",
  "ModuleNotFoundError",
  "errors during collection",
];

// Parse a pytest run's OUTPUT TEXT into an outcome. Conservative + failure-biased: any
// error/traceback/failure marker overrides a stray "passed" substring, so a pipeline-masked
// `success=true` cannot launder a failing run into a pass. Never consults shell exit status.
export function parsePytestOutcome(
  output: string | null,
  opts: { truncated?: boolean } = {},
): ParsedTestOutcome {
  const framework: TestFramework = "pytest";
  if (output === null || output.trim().length === 0) {
    return { framework, status: "unknown", evidence: ["no output captured"], confidence: "low" };
  }
  const text = output;
  const evidence: string[] = [];

  const hasErrorsHeader = /={3,}\s*ERRORS\s*={3,}/.test(text);
  const hasFailuresHeader = /={3,}\s*FAILURES\s*={3,}/.test(text);
  const errorMarker = PYTEST_ERROR_MARKERS.find((m) => text.includes(m));
  const passedMatch = text.match(/(\d+)\s+passed/);
  const failedMatch = text.match(/(\d+)\s+failed/);
  const errorMatch = text.match(/(\d+)\s+errors?\b/);
  const noTests = /no tests ran/.test(text) || /collected 0 items/.test(text);
  const failedLine = /(^|\n)FAILED\s+\S/.test(text);

  // 1) Hard error signals (a traceback / import error / ERRORS section / N errors).
  if (errorMarker || hasErrorsHeader || (errorMatch && Number(errorMatch[1]) > 0)) {
    if (errorMarker) evidence.push(errorMarker);
    if (hasErrorsHeader) evidence.push("= ERRORS = section");
    if (errorMatch && Number(errorMatch[1]) > 0) evidence.push(`${errorMatch[1]} error(s) in summary`);
    return { framework, status: "error", evidence, confidence: "high" };
  }
  // 2) Failures (FAILURES section, "N failed" summary, or a FAILED line).
  if (hasFailuresHeader || (failedMatch && Number(failedMatch[1]) > 0) || failedLine) {
    if (hasFailuresHeader) evidence.push("= FAILURES = section");
    if (failedMatch && Number(failedMatch[1]) > 0) evidence.push(`${failedMatch[1]} failed in summary`);
    if (failedLine) evidence.push("FAILED line");
    return { framework, status: "failed", evidence, confidence: "high" };
  }
  // 3) Clean pass: a positive passed-count and no failure/error signals above.
  if (passedMatch && Number(passedMatch[1]) > 0) {
    evidence.push(`${passedMatch[1]} passed in summary`);
    return { framework, status: "passed", evidence, confidence: "high" };
  }
  // 4) Ran but verified nothing.
  if (noTests) {
    evidence.push("no tests ran / collected 0 items");
    return { framework, status: "unknown", evidence, confidence: "medium" };
  }
  // 5) Truncated before a summary, with a weak failure hint ⇒ cannot call it a pass.
  const weakFailHint = /\bassert\b/i.test(text) || /\berror\b/i.test(text) || /\bfailed\b/i.test(text);
  if (opts.truncated && weakFailHint) {
    evidence.push("truncated output with failure-ish hint");
    return { framework, status: "failed_or_error", evidence, confidence: "low" };
  }
  // 6) Nothing conclusive.
  evidence.push("no recognizable pytest summary");
  return { framework, status: "unknown", evidence, confidence: "low" };
}

// True when raw tool success disagrees with the parsed outcome — the M21.1 masking signature.
export function outcomeMismatch(rawToolSuccess: boolean | null, parsed: ParsedTestOutcome): boolean {
  if (rawToolSuccess !== true) return false;
  return parsed.status === "failed" || parsed.status === "error" || parsed.status === "failed_or_error";
}

// -------------------------------------------------------------------------------------------
// Provenance: did the test NAME come from the agent's own exploration, or from injected
// FAIL_TO_PASS / capsule metadata it would not have in a deployed run?
// -------------------------------------------------------------------------------------------

export type TestProvenanceClass = "agent_discovered" | "injected_metadata" | "ambiguous" | "unknown";

export interface TestProvenance {
  classification: TestProvenanceClass;
  evidence: string[];
}

// Normalize a pytest node id for matching: drop a trailing `[params]` and keep the leaf.
function testLeaf(nodeId: string): string {
  const afterColons = nodeId.includes("::") ? nodeId.slice(nodeId.lastIndexOf("::") + 2) : nodeId;
  return afterColons.replace(/\[.*\]$/, "").trim();
}

function sameTest(a: string, b: string): boolean {
  if (a === b) return true;
  const la = testLeaf(a);
  const lb = testLeaf(b);
  return la.length > 0 && la === lb;
}

// Classify why a selected test appeared. `injectedTestNames` = FAIL_TO_PASS / testExpectation
// names VTRACE injected (null when that telemetry is unavailable). `priorCommandText` =
// the text of grep/find/read/bash calls observed BEFORE the test command in the same phase.
export function classifyTestProvenance(input: {
  selectedTests: readonly string[];
  injectedTestNames: readonly string[] | null;
  priorCommandText: readonly string[];
}): TestProvenance {
  const evidence: string[] = [];
  if (input.selectedTests.length === 0) {
    return { classification: "unknown", evidence: ["no selected tests"] };
  }
  const injectedMatch =
    input.injectedTestNames !== null &&
    input.selectedTests.some((t) => input.injectedTestNames!.some((i) => sameTest(t, i)));
  if (injectedMatch) evidence.push("selected test matches injected FAIL_TO_PASS/testExpectation");

  // "Discovered" = the test file/leaf shows up in earlier exploration commands (not the test run).
  const discovered = input.selectedTests.some((t) => {
    const leaf = testLeaf(t);
    const file = t.includes("::") ? t.slice(0, t.indexOf("::")) : t;
    const base = file.split("/").pop() ?? file;
    return input.priorCommandText.some((c) => (leaf.length > 2 && c.includes(leaf)) || (base.length > 2 && c.includes(base)));
  });
  if (discovered) evidence.push("test file/name appears in prior exploration commands");

  if (injectedMatch && discovered) return { classification: "ambiguous", evidence };
  if (injectedMatch) return { classification: "injected_metadata", evidence };
  if (discovered) return { classification: "agent_discovered", evidence };
  // No injection telemetry and no discovery evidence ⇒ cannot prove fairness.
  if (input.injectedTestNames === null && input.priorCommandText.length === 0) {
    return { classification: "unknown", evidence: ["insufficient telemetry"] };
  }
  return { classification: "ambiguous", evidence: [...evidence, "no discovery evidence and no injected match — origin unclear"] };
}

// -------------------------------------------------------------------------------------------
// Patch state: can this test command verify a particular patch? Never claims final-patch
// verification without proof (which the in-loop stream cannot provide today).
// -------------------------------------------------------------------------------------------

export type RefinedPatchState =
  | "pre_patch_state"
  | "after_observed_edit_state"
  | "revision_phase_state"
  | "unknown";

export interface PatchStateAssessment {
  patchState: RefinedPatchState;
  /** Always false unless the artifact PROVES the test ran after the final patch was applied. */
  canVerifyFinalPatch: boolean;
  evidence: string[];
}

// Assess what a test command at `testIndex` could verify, from the ordered calls of its
// phase. `editToolBeforeTest` = an edit/write happened earlier in the phase. We never set
// `canVerifyFinalPatch` true: the stream does not prove the working tree at test time equals
// the extracted final/revised patch (the agent may edit further; extraction happens later).
export function classifyTestPatchState(input: {
  phase: RunPhase;
  editToolBeforeTest: boolean;
}): PatchStateAssessment {
  if (input.phase === "pivot_revision") {
    return {
      patchState: "revision_phase_state",
      canVerifyFinalPatch: false,
      evidence: ["ran during revision phase before the revised patch was extracted"],
    };
  }
  if (input.editToolBeforeTest) {
    return {
      patchState: "after_observed_edit_state",
      canVerifyFinalPatch: false,
      evidence: ["an edit/write occurred before the test, but final modelPatch is extracted after the loop"],
    };
  }
  return {
    patchState: "pre_patch_state",
    canVerifyFinalPatch: false,
    evidence: ["no edit observed before the test; cannot verify any patched state"],
  };
}

// ===========================================================================================
// M23 — fair revision verification policy (PURE, no fs/Docker/oracle).
//
// M22 left three honest sub-judgments (outcome / provenance / patch-state). This layer is the
// opt-in `--revision-verification-policy agent-discovered-tests` decision surface: it composes
// those sub-judgments into a SINGLE verdict (`fairVerificationUsable`) with an explicit blocker
// list, and — crucially — refuses to treat injected FAIL_TO_PASS-matched tests as fair evidence.
// It is SCAFFOLDING ONLY: it never adopts/rejects a patch and never makes the revision pass
// run. On today's captures every event is expected to come back `fairVerificationUsable=false`.
// ===========================================================================================

// Which verification policy was in force for the run. "none" = default (M15/M16/M21/M22
// behavior unchanged). "agent_discovered" = opt-in fair test policy (the prompt asked the
// agent to discover/run a focused test from repo exploration, not injected labels).
export type VerificationPolicy = "none" | "agent_discovered";

// Provenance classification (from `classifyTestProvenance`) plus the fairness verdict: a test
// only counts as fair evidence when the agent provably chose it itself.
export interface VerificationProvenance {
  classification: TestProvenanceClass;
  evidence: string[];
  allowedForFairVerification: boolean;
  disallowReason?: string;
}

// Patch-state classification with the proof-gated `final_patch_verified` member. That member
// is NEVER emitted from in-loop stream data alone — only when an explicit artifact proves the
// command ran after the exact candidate/final patch was installed.
export type VerificationPatchStateClass =
  | "pre_patch_state"
  | "after_observed_edit_state"
  | "revision_phase_state"
  | "final_patch_verified"
  | "unknown";

export interface VerificationPatchState {
  classification: VerificationPatchStateClass;
  canVerifyFinalPatch: boolean;
  evidence: string[];
}

export interface FairVerificationAssessment {
  verificationPolicy: VerificationPolicy;
  verificationProvenance: VerificationProvenance;
  verificationPatchState: VerificationPatchState;
  /** M24: explicit environment classification of the captured test outcome (additive). */
  environmentClassification: TestEnvironmentAssessment;
  fairVerificationUsable: boolean;
  fairVerificationBlockers: string[];
}

// Wrap a raw provenance classification with the fairness verdict. Only `agent_discovered`
// (the agent reached the test through its own exploration) is allowed; everything else —
// injected_metadata, ambiguous, unknown — is disallowed with a reason. In particular an exact
// FAIL_TO_PASS match classifies as injected_metadata ⇒ allowedForFairVerification=false.
export function fairProvenance(p: TestProvenance): VerificationProvenance {
  const allowed = p.classification === "agent_discovered";
  return {
    classification: p.classification,
    evidence: [...p.evidence],
    allowedForFairVerification: allowed,
    ...(allowed
      ? {}
      : { disallowReason: `provenance "${p.classification}" is not provably agent-owned` }),
  };
}

// Patch-state for fair verification. Defaults to the conservative M22 classifier; promotes to
// `final_patch_verified` ONLY when `finalPatchProof.applied` is true AND carries evidence (an
// artifact proving the test ran against the installed final/revised patch). Without that proof
// the state stays "before"/phase-derived and `canVerifyFinalPatch=false` — no overclaiming.
export function classifyVerificationPatchState(input: {
  phase: RunPhase;
  editToolBeforeTest: boolean;
  finalPatchProof?: { applied: boolean; evidence?: readonly string[] };
}): VerificationPatchState {
  const proof = input.finalPatchProof;
  if (proof?.applied === true) {
    const evidence = proof.evidence ? proof.evidence.filter((e) => e.trim().length > 0) : [];
    if (evidence.length > 0) {
      return { classification: "final_patch_verified", canVerifyFinalPatch: true, evidence: [...evidence] };
    }
    // Claimed but unproven (no evidence) ⇒ refuse to emit final_patch_verified; fall through.
  }
  const base = classifyTestPatchState({ phase: input.phase, editToolBeforeTest: input.editToolBeforeTest });
  return {
    classification: base.patchState,
    canVerifyFinalPatch: base.canVerifyFinalPatch,
    evidence: [...base.evidence],
  };
}

// Environment/import/dependency failure markers — a test that never executed (import error,
// failed collection, internal error) yields no verification signal regardless of exit status.
const ENVIRONMENT_FAILURE_MARKERS = [
  "ImportError",
  "ModuleNotFoundError",
  "No module named",
  "errors during collection",
  "INTERNALERROR",
  "Traceback (most recent call last)",
];

export function hasEnvironmentFailureMarkers(text: string | null): { found: boolean; markers: string[] } {
  if (text === null || text.trim().length === 0) return { found: false, markers: [] };
  const markers = ENVIRONMENT_FAILURE_MARKERS.filter((m) => text.includes(m));
  return { found: markers.length > 0, markers };
}

// -------------------------------------------------------------------------------------------
// M24 — explicit environment classification of a captured test command.
//
// `parsePytestOutcome` is deliberately failure-biased but collapses two CATEGORICALLY
// different failures into one `status: "error"`:
//   (a) the pytest/plugin/dependency import chain broke BEFORE the selected target test was
//       ever collected (e.g. sphinx-7462's `ImportError: cannot import name 'environmentfilter'`
//       from a host jinja2 that does not match the instance's pinned deps), and
//   (b) the target test WAS collected and executed, then errored in its body/fixture.
// Only (b) carries a real signal about the patch; (a) carries none and must NOT count as
// verification. The discriminator is whether the target test was provably collected/executed,
// which pytest's own output exposes (`collected N items`, node-result lines, a FAILURES header).
//
// The classification is ADDITIVE: the raw `parsedOutcome` is preserved separately and never
// rewritten by this layer.
// -------------------------------------------------------------------------------------------

export type TestEnvironmentClassification =
  | "test_passed"
  | "test_failed"
  | "test_error_target"
  | "test_error_environment"
  | "test_not_run"
  | "unknown";

export interface TestEnvironmentAssessment {
  classification: TestEnvironmentClassification;
  /** True only when there is positive evidence the target test was collected/executed. */
  targetTestExecuted: boolean;
  evidence: string[];
}

// Positive evidence that pytest got past plugin/import loading and actually collected/ran a
// test: a non-zero `collected N items`, a per-node result line (`::name PASSED|FAILED|ERROR`),
// a `FAILURES` section (only printed for tests that ran), or an `N passed/failed` summary.
function detectTargetTestExecuted(text: string): { executed: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const collected = text.match(/collected\s+(\d+)\s+items?/i);
  if (collected && Number(collected[1]) > 0) evidence.push(`collected ${collected[1]} item(s)`);
  if (/::[^\s]+\s+(PASSED|FAILED|ERROR)\b/.test(text)) evidence.push("per-node result line");
  if (/={3,}\s*FAILURES\s*={3,}/.test(text)) evidence.push("= FAILURES = section");
  const ranSummary = text.match(/(\d+)\s+(passed|failed)\b/);
  if (ranSummary && Number(ranSummary[1]) > 0) evidence.push(`${ranSummary[1]} ${ranSummary[2]} in summary`);
  return { executed: evidence.length > 0, evidence };
}

// Map a parsed outcome + raw output to one of the six explicit environment classifications.
// PURE; reads no fs/Docker/oracle. The rules mirror the M24 audit:
//   - passed                              => test_passed
//   - failed (assertion/FAILURES)         => test_failed
//   - error AND target executed           => test_error_target
//   - error AND target NOT executed       => test_error_environment (import/plugin/dep failure
//                                            before the selected test ran)
//   - ran nothing (collected 0 / no tests)=> test_not_run
//   - no recognizable runner evidence     => unknown
export function classifyTestEnvironmentOutcome(input: {
  parsedOutcome: ParsedTestOutcome;
  output: string | null;
  truncated?: boolean;
}): TestEnvironmentAssessment {
  const text = input.output ?? "";
  const status = input.parsedOutcome.status;
  const { executed, evidence: execEvidence } = detectTargetTestExecuted(text);
  const noTests = /no tests ran/i.test(text) || /collected 0 items/i.test(text);

  if (status === "passed") {
    return { classification: "test_passed", targetTestExecuted: true, evidence: ["parsed outcome passed"] };
  }
  if (status === "failed") {
    return {
      classification: "test_failed",
      targetTestExecuted: true,
      evidence: ["parsed outcome failed (assertion/FAILURES)", ...execEvidence],
    };
  }
  if (status === "error") {
    if (executed) {
      return {
        classification: "test_error_target",
        targetTestExecuted: true,
        evidence: ["target test was collected/executed before the error", ...execEvidence],
      };
    }
    const env = hasEnvironmentFailureMarkers(text);
    return {
      classification: "test_error_environment",
      targetTestExecuted: false,
      evidence: [
        "errored before the selected target test executed (import/plugin/dependency failure)",
        ...(env.found ? [`markers: ${env.markers.join(", ")}`] : []),
      ],
    };
  }
  if (noTests) {
    return {
      classification: "test_not_run",
      targetTestExecuted: false,
      evidence: ["no tests ran / collected 0 items"],
    };
  }
  // status unknown / failed_or_error with no execution evidence: cannot attribute to env vs target.
  return {
    classification: "unknown",
    targetTestExecuted: executed,
    evidence:
      text.trim().length === 0
        ? ["no output captured"]
        : ["no recognizable pytest runner evidence", ...execEvidence],
  };
}

// Compose the three M22 sub-judgments + the policy into one fair-verification verdict.
// `fairVerificationUsable` is true ONLY when ALL hold: the opt-in policy is enabled, the test
// provenance is agent_discovered, the parsed outcome is `passed`, the patch state proves
// final/revised-patch verification, and no environment/import failure markers are present.
// Each failing condition appends a human-readable blocker; an empty blocker list ⇒ usable.
export function assessFairVerification(input: {
  policy: VerificationPolicy;
  event: TestCommandEvent;
  injectedTestNames: readonly string[] | null;
  priorCommandText: readonly string[];
  editToolBeforeTest: boolean;
  finalPatchProof?: { applied: boolean; evidence?: readonly string[] };
  /** Fuller captured output (≤8k) for environment classification; falls back to outputSummary. */
  fullOutput?: string | null;
}): FairVerificationAssessment {
  const { policy, event } = input;
  const provenance = fairProvenance(
    classifyTestProvenance({
      selectedTests: event.selectedTests,
      injectedTestNames: input.injectedTestNames,
      priorCommandText: input.priorCommandText,
    }),
  );
  const patchState = classifyVerificationPatchState({
    phase: event.phase,
    editToolBeforeTest: input.editToolBeforeTest,
    finalPatchProof: input.finalPatchProof,
  });
  const classificationText = [
    input.fullOutput ?? event.outputSummary ?? "",
    ...event.parsedOutcome.evidence,
  ].join("\n");
  const env = hasEnvironmentFailureMarkers(classificationText);
  const environmentClassification = classifyTestEnvironmentOutcome({
    parsedOutcome: event.parsedOutcome,
    output: classificationText,
  });

  const blockers: string[] = [];
  if (policy !== "agent_discovered") {
    blockers.push("fair verification policy not enabled (policy=none)");
  }
  if (!provenance.allowedForFairVerification) {
    blockers.push(`provenance "${provenance.classification}" is not allowed for fair verification`);
  }
  if (event.parsedOutcome.status !== "passed") {
    blockers.push(`parsed outcome is "${event.parsedOutcome.status}" (not "passed")`);
  }
  if (!patchState.canVerifyFinalPatch) {
    blockers.push(`patch state "${patchState.classification}" cannot verify the final patch`);
  }
  if (env.found) {
    blockers.push(`environment/import failure markers present: ${env.markers.join(", ")}`);
  }
  // M24: an environment failure (import/plugin/dep error before the target test ran) is an
  // explicit, standalone blocker — even when the truncated head carried no literal marker.
  if (environmentClassification.classification === "test_error_environment" && !env.found) {
    blockers.push(
      "test environment failed before the target test executed (test_error_environment)",
    );
  }

  return {
    verificationPolicy: policy,
    verificationProvenance: provenance,
    verificationPatchState: patchState,
    environmentClassification,
    fairVerificationUsable: blockers.length === 0,
    fairVerificationBlockers: blockers,
  };
}

// Per-test-command fair-verification report row: the derived event plus its assessment and
// the in-phase context the assessment was computed from (so the artifact is self-describing).
export interface TestCommandVerification {
  phase: RunPhase;
  command: string;
  selectedTests: string[];
  parsedOutcome: ParsedTestOutcome;
  priorCommandText: string[];
  editToolBeforeTest: boolean;
  assessment: FairVerificationAssessment;
}

// Build per-test-command fair-verification assessments from the ORDERED enriched calls.
// For each test command, `priorCommandText` = the commands/paths of calls BEFORE it in the
// SAME phase (the agent's exploration the test name could legitimately have come from), and
// `editToolBeforeTest` = any edit/write-category call before it in the same phase. PURE; reads
// no gold labels beyond the explicitly-passed `injectedTestNames` (which only ever DISALLOW).
export function buildFairVerificationReport(input: {
  calls: readonly EnrichedToolCall[];
  policy: VerificationPolicy;
  injectedTestNames: readonly string[] | null;
}): TestCommandVerification[] {
  const rows: TestCommandVerification[] = [];
  for (let i = 0; i < input.calls.length; i++) {
    const call = input.calls[i]!;
    const event = deriveTestCommandEvent(call);
    if (event === null) continue;
    const priorCommandText: string[] = [];
    let editToolBeforeTest = false;
    for (let j = 0; j < i; j++) {
      const prior = input.calls[j]!;
      if (prior.phase !== call.phase) continue;
      if (prior.command !== null) priorCommandText.push(prior.command);
      if (prior.path !== null) priorCommandText.push(prior.path);
      if (prior.category === "edit") editToolBeforeTest = true;
    }
    const assessment = assessFairVerification({
      policy: input.policy,
      event,
      injectedTestNames: input.injectedTestNames,
      priorCommandText,
      editToolBeforeTest,
      fullOutput: call.output,
    });
    rows.push({
      phase: event.phase,
      command: event.command,
      selectedTests: event.selectedTests,
      parsedOutcome: event.parsedOutcome,
      priorCommandText,
      editToolBeforeTest,
      assessment,
    });
  }
  return rows;
}
