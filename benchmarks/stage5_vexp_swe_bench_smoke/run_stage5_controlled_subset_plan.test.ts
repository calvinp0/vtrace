import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildConditionIndex,
  buildExistingPairTasks,
  buildMissingRuns,
  buildPlan,
  buildVtraceCommand,
  buildBaselineCommand,
  parseLedger,
  renderJson,
  renderMarkdown,
  selectAdditionalTasks,
  type LedgerPairLite,
  type LedgerRunLite,
  type ParsedLedger,
  type SelectedTask,
} from "./run_stage5_controlled_subset_plan";

// Five existing same-label baseline-vs-vtrace pairs (all django, as in the real ledger).
function djangoPairs(): LedgerPairLite[] {
  return ["10880", "11095", "11490", "11728", "11740"].map((n) => ({
    instanceId: `django__django-${n}`,
    pairType: "baseline_vs_vtrace",
    beforeRunLabel: `eval-${n} [baseline]`,
    afterRunLabel: `eval-${n} [vtrace]`,
    beforeResolved: true,
    afterResolved: true,
    beforeCost: 0.2,
    afterCost: 0.3,
    beforeTokens: 100,
    afterTokens: 200,
  }));
}

// Runs across diverse repos with mixed outcomes, each with a reusable baseline.
function diverseRuns(): LedgerRunLite[] {
  const mk = (instanceId: string, condition: string, resolved: boolean | null, valid: boolean): LedgerRunLite => ({
    runLabel: `eval-old-${condition}-${instanceId}`,
    condition,
    instanceId,
    resolved,
    cost: 0.4,
    tokens: 1000,
    treatmentValid: valid,
  });
  return [
    // astropy: apparent VTRACE win
    mk("astropy__astropy-14369", "baseline", false, true),
    mk("astropy__astropy-14369", "vtrace", true, true),
    // psf: apparent VTRACE loss
    mk("psf__requests-5414", "baseline", true, true),
    mk("psf__requests-5414", "vtrace", false, true),
    // sympy: tie resolved (also a promoted precheck candidate in the fixture)
    mk("sympy__sympy-16766", "baseline", true, true),
    mk("sympy__sympy-16766", "vtrace", true, true),
    // sphinx: both unresolved
    mk("sphinx-doc__sphinx-7462", "baseline", false, true),
    mk("sphinx-doc__sphinx-7462", "vtrace", false, true),
    // matplotlib: tie resolved
    mk("matplotlib__matplotlib-22719", "baseline", true, true),
    mk("matplotlib__matplotlib-22719", "vtrace", true, true),
  ];
}

function fullLedger(): ParsedLedger {
  return { runs: diverseRuns(), pairs: djangoPairs() };
}

// ---------------------------------------------------------------------------
// 1. Existing baseline-vs-vtrace pairs are preserved.
// ---------------------------------------------------------------------------
test("existing baseline-vs-vtrace pairs are preserved with stripped labels", () => {
  const tasks = buildExistingPairTasks(djangoPairs());
  assert.equal(tasks.length, 5);
  assert.ok(tasks.every((t) => t.selectionSource === "existing_pair"));
  assert.ok(tasks.every((t) => t.hasBaselineRun && t.hasVtraceRun));
  assert.equal(tasks[0]!.baselineRunLabel, "eval-10880"); // " [baseline]" stripped
  assert.equal(tasks[0]!.vtraceRunLabel, "eval-10880");
  // Preserved pairs produce no missing runs.
  assert.deepEqual(buildMissingRuns(tasks[0]!), []);
});

// ---------------------------------------------------------------------------
// 2. The planner adds tasks until target size when candidates exist.
// ---------------------------------------------------------------------------
test("planner adds additional tasks up to target size with repository diversity", () => {
  const plan = buildPlan(fullLedger(), new Set(), 10, "t");
  assert.equal(plan.summary.existingPairCount, 5);
  assert.equal(plan.summary.additionalTaskCount, 5);
  assert.equal(plan.summary.totalSelected, 10);
  const additional = plan.selectedTasks.filter((t) => t.selectionSource !== "existing_pair");
  const repos = additional.map((t) => t.repo);
  // 5 distinct NON-django repos (diversity beyond the django pairs).
  assert.equal(new Set(repos).size, 5);
  assert.ok(!repos.includes("django"));
  // Outcome mix: at least one apparent loss and at least one unresolved (no cherry-picking).
  assert.ok(additional.some((t) => t.baselineResolved === true && t.vtraceResolved === false));
  assert.ok(additional.some((t) => t.baselineResolved === false && t.vtraceResolved === false));
});

test("planner reports a shortfall when too few candidates exist", () => {
  const ledger: ParsedLedger = {
    runs: [
      { runLabel: "eval-a", condition: "baseline", instanceId: "a__a-1", resolved: true, cost: 0.1, tokens: 10, treatmentValid: true },
    ],
    pairs: djangoPairs(),
  };
  const plan = buildPlan(ledger, new Set(), 10, "t");
  assert.equal(plan.summary.additionalTaskCount, 1); // only one candidate available
  assert.equal(plan.summary.shortfall, true);
  assert.equal(plan.summary.totalSelected, 6);
});

// ---------------------------------------------------------------------------
// 3. Missing baseline and missing VTRACE runs are reported separately.
// ---------------------------------------------------------------------------
test("missing baseline and missing vtrace are reported separately", () => {
  const baselineOnly: SelectedTask = {
    instanceId: "x__y-1",
    repo: "x",
    selectionSource: "existing_condition_data",
    hasBaselineRun: true,
    hasVtraceRun: false, // no vtrace => vtrace missing only
    baselineRunLabel: "eval-old-baseline-x__y-1",
    vtraceRunLabel: null,
    baselineResolved: true,
    vtraceResolved: null,
    baselineCost: 0.1,
    vtraceCost: null,
    baselineTokens: 10,
    vtraceTokens: null,
    reasonSelected: "fixture",
    risk: "fixture",
  };
  const vtraceOnly: SelectedTask = { ...baselineOnly, instanceId: "p__q-2", hasBaselineRun: false, hasVtraceRun: true, baselineRunLabel: null, vtraceRunLabel: "eval-old-vtrace-p__q-2" };

  const m1 = buildMissingRuns(baselineOnly);
  // baseline reusable => only vtrace missing
  assert.deepEqual(m1.map((m) => m.condition), ["vtrace"]);

  const m2 = buildMissingRuns(vtraceOnly);
  // no baseline => baseline AND vtrace missing, reported separately
  assert.deepEqual(m2.map((m) => m.condition), ["baseline", "vtrace"]);
});

// ---------------------------------------------------------------------------
// 4. Generated VTRACE commands use current normal VTRACE behavior.
// ---------------------------------------------------------------------------
test("vtrace command uses normal current behavior and never --disable-pivot-check", () => {
  const cmd = buildVtraceCommand("astropy__astropy-14369");
  assert.match(cmd, /--protocol vtrace-indexed/);
  assert.match(cmd, /--context-policy force-inject/);
  assert.match(cmd, /--capsule-engine v2/);
  assert.match(cmd, /--capsule-intent debug/);
  assert.match(cmd, /--capsule-budget 8000/);
  assert.match(cmd, /--run-label eval-controlled-vtrace-astropy-14369/);
  assert.doesNotMatch(cmd, /--disable-pivot-check/);
});

// ---------------------------------------------------------------------------
// 5. Generated baseline commands match the existing harness protocol style.
// ---------------------------------------------------------------------------
test("baseline command matches the harness protocol style", () => {
  const cmd = buildBaselineCommand("psf__requests-5414");
  assert.match(cmd, /run_stage5_vexp_swe_bench_smoke\.ts/);
  assert.match(cmd, /--mode run-protocol/);
  assert.match(cmd, /--protocol baseline/);
  assert.match(cmd, /--run-label eval-controlled-baseline-requests-5414/);
  assert.doesNotMatch(cmd, /--capsule-engine/); // baseline uses no retrieval flags
  assert.doesNotMatch(cmd, /--context-policy/);
});

// ---------------------------------------------------------------------------
// 6. The planner does not count missing runs as evaluated.
// ---------------------------------------------------------------------------
test("planner does not count missing runs as evaluated pairs", () => {
  const plan = buildPlan(fullLedger(), new Set(), 10, "t");
  // Only the 5 existing same-label pairs are comparable NOW; the 5 additional need runs.
  assert.equal(plan.summary.currentlyComparablePairs, 5);
  assert.equal(plan.summary.comparablePairsAfterCompletion, 10);
  assert.ok(plan.summary.missingRunCount >= 5);
  // The markdown must NOT present computed deltas/resolved counts for the subset.
  const md = renderMarkdown(plan);
  assert.match(md, /None of these are computed here/);
  assert.doesNotMatch(md, /VTRACE resolved count: \d/);
});

// ---------------------------------------------------------------------------
// 7. Markdown includes limitations and non-claims.
// ---------------------------------------------------------------------------
test("markdown includes all required sections, limitations, and non-claims", () => {
  const plan = buildPlan(fullLedger(), new Set(["sympy__sympy-16766"]), 10, "2026-06-09T00:00:00.000Z");
  const md = renderMarkdown(plan);
  for (const h of [
    "# Stage 5 controlled 10-task benchmark plan",
    "## Summary",
    "## Existing comparable pairs",
    "## Selected additional tasks",
    "## Missing runs to execute",
    "## Selection rationale",
    "## Expected metrics after completion",
    "## Run commands",
    "## Limitations",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(h), `missing section: ${h}`);
  }
  assert.match(md, /pilot controlled subset/);
  assert.match(md, /does not claim VTRACE beats VEXP/);
  assert.match(md, /does not claim pass@1/);
});

// ---------------------------------------------------------------------------
// 8. JSON exposes selectedTasks and missingRuns.
// ---------------------------------------------------------------------------
test("json exposes selectedTasks[] and missingRuns[] with required fields", () => {
  const plan = buildPlan(fullLedger(), new Set(), 10, "2026-06-09T00:00:00.000Z");
  const json = JSON.parse(renderJson(plan));
  assert.ok(Array.isArray(json.selectedTasks));
  assert.ok(Array.isArray(json.missingRuns));
  assert.ok(Array.isArray(json.commands));
  assert.equal(json.targetSize, 10);
  assert.equal(json.existingPairCount, 5);
  assert.equal(json.additionalTaskCount, 5);
  for (const f of ["instanceId", "repo", "selectionSource", "hasBaselineRun", "hasVtraceRun", "baselineRunLabel", "vtraceRunLabel", "baselineResolved", "vtraceResolved", "baselineCost", "vtraceCost", "baselineTokens", "vtraceTokens", "reasonSelected", "risk"]) {
    assert.ok(f in json.selectedTasks[0], `selectedTasks missing ${f}`);
  }
  for (const f of ["instanceId", "condition", "reasonMissing", "recommendedRunLabel", "command"]) {
    assert.ok(f in json.missingRuns[0], `missingRuns missing ${f}`);
  }
});

// ---------------------------------------------------------------------------
// parseLedger + buildConditionIndex + selection internals.
// ---------------------------------------------------------------------------
test("parseLedger reads runs (tokens.total) and pairs", () => {
  const raw = {
    runs: [{ runLabel: "L", condition: "vtrace", instanceId: "a__b-1", resolved: true, cost: 0.5, tokens: { total: 1260 }, treatmentValid: true }],
    pairs: [{ instanceId: "a__b-1", pairType: "baseline_vs_vtrace", beforeRunLabel: "L [baseline]", afterRunLabel: "L [vtrace]", beforeResolved: false, afterResolved: true, beforeCost: 0.2, afterCost: 0.5, beforeTokens: 100, afterTokens: 200 }],
  };
  const parsed = parseLedger(raw);
  assert.equal(parsed.runs[0]!.tokens, 1260);
  assert.equal(parsed.pairs[0]!.pairType, "baseline_vs_vtrace");
});

test("buildConditionIndex prefers a run with known resolution", () => {
  const runs: LedgerRunLite[] = [
    { runLabel: "unknownres", condition: "vtrace", instanceId: "a__b-1", resolved: null, cost: 0.1, tokens: 10, treatmentValid: true },
    { runLabel: "knownres", condition: "vtrace", instanceId: "a__b-1", resolved: true, cost: 0.2, tokens: 20, treatmentValid: true },
  ];
  const idx = buildConditionIndex(runs);
  assert.equal(idx.get("a__b-1")!.vtrace!.runLabel, "knownres");
});

test("selectAdditionalTasks gives a promoted candidate a ranking bonus on a tie", () => {
  // Two single-repo-equivalent candidates with identical evidence; promotion breaks the tie.
  const runs: LedgerRunLite[] = [
    { runLabel: "b1", condition: "baseline", instanceId: "z__alpha-1", resolved: true, cost: 0.1, tokens: 10, treatmentValid: true },
    { runLabel: "b2", condition: "baseline", instanceId: "z__beta-2", resolved: true, cost: 0.1, tokens: 10, treatmentValid: true },
  ];
  const idx = buildConditionIndex(runs);
  // Same repo "z": only one fits via diversity; the promoted one should win.
  const picked = selectAdditionalTasks(idx, new Set(), new Set(), new Set(["z__beta-2"]), 1);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.instanceId, "z__beta-2");
});
