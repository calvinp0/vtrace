/**
 * M179-F — broad deterministic qualification of the monotone delivery repair.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m179_qualification.ts --corpus broad100a
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m179_qualification.ts --corpus broad100b
 *
 * BOTH ARMS IN ONE PROCESS, ON THE SAME BYTES. `compactProductResponse` is a pure
 * function of the authoritative object, so the pre-repair checkout is imported by
 * absolute path and called on the SAME in-memory object as the repaired one.
 * M178 measured what any other method costs: a naive before/after re-run reported
 * 20 decision differences across 1,016 cases, every one a specimen tipped by the
 * decimal width of a timing float. There is no transport, no index, no clock and
 * no machine load between these arms.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { carriesItemBodies } from "./m179Capture";
import {
  comparePair, hashOf, RENDER_TRAILING_NOTE, TERMINAL_RANK, type Delivered,
} from "./m179Packing";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");
/** Created by M179; nothing else owns it. Pinned to M178's final commit. */
const PRE_REPAIR_ROOT = "/home/calvin/bench/vtrace-m179/pre-repair";

const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;
const DEFAULT_BUDGET = 8_000;

interface Arm {
  readonly compact: (output: unknown, options: Record<string, unknown>) => unknown;
  readonly project: (output: unknown) => unknown;
  readonly detail: Record<string, string>;
}

async function loadArm(root: string): Promise<Arm> {
  const envelope = await import(`${root}/src/mcp/responseEnvelope`) as {
    compactProductResponse: Arm["compact"]; McpResponseDetail: Record<string, string>;
  };
  const projection = await import(`${root}/src/runPipeline/orientationProjection`) as {
    projectRunPipelineOrientation: Arm["project"];
  };
  return { compact: envelope.compactProductResponse, project: projection.projectRunPipelineOrientation, detail: envelope.McpResponseDetail };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const stripTrailingNote = (code: string): string => {
  const trimmed = code.trimEnd();
  return trimmed.endsWith(RENDER_TRAILING_NOTE)
    ? trimmed.slice(0, trimmed.length - RENDER_TRAILING_NOTE.length).trimEnd()
    : code;
};

/** The same measurement as `m179Packing.deliver`, taken through a chosen arm. */
function deliverVia(arm: Arm, authoritative: unknown, budget: number): Delivered & { serialized: string } {
  const draft = structuredClone(authoritative) as Record<string, unknown>;
  delete draft.responseBudget;
  let response: Record<string, unknown>;
  try {
    response = arm.compact(draft, { requestedContextTokens: budget, detail: arm.detail.Standard }) as Record<string, unknown>;
  } catch (cause) {
    return {
      state: `throw:${cause instanceof Error ? cause.message : String(cause)}`, rank: TERMINAL_RANK.refused,
      focus: null, focusCode: false, focusTruncated: false, focusCodeCharacters: 0, focusCodeContaminated: false,
      related: [], notes: [], modelVisibleTokens: 0, metadataTokens: 0, totalTokens: 0, ceilingTokens: 0,
      withinEnvelope: false, envelopeDecline: false, boundedDegradation: false, deliveredItems: 0,
      serializedCharacters: 0, serialized: "",
    };
  }
  const budgetAccounting = isRecord(response.responseBudget) ? response.responseBudget : {};
  const compactedFields = Array.isArray(budgetAccounting.compacted_fields) ? budgetAccounting.compacted_fields.map(String) : [];
  const productContext = isRecord(response.productContext) ? response.productContext : {};
  const diagnostics = isRecord(productContext.diagnostics) ? productContext.diagnostics : {};
  const number = (value: unknown): number => (typeof value === "number" ? value : 0);
  const shared = {
    modelVisibleTokens: number(budgetAccounting.estimated_model_visible_tokens),
    metadataTokens: number(budgetAccounting.estimated_metadata_tokens),
    totalTokens: number(budgetAccounting.estimated_total_response_tokens),
    ceilingTokens: number(budgetAccounting.total_response_token_ceiling),
    withinEnvelope: budgetAccounting.within_envelope === true,
    envelopeDecline: diagnostics.envelopeDecline === true,
    boundedDegradation: compactedFields.includes("productContext.bounded_degradation"),
    deliveredItems: asArray(productContext.items).length,
    serializedCharacters: number(budgetAccounting.serialized_response_characters),
    serialized: JSON.stringify(response),
  };
  const packet = arm.project(response) as {
    focus: { at: string; code: string | null; codeTruncated: boolean };
    related: { at: string; how: string }[];
    notes?: string[];
  } | null;
  if (packet === null) {
    return {
      state: String(productContext.resultState ?? "unknown"), rank: TERMINAL_RANK.decline,
      focus: null, focusCode: false, focusTruncated: false, focusCodeCharacters: 0, focusCodeContaminated: false,
      related: [], notes: [], ...shared,
    };
  }
  const normalized = stripTrailingNote(packet.focus.code ?? "");
  return {
    state: "orientation", rank: TERMINAL_RANK.orientation, focus: packet.focus.at,
    focusCode: normalized !== "", focusTruncated: packet.focus.codeTruncated,
    focusCodeCharacters: normalized.length, focusCodeContaminated: normalized !== (packet.focus.code ?? ""),
    related: packet.related.map((entry) => `${entry.at}|${entry.how}`),
    notes: [...(packet.notes ?? [])], ...shared,
  };
}

interface Case { readonly instanceId: string; readonly authoritative: unknown }

function loadCorpus(dir: string): Case[] {
  if (!existsSync(dir)) return [];
  const cases: Case[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const captured = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
      instanceId: string; snapshot: unknown; error: string | null;
    };
    if (captured.snapshot === null || captured.error !== null) continue;
    cases.push({ instanceId: captured.instanceId, authoritative: captured.snapshot });
  }
  return cases;
}

const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";
  if (!existsSync(PRE_REPAIR_ROOT)) throw new Error(`missing pre-repair worktree at ${PRE_REPAIR_ROOT}`);
  const before = await loadArm(PRE_REPAIR_ROOT);
  const after = await loadArm(ROOT);
  const cases = loadCorpus(path.join(CORPUS_ROOT, corpus));
  if (cases.length === 0) throw new Error(`no frozen authoritative objects in ${path.join(CORPUS_ROOT, corpus)}`);

  const tally = () => ({
    ORIENTATION_TO_DECLINE: 0, ITEM_LOSS_WITH_NORMAL_RESPONSE: 0, PRIORITY_INVERSION: 0,
    REPRESENTATION_DOWNGRADE: 0, QUALIFIER_EVICTED: 0, FOCUS_SUBSTITUTED: 0, DECLINE_TO_REFUSED: 0,
  } as Record<string, number>);
  const counts = { before: tally(), after: tally() };
  const pairTotals = { before: 0, after: 0 };
  const caseTotals = { before: 0, after: 0 };
  const declineStates = { before: 0, after: 0 };
  const throwStates = { before: 0, after: 0 };

  let defaultIdentical = 0;
  let defaultChanged = 0;
  const defaultChanges: Array<Record<string, unknown>> = [];
  let refillAtWorkingBudgets = 0;
  let restoredDueToRepair = 0;
  let truthfulnessFailures = 0;
  let totalityFailures = 0;
  let bodyFixtureFailures = 0;
  const beforeTokens: number[] = [];
  const afterTokens: number[] = [];
  /** Economics on the path that already worked, and at the product's own default. */
  const workingBefore: number[] = [];
  const workingAfter: number[] = [];
  const defaultBefore: number[] = [];
  const defaultAfter: number[] = [];
  const rows: Array<Record<string, unknown>> = [];

  for (const item of cases) {
    if (!carriesItemBodies(item.authoritative).valid) bodyFixtureFailures += 1;
    const beforeLadder = BUDGETS.map((budget) => ({ budget, ...deliverVia(before, item.authoritative, budget) }));
    const afterLadder = BUDGETS.map((budget) => ({ budget, ...deliverVia(after, item.authoritative, budget) }));

    for (const [arm, ladder] of [["before", beforeLadder], ["after", afterLadder]] as const) {
      let caseViolations = 0;
      for (let i = 0; i < ladder.length; i += 1) {
        for (let j = i + 1; j < ladder.length; j += 1) {
          const violation = comparePair(ladder[i]!.budget, ladder[i]!, ladder[j]!.budget, ladder[j]!);
          if (violation === null) continue;
          caseViolations += 1;
          pairTotals[arm] += 1;
          for (const klass of violation.classes) counts[arm][klass] = (counts[arm][klass] ?? 0) + 1;
        }
      }
      if (caseViolations > 0) caseTotals[arm] += 1;
      declineStates[arm] += ladder.filter((entry) => entry.rank === TERMINAL_RANK.decline).length;
      throwStates[arm] += ladder.filter((entry) => entry.rank === TERMINAL_RANK.refused).length;
    }

    for (let index = 0; index < BUDGETS.length; index += 1) {
      const beforeEntry = beforeLadder[index]!;
      const afterEntry = afterLadder[index]!;
      beforeTokens.push(beforeEntry.modelVisibleTokens);
      afterTokens.push(afterEntry.modelVisibleTokens);

      // §55 — totality: every budget still ends in a normal response or a truthful
      // bounded decline. An exception is a regression whatever else improved.
      if (afterEntry.rank === TERMINAL_RANK.refused) totalityFailures += 1;
      // §72 — the repair may only ever emit a rung the packer already builds, so a
      // packet asserting a focus without a body it did not have, or claiming
      // orientation while the product context says delivery failed, is a defect.
      if (afterEntry.rank === TERMINAL_RANK.orientation && afterEntry.focus === null) truthfulnessFailures += 1;

      // §48 — no refill. At a budget that ALREADY produced an orientation, the
      // repair must change nothing at all.
      if (beforeEntry.rank === TERMINAL_RANK.orientation) {
        workingBefore.push(beforeEntry.modelVisibleTokens);
        workingAfter.push(afterEntry.modelVisibleTokens);
        if (afterEntry.serialized !== beforeEntry.serialized) refillAtWorkingBudgets += 1;
      } else if (afterEntry.rank === TERMINAL_RANK.orientation) {
        restoredDueToRepair += 1;
      }

      if (BUDGETS[index] === DEFAULT_BUDGET) {
        defaultBefore.push(beforeEntry.modelVisibleTokens);
        defaultAfter.push(afterEntry.modelVisibleTokens);
        if (afterEntry.serialized === beforeEntry.serialized) defaultIdentical += 1;
        else {
          defaultChanged += 1;
          defaultChanges.push({
            instanceId: item.instanceId,
            beforeState: beforeEntry.state, afterState: afterEntry.state,
            beforeModelVisibleTokens: beforeEntry.modelVisibleTokens,
            afterModelVisibleTokens: afterEntry.modelVisibleTokens,
            classification: beforeEntry.rank < afterEntry.rank
              ? "necessary_monotonicity_correction"
              : "UNEXPECTED",
          });
        }
      }
    }

    rows.push({
      instanceId: item.instanceId,
      before: beforeLadder.map((entry) => ({ budget: entry.budget, state: entry.state, modelVisibleTokens: entry.modelVisibleTokens, relatedCount: entry.related.length })),
      after: afterLadder.map((entry) => ({ budget: entry.budget, state: entry.state, modelVisibleTokens: entry.modelVisibleTokens, relatedCount: entry.related.length })),
    });
  }

  const unexpectedDefaultChanges = defaultChanges.filter((row) => row.classification === "UNEXPECTED").length;
  const report = {
    schemaVersion: "stage5.m179.qualification.v1",
    milestone: "M179",
    workstream: "F",
    corpus,
    cases: cases.length,
    budgets: BUDGETS,
    defaultBudget: DEFAULT_BUDGET,
    preRepairRoot: PRE_REPAIR_ROOT,
    method:
      "Both checkouts imported by absolute path into ONE process and called on the "
      + "SAME in-memory authoritative object. Every ORDERED budget pair is checked, "
      + "which §60 calls the stronger metric.",
    monotonicity: {
      violatingPairsBefore: pairTotals.before,
      violatingPairsAfter: pairTotals.after,
      casesWithViolationsBefore: caseTotals.before,
      casesWithViolationsAfter: caseTotals.after,
      byClassBefore: counts.before,
      byClassAfter: counts.after,
    },
    totality: {
      declineStatesBefore: declineStates.before,
      declineStatesAfter: declineStates.after,
      throwStatesBefore: throwStates.before,
      throwStatesAfter: throwStates.after,
      totalityFailuresAfter: totalityFailures,
      verdict: totalityFailures === 0 && throwStates.after === 0 ? "RESPONSE_TOTALITY_PRESERVED" : "RESPONSE_TOTALITY_REGRESSED",
    },
    truthfulness: {
      failuresAfter: truthfulnessFailures,
      verdict: truthfulnessFailures === 0 ? "PACKER_TRUTHFULNESS_PRESERVED" : "PACKER_TRUTHFULNESS_REGRESSED",
    },
    noRefill: {
      budgetsAlreadyWorkingThatChanged: refillAtWorkingBudgets,
      restoredDueToRepair,
      note:
        "A budget that already produced an orientation is byte-identical after the "
        + "repair: the retry runs only where the response was about to be discarded. "
        + "`restoredDueToRepair` counts budgets that used to deliver nothing and now "
        + "deliver a packet the packer would have published for a smaller request.",
    },
    defaultOutputIdentity: {
      identical: defaultIdentical,
      changed: defaultChanged,
      unexpected: unexpectedDefaultChanges,
      changes: defaultChanges,
    },
    packetEconomics: {
      beforeMedianModelVisibleTokens: percentile(beforeTokens, 0.5),
      afterMedianModelVisibleTokens: percentile(afterTokens, 0.5),
      beforeP90ModelVisibleTokens: percentile(beforeTokens, 0.9),
      afterP90ModelVisibleTokens: percentile(afterTokens, 0.9),
      beforeMaxModelVisibleTokens: Math.max(0, ...beforeTokens),
      afterMaxModelVisibleTokens: Math.max(0, ...afterTokens),
      // The whole-ladder median moves because budgets that used to deliver NOTHING
      // now deliver evidence — the repair, not inflation. The two figures below are
      // the ones §77 is about: what the compact product costs where it already
      // worked, and what it costs at the budget the product actually runs at.
      alreadyWorkingMedianBefore: percentile(workingBefore, 0.5),
      alreadyWorkingMedianAfter: percentile(workingAfter, 0.5),
      alreadyWorkingP90Before: percentile(workingBefore, 0.9),
      alreadyWorkingP90After: percentile(workingAfter, 0.9),
      defaultBudgetMedianBefore: percentile(defaultBefore, 0.5),
      defaultBudgetMedianAfter: percentile(defaultAfter, 0.5),
    },
    fixtureControl: { casesWithoutItemBodies: bodyFixtureFailures },
    rowsHash: hashOf(rows),
    rows,
  };
  const outPath = path.join(RESULTS, `stage5_m179_broad_monotonicity.${corpus}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);

  console.log(`corpus=${corpus} cases=${cases.length}\n`);
  console.log(`violating ordered pairs   before=${pairTotals.before}  after=${pairTotals.after}`);
  console.log(`cases with violations     before=${caseTotals.before}  after=${caseTotals.after}`);
  for (const klass of Object.keys(counts.before)) {
    console.log(`  ${klass.padEnd(32)} before=${String(counts.before[klass]).padStart(4)}  after=${String(counts.after[klass]).padStart(4)}`);
  }
  console.log(`\ndecline states            before=${declineStates.before}  after=${declineStates.after}`);
  console.log(`throws                    before=${throwStates.before}  after=${throwStates.after}`);
  console.log(`default-budget identical  ${defaultIdentical}/${cases.length} (changed=${defaultChanged}, unexpected=${unexpectedDefaultChanges})`);
  console.log(`no-refill: already-working budgets changed = ${refillAtWorkingBudgets}; restored by repair = ${restoredDueToRepair}`);
  console.log(`economics (all budgets):    median mv ${report.packetEconomics.beforeMedianModelVisibleTokens} -> ${report.packetEconomics.afterMedianModelVisibleTokens}, p90 ${report.packetEconomics.beforeP90ModelVisibleTokens} -> ${report.packetEconomics.afterP90ModelVisibleTokens}`);
  console.log(`economics (already worked): median mv ${report.packetEconomics.alreadyWorkingMedianBefore} -> ${report.packetEconomics.alreadyWorkingMedianAfter}, p90 ${report.packetEconomics.alreadyWorkingP90Before} -> ${report.packetEconomics.alreadyWorkingP90After}`);
  console.log(`economics (default 8000):   median mv ${report.packetEconomics.defaultBudgetMedianBefore} -> ${report.packetEconomics.defaultBudgetMedianAfter}`);
  console.log(`totality: ${report.totality.verdict}; truthfulness: ${report.truthfulness.verdict}`);
  console.log(`\n-> ${path.relative(ROOT, outPath)}`);
}

await main();
