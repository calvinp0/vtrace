import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  computeOrientationParity,
  computeQualityPreservingReductionPct,
  csvEscape,
  detectContaminatedVtracePaths,
  estimateTokens,
  evaluateContextQuality,
  loadTasks,
  renderMarkdown,
  summarizeRows,
  type OrientationRow,
  type QualityEvaluation,
} from "./run_arc_stage2_orientation";

test("quality scoring marks a top expected path match as strong", () => {
  const quality = evaluateContextQuality({
    itemCount: 2,
    topFile: "arc/species/species.py",
    topSymbol: "Other",
    files: ["arc/species/species.py", "arc/common.py"],
    symbols: ["Other"],
  }, {
    expected_paths: ["arc/species/species.py"],
    expected_symbols: ["ARCSpecies"],
  });

  assert.equal(quality.qualityLabel, "strong");
  assert.equal(quality.qualityScore, 3);
  assert.equal(quality.matchedExpectedPath, "arc/species/species.py");
});

test("quality scoring marks a non-top expected symbol match as acceptable", () => {
  const quality = evaluateContextQuality({
    itemCount: 2,
    topFile: "arc/common.py",
    topSymbol: "arc.common.helper",
    files: ["arc/common.py", "arc/reaction/reaction.py"],
    symbols: ["arc.common.helper", "arc.reaction.ARCReaction.determine_family"],
  }, {
    expected_paths: ["arc/reaction/reaction.py"],
    expected_symbols: ["determine_family"],
  });

  assert.equal(quality.qualityLabel, "acceptable");
  assert.equal(quality.qualityScore, 2);
  assert.equal(quality.matchedExpectedSymbol, "determine_family");
});

test("quality scoring marks context without expected target as weak", () => {
  const quality = evaluateContextQuality({
    itemCount: 1,
    topFile: "arc/common.py",
    topSymbol: "helper",
    files: ["arc/common.py"],
    symbols: ["helper"],
  }, {
    expected_paths: ["arc/species/species.py"],
    expected_symbols: ["ARCSpecies"],
  });

  assert.equal(quality.qualityLabel, "weak");
  assert.equal(quality.qualityScore, 1);
});

test("quality scoring marks empty context as missing", () => {
  const quality = evaluateContextQuality({
    itemCount: 0,
    topFile: null,
    topSymbol: null,
    files: [],
    symbols: [],
  }, {
    expected_paths: ["arc/species/species.py"],
    expected_symbols: ["ARCSpecies"],
  });

  assert.equal(quality.qualityLabel, "missing");
  assert.equal(quality.qualityScore, 0);
});

test("parity computation compares ordered quality scores", () => {
  assert.equal(computeOrientationParity(makeQuality("acceptable"), makeQuality("strong")), true);
  assert.equal(computeOrientationParity(makeQuality("strong"), makeQuality("weak")), false);
  assert.equal(computeOrientationParity(makeQuality("unchecked"), makeQuality("strong")), null);
});

test("quality-preserving reduction is computed only for parity rows", () => {
  assert.equal(computeQualityPreservingReductionPct(100, 25, true), 75);
  assert.equal(computeQualityPreservingReductionPct(100, 25, false), null);
  assert.equal(computeQualityPreservingReductionPct(0, 25, true), null);
});

test("contamination detection reuses suspicious vtrace path markers", () => {
  assert.deepEqual(detectContaminatedVtracePaths([
    "arc/species/species.py",
    ".claude/worktrees/agent-a/arc/species/species.py",
    "dist/generated.py",
  ]), [
    ".claude/worktrees/agent-a/arc/species/species.py",
    "dist/generated.py",
  ]);
});

test("stable task loading preserves file order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arc-stage2-"));

  try {
    const tasksPath = path.join(dir, "tasks.json");
    await writeFile(tasksPath, JSON.stringify([
      { id: "a", category: "exact", task: "Find A.", query: "A" },
      { id: "b", category: "workflow", task: "Find B.", query: "B" },
    ]));

    assert.deepEqual(await loadTasks(tasksPath), [
      { id: "a", category: "exact", task: "Find A.", query: "A" },
      { id: "b", category: "workflow", task: "Find B.", query: "B" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CSV escaping is stable for commas, quotes, and newlines", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("a,b"), "\"a,b\"");
  assert.equal(csvEscape("a\"b"), "\"a\"\"b\"");
  assert.equal(csvEscape("a\nb"), "\"a\nb\"");
  assert.equal(csvEscape(null), "");
});

test("markdown summary generation reports parity results", () => {
  const rows = [
    makeRow({
      id: "parity",
      baselineQuality: makeQuality("acceptable"),
      vtraceQuality: makeQuality("strong"),
      baselineTokens: 100,
      vtraceTokens: 20,
    }),
    makeRow({
      id: "regression",
      baselineQuality: makeQuality("strong"),
      vtraceQuality: makeQuality("weak"),
      baselineTokens: 100,
      vtraceTokens: 10,
    }),
  ];
  const summary = summarizeRows(rows);
  const markdown = renderMarkdown({
    arcRepoPath: "/home/calvin/code/ARC",
    toolCommand: "handoff",
  }, rows, summary);

  assert.equal(summary.parityCount, 1);
  assert.equal(summary.vtraceBetterCount, 1);
  assert.equal(summary.vtraceWorseCount, 1);
  assert.match(markdown, /orientation parity or better on 1\/2 checked tasks/);
  assert.match(markdown, /Mean quality-preserving reduction: 80\.00%/);
  assert.match(markdown, /\| regression \| strong \| weak \| no \|/);
});

function makeQuality(label: QualityEvaluation["qualityLabel"]): QualityEvaluation {
  const scores = {
    missing: 0,
    weak: 1,
    acceptable: 2,
    strong: 3,
    unchecked: null,
  };

  return {
    qualityLabel: label,
    qualityScore: scores[label],
    matchedExpectedPath: label === "strong" ? "arc/species/species.py" : null,
    matchedExpectedSymbol: null,
  };
}

function makeRow(overrides: {
  readonly id: string;
  readonly baselineQuality: QualityEvaluation;
  readonly vtraceQuality: QualityEvaluation;
  readonly baselineTokens: number;
  readonly vtraceTokens: number;
}): OrientationRow {
  const parity = computeOrientationParity(overrides.baselineQuality, overrides.vtraceQuality);
  const baselineChars = overrides.baselineTokens * 4;
  const vtraceChars = overrides.vtraceTokens * 4;

  return {
    id: overrides.id,
    category: "exact",
    task: "Find the ARC species class implementation.",
    query: "ARCSpecies",
    expected: {
      expected_paths: ["arc/species/species.py"],
      expected_symbols: ["ARCSpecies"],
      notes: "Exact class lookup.",
    },
    baseline: {
      files: ["arc/species/species.py"],
      snippets: [],
      chars: baselineChars,
      estTokens: estimateTokens(baselineChars),
      notes: [],
    },
    vtrace: {
      selectedIntent: "explore",
      routingProfile: "explore",
      capsuleProfile: "explain_stable",
      itemCount: 1,
      pivotCount: 1,
      supportCount: 0,
      topResult: "arc.species.ARCSpecies",
      topFile: "arc/species/species.py",
      files: ["arc/species/species.py"],
      symbols: ["arc.species.ARCSpecies"],
      items: [{ filePath: "arc/species/species.py", name: "arc.species.ARCSpecies" }],
      chars: vtraceChars,
      estTokens: estimateTokens(vtraceChars),
      contaminatedPaths: [],
      contaminationDetected: false,
      diagnostics: [],
      rawSnippet: {},
    },
    baselineQuality: overrides.baselineQuality,
    vtraceQuality: overrides.vtraceQuality,
    vtraceOrientationParity: parity,
    qualityPreservingReductionPct: computeQualityPreservingReductionPct(
      estimateTokens(baselineChars),
      estimateTokens(vtraceChars),
      parity,
    ),
    notes: [],
  };
}
