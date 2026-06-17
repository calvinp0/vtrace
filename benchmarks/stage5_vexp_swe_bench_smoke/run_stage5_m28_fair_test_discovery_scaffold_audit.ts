// M28 offline audit — strengthened fair test-discovery scaffold (PURE; no live agents, no
// Docker, no model calls, no 30/100-case runs, no retrieval/scoring/ranking/candidate-gen/
// pivot-selection change). It exercises the M28 code paths over SYNTHETIC inputs (so it is
// fully reproducible and depends on no untracked raw artifacts) and asserts the three audit
// claims the task requires:
//
//   1. Prompt rendering — default/none behavior unchanged; the agent-discovered-tests prompt
//      carries the explicit search/list/read discovery protocol; literal FAIL_TO_PASS names
//      are absent (Option 1) including the static task label (M28 cosmetic cleanup).
//   2. The M23.1 signature (a test run without a discovery chain, captured behind a shell
//      pipeline, matching the injected evaluator label) stays NOT allowed for fair verification,
//      its command is planner-ineligible, and the M27 verifier would still skip it (no Docker).
//   3. A synthetic agent-discovered pytest command WITHOUT shell pipes becomes planner-eligible,
//      and the same command wrapped in a pipe is rejected.
//
// Writes: results/stage5_m28_fair_test_discovery_scaffold_audit.md (committed).
//
// Run: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m28_fair_test_discovery_scaffold_audit.ts

import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  buildRevisionPrompt,
  buildTestExpectation,
} from "../../src/capsuleV2/pivotRevisionPass";
import { computePivotInspectionCompliance } from "../../src/capsuleV2/pivotInspectionCompliance";
import { buildPivotInspectionContract } from "../../src/capsuleV2/pivotInspectionContract";
import {
  classifyTestProvenance,
  computeDiscoveryEvidence,
  fairProvenance,
  classifyTestFramework,
  type DiscoveryEvidence,
} from "../../src/capsule/toolOutputCapture";
import {
  buildAgentTestCommandPlan,
  deriveExpectedImageKey,
  type PlanCommandCandidate,
} from "../../src/capsule/agentTestCommandPlanner";
import {
  decideVerificationEligibility,
  canonicalizeCommand,
} from "../../src/capsule/agentTestCommandVerifier";

const REPORT = path.join(import.meta.dir, "results", "stage5_m28_fair_test_discovery_scaffold_audit.md");

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

// ---- Shared fixtures -----------------------------------------------------------------------

// A non-compliant 2-pivot verdict (lead edited, non-lead only inspected) so the corrective
// prompt fires. No FAIL_TO_PASS passed ⇒ no rule-out conflict ⇒ no internal guardrail token.
function nonCompliant() {
  const contract = buildPivotInspectionContract(
    [{ path: "a/lead.py", symbol: "lead" }, { path: "a/other.py", symbol: "other" }],
    [],
  );
  return computePivotInspectionCompliance({
    enabled: true,
    contract,
    editedFiles: ["a/lead.py"],
    inspectedFiles: ["a/other.py"],
  });
}
const PATCH = "diff --git a/a/lead.py b/a/lead.py\n@@ -1 +1 @@\n-old\n+new\n";
const INJECTED_LABEL = "tests/test_domain_py.py::test_parse_annotation";

// ---- 1) Prompt rendering -------------------------------------------------------------------

const expectation = buildTestExpectation([INJECTED_LABEL], "Empty annotation crashes the parser");
const defaultPrompt = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: expectation });
const nonePrompt = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: expectation, verificationPolicy: "none" });
const fairPrompt = buildRevisionPrompt({ complianceBefore: nonCompliant(), currentPatch: PATCH, testExpectation: expectation, verificationPolicy: "agent_discovered" });

check("default == none (default behavior unchanged)", defaultPrompt === nonePrompt, "omitting the policy and passing \"none\" produce byte-identical prompts");
check("default keeps literal FAIL_TO_PASS names", defaultPrompt.includes("FAIL_TO_PASS:") && defaultPrompt.includes(INJECTED_LABEL), "default prompt still lists the evaluator labels");
check("default has no fair-verification block", !defaultPrompt.includes("## Fair verification"), "the discovery block is opt-in only");

check("fair prompt has the discovery protocol", fairPrompt.includes("Discovery protocol") && fairPrompt.includes("Search/list/read the repository test files"), "explicit search/list/read instruction present");
check("fair prompt forbids guessing from the function name", fairPrompt.includes("Do not guess a test name from the edited function name alone"), "anti-guess instruction present");
check("fair prompt avoids piped/truncated commands", fairPrompt.includes("never a piped or truncated one") && fairPrompt.includes("piping or truncating the test command"), "canonical-command instruction present");
check("fair prompt prefers canonical pytest", fairPrompt.includes("python -m pytest <discovered test node>"), "canonical pytest form suggested");
check("fair prompt suppresses literal FAIL_TO_PASS (incl. static label)", !fairPrompt.includes("FAIL_TO_PASS"), "no FAIL_TO_PASS token in the fair-policy prompt");
check("fair prompt withholds the injected labels", fairPrompt.includes("labels are withheld under the fair verification policy") && !fairPrompt.includes(INJECTED_LABEL), "Option 1 sanitization intact");
// When only a problem statement (no FAIL_TO_PASS) is available, that public context is kept.
const fairProblemPrompt = buildRevisionPrompt({
  complianceBefore: nonCompliant(),
  currentPatch: PATCH,
  testExpectation: buildTestExpectation([], "Empty annotation crashes the parser"),
  verificationPolicy: "agent_discovered",
});
check("fair prompt keeps the public problem-statement excerpt", fairProblemPrompt.includes("Empty annotation crashes the parser") && fairProblemPrompt.includes("## Fair verification"), "problem-statement context is legitimate and retained");
check("fair prompt keeps minimal-diff guardrail", fairPrompt.includes("Prefer the minimal final diff."), "anti-over-edit guardrails preserved");

// ---- 2) M23.1 signature stays ineligible ---------------------------------------------------
//
// The M23.1 capture: the agent ran `tests/test_domain_py.py::test_parse_annotation` (which is the
// injected evaluator label) WITHOUT first searching/reading the repository tests, and behind a
// shell pipeline (`... 2>&1 | head -50`). Reconstructed structurally below.

const m231Command = `python -m pytest ${INJECTED_LABEL} 2>&1 | head -50`;
const m231Discovery: DiscoveryEvidence = computeDiscoveryEvidence({
  selectedTests: [INJECTED_LABEL],
  priorCalls: [
    // Only unrelated source exploration — no search/read of the TEST file, no surfacing output.
    { command: null, path: "sphinx/domains/python.py", category: "read", output: null },
    { command: "git diff", path: null, category: "other", output: null },
  ],
});
const m231Provenance = fairProvenance(
  classifyTestProvenance({
    selectedTests: [INJECTED_LABEL],
    injectedTestNames: [INJECTED_LABEL],
    priorCommandText: ["sphinx/domains/python.py", "git diff"],
    discoveryEvidence: m231Discovery,
  }),
);
check("M23.1 provenance is not allowed for fair verification", m231Provenance.allowedForFairVerification === false, `classification=${m231Provenance.classification}`);
check("M23.1 has no agent-side discovery chain", m231Discovery.priorSearchCommands.length === 0 && m231Discovery.priorReadCommands.length === 0 && m231Discovery.priorOutputsWithTestNode.length === 0, "no search→read/output evidence of the test");

const m231Plan = buildAgentTestCommandPlan({
  sourceRunLabel: "audit-m231",
  instanceId: "sphinx-doc__sphinx-7462",
  patchSource: "pivot_revision_revised",
  patchPath: "/dev/null",
  patchText: "diff --git a/x b/x\n",
  commandSource: "pivot_revision_test_commands",
  candidates: [{
    command: m231Command,
    framework: classifyTestFramework(m231Command),
    selectedTests: [INJECTED_LABEL],
    provenance: m231Provenance,
    parsedOutcomeStatus: "unknown",
  }],
  imagePlan: deriveExpectedImageKey({ instanceId: "sphinx-doc__sphinx-7462" }),
  plannedArtifacts: [],
});
check("M23.1 command is planner-ineligible", m231Plan.eligibleForFutureExecution === false, `blockers: ${m231Plan.blockers.join("; ")}`);
check("M23.1 blocked on provenance AND shell pipeline", m231Plan.blockers.some((b) => b.includes("not allowed for fair verification")) && m231Plan.blockers.some((b) => b.includes("not fair-executable as captured")), "both the injected-provenance and the pipeline gates fire");

const m231Eligibility = decideVerificationEligibility(m231Plan);
check("M27 verifier would skip the M23.1 plan (no Docker)", m231Eligibility.eligible === false, "decideVerificationEligibility returns eligible=false ⇒ plan_ineligible skip before any container");

// ---- 3) A synthetic agent-discovered command becomes planner-eligible ----------------------

const goodCommand = "python -m pytest tests/test_z.py::test_w";
const goodDiscovery = computeDiscoveryEvidence({
  selectedTests: ["tests/test_z.py::test_w"],
  priorCalls: [
    { command: "grep -rn test_w tests/", path: null, category: "other", output: "tests/test_z.py:10:def test_w" },
    { command: "cat tests/test_z.py", path: null, category: "other", output: "def test_w(): assert True" },
  ],
});
const goodProvenance = fairProvenance(
  classifyTestProvenance({
    selectedTests: ["tests/test_z.py::test_w"],
    injectedTestNames: ["tests/other.py::test_other"], // not injected
    priorCommandText: [],
    discoveryEvidence: goodDiscovery,
  }),
);
check("synthetic discovery classifies as agent_discovered", goodProvenance.classification === "agent_discovered" && goodProvenance.allowedForFairVerification, "search→read chain credited");

const goodPlan = buildAgentTestCommandPlan({
  sourceRunLabel: "audit-good",
  instanceId: "django__django-12345",
  patchSource: "pivot_revision_revised",
  patchPath: "/dev/null",
  patchText: "diff --git a/x b/x\n",
  commandSource: "pivot_revision_test_commands",
  candidates: [{
    command: goodCommand,
    framework: classifyTestFramework(goodCommand),
    selectedTests: ["tests/test_z.py::test_w"],
    provenance: goodProvenance,
    parsedOutcomeStatus: "passed",
  }],
  imagePlan: deriveExpectedImageKey({ instanceId: "django__django-12345" }),
  plannedArtifacts: [],
});
check("synthetic agent_discovered command is planner-eligible", goodPlan.eligibleForFutureExecution === true, `blockers: ${goodPlan.blockers.join("; ") || "(none)"}`);
const goodCanon = canonicalizeCommand({ capturedCommand: goodCommand, framework: "pytest", selectedTests: ["tests/test_z.py::test_w"] });
check("synthetic command canonicalizes to a safe pytest invocation", goodCanon.commandCanonicalized && goodCanon.executedCommand === "python -m pytest 'tests/test_z.py::test_w'", `executed=${goodCanon.executedCommand}`);

// The same command, shell-piped, is rejected.
const pipedCommand = `${goodCommand} 2>&1 | head -50`;
const pipedPlan = buildAgentTestCommandPlan({
  sourceRunLabel: "audit-piped",
  instanceId: "django__django-12345",
  patchSource: "pivot_revision_revised",
  patchPath: "/dev/null",
  patchText: "diff --git a/x b/x\n",
  commandSource: "pivot_revision_test_commands",
  candidates: [{
    command: pipedCommand,
    framework: classifyTestFramework(pipedCommand),
    selectedTests: ["tests/test_z.py::test_w"],
    provenance: goodProvenance,
    parsedOutcomeStatus: "passed",
  }],
  imagePlan: deriveExpectedImageKey({ instanceId: "django__django-12345" }),
  plannedArtifacts: [],
});
check("shell-piped agent_discovered command is rejected", pipedPlan.eligibleForFutureExecution === false && pipedPlan.commandSafety.diagnosticOnly === true, `blockers: ${pipedPlan.blockers.join("; ")}`);

// ---- Render report -------------------------------------------------------------------------

const allPass = checks.every((c) => c.pass);
const lines: string[] = [];
lines.push("# Stage 5 — M28 fair test-discovery scaffold audit");
lines.push("");
lines.push("Offline, PURE audit (no live agents, no Docker, no model calls). It exercises the M28");
lines.push("code paths over synthetic inputs and confirms the strengthened discovery scaffold.");
lines.push("");
lines.push(`**Overall: ${allPass ? "PASS" : "FAIL"}** — ${checks.filter((c) => c.pass).length}/${checks.length} checks pass.`);
lines.push("");
lines.push("## What changed");
lines.push("");
lines.push("- The opt-in revision prompt (`--revision-verification-policy agent-discovered-tests`) now");
lines.push("  carries an explicit **discovery protocol**: search/list/read the repository tests, pick the");
lines.push("  smallest test actually discovered, and run it with a canonical (un-piped) command. It also");
lines.push("  forbids guessing a test from the edited function name and copying benchmark/evaluator labels.");
lines.push("- The provenance classifier gained a **strict gate**: `agent_discovered` now requires a prior");
lines.push("  SEARCH over the repository test paths AND a subsequent READ of the test file (or an OUTPUT");
lines.push("  that surfaced the node). A lone grep is only `ambiguous`. An exact injected match still");
lines.push("  disallows. Structured `discoveryEvidence` is attached to each fair-verification report row.");
lines.push("- Default/`none` behavior and the legacy classifier signature are unchanged (backward compatible).");
lines.push("");
lines.push("## Checks");
lines.push("");
lines.push("| # | Check | Result | Detail |");
lines.push("| - | ----- | ------ | ------ |");
checks.forEach((c, i) => {
  lines.push(`| ${i + 1} | ${c.name} | ${c.pass ? "✅ pass" : "❌ FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`);
});
lines.push("");
lines.push("## Fair-policy prompt — discovery section (rendered)");
lines.push("");
lines.push("```text");
const fairSectionStart = fairPrompt.indexOf("## Fair verification");
lines.push(fairPrompt.slice(fairSectionStart, fairPrompt.indexOf("\n\nTask:", fairSectionStart)).trimEnd());
lines.push("```");
lines.push("");
lines.push("## M23.1 signature — stays ineligible");
lines.push("");
lines.push("- Captured command: `" + m231Command + "`");
lines.push(`- Provenance: \`${m231Provenance.classification}\` — allowedForFairVerification=\`${m231Provenance.allowedForFairVerification}\``);
lines.push(`- Planner blockers: ${m231Plan.blockers.map((b) => "`" + b + "`").join(", ")}`);
lines.push(`- M27 verifier eligibility: \`${m231Eligibility.eligible}\` ⇒ would skip (\`plan_ineligible\`) before any container.`);
lines.push("");
lines.push("## Synthetic agent-discovered command — eligible");
lines.push("");
lines.push("- Captured command: `" + goodCommand + "` (after `grep` then `cat` of the test file)");
lines.push(`- Provenance: \`${goodProvenance.classification}\`; planner eligible=\`${goodPlan.eligibleForFutureExecution}\`.`);
lines.push(`- Canonicalized command: \`${goodCanon.executedCommand}\``);
lines.push(`- Same command shell-piped (\`${pipedCommand}\`) ⇒ eligible=\`${pipedPlan.eligibleForFutureExecution}\` (diagnosticOnly).`);
lines.push("");

await writeFile(REPORT, lines.join("\n") + "\n");
process.stdout.write(`${allPass ? "PASS" : "FAIL"} — wrote ${REPORT}\n`);
if (!allPass) process.exitCode = 1;
