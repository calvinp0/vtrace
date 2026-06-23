/**
 * M68B — non-agent pre-flight for the post-M68 pivot-confidence gate on the 5 selected
 * cases. NO live agents, NO Docker, NO API spend. For each case it drives the REAL live
 * render path (`prepareIndexedContext`: checkout -> vtrace index -> deterministic
 * `capsule` query -> render) with the FULL treatment flag set INCLUDING
 * `--pivot-confidence-gate`, reads the rendered injected context, and classifies validity
 * exactly like the M62/M66 pre-flights (VALID / FAIL_CLOSED_OMITTED /
 * INVALID_PARTIAL_SENTINEL / INVALID_STRUCTURED_GRAMMAR / INVALID_OPTIONAL_IMPACT /
 * OTHER_INVALID) plus the M68 gate extras (zero-required marker, demoted pivots, O/T id
 * separation, no required IMPACT). It changes NO retrieval / scoring / ranking logic.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m68b_preflight.ts \
 *     --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench [--out dir]
 */
import path from "node:path";
import { prepareIndexedContext, type CliConfig } from "./run_stage5_vexp_swe_bench_smoke.ts";
import { buildPrecheckConfig } from "./run_stage5_live_capsule_precheck.ts";
import {
  parseDigestDecisionContract,
  NO_HIGH_CONFIDENCE_REQUIRED_MARKER,
} from "../../src/capsuleV2/digestDecisionContract.ts";
import { STRUCTURED_CONTRACT_OMITTED_MARKER } from "../../src/capsuleV2/sectionBudgetAccounting.ts";

const ROOT = "/home/calvin/code/vtrace";
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
const VEXP = flag("--vexp-swe-bench-dir", "/home/calvin/code/vexp-swe-bench")!;
const OUT = flag("--out", path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results"))!;

// The 5 selected cases (canonical SWE-bench instance ids). requests is psf__requests-5414.
const SELECTED = [
  { instance_id: "django__django-11740", expect: "zero_required" },
  { instance_id: "sympy__sympy-12419", expect: "zero_required" },
  { instance_id: "matplotlib__matplotlib-24627", expect: "required_kept" },
  { instance_id: "astropy__astropy-14365", expect: "required_kept_demote_collateral" },
  { instance_id: "psf__requests-5414", expect: "required_kept" },
];

function countOcc(h: string, n: string): number {
  return h.split(n).length - 1;
}
function block(t: string, s: string, e: string): string {
  const a = t.indexOf(s);
  const b = t.indexOf(e);
  return a >= 0 && b >= 0 ? t.slice(a, b + e.length) : "";
}

function buildConfig(instanceId: string): CliConfig {
  const short = instanceId.replace(/[^a-zA-Z0-9]+/g, "_");
  const base = buildPrecheckConfig({
    instanceId,
    vexpSweBenchDir: VEXP,
    resultsDir: path.join(OUT, "_m68b_preflight", short),
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
    reuseWorkspace: false,
  });
  return {
    ...base,
    injectCapsuleDigest: true,
    digestDecisionContract: true,
    compactDigestInjection: true,
    boundedDigestDecisions: true,
    pivotConfidenceGate: true,
  };
}

const cases: Record<string, unknown>[] = [];

for (const sel of SELECTED) {
  const inst = sel.instance_id;
  const base: Record<string, unknown> = {
    instance_id: inst,
    expectation: sel.expect,
    final_status: "OTHER_INVALID",
    invalid_reason: "not_run",
  };
  let result;
  try {
    result = await prepareIndexedContext(buildConfig(inst), {});
  } catch (err) {
    base.invalid_reason = `prepare_threw: ${err instanceof Error ? err.message : String(err)}`;
    cases.push(base);
    console.error(`[fail] ${inst}: ${base.invalid_reason}`);
    continue;
  }
  if (!result.contextFile) {
    base.invalid_reason = "no_context_file";
    cases.push(base);
    console.error(`[fail] ${inst}: no context file`);
    continue;
  }
  let ctx = "";
  try {
    ctx = await Bun.file(result.contextFile).text();
  } catch {
    base.invalid_reason = "context_file_unreadable";
    cases.push(base);
    continue;
  }

  const digest = block(ctx, DIGEST_START, DIGEST_END);
  const contractBlock = block(ctx, CONTRACT_START, CONTRACT_END);

  // Sentinel accounting on the FINAL injected (post-truncation) context.
  const dS = countOcc(ctx, DIGEST_START);
  const dE = countOcc(ctx, DIGEST_END);
  const cS = countOcc(ctx, CONTRACT_START);
  const cE = countOcc(ctx, CONTRACT_END);
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
  const demotedPivots = optionalLines.filter((o) => o.body.includes(DEMOTED_SUFFIX)).map((o) => `${o.id} ${o.body}`);
  const impactReps = optionalLines.filter((o) => o.body.includes("additional dependent/caller")).map((o) => o.id);
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

  // The lead pivot the live capsule actually selected (for the report's localization col).
  const leadPivot = result.capsuleTopPivotFile;

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
    status = "INVALID_OPTIONAL_IMPACT";
    reason = "impact_rep_still_required";
  } else if (idsCollide) {
    status = "INVALID_OPTIONAL_IMPACT";
    reason = "optional_ids_collide_with_required_ids";
  } else if (optionalSectionPresent && !notClosureScored) {
    status = "INVALID_OPTIONAL_IMPACT";
    reason = "optional_context_not_marked_uncored";
  } else if (!compact) {
    status = "OTHER_INVALID";
    reason = "compact_mode_not_applied";
  } else if (requiredCount === 0) {
    // Zero-required is valid ONLY with the explicit marker.
    if (!noHighConfMarker) {
      status = "OTHER_INVALID";
      reason = "zero_required_without_marker";
    } else if (demotedPivots.length === 0) {
      status = "OTHER_INVALID";
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

  const row = {
    ...base,
    final_status: status,
    invalid_reason: reason,
    lead_pivot: leadPivot,
    capsule_actual_mode: result.capsuleActualMode,
    context_chars: ctx.length,
    context_truncated: result.contextTruncated,
    digest_present: dS === 1 && dE === 1,
    contract_present: contractPresent,
    four_sentinel_ok: fourSentinelOk,
    has_impact_row: hasImpactRow,
    structured_grammar_present: grammar,
    compact_mode_applied: compact,
    no_high_confidence_required_marker: noHighConfMarker,
    required_target_count: requiredCount,
    required_target_ids: requiredIds,
    required_targets: parsed.targets.map((t) => `${t.kind} ${t.target}`),
    required_has_impact: requiredHasImpact,
    demoted_pivot_count: demotedPivots.length,
    demoted_pivots: demotedPivots,
    optional_impact_id_count: impactReps.length,
    optional_section_present: optionalSectionPresent,
    optional_not_closure_scored: notClosureScored,
    optional_ids: optionalIds,
    optional_ids_collide: idsCollide,
    partial_sentinel: partial,
    omission_marker_present: omission,
  };
  cases.push(row);
  console.error(
    `[done] ${inst} ${status} req=${requiredCount}[${requiredIds.join(",")}] ` +
      `demoted=${demotedPivots.length} optImpact=${impactReps.length} marker=${noHighConfMarker} lead=${leadPivot}`,
  );
}

const valid = cases.filter((c) => c.final_status === "VALID");
const summary = {
  milestone: "M68B-preflight",
  kind: "non-agent gate-on render pre-flight (prepareIndexedContext)",
  live_agents: false,
  docker: false,
  retrieval_changed: false,
  total: cases.length,
  valid: valid.length,
  zero_required_cases: cases.filter((c) => c.required_target_count === 0).map((c) => c.instance_id),
  required_impact_any: cases.some((c) => c.required_has_impact === true),
  invalid_partial_sentinel: cases.filter((c) => c.final_status === "INVALID_PARTIAL_SENTINEL").map((c) => c.instance_id),
  cases,
};
await Bun.write(path.join(OUT, "stage5_m68b_preflight.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "RESULT_JSON: " +
    JSON.stringify({
      total: summary.total,
      valid: summary.valid,
      zero_required: summary.zero_required_cases,
      partial: summary.invalid_partial_sentinel,
      required_impact_any: summary.required_impact_any,
    }),
);
