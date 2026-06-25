/**
 * M72 — no-agent Stage B pre-flight over the FROZEN M70B Stage B membership (NO live agents,
 * NO Docker, NO API spend). For each Stage B instance in stage5_m72_stage_b_fixture.json it
 * RE-RENDERS the EXACT M70/M70B treatment injected context with `--pivot-confidence-gate` ON
 * (current code) and classifies validity with the M69/M70B gate-on rules. Mirrors the M70B
 * preflight render/classify seam exactly (renderReuse / renderClone / classifyFinalContext)
 * so the Stage B gate is reproduced with the live treatment flags before any spend.
 *
 * Render paths (both offline):
 *  - REUSE: persisted vtrace index under results/workspaces/.../<id>/.vtrace/index.sqlite
 *  - CLONE (--clone-missing, default ON here): checkout -> index -> query -> render into a temp
 *    dir, deleted afterward (--cleanup, default ON). NEVER mutates a persisted workspace.
 *
 * Changes NO retrieval / scoring / ranking logic. Output shape is M71-preflight-compatible
 * (top-level summary + `cases[]`) so run_stage5_m72_stage_b_analyze.ts / _report.ts consume it.
 *
 *   bun run_stage5_m72_stage_b_preflight.ts [--fixture path] [--dataset path] [--out dir]
 *     [--no-clone-missing] [--no-cleanup] [--only <id,id>]
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
const FIXTURE = flag("--fixture", path.join(RESULTS, "stage5_m72_stage_b_fixture.json"))!;
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

interface Case {
  instance_id: string;
  repo: string;
  difficulty: string;
  render_path: "reuse" | "clone" | "none";
  final_status: string;
  invalid_reason: string | null;
  context_chars: number;
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

// Shared classifier over the FINAL injected context (post-truncation). Mirrors M70B/M69.
function classifyFinalContext(ctx: string): Partial<Case> & { final_status: string } {
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

function renderReuse(
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

async function renderClone(instanceId: string): Promise<string | null> {
  const short = instanceId.replace(/[^a-zA-Z0-9]+/g, "_");
  const base = buildPrecheckConfig({
    instanceId,
    vexpSweBenchDir: VEXP,
    resultsDir: path.join(OUT, "_m72_preflight", short),
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
  instances: Array<{ instance_id: string; repo: string; difficulty: string }>;
  skipped?: Array<{ instance_id: string; repo: string; matrix_preflight_status: string; reason: string }>;
};
let selected = fixture.instances;
if (ONLY.length) selected = selected.filter((s) => ONLY.includes(s.instance_id));

const wsMap = await buildWorkspaceMap();
const cases: Case[] = [];

for (const sel of selected) {
  const inst = sel.instance_id;
  const ws = wsMap.get(inst) ?? null;
  const base: Case = {
    instance_id: inst,
    repo: sel.repo,
    difficulty: sel.difficulty,
    render_path: "none",
    final_status: "PREFLIGHT_PENDING_INDEX",
    invalid_reason: ws ? null : "no_persisted_index_and_clone_disabled",
    context_chars: 0,
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
    if (!finalCtx) {
      base.final_status = "OTHER_INVALID";
      base.invalid_reason ??= "reuse_render_empty";
      cases.push(base);
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
      cases.push(base);
      console.error(`[fail] ${inst} clone render threw`);
      continue;
    } finally {
      if (CLEANUP) {
        const short = inst.replace(/[^a-zA-Z0-9]+/g, "_");
        await rm(path.join(OUT, "_m72_preflight", short), { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!finalCtx) {
      base.final_status = "OTHER_INVALID";
      base.invalid_reason = "clone_render_empty";
      cases.push(base);
      continue;
    }
  } else {
    cases.push(base);
    console.error(`[pending] ${inst} no persisted index (clone disabled)`);
    continue;
  }

  const cls = classifyFinalContext(finalCtx);
  const merged: Case = { ...base, ...cls } as Case;
  cases.push(merged);
  console.error(
    `[done] ${inst} ${merged.final_status} req=${merged.required_target_count} ` +
      `demoted=${merged.demoted_pivot_count} marker=${merged.no_high_confidence_required_marker} ` +
      `path=${merged.render_path}`,
  );
}

const valid = cases.filter((r) => r.final_status === "VALID");
const byStatus: Record<string, number> = {};
for (const r of cases) byStatus[r.final_status] = (byStatus[r.final_status] ?? 0) + 1;

const summary = {
  milestone: "M72-preflight",
  kind: "no-agent gate-on render pre-flight over the frozen M70B Stage B membership (current code)",
  helper: "run_stage5_m72_stage_b_preflight.ts",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  clone_missing: CLONE_MISSING,
  total: cases.length,
  valid_count: valid.length,
  by_status: byStatus,
  fail_closed_count: byStatus["FAIL_CLOSED_OMITTED"] ?? 0,
  partial_sentinel_count: byStatus["INVALID_PARTIAL_SENTINEL"] ?? 0,
  invalid_structured_count: byStatus["INVALID_STRUCTURED_GRAMMAR"] ?? 0,
  invalid_impact_count: byStatus["INVALID_IMPACT"] ?? 0,
  invalid_confidence_gate_count: byStatus["INVALID_CONFIDENCE_GATE"] ?? 0,
  other_invalid_count: byStatus["OTHER_INVALID"] ?? 0,
  pending_index_count: byStatus["PREFLIGHT_PENDING_INDEX"] ?? 0,
  rendered_count: cases.filter((r) => r.render_path !== "none").length,
  reuse_count: cases.filter((r) => r.render_path === "reuse").length,
  clone_count: cases.filter((r) => r.render_path === "clone").length,
  zero_required_count: cases.filter((r) => r.render_path !== "none" && r.required_target_count === 0).length,
  zero_required_cases: cases.filter((r) => r.render_path !== "none" && r.required_target_count === 0).map((r) => r.instance_id),
  demoted_pivot_count: cases.reduce((a, r) => a + (r.demoted_pivot_count ?? 0), 0),
  required_impact_target_count: cases.reduce((a, r) => a + (r.required_has_impact ? 1 : 0), 0),
  optional_impact_context_missing_count: cases.filter(
    (r) => r.final_status === "VALID" && r.optional_impact_id_count > 0 && !r.optional_section_present,
  ).length,
  invalid_cases: cases.filter((r) => r.final_status !== "VALID").map((r) => ({ instance_id: r.instance_id, final_status: r.final_status, invalid_reason: r.invalid_reason })),
  // Stage B membership skipped pre-flight upstream (matrix OTHER_INVALID); not re-rendered here.
  skipped_from_matrix: fixture.skipped ?? [],
  cases,
};
await Bun.write(path.join(OUT, "stage5_m72_stage_b_preflight.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "RESULT_JSON: " +
    JSON.stringify({
      total: summary.total,
      valid: summary.valid_count,
      rendered: summary.rendered_count,
      reuse: summary.reuse_count,
      clone: summary.clone_count,
      by_status: byStatus,
      zero_required: summary.zero_required_count,
      demoted: summary.demoted_pivot_count,
      required_impact: summary.required_impact_target_count,
      partial_sentinel: summary.partial_sentinel_count,
    }),
);
