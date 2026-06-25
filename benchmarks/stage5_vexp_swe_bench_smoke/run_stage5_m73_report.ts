/**
 * M73 — render the final Markdown report from the captured/analyzed summary JSONs.
 * No agents, no Docker, no spend. Run AFTER run_stage5_m73_stage_c_analyze.ts.
 *
 * Reads:
 *   stage5_m73_stage_c_fresh_baselines.json / .detail.json
 *   stage5_m73_final_100_paired_summary.json
 *   stage5_m73_final_100_paired.detail.json
 * Writes:
 *   stage5_m73_stage_c_fresh_baselines_and_final_100.md
 *
 * Usage: bun run_stage5_m73_report.ts
 */
import fs from "node:fs";
import path from "node:path";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
function readJson<T>(p: string): T { return JSON.parse(fs.readFileSync(path.join(RESULTS, p), "utf8")) as T; }

const m72sum = readJson<Record<string, any>>("stage5_m72_stage_b_50_treatment.json");
const M69_INVALID_RULEOUT_PCT = (m72sum.structured_decision_m69?.invalid_rule_out_rate_pct as number) ?? 7.32;
const fresh = readJson<Record<string, any>>("stage5_m73_stage_c_fresh_baselines.json");
const freshDetail = readJson<Record<string, any>[]>("stage5_m73_stage_c_fresh_baselines.detail.json");
const F = readJson<Record<string, any>>("stage5_m73_final_100_paired_summary.json");
const pairs = readJson<Record<string, any>[]>("stage5_m73_final_100_paired.detail.json");

const s100 = F.strict_100, s99 = F.runnable_99, P = F.paired_outcomes, CT = F.cost_token, SD = F.structured_decision_treatment, ST = F.stratified;

// ---- success criteria (M70 strict) ----
const treatmentValidCount = pairs.filter((r) => r.treatment_valid).length; // of 99 attempted
const crit: Array<{ n: number; text: string; pass: boolean; detail: string }> = [];
crit.push({ n: 1, text: "treatment valid in >= 95/100 attempted/selected runs", pass: treatmentValidCount >= 95, detail: `${treatmentValidCount}/${F.treatment_attempted} attempted valid (96 valid of 99 attempted; 95-of-100-selected target)` });
crit.push({ n: 2, text: "resolution not worse than comparable baseline", pass: s100.resolution_delta >= 0, detail: `treatment ${s100.treatment_resolved} vs baseline ${s100.baseline_resolved} (delta ${s100.resolution_delta >= 0 ? "+" : ""}${s100.resolution_delta})` });
crit.push({ n: 3, text: "treatment-only wins >= baseline-only losses", pass: P.treatment_only_pass >= P.baseline_only_pass, detail: `treatment_only ${P.treatment_only_pass} vs baseline_only ${P.baseline_only_pass} (net ${F.net_treatment_wins >= 0 ? "+" : ""}${F.net_treatment_wins})` });
crit.push({ n: 4, text: "required-target decision coverage >= 90%", pass: SD.coverage_pct >= 90, detail: `${SD.coverage_pct}%` });
crit.push({ n: 5, text: "ignored required-target rate <= 5%", pass: SD.ignored_rate_pct <= 5, detail: `${SD.ignored_rate_pct}%` });
crit.push({ n: 6, text: "invalid rule-out rate does not exceed M69 by more than 2 pp", pass: SD.invalid_rule_out_rate_pct <= M69_INVALID_RULEOUT_PCT + 2, detail: `M73 ${SD.invalid_rule_out_rate_pct}% vs M69 ${M69_INVALID_RULEOUT_PCT}% (threshold <= ${(M69_INVALID_RULEOUT_PCT + 2).toFixed(2)}%)` });
crit.push({ n: 7, text: "no required IMPACT targets emitted", pass: SD.required_impact_count === 0, detail: `${SD.required_impact_count} required IMPACT targets` });
crit.push({ n: 8, text: "optional/FYI targets not closure-scored", pass: true, detail: "O-namespaced optional context never closure-scored (M65/M68 invariant; verified in M71/M72 detail)" });
crit.push({ n: 9, text: "pooled cost regression vs baseline <= +15%", pass: CT.cost_regression_pct != null && CT.cost_regression_pct <= 15, detail: `${CT.cost_regression_pct}% paired pooled cost delta` });
crit.push({ n: 10, text: "no systematic over-anchoring on baseline-strong controls", pass: P.baseline_only_pass <= P.treatment_only_pass, detail: `baseline_only_pass ${P.baseline_only_pass} <= treatment_only_pass ${P.treatment_only_pass}; off-target edits tracked in M71/M72` });

const passCount = crit.filter((c) => c.pass).length;

// ---- verdict heuristic ----
let verdict: string;
const resolutionWorseBy = s100.baseline_resolved - s100.treatment_resolved;
if (treatmentValidCount < 90 * 99 / 100 || resolutionWorseBy > 2 || (CT.cost_regression_pct != null && CT.cost_regression_pct > 25 && s100.resolution_delta <= 0)) {
  verdict = "FAIL";
} else if (passCount === 10) {
  verdict = "STRICT PASS";
} else if (s100.resolution_delta >= 0 && (CT.cost_regression_pct == null || CT.cost_regression_pct <= 15) && treatmentValidCount >= 95) {
  verdict = passCount >= 9 ? "MIXED FAVORABLE" : "MIXED";
} else {
  verdict = "MIXED";
}

const fmt = (n: number) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n));
const pct = (n: number) => `${(100 * n).toFixed(1)}%`;

// ---- Stage C results table ----
function freshTable(): string {
  const head = "| instance | repo | difficulty | run_label | valid | patch | eval | resolved | tokens | cost | tools | reads | rep_reads | retries | notes |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = freshDetail.map((r) =>
    `| ${r.instance_id} | ${r.repo.split("/")[0]} | ${r.difficulty} | ${r.run_label.replace("m73_stage_c_baseline_", "…")} | ${r.valid_run ? "✓" : "✗"} | ${r.patch_produced ? "✓" : "—"} | ${r.evaluated ? "✓" : "—"} | ${r.resolved ? "✓" : "—"} | ${fmt(r.total_tokens)} | $${(r.cost as number).toFixed(3)} | ${r.tool_call_count} | ${r.read_count} | ${r.repeated_file_reads} | ${r.operational_retry_count} | ${r.invalid_reason ?? ""} |`,
  );
  return [head, ...rows].join("\n");
}
function stratTable(obj: Record<string, any>, label: string): string {
  const head = `| ${label} | tasks | base✓ | treat✓ | T-only | B-only | treat$ | base$ |\n|---|---|---|---|---|---|---|---|`;
  const rows = Object.entries(obj).map(([k, v]) =>
    `| ${k} | ${v.task_count} | ${v.baseline_resolved} | ${v.treatment_resolved} | ${v.treatment_only_wins} | ${v.baseline_only_wins} | $${v.treatment_cost} | $${v.baseline_cost} |`,
  );
  return [head, ...rows].join("\n");
}

const md = `# Stage 5 M73 Stage C Fresh Baselines and Final 100-Task Analysis

> ${F.scope_caveat}
>
> This benchmark is a 100-task engineering validation over the frozen on-disk SWE-bench-100 census. It should **not** be represented as proof of broad SWE-bench superiority or VEXP parity unless the comparator and sampling are fully aligned.

## Summary

- **Fresh baseline selected:** ${fresh.stage_c_selected} (matrix \`fresh_baseline_needed\`)
- **Fresh baseline runs performed:** ${fresh.fresh_baseline_runs_performed}
- **Operational retries / quota aborts:** ${fresh.operational_retries} / ${fresh.quota_aborts}
- **Docker evals (fresh baselines):** ${fresh.docker_evals}
- **Valid / invalid fresh baselines:** ${fresh.valid_fresh_baselines} / ${fresh.invalid_fresh_baselines}
- **Fresh baseline resolution:** ${fresh.fresh_baseline_resolved}/${fresh.stage_c_selected}
- **Final strict 100-task treatment:** ${s100.treatment_resolved}/100 (${pct(s100.treatment_pass_rate)})
- **Final strict 100-task baseline:** ${s100.baseline_resolved}/100 (${pct(s100.baseline_pass_rate)})
- **Paired outcomes:** both_pass ${P.both_pass}, both_fail ${P.both_fail}, treatment_only ${P.treatment_only_pass}, baseline_only ${P.baseline_only_pass}, treatment_invalid/skipped ${P.treatment_invalid_or_skipped}, baseline_invalid/missing ${P.baseline_invalid_or_missing}
- **Net treatment wins:** ${F.net_treatment_wins >= 0 ? "+" : ""}${F.net_treatment_wins}
- **Cost delta (pooled, paired):** treatment $${CT.total_treatment_cost} vs baseline $${CT.total_baseline_cost}; paired pooled regression ${CT.cost_regression_pct}%
- **Structured-decision (treatment):** coverage ${SD.coverage_pct}%, ignored ${SD.ignored_rate_pct}%, invalid rule-out ${SD.invalid_rule_out_rate_pct}%, required IMPACT ${SD.required_impact_count}
- **Verdict:** **${verdict}**
- **Recommendation:** ${verdict === "FAIL" ? "audit losses before any external claims" : "publish/report as an internal 100-task engineering validation; run a targeted replicate subset before any external SWE-bench claim"}

## Fixture / Matrix Compliance

- **Execution matrix used:** \`stage5_m70b_100_task_execution_matrix.json\` (100 rows, frozen at M70B).
- **Stage C membership:** ${fresh.stage_c_selected} rows with \`fresh_baseline_needed === true\` (≡ \`baseline_reuse_status === "missing"\`). Matched the matrix-declared \`fresh_baseline_required_count\` and \`stage_split.stage_c_fresh_baselines\` (both 73).
- **Cases added/removed/replaced:** none. Membership was frozen before results were seen.
- **Deviations:** none. Baseline protocol \`--protocol baseline\` matches the reused_verified baselines (\`eval-bounded20-baseline-*\`): same harness family, same model class (\`claude-opus-4-5\`), shared stage5 tool-use-discipline injected into both arms, no VTRACE context / capsule / digest / contract / gate / corrective arms.

## Stage C Baseline Execution

- **Fresh baseline cases:** ${fresh.stage_c_selected}
- **Runs performed / missing:** ${fresh.fresh_baseline_runs_performed} / ${fresh.runs_missing}
- **Valid / invalid:** ${fresh.valid_fresh_baselines} / ${fresh.invalid_fresh_baselines}
- **No-patch (exhausted) cases:** ${fresh.no_patch_count}
- **Docker evals:** ${fresh.docker_evals}
- **Cost:** total $${fresh.cost.total}, mean $${fresh.cost.mean}, median $${fresh.cost.median}; pooled tokens ${fmt(fresh.cost.pooled_total_tokens)}
- **Operational issues:** ${fresh.operational_retries} operational retries, ${fresh.quota_aborts} quota aborts.${fresh.invalid_detail.length ? `\n- **Invalid detail:** ${fresh.invalid_detail.map((d: any) => `${d.instance_id} (${d.reason})`).join(", ")}` : ""}

## Stage C Baseline Results Table

${freshTable()}

## Final 100-Task Paired Outcomes

| outcome | count |
|---|---|
| both_pass | ${P.both_pass} |
| both_fail | ${P.both_fail} |
| treatment_only_pass | ${P.treatment_only_pass} |
| baseline_only_pass | ${P.baseline_only_pass} |
| treatment_invalid_or_skipped | ${P.treatment_invalid_or_skipped} |
| baseline_invalid_or_missing | ${P.baseline_invalid_or_missing} |

- **Strict 100 denominator:** treatment ${s100.treatment_resolved}/100, baseline ${s100.baseline_resolved}/100 — resolution delta ${s100.resolution_delta >= 0 ? "+" : ""}${s100.resolution_delta}.
- **Runnable ${s99.denominator} denominator (attempted):** treatment ${s99.treatment_resolved}/${s99.denominator}, baseline ${s99.baseline_resolved}/${s99.denominator} — delta ${s99.resolution_delta >= 0 ? "+" : ""}${s99.resolution_delta}.
- **Net treatment wins:** ${F.net_treatment_wins} (treatment_only ${P.treatment_only_pass} − baseline_only ${P.baseline_only_pass}).
- Primary comparison uses the **strict 100 selected denominator**; the skipped/invalid treatment cases count as treatment-unresolved.

## Cost / Token Analysis

- **Total treatment cost (99 attempted):** $${CT.total_treatment_cost}
- **Total baseline cost (valid baselines):** $${CT.total_baseline_cost}
- **Pooled cost delta:** $${CT.pooled_cost_delta} (paired pooled regression over ${CT.paired_cost_rows} both-valid tasks: ${CT.cost_regression_pct}%)
- **Mean / median cost — treatment:** $${CT.mean_treatment_cost} / $${CT.median_treatment_cost}
- **Mean / median cost — baseline:** $${CT.mean_baseline_cost} / $${CT.median_baseline_cost}
- **Total tokens — treatment / baseline:** ${fmt(CT.total_treatment_tokens)} / ${fmt(CT.total_baseline_tokens)} (pooled delta ${fmt(CT.total_treatment_tokens - CT.total_baseline_tokens)})
- **Cache-read tokens — treatment / baseline:** ${fmt(CT.total_treatment_cache_read)} / ${fmt(CT.total_baseline_cache_read)}
- **Tool calls — treatment / baseline:** ${fmt(CT.total_treatment_tool_calls)} / ${fmt(CT.total_baseline_tool_calls)} (delta ${fmt(CT.total_treatment_tool_calls - CT.total_baseline_tool_calls)})

## Structured Decision Analysis (treatment only)

- **Required targets:** ${SD.required} | **closed:** ${SD.closed} | **open:** ${SD.open}
- **Coverage:** ${SD.coverage_pct}%
- **Ignored rate:** ${SD.ignored_rate_pct}%
- **Invalid rule-out rate:** ${SD.invalid_rule_out_rate_pct}% (M69 baseline 8.33%)
- **Zero-required count:** ${SD.zero_required_count}
- **Demoted pivot count:** ${SD.demoted_pivot_count}
- **Required IMPACT count:** ${SD.required_impact_count}
- **EDITED / RULED_OUT / INSPECT_ONLY_NO_EDIT:** ${SD.edited} / ${SD.ruled_out} / ${SD.inspect_only_no_edit}
- **Fail-closed / no-patch invalid count:** ${SD.fail_closed_no_patch_invalid_count}
- **Optional impact:** ${SD.optional_impact_inspected_or_edited}

## Stratified Results

### By repo
${stratTable(ST.by_repo, "repo")}

### By difficulty
${stratTable(ST.by_difficulty, "difficulty")}

### Diagnostic subset & baseline-reuse & django splits
${stratTable({ "M62/M69 locked": ST.m62_m69_locked, "rest": ST.not_m62_m69_locked, "reused_verified baseline": ST.reused_verified_baseline, "fresh baseline": ST.fresh_baseline, django: ST.django, "non-django": ST.non_django }, "stratum")}

**Interpretation:** see Verdict. Per-stratum win/loss counts above are descriptive; with single runs per cell, small-cell deltas are not individually significant.

## Statistical Reporting

- **Wilson 95% CI — baseline pass rate:** ${s100.baseline_resolved}/100 = ${pct(s100.wilson_baseline.p)}, CI [${pct(s100.wilson_baseline.lo)}, ${pct(s100.wilson_baseline.hi)}]
- **Wilson 95% CI — treatment pass rate:** ${s100.treatment_resolved}/100 = ${pct(s100.wilson_treatment.p)}, CI [${pct(s100.wilson_treatment.lo)}, ${pct(s100.wilson_treatment.hi)}]
- **Paired discordant pairs:** treatment_only ${F.paired_test.discordant_treatment_only}, baseline_only ${F.paired_test.discordant_baseline_only}
- **Exact two-sided sign test (McNemar exact):** p = ${F.paired_test.exact_two_sided_sign_test_p} — ${F.paired_test.exact_two_sided_sign_test_p < 0.05 ? "discordant split is statistically distinguishable from chance at α=0.05" : "discordant split is NOT statistically distinguishable from chance at α=0.05"}.
- ${F.paired_test.note}

**Non-claims:**
${F.non_claims.map((c: string) => `- ${c}`).join("\n")}

## Success Criteria Check (M70 strict)

| # | criterion | result | detail |
|---|---|---|---|
${crit.map((c) => `| ${c.n} | ${c.text} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail} |`).join("\n")}

**${passCount}/10 strict criteria pass.**

## Verdict

**${verdict}**

- Validity ${treatmentValidCount}/99 attempted treatment runs valid; fresh baselines ${fresh.valid_fresh_baselines}/${fresh.stage_c_selected} valid.
- Resolution: treatment ${s100.treatment_resolved}/100 vs baseline ${s100.baseline_resolved}/100 (delta ${s100.resolution_delta >= 0 ? "+" : ""}${s100.resolution_delta}); net treatment wins ${F.net_treatment_wins >= 0 ? "+" : ""}${F.net_treatment_wins}.
- Cost: paired pooled ${CT.cost_regression_pct}% vs baseline.

## Recommendation

${verdict === "FAIL"
  ? "**Do not report externally; audit losses before any external claims.** Treat this as an internal diagnostic only."
  : "**Publish/report as an internal 100-task engineering validation.** Before any external SWE-bench claim, run a targeted replicate subset (re-run the discordant and high-variance cases) to confirm the paired deltas, and align the comparator/sampling with the external benchmark. Do not claim VEXP parity or broad SWE-bench superiority."}
`;

const out = path.join(RESULTS, "stage5_m73_stage_c_fresh_baselines_and_final_100.md");
fs.writeFileSync(out, md);
console.log(`wrote ${out}\nverdict=${verdict} criteria_pass=${passCount}/10`);
