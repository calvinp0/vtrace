// Stage 5 M107 — no-agent live-run preflight over the 26 pre-registered
// extension cases (stage5_m107_case_selection.json). Thin wrapper around the
// M105 preflight's per-case check (`runCase`), run under the IDENTICAL
// treatment argv (`M105_TREATMENT_CONTEXT_ARGV` — M107 uses the same M92
// clean-core flag set), plus the same read-only env-guard probe and agent
// shell-guard materialization proof. Mirrors run_stage5_m106_preflight.ts.
//
// The 26 M107 cases were not in the M104 smoke, so no frozen M104 hash exists
// for them: the m104_hash_match field is vacuous-null (only `false` fails, as
// in M105/M106). The binding parity anchors are the shared-derivation identity
// and the frozen M103 detail row. Each case's structured task sha256 is
// recorded here as the M107 frozen hash.
//
// NO agents, NO Docker, NO API spend, NO network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m107_preflight.ts \
//     [--data /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl] \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results] [--only id,id]

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadSweBenchData, parseArgs } from "./run_stage5_vexp_swe_bench_smoke";
import {
  M105_TREATMENT_CONTEXT_ARGV,
  forbiddenArmsOn,
  mandatoryGuardsOff,
  probeShellGuard,
  runCase,
  type M103DetailRow,
  type M104DetailRow,
  type M105PreflightCase,
} from "./run_stage5_m105_preflight";
import { runStage5EnvGuardPreflight } from "./stage5EnvGuardIntegration";

const VEXP = "/home/calvin/code/vexp-swe-bench";
const DEFAULT_DATA = path.join(VEXP, "data", "swe-bench-100.jsonl");
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const M103_DETAIL = path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json");
const M104_DETAIL = path.join(RESULTS_ROOT, "stage5_m104_live_context_smoke.detail.json");
const SELECTION = path.join(RESULTS_ROOT, "stage5_m107_case_selection.json");
const EXPECTED_TESTBED_PREFIX = "/home/calvin/miniforge3/envs/vexp_swebench";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1]! : fallback;
  };
  const dataPath = flag("--data", DEFAULT_DATA);
  const outDir = flag("--out", RESULTS_ROOT);
  const only = flag("--only", "").split(",").map((s) => s.trim()).filter(Boolean);
  const repoRoot = process.cwd();

  const config = parseArgs([...M105_TREATMENT_CONTEXT_ARGV]);
  const forbidden = forbiddenArmsOn(config);
  const guardsOff = mandatoryGuardsOff(config);

  const selection = JSON.parse(readFileSync(SELECTION, "utf8")) as {
    selected: Array<{ instance_id: string; selection_stratum: string; phase: string }>;
    excluded_m105_cases: string[];
    excluded_m106_cases: string[];
  };
  const selectedIds = selection.selected.map((s) => s.instance_id);
  const excluded = new Set([...selection.excluded_m105_cases, ...selection.excluded_m106_cases]);
  const overlap = selectedIds.filter((id) => excluded.has(id));
  if (overlap.length > 0) {
    throw new Error(`selection overlaps the committed M105/M106 case sets (rerun forbidden): ${overlap.join(", ")}`);
  }

  const records = await loadSweBenchData(dataPath);
  const m103Rows = new Map<string, M103DetailRow>(
    (JSON.parse(readFileSync(M103_DETAIL, "utf8")) as { rows: M103DetailRow[] }).rows.map((r) => [r.instance_id, r]),
  );
  // Loaded for interface parity with M105; none of the 26 M107 cases has an
  // M104 row, so m104_hash_match stays null for all of them.
  const m104Rows = new Map<string, M104DetailRow>(
    (JSON.parse(readFileSync(M104_DETAIL, "utf8")) as { cases: M104DetailRow[] }).cases.map((r) => [r.instance_id, r]),
  );

  const ids = only.length > 0 ? selectedIds.filter((id) => only.includes(id)) : selectedIds;
  const cases: Array<M105PreflightCase & { selection_stratum: string; phase: string }> = [];
  for (const id of ids) {
    const record = records.find((r) => r.instance_id === id || r.instanceId === id);
    if (record === undefined) {
      process.stderr.write(`[m107-preflight] SKIP ${id}: not in dataset\n`);
      continue;
    }
    process.stderr.write(`[m107-preflight] ${id} …\n`);
    const sel = selection.selected.find((s) => s.instance_id === id);
    cases.push({
      ...runCase(record, config, m103Rows.get(id) ?? null, m104Rows.get(id) ?? null, repoRoot),
      selection_stratum: sel?.selection_stratum ?? "unknown",
      phase: sel?.phase ?? "unknown",
    });
  }

  const shell = await probeShellGuard(outDir);
  const env = runStage5EnvGuardPreflight({
    enabled: true,
    driftCheckEnabled: true,
    expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX,
    vexpSweBenchDir: VEXP,
    shellCondaPrefix: process.env.CONDA_PREFIX ?? "/home/calvin/miniforge3",
  });
  const envMeta = env.metadata as unknown as Record<string, unknown>;
  const envGuardPass =
    env.ok &&
    envMeta.stage5_env_guard_status === "pass" &&
    envMeta.stage5_python_prefix_verified === true &&
    envMeta.stage5_pip_prefix_verified === true;

  const summary = {
    milestone: "M107",
    kind: "no-agent live-run preflight (task parity + leakage + fallback + guards) over the 26 pre-registered extension cases, under the M105/M92 clean-core treatment flags",
    date: new Date().toISOString().slice(0, 10),
    no_agents: true,
    no_docker: true,
    no_api_spend: true,
    treatment_argv: M105_TREATMENT_CONTEXT_ARGV,
    forbidden_arms_on: forbidden,
    mandatory_guards_off: guardsOff,
    m105_m106_overlap_checked: true,
    cases: cases.length,
    preflight_pass_count: cases.filter((c) => c.preflight_pass).length,
    m103_task_text_exact_match_all: cases.every((c) => c.m103_task_text_exact_match !== false),
    unexplained_leak_hits_total: cases.reduce((n, c) => n + (c.context_leak_unexplained_count ?? 0), 0),
    fallback_would_fire_count: cases.filter((c) => c.v2_fallback_would_fire === true).length,
    digest_injected_all: cases.every((c) => c.digest_injected !== false),
    decision_contract_injected_all: cases.every((c) => c.decision_contract_injected !== false),
    env_guard: {
      pass: envGuardPass,
      status: envMeta.stage5_env_guard_status ?? null,
      python_prefix_verified: envMeta.stage5_python_prefix_verified ?? null,
      pip_prefix_verified: envMeta.stage5_pip_prefix_verified ?? null,
      expected_testbed_prefix: envMeta.stage5_expected_testbed_prefix ?? null,
      drift_check_enabled: envMeta.stage5_drift_check_enabled ?? null,
      fail_closed_reason: env.failClosedReason,
    },
    shell_guard: shell,
    gate_pass:
      forbidden.length === 0 &&
      guardsOff.length === 0 &&
      envGuardPass &&
      shell.available &&
      cases.length > 0 &&
      cases.every((c) => c.preflight_pass),
  };

  await mkdir(outDir, { recursive: true });
  const detailPath = path.join(outDir, "stage5_m107_live_preflight.detail.json");
  await writeFile(detailPath, `${JSON.stringify({ summary, cases }, null, 2)}\n`);
  process.stderr.write(`[m107-preflight] wrote ${detailPath}\n`);
  console.log(
    JSON.stringify(
      {
        gate_pass: summary.gate_pass,
        cases: summary.cases,
        preflight_pass_count: summary.preflight_pass_count,
        unexplained_leak_hits_total: summary.unexplained_leak_hits_total,
        fallback_would_fire_count: summary.fallback_would_fire_count,
        env_guard_pass: envGuardPass,
        shell_guard_available: shell.available,
        failing_cases: cases.filter((c) => !c.preflight_pass).map((c) => ({ id: c.instance_id, reasons: c.fail_reasons })),
      },
      null,
      2,
    ),
  );
  if (!summary.gate_pass) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
