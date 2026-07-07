// Stage 5 M108 — no-agent live-run preflight over the 50 pre-registered
// remaining cases (stage5_m108_case_selection.json). Thin wrapper around the
// M105 preflight's per-case check (`runCase`), run under the IDENTICAL
// treatment argv (`M105_TREATMENT_CONTEXT_ARGV` — M108 uses the same M92
// clean-core flag set), plus the same read-only env-guard probe and agent
// shell-guard materialization proof. Mirrors run_stage5_m107_preflight.ts.
//
// The 50 M108 cases were not in the M104 smoke, so no frozen M104 hash exists
// for them: the m104_hash_match field is vacuous-null (only `false` fails, as
// in M105/M106/M107). The binding parity anchors are the shared-derivation
// identity and the frozen M103 detail row. Each case's structured task sha256
// is recorded here as the M108 frozen hash.
//
// Two M108-specific post-classifications over the M105 `runCase` result (both
// pre-registered BEFORE any live spawn; see the plan's preflight addendum):
//
//   issue-authored task hits — the M103 V5 derivation deliberately extracts
//   failing tests THE ISSUE MENTIONS; when such a test id is also a
//   FAIL_TO_PASS label, the raw task scan flags it even though the string is
//   verbatim issue-authored (available to any solver reading the issue) and
//   the task text is byte-identical to the frozen M103 row. Per the M103
//   leakage policy (issue_authored_gold_path) such hits are reclassified
//   `issue_authored_task_hits` and the case passes; a hit NOT verbatim in the
//   problem statement still fails.
//
//   expected deterministic no-context — the frozen M103 scoreboard records
//   capsule mode `no_context` for some miss-class cases (the deterministic
//   default path finds no capsule content). The live preflight reproducing
//   gate_action=no_context for exactly those cases is PARITY, not a failure —
//   but a live run would inject nothing (baseline-shaped, and parity-invalid
//   under the M105 validity contract), so such cases keep preflight_pass=false
//   (the driver never spawns them) while NOT blocking the global gate for the
//   other cases. A no_context gate action on a case the frozen M103 row does
//   NOT record as no_context still fails the global gate.
//
// NO agents, NO Docker, NO API spend, NO network.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m108_preflight.ts \
//     [--data /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl] \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results] [--only id,id]

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2Task, loadSweBenchData, parseArgs, toSweBenchInstance } from "./run_stage5_vexp_swe_bench_smoke";
import { scanLeakage } from "./run_stage5_m104_live_context_smoke";
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
const SELECTION = path.join(RESULTS_ROOT, "stage5_m108_case_selection.json");
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
    excluded_m107_cases: string[];
  };
  const selectedIds = selection.selected.map((s) => s.instance_id);
  const excluded = new Set([
    ...selection.excluded_m105_cases,
    ...selection.excluded_m106_cases,
    ...selection.excluded_m107_cases,
  ]);
  const overlap = selectedIds.filter((id) => excluded.has(id));
  if (overlap.length > 0) {
    throw new Error(`selection overlaps the committed M105/M106/M107 case sets (rerun forbidden): ${overlap.join(", ")}`);
  }

  const records = await loadSweBenchData(dataPath);
  const m103Raw = JSON.parse(readFileSync(M103_DETAIL, "utf8")) as {
    rows: Array<M103DetailRow & { capsule: { mode?: string } | null }>;
  };
  const m103Rows = new Map<string, M103DetailRow>(m103Raw.rows.map((r) => [r.instance_id, r]));
  const m103CapsuleMode = new Map<string, string | null>(m103Raw.rows.map((r) => [r.instance_id, r.capsule?.mode ?? null]));
  // Loaded for interface parity with M105; none of the 50 M108 cases has an
  // M104 row, so m104_hash_match stays null for all of them.
  const m104Rows = new Map<string, M104DetailRow>(
    (JSON.parse(readFileSync(M104_DETAIL, "utf8")) as { cases: M104DetailRow[] }).cases.map((r) => [r.instance_id, r]),
  );

  const NO_CONTEXT_REASONS = new Set([
    "gate action no_context under force-inject",
    "digest sentinel missing under --inject-capsule-digest",
    "decision-contract sentinel missing under --digest-decision-contract",
  ]);
  const TASK_HIT_REASON = "forbidden strings in task text";

  type M108PreflightCase = M105PreflightCase & {
    selection_stratum: string;
    phase: string;
    issue_authored_task_hits: string[] | null;
    expected_no_context: boolean;
  };

  const ids = only.length > 0 ? selectedIds.filter((id) => only.includes(id)) : selectedIds;
  const cases: M108PreflightCase[] = [];
  for (const id of ids) {
    const record = records.find((r) => r.instance_id === id || r.instanceId === id);
    if (record === undefined) {
      process.stderr.write(`[m108-preflight] SKIP ${id}: not in dataset\n`);
      continue;
    }
    process.stderr.write(`[m108-preflight] ${id} …\n`);
    const sel = selection.selected.find((s) => s.instance_id === id);
    const base = runCase(record, config, m103Rows.get(id) ?? null, m104Rows.get(id) ?? null, repoRoot);
    let failReasons = [...base.fail_reasons];
    let issueAuthoredHits: string[] | null = null;

    // Issue-authored task-hit reclassification (see file header): rescue ONLY
    // when the task is byte-exact with the frozen M103 row, there are no gold
    // added-line matches, and EVERY hit needle is verbatim in the problem
    // statement the issue author wrote.
    if (failReasons.includes(TASK_HIT_REASON) && base.m103_task_text_exact_match === true) {
      const instance = toSweBenchInstance(record);
      const task = buildCapsuleV2Task(instance);
      const passToPass = ((): string[] => {
        const v = record.PASS_TO_PASS ?? record.pass_to_pass;
        if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
        if (typeof v === "string") {
          try {
            const p = JSON.parse(v) as unknown;
            return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
          } catch {
            return [];
          }
        }
        return [];
      })();
      const scan = scanLeakage(task, {
        failToPass: instance.failToPass,
        passToPass,
        goldPatch: typeof record.patch === "string" ? record.patch : "",
      });
      const allIssueAuthored =
        scan.goldAddedLineMatches.length === 0 &&
        scan.hits.length > 0 &&
        scan.hits.every((h) => instance.problemStatement.includes(h.needle));
      if (allIssueAuthored) {
        issueAuthoredHits = scan.hits.map((h) => `${h.kind}:${h.needle}`);
        failReasons = failReasons.filter((r) => r !== TASK_HIT_REASON);
        process.stderr.write(`[m108-preflight] ${id}: task hits reclassified issue-authored (${issueAuthoredHits.join(", ")})\n`);
      }
    }

    // Expected deterministic no-context (see file header): parity with the
    // frozen M103 capsule mode. The case stays preflight_pass=false (never
    // spawned) but does not block the global gate.
    const expectedNoContext =
      failReasons.length > 0 &&
      failReasons.every((r) => NO_CONTEXT_REASONS.has(r)) &&
      m103CapsuleMode.get(id) === "no_context";

    cases.push({
      ...base,
      fail_reasons: failReasons,
      preflight_pass: failReasons.length === 0,
      selection_stratum: sel?.selection_stratum ?? "unknown",
      phase: sel?.phase ?? "unknown",
      issue_authored_task_hits: issueAuthoredHits,
      expected_no_context: expectedNoContext,
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
    milestone: "M108",
    kind: "no-agent live-run preflight (task parity + leakage + fallback + guards) over the 50 pre-registered remaining cases, under the M105/M92 clean-core treatment flags",
    date: new Date().toISOString().slice(0, 10),
    no_agents: true,
    no_docker: true,
    no_api_spend: true,
    treatment_argv: M105_TREATMENT_CONTEXT_ARGV,
    forbidden_arms_on: forbidden,
    mandatory_guards_off: guardsOff,
    m105_m106_m107_overlap_checked: true,
    cases: cases.length,
    preflight_pass_count: cases.filter((c) => c.preflight_pass).length,
    expected_no_context_count: cases.filter((c) => c.expected_no_context).length,
    expected_no_context_cases: cases.filter((c) => c.expected_no_context).map((c) => c.instance_id),
    issue_authored_task_hit_cases: cases
      .filter((c) => c.issue_authored_task_hits !== null)
      .map((c) => ({ id: c.instance_id, hits: c.issue_authored_task_hits })),
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
    // Global gate: every failing case must be an expected deterministic
    // no-context case (parity with the frozen M103 mode; never spawned). Any
    // OTHER failure — leakage, parity, guards — blocks all spawning.
    gate_pass:
      forbidden.length === 0 &&
      guardsOff.length === 0 &&
      envGuardPass &&
      shell.available &&
      cases.length > 0 &&
      cases.every((c) => c.preflight_pass || c.expected_no_context),
  };

  await mkdir(outDir, { recursive: true });
  const detailPath = path.join(outDir, "stage5_m108_live_preflight.detail.json");
  await writeFile(detailPath, `${JSON.stringify({ summary, cases }, null, 2)}\n`);
  process.stderr.write(`[m108-preflight] wrote ${detailPath}\n`);
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
