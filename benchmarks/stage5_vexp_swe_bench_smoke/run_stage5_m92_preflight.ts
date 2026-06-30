/**
 * M92 — no-agent pre-flight over the FROZEN M90/M92 50-case split (NO live agents, NO Docker, NO API
 * spend) for the CORE structured-bounded VTRACE token-reduction treatment with the M89/M90A mandatory
 * safety stack (env-isolation guard + agent shell guard / host-pip firewall) and the V4/C7_D
 * BEHAVIORAL guards DISABLED.
 *
 * For each selected instance it RE-RENDERS the EXACT M73/M80/M82/M85 structured-bounded +
 * pivot-confidence treatment context offline (identical render to the M90 preflight) and classifies
 * validity with the M72/M73 gate-on rules. It DIFFERS from the M90 preflight in the gate:
 *   - It does NOT require the V4 tool-loop guard / C7_D cost guard inject seam (M92 disables them).
 *     It instead ASSERTS the behavioral guards are off (offline they cannot be configured here).
 *   - It ADDS an offline agent-shell-guard / host-pip-firewall AVAILABILITY proof: it materializes
 *     the per-run wrapper bin into a throwaway temp dir and runs the mandatory-gate decision
 *     (evaluateMandatoryAgentShellGuard) to prove a live run would pass status=pass / benchmark-valid.
 *   - It keeps the M86 read-only env-guard prefix probe + drift-check readiness.
 *
 * Neither the env probe nor the shell-guard materialization affects the rendered context; the
 * treatment-validity classification is identical to M85/M90. Changes NO retrieval / scoring / ranking.
 *
 *   bun run_stage5_m92_preflight.ts [--split path] [--dataset path] [--out dir] [--only id,id]
 *     [--expected-testbed-prefix path] [--no-clone-missing] [--no-cleanup]
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { Glob } from "bun";
import {
  loadSweBenchData,
  findSweBenchRecord,
  toSweBenchInstance,
  buildCapsuleV2Task,
  buildVtraceQueryCommand,
  capsuleModeForInstance,
  classifyCapsuleOutput,
  buildStage5DigestEnrichmentsBestEffort,
  STAGE5_ATOMIC_SENTINEL_BLOCKS,
  prepareIndexedContext,
  type CliConfig,
} from "./run_stage5_vexp_swe_bench_smoke.ts";
import { buildPrecheckConfig } from "./run_stage5_live_capsule_precheck.ts";
import { runStage5EnvGuardPreflight } from "./stage5EnvGuardIntegration";
import { normalizePrefix } from "./envIsolationGuard";
import { materializeAgentShellGuard } from "./stage5AgentShellGuardIntegration";
import { evaluateMandatoryAgentShellGuard } from "./agentShellGuard";
import {
  parseDigestDecisionContract,
  NO_HIGH_CONFIDENCE_REQUIRED_MARKER,
} from "../../src/capsuleV2/digestDecisionContract.ts";
import {
  truncateContextByPriority,
  STRUCTURED_CONTRACT_OMITTED_MARKER,
} from "../../src/capsuleV2/sectionBudgetAccounting.ts";

const ROOT = "/home/calvin/code/vtrace";
const VTRACE_CONTEXT_MAX_CHARS = 12_000;
const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const INSPECT_FIRST = "## VTRACE inspect-first";
const DEMOTED_SUFFIX = "low-confidence pivot (weak localization evidence)";

function flag(name: string, fb: string | null): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const SPLIT = flag("--split", path.join(RESULTS, "stage5_m92_core_reduction50_split.json"))!;
const DATASET = flag("--dataset", "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl")!;
const OUT = flag("--out", RESULTS)!;
const VEXP = flag("--vexp-swe-bench-dir", "/home/calvin/code/vexp-swe-bench")!;
const EXPECTED_TESTBED_PREFIX = normalizePrefix(
  flag("--expected-testbed-prefix", "/home/calvin/miniforge3/envs/vexp_swebench")!,
);
const CLONE_MISSING = !has("--no-clone-missing");
const CLEANUP = !has("--no-cleanup");
const ONLY = (flag("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const WS_ROOT = path.join(OUT, "workspaces");

function countOcc(h: string, n: string): number {
  return h.split(n).length - 1;
}
function block(t: string, s: string, e: string): string {
  const a = t.indexOf(s);
  const b = t.indexOf(e);
  return a >= 0 && b >= 0 ? t.slice(a, b + e.length) : "";
}

async function buildWorkspaceMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const glob = new Glob("**/.vtrace/index.sqlite");
  const found: string[] = [];
  try {
    for await (const rel of glob.scan({ cwd: WS_ROOT, onlyFiles: true, dot: true })) found.push(rel);
  } catch {
    /* no workspaces dir */
  }
  found.sort();
  for (const rel of found) {
    const wsDir = path.join(WS_ROOT, path.dirname(path.dirname(rel)));
    const inst = path.basename(wsDir);
    if (!map.has(inst)) map.set(inst, wsDir);
  }
  return map;
}

// Shared classifier over the FINAL injected context (post-truncation). Identical to M85/M90, plus
// the M92 token-accounting fields (digest_chars, capsule/context chars, optional target count).
function classifyFinalContext(ctx: string) {
  const digest = block(ctx, DIGEST_START, DIGEST_END);
  const contractBlock = block(ctx, CONTRACT_START, CONTRACT_END);
  const dS = countOcc(ctx, DIGEST_START), dE = countOcc(ctx, DIGEST_END);
  const cS = countOcc(ctx, CONTRACT_START), cE = countOcc(ctx, CONTRACT_END);
  const partial = dS !== dE || cS !== cE;
  const fourSentinelOk = dS === 1 && dE === 1 && cS === 1 && cE === 1;

  const parsed = parseDigestDecisionContract(ctx);
  const contractPresent = parsed.present;
  const requiredCount = parsed.targets.length;
  const requiredHasImpact = parsed.targets.some((t) => t.kind === "IMPACT");
  const noHighConfMarker = ctx.includes(NO_HIGH_CONFIDENCE_REQUIRED_MARKER);

  const requiredIds = [...contractBlock.matchAll(/target_id: (T\d+)/g)].map((m) => m[1]!);
  const optionalLines = [...contractBlock.matchAll(/^- (O\d+): (.+)$/gm)].map((m) => ({ id: m[1]!, body: m[2]! }));
  const optionalIds = optionalLines.map((o) => o.id);
  const demotedPivots = optionalLines.filter((o) => o.body.includes(DEMOTED_SUFFIX));
  const impactReps = optionalLines.filter((o) => o.body.includes("additional dependent/caller"));
  const idsCollide =
    optionalIds.some((id) => requiredIds.includes(id)) ||
    requiredIds.some((id) => /^O/.test(id)) ||
    optionalIds.some((id) => /^T/.test(id));

  const hasImpactRow = /→ impact/.test(digest);
  const optionalSectionPresent = /Optional context \/ FYI/.test(contractBlock);
  const notClosureScored = /not closure-scored/i.test(contractBlock);
  const compact = countOcc(ctx, INSPECT_FIRST) === 0;
  const omission = ctx.includes(STRUCTURED_CONTRACT_OMITTED_MARKER);
  const grammar =
    /target_id/.test(contractBlock) &&
    /decision:/.test(contractBlock) &&
    /reason:/.test(contractBlock) &&
    /files_touched/.test(contractBlock) &&
    /EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(contractBlock);

  let status = "VALID";
  let reason: string | null = null;
  if (partial) {
    status = "INVALID_PARTIAL_SENTINEL";
    reason = "start_end_sentinel_mismatch";
  } else if (!contractPresent || !fourSentinelOk) {
    if (omission) {
      status = "FAIL_CLOSED_OMITTED";
      reason = "essential_block_omitted_over_budget";
    } else {
      status = "OTHER_INVALID";
      reason = "contract_absent_or_sentinels_not_singular";
    }
  } else if (requiredHasImpact) {
    status = "INVALID_IMPACT";
    reason = "impact_rep_still_required";
  } else if (idsCollide) {
    status = "INVALID_IMPACT";
    reason = "optional_ids_collide_with_required_ids";
  } else if (optionalSectionPresent && !notClosureScored) {
    status = "INVALID_IMPACT";
    reason = "optional_context_not_marked_uncored";
  } else if (!compact) {
    status = "OTHER_INVALID";
    reason = "compact_mode_not_applied";
  } else if (requiredCount === 0) {
    if (!noHighConfMarker) {
      status = "INVALID_CONFIDENCE_GATE";
      reason = "zero_required_without_marker";
    } else if (demotedPivots.length === 0) {
      status = "INVALID_CONFIDENCE_GATE";
      reason = "zero_required_but_no_demoted_pivots_listed";
    } else {
      status = "VALID";
    }
  } else if (!grammar || requiredCount > 4) {
    status = "INVALID_STRUCTURED_GRAMMAR";
    reason = !grammar ? "structured_grammar_absent" : "required_target_count_gt_4";
  } else {
    status = "VALID";
  }

  // crude char→token estimate (≈4 chars/token) — order-of-magnitude only, for attribution.
  const est = (n: number) => Math.round(n / 4);
  return {
    treatment_status: status,
    treatment_invalid_reason: reason,
    context_chars: ctx.length,
    capsule_est_tokens: est(ctx.length),
    digest_chars: digest.length,
    digest_est_tokens: est(digest.length),
    contract_chars: contractBlock.length,
    digest_present: dS === 1 && dE === 1,
    contract_present: contractPresent,
    four_sentinel_ok: fourSentinelOk,
    partial_sentinel: partial,
    has_impact_row: hasImpactRow,
    structured_grammar_present: grammar,
    compact_mode_applied: compact,
    confidence_gate_enabled: true,
    no_high_confidence_required_marker: noHighConfMarker,
    required_target_count: requiredCount,
    optional_target_count: optionalIds.length,
    required_has_impact: requiredHasImpact,
    demoted_pivot_count: demotedPivots.length,
    optional_impact_id_count: impactReps.length,
    optional_section_present: optionalSectionPresent,
    optional_not_closure_scored: notClosureScored,
    optional_ids_collide: idsCollide,
    omission_marker_present: omission,
  };
}

function renderReuse(ws: string, queryText: string, mode: ReturnType<typeof capsuleModeForInstance>): string | null {
  const config = {
    vtraceCommand: "bun src/cli/index.ts",
    vtraceQueryArgs: "",
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
    injectCapsuleDigest: true,
  } as unknown as CliConfig;
  const spec = buildVtraceQueryCommand(config, ws, queryText, mode);
  const proc = Bun.spawnSync([spec.command, ...spec.args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return null;
  const stdout = new TextDecoder().decode(proc.stdout);
  const provider = (parsed: Parameters<typeof buildStage5DigestEnrichmentsBestEffort>[0]["result"]) =>
    buildStage5DigestEnrichmentsBestEffort({
      dbPath: path.join(ws, ".vtrace", "index.sqlite"),
      repoRoot: ws,
      query: queryText,
      result: parsed,
      intent: "debug",
    });
  const rawCtx =
    classifyCapsuleOutput(stdout, {
      injectDigest: true,
      query: queryText,
      digestEnrichmentProvider: provider,
      digestDecisionContract: true,
      boundedDigestDecisions: true,
      compactDigestInjection: true,
      pivotConfidenceGate: true,
    }).context ?? "";
  if (!rawCtx) return null;
  return truncateContextByPriority(rawCtx, VTRACE_CONTEXT_MAX_CHARS, {
    atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS,
  }).text;
}

async function renderClone(instanceId: string): Promise<string | null> {
  const short = instanceId.replace(/[^a-zA-Z0-9]+/g, "_");
  const base = buildPrecheckConfig({
    instanceId,
    vexpSweBenchDir: VEXP,
    resultsDir: path.join(OUT, "_m92_preflight", short),
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
    reuseWorkspace: false,
  });
  const config: CliConfig = {
    ...base,
    injectCapsuleDigest: true,
    digestDecisionContract: true,
    compactDigestInjection: true,
    boundedDigestDecisions: true,
    pivotConfidenceGate: true,
  };
  const result = await prepareIndexedContext(config, {});
  if (!result.contextFile) return null;
  return await Bun.file(result.contextFile).text();
}

// One-time OFFLINE agent-shell-guard / host-pip-firewall availability proof (shared by every case).
// Materializes the per-run wrapper bin into a throwaway temp dir and runs the mandatory-gate
// decision exactly as a live run would, proving a live run would pass status=pass / benchmark-valid.
async function probeShellGuard() {
  const probeDir = path.join(OUT, "_m92_preflight", "_shell_guard_probe");
  await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  let materializeOk = false;
  let wrapperBin: string | null = null;
  let pathSanitized = false;
  let condaEnvScrubbed = false;
  let failureReason: string | null = null;
  try {
    const mat = materializeAgentShellGuard({ runDir: probeDir, expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX });
    materializeOk = mat.wrapperBinReady;
    wrapperBin = mat.wrapperBin;
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
  if (CLEANUP) await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  return {
    materialize_ok: materializeOk,
    wrapper_bin: wrapperBin,
    path_sanitized: pathSanitized,
    conda_env_scrubbed: condaEnvScrubbed,
    decision_proceed: decision.proceed,
    decision_status: decision.status,
    decision_benchmark_valid: decision.benchmarkValid,
    decision_required: decision.required,
    failure_reason: failureReason ?? decision.reason,
    available: decision.proceed && decision.status === "pass" && decision.benchmarkValid && materializeOk,
  };
}

const records = await loadSweBenchData(DATASET);
const split = JSON.parse(await Bun.file(SPLIT).text()) as {
  cases: Array<{ instance_id: string; repo: string; difficulty?: string; validation_group: string; group?: string }>;
};
let selected = split.cases;
if (ONLY.length) selected = selected.filter((s) => ONLY.includes(s.instance_id));

const shell = await probeShellGuard();

// One-time READ-ONLY Stage 5 environment-guard preflight (the live driver runs this before each
// agent spawn; it MUTATES NOTHING — `python -c`, `python -m pip -V` probes only).
const env = runStage5EnvGuardPreflight({
  enabled: true,
  driftCheckEnabled: true,
  expectedTestbedPrefix: EXPECTED_TESTBED_PREFIX,
  vexpSweBenchDir: VEXP,
  shellCondaPrefix: process.env.CONDA_PREFIX ?? "/home/calvin/miniforge3",
});
const envMeta = env.metadata;
const envGuardPass =
  env.ok &&
  envMeta.stage5_env_guard_status === "pass" &&
  envMeta.stage5_python_prefix_verified === true &&
  envMeta.stage5_pip_prefix_verified === true &&
  "stage5_prefix_drift_summary" in envMeta;
const envExpectedPrefixOk = envMeta.stage5_expected_testbed_prefix === EXPECTED_TESTBED_PREFIX;
const driftCheckEnabled = envMeta.stage5_drift_check_enabled === true;

console.error(
  `[shell] available=${shell.available} materialize=${shell.materialize_ok} status=${shell.decision_status} ` +
    `benchmark_valid=${shell.decision_benchmark_valid} path_sanitized=${shell.path_sanitized}`,
);
console.error(
  `[env] guard_pass=${envGuardPass} status=${envMeta.stage5_env_guard_status} ` +
    `py=${envMeta.stage5_python_prefix_verified} pip=${envMeta.stage5_pip_prefix_verified} ` +
    `prefix_ok=${envExpectedPrefixOk} drift=${driftCheckEnabled} resolved=${env.resolvedTestbedPython}`,
);

const wsMap = await buildWorkspaceMap();
const cases: any[] = [];

for (const sel of selected) {
  const inst = sel.instance_id;
  const ws = wsMap.get(inst) ?? null;
  // M92 behavioral-guard exclusions: NOT configured. A run with these flags omitted runs no guard
  // and emits no *_guard_* metadata; offline we assert the intended-off state.
  const guardFields = {
    tool_loop_guard_enabled: false,
    cost_guard_enabled: false,
    // M90A shell-guard availability (one-time probe, identical for every case).
    stage5_agent_shell_guard_available: shell.available,
    stage5_agent_shell_guard_status: shell.decision_status,
    stage5_host_pip_firewall_available: shell.available,
    // M86 env-guard fields (one-time probe, identical for every case).
    stage5_env_guard_enabled: true,
    stage5_env_guard_status: envMeta.stage5_env_guard_status,
    stage5_expected_testbed_prefix: envMeta.stage5_expected_testbed_prefix,
    stage5_python_prefix_verified: envMeta.stage5_python_prefix_verified,
    stage5_pip_prefix_verified: envMeta.stage5_pip_prefix_verified,
    stage5_drift_check_enabled: driftCheckEnabled,
  };
  const base: any = {
    instance_id: inst,
    repo: sel.repo,
    difficulty: sel.difficulty ?? null,
    validation_group: sel.validation_group,
    render_path: "none",
    final_status: "PREFLIGHT_PENDING_INDEX",
    invalid_reason: ws ? null : "no_persisted_index_and_clone_disabled",
    ...guardFields,
  };

  const record = findSweBenchRecord(records, inst);
  if (record === null) {
    base.final_status = "OTHER_INVALID";
    base.invalid_reason = "not_in_dataset";
    cases.push(base);
    continue;
  }
  const instance = toSweBenchInstance(record);
  const queryText = buildCapsuleV2Task(instance);
  const mode = capsuleModeForInstance(instance);

  let finalCtx: string | null = null;
  if (ws) {
    base.render_path = "reuse";
    try {
      finalCtx = renderReuse(ws, queryText, mode);
    } catch (err) {
      base.invalid_reason = `reuse_render_threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (CLONE_MISSING) {
    base.render_path = "clone";
    try {
      finalCtx = await renderClone(inst);
    } catch (err) {
      base.final_status = "OTHER_INVALID";
      base.invalid_reason = `clone_render_threw: ${err instanceof Error ? err.message : String(err)}`;
      cases.push(base);
      console.error(`[fail] ${inst} clone render threw`);
      continue;
    } finally {
      if (CLEANUP) {
        const short = inst.replace(/[^a-zA-Z0-9]+/g, "_");
        await rm(path.join(OUT, "_m92_preflight", short), { recursive: true, force: true }).catch(() => {});
      }
    }
  } else {
    cases.push(base);
    continue;
  }

  if (!finalCtx) {
    base.final_status = "OTHER_INVALID";
    base.invalid_reason ??= `${base.render_path}_render_empty`;
    cases.push(base);
    console.error(`[fail] ${inst} render empty`);
    continue;
  }

  const cls = classifyFinalContext(finalCtx);
  // Final M92 status combines treatment validity AND the env-guard preflight passing AND the
  // shell-guard availability proof. It does NOT require any behavioral (V4/C7_D) guard seam.
  let finalStatus = cls.treatment_status;
  let finalReason = cls.treatment_invalid_reason;
  if (finalStatus === "VALID" && !shell.available) {
    finalStatus = "INVALID_SHELL_GUARD";
    finalReason = "m92_shell_guard_unavailable";
  } else if (finalStatus === "VALID" && !envGuardPass) {
    finalStatus = "INVALID_ENV_GUARD";
    finalReason = "m92_env_guard_not_pass";
  } else if (finalStatus === "VALID" && !envExpectedPrefixOk) {
    finalStatus = "INVALID_ENV_GUARD";
    finalReason = "m92_expected_prefix_not_verified";
  } else if (finalStatus === "VALID" && !driftCheckEnabled) {
    finalStatus = "INVALID_ENV_GUARD";
    finalReason = "m92_drift_check_missing";
  }
  const merged = { ...base, ...cls, final_status: finalStatus, invalid_reason: finalReason };
  cases.push(merged);
  console.error(
    `[done] ${inst} ${merged.final_status} grp=${merged.validation_group} req=${merged.required_target_count} ` +
      `opt=${merged.optional_target_count} demoted=${merged.demoted_pivot_count} ` +
      `marker=${merged.no_high_confidence_required_marker} ctx=${merged.context_chars} digest=${merged.digest_chars} ` +
      `shell=${shell.available} env=${envGuardPass} path=${merged.render_path}`,
  );
}

const valid = cases.filter((r) => r.final_status === "VALID");
const byStatus: Record<string, number> = {};
for (const r of cases) byStatus[r.final_status] = (byStatus[r.final_status] ?? 0) + 1;

const MIN_VALID = 45; // M92 gate: stop if fewer than 45 cases valid.
const partialSentinelZero = (byStatus["INVALID_PARTIAL_SENTINEL"] ?? 0) === 0;
const requiredImpactZero = cases.reduce((a, r) => a + (r.required_has_impact ? 1 : 0), 0) === 0;
const behavioralGuardsDisabledAll = cases.every(
  (r) => r.tool_loop_guard_enabled === false && r.cost_guard_enabled === false,
);

const summary = {
  milestone: "M92-preflight",
  kind: "no-agent gate-on render pre-flight over the frozen M92 50-case split; CORE structured-bounded VTRACE token-reduction treatment with V4/C7_D behavioral guards DISABLED, M86 env-isolation guard (read-only probe + drift readiness) and M90A agent-shell-guard / host-pip-firewall availability proof",
  helper: "run_stage5_m92_preflight.ts",
  split: SPLIT,
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  clone_missing: CLONE_MISSING,
  behavioral_guards: {
    tool_loop_guard_configured: false,
    cost_guard_configured: false,
    behavioral_guards_disabled_all: behavioralGuardsDisabledAll,
  },
  shell_guard: shell,
  env_guard: {
    enabled: true,
    expected_testbed_prefix: EXPECTED_TESTBED_PREFIX,
    pass: envGuardPass,
    status: envMeta.stage5_env_guard_status,
    python_prefix_verified: envMeta.stage5_python_prefix_verified,
    pip_prefix_verified: envMeta.stage5_pip_prefix_verified,
    expected_prefix_ok: envExpectedPrefixOk,
    drift_check_enabled: driftCheckEnabled,
    drift_summary: envMeta.stage5_prefix_drift_summary,
    resolved_testbed_python: env.resolvedTestbedPython,
    prefix_guard_failures: envMeta.stage5_prefix_guard_failures ?? [],
    warnings: env.prefixGuard?.warnings ?? [],
  },
  total: cases.length,
  valid_count: valid.length,
  by_status: byStatus,
  partial_sentinel_count: byStatus["INVALID_PARTIAL_SENTINEL"] ?? 0,
  required_impact_count: cases.reduce((a, r) => a + (r.required_has_impact ? 1 : 0), 0),
  zero_required_count: cases.filter((r) => r.render_path !== "none" && r.required_target_count === 0).length,
  confidence_gate_enabled_all: cases.every((r) => r.confidence_gate_enabled === true || r.render_path === "none"),
  compact_mode_applied_all: cases.every((r) => r.compact_mode_applied === true || r.render_path === "none"),
  env_guard_pass_all: cases.every((r) => r.stage5_env_guard_status === "pass"),
  shell_guard_available_all: cases.every((r) => r.stage5_agent_shell_guard_available === true),
  invalid_cases: cases
    .filter((r) => r.final_status !== "VALID")
    .map((r) => ({ instance_id: r.instance_id, final_status: r.final_status, invalid_reason: r.invalid_reason })),
  // Gate decision per the M92 protocol (fewer than 45 valid ⇒ STOP).
  gate: {
    min_valid_required: MIN_VALID,
    valid_count: valid.length,
    partial_sentinel_zero: partialSentinelZero,
    required_impact_zero: requiredImpactZero,
    behavioral_guards_disabled_all: behavioralGuardsDisabledAll,
    shell_guard_available: shell.available,
    env_guard_pass: envGuardPass,
    expected_prefix_ok: envExpectedPrefixOk,
    drift_check_enabled: driftCheckEnabled,
    passes:
      valid.length >= MIN_VALID &&
      partialSentinelZero &&
      requiredImpactZero &&
      behavioralGuardsDisabledAll &&
      shell.available &&
      envGuardPass &&
      envExpectedPrefixOk &&
      driftCheckEnabled,
  },
  cases,
};
await Bun.write(path.join(OUT, "stage5_m92_core_reduction50_preflight.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "RESULT_JSON: " +
    JSON.stringify({
      total: summary.total,
      valid: summary.valid_count,
      by_status: byStatus,
      behavioral_guards_disabled_all: behavioralGuardsDisabledAll,
      shell_guard_available: shell.available,
      env_guard_pass: envGuardPass,
      env_status: envMeta.stage5_env_guard_status,
      expected_prefix_ok: envExpectedPrefixOk,
      drift_check_enabled: driftCheckEnabled,
      gate_passes: summary.gate.passes,
    }),
);
