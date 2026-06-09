import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildReport,
  decidePromotion,
  evaluateCandidate,
  parseArgs,
  parseDiscoveryCandidates,
  renderJson,
  renderMarkdown,
  runPrecheck,
  selectCandidates,
  suspectedHiddenGold,
  type CandidateCheckInput,
  type DiscoveryCandidateLite,
  type LiveCapsuleOutcome,
  type PrecheckOrchestrationConfig,
} from "./run_stage5_live_capsule_precheck";

// A live role-reason that names the issue's source line anchor => source-anchored.
const ANCHOR_REASON = "source line anchor in the issue points at this symbol — explicit edit site";
// A live role-reason surfaced by symbol/test/graph evidence => hidden / non-source.
const HIDDEN_REASON = "actionable function — exercised by a failing test; symbol-name match";

// A Tier 2 candidate whose suspected hidden file (in gold) appears as a NON-source
// pivot in the live capsule among >= 2 pivots (the promote shape).
function promoteInput(overrides: Partial<CandidateCheckInput> = {}): CandidateCheckInput {
  return {
    instanceId: "sympy__sympy-13372",
    repo: "sympy/sympy",
    inputTier: "tier2",
    suspectedHiddenGoldFiles: ["sympy/core/evalf.py"],
    suspectedHiddenFiles: ["sympy/core/evalf.py"],
    suspectedHiddenSymbols: ["add_terms"],
    goldPatchFiles: ["sympy/core/evalf.py"],
    live: {
      built: true,
      actualMode: "full",
      error: null,
      pivots: [
        { path: "sympy/core/sympify.py", symbol: "sympify", roleReason: ANCHOR_REASON },
        { path: "sympy/core/evalf.py", symbol: "add_terms", roleReason: HIDDEN_REASON },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. suspected file appears as a non-source live pivot => promote
// ---------------------------------------------------------------------------
test("promotes when the suspected file is a non-source live pivot among >= 2 pivots", () => {
  const c = evaluateCandidate(promoteInput());
  assert.equal(c.promotionDecision, "promote");
  assert.equal(c.suspectedFilePresentAsPivot, "yes");
  assert.equal(c.suspectedFileHiddenInLiveCapsule, "yes");
  assert.equal(c.pivotsOverlapGoldPatch, "yes");
  // commands are emitted ONLY for promotions
  assert.ok(c.commands && c.commands.length === 2);
  assert.equal(c.recommendedBeforeLabel, "eval-pivot-telemetry-vtrace-sympy-13372-no-pivot-check");
  assert.equal(c.recommendedAfterLabel, "eval-pivot-check-vtrace-sympy-13372");
});

// ---------------------------------------------------------------------------
// 2. suspected file missing from live pivots => demote
// ---------------------------------------------------------------------------
test("demotes when the suspected file is absent from the live pivots", () => {
  const input = promoteInput({
    live: {
      built: true,
      actualMode: "full",
      error: null,
      pivots: [
        { path: "sympy/core/sympify.py", symbol: "sympify", roleReason: ANCHOR_REASON },
        { path: "sympy/core/numbers.py", symbol: "Float", roleReason: HIDDEN_REASON },
      ],
    },
  });
  const c = evaluateCandidate(input);
  assert.equal(c.promotionDecision, "demote");
  assert.equal(c.suspectedFilePresentAsPivot, "no");
  assert.match(c.reason, /absent/);
  assert.equal(c.commands, null);
  assert.equal(c.recommendedBeforeLabel, null);
});

// ---------------------------------------------------------------------------
// 3. suspected file appears but is source-anchored => demote (inverted reality)
// ---------------------------------------------------------------------------
test("demotes when the suspected file is present but source-anchored in the live capsule", () => {
  const input = promoteInput({
    live: {
      built: true,
      actualMode: "full",
      error: null,
      pivots: [
        // The suspected "hidden" gold file is actually the source-anchored pivot.
        { path: "sympy/core/evalf.py", symbol: "add_terms", roleReason: ANCHOR_REASON },
        { path: "sympy/core/sympify.py", symbol: "sympify", roleReason: HIDDEN_REASON },
      ],
    },
  });
  const c = evaluateCandidate(input);
  assert.equal(c.promotionDecision, "demote");
  assert.equal(c.suspectedFilePresentAsPivot, "yes");
  assert.equal(c.suspectedFileHiddenInLiveCapsule, "no");
  assert.match(c.reason, /source-anchored|inverted/);
  assert.equal(c.commands, null);
});

// A present-but-indeterminate (blank role-reason) suspected file is AMBIGUOUS, never
// silently promoted — the live capsule built but the role cannot be read.
test("marks ambiguous when the suspected pivot has a blank role-reason", () => {
  const input = promoteInput({
    live: {
      built: true,
      actualMode: "full",
      error: null,
      pivots: [
        { path: "sympy/core/sympify.py", symbol: "sympify", roleReason: ANCHOR_REASON },
        { path: "sympy/core/evalf.py", symbol: "add_terms", roleReason: "  " },
      ],
    },
  });
  const c = evaluateCandidate(input);
  assert.equal(c.promotionDecision, "ambiguous");
  assert.equal(c.suspectedFileHiddenInLiveCapsule, "unknown");
});

// ---------------------------------------------------------------------------
// 4. only one live pivot => demote
// ---------------------------------------------------------------------------
test("demotes when the live capsule has only one pivot", () => {
  const input = promoteInput({
    live: {
      built: true,
      actualMode: "full",
      error: null,
      pivots: [{ path: "sympy/core/evalf.py", symbol: "add_terms", roleReason: HIDDEN_REASON }],
    },
  });
  const c = evaluateCandidate(input);
  assert.equal(c.promotionDecision, "demote");
  assert.match(c.reason, /single pivot/);
  assert.equal(c.commands, null);
});

test("demotes when the live capsule failed to build", () => {
  const input = promoteInput({
    live: { built: false, actualMode: null, error: "vtrace index failed (exit 1)", pivots: [] },
  });
  const c = evaluateCandidate(input);
  assert.equal(c.promotionDecision, "demote");
  assert.equal(c.liveCapsuleBuilt, false);
  assert.equal(c.liveBuildError, "vtrace index failed (exit 1)");
  assert.match(c.reason, /did not build/);
});

test("demotes when the live capsule produced zero pivots (retrieval failure)", () => {
  const input = promoteInput({
    live: { built: true, actualMode: "no_context", error: null, pivots: [] },
  });
  const c = evaluateCandidate(input);
  assert.equal(c.promotionDecision, "demote");
  assert.match(c.reason, /no pivots|retrieval failure/);
});

// ---------------------------------------------------------------------------
// 5. missing gold metadata does not fabricate edit relevance
// ---------------------------------------------------------------------------
test("missing gold metadata does not fabricate edit relevance (ambiguous, all unknown)", () => {
  const input = promoteInput({
    goldPatchFiles: null,
    suspectedHiddenGoldFiles: [], // hidden∩gold is empty when gold is unknown
  });
  const c = evaluateCandidate(input);
  assert.equal(c.promotionDecision, "ambiguous");
  assert.equal(c.pivotsOverlapGoldPatch, "unknown");
  assert.equal(c.suspectedFilePresentAsPivot, "unknown");
  assert.equal(c.suspectedFileHiddenInLiveCapsule, "unknown");
  assert.match(c.reason, /gold/);
  assert.equal(c.commands, null);
});

// suspectedHiddenGold never invents files when gold is absent.
test("suspectedHiddenGold returns [] when gold metadata is absent", () => {
  const cand: DiscoveryCandidateLite = {
    instanceId: "x__y-1",
    repo: "x/y",
    tier: "tier2",
    hiddenPivotFiles: ["a/b.py"],
    hiddenPivotSymbols: ["f"],
    goldPatchFiles: null,
  };
  assert.deepEqual(suspectedHiddenGold(cand), []);
});

test("suspectedHiddenGold intersects hidden pivots with gold (suffix-tolerant)", () => {
  const cand: DiscoveryCandidateLite = {
    instanceId: "django__django-11820",
    repo: "django/django",
    tier: "tier2",
    hiddenPivotFiles: ["django/db/models/base.py", "django/db/models/enums.py"],
    hiddenPivotSymbols: ["_check_ordering"],
    goldPatchFiles: ["db/models/base.py"], // repo-trimmed in discovery
  };
  assert.deepEqual(suspectedHiddenGold(cand), ["django/db/models/base.py"]);
});

// ---------------------------------------------------------------------------
// 6. Markdown includes promoted / demoted / ambiguous sections
// ---------------------------------------------------------------------------
test("markdown includes promoted, demoted, and ambiguous sections", () => {
  const promoted = evaluateCandidate(promoteInput());
  const demoted = evaluateCandidate(
    promoteInput({
      instanceId: "django__django-11740",
      live: {
        built: true,
        actualMode: "full",
        error: null,
        pivots: [
          { path: "x/anchor.py", symbol: "a", roleReason: ANCHOR_REASON },
          { path: "x/other.py", symbol: "b", roleReason: HIDDEN_REASON },
        ],
      },
      suspectedHiddenGoldFiles: ["x/missing.py"],
      goldPatchFiles: ["x/missing.py"],
    }),
  );
  const ambiguous = evaluateCandidate(promoteInput({ instanceId: "z__z-9", goldPatchFiles: null, suspectedHiddenGoldFiles: [] }));
  const report = buildReport(
    [promoted, demoted, ambiguous],
    "stage5_edit_relevant_hidden_pivot_candidates.json",
    { engine: "v2", intent: "debug", budget: 8000, contextPolicy: "force-inject" },
    "2026-06-09T00:00:00.000Z",
  );
  const md = renderMarkdown(report);
  assert.match(md, /## Promoted candidates/);
  assert.match(md, /## Demoted candidates/);
  assert.match(md, /## Ambiguous candidates/);
  assert.match(md, /## Recommended next live runs/);
  assert.match(md, /## Non-claims/);
  assert.match(md, /## Method/);
  // The promoted instance and its commands should appear.
  assert.match(md, /sympy__sympy-13372/);
  assert.match(md, /--disable-pivot-check/);
  // Demoted/ambiguous should not have emitted before/after labels.
  assert.equal(demoted.recommendedBeforeLabel, null);
  assert.equal(ambiguous.recommendedBeforeLabel, null);
});

// ---------------------------------------------------------------------------
// 7. JSON includes the live capsule evidence fields
// ---------------------------------------------------------------------------
test("json includes live capsule evidence fields per candidate", () => {
  const report = buildReport(
    [evaluateCandidate(promoteInput())],
    "stage5_edit_relevant_hidden_pivot_candidates.json",
    { engine: "v2", intent: "debug", budget: 8000, contextPolicy: "force-inject" },
    "2026-06-09T00:00:00.000Z",
  );
  const json = JSON.parse(renderJson(report));
  assert.equal(json.summary.promoted, 1);
  assert.equal(json.sourceDiscoveryReport, "stage5_edit_relevant_hidden_pivot_candidates.json");
  assert.equal(json.capsule.engine, "v2");
  const c = json.checkedCandidates[0];
  for (const field of [
    "liveCapsuleBuilt",
    "livePivotCount",
    "livePivots",
    "sourceAnchoredPivots",
    "hiddenOrNonSourcePivots",
    "suspectedFilePresentAsPivot",
    "suspectedFileHiddenInLiveCapsule",
    "pivotsOverlapGoldPatch",
    "promotionDecision",
    "reason",
  ]) {
    assert.ok(field in c, `expected field ${field} in candidate JSON`);
  }
  assert.deepEqual(c.sourceAnchoredPivots, ["sympy/core/sympify.py"]);
  assert.deepEqual(c.hiddenOrNonSourcePivots, ["sympy/core/evalf.py"]);
});

// ---------------------------------------------------------------------------
// 8. recommended commands include --disable-pivot-check only for before runs
// ---------------------------------------------------------------------------
test("recommended commands include --disable-pivot-check only for the before run", () => {
  const c = evaluateCandidate(promoteInput());
  assert.ok(c.commands);
  const [before, after] = c.commands!;
  assert.match(before!, /# before/);
  assert.match(before!, /--disable-pivot-check/);
  assert.match(after!, /# after/);
  assert.doesNotMatch(after!, /--disable-pivot-check/);
});

// decidePromotion is the transparent decision core; verify it directly too.
test("decidePromotion mirrors evaluateCandidate", () => {
  assert.equal(decidePromotion(promoteInput()).decision, "promote");
});

// ---------------------------------------------------------------------------
// Discovery parsing + selection + orchestration (with a mocked live builder)
// ---------------------------------------------------------------------------
test("parseDiscoveryCandidates keeps goldPatchFiles null when absent", () => {
  const parsed = parseDiscoveryCandidates({
    candidates: [
      { instanceId: "a__b-1", repo: "a/b", tier: "tier2", hiddenPivotFiles: ["f.py"], hiddenPivotSymbols: ["g"] },
      {
        instanceId: "c__d-2",
        repo: "c/d",
        tier: "tier1",
        hiddenPivotFiles: ["h.py"],
        hiddenPivotSymbols: [],
        goldPatchFiles: ["h.py"],
      },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.goldPatchFiles, null);
  assert.deepEqual(parsed[1]!.goldPatchFiles, ["h.py"]);
});

test("selectCandidates filters by tier, or by explicit instances", () => {
  const discovery: DiscoveryCandidateLite[] = [
    { instanceId: "a__b-1", repo: "a/b", tier: "tier1", hiddenPivotFiles: [], hiddenPivotSymbols: [], goldPatchFiles: null },
    { instanceId: "c__d-2", repo: "c/d", tier: "tier2", hiddenPivotFiles: [], hiddenPivotSymbols: [], goldPatchFiles: null },
    { instanceId: "e__f-3", repo: "e/f", tier: "tier2", hiddenPivotFiles: [], hiddenPivotSymbols: [], goldPatchFiles: null },
  ];
  assert.deepEqual(
    selectCandidates(discovery, [], ["Tier2"]).map((c) => c.instanceId),
    ["c__d-2", "e__f-3"],
  );
  assert.deepEqual(
    selectCandidates(discovery, ["a__b-1"], ["Tier2"]).map((c) => c.instanceId),
    ["a__b-1"],
  );
});

test("runPrecheck wires a mocked live builder through to the report (no subprocess)", async () => {
  const discoveryPath = `/tmp/precheck_discovery_${Math.floor(performance.now())}_${process.pid}.json`;
  await Bun.write(
    discoveryPath,
    JSON.stringify({
      candidates: [
        {
          instanceId: "sympy__sympy-13372",
          repo: "sympy/sympy",
          tier: "tier2",
          hiddenPivotFiles: ["sympy/core/evalf.py"],
          hiddenPivotSymbols: ["add_terms"],
          goldPatchFiles: ["sympy/core/evalf.py"],
        },
      ],
    }),
  );
  const config: PrecheckOrchestrationConfig = {
    resultsDir: "/tmp",
    vexpSweBenchDir: "/tmp/vexp",
    discoveryReport: discoveryPath,
    instances: [],
    tiers: ["Tier2"],
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
    reuseWorkspace: false,
    outName: "stage5_live_capsule_precheck_tier2",
  };
  const live: LiveCapsuleOutcome = {
    built: true,
    actualMode: "full",
    error: null,
    pivots: [
      { path: "sympy/core/sympify.py", symbol: "sympify", roleReason: ANCHOR_REASON },
      { path: "sympy/core/evalf.py", symbol: "add_terms", roleReason: HIDDEN_REASON },
    ],
  };
  const report = await runPrecheck(config, { buildLiveCapsule: async () => live }, "2026-06-09T00:00:00.000Z");
  assert.equal(report.summary.checked, 1);
  assert.equal(report.summary.promoted, 1);
  assert.equal(report.checkedCandidates[0]!.promotionDecision, "promote");
});

test("parseArgs defaults to v2/debug/8000/Tier2 and rejects a non-v2 engine", () => {
  const cfg = parseArgs([
    "--results",
    "benchmarks/stage5_vexp_swe_bench_smoke/results",
    "--vexp-swe-bench-dir",
    "/home/calvin/code/vexp-swe-bench",
    "--from-discovery",
    "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_edit_relevant_hidden_pivot_candidates.json",
  ]);
  assert.equal(cfg.capsuleEngine, "v2");
  assert.equal(cfg.capsuleIntent, "debug");
  assert.equal(cfg.capsuleBudget, 8000);
  assert.deepEqual(cfg.tiers, ["Tier2"]);
  assert.throws(() => parseArgs(["--capsule-engine", "legacy"]), /must be v2/);
});

test("parseArgs --instances overrides tier selection", () => {
  const cfg = parseArgs(["--instances", "sympy__sympy-13372,django__django-11740"]);
  assert.deepEqual(cfg.instances, ["sympy__sympy-13372", "django__django-11740"]);
});
