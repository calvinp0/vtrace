// M140-C acceptance: path-coherent orchestration delivery.
//
// The selector is a SELECTION rule, not a ranking rule, so these cases are about
// which bounded set of evidence answers a request coherently — never about making
// a weak candidate look strong. Two properties are load-bearing and asserted
// repeatedly: at most one item per request, and the item's ordinary rank/score
// are reported exactly as retrieval computed them.
//
// The negative controls carry as much weight as the positive cases. A role that
// fired on every process question would drag one arbitrary caller into every
// answer, which is a worse failure than the one it fixes.

import assert from "node:assert/strict";
import { test } from "bun:test";

import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { SymbolKind } from "../domain/types";
import type { HybridCandidate, OrchestrationPathCandidate } from "../retrieval/hybridRetrieval";
import { HybridCandidateSource } from "../retrieval/hybridRetrieval";
import { deriveQueryIntent, evaluateOrchestrationIntent } from "../retrieval/querySemantics";
import { rescueUpstreamCandidates } from "../retrieval/upstreamRescue";
import {
  CONDITIONAL_BRANCH_FIXTURE,
  CONDITIONAL_BRANCH_QUERY,
  HIGH_FAN_IN_QUERY,
  HIGH_FAN_IN_SEED,
  ORCHESTRATION_CHAIN_FIXTURE,
  ORCHESTRATION_CHAIN_QUERY,
  highFanInFixture,
  seedRescueFixture,
  type RescueFixtureSpec,
} from "../retrieval/upstreamRescueFixture";
import {
  PATH_COMPLETION_DEFAULTS,
  selectPathCompletion,
  type PathCompletionInput,
  type PathCompletionResult,
} from "./pathCompletion";

/**
 * Build the selector's input from the REAL rescue lane over a fixture.
 *
 * Driving the lane directly rather than through the capsule is the same
 * compromise M140-B documented: the lexical pool holds 100 candidates, so in a
 * ten-symbol fixture every symbol is already retrieved and there is by definition
 * nothing left to rescue. What the fixture CAN provide truthfully is the graph —
 * real `calls` edges, real depths, real paths, real query relevance — and that is
 * exactly what the selector consumes. Genuine end-to-end delivery is proven on a
 * real index by the ARC acceptance.
 *
 * `ordinaryRank`/`ordinaryScore` are stamped low on purpose: the whole premise is
 * that these candidates lose the ordinary ranking.
 */
function pathsFrom(
  spec: RescueFixtureSpec,
  query: string,
  seedFqNames: readonly string[],
): OrchestrationPathCandidate[] {
  const db: Database = openIndexerDatabase(":memory:");
  try {
    const ids = seedRescueFixture(db, spec);
    const seeds = seedFqNames.map((fqName, index) => {
      const symbolId = ids.get(fqName);
      if (symbolId === undefined) {
        throw new Error(`fixture: unknown seed ${fqName}`);
      }
      return { symbolId, fqName, rank: index + 1, final: 2 - index * 0.01, reason: "test seed" };
    });
    const result = rescueUpstreamCandidates({
      db,
      seeds,
      intent: deriveQueryIntent(query),
      existingSymbolIds: new Set(seeds.map((seed) => seed.symbolId)),
    });
    return result.candidates.map((rescued, index) => ({
      candidate: candidateOf(rescued.symbol.id, rescued.symbol.fqName, rescued.symbol.kind),
      ordinaryRank: 80 + index,
      ordinaryScore: 0.9 - index * 0.01,
      withinPool: false,
      depth: rescued.depth,
      path: rescued.path,
      seedFqNames: rescued.seedFqNames,
      relevance: rescued.relevance,
      rescueScore: rescued.rescueScore,
      matchedTerms: rescued.matchedTerms,
      reason: rescued.reason,
    }));
  } finally {
    db.close();
  }
}

function candidateOf(symbolId: string, fqName: string, kind: SymbolKind): HybridCandidate {
  return {
    symbolId,
    filePath: fqName.split("::")[0] ?? fqName,
    fqName,
    localName: fqName.split("::").pop() ?? fqName,
    kind,
    scores: {
      lexical: 0, fts: 0, tfidf: 0, bm25: 0, symbol: 0, path: 0, testToImpl: 0, bodyLiteral: 0, domain: 0,
      graph: 0, graphProximity: 0, centrality: 0, actionability: 0, inDegree: 0,
      localEvidence: 0, hubPenalty: 0, actionabilityPenalty: 0, final: 0.9,
    },
    sources: [HybridCandidateSource.UpstreamRescue],
    evidence: ["rescued upstream caller"],
    matches: [],
  };
}

/** A hand-built path candidate, for the cases a fixture cannot express. */
function syntheticPath(overrides: Partial<OrchestrationPathCandidate> & {
  fqName: string;
  path: readonly string[];
}): OrchestrationPathCandidate {
  const { fqName, path, ...rest } = overrides;
  return {
    candidate: candidateOf(`id:${fqName}`, fqName, SymbolKind.Function),
    ordinaryRank: 90,
    ordinaryScore: 0.9,
    withinPool: false,
    depth: path.length - 1,
    path,
    seedFqNames: [path[path.length - 1] ?? ""],
    relevance: 0.8,
    rescueScore: 0.5,
    matchedTerms: ["alpha", "beta", "gamma"],
    reason: "rescued upstream caller",
    ...rest,
  };
}

function select(
  paths: readonly OrchestrationPathCandidate[],
  selected: readonly string[],
  overrides: Partial<PathCompletionInput> = {},
): PathCompletionResult {
  return selectPathCompletion({
    orchestrationPaths: paths,
    orchestrationIntentActive: true,
    selectedFqNames: new Set(selected),
    supportSlots: 4,
    hasBranchClause: false,
    ...overrides,
  });
}

const byName = (paths: readonly OrchestrationPathCandidate[], suffix: string): OrchestrationPathCandidate => {
  const found = paths.find((entry) => entry.candidate.fqName.endsWith(suffix));
  assert.ok(found !== undefined, `no rescued candidate ending in ${suffix}: ${paths.map((p) => p.candidate.fqName).join(", ")}`);
  return found;
};

// ---------------------------------------------------------------------------
// Positive cases

test("completes a generic one-chain reconstruction path (§26)", () => {
  const paths = pathsFrom(
    ORCHESTRATION_CHAIN_FIXTURE,
    ORCHESTRATION_CHAIN_QUERY,
    ["app/parser.py::parse_raw_data"],
  );
  // `rebuild_model` is the intermediate and is assumed already delivered;
  // `deserialize` is the entry point two hops up that ordinary ranking loses.
  const result = select(paths, [
    "app/parser.py::parse_raw_data",
    "app/loader.py::rebuild_model",
  ]);
  assert.equal(result.selection?.candidate.fqName, "app/loader.py::deserialize");
  assert.equal(result.selection?.coverageRole, "orchestration_entry");
  assert.equal(result.selection?.depth, 2);
  assert.deepEqual([...(result.selection?.path ?? [])], [
    "app/loader.py::deserialize",
    "app/loader.py::rebuild_model",
    "app/parser.py::parse_raw_data",
  ]);
});

test("the completed entry point keeps the ordinary rank it earned (§10/§19)", () => {
  const paths = pathsFrom(
    ORCHESTRATION_CHAIN_FIXTURE,
    ORCHESTRATION_CHAIN_QUERY,
    ["app/parser.py::parse_raw_data"],
  );
  const entry = byName(paths, "::deserialize");
  const result = select(paths, ["app/parser.py::parse_raw_data", "app/loader.py::rebuild_model"]);
  // The point of the milestone: selection changed, ranking did not.
  assert.equal(result.selection?.ordinaryRank, entry.ordinaryRank);
  assert.equal(result.selection?.ordinaryScore, entry.ordinaryScore);
  assert.match(result.selection?.selectionReason ?? "", /ordinary rank \d+ .*is unchanged/u);
});

test("selects the controller of two delivered branches (§27)", () => {
  const paths = pathsFrom(
    CONDITIONAL_BRANCH_FIXTURE,
    CONDITIONAL_BRANCH_QUERY,
    ["app/state.py::use_cached", "app/state.py::regenerate"],
  );
  const result = select(
    paths,
    ["app/state.py::use_cached", "app/state.py::regenerate"],
    { hasBranchClause: true },
  );
  assert.equal(result.selection?.candidate.fqName, "app/state.py::load_state");
  assert.equal(result.selection?.coverageRole, "branch_controller");
  assert.equal(result.selection?.depth, 1);
});

test("a branch question with only one delivered alternative is not a controller (§23)", () => {
  const paths = pathsFrom(
    CONDITIONAL_BRANCH_FIXTURE,
    CONDITIONAL_BRANCH_QUERY,
    ["app/state.py::use_cached", "app/state.py::regenerate"],
  );
  // Only one branch on screen: calling it is not evidence of choosing between
  // alternatives, it is ordinary caller-of.
  const result = select(paths, ["app/state.py::use_cached"], { hasBranchClause: true });
  assert.equal(result.selection, undefined);
  assert.ok(result.diagnostics.rejectedNoCoherentPath >= 1);
});

// ---------------------------------------------------------------------------
// Coherence: the completed path must already be on screen

test("an undelivered intermediate blocks completion (§34/§35)", () => {
  const paths = pathsFrom(
    ORCHESTRATION_CHAIN_FIXTURE,
    ORCHESTRATION_CHAIN_QUERY,
    ["app/parser.py::parse_raw_data"],
  );
  // Without `rebuild_model` delivered, admitting `deserialize` would hand the
  // reader a chain with its middle link missing.
  const result = select(paths, ["app/parser.py::parse_raw_data"]);
  assert.equal(result.selection, undefined);
  const trace = result.diagnostics.candidates.find((entry) => entry.fqName.endsWith("::deserialize"));
  assert.match(trace?.rejectedBy ?? "", /downstream path nodes selected/u);
});

test("one more caller of a delivered symbol is not path completion (§34)", () => {
  const result = select(
    [syntheticPath({ fqName: "app/x.py::some_caller", path: ["app/x.py::some_caller", "app/y.py::seed"] })],
    ["app/y.py::seed"],
  );
  assert.equal(result.selection, undefined);
  assert.equal(result.diagnostics.rejectedNoCoherentPath, 1);
});

test("a candidate already delivered on its own evidence is not re-selected", () => {
  const result = select(
    [syntheticPath({ fqName: "app/x.py::head", path: ["app/x.py::head", "app/y.py::mid", "app/y.py::seed"] })],
    ["app/x.py::head", "app/y.py::mid", "app/y.py::seed"],
  );
  assert.equal(result.selection, undefined);
  assert.equal(result.diagnostics.rejectedAlreadySelected, 1);
});

// ---------------------------------------------------------------------------
// Negative controls

test("no orchestration intent means no path completion (§28/§29/§30)", () => {
  for (const query of [
    "find parse_raw_data",
    "where is load_state?",
    "a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices",
    "who calls parse_raw_data?",
  ]) {
    const verdict = evaluateOrchestrationIntent(deriveQueryIntent(query));
    assert.equal(verdict.active, false, `expected no orchestration intent for: ${query}`);
    // The capsule passes the lane's own verdict through, so an inactive gate
    // means the selector is never even offered a candidate.
    const result = select(
      [syntheticPath({ fqName: "app/x.py::head", path: ["app/x.py::head", "app/y.py::mid", "app/y.py::seed"] })],
      ["app/y.py::mid", "app/y.py::seed"],
      { orchestrationIntentActive: false, orchestrationIntentReason: verdict.suppressedBy ?? "" },
    );
    assert.equal(result.selection, undefined);
    assert.equal(result.diagnostics.eligibleRequest, false);
    assert.equal(result.diagnostics.rejectedNoIntent, 1);
  }
});

test("a high-fan-in helper yields no arbitrary path completion (§32)", () => {
  const spec = highFanInFixture(1_000);
  const paths = pathsFrom(spec, HIGH_FAN_IN_QUERY, [HIGH_FAN_IN_SEED]);
  // The lane admits at most three callers; none of them is a chain head, so the
  // slot stays unused however many callers the helper has.
  assert.ok(paths.length <= 3, `expected <= 3 rescued, got ${paths.length}`);
  const result = select(paths, [HIGH_FAN_IN_SEED]);
  assert.equal(result.selection, undefined);
  assert.equal(result.diagnostics.eligibleCandidates, 0);
});

test("a structural module symbol can never be path-completed (§45)", () => {
  const structural = syntheticPath({
    fqName: "app/y.py::<module>",
    path: ["app/y.py::<module>", "app/y.py::mid", "app/y.py::seed"],
  });
  const result = select(
    [{ ...structural, candidate: { ...structural.candidate, kind: SymbolKind.Module } }],
    ["app/y.py::mid", "app/y.py::seed"],
  );
  assert.equal(result.selection, undefined);
  assert.equal(result.diagnostics.rejectedStructural, 1);
});

test("graph position alone does not clear the relevance floor (§25/§38)", () => {
  const weak = syntheticPath({
    fqName: "app/x.py::head",
    path: ["app/x.py::head", "app/y.py::mid", "app/y.py::seed"],
    relevance: 0.05,
    matchedTerms: ["alpha"],
  });
  const result = select([weak], ["app/y.py::mid", "app/y.py::seed"]);
  assert.equal(result.selection, undefined);
  assert.equal(result.diagnostics.rejectedWeakRelevance, 1);
});

test("depth beyond the lane's bound is refused (§16)", () => {
  const deep = syntheticPath({
    fqName: "app/x.py::head",
    path: ["app/x.py::head", "app/y.py::a", "app/y.py::b", "app/y.py::seed"],
  });
  const result = select([deep], ["app/y.py::a", "app/y.py::b", "app/y.py::seed"]);
  assert.equal(result.selection, undefined);
  assert.equal(result.diagnostics.rejectedDepth, 1);
});

// ---------------------------------------------------------------------------
// Bounds and determinism

test("at most one item is ever path-completed (§17/§55)", () => {
  const paths = [
    syntheticPath({ fqName: "app/a.py::head_a", path: ["app/a.py::head_a", "app/y.py::mid", "app/y.py::seed"] }),
    syntheticPath({ fqName: "app/b.py::head_b", path: ["app/b.py::head_b", "app/y.py::mid", "app/y.py::seed"] }),
    syntheticPath({ fqName: "app/c.py::head_c", path: ["app/c.py::head_c", "app/y.py::mid", "app/y.py::seed"] }),
  ];
  const result = select(paths, ["app/y.py::mid", "app/y.py::seed"]);
  assert.equal(PATH_COMPLETION_DEFAULTS.maxPathCompletionItems, 1);
  assert.equal(result.diagnostics.selectedCount, 1);
  assert.equal(result.diagnostics.eligibleCandidates, 3);
  assert.equal(result.diagnostics.rejectedSlotTaken, 2);
});

test("equally path-valid entry points resolve by request relevance, then by name (§33/§80)", () => {
  const base = { path: ["", "app/y.py::mid", "app/y.py::seed"] as const };
  const build = (name: string, matched: string[], score: number) =>
    syntheticPath({
      fqName: name,
      path: [name, ...base.path.slice(1)],
      matchedTerms: matched,
      ordinaryScore: score,
    });
  // entry_b answers strictly more of the request; it wins despite sorting later.
  const relevanceWins = select(
    [build("app/a.py::entry_a", ["alpha", "beta"], 0.9), build("app/b.py::entry_b", ["alpha", "beta", "gamma"], 0.9)],
    ["app/y.py::mid", "app/y.py::seed"],
  );
  assert.equal(relevanceWins.selection?.candidate.fqName, "app/b.py::entry_b");

  // Fully symmetric: the name breaks the tie, so the result cannot depend on the
  // order the graph happened to yield.
  const forward = [build("app/a.py::entry_a", ["alpha", "beta"], 0.9), build("app/b.py::entry_b", ["alpha", "beta"], 0.9)];
  assert.equal(select(forward, ["app/y.py::mid", "app/y.py::seed"]).selection?.candidate.fqName, "app/a.py::entry_a");
  assert.equal(
    select([...forward].reverse(), ["app/y.py::mid", "app/y.py::seed"]).selection?.candidate.fqName,
    "app/a.py::entry_a",
  );
});

test("a chain head outranks a branch controller on the same request (§34/§35)", () => {
  const controller = syntheticPath({
    fqName: "app/a.py::controller",
    path: ["app/a.py::controller", "app/y.py::seed"],
    seedFqNames: ["app/y.py::seed", "app/y.py::other"],
    matchedTerms: ["alpha", "beta", "gamma", "delta"],
  });
  const head = syntheticPath({
    fqName: "app/b.py::head",
    path: ["app/b.py::head", "app/y.py::mid", "app/y.py::seed"],
    matchedTerms: ["alpha", "beta"],
  });
  const result = select(
    [controller, head],
    ["app/y.py::seed", "app/y.py::other", "app/y.py::mid"],
    { hasBranchClause: true },
  );
  assert.equal(result.diagnostics.eligibleCandidates, 2);
  assert.equal(result.selection?.candidate.fqName, "app/b.py::head");
});

test("a capsule with one support slot never spends it here (§57)", () => {
  const paths = [syntheticPath({ fqName: "app/x.py::head", path: ["app/x.py::head", "app/y.py::mid", "app/y.py::seed"] })];
  const selected = ["app/y.py::mid", "app/y.py::seed"];
  assert.equal(select(paths, selected, { supportSlots: 1 }).selection, undefined);
  assert.equal(select(paths, selected, { supportSlots: 0 }).selection, undefined);
  // Budget monotonicity (§58): more room never makes the chain less complete.
  assert.ok(select(paths, selected, { supportSlots: 2 }).selection !== undefined);
  assert.ok(select(paths, selected, { supportSlots: 8 }).selection !== undefined);
});

test("the role can be switched off entirely", () => {
  const paths = [syntheticPath({ fqName: "app/x.py::head", path: ["app/x.py::head", "app/y.py::mid", "app/y.py::seed"] })];
  const result = select(paths, ["app/y.py::mid", "app/y.py::seed"], {
    options: { maxPathCompletionItems: 0 },
  });
  assert.equal(result.selection, undefined);
  assert.equal(result.diagnostics.eligibleRequest, false);
});

test("selection is a pure function of its inputs", () => {
  const paths = pathsFrom(
    ORCHESTRATION_CHAIN_FIXTURE,
    ORCHESTRATION_CHAIN_QUERY,
    ["app/parser.py::parse_raw_data"],
  );
  const selected = ["app/parser.py::parse_raw_data", "app/loader.py::rebuild_model"];
  const first = select(paths, selected);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(select(paths, selected).selection?.candidate.fqName, first.selection?.candidate.fqName);
  }
});

test("every discovered candidate is accounted for in diagnostics (§53)", () => {
  const paths = [
    syntheticPath({ fqName: "app/a.py::head", path: ["app/a.py::head", "app/y.py::mid", "app/y.py::seed"] }),
    syntheticPath({ fqName: "app/b.py::caller", path: ["app/b.py::caller", "app/y.py::seed"] }),
    syntheticPath({ fqName: "app/c.py::weak", path: ["app/c.py::weak", "app/y.py::mid", "app/y.py::seed"], relevance: 0 }),
  ];
  const result = select(paths, ["app/y.py::mid", "app/y.py::seed"]);
  assert.equal(result.diagnostics.discoveredCandidates, 3);
  assert.equal(result.diagnostics.candidates.length, 3);
  const rejected = result.diagnostics.candidates.filter((entry) => !entry.eligible);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((entry) => (entry.rejectedBy ?? "").length > 0));
  assert.equal(result.diagnostics.candidates.filter((entry) => entry.selected).length, 1);
});
