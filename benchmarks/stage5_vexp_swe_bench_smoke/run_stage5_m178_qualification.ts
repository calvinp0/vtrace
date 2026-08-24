/**
 * M178-F — the `run_pipeline` arm, and the Django monotonicity re-observation.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m178_qualification.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * TWO QUESTIONS, AND ONLY THE FIRST IS M178'S.
 *
 * 1. DOES `run_pipeline` HAVE THE DISAGREEMENT AT ALL? It carries the same two
 *    bounds — `max_tokens` on the model-visible context, and a larger ceiling on
 *    the complete serialized response — but enforces them in two SEPARATE
 *    components: `budgetDelivery.ts` packs to the first, `responseEnvelope.ts`
 *    gates on the second, and its escalation ladder tests the very condition its
 *    terminal tests. If the structural claim in M178-C is right, that design
 *    should have no analogue of the impact path's window: no response should ever
 *    be delivered carrying more model-visible context than the caller asked for.
 *    That is a prediction about a DIFFERENT implementation than the one the
 *    mechanism was derived from, which is the only kind worth checking.
 *
 * 2. DOES THE DJANGO SEQUENCE STILL REPRODUCE? §51 and §82 require it re-measured
 *    and §59 forbids tuning it. M178 changed no packing, no ordering and no
 *    selection, so the expected answer is that it reproduces unchanged and M179
 *    stays licensed. It is reported as an OBSERVATION and nothing here is scored
 *    on it (§38).
 *
 * The snapshots are M176's, replayed through the current envelope. They are
 * captured authoritative `run_pipeline` results, so no index, no agent and no
 * network is involved.
 *
 * Deterministic, offline, no paid API, no Docker.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { McpResponseDetail, compactProductResponse } from "../../src/mcp/responseEnvelope";
import { projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { pipelineDeliveryFits, pipelineEnvelopeFits } from "./m178FitContract";

const SNAPSHOTS = path.resolve(import.meta.dir, "results/_m176_snapshots");

/** M176's grid, so the sequence is re-read exactly where it was recorded. */
const BUDGETS = [0, 50, 100, 150, 200, 400, 600, 800, 1_000, 1_600, 3_200, 6_400, 8_000, 16_000, 32_000, 64_000] as const;

/** The five budgets §82 names. */
const DJANGO_SEQUENCE = [400, 600, 800, 1_000, 1_600] as const;

/** refused < decline < orientation. A weaker state at a larger budget is a violation. */
const RANK = { refused: 0, decline: 1, orientation: 2 } as const;

const argOf = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

interface Rung {
  readonly budget: number;
  readonly state: string;
  readonly rank: number;
  readonly modelVisibleTokens: number | null;
  readonly totalTokens: number | null;
  readonly ceiling: number | null;
  readonly deliveryContractHolds: boolean | null;
  readonly envelopeContractHolds: boolean | null;
  readonly declined: boolean;
  readonly threw: string | null;
}

function step(snapshot: unknown, budget: number): Rung {
  const draft = structuredClone(snapshot) as Record<string, unknown>;
  delete draft.responseBudget;
  try {
    const response = compactProductResponse(draft, {
      requestedContextTokens: budget,
      detail: McpResponseDetail.Standard,
    }) as Record<string, unknown> & { responseBudget: Parameters<typeof pipelineEnvelopeFits>[0] };
    const accounting = response.responseBudget;
    const productContext = response.productContext as
      { resultState?: unknown; diagnostics?: { envelopeDecline?: unknown } } | undefined;
    const declined = productContext?.diagnostics?.envelopeDecline === true;
    const oriented = projectRunPipelineOrientation(response) !== null;
    return {
      budget,
      state: oriented ? "orientation" : `${String(productContext?.resultState)}${declined ? "+envelopeDecline" : ""}`,
      rank: oriented ? RANK.orientation : RANK.decline,
      modelVisibleTokens: accounting.estimated_model_visible_tokens,
      totalTokens: accounting.estimated_total_response_tokens,
      ceiling: accounting.total_response_token_ceiling,
      deliveryContractHolds: pipelineDeliveryFits(accounting),
      envelopeContractHolds: pipelineEnvelopeFits(accounting),
      declined,
      threw: null,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      budget,
      state: `throw:${message}`,
      rank: RANK.refused,
      modelVisibleTokens: null,
      totalTokens: null,
      ceiling: null,
      deliveryContractHolds: null,
      envelopeContractHolds: null,
      declined: false,
      threw: message,
    };
  }
}

async function main(): Promise<void> {
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });

  const files = readdirSync(SNAPSHOTS).filter((name) => name.endsWith(".json")).sort();
  const cases: Array<Record<string, unknown>> = [];

  let observations = 0;
  let deliveryContractViolations = 0;
  let envelopeContractViolations = 0;
  let handlerFailures = 0;
  let declines = 0;
  let monotonicityViolations = 0;

  for (const file of files) {
    const wrapper = JSON.parse(readFileSync(path.join(SNAPSHOTS, file), "utf8")) as { snapshot?: unknown };
    const snapshot = wrapper.snapshot;
    if (snapshot === undefined || snapshot === null) continue;

    const ladder = BUDGETS.map((budget) => step(snapshot, budget));
    const violations: number[] = [];
    for (let index = 1; index < ladder.length; index += 1) {
      if (ladder[index].rank < ladder[index - 1].rank) violations.push(ladder[index].budget);
    }
    monotonicityViolations += violations.length;

    for (const rung of ladder) {
      observations += 1;
      if (rung.threw !== null) handlerFailures += 1;
      if (rung.declined) declines += 1;
      // The disagreement class, transposed to this path: delivered normally while
      // the model-visible context exceeds the caller's max_tokens.
      if (!rung.declined && rung.threw === null && rung.deliveryContractHolds === false) {
        deliveryContractViolations += 1;
      }
      if (!rung.declined && rung.threw === null && rung.envelopeContractHolds === false) {
        envelopeContractViolations += 1;
      }
    }

    cases.push({
      instanceId: file.replace(/\.json$/, ""),
      monotonicityViolationsAtBudgets: violations,
      ladder,
    });
  }

  const django = cases.find((row) => row.instanceId === "django__django-10880");
  const djangoLadder = (django?.ladder ?? []) as Rung[];
  const djangoSequence = DJANGO_SEQUENCE.map((budget) => {
    const rung = djangoLadder.find((row) => row.budget === budget);
    return { budget, state: rung?.state ?? "not_measured", modelVisibleTokens: rung?.modelVisibleTokens ?? null };
  });
  const djangoNonMonotone = djangoSequence.some((row, index) =>
    index > 0 && RANK[row.state as keyof typeof RANK] !== undefined);

  const report = {
    milestone: "M178-F",
    generatedFrom: "run_stage5_m178_qualification.ts",
    snapshots: files.length,
    budgets: BUDGETS,

    // Question 1 — the structural prediction about the OTHER implementation.
    pipelineFitContract: {
      observations,
      // A response delivered carrying more model-visible context than requested.
      // The impact path's window, transposed. Expected 0: the two bounds are
      // enforced by two components here, and the packer shrinks to the first.
      deliveryContractViolations,
      envelopeContractViolations,
      predictionHolds: deliveryContractViolations === 0,
      interpretation: deliveryContractViolations === 0
        ? "run_pipeline has NO analogue of the impact disagreement window: its evidence budget is enforced "
          + "by a separate packer that sheds to zero rather than overshoot, so no surplus metadata allowance "
          + "is ever available to the evidence channel."
        : "run_pipeline DOES deliver responses over max_tokens; the two-component claim in M178-C is incomplete.",
    },

    // §55 totality tally.
    totality: {
      validRequests: observations,
      normalResponses: observations - declines - handlerFailures,
      truthfulDeclines: declines,
      handlerFailures,
      unreachableStates: handlerFailures,
    },

    // Question 2 — observation only. §59 forbids tuning; §65 forbids claiming a fix.
    djangoMonotonicity: {
      instanceId: "django__django-10880",
      sequence: djangoSequence,
      violationsAcrossFullGrid: (django?.monotonicityViolationsAtBudgets ?? []) as number[],
      stillReproduces: ((django?.monotonicityViolationsAtBudgets ?? []) as number[]).length > 0,
      note: "M178 changed no packing, ordering or selection. Reported, never tuned.",
      reproduced: djangoNonMonotone,
    },

    monotonicityViolationsAcrossCorpus: monotonicityViolations,
    cases,
  };

  writeFileSync(path.join(out, "stage5_m178_pipeline_qualification.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    pipelineFitContract: report.pipelineFitContract,
    totality: report.totality,
    djangoMonotonicity: {
      sequence: report.djangoMonotonicity.sequence,
      violationsAcrossFullGrid: report.djangoMonotonicity.violationsAcrossFullGrid,
      stillReproduces: report.djangoMonotonicity.stillReproduces,
    },
    monotonicityViolationsAcrossCorpus: report.monotonicityViolationsAcrossCorpus,
  }, null, 2));
}

await main();
