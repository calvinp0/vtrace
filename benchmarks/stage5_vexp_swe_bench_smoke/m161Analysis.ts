/**
 * M161-D §52-§60, §64-§68, §75-§76 — paired outcome, orientation and cross-tab
 * primitives.
 *
 * PURE. These turn captured run rows into the counts M161 reports. They are a
 * separate, tested module because the headline numbers ARE their output, and
 * because §50 forbids adjusting anything after outcomes are read — a classifier
 * that lives in the driver is a classifier that can be quietly retuned while
 * staring at a disappointing matrix.
 */

import type { LeadQuality, TreatmentState } from "./m161Treatment";

// ---------------------------------------------------------------------------
// Orientation (§60)
// ---------------------------------------------------------------------------

export interface ToolCall {
  readonly index: number;
  readonly tool: string;
  /** "read" | "search" | "edit" | "other", as classified by the runner. */
  readonly category: string;
  readonly path: string | null;
}

export interface Orientation {
  readonly toolCalls: number;
  readonly searches: number;
  readonly reads: number;
  readonly edits: number;
  /** 0-based position of the first edit, or null if the agent never edited. */
  readonly firstEditIndex: number | null;
  readonly toolCallsBeforeFirstEdit: number | null;
  readonly searchesBeforeFirstEdit: number | null;
  readonly readsBeforeFirstEdit: number | null;
  /** 0-based position of the first call touching a gold file, or null. */
  readonly firstGoldTouchIndex: number | null;
  readonly goldTouchedBeforeFirstEdit: boolean;
}

/**
 * Gold paths arrive absolute (the agent works in the bench clone) while the
 * manifest holds repo-relative paths, so matching is by suffix. Matching on
 * basename alone would collapse `utils.py` across a hundred packages.
 */
export function touchesGold(callPath: string | null, goldFiles: readonly string[]): boolean {
  if (callPath === null || callPath.length === 0) return false;
  const normalized = callPath.replaceAll("\\", "/");
  return goldFiles.some((gold) => normalized === gold || normalized.endsWith(`/${gold}`));
}

export function computeOrientation(calls: readonly ToolCall[], goldFiles: readonly string[]): Orientation {
  const ordered = [...calls].sort((a, b) => a.index - b.index);
  const firstEdit = ordered.findIndex((c) => c.category === "edit");
  const firstGold = ordered.findIndex((c) => touchesGold(c.path, goldFiles));
  const before = firstEdit < 0 ? ordered : ordered.slice(0, firstEdit);
  return {
    toolCalls: ordered.length,
    searches: ordered.filter((c) => c.category === "search").length,
    reads: ordered.filter((c) => c.category === "read").length,
    edits: ordered.filter((c) => c.category === "edit").length,
    firstEditIndex: firstEdit < 0 ? null : firstEdit,
    toolCallsBeforeFirstEdit: firstEdit < 0 ? null : before.length,
    searchesBeforeFirstEdit: firstEdit < 0 ? null : before.filter((c) => c.category === "search").length,
    readsBeforeFirstEdit: firstEdit < 0 ? null : before.filter((c) => c.category === "read").length,
    firstGoldTouchIndex: firstGold < 0 ? null : firstGold,
    goldTouchedBeforeFirstEdit: firstGold >= 0 && (firstEdit < 0 || firstGold < firstEdit),
  };
}

// ---------------------------------------------------------------------------
// Paired outcome matrix (§52, §88)
// ---------------------------------------------------------------------------

export type Grade = "PASS" | "FAIL" | "UNGRADED";

export type PairClass =
  | "shared success"
  | "VTRACE unique win"
  | "VTRACE unique loss"
  | "shared failure"
  | "incomplete";

/**
 * Grade one arm from what the run actually produced (§51).
 *
 * The grader is the authority, with one entailed exception: a run that COMPLETED
 * and produced an EMPTY patch is a FAIL. The SWE-bench grader refuses to evaluate
 * an empty patch at all, so leaving it UNGRADED would silently drop a real agent
 * failure out of the denominator — and dropping it is not neutral, because the
 * paired arm's outcome decides which way the omission points.
 *
 * This is entailment, not judgement: FAIL_TO_PASS tests fail at the base commit by
 * definition — that is what makes them FAIL_TO_PASS — and an empty patch leaves the
 * tree at the base commit. Resolution is impossible, not merely unlikely.
 *
 * It applies only to a run that finished normally. A crash, an infrastructure
 * failure or a cap hit is not covered here and is handled by the rerun policy.
 */
export function gradeArm(input: {
  readonly ran: boolean;
  readonly evaluationRan: boolean;
  readonly resolved: unknown;
  readonly patchProduced: boolean;
}): Grade {
  if (!input.ran) return "UNGRADED";
  if (input.evaluationRan) return input.resolved === true ? "PASS" : "FAIL";
  return input.patchProduced ? "UNGRADED" : "FAIL";
}

export function classifyPair(baseline: Grade, vtrace: Grade): PairClass {
  if (baseline === "UNGRADED" || vtrace === "UNGRADED") return "incomplete";
  if (baseline === "PASS" && vtrace === "PASS") return "shared success";
  if (baseline === "FAIL" && vtrace === "PASS") return "VTRACE unique win";
  if (baseline === "PASS" && vtrace === "FAIL") return "VTRACE unique loss";
  return "shared failure";
}

export interface PairedMatrix {
  readonly "shared success": number;
  readonly "VTRACE unique win": number;
  readonly "VTRACE unique loss": number;
  readonly "shared failure": number;
  readonly incomplete: number;
}

export function buildMatrix(pairs: readonly { readonly classification: PairClass }[]): PairedMatrix {
  const matrix: Record<PairClass, number> = {
    "shared success": 0, "VTRACE unique win": 0, "VTRACE unique loss": 0, "shared failure": 0, incomplete: 0,
  };
  for (const pair of pairs) matrix[pair.classification] += 1;
  return matrix as unknown as PairedMatrix;
}

// ---------------------------------------------------------------------------
// Uncertainty (§54)
// ---------------------------------------------------------------------------

/**
 * Wilson score interval for the paired difference is the wrong tool here — the
 * pairs are not independent draws from one proportion. What actually carries the
 * information at n=30 is the DISCORDANT count, so this reports the exact binomial
 * (sign) test over discordant pairs, which is what McNemar's test reduces to at
 * small n. A pass-rate delta with 4 discordant pairs is not a measurement, and
 * saying so numerically is the point (§54: do not overstate a small delta).
 */
export function discordantExactP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  // Two-sided exact binomial at p=0.5.
  let cumulative = 0;
  for (let i = 0; i <= k; i += 1) cumulative += binomial(n, i);
  const p = (2 * cumulative) / 2 ** n;
  return Math.min(1, Number(p.toFixed(6)));
}

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
}

// ---------------------------------------------------------------------------
// Descriptive statistics (§55, §58)
// ---------------------------------------------------------------------------

export interface Stats {
  readonly n: number;
  readonly total: number;
  readonly mean: number | null;
  readonly median: number | null;
  readonly p90: number | null;
}

export function stats(values: readonly number[]): Stats {
  const usable = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (usable.length === 0) return { n: 0, total: 0, mean: null, median: null, p90: null };
  const total = usable.reduce((sum, v) => sum + v, 0);
  const mid = Math.floor(usable.length / 2);
  return {
    n: usable.length,
    total: round(total),
    mean: round(total / usable.length),
    median: round(usable.length % 2 === 1 ? usable[mid]! : (usable[mid - 1]! + usable[mid]!) / 2),
    p90: round(usable[Math.min(usable.length - 1, Math.floor(0.9 * usable.length))]!),
  };
}

function round(value: number): number {
  return Math.abs(value) >= 1000 ? Math.round(value) : Number(value.toFixed(4));
}

/** Paired per-case deltas (vtrace − baseline). Median is the headline (§136). */
export function pairedDelta(pairs: readonly { readonly baseline: number | null; readonly vtrace: number | null }[]): Stats {
  return stats(
    pairs
      .filter((p) => typeof p.baseline === "number" && typeof p.vtrace === "number")
      .map((p) => (p.vtrace as number) - (p.baseline as number)),
  );
}

// ---------------------------------------------------------------------------
// Lead-quality cross-tab (§64, §107, §135-§136)
// ---------------------------------------------------------------------------

export interface CrossTabCase {
  readonly instanceId: string;
  readonly leadQuality: LeadQuality;
  readonly treatmentState: TreatmentState;
  readonly classification: PairClass;
  readonly baselineGrade: Grade;
  readonly vtraceGrade: Grade;
  readonly tokenDelta: number | null;
  readonly searchDelta: number | null;
  readonly turnDelta: number | null;
  readonly wallDelta: number | null;
  readonly firstEditDelta: number | null;
}

export interface CrossTabRow {
  readonly leadQuality: LeadQuality;
  readonly cases: number;
  readonly baselinePass: number;
  readonly vtracePass: number;
  readonly uniqueWins: number;
  readonly uniqueLosses: number;
  readonly medianTokenDelta: number | null;
  readonly medianSearchDelta: number | null;
  readonly medianTurnDelta: number | null;
  readonly medianWallDelta: number | null;
  readonly medianFirstEditDelta: number | null;
  readonly instanceIds: readonly string[];
}

export const LEAD_QUALITIES: readonly LeadQuality[] = [
  "LEAD_GOLD", "LEAD_WRONG_GOLD_ELSEWHERE", "LEAD_WRONG_NO_GOLD", "VALID_EMPTY", "TREATMENT_UNAVAILABLE",
];

/**
 * One row per lead-quality label, INCLUDING labels with zero cases.
 *
 * Emitting the empty rows is deliberate: "LEAD_WRONG_GOLD_ELSEWHERE: 0 cases" and
 * a silently missing row read identically in a report, and only one of them is a
 * finding. §135 asks for the counts; §123 says a zero has to be visible to count.
 */
export function crossTab(cases: readonly CrossTabCase[]): CrossTabRow[] {
  return LEAD_QUALITIES.map((leadQuality) => {
    const rows = cases.filter((c) => c.leadQuality === leadQuality);
    const median = (pick: (c: CrossTabCase) => number | null): number | null =>
      stats(rows.map(pick).filter((v): v is number => typeof v === "number")).median;
    return {
      leadQuality,
      cases: rows.length,
      baselinePass: rows.filter((c) => c.baselineGrade === "PASS").length,
      vtracePass: rows.filter((c) => c.vtraceGrade === "PASS").length,
      uniqueWins: rows.filter((c) => c.classification === "VTRACE unique win").length,
      uniqueLosses: rows.filter((c) => c.classification === "VTRACE unique loss").length,
      medianTokenDelta: median((c) => c.tokenDelta),
      medianSearchDelta: median((c) => c.searchDelta),
      medianTurnDelta: median((c) => c.turnDelta),
      medianWallDelta: median((c) => c.wallDelta),
      medianFirstEditDelta: median((c) => c.firstEditDelta),
      instanceIds: rows.map((c) => c.instanceId).sort(),
    };
  });
}
