/**
 * M73 — offline analysis: (1) extract metrics for the Stage C fresh baseline runs, and
 * (2) combine the 27 reused_verified baselines (M70B) + 73 fresh baselines (M73) +
 * 99 treatment runs (M71/M72) into the FINAL paired 100-task benchmark summary.
 *
 * Reads CAPTURED artifacts only — no agents, no Docker, no spend. Run AFTER the Stage C
 * driver's treat + evaluate phases complete.
 *
 * Outputs:
 *   stage5_m73_stage_c_fresh_baselines.detail.json   per-instance fresh baseline metrics
 *   stage5_m73_stage_c_fresh_baselines.json          fresh baseline aggregate
 *   stage5_m73_final_100_paired_summary.json         final paired 100-task summary
 *
 * Usage: bun run_stage5_m73_stage_c_analyze.ts
 */
import fs from "node:fs";
import path from "node:path";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const RUNS = path.join(RESULTS, "runs");
const MATRIX = path.join(RESULTS, "stage5_m70b_100_task_execution_matrix.json");
const FIXTURE = path.join(RESULTS, "stage5_m73_stage_c_fixture.json");
const M71_DETAIL = path.join(RESULTS, "stage5_m71_stage_a_50_treatment.detail.json");
const M72_DETAIL = path.join(RESULTS, "stage5_m72_stage_b_50_treatment.detail.json");
const M71_SUM = path.join(RESULTS, "stage5_m71_stage_a_50_treatment.json");
const M72_SUM = path.join(RESULTS, "stage5_m72_stage_b_50_treatment.json");
const LEDGER = path.join(RESULTS, "_m73_stage_c_driver_ledger.jsonl");

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return null; }
}
function readText(p: string): string { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function firstGlob(dir: string, prefix: string): string | null {
  try { const f = fs.readdirSync(dir).find((n) => n.startsWith(prefix)); return f ? path.join(dir, f) : null; } catch { return null; }
}
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

// ---- read a captured swebench run (baseline/vtrace/vexp) -> compact metrics ----
type SweMetrics = {
  found: boolean; condition: string | null; resolved: boolean; evaluated: boolean; patch_produced: boolean;
  cost: number; duration_ms: number;
  input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; total_tokens: number;
  turn_count: number; tool_call_count: number; reads: number; searches: number; edits: number; repeated_reads: number;
  model: string | null; instanceId: string | null; eval_status: string;
};
function readSweRun(runLabel: string): SweMetrics | null {
  const rawRoot = path.join(RUNS, runLabel, "raw");
  let raw: string | null = null; let cond: string | null = null;
  for (const c of ["baseline", "vtrace", "vexp"]) {
    const d = path.join(rawRoot, c);
    if (firstGlob(d, "swebench-")) { raw = d; cond = c; break; }
  }
  if (!raw) return null;
  const sweFile = firstGlob(raw, "swebench-");
  if (!sweFile) return null;
  const swe = (() => { const l = readText(sweFile).trim().split("\n").pop(); return l ? (JSON.parse(l) as Record<string, unknown>) : null; })();
  if (!swe) return null;
  const evalMeta = readJson<Record<string, unknown>>(path.join(raw, "_eval.meta.json"));
  const runMeta = readJson<Record<string, unknown>>(path.join(raw, "_run.meta.json"));
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const modelPatch = typeof swe.modelPatch === "string" ? (swe.modelPatch as string) : "";
  const it = num(swe.inputTokens), ot = num(swe.outputTokens), cr = num(swe.cacheReadTokens), cw = num(swe.cacheCreationTokens);
  const reads = toolCalls.filter((t) => t.category === "read");
  const seen = new Set<string>(); let repeated = 0;
  for (const t of reads) { const p = typeof t.path === "string" ? t.path : ""; if (!p) continue; if (seen.has(p)) repeated++; else seen.add(p); }
  const evaluated = evalMeta !== null;
  const evalStatus = !modelPatch.length ? "no_patch" : evaluated ? (evalMeta?.resolvedCount === 1 ? "resolved" : "unresolved") : "patch_unevaluated";
  return {
    found: true,
    condition: (typeof runMeta?.condition === "string" ? runMeta.condition : cond),
    resolved: swe.resolved === true || evalMeta?.resolvedCount === 1,
    evaluated,
    patch_produced: modelPatch.length > 0,
    cost: num(swe.costUsd), duration_ms: num(swe.durationMs),
    input_tokens: it, output_tokens: ot, cache_read: cr, cache_write: cw, total_tokens: it + ot + cr + cw,
    turn_count: num(swe.numTurns), tool_call_count: toolCalls.length,
    reads: reads.length,
    searches: toolCalls.filter((t) => t.category === "search").length,
    edits: toolCalls.filter((t) => t.category === "edit").length,
    repeated_reads: repeated,
    model: typeof swe.model === "string" ? swe.model : null,
    instanceId: typeof swe.instanceId === "string" ? swe.instanceId : null,
    eval_status: evalStatus,
  };
}

// ---- ledger: operational retries / quota aborts per instance ----
type Ledger = { ts: string; phase: string; instance: string; label: string; status: string; rc?: number; result_present?: string };
const ledgerLines: Ledger[] = readText(LEDGER).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Ledger);
const treatStarts = new Map<string, number>();      // instance -> # of treat-phase "start" launches
const treatNoResult = new Map<string, number>();    // instance -> # of treat-phase "done" with result_present=no
for (const e of ledgerLines) {
  if (e.phase !== "treat") continue;
  if (e.status === "start") treatStarts.set(e.instance, (treatStarts.get(e.instance) ?? 0) + 1);
  if (e.status === "done" && e.result_present === "no") treatNoResult.set(e.instance, (treatNoResult.get(e.instance) ?? 0) + 1);
}
// quota abort signature in the per-run stderr log
function quotaAbortCount(label: string): number {
  const err = readText(path.join(RUNS, `_m73_${label}.stderr.log`)) + readText(path.join(RUNS, label, "raw", "baseline", "_run.stderr.txt"));
  const m = err.match(/out_of_credits|rate_limit|429|usage limit|5-hour/gi);
  return m ? 1 : 0;
}

// ================= Stage C fresh baselines =================
type FixtureInst = {
  instance_id: string; safe: string; repo: string; category: string; difficulty: string;
  m70_selected_index: number; execution_stage: string; run_label: string; notes: string;
};
const fixture = readJson<{ instances: FixtureInst[] }>(FIXTURE);
if (!fixture) { console.error("STOP: Stage C fixture missing"); process.exit(2); }

const freshRows: Record<string, unknown>[] = [];
for (const fi of fixture.instances) {
  const m = readSweRun(fi.run_label);
  const starts = treatStarts.get(fi.instance_id) ?? 0;
  const operationalRetries = Math.max(0, starts - 1); // launches beyond the first for this instance
  const quotaAborts = quotaAbortCount(fi.run_label);

  // baseline validity per milestone definition
  let invalidReason: string | null = null;
  if (!m || !m.found) invalidReason = "artifact_missing";
  else if (m.condition !== "baseline") invalidReason = `wrong_condition:${m.condition}`;
  else if (m.instanceId !== fi.instance_id) invalidReason = `wrong_instance:${m.instanceId}`;
  else if (m.model && !/opus-4-5/.test(m.model)) invalidReason = `wrong_model:${m.model}`;
  else if (m.patch_produced && !m.evaluated) invalidReason = "eval_missing_for_patch";
  // no-patch run with an explicit exhausted/no-patch artifact is VALID
  const validRun = invalidReason === null;

  freshRows.push({
    instance_id: fi.instance_id,
    repo: fi.repo,
    difficulty: fi.difficulty,
    execution_stage: fi.execution_stage,
    condition: "m73_stage_c_baseline",
    run_label: fi.run_label,
    baseline_source: "fresh",
    valid_run: validRun,
    invalid_reason: invalidReason,
    patch_produced: m?.patch_produced ?? false,
    resolved: m?.resolved ?? false,
    evaluated: m?.evaluated ?? false,
    eval_status: m?.eval_status ?? "no_run",
    cost: m?.cost ?? 0,
    duration_ms: m?.duration_ms ?? 0,
    input_tokens_total: m?.input_tokens ?? 0,
    output_tokens_total: m?.output_tokens ?? 0,
    cache_read_tokens_total: m?.cache_read ?? 0,
    cache_write_tokens_total: m?.cache_write ?? 0,
    total_tokens: m?.total_tokens ?? 0,
    turn_count: m?.turn_count ?? 0,
    tool_call_count: m?.tool_call_count ?? 0,
    read_count: m?.reads ?? 0,
    search_count: m?.searches ?? 0,
    edit_count: m?.edits ?? 0,
    repeated_file_reads: m?.repeated_reads ?? 0,
    operational_retry_count: operationalRetries,
    quota_abort_count: quotaAborts,
    model: m?.model ?? null,
  });
}
fs.writeFileSync(path.join(RESULTS, "stage5_m73_stage_c_fresh_baselines.detail.json"), JSON.stringify(freshRows, null, 2) + "\n");

// Documented operational history: the 10 sympy baselines that aborted on the five-hour
// session limit (out_of_credits / HTTP 429) during the first treat pass and were retried
// after the credit reset (per the milestone's operational retry policy). Derived from the
// driver ledger (treat-phase "done" with result_present=no) + the per-run quota signatures
// captured before the retry overwrote those logs.
const QUOTA_ABORTED_INSTANCES = [...new Set(
  ledgerLines.filter((e) => e.phase === "treat" && e.status === "done" && e.result_present === "no").map((e) => e.instance),
)].sort();

const freshPresent = freshRows.filter((r) => (r.eval_status as string) !== "no_run");
const freshValid = freshRows.filter((r) => r.valid_run);
const freshSummary = {
  milestone: "M73",
  kind: "Stage C fresh baselines — established Stage 5 baseline condition over the 73 fresh-required matrix tasks",
  live_agents: true,
  source_matrix: "stage5_m70b_100_task_execution_matrix.json",
  baseline_protocol: "baseline",
  stage_c_selected: freshRows.length,
  fresh_baseline_runs_performed: freshPresent.length,
  runs_missing: freshRows.length - freshPresent.length,
  docker_evals: freshRows.filter((r) => r.evaluated).length,
  valid_fresh_baselines: freshValid.length,
  invalid_fresh_baselines: freshRows.length - freshValid.length,
  invalid_detail: freshRows.filter((r) => !r.valid_run).map((r) => ({ instance_id: r.instance_id, reason: r.invalid_reason })),
  validity_rate_pct: freshRows.length ? +(100 * freshValid.length / freshRows.length).toFixed(1) : 0,
  patch_produced_count: freshRows.filter((r) => r.patch_produced).length,
  no_patch_count: freshRows.filter((r) => !r.patch_produced).length,
  fresh_baseline_resolved: freshRows.filter((r) => r.resolved === true).length,
  operational_retries: sum(freshRows.map((r) => num(r.operational_retry_count))),
  // quota_abort_count per-run is derived from logs that the retry overwrote (so it reads 0
  // on the clean final runs). The documented operational history is authoritative below.
  quota_aborts: Math.max(
    QUOTA_ABORTED_INSTANCES.length,
    sum(freshRows.map((r) => num(r.quota_abort_count))),
  ),
  operational_history: {
    quota_aborted_first_pass: QUOTA_ABORTED_INSTANCES.length,
    quota_aborted_cases: QUOTA_ABORTED_INSTANCES,
    abort_cause: "five_hour session limit (out_of_credits, HTTP 429) at 2026-06-25T09:49Z; reset 2026-06-25T12:30Z",
    retried_after_reset: QUOTA_ABORTED_INSTANCES.length,
    retries_completed_valid: freshRows.filter((r) => QUOTA_ABORTED_INSTANCES.includes(String(r.instance_id)) && r.valid_run).length,
    retry_policy_note: "Same instance, same baseline condition, recorded as operational retries (NOT replacements or variance replicates). 10 retries used; under the 12-retry cap.",
  },
  cost: {
    total: +sum(freshRows.map((r) => num(r.cost))).toFixed(4),
    mean: +mean(freshRows.map((r) => num(r.cost))).toFixed(4),
    median: +median(freshRows.map((r) => num(r.cost))).toFixed(4),
    pooled_total_tokens: sum(freshRows.map((r) => num(r.total_tokens))),
  },
};
fs.writeFileSync(path.join(RESULTS, "stage5_m73_stage_c_fresh_baselines.json"), JSON.stringify(freshSummary, null, 2) + "\n");

// ================= FINAL paired 100-task =================
type Matrix = { rows: Array<Record<string, unknown>> };
const matrix = readJson<Matrix>(MATRIX)!;
const m71 = readJson<Array<Record<string, unknown>>>(M71_DETAIL) ?? [];
const m72 = readJson<Array<Record<string, unknown>>>(M72_DETAIL) ?? [];
const treatByInst = new Map<string, Record<string, unknown>>();
for (const r of [...m71, ...m72]) treatByInst.set(String(r.instance_id), r);
const freshByInst = new Map<string, Record<string, unknown>>();
for (const r of freshRows) freshByInst.set(String(r.instance_id), r);

const M62_M69_LOCKED = (note: string) => /M62\/M69 locked diagnostic subset/.test(note);

type PairRow = {
  instance_id: string; repo: string; difficulty: string; execution_stage: string;
  baseline_source: string; m62_m69_locked: boolean; is_django: boolean;
  // treatment
  treatment_attempted: boolean; treatment_valid: boolean; treatment_resolved: boolean;
  treatment_skipped: boolean; treatment_cost: number; treatment_tokens: number;
  treatment_cache_read: number; treatment_tool_calls: number; treatment_reads: number;
  treatment_searches: number; treatment_edits: number;
  // baseline
  baseline_valid: boolean; baseline_resolved: boolean; baseline_missing: boolean;
  baseline_cost: number; baseline_tokens: number; baseline_cache_read: number;
  baseline_tool_calls: number; baseline_reads: number; baseline_searches: number; baseline_edits: number;
  baseline_run_label: string | null;
  // paired outcome
  outcome: string;
};

const pairRows: PairRow[] = [];
for (const mrow of matrix.rows) {
  const inst = String(mrow.instance_id);
  const repo = String(mrow.repo);
  const note = String(mrow.notes ?? "");
  const t = treatByInst.get(inst); // undefined for django-10973 (skipped)
  const treatmentAttempted = t != null;
  const treatmentSkipped = !treatmentAttempted;
  const treatmentValid = Boolean(t?.valid_run);
  // strict scoring: skipped/invalid treatment counts as unresolved (per milestone)
  const treatmentResolved = t?.resolved === true;

  // baseline: reused (matrix label) or fresh (M73)
  const reuseStatus = String(mrow.baseline_reuse_status);
  let baselineMetrics: SweMetrics | null = null;
  let baselineSource = ""; let baselineRunLabel: string | null = null;
  let baselineResolved = false; let baselineValid = false; let baselineMissing = false;
  if (reuseStatus === "reused_verified") {
    baselineSource = "reused_verified";
    baselineRunLabel = mrow.baseline_run_label != null ? String(mrow.baseline_run_label) : null;
    baselineMetrics = baselineRunLabel ? readSweRun(baselineRunLabel) : null;
    // matrix is the authority on reused resolution; cross-check the captured run
    baselineResolved = mrow.baseline_resolved === true || baselineMetrics?.resolved === true;
    baselineValid = baselineMetrics !== null;
    baselineMissing = baselineMetrics === null;
  } else {
    baselineSource = "fresh_baseline";
    const fr = freshByInst.get(inst);
    baselineRunLabel = fr ? String(fr.run_label) : null;
    baselineMetrics = baselineRunLabel ? readSweRun(baselineRunLabel) : null;
    baselineResolved = fr?.resolved === true;
    baselineValid = Boolean(fr?.valid_run);
    baselineMissing = !fr || (fr.eval_status === "no_run");
  }

  // paired outcome classification (strict 100 denominator)
  let outcome: string;
  if (treatmentSkipped || !treatmentValid) outcome = "treatment_invalid_or_skipped";
  else if (baselineMissing || !baselineValid) outcome = "baseline_invalid_or_missing";
  else if (treatmentResolved && baselineResolved) outcome = "both_pass";
  else if (!treatmentResolved && !baselineResolved) outcome = "both_fail";
  else if (treatmentResolved && !baselineResolved) outcome = "treatment_only_pass";
  else outcome = "baseline_only_pass";

  pairRows.push({
    instance_id: inst, repo, difficulty: String(mrow.difficulty), execution_stage: String(mrow.execution_stage),
    baseline_source: baselineSource, m62_m69_locked: M62_M69_LOCKED(note), is_django: repo.startsWith("django/"),
    treatment_attempted: treatmentAttempted, treatment_valid: treatmentValid, treatment_resolved: treatmentResolved,
    treatment_skipped: treatmentSkipped,
    treatment_cost: num(t?.cost), treatment_tokens: num(t?.total_tokens),
    treatment_cache_read: num(t?.cache_read_tokens_total), treatment_tool_calls: num(t?.tool_call_count),
    treatment_reads: num(t?.read_count), treatment_searches: num(t?.search_count), treatment_edits: num(t?.edit_count),
    baseline_valid: baselineValid, baseline_resolved: baselineResolved, baseline_missing: baselineMissing,
    baseline_cost: baselineMetrics?.cost ?? 0, baseline_tokens: baselineMetrics?.total_tokens ?? 0,
    baseline_cache_read: baselineMetrics?.cache_read ?? 0, baseline_tool_calls: baselineMetrics?.tool_call_count ?? 0,
    baseline_reads: baselineMetrics?.reads ?? 0, baseline_searches: baselineMetrics?.searches ?? 0, baseline_edits: baselineMetrics?.edits ?? 0,
    baseline_run_label: baselineRunLabel,
    outcome,
  });
}

// ---- paired outcome counts ----
const oc = (k: string) => pairRows.filter((r) => r.outcome === k).length;
const paired = {
  both_pass: oc("both_pass"),
  both_fail: oc("both_fail"),
  treatment_only_pass: oc("treatment_only_pass"),
  baseline_only_pass: oc("baseline_only_pass"),
  treatment_invalid_or_skipped: oc("treatment_invalid_or_skipped"),
  baseline_invalid_or_missing: oc("baseline_invalid_or_missing"),
};
const net_treatment_wins = paired.treatment_only_pass - paired.baseline_only_pass;

// strict 100 denominator
const treatmentResolved100 = pairRows.filter((r) => r.treatment_resolved).length;
const baselineResolved100 = pairRows.filter((r) => r.baseline_resolved).length;

// runnable treatment denominator (99 attempted)
const attempted = pairRows.filter((r) => r.treatment_attempted);
const treatmentResolvedAtt = attempted.filter((r) => r.treatment_resolved).length;
const baselineResolvedAtt = attempted.filter((r) => r.baseline_resolved).length;

// ---- Wilson 95% CI ----
function wilson(k: number, n: number): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const z = 1.959963984540054, phat = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return { p: +phat.toFixed(4), lo: +(center - half).toFixed(4), hi: +(center + half).toFixed(4) };
}
// ---- exact two-sided binomial sign test (McNemar exact) on discordant pairs ----
function binomPmf(k: number, n: number, p: number): number {
  // log-space for stability
  let logc = 0;
  for (let i = 1; i <= k; i++) logc += Math.log(n - k + i) - Math.log(i);
  return Math.exp(logc + k * Math.log(p) + (n - k) * Math.log(1 - p));
}
function signTestTwoSided(b: number, c: number): number {
  const n = b + c; if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0; for (let i = 0; i <= k; i++) tail += binomPmf(i, n, 0.5);
  return Math.min(1, 2 * tail);
}

// ---- cost / token pooled over the strict 100 (treatment over valid+attempted; baseline over valid) ----
const treatmentCostRows = pairRows.filter((r) => r.treatment_attempted);
const baselineCostRows = pairRows.filter((r) => r.baseline_valid && !r.baseline_missing);
const costToken = {
  total_treatment_cost: +sum(treatmentCostRows.map((r) => r.treatment_cost)).toFixed(4),
  total_baseline_cost: +sum(baselineCostRows.map((r) => r.baseline_cost)).toFixed(4),
  mean_treatment_cost: +mean(treatmentCostRows.map((r) => r.treatment_cost)).toFixed(4),
  median_treatment_cost: +median(treatmentCostRows.map((r) => r.treatment_cost)).toFixed(4),
  mean_baseline_cost: +mean(baselineCostRows.map((r) => r.baseline_cost)).toFixed(4),
  median_baseline_cost: +median(baselineCostRows.map((r) => r.baseline_cost)).toFixed(4),
  total_treatment_tokens: sum(treatmentCostRows.map((r) => r.treatment_tokens)),
  total_baseline_tokens: sum(baselineCostRows.map((r) => r.baseline_tokens)),
  total_treatment_cache_read: sum(treatmentCostRows.map((r) => r.treatment_cache_read)),
  total_baseline_cache_read: sum(baselineCostRows.map((r) => r.baseline_cache_read)),
  total_treatment_tool_calls: sum(treatmentCostRows.map((r) => r.treatment_tool_calls)),
  total_baseline_tool_calls: sum(baselineCostRows.map((r) => r.baseline_tool_calls)),
};
const pooled_cost_delta = +(costToken.total_treatment_cost - costToken.total_baseline_cost).toFixed(4);
// per-task mean cost delta (paired, on rows valid for both)
const bothValidRows = pairRows.filter((r) => r.treatment_attempted && r.baseline_valid && !r.baseline_missing);
const cost_regression_pct = sum(bothValidRows.map((r) => r.baseline_cost)) > 0
  ? +(100 * (sum(bothValidRows.map((r) => r.treatment_cost)) - sum(bothValidRows.map((r) => r.baseline_cost))) / sum(bothValidRows.map((r) => r.baseline_cost))).toFixed(2)
  : null;

// ---- stratified ----
function stratum(rows: PairRow[]) {
  return {
    task_count: rows.length,
    baseline_resolved: rows.filter((r) => r.baseline_resolved).length,
    treatment_resolved: rows.filter((r) => r.treatment_resolved).length,
    treatment_only_wins: rows.filter((r) => r.outcome === "treatment_only_pass").length,
    baseline_only_wins: rows.filter((r) => r.outcome === "baseline_only_pass").length,
    treatment_cost: +sum(rows.filter((r) => r.treatment_attempted).map((r) => r.treatment_cost)).toFixed(2),
    baseline_cost: +sum(rows.filter((r) => r.baseline_valid && !r.baseline_missing).map((r) => r.baseline_cost)).toFixed(2),
  };
}
const byRepo: Record<string, unknown> = {};
for (const repo of [...new Set(pairRows.map((r) => r.repo))].sort()) byRepo[repo] = stratum(pairRows.filter((r) => r.repo === repo));
const byDifficulty: Record<string, unknown> = {};
for (const d of [...new Set(pairRows.map((r) => r.difficulty))]) byDifficulty[d] = stratum(pairRows.filter((r) => r.difficulty === d));
const stratified = {
  by_repo: byRepo,
  by_difficulty: byDifficulty,
  m62_m69_locked: stratum(pairRows.filter((r) => r.m62_m69_locked)),
  not_m62_m69_locked: stratum(pairRows.filter((r) => !r.m62_m69_locked)),
  reused_verified_baseline: stratum(pairRows.filter((r) => r.baseline_source === "reused_verified")),
  fresh_baseline: stratum(pairRows.filter((r) => r.baseline_source === "fresh_baseline")),
  django: stratum(pairRows.filter((r) => r.is_django)),
  non_django: stratum(pairRows.filter((r) => !r.is_django)),
};

// ---- structured-decision treatment metrics (combine M71 + M72 summaries) ----
const m71sum = readJson<Record<string, unknown>>(M71_SUM);
const m72sum = readJson<Record<string, unknown>>(M72_SUM);
const d71 = (m71sum?.structured_decision_m71 as Record<string, number>) ?? {};
const d72 = (m72sum?.structured_decision_m72 as Record<string, number>) ?? {};
const sd = (k: string) => num(d71[k]) + num(d72[k]);
const structuredDecision = {
  required: sd("required"), closed: sd("closed"), open: sd("open"),
  ignored: sd("ignored"), invalid: sd("invalid"), edited: sd("edited"),
  ruled_out: sd("ruled_out"), inspect_only_no_edit: sd("inspect_only_no_edit"),
  coverage_pct: sd("required") ? +(100 * sd("closed") / sd("required")).toFixed(2) : 0,
  ignored_rate_pct: sd("required") ? +(100 * sd("ignored") / sd("required")).toFixed(2) : 0,
  invalid_rule_out_rate_pct: sd("required") ? +(100 * sd("invalid") / sd("required")).toFixed(2) : 0,
  zero_required_count: num(m71sum?.zero_required_count) + num(m72sum?.zero_required_count),
  demoted_pivot_count: num(m71sum?.demoted_pivot_total) + num(m72sum?.demoted_pivot_total),
  required_impact_count: 0,
  optional_impact_inspected_or_edited: "see per-stage detail (O-namespaced, never closure-scored)",
  fail_closed_no_patch_invalid_count: num(m71sum?.invalid_treatment_runs) + num(m72sum?.invalid_treatment_runs),
};

const finalSummary = {
  milestone: "M73",
  kind: "Final paired 100-task benchmark — reused_verified (M70B) + fresh (M73) baselines vs structured-bounded + pivot-confidence treatment (M71/M72)",
  live_agents: true,
  scope_caveat: "100-task engineering validation over the frozen on-disk SWE-bench-100 census. NOT proof of broad SWE-bench superiority or VEXP parity.",
  selected_tasks: 100,
  treatment_attempted: attempted.length,
  treatment_skipped: pairRows.filter((r) => r.treatment_skipped).length,
  treatment_skipped_cases: pairRows.filter((r) => r.treatment_skipped).map((r) => r.instance_id),
  baseline_composition: {
    reused_verified: pairRows.filter((r) => r.baseline_source === "reused_verified").length,
    fresh_baseline: pairRows.filter((r) => r.baseline_source === "fresh_baseline").length,
  },
  strict_100: {
    treatment_resolved: treatmentResolved100,
    baseline_resolved: baselineResolved100,
    treatment_pass_rate: +(treatmentResolved100 / 100).toFixed(4),
    baseline_pass_rate: +(baselineResolved100 / 100).toFixed(4),
    resolution_delta: treatmentResolved100 - baselineResolved100,
    wilson_treatment: wilson(treatmentResolved100, 100),
    wilson_baseline: wilson(baselineResolved100, 100),
  },
  runnable_99: {
    denominator: attempted.length,
    treatment_resolved: treatmentResolvedAtt,
    baseline_resolved: baselineResolvedAtt,
    treatment_pass_rate: +(treatmentResolvedAtt / attempted.length).toFixed(4),
    baseline_pass_rate: +(baselineResolvedAtt / attempted.length).toFixed(4),
    resolution_delta: treatmentResolvedAtt - baselineResolvedAtt,
  },
  paired_outcomes: paired,
  net_treatment_wins,
  paired_test: {
    discordant_treatment_only: paired.treatment_only_pass,
    discordant_baseline_only: paired.baseline_only_pass,
    exact_two_sided_sign_test_p: +signTestTwoSided(paired.treatment_only_pass, paired.baseline_only_pass).toFixed(4),
    note: "Exact two-sided binomial sign test (McNemar exact) on discordant pairs only; computed here, not from an external library.",
  },
  cost_token: { ...costToken, pooled_cost_delta, cost_regression_pct, paired_cost_rows: bothValidRows.length },
  structured_decision_treatment: structuredDecision,
  stratified,
  non_claims: [
    "Does not claim VTRACE is VEXP parity.",
    "Does not claim broad SWE-bench superiority.",
    "Does not claim statistical superiority beyond what the reported paired sign test supports.",
  ],
};
fs.writeFileSync(path.join(RESULTS, "stage5_m73_final_100_paired_summary.json"), JSON.stringify(finalSummary, null, 2) + "\n");

// also persist the per-task pair rows for the report table / audit (compact, no streams)
fs.writeFileSync(path.join(RESULTS, "stage5_m73_final_100_paired.detail.json"), JSON.stringify(pairRows, null, 2) + "\n");

console.log(JSON.stringify({
  fresh: {
    selected: freshSummary.stage_c_selected, performed: freshSummary.fresh_baseline_runs_performed,
    valid: freshSummary.valid_fresh_baselines, invalid: freshSummary.invalid_fresh_baselines,
    resolved: freshSummary.fresh_baseline_resolved, docker_evals: freshSummary.docker_evals,
    retries: freshSummary.operational_retries, quota_aborts: freshSummary.quota_aborts,
    cost_total: freshSummary.cost.total,
  },
  final: {
    treatment_resolved_100: treatmentResolved100, baseline_resolved_100: baselineResolved100,
    resolution_delta: treatmentResolved100 - baselineResolved100,
    paired, net_treatment_wins, sign_test_p: finalSummary.paired_test.exact_two_sided_sign_test_p,
    pooled_cost_delta, cost_regression_pct,
  },
}, null, 2));
