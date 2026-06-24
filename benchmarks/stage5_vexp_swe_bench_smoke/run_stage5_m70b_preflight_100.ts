/**
 * M70B — no-agent 100-task pre-flight over the FROZEN M70 census (NO live agents, NO Docker,
 * NO API spend). For each of the 100 selected instances it renders the EXACT M70 treatment
 * injected context INCLUDING `--pivot-confidence-gate` and classifies validity with the M69
 * gate-on rules (VALID / FAIL_CLOSED_OMITTED / INVALID_PARTIAL_SENTINEL /
 * INVALID_STRUCTURED_GRAMMAR / INVALID_IMPACT / INVALID_CONFIDENCE_GATE / OTHER_INVALID, plus
 * PREFLIGHT_PENDING_INDEX for cases with no persisted index when --clone-missing is off).
 *
 * Two render paths, both no-agent / no-Docker:
 *  - REUSE (default, fast, read-only): if a persisted vtrace index exists on disk for the
 *    instance (results/workspaces/.../<instance_id>/.vtrace/index.sqlite), render directly
 *    from it via the M62-replay seam (capsule query + buildStage5DigestEnrichmentsBestEffort +
 *    classifyCapsuleOutput) with the gate on, then apply the 12k atomic truncation. NEVER
 *    mutates the persisted workspace.
 *  - CLONE (opt-in, --clone-missing): for instances with no persisted index, drive the live
 *    render path `prepareIndexedContext` (checkout -> index -> query -> render) into a temp
 *    dir; with --cleanup the temp clone is deleted after the row is captured (M69 precedent).
 *
 * Changes NO retrieval / scoring / ranking logic.
 *
 *   bun run_stage5_m70b_preflight_100.ts [--fixture path] [--dataset path] [--out dir]
 *     [--clone-missing] [--cleanup] [--limit N] [--only <id,id>]
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
const NEAR_BUDGET = 10_800;
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
const FIXTURE = flag(
  "--fixture",
  path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m70_100_task_preregistration.json"),
)!;
const DATASET = flag("--dataset", "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl")!;
const OUT = flag("--out", path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results"))!;
const VEXP = flag("--vexp-swe-bench-dir", "/home/calvin/code/vexp-swe-bench")!;
const CLONE_MISSING = has("--clone-missing");
const CLEANUP = has("--cleanup");
const LIMIT = Number(flag("--limit", "0"));
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

// Build {instance_id -> persisted workspace dir} from any results/workspaces/**/<id>/.vtrace.
async function buildWorkspaceMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const glob = new Glob("**/.vtrace/index.sqlite");
  const found: string[] = [];
  try {
    // `dot: true` is REQUIRED — the index lives under the dot-dir `.vtrace`, which Bun's
    // Glob skips by default.
    for await (const rel of glob.scan({ cwd: WS_ROOT, onlyFiles: true, dot: true })) found.push(rel);
  } catch {
    /* no workspaces dir */
  }
  found.sort(); // deterministic pick
  for (const rel of found) {
    const wsDir = path.join(WS_ROOT, path.dirname(path.dirname(rel))); // strip /.vtrace/index.sqlite
    const inst = path.basename(wsDir);
    if (!map.has(inst)) map.set(inst, wsDir);
  }
  return map;
}

interface Row {
  instance_id: string;
  repo: string;
  difficulty: string;
  in_M62_24: boolean;
  render_path: "reuse" | "clone" | "none";
  workspace: string | null;
  final_status: string;
  invalid_reason: string | null;
  context_chars: number;
  digest_plus_contract_chars: number;
  over_budget_by: number;
  near_budget: boolean;
  digest_present: boolean;
  contract_present: boolean;
  four_sentinel_ok: boolean;
  partial_sentinel: boolean;
  has_impact_row: boolean;
  structured_grammar_present: boolean;
  compact_mode_applied: boolean;
  confidence_gate_enabled: boolean;
  no_high_confidence_required_marker: boolean;
  required_target_count: number;
  required_has_impact: boolean;
  demoted_pivot_count: number;
  optional_impact_id_count: number;
  optional_section_present: boolean;
  optional_not_closure_scored: boolean;
  optional_ids_collide: boolean;
  omission_marker_present: boolean;
}

// Shared classifier over the FINAL injected context (post-truncation). Mirrors M69 gate rules.
function classifyFinalContext(ctx: string): Partial<Row> & { final_status: string } {
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
    final_status: status,
    invalid_reason: reason,
    context_chars: ctx.length,
    digest_plus_contract_chars: digest.length + contractBlock.length,
    digest_present: dS === 1 && dE === 1,
    contract_present: contractPresent,
    four_sentinel_ok: fourSentinelOk,
    partial_sentinel: partial,
    has_impact_row: hasImpactRow,
    structured_grammar_present: grammar,
    compact_mode_applied: compact,
    // The gate is enabled in the render config for every case; a valid zero-required (with
    // marker + demoted pivots) is the gate firing. We record the enable flag honestly.
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

// Read-only reuse render from a persisted index (no clone, no mutation).
function renderReuse(
  instanceId: string,
  ws: string,
  queryText: string,
  mode: ReturnType<typeof capsuleModeForInstance>,
): string | null {
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

// Clone render via the live render path (opt-in). Returns the final injected context.
async function renderClone(instanceId: string): Promise<string | null> {
  const short = instanceId.replace(/[^a-zA-Z0-9]+/g, "_");
  const base = buildPrecheckConfig({
    instanceId,
    vexpSweBenchDir: VEXP,
    resultsDir: path.join(OUT, "_m70b_preflight", short),
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

const records = await loadSweBenchData(DATASET);
const fixture = JSON.parse(await Bun.file(FIXTURE).text()) as {
  instances: Array<{ instance_id: string; repo: string; difficulty: string; in_M62_24: boolean }>;
};
let selected = fixture.instances;
if (ONLY.length) selected = selected.filter((s) => ONLY.includes(s.instance_id));
if (LIMIT > 0) selected = selected.slice(0, LIMIT);

const wsMap = await buildWorkspaceMap();
const rows: Row[] = [];

for (const sel of selected) {
  const inst = sel.instance_id;
  const ws = wsMap.get(inst) ?? null;
  const base: Row = {
    instance_id: inst,
    repo: sel.repo,
    difficulty: sel.difficulty,
    in_M62_24: sel.in_M62_24,
    render_path: "none",
    workspace: ws,
    final_status: "PREFLIGHT_PENDING_INDEX",
    invalid_reason: ws ? null : "no_persisted_index_and_clone_disabled",
    context_chars: 0,
    digest_plus_contract_chars: 0,
    over_budget_by: 0,
    near_budget: false,
    digest_present: false,
    contract_present: false,
    four_sentinel_ok: false,
    partial_sentinel: false,
    has_impact_row: false,
    structured_grammar_present: false,
    compact_mode_applied: false,
    confidence_gate_enabled: false,
    no_high_confidence_required_marker: false,
    required_target_count: 0,
    required_has_impact: false,
    demoted_pivot_count: 0,
    optional_impact_id_count: 0,
    optional_section_present: false,
    optional_not_closure_scored: false,
    optional_ids_collide: false,
    omission_marker_present: false,
  };

  const record = findSweBenchRecord(records, inst);
  if (record === null) {
    base.final_status = "OTHER_INVALID";
    base.invalid_reason = "not_in_dataset";
    rows.push(base);
    continue;
  }
  const instance = toSweBenchInstance(record);
  const queryText = buildCapsuleV2Task(instance);
  const mode = capsuleModeForInstance(instance);

  let finalCtx: string | null = null;
  if (ws) {
    base.render_path = "reuse";
    try {
      finalCtx = renderReuse(inst, ws, queryText, mode);
    } catch (err) {
      base.invalid_reason = `reuse_render_threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!finalCtx) {
      base.final_status = "OTHER_INVALID";
      base.invalid_reason ??= "reuse_render_empty";
      rows.push(base);
      console.error(`[fail] ${inst} reuse render empty`);
      continue;
    }
  } else if (CLONE_MISSING) {
    base.render_path = "clone";
    try {
      finalCtx = await renderClone(inst);
    } catch (err) {
      base.final_status = "OTHER_INVALID";
      base.invalid_reason = `clone_render_threw: ${err instanceof Error ? err.message : String(err)}`;
      rows.push(base);
      console.error(`[fail] ${inst} clone render threw`);
      continue;
    } finally {
      if (CLEANUP) {
        const short = inst.replace(/[^a-zA-Z0-9]+/g, "_");
        await rm(path.join(OUT, "_m70b_preflight", short), { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!finalCtx) {
      base.final_status = "OTHER_INVALID";
      base.invalid_reason = "clone_render_empty";
      rows.push(base);
      continue;
    }
  } else {
    // No persisted index and cloning disabled — honest pending status.
    rows.push(base);
    console.error(`[pending] ${inst} no persisted index (clone disabled)`);
    continue;
  }

  const cls = classifyFinalContext(finalCtx);
  const merged: Row = {
    ...base,
    ...cls,
    over_budget_by: Math.max(0, (cls.digest_plus_contract_chars ?? 0) - VTRACE_CONTEXT_MAX_CHARS),
    near_budget: (cls.digest_plus_contract_chars ?? 0) >= NEAR_BUDGET,
  } as Row;
  rows.push(merged);
  console.error(
    `[done] ${inst} ${merged.final_status} req=${merged.required_target_count} ` +
      `demoted=${merged.demoted_pivot_count} marker=${merged.no_high_confidence_required_marker} ` +
      `path=${merged.render_path}`,
  );
}

const valid = rows.filter((r) => r.final_status === "VALID");
const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[r.final_status] = (byStatus[r.final_status] ?? 0) + 1;

const summary = {
  milestone: "M70B-preflight",
  kind: "no-agent gate-on render pre-flight over the frozen M70 100-task census",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  clone_missing: CLONE_MISSING,
  total: rows.length,
  valid_count: valid.length,
  fail_closed_count: byStatus["FAIL_CLOSED_OMITTED"] ?? 0,
  partial_sentinel_count: byStatus["INVALID_PARTIAL_SENTINEL"] ?? 0,
  invalid_structured_count: byStatus["INVALID_STRUCTURED_GRAMMAR"] ?? 0,
  invalid_impact_count: byStatus["INVALID_IMPACT"] ?? 0,
  invalid_confidence_gate_count: byStatus["INVALID_CONFIDENCE_GATE"] ?? 0,
  other_invalid_count: byStatus["OTHER_INVALID"] ?? 0,
  pending_index_count: byStatus["PREFLIGHT_PENDING_INDEX"] ?? 0,
  rendered_count: rows.filter((r) => r.render_path !== "none").length,
  reuse_count: rows.filter((r) => r.render_path === "reuse").length,
  clone_count: rows.filter((r) => r.render_path === "clone").length,
  zero_required_count: rows.filter((r) => r.render_path !== "none" && r.required_target_count === 0).length,
  zero_required_cases: rows.filter((r) => r.render_path !== "none" && r.required_target_count === 0).map((r) => r.instance_id),
  demoted_pivot_count: rows.reduce((a, r) => a + (r.demoted_pivot_count ?? 0), 0),
  required_impact_target_count: rows.reduce((a, r) => a + (r.required_has_impact ? 1 : 0), 0),
  optional_impact_context_missing_count: rows.filter(
    (r) => r.final_status === "VALID" && r.optional_impact_id_count > 0 && !r.optional_section_present,
  ).length,
  by_status: byStatus,
  rows,
};
await Bun.write(path.join(OUT, "stage5_m70b_preflight.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "RESULT_JSON: " +
    JSON.stringify({
      total: summary.total,
      valid: summary.valid_count,
      rendered: summary.rendered_count,
      pending: summary.pending_index_count,
      by_status: byStatus,
      zero_required: summary.zero_required_count,
      demoted: summary.demoted_pivot_count,
      required_impact: summary.required_impact_target_count,
    }),
);
