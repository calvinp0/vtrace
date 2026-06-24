/**
 * M70B — offline baseline reuse qualification (NO live agents, NO Docker, NO API spend, NO
 * fresh baselines). Scans on-disk baseline run artifacts under results/runs/<label>/raw/baseline
 * and classifies, for each of the 100 frozen M70 instances, whether an existing baseline can be
 * reused for the future 100-task paired comparison.
 *
 * Reuse gate (a baseline is `reused_verified` only if ALL hold):
 *   - same instance_id;
 *   - baseline condition (raw/baseline);
 *   - same Stage 5 vexp-swe-bench harness family (these dirs are);
 *   - model == the M70 treatment model (claude-opus-4-5-20251101) — runner does not override;
 *   - patch present (modelPatch non-empty);
 *   - eval metadata available (_eval.meta.json with evaluationRan);
 *   - resolved result available;
 *   - token/cost/tool-call metadata available;
 *   - artifact paths parseable.
 * Anything short of that is `reused_candidate_but_incomplete` (dir parses but a criterion is
 * soft/missing — e.g. model comparability unclear, no eval) or `invalid_artifact` (jsonl
 * unparseable). No baseline dir at all => `missing`. We DO NOT lower the bar to cut live runs.
 *
 *   bun run_stage5_m70b_qualify_baselines.ts [--fixture path] [--runs dir] [--out dir]
 */
import path from "node:path";
import { Glob } from "bun";

const ROOT = "/home/calvin/code/vtrace";
const TREATMENT_MODEL = "claude-opus-4-5-20251101";

function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const FIXTURE = flag("--fixture", path.join(RESULTS, "stage5_m70_100_task_preregistration.json"));
const RUNS = flag("--runs", path.join(RESULTS, "runs"));
const OUT = flag("--out", RESULTS);

interface Candidate {
  label: string;
  baseline_dir: string;
  jsonl_path: string | null;
  model: string | null;
  protocol: string | null;
  patch_produced: boolean;
  eval_available: boolean;
  resolved: boolean | null;
  token_cost_available: boolean;
  tool_calls_available: boolean;
  parseable: boolean;
  score: number;
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(require("node:fs").readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Collect every results/runs/<label>/raw/baseline candidate keyed by instance_id.
const byInstance = new Map<string, Candidate[]>();
const metaGlob = new Glob("*/raw/baseline/_run.meta.json");
for await (const rel of metaGlob.scan({ cwd: RUNS, onlyFiles: true, dot: true })) {
  const metaPath = path.join(RUNS, rel);
  const baselineDir = path.dirname(metaPath);
  const label = rel.split("/")[0]!;
  const runMeta = readJson(metaPath);
  // Locate the swebench result row.
  let jsonlPath: string | null = null;
  const jlGlob = new Glob("swebench-*.jsonl");
  for await (const jl of jlGlob.scan({ cwd: baselineDir, onlyFiles: true })) {
    jsonlPath = path.join(baselineDir, jl);
    break;
  }
  let instanceId: string | null = null;
  let model: string | null = null;
  let patch = false;
  let resolved: boolean | null = null;
  let tokenCost = false;
  let toolCalls = false;
  let parseable = true;
  if (jsonlPath) {
    try {
      const firstLine = (await Bun.file(jsonlPath).text()).split("\n").find((l) => l.trim());
      const rec = firstLine ? JSON.parse(firstLine) : null;
      if (rec) {
        instanceId = rec.instanceId ?? null;
        model = rec.model ?? null;
        patch = typeof rec.modelPatch === "string" && rec.modelPatch.trim().length > 0;
        resolved = typeof rec.resolved === "boolean" ? rec.resolved : null;
        tokenCost =
          rec.inputTokens !== undefined && rec.outputTokens !== undefined && rec.costUsd !== undefined;
        toolCalls = rec.toolCalls !== undefined || rec.numTurns !== undefined;
      } else {
        parseable = false;
      }
    } catch {
      parseable = false;
    }
  }
  if (!instanceId && runMeta?.instances?.length) instanceId = runMeta.instances[0];
  if (!instanceId) continue;

  const evalMeta = readJson(path.join(baselineDir, "_eval.meta.json"));
  const evalAvailable = !!evalMeta && evalMeta.evaluationRan === true;
  if (resolved === null && evalMeta && typeof evalMeta.resolvedCount === "number") {
    resolved = evalMeta.resolvedCount > 0;
  }
  const protocol = runMeta?.condition ?? null;

  const score =
    (model === TREATMENT_MODEL ? 1 : 0) +
    (patch ? 1 : 0) +
    (evalAvailable ? 1 : 0) +
    (jsonlPath ? 1 : 0) +
    (resolved !== null ? 1 : 0);

  const cand: Candidate = {
    label,
    baseline_dir: path.relative(ROOT, baselineDir),
    jsonl_path: jsonlPath ? path.relative(ROOT, jsonlPath) : null,
    model,
    protocol,
    patch_produced: patch,
    eval_available: evalAvailable,
    resolved,
    token_cost_available: tokenCost,
    tool_calls_available: toolCalls,
    parseable,
    score,
  };
  if (!byInstance.has(instanceId)) byInstance.set(instanceId, []);
  byInstance.get(instanceId)!.push(cand);
}

const fixture = JSON.parse(await Bun.file(FIXTURE).text()) as {
  instances: Array<{ instance_id: string; repo: string; difficulty: string; in_M62_24: boolean }>;
};

function classify(best: Candidate | null): { decision: string; reject: string | null } {
  if (!best) return { decision: "missing", reject: "no_baseline_dir_on_disk" };
  if (!best.parseable || !best.jsonl_path) return { decision: "invalid_artifact", reject: "swebench_jsonl_unparseable_or_absent" };
  const okModel = best.model === TREATMENT_MODEL;
  const full = okModel && best.patch_produced && best.eval_available && best.resolved !== null && best.token_cost_available;
  if (full) return { decision: "reused_verified", reject: null };
  const reasons: string[] = [];
  if (!okModel) reasons.push(`model_mismatch_or_unclear(${best.model ?? "unknown"})`);
  if (!best.patch_produced) reasons.push("no_patch");
  if (!best.eval_available) reasons.push("no_eval_meta");
  if (best.resolved === null) reasons.push("no_resolved_result");
  if (!best.token_cost_available) reasons.push("no_token_cost_meta");
  return { decision: "reused_candidate_but_incomplete", reject: reasons.join(",") };
}

const rows = fixture.instances.map((fi) => {
  const cands = (byInstance.get(fi.instance_id) ?? []).slice().sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const best = cands[0] ?? null;
  const { decision, reject } = classify(best);
  // any-replicate-resolved (M62 convention) for reporting
  const anyResolved = cands.some((c) => c.resolved === true);
  return {
    instance_id: fi.instance_id,
    repo: fi.repo,
    difficulty: fi.difficulty,
    in_M62_24: fi.in_M62_24,
    baseline_run_label: best?.label ?? null,
    baseline_artifact_path: best?.jsonl_path ?? best?.baseline_dir ?? null,
    model: best?.model ?? null,
    harness_protocol: best ? `stage5-vexp/${best.protocol ?? "baseline"}` : null,
    patch_produced: best?.patch_produced ?? false,
    eval_available: best?.eval_available ?? false,
    resolved: best?.resolved ?? null,
    any_replicate_resolved: anyResolved,
    token_cost_available: best?.token_cost_available ?? false,
    tool_call_metadata_available: best?.tool_calls_available ?? false,
    replicate_count: cands.length,
    reuse_decision: decision,
    reuse_reject_reason: reject,
  };
});

const counts: Record<string, number> = {};
for (const r of rows) counts[r.reuse_decision] = (counts[r.reuse_decision] ?? 0) + 1;
const reusedVerified = counts["reused_verified"] ?? 0;
const freshRequired = rows.length - reusedVerified;

// Per-repo summary
const repos = [...new Set(rows.map((r) => r.repo))].sort();
const perRepo = repos.map((repo) => {
  const rr = rows.filter((r) => r.repo === repo);
  return {
    repo,
    selected: rr.length,
    reused_verified: rr.filter((r) => r.reuse_decision === "reused_verified").length,
    incomplete: rr.filter((r) => r.reuse_decision === "reused_candidate_but_incomplete").length,
    invalid: rr.filter((r) => r.reuse_decision === "invalid_artifact").length,
    missing: rr.filter((r) => r.reuse_decision === "missing").length,
    fresh_required: rr.filter((r) => r.reuse_decision !== "reused_verified").length,
  };
});

const summary = {
  milestone: "M70B-baseline-qualification",
  kind: "offline on-disk baseline reuse qualification (no agents, no Docker, no fresh baselines)",
  treatment_model: TREATMENT_MODEL,
  reuse_gate:
    "same instance + baseline condition + stage5 vexp harness + model==treatment + patch + eval meta + resolved + token/cost meta + parseable",
  total: rows.length,
  counts,
  reused_verified_count: reusedVerified,
  fresh_required_count: freshRequired,
  per_repo: perRepo,
  rows,
};
await Bun.write(path.join(OUT, "stage5_m70b_baselines.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "RESULT_JSON: " +
    JSON.stringify({ total: rows.length, counts, reused_verified: reusedVerified, fresh_required: freshRequired }),
);
