import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  CAPSULE_V2_CONTEXT_FILENAME,
  CAPSULE_V2_MANIFEST_FILENAME,
  CAPSULE_V2_RANKING_FILENAME,
  buildCapsuleV2Manifest,
  buildCapsuleV2RankingSummary,
  capsuleV2ArtifactsNotPersistedMeta,
  isDeferredItem,
  pivotRankingVersionOf,
  writeCapsuleV2Artifacts,
  type CapsuleV2ArtifactBundle,
} from "./stage5Artifacts";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  NO_DEBUG_ROLE_SIGNALS,
  type CapsuleV2Diagnostics,
  type CapsuleV2Item,
  type CapsuleV2Result,
  type CapsuleV2Scorecard,
} from "./types";

// --------------------------------------------------------------------------
// Fixtures — hand-built CapsuleV2Result objects. No graph build, no subprocess,
// no Docker, no model: every test feeds plain literals to the pure builders.
// --------------------------------------------------------------------------

const SCORECARD: CapsuleV2Scorecard = {
  lexical: 0.7,
  symbol: 0.9,
  path: 0.4,
  test_to_impl: 0.2,
  body_literal: 0.8,
  graph_proximity: 0.5,
  centrality: 0.3,
  actionability: 0.6,
  hub_penalty: 0,
  final: 0.82,
};

function makeItem(overrides: Partial<CapsuleV2Item> = {}): CapsuleV2Item {
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    role: "pivot",
    role_reason: "implementation helper does the actual work",
    path: "astropy/units/format/cds.py",
    fq_name: "astropy.units.format.cds.CDS._make_parser",
    symbol: "_make_parser",
    kind: "method",
    content_mode: CapsuleV2ContentMode.Full,
    source: "def _make_parser(self): ...",
    evidence: ["symbol exact match", "body literal"],
    scorecard: SCORECARD,
    estimated_tokens: 410,
    pivot_ranking_version: "v2",
    pivot_rank_score: 0.95,
    pivot_rank_signals: ["multi-evidence(3) +0.2"],
    pivot_rank_penalties: [],
    pivot_rank_reason: "base 0.82; +[multi-evidence(3) +0.2] => 0.95",
    ...overrides,
  };
}

const DIAGNOSTICS: CapsuleV2Diagnostics = {
  intent_reason: ["issue describes a parser bug"],
  intent_confidence: "high",
  strategy: {
    candidate_generators: ["lexical", "symbol"],
    role_policy: "debug_refinement",
    budget_policy: "standard sizing",
  },
  candidate_count: 7,
  pivot_count: 1,
  support_count: 1,
  discarded_count: 1,
  tier: CapsuleV2Mode.Standard,
  weights: { lexical: 1, symbol: 1.5 },
  likely_files: ["astropy/units/format/cds.py"],
  likely_symbols: ["_make_parser"],
  failing_tests: ["astropy/units/tests/test_format.py::test_cds_grammar"],
};

function makeResult(overrides: Partial<CapsuleV2Result> = {}): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Debug,
    actual_mode: CapsuleV2Mode.Standard,
    budget: { max_tokens: 8000, estimated_tokens: 489, used_percent: 6.1 },
    pivots: [makeItem()],
    support: [
      makeItem({
        role: "support",
        symbol: "CDS",
        kind: "class",
        content_mode: CapsuleV2ContentMode.Signature,
        source: undefined,
        signature: "class CDS(Base):",
        estimated_tokens: 60,
        // Support items carry no pivot-ranking metadata.
        pivot_ranking_version: undefined,
        pivot_rank_score: undefined,
        pivot_rank_signals: undefined,
        pivot_rank_penalties: undefined,
        pivot_rank_reason: undefined,
      }),
    ],
    discarded: [
      {
        ...NO_DEBUG_ROLE_SIGNALS,
        path: "docs/units/format.rst",
        symbol: "cds-format",
        kind: "markdown-section",
        scorecard: SCORECARD,
        evidence: ["lexical hit"],
        discard_reason: "non-source example down-ranked out of pivot role",
      },
    ],
    diagnostics: DIAGNOSTICS,
    ...overrides,
  };
}

const BUNDLE: CapsuleV2ArtifactBundle = {
  instanceId: "astropy__astropy-14369",
  result: makeResult(),
  contextMarkdown: "# Capsule v2\n\n## Pivot: _make_parser\n\nbody...",
};

const CTX = { runLabel: "eval-strictv2-vtrace-astropy-14369", generatedAt: "2026-06-11T00:00:00.000Z" };

// --------------------------------------------------------------------------
// Pure-builder tests
// --------------------------------------------------------------------------

test("pivotRankingVersionOf reads the version stamped on the first pivot", () => {
  assert.equal(pivotRankingVersionOf(makeResult()), "v2");
  assert.equal(
    pivotRankingVersionOf(makeResult({ pivots: [makeItem({ pivot_ranking_version: "legacy" })] })),
    "legacy",
  );
});

test("isDeferredItem flags non-full content modes", () => {
  assert.equal(isDeferredItem(makeItem({ content_mode: CapsuleV2ContentMode.Full })), false);
  assert.equal(isDeferredItem(makeItem({ content_mode: CapsuleV2ContentMode.Signature })), true);
  assert.equal(isDeferredItem(makeItem({ content_mode: CapsuleV2ContentMode.Skeleton })), true);
});

test("buildCapsuleV2Manifest carries identity, budget, and engine fields", () => {
  const manifest = buildCapsuleV2Manifest(BUNDLE, CTX);
  assert.equal(manifest.instanceId, "astropy__astropy-14369");
  assert.equal(manifest.runLabel, "eval-strictv2-vtrace-astropy-14369");
  assert.equal(manifest.capsuleEngine, "v2");
  assert.equal(manifest.capsuleIntent, "debug");
  assert.equal(manifest.capsuleActualMode, "standard");
  assert.equal(manifest.pivotRankingVersion, "v2");
  assert.equal(manifest.capsuleTokenEstimate, 489);
  assert.equal(manifest.capsuleBudget.maxTokens, 8000);
  assert.equal(manifest.generatedAt, "2026-06-11T00:00:00.000Z");
});

test("buildCapsuleV2Manifest preserves per-item pivot-ranking metadata", () => {
  const manifest = buildCapsuleV2Manifest(BUNDLE, CTX);
  const pivot = manifest.items.find((item) => item.role === "pivot");
  assert.ok(pivot);
  assert.equal(pivot.pivotRankingVersion, "v2");
  assert.equal(pivot.pivotRankScore, 0.95);
  assert.deepEqual(pivot.pivotRankSignals, ["multi-evidence(3) +0.2"]);
  assert.deepEqual(pivot.pivotRankPenalties, []);
  assert.equal(pivot.pivotRankReason, "base 0.82; +[multi-evidence(3) +0.2] => 0.95");
  assert.equal(pivot.tokenEstimate, 410);
  assert.equal(pivot.kind, "method");
});

test("buildCapsuleV2Manifest records deferred refs and lossless discarded/diagnostics", () => {
  const manifest = buildCapsuleV2Manifest(BUNDLE, CTX);
  // The signature-mode support item is deferred (body not inlined).
  assert.equal(manifest.deferredRefs.length, 1);
  assert.equal(manifest.deferredRefs[0]!.symbol, "CDS");
  assert.equal(manifest.deferredRefs[0]!.contentMode, "signature");
  // Lossless audit tail.
  assert.equal(manifest.discarded.length, 1);
  assert.equal(manifest.discarded[0]!.discard_reason, "non-source example down-ranked out of pivot role");
  assert.ok(manifest.diagnostics);
  assert.equal(manifest.diagnostics!.intent_confidence, "high");
});

test("buildCapsuleV2RankingSummary builds compact topItems with scores/signals/penalties/reasons", () => {
  const ranking = buildCapsuleV2RankingSummary(BUNDLE, CTX);
  assert.equal(ranking.pivotRankingVersion, "v2");
  assert.equal(ranking.topItems.length, 1);
  const top = ranking.topItems[0]!;
  assert.equal(top.rank, 1);
  assert.equal(top.path, "astropy/units/format/cds.py");
  assert.equal(top.symbol, "_make_parser");
  assert.equal(top.pivotRankScore, 0.95);
  assert.deepEqual(top.pivotRankSignals, ["multi-evidence(3) +0.2"]);
  assert.deepEqual(top.pivotRankPenalties, []);
  assert.ok(top.pivotRankReason?.includes("=> 0.95"));
  // One full pivot expanded, one signature support deferred.
  assert.equal(ranking.deferredRefCount, 1);
  assert.equal(ranking.expandedDeferredRefCount, 1);
});

test("capsuleV2ArtifactsNotPersistedMeta marks a non-v2 run honestly", () => {
  const meta = capsuleV2ArtifactsNotPersistedMeta("capsule-engine-not-v2");
  assert.equal(meta.capsuleV2ArtifactsPersisted, false);
  assert.equal(meta.capsuleEngine, null);
  assert.equal(meta.pivotRankingVersion, null);
  assert.equal(meta.capsuleV2ManifestFile, null);
  assert.equal(meta.capsuleV2ArtifactInstanceCount, 0);
  assert.equal(meta.capsuleV2ArtifactsMissingReason, "capsule-engine-not-v2");
});

// --------------------------------------------------------------------------
// IO: writeCapsuleV2Artifacts against a real tmp dir
// --------------------------------------------------------------------------

test("writeCapsuleV2Artifacts writes manifest, context, and ranking files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capsule-v2-artifacts-"));
  const meta = await writeCapsuleV2Artifacts(dir, [BUNDLE], CTX);

  const entries = await readdir(dir);
  assert.ok(entries.includes(CAPSULE_V2_MANIFEST_FILENAME), "manifest written");
  assert.ok(entries.includes(CAPSULE_V2_CONTEXT_FILENAME), "context written");
  assert.ok(entries.includes(CAPSULE_V2_RANKING_FILENAME), "ranking written");

  // Manifest is valid JSON carrying ranking metadata.
  const manifest = JSON.parse(await readFile(path.join(dir, CAPSULE_V2_MANIFEST_FILENAME), "utf8"));
  assert.equal(manifest.instanceId, "astropy__astropy-14369");
  assert.equal(manifest.items[0].pivotRankScore, 0.95);

  // Context is the EXACT injected markdown (plus trailing newline).
  const context = await readFile(path.join(dir, CAPSULE_V2_CONTEXT_FILENAME), "utf8");
  assert.equal(context, `${BUNDLE.contextMarkdown}\n`);

  // Ranking is valid JSON with compact topItems.
  const ranking = JSON.parse(await readFile(path.join(dir, CAPSULE_V2_RANKING_FILENAME), "utf8"));
  assert.equal(ranking.topItems[0].rank, 1);

  // Meta records the artifact paths and the pivot-ranking version.
  assert.equal(meta.capsuleV2ArtifactsPersisted, true);
  assert.equal(meta.capsuleEngine, "v2");
  assert.equal(meta.pivotRankingVersion, "v2");
  assert.equal(meta.capsuleV2ArtifactInstanceCount, 1);
  assert.equal(meta.capsuleV2ManifestFile, path.join(dir, CAPSULE_V2_MANIFEST_FILENAME));
  assert.equal(meta.capsuleV2ContextFile, path.join(dir, CAPSULE_V2_CONTEXT_FILENAME));
  assert.equal(meta.capsuleV2RankingFile, path.join(dir, CAPSULE_V2_RANKING_FILENAME));
  assert.equal(meta.capsuleV2ArtifactsMissingReason, null);
});

test("writeCapsuleV2Artifacts with no bundle writes nothing and records the missing reason", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capsule-v2-artifacts-empty-"));
  const meta = await writeCapsuleV2Artifacts(dir, [], CTX);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(meta.capsuleV2ArtifactsPersisted, false);
  assert.equal(meta.capsuleV2ArtifactsMissingReason, "capsule-engine-not-v2");
});

test("writeCapsuleV2Artifacts suffixes extra instances and keeps canonical names for the first", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capsule-v2-artifacts-multi-"));
  const second: CapsuleV2ArtifactBundle = {
    instanceId: "django__django-10880",
    result: makeResult(),
    contextMarkdown: "# Capsule v2 (second)",
  };
  const meta = await writeCapsuleV2Artifacts(dir, [BUNDLE, second], CTX);
  const entries = await readdir(dir);
  assert.ok(entries.includes(CAPSULE_V2_MANIFEST_FILENAME));
  assert.ok(entries.includes("_capsule_v2_manifest.django__django-10880.json"));
  assert.equal(meta.capsuleV2ArtifactInstanceCount, 2);
  // Canonical meta paths point at the FIRST bundle.
  assert.equal(meta.capsuleV2ManifestFile, path.join(dir, CAPSULE_V2_MANIFEST_FILENAME));
});

test("writeCapsuleV2Artifacts can use an injected writer (no real fs)", async () => {
  const writes: Record<string, string> = {};
  const meta = await writeCapsuleV2Artifacts("/virtual/raw/vtrace", [BUNDLE], CTX, async (p, c) => {
    writes[p] = c;
  });
  assert.equal(meta.capsuleV2ArtifactsPersisted, true);
  assert.ok(writes[path.join("/virtual/raw/vtrace", CAPSULE_V2_MANIFEST_FILENAME)]);
  assert.ok(writes[path.join("/virtual/raw/vtrace", CAPSULE_V2_CONTEXT_FILENAME)]);
  assert.ok(writes[path.join("/virtual/raw/vtrace", CAPSULE_V2_RANKING_FILENAME)]);
});
