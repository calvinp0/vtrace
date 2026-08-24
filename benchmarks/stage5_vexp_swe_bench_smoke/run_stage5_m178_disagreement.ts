/**
 * M178-B — the frozen disagreement corpus.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m178_disagreement.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * WHAT IT MEASURES. For every corpus symbol, the budgets at which
 * `get_impact_graph` returns a NORMAL response whose model-visible evidence
 * exceeds the caller's declared `max_tokens` — the class M177 predicted from
 * reading the code and left unmeasured. Each such budget is a call where the
 * ladder's own gate says the response does not fit and the terminal returns it
 * anyway.
 *
 * WHY BINARY SEARCH IS SOUND HERE. M177 established, and `monotonicity` below
 * re-checks on every corpus member, that the impact terminal state is monotone in
 * the budget: below a per-symbol floor every rung fires and the call declines;
 * at or above it the call is delivered. So the first delivering budget is
 * findable in ~15 probes instead of 20,000, and the ladder floor read there is
 * the constant residue the whole failing range shares.
 *
 * THE PREDICTION, CHECKED RATHER THAN ASSUMED. `predictedDisagreementWindow`
 * derives the window from the floor arithmetic alone — width = surplus metadata
 * allowance. Every symbol reports predicted AND observed endpoints, and
 * `windowPredictionHolds` is false the moment they part company. A mechanism that
 * only explains the case it was derived from is not a mechanism.
 *
 * THE ONE DECOMPOSITION THAT MAKES THIS MEASURABLE, AND WHY IT IS NOT A CHEAT.
 * `max_tokens` is spent TWICE on this path. The ENGINE spends it at
 * `getImpactGraph.ts:717` (`takePathsWithinTokenBudget`), so the authoritative
 * result is itself a function of the budget in its `paths` dimension; the
 * ENVELOPE then spends it again as the fit budget. A first version of this runner
 * varied the request budget and let both move at once, and it produced two
 * incoherent controls — a "constant residue below the floor" that held for only
 * 14 of 60 symbols, and a window prediction that failed on 18 — because the thing
 * being compared was changing underneath the comparison. Neither was a product
 * defect; both were the instrument measuring the engine and calling it the
 * envelope.
 *
 * M178 is a milestone about the ENVELOPE's fit contract, so the engine is held
 * fixed: one authoritative result per symbol, computed once at a reference
 * budget, and then `limits.maxTokens` — the only budget input
 * `compactImpactProductResponse` reads — is varied over that ONE immutable
 * object. Every difference the runner then reports is a difference the envelope
 * made. The engine-coupled view is not discarded; it is reported separately as
 * `engineCoupled`, where it belongs.
 *
 * §21: this corpus and its selection are frozen here, before any candidate is
 * simulated. §23: the default budget is reported as its own population and never
 * pooled with the pressure budgets.
 *
 * Deterministic, offline, no paid API, no Docker.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ImpactGraphOutput } from "../../src/impact/getImpactGraph";
import { compactImpactProductResponse } from "../../src/impact/impactResponseEnvelope";
import {
  authoritativeImpact,
  openWorkspace,
} from "./m177ImpactEnvelope";
import {
  classify,
  contentIdentity,
  DISAGREEMENT_UNOBSERVABLE_ON_DECLINE,
  isImpactDecline,
  observe,
  predictedDisagreementWindow,
  type ImpactObservation,
} from "./m178FitContract";

const REPO = path.resolve(import.meta.dir, "results/workspaces/m160_broad_b/pytest-dev__pytest-10081");

/** The tool's own default. The only budget that speaks to production frequency. */
const DEFAULT_BUDGET = 1_200;

/** Deliberate pressure. Correctness only — never pooled with the default. §23. */
const PRESSURE_BUDGETS = [1, 50, 200, 400, 800] as const;

const CORPUS_SIZE = 60;

/** Upper bound of the binary search. The tool's own hard bound on `max_tokens`. */
const SEARCH_CEILING = 20_000;

const argOf = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

type Db = ReturnType<typeof openWorkspace>;

/**
 * The reference budget at which each symbol's ONE authoritative result is
 * computed. The tool's default, so the fixed input is the input a caller
 * ordinarily produces rather than a pressure artefact.
 */
const REFERENCE_BUDGET = DEFAULT_BUDGET;

/**
 * Run the REAL product envelope over a FIXED authoritative result at a chosen
 * response budget. `limits.maxTokens` is the sole budget input the envelope
 * reads, so setting it is exactly equivalent to a caller having asked for that
 * budget — with the engine's own spend of `max_tokens` held constant.
 */
function envelopeAt(
  authoritative: ImpactGraphOutput,
  symbolFqn: string,
  maxTokens: number,
): { observation: ImpactObservation; contentHash: string } {
  const draft = structuredClone(authoritative) as ImpactGraphOutput;
  (draft.limits as { maxTokens: number }).maxTokens = maxTokens;
  const response = compactImpactProductResponse(draft);
  return { observation: observe(symbolFqn, maxTokens, response), contentHash: contentIdentity(response) };
}

/** Smallest budget at which the envelope DELIVERS rather than declines. */
function firstDeliveringBudget(authoritative: ImpactGraphOutput, symbolFqn: string): number | null {
  if (envelopeAt(authoritative, symbolFqn, SEARCH_CEILING).observation.declined) return null;
  let low = 1;
  let high = SEARCH_CEILING;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (envelopeAt(authoritative, symbolFqn, mid).observation.declined) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The engine-coupled view, kept because it is what a caller actually experiences:
 * both spends of `max_tokens` move together. Reported separately and never used
 * to characterise the envelope contract.
 */
async function engineCoupledCall(
  db: Db,
  symbolFqn: string,
  maxTokens: number,
): Promise<ImpactObservation | null> {
  const authoritative = await authoritativeImpact(db, REPO, { symbolFqn, maxTokens });
  if (!authoritative.ok || authoritative.output === null) return null;
  return observe(symbolFqn, maxTokens, compactImpactProductResponse(authoritative.output));
}

async function main(): Promise<void> {
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });
  const db = openWorkspace(REPO);

  try {
    // Selection inherited verbatim from M177-E: fixed scan order, fixed per-class
    // quota, first come. Stratified so the empty and small graphs are present —
    // §38's reason, and also this milestone's, since a symbol with nothing in it
    // is the one whose metadata floor is smallest and whose surplus allowance is
    // therefore largest.
    const rows = db.query(
      "SELECT fq_name FROM symbols WHERE fq_name LIKE 'src/_pytest/%' ORDER BY fq_name LIMIT ?",
    ).all(CORPUS_SIZE * 6) as Array<{ fq_name: string }>;

    const PER_CLASS = Math.ceil(CORPUS_SIZE / 4);
    const buckets = new Map<string, Array<{ symbolFqn: string; authoritativeEdges: number; sizeClass: string }>>(
      [["empty", []], ["small", []], ["medium", []], ["large", []]],
    );
    for (const row of rows) {
      if ([...buckets.values()].every((bucket) => bucket.length >= PER_CLASS)) break;
      const authoritative = await authoritativeImpact(db, REPO, { symbolFqn: row.fq_name, maxTokens: DEFAULT_BUDGET });
      if (!authoritative.ok || authoritative.output === null) continue;
      const edges = new Set([
        ...authoritative.output.edges.map((edge) => edge.edgeId),
        ...authoritative.output.directRelations.map((relation) => relation.edgeId ?? relation.id),
      ]).size;
      const sizeClass = edges === 0 ? "empty" : edges <= 4 ? "small" : edges <= 20 ? "medium" : "large";
      const bucket = buckets.get(sizeClass)!;
      if (bucket.length >= PER_CLASS) continue;
      bucket.push({ symbolFqn: row.fq_name, authoritativeEdges: edges, sizeClass });
    }
    const corpus = [...buckets.values()].flat();

    interface SymbolRow {
      readonly symbolFqn: string;
      readonly sizeClass: string;
      readonly authoritativeEdges: number;
      readonly firstDeliveringBudget: number | null;
      readonly modelVisibleFloorTokens: number | null;
      readonly metadataFloorTokens: number | null;
      readonly predictedWindow: { lowBudget: number; highBudget: number; width: number } | null;
      readonly observedWindowLow: number | null;
      readonly observedWindowHigh: number | null;
      readonly windowPredictionHolds: boolean | null;
      readonly monotonic: boolean;
      readonly defaultBudgetClassification: string | null;
      readonly floorContentConstantBelowFloor: boolean | null;
    }

    const symbolRows: SymbolRow[] = [];
    const observations: ImpactObservation[] = [];
    const engineCoupled: ImpactObservation[] = [];

    for (const entry of corpus) {
      // ONE authoritative result per symbol, computed once. Everything below
      // varies only the envelope's budget over this immutable object.
      const reference = await authoritativeImpact(db, REPO, {
        symbolFqn: entry.symbolFqn,
        maxTokens: REFERENCE_BUDGET,
      });
      if (!reference.ok || reference.output === null) continue;
      const authoritative = reference.output;

      // The default budget and the pressure budgets, recorded for every symbol.
      for (const maxTokens of [DEFAULT_BUDGET, ...PRESSURE_BUDGETS]) {
        observations.push(envelopeAt(authoritative, entry.symbolFqn, maxTokens).observation);
        const coupled = await engineCoupledCall(db, entry.symbolFqn, maxTokens);
        if (coupled !== null) engineCoupled.push(coupled);
      }

      const floorBudget = firstDeliveringBudget(authoritative, entry.symbolFqn);
      if (floorBudget === null) {
        symbolRows.push({
          symbolFqn: entry.symbolFqn,
          sizeClass: entry.sizeClass,
          authoritativeEdges: entry.authoritativeEdges,
          firstDeliveringBudget: null,
          modelVisibleFloorTokens: null,
          metadataFloorTokens: null,
          predictedWindow: null,
          observedWindowLow: null,
          observedWindowHigh: null,
          windowPredictionHolds: null,
          monotonic: true,
          defaultBudgetClassification: null,
          floorContentConstantBelowFloor: null,
        });
        continue;
      }

      const atFloor = envelopeAt(authoritative, entry.symbolFqn, floorBudget);
      const modelVisibleFloorTokens = atFloor.observation.modelVisibleEstimatedTokens;
      const metadataFloorTokens = atFloor.observation.metadataEstimatedTokens;
      const predicted = predictedDisagreementWindow(modelVisibleFloorTokens, metadataFloorTokens);

      // Walk the predicted window and one budget past each end. If the mechanism
      // is right, every budget inside is `emitted_with_ladder_gate_false`, the
      // budget below declines, and the budget above agrees.
      let observedWindowLow: number | null = null;
      let observedWindowHigh: number | null = null;
      // Every budget from one below the predicted window to one above it. The
      // window is narrow (it is the surplus metadata allowance), so this is an
      // exhaustive walk rather than a sample.
      {
        const from = Math.max(1, predicted.lowBudget - 1);
        const to = Math.min(SEARCH_CEILING, Math.max(predicted.highBudget + 1, from + 1));
        for (let budget = from; budget <= to; budget += 1) {
          const probe = envelopeAt(authoritative, entry.symbolFqn, budget);
          observations.push(probe.observation);
          if (probe.observation.classification === "emitted_with_ladder_gate_false") {
            observedWindowLow = observedWindowLow === null ? budget : Math.min(observedWindowLow, budget);
            observedWindowHigh = observedWindowHigh === null ? budget : Math.max(observedWindowHigh, budget);
          }
        }
      }

      // Monotonicity control: the terminal state must never get weaker as the
      // budget grows. Checked on the probes already taken for this symbol.
      const forSymbol = observations
        .filter((row) => row.symbolFqn === entry.symbolFqn)
        .sort((left, right) => left.maxTokens - right.maxTokens);
      let monotonic = true;
      for (let index = 1; index < forSymbol.length; index += 1) {
        if (forSymbol[index - 1].declined === false && forSymbol[index].declined === true) monotonic = false;
      }

      // §15's rule applied to the floor claim: the residue below the floor must
      // really be constant, or "the floor is a constant draft" is an assumption.
      let floorContentConstantBelowFloor: boolean | null = null;
      if (floorBudget > 2) {
        const a = envelopeAt(authoritative, entry.symbolFqn, 1);
        const b = envelopeAt(authoritative, entry.symbolFqn, floorBudget - 1);
        floorContentConstantBelowFloor = a.contentHash === b.contentHash;
      }

      const defaultRow = observations.find(
        (row) => row.symbolFqn === entry.symbolFqn && row.maxTokens === DEFAULT_BUDGET,
      );

      symbolRows.push({
        symbolFqn: entry.symbolFqn,
        sizeClass: entry.sizeClass,
        authoritativeEdges: entry.authoritativeEdges,
        firstDeliveringBudget: floorBudget,
        modelVisibleFloorTokens,
        metadataFloorTokens,
        predictedWindow: predicted,
        observedWindowLow,
        observedWindowHigh,
        windowPredictionHolds: predicted === null
          ? null
          : predicted.width === 0
            ? observedWindowLow === null
            : observedWindowLow === predicted.lowBudget && observedWindowHigh === predicted.highBudget,
        monotonic,
        defaultBudgetClassification: defaultRow?.classification ?? null,
        floorContentConstantBelowFloor,
      });
    }

    const tally = (rows: readonly ImpactObservation[]): Record<string, number> => {
      const counts: Record<string, number> = {
        agree_normal: 0,
        emitted_with_ladder_gate_false: 0,
        emitted_with_terminal_gate_false: 0,
        [DISAGREEMENT_UNOBSERVABLE_ON_DECLINE]: 0,
      };
      for (const row of rows) counts[row.classification] += 1;
      return counts;
    };

    const defaultBudgetRows = observations.filter((row) => row.maxTokens === DEFAULT_BUDGET);
    const pressureRows = observations.filter((row) => row.maxTokens !== DEFAULT_BUDGET);

    const manifest = {
      milestone: "M178-B",
      generatedFrom: "run_stage5_m178_disagreement.ts",
      repo: REPO,
      corpusSize: corpus.length,
      defaultBudget: DEFAULT_BUDGET,
      pressureBudgets: PRESSURE_BUDGETS,
      searchCeiling: SEARCH_CEILING,
      selection: "src/_pytest/% ordered by fq_name, stratified by authoritative edge count, first come",
      corpus,
    };

    const results = {
      milestone: "M178-B",
      totalObservations: observations.length,
      // §23 — the two populations are never pooled.
      defaultBudget: {
        budget: DEFAULT_BUDGET,
        observations: defaultBudgetRows.length,
        classifications: tally(defaultBudgetRows),
      },
      pressureBudgets: {
        observations: pressureRows.length,
        classifications: tally(pressureRows),
      },
      windowPrediction: {
        symbolsWithFloor: symbolRows.filter((row) => row.firstDeliveringBudget !== null).length,
        symbolsWithNonEmptyPredictedWindow: symbolRows.filter((row) => (row.predictedWindow?.width ?? 0) > 0).length,
        predictionHolds: symbolRows.filter((row) => row.windowPredictionHolds === true).length,
        predictionFails: symbolRows.filter((row) => row.windowPredictionHolds === false).length,
        maxModelVisibleFloorTokens: Math.max(
          0,
          ...symbolRows.map((row) => row.modelVisibleFloorTokens ?? 0),
        ),
      },
      // The caller-experienced view, where the engine's spend of max_tokens and
      // the envelope's move together. Reported, never used to characterise the
      // envelope contract. See the header.
      engineCoupled: {
        observations: engineCoupled.length,
        classifications: tally(engineCoupled),
        defaultBudget: tally(engineCoupled.filter((row) => row.maxTokens === DEFAULT_BUDGET)),
      },
      controls: {
        monotonicSymbols: symbolRows.filter((row) => row.monotonic).length,
        nonMonotonicSymbols: symbolRows.filter((row) => !row.monotonic).length,
        floorResidueConstantChecked: symbolRows.filter((row) => row.floorContentConstantBelowFloor !== null).length,
        floorResidueConstantHeld: symbolRows.filter((row) => row.floorContentConstantBelowFloor === true).length,
      },
      symbols: symbolRows,
      observations,
    };

    writeFileSync(path.join(out, "stage5_m178_disagreement_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(out, "stage5_m178_disagreement_results.json"), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(
      path.join(out, "stage5_m178_default_budget_disagreements.json"),
      `${JSON.stringify({
        milestone: "M178-B",
        budget: DEFAULT_BUDGET,
        observations: defaultBudgetRows.length,
        classifications: tally(defaultBudgetRows),
        disagreements: defaultBudgetRows.filter((row) => row.classification === "emitted_with_ladder_gate_false"),
      }, null, 2)}\n`,
    );

    console.log(JSON.stringify({
      corpus: corpus.length,
      totalObservations: observations.length,
      defaultBudget: tally(defaultBudgetRows),
      pressure: tally(pressureRows),
      windowPrediction: results.windowPrediction,
      engineCoupled: results.engineCoupled,
      controls: results.controls,
    }, null, 2));
  } finally {
    db.close();
  }
}

await main();
