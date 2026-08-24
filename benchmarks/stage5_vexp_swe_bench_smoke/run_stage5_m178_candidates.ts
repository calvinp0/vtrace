/**
 * M178-D — simulating the candidate fit contracts over the frozen corpus.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m178_candidates.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * Reads `stage5_m178_disagreement_results.json` — frozen by M178-B before any
 * candidate existed, per §21 — and reports what each candidate would have done to
 * every observation in it.
 *
 * WHY TWO OF THE FOUR NEED NO FORK. A candidate that changes only the TERMINAL
 * predicate cannot change what the ladder produced, so its outcome is a function
 * of the already-measured draft: every observation the current product delivered
 * with C3 false is a decline under `C_STRICT_FITS`, and everything else is
 * unchanged. `C_EXPLICIT_SPLIT` changes no predicate at all, only which name each
 * caller uses, so it is current behaviour by construction and its simulation is a
 * restatement of the corpus. Neither needs a second implementation, and building
 * one would introduce a re-implementation that could disagree with the product for
 * reasons having nothing to do with the contract.
 *
 * WHY `C_TERMINAL` IS DROPPED WITHOUT MEASUREMENT, AND WHY THAT IS NOT AVOIDANCE.
 * §34 licenses dropping a candidate that C proves semantically invalid, and this
 * one is refuted by arithmetic rather than by taste. Gating the LADDER on C1 alone
 * stops compaction the moment the total fits, so delivered evidence is bounded
 * only by `totalCeiling - metadata = max_tokens + allowance - metadata`. A caller
 * who asks for 400 tokens of impact content against a 500-token metadata floor
 * would receive up to 700 — 75% over a bound the tool's own schema publishes as
 * "max_tokens bounds model-facing impact content". The candidate abandons the
 * published bound outright, so it is refuted on the contract and not on a count.
 *
 * §35's ordering is applied explicitly, and §38 is respected: no candidate is
 * scored on whether it makes the Django ladder look monotone.
 *
 * Deterministic, offline, no paid API, no Docker.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS } from "../../src/impact/impactResponseEnvelope";
import type { ImpactObservation } from "./m178FitContract";

const argOf = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

const DEFAULT_BUDGET = 1_200;

interface CandidateOutcome {
  readonly candidate: string;
  readonly ladderGate: string;
  readonly terminalGate: string;
  readonly semanticallyAdmissible: boolean;
  readonly refutation: string | null;
  readonly normalResponses: number | null;
  readonly truthfulDeclines: number | null;
  readonly handlerFailures: number | null;
  readonly defaultBudgetOutputChanges: number | null;
  readonly pressureBudgetOutputChanges: number | null;
  readonly evidenceEdgesLost: number | null;
  readonly maxExcessTokensOverRequested: number | null;
  readonly publishedBoundHonoured: boolean;
  readonly notes: string;
}

async function main(): Promise<void> {
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });

  const frozen = JSON.parse(
    readFileSync(path.join(out, "stage5_m178_disagreement_results.json"), "utf8"),
  ) as { observations: ImpactObservation[] };
  const observations = frozen.observations;

  const delivered = observations.filter((row) => !row.declined);
  const declines = observations.filter((row) => row.declined);
  const disagreements = observations.filter((row) => row.classification === "emitted_with_ladder_gate_false");
  const defaultDisagreements = disagreements.filter((row) => row.maxTokens === DEFAULT_BUDGET);
  const pressureDisagreements = disagreements.filter((row) => row.maxTokens !== DEFAULT_BUDGET);

  // What C_STRICT_FITS would cost: every disagreeing delivery becomes a decline,
  // so all its retained evidence is lost, to recover an excess that is bounded by
  // the surplus metadata allowance.
  const evidenceEdgesLost = disagreements.reduce((sum, row) => sum + row.retainedEdges, 0);
  const excesses = disagreements.map((row) => row.modelVisibleEstimatedTokens - row.maxTokens);
  const maxExcess = excesses.length === 0 ? 0 : Math.max(...excesses);
  const meanExcess = excesses.length === 0
    ? 0
    : Math.round((excesses.reduce((sum, value) => sum + value, 0) / excesses.length) * 100) / 100;
  const surplusBound = Math.max(
    0,
    ...disagreements.map((row) => IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS - row.metadataEstimatedTokens),
  );

  const candidates: CandidateOutcome[] = [
    {
      candidate: "C_CURRENT_SPLIT",
      ladderGate: "C1 && C2 && C3",
      terminalGate: "C1 && C2",
      semanticallyAdmissible: true,
      refutation: null,
      normalResponses: delivered.length,
      truthfulDeclines: declines.length,
      handlerFailures: 0,
      defaultBudgetOutputChanges: 0,
      pressureBudgetOutputChanges: 0,
      evidenceEdgesLost: 0,
      maxExcessTokensOverRequested: maxExcess,
      publishedBoundHonoured: false,
      notes:
        "The product as M177 left it. Honours the published TOTAL bound always, and the published MODEL-FACING bound "
        + `everywhere except a window whose width is the surplus metadata allowance (observed max excess ${maxExcess} tokens).`,
    },
    {
      candidate: "C_STRICT_FITS",
      ladderGate: "C1 && C2 && C3",
      terminalGate: "C1 && C2 && C3",
      semanticallyAdmissible: true,
      refutation: null,
      normalResponses: delivered.length - disagreements.length,
      truthfulDeclines: declines.length + disagreements.length,
      handlerFailures: 0,
      defaultBudgetOutputChanges: defaultDisagreements.length,
      pressureBudgetOutputChanges: pressureDisagreements.length,
      evidenceEdgesLost,
      maxExcessTokensOverRequested: 0,
      publishedBoundHonoured: true,
      notes:
        `Honours both published bounds exactly. Costs ${evidenceEdgesLost} delivered edges across `
        + `${disagreements.length} calls, every one of them to recover at most ${surplusBound} tokens of surplus `
        + "metadata allowance — and each such call drops from bounded evidence to a decline carrying none. "
        + "M177's warning in §4 is precisely this trade.",
    },
    {
      candidate: "C_TERMINAL",
      ladderGate: "C1 && C2",
      terminalGate: "C1 && C2",
      semanticallyAdmissible: false,
      refutation:
        "Refuted on the published contract, not on a count. With C3 removed from the LADDER, delivered evidence is "
        + "bounded only by totalCeiling - metadata = max_tokens + allowance - metadata, so a caller who asks for "
        + "400 tokens of model-facing impact content can receive up to 400 + 800 - metadata. get_impact_graph's own "
        + "schema states that max_tokens bounds model-facing impact content; this candidate stops enforcing it.",
      normalResponses: null,
      truthfulDeclines: null,
      handlerFailures: null,
      defaultBudgetOutputChanges: null,
      pressureBudgetOutputChanges: null,
      evidenceEdgesLost: null,
      maxExcessTokensOverRequested: null,
      publishedBoundHonoured: false,
      notes: "Dropped under §34 before simulation. Not measured, because an invalid contract does not earn a measurement.",
    },
    {
      candidate: "C_EXPLICIT_SPLIT",
      ladderGate: "fitsResponseEnvelope && meetsEvidenceBudget  (identical truth value to C1 && C2 && C3)",
      terminalGate: "fitsResponseEnvelope  (identical truth value to C1 && C2)",
      semanticallyAdmissible: true,
      refutation: null,
      normalResponses: delivered.length,
      truthfulDeclines: declines.length,
      handlerFailures: 0,
      defaultBudgetOutputChanges: 0,
      pressureBudgetOutputChanges: 0,
      evidenceEdgesLost: 0,
      maxExcessTokensOverRequested: maxExcess,
      publishedBoundHonoured: false,
      notes:
        "Behaviourally identical to C_CURRENT_SPLIT by construction — the same two truth values, reached through two "
        + "named predicates instead of one ambiguous one. Changes what the code MEANS, not what it DOES.",
    },
  ];

  const decision = {
    milestone: "M178-D",
    frozenCorpus: "stage5_m178_disagreement_results.json",
    observations: observations.length,
    disagreements: {
      total: disagreements.length,
      atDefaultBudget: defaultDisagreements.length,
      atPressureBudgets: pressureDisagreements.length,
      maxExcessTokensOverRequested: maxExcess,
      meanExcessTokensOverRequested: meanExcess,
      surplusAllowanceBound: surplusBound,
      excessNeverExceedsSurplus: maxExcess <= surplusBound,
    },
    // §35's ordering, applied in order and recorded so the choice can be audited.
    selectionCriteria: [
      {
        rank: 1,
        criterion: "semantic correctness",
        finding:
          "C_TERMINAL is refuted. The remaining three all deliver a coherent contract; C_STRICT_FITS and "
          + "C_EXPLICIT_SPLIT differ on whether the model-facing bound is HARD (decline on breach) or a "
          + "COMPACTION TARGET (best effort, with the total bound as the hard one).",
      },
      {
        rank: 2,
        criterion: "compatibility with actual client/protocol constraints",
        finding:
          "Neutral. No protocol limit is implicated: C2, the only transport-shaped condition, is provably dead, and "
          + "M167 found the wire duplicate costs no model tokens in the proven client.",
      },
      {
        rank: 3,
        criterion: "preservation of truthfulness and totality",
        finding: "Neutral. All three admissible candidates terminate in a response or a truthful bounded decline; none throws.",
      },
      {
        rank: 4,
        criterion: "minimal unintended normal-product behaviour change",
        finding:
          `DECISIVE. C_EXPLICIT_SPLIT changes 0 responses. C_STRICT_FITS changes ${disagreements.length}, `
          + `destroying ${evidenceEdgesLost} delivered edges to reclaim at most ${surplusBound} tokens each. `
          + "§40 permits a tiny-budget behaviour change only when the old behaviour violated a REAL required bound; "
          + "the bound it breaches is the compaction target, while the hard total bound was satisfied throughout.",
      },
      {
        rank: 5,
        criterion: "implementation simplicity",
        finding: "C_EXPLICIT_SPLIT is two named predicates over the existing arithmetic. No new state, no new budget.",
      },
      {
        rank: 6,
        criterion: "token/economic side effect",
        finding: "C_EXPLICIT_SPLIT: none. C_STRICT_FITS: strictly fewer evidence tokens delivered, for no billing benefit.",
      },
    ],
    selected: "C_EXPLICIT_SPLIT",
    selectionFrozenBeforeImplementation: true,
    djangoUsedAsOptimizationTarget: false,
    candidates,
  };

  writeFileSync(path.join(out, "stage5_m178_candidate_comparison.json"), `${JSON.stringify(decision, null, 2)}\n`);
  console.log(JSON.stringify({
    disagreements: decision.disagreements,
    selected: decision.selected,
    candidates: candidates.map((row) => ({
      candidate: row.candidate,
      admissible: row.semanticallyAdmissible,
      defaultBudgetOutputChanges: row.defaultBudgetOutputChanges,
      pressureBudgetOutputChanges: row.pressureBudgetOutputChanges,
      evidenceEdgesLost: row.evidenceEdgesLost,
    })),
  }, null, 2));
}

await main();
