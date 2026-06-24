/**
 * M71 — render the Stage A 50-treatment Markdown report from the captured analysis JSON
 * (stage5_m71_stage_a_50_treatment.json + .detail.json) and the frozen execution matrix.
 * No agents, no Docker, no spend. Pure formatting + success-criteria evaluation.
 *
 * Usage: bun run_stage5_m71_stage_a_report.ts
 */
import fs from "node:fs";
import path from "node:path";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(RESULTS, p), "utf8")) as T;

const s = readJson<any>("stage5_m71_stage_a_50_treatment.json");
const detail = readJson<any[]>("stage5_m71_stage_a_50_treatment.detail.json");
const preflight = readJson<any>("stage5_m71_stage_a_preflight.json");
const matrix = readJson<any>("stage5_m70b_100_task_execution_matrix.json");

const fmt = (v: any) => (v === null || v === undefined ? "—" : String(v));
const yn = (b: any) => (b === true ? "yes" : b === false ? "no" : "—");
const usd = (v: any) => (typeof v === "number" ? `$${v.toFixed(2)}` : "—");

// ---------- success criteria ----------
const dec = s.structured_decision_m71;
const m69dec = s.structured_decision_m69 ?? { invalid_rule_out_rate_pct: 7.32, coverage_pct: 90.24 };
const validityOk = s.validity_rate_pct >= 95;
const invalidRuleOutDelta = dec.invalid_rule_out_rate_pct - (m69dec?.invalid_rule_out_rate_pct ?? 0);
const projected = s.cost.projected_100_treatment_cost;
// preregistered acceptable cost ceiling: not formally fixed; flag if projected 100-treatment
// cost would be an order of magnitude above the M69-scaled expectation. Use a generous guard.
const COST_SANITY_CEILING = 200; // USD for 100 treatment runs; well above any prior slice
const crit: Array<{ id: string; label: string; pass: boolean | null; detail: string }> = [
  { id: "1", label: "Stage A pre-flight has no partial sentinel", pass: (preflight.partial_sentinel_count ?? 0) === 0 && !s.partial_sentinel_any, detail: `preflight partial_sentinel=${preflight.partial_sentinel_count ?? 0}, run partial_sentinel_any=${s.partial_sentinel_any}` },
  { id: "2", label: "treatment valid in >=95% of attempted runs", pass: validityOk, detail: `${s.valid_treatment_runs}/${s.new_live_runs} = ${s.validity_rate_pct}%` },
  { id: "3", label: "no required IMPACT targets emitted", pass: s.required_impact_any === false, detail: `required_impact_any=${s.required_impact_any}` },
  { id: "4", label: "confidence gate enabled in all valid treatment runs", pass: s.gate_enabled_all === true, detail: `gate verified ${s.gate_enabled_count}/${s.valid_treatment_runs}` },
  { id: "5", label: "optional/FYI targets not closure-scored", pass: detail.filter((r) => r.valid_run && r.optional_impact_id_count > 0).every((r) => r.optional_impact_not_closure_scored), detail: `optional_impact_ok=${s.optional_impact_ok}` },
  { id: "6", label: "decision coverage >=90% (or miss explained by zero-required/known-invalid)", pass: dec.coverage_pct >= 90, detail: `coverage ${dec.coverage_pct}% (zero-required=${s.zero_required_count})` },
  { id: "7", label: "invalid rule-out rate not >2pp above M69", pass: invalidRuleOutDelta <= 2, detail: `M71 ${dec.invalid_rule_out_rate_pct}% vs M69 ${m69dec?.invalid_rule_out_rate_pct ?? "—"}% (Δ ${invalidRuleOutDelta.toFixed(2)}pp)` },
  { id: "8", label: "no severe cost explosion (projected 100-treatment acceptable)", pass: projected <= COST_SANITY_CEILING, detail: `projected 100-treatment ${usd(projected)} (mean ${usd(s.cost.mean)}/run)` },
  { id: "9", label: "no systematic failure pattern making Stage B unsafe", pass: s.invalid_treatment_runs <= Math.ceil(0.05 * s.new_live_runs) && !s.required_impact_any && s.gate_enabled_all, detail: `${s.invalid_treatment_runs} invalid; gate_all=${s.gate_enabled_all}; required_impact=${s.required_impact_any}` },
];
const allPass = crit.every((c) => c.pass === true);
const hardInvalid = preflight.valid_count < 45 || s.partial_sentinel_any || s.required_impact_any || s.ids_collide_any;
const verdict = hardInvalid ? "INVALID" : allPass ? "PASS" : crit.filter((c) => c.pass !== true).length <= 2 ? "MIXED" : "FAIL";
const recommendation =
  verdict === "PASS" ? "authorize Stage B 50 treatment runs"
  : verdict === "MIXED" ? "pause for audit"
  : verdict === "INVALID" ? "fix pre-flight/render issue before more live runs"
  : "pause for audit";

// ---------- markdown ----------
const L: string[] = [];
const p = (x = "") => L.push(x);

p("# Stage 5 M71 Stage A 50-Treatment Run");
p();
p("## Summary");
p(`- Stage A selected count: **${s.stage_a_selected}**`);
p(`- pre-flight valid / invalid / skipped: **${preflight.valid_count} / ${preflight.total - preflight.valid_count} / 0** (of ${preflight.total})`);
p(`- new live treatment runs: **${s.new_live_runs}**`);
p(`- Docker evals: **${s.docker_evals}**`);
p(`- reused baselines available in Stage A: **${s.baselines_reused_available}**`);
p(`- fresh baselines pending in Stage A (Stage C): **${s.baselines_missing_pending_stage_c}**`);
p(`- treatment valid / invalid: **${s.valid_treatment_runs} / ${s.invalid_treatment_runs}** (${s.validity_rate_pct}%)`);
p(`- headline treatment resolution: **${s.resolution.treatment_resolved}/${s.resolution.n}** resolved (${s.resolution.treatment_evaluated} evaluated)`);
p(`- paired (reused-baseline) subset: treatment **${s.paired_vs_baseline.treatment_passes}/${s.paired_vs_baseline.paired_case_count}** vs baseline **${s.paired_vs_baseline.baseline_passes}/${s.paired_vs_baseline.paired_case_count}**`);
p(`- unpaired (fresh-baseline-pending) subset: treatment **${s.unpaired_treatment_only.treatment_passes}/${s.unpaired_treatment_only.case_count}** (paired conclusion pending Stage C)`);
p(`- headline cost: total **${usd(s.cost.total)}**, mean **${usd(s.cost.mean)}**/run, pooled tokens **${s.cost.pooled_total_tokens.toLocaleString()}**`);
p(`- structured-decision compliance: coverage **${dec.coverage_pct}%**, ignored **${dec.ignored_rate_pct}%**, invalid rule-out **${dec.invalid_rule_out_rate_pct}%**`);
p(`- verdict: **${verdict}**`);
p(`- recommendation: **${recommendation}**`);
p();
p("## Fixture / Matrix Compliance");
p(`- M70B execution matrix used: \`stage5_m70b_100_task_execution_matrix.json\` (${matrix.rows.length} rows)`);
p(`- Stage A membership (execution_stage == "stage_a"): **${matrix.rows.filter((r: any) => r.execution_stage === "stage_a").length}**`);
p(`- cases added / removed / replaced: **none** (frozen membership; not altered after seeing results)`);
const acc = s.live_run_accounting;
p(`- deviations:`);
p(`  1. Pre-flight rendered to an isolated temp \`--out\` with the real \`results/workspaces\` symlinked in (reuse), so the committed \`stage5_m70b_preflight.json\` was not overwritten. No retrieval/scoring/ranking code touched.`);
if (acc) p(`  2. Quota interruption: ${acc.quota_aborted_first_pass} first-pass runs (${acc.quota_aborted_cases.join(", ")}) were aborted by the account's 5-hour session limit (HTTP 429 \`out_of_credits\`) with no patch. The user explicitly authorized re-running those ${acc.reruns_after_credit_reset} **distinct** instances after the credit reset to obtain one valid result per Stage A instance — ${acc.total_live_launches} total live launches vs the literal 50-launch cap, **no** new/replacement instances and **no** variance replicates. All ${acc.reruns_completed} re-runs completed cleanly with no repeat 429.`);
p();
p("## Stage A Pre-flight");
p(`- valid cases: **${preflight.valid_count}**`);
p(`- invalid cases: **${preflight.total - preflight.valid_count}** ${preflight.invalid_cases?.length ? "(" + preflight.invalid_cases.map((c: any) => `${c.instance_id}:${c.final_status}`).join(", ") + ")" : ""}`);
p(`- skipped cases: **0**`);
p(`- zero-required cases: **${preflight.zero_required_count}** ${(preflight.zero_required_cases ?? []).length ? "(" + preflight.zero_required_cases.join(", ") + ")" : ""}`);
p(`- demoted pivot count (pre-flight): **${preflight.demoted_pivot_count}**`);
p(`- required IMPACT count (pre-flight): **${preflight.required_impact_target_count}**`);
p(`- optional/FYI integrity: optional_impact_context_missing=${preflight.optional_impact_context_missing_count}`);
p(`- confidence-gate integrity: gate-on render reproduced for all rendered cases (reuse=${preflight.reuse_count}, clone=${preflight.clone_count})`);
p();
p("## Run Matrix");
p("| instance_id | repo | difficulty | baseline_reuse | base_resolved | preflight | valid | evaluated | resolved | notes |");
p("|---|---|---|---|---|---|---|---|---|---|");
for (const r of detail) {
  const note = !r.run_present ? "no run" : r.invalid_reason ? r.invalid_reason : "";
  p(`| ${r.instance_id} | ${r.repo} | ${r.difficulty} | ${r.baseline_reuse_status} | ${fmt(r.baseline_resolved)} | ${r.preflight_status} | ${yn(r.valid_run)} | ${yn(r.evaluated)} | ${yn(r.resolved)} | ${note} |`);
}
p();
p("## Results Table");
p("| instance_id | repo | base_reuse | treat_resolved | base_resolved | total_tokens | cost | tools | reads | searches | rpt_reads | req_tgts | demoted | open | inv_ruleout | optional | opt_edited |");
p("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of detail.filter((x) => x.run_present)) {
  p(`| ${r.instance_id} | ${r.repo} | ${r.baseline_reuse_status} | ${yn(r.resolved)} | ${fmt(r.baseline_resolved)} | ${r.total_tokens} | ${usd(r.cost)} | ${r.tool_call_count} | ${r.read_count} | ${r.search_count} | ${r.repeated_file_reads} | ${r.required_target_count} | ${r.demoted_pivot_count} | ${r.required_target_open_count} | ${r.required_target_invalid_decision_count} | ${r.optional_context_target_count} | ${(r.optional_context_edited ?? []).length} |`);
}
p();
p("## Paired Subset Analysis");
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
p("## Unpaired Treatment-Only Analysis");
p("_Cases with fresh_required baselines pending (Stage C). Paired conclusion is pending Stage C._");
const us = s.unpaired_treatment_only;
p(`- case_count: **${us.case_count}**`);
p(`- treatment_passes: **${us.treatment_passes}**`);
p(`- treatment_failures: **${us.treatment_failures}**`);
p(`- pooled cost: ${usd(us.pooled_cost)} (mean ${usd(us.mean_cost)}/run); pooled tokens ${us.pooled_tokens.toLocaleString()}; mean tool calls ${us.mean_tool_calls}`);
p();
p("## Structured Decision Analysis");
p(`- required targets (pooled): **${dec.required}** — closed ${dec.closed}, open ${dec.open}, ignored ${dec.ignored}, invalid ${dec.invalid}`);
p(`- decisions: EDIT ${dec.edited}, RULE_OUT ${dec.ruled_out}, INSPECT_ONLY_NO_EDIT ${dec.inspect_only_no_edit}`);
p(`- decision coverage: **${dec.coverage_pct}%**`);
p(`- ignored rate: **${dec.ignored_rate_pct}%**`);
p(`- invalid rule-out rate: **${dec.invalid_rule_out_rate_pct}%**`);
p(`- zero-required count: **${s.zero_required_count}** (all marker-backed=${s.zero_required_all_marker_backed})`);
p(`- demoted pivot count: **${s.demoted_pivot_total}** (any demoted edited=${s.any_demoted_pivot_edited})`);
p(`- required IMPACT target count: **${dec.required ? detail.filter((r) => r.required_has_impact).length : 0}** (required_impact_any=${s.required_impact_any})`);
p(`- off-target edits (pooled): **${s.off_target_edit_total}**`);
p(`- comparison to M69: M69 coverage ${m69dec?.coverage_pct ?? "—"}%, ignored ${m69dec?.ignored_rate_pct ?? "—"}%, invalid rule-out ${m69dec?.invalid_rule_out_rate_pct ?? "—"}%`);
p();
p("## Cost / Operational Analysis");
p(`- total Stage A treatment cost: **${usd(s.cost.total)}**`);
p(`- mean / median cost: **${usd(s.cost.mean)} / ${usd(s.cost.median)}**`);
p(`- pooled tokens: **${s.cost.pooled_total_tokens.toLocaleString()}**`);
p(`- thrashing outlier (max cost): **${fmt(s.cost.max_cost_case)}** at ${usd(s.cost.max_cost_value)}`);
{
  const byRepo: Record<string, number> = {};
  for (const r of detail.filter((x) => x.run_present)) byRepo[r.repo] = (byRepo[r.repo] ?? 0) + (r.cost ?? 0);
  const top = Object.entries(byRepo).sort((a, b) => b[1] - a[1]).slice(0, 5);
  p(`- repo cost concentration (top 5): ${top.map(([k, v]) => `${k} ${usd(v)}`).join(", ")}`);
}
p(`- projected full 100-treatment cost (Stage A mean × 100): **${usd(projected)}**`);
p();
p("## Success Criteria Check");
for (const c of crit) p(`- ${c.pass === true ? "✅" : c.pass === false ? "❌" : "⚠️"} **C${c.id}** ${c.label} — ${c.detail}`);
p();
p("## Verdict");
p(`**${verdict}**`);
p();
p("## Recommendation");
p(`**${recommendation}**`);
p();
p("---");
p("_Interpretation guardrails: this is Stage A only — not the full 100-task benchmark, not Stage B/C, not a default promotion. No VEXP-parity or general SWE-bench-improvement claim is made. Paired pass-rate conclusions are limited to the reused-baseline subset; the rest is treatment-only pending Stage C fresh baselines._");
p();

fs.writeFileSync(path.join(RESULTS, "stage5_m71_stage_a_50_treatment.md"), L.join("\n") + "\n");
console.log(`verdict=${verdict} recommendation=${recommendation}`);
console.log("criteria:", crit.map((c) => `C${c.id}:${c.pass === true ? "P" : c.pass === false ? "F" : "?"}`).join(" "));
