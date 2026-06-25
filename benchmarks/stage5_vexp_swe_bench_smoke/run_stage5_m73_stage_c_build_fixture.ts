/**
 * M73 — build the Stage C fresh-baseline fixture from the frozen M70B execution matrix.
 *
 * Stage C membership = the matrix rows with `fresh_baseline_needed === true`
 * (equivalently baseline_reuse_status === "missing"). NO agents, NO Docker, NO spend.
 *
 * Each fixture entry carries the baseline run_label `m73_stage_c_baseline_<safe>` used by
 * the driver. The treatment-side fields (execution_stage, planned treatment label) are
 * carried through for the final paired join, but Stage C runs ONLY the baseline condition.
 *
 * Stop conditions (mirrors the milestone guardrails): the matrix must exist, expose exactly
 * 100 rows, and the fresh-required count must equal the matrix-declared 73 — otherwise abort.
 *
 * Usage: bun run_stage5_m73_stage_c_build_fixture.ts
 */
import fs from "node:fs";
import path from "node:path";

const RESULTS = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const MATRIX = path.join(RESULTS, "stage5_m70b_100_task_execution_matrix.json");

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

type MatrixRow = {
  instance_id: string;
  repo: string;
  difficulty: string;
  m70_selected_index: number;
  preflight_status: string;
  preflight_render_path: string;
  expected_treatment_run: boolean;
  planned_treatment_run_label: string;
  baseline_reuse_status: string;
  baseline_run_label: string | null;
  baseline_resolved: boolean | null;
  fresh_baseline_needed: boolean;
  planned_fresh_baseline_run_label: string | null;
  execution_stage: string;
  notes: string;
};
type Matrix = {
  milestone: string;
  rows: MatrixRow[];
  fresh_baseline_required_count: number;
  stage_split: Record<string, number>;
};

if (!fs.existsSync(MATRIX)) {
  console.error(`STOP: execution matrix missing at ${MATRIX}`);
  process.exit(2);
}
const matrix = readJson<Matrix>(MATRIX);
if (!Array.isArray(matrix.rows) || matrix.rows.length !== 100) {
  console.error(`STOP: matrix inconsistent — expected 100 rows, got ${matrix.rows?.length}`);
  process.exit(2);
}

// safe id: "django__django-12345" -> "django_12345" (repo prefix dropped, matches M70 labels)
function safeId(instanceId: string): string {
  const parts = instanceId.split("__");
  const tail = parts[parts.length - 1]!; // e.g. "django-12345"
  return tail.replace(/-/g, "_");
}

const fresh = matrix.rows.filter((r) => r.fresh_baseline_needed === true);
if (fresh.length !== matrix.fresh_baseline_required_count) {
  console.error(
    `STOP: fresh_baseline_needed count (${fresh.length}) != matrix.fresh_baseline_required_count (${matrix.fresh_baseline_required_count})`,
  );
  process.exit(2);
}
if (fresh.length !== (matrix.stage_split.stage_c_fresh_baselines ?? -1)) {
  console.error(
    `STOP: fresh count (${fresh.length}) != stage_split.stage_c_fresh_baselines (${matrix.stage_split.stage_c_fresh_baselines})`,
  );
  process.exit(2);
}
if (fresh.length > 73) {
  console.error(`STOP: fresh baseline count ${fresh.length} exceeds hard cap of 73`);
  process.exit(2);
}

const instances = fresh.map((r) => {
  const safe = safeId(r.instance_id);
  return {
    instance_id: r.instance_id,
    safe,
    repo: r.repo,
    category: r.repo.split("/")[0],
    difficulty: r.difficulty,
    m70_selected_index: r.m70_selected_index,
    matrix_preflight_status: r.preflight_status,
    execution_stage: r.execution_stage, // treatment stage assignment (stage_a/stage_b)
    planned_treatment_run_label: r.planned_treatment_run_label,
    planned_fresh_baseline_run_label: r.planned_fresh_baseline_run_label,
    baseline_reuse_status: r.baseline_reuse_status, // "missing"
    run_label: `m73_stage_c_baseline_${safe}`,
    condition: "m73_stage_c_baseline",
    baseline_source: "fresh",
    notes: r.notes,
  };
});

const fixture = {
  milestone: "M73",
  kind: "Stage C fresh-baseline fixture — established Stage 5 baseline condition (--protocol baseline), no treatment",
  source_matrix: "stage5_m70b_100_task_execution_matrix.json",
  stage: "stage_c_fresh_baselines",
  baseline_protocol: "baseline",
  baseline_flags: ["--protocol baseline"],
  baseline_condition_note:
    "established Stage 5 baseline: no VTRACE indexed context, no capsule injection, no digest/decision contract, no bounded decisions, no pivot-confidence gate, no corrective/revision/oracle. Shared stage5 tool-use-discipline block is injected into BOTH baseline and treatment (default), matching the reused_verified baselines (eval-bounded20-baseline-*).",
  run_label_prefix: "m73_stage_c_baseline_",
  hard_cap_fresh_baseline_runs: 73,
  instance_count: instances.length,
  instances,
};

const out = path.join(RESULTS, "stage5_m73_stage_c_fixture.json");
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");

console.log(
  JSON.stringify(
    {
      wrote: out,
      stage_c_selected: instances.length,
      repos: [...new Set(instances.map((i) => i.repo))].length,
      per_repo: Object.fromEntries(
        [...new Set(instances.map((i) => i.repo))].sort().map((repo) => [
          repo,
          instances.filter((i) => i.repo === repo).length,
        ]),
      ),
      includes_django_10973: instances.some((i) => i.instance_id === "django__django-10973"),
    },
    null,
    2,
  ),
);
