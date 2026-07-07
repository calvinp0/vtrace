// Stage 5 M108 — pure helpers for the 100-case live-confirmation extension:
// deterministic pre-registered remaining-case selection (the COMPLEMENT of the
// committed M105+M106+M107 live sets over the frozen 100-case pool — no
// strata, no sampling: every remaining case is selected), phase assignment
// (A=8 / B=14 / C=14 / D=14), the combined
// (M105 n=14 + M106 n=10 + M107 n=26 + M108 n=50) aggregation, and the
// pre-registered extension spend pause-cap check. NO I/O — everything takes
// parsed JSON values so the logic is unit-testable without raw live
// artifacts. Reuses the M105 validity/metric/aggregation primitives.

import { aggregateM105, type M105Aggregate, type M105CaseRow } from "./run_stage5_m105_report_lib";
import { type M106SelectionCandidate, type M106SelectedCase } from "./run_stage5_m106_lib";

// ---------------------------------------------------------------------------
// Deterministic case selection (pre-registered; run BEFORE any live result)
// ---------------------------------------------------------------------------

// The M108 brief expects the complement to be EXACTLY 50 cases
// (100 pool − 14 M105 − 10 M106 − 26 M107). The selection script stops before
// any live run if the complement deviates.
export const M108_EXPECTED_REMAINING = 50;

export interface M108SelectionResult {
  readonly selected: M106SelectedCase[];
  // Pool rows dropped by the complement rule (not excluded-by-reuse), with the
  // reason — the brief requires deviations to be explainable BEFORE live runs.
  readonly rejected: Array<{ instance_id: string; reason: string }>;
}

// Complement rule (pre-registered):
//   pool     = the frozen M103 100-case scoreboard rows;
//   keep     = generation_status "scored" with a derivation row (`scored`),
//              minus the committed M105/M106/M107 live case ids;
//   stratum  = reporting-only label `remaining_<m103_outcome>` (there is no
//              sampling — the label only carries the M103 outcome class into
//              the per-case table);
//   order    = cases WITH an M92 run-matrix row first (historical
//              comparability lands in the early phases), then instance_id
//              ascending — the same deterministic tie-break as M106/M107.
export function selectM108RemainingCases(
  candidates: readonly M106SelectionCandidate[],
  excludeIds: ReadonlySet<string>,
): M108SelectionResult {
  const rejected: M108SelectionResult["rejected"] = [];
  const pool: M106SelectionCandidate[] = [];
  for (const c of candidates) {
    if (excludeIds.has(c.instance_id)) continue; // committed live case — reused, never rerun
    if (!c.scored) {
      rejected.push({ instance_id: c.instance_id, reason: "M103 detail incomplete (not scored / no derivation)" });
      continue;
    }
    pool.push(c);
  }
  const selected = pool
    .sort((a, b) =>
      a.in_m92 !== b.in_m92 ? (a.in_m92 ? -1 : 1) : a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0,
    )
    .map((c) => ({ instance_id: c.instance_id, stratum: `remaining_${c.m103_outcome ?? "unknown"}` }));
  return { selected, rejected };
}

// Phase assignment over the selection order: A = 8-case pilot, B/C/D = 14
// each (the M108 brief's phased-run contract).
export function m108Phase(index: number): "A" | "B" | "C" | "D" {
  if (index < 8) return "A";
  if (index < 22) return "B";
  if (index < 36) return "C";
  return "D";
}

// ---------------------------------------------------------------------------
// Combined 100-case aggregation (committed M105 + M106 + M107 rows are
// REUSED, never recomputed; any instance overlap means a case was rerun — a
// FAIL condition that must never aggregate silently)
// ---------------------------------------------------------------------------

export interface Combined100Aggregates {
  readonly m105: M105Aggregate;
  readonly m106: M105Aggregate;
  readonly m107: M105Aggregate;
  readonly m108: M105Aggregate;
  readonly combined50: M105Aggregate;
  readonly combined100: M105Aggregate;
}

export function aggregateCombined100(
  m105Rows: readonly M105CaseRow[],
  m106Rows: readonly M105CaseRow[],
  m107Rows: readonly M105CaseRow[],
  m108Rows: readonly M105CaseRow[],
  m105LeakageFireCount: number,
  m106LeakageFireCount: number,
  m107LeakageFireCount: number,
  m108LeakageFireCount: number,
): Combined100Aggregates {
  const seen = new Set<string>();
  for (const [set, rows] of [
    ["m105", m105Rows],
    ["m106", m106Rows],
    ["m107", m107Rows],
    ["m108", m108Rows],
  ] as const) {
    for (const r of rows) {
      if (seen.has(r.instance_id)) throw new Error(`case rerun detected across sets (${set}): ${r.instance_id}`);
      seen.add(r.instance_id);
    }
  }
  const first50Rows = [...m105Rows, ...m106Rows, ...m107Rows];
  const first50Leaks = m105LeakageFireCount + m106LeakageFireCount + m107LeakageFireCount;
  return {
    m105: aggregateM105(m105Rows, m105LeakageFireCount),
    m106: aggregateM105(m106Rows, m106LeakageFireCount),
    m107: aggregateM105(m107Rows, m107LeakageFireCount),
    m108: aggregateM105(m108Rows, m108LeakageFireCount),
    combined50: aggregateM105(first50Rows, first50Leaks),
    combined100: aggregateM105([...first50Rows, ...m108Rows], first50Leaks + m108LeakageFireCount),
  };
}

// ---------------------------------------------------------------------------
// Extension spend pause cap (pre-registered: stop if M108 extension spend
// exceeds the cap before all 50 cases finish, unless overage is approved)
// ---------------------------------------------------------------------------

export const M108_EXTENSION_PAUSE_CAP_USD = 45;

export interface SpendCapStatus {
  readonly cap_usd: number;
  readonly spent_usd: number;
  readonly remaining_usd: number;
  readonly under_cap: boolean;
}

export function spendCapStatus(rows: readonly M105CaseRow[], capUsd: number = M108_EXTENSION_PAUSE_CAP_USD): SpendCapStatus {
  const spent = rows.reduce((sum, r) => sum + (r.metrics?.cost_usd ?? 0), 0);
  return {
    cap_usd: capUsd,
    spent_usd: spent,
    remaining_usd: capUsd - spent,
    under_cap: spent <= capUsd,
  };
}
