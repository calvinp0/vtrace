import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  CONDITION,
  INSTANCE_ID,
  NON_CLAIMS,
  PRIMARY_ISSUE,
  RUN_LABEL,
  SECONDARY_ISSUES,
  analyzePatch,
  buildReport,
  classifyFailureMode,
  deletedFilesFromPatch,
  detectRankScoreDisagreement,
  isContextGood,
  parseCapsuleEvidence,
  parseDockerEvaluation,
  parseOrderedTelemetry,
  parseRankingEvidence,
  parseSweBenchRow,
  renderJson,
  renderMarkdown,
} from "./run_stage5_astropy_protocol_diagnostic";

// --------------------------------------------------------------------------
// Fixtures — mirror the real auditable protocol run artifacts. No Docker, no
// model, no agent: every test reads synthetic in-memory / on-disk data.
// --------------------------------------------------------------------------

// A patch that deletes the generated parser table and relocates grammar
// productions into p_combined_units (the broad rewrite), instead of the narrow
// known-good reorder.
const BROAD_PATCH =
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py\n" +
  "index 307e987..1e3425e 100644\n" +
  "--- a/astropy/units/format/cds.py\n" +
  "+++ b/astropy/units/format/cds.py\n" +
  "@@\n" +
  "-    def p_division_of_units(p):\n" +
  "+    def p_combined_units(p):\n" +
  "+        # division alternatives moved here, product recursion changed\n" +
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py\n" +
  "deleted file mode 100644\n" +
  "index aaa..000\n" +
  "--- a/astropy/units/format/cds_parsetab.py\n" +
  "+++ /dev/null\n" +
  "@@\n" +
  "-_lr_productions = []\n";

// The narrow known-good reorder, for the contrast case (no deletion, no rewrite).
const NARROW_PATCH =
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py\n" +
  "index 307e987..1e3425e 100644\n" +
  "--- a/astropy/units/format/cds.py\n" +
  "+++ b/astropy/units/format/cds.py\n" +
  "@@\n" +
  "-        division_of_units : unit_expression DIVISION combined_units\n" +
  "+        division_of_units : combined_units DIVISION unit_expression\n";

const SWEBENCH_ROW = {
  instanceId: INSTANCE_ID,
  repo: "astropy/astropy",
  timestamp: "2026-06-11T18:00:00.000Z",
  commitHash: "fa4e8d1cd279acf9b24560813c8652494ccd5922",
  model: "claude-opus-4-5-20251101",
  agent: "claude-code",
  inputTokens: 314,
  outputTokens: 106,
  cacheReadTokens: 2018021,
  cacheCreationTokens: 105072,
  costUsd: 1.1538184999999999,
  numTurns: 44,
  durationMs: 250000,
  toolCalls: { Read: 5, Edit: 1, Bash: 6, Glob: 1, Grep: 3 },
  modelPatch: BROAD_PATCH,
  resolved: false,
  vexpMetrics: null,
};

const EVAL_META = {
  condition: "vtrace",
  evaluationRan: true,
  evaluationMethod: "docker",
  dockerUsed: true,
  evaluationError: null,
  instancesEvaluated: 1,
  resolvedCount: 0,
  notes: [],
};

const TOOL_SUMMARY = {
  runLabel: RUN_LABEL,
  condition: "vtrace",
  instanceId: INSTANCE_ID,
  totalToolCalls: 16,
  bashToolCalls: 6,
  grepLikeToolCalls: 4,
  fileReadToolCalls: 5,
  fileWriteToolCalls: 1,
  uniqueFilesTouchedByTools: 5,
  longBashLoopHeuristic: false,
  repeatedSearchHeuristic: false,
  orderedTelemetryAvailable: true,
  pivotChecklistEmitted: false,
  missingReason: null,
};

const RUN_META = {
  condition: "vtrace",
  vtraceMethod: "indexed-context",
  vtraceTreatmentValid: true,
  vtraceIndexedContext: true,
  vtraceContextInjected: true,
  vtraceContextPolicyOverride: "force-inject",
  vtraceCapsuleEngine: "v2",
  vtraceCapsuleIntent: "debug",
  vtraceCapsuleBudget: 8000,
  vtraceCapsuleTopPivotFile: "astropy/units/format/cds.py",
  vtraceCapsuleTopPivotSymbol: "CDS",
  vtraceCapsuleEstimatedTokens: 5086,
  vtracePivotCount: 2,
  vtraceSupportCount: 4,
  vtracePivotCheckPolicy: "strict_risk_gated",
  vtracePivotCheckInjected: false,
  vtracePivotCheckPolicyReason: "strict_risk_gated: no strong risk signal (hidden_pivot alone is insufficient)",
  capsuleV2ArtifactsPersisted: true,
  capsuleEngine: "v2",
  pivotRankingVersion: "v2",
};

const RANKING_JSON = {
  schema: "stage5-capsule-v2-ranking/v1",
  generatedAt: "2026-06-11T18:16:01.955Z",
  runLabel: RUN_LABEL,
  instanceId: INSTANCE_ID,
  pivotRankingVersion: "v2",
  topItems: [
    {
      rank: 1,
      path: "astropy/units/format/cds.py",
      symbol: "CDS",
      kind: "class",
      tokenEstimate: 2657,
      pivotRankScore: 2.853,
      pivotRankSignals: ["multi-evidence(2) +0.1"],
      pivotRankPenalties: [],
      pivotRankReason: "base 2.753; +[multi-evidence(2) +0.1] => 2.853",
    },
    {
      rank: 2,
      path: "astropy/units/format/vounit.py",
      symbol: "VOUnit",
      kind: "class",
      tokenEstimate: 2302,
      pivotRankScore: 3.049,
      pivotRankSignals: ["multi-evidence(3) +0.2"],
      pivotRankPenalties: [],
      pivotRankReason: "base 2.849; +[multi-evidence(3) +0.2] => 3.049",
    },
  ],
  deferredRefCount: 4,
  expandedDeferredRefCount: 2,
};

async function writeRunTree(): Promise<string> {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "stage5-protocol-"));
  const conditionDir = path.join(resultsDir, "runs", RUN_LABEL, "raw", CONDITION);
  await mkdir(conditionDir, { recursive: true });
  await writeFile(path.join(conditionDir, "swebench-2026-06-11.jsonl"), `${JSON.stringify(SWEBENCH_ROW)}\n`);
  await writeFile(path.join(conditionDir, "_eval.meta.json"), JSON.stringify(EVAL_META));
  await writeFile(path.join(conditionDir, "_tool_calls.summary.json"), JSON.stringify(TOOL_SUMMARY));
  await writeFile(path.join(conditionDir, "_run.meta.json"), JSON.stringify(RUN_META));
  await writeFile(path.join(conditionDir, "_capsule_v2_ranking.json"), JSON.stringify(RANKING_JSON));
  await writeFile(path.join(conditionDir, "_capsule_v2_manifest.json"), JSON.stringify({ items: [] }));
  await writeFile(path.join(conditionDir, "_capsule_v2_context.md"), "● pivot astropy/units/format/cds.py::CDS\n");
  return resultsDir;
}

// --------------------------------------------------------------------------
// Pure-helper unit tests
// --------------------------------------------------------------------------

test("parseCapsuleEvidence detects Capsule v2 artifacts persisted", () => {
  const c = parseCapsuleEvidence(RUN_META, { manifest: true, ranking: true, context: true });
  assert.equal(c.capsuleV2ArtifactsPersisted, true);
  assert.equal(c.capsuleEngine, "v2");
  assert.equal(c.pivotRankingVersion, "v2");
  assert.equal(c.topPivotFile, "astropy/units/format/cds.py");
  assert.equal(c.topPivotSymbol, "CDS");
  assert.equal(c.manifestFilePresent, true);
});

test("parseRankingEvidence detects cds.py::CDS at rank 1", () => {
  const k = parseRankingEvidence(RANKING_JSON);
  assert.equal(k.rank1?.path, "astropy/units/format/cds.py");
  assert.equal(k.rank1?.symbol, "CDS");
  assert.equal(k.rank1?.rank, 1);
  assert.equal(k.topPivotIsExpected, true);
});

test("parseOrderedTelemetry detects loop heuristics false", () => {
  const t = parseOrderedTelemetry(TOOL_SUMMARY);
  assert.equal(t.longBashLoopHeuristic, false);
  assert.equal(t.repeatedSearchHeuristic, false);
  assert.equal(t.orderedTelemetryAvailable, true);
  assert.equal(t.totalToolCalls, 16);
});

test("parseSweBenchRow / parseDockerEvaluation detect resolved=false", () => {
  const row = parseSweBenchRow(SWEBENCH_ROW);
  assert.equal(row.resolved, false);
  const d = parseDockerEvaluation(EVAL_META);
  assert.equal(d.resolved, false);
  assert.equal(d.resolvedCount, 0);
});

test("classifyFailureMode returns patch_mistake_despite_good_context when context good but Docker unresolved", () => {
  assert.equal(classifyFailureMode(true, false), "patch_mistake_despite_good_context");
  assert.equal(classifyFailureMode(false, false), "localization_or_context_gap");
  assert.equal(classifyFailureMode(true, true), "resolved");
});

test("isContextGood is true for an injected, valid treatment with the expected lead pivot", () => {
  const c = parseCapsuleEvidence(RUN_META, { manifest: true, ranking: true, context: true });
  const k = parseRankingEvidence(RANKING_JSON);
  assert.equal(isContextGood(c, k), true);
});

test("deletedFilesFromPatch + analyzePatch detect broad grammar rewrite / parser-table deletion", () => {
  assert.deepEqual(deletedFilesFromPatch(BROAD_PATCH), ["astropy/units/format/cds_parsetab.py"]);
  const broad = analyzePatch(BROAD_PATCH);
  assert.deepEqual(broad.deletedGeneratedParserTables, ["astropy/units/format/cds_parsetab.py"]);
  assert.equal(broad.touchesCombinedUnitsMethod, true);
  assert.equal(broad.broadGrammarRewriteDetected, true);

  // The narrow known-good reorder is NOT a broad rewrite.
  const narrow = analyzePatch(NARROW_PATCH);
  assert.deepEqual(narrow.deletedGeneratedParserTables, []);
  assert.equal(narrow.broadGrammarRewriteDetected, false);
  assert.equal(narrow.narrowGrammarReorderPresent, true);
});

test("detectRankScoreDisagreement fires when a lower-ranked item has a higher score", () => {
  const k = parseRankingEvidence(RANKING_JSON);
  assert.equal(k.rankScoreDisagreement, true);
  assert.equal(k.higherScoredLowerRanked?.symbol, "VOUnit");
  assert.equal(k.higherScoredLowerRanked?.pivotRankScore, 3.049);

  // A consistent ordering does not flag the caveat.
  const consistent = parseRankingEvidence({
    topItems: [
      { rank: 1, path: "a.py", symbol: "A", pivotRankScore: 3.0 },
      { rank: 2, path: "b.py", symbol: "B", pivotRankScore: 2.0 },
    ],
  });
  assert.equal(consistent.rankScoreDisagreement, false);
});

// --------------------------------------------------------------------------
// IO + rendering against the synthetic run tree
// --------------------------------------------------------------------------

test("buildReport assembles the protocol diagnosis from disk", async () => {
  const resultsDir = await writeRunTree();
  const report = await buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z");

  assert.equal(report.instanceId, INSTANCE_ID);
  assert.equal(report.docker.resolved, false);
  assert.equal(report.contextGood, true);
  assert.equal(report.failureMode, "patch_mistake_despite_good_context");
  assert.equal(report.diagnosis.primaryIssue, PRIMARY_ISSUE);
  assert.deepEqual(report.diagnosis.secondaryIssues, [...SECONDARY_ISSUES]);
  assert.equal(report.diagnosis.supersedes, "noisy_pivot_ranking");
  assert.equal(report.patch.broadGrammarRewriteDetected, true);
  assert.equal(report.ranking.rankScoreDisagreement, true);
});

test("buildReport throws a clear error when the run row is missing", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "stage5-protocol-empty-"));
  await assert.rejects(() => buildReport({ resultsDir }, null), /Missing protocol run row/);
});

const REQUIRED_SECTIONS = [
  "# Stage 5 Astropy protocol diagnostic",
  "## Summary",
  "## Run identity",
  "## Capsule v2 evidence",
  "## Ranking/context evidence",
  "## Ordered telemetry evidence",
  "## Docker outcome",
  "## Patch analysis",
  "## Diagnosis update",
  "## Ranking metadata caveat",
  "## Recommended next step",
  "## Non-claims",
];

test("renderMarkdown emits every required section", async () => {
  const resultsDir = await writeRunTree();
  const md = renderMarkdown(await buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z"));
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
});

test("renderMarkdown emits the ranking-metadata caveat when rank and score disagree", async () => {
  const resultsDir = await writeRunTree();
  const md = renderMarkdown(await buildReport({ resultsDir }, null));
  // The fixed caveat text plus the detected concrete disagreement note.
  assert.ok(md.includes("higher pivotRankScore"));
  assert.ok(md.includes("VOUnit"));
  assert.ok(/rank 1 .*cds\.py::CDS.* is ordered ahead of rank 2/.test(md.replace(/`/g, "")));
});

test("renderMarkdown includes every non-claim verbatim and the primary diagnosis", async () => {
  const resultsDir = await writeRunTree();
  const md = renderMarkdown(await buildReport({ resultsDir }, null));
  for (const claim of NON_CLAIMS) {
    assert.ok(md.includes(claim), `missing non-claim: ${claim}`);
  }
  assert.ok(md.includes("patch_mistake_despite_good_context"));
  assert.ok(md.includes("noisy_pivot_ranking"));
});

test("renderJson emits the required JSON fields", async () => {
  const resultsDir = await writeRunTree();
  const json = JSON.parse(renderJson(await buildReport({ resultsDir }, "2026-06-11T00:00:00.000Z")));

  assert.equal(json.runLabel, RUN_LABEL);
  assert.equal(json.instanceId, INSTANCE_ID);
  assert.equal(json.condition, CONDITION);
  assert.equal(json.protocol, "vtrace-indexed");
  assert.equal(json.capsule.capsuleV2ArtifactsPersisted, true);
  assert.equal(json.ranking.rank1.path, "astropy/units/format/cds.py");
  assert.equal(json.ranking.rankScoreDisagreement, true);
  assert.equal(json.orderedTelemetry.longBashLoopHeuristic, false);
  assert.equal(json.docker.resolved, false);
  assert.equal(json.patch.broadGrammarRewriteDetected, true);
  assert.equal(json.contextGood, true);
  assert.equal(json.failureMode, "patch_mistake_despite_good_context");
  assert.equal(json.diagnosis.primaryIssue, PRIMARY_ISSUE);
  assert.deepEqual(json.diagnosis.secondaryIssues, [...SECONDARY_ISSUES]);
  assert.equal(json.nonClaims.length, NON_CLAIMS.length);
});
