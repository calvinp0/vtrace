import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  calculateReductionPct,
  csvEscape,
  detectContaminatedVtracePaths,
  estimateTokens,
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

test("source-backed pivot rendering does not produce blank cells", () => {
  const rendered = renderRowsTable([makeBenchmarkRow([])]);

  assert.match(rendered, /\| unknown \|/);
  assert.doesNotMatch(rendered, /\|\s+\| no \|/);
});

function makeBenchmarkRow(contaminatedPaths: readonly string[]) {
  return {
    query: "ARCSpecies",
    category: "exact",
    baseline: {
      files: ["arc/species/species.py"],
      chars: 400,
      estTokens: 100,
      snippets: [],
      notes: [],
    },
    vtrace: {
      selectedIntent: "explain",
      routingProfile: "explain",
      capsuleProfile: "explain_stable",
      itemCount: 1,
      pivotCount: 1,
      supportCount: 0,
      sourceBackedPivotCount: null,
      chars: 80,
      estTokens: 20,
      topResult: "arc.species.ARCSpecies",
      topFile: contaminatedPaths[0] ?? "arc/species/species.py",
      contaminatedPaths,
      contaminationDetected: contaminatedPaths.length > 0,
      diagnostics: [],
      rawSnippet: {},
    },
    reductionPct: 80,
    expectedAreaHits: [],
    notes: [],
  };
}
