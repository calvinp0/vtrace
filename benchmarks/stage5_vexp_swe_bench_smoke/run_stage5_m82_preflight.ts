/**
 * M82 — no-agent pre-flight over the FROZEN M82 split (NO live agents, NO Docker, NO API spend)
 * for the COMBINED V4 tool-loop guard + C7 cost/no-convergence guard in runtime-inject mode.
 *
 * For each selected instance it RE-RENDERS the EXACT M73/M80 structured-bounded + pivot-confidence
 * treatment context offline and classifies validity with the M72/M73 gate-on rules (identical to
 * the M80 preflight), AND verifies BOTH runtime guards are configured and the SINGLE combined
 * PostToolUse hook seam is available in the external adapter (the cost guard reuses the same M76
 * --settings registration point), recording V4 calibration + cost-guard inject configuration.
 *
 * Neither guard affects the rendered context (they only gate the live runtime detector), so the
 * treatment-validity classification is identical to M77/M80; this preflight adds the explicit
 * cost-guard audit fields. Changes NO retrieval / scoring / ranking logic.
 *
 *   bun run_stage5_m82_preflight.ts [--split path] [--dataset path] [--out dir] [--only id,id]
 *     [--no-clone-missing] [--no-cleanup]
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
import { buildPrecheckConfig } from "./run_stage5_live_capsule_precheck.ts";
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
const SPLIT = flag("--split", path.join(RESULTS, "stage5_m82_v4_c7_live_split.json"))!;
const DATASET = flag("--dataset", "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl")!;
const OUT = flag("--out", RESULTS)!;
const VEXP = flag("--vexp-swe-bench-dir", "/home/calvin/code/vexp-swe-bench")!;
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

// Shared classifier over the FINAL injected context (post-truncation). Mirrors M72/M73/M80.
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
    resultsDir: path.join(OUT, "_m82_preflight", short),
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

// One-time COMBINED runtime guard inject seam probe (shared by every case). The cost guard reuses
// the SAME M76 PostToolUse --settings registration point, so a single adapter-patch check covers
// the combined hook; we additionally confirm BOTH guards' --settings files are constructible.
async function probeGuardSeam() {
  const target = await locateClaudePromptFile(VEXP);
  const adapter = target === null ? "" : await Bun.file(target).text().catch(() => "");
  const hookAvailable = target !== null && hasToolLoopGuardHookPatch(adapter);
  let unavailableReason: string | null = null;
  if (target === null) unavailableReason = "claude-code adapter not located under --vexp-swe-bench-dir";
  else if (!hookAvailable) unavailableReason = `M76 combined hook patch (${STAGE5_TOOL_LOOP_GUARD_HOOK_MARKER}) absent from ${target}`;

  // Tool-loop-guard --settings file constructible (V4 inject path when it owns the registration).
  let toolLoopSettingsConstructible = false;
  try {
    const cmd = toolLoopGuardHookCommand("node");
    const settings = buildToolLoopGuardHookSettings(cmd);
    toolLoopSettingsConstructible = JSON.stringify(settings).includes("PostToolUse") && cmd.length > 0;
  } catch {
    toolLoopSettingsConstructible = false;
  }
  // Cost-guard --settings file constructible (the combined hook owns the registration when C7
  // injects; it reuses buildToolLoopGuardHookSettings with the cost-guard hook command).
  let costGuardSettingsConstructible = false;
  try {
    const cmd = costGuardHookCommand("node");
    const settings = buildToolLoopGuardHookSettings(cmd);
    costGuardSettingsConstructible =
      JSON.stringify(settings).includes("PostToolUse") && cmd.includes("costGuardHook") && cmd.length > 0;
  } catch {
    costGuardSettingsConstructible = false;
  }
  return {
    adapter_file: target,
    runtime_hook_available: hookAvailable,
    runtime_hook_unavailable_reason: unavailableReason,
    combined_hook_available: hookAvailable,
    tool_loop_guard_settings_path: toolLoopGuardHookSettingsFilePath(OUT),
    tool_loop_guard_settings_constructible: toolLoopSettingsConstructible,
    cost_guard_settings_path: costGuardHookSettingsFilePath(OUT),
    cost_guard_settings_constructible: costGuardSettingsConstructible,
  };
}

const records = await loadSweBenchData(DATASET);
const split = JSON.parse(await Bun.file(SPLIT).text()) as {
  cases: Array<{ instance_id: string; repo: string; difficulty: string; validation_group: string }>;
};
let selected = split.cases;
if (ONLY.length) selected = selected.filter((s) => ONLY.includes(s.instance_id));

const seam = await probeGuardSeam();
console.error(
  `[seam] combined_hook_available=${seam.combined_hook_available} ` +
    `tl_settings=${seam.tool_loop_guard_settings_constructible} cost_settings=${seam.cost_guard_settings_constructible}`,
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
    runtime_hook_available: seam.runtime_hook_available,
    combined_hook_available: seam.combined_hook_available,
    tool_loop_guard_settings_constructible: seam.tool_loop_guard_settings_constructible,
    cost_guard_settings_constructible: seam.cost_guard_settings_constructible,
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
        await rm(path.join(OUT, "_m82_preflight", short), { recursive: true, force: true }).catch(() => {});
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
  // Final M82 status combines treatment validity AND combined-guard inject availability.
  let finalStatus = cls.treatment_status;
  let finalReason = cls.treatment_invalid_reason;
  if (finalStatus === "VALID" && !seam.combined_hook_available) {
    finalStatus = "INVALID_GUARD_HOOK";
    finalReason = "m82_combined_hook_unavailable";
  } else if (finalStatus === "VALID" && !seam.cost_guard_settings_constructible) {
    finalStatus = "INVALID_GUARD_HOOK";
    finalReason = "m82_cost_guard_settings_missing";
  }
  const merged = { ...base, ...cls, final_status: finalStatus, invalid_reason: finalReason };
  cases.push(merged);
  console.error(
    `[done] ${inst} ${merged.final_status} grp=${merged.validation_group} req=${merged.required_target_count} ` +
      `demoted=${merged.demoted_pivot_count} marker=${merged.no_high_confidence_required_marker} ` +
      `hook=${seam.combined_hook_available} cost=${seam.cost_guard_settings_constructible} path=${merged.render_path}`,
  );
}

const valid = cases.filter((r) => r.final_status === "VALID");
const byStatus: Record<string, number> = {};
for (const r of cases) byStatus[r.final_status] = (byStatus[r.final_status] ?? 0) + 1;

const summary = {
  milestone: "M82-preflight",
  kind: "no-agent gate-on render pre-flight over the frozen M82 split; combined V4 tool-loop guard + C7 cost guard, both runtime-inject (current code)",
  helper: "run_stage5_m82_preflight.ts",
  tool_loop_guard_calibration: "v4",
  cost_guard_mode: "inject",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  clone_missing: CLONE_MISSING,
  guard_seam: seam,
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
  combined_hook_available_all: cases.every((r) => r.combined_hook_available === true),
  cost_guard_settings_constructible_all: cases.every((r) => r.cost_guard_settings_constructible === true),
  invalid_cases: cases
    .filter((r) => r.final_status !== "VALID")
    .map((r) => ({ instance_id: r.instance_id, final_status: r.final_status, invalid_reason: r.invalid_reason })),
  // Gate decision per the M82 protocol.
  gate: {
    min_valid_required: 8,
    valid_count: valid.length,
    partial_sentinel_zero: (byStatus["INVALID_PARTIAL_SENTINEL"] ?? 0) === 0,
    required_impact_zero: cases.reduce((a, r) => a + (r.required_has_impact ? 1 : 0), 0) === 0,
    combined_hook_available: seam.combined_hook_available,
    cost_guard_settings_constructible: seam.cost_guard_settings_constructible,
    tool_loop_guard_settings_constructible: seam.tool_loop_guard_settings_constructible,
    calibration_v4_all: cases.every((r) => r.tool_loop_guard_calibration === "v4"),
    passes:
      valid.length >= 8 &&
      (byStatus["INVALID_PARTIAL_SENTINEL"] ?? 0) === 0 &&
      cases.reduce((a, r) => a + (r.required_has_impact ? 1 : 0), 0) === 0 &&
      seam.combined_hook_available &&
      seam.cost_guard_settings_constructible &&
      seam.tool_loop_guard_settings_constructible &&
      cases.every((r) => r.tool_loop_guard_calibration === "v4"),
  },
  cases,
};
await Bun.write(path.join(OUT, "stage5_m82_v4_c7_preflight.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "RESULT_JSON: " +
    JSON.stringify({
      total: summary.total,
      valid: summary.valid_count,
      by_status: byStatus,
      combined_hook_available: seam.combined_hook_available,
      cost_guard_settings_constructible: seam.cost_guard_settings_constructible,
      gate_passes: summary.gate.passes,
    }),
);
