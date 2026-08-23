/**
 * M177-A/B — the impact-envelope failure path, traced and reproduced.
 *
 * Answers three questions with measurement rather than with analogy to the
 * `run_pipeline` envelope M176 repaired:
 *
 *   1. Does the ENGINE succeed before the envelope fails? (Is this a delivery
 *      failure wearing a computation failure's clothes?)
 *   2. Exactly which of `fits()`'s three conditions is unsatisfiable at the
 *      terminal, and why can no rung of the ladder satisfy it?
 *   3. Where is the floor, and is the terminal residue really constant below it?
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m177_failure_path.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
  IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
  impactResponseTokenCeiling,
} from "../../src/impact/impactResponseEnvelope";
import {
  authoritativeImpact,
  billedTokens,
  envelopeTokens,
  findEnvelopeFloor,
  openWorkspace,
  runImpactEnvelope,
  runLadder,
} from "./m177ImpactEnvelope";

const KNOWN_POSITIVE_REPO = path.resolve(
  import.meta.dir,
  "results/workspaces/m160_broad_b/pytest-dev__pytest-10081",
);
const KNOWN_POSITIVE_SYMBOL = "src/_pytest/debugging.py::_enter_pdb";

/** M176's recorded ladder, plus the budgets that bracket the real transition. */
const LADDER_BUDGETS = [1, 50, 100, 200, 400, 600, 800, 1000, 1200] as const;

function outDir(): string {
  const index = process.argv.indexOf("--out");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? path.resolve(import.meta.dir, "results");
}

async function main(): Promise<void> {
  const out = outDir();
  mkdirSync(out, { recursive: true });
  const db = openWorkspace(KNOWN_POSITIVE_REPO);

  try {
    const rungs = await runLadder(db, KNOWN_POSITIVE_REPO, KNOWN_POSITIVE_SYMBOL, LADDER_BUDGETS);
    const floor = await findEnvelopeFloor(db, KNOWN_POSITIVE_REPO, KNOWN_POSITIVE_SYMBOL, 1, 2_000);

    // Read the irreducible residue off the floor specimen: at exactly the floor
    // every rung has fired, so this is the smallest response the ladder can build
    // for this authoritative result. Reading it at a comfortable budget instead
    // would measure a different, larger draft (M175-B's trap).
    const atFloor = floor.floor === null
      ? null
      : await authoritativeImpact(db, KNOWN_POSITIVE_REPO, { symbolFqn: KNOWN_POSITIVE_SYMBOL, maxTokens: floor.floor });
    const floorOutcome = atFloor?.output === undefined || atFloor?.output === null
      ? null
      : runImpactEnvelope(atFloor.output);
    const residue = floorOutcome?.budget ?? null;

    // What the floor specimen SPENDS, key by key. The point of the breakdown is
    // attribution: the ladder shrinks the five model-visible keys and nothing
    // else, so if the metadata outweighs the evidence at the floor then no amount
    // of further evidence-shedding can reach a smaller budget.
    const MODEL_VISIBLE_KEYS = new Set(["edges", "nodes", "view", "directRelations", "paths"]);
    const floorResponse = floorOutcome?.response as unknown as Record<string, unknown> | undefined;
    const keyCosts = floorResponse === undefined
      ? []
      : Object.keys(floorResponse)
        .map((key) => ({
          key,
          channel: MODEL_VISIBLE_KEYS.has(key) ? "model_visible" as const : "metadata" as const,
          estimatedTokens: envelopeTokens(floorResponse[key]),
          characters: JSON.stringify(floorResponse[key] ?? null).length,
          reducedByTheLadder: MODEL_VISIBLE_KEYS.has(key)
            || ["coverage", "callerCoverage", "diagnostics", "accounting", "affectedFiles", "entrypoints", "tests", "potentialCallers", "dependentFiles"].includes(key),
        }))
        .sort((left, right) => right.estimatedTokens - left.estimatedTokens);
    const metadataTokens = keyCosts.filter((row) => row.channel === "metadata").reduce((sum, row) => sum + row.estimatedTokens, 0);
    const modelVisibleTokens = keyCosts.filter((row) => row.channel === "model_visible").reduce((sum, row) => sum + row.estimatedTokens, 0);

    // Which of the three `fits()` conditions is unsatisfiable at each failing
    // budget, evaluated against the residue the ladder actually bottoms out at.
    const conditions = rungs.filter((rung) => rung.unreachable).map((rung) => ({
      maxTokens: rung.maxTokens,
      totalCeiling: rung.totalCeiling,
      modelVisibleCondition: {
        expression: "modelVisibleEstimatedTokens <= requestedMaxTokens",
        residueValue: residue?.modelVisibleEstimatedTokens ?? null,
        bound: rung.maxTokens,
        satisfiable: residue === null ? null : residue.modelVisibleEstimatedTokens <= rung.maxTokens,
      },
      totalCondition: {
        expression: "estimatedTotalTokens <= totalCeiling",
        residueValue: residue?.estimatedTotalTokens ?? null,
        bound: rung.totalCeiling,
        satisfiable: residue === null ? null : residue.estimatedTotalTokens <= rung.totalCeiling,
      },
      characterCondition: {
        expression: "serializedCharacters <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING",
        residueValue: residue?.serializedCharacters ?? null,
        bound: IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
        satisfiable: residue === null ? null : residue.serializedCharacters <= IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
      },
    }));

    // The engine's own verdict at a failing budget. If this is `ok`, the failure
    // is delivery and nothing else.
    const engineAtFailingBudget = await authoritativeImpact(
      db,
      KNOWN_POSITIVE_REPO,
      { symbolFqn: KNOWN_POSITIVE_SYMBOL, maxTokens: 200 },
    );

    const failurePath = {
      schemaVersion: "stage5.m177.failure-path.v1",
      milestone: "M177",
      workstream: "A",
      tool: "get_impact_graph",
      terminal: {
        file: "src/impact/impactResponseEnvelope.ts",
        line: 340,
        message: "impact_response_envelope_unreachable",
        reportedToCallerAs: "handler_failed (MCP server catch-all)",
      },
      path: [
        "tools.ts:10180 withReadyRepoDb — readiness gate, unchanged by M177",
        "tools.ts:10181 getImpactGraph(db, ...) — AUTHORITATIVE impact computation",
        "tools.ts:10199 !result.ok -> invalid_request (a computation failure, separate state)",
        "tools.ts:10207 buildContextAccountingBestEffort — additive, never throws",
        "tools.ts:10217 compactImpactProductResponse — the response envelope",
        "impactResponseEnvelope.ts:183 fits() — three conjunctive conditions",
        "impactResponseEnvelope.ts:196-329 the degradation ladder",
        "impactResponseEnvelope.ts:338 rebuilt budget still exceeds a bound",
        "impactResponseEnvelope.ts:340 throw",
      ],
      fitsConditions: {
        ladderGate: {
          site: "impactResponseEnvelope.ts:183 fits()",
          expression: "estimatedTotalTokens <= totalCeiling && serializedCharacters <= 80000 && modelVisibleEstimatedTokens <= requestedMaxTokens",
          conditions: 3,
        },
        terminalCheck: {
          site: "impactResponseEnvelope.ts:338",
          expression: "estimatedTotalTokens > totalCeiling || serializedCharacters > 80000",
          conditions: 2,
        },
        theyDisagree: {
          finding: "the ladder's own gate tests THREE conditions; the terminal check that decides whether to throw tests only TWO of them. `modelVisibleEstimatedTokens <= requestedMaxTokens` drives every rung of compaction and then has no say in the throw.",
          consequence: "the ladder is driven to exhaustion by the model-visible bound and then dies on the total bound. A response can therefore be RETURNED while still exceeding requestedMaxTokens in model-visible content — measured at the floor below — and the throw fires on the metadata, not on the evidence.",
          classification: "PRE-EXISTING, measured, NOT repaired by M177 (see stage5_m177_outstanding_defects.md)",
        },
        totalCeiling: "min(requestedMaxTokens + max(800, ceil(requestedMaxTokens * 0.15)), 20000)",
        metadataAllowanceFloorTokens: IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
        hardCharacterCeiling: IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
        modelVisibleFields: ["edges", "nodes", "view", "directRelations", "paths"],
      },
      whyTheLadderCannotSatisfyIt: {
        irreducibleRungs: [
          "impactResponseEnvelope.ts:267 `while (!fits() && draft.directRelations.length > 1)` stops at ONE relation, never zero",
          "impactResponseEnvelope.ts:311-323 the last-resort `bounded_degradation` rung keeps `directRelations.slice(0, 1)`",
          "impactResponseEnvelope.ts:325 `while (!fits() && draft.edges.length > 1)` stops at ONE edge, never zero",
          "no rung reduces the ROOT metadata: requested, resolvedSymbol, coverage, summary, richSummary, limits, timing, diagnostics, callerCoverage",
        ],
        consequence: "the ladder has a floor above zero, so `modelVisibleEstimatedTokens <= requestedMaxTokens` is UNSATISFIABLE for any requested budget below that floor, and the loop condition `draft.edges.length > 1` exits with the response still too large",
        emptyModelVisibleFloorTokens: envelopeTokens({ edges: [], nodes: [], view: { format: "tree", lines: [] }, directRelations: [], paths: [] }),
        emptyModelVisibleNote: "even a response carrying NO impact evidence at all serializes its five model-visible keys, so budgets below this can never be satisfied by dropping evidence — a truthful terminal is the only reachable answer",
      },
      computationVersusDelivery: {
        question: "did get_impact_graph compute authoritative impact evidence before failing solely on the response envelope?",
        engineAtMaxTokens200: {
          ok: engineAtFailingBudget.ok,
          errorCode: engineAtFailingBudget.errorCode,
          resolvedSymbol: engineAtFailingBudget.output?.resolvedSymbol.fqName ?? null,
          directRelations: engineAtFailingBudget.output?.directRelations.length ?? null,
          edges: engineAtFailingBudget.output?.edges.length ?? null,
          nodes: engineAtFailingBudget.output?.nodes.length ?? null,
          potentialCallers: engineAtFailingBudget.output?.potentialCallers.length ?? null,
          consumers: engineAtFailingBudget.output?.summary.consumers ?? null,
        },
        answer: engineAtFailingBudget.ok
          ? "YES — the engine returned a resolved symbol and a populated relation set at a budget where the envelope throws. The failure is IMPACT_COMPUTATION_SUCCEEDED + RESPONSE_COULD_NOT_FIT."
          : "NO — the engine itself failed; this specimen does not isolate the envelope.",
      },
      floor: {
        ...floor,
        residue: residue === null ? null : {
          modelVisibleEstimatedTokens: residue.modelVisibleEstimatedTokens,
          metadataEstimatedTokens: residue.metadataEstimatedTokens,
          estimatedTotalTokens: residue.estimatedTotalTokens,
          totalCeiling: residue.totalCeiling,
          serializedCharacters: residue.serializedCharacters,
          retainedEdges: residue.retainedEdges,
          omittedEdges: residue.omittedEdges,
          resultState: residue.resultState,
          compactedFields: residue.compactedFields,
        },
        billedTokensAtFloor: floorOutcome?.response == null ? null : billedTokens(floorOutcome.response),
      },
      bindingConditionPerFailingBudget: conditions,
      costAtFloor: {
        note: "per-key cost of the SMALLEST response the ladder can build for this authoritative result. Read at the floor, never at a comfortable budget (M175-B).",
        metadataEstimatedTokens: metadataTokens,
        modelVisibleEstimatedTokens: modelVisibleTokens,
        metadataShare: metadataTokens + modelVisibleTokens === 0
          ? null
          : Math.round((metadataTokens / (metadataTokens + modelVisibleTokens)) * 1000) / 10,
        finding: metadataTokens > modelVisibleTokens
          ? "the METADATA outweighs the delivered evidence at the floor. The ladder can only shrink the model-visible channel, so no further evidence-shedding reaches a smaller budget: the floor is set by fields no rung touches."
          : "the delivered evidence still outweighs the metadata at the floor.",
        keys: keyCosts,
      },
    };

    writeFileSync(path.join(out, "stage5_m177_failure_path.json"), `${JSON.stringify(failurePath, null, 2)}\n`);

    const knownPositive = {
      schemaVersion: "stage5.m177.known-positive-before.v1",
      milestone: "M177",
      workstream: "B",
      arm: "before",
      note: "offline reproduction over the real product envelope; the real-MCP reproduction is stage5_m177_known_positive_transport.json",
      repoRoot: KNOWN_POSITIVE_REPO,
      symbolFqn: KNOWN_POSITIVE_SYMBOL,
      request: { depth: 5, format: "tree", maxEdges: "default 64", maxPaths: "default 3" },
      ladder: rungs.map((rung) => ({
        maxTokens: rung.maxTokens,
        totalCeiling: rung.totalCeiling,
        authoritativeOk: rung.authoritativeOk,
        authoritativeIdentity: rung.authoritativeIdentity,
        outcome: rung.unreachable ? "impact_response_envelope_unreachable" : rung.reachable ? "response" : `unexpected:${rung.unexpectedError}`,
        modelVisibleEstimatedTokens: rung.modelVisibleEstimatedTokens,
        serializedCharacters: rung.serializedCharacters,
        responseIdentity: rung.responseIdentity,
      })),
      unexpectedErrors: rungs.filter((rung) => rung.unexpectedError !== null).map((rung) => rung.unexpectedError),
      m176RecordedLadder: { failing: [1, 50, 200, 400], passing: [1200], thresholdBetween: [400, 1200] },
      m177MeasuredThreshold: { largestFailing: floor.largestFailing, smallestPassing: floor.floor },
      agreesWithM176: rungs.filter((rung) => [1, 50, 200, 400].includes(rung.maxTokens)).every((rung) => rung.unreachable)
        && rungs.some((rung) => rung.maxTokens === 1_200 && rung.reachable),
    };
    writeFileSync(path.join(out, "stage5_m177_known_positive_before.json"), `${JSON.stringify(knownPositive, null, 2)}\n`);

    console.log(`floor=${floor.floor} largestFailing=${floor.largestFailing} probes=${floor.probes}`);
    console.log(`residue modelVisible=${residue?.modelVisibleEstimatedTokens} total=${residue?.estimatedTotalTokens} ceiling=${residue?.totalCeiling} chars=${residue?.serializedCharacters}`);
    console.log(`agreesWithM176=${knownPositive.agreesWithM176}`);
    for (const rung of rungs) {
      console.log(`  ${String(rung.maxTokens).padStart(4)} ceiling=${String(rung.totalCeiling).padStart(5)} -> ${rung.unreachable ? "UNREACHABLE" : rung.reachable ? `ok mv=${rung.modelVisibleEstimatedTokens}` : `UNEXPECTED ${rung.unexpectedError}`}`);
    }
    console.log(`empty model-visible floor = ${failurePath.whyTheLadderCannotSatisfyIt.emptyModelVisibleFloorTokens} tokens`);
    console.log(`ceiling(1)=${impactResponseTokenCeiling(1)}`);
  } finally {
    db.close();
  }
}

await main();
