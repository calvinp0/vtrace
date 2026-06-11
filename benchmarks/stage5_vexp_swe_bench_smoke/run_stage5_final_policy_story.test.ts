import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  type PolicyRow,
  type RepairEvidence,
  type StoryInputs,
  CLAIMS,
  FINAL_RECOMMENDATION,
  NEXT_PRODUCTIZATION_WORK,
  NON_CLAIMS,
  buildReport,
  loadStoryInputs,
  parseArgs,
  parsePivotCheckPolicy,
  parsePolicyRow,
  parseRepairEvidence,
  renderJson,
  renderMarkdown,
} from "./run_stage5_final_policy_story";

// --- fixtures: the committed final numbers, as a pure StoryInputs (no filesystem) -------
function row(name: string, resolved: number, cost: number, tokens: number): PolicyRow {
  return { policyName: name, taskCount: 10, resolvedCount: resolved, totalCostUsd: cost, totalTokens: tokens, costPerResolved: cost / resolved, tokensPerResolved: tokens / resolved };
}

function repair(): RepairEvidence {
  return {
    runLabel: "eval-strictgated-vtrace-requests-5414",
    instanceId: "psf__requests-5414",
    converted: true,
    dockerUsed: true,
    resolved: true,
    criticCostUsd: 0.1909,
    repairCostUsd: 0.2241,
    totalRecoveryCostUsd: 0.415,
  };
}

function inputs(overrides: Partial<StoryInputs> = {}): StoryInputs {
  return {
    taskCount: 10,
    baseline: row("baseline", 8, 6.9777, 16756692),
    oldFirstPatch: row("old_vtrace_first_patch", 5, 8.2089, 17074981),
    strictFirstPatch: row("strict_vtrace_first_patch", 7, 6.408, 12526985),
    strictWithRepair: row("strict_vtrace_with_verified_repair", 8, 6.823, 12543588),
    pivotCheckPolicy: "strict_risk_gated",
    strictRunTaskCount: 10,
    repair: repair(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 9. Emits required Markdown sections.
// ---------------------------------------------------------------------------
test("emits required Markdown sections", () => {
  const md = renderMarkdown(buildReport({ generatedAt: "t", inputs: inputs() }));
  for (const section of [
    "# Stage 5 final policy story",
    "## Executive summary",
    "## What changed",
    "## Controlled 10-task results",
    "## Token and cost outcome",
    "## Resolution outcome",
    "## Strict pivot-check default",
    "## Gated repair outcome",
    "## Why repair remains gated",
    "## What we can claim",
    "## What we cannot claim",
    "## Final recommendation",
    "## Next productization work",
  ]) {
    assert.ok(md.includes(section), `missing section ${section}`);
  }
});

// ---------------------------------------------------------------------------
// 10. Emits required JSON fields.
// ---------------------------------------------------------------------------
test("emits required JSON fields", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  const json = JSON.parse(renderJson(report));
  for (const key of [
    "generatedAt", "taskCount", "pivotCheckPolicy", "executiveSummary", "policies",
    "tokenCostOutcome", "resolutionOutcome", "repair", "claims", "nonClaims",
    "whyRepairGated", "finalRecommendation", "nextProductizationWork",
  ]) {
    assert.ok(key in json, `missing key ${key}`);
  }
  // policy rows are present for all four narrative policies
  const names = json.policies.map((p: { policyName: string }) => p.policyName);
  for (const required of ["baseline", "old_vtrace_first_patch", "strict_vtrace_first_patch", "strict_vtrace_with_verified_repair"]) {
    assert.ok(names.includes(required), `policies missing ${required}`);
  }
  for (const key of ["lowerCostThanBaseline", "fewerTokensThanBaseline", "costDeltaVsBaseline", "tokensDeltaVsBaseline"]) {
    assert.ok(key in json.tokenCostOutcome, `tokenCostOutcome missing ${key}`);
  }
  for (const key of ["baselineResolved", "strictWithRepairResolved", "strictMatchesBaseline", "strictImprovesOverOld"]) {
    assert.ok(key in json.resolutionOutcome, `resolutionOutcome missing ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Numbers are data-driven (read from inputs, not hardcoded).
// ---------------------------------------------------------------------------
test("controlled-set numbers come from the inputs, not hardcoded", () => {
  // Feed deliberately different numbers; the report must reflect THEM.
  const alt = inputs({
    baseline: row("baseline", 6, 5.0, 10000000),
    strictWithRepair: row("strict_vtrace_with_verified_repair", 6, 4.0, 9000000),
  });
  const report = buildReport({ generatedAt: "t", inputs: alt });
  assert.equal(report.resolutionOutcome.baselineResolved, 6);
  assert.equal(report.resolutionOutcome.strictWithRepairResolved, 6);
  assert.equal(report.tokenCostOutcome.strictWithRepairTotalCostUsd, 4.0);
  assert.equal(report.tokenCostOutcome.strictWithRepairTotalTokens, 9000000);
  assert.equal(report.tokenCostOutcome.costDeltaVsBaseline, 4.0 - 5.0);
  assert.equal(report.tokenCostOutcome.tokensDeltaVsBaseline, 9000000 - 10000000);
  const md = renderMarkdown(report);
  assert.ok(md.includes("| baseline | 6/10 | $5.0000 | 10000000 |"));
  assert.ok(md.includes("| strict_vtrace_with_verified_repair | 6/10 | $4.0000 | 9000000 |"));
});

// ---------------------------------------------------------------------------
// Resolution + token/cost outcome computed from the real final numbers.
// ---------------------------------------------------------------------------
test("computes strict+repair matches baseline at lower cost and fewer tokens", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  assert.equal(report.resolutionOutcome.strictWithRepairResolved, 8);
  assert.equal(report.resolutionOutcome.baselineResolved, 8);
  assert.equal(report.resolutionOutcome.strictMatchesBaseline, true);
  assert.equal(report.resolutionOutcome.strictImprovesOverOld, true); // 7 > 5
  assert.equal(report.tokenCostOutcome.lowerCostThanBaseline, true); // 6.823 < 6.9777
  assert.equal(report.tokenCostOutcome.fewerTokensThanBaseline, true); // 12.54M < 16.76M
  const md = renderMarkdown(report);
  assert.ok(md.includes("strict_vtrace_with_verified_repair matched baseline resolution on the controlled 10-task set."));
  assert.ok(md.includes("used lower total cost and fewer total tokens than baseline"));
});

// ---------------------------------------------------------------------------
// Required claims present.
// ---------------------------------------------------------------------------
test("emits the required claims", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  const md = renderMarkdown(report);
  assert.ok(CLAIMS.some((c) => /strict_risk_gated is now the internal Stage 5 default/.test(c)));
  for (const expected of [
    "strict_risk_gated is now the internal Stage 5 default PIVOT_CHECK policy.",
    "strict first-pass VTRACE improved over old controlled VTRACE on resolution, tokens, and cost.",
    "strict_vtrace_with_verified_repair matched baseline resolution on the controlled 10-task set.",
    "strict_vtrace_with_verified_repair used lower total tokens and lower total cost than baseline in this controlled set.",
  ]) {
    assert.ok(report.claims.includes(expected), `claims missing: ${expected}`);
    assert.ok(md.includes(expected), `markdown missing claim: ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// Required non-claims present (explicitly NOT claimed).
// ---------------------------------------------------------------------------
test("emits the required non-claims", () => {
  const report = buildReport({ generatedAt: "t", inputs: inputs() });
  const md = renderMarkdown(report);
  for (const fragment of [
    "VTRACE beats VEXP",
    "statistically meaningful SWE-bench benchmark",
    "repair should be always-on",
    "old VTRACE repair conversions transfer to strict runs",
    "aggregate performance beyond this controlled 10-task set",
  ]) {
    assert.ok(report.nonClaims.some((n) => n.includes(fragment)), `non-claims missing: ${fragment}`);
    assert.ok(md.includes(fragment), `markdown missing non-claim: ${fragment}`);
  }
  assert.equal(NON_CLAIMS.length, 5);
});

// ---------------------------------------------------------------------------
// Final recommendation: stop repair experiments, keep strict default, repair gated.
// ---------------------------------------------------------------------------
test("emits the final recommendation (stop, keep strict, keep repair gated, productize)", () => {
  const md = renderMarkdown(buildReport({ generatedAt: "t", inputs: inputs() }));
  assert.ok(/Stop Stage 5 repair experiments for now/.test(FINAL_RECOMMENDATION));
  assert.ok(/Keep strict_risk_gated as the internal Stage 5 default/.test(FINAL_RECOMMENDATION));
  assert.ok(/Keep critic\/repair gated and disabled by default/.test(FINAL_RECOMMENDATION));
  assert.ok(/VTRACE productization and release hardening/.test(FINAL_RECOMMENDATION));
  assert.ok(md.includes(FINAL_RECOMMENDATION));
});

// ---------------------------------------------------------------------------
// Next productization work: all six concrete areas.
// ---------------------------------------------------------------------------
test("lists the six next productization areas", () => {
  assert.equal(NEXT_PRODUCTIZATION_WORK.length, 6);
  const md = renderMarkdown(buildReport({ generatedAt: "t", inputs: inputs() }));
  for (const fragment of ["auto / fast / thorough / debug", "Release/CI hardening", "Capsule v2", "raw artifacts untracked", "hide internal knobs", "Broader validation"]) {
    assert.ok(md.includes(fragment), `next-work missing: ${fragment}`);
  }
});

// ---------------------------------------------------------------------------
// Gated repair outcome reflects the strict conversion evidence.
// ---------------------------------------------------------------------------
test("renders the strict repair conversion as strict-specific", () => {
  const md = renderMarkdown(buildReport({ generatedAt: "t", inputs: inputs() }));
  assert.ok(md.includes("eval-strictgated-vtrace-requests-5414"));
  assert.ok(md.includes("psf__requests-5414"));
  assert.ok(md.includes("NOT transferred from old VTRACE repair evidence"));
});

// ---------------------------------------------------------------------------
// Parsing helpers (real artifact shapes).
// ---------------------------------------------------------------------------
test("parsePolicyRow reads a policy-accounting row", () => {
  const r = parsePolicyRow({ policyName: "baseline", taskCount: 10, resolvedCount: 8, totalCostUsd: 6.9777, totalTokens: 16756692, costPerResolved: 0.87, tokensPerResolved: 2094587 });
  assert.equal(r?.policyName, "baseline");
  assert.equal(r?.resolvedCount, 8);
  assert.equal(r?.totalTokens, 16756692);
  assert.equal(parsePolicyRow(undefined), null);
  assert.equal(parsePolicyRow({}), null); // no policyName
});

test("parsePivotCheckPolicy returns the single strict policy or null on disagreement", () => {
  const single = parsePivotCheckPolicy({ tasks: [{ strict: { pivotCheckPolicy: "strict_risk_gated" } }, { strict: { pivotCheckPolicy: "strict_risk_gated" } }] });
  assert.equal(single.policy, "strict_risk_gated");
  assert.equal(single.taskCount, 2);
  const mixed = parsePivotCheckPolicy({ tasks: [{ strict: { pivotCheckPolicy: "strict_risk_gated" } }, { strict: { pivotCheckPolicy: "always" } }] });
  assert.equal(mixed.policy, null); // disagreement → null, never fabricated
  assert.equal(parsePivotCheckPolicy(null).policy, null);
});

test("parseRepairEvidence reads the strict conversion shape", () => {
  const ev = parseRepairEvidence({
    runLabel: "eval-strictgated-vtrace-requests-5414",
    instanceId: "psf__requests-5414",
    conversion: { convertedUnresolvedToResolved: true },
    evaluation: { dockerUsed: true, resolved: true },
    costs: { criticCostUsd: 0.1909, repairCostUsd: 0.2241, totalCriticRepairCostUsd: 0.415 },
  });
  assert.equal(ev?.converted, true);
  assert.equal(ev?.dockerUsed, true);
  assert.equal(ev?.totalRecoveryCostUsd, 0.415);
  assert.equal(parseRepairEvidence(null), null);
});

// ---------------------------------------------------------------------------
// 11. No Docker / model / agent: loader fails clearly when accounting is missing.
// ---------------------------------------------------------------------------
test("loader fails clearly when the policy-accounting report is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "final-story-"));
  try {
    await assert.rejects(() => loadStoryInputs(dir), /No policy-accounting report/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseArgs reads results and out-name", () => {
  const cfg = parseArgs(["--results", "r", "--out-name", "o"]);
  assert.equal(cfg.resultsDir, "r");
  assert.equal(cfg.outName, "o");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});
