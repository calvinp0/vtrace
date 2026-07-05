// Stage 5 M106 — pure helpers for the 24-case live-confirmation extension:
// deterministic pre-registered case selection, the committed-M105-artifact
// reuse adapter, and combined (M105 n=14 + M106 n=10) aggregation. NO I/O —
// everything takes parsed JSON values so the logic is unit-testable without
// raw live artifacts. Reuses the M105 validity/metric/aggregation primitives.

import {
  aggregateM105,
  type M105Aggregate,
  type M105CaseRow,
  type ResultRowMetrics,
  type RunValidity,
} from "./run_stage5_m105_report_lib";

// ---------------------------------------------------------------------------
// Deterministic case selection (pre-registered; run BEFORE any live result)
// ---------------------------------------------------------------------------

export interface M106SelectionCandidate {
  readonly instance_id: string;
  readonly repo: string;
  readonly m103_outcome: string | null;
  readonly multi_file: boolean;
  readonly scored: boolean; // M103 generation_status === "scored" with a derivation row
  readonly m73_treatment_valid: boolean;
  readonly m73_treatment_resolved: boolean | null;
  readonly in_m92: boolean;
  readonly in_holdout: boolean;
}

export interface M106StratumSpec {
  readonly name: string;
  readonly want: number;
  readonly predicate: (c: M106SelectionCandidate) => boolean;
}

// The M103 scoreboard has NO "lexical_mismatch" outcome class (outcomes are
// excellent/good/partial/wrong_pivot/miss/overpacked), so the prompt's
// "miss/lexical_mismatch" stratum deterministically maps to outcome === "miss"
// (the class that contains the lexical-mismatch failures). Documented in the
// pre-run plan as the closest deterministic substitution.
export const M106_STRATA: readonly M106StratumSpec[] = [
  {
    name: "eg_hist_resolved",
    want: 2,
    predicate: (c) =>
      (c.m103_outcome === "excellent" || c.m103_outcome === "good") &&
      c.m73_treatment_valid &&
      c.m73_treatment_resolved === true,
  },
  {
    name: "eg_hist_unresolved",
    want: 2,
    predicate: (c) =>
      (c.m103_outcome === "excellent" || c.m103_outcome === "good") &&
      c.m73_treatment_valid &&
      c.m73_treatment_resolved === false,
  },
  {
    name: "partial_wrong_pivot",
    want: 2,
    predicate: (c) => c.m103_outcome === "partial" || c.m103_outcome === "wrong_pivot",
  },
  {
    name: "miss",
    want: 2,
    predicate: (c) => c.m103_outcome === "miss",
  },
  {
    name: "multi_file",
    want: 1,
    predicate: (c) => c.multi_file,
  },
  {
    name: "holdout",
    want: 1,
    predicate: (c) => c.in_holdout,
  },
];

export interface M106SelectedCase {
  readonly instance_id: string;
  readonly stratum: string;
}

export interface M106SelectionResult {
  readonly selected: M106SelectedCase[];
  readonly shortfalls: Array<{ stratum: string; want: number; got: number }>;
}

// Deterministic rules (pre-registered):
//   pool     = candidates with a scored M103 row, minus excludeIds (the 14 M105
//              live cases), minus anything already selected;
//   order    = cases WITH an M92 row first (prefer historical comparability;
//              every pool case has an M73 row), then instance_id ascending;
//   repo cap = pass 1 skips a candidate whose repo already has >= repoCap
//              selections ("avoid duplicate repo overrepresentation where
//              practical"); pass 2 relaxes the cap only if the stratum is
//              still short.
export function selectM106Cases(
  candidates: readonly M106SelectionCandidate[],
  excludeIds: ReadonlySet<string>,
  strata: readonly M106StratumSpec[] = M106_STRATA,
  repoCap = 2,
): M106SelectionResult {
  const repoOf = new Map(candidates.map((c) => [c.instance_id, c.repo]));
  const selected: M106SelectedCase[] = [];
  const shortfalls: Array<{ stratum: string; want: number; got: number }> = [];
  const isSelected = (id: string): boolean => selected.some((s) => s.instance_id === id);
  const repoCount = (repo: string): number =>
    selected.filter((s) => repoOf.get(s.instance_id) === repo).length;

  for (const stratum of strata) {
    const pool = candidates
      .filter((c) => c.scored && !excludeIds.has(c.instance_id) && !isSelected(c.instance_id) && stratum.predicate(c))
      .sort((a, b) =>
        a.in_m92 !== b.in_m92 ? (a.in_m92 ? -1 : 1) : a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0,
      );
    let got = 0;
    for (const c of pool) {
      if (got === stratum.want) break;
      if (repoCount(c.repo) >= repoCap) continue;
      selected.push({ instance_id: c.instance_id, stratum: stratum.name });
      got += 1;
    }
    for (const c of pool) {
      if (got === stratum.want) break;
      if (isSelected(c.instance_id)) continue;
      selected.push({ instance_id: c.instance_id, stratum: stratum.name });
      got += 1;
    }
    if (got < stratum.want) shortfalls.push({ stratum: stratum.name, want: stratum.want, got });
  }
  return { selected, shortfalls };
}

// ---------------------------------------------------------------------------
// Committed-M105-artifact reuse (M105 is NOT rerun; its detail rows are read
// back from stage5_m105_live_runs.detail.json and re-aggregated as-is)
// ---------------------------------------------------------------------------

// Validate + narrow one case row of the committed M105 detail JSON to the
// M105CaseRow shape aggregateM105 consumes. Returns null on shape mismatch so
// a corrupted/edited artifact fails loudly at the join instead of silently
// skewing the combined aggregate.
export function toM105CaseRow(value: unknown): M105CaseRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.instance_id !== "string") return null;
  const preflight = row.preflight_status;
  if (preflight !== "pass" && preflight !== "fail" && preflight !== "missing") return null;
  const live = row.live_status;
  if (live !== "valid" && live !== "invalid" && live !== "not_attempted") return null;
  const evalStatus = row.eval_status;
  if (evalStatus !== "evaluated" && evalStatus !== "pending" && evalStatus !== "not_applicable") return null;
  const validity = row.validity;
  if (validity !== null && (typeof validity !== "object" || typeof (validity as RunValidity).valid !== "boolean"))
    return null;
  const metrics = row.metrics;
  if (metrics !== null && (typeof metrics !== "object" || typeof (metrics as ResultRowMetrics).total_tokens !== "number"))
    return null;
  return {
    instance_id: row.instance_id,
    preflight_status: preflight,
    live_status: live,
    eval_status: evalStatus,
    validity: validity as RunValidity | null,
    metrics: metrics as ResultRowMetrics | null,
  };
}

export interface CombinedAggregates {
  readonly m105: M105Aggregate;
  readonly m106: M105Aggregate;
  readonly combined: M105Aggregate;
}

// Combine the committed M105 rows with the fresh M106 rows. Throws on a
// duplicate instance_id — an overlap would mean an M105 case was rerun, which
// is an M106 FAIL condition, so it must never aggregate silently.
export function aggregateCombined(
  m105Rows: readonly M105CaseRow[],
  m106Rows: readonly M105CaseRow[],
  m105LeakageFireCount: number,
  m106LeakageFireCount: number,
): CombinedAggregates {
  const seen = new Set(m105Rows.map((r) => r.instance_id));
  for (const r of m106Rows) {
    if (seen.has(r.instance_id)) throw new Error(`M105 case rerun detected in M106 rows: ${r.instance_id}`);
  }
  return {
    m105: aggregateM105(m105Rows, m105LeakageFireCount),
    m106: aggregateM105(m106Rows, m106LeakageFireCount),
    combined: aggregateM105([...m105Rows, ...m106Rows], m105LeakageFireCount + m106LeakageFireCount),
  };
}
