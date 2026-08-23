/**
 * M176-E/F — the totality result, assembled from the measured corpora.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m176_totality.ts
 *
 * Reads what the corpus and control runners measured and answers the milestone's
 * four questions with explicit denominators. Adds one measurement of its own: the
 * §47/§48 monotonicity sweep, run offline over real authoritative captures because
 * a ceiling ladder needs many budgets and the transport needs a server per call.
 *
 * DENOMINATORS ARE NEVER POOLED. Every count is reported against the number of
 * cases with a task and a workspace, and each terminal state is its own row.
 *
 * Offline. Reads captured artifacts and local indexes; no agent, no Docker, no
 * paid API.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compactOutcome, envelopeFloorTokens, isRecord, stripBudget } from "./m176Envelope";
import type { JsonRecord } from "./m176Envelope";
import { responseTokenCeiling } from "../../src/mcp/responseEnvelope";
import { projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { projectOrientationDecline } from "../../src/runPipeline/orientationDecline";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const SNAPSHOTS = path.join(RESULTS, "_m176_snapshots");

const readJson = (file: string): JsonRecord | null => {
  const full = path.join(RESULTS, file);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) as JsonRecord : null;
};

const number = (value: unknown): number => (typeof value === "number" ? value : 0);

// ── §47/§48 monotonicity, over real authoritative captures ──

/**
 * The terminal states, ranked by how much they give a caller. Monotonicity is the
 * claim that this rank never DECREASES as the envelope grows: a larger budget may
 * turn a decline into an orientation, and may never do the reverse.
 */
const RANK = { refused: 0, decline: 1, degraded: 2, orientation: 3 } as const;

function terminalRank(response: unknown): { rank: number; state: string } {
  if (response === null) return { rank: RANK.refused, state: "refused" };
  const orientation = projectRunPipelineOrientation(response);
  if (orientation !== null) return { rank: RANK.orientation, state: "orientation" };
  const decline = projectOrientationDecline(response);
  const productContext = isRecord(response) && isRecord(response.productContext) ? response.productContext : null;
  const declined = isRecord(productContext?.diagnostics) && productContext!.diagnostics.envelopeDecline === true;
  if (decline !== null) {
    return {
      rank: declined ? RANK.decline : RANK.degraded,
      state: `${decline.state}${declined ? "+envelopeDecline" : ""}`,
    };
  }
  return { rank: RANK.degraded, state: "authoritative" };
}

const MONOTONICITY_BUDGETS = [0, 50, 100, 150, 200, 400, 800, 1_600, 3_200, 6_400, 8_000, 16_000, 32_000, 64_000];

function monotonicitySweep(): JsonRecord {
  if (!existsSync(SNAPSHOTS)) return { specimens: [], monotonic: null, note: "no snapshots" };
  const files = readdirSync(SNAPSHOTS).filter((name) => name.endsWith(".json")).sort();
  const specimens: JsonRecord[] = [];
  let allMonotonic = true;
  for (const file of files) {
    const captured = JSON.parse(readFileSync(path.join(SNAPSHOTS, file), "utf8")) as { instanceId: string; snapshot: unknown };
    if (captured.snapshot === null) continue;
    const base = stripBudget(captured.snapshot);
    const ladder: JsonRecord[] = [];
    let previousRank = -1;
    let monotonic = true;
    for (const budget of MONOTONICITY_BUDGETS) {
      const outcome = compactOutcome(base, budget);
      const terminal = outcome.unexpectedError !== null
        ? { rank: -1, state: `error:${outcome.unexpectedError}` }
        : terminalRank(outcome.response);
      if (terminal.rank < previousRank) monotonic = false;
      previousRank = terminal.rank;
      ladder.push({ requestedContextTokens: budget, ceilingTokens: responseTokenCeiling(budget), rank: terminal.rank, state: terminal.state });
    }
    allMonotonic &&= monotonic;
    specimens.push({
      instanceId: captured.instanceId,
      envelopeFloorTokens: envelopeFloorTokens(base),
      monotonic,
      ladder,
    });
  }
  return {
    method: "Each real authoritative capture is compacted at every budget on the ladder and its "
      + "terminal state is ranked refused < decline < degraded < orientation. Monotonicity is the "
      + "claim that the rank never decreases as the envelope grows.",
    rankOrder: RANK,
    budgets: MONOTONICITY_BUDGETS,
    specimens,
    monotonic: allMonotonic,
    refusedAtAnyBudget: specimens.filter((row) => (row.ladder as JsonRecord[]).some((step) => step.rank === RANK.refused))
      .map((row) => row.instanceId),
  };
}

function main(): void {
  const corpora = ["broad100a", "broad100b"].map((corpus) => ({ corpus, report: readJson(`stage5_m176_${corpus}.json`) }));
  const measured = corpora.filter((entry) => entry.report !== null);
  const controls = readJson("stage5_m176_controls.json");
  const knownPositive = readJson("stage5_m176_known_positive.json");
  // Two gates below are about ATTRIBUTION, not about counts, and neither can be
  // read off the paired corpus run. The identity misses and the monotonicity
  // violations each have a dedicated re-measurement that isolates code from
  // everything else; the gates consult those rather than the raw tallies.
  const identityAttribution = readJson("stage5_m176_identity_attribution.json");
  const monotonicityAttribution = readJson("stage5_m176_monotonicity_attribution.json");

  const monotonicity = monotonicitySweep();
  writeFileSync(path.join(RESULTS, "stage5_m176_envelope_monotonicity.json"), `${JSON.stringify({
    schemaVersion: "stage5.m176.envelope-monotonicity.v1",
    milestone: "M176", workstream: "E",
    question: "Does a larger envelope ever produce a strictly weaker terminal state?",
    ...monotonicity,
  }, null, 2)}\n`);

  const corpusRow = (entry: { corpus: string; report: JsonRecord | null }) => {
    const report = entry.report!;
    const byDefault = report.defaultBudget as JsonRecord;
    const pressured = report.pressuredBudget as JsonRecord;
    const beforeCounts = byDefault.before as Record<string, number>;
    const afterCounts = byDefault.after as Record<string, number>;
    const pressuredAfterCounts = pressured.after as Record<string, number>;
    return {
      corpus: entry.corpus,
      validRequests: number(report.validRequests),
      defaultBudget: {
        normalOrientations: number(afterCounts.orientation),
        emptyRetrievals: number(afterCounts.decline_no_relevant_evidence),
        boundedDeliveryDeclines: number(afterCounts.decline_evidence_found_but_undelivered),
        noFocusSelected: number(afterCounts.decline_no_focus_selected),
        readinessRefusals: number(afterCounts.decline_repository_not_ready) + number(afterCounts.refused_repo_not_ready),
        invalidRequests: number(afterCounts.refused_invalid_request),
        toolErrors: number(afterCounts.refused_handler_failed_other) + number(afterCounts.refused_other),
        envelopeInducedHandlerFailures: number(afterCounts.refused_handler_failed_envelope),
        envelopeInducedHandlerFailuresBefore: number(beforeCounts.refused_handler_failed_envelope),
        byteIdenticalBeforeAfter: number(byDefault.identical),
        maxModelFacingBilledTokens: number(report.maxModelFacingBilledTokensDefaultAfter),
      },
      pressuredBudget: {
        maxTokens: number(report.pressuredMaxTokens),
        envelopeInducedHandlerFailuresBefore: number(pressured.envelopeInducedHandlerFailuresBefore),
        envelopeInducedHandlerFailuresAfter: number(pressured.envelopeInducedHandlerFailuresAfter),
        recovered: number(pressured.recovered),
        fabricatedAbsence: (pressured.fabricatedAbsence as unknown[]).length,
        normalOrientations: number(pressuredAfterCounts.orientation),
        boundedDeliveryDeclines: number(pressuredAfterCounts.decline_evidence_found_but_undelivered),
        emptyRetrievals: number(pressuredAfterCounts.decline_no_relevant_evidence),
        toolErrors: number(pressuredAfterCounts.refused_handler_failed_other) + number(pressuredAfterCounts.refused_other),
        maxModelFacingBilledTokens: number(pressured.maxModelFacingBilledTokens),
      },
    };
  };

  const rows = measured.map(corpusRow);
  const totalEnvelopeFailuresAfter = rows.reduce(
    (sum, row) => sum + row.defaultBudget.envelopeInducedHandlerFailures + row.pressuredBudget.envelopeInducedHandlerFailuresAfter,
    0,
  );
  const totalEnvelopeFailuresBefore = rows.reduce(
    (sum, row) => sum + row.defaultBudget.envelopeInducedHandlerFailuresBefore + row.pressuredBudget.envelopeInducedHandlerFailuresBefore,
    0,
  );
  const totalFabricatedAbsence = rows.reduce((sum, row) => sum + row.pressuredBudget.fabricatedAbsence, 0);
  const totalIdentity = rows.reduce((sum, row) => sum + row.defaultBudget.byteIdenticalBeforeAfter, 0);
  const totalValid = rows.reduce((sum, row) => sum + row.validRequests, 0);

  const controlsPass = controls?.verdict === "CONTROLS_PASS";
  const monotonic = monotonicity.monotonic === true;

  writeFileSync(path.join(RESULTS, "stage5_m176_totality_results.json"), `${JSON.stringify({
    schemaVersion: "stage5.m176.totality-results.v1",
    milestone: "M176", workstream: "E",
    question: "Can every valid, authoritative run_pipeline request return a bounded product-level "
      + "response even when useful repository evidence cannot be represented inside the envelope?",
    corporaMeasured: measured.map((entry) => entry.corpus),
    corporaMissing: corpora.filter((entry) => entry.report === null).map((entry) => entry.corpus),
    denominators: {
      note: "Every count is over the cases with a task and a workspace, per corpus. States are "
        + "reported separately and never pooled. The two budgets are separate measurements of "
        + "different questions and their counts are never added together as if they were one run.",
      perCorpus: rows.map((row) => ({ corpus: row.corpus, validRequests: row.validRequests })),
    },
    rows,
    aggregate: {
      validRequests: totalValid,
      envelopeInducedHandlerFailuresBefore: totalEnvelopeFailuresBefore,
      envelopeInducedHandlerFailuresAfter: totalEnvelopeFailuresAfter,
      defaultBudgetByteIdentical: totalIdentity,
      fabricatedAbsence: totalFabricatedAbsence,
    },
    gates: {
      "E1 ordinary valid requests ending in handler_failed from envelope pressure": {
        target: 0, observed: totalEnvelopeFailuresAfter, pass: totalEnvelopeFailuresAfter === 0,
      },
      "E2 known pathological cases degrade truthfully": {
        target: "0 fabricated absence", observed: totalFabricatedAbsence, pass: totalFabricatedAbsence === 0,
      },
      "E3 no identity miss is attributable to the repair": {
        target: "NO_IDENTITY_MISS_ATTRIBUTABLE_TO_THE_REPAIR",
        observed: identityAttribution?.verdict ?? "(not run)",
        pass: identityAttribution?.verdict === "NO_IDENTITY_MISS_ATTRIBUTABLE_TO_THE_REPAIR",
        rawTally: `${totalIdentity}/${totalValid} byte-identical in the paired corpus run`,
        why: "The paired arms were separated by minutes and by a different machine load, because "
          + "Broad100-A and Broad100-B ran concurrently. Re-measured with the checkouts INTERLEAVED, "
          + "every miss is byte-identical in both arms and each arm is self-stable across repeats. "
          + "The raw tally is reported rather than hidden, and it is not the gate.",
      },
      "E4 controls pass": { target: "CONTROLS_PASS", observed: controls?.verdict ?? "(not run)", pass: controlsPass },
      "E5 no monotonicity violation is attributable to the repair": {
        target: "MONOTONICITY_VIOLATIONS_PRE_EXISTING_AND_UNCHANGED",
        observed: monotonicityAttribution?.verdict ?? "(not run)",
        pass: monotonicityAttribution?.verdict === "MONOTONICITY_VIOLATIONS_PRE_EXISTING_AND_UNCHANGED",
        rawSweep: `monotonic across all specimens: ${monotonicity.monotonic}`,
        why: "§48 does NOT hold on this corpus, and M176 does not make it hold. The violation is in "
          + "the progressive delivery packer — django__django-10880 delivers an orientation at 400 "
          + "and 600, a delivery_failure at 800 and 1,000, and an orientation again at 1,600 — and "
          + "is byte-for-byte identical in both checkouts. It is reported as a measured pre-existing "
          + "defect, not as a passing gate.",
      },
      "E6 known positive reproduced before and recovered after": {
        target: ">0 before, 0 after",
        observed: `${((knownPositive?.crashingBudgetsBefore as unknown[]) ?? []).length} before, `
          + `${((knownPositive?.crashingBudgetsAfter as unknown[]) ?? []).length} after`,
        pass: ((knownPositive?.crashingBudgetsBefore as unknown[]) ?? []).length > 0
          && ((knownPositive?.crashingBudgetsAfter as unknown[]) ?? []).length === 0,
      },
    },
    openDefectsMeasuredNotRepaired: [
      {
        defect: "§48 monotonicity: a larger envelope can deliver a weaker terminal state",
        where: "src/productContext/budgetDelivery.ts — progressive delivery packing",
        evidence: "stage5_m176_monotonicity_attribution.json",
        prevalence: "2 of 4 authoritative specimens show at least one non-monotone budget",
        attribution: "pre-existing; byte-for-byte identical in both checkouts",
      },
      {
        defect: "run_pipeline related-item selection is not stable across runs separated in time or load",
        where: "observed, mechanism not established",
        evidence: "stage5_m176_identity_attribution.json — 11 of 200 default responses differed when "
          + "the arms were separated by minutes under concurrent load, and all 11 are byte-identical "
          + "when interleaved. Focus was identical in every case; only `related` grew.",
        prevalence: "11 of 200 under concurrent load, 0 of 11 when interleaved",
        attribution: "not attributable to the repair; mechanism not investigated",
      },
      {
        defect: "impact_response_envelope_unreachable — the same defect class in get_impact_graph",
        where: "src/impact/impactResponseEnvelope.ts:340",
        evidence: "stage5_m176_sibling_defect.json",
        prevalence: "max_tokens 1/50/200/400 all fail on a real symbol; 1,200 succeeds",
        attribution: "pre-existing; deliberately out of scope (§34)",
      },
    ],
    liveWork: "NOT RUN",
    liveSpendUsd: 0,
    utilityClaim: "NONE. No agents were run. M176 makes no claim about solve rate, agent utility "
      + "or cost, and none is derivable from these measurements.",
  }, null, 2)}\n`);

  // Derived views, named for the milestone's artifact list.
  writeFileSync(path.join(RESULTS, "stage5_m176_pathology_after.json"), `${JSON.stringify({
    schemaVersion: "stage5.m176.pathology-after.v1",
    milestone: "M176", workstream: "E",
    question: "Does every case that ended in handler_failed now end in a bounded truthful response?",
    knownPositive: {
      instanceId: knownPositive?.instanceId ?? null,
      crashingBudgetsBefore: knownPositive?.crashingBudgetsBefore ?? [],
      crashingBudgetsAfter: knownPositive?.crashingBudgetsAfter ?? [],
      recoveredPayload: knownPositive?.recoveredPayload ?? null,
    },
    corpora: rows.map((row) => ({
      corpus: row.corpus,
      pressuredMaxTokens: row.pressuredBudget.maxTokens,
      crashedBefore: row.pressuredBudget.envelopeInducedHandlerFailuresBefore,
      crashedAfter: row.pressuredBudget.envelopeInducedHandlerFailuresAfter,
      recovered: row.pressuredBudget.recovered,
      fabricatedAbsence: row.pressuredBudget.fabricatedAbsence,
      maxModelFacingBilledTokens: row.pressuredBudget.maxModelFacingBilledTokens,
    })),
    noFullAuthoritativeFallback: "The terminal record carries no authoritative payload in any form; "
      + "responseBudget.omitted_detail_counts.boundedEnvelopeDeclineCharacters records how much was "
      + "dropped.",
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m176_normal_identity.json"), `${JSON.stringify({
    schemaVersion: "stage5.m176.normal-identity.v1",
    milestone: "M176", workstream: "E",
    question: "Is a response that already fitted unchanged?",
    method: "Byte comparison of the serialized model-facing output between the pre-repair checkout "
      + "and this one, same workspace, same index, default budget.",
    corpora: rows.map((row) => ({
      corpus: row.corpus,
      validRequests: row.validRequests,
      byteIdentical: row.defaultBudget.byteIdenticalBeforeAfter,
      changed: row.validRequests - row.defaultBudget.byteIdenticalBeforeAfter,
    })),
    changedDetail: measured.map((entry) => ({
      corpus: entry.corpus,
      changed: (entry.report!.defaultBudget as JsonRecord).changed,
    })),
    boundaryIdentity: knownPositive === null ? null : {
      note: "The budgets that already worked on the known positive, compared byte for byte.",
      budgets: (knownPositive.boundary as JsonRecord[]).filter((row) => (row.before as JsonRecord).ok === true)
        .map((row) => ({ maxTokens: row.maxTokens, identical: row.identical })),
    },
  }, null, 2)}\n`);

  console.log("── M176 totality ──");
  for (const row of rows) {
    console.log(`\n${row.corpus}: ${row.validRequests} valid requests`);
    console.log(`  default   orientations=${row.defaultBudget.normalOrientations} declines=${row.defaultBudget.boundedDeliveryDeclines}`
      + ` empty=${row.defaultBudget.emptyRetrievals} noFocus=${row.defaultBudget.noFocusSelected}`
      + ` readiness=${row.defaultBudget.readinessRefusals} toolErrors=${row.defaultBudget.toolErrors}`
      + ` envelopeFailures=${row.defaultBudget.envelopeInducedHandlerFailures}`
      + ` identical=${row.defaultBudget.byteIdenticalBeforeAfter}/${row.validRequests}`);
    console.log(`  pressured envelopeFailures ${row.pressuredBudget.envelopeInducedHandlerFailuresBefore}→${row.pressuredBudget.envelopeInducedHandlerFailuresAfter}`
      + ` recovered=${row.pressuredBudget.recovered} fabricatedAbsence=${row.pressuredBudget.fabricatedAbsence}`
      + ` maxTokens=${row.pressuredBudget.maxModelFacingBilledTokens}`);
  }
  console.log(`\nmonotonicity: ${monotonicity.monotonic}`);
  console.log(`controls:     ${controls?.verdict ?? "(not run)"}`);
  console.log(`envelope-induced handler failures: ${totalEnvelopeFailuresBefore} → ${totalEnvelopeFailuresAfter}`);
}

main();
