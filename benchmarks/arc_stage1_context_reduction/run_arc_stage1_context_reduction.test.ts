import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  calculateReductionPct,
  capContentByChars,
  csvEscape,
  detectContaminatedVtracePaths,
  estimateTokens,
  evaluateQuality,
  extractSnippetRanges,
  loadQueries,
  parseVtraceOutput,
  renderRowsTable,
  stableDeduplicateFiles,
  summarizeRows,
} from "./run_arc_stage1_context_reduction";

test("estimated token calculation uses ceil chars divided by four", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(1), 1);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
});

test("reduction percentage is null when baseline has no tokens", () => {
  assert.equal(calculateReductionPct(0, 10), null);
  assert.equal(calculateReductionPct(100, 25), 75);
  assert.equal(calculateReductionPct(100, 125), -25);
});

test("stable query loading preserves file order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "arc-stage1-"));

  try {
    const queriesPath = path.join(dir, "queries.json");
    await writeFile(queriesPath, JSON.stringify([
      { category: "exact", query: "ARCSpecies" },
      { category: "workflow", query: "where are conformers filtered" },
    ]));

    assert.deepEqual(await loadQueries(queriesPath), [
      { category: "exact", query: "ARCSpecies" },
      { category: "workflow", query: "where are conformers filtered" },
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

test("baseline file deduplication preserves first-seen order and max count", () => {
  assert.deepEqual(stableDeduplicateFiles([
    "/repo/a.py",
    "/repo/b.py",
    "/repo/a.py",
    "/repo/c.py",
  ], 2), [
    "/repo/a.py",
    "/repo/b.py",
  ]);
});

test("snippet extraction around line matches is deterministic", () => {
  assert.deepEqual(extractSnippetRanges([10, 30], 100, 2, 3), [
    { startLine: 8, endLine: 12 },
    { startLine: 28, endLine: 32 },
  ]);
});

test("overlapping snippets are merged deterministically", () => {
  assert.deepEqual(extractSnippetRanges([10, 12, 40], 100, 5, 3), [
    { startLine: 5, endLine: 17 },
    { startLine: 35, endLine: 45 },
  ]);
});

test("capped-full-file counting caps content per file", () => {
  const capped = capContentByChars("abcdefghij", 4);

  assert.equal(capped, "abcd");
  assert.equal(estimateTokens(capped.length), 1);
});

test("representative handoff JSON fixture parses counts and metadata", () => {
  const parsed = parseVtraceOutput({
    selectedIntent: "explore",
    routingProfile: { id: "explore-default" },
    capsuleProfile: { id: "explain-stable" },
    capsule: {
      items: [
        {
          role: "pivot",
          fqName: "arc.species.ARCSpecies",
          localName: "ARCSpecies",
          filePath: "arc/species/species.py",
          sourceBacked: true,
          content: { mode: "full", source: "class ARCSpecies: pass" },
        },
        {
          role: "support",
          fqName: "arc.common.helper",
          localName: "helper",
          filePath: "arc/common.py",
          sourceBacked: true,
          content: { mode: "signature_only", signature: "def helper()" },
        },
      ],
      budget: {
        model: "character_count",
        maxCharacters: 2000,
        usedCharacters: 128,
        remainingCharacters: 1872,
      },
      truncated: false,
      compressed: false,
    },
  }, "handoff");

  assert.equal(parsed.selectedIntent, "explore");
  assert.equal(parsed.routingProfile, "explore-default");
  assert.equal(parsed.capsuleProfile, "explain-stable");
  assert.equal(parsed.itemCount, 2);
  assert.equal(parsed.pivotCount, 1);
  assert.equal(parsed.supportCount, 1);
  assert.equal(parsed.sourceBackedPivotCount, 1);
  assert.equal(parsed.chars, 128);
  assert.equal(parsed.estTokens, 32);
  assert.equal(parsed.topResult, "arc.species.ARCSpecies");
  assert.equal(parsed.topFile, "arc/species/species.py");
});

test("representative capsule JSON fixture parses pivot and support arrays", () => {
  const parsed = parseVtraceOutput({
    intent: "debug",
    routingProfile: { id: "debug-default" },
    capsuleProfile: { id: "debug-focused" },
    capsule: {
      pivots: [
        {
          role: "pivot",
          localName: "Scheduler",
          filePath: "arc/scheduler.py",
          sourceBacked: true,
          content: { mode: "summary", summary: "schedules jobs" },
        },
      ],
      supportingItems: [],
      budget: {
        model: "character_count",
        maxCharacters: 2000,
        usedCharacters: 44,
        remainingCharacters: 1956,
      },
      truncated: false,
      compressed: true,
    },
  }, "capsule");

  assert.equal(parsed.selectedIntent, "debug");
  assert.equal(parsed.itemCount, 1);
  assert.equal(parsed.pivotCount, 1);
  assert.equal(parsed.supportCount, 0);
  assert.equal(parsed.sourceBackedPivotCount, 1);
  assert.equal(parsed.chars, 44);
});

test("source-backed pivot count is null when the flag is not exposed", () => {
  const parsed = parseVtraceOutput({
    capsule: {
      items: [
        {
          role: "pivot",
          localName: "ARCSpecies",
          filePath: "arc/species/species.py",
          content: { mode: "summary", summary: "species model" },
        },
      ],
      budget: {
        model: "character_count",
        maxCharacters: 2000,
        usedCharacters: 64,
        remainingCharacters: 1936,
      },
    },
  }, "handoff");

  assert.equal(parsed.sourceBackedPivotCount, null);
});

test("strong quality label comes from top path match", () => {
  const quality = evaluateQuality(makeVtraceForQuality({
    topFile: "arc/species/species.py",
    items: [{ filePath: "arc/species/species.py", name: "Other" }],
  }), {
    expected_paths: ["arc/species/species.py"],
    expected_symbols: ["ARCSpecies"],
  });

  assert.equal(quality.qualityLabel, "strong");
  assert.equal(quality.matchedExpectedPath, "arc/species/species.py");
});

test("acceptable quality label comes from non-top item match", () => {
  const quality = evaluateQuality(makeVtraceForQuality({
    topFile: "arc/common.py",
    topResult: "arc.common.helper",
    items: [
      { filePath: "arc/common.py", name: "helper" },
      { filePath: "arc/reaction/reaction.py", name: "arc.reaction.ARCReaction" },
    ],
  }), {
    expected_paths: ["arc/reaction/reaction.py"],
    expected_symbols: ["ARCReaction"],
  });

  assert.equal(quality.qualityLabel, "acceptable");
  assert.equal(quality.matchedExpectedPath, "arc/reaction/reaction.py");
});

test("weak quality label is used when context exists without expected match", () => {
  const quality = evaluateQuality(makeVtraceForQuality({
    topFile: "arc/common.py",
    items: [{ filePath: "arc/common.py", name: "helper" }],
  }), {
    expected_paths: ["arc/species/species.py"],
    expected_symbols: ["ARCSpecies"],
  });

  assert.equal(quality.qualityLabel, "weak");
});

test("missing quality label is used when vtrace returns no context", () => {
  const quality = evaluateQuality(makeVtraceForQuality({
    itemCount: 0,
    topFile: null,
    topResult: null,
    items: [],
  }), {
    expected_paths: ["arc/species/species.py"],
    expected_symbols: ["ARCSpecies"],
  });

  assert.equal(quality.qualityLabel, "missing");
});

test("unchecked quality label is used when no expectation exists", () => {
  const quality = evaluateQuality(makeVtraceForQuality({
    topFile: "arc/species/species.py",
    items: [{ filePath: "arc/species/species.py", name: "ARCSpecies" }],
  }), undefined);

  assert.equal(quality.qualityLabel, "unchecked");
});

test("detects .claude worktree contamination in vtrace paths", () => {
  assert.deepEqual(detectContaminatedVtracePaths([
    ".claude/worktrees/agent-a/arc/species/species.py",
    "arc/species/species.py",
  ]), [
    ".claude/worktrees/agent-a/arc/species/species.py",
  ]);
});

test("clean vtrace paths are not flagged as contaminated", () => {
  assert.deepEqual(detectContaminatedVtracePaths([
    "arc/species/species.py",
    "arc/reaction/reaction.py",
  ]), []);
});

test("summary marks benchmark unacceptable when contamination exists", () => {
  const summary = summarizeRows([
    makeBenchmarkRow([".claude/worktrees/agent-a/arc/species/species.py"]),
    makeBenchmarkRow([]),
  ]);

  assert.equal(summary.rowsWithContaminatedVtracePaths, 1);
  assert.equal(summary.contaminatedVtracePathCount, 1);
  assert.equal(summary.benchmarkAcceptableForReductionClaim, false);
});

test("summary marks benchmark acceptable when no contamination exists", () => {
  const summary = summarizeRows([
    makeBenchmarkRow([]),
    makeBenchmarkRow([]),
  ]);

  assert.equal(summary.rowsWithContaminatedVtracePaths, 0);
  assert.equal(summary.contaminatedVtracePathCount, 0);
  assert.equal(summary.benchmarkAcceptableForReductionClaim, true);
});

test("--baseline-mode all summary fields include every baseline mode", () => {
  const summary = summarizeRows([
    makeBenchmarkRow([], {
      baselineMode: "all",
      baselines: {
        "full-file": makeBaseline("full-file", 400),
        snippet: makeBaseline("snippet", 120),
        "capped-full-file": makeBaseline("capped-full-file", 200),
      },
      reductions: {
        "full-file": 80,
        snippet: 33.333333,
        "capped-full-file": 60,
      },
    }),
  ]);

  assert.deepEqual(summary.baselineSummaries.map((baseline) => baseline.mode), [
    "full-file",
    "snippet",
    "capped-full-file",
  ]);
  assert.equal(summary.baselineSummaries[0]?.averageBaselineTokens, 100);
  assert.equal(summary.baselineSummaries[1]?.averageBaselineTokens, 30);
  assert.equal(summary.baselineSummaries[2]?.averageBaselineTokens, 50);
});

test("category summary is baseline-aware in all mode", () => {
  const summary = summarizeRows([
    makeBenchmarkRow([], {
      baselineMode: "all",
      baselines: {
        "full-file": makeBaseline("full-file", 400),
        snippet: makeBaseline("snippet", 100),
        "capped-full-file": makeBaseline("capped-full-file", 200),
      },
      reductions: {
        "full-file": 80,
        snippet: 20,
        "capped-full-file": 60,
      },
    }),
  ]);

  assert.equal(summary.categoryAverages[0]?.mean_full_file_reduction_pct, 80);
  assert.equal(summary.categoryAverages[0]?.mean_snippet_reduction_pct, 20);
  assert.equal(summary.categoryAverages[0]?.mean_capped_full_file_reduction_pct, 60);
});

test("backward-compatible full-file mode keeps selected baseline summary", () => {
  const summary = summarizeRows([makeBenchmarkRow([])]);

  assert.deepEqual(summary.baselineSummaries.map((baseline) => baseline.mode), ["full-file"]);
  assert.equal(summary.averageBaselineTokens, 100);
  assert.equal(summary.meanReductionPercent, 80);
});

test("source-backed pivot rendering does not produce blank cells", () => {
  const rendered = renderRowsTable([makeBenchmarkRow([])]);

  assert.match(rendered, /\| unknown \|/);
  assert.doesNotMatch(rendered, /\|\s+\| no \|/);
});

function makeBenchmarkRow(
  contaminatedPaths: readonly string[],
  overrides: {
    readonly baselineMode?: "full-file" | "snippet" | "capped-full-file" | "all";
    readonly baselines?: ReturnType<typeof makeBaselineMap>;
    readonly reductions?: Record<string, number | null>;
    readonly itemCount?: number;
    readonly items?: Array<{ readonly filePath: string | null; readonly name: string | null }>;
  } = {},
) {
  const baselineMode = overrides.baselineMode ?? "full-file";
  const baseline = overrides.baselines?.["full-file"] ?? makeBaseline("full-file", 400);
  const baselines = overrides.baselines ?? makeBaselineMap(baseline);
  const reductions = overrides.reductions ?? { "full-file": 80 };

  return {
    query: "ARCSpecies",
    category: "exact",
    baselineMode,
    baseline,
    baselines,
    vtrace: {
      selectedIntent: "explain",
      routingProfile: "explain",
      capsuleProfile: "explain_stable",
      itemCount: overrides.itemCount ?? 1,
      pivotCount: 1,
      supportCount: 0,
      sourceBackedPivotCount: null,
      chars: 80,
      estTokens: 20,
      topResult: "arc.species.ARCSpecies",
      topFile: contaminatedPaths[0] ?? "arc/species/species.py",
      items: overrides.items ?? [{ filePath: contaminatedPaths[0] ?? "arc/species/species.py", name: "arc.species.ARCSpecies" }],
      contaminatedPaths,
      contaminationDetected: contaminatedPaths.length > 0,
      diagnostics: [],
      rawSnippet: {},
    },
    reductionPct: 80,
    reductions,
    quality: {
      qualityLabel: "strong",
      expectedPaths: ["arc/species/species.py"],
      expectedSymbols: ["ARCSpecies"],
      matchedExpectedPath: "arc/species/species.py",
      matchedExpectedSymbol: null,
    },
    expectedAreaHits: [],
    notes: [],
  };
}

function makeVtraceForQuality(overrides: {
  readonly itemCount?: number;
  readonly topFile?: string | null;
  readonly topResult?: string | null;
  readonly items?: Array<{ readonly filePath: string | null; readonly name: string | null }>;
}) {
  const items = overrides.items ?? [{ filePath: "arc/species/species.py", name: "ARCSpecies" }];

  return {
    itemCount: overrides.itemCount ?? items.length,
    topFile: overrides.topFile === undefined ? items[0]?.filePath ?? null : overrides.topFile,
    topResult: overrides.topResult === undefined ? items[0]?.name ?? null : overrides.topResult,
    items,
  };
}

function makeBaselineMap(baseline: ReturnType<typeof makeBaseline>) {
  return {
    [baseline.mode]: baseline,
  };
}

function makeBaseline(mode: "full-file" | "snippet" | "capped-full-file", chars: number) {
  return {
    mode,
    files: ["arc/species/species.py"],
    chars,
    estTokens: estimateTokens(chars),
    snippets: [],
    notes: [],
  };
}
