/**
 * M62 — offline 24-task pre-flight replay (no agents, no Docker, no API spend).
 *
 * Generalises the M61B budget replay (run_stage5_m61b_budget_replay.ts) from the 15 M60
 * workspaces to the full 24-task M55Y set. For each instance it builds the EXACT structured
 * bounded treatment context (--inject-capsule-digest --digest-decision-contract
 * --bounded-digest-decisions --compact-digest-injection), applies the harness's 12,000-char
 * `truncateContextByPriority` step with the M61 atomic sentinel blocks, and classifies the
 * post-truncation injected context as
 *   VALID / FAIL_CLOSED_OMITTED / INVALID_PARTIAL_SENTINEL /
 *   INVALID_STRUCTURED_GRAMMAR / INVALID_IMPACT / OTHER_INVALID.
 *
 * It uses ANY already-persisted workspace index for each instance (the index build is
 * deterministic from repo source at the SWE-bench base commit, unchanged by M56–M59), read
 * from a {instance_id -> workspace_dir} map file. It does NOT clone, rebuild, run agents,
 * or evaluate.
 *
 * Usage:
 *   bun run_stage5_m62_preflight_replay.ts <fixture.json> <ws_map.json> [--out dir] [--dataset path]
 * Writes <out>/stage5_m62_preflight_replay.json and prints a RESULT_JSON line.
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
const NEAR_BUDGET = 10_800;

const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const INSPECT_FIRST = "## VTRACE inspect-first";

const FIXTURE = process.argv[2];
const WSMAP = process.argv[3];
function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}
if (!FIXTURE || !WSMAP) throw new Error("usage: bun run_stage5_m62_preflight_replay.ts <fixture.json> <ws_map.json> [--out dir] [--dataset path]");
const OUT = flag("--out", path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results"));
const DATASET = flag("--dataset", "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl");

const fixture = JSON.parse(await Bun.file(FIXTURE).text());
const wsMap: Record<string, string | null> = JSON.parse(await Bun.file(WSMAP).text());
const records = await loadSweBenchData(DATASET);

function countOcc(h: string, n: string): number {
  return h.split(n).length - 1;
}
function block(t: string, s: string, e: string): string {
  const a = t.indexOf(s), b = t.indexOf(e);
  return a >= 0 && b >= 0 ? t.slice(a, b + e.length) : "";
}

interface CaseOut {
  instance_id: string;
  repo: string;
  category: string;
  workspace: string | null;
  final_status: string;
  invalid_reason: string | null;
  digest_chars: number;
  contract_chars: number;
  digest_plus_contract_chars: number;
  budget_chars: number;
  over_budget_by: number;
  near_budget: boolean;
  required_target_count: number;
  impact_present: boolean;
  structured_grammar_present: boolean;
  compact_mode_applied: boolean;
  partial_sentinel: boolean;
  omission_marker_present: boolean;
  truncation_mode: string;
}

const cases: CaseOut[] = [];

for (const fi of fixture.instances) {
  const inst: string = fi.instance_id;
  const ws = wsMap[inst] ?? null;
  const base: CaseOut = {
    instance_id: inst,
    repo: fi.repo,
    category: fi.category,
    workspace: ws,
    final_status: "OTHER_INVALID",
    invalid_reason: ws ? null : "no_persisted_workspace_index",
    digest_chars: 0,
    contract_chars: 0,
    digest_plus_contract_chars: 0,
    budget_chars: VTRACE_CONTEXT_MAX_CHARS,
    over_budget_by: 0,
    near_budget: false,
    required_target_count: 0,
    impact_present: false,
    structured_grammar_present: false,
    compact_mode_applied: false,
    partial_sentinel: false,
    omission_marker_present: false,
    truncation_mode: "n/a",
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

  const ctx = classify(true);
  const ctxNoCompact = classify(false);
  const truncated = truncateContextByPriority(ctx, VTRACE_CONTEXT_MAX_CHARS, {
    atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS,
  });
  const tctx = truncated.text;

  const digest = block(ctx, DIGEST_START, DIGEST_END);
  const contractBlock = block(ctx, CONTRACT_START, CONTRACT_END);
  const combined = digest.length + contractBlock.length;

  const requiredCount = parseDigestDecisionContract(ctx).targets.length;
  const hasImpact = /→ impact/.test(digest);
  const grammar =
    /target_id/.test(ctx) && /decision:/.test(ctx) && /reason:/.test(ctx) && /files_touched/.test(ctx) &&
    /EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(ctx);
  const compact = countOcc(ctxNoCompact, INSPECT_FIRST) >= 1 && countOcc(ctx, INSPECT_FIRST) === 0;

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
    status = "INVALID_PARTIAL_SENTINEL";
    reason = "start_end_sentinel_mismatch";
  } else if (!postDigestOk || !postContractOk || !postContractPresent) {
    if (omission) { status = "FAIL_CLOSED_OMITTED"; reason = "essential_block_omitted_over_budget"; }
    else { status = "OTHER_INVALID"; reason = "block_absent_no_marker"; }
  } else if (!hasImpact) {
    status = "INVALID_IMPACT"; reason = "impact_missing_or_warning_only";
  } else if (!grammar || !(requiredCount > 0 && requiredCount <= 4)) {
    status = "INVALID_STRUCTURED_GRAMMAR";
    reason = !grammar ? "structured_grammar_absent" : "required_target_count_out_of_bounds";
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
    digest_plus_contract_chars: combined,
    over_budget_by: Math.max(0, combined - VTRACE_CONTEXT_MAX_CHARS),
    near_budget: combined >= NEAR_BUDGET,
    required_target_count: requiredCount,
    impact_present: hasImpact,
    structured_grammar_present: grammar,
    compact_mode_applied: compact,
    partial_sentinel: partial,
    omission_marker_present: omission,
    truncation_mode: truncated.budget.truncationMode,
  });
  console.error(`[done] ${inst} ${status} d=${digest.length} c=${contractBlock.length} sum=${combined}`);
}

const summary = {
  milestone: "M62-preflight",
  budget_chars: VTRACE_CONTEXT_MAX_CHARS,
  near_budget_threshold: NEAR_BUDGET,
  total: cases.length,
  valid: cases.filter((c) => c.final_status === "VALID").length,
  fail_closed_omitted: cases.filter((c) => c.final_status === "FAIL_CLOSED_OMITTED").map((c) => c.instance_id),
  invalid_partial_sentinel: cases.filter((c) => c.final_status === "INVALID_PARTIAL_SENTINEL").map((c) => c.instance_id),
  invalid_structured_grammar: cases.filter((c) => c.final_status === "INVALID_STRUCTURED_GRAMMAR").map((c) => c.instance_id),
  invalid_impact: cases.filter((c) => c.final_status === "INVALID_IMPACT").map((c) => c.instance_id),
  other_invalid: cases.filter((c) => c.final_status === "OTHER_INVALID").map((c) => c.instance_id),
  over_budget: cases.filter((c) => c.over_budget_by > 0).map((c) => c.instance_id),
  near_budget: cases.filter((c) => c.near_budget && c.over_budget_by === 0).map((c) => c.instance_id),
  cases,
};

await Bun.write(path.join(OUT, "stage5_m62_preflight_replay.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("RESULT_JSON: " + JSON.stringify({
  total: summary.total, valid: summary.valid,
  fail_closed: summary.fail_closed_omitted, partial: summary.invalid_partial_sentinel,
  over_budget: summary.over_budget, near_budget: summary.near_budget,
}));
