/**
 * M69 — aggregate computation for the pivot-confidence 24-task live validation. Reads the
 * CAPTURED M69 per-case detail (post-eval `resolved`), the M66 detail (prior treatment +
 * reused baseline fields), the M69 gated pre-flight, and the frozen fixture. Computes
 * resolution, paired outcomes, paired deltas, structured-decision aggregates, category
 * stratification, gate analysis, off-target edits, and the success-criteria checks. Writes
 * the compact summary JSON and prints a full computed blob to stdout (used to author the MD).
 * No agents, no Docker, no spend.
 *
 * Usage: bun run_stage5_m69_report.ts
 */
import fs from "node:fs";
import path from "node:path";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const M69_DETAIL = path.join(RESULTS, "stage5_m69_pivot_confidence_24_live_validation.detail.json");
const M66_DETAIL = path.join(RESULTS, "stage5_m66_optional_impact_24_live_validation.detail.json");
const PREFLIGHT = path.join(RESULTS, "stage5_m69_preflight.json");
const FIXTURE = path.join(RESULTS, "stage5_m62_structured_bounded_24_preregistration.json");

function readJson<T>(p: string): T { return JSON.parse(fs.readFileSync(p, "utf8")) as T; }
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const bool = (v: unknown): boolean => v === true;
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function pooledPct(treat: number[], base: number[]): number {
  const t = treat.reduce((a, b) => a + b, 0), b = base.reduce((a, b) => a + b, 0);
  return b === 0 ? 0 : ((t - b) / b) * 100;
}

type Row = Record<string, unknown>;
const m69: Row[] = readJson(M69_DETAIL);
const m66: Row[] = readJson(M66_DETAIL);
const m66By = new Map<string, Row>(); for (const r of m66) m66By.set(String(r.instance_id), r);
const preflight = readJson<{ cases: Row[] }>(PREFLIGHT);
const pfBy = new Map<string, Row>(); for (const c of preflight.cases) pfBy.set(String(c.instance_id), c);
const fixture = readJson<{ category_counts: Record<string, number>; repo_count: number; repos?: string[] }>(FIXTURE);

// ---- resolution ----
const m69Resolved = m69.filter((r) => bool(r.resolved)).map((r) => String(r.instance_id));
const baseResolved = m69.filter((r) => bool(r.baseline_resolved)).map((r) => String(r.instance_id));
const m66Resolved = m69.filter((r) => bool(r.m66_resolved)).map((r) => String(r.instance_id));

// ---- paired outcomes vs baseline ----
const pairBaseline = { both_pass: [] as string[], both_fail: [] as string[], m69_only_pass: [] as string[], baseline_only_pass: [] as string[] };
for (const r of m69) {
  const inst = String(r.instance_id), a = bool(r.resolved), b = bool(r.baseline_resolved);
  if (a && b) pairBaseline.both_pass.push(inst);
  else if (!a && !b) pairBaseline.both_fail.push(inst);
  else if (a && !b) pairBaseline.m69_only_pass.push(inst);
  else pairBaseline.baseline_only_pass.push(inst);
}
// ---- paired outcomes vs M66 ----
const pairM66 = { both_pass: [] as string[], both_fail: [] as string[], m69_only_pass: [] as string[], m66_only_pass: [] as string[] };
for (const r of m69) {
  const inst = String(r.instance_id), a = bool(r.resolved), b = bool(r.m66_resolved);
  if (a && b) pairM66.both_pass.push(inst);
  else if (!a && !b) pairM66.both_fail.push(inst);
  else if (a && !b) pairM66.m69_only_pass.push(inst);
  else pairM66.m66_only_pass.push(inst);
}

// ---- paired deltas vs baseline (per-case treatment - reused baseline median) ----
const tok = m69.map((r) => num(r.total_tokens));
const baseTok = m69.map((r) => num(r.baseline_total_tokens_med));
const tokD = m69.map((r) => num(r.total_tokens) - num(r.baseline_total_tokens_med));
const cacheD = m69.map((r) => num(r.cache_read_tokens_total) - num(r.baseline_cache_read_med));
const costD = m69.map((r) => num(r.cost) - num(r.baseline_cost_med));
const toolD = m69.map((r) => num(r.tool_call_count) - num(r.baseline_tool_med));
const cost = m69.map((r) => num(r.cost)); const baseCost = m69.map((r) => num(r.baseline_cost_med));
const cacheT = m69.map((r) => num(r.cache_read_tokens_total)); const baseCache = m69.map((r) => num(r.baseline_cache_read_med));
const readD = m69.map((r) => num(r.read_count)); // baseline read not captured per-case; reported absolute mean
const searchD = m69.map((r) => num(r.search_count));

const deltasVsBaseline = {
  n: m69.length,
  token_delta_mean: mean(tokD), token_delta_median: median(tokD), token_delta_pooled_pct: pooledPct(tok, baseTok),
  cache_read_delta_mean: mean(cacheD), cache_read_delta_median: median(cacheD), cache_read_delta_pooled_pct: pooledPct(cacheT, baseCache),
  cost_delta_mean: mean(costD), cost_delta_median: median(costD), cost_delta_pooled_pct: pooledPct(cost, baseCost),
  tool_call_delta_mean: mean(toolD),
  read_mean: mean(readD), search_mean: mean(searchD),
  resolution_delta: m69Resolved.length - baseResolved.length,
  pooled_treatment_cost: cost.reduce((a, b) => a + b, 0), pooled_baseline_cost: baseCost.reduce((a, b) => a + b, 0),
  pooled_treatment_tokens: tok.reduce((a, b) => a + b, 0), pooled_baseline_tokens: baseTok.reduce((a, b) => a + b, 0),
};

// ---- structured decision aggregates (required pivots only) ----
function sd(rows: Row[]) {
  const required = rows.reduce((a, r) => a + num(r.required_target_count), 0);
  const closed = rows.reduce((a, r) => a + num(r.required_target_closed_count), 0);
  const open = rows.reduce((a, r) => a + num(r.required_target_open_count), 0);
  const ignored = rows.reduce((a, r) => a + num(r.required_target_ignored_count), 0);
  const invalid = rows.reduce((a, r) => a + num(r.required_target_invalid_decision_count), 0);
  const edited = rows.reduce((a, r) => a + num(r.required_target_edited_count), 0);
  const ruledOut = rows.reduce((a, r) => a + num(r.required_target_ruled_out_count), 0);
  const inspectOnly = rows.reduce((a, r) => a + num(r.required_target_inspect_only_no_edit_count), 0);
  return {
    required, closed, open, ignored, invalid, edited, ruled_out: ruledOut, inspect_only_no_edit: inspectOnly,
    coverage_pct: required ? +(100 * closed / required).toFixed(2) : 0,
    ignored_rate_pct: required ? +(100 * ignored / required).toFixed(2) : 0,
    invalid_rule_out_rate_pct: required ? +(100 * invalid / required).toFixed(2) : 0,
  };
}
const sdM69 = sd(m69);
const sdM66 = sd(m66);

// ---- gate analysis ----
const zeroReq = m69.filter((r) => num(r.required_target_count) === 0).map((r) => String(r.instance_id));
const demotedCases = m69.filter((r) => num(r.demoted_pivot_count) > 0);
const demotedTotal = m69.reduce((a, r) => a + num(r.demoted_pivot_count), 0);
const demotedDetail = demotedCases.map((r) => ({
  instance_id: r.instance_id,
  demoted_pivots: r.demoted_pivots,
  demoted_inspected: r.demoted_pivot_inspected,
  demoted_edited: r.demoted_pivot_edited,
  resolved: r.resolved,
  marker: r.no_high_confidence_required_marker_present,
}));
const anyDemotedEdited = demotedCases.some((r) => (r.demoted_pivot_edited as unknown[]).length > 0);

// ---- off-target edits ----
const offTargetTotal = m69.reduce((a, r) => a + num(r.off_target_edit_count), 0);
const offTargetCases = m69.filter((r) => num(r.off_target_edit_count) > 0).map((r) => ({ instance_id: r.instance_id, count: r.off_target_edit_count, edits: r.off_target_edits }));

// ---- category stratification ----
const cats = ["A", "B", "C", "D", "E"];
const byCat: Record<string, unknown> = {};
for (const c of cats) {
  const rows = m69.filter((r) => r.category === c);
  const sdc = sd(rows);
  byCat[c] = {
    n: rows.length,
    baseline_resolved: rows.filter((r) => bool(r.baseline_resolved)).length,
    m66_resolved: rows.filter((r) => bool(r.m66_resolved)).length,
    m69_resolved: rows.filter((r) => bool(r.resolved)).length,
    m69_only_wins_vs_baseline: rows.filter((r) => bool(r.resolved) && !bool(r.baseline_resolved)).map((r) => r.instance_id),
    baseline_only_wins: rows.filter((r) => !bool(r.resolved) && bool(r.baseline_resolved)).map((r) => r.instance_id),
    cost_delta_pooled_pct: pooledPct(rows.map((r) => num(r.cost)), rows.map((r) => num(r.baseline_cost_med))),
    token_delta_pooled_pct: pooledPct(rows.map((r) => num(r.total_tokens)), rows.map((r) => num(r.baseline_total_tokens_med))),
    coverage_pct: sdc.coverage_pct, ignored_rate_pct: sdc.ignored_rate_pct, invalid_rule_out_rate_pct: sdc.invalid_rule_out_rate_pct,
    off_target_edits: rows.reduce((a, r) => a + num(r.off_target_edit_count), 0),
  };
}

// ---- validity ----
const validRuns = m69.filter((r) => bool(r.valid_run)).length;
const invalidRuns = m69.filter((r) => !bool(r.valid_run)).map((r) => ({ instance_id: r.instance_id, reason: r.invalid_reason }));
const gateEnabledAll = m69.every((r) => bool(r.pivot_confidence_gate_enabled));
const requiredImpactAny = m69.some((r) => bool(r.required_has_impact));
const zeroReqAllMarked = zeroReq.every((inst) => bool(m69.find((r) => r.instance_id === inst)?.no_high_confidence_required_marker_present));
const idsCollideAny = m69.some((r) => bool(r.optional_ids_collide));
const optionalImpactOk = m69.every((r) => !(num(r.optional_impact_id_count) > 0) || bool(r.optional_impact_context_present));

// ---- success criteria ----
const criteria = {
  c1_valid_all: { pass: validRuns >= 23, detail: `${validRuns}/24 valid` },
  c2_gate_enabled_all: { pass: gateEnabledAll, detail: `gate verified on ${m69.filter((r) => bool(r.pivot_confidence_gate_enabled)).length}/24` },
  c3_zero_required_marker: { pass: zeroReqAllMarked, detail: `${zeroReq.length} zero-required, all marker-backed=${zeroReqAllMarked}` },
  c4_no_required_impact: { pass: !requiredImpactAny, detail: `required_impact_any=${requiredImpactAny}` },
  c5_optional_not_closure_scored: { pass: m69.every((r) => num(r.optional_impact_id_count) === 0 || bool(r.optional_impact_not_closure_scored)), detail: "optional/FYI never closure-scored" },
  c6_coverage_ge_90: { pass: sdM69.coverage_pct >= 90, detail: `coverage ${sdM69.coverage_pct}%` },
  c7_ignored_le_5: { pass: sdM69.ignored_rate_pct <= 5, detail: `ignored ${sdM69.ignored_rate_pct}%` },
  c8_invalid_not_worse_than_m66: { pass: sdM69.invalid_rule_out_rate_pct <= sdM66.invalid_rule_out_rate_pct, detail: `M69 ${sdM69.invalid_rule_out_rate_pct}% vs M66 ${sdM66.invalid_rule_out_rate_pct}%` },
  // c9, c10 require manual mechanism review (filled in MD): treatment-only wins keep mechanism; no correct lead wrongly demoted
  c11_resolution_not_worse: { pass: m69Resolved.length >= baseResolved.length, detail: `M69 ${m69Resolved.length} vs baseline ${baseResolved.length}` },
  c12_cost_pooled_le_15: { pass: deltasVsBaseline.cost_delta_pooled_pct <= 15, detail: `pooled cost ${deltasVsBaseline.cost_delta_pooled_pct.toFixed(2)}%` },
};

const summary = {
  milestone: "M69",
  kind: "pivot-confidence gate — frozen M62 24-task live repeat (treatment + reused baselines)",
  live_agents: true, new_live_runs: 24, fresh_baselines: 0, reused_baselines: 24, docker_evals: m69.filter((r) => bool(r.evaluated)).length,
  retrieval_changed: false,
  selected_task_count: m69.length,
  repos: fixture.repo_count, category_counts: fixture.category_counts,
  valid_treatment_runs: validRuns, invalid_treatment_runs: invalidRuns.length, invalid_detail: invalidRuns,
  gate_enabled_all: gateEnabledAll, required_impact_any: requiredImpactAny, ids_collide_any: idsCollideAny, optional_impact_ok: optionalImpactOk,
  zero_required_cases: zeroReq, zero_required_all_marker_backed: zeroReqAllMarked,
  demoted_pivot_total: demotedTotal, demoted_cases: demotedDetail, any_demoted_pivot_edited: anyDemotedEdited,
  resolution: { m69: m69Resolved.length, baseline: baseResolved.length, m66: m66Resolved.length, n: m69.length, m69_resolved: m69Resolved },
  paired_vs_baseline: pairBaseline,
  paired_vs_m66: pairM66,
  deltas_vs_baseline: deltasVsBaseline,
  structured_decision_m69: sdM69,
  structured_decision_m66: sdM66,
  by_category: byCat,
  off_target_edit_total: offTargetTotal, off_target_cases: offTargetCases,
  success_criteria: criteria,
};

fs.writeFileSync(path.join(RESULTS, "stage5_m69_pivot_confidence_24_live_validation.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
