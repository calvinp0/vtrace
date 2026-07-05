// Stage 5 M105 — no-agent live-run preflight over the 14 M104 smoke cases.
//
// Before ANY M105 live agent spawn, this proves per case, using the EXACT M105
// treatment configuration (the M92 clean-core flag set: force-inject, v2,
// intent debug, budget 8000, digest + decision contract + bounded + compact +
// pivot-confidence-gate, mandatory env/shell guard flags):
//
//   parity   — the live task text is byte-identical to the shared M103
//              derivation, the FROZEN M104 smoke hash, and the FROZEN M103
//              detail row (text + diagnostics);
//   leakage  — the assembled model-visible markdown (INCLUDING the injected
//              digest/decision-contract blocks the M105 command adds) has no
//              unexplained FAIL_TO_PASS / PASS_TO_PASS / gold-patch / marker /
//              full-problem content (base-commit repo content is allowed and
//              diagnosed, per the M104 provenance policy);
//   fallback — the v2 capsule query succeeds (a live run would NOT take the
//              legacy fallback, which still packs FAIL_TO_PASS into retrieval);
//   arms off — the parsed M105 config has every revision / corrective /
//              behavioral-guard / vexp / unguarded-escape arm off;
//   guards   — the M89 env guard passes read-only and the M90A agent shell
//              guard materializes to a benchmark-valid pass.
//
// NO agents, NO Docker, NO API spend, NO network. The only subprocess is the
// local `vtrace capsule` CLI over the pre-existing M103 clean indexed
// workspaces (plus the read-only env-guard python probes).
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m105_preflight.ts \
//     [--data /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl] \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results] [--only id,id]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyContextPolicyOverride,
  buildCapsuleV2Task,
  buildStage5DigestEnrichmentsBestEffort,
  buildVtraceContextMarkdown,
  buildVtraceQueryCommand,
  capsuleModeForInstance,
  classifyCapsuleOutput,
  decideCapsuleV2ContextPolicy,
  deriveContextPolicySignals,
  loadSweBenchData,
  parseArgs,
  toSweBenchInstance,
  type CliConfig,
  type SweBenchInstance,
  type VtraceContextSection,
} from "./run_stage5_vexp_swe_bench_smoke";
import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";
import { assessGoldLeakage, extractGold } from "./stage5_m94_lib";
import { normalizeFilePath } from "./run_stage5_retrieval_eval";
import {
  SMOKE_CASE_IDS,
  derivableFromWorkspace,
  presentInWorkspace,
  scanLeakage,
  sha256,
  type AnnotatedLeakHit,
} from "./run_stage5_m104_live_context_smoke";
import { runStage5EnvGuardPreflight } from "./stage5EnvGuardIntegration";
import { materializeAgentShellGuard } from "./stage5AgentShellGuardIntegration";
import { evaluateMandatoryAgentShellGuard } from "./agentShellGuard";

const ROOT = "/home/calvin/code/vtrace";
const VEXP = "/home/calvin/code/vexp-swe-bench";
const DEFAULT_DATA = path.join(VEXP, "data", "swe-bench-100.jsonl");
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const M103_DETAIL = path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json");
const M104_DETAIL = path.join(RESULTS_ROOT, "stage5_m104_live_context_smoke.detail.json");
const EXPECTED_TESTBED_PREFIX = "/home/calvin/miniforge3/envs/vexp_swebench";

// The EXACT M105 live treatment argv (minus --mode/--instances/--run-label/
// --vexp-swe-bench-dir/--out, which do not shape the injected context). Kept in
// one exported constant so the driver, the preflight, and the report all agree.
export const M105_TREATMENT_CONTEXT_ARGV: readonly string[] = [
  "--context-policy", "force-inject",
  "--capsule-engine", "v2",
  "--capsule-intent", "debug",
  "--capsule-budget", "8000",
  "--inject-capsule-digest",
  "--digest-decision-contract",
  "--bounded-digest-decisions",
  "--compact-digest-injection",
  "--pivot-confidence-gate",
  "--stage5-env-guard",
  "--stage5-env-drift-check",
  "--expected-testbed-prefix", EXPECTED_TESTBED_PREFIX,
  "--stage5-agent-shell-guard",
  "--stage5-host-pip-firewall",
];

// Every opt-in arm that would invalidate M105 if it were on. Checked on the
// PARSED config so a flag-plumbing regression (not just a driver typo) fails
// the preflight.
export function forbiddenArmsOn(config: CliConfig): string[] {
  const arms: Array<[string, boolean]> = [
    ["allowVexp", config.allowVexp === true],
    ["allowUnguardedLiveEnv", config.allowUnguardedLiveEnv === true],
    ["pivotInspectionEnforcement", config.pivotInspectionEnforcement === true],
    ["pivotRevisionPass", config.pivotRevisionPass === true],
    ["ruleoutSufficiencyCheck", config.ruleoutSufficiencyCheck === true],
    ["toolLoopGuard", config.toolLoopGuard === true],
    ["costGuard", config.costGuard === true],
  ];
  return arms.filter(([, on]) => on).map(([name]) => name);
}

export function mandatoryGuardsOff(config: CliConfig): string[] {
  const guards: Array<[string, boolean]> = [
    ["stage5EnvGuard", config.stage5EnvGuard === true],
    ["stage5EnvDriftCheck", config.stage5EnvDriftCheck === true],
    ["expectedTestbedPrefix", config.expectedTestbedPrefix === EXPECTED_TESTBED_PREFIX],
    ["stage5AgentShellGuard", config.stage5AgentShellGuard !== false],
    ["stage5HostPipFirewall", config.stage5HostPipFirewall !== false],
  ];
  return guards.filter(([, ok]) => !ok).map(([name]) => name);
}

export interface M103DetailRow {
  readonly instance_id: string;
  readonly outcome: string | null;
  readonly derivation: {
    readonly task_text: string;
    readonly task_chars: number;
    readonly exception_count: number;
    readonly failing_test_count: number;
    readonly traceback_frame_count: number;
  } | null;
  readonly capsule: { readonly lead_pivot_file: string | null } | null;
}

export interface M104DetailRow {
  readonly instance_id: string;
  readonly structured_task_hash: string;
  readonly lead_pivot_file: string | null;
}

export interface M105PreflightCase {
  readonly instance_id: string;
  readonly repo: string;
  // Task parity
  readonly structured_task_hash: string;
  readonly structured_task_chars: number;
  readonly uses_shared_derivation: boolean;
  readonly m104_hash_match: boolean | null;
  readonly m103_task_text_exact_match: boolean | null;
  readonly task_diagnostics_match_m103: boolean | null;
  readonly task_is_full_problem_statement: boolean;
  // Provenance / leakage
  readonly leakage_verdict: string;
  readonly gold_patch_leak_block_count: number;
  readonly task_leak_hit_count: number;
  readonly context_leak_unexplained_count: number | null;
  readonly context_leak_base_commit_content_count: number | null;
  readonly context_leak_unexplained: AnnotatedLeakHit[];
  readonly model_visible_full_problem_present: boolean | null;
  // Fallback / context build under the M105 flags
  readonly workspace_found: boolean;
  readonly capsule_exit_code: number | null;
  readonly v2_fallback_would_fire: boolean | null;
  readonly gate_action: string | null;
  readonly digest_injected: boolean | null;
  readonly decision_contract_injected: boolean | null;
  readonly context_chars: number | null;
  readonly lead_pivot_file: string | null;
  readonly lead_pivot_matches_m103: boolean | null;
  readonly m103_outcome: string | null;
  readonly error: string | null;
  readonly preflight_pass: boolean;
  readonly fail_reasons: string[];
}

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      return [];
    }
  }
  return [];
}

const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";

export function runCase(
  record: Record<string, unknown>,
  config: CliConfig,
  m103Row: M103DetailRow | null,
  m104Row: M104DetailRow | null,
  repoRoot: string,
): M105PreflightCase {
  const instance: SweBenchInstance = toSweBenchInstance(record);
  const problemStatement = instance.problemStatement;
  const gold = extractGold(typeof record.patch === "string" ? record.patch : "");
  const goldPatch = typeof record.patch === "string" ? record.patch : "";
  const labels = {
    failToPass: instance.failToPass,
    passToPass: normalizeList(record.PASS_TO_PASS ?? record.pass_to_pass),
    goldPatch,
  };

  // --- Task parity ----------------------------------------------------------
  const liveTask = buildCapsuleV2Task(instance);
  const derived = deriveStructuredTaskFromProblemStatement(problemStatement);
  const diag = derived.diagnostics;
  const taskHash = sha256(liveTask);
  const m103Task = m103Row?.derivation?.task_text ?? null;
  const diagMatch = m103Row?.derivation
    ? diag.taskChars === m103Row.derivation.task_chars &&
      diag.exceptionCount === m103Row.derivation.exception_count &&
      diag.failingTestCount === m103Row.derivation.failing_test_count &&
      diag.tracebackFrameCount === m103Row.derivation.traceback_frame_count
    : null;
  const assessed = assessGoldLeakage(liveTask, problemStatement, gold);
  const taskLeak = scanLeakage(liveTask, labels);

  const base = {
    instance_id: instance.instanceId,
    repo: instance.repo,
    structured_task_hash: taskHash,
    structured_task_chars: liveTask.length,
    uses_shared_derivation: liveTask === derived.taskText,
    m104_hash_match: m104Row === null ? null : taskHash === m104Row.structured_task_hash,
    m103_task_text_exact_match: m103Task === null ? null : liveTask === m103Task,
    task_diagnostics_match_m103: diagMatch,
    task_is_full_problem_statement: liveTask.trim() === problemStatement.trim(),
    leakage_verdict: assessed.verdict,
    gold_patch_leak_block_count: assessed.verdict === "gold_patch_leak" ? 1 : 0,
    task_leak_hit_count: taskLeak.hits.length + taskLeak.goldAddedLineMatches.length,
    m103_outcome: m103Row?.outcome ?? null,
  };

  const failReasons: string[] = [];
  if (!base.uses_shared_derivation) failReasons.push("live task != shared M103 derivation");
  if (base.m104_hash_match === false) failReasons.push("task hash != frozen M104 hash");
  if (base.m103_task_text_exact_match === false) failReasons.push("task text != frozen M103 row");
  if (base.task_diagnostics_match_m103 === false) failReasons.push("derivation diagnostics != M103 row");
  if (base.task_is_full_problem_statement) failReasons.push("task is the full problem statement");
  if (base.gold_patch_leak_block_count > 0) failReasons.push("gold_patch_leak verdict on task");
  if (base.task_leak_hit_count > 0) failReasons.push("forbidden strings in task text");

  const fail = (error: string, extra?: Partial<M105PreflightCase>): M105PreflightCase => ({
    ...base,
    context_leak_unexplained_count: null,
    context_leak_base_commit_content_count: null,
    context_leak_unexplained: [],
    model_visible_full_problem_present: null,
    workspace_found: false,
    capsule_exit_code: null,
    v2_fallback_would_fire: null,
    gate_action: null,
    digest_injected: null,
    decision_contract_injected: null,
    context_chars: null,
    lead_pivot_file: null,
    lead_pivot_matches_m103: null,
    error,
    preflight_pass: false,
    fail_reasons: [...failReasons, error],
    ...extra,
  });

  // --- Model-visible context under the EXACT M105 flags ----------------------
  const workspace = resolveCleanWorkspace(instance.instanceId);
  if (workspace === null) return fail("no clean indexed workspace");

  const mode = capsuleModeForInstance(instance);
  const spec = buildVtraceQueryCommand(config, workspace, liveTask, mode);
  const proc = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    // A live run would take the legacy fallback here — parity-invalid for M105.
    return fail(`vtrace capsule failed (a live run would fall back to legacy): ${(proc.stderr ?? "").trim().slice(0, 400)}`, {
      workspace_found: true,
      capsule_exit_code: proc.status,
      v2_fallback_would_fire: true,
    });
  }

  // Mirror the live runEngineQuery classification for the M105 flag set,
  // including the DB-backed digest enrichment provider.
  const injectV2Digest = config.injectCapsuleDigest;
  const classification = classifyCapsuleOutput(proc.stdout, {
    injectDigest: injectV2Digest,
    query: liveTask,
    digestEnrichmentProvider: injectV2Digest
      ? (parsed) =>
          buildStage5DigestEnrichmentsBestEffort({
            dbPath: path.join(workspace, ".vtrace", "index.sqlite"),
            repoRoot: workspace,
            query: liveTask,
            result: parsed,
            intent: config.capsuleIntent,
          })
      : undefined,
    digestDecisionContract: injectV2Digest && config.digestDecisionContract,
    compactDigestInjection: injectV2Digest && config.compactDigestInjection,
    boundedDigestDecisions: injectV2Digest && config.digestDecisionContract && config.boundedDigestDecisions,
    pivotConfidenceGate:
      injectV2Digest && config.digestDecisionContract && config.boundedDigestDecisions && config.pivotConfidenceGate,
  });
  if (classification.policyAction === "error") {
    return fail(`v2 classification error (a live run would fall back to legacy): ${classification.error ?? "(no detail)"}`, {
      workspace_found: true,
      capsule_exit_code: proc.status,
      v2_fallback_would_fire: true,
    });
  }

  const hasContext = classification.context.trim().length > 0;
  const signals = deriveContextPolicySignals(instance);
  const autoDecision = decideCapsuleV2ContextPolicy(signals, {
    capsuleAction: classification.policyAction,
    hasContext,
    actualMode: classification.actualCapsuleMode,
    pivotCount: classification.pivotCount,
    supportCount: classification.supportCount,
    topPivotHasSource: classification.capsuleTopPivotHasSource,
    topPivotSourceChars: classification.capsuleTopPivotSourceChars,
    editRiskDirectiveCount: classification.capsuleEditRiskDirectivesCount,
    lineAnchorResolutionUsed: classification.capsuleLineAnchorResolutionUsed,
    sqlRenderingBackfillUsed: classification.capsuleSqlRenderingBackfillUsed,
    actionabilityHintCount: classification.capsuleV2Result?.actionability_hints?.length ?? 0,
    topPivotPath: classification.capsuleV2Result?.pivots[0]?.path ?? null,
    localization: classification.capsuleV2Result?.diagnostics.localization_signals,
  });
  const decision = applyContextPolicyOverride(autoDecision, config.contextPolicyOverride, hasContext);

  const section: VtraceContextSection = {
    instance,
    rawContext: classification.context,
    error: null,
    classification,
    preformatted: true,
    requestedEngine: "v2",
    effectiveEngine: "v2",
    engineFallbackReason: null,
  };
  const assembled = buildVtraceContextMarkdown([section], {
    maxChars: config.vtraceContextMaxChars,
    maxItems: config.vtraceContextMaxItems,
    pivotCheckPolicy: config.disablePivotCheck ? "off" : config.pivotCheckPolicy,
    disableEditGuard: config.disableEditGuard,
    disablePatchVerify: config.disablePatchVerify,
    pivotInspectionEnforcement: config.pivotInspectionEnforcement,
    injectTokenDiscipline: !config.disableTokenDiscipline,
  });

  const contextLeak = scanLeakage(assembled.markdown, labels);
  const annotatedHits: AnnotatedLeakHit[] = contextLeak.hits.map((h) => ({
    ...h,
    in_base_commit_repo: derivableFromWorkspace(workspace, h.needle),
  }));
  const annotatedGoldLines = contextLeak.goldAddedLineMatches.map((line) => ({
    line,
    in_base_commit_repo: presentInWorkspace(workspace, line),
  }));
  const unexplained: AnnotatedLeakHit[] = [
    ...annotatedHits.filter((h) => !h.in_base_commit_repo),
    ...annotatedGoldLines
      .filter((g) => !g.in_base_commit_repo)
      .map((g) => ({ kind: "gold_added_line", needle: g.line, snippet: "", in_base_commit_repo: false })),
  ];
  const explainedCount = annotatedHits.length + annotatedGoldLines.length - unexplained.length;
  const fullProblemVisible =
    problemStatement.trim().length > 200 && assembled.markdown.includes(problemStatement.trim());

  if (unexplained.length > 0) failReasons.push("unexplained model-visible leakage hits");
  if (fullProblemVisible) failReasons.push("full problem statement visible in context");
  if (decision.action !== "inject") failReasons.push(`gate action ${decision.action} under force-inject`);
  const digestInjected = assembled.markdown.includes(DIGEST_START);
  const contractInjected = assembled.markdown.includes(CONTRACT_START);
  if (!digestInjected) failReasons.push("digest sentinel missing under --inject-capsule-digest");
  if (!contractInjected) failReasons.push("decision-contract sentinel missing under --digest-decision-contract");

  const leadPivot = classification.capsulePivots?.[0]?.path;
  const leadPivotFile = leadPivot === undefined ? null : normalizeFilePath(leadPivot);
  const m103Lead = m103Row?.capsule?.lead_pivot_file ?? null;

  return {
    ...base,
    context_leak_unexplained_count: unexplained.length,
    context_leak_base_commit_content_count: explainedCount,
    context_leak_unexplained: unexplained,
    model_visible_full_problem_present: fullProblemVisible,
    workspace_found: true,
    capsule_exit_code: proc.status,
    v2_fallback_would_fire: false,
    gate_action: decision.action,
    digest_injected: digestInjected,
    decision_contract_injected: contractInjected,
    context_chars: assembled.markdown.length,
    lead_pivot_file: leadPivotFile,
    lead_pivot_matches_m103: m103Lead === null || leadPivotFile === null ? null : leadPivotFile === m103Lead,
    error: null,
    preflight_pass: failReasons.length === 0,
    fail_reasons: failReasons,
  };
}

export async function probeShellGuard(outDir: string) {
  const probeDir = path.join(outDir, "_m105_preflight_shell_guard_probe");
  await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  let materializeOk = false;
  let pathSanitized = false;
  let condaEnvScrubbed = false;
  let failureReason: string | null = null;
  try {
    const mat = materializeAgentShellGuard({ runDir: probeDir, expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX });
    materializeOk = mat.wrapperBinReady;
    pathSanitized = mat.shellEnv.pathSanitized;
    condaEnvScrubbed = mat.shellEnv.condaEnvScrubbed;
    failureReason = mat.failureReason;
  } catch (err) {
    failureReason = `materialize threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const decision = evaluateMandatoryAgentShellGuard({
    isLiveAgentRun: true,
    allowUnguardedLiveEnv: false,
    shellGuardEnabled: true,
    hostPipFirewallEnabled: true,
    wrapperBinReady: materializeOk,
    pathSanitized,
    condaEnvScrubbed,
  });
  await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  return {
    materialize_ok: materializeOk,
    path_sanitized: pathSanitized,
    conda_env_scrubbed: condaEnvScrubbed,
    decision_status: decision.status,
    decision_benchmark_valid: decision.benchmarkValid,
    failure_reason: failureReason ?? decision.reason,
    available: decision.proceed && decision.status === "pass" && decision.benchmarkValid && materializeOk,
  };
}

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

  const records = await loadSweBenchData(dataPath);
  const m103Rows = new Map<string, M103DetailRow>(
    (JSON.parse(readFileSync(M103_DETAIL, "utf8")) as { rows: M103DetailRow[] }).rows.map((r) => [r.instance_id, r]),
  );
  const m104Rows = new Map<string, M104DetailRow>(
    (JSON.parse(readFileSync(M104_DETAIL, "utf8")) as { cases: M104DetailRow[] }).cases.map((r) => [r.instance_id, r]),
  );

  const ids = only.length > 0 ? SMOKE_CASE_IDS.filter((id) => only.includes(id)) : SMOKE_CASE_IDS;
  const cases: M105PreflightCase[] = [];
  for (const id of ids) {
    const record = records.find((r) => r.instance_id === id || r.instanceId === id);
    if (record === undefined) {
      process.stderr.write(`[m105-preflight] SKIP ${id}: not in dataset\n`);
      continue;
    }
    process.stderr.write(`[m105-preflight] ${id} …\n`);
    cases.push(runCase(record, config, m103Rows.get(id) ?? null, m104Rows.get(id) ?? null, repoRoot));
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
    milestone: "M105",
    kind: "no-agent live-run preflight (task parity + leakage + fallback + guards) under the M105 treatment flags",
    date: new Date().toISOString().slice(0, 10),
    no_agents: true,
    no_docker: true,
    no_api_spend: true,
    treatment_argv: M105_TREATMENT_CONTEXT_ARGV,
    forbidden_arms_on: forbidden,
    mandatory_guards_off: guardsOff,
    cases: cases.length,
    preflight_pass_count: cases.filter((c) => c.preflight_pass).length,
    m104_hash_match_all: cases.every((c) => c.m104_hash_match !== false),
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
  const detailPath = path.join(outDir, "stage5_m105_live_preflight.detail.json");
  await writeFile(detailPath, `${JSON.stringify({ summary, cases }, null, 2)}\n`);
  process.stderr.write(`[m105-preflight] wrote ${detailPath}\n`);
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
