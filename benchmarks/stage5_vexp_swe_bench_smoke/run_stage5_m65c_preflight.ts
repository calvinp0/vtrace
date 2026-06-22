/**
 * M65C — offline pre-flight gate for the 2 selected live-variance-replication cases
 * (no agents, no Docker, no API spend). This is a thin restriction of the validated
 * M65B pre-flight (run_stage5_m65b_preflight.ts) to the two M65C cases:
 *   - matplotlib__matplotlib-24627 (treatment-only win, M65B flip)
 *   - mwaskom__seaborn-3187        (known stability case)
 *
 * It reuses the EXACT same classification logic as M65B so the gate is evaluated
 * identically: it builds the post-M65 structured-bounded treatment context
 * (--inject-capsule-digest --digest-decision-contract --bounded-digest-decisions
 * --compact-digest-injection) from a persisted workspace index, applies the harness's
 * atomic truncation, and classifies VALID / FAIL_CLOSED_OMITTED /
 * INVALID_PARTIAL_SENTINEL / INVALID_STRUCTURED_GRAMMAR / INVALID_IMPACT /
 * INVALID_OPTIONAL_IMPACT / OTHER_INVALID.
 *
 * Usage: bun run_stage5_m65c_preflight.ts <ws_map.json> [--out dir] [--dataset path]
 */
import path from "node:path";
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
  type CliConfig,
} from "./run_stage5_vexp_swe_bench_smoke.ts";
import { parseDigestDecisionContract } from "../../src/capsuleV2/digestDecisionContract.ts";
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

// The 2 selected M65C cases (frozen-fixture instance ids) + selection reason.
const SELECTED: Array<{ instance_id: string; repo: string; category: string; selection_reason: string }> = [
  { instance_id: "matplotlib__matplotlib-24627", repo: "matplotlib/matplotlib", category: "A", selection_reason: "M62C treatment-only win, M65B fail; test optional-impact demotion vs live variance" },
  { instance_id: "mwaskom__seaborn-3187", repo: "mwaskom/seaborn", category: "A", selection_reason: "known unstable/stability-sensitive case from M64/M65B lineage" },
];

const WSMAP = process.argv[2];
function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
if (!WSMAP) throw new Error("usage: bun run_stage5_m65c_preflight.ts <ws_map.json> [--out dir] [--dataset path]");
const OUT = flag("--out", path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results"));
const DATASET = flag("--dataset", "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl");

const wsMap: Record<string, string | null> = JSON.parse(await Bun.file(WSMAP).text());
const records = await loadSweBenchData(DATASET);

function countOcc(h: string, n: string): number {
  return h.split(n).length - 1;
}
function block(t: string, s: string, e: string): string {
  const a = t.indexOf(s), b = t.indexOf(e);
  return a >= 0 && b >= 0 ? t.slice(a, b + e.length) : "";
}

const cases: Record<string, unknown>[] = [];

for (const fi of SELECTED) {
  const inst = fi.instance_id;
  const ws = wsMap[inst] ?? null;
  const base: Record<string, unknown> = {
    instance_id: inst,
    repo: fi.repo,
    category: fi.category,
    selection_reason: fi.selection_reason,
    workspace: ws,
    final_status: "OTHER_INVALID",
    invalid_reason: ws ? null : "no_persisted_workspace_index",
  };
  if (!ws) {
    cases.push(base);
    console.error(`[skip] ${inst}: no workspace`);
    continue;
  }
  const record = findSweBenchRecord(records, inst);
  if (record === null) {
    base.invalid_reason = "not_in_dataset";
    cases.push(base);
    continue;
  }
  const instance = toSweBenchInstance(record);
  const queryText = buildCapsuleV2Task(instance);
  const config = {
    vtraceCommand: "bun src/cli/index.ts",
    vtraceQueryArgs: "",
    capsuleEngine: "v2",
    capsuleIntent: "debug",
    capsuleBudget: 8000,
    injectCapsuleDigest: true,
  } as unknown as CliConfig;

  const spec = buildVtraceQueryCommand(config, ws, queryText, capsuleModeForInstance(instance));
  const proc = Bun.spawnSync([spec.command, ...spec.args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    base.invalid_reason = `vtrace_query_failed_exit_${proc.exitCode}`;
    cases.push(base);
    console.error(`[fail] ${inst}: query exit ${proc.exitCode}`);
    continue;
  }
  const stdout = new TextDecoder().decode(proc.stdout);
  const provider = (parsed: Parameters<typeof buildStage5DigestEnrichmentsBestEffort>[0]["result"]) =>
    buildStage5DigestEnrichmentsBestEffort({
      dbPath: path.join(ws, ".vtrace", "index.sqlite"),
      repoRoot: ws,
      query: queryText,
      result: parsed,
      intent: config.capsuleIntent,
    });
  const classify = (compact: boolean) =>
    classifyCapsuleOutput(stdout, {
      injectDigest: true,
      query: queryText,
      digestEnrichmentProvider: provider,
      digestDecisionContract: true,
      boundedDigestDecisions: true,
      compactDigestInjection: compact,
    }).context ?? "";

  let parsedResult: unknown = null;
  try {
    parsedResult = JSON.parse(stdout);
  } catch {
    const last = stdout.trim().split("\n").pop();
    parsedResult = last ? JSON.parse(last) : null;
  }
  const seamAny = buildStage5DigestEnrichmentsBestEffort({
    dbPath: path.join(ws, ".vtrace", "index.sqlite"),
    repoRoot: ws,
    query: queryText,
    result: parsedResult as Parameters<typeof buildStage5DigestEnrichmentsBestEffort>[0]["result"],
    intent: config.capsuleIntent,
  }) as unknown as { impact?: { representative?: Array<{ path?: string }> }; representative?: Array<{ path?: string }> };
  const seamImpact = seamAny?.impact ?? seamAny;
  const repPaths = (seamImpact?.representative ?? []).map((r) => r.path ?? "").filter(Boolean);

  const ctx = classify(true);
  const ctxNoCompact = classify(false);
  const truncated = truncateContextByPriority(ctx, VTRACE_CONTEXT_MAX_CHARS, {
    atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS,
  });
  const tctx = truncated.text;

  const digest = block(ctx, DIGEST_START, DIGEST_END);
  const contractBlock = block(ctx, CONTRACT_START, CONTRACT_END);

  const requiredCount = parseDigestDecisionContract(ctx).targets.length;
  const hasImpact = /→ impact/.test(digest);
  const grammar =
    /target_id/.test(ctx) && /decision:/.test(ctx) && /reason:/.test(ctx) && /files_touched/.test(ctx) &&
    /EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(ctx);
  const compact = countOcc(ctxNoCompact, INSPECT_FIRST) >= 1 && countOcc(ctx, INSPECT_FIRST) === 0;

  const requiredIds = [...contractBlock.matchAll(/target_id: (T\d+)/g)].map((m) => m[1]!);
  const optionalIds = [...contractBlock.matchAll(/^- (O\d+):/gm)].map((m) => m[1]!);
  const optionalSectionPresent = /Optional context \/ FYI impact references/.test(contractBlock);
  const notClosureScored = /not closure-scored/i.test(contractBlock);
  const optionalImpactPresent = optionalSectionPresent && optionalIds.length > 0;
  const idsCollide = optionalIds.some((id) => requiredIds.includes(id)) ||
    requiredIds.some((id) => /^O/.test(id)) || optionalIds.some((id) => /^T/.test(id));
  const parsedTargets = parseDigestDecisionContract(ctx).targets;
  const requiredHasImpact = parsedTargets.some((t) => t.kind === "IMPACT");

  const basename = (p: string): string => p.split("/").pop() ?? p;
  const pivotPaths = parsedTargets.map((t) => t.path);
  const samePathAsPivot = (rp: string): boolean =>
    pivotPaths.some((pp) => pp === rp || pp.endsWith(`/${rp}`) || rp.endsWith(`/${pp}`) || basename(pp) === basename(rp));
  const crossFileRepCount = repPaths.filter((rp) => !samePathAsPivot(rp)).length;
  const impactRepsExist = crossFileRepCount > 0;

  const dS = countOcc(tctx, DIGEST_START), dE = countOcc(tctx, DIGEST_END);
  const cS = countOcc(tctx, CONTRACT_START), cE = countOcc(tctx, CONTRACT_END);
  const partial = dS !== dE || cS !== cE;
  const postDigestOk = dS === 1 && dE === 1;
  const postContractOk = cS === 1 && cE === 1;
  const postContractPresent = parseDigestDecisionContract(tctx).present;
  const omission = tctx.includes(STRUCTURED_CONTRACT_OMITTED_MARKER);

  let status: string;
  let reason: string | null = null;
  if (partial) {
    status = "INVALID_PARTIAL_SENTINEL"; reason = "start_end_sentinel_mismatch";
  } else if (!postDigestOk || !postContractOk || !postContractPresent) {
    if (omission) { status = "FAIL_CLOSED_OMITTED"; reason = "essential_block_omitted_over_budget"; }
    else { status = "OTHER_INVALID"; reason = "block_absent_no_marker"; }
  } else if (!hasImpact) {
    status = "INVALID_IMPACT"; reason = "impact_missing_or_warning_only";
  } else if (!grammar || !(requiredCount > 0 && requiredCount <= 4)) {
    status = "INVALID_STRUCTURED_GRAMMAR";
    reason = !grammar ? "structured_grammar_absent" : "required_target_count_out_of_bounds";
  } else if (requiredHasImpact) {
    status = "INVALID_OPTIONAL_IMPACT"; reason = "impact_rep_still_required";
  } else if (impactRepsExist && !optionalImpactPresent) {
    status = "INVALID_OPTIONAL_IMPACT"; reason = "optional_impact_context_missing";
  } else if (optionalImpactPresent && !notClosureScored) {
    status = "INVALID_OPTIONAL_IMPACT"; reason = "optional_context_not_marked_uncored";
  } else if (idsCollide) {
    status = "INVALID_OPTIONAL_IMPACT"; reason = "optional_ids_collide_with_required_ids";
  } else if (!compact) {
    status = "OTHER_INVALID"; reason = "compact_mode_not_applied";
  } else {
    status = "VALID";
  }

  cases.push({
    ...base,
    final_status: status,
    invalid_reason: reason,
    digest_chars: digest.length,
    contract_chars: contractBlock.length,
    required_target_count: requiredCount,
    required_target_ids: requiredIds,
    required_has_impact: requiredHasImpact,
    impact_present: hasImpact,
    impact_representative_paths: repPaths,
    cross_file_impact_rep_count: crossFileRepCount,
    impact_reps_exist: impactRepsExist,
    structured_grammar_present: grammar,
    compact_mode_applied: compact,
    optional_section_present: optionalSectionPresent,
    optional_impact_id_count: optionalIds.length,
    optional_ids: optionalIds,
    optional_not_closure_scored: notClosureScored,
    optional_ids_collide: idsCollide,
    partial_sentinel: partial,
    omission_marker_present: omission,
    truncation_mode: truncated.budget.truncationMode,
  });
  console.error(
    `[done] ${inst} ${status} req=${requiredCount}[${requiredIds.join(",")}] opt=${optionalIds.length}[${optionalIds.join(",")}] impactReps=${impactRepsExist}`,
  );
}

const valid = cases.filter((c) => c.final_status === "VALID");
const summary = {
  milestone: "M65C-preflight",
  budget_chars: VTRACE_CONTEXT_MAX_CHARS,
  total: cases.length,
  valid: valid.length,
  fail_closed_omitted: cases.filter((c) => c.final_status === "FAIL_CLOSED_OMITTED").map((c) => c.instance_id),
  invalid_partial_sentinel: cases.filter((c) => c.final_status === "INVALID_PARTIAL_SENTINEL").map((c) => c.instance_id),
  invalid_structured_grammar: cases.filter((c) => c.final_status === "INVALID_STRUCTURED_GRAMMAR").map((c) => c.instance_id),
  invalid_impact: cases.filter((c) => c.final_status === "INVALID_IMPACT").map((c) => c.instance_id),
  invalid_optional_impact: cases.filter((c) => c.final_status === "INVALID_OPTIONAL_IMPACT").map((c) => c.instance_id),
  other_invalid: cases.filter((c) => c.final_status === "OTHER_INVALID").map((c) => c.instance_id),
  cases,
};

await Bun.write(path.join(OUT, "stage5_m65c_preflight.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("RESULT_JSON: " + JSON.stringify({
  total: summary.total, valid: summary.valid,
  partial: summary.invalid_partial_sentinel,
  optional_invalid: summary.invalid_optional_impact,
  fail_closed: summary.fail_closed_omitted,
}));
