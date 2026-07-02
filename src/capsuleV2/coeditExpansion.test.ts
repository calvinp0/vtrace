// Tests for the bounded hidden co-edit support expansion (M97).
//
// Layers: pure helpers (proximity, tokens), lane behaviour over a real fixture
// index (activation gating, rescue thresholds, injection gating/caps, hub and
// generic filters, generated pairs, determinism), and the builder's
// displacement rule (a co-edit never evicts a new-file, non-generic support
// item; it may reclaim slots spent on duplicate-file symbols).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import {
  expandCoeditSupport,
  meaningfulTokens,
  orderSupportWithCoedit,
  packageProximity,
  MAX_COEDIT_FILES,
  type CoeditExpansionInput,
} from "./coeditExpansion";
import { CandidateRole } from "../capsule/assignCandidateRoles";
import type { RefinedRoledCandidate } from "./debugRoles";
import { NO_DEBUG_ROLE_SIGNALS } from "./types";
import { seedCustomFixture, type CapsuleV2Fixture } from "./__fixtures__/capsuleV2Fixture";
import { insertEdges } from "../db/repositories/edgesRepository";
import { EdgeType, SymbolKind, type EdgeRecord } from "../domain/types";
import { HybridCandidateSource, type HybridCandidate } from "../retrieval/hybridRetrieval";

// --- helpers ------------------------------------------------------------------

const EMPTY_IDS = {
  anchorSymbolIds: new Set<string>(),
  titleSymbolIds: new Set<string>(),
  literalAnchorIds: new Set<string>(),
  directEvidenceStrongIds: new Set<string>(),
  suppressedDecoyIds: new Set<string>(),
};

function candidate(
  over: Partial<HybridCandidate> & { scores?: Partial<HybridCandidate["scores"]> } = {},
): HybridCandidate {
  const baseScores = {
    lexical: 0, fts: 0, tfidf: 0, bm25: 0, symbol: 0, path: 0, testToImpl: 0,
    bodyLiteral: 0, domain: 0, graph: 0, graphProximity: 0, centrality: 0,
    actionability: 1, inDegree: 0, localEvidence: 0, hubPenalty: 0,
    actionabilityPenalty: 0, final: 1,
  };
  return {
    symbolId: over.symbolId ?? "sym-1",
    filePath: over.filePath ?? "pkg/handler.py",
    fqName: over.fqName ?? "handle",
    localName: over.localName ?? "handle",
    kind: over.kind ?? SymbolKind.Function,
    scores: { ...baseScores, ...(over.scores ?? {}) },
    sources: over.sources ?? [HybridCandidateSource.Lexical],
    evidence: over.evidence ?? [],
    matches: over.matches ?? [],
  };
}

function entry(c: HybridCandidate, role: CandidateRole = CandidateRole.Pivot): RefinedRoledCandidate {
  return { candidate: c, role, roleReason: "test", signals: NO_DEBUG_ROLE_SIGNALS };
}

function edge(src: string, dst: string, type: EdgeType, salt = ""): EdgeRecord {
  return {
    id: createHash("sha256").update([src, dst, type, salt].join("\0")).digest("hex"),
    srcSymbolId: src,
    dstSymbolId: dst,
    edgeType: type,
    confidence: 1,
  };
}

function laneInput(over: Partial<CoeditExpansionInput> & { db: Database }): CoeditExpansionInput {
  return {
    db: over.db,
    task: over.task ?? "fix the annotation handling bug",
    pivotEntries: over.pivotEntries ?? [],
    supportEntries: over.supportEntries ?? [],
    winnerSymbolIds: over.winnerSymbolIds ?? new Set(),
    poolFilePaths: over.poolFilePaths ?? new Set(),
    ids: over.ids ?? EMPTY_IDS,
  };
}

// A fixture with an anchor file, a same-package sibling connected by call edges
// whose connecting symbol carries a task word ("annotation"), plus decoys.
interface LaneFixture extends CapsuleV2Fixture {
  ids: Record<string, string>; // localName -> symbolId per file key
}

function seedLaneFixture(): LaneFixture {
  const fx = seedCustomFixture([
    { relPath: "pkg/anchor.py", specs: [
      { localName: "anchor_func", kind: SymbolKind.Function, body: "def anchor_func():\n    return build_annotation()" },
    ] },
    { relPath: "pkg/sibling.py", specs: [
      { localName: "build_annotation", kind: SymbolKind.Function, body: "def build_annotation():\n    return 1" },
    ] },
    { relPath: "pkg/plain.py", specs: [
      { localName: "plain_helper", kind: SymbolKind.Function, body: "def plain_helper():\n    return 2" },
    ] },
    { relPath: "pkg/utils.py", specs: [
      { localName: "generic_annotation_util", kind: SymbolKind.Function, body: "def generic_annotation_util():\n    return 3" },
    ] },
    { relPath: "pkg/tests/test_anchor.py", specs: [
      { localName: "test_annotation", kind: SymbolKind.Function, body: "def test_annotation():\n    assert True" },
    ] },
    { relPath: "far/away.py", specs: [
      { localName: "distant_annotation", kind: SymbolKind.Function, body: "def distant_annotation():\n    return 4" },
    ] },
  ]);
  // Recover symbol ids by seeding a map from the index itself.
  const rows = fx.db.query(
    "SELECT symbols.local_name AS name, symbols.id AS id FROM symbols",
  ).all() as Array<{ name: string; id: string }>;
  const ids: Record<string, string> = {};
  for (const row of rows) ids[row.name] = row.id;
  return { ...fx, ids };
}

function linkAll(db: Database, pairs: Array<[string, string, EdgeType, string?]>): void {
  insertEdges(db, pairs.map(([s, d, t, salt]) => edge(s, d, t, salt ?? "")));
}

function anchorPivot(fx: LaneFixture): RefinedRoledCandidate {
  return entry(candidate({
    symbolId: fx.ids["anchor_func"]!, filePath: "pkg/anchor.py",
    localName: "anchor_func", fqName: "anchor_func",
  }));
}

// --- pure helpers ----------------------------------------------------------------

test("packageProximity: same dir 2, parent/child 1, sibling packages 1, distant null", () => {
  assert.equal(packageProximity("pkg/a.py", "pkg/b.py"), 2);
  assert.equal(packageProximity("pkg/a.py", "pkg/sub/b.py"), 1);
  assert.equal(packageProximity("pkg/sub/a.py", "pkg/other/b.py"), 1);
  assert.equal(packageProximity("pkg/a.py", "far/b.py"), null);
});

test("meaningfulTokens: splits camel/snake, drops short and generic words", () => {
  const tokens = meaningfulTokens("_process_contour_level_args ScalarFormatter of");
  assert.ok(tokens.has("contour"));
  assert.ok(tokens.has("level"));
  assert.ok(tokens.has("scalar"));
  assert.ok(tokens.has("formatter"));
  assert.ok(!tokens.has("args")); // generic
  assert.ok(!tokens.has("of")); // too short
});

// --- activation gating -------------------------------------------------------------

test("no pivots → lane does not fire", () => {
  const fx = seedLaneFixture();
  const result = expandCoeditSupport(laneInput({ db: fx.db }));
  assert.equal(result.fired, false);
  assert.equal(result.entries.length, 0);
  fx.db.close();
});

test("test-file lead pivot → lane does not fire", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [[fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.Calls]]);
  const lead = entry(candidate({
    symbolId: fx.ids["test_annotation"]!, filePath: "pkg/tests/test_anchor.py",
    localName: "test_annotation", fqName: "test_annotation",
  }));
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [lead] }));
  assert.equal(result.fired, false);
  fx.db.close();
});

test("generic-infra-named lead alone provides no anchor → lane does not fire", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [[fx.ids["generic_annotation_util"]!, fx.ids["build_annotation"]!, EdgeType.Calls]]);
  const lead = entry(candidate({
    symbolId: fx.ids["generic_annotation_util"]!, filePath: "pkg/utils.py",
    localName: "generic_annotation_util", fqName: "generic_annotation_util",
  }));
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [lead] }));
  assert.equal(result.fired, false);
  fx.db.close();
});

// --- injection ---------------------------------------------------------------------

test("edge-connected sibling with task-word affinity is injected as SUPPORT", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [[fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.Calls]]);
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [anchorPivot(fx)] }));
  assert.equal(result.fired, true);
  assert.equal(result.entries.length, 1);
  const injected = result.entries[0]!;
  assert.equal(injected.candidate.filePath, "pkg/sibling.py");
  assert.equal(injected.candidate.localName, "build_annotation");
  assert.equal(injected.role, CandidateRole.Support);
  // Support-strength scores: no direct evidence → can never become the lead.
  assert.equal(injected.candidate.scores.symbol, 0);
  assert.equal(injected.candidate.scores.bodyLiteral, 0);
  assert.ok(injected.candidate.scores.final < 0.5);
  assert.equal(result.candidates[0]!.action, "injected");
  fx.db.close();
});

test("edge-connected sibling WITHOUT affinity or stem share is rejected as ambiguous", () => {
  const fx = seedLaneFixture();
  // plain_helper carries no task word and shares no stem token with the anchor.
  linkAll(fx.db, [
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.References, "b"],
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "c"],
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "d"],
  ]);
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [anchorPivot(fx)] }));
  assert.equal(result.entries.length, 0);
  assert.ok(result.ambiguousRejectedCount >= 1);
  fx.db.close();
});

test("generic-infra-named neighbour is never injected", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    [fx.ids["anchor_func"]!, fx.ids["generic_annotation_util"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["generic_annotation_util"]!, EdgeType.Calls, "b"],
  ]);
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [anchorPivot(fx)] }));
  assert.equal(result.entries.length, 0);
  fx.db.close();
});

test("test-file neighbour is never injected", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    [fx.ids["anchor_func"]!, fx.ids["test_annotation"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["test_annotation"]!, EdgeType.Calls, "b"],
  ]);
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [anchorPivot(fx)] }));
  assert.equal(result.entries.length, 0);
  fx.db.close();
});

test("out-of-package neighbour is out of co-edit scope", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    [fx.ids["anchor_func"]!, fx.ids["distant_annotation"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["distant_annotation"]!, EdgeType.Calls, "b"],
  ]);
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [anchorPivot(fx)] }));
  assert.equal(result.entries.length, 0);
  fx.db.close();
});

test("a neighbour edge-connected to too many files repo-wide is hub-rejected", () => {
  const files = [
    { relPath: "pkg/anchor.py", specs: [
      { localName: "anchor_func", kind: SymbolKind.Function, body: "def anchor_func():\n    return hub_annotation()" },
    ] },
    { relPath: "pkg/hub.py", specs: [
      { localName: "hub_annotation", kind: SymbolKind.Function, body: "def hub_annotation():\n    return 1" },
    ] },
  ];
  for (let i = 0; i < 30; i += 1) {
    files.push({ relPath: `pkg/user_${i}.py`, specs: [
      { localName: `user_fn_${i}`, kind: SymbolKind.Function, body: `def user_fn_${i}():\n    return hub_annotation()` },
    ] });
  }
  const fx = seedCustomFixture(files);
  const rows = fx.db.query("SELECT symbols.local_name AS name, symbols.id AS id FROM symbols").all() as Array<{ name: string; id: string }>;
  const ids: Record<string, string> = {};
  for (const row of rows) ids[row.name] = row.id;
  const edges: Array<[string, string, EdgeType, string?]> = [
    [ids["anchor_func"]!, ids["hub_annotation"]!, EdgeType.Calls, "x"],
  ];
  for (let i = 0; i < 30; i += 1) {
    edges.push([ids[`user_fn_${i}`]!, ids["hub_annotation"]!, EdgeType.Calls, `u${i}`]);
  }
  linkAll(fx.db, edges);
  const lead = entry(candidate({
    symbolId: ids["anchor_func"]!, filePath: "pkg/anchor.py",
    localName: "anchor_func", fqName: "anchor_func",
  }));
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [lead] }));
  assert.equal(result.entries.length, 0);
  assert.ok(result.highDegreeRejectedCount >= 1);
  fx.db.close();
});

test("generated parser-table pair is injected even though generated files are otherwise excluded", () => {
  const fx = seedCustomFixture([
    { relPath: "pkg/format/cds.py", specs: [
      { localName: "parse_unit", kind: SymbolKind.Function, body: "def parse_unit():\n    return 1" },
    ] },
    { relPath: "pkg/format/cds_parsetab.py", specs: [
      { localName: "_tabversion", kind: SymbolKind.ModuleVariable, body: "_tabversion = '3.10'" },
    ] },
  ]);
  const rows = fx.db.query("SELECT symbols.local_name AS name, symbols.id AS id FROM symbols").all() as Array<{ name: string; id: string }>;
  const ids: Record<string, string> = {};
  for (const row of rows) ids[row.name] = row.id;
  const lead = entry(candidate({
    symbolId: ids["parse_unit"]!, filePath: "pkg/format/cds.py",
    localName: "parse_unit", fqName: "parse_unit",
  }));
  const result = expandCoeditSupport(laneInput({ db: fx.db, task: "units parse incorrectly", pivotEntries: [lead] }));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.candidate.filePath, "pkg/format/cds_parsetab.py");
  assert.equal(result.candidates[0]!.evidence_type, "generated_artifact_pair");
  fx.db.close();
});

// --- rescue -------------------------------------------------------------------------

test("pooled support with >=2 edges to an anchor is rescued; a 1-edge sibling is not", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    // sibling: 2 edges → rescueable once pooled.
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.References, "b"],
    // plain: only 1 edge → below the rescue bar.
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "c"],
  ]);
  const sibling = entry(candidate({
    symbolId: fx.ids["build_annotation"]!, filePath: "pkg/sibling.py",
    localName: "build_annotation", fqName: "build_annotation",
  }), CandidateRole.Support);
  const plain = entry(candidate({
    symbolId: fx.ids["plain_helper"]!, filePath: "pkg/plain.py",
    localName: "plain_helper", fqName: "plain_helper",
  }), CandidateRole.Support);
  const result = expandCoeditSupport(laneInput({
    db: fx.db,
    pivotEntries: [anchorPivot(fx)],
    supportEntries: [sibling, plain],
    winnerSymbolIds: new Set(), // neither is guaranteed a slot
    poolFilePaths: new Set(["pkg/anchor.py", "pkg/sibling.py", "pkg/plain.py"]),
  }));
  const rescued = result.candidates.filter((c) => c.action === "rescued");
  assert.deepEqual(rescued.map((c) => c.path), ["pkg/sibling.py"]);
  assert.ok(result.rescuedSymbolIds.has(fx.ids["build_annotation"]!));
  fx.db.close();
});

test("a support winner (already guaranteed a slot) is not re-proposed as a co-edit", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.References, "b"],
  ]);
  const sibling = entry(candidate({
    symbolId: fx.ids["build_annotation"]!, filePath: "pkg/sibling.py",
    localName: "build_annotation", fqName: "build_annotation",
  }), CandidateRole.Support);
  const result = expandCoeditSupport(laneInput({
    db: fx.db,
    pivotEntries: [anchorPivot(fx)],
    supportEntries: [sibling],
    winnerSymbolIds: new Set([fx.ids["build_annotation"]!]),
    poolFilePaths: new Set(["pkg/anchor.py", "pkg/sibling.py"]),
  }));
  assert.equal(result.entries.length, 0);
  fx.db.close();
});

// --- caps & determinism ---------------------------------------------------------------

test("one non-generated proposal per anchor; combined cap at MAX_COEDIT_FILES", () => {
  const fx = seedCustomFixture([
    { relPath: "pkg/anchor.py", specs: [
      { localName: "anchor_func", kind: SymbolKind.Function, body: "def anchor_func():\n    pass" },
    ] },
    { relPath: "pkg/anchor_two.py", specs: [
      { localName: "anchor_two_func", kind: SymbolKind.Function, body: "def anchor_two_func():\n    pass" },
    ] },
    { relPath: "pkg/first_annotation.py", specs: [
      { localName: "first_annotation", kind: SymbolKind.Function, body: "def first_annotation():\n    return 1" },
    ] },
    { relPath: "pkg/second_annotation.py", specs: [
      { localName: "second_annotation", kind: SymbolKind.Function, body: "def second_annotation():\n    return 2" },
    ] },
    { relPath: "pkg/third_annotation.py", specs: [
      { localName: "third_annotation", kind: SymbolKind.Function, body: "def third_annotation():\n    return 3" },
    ] },
  ]);
  const rows = fx.db.query("SELECT symbols.local_name AS name, symbols.id AS id FROM symbols").all() as Array<{ name: string; id: string }>;
  const ids: Record<string, string> = {};
  for (const row of rows) ids[row.name] = row.id;
  const anchors = [
    entry(candidate({ symbolId: ids["anchor_func"]!, filePath: "pkg/anchor.py",
      localName: "anchor_func", fqName: "anchor_func" })),
    entry(candidate({ symbolId: ids["anchor_two_func"]!, filePath: "pkg/anchor_two.py",
      localName: "anchor_two_func", fqName: "anchor_two_func" })),
  ];
  // Anchor 1 reaches two pooled siblings (first stronger); anchor 2 reaches the
  // third. Per-anchor cap keeps first + third; second is rejected as ambiguous.
  // Each sibling couples via calls AND references so the rescues stay selectable
  // under the M98 confidence tiers (a single relation type is low-confidence).
  const supportEntries: RefinedRoledCandidate[] = [];
  const edges: Array<[string, string, EdgeType, string?]> = [];
  for (const [src, name, n] of [
    ["anchor_func", "first_annotation", 3],
    ["anchor_func", "second_annotation", 2],
    ["anchor_two_func", "third_annotation", 2],
  ] as const) {
    for (let i = 0; i < n; i += 1) edges.push([ids[src]!, ids[name]!, EdgeType.Calls, `${name}-${i}`]);
    edges.push([ids[name]!, ids[src]!, EdgeType.References, `${name}-ref`]);
    supportEntries.push(entry(candidate({
      symbolId: ids[name]!, filePath: `pkg/${name}.py`, localName: name, fqName: name,
    }), CandidateRole.Support));
  }
  linkAll(fx.db, edges);
  const result = expandCoeditSupport(laneInput({
    db: fx.db,
    pivotEntries: anchors,
    supportEntries,
    poolFilePaths: new Set(["pkg/anchor.py", "pkg/anchor_two.py", ...supportEntries.map((e) => e.candidate.filePath)]),
  }));
  assert.equal(result.entries.length, MAX_COEDIT_FILES);
  assert.deepEqual(
    result.candidates.map((c) => c.path).sort(),
    ["pkg/first_annotation.py", "pkg/third_annotation.py"],
  );
  assert.ok(result.ambiguousRejectedCount >= 1); // anchor 1's runner-up sibling
  fx.db.close();
});

test("a rescue outranks a higher-scoring injection within one anchor", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    // Pooled sibling: 2 edges (rescue, score 4).
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.References, "b"],
    // Un-pooled sibling with affinity: injection scoring higher (1+2+4=7).
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.Calls, "c"],
  ]);
  const plain = entry(candidate({
    symbolId: fx.ids["plain_helper"]!, filePath: "pkg/plain.py",
    localName: "plain_helper", fqName: "plain_helper",
  }), CandidateRole.Support);
  const result = expandCoeditSupport(laneInput({
    db: fx.db,
    pivotEntries: [anchorPivot(fx)],
    supportEntries: [plain],
    poolFilePaths: new Set(["pkg/anchor.py", "pkg/plain.py"]),
  }));
  // The single per-anchor slot goes to the rescue even though the injection scored higher.
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.path, "pkg/plain.py");
  assert.equal(result.candidates[0]!.action, "rescued");
  fx.db.close();
});

// --- displacement-safe support ordering -------------------------------------------

function namedEntry(symbolId: string, filePath: string, role = CandidateRole.Support): RefinedRoledCandidate {
  return entry(candidate({ symbolId, filePath, localName: symbolId, fqName: symbolId }), role);
}

test("orderSupportWithCoedit: a new-file, non-generic winner is never displaced", () => {
  // 2 slots; both winners introduce new files → co-edit must rank BEHIND them.
  const winners = [namedEntry("s1", "pkg/one.py"), namedEntry("s2", "pkg/two.py")];
  const coeditEntry = namedEntry("cx", "pkg/coedit.py");
  const order = orderSupportWithCoedit({
    baseOrder: winners,
    coeditEntries: [coeditEntry],
    rescuedSymbolIds: new Set(),
    spareOnlySymbolIds: new Set(),
    pivotFilePaths: new Set(["pkg/pivot.py"]),
    maxSupport: 2,
    isProtectedTier: () => true,
  });
  assert.deepEqual(
    order.ordered.map((e) => e.candidate.symbolId).slice(0, 2),
    ["s1", "s2"],
  );
  assert.equal(order.displaceableWinners.length, 0);
});

test("orderSupportWithCoedit: duplicate-file symbols and generic files are displaceable", () => {
  const winners = [
    namedEntry("s1", "pkg/one.py"),
    namedEntry("dup", "pkg/pivot.py"), // second symbol of the pivot's file
    namedEntry("gen", "pkg/utils.py"), // generic-infra-named file
  ];
  const coeditEntry = namedEntry("cx", "pkg/coedit.py");
  const order = orderSupportWithCoedit({
    baseOrder: winners,
    coeditEntries: [coeditEntry],
    rescuedSymbolIds: new Set(),
    spareOnlySymbolIds: new Set(),
    pivotFilePaths: new Set(["pkg/pivot.py"]),
    maxSupport: 3,
    isProtectedTier: () => true,
  });
  // Co-edit sits after the protected new-file winner, before the displaceables.
  assert.deepEqual(
    order.ordered.map((e) => e.candidate.symbolId),
    ["s1", "cx", "dup", "gen"],
  );
  assert.deepEqual(order.displaceableWinners.map((e) => e.candidate.symbolId), ["dup", "gen"]);
});

test("orderSupportWithCoedit: a rescued non-winner is not emitted twice", () => {
  const rescued = namedEntry("resc", "pkg/sibling.py");
  const order = orderSupportWithCoedit({
    baseOrder: [namedEntry("s1", "pkg/one.py"), rescued],
    coeditEntries: [rescued],
    rescuedSymbolIds: new Set(["resc"]),
    spareOnlySymbolIds: new Set(),
    pivotFilePaths: new Set(["pkg/pivot.py"]),
    maxSupport: 1,
    isProtectedTier: () => true,
  });
  const ids = order.ordered.map((e) => e.candidate.symbolId);
  assert.deepEqual(ids, ["s1", "resc"]);
});

// --- confidence tiers (M98) ----------------------------------------------------------

test("single-relation-type rescue is pruned as low confidence, not rendered", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    // 3 edges, but ALL calls — one-way usage, not the co-edit signature.
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "b"],
    [fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, "c"],
  ]);
  const plain = entry(candidate({
    symbolId: fx.ids["plain_helper"]!, filePath: "pkg/plain.py",
    localName: "plain_helper", fqName: "plain_helper",
  }), CandidateRole.Support);
  const result = expandCoeditSupport(laneInput({
    db: fx.db,
    pivotEntries: [anchorPivot(fx)],
    supportEntries: [plain],
    poolFilePaths: new Set(["pkg/anchor.py", "pkg/plain.py"]),
  }));
  assert.equal(result.entries.length, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rescuedSymbolIds.size, 0); // stays in the base support order
  assert.equal(result.pruned.length, 1);
  assert.equal(result.pruned[0]!.path, "pkg/plain.py");
  assert.equal(result.pruned[0]!.confidence, "low");
  assert.equal(result.pruned[0]!.prune_reason, "single relation type rescue");
  fx.db.close();
});

test("sparse two-type rescue is MEDIUM (spare slots only); dense is HIGH", () => {
  const fx = seedLaneFixture();
  const edges: Array<[string, string, EdgeType, string?]> = [
    // sibling: 2 types, sparse (2 edges) → medium.
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.Calls, "a"],
    [fx.ids["build_annotation"]!, fx.ids["anchor_func"]!, EdgeType.References, "b"],
  ];
  // plain: 2 types, dense (8 edges) → high.
  for (let i = 0; i < 7; i += 1) {
    edges.push([fx.ids["anchor_func"]!, fx.ids["plain_helper"]!, EdgeType.Calls, `c${i}`]);
  }
  edges.push([fx.ids["plain_helper"]!, fx.ids["anchor_func"]!, EdgeType.References, "r"]);
  linkAll(fx.db, edges);
  const sibling = entry(candidate({
    symbolId: fx.ids["build_annotation"]!, filePath: "pkg/sibling.py",
    localName: "build_annotation", fqName: "build_annotation",
  }), CandidateRole.Support);
  const plain = entry(candidate({
    symbolId: fx.ids["plain_helper"]!, filePath: "pkg/plain.py",
    localName: "plain_helper", fqName: "plain_helper",
  }), CandidateRole.Support);
  // Two runs (the per-anchor cap keeps only the best rescue per anchor).
  const sparse = expandCoeditSupport(laneInput({
    db: fx.db,
    pivotEntries: [anchorPivot(fx)],
    supportEntries: [sibling],
    poolFilePaths: new Set(["pkg/anchor.py", "pkg/sibling.py"]),
  }));
  assert.equal(sparse.candidates.length, 1);
  assert.equal(sparse.candidates[0]!.confidence, "medium");
  assert.ok(sparse.spareOnlySymbolIds.has(fx.ids["build_annotation"]!));
  const dense = expandCoeditSupport(laneInput({
    db: fx.db,
    pivotEntries: [anchorPivot(fx)],
    supportEntries: [plain],
    poolFilePaths: new Set(["pkg/anchor.py", "pkg/plain.py"]),
  }));
  assert.equal(dense.candidates.length, 1);
  assert.equal(dense.candidates[0]!.confidence, "high");
  assert.equal(dense.spareOnlySymbolIds.size, 0);
  fx.db.close();
});

test("injection without a call edge is pruned even with task affinity", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    // references-only coupling; the connecting symbol carries a task word.
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.References, "a"],
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.References, "b"],
  ]);
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [anchorPivot(fx)] }));
  assert.equal(result.entries.length, 0);
  assert.equal(result.pruned.length, 1);
  assert.equal(result.pruned[0]!.prune_reason, "no call edge behind injection");
  fx.db.close();
});

test("injected __init__ package facade is pruned as low confidence", () => {
  const fx = seedCustomFixture([
    { relPath: "pkg/anchor.py", specs: [
      { localName: "anchor_func", kind: SymbolKind.Function, body: "def anchor_func():\n    return register_annotation()" },
    ] },
    { relPath: "pkg/__init__.py", specs: [
      { localName: "register_annotation", kind: SymbolKind.Function, body: "def register_annotation():\n    return 1" },
    ] },
  ]);
  const rows = fx.db.query("SELECT symbols.local_name AS name, symbols.id AS id FROM symbols").all() as Array<{ name: string; id: string }>;
  const ids: Record<string, string> = {};
  for (const row of rows) ids[row.name] = row.id;
  linkAll(fx.db, [
    [ids["anchor_func"]!, ids["register_annotation"]!, EdgeType.Calls, "a"],
    [ids["anchor_func"]!, ids["register_annotation"]!, EdgeType.Calls, "b"],
  ]);
  const lead = entry(candidate({
    symbolId: ids["anchor_func"]!, filePath: "pkg/anchor.py",
    localName: "anchor_func", fqName: "anchor_func",
  }));
  const result = expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [lead] }));
  assert.equal(result.entries.length, 0);
  assert.equal(result.pruned.length, 1);
  assert.equal(result.pruned[0]!.prune_reason, "package facade (__init__) injection");
  fx.db.close();
});

test("call-edge injection with task affinity is HIGH; stem-share-only is MEDIUM", () => {
  const fx = seedCustomFixture([
    { relPath: "pkg/contour.py", specs: [
      { localName: "draw_main", kind: SymbolKind.Function, body: "def draw_main():\n    return helper_fn()" },
    ] },
    { relPath: "pkg/contour_extra.py", specs: [
      { localName: "helper_fn", kind: SymbolKind.Function, body: "def helper_fn():\n    return 1" },
    ] },
  ]);
  const rows = fx.db.query("SELECT symbols.local_name AS name, symbols.id AS id FROM symbols").all() as Array<{ name: string; id: string }>;
  const ids: Record<string, string> = {};
  for (const row of rows) ids[row.name] = row.id;
  linkAll(fx.db, [
    [ids["draw_main"]!, ids["helper_fn"]!, EdgeType.Calls, "a"],
    [ids["draw_main"]!, ids["helper_fn"]!, EdgeType.Calls, "b"],
  ]);
  const lead = entry(candidate({
    symbolId: ids["draw_main"]!, filePath: "pkg/contour.py",
    localName: "draw_main", fqName: "draw_main",
  }));
  // No task word matches any connecting symbol; the neighbour only shares the
  // anchor's file stem ("contour") → selectable, but spare slots only.
  const stemOnly = expandCoeditSupport(laneInput({
    db: fx.db, task: "fix the rendering bug", pivotEntries: [lead],
  }));
  assert.equal(stemOnly.candidates.length, 1);
  assert.equal(stemOnly.candidates[0]!.confidence, "medium");
  assert.ok(stemOnly.spareOnlySymbolIds.has(ids["helper_fn"]!));
  // A task word matching the connecting symbol name upgrades it to HIGH.
  const affinity = expandCoeditSupport(laneInput({
    db: fx.db, task: "the helper output is wrong", pivotEntries: [lead],
  }));
  assert.equal(affinity.candidates.length, 1);
  assert.equal(affinity.candidates[0]!.confidence, "high");
  assert.equal(affinity.spareOnlySymbolIds.size, 0);
  fx.db.close();
});

test("orderSupportWithCoedit: a spare-only (medium) entry never displaces, even junk", () => {
  const winners = [
    namedEntry("s1", "pkg/one.py"),
    namedEntry("dup", "pkg/pivot.py"), // duplicate-file symbol → displaceable
  ];
  const high = namedEntry("hi", "pkg/high.py");
  const medium = namedEntry("med", "pkg/medium.py");
  const order = orderSupportWithCoedit({
    baseOrder: winners,
    coeditEntries: [high, medium],
    rescuedSymbolIds: new Set(),
    spareOnlySymbolIds: new Set(["med"]),
    pivotFilePaths: new Set(["pkg/pivot.py"]),
    maxSupport: 2,
    isProtectedTier: () => true,
  });
  // High displaces the duplicate; medium ranks behind EVERY winner, so with 2
  // slots it can only render when a slot is genuinely spare.
  assert.deepEqual(
    order.ordered.map((e) => e.candidate.symbolId),
    ["s1", "hi", "dup", "med"],
  );
});

test("co-edit expansion is deterministic", () => {
  const fx = seedLaneFixture();
  linkAll(fx.db, [
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.Calls, "a"],
    [fx.ids["anchor_func"]!, fx.ids["build_annotation"]!, EdgeType.References, "b"],
  ]);
  const build = () => expandCoeditSupport(laneInput({ db: fx.db, pivotEntries: [anchorPivot(fx)] }));
  const first = build();
  const second = build();
  assert.deepEqual(
    JSON.parse(JSON.stringify(first.candidates)),
    JSON.parse(JSON.stringify(second.candidates)),
  );
  fx.db.close();
});
