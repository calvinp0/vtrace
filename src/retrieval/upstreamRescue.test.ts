// M140-B acceptance: bounded upstream orchestration rescue.
//
// The positive cases prove the lane recovers orchestration the query describes
// but does not name. The negative controls matter just as much: a lane that
// recovers callers for every request would trade one failure mode (missing
// orchestration) for a worse one (every popular helper dragging its callers into
// the answer).

import assert from "node:assert/strict";
import { test } from "bun:test";

import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import { SymbolKind } from "../domain/types";
import { hybridRetrieve, HybridCandidateSource, type HybridRetrievalResult } from "./hybridRetrieval";
import { deriveQueryIntent, evaluateOrchestrationIntent } from "./querySemantics";
import {
  rescueUpstreamCandidates,
  selectUpstreamRescueSeeds,
  UPSTREAM_RESCUE_DEFAULTS,
  type UpstreamRescueOptions,
  type UpstreamRescueResult,
} from "./upstreamRescue";
import {
  CONDITIONAL_BRANCH_FIXTURE,
  CONDITIONAL_BRANCH_QUERY,
  CYCLE_FIXTURE,
  CYCLE_QUERY,
  DEEP_CHAIN_QUERY,
  HIGH_FAN_IN_QUERY,
  HIGH_FAN_IN_SEED,
  MULTI_SEED_FIXTURE,
  MULTI_SEED_QUERY,
  ONE_HOP_QUERY,
  ORCHESTRATION_CHAIN_FIXTURE,
  ORCHESTRATION_CHAIN_QUERY,
  TWO_HOP_FIXTURE,
  TWO_HOP_QUERY,
  commonNameFixture,
  deepChainFixture,
  highFanInFixture,
  seedRescueFixture,
  type RescueFixtureSpec,
} from "./upstreamRescueFixture";

function retrieve(
  spec: RescueFixtureSpec,
  query: string,
  options: { rescue?: boolean; maxResults?: number; lexicalPoolSize?: number } = {},
): HybridRetrievalResult {
  const db: Database = openIndexerDatabase(":memory:");
  try {
    seedRescueFixture(db, spec);
    const shaped = shapeSweQuery({ problemStatement: query, failToPass: [] });
    return hybridRetrieve(db, {
      query: shaped.query,
      shaped,
      taskText: query,
      maxResults: options.maxResults ?? 25,
      // A real repository is far larger than the lexical pool, so most symbols
      // are NOT retrieved. A fixture smaller than the pool inverts that: every
      // symbol is already a candidate and there is nothing left to rescue.
      // Narrowing the pool reproduces the selectivity rather than the size.
      ...(options.lexicalPoolSize === undefined ? {} : { lexicalPoolSize: options.lexicalPoolSize }),
      ...(options.rescue === false ? { enableUpstreamRescue: false } : {}),
    });
  } finally {
    db.close();
  }
}

/**
 * Drive the lane directly from named seeds.
 *
 * The end-to-end path cannot express the structural cases on a small fixture: the
 * lexical pool holds 100 candidates, so in a ten-symbol repository EVERY symbol
 * is already retrieved and there is by definition no upstream left to recover.
 * Scaling each fixture past that threshold would test the pool size, not the
 * traversal. These cases therefore exercise the traversal contract — depth,
 * cycles, dedupe, caps, relevance — against exactly the seeds they name, and the
 * end-to-end behaviour is covered separately by the high-fan-in fixture (where
 * the repository IS larger than the pool) and by the ARC acceptance.
 */
function rescueFrom(
  spec: RescueFixtureSpec,
  query: string,
  seedFqNames: readonly string[],
  options: UpstreamRescueOptions = {},
): UpstreamRescueResult {
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
    return rescueUpstreamCandidates({
      db,
      seeds,
      intent: deriveQueryIntent(query),
      existingSymbolIds: new Set(seeds.map((seed) => seed.symbolId)),
      options,
    });
  } finally {
    db.close();
  }
}

const rescuedNames = (result: UpstreamRescueResult): string[] =>
  result.candidates.map((candidate) => candidate.symbol.fqName);

const rescued = (result: HybridRetrievalResult): string[] =>
  result.candidates
    .filter((candidate) => candidate.sources.includes(HybridCandidateSource.UpstreamRescue))
    .map((candidate) => candidate.fqName);

const names = (result: HybridRetrievalResult): string[] =>
  result.candidates.map((candidate) => candidate.fqName);

// ---------------------------------------------------------------------------
// Intent gate

test("orchestration intent fires on process and conditional-branch questions", () => {
  for (const query of [
    "How is an object rebuilt from a serialized payload before raw data parsing?",
    "How does a species object get its graph when rebuilt from a serialized dictionary?",
    "What happens when a shard index is merged?",
    "When do we reuse cached state rather than regenerate it?",
  ]) {
    const verdict = evaluateOrchestrationIntent(deriveQueryIntent(query));
    assert.equal(verdict.active, true, `expected orchestration intent for: ${query}`);
  }
});

test("orchestration intent stays off for lookups and capability questions", () => {
  for (const query of [
    "find parse_raw_data",
    "where is ARCSpecies.from_dict?",
    "locate build_shard_index",
    "is there already a function that returns a dihedral angle?",
    "which function parses the manifest?",
  ]) {
    const verdict = evaluateOrchestrationIntent(deriveQueryIntent(query));
    assert.equal(verdict.active, false, `expected NO orchestration intent for: ${query}`);
    assert.ok(verdict.suppressedBy !== undefined, "a suppressed request must say why");
  }
});

test("a lookup verb inside a process question does not demote it to a lookup", () => {
  // Anchored lookup frames: "find" mid-sentence is not an imperative lookup.
  const verdict = evaluateOrchestrationIntent(
    deriveQueryIntent("How does the loader find the parser it should use?"),
  );
  assert.equal(verdict.active, true);
});

// ---------------------------------------------------------------------------
// Seed eligibility

test("seed selection is narrow, typed and deterministic", () => {
  const base = [
    { symbolId: "s1", fqName: "a.py::TopClass", localName: "TopClass", filePath: "a.py", kind: SymbolKind.Class, final: 2.0 },
    { symbolId: "s2", fqName: "t/test_a.py::TestA.test_thing", localName: "test_thing", filePath: "t/test_a.py", kind: SymbolKind.Method, final: 1.99 },
    { symbolId: "s3", fqName: "a.py::strong_impl", localName: "strong_impl", filePath: "a.py", kind: SymbolKind.Function, final: 1.9 },
    { symbolId: "s4", fqName: "a.py::weak_impl", localName: "weak_impl", filePath: "a.py", kind: SymbolKind.Function, final: 0.4 },
    { symbolId: "s5", fqName: "a.py::CONFIG", localName: "CONFIG", filePath: "a.py", kind: SymbolKind.ModuleVariable, final: 1.9 },
  ];
  const seeds = selectUpstreamRescueSeeds(base);
  assert.deepEqual(seeds.map((seed) => seed.fqName), ["a.py::strong_impl"]);

  // A class is not call-chain shaped, a test is the top of a chain rather than
  // orchestration within one, a module variable is not callable, and a candidate
  // far below the best score is not something to expand upward from.
  assert.deepEqual(selectUpstreamRescueSeeds(base, { maxRescueSeeds: 0 }), []);
});

test("seed count is capped", () => {
  const base = Array.from({ length: 10 }, (_, index) => ({
    symbolId: `s${index}`,
    fqName: `a.py::impl_${index}`,
    localName: `impl_${index}`,
    filePath: "a.py",
    kind: SymbolKind.Function,
    final: 2 - index * 0.01,
  }));
  assert.equal(selectUpstreamRescueSeeds(base).length, UPSTREAM_RESCUE_DEFAULTS.maxRescueSeeds);
  assert.equal(selectUpstreamRescueSeeds(base, { maxRescueSeeds: 2 }).length, 2);
});

// ---------------------------------------------------------------------------
// Positive recovery

test("§41 recovers a two-stage reconstruction chain above the matched parser", () => {
  const result = rescueFrom(
    ORCHESTRATION_CHAIN_FIXTURE,
    ORCHESTRATION_CHAIN_QUERY,
    ["app/parser.py::parse_raw_data"],
  );
  const recovered = rescuedNames(result);
  assert.ok(
    recovered.includes("app/loader.py::rebuild_model"),
    `expected rebuild_model at depth 1, got ${recovered.join(", ")}`,
  );
  assert.ok(
    recovered.includes("app/loader.py::deserialize"),
    `expected deserialize at depth 2, got ${recovered.join(", ")}`,
  );
  const depths = new Map(result.candidates.map((entry) => [entry.symbol.fqName, entry.depth]));
  assert.equal(depths.get("app/loader.py::rebuild_model"), 1);
  assert.equal(depths.get("app/loader.py::deserialize"), 2);
  // Unrelated neighbours are not callers and must not appear.
  assert.ok(!recovered.some((name) => name.startsWith("app/render.py::")));
});

test("§41 end to end: the matched implementation survives alongside the rescue", () => {
  const result = retrieve(ORCHESTRATION_CHAIN_FIXTURE, ORCHESTRATION_CHAIN_QUERY);
  assert.equal(result.upstreamRescue.activated, true);
  // §38: recovering orchestration must not displace the implementation.
  for (const required of [
    "app/parser.py::parse_raw_data",
    "app/loader.py::rebuild_model",
    "app/loader.py::deserialize",
  ]) {
    assert.ok(names(result).includes(required), `missing ${required}`);
  }
});

test("§42 recovers the branch entry point and keeps both branches positive", () => {
  const result = retrieve(CONDITIONAL_BRANCH_FIXTURE, CONDITIONAL_BRANCH_QUERY);
  const intent = deriveQueryIntent(CONDITIONAL_BRANCH_QUERY);

  assert.equal(intent.contrastKind, "alternative_branches");
  const all = names(result);
  assert.ok(all.includes("app/state.py::load_state"), `expected load_state, got ${all.join(", ")}`);

  // Neither alternative may carry a negative contrast penalty (M139).
  for (const branch of ["app/state.py::use_cached", "app/state.py::regenerate"]) {
    const candidate = result.candidates.find((entry) => entry.fqName === branch);
    if (candidate !== undefined) {
      assert.equal(candidate.scores.contrastPenalty ?? 0, 0, `${branch} must not be penalised`);
    }
  }
});

test("§44 recovers a two-hop chain, ordered depth 1 before depth 2", () => {
  const result = rescueFrom(TWO_HOP_FIXTURE, TWO_HOP_QUERY, ["app/checksum.py::verify_payload_checksum"]);
  const recovered = rescuedNames(result);
  assert.ok(recovered.includes("app/pipeline.py::middle"), `depth-1: ${recovered.join(", ")}`);
  assert.ok(recovered.includes("app/pipeline.py::entry"), `depth-2: ${recovered.join(", ")}`);
  assert.equal(result.diagnostics.maxDepthReached, 2);

  const middle = result.candidates.find((entry) => entry.symbol.fqName === "app/pipeline.py::middle");
  assert.deepEqual(middle?.path, ["app/pipeline.py::middle", "app/checksum.py::verify_payload_checksum"]);
  const entry = result.candidates.find((candidate) => candidate.symbol.fqName === "app/pipeline.py::entry");
  assert.deepEqual(entry?.path, [
    "app/pipeline.py::entry",
    "app/pipeline.py::middle",
    "app/checksum.py::verify_payload_checksum",
  ]);
});

test("§45 a single hop is recovered at depth 1 without needing depth 2", () => {
  const result = rescueFrom(
    TWO_HOP_FIXTURE,
    ONE_HOP_QUERY,
    ["app/solo.py::validate_payload_signature"],
    { maxDepth: 1 },
  );
  assert.deepEqual(rescuedNames(result), ["app/solo.py::lone_caller"]);
  assert.equal(result.diagnostics.maxDepthReached, 1);
});

test("§23 depth is clamped: no third hop is ever traversed", () => {
  const result = rescueFrom(
    TWO_HOP_FIXTURE,
    TWO_HOP_QUERY,
    ["app/checksum.py::verify_payload_checksum"],
    { maxDepth: 5 },
  );
  assert.ok(result.diagnostics.maxDepthReached <= 2, `reached depth ${result.diagnostics.maxDepthReached}`);
});

test("§47 multiple overlapping seeds dedupe to one candidate each", () => {
  const result = rescueFrom(MULTI_SEED_FIXTURE, MULTI_SEED_QUERY, [
    "app/index.py::build_shard_index",
    "app/index.py::merge_shard_index",
  ]);
  const recovered = rescuedNames(result);
  assert.equal(new Set(recovered).size, recovered.length, `duplicates: ${recovered.join(", ")}`);
  assert.ok(
    recovered.includes("app/driver.py::run_shard_maintenance"),
    `expected the shared orchestrator, got ${recovered.join(", ")}`,
  );

  // Reached from BOTH seeds, recorded once, with both seeds attributed.
  const shared = result.candidates.find(
    (entry) => entry.symbol.fqName === "app/driver.py::run_shard_maintenance",
  );
  assert.equal(shared?.seedSymbolIds.length, 2, "both seeds should be credited");
  // §26: two paths must not pay twice.
  assert.ok((shared?.rescueScore ?? 0) <= 0.95 + 1e-9);
});

// ---------------------------------------------------------------------------
// Bounding

test("§43 a 1000-caller helper does not flood the rescued set", () => {
  const result = rescueFrom(highFanInFixture(1000), HIGH_FAN_IN_QUERY, [HIGH_FAN_IN_SEED]);
  const diagnostics = result.diagnostics;
  const seed = diagnostics.perSeed[0];
  assert.ok(seed !== undefined);

  // True fan-in is reported, and the output is bounded regardless of it.
  assert.equal(seed.incomingCallersTotal, 1002);
  assert.ok(
    seed.incomingCallersExamined <= UPSTREAM_RESCUE_DEFAULTS.maxIncomingEdgesPerSeed,
    `examined ${seed.incomingCallersExamined}`,
  );
  assert.ok(
    seed.callersAdmitted <= UPSTREAM_RESCUE_DEFAULTS.maxUpstreamCandidatesPerSeed,
    `admitted ${seed.callersAdmitted}`,
  );
  // A handful of batched queries, never one per caller (§76).
  assert.ok(diagnostics.dbQueries <= 12, `dbQueries=${diagnostics.dbQueries}`);

  // §40: nothing from the unrelated tail may be rescued, at any fan-in.
  const bulk = rescuedNames(result).filter((name) => name.includes("bulk_consumer_"));
  assert.deepEqual(bulk, [], `unrelated bulk callers admitted: ${bulk.slice(0, 5).join(", ")}`);
});

test("§20 the DB-side edge cap bounds reads and is reported when it bites", () => {
  const result = rescueFrom(
    highFanInFixture(1000),
    HIGH_FAN_IN_QUERY,
    [HIGH_FAN_IN_SEED],
    { maxIncomingEdgesPerSeed: 25 },
  );
  const seed = result.diagnostics.perSeed[0];
  assert.ok(seed !== undefined);
  assert.equal(seed.incomingCallersTotal, 1002, "true fan-in is still reported");
  assert.ok(seed.incomingCallersExamined <= 25, `examined ${seed.incomingCallersExamined}`);
  assert.equal(seed.limitReached, true);
  assert.ok(result.diagnostics.limitReached.includes("maxIncomingEdgesPerSeed"));
});

test("§43 rescue cost tracks its caps, not the size of the fan-in", () => {
  const small = rescueFrom(highFanInFixture(50), HIGH_FAN_IN_QUERY, [HIGH_FAN_IN_SEED]);
  const large = rescueFrom(highFanInFixture(1000), HIGH_FAN_IN_QUERY, [HIGH_FAN_IN_SEED]);
  // 20x the callers must not mean 20x the work or 20x the output.
  assert.equal(small.diagnostics.dbQueries, large.diagnostics.dbQueries);
  assert.equal(
    small.diagnostics.rescuedCandidatesAdmitted,
    large.diagnostics.rescuedCandidatesAdmitted,
  );
  assert.ok(
    large.diagnostics.incomingEdgesExamined <= UPSTREAM_RESCUE_DEFAULTS.maxIncomingEdgesPerSeed,
  );
});

test("§43 the relevant minority is what gets rescued", () => {
  const result = rescueFrom(highFanInFixture(1000), HIGH_FAN_IN_QUERY, [HIGH_FAN_IN_SEED]);
  const recovered = rescuedNames(result);
  assert.ok(
    recovered.includes("app/queue.py::finalize_delivery"),
    `expected the relevant caller, got ${recovered.join(", ")}`,
  );
});

test("§46 a call cycle terminates without duplicates or revisiting the seed", () => {
  const result = rescueFrom(CYCLE_FIXTURE, CYCLE_QUERY, ["app/cycle.py::stage_a"], { maxDepth: 2 });
  const recovered = rescuedNames(result);
  assert.equal(new Set(recovered).size, recovered.length, "cycle produced duplicates");
  // A -> B -> C -> A: walking incoming from A reaches C then B, and must stop
  // rather than closing the loop back onto the seed.
  assert.ok(!recovered.includes("app/cycle.py::stage_a"), "the seed was re-admitted through the cycle");
  assert.ok(result.diagnostics.maxDepthReached <= 2);
});

test("rescued candidates never exceed the configured caps", () => {
  const result = retrieve(highFanInFixture(200), HIGH_FAN_IN_QUERY, { maxResults: 40 });
  assert.ok(result.upstreamRescue.rescuedCandidatesAdmitted <= UPSTREAM_RESCUE_DEFAULTS.maxUpstreamRescueCandidates);
  for (const entry of result.upstreamRescue.perSeed) {
    assert.ok(entry.callersAdmitted <= UPSTREAM_RESCUE_DEFAULTS.maxUpstreamCandidatesPerSeed);
  }
});

// ---------------------------------------------------------------------------
// Negative controls

test("§48 an explicit symbol lookup performs no rescue", () => {
  const result = retrieve(TWO_HOP_FIXTURE, "find verify_payload_checksum");
  assert.equal(result.upstreamRescue.activated, false);
  assert.deepEqual(rescued(result), []);
  // Exact lookup precision is untouched.
  assert.ok(names(result).includes("app/checksum.py::verify_payload_checksum"));
});

test("§49 a broad behaviour question keeps seed selection strict", () => {
  const result = retrieve(highFanInFixture(1000), "how does processing work?");
  // It may activate — but a request with no strongly-matched implementation has
  // nothing worth expanding upward from, so no caller tree is pulled in.
  assert.ok(
    result.upstreamRescue.rescuedCandidatesAdmitted <= UPSTREAM_RESCUE_DEFAULTS.maxUpstreamRescueCandidates,
  );
  const bulk = rescued(result).filter((name) => name.includes("bulk_consumer_"));
  assert.deepEqual(bulk, [], "a broad question rescued unrelated callers");
});

test("§50 a common helper name does not by itself trigger wide rescue", () => {
  const result = retrieve(commonNameFixture(300), "How does a value get copied?");
  const wide = rescued(result).filter((name) => name.includes("module_") && name.includes("_entry"));
  assert.deepEqual(wide, [], `common-name fan-in leaked: ${wide.slice(0, 5).join(", ")}`);

  // Driving the lane straight at the common helper must still admit nothing:
  // its callers share no vocabulary with the request.
  const forced = rescueFrom(commonNameFixture(300), "How does a value get copied?", ["app/util.py::copy"]);
  assert.deepEqual(rescuedNames(forced), []);
});

// ---------------------------------------------------------------------------
// Attribution and hygiene

test("§31 rescued candidates carry truthful, non-lexical attribution", () => {
  const result = rescueFrom(
    ORCHESTRATION_CHAIN_FIXTURE,
    ORCHESTRATION_CHAIN_QUERY,
    ["app/parser.py::parse_raw_data"],
  );
  const candidate = result.candidates.find(
    (entry) => entry.symbol.fqName === "app/loader.py::rebuild_model",
  );
  assert.ok(candidate !== undefined, "rebuild_model should be rescued");

  assert.match(candidate.reason, /^rescued upstream caller \(incoming call depth 1\) of /);
  // It names the terms it DID match, and never claims a direct/lexical answer.
  assert.match(candidate.reason, /independently matches /);
  assert.doesNotMatch(candidate.reason, /direct answer|lexical match/);
  assert.ok(candidate.matchedTerms.length >= UPSTREAM_RESCUE_DEFAULTS.minMatchedQueryTerms);
});

test("§79 any rescue score reaching a candidate is bounded and attributed", () => {
  // Whether the lane fires on a synthetic repo is not the invariant worth
  // pinning: a fixture small enough to reason about is also small enough for
  // lexical search to already hold the orchestration, so there is nothing left to
  // recover. (The genuine end-to-end recovery is the ARC acceptance, where a
  // 9,000-symbol index really does leave the chain outside the pool.) What must
  // hold everywhere is that a rescue score never exceeds its cap and never
  // arrives without its attribution.
  for (const [spec, query] of [
    [deepChainFixture(30), DEEP_CHAIN_QUERY],
    [ORCHESTRATION_CHAIN_FIXTURE, ORCHESTRATION_CHAIN_QUERY],
    [highFanInFixture(200), HIGH_FAN_IN_QUERY],
    [MULTI_SEED_FIXTURE, MULTI_SEED_QUERY],
  ] as const) {
    const result = retrieve(spec, query, { lexicalPoolSize: 6 });
    for (const candidate of result.candidates) {
      const score = candidate.scores.upstreamRescueScore ?? 0;
      assert.ok(score <= 0.95 + 1e-9, `${candidate.fqName} rescue score ${score} exceeds the cap`);
      if (score > 0) {
        assert.ok(candidate.sources.includes(HybridCandidateSource.UpstreamRescue));
        const evidence = candidate.evidence.join(" | ");
        assert.match(evidence, /rescued upstream caller \(incoming call depth \d\)/);
        assert.match(evidence, /upstream call path: /);
      }
    }
  }
});

test("a request with rescue disabled reports why and does no graph work", () => {
  const result = retrieve(ORCHESTRATION_CHAIN_FIXTURE, ORCHESTRATION_CHAIN_QUERY, { rescue: false });
  assert.equal(result.upstreamRescue.activated, false);
  assert.equal(result.upstreamRescue.suppressedBy, "disabled by caller");
  assert.equal(result.upstreamRescue.incomingEdgesExamined, 0);
  assert.equal(result.upstreamRescue.dbQueries, 0);
});

test("a non-orchestration request does no incoming-edge work at all", () => {
  const result = retrieve(TWO_HOP_FIXTURE, "find verify_payload_checksum");
  assert.equal(result.upstreamRescue.incomingEdgesExamined, 0);
  assert.equal(result.upstreamRescue.dbQueries, 0);
  assert.deepEqual(result.upstreamRescue.seeds, []);
});

test("ordering is deterministic across repeated runs", () => {
  const first = retrieve(MULTI_SEED_FIXTURE, MULTI_SEED_QUERY);
  const second = retrieve(MULTI_SEED_FIXTURE, MULTI_SEED_QUERY);
  assert.deepEqual(names(first), names(second));
  assert.deepEqual(rescued(first), rescued(second));
});
