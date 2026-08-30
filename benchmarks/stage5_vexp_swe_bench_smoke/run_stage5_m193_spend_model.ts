/**
 * M193 §12 — derive the per-run and total live-spend ceilings from the
 * historical cost distribution of untreated `claude-code` baseline arms.
 *
 * Deterministic. Reads only captured artifacts; invokes no model.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_spend_model.ts
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { M193_LIMITS } from "./m193Acquisition";

const RESULTS = join(import.meta.dir, "results");
const RUNS = join(RESULTS, "runs");
const OUT = join(RESULTS, "stage5_m193_spend_model.json");

/** The model the acquisition is pinned to; a cap derived from a different
 *  model's economics would not bind this experiment. */
const PINNED_MODEL = "claude-opus-4-5-20251101";

interface Row {
  runLabel: string;
  condition: string;
  instanceId: string;
  model: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  resolved: boolean | null;
  /** §34 — a run labelled "baseline" is not automatically untreated. */
  treatmentState: "UNTREATED_CONFIRMED" | "TREATED" | "TREATMENT_STATE_UNKNOWN";
  treatmentMarkers: string[];
}

/**
 * A historical arm sitting in a directory called `baseline` is not evidence
 * that it was untreated. Stage 5 injected a shared tool-use-discipline block
 * and, later, an M163 orientation trigger into arms of every condition. Cost
 * derived from those arms is not baseline cost, so they are excluded here and
 * the exclusion is declared rather than silent.
 */
function classifyTreatment(metaPath: string): {
  treatmentState: Row["treatmentState"];
  treatmentMarkers: string[];
} {
  if (!existsSync(metaPath)) return { treatmentState: "TREATMENT_STATE_UNKNOWN", treatmentMarkers: [] };
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { treatmentState: "TREATMENT_STATE_UNKNOWN", treatmentMarkers: [] };
  }
  const markers: string[] = [];
  if (m.stage5ToolUseDisciplineInjected === true) markers.push("stage5ToolUseDisciplineInjected");
  if (m.stage5M163TriggerInjected === true) markers.push("stage5M163TriggerInjected");
  if (m.vtraceContextInjected === true) markers.push("vtraceContextInjected");
  if (typeof m.vtraceEffectiveCapsuleEngine === "string" && m.vtraceEffectiveCapsuleEngine.length > 0) {
    markers.push("vtraceEffectiveCapsuleEngine");
  }
  if (markers.length > 0) return { treatmentState: "TREATED", treatmentMarkers: markers };

  // Untreated is only claimable when the flags are present and false.
  const declared =
    m.stage5ToolUseDisciplineInjected === false && m.stage5M163TriggerInjected === false;
  return declared
    ? { treatmentState: "UNTREATED_CONFIRMED", treatmentMarkers: [] }
    : { treatmentState: "TREATMENT_STATE_UNKNOWN", treatmentMarkers: [] };
}

function readRows(): Row[] {
  const rows: Row[] = [];
  if (!existsSync(RUNS)) return rows;
  for (const label of readdirSync(RUNS).sort()) {
    const raw = join(RUNS, label, "raw");
    if (!existsSync(raw)) continue;
    for (const condition of readdirSync(raw).sort()) {
      const dir = join(raw, condition);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const { treatmentState, treatmentMarkers } = classifyTreatment(join(dir, "_run.meta.json"));
      for (const f of files) {
        if (!f.startsWith("swebench-") || !f.endsWith(".jsonl")) continue;
        let text: string;
        try {
          text = readFileSync(join(dir, f), "utf8");
        } catch {
          continue;
        }
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let d: Record<string, unknown>;
          try {
            d = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof d.costUsd !== "number") continue;
          rows.push({
            runLabel: label,
            condition,
            instanceId: String(d.instanceId ?? ""),
            model: String(d.model ?? ""),
            costUsd: d.costUsd,
            numTurns: typeof d.numTurns === "number" ? d.numTurns : -1,
            durationMs: typeof d.durationMs === "number" ? d.durationMs : -1,
            resolved: typeof d.resolved === "boolean" ? d.resolved : d.resolved === "true" ? true : d.resolved === "false" ? false : null,
            treatmentState,
            treatmentMarkers,
          });
        }
      }
    }
  }
  return rows;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)));
  return sorted[i]!;
}

function describe(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? null,
    p50: quantile(s, 0.5),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    p95: quantile(s, 0.95),
    p99: quantile(s, 0.99),
    max: s[s.length - 1] ?? null,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
    sum: s.reduce((a, b) => a + b, 0),
  };
}

const all = readRows();
const baseline = all.filter((r) => r.condition === "baseline");
const pinned = baseline.filter((r) => r.model === PINNED_MODEL);

const untreated = pinned.filter((r) => r.treatmentState === "UNTREATED_CONFIRMED");
const treated = pinned.filter((r) => r.treatmentState === "TREATED");
const unknown = pinned.filter((r) => r.treatmentState === "TREATMENT_STATE_UNKNOWN");

// The cap is derived from the untreated stratum, because that is the condition
// M194 will actually run. The other strata are reported so that no expensive
// run is hidden by the stratification (§12).
const costs = describe(untreated.map((r) => r.costUsd));
const turns = describe(untreated.map((r) => r.numTurns).filter((n) => n >= 0));
const durations = describe(untreated.map((r) => r.durationMs).filter((n) => n >= 0));

const perRunCap = M193_LIMITS.perRunCostCapUsd;
const totalCap = M193_LIMITS.totalSpendCapUsd;
const maxArms = M193_LIMITS.maxArms;

const truncatedUntreated = untreated.filter((r) => r.costUsd > perRunCap);
const truncatedAnyStratum = pinned.filter((r) => r.costUsd > perRunCap);

const projected = {
  atUntreatedMean: (costs.mean ?? 0) * maxArms,
  atUntreatedP50: costs.p50 * maxArms,
  atUntreatedP90: costs.p90 * maxArms,
  atUntreatedP95: costs.p95 * maxArms,
  atPerRunCap: perRunCap * maxArms,
};

const model = {
  schemaVersion: "stage5.m193.spend-model.v2",
  milestone: "M193",
  purpose:
    "Derive the frozen per-run and total live-spend ceilings from the historical cost distribution of GENUINELY UNTREATED claude-code baseline arms, before any M193/M194 live spend.",
  pinnedModel: PINNED_MODEL,
  population: {
    rule:
      "every captured run row under results/runs/*/raw/baseline/swebench-*.jsonl carrying a numeric costUsd on the pinned model, stratified by the treatment markers each arm recorded about itself in its own _run.meta.json",
    totalRowsScanned: all.length,
    baselineConditionRows: baseline.length,
    pinnedModelRows: pinned.length,
    strata: {
      UNTREATED_CONFIRMED: untreated.length,
      TREATED: treated.length,
      TREATMENT_STATE_UNKNOWN: unknown.length,
    },
    capDerivedFrom: "UNTREATED_CONFIRMED",
    declaredExclusions: [
      {
        stratum: "TREATED",
        rows: treated.length,
        reason:
          "these arms sit in a directory called baseline but their own meta records an injected tool-use-discipline block, an M163 orientation trigger, or VTRACE context. Their cost is not baseline cost.",
        markerCounts: treated.reduce<Record<string, number>>((acc, r) => {
          for (const m of r.treatmentMarkers) acc[m] = (acc[m] ?? 0) + 1;
          return acc;
        }, {}),
      },
      {
        stratum: "TREATMENT_STATE_UNKNOWN",
        rows: unknown.length,
        reason:
          "the arm predates the treatment-marker telemetry, so it cannot assert its own condition. Reported, not used to set the cap.",
      },
    ],
    costBasedExclusions: [],
    costBasedExclusionNote:
      "No row is excluded for being expensive. §12 forbids that, and the most expensive untreated arm on record is precisely what the per-run cap is set above.",
  },
  costUsd: costs,
  numTurns: turns,
  durationMs: durations,
  strataCostComparison: {
    UNTREATED_CONFIRMED: describe(untreated.map((r) => r.costUsd)),
    TREATED: describe(treated.map((r) => r.costUsd)),
    TREATMENT_STATE_UNKNOWN: describe(unknown.map((r) => r.costUsd)),
    ALL_PINNED: describe(pinned.map((r) => r.costUsd)),
  },
  mostExpensiveUntreated: [...untreated]
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 8)
    .map((r) => ({ instanceId: r.instanceId, costUsd: r.costUsd, numTurns: r.numTurns, runLabel: r.runLabel })),
  mostExpensiveAnyStratum: [...pinned]
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 8)
    .map((r) => ({
      instanceId: r.instanceId,
      costUsd: r.costUsd,
      numTurns: r.numTurns,
      runLabel: r.runLabel,
      treatmentState: r.treatmentState,
    })),
  frozenCaps: {
    perRunCostCapUsd: perRunCap,
    totalSpendCapUsd: totalCap,
    maxArms,
    perRunCapRationale:
      "Set strictly above the maximum cost ever observed on an untreated arm, and above the maximum across every stratum, so that no arm resembling anything already recorded is truncated. A cap at the untreated p95, or at the VEXP shipped default of $3.00, would have truncated observed runs.",
    totalCapRationale:
      "Covers the pessimistic case in which every one of the maximum arms costs the untreated p95, with headroom, while sitting far below maxArms x perRunCap. It binds only if per-arm cost regresses well beyond anything on record, which is what a total cap is for. Expected spend is roughly the mean projection, not this ceiling.",
    armsWouldHaveBeenTruncatedUntreated: truncatedUntreated.length,
    armsWouldHaveBeenTruncatedAnyStratum: truncatedAnyStratum.length,
    truncationRateUntreated: untreated.length ? truncatedUntreated.length / untreated.length : null,
    truncatedInstances: truncatedAnyStratum.map((r) => ({
      instanceId: r.instanceId,
      costUsd: r.costUsd,
      treatmentState: r.treatmentState,
    })),
  },
  projectedTotalSpendUsd: projected,
  worstCaseUnderCaps: {
    note: "maxArms x perRunCap exceeds the total cap; the total cap stops the acquisition first.",
    maxArmsTimesPerRunCap: perRunCap * maxArms,
    bindingCeiling: Math.min(perRunCap * maxArms, totalCap),
    p95EverywhereIsCovered: projected.atUntreatedP95 <= totalCap,
  },
  m193LiveSpendUsd: 0,
};

writeFileSync(OUT, `${JSON.stringify(model, null, 2)}\n`);
console.log(`wrote ${OUT}`);
console.log(
  `strata: untreated=${untreated.length} treated=${treated.length} unknown=${unknown.length} (of ${pinned.length} pinned-model baseline rows)`,
);
console.log(
  `untreated cost: median $${costs.p50.toFixed(4)}  p90 $${costs.p90.toFixed(4)}  p95 $${costs.p95.toFixed(4)}  max $${(costs.max ?? 0).toFixed(4)}  mean $${(costs.mean ?? 0).toFixed(4)}`,
);
console.log(
  `per-run cap $${perRunCap.toFixed(2)}: truncates ${truncatedUntreated.length}/${untreated.length} untreated, ${truncatedAnyStratum.length}/${pinned.length} across all strata`,
);
console.log(
  `projected total over ${maxArms} arms: mean $${projected.atUntreatedMean.toFixed(2)}  p90-everywhere $${projected.atUntreatedP90.toFixed(2)}  p95-everywhere $${projected.atUntreatedP95.toFixed(2)}  cap $${totalCap}`,
);
