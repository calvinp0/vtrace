/**
 * M70B — build the 100-task execution matrix + readiness summary from the frozen M70 fixture,
 * the M70B pre-flight result, and the M70B baseline qualification. Pure/deterministic, report
 * only: reads three JSONs, writes the execution matrix + readiness JSON. NO agents, NO Docker.
 *
 *   bun run_stage5_m70b_build_matrix.ts [--out dir]
 */
import path from "node:path";

const ROOT = "/home/calvin/code/vtrace";
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
const OUT = flag("--out", RESULTS);

const fixture = JSON.parse(await Bun.file(path.join(RESULTS, "stage5_m70_100_task_preregistration.json")).text());
const preflight = JSON.parse(await Bun.file(path.join(RESULTS, "stage5_m70b_preflight.json")).text());
const baselines = JSON.parse(await Bun.file(path.join(RESULTS, "stage5_m70b_baselines.json")).text());

const pfById = new Map<string, any>(preflight.rows.map((r: any) => [r.instance_id, r]));
const blById = new Map<string, any>(baselines.rows.map((r: any) => [r.instance_id, r]));

function safeId(instanceId: string): string {
  return (instanceId.split("__").pop() ?? instanceId).replace(/[^a-zA-Z0-9]+/g, "_");
}

const matrixRows = fixture.instances.map((fi: any) => {
  const pf = pfById.get(fi.instance_id);
  const bl = blById.get(fi.instance_id);
  const qpos: number = fi.run_queue_position ?? 0;
  const stage = qpos > 0 && qpos <= 50 ? "stage_a" : "stage_b";
  const reuse = bl?.reuse_decision ?? "missing";
  const freshNeeded = reuse !== "reused_verified";
  const safe = safeId(fi.instance_id);
  const notes: string[] = [];
  if (fi.in_M62_24) notes.push("M62/M69 locked diagnostic subset");
  if (pf?.final_status === "PREFLIGHT_PENDING_INDEX") notes.push("preflight pending (no persisted index)");
  if (pf?.invalid_reason === "reuse_render_empty") notes.push("stale persisted index; rerun fresh");
  if (pf?.required_target_count === 0 && pf?.render_path !== "none") notes.push("zero-required (gate marker)");
  if (fi.over_budget_watch) notes.push("over-budget watch");
  return {
    instance_id: fi.instance_id,
    repo: fi.repo,
    difficulty: fi.difficulty,
    m70_selected_index: qpos,
    preflight_status: pf?.final_status ?? "PREFLIGHT_PENDING_INDEX",
    preflight_render_path: pf?.render_path ?? "none",
    expected_treatment_run: true,
    planned_treatment_run_label: `m70_structured_bounded_${safe}`,
    baseline_reuse_status: reuse,
    baseline_run_label: reuse === "reused_verified" ? bl?.baseline_run_label ?? null : null,
    baseline_resolved: bl?.resolved ?? null,
    fresh_baseline_needed: freshNeeded,
    planned_fresh_baseline_run_label: freshNeeded ? `m70_baseline_${safe}` : null,
    execution_stage: stage,
    notes: notes.join("; "),
  };
});

const preflightValid = matrixRows.filter((r: any) => r.preflight_status === "VALID").length;
const preflightInvalid = matrixRows.filter(
  (r: any) => r.preflight_status !== "VALID" && r.preflight_status !== "PREFLIGHT_PENDING_INDEX",
).length;
const preflightPending = matrixRows.filter((r: any) => r.preflight_status === "PREFLIGHT_PENDING_INDEX").length;
const reusedVerified = matrixRows.filter((r: any) => r.baseline_reuse_status === "reused_verified").length;
const freshRequired = matrixRows.filter((r: any) => r.fresh_baseline_needed).length;
const expectedTreatment = matrixRows.length;
const expectedTotal = expectedTreatment + freshRequired;

// Recommend the staged option: paired comparison (Opt 2) executed as a 50+50 split (Opt 3) +
// fresh baselines, UNLESS pre-flight validity is incomplete/low.
const everyRendered = preflightPending === 0;
const validityOk = everyRendered && preflightValid >= 95;
const recommendedOption = !everyRendered
  ? "not_ready_complete_preflight_first"
  : preflightValid >= 95
    ? "option_3_staged_50_50_plus_fresh_baselines"
    : preflightValid >= 90
      ? "option_3_staged_with_caution"
      : "not_ready_fix_preflight_validity";

const matrix = {
  milestone: "M70B",
  kind: "100-task execution matrix (planning only — no live runs authorized)",
  fixture_source: "stage5_m70_100_task_preregistration.json",
  preflight_source: "stage5_m70b_preflight.json",
  baseline_source: "stage5_m70b_baselines.json",
  treatment_flags: fixture.treatment_flags,
  future_model: fixture.future_model,
  preflight_valid_count: preflightValid,
  preflight_invalid_count: preflightInvalid,
  preflight_pending_count: preflightPending,
  baseline_reused_verified_count: reusedVerified,
  fresh_baseline_required_count: freshRequired,
  expected_treatment_runs: expectedTreatment,
  expected_fresh_baseline_runs: freshRequired,
  expected_total_live_runs: expectedTotal,
  recommended_execution_option: recommendedOption,
  recommended_run_cap: expectedTotal,
  stage_split: {
    stage_a: matrixRows.filter((r: any) => r.execution_stage === "stage_a").length,
    stage_b: matrixRows.filter((r: any) => r.execution_stage === "stage_b").length,
    stage_c_fresh_baselines: freshRequired,
  },
  rows: matrixRows,
};
await Bun.write(path.join(OUT, "stage5_m70b_100_task_execution_matrix.json"), JSON.stringify(matrix, null, 2) + "\n");

const readiness = {
  milestone: "M70B",
  kind: "100-task readiness summary (no agents, no Docker, no API spend)",
  fixture_validated: {
    path: "stage5_m70_100_task_preregistration.json",
    task_count: fixture.instances.length,
    repo_count: fixture.repo_count,
    repo_counts: fixture.repo_counts,
    complexity_counts: fixture.complexity_counts,
    tasks_changed: false,
  },
  preflight: {
    helper: "run_stage5_m70b_preflight_100.ts",
    total: preflight.total,
    valid_count: preflight.valid_count,
    rendered_count: preflight.rendered_count,
    reuse_count: preflight.reuse_count,
    clone_count: preflight.clone_count,
    pending_index_count: preflight.pending_index_count,
    fail_closed_count: preflight.fail_closed_count,
    partial_sentinel_count: preflight.partial_sentinel_count,
    invalid_structured_count: preflight.invalid_structured_count,
    invalid_impact_count: preflight.invalid_impact_count,
    invalid_confidence_gate_count: preflight.invalid_confidence_gate_count,
    other_invalid_count: preflight.other_invalid_count,
    zero_required_count: preflight.zero_required_count,
    zero_required_cases: preflight.zero_required_cases,
    demoted_pivot_count: preflight.demoted_pivot_count,
    required_impact_target_count: preflight.required_impact_target_count,
    optional_impact_context_missing_count: preflight.optional_impact_context_missing_count,
    by_status: preflight.by_status,
  },
  baselines: {
    helper: "run_stage5_m70b_qualify_baselines.ts",
    reused_verified_count: baselines.reused_verified_count,
    fresh_required_count: baselines.fresh_required_count,
    counts: baselines.counts,
    per_repo: baselines.per_repo,
  },
  execution: {
    expected_treatment_runs: expectedTreatment,
    expected_fresh_baseline_runs: freshRequired,
    expected_total_live_runs: expectedTotal,
    recommended_execution_option: recommendedOption,
    recommended_run_cap: expectedTotal,
  },
  recommendation: recommendedOption,
};
await Bun.write(path.join(OUT, "stage5_m70b_100_task_readiness.json"), JSON.stringify(readiness, null, 2) + "\n");

console.log(
  "RESULT_JSON: " +
    JSON.stringify({
      preflight_valid: preflightValid,
      preflight_invalid: preflightInvalid,
      preflight_pending: preflightPending,
      reused_verified: reusedVerified,
      fresh_required: freshRequired,
      expected_total_live_runs: expectedTotal,
      recommended_execution_option: recommendedOption,
    }),
);
