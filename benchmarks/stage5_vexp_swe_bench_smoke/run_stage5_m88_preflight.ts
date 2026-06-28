/**
 * M88 — no-agent pre-flight over the FROZEN M88 24-case split (NO live agents, NO Docker, NO API
 * spend) for the COMBINED V4 tool-loop guard + C7_D (editVerifyChurnThreshold=2) cost/no-convergence
 * guard in runtime-inject mode, HARDENED with the M86 Stage 5 environment-isolation guard.
 *
 * For each selected instance it RE-RENDERS the EXACT M73/M80/M82/M85 structured-bounded +
 * pivot-confidence treatment context offline and classifies validity with the M72/M73 gate-on rules
 * (identical to the M85 preflight), AND verifies BOTH runtime guards are configured + the SINGLE
 * combined PostToolUse hook seam is available + the C7_D calibration is correctly constructed
 * (editVerifyChurnThreshold===2, 25-tool gate unchanged).
 *
 * M88 adds a one-time READ-ONLY Stage 5 environment-guard preflight probe
 * (runStage5EnvGuardPreflight) that proves the disposable testbed interpreter targets the
 * expected vexp_swebench prefix (never the conda base / active dev env) and reports drift-check
 * readiness — the same probe the live driver runs before spawning each agent. It MUTATES NOTHING.
 *
 * Neither guard nor the env probe affects the rendered context; the treatment-validity
 * classification is identical to M85. Changes NO retrieval / scoring / ranking logic.
 *
 *   bun run_stage5_m88_preflight.ts [--split path] [--dataset path] [--out dir] [--only id,id]
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
  locateClaudePromptFile,
  hasToolLoopGuardHookPatch,
  toolLoopGuardHookSettingsFilePath,
  toolLoopGuardHookCommand,
  costGuardHookSettingsFilePath,
  costGuardHookCommand,
  STAGE5_TOOL_LOOP_GUARD_HOOK_MARKER,
  type CliConfig,
} from "./run_stage5_vexp_swe_bench_smoke.ts";
import { buildToolLoopGuardHookSettings } from "./toolLoopGuardRuntime.ts";
import { costGuardConfigForCalibration } from "./costGuard.ts";
import { buildPrecheckConfig } from "./run_stage5_live_capsule_precheck.ts";
import { runStage5EnvGuardPreflight } from "./stage5EnvGuardIntegration";
import { normalizePrefix } from "./envIsolationGuard";
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
const SPLIT = flag("--split", path.join(RESULTS, "stage5_m88_v4_c7d_envguard_split.json"))!;
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

// Shared classifier over the FINAL injected context (post-truncation). Identical to M85/M80/M73.
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

  return {
    treatment_status: status,
    treatment_invalid_reason: reason,
    context_chars: ctx.length,
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
    resultsDir: path.join(OUT, "_m88_preflight", short),
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

// One-time COMBINED runtime guard inject seam probe (shared by every case). Identical to M85.
async function probeGuardSeam() {
  const target = await locateClaudePromptFile(VEXP);
  const adapter = target === null ? "" : await Bun.file(target).text().catch(() => "");
  const hookAvailable = target !== null && hasToolLoopGuardHookPatch(adapter);
  let unavailableReason: string | null = null;
  if (target === null) unavailableReason = "claude-code adapter not located under --vexp-swe-bench-dir";
  else if (!hookAvailable) unavailableReason = `M76 combined hook patch (${STAGE5_TOOL_LOOP_GUARD_HOOK_MARKER}) absent from ${target}`;

  let toolLoopSettingsConstructible = false;
  try {
    const cmd = toolLoopGuardHookCommand("node");
    const settings = buildToolLoopGuardHookSettings(cmd);
    toolLoopSettingsConstructible = JSON.stringify(settings).includes("PostToolUse") && cmd.length > 0;
  } catch {
    toolLoopSettingsConstructible = false;
  }
  let costGuardSettingsConstructible = false;
  try {
    const cmd = costGuardHookCommand("node");
    const settings = buildToolLoopGuardHookSettings(cmd);
    costGuardSettingsConstructible =
      JSON.stringify(settings).includes("PostToolUse") && cmd.includes("costGuardHook") && cmd.length > 0;
  } catch {
    costGuardSettingsConstructible = false;
  }
  const c7d = costGuardConfigForCalibration("c7d", { enabled: true });
  const v0 = costGuardConfigForCalibration("v0", { enabled: true });
  const c7dCalibrationCorrect =
    c7d.calibration === "c7d" &&
    c7d.editVerifyChurnThreshold === 2 &&
    v0.editVerifyChurnThreshold === 3 &&
    c7d.minToolCallsBeforeFire === 25 &&
    c7d.minToolCallsBeforeFire === v0.minToolCallsBeforeFire &&
    c7d.highToolCountThreshold === v0.highToolCountThreshold &&
    c7d.costCapFraction === v0.costCapFraction;
  return {
    adapter_file: target,
    runtime_hook_available: hookAvailable,
    runtime_hook_unavailable_reason: unavailableReason,
    combined_hook_available: hookAvailable,
    tool_loop_guard_settings_path: toolLoopGuardHookSettingsFilePath(OUT),
    tool_loop_guard_settings_constructible: toolLoopSettingsConstructible,
    cost_guard_settings_path: costGuardHookSettingsFilePath(OUT),
    cost_guard_settings_constructible: costGuardSettingsConstructible,
    cost_guard_calibration: "c7d" as const,
    cost_guard_calibration_correct: c7dCalibrationCorrect,
    cost_guard_c7d_edit_verify_churn_threshold: c7d.editVerifyChurnThreshold,
    cost_guard_c7d_min_tool_calls_gate: c7d.minToolCallsBeforeFire,
  };
}

const records = await loadSweBenchData(DATASET);
const split = JSON.parse(await Bun.file(SPLIT).text()) as {
  cases: Array<{ instance_id: string; repo: string; difficulty: string; validation_group: string; group?: string }>;
};
let selected = split.cases;
if (ONLY.length) selected = selected.filter((s) => ONLY.includes(s.instance_id));

const seam = await probeGuardSeam();

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
  `[seam] combined_hook_available=${seam.combined_hook_available} ` +
    `tl_settings=${seam.tool_loop_guard_settings_constructible} cost_settings=${seam.cost_guard_settings_constructible} ` +
    `c7d_correct=${seam.cost_guard_calibration_correct} c7d_churn=${seam.cost_guard_c7d_edit_verify_churn_threshold} ` +
    `c7d_gate=${seam.cost_guard_c7d_min_tool_calls_gate}`,
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
  const guardFields = {
    tool_loop_guard_enabled: true,
    tool_loop_guard_mode: "inject",
    tool_loop_guard_calibration: "v4",
    cost_guard_enabled: true,
    cost_guard_mode: "inject",
    cost_guard_calibration: "c7d",
    cost_guard_calibration_correct: seam.cost_guard_calibration_correct,
    cost_guard_c7d_edit_verify_churn_threshold: seam.cost_guard_c7d_edit_verify_churn_threshold,
    cost_guard_c7d_min_tool_calls_gate: seam.cost_guard_c7d_min_tool_calls_gate,
    runtime_hook_available: seam.runtime_hook_available,
    combined_hook_available: seam.combined_hook_available,
    tool_loop_guard_settings_constructible: seam.tool_loop_guard_settings_constructible,
    cost_guard_settings_constructible: seam.cost_guard_settings_constructible,
    // M88 env-guard fields (one-time probe, identical for every case).
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
    difficulty: sel.difficulty,
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
        await rm(path.join(OUT, "_m88_preflight", short), { recursive: true, force: true }).catch(() => {});
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
  // Final M88 status combines treatment validity AND combined-guard inject availability AND a
  // correctly-constructed C7_D calibration AND the env-guard preflight passing.
  let finalStatus = cls.treatment_status;
  let finalReason = cls.treatment_invalid_reason;
  if (finalStatus === "VALID" && !seam.combined_hook_available) {
    finalStatus = "INVALID_GUARD_HOOK";
    finalReason = "m88_combined_hook_unavailable";
  } else if (finalStatus === "VALID" && !seam.cost_guard_settings_constructible) {
    finalStatus = "INVALID_GUARD_HOOK";
    finalReason = "m88_cost_guard_settings_missing";
  } else if (finalStatus === "VALID" && !seam.cost_guard_calibration_correct) {
    finalStatus = "INVALID_GUARD_HOOK";
    finalReason = "m88_cost_guard_calibration_c7d_unavailable";
  } else if (finalStatus === "VALID" && !envGuardPass) {
    finalStatus = "INVALID_ENV_GUARD";
    finalReason = "m88_env_guard_not_pass";
  } else if (finalStatus === "VALID" && !envExpectedPrefixOk) {
    finalStatus = "INVALID_ENV_GUARD";
    finalReason = "m88_expected_prefix_not_verified";
  } else if (finalStatus === "VALID" && !driftCheckEnabled) {
    finalStatus = "INVALID_ENV_GUARD";
    finalReason = "m88_drift_check_missing";
  }
  const merged = { ...base, ...cls, final_status: finalStatus, invalid_reason: finalReason };
  cases.push(merged);
  console.error(
    `[done] ${inst} ${merged.final_status} grp=${merged.validation_group} req=${merged.required_target_count} ` +
      `demoted=${merged.demoted_pivot_count} marker=${merged.no_high_confidence_required_marker} ` +
      `hook=${seam.combined_hook_available} cost=${seam.cost_guard_settings_constructible} env=${envGuardPass} path=${merged.render_path}`,
  );
}

const valid = cases.filter((r) => r.final_status === "VALID");
const byStatus: Record<string, number> = {};
for (const r of cases) byStatus[r.final_status] = (byStatus[r.final_status] ?? 0) + 1;

const MIN_VALID = 20; // M88 gate: stop if fewer than 20 cases valid.
const partialSentinelZero = (byStatus["INVALID_PARTIAL_SENTINEL"] ?? 0) === 0;
const requiredImpactZero = cases.reduce((a, r) => a + (r.required_has_impact ? 1 : 0), 0) === 0;

const summary = {
  milestone: "M88-preflight",
  kind: "no-agent gate-on render pre-flight over the frozen M88 24-case split; combined V4 tool-loop guard + C7_D cost guard (editVerifyChurnThreshold=2) both runtime-inject, PLUS M86 Stage 5 env-isolation guard (read-only prefix probe + drift-check readiness)",
  helper: "run_stage5_m88_preflight.ts",
  split: SPLIT,
  tool_loop_guard_calibration: "v4",
  cost_guard_mode: "inject",
  cost_guard_calibration: "c7d",
  cost_guard_calibration_correct: seam.cost_guard_calibration_correct,
  cost_guard_c7d_edit_verify_churn_threshold: seam.cost_guard_c7d_edit_verify_churn_threshold,
  cost_guard_c7d_min_tool_calls_gate: seam.cost_guard_c7d_min_tool_calls_gate,
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  clone_missing: CLONE_MISSING,
  guard_seam: seam,
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
  tool_loop_guard_inject_configured_all: cases.every((r) => r.tool_loop_guard_mode === "inject" && r.tool_loop_guard_enabled === true),
  tool_loop_guard_calibration_v4_all: cases.every((r) => r.tool_loop_guard_calibration === "v4"),
  cost_guard_inject_configured_all: cases.every((r) => r.cost_guard_mode === "inject" && r.cost_guard_enabled === true),
  cost_guard_calibration_c7d_all: cases.every((r) => r.cost_guard_calibration === "c7d"),
  combined_hook_available_all: cases.every((r) => r.combined_hook_available === true),
  cost_guard_settings_constructible_all: cases.every((r) => r.cost_guard_settings_constructible === true),
  env_guard_pass_all: cases.every((r) => r.stage5_env_guard_status === "pass"),
  invalid_cases: cases
    .filter((r) => r.final_status !== "VALID")
    .map((r) => ({ instance_id: r.instance_id, final_status: r.final_status, invalid_reason: r.invalid_reason })),
  // Gate decision per the M88 protocol (fewer than 20 valid ⇒ STOP).
  gate: {
    min_valid_required: MIN_VALID,
    valid_count: valid.length,
    partial_sentinel_zero: partialSentinelZero,
    required_impact_zero: requiredImpactZero,
    combined_hook_available: seam.combined_hook_available,
    cost_guard_settings_constructible: seam.cost_guard_settings_constructible,
    cost_guard_calibration_correct: seam.cost_guard_calibration_correct,
    tool_loop_guard_settings_constructible: seam.tool_loop_guard_settings_constructible,
    calibration_v4_all: cases.every((r) => r.tool_loop_guard_calibration === "v4"),
    calibration_c7d_all: cases.every((r) => r.cost_guard_calibration === "c7d"),
    env_guard_pass: envGuardPass,
    expected_prefix_ok: envExpectedPrefixOk,
    drift_check_enabled: driftCheckEnabled,
    passes:
      valid.length >= MIN_VALID &&
      partialSentinelZero &&
      requiredImpactZero &&
      seam.combined_hook_available &&
      seam.cost_guard_settings_constructible &&
      seam.cost_guard_calibration_correct &&
      seam.tool_loop_guard_settings_constructible &&
      cases.every((r) => r.tool_loop_guard_calibration === "v4") &&
      cases.every((r) => r.cost_guard_calibration === "c7d") &&
      envGuardPass &&
      envExpectedPrefixOk &&
      driftCheckEnabled,
  },
  cases,
};
await Bun.write(path.join(OUT, "stage5_m88_v4_c7d_envguard_preflight.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "RESULT_JSON: " +
    JSON.stringify({
      total: summary.total,
      valid: summary.valid_count,
      by_status: byStatus,
      combined_hook_available: seam.combined_hook_available,
      cost_guard_calibration_correct: seam.cost_guard_calibration_correct,
      env_guard_pass: envGuardPass,
      env_status: envMeta.stage5_env_guard_status,
      expected_prefix_ok: envExpectedPrefixOk,
      drift_check_enabled: driftCheckEnabled,
      gate_passes: summary.gate.passes,
    }),
);
