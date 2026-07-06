// Stage 5 M107 — pure helpers for the 50-case live-confirmation extension:
// deterministic pre-registered 26-case selection (strata per the M107 brief,
// with a documented deterministic substitution for the exhausted `partial`
// class), phase assignment (A=5 / B=10 / C=11), and the combined
// (M105 n=14 + M106 n=10 + M107 n=26) aggregation. NO I/O — everything takes
// parsed JSON values so the logic is unit-testable without raw live
// artifacts. Reuses the M105 validity/metric/aggregation primitives and the
// M106 selection engine.

import { aggregateM105, type M105Aggregate, type M105CaseRow } from "./run_stage5_m105_report_lib";
import {
  selectM106Cases,
  type M106SelectionCandidate,
  type M106SelectedCase,
  type M106StratumSpec,
} from "./run_stage5_m106_lib";

// ---------------------------------------------------------------------------
// Deterministic case selection (pre-registered; run BEFORE any live result)
// ---------------------------------------------------------------------------

// The M107 brief's strata over the remaining 76-case pool (100 minus the 14
// M105 and 10 M106 live cases). As in M106, the M103 scoreboard outcome
// classes are excellent/good/partial/wrong_pivot/miss/overpacked.
export const M107_STRATA: readonly M106StratumSpec[] = [
  {
    name: "eg_hist_resolved",
    want: 5,
    predicate: (c) =>
      (c.m103_outcome === "excellent" || c.m103_outcome === "good") &&
      c.m73_treatment_valid &&
      c.m73_treatment_resolved === true,
  },
  {
    name: "eg_hist_unresolved",
    want: 4,
    predicate: (c) =>
      (c.m103_outcome === "excellent" || c.m103_outcome === "good") &&
      c.m73_treatment_valid &&
      c.m73_treatment_resolved === false,
  },
  {
    name: "partial",
    want: 4,
    predicate: (c) => c.m103_outcome === "partial",
  },
  {
    name: "wrong_pivot",
    want: 4,
    predicate: (c) => c.m103_outcome === "wrong_pivot",
  },
  {
    name: "miss",
    want: 5,
    predicate: (c) => c.m103_outcome === "miss",
  },
  {
    name: "multi_file",
    want: 2,
    predicate: (c) => c.multi_file,
  },
  {
    name: "holdout",
    want: 2,
    predicate: (c) => c.in_holdout,
  },
];

// Pre-registered deterministic substitution when a stratum's pool is
// exhausted: the remaining pool has only ONE `partial` case, so the partial
// deficit fills from `overpacked` — the single M103 failure class the M107
// strata do not otherwise cover (gold retrieved but the capsule overflows).
// Substituted rows keep their provenance in the stratum name.
export const M107_STRATUM_SUBSTITUTES: Readonly<Record<string, { name: string; predicate: (c: M106SelectionCandidate) => boolean }>> = {
  partial: {
    name: "partial_sub_overpacked",
    predicate: (c) => c.m103_outcome === "overpacked",
  },
};

// "avoid selecting more than 6 cases from the same repo in the M107
// extension when possible" — pass 1 of the selection engine enforces this,
// pass 2 relaxes only when a stratum would otherwise fall short.
export const M107_REPO_CAP = 6;

export interface M107SelectionResult {
  readonly selected: M106SelectedCase[];
  readonly substitutions: Array<{ stratum: string; substitute: string; count: number }>;
  readonly shortfalls: Array<{ stratum: string; want: number; got: number }>;
}

export function selectM107Cases(
  candidates: readonly M106SelectionCandidate[],
  excludeIds: ReadonlySet<string>,
): M107SelectionResult {
  const base = selectM106Cases(candidates, excludeIds, M107_STRATA, M107_REPO_CAP);
  const selected = [...base.selected];
  const substitutions: M107SelectionResult["substitutions"] = [];
  const shortfalls: M107SelectionResult["shortfalls"] = [];
  const repoOf = new Map(candidates.map((c) => [c.instance_id, c.repo]));
  const repoCount = (repo: string): number => selected.filter((s) => repoOf.get(s.instance_id) === repo).length;

  for (const shortfall of base.shortfalls) {
    const substitute = M107_STRATUM_SUBSTITUTES[shortfall.stratum];
    const deficit = shortfall.want - shortfall.got;
    if (substitute === undefined || deficit <= 0) {
      shortfalls.push(shortfall);
      continue;
    }
    // Same two-pass rules as the base selection, but the repo cap counts the
    // WHOLE M107 selection so far (a nested selectM106Cases call would reset
    // its repo counter and overweight an already-saturated repo).
    const isTaken = (id: string): boolean => excludeIds.has(id) || selected.some((s) => s.instance_id === id);
    const pool = candidates
      .filter((c) => c.scored && !isTaken(c.instance_id) && substitute.predicate(c))
      .sort((a, b) =>
        a.in_m92 !== b.in_m92 ? (a.in_m92 ? -1 : 1) : a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0,
      );
    let got = 0;
    for (const c of pool) {
      if (got === deficit) break;
      if (repoCount(c.repo) >= M107_REPO_CAP) continue;
      selected.push({ instance_id: c.instance_id, stratum: substitute.name });
      got += 1;
    }
    for (const c of pool) {
      if (got === deficit) break;
      if (selected.some((s) => s.instance_id === c.instance_id)) continue;
      selected.push({ instance_id: c.instance_id, stratum: substitute.name });
      got += 1;
    }
    if (got > 0) substitutions.push({ stratum: shortfall.stratum, substitute: substitute.name, count: got });
    if (got < deficit) shortfalls.push({ stratum: shortfall.stratum, want: shortfall.want, got: shortfall.got + got });
  }
  return { selected, substitutions, shortfalls };
}

// Phase assignment over the selection order: A = 5-case pilot, B = next 10,
// C = final 11 (the M107 brief's phased-run contract).
export function m107Phase(index: number): "A" | "B" | "C" {
  if (index < 5) return "A";
  if (index < 15) return "B";
  return "C";
}

// ---------------------------------------------------------------------------
// Combined 50-case aggregation (committed M105 + M106 rows are REUSED, never
// recomputed; any instance overlap means a case was rerun — a FAIL condition
// that must never aggregate silently)
// ---------------------------------------------------------------------------

export interface Combined50Aggregates {
  readonly m105: M105Aggregate;
  readonly m106: M105Aggregate;
  readonly m107: M105Aggregate;
  readonly combined24: M105Aggregate;
  readonly combined50: M105Aggregate;
}

export function aggregateCombined50(
  m105Rows: readonly M105CaseRow[],
  m106Rows: readonly M105CaseRow[],
  m107Rows: readonly M105CaseRow[],
  m105LeakageFireCount: number,
  m106LeakageFireCount: number,
  m107LeakageFireCount: number,
): Combined50Aggregates {
  const seen = new Set<string>();
  for (const [set, rows] of [
    ["m105", m105Rows],
    ["m106", m106Rows],
    ["m107", m107Rows],
  ] as const) {
    for (const r of rows) {
      if (seen.has(r.instance_id)) throw new Error(`case rerun detected across sets (${set}): ${r.instance_id}`);
      seen.add(r.instance_id);
    }
  }
  return {
    m105: aggregateM105(m105Rows, m105LeakageFireCount),
    m106: aggregateM105(m106Rows, m106LeakageFireCount),
    m107: aggregateM105(m107Rows, m107LeakageFireCount),
    combined24: aggregateM105([...m105Rows, ...m106Rows], m105LeakageFireCount + m106LeakageFireCount),
    combined50: aggregateM105(
      [...m105Rows, ...m106Rows, ...m107Rows],
      m105LeakageFireCount + m106LeakageFireCount + m107LeakageFireCount,
    ),
  };
}
