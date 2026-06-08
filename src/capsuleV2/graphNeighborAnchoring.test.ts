// Tests for bounded test/import graph-neighbour expansion.
//
// Two layers: pure-predicate unit tests (seed eligibility, neighbour eligibility,
// vendored/generic filters) and full-pipeline integration tests on a fixture with
// real edges (a production neighbour enters the pool, depth-1 / cap bounds hold,
// hubs and non-source neighbours are skipped, and explicit anchors still out-rank).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { buildCapsuleV2 } from "./buildCapsuleV2";
import {
  anchorGraphNeighbors,
  isSeedEligible,
  isVendoredOrGenerated,
  isGenericInfraFile,
  type GraphNeighborInput,
} from "./graphNeighborAnchoring";
import { CapsuleIntent } from "./types";
import { seedCustomFixture, seedFile } from "./__fixtures__/capsuleV2Fixture";
import { insertEdges } from "../db/repositories/edgesRepository";
import { EdgeType, SymbolKind, type EdgeRecord } from "../domain/types";
import { HybridCandidateSource, type HybridCandidate } from "../retrieval/hybridRetrieval";

// --- helpers ------------------------------------------------------------------

const EMPTY_IDS = {
  anchorSymbolIds: new Set<string>(),
  titleSymbolIds: new Set<string>(),
  literalAnchorIds: new Set<string>(),
  suppressedDecoyIds: new Set<string>(),
};

function candidate(over: Partial<HybridCandidate> & { scores?: Partial<HybridCandidate["scores"]> } = {}): HybridCandidate {
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

function edge(src: string, dst: string, type: EdgeType): EdgeRecord {
  return {
    id: createHash("sha256").update([src, dst, type].join("\0")).digest("hex"),
    srcSymbolId: src,
    dstSymbolId: dst,
    edgeType: type,
    confidence: 1,
  };
}

function seeds(over: Partial<GraphNeighborInput>): GraphNeighborInput {
  return {
    db: over.db as Database,
    task: over.task ?? "the bug",
    candidates: over.candidates ?? [],
    anchorSymbolIds: over.anchorSymbolIds ?? new Set(),
    titleSymbolIds: over.titleSymbolIds ?? new Set(),
    literalAnchorIds: over.literalAnchorIds ?? new Set(),
    suppressedDecoyIds: over.suppressedDecoyIds ?? new Set(),
  };
}

// --- pure: seed eligibility ----------------------------------------------------

test("isSeedEligible: a strong-lexical actionable source candidate is a seed", () => {
  const c = candidate({ scores: { lexical: 0.8 } });
  assert.equal(isSeedEligible(c, EMPTY_IDS, false), true);
});

test("isSeedEligible: a title/literal/line anchor is a seed even on weak lexical", () => {
  const c = candidate({ symbolId: "anchored", scores: { lexical: 0.1 } });
  const ids = { ...EMPTY_IDS, titleSymbolIds: new Set(["anchored"]) };
  assert.equal(isSeedEligible(c, ids, false), true);
});

test("isSeedEligible: a suppressed generic lexical decoy is NEVER a seed (#4)", () => {
  const c = candidate({ symbolId: "decoy", scores: { lexical: 0.9 } });
  const ids = { ...EMPTY_IDS, suppressedDecoyIds: new Set(["decoy"]) };
  assert.equal(isSeedEligible(c, ids, false), false);
});

test("isSeedEligible: a weak generic lexical candidate is not a seed", () => {
  assert.equal(isSeedEligible(candidate({ scores: { lexical: 0.2 } }), EMPTY_IDS, false), false);
});

test("isSeedEligible: a low-actionability symbol is not a seed", () => {
  const c = candidate({ kind: SymbolKind.ModuleVariable, scores: { lexical: 0.9, actionability: 0 } });
  assert.equal(isSeedEligible(c, EMPTY_IDS, false), false);
});

test("isSeedEligible: an undirect-evidence hub is not a seed", () => {
  // Strong lexical but a high-degree hub with no symbol/path/test/body pointer.
  const c = candidate({ scores: { lexical: 0.9, inDegree: 20 } });
  assert.equal(isSeedEligible(c, EMPTY_IDS, false), false);
  // With a direct symbol pointer, the same hub IS a trustworthy seed.
  assert.equal(isSeedEligible(candidate({ scores: { lexical: 0.9, inDegree: 20, symbol: 1 } }), EMPTY_IDS, false), true);
});

test("isSeedEligible: a non-source seed is skipped unless the task allows it", () => {
  const c = candidate({ filePath: "examples/demo.py", scores: { lexical: 0.9 } });
  assert.equal(isSeedEligible(c, EMPTY_IDS, false), false);
  assert.equal(isSeedEligible(c, EMPTY_IDS, true), true);
});

// --- pure: neighbour filters ---------------------------------------------------

test("isVendoredOrGenerated flags vendored/third-party/generated trees", () => {
  assert.equal(isVendoredOrGenerated("astropy/extern/configobj/configobj.py"), true);
  assert.equal(isVendoredOrGenerated("pkg/_vendor/six.py"), true);
  assert.equal(isVendoredOrGenerated("pkg/parser/parsetab.py"), true);
  assert.equal(isVendoredOrGenerated("pkg/grpc/service_pb2.py"), true);
  assert.equal(isVendoredOrGenerated("pkg/real/module.py"), false);
});

test("isGenericInfraFile flags giant generic neighbours, not real domain files", () => {
  assert.equal(isGenericInfraFile("pkg/utils.py"), true);
  assert.equal(isGenericInfraFile("pkg/base.py"), true);
  assert.equal(isGenericInfraFile("pkg/exceptions.py"), true);
  assert.equal(isGenericInfraFile("lib/matplotlib/_api/deprecation.py"), true);
  assert.equal(isGenericInfraFile("pkg/colors.py"), false);
  assert.equal(isGenericInfraFile("pkg/base_user.py"), false); // `user` is not generic
});

// --- integration ---------------------------------------------------------------

// A strong-lexical seed that calls a hidden production function whose name the task
// never mentions: the neighbour should enter the pool via the call edge (#1, #7).
test("a production neighbour of a high-confidence seed enters the pool with edge evidence", () => {
  const { db, repoRoot } = seedCustomFixture([]);
  try {
    const handler = seedFile(db, repoRoot, "pkg/handler.py", [
      { localName: "handle_request", kind: SymbolKind.Function, signature: "handle_request(req)", body: "def handle_request(req):\n    return normalize_units(req)" },
    ]);
    const units = seedFile(db, repoRoot, "pkg/units.py", [
      { localName: "normalize_units", kind: SymbolKind.Function, signature: "normalize_units(x)", body: "def normalize_units(x):\n    return x" },
    ]);
    insertEdges(db, [edge(handler.handle_request!, units.normalize_units!, EdgeType.Calls)]);

    // Task names ONLY handle_request (strong-lexical seed); "normalize_units" is unsaid.
    const result = buildCapsuleV2({ db, repoRoot, task: "handle_request raises on bad input.", intent: CapsuleIntent.Auto, maxTokens: 8_000 });

    const matches = result.diagnostics.graph_neighbor_matches ?? [];
    assert.equal(result.diagnostics.graph_neighbor_expansion_used, true);
    const m = matches.find((x) => x.neighbor_path === "pkg/units.py");
    assert.ok(m, `expected units.py as a graph neighbour, got ${JSON.stringify(matches)}`);
    assert.equal(m!.seed_path, "pkg/handler.py");
    assert.equal(m!.seed_symbol, "handle_request");
    assert.equal(m!.edge, "calls");
    // It entered the capsule as SUPPORT (never a pivot — no direct evidence).
    assert.ok(result.support.some((s) => s.path === "pkg/units.py"), "neighbour should render as support");
    assert.ok(!result.pivots.some((p) => p.path === "pkg/units.py"), "neighbour must not be a pivot");
  } finally {
    db.close();
  }
});

// A 2-hop chain: only the depth-1 neighbour is surfaced (#2).
test("expansion is depth-1 bounded", () => {
  const { db, repoRoot } = seedCustomFixture([]);
  try {
    const a = seedFile(db, repoRoot, "pkg/handler.py", [
      { localName: "handle_request", kind: SymbolKind.Function, body: "def handle_request():\n    return mid()" },
    ]);
    const b = seedFile(db, repoRoot, "pkg/mid.py", [
      { localName: "mid_layer", kind: SymbolKind.Function, body: "def mid_layer():\n    return deep()" },
    ]);
    const c = seedFile(db, repoRoot, "pkg/deep.py", [
      { localName: "deep_layer", kind: SymbolKind.Function, body: "def deep_layer():\n    return 1" },
    ]);
    insertEdges(db, [
      edge(a.handle_request!, b.mid_layer!, EdgeType.Calls),
      edge(b.mid_layer!, c.deep_layer!, EdgeType.Calls),
    ]);
    const result = buildCapsuleV2({ db, repoRoot, task: "handle_request raises on bad input.", intent: CapsuleIntent.Auto, maxTokens: 8_000 });
    const paths = (result.diagnostics.graph_neighbor_matches ?? []).map((m) => m.neighbor_path);
    assert.ok(paths.includes("pkg/mid.py"), "depth-1 neighbour expected");
    assert.ok(!paths.includes("pkg/deep.py"), "depth-2 neighbour must NOT be expanded");
  } finally {
    db.close();
  }
});

// One seed with many production callees: the per-seed cap bounds how many enter (#3).
test("expansion respects the per-seed neighbour cap", () => {
  const { db, repoRoot } = seedCustomFixture([]);
  try {
    const a = seedFile(db, repoRoot, "pkg/handler.py", [
      { localName: "handle_request", kind: SymbolKind.Function, body: "def handle_request():\n    return 1" },
    ]);
    const edges: EdgeRecord[] = [];
    for (let i = 0; i < 9; i += 1) {
      const f = seedFile(db, repoRoot, `pkg/callee_${i}.py`, [
        { localName: `callee_${i}`, kind: SymbolKind.Function, body: `def callee_${i}():\n    return ${i}` },
      ]);
      edges.push(edge(a.handle_request!, f[`callee_${i}`]!, EdgeType.Calls));
    }
    insertEdges(db, edges);
    const result = buildCapsuleV2({ db, repoRoot, task: "handle_request raises on bad input.", intent: CapsuleIntent.Auto, maxTokens: 20_000 });
    const matches = result.diagnostics.graph_neighbor_matches ?? [];
    // MAX_NEIGHBORS_PER_SEED = 4 — a single seed cannot flood the pool.
    assert.ok(matches.length <= 4, `per-seed cap should bound neighbours, got ${matches.length}`);
    assert.ok(matches.length >= 1, "at least one neighbour expected");
  } finally {
    db.close();
  }
});

// A neighbour that 5+ other symbols depend on is a hub and is skipped (#6).
test("high-degree hub neighbours are skipped", () => {
  const { db, repoRoot } = seedCustomFixture([]);
  try {
    const a = seedFile(db, repoRoot, "pkg/handler.py", [
      { localName: "handle_request", kind: SymbolKind.Function, body: "def handle_request():\n    return hub()" },
    ]);
    const hub = seedFile(db, repoRoot, "pkg/hubmod.py", [
      { localName: "hub_target", kind: SymbolKind.Function, body: "def hub_target():\n    return 1" },
    ]);
    const edges: EdgeRecord[] = [edge(a.handle_request!, hub.hub_target!, EdgeType.Calls)];
    // Six unrelated symbols depend on hub_target → in-degree 6 (>= threshold 5).
    for (let i = 0; i < 6; i += 1) {
      const dep = seedFile(db, repoRoot, `pkg/dep_${i}.py`, [
        { localName: `dep_${i}`, kind: SymbolKind.Function, body: `def dep_${i}():\n    return 1` },
      ]);
      edges.push(edge(dep[`dep_${i}`]!, hub.hub_target!, EdgeType.References));
    }
    insertEdges(db, edges);
    const result = buildCapsuleV2({ db, repoRoot, task: "handle_request raises on bad input.", intent: CapsuleIntent.Auto, maxTokens: 8_000 });
    const paths = (result.diagnostics.graph_neighbor_matches ?? []).map((m) => m.neighbor_path);
    assert.ok(!paths.includes("pkg/hubmod.py"), "a high-degree hub neighbour must be skipped");
  } finally {
    db.close();
  }
});

// A non-source neighbour is not promoted unless the task allows docs/examples (#5).
test("a non-source example neighbour is not promoted", () => {
  const { db, repoRoot } = seedCustomFixture([]);
  try {
    const a = seedFile(db, repoRoot, "pkg/handler.py", [
      { localName: "handle_request", kind: SymbolKind.Function, body: "def handle_request():\n    return demo()" },
    ]);
    const demo = seedFile(db, repoRoot, "examples/demo.py", [
      { localName: "demo_helper", kind: SymbolKind.Function, body: "def demo_helper():\n    return 1" },
    ]);
    insertEdges(db, [edge(a.handle_request!, demo.demo_helper!, EdgeType.Calls)]);
    const result = buildCapsuleV2({ db, repoRoot, task: "handle_request raises on bad input.", intent: CapsuleIntent.Auto, maxTokens: 8_000 });
    const paths = (result.diagnostics.graph_neighbor_matches ?? []).map((m) => m.neighbor_path);
    assert.ok(!paths.includes("examples/demo.py"), "a non-source neighbour must not be expanded");
  } finally {
    db.close();
  }
});

// A neighbour MISSING from the pool is injected as a fresh support-strength
// candidate (the inject path, isolated from the full pipeline's other recovery
// mechanisms). The seed is supplied as a high-confidence anchor; the callee is not
// in the pool, so the generator both reports AND injects it.
test("a neighbour missing from the pool is injected as a support-strength candidate", () => {
  const { db, repoRoot } = seedCustomFixture([]);
  try {
    const core = seedFile(db, repoRoot, "pkg/core.py", [
      { localName: "obscure_entry", kind: SymbolKind.Function, signature: "obscure_entry()", body: "def obscure_entry():\n    return hidden_impl()" },
    ]);
    const helper = seedFile(db, repoRoot, "pkg/hidden.py", [
      { localName: "hidden_impl", kind: SymbolKind.Function, signature: "hidden_impl()", body: "def hidden_impl():\n    return 1" },
    ]);
    insertEdges(db, [edge(core.obscure_entry!, helper.hidden_impl!, EdgeType.Calls)]);

    // Pool holds ONLY the seed (a line anchor); hidden_impl is absent.
    const seedCandidate = candidate({ symbolId: core.obscure_entry!, filePath: "pkg/core.py", localName: "obscure_entry", scores: { symbol: 1, path: 1, lexical: 1 } });
    const result = anchorGraphNeighbors(seeds({
      db,
      task: "Crash originates at pkg/core.py#L1.",
      candidates: [seedCandidate],
      anchorSymbolIds: new Set([core.obscure_entry!]),
    }));

    assert.equal(result.used, true);
    const m = result.matches.find((x) => x.neighborPath === "pkg/hidden.py");
    assert.ok(m, `expected hidden.py neighbour, got ${JSON.stringify(result.matches)}`);
    assert.equal(m!.edge, "calls");
    // It was MISSING from the pool, so it is injected as a fresh candidate...
    const injected = result.candidates.find((c) => c.filePath === "pkg/hidden.py");
    assert.ok(injected, "missing neighbour should be injected as a candidate");
    // ...at support strength: graph proximity but NO direct evidence (never a pivot).
    assert.equal(injected!.scores.symbol, 0);
    assert.equal(injected!.scores.path, 0);
    assert.equal(injected!.scores.testToImpl, 0);
    assert.ok(injected!.scores.graph > 0, "neighbour carries graph proximity");
  } finally {
    db.close();
  }
});

// An explicit title-symbol pivot still leads; the graph neighbour is only support (#8).
test("explicit title-symbol anchor still out-ranks a graph neighbour", () => {
  const { db, repoRoot } = seedCustomFixture([]);
  try {
    // Title names PaymentProcessor (a class) → title-symbol pivot; it calls a hidden helper.
    const proc = seedFile(db, repoRoot, "pkg/payment.py", [
      { localName: "PaymentProcessor", kind: SymbolKind.Class, body: "class PaymentProcessor:\n    def run(self):\n        return settle_ledger()" },
    ]);
    const ledger = seedFile(db, repoRoot, "pkg/ledger.py", [
      { localName: "settle_ledger", kind: SymbolKind.Function, body: "def settle_ledger():\n    return 1" },
    ]);
    insertEdges(db, [edge(proc.PaymentProcessor!, ledger.settle_ledger!, EdgeType.Calls)]);
    const result = buildCapsuleV2({ db, repoRoot, task: "PaymentProcessor drops the rounding.", intent: CapsuleIntent.Auto, maxTokens: 8_000 });
    // The title symbol leads the pivots; the neighbour is support, never ahead of it.
    assert.equal(result.pivots[0]?.symbol, "PaymentProcessor");
    assert.ok(!result.pivots.some((p) => p.path === "pkg/ledger.py"), "graph neighbour must not be a pivot");
  } finally {
    db.close();
  }
});
