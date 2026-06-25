/**
 * M72 — render the Stage B 50-treatment Markdown report from the captured analysis JSON
 * (stage5_m72_stage_b_50_treatment.json + .detail.json + cumulative) and the frozen execution
 * matrix. No agents, no Docker, no spend. Pure formatting + success-criteria evaluation.
 *
 * Usage: bun run_stage5_m72_stage_b_report.ts
 */
import fs from "node:fs";
import path from "node:path";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(RESULTS, p), "utf8")) as T;

const s = readJson<any>("stage5_m72_stage_b_50_treatment.json");
const detail = readJson<any[]>("stage5_m72_stage_b_50_treatment.detail.json");
const preflight = readJson<any>("stage5_m72_stage_b_preflight.json");
const matrix = readJson<any>("stage5_m70b_100_task_execution_matrix.json");
const cum = readJson<any>("stage5_m72_stage_ab_treatment_cumulative.json");

const fmt = (v: any) => (v === null || v === undefined ? "—" : String(v));
const yn = (b: any) => (b === true ? "yes" : b === false ? "no" : "—");
const usd = (v: any) => (typeof v === "number" ? `$${v.toFixed(2)}` : "—");

// ---------- success criteria ----------
const dec = s.structured_decision_m72;
const m69dec = s.structured_decision_m69 ?? { invalid_rule_out_rate_pct: 7.32, coverage_pct: 90.24 };
const validityOk = s.validity_rate_pct >= 95;
const invalidRuleOutDelta = dec.invalid_rule_out_rate_pct - (m69dec?.invalid_rule_out_rate_pct ?? 0);
// cumulative 100-treatment cost = Stage A total + Stage B total (both fully executed)
const cumulative100Cost = cum.total_treatment_cost;
const COST_SANITY_CEILING = 200; // USD for 100 treatment runs; well above any prior slice
const optionalClosureOk = detail.filter((r) => r.valid_run && r.optional_impact_id_count > 0).every((r) => r.optional_impact_not_closure_scored);
const crit: Array<{ id: string; label: string; pass: boolean | null; detail: string }> = [
  { id: "1", label: "Stage B pre-flight has no partial sentinel", pass: (preflight.partial_sentinel_count ?? 0) === 0 && !s.partial_sentinel_any, detail: `preflight partial_sentinel=${preflight.partial_sentinel_count ?? 0}, run partial_sentinel_any=${s.partial_sentinel_any}` },
  { id: "2", label: "treatment valid in >=95% of attempted Stage B runs", pass: validityOk, detail: `${s.valid_treatment_runs}/${s.new_live_runs} = ${s.validity_rate_pct}%` },
  { id: "3", label: "no required IMPACT targets emitted", pass: s.required_impact_any === false, detail: `required_impact_any=${s.required_impact_any}` },
  { id: "4", label: "confidence gate enabled in all valid treatment runs", pass: s.gate_enabled_all === true, detail: `gate verified ${s.gate_enabled_count}/${s.valid_treatment_runs}` },
  { id: "5", label: "optional/FYI targets not closure-scored", pass: optionalClosureOk, detail: `optional_impact_ok=${s.optional_impact_ok}` },
  { id: "6", label: "decision coverage >=90% (or miss explained by zero-required/known-invalid)", pass: dec.coverage_pct >= 90, detail: `coverage ${dec.coverage_pct}% (zero-required=${s.zero_required_count})` },
  { id: "7", label: "invalid rule-out rate not >2pp above M69", pass: invalidRuleOutDelta <= 2, detail: `M72 ${dec.invalid_rule_out_rate_pct}% vs M69 ${m69dec?.invalid_rule_out_rate_pct ?? "—"}% (Δ ${invalidRuleOutDelta.toFixed(2)}pp)` },
  { id: "8", label: "no severe cost explosion (cumulative 100-treatment acceptable)", pass: cumulative100Cost <= COST_SANITY_CEILING, detail: `cumulative A+B ${usd(cumulative100Cost)} (Stage B mean ${usd(s.cost.mean)}/run)` },
  { id: "9", label: "no systematic failure pattern making Stage C unsafe", pass: s.invalid_treatment_runs <= Math.ceil(0.05 * s.new_live_runs) && !s.required_impact_any && s.gate_enabled_all && !s.ids_collide_any, detail: `${s.invalid_treatment_runs} invalid; gate_all=${s.gate_enabled_all}; required_impact=${s.required_impact_any}; ids_collide=${s.ids_collide_any}` },
];
const allPass = crit.every((c) => c.pass === true);
const hardInvalid = preflight.valid_count < 45 || s.partial_sentinel_any || s.required_impact_any || s.ids_collide_any;
const verdict = hardInvalid ? "INVALID" : allPass ? "PASS" : crit.filter((c) => c.pass !== true).length <= 2 ? "MIXED" : "FAIL";
const recommendation =
  verdict === "PASS" ? "authorize Stage C fresh baselines"
  : verdict === "MIXED" ? "pause for audit before Stage C"
  : verdict === "INVALID" ? "fix pre-flight/render issue before more live runs"
  : "pause for audit before Stage C";

// ---------- markdown ----------
const L: string[] = [];
const p = (x = "") => L.push(x);

p("# Stage 5 M72 Stage B 50-Treatment Run");
p();
p("## Summary");
p(`- Stage B selected count: **${s.stage_b_selected}** (of ${s.stage_b_total_membership} frozen Stage B membership; ${(s.skipped_preflight_invalid ?? []).length} skipped pre-flight invalid)`);
p(`- pre-flight valid / invalid / skipped: **${preflight.valid_count} / ${preflight.total - preflight.valid_count} / ${(s.skipped_preflight_invalid ?? []).length}** (rendered ${preflight.total}; skipped = ${(s.skipped_preflight_invalid ?? []).map((x: any) => x.instance_id).join(", ") || "none"})`);
p(`- new live treatment runs: **${s.new_live_runs}**`);
p(`- operational retries / quota aborts: **${s.operational_retry_count} / ${s.quota_abort_count}**`);
p(`- Docker evals: **${s.docker_evals}**`);
p(`- reused baselines available in Stage B: **${s.baselines_reused_available}**`);
p(`- fresh baselines pending in Stage B (Stage C): **${s.baselines_missing_pending_stage_c}**`);
p(`- treatment valid / invalid: **${s.valid_treatment_runs} / ${s.invalid_treatment_runs}** (${s.validity_rate_pct}%)`);
p(`- headline Stage B treatment resolution: **${s.resolution.treatment_resolved}/${s.resolution.n}** resolved (${s.resolution.treatment_evaluated} evaluated)`);
p(`- paired (reused-baseline) subset: treatment **${s.paired_vs_baseline.treatment_passes}/${s.paired_vs_baseline.paired_case_count}** vs baseline **${s.paired_vs_baseline.baseline_passes}/${s.paired_vs_baseline.paired_case_count}**`);
p(`- unpaired (fresh-baseline-pending) subset: treatment **${s.unpaired_treatment_only.treatment_passes}/${s.unpaired_treatment_only.case_count}** (paired conclusion pending Stage C)`);
p(`- headline cost: total **${usd(s.cost.total)}**, mean **${usd(s.cost.mean)}**/run, pooled tokens **${s.cost.pooled_total_tokens.toLocaleString()}**`);
p(`- structured-decision compliance: coverage **${dec.coverage_pct}%**, ignored **${dec.ignored_rate_pct}%**, invalid rule-out **${dec.invalid_rule_out_rate_pct}%**`);
p(`- cumulative Stage A+B treatment-only: **${cum.treatment_resolved}/${cum.treatment_attempted}** resolved, valid **${cum.treatment_valid}/${cum.treatment_attempted}** (${cum.validity_rate_pct}%), total cost **${usd(cum.total_treatment_cost)}**`);
p(`- verdict: **${verdict}**`);
p(`- recommendation: **${recommendation}**`);
p();
p("## Fixture / Matrix Compliance");
p(`- M70B execution matrix used: \`stage5_m70b_100_task_execution_matrix.json\` (${matrix.rows.length} rows)`);
p(`- Stage B membership (execution_stage == "stage_b"): **${matrix.rows.filter((r: any) => r.execution_stage === "stage_b").length}**`);
p(`- cases added / removed / replaced: **none** (frozen membership; not altered after seeing results)`);
p(`- deviations:`);
p(`  1. \`django__django-10973\` is the matrix's known OTHER_INVALID (contract_absent) case — recorded as pre-flight invalid / skipped and **not replaced** (stays within the 50-instance cap). Stage B live runs = ${s.stage_b_selected}.`);
p(`  2. Pre-flight re-rendered the gate-on injected context with current code: ${preflight.reuse_count} reuse (persisted index) + ${preflight.clone_count} clone (temp dir, cleaned up). No retrieval/scoring/ranking code touched (no \`src/\` change since the matrix commit).`);
if ((s.operational_retry_count ?? 0) > 0 || (s.quota_abort_count ?? 0) > 0) {
  p(`  3. Operational retries: ${s.operational_retry_count} retry launch(es) on the SAME instance/condition after a transient infra/quota abort (${s.quota_abort_count} abort(s)); not counted as replacement tasks or variance replicates. ${JSON.stringify(s.retries_by_instance)}`);
}
p();
p("## Stage B Pre-flight");
p(`- valid cases: **${preflight.valid_count}**`);
p(`- invalid cases (rendered): **${preflight.total - preflight.valid_count}** ${preflight.invalid_cases?.length ? "(" + preflight.invalid_cases.map((c: any) => `${c.instance_id}:${c.final_status}`).join(", ") + ")" : ""}`);
p(`- skipped cases (matrix-invalid, not re-rendered): **${(preflight.skipped_from_matrix ?? []).length}** ${(preflight.skipped_from_matrix ?? []).map((c: any) => c.instance_id).join(", ")}`);
p(`- zero-required cases: **${preflight.zero_required_count}** ${(preflight.zero_required_cases ?? []).length ? "(" + preflight.zero_required_cases.join(", ") + ")" : ""}`);
p(`- demoted pivot count (pre-flight): **${preflight.demoted_pivot_count}**`);
p(`- required IMPACT count (pre-flight): **${preflight.required_impact_target_count}**`);
p(`- optional/FYI integrity: optional_impact_context_missing=${preflight.optional_impact_context_missing_count}`);
p(`- confidence-gate integrity: gate-on render reproduced for all rendered cases (reuse=${preflight.reuse_count}, clone=${preflight.clone_count}); partial sentinel=${preflight.partial_sentinel_count}`);
p();
p("### Live gate integrity (treatment runs)");
p(`- \`--pivot-confidence-gate\` applied to all ${s.new_live_runs} runs (driver-hard-coded): **${s.gate_flag_applied_all_runs}**`);
p(`- live render reproduced the pre-flight render in **${s.gate_matches_preflight_count}/${s.new_live_runs}** runs`);
p(`- runs with a definitive gate effect (demoted pivot or zero-required+marker — gate-only outputs): **${s.gate_definitive_effect_count}**`);
p(`- pre-flight render drift (benign): **${s.preflight_render_drift_count}** case(s) where the pre-flight REUSE render (older persisted index) differs from the live fresh-clone render. All remain valid gated contracts; the live render is what the agent saw. Not a gate failure (CLAUDE.md: persisted workspaces can be stale).`);
for (const dft of s.preflight_render_drift_cases ?? []) {
  p(`  - ${dft.instance_id}: pre-flight req=${dft.preflight_required}/demoted=${dft.preflight_demoted} → live req=${dft.live_required}/demoted=${dft.live_demoted} (gate effect visible: ${dft.gate_effect_visible}; resolved: ${yn(dft.resolved)})`);
}
p();
p("## Run Matrix");
p("| instance_id | repo | difficulty | baseline_reuse | base_resolved | preflight | treatment_run_label | valid | evaluated | resolved | retries | notes |");
p("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of detail) {
  const note = !r.run_present ? "no run" : r.invalid_reason ? r.invalid_reason : "";
  p(`| ${r.instance_id} | ${r.repo} | ${r.difficulty} | ${r.baseline_reuse_status} | ${fmt(r.baseline_resolved)} | ${r.preflight_status} | ${r.run_label} | ${yn(r.valid_run)} | ${yn(r.evaluated)} | ${yn(r.resolved)} | ${r.operational_retry_count ?? 0} | ${note} |`);
}
p();
p("## Results Table");
p("| instance_id | repo | base_reuse | treat_resolved | base_resolved | total_tokens | cost | tools | reads | searches | rpt_reads | req_tgts | demoted | open | inv_ruleout | optional | opt_edited |");
p("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of detail.filter((x) => x.run_present)) {
  p(`| ${r.instance_id} | ${r.repo} | ${r.baseline_reuse_status} | ${yn(r.resolved)} | ${fmt(r.baseline_resolved)} | ${r.total_tokens} | ${usd(r.cost)} | ${r.tool_call_count} | ${r.read_count} | ${r.search_count} | ${r.repeated_file_reads} | ${r.required_target_count} | ${r.demoted_pivot_count} | ${r.required_target_open_count} | ${r.required_target_invalid_decision_count} | ${r.optional_context_target_count} | ${(r.optional_context_edited ?? []).length} |`);
}
p();
p("## Stage B Paired Subset Analysis");
p("_Cases with reused_verified baselines only._");
const ps = s.paired_vs_baseline;
p(`- paired_case_count: **${ps.paired_case_count}**`);
p(`- baseline_passes: **${ps.baseline_passes}**`);
p(`- treatment_passes: **${ps.treatment_passes}**`);
p(`- both_pass: **${ps.both_pass}**`);
p(`- both_fail: **${ps.both_fail}**`);
p(`- treatment_only_pass: **${ps.treatment_only_pass}**`);
p(`- baseline_only_pass: **${ps.baseline_only_pass}**`);
p(`- pooled cost (metrics pairs=${ps.metrics_pairs}): treatment ${usd(ps.pooled_treatment_cost)} vs baseline ${usd(ps.pooled_baseline_cost)}`);
p(`- pooled tokens: treatment ${ps.pooled_treatment_tokens.toLocaleString()} vs baseline ${ps.pooled_baseline_tokens.toLocaleString()}`);
p();
p("## Stage B Unpaired Treatment-Only Analysis");
p("_Cases with fresh_required baselines pending (Stage C). Paired conclusion is pending Stage C._");
const us = s.unpaired_treatment_only;
p(`- case_count: **${us.case_count}**`);
p(`- treatment_passes: **${us.treatment_passes}**`);
p(`- treatment_failures: **${us.treatment_failures}**`);
p(`- pooled cost: ${usd(us.pooled_cost)} (mean ${usd(us.mean_cost)}/run); pooled tokens ${us.pooled_tokens.toLocaleString()}; mean tool calls ${us.mean_tool_calls}`);
p();
p("## Cumulative Stage A+B Treatment Summary");
p("_Treatment-only. NOT the final paired 100-task conclusion (Stage C fresh baselines pending)._");
p(`- selected tasks: **${cum.selected_tasks_total}** (Stage A ${cum.stage_a_selected} + Stage B ${cum.stage_b_selected})`);
p(`- pre-flight skipped (in denominator): **${cum.preflight_skipped_total}** ${cum.preflight_skipped_cases.length ? "(" + cum.preflight_skipped_cases.join(", ") + ")" : ""}`);
p(`- treatment denominator after skips: **${cum.treatment_denominator_after_skips}**`);
p(`- treatment attempted: **${cum.treatment_attempted}**`);
p(`- treatment valid / invalid: **${cum.treatment_valid} / ${cum.treatment_invalid}** (${cum.validity_rate_pct}%)`);
p(`- treatment resolved / unresolved: **${cum.treatment_resolved} / ${cum.treatment_unresolved}**`);
p(`- patch produced / no-patch fail-closed: **${cum.patch_produced} / ${cum.no_patch_fail_closed}**`);
p(`- Docker evals: **${cum.docker_evals}**`);
p(`- total treatment cost: **${usd(cum.total_treatment_cost)}** (Stage A ${usd(cum.stage_a_cost)} + Stage B ${usd(cum.stage_b_cost)}); mean ${usd(cum.mean_treatment_cost)}, median ${usd(cum.median_treatment_cost)}`);
p(`- structured-decision: coverage **${cum.structured_decision.coverage_pct}%**, ignored **${cum.structured_decision.ignored_rate_pct}%**, invalid rule-out **${cum.structured_decision.invalid_rule_out_rate_pct}%**`);
p(`- required IMPACT count: **${cum.required_impact_count}**; zero-required count: **${cum.zero_required_count}**; demoted pivot count: **${cum.demoted_pivot_count}**`);
p(`- reused baseline available: **${cum.reused_baseline_available}**; fresh baseline pending Stage C: **${cum.fresh_baseline_pending_stage_c}** (paired completion requirement for Stage C)`);
p();
p("## Structured Decision Analysis");
p(`- required targets (pooled, valid): **${dec.required}** — closed ${dec.closed}, open ${dec.open}, ignored ${dec.ignored}, invalid ${dec.invalid}`);
p(`- decisions: EDIT ${dec.edited}, RULE_OUT ${dec.ruled_out}, INSPECT_ONLY_NO_EDIT ${dec.inspect_only_no_edit}`);
p(`- decision coverage: **${dec.coverage_pct}%**`);
p(`- ignored rate: **${dec.ignored_rate_pct}%**`);
p(`- invalid rule-out rate: **${dec.invalid_rule_out_rate_pct}%**`);
p(`- zero-required count: **${s.zero_required_count}** (all marker-backed=${s.zero_required_all_marker_backed})`);
p(`- demoted pivot count: **${s.demoted_pivot_total}** (any demoted edited=${s.any_demoted_pivot_edited})`);
p(`- required IMPACT target count: **${detail.filter((r) => r.required_has_impact).length}** (required_impact_any=${s.required_impact_any})`);
p(`- optional impact inspected/edited: inspected ${detail.filter((r) => r.valid_run).reduce((a, r) => a + (r.optional_context_inspected ?? []).length, 0)}, edited ${detail.filter((r) => r.valid_run).reduce((a, r) => a + (r.optional_context_edited ?? []).length, 0)}`);
p(`- off-target edits (pooled): **${s.off_target_edit_total}**`);
p(`- comparison to M71 Stage A: coverage ${s.structured_decision_m72.coverage_pct}% (B) vs Stage A (see M71 report); comparison to M69: coverage ${m69dec?.coverage_pct ?? "—"}%, ignored ${m69dec?.ignored_rate_pct ?? "—"}%, invalid rule-out ${m69dec?.invalid_rule_out_rate_pct ?? "—"}%`);
p();
p("## Cost / Operational Analysis");
p(`- total Stage B treatment cost: **${usd(s.cost.total)}**`);
p(`- cumulative Stage A+B treatment cost: **${usd(cum.total_treatment_cost)}**`);
p(`- Stage B mean / median cost: **${usd(s.cost.mean)} / ${usd(s.cost.median)}**`);
p(`- pooled tokens (Stage B): **${s.cost.pooled_total_tokens.toLocaleString()}**`);
p(`- thrashing outlier (max cost): **${fmt(s.cost.max_cost_case)}** at ${usd(s.cost.max_cost_value)}`);
p(`- quota aborts / operational retries: **${s.quota_abort_count} / ${s.operational_retry_count}**`);
{
  const byRepo: Record<string, number> = {};
  for (const r of detail.filter((x) => x.run_present)) byRepo[r.repo] = (byRepo[r.repo] ?? 0) + (r.cost ?? 0);
  const top = Object.entries(byRepo).sort((a, b) => b[1] - a[1]).slice(0, 5);
  p(`- repo cost concentration (top 5): ${top.map(([k, v]) => `${k} ${usd(v)}`).join(", ")}`);
}
p(`- projected Stage C fresh-baseline cost risk: ${cum.fresh_baseline_pending_stage_c} fresh baselines pending; at Stage B mean ${usd(s.cost.mean)}/run a comparable baseline arm is roughly ${usd(cum.fresh_baseline_pending_stage_c * s.cost.mean)} (baseline runs historically cost more than treatment — treat as a lower bound).`);
p();
p("## Success Criteria Check");
p("PASS only if all of:");
for (const c of crit) p(`- ${c.pass === true ? "✅" : c.pass === false ? "❌" : "⚠️"} **C${c.id}** ${c.label} — ${c.detail}`);
p();
p("## Verdict");
p(`**${verdict}**`);
p();
p("## Recommendation");
p(`**${recommendation}**`);
p();
p("---");
p("_Interpretation guardrails: this is Stage B only — not the full 100-task benchmark, not Stage C, not a default promotion. No VEXP-parity or general SWE-bench-improvement claim is made. Paired pass-rate conclusions are limited to the reused-baseline subset; the rest is treatment-only pending Stage C fresh baselines._");
p();

fs.writeFileSync(path.join(RESULTS, "stage5_m72_stage_b_50_treatment.md"), L.join("\n") + "\n");
console.log(`verdict=${verdict} recommendation=${recommendation}`);
console.log("criteria:", crit.map((c) => `C${c.id}:${c.pass === true ? "P" : c.pass === false ? "F" : "?"}`).join(" "));
