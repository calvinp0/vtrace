import assert from "node:assert/strict";
import { test } from "bun:test";

import type { PatchCriticReport } from "./stage5_patch_critic";
import type { LiveCriticMeta } from "./stage5_patch_critic_live";
import {
  type PatchRepairInput,
  type RepairCaller,
  ASTROPY_CDS_EXPECTED_GENERATED_TABLE,
  DEFAULT_ALLOWED_DEFECT_CLASSES,
  buildGeneratedParserConsistencyContext,
  buildGeneratedParserRepairGuidance,
  buildRepairArtifacts,
  buildRepairPrompt,
  checkGeneratedParserRepairShape,
  evaluateRepairEligibility,
  extractUnifiedDiff,
  runPatchRepair,
  validateUnifiedDiff,
} from "./stage5_patch_repair";

// ---------------------------------------------------------------------------
// Fixtures — synthetic critic artifacts (no filesystem, no agents, no model).
// ---------------------------------------------------------------------------

const SYMPY_FIRST_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -346,6 +346,10 @@ def _print_Stream(self, strm):",
  "     def _print_NoneToken(self, arg):",
  "         return 'None'",
  " ",
  "+    def _print_Indexed(self, expr):",
  "+        indices = [self._print(i) for i in expr.indices]",
  "+        return '{}[{}]'.format(self._print(expr.base.label), ', '.join(indices))",
  "+",
  " ",
  " class PythonCodePrinter(AbstractPythonCodePrinter):",
].join("\n");

// A repaired diff that relocates the method (differs from the first patch).
const SYMPY_REPAIRED_PATCH = [
  "diff --git a/sympy/printing/pycode.py b/sympy/printing/pycode.py",
  "--- a/sympy/printing/pycode.py",
  "+++ b/sympy/printing/pycode.py",
  "@@ -360,6 +360,10 @@ class PythonCodePrinter(AbstractPythonCodePrinter):",
  "     def _print_Symbol(self, expr):",
  "         return expr.name",
  " ",
  "+    def _print_Indexed(self, expr):",
  "+        indices = [self._print(i) for i in expr.indices]",
  "+        return '{}[{}]'.format(self._print(expr.base.label), ', '.join(indices))",
  "+",
].join("\n");

function reportFor(args: {
  instanceId: string;
  repairRequired?: boolean;
  repairReason?: string;
  repairInstructions?: string;
}): PatchCriticReport {
  const repairRequired = args.repairRequired ?? true;
  return {
    instanceId: args.instanceId,
    runLabel: `eval-${args.instanceId}`,
    scope_ok: false,
    scope_evidence: "inserted_method_scope shows the method landed in the wrong class.",
    failing_behavior_handled: true,
    failing_behavior_evidence: "Behavior produced via inheritance.",
    minimality_ok: true,
    minimality_evidence: "Additive single-method insertion.",
    test_evidence_ok: null,
    test_evidence: "Only an ad-hoc smoke check was run.",
    risk: "medium",
    repair_required: repairRequired,
    repair_reason: args.repairReason ?? (repairRequired ? "Wrong scope: method landed outside the intended class." : ""),
    repair_instructions:
      args.repairInstructions ??
      (repairRequired
        ? "Relocate the existing `_print_Indexed` method out of AbstractPythonCodePrinter and into the PythonCodePrinter class body, preserving the same implementation and indentation."
        : ""),
    confidence: "medium",
    evidence_probe_ids: ["inserted_method_scope"],
  };
}

function metaFor(overrides: Partial<LiveCriticMeta> = {}): LiveCriticMeta {
  return {
    enabled: true,
    ran: true,
    validReport: true,
    failedOpen: false,
    error: null,
    criticModel: "mock-critic",
    criticCostUsd: 0.12,
    criticInputTokens: 4000,
    criticOutputTokens: 2000,
    deterministicRepairRequired: true,
    liveRepairRequired: true,
    agreementWithDeterministic: true,
    ...overrides,
  };
}

// A counting mock repair caller; NEVER touches a live model.
function mockCaller(opts: { response?: string; costUsd?: number; throws?: boolean } = {}): {
  caller: RepairCaller;
  readonly calls: number;
  readonly lastPrompt: string | null;
} {
  let calls = 0;
  let lastPrompt: string | null = null;
  const caller: RepairCaller = async (prompt) => {
    calls += 1;
    lastPrompt = prompt;
    if (opts.throws) throw new Error("simulated repair invocation failure");
    return {
      raw: opts.response ?? SYMPY_REPAIRED_PATCH,
      model: "mock-repair",
      costUsd: opts.costUsd ?? 0.05,
      inputTokens: 2000,
      outputTokens: 200,
    };
  };
  return {
    caller,
    get calls() {
      return calls;
    },
    get lastPrompt() {
      return lastPrompt;
    },
  };
}

// ---------------------------------------------------------------------------
// extractUnifiedDiff / validateUnifiedDiff
// ---------------------------------------------------------------------------
test("extractUnifiedDiff pulls a diff out of fenced and prose-wrapped responses", () => {
  assert.equal(extractUnifiedDiff(SYMPY_REPAIRED_PATCH), SYMPY_REPAIRED_PATCH);
  const fenced = "Here is the fix:\n```diff\n" + SYMPY_REPAIRED_PATCH + "\n```\nDone.";
  assert.equal(extractUnifiedDiff(fenced), SYMPY_REPAIRED_PATCH);
  const prose = "I think this works:\n\n" + SYMPY_REPAIRED_PATCH;
  assert.equal(extractUnifiedDiff(prose), SYMPY_REPAIRED_PATCH);
  assert.equal(extractUnifiedDiff("no diff here, just refusing"), null);
  assert.equal(extractUnifiedDiff(""), null);
});

// Hardened extraction (the Astropy failure mode): a bare ``` fence wrapping reasoning followed by
// the REAL diff outside it, prose on both sides, multiple fences, and no-diff responses.
test("extractUnifiedDiff: a normal fenced ```diff block extracts correctly", () => {
  const fenced = "Here is the fix:\n```diff\n" + SYMPY_REPAIRED_PATCH + "\n```\n";
  assert.equal(extractUnifiedDiff(fenced), SYMPY_REPAIRED_PATCH);
});

test("extractUnifiedDiff: bare prose fence followed by a real diff OUTSIDE the fence extracts the outside diff", () => {
  // The model wrapped its reasoning in a bare ``` fence and emitted the actual diff after it.
  const response =
    "```\n" +
    "I considered the grammar and decided to reorder the division production.\n" +
    "PLY would normally regenerate the table at import time.\n" +
    "```\n\n" +
    SYMPY_REPAIRED_PATCH +
    "\n";
  assert.equal(extractUnifiedDiff(response), SYMPY_REPAIRED_PATCH);
});

test("extractUnifiedDiff: prose before AND after the diff extracts only the diff", () => {
  const response =
    "Here is my reasoning before the patch.\n\n" +
    SYMPY_REPAIRED_PATCH +
    "\n\nThat should resolve the issue cleanly.\n";
  assert.equal(extractUnifiedDiff(response), SYMPY_REPAIRED_PATCH);
});

test("extractUnifiedDiff: a response with no diff returns null", () => {
  assert.equal(extractUnifiedDiff("I cannot produce a diff for this; here is some prose instead."), null);
  assert.equal(extractUnifiedDiff("```\njust some fenced prose, no diff\n```"), null);
  assert.equal(extractUnifiedDiff(""), null);
});

test("extractUnifiedDiff: multiple fences where only one contains the diff extracts the diff fence", () => {
  const response =
    "First, some reasoning:\n```\nthis fence is only prose\n```\n" +
    "And the patch:\n```diff\n" +
    SYMPY_REPAIRED_PATCH +
    "\n```\n";
  assert.equal(extractUnifiedDiff(response), SYMPY_REPAIRED_PATCH);
});

test("validateUnifiedDiff requires file + hunk headers", () => {
  assert.deepEqual(validateUnifiedDiff(SYMPY_REPAIRED_PATCH), []);
  assert.ok(validateUnifiedDiff("just some prose").length > 0);
  // file header but no hunk
  assert.ok(validateUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x").length > 0);
});

// ---------------------------------------------------------------------------
// Eligibility (the artifact-derived gates)
// ---------------------------------------------------------------------------
// 6. wrong_scope with actionable instructions is eligible.
test("wrong_scope with actionable instructions is eligible", () => {
  const e = evaluateRepairEligibility({
    runLabel: "eval-patchverify-before-sympy-16766",
    meta: metaFor(),
    report: reportFor({ instanceId: "sympy__sympy-16766" }),
    firstPatch: SYMPY_FIRST_PATCH,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(e.eligible, true, e.reasons.join("; "));
  assert.equal(e.defectClass, "wrong_scope");
  assert.ok(e.instructionQuality === "actionable" || e.instructionQuality === "concrete");
});

// 7. broad_rewrite_minimality with actionable instructions is eligible.
test("broad_rewrite_minimality with actionable instructions is eligible", () => {
  const e = evaluateRepairEligibility({
    runLabel: "eval-editguard-before-requests-5414",
    meta: metaFor(),
    report: reportFor({
      instanceId: "psf__requests-5414",
      repairReason: "Broad control-flow rewrite where a minimal additive change would suffice.",
      repairInstructions:
        "Restore the original `unicode_is_ascii` control-flow gate and keep only a minimal additive validation for empty IDNA labels; avoid rewriting the entire branch.",
    }),
    firstPatch: SYMPY_FIRST_PATCH,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(e.eligible, true, e.reasons.join("; "));
  assert.equal(e.defectClass, "broad_rewrite_minimality");
});

// 5. missing_failing_behavior is ineligible by default.
test("missing_failing_behavior is ineligible by default but allowed when explicitly permitted", () => {
  const base = {
    runLabel: "eval-editguard-before-matplotlib-22719",
    meta: metaFor(),
    report: reportFor({
      instanceId: "matplotlib__matplotlib-22719",
      repairInstructions: "Add an explicit empty-array handling path in `lib/matplotlib/category.py` before the assuming branch.",
    }),
    firstPatch: SYMPY_FIRST_PATCH,
  };
  const def = evaluateRepairEligibility({ ...base, allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES });
  assert.equal(def.eligible, false);
  assert.ok(def.reasons.some((r) => r.includes("missing_failing_behavior")));
  // Explicitly allowing the class (other gates pass) flips it eligible.
  const allowed = evaluateRepairEligibility({ ...base, allowedDefectClasses: ["missing_failing_behavior"] });
  assert.equal(allowed.eligible, true, allowed.reasons.join("; "));
});

// 3. Only liveRepairRequired=true runs are eligible.
test("liveRepairRequired=false is ineligible", () => {
  const e = evaluateRepairEligibility({
    runLabel: "x",
    meta: metaFor({ liveRepairRequired: false }),
    report: reportFor({ instanceId: "sympy__sympy-16766" }),
    firstPatch: SYMPY_FIRST_PATCH,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.some((r) => /liveRepairRequired/.test(r)));
});

// 4. failedOpen/invalid live critic report is ineligible.
test("failedOpen or invalid live critic report is ineligible", () => {
  const failedOpen = evaluateRepairEligibility({
    runLabel: "x",
    meta: metaFor({ failedOpen: true }),
    report: reportFor({ instanceId: "sympy__sympy-16766" }),
    firstPatch: SYMPY_FIRST_PATCH,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(failedOpen.eligible, false);
  assert.ok(failedOpen.reasons.some((r) => /failed open/.test(r)));

  const invalid = evaluateRepairEligibility({
    runLabel: "x",
    meta: metaFor({ validReport: false }),
    report: reportFor({ instanceId: "sympy__sympy-16766" }),
    firstPatch: SYMPY_FIRST_PATCH,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(invalid.eligible, false);
  assert.ok(invalid.reasons.some((r) => /not valid/.test(r)));

  // Missing artifacts entirely.
  const missing = evaluateRepairEligibility({
    runLabel: "x",
    meta: null,
    report: null,
    firstPatch: null,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(missing.eligible, false);
});

test("empty repair_reason/instructions make a run ineligible even if repair_required", () => {
  const e = evaluateRepairEligibility({
    runLabel: "x",
    meta: metaFor(),
    report: reportFor({ instanceId: "sympy__sympy-16766", repairReason: "", repairInstructions: "" }),
    firstPatch: SYMPY_FIRST_PATCH,
    allowedDefectClasses: DEFAULT_ALLOWED_DEFECT_CLASSES,
  });
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.some((r) => /repair_reason/.test(r)));
  assert.ok(e.reasons.some((r) => /repair_instructions/.test(r)));
});

// ---------------------------------------------------------------------------
// runPatchRepair — exactly one attempt, fail-open, never modifies first patch
// ---------------------------------------------------------------------------
function inputFor(firstPatch = SYMPY_FIRST_PATCH) {
  return {
    instanceId: "sympy__sympy-16766",
    runLabel: "eval-patchverify-before-sympy-16766",
    defectClass: "wrong_scope" as const,
    issueText: null,
    firstPatch,
    criticReport: reportFor({ instanceId: "sympy__sympy-16766" }),
    repairInstructions: reportFor({ instanceId: "sympy__sympy-16766" }).repair_instructions,
  };
}

// 1. Repair disabled does not call the model.
test("disabled repair does not call the model and reports ran=false", async () => {
  const m = mockCaller();
  const { result } = await runPatchRepair({ enabled: false, input: inputFor(), caller: m.caller, repairModel: null });
  assert.equal(m.calls, 0);
  assert.equal(result.ran, false);
  assert.equal(result.repairedPatch, null);
});

// 12. valid unified diff repair output is accepted (and exactly one call is made).
test("a valid repaired diff is accepted with exactly one model call", async () => {
  const m = mockCaller();
  const { result } = await runPatchRepair({ enabled: true, input: inputFor(), caller: m.caller, repairModel: null });
  assert.equal(m.calls, 1); // exactly one attempt, never a loop
  assert.equal(result.ran, true);
  assert.equal(result.validPatch, true);
  assert.equal(result.failedOpen, false);
  assert.equal(result.repairedPatch, SYMPY_REPAIRED_PATCH);
  assert.equal(result.changedPatch, true);
  assert.equal(result.repairCostUsd, 0.05);
});

// 11. invalid repair output fails open.
test("invalid repair output fails open (one call, first patch preserved)", async () => {
  const m = mockCaller({ response: "I cannot produce a diff for this." });
  const { result } = await runPatchRepair({ enabled: true, input: inputFor(), caller: m.caller, repairModel: null });
  assert.equal(m.calls, 1);
  assert.equal(result.ran, true);
  assert.equal(result.validPatch, false);
  assert.equal(result.failedOpen, true);
  assert.equal(result.repairedPatch, null);
  assert.ok(result.error && /no unified diff/.test(result.error));
});

test("a thrown invocation fails open without throwing", async () => {
  const m = mockCaller({ throws: true });
  const { result } = await runPatchRepair({ enabled: true, input: inputFor(), caller: m.caller, repairModel: null });
  assert.equal(m.calls, 1);
  assert.equal(result.failedOpen, true);
  assert.equal(result.repairedPatch, null);
  assert.ok(result.error && /invocation failed/.test(result.error));
});

// 13. first patch is not modified by repair.
test("the first patch string is never mutated by a repair attempt", async () => {
  const original = SYMPY_FIRST_PATCH;
  const input = inputFor(original);
  const m = mockCaller();
  await runPatchRepair({ enabled: true, input, caller: m.caller, repairModel: null });
  assert.equal(input.firstPatch, original); // unchanged reference content
  assert.equal(SYMPY_FIRST_PATCH, original);
});

test("a repaired diff identical to the first patch reports changedPatch=false", async () => {
  const m = mockCaller({ response: SYMPY_FIRST_PATCH });
  const { result } = await runPatchRepair({ enabled: true, input: inputFor(), caller: m.caller, repairModel: null });
  assert.equal(result.validPatch, true);
  assert.equal(result.changedPatch, false);
});

// ---------------------------------------------------------------------------
// Artifacts — repaired patch only written when produced; first patch copied
// ---------------------------------------------------------------------------
test("buildRepairArtifacts copies the first patch and includes the repaired patch only when present", () => {
  const input = inputFor();
  const ok = buildRepairArtifacts({
    input,
    outcome: {
      result: {
        ran: true,
        validPatch: true,
        failedOpen: false,
        error: null,
        repairedPatch: SYMPY_REPAIRED_PATCH,
        changedPatch: true,
        repairCostUsd: 0.05,
        repairInputTokens: 2000,
        repairOutputTokens: 200,
      },
      prompt: "p",
      raw: SYMPY_REPAIRED_PATCH,
    },
    meta: {
      enabled: true,
      runLabel: input.runLabel,
      instanceId: input.instanceId,
      defectClass: "wrong_scope",
      instructionQuality: "actionable",
      result: {
        ran: true,
        validPatch: true,
        failedOpen: false,
        error: null,
        repairedPatch: SYMPY_REPAIRED_PATCH,
        changedPatch: true,
        repairCostUsd: 0.05,
        repairInputTokens: 2000,
        repairOutputTokens: 200,
      },
      evaluation: { requested: false, performed: false, note: "n/a" },
    },
  });
  assert.ok("_first_patch.diff" in ok);
  assert.ok("_repaired_patch.diff" in ok);
  assert.ok(ok["_first_patch.diff"]!.startsWith("diff --git a/sympy"));

  // Failed-open: no repaired patch artifact, first patch still copied.
  const failed = buildRepairArtifacts({
    input,
    outcome: {
      result: {
        ran: true,
        validPatch: false,
        failedOpen: true,
        error: "no unified diff found in repair response",
        repairedPatch: null,
        changedPatch: false,
        repairCostUsd: 0.01,
        repairInputTokens: 100,
        repairOutputTokens: 5,
      },
      prompt: "p",
      raw: "refused",
    },
    meta: {
      enabled: true,
      runLabel: input.runLabel,
      instanceId: input.instanceId,
      defectClass: "wrong_scope",
      instructionQuality: "actionable",
      result: {
        ran: true,
        validPatch: false,
        failedOpen: true,
        error: "no unified diff found in repair response",
        repairedPatch: null,
        changedPatch: false,
        repairCostUsd: 0.01,
        repairInputTokens: 100,
        repairOutputTokens: 5,
      },
      evaluation: { requested: false, performed: false, note: "n/a" },
    },
  });
  assert.ok("_first_patch.diff" in failed);
  assert.ok(!("_repaired_patch.diff" in failed)); // not written on fail-open
});

// ---------------------------------------------------------------------------
// Generated-parser post-repair SHAPE gate + repair prompt OUTPUT CONTRACT
// ---------------------------------------------------------------------------
// Fixtures mirror the Astropy/CDS generated-parser case: a cds.py grammar source change whose
// sibling generated table is astropy/units/format/cds_parsetab.py.

const CDS_SOURCE_DIR = "astropy/units/format";

// The first patch: a narrow cds.py grammar edit (used only to DERIVE the consistency context —
// expected table = cds_parsetab.py). Its own table-update state is irrelevant to the repair gate.
const CDS_FIRST_PATCH = [
  `diff --git a/${CDS_SOURCE_DIR}/cds.py b/${CDS_SOURCE_DIR}/cds.py`,
  `--- a/${CDS_SOURCE_DIR}/cds.py`,
  `+++ b/${CDS_SOURCE_DIR}/cds.py`,
  "@@ -198,6 +198,7 @@",
  " def p_division_of_units(p):",
  "     '''",
  "     division_of_units : DIVISION unit_expression",
  "                       | unit_expression DIVISION combined_units",
  "+                      | combined_units DIVISION unit_expression",
  "     '''",
  "     pass",
].join("\n");

// ACCEPTED shape: narrow cds.py grammar edit AND a consistent cds_parsetab.py update.
const CDS_REPAIRED_ACCEPT = [
  `diff --git a/${CDS_SOURCE_DIR}/cds.py b/${CDS_SOURCE_DIR}/cds.py`,
  `--- a/${CDS_SOURCE_DIR}/cds.py`,
  `+++ b/${CDS_SOURCE_DIR}/cds.py`,
  "@@ -198,6 +198,7 @@",
  " def p_division_of_units(p):",
  "     '''",
  "     division_of_units : DIVISION unit_expression",
  "                       | unit_expression DIVISION combined_units",
  "+                      | combined_units DIVISION unit_expression",
  "     '''",
  "     pass",
  `diff --git a/${CDS_SOURCE_DIR}/cds_parsetab.py b/${CDS_SOURCE_DIR}/cds_parsetab.py`,
  `--- a/${CDS_SOURCE_DIR}/cds_parsetab.py`,
  `+++ b/${CDS_SOURCE_DIR}/cds_parsetab.py`,
  "@@ -1,3 +1,3 @@",
  "-_lr_signature = 'OLDSIGNATURE'",
  "+_lr_signature = 'NEWSIGNATURE'",
  " _lr_action_items = {}",
].join("\n");

// REJECTED: cds.py grammar edit with NO generated-table update (the prior Astropy failure shape).
const CDS_REPAIRED_SOURCE_ONLY = [
  `diff --git a/${CDS_SOURCE_DIR}/cds.py b/${CDS_SOURCE_DIR}/cds.py`,
  `--- a/${CDS_SOURCE_DIR}/cds.py`,
  `+++ b/${CDS_SOURCE_DIR}/cds.py`,
  "@@ -198,6 +198,7 @@",
  " def p_division_of_units(p):",
  "     '''",
  "     division_of_units : DIVISION unit_expression",
  "                       | unit_expression DIVISION combined_units",
  "+                      | combined_units DIVISION unit_expression",
  "     '''",
  "     pass",
].join("\n");

// REJECTED: deletes the generated parser table.
const CDS_REPAIRED_DELETES_TABLE = [
  `diff --git a/${CDS_SOURCE_DIR}/cds.py b/${CDS_SOURCE_DIR}/cds.py`,
  `--- a/${CDS_SOURCE_DIR}/cds.py`,
  `+++ b/${CDS_SOURCE_DIR}/cds.py`,
  "@@ -198,6 +198,7 @@",
  " def p_division_of_units(p):",
  "     '''",
  "     division_of_units : DIVISION unit_expression",
  "+                      | combined_units DIVISION unit_expression",
  "     '''",
  "     pass",
  `diff --git a/${CDS_SOURCE_DIR}/cds_parsetab.py b/${CDS_SOURCE_DIR}/cds_parsetab.py`,
  "deleted file mode 100644",
  `--- a/${CDS_SOURCE_DIR}/cds_parsetab.py`,
  "+++ /dev/null",
  "@@ -1,3 +0,0 @@",
  "-_lr_signature = 'X'",
  "-_lr_action = {}",
  "-_lr_goto = {}",
].join("\n");

// REJECTED: broad rewrite — one parser function removed, another rewritten (productions relocated).
const CDS_REPAIRED_BROAD_REWRITE = [
  `diff --git a/${CDS_SOURCE_DIR}/cds.py b/${CDS_SOURCE_DIR}/cds.py`,
  `--- a/${CDS_SOURCE_DIR}/cds.py`,
  `+++ b/${CDS_SOURCE_DIR}/cds.py`,
  "@@ -150,10 +150,7 @@",
  "-def p_product_of_units(p):",
  "-    '''",
  "-    product_of_units : unit_expression PRODUCT combined_units",
  "-                     | unit_expression",
  "-    '''",
  "-    pass",
  " def p_combined_units(p):",
  "     '''",
  "     combined_units : product_of_units",
  "+                   | product_of_units PRODUCT combined_units",
  "                    | division_of_units",
  "     '''",
].join("\n");

const CDS_EXPECTED_TABLES = [`${CDS_SOURCE_DIR}/cds_parsetab.py`];

test("buildGeneratedParserConsistencyContext: derives the expected cds_parsetab.py table for a cds.py grammar change", () => {
  const cons = buildGeneratedParserConsistencyContext(CDS_FIRST_PATCH);
  assert.ok(cons !== null);
  assert.deepEqual([...cons!.expectedGeneratedTables], CDS_EXPECTED_TABLES);
  assert.ok(cons!.expectedGeneratedTables.includes(ASTROPY_CDS_EXPECTED_GENERATED_TABLE));
});

test("shape gate ACCEPTS a narrow grammar source edit plus a consistent parsetab update", () => {
  const shape = checkGeneratedParserRepairShape(CDS_REPAIRED_ACCEPT, CDS_EXPECTED_TABLES);
  assert.equal(shape.checked, true);
  assert.equal(shape.accepted, true, shape.rejectedReason ?? "");
  assert.equal(shape.rejectedReason, null);
  assert.deepEqual([...shape.missingExpectedTables], []);
  assert.ok(shape.tablesUpdated.includes(ASTROPY_CDS_EXPECTED_GENERATED_TABLE));
  assert.equal(shape.deletesGeneratedTables, false);
  assert.equal(shape.broadRewriteDetected, false);
});

test("shape gate REJECTS a source grammar edit with no expected parsetab update", () => {
  const shape = checkGeneratedParserRepairShape(CDS_REPAIRED_SOURCE_ONLY, CDS_EXPECTED_TABLES);
  assert.equal(shape.accepted, false);
  assert.ok(shape.missingExpectedTables.includes(ASTROPY_CDS_EXPECTED_GENERATED_TABLE));
  assert.ok(shape.rejectedReason && /cds_parsetab\.py/.test(shape.rejectedReason));
  assert.ok(shape.rejectedReason && /expected generated parser table/.test(shape.rejectedReason));
});

test("shape gate REJECTS a repaired patch that deletes the generated parser table", () => {
  const shape = checkGeneratedParserRepairShape(CDS_REPAIRED_DELETES_TABLE, CDS_EXPECTED_TABLES);
  assert.equal(shape.accepted, false);
  assert.equal(shape.deletesGeneratedTables, true);
  assert.ok(shape.rejectedReason && /delete/.test(shape.rejectedReason));
});

test("shape gate REJECTS a broad grammar rewrite / production relocation", () => {
  const shape = checkGeneratedParserRepairShape(CDS_REPAIRED_BROAD_REWRITE, CDS_EXPECTED_TABLES);
  assert.equal(shape.accepted, false);
  assert.equal(shape.broadRewriteDetected, true);
  assert.ok(shape.rejectedReason && /broadly relocates|rewrites/.test(shape.rejectedReason));
});

// Build a generated-parser repair input whose consistency context drives the post-repair shape gate.
function gpRepairInputFor(): PatchRepairInput {
  const consistency = buildGeneratedParserConsistencyContext(CDS_FIRST_PATCH);
  assert.ok(consistency !== null);
  const report = reportFor({
    instanceId: "astropy__astropy-14369",
    repairReason: "Broad non-minimal generated-parser rewrite.",
    repairInstructions:
      "Reorder the division_of_units production within p_division_of_units and update the generated parser table consistently; do not delete generated parser tables.",
  });
  return {
    instanceId: "astropy__astropy-14369",
    runLabel: "eval-strictv2-artifacts-protocol-vtrace-astropy-14369",
    defectClass: "broad_rewrite_minimality",
    issueText: null,
    firstPatch: CDS_FIRST_PATCH,
    criticReport: report,
    repairInstructions: report.repair_instructions,
    generatedParserRepair: {
      source: "generated_parser_minimality",
      guidance: buildGeneratedParserRepairGuidance(report, null, consistency),
      liveCriticInstruction: report.repair_instructions,
      narrowAlternativeHint: null,
      consistency,
    },
  };
}

test("runPatchRepair: generated-parser repair with a consistent table update PASSES the shape gate", async () => {
  const m = mockCaller({ response: CDS_REPAIRED_ACCEPT });
  const { result } = await runPatchRepair({
    enabled: true,
    input: gpRepairInputFor(),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(result.validPatch, true);
  assert.equal(result.failedOpen, false);
  assert.equal(result.repairedPatch, CDS_REPAIRED_ACCEPT);
  assert.equal(result.generatedParserRepairShapeChecked, true);
  assert.equal(result.generatedParserRepairShapeAccepted, true);
  assert.ok(result.generatedParserRepairTablesUpdated.includes(ASTROPY_CDS_EXPECTED_GENERATED_TABLE));
  assert.equal(result.rejectedRepairedPatch, null);
});

test("runPatchRepair: generated-parser repair that leaves the table stale is REJECTED and fails open", async () => {
  const m = mockCaller({ response: CDS_REPAIRED_SOURCE_ONLY });
  const { result } = await runPatchRepair({
    enabled: true,
    input: gpRepairInputFor(),
    caller: m.caller,
    repairModel: null,
  });
  assert.equal(m.calls, 1);
  assert.equal(result.validPatch, false);
  assert.equal(result.failedOpen, true); // original first patch preserved (repairedPatch=null)
  assert.equal(result.repairedPatch, null);
  assert.equal(result.generatedParserRepairShapeChecked, true);
  assert.equal(result.generatedParserRepairShapeAccepted, false);
  assert.ok(result.error && /generated-parser repair shape rejected/.test(result.error));
  assert.ok(result.generatedParserRepairMissingExpectedTables.includes(ASTROPY_CDS_EXPECTED_GENERATED_TABLE));
  // The rejected diff is preserved for diagnosis but is NOT the operative patch.
  assert.equal(result.rejectedRepairedPatch, CDS_REPAIRED_SOURCE_ONLY);
});

test("repair result carries the generated-parser shape-gate report fields", async () => {
  const m = mockCaller({ response: CDS_REPAIRED_ACCEPT });
  const { result } = await runPatchRepair({
    enabled: true,
    input: gpRepairInputFor(),
    caller: m.caller,
    repairModel: null,
  });
  for (const field of [
    "generatedParserRepairShapeChecked",
    "generatedParserRepairShapeAccepted",
    "generatedParserRepairShapeRejectedReason",
    "generatedParserRepairMissingExpectedTables",
    "generatedParserRepairTablesUpdated",
    "generatedParserRepairDeletesGeneratedTables",
    "generatedParserRepairBroadRewriteDetected",
  ]) {
    assert.ok(field in result, `missing shape-gate field ${field}`);
  }
});

test("runPatchRepair: a non-generated-parser repair does NOT run the shape gate", async () => {
  const m = mockCaller(); // default SYMPY_REPAIRED_PATCH; default input has no generatedParserRepair
  const { result } = await runPatchRepair({ enabled: true, input: inputFor(), caller: m.caller, repairModel: null });
  assert.equal(result.validPatch, true);
  assert.equal(result.generatedParserRepairShapeChecked, false);
  assert.equal(result.generatedParserRepairShapeAccepted, null);
});

// --- Prompt / output contract ----------------------------------------------
test("generated-parser repair guidance includes the diff-only OUTPUT CONTRACT", () => {
  const consistency = buildGeneratedParserConsistencyContext(CDS_FIRST_PATCH);
  const guidance = buildGeneratedParserRepairGuidance(reportFor({ instanceId: "astropy__astropy-14369" }), null, consistency);
  const text = guidance.join("\n");
  assert.ok(text.includes("Output contract:"));
  assert.ok(text.includes("Return only a unified diff."));
  assert.ok(text.includes("Do not wrap reasoning in markdown fences."));
});

test("generated-parser repair guidance requires the diff to begin with `diff --git`", () => {
  const consistency = buildGeneratedParserConsistencyContext(CDS_FIRST_PATCH);
  const guidance = buildGeneratedParserRepairGuidance(reportFor({ instanceId: "astropy__astropy-14369" }), null, consistency);
  assert.ok(guidance.join("\n").includes("The diff must begin with `diff --git`."));
});

test("generated-parser repair guidance states the expected generated table update is required (Astropy/CDS named)", () => {
  const consistency = buildGeneratedParserConsistencyContext(CDS_FIRST_PATCH);
  const guidance = buildGeneratedParserRepairGuidance(reportFor({ instanceId: "astropy__astropy-14369" }), null, consistency);
  const text = guidance.join("\n");
  assert.ok(text.includes("must update the expected generated parser table(s)"));
  assert.ok(text.includes(ASTROPY_CDS_EXPECTED_GENERATED_TABLE));
  assert.ok(text.includes(`This repair is incomplete unless ${ASTROPY_CDS_EXPECTED_GENERATED_TABLE} is updated`));
});

test("buildRepairPrompt threads the generated-parser output contract into the full prompt", () => {
  const prompt = buildRepairPrompt(gpRepairInputFor());
  assert.ok(prompt.includes("Output contract:"));
  assert.ok(prompt.includes("The diff must begin with `diff --git`."));
  assert.ok(prompt.includes(ASTROPY_CDS_EXPECTED_GENERATED_TABLE));
});
