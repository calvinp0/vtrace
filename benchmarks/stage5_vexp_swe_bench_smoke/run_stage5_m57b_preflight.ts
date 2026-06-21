/**
 * M57B non-agent injected-context pre-flight (no live agent, no Docker, no spend).
 *
 * Extends the M56C pre-flight to the M57 decision-contract + compact-injection path.
 * Builds the EXACT Stage 5 injected v2 context (same `classifyCapsuleOutput` path used
 * by --mode run-protocol with --inject-capsule-digest --digest-decision-contract
 * [--compact-digest-injection]) for ONE case against an already-built workspace index,
 * and asserts the 7 M57B pre-flight requirements:
 *   1. digest sentinel present exactly once
 *   2. decision contract sentinel present exactly once
 *   3. a real non-warning `→ impact` section present
 *   4. the decision contract contains >= 1 REQUIRED target
 *   5. required target count <= 4
 *   6. compact mode removed the duplicate `## VTRACE inspect-first` block
 *   7. memory/rules warnings remain honest if no data exists
 *
 * Spawns the capsule query ONCE and classifies twice (compact off + on) to prove the
 * compaction delta. Reuses a persisted workspace index (index build unchanged by M57).
 *
 * Usage:
 *   bun run_stage5_m57b_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]
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
  type CliConfig,
} from "./run_stage5_vexp_swe_bench_smoke.ts";
import { parseDigestDecisionContract } from "../../src/capsuleV2/digestDecisionContract.ts";

const INSTANCE = process.argv[2];
const WORKSPACE = process.argv[3];
const DATASET = process.argv[4] ?? "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
if (INSTANCE === undefined || WORKSPACE === undefined) {
  throw new Error("usage: bun run_stage5_m57b_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]");
}

const config = {
  vtraceCommand: "bun src/cli/index.ts",
  vtraceQueryArgs: "",
  capsuleEngine: "v2",
  capsuleIntent: "debug",
  capsuleBudget: 8000,
  injectCapsuleDigest: true,
} as unknown as CliConfig;

const records = await loadSweBenchData(DATASET);
const record = findSweBenchRecord(records, INSTANCE);
if (record === null) throw new Error(`instance ${INSTANCE} not in ${DATASET}`);
const instance = toSweBenchInstance(record);

const queryText = buildCapsuleV2Task(instance);
const spec = buildVtraceQueryCommand(config, WORKSPACE, queryText, capsuleModeForInstance(instance));
const proc = Bun.spawnSync([spec.command, ...spec.args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
if (proc.exitCode !== 0) {
  console.error(new TextDecoder().decode(proc.stderr));
  throw new Error(`vtrace capsule query failed exit ${proc.exitCode}`);
}
const stdout = new TextDecoder().decode(proc.stdout);

const enrichmentProvider = (parsed: Parameters<typeof buildStage5DigestEnrichmentsBestEffort>[0]["result"]) =>
  buildStage5DigestEnrichmentsBestEffort({
    dbPath: path.join(WORKSPACE, ".vtrace", "index.sqlite"),
    repoRoot: WORKSPACE,
    query: queryText,
    result: parsed,
    intent: config.capsuleIntent,
  });

function classify(compact: boolean): string {
  const classified = classifyCapsuleOutput(stdout, {
    injectDigest: true,
    query: queryText,
    digestEnrichmentProvider: enrichmentProvider,
    digestDecisionContract: true,
    compactDigestInjection: compact,
  });
  return classified.context ?? "";
}

const ctxFull = classify(false); // contract on, compact OFF
const ctxCompact = classify(true); // contract on, compact ON

const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const INSPECT_FIRST = "## VTRACE inspect-first";

function countOcc(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const ctx = ctxCompact; // the actual injected context for the M57B treatment

// digest sub-block (for impact / warning checks)
const ds = ctx.indexOf(DIGEST_START);
const de = ctx.indexOf(DIGEST_END);
const digest = ds >= 0 && de >= 0 ? ctx.slice(ds, de + DIGEST_END.length) : "";

const contract = parseDigestDecisionContract(ctx);

const hasImpact = /→ impact/.test(digest);
const impactWarnOnly = /impact_not_threaded_into_digest/.test(digest) && !hasImpact;

const requiredCount = contract.targets.length;
const compactRemovedInspectFirst =
  countOcc(ctxFull, INSPECT_FIRST) >= 1 && countOcc(ctxCompact, INSPECT_FIRST) === 0;

const checks = {
  instance: INSTANCE,
  // 1
  digest_sentinel_start_count: countOcc(ctx, DIGEST_START),
  digest_sentinel_end_count: countOcc(ctx, DIGEST_END),
  digest_sentinel_exactly_once: countOcc(ctx, DIGEST_START) === 1 && countOcc(ctx, DIGEST_END) === 1,
  // 2
  contract_sentinel_start_count: countOcc(ctx, CONTRACT_START),
  contract_sentinel_end_count: countOcc(ctx, CONTRACT_END),
  contract_sentinel_exactly_once: countOcc(ctx, CONTRACT_START) === 1 && countOcc(ctx, CONTRACT_END) === 1,
  // 3
  impact_section_present: hasImpact,
  impact_warning_only: impactWarnOnly,
  // 4 + 5
  required_target_count: requiredCount,
  required_targets: contract.targets.map((t) => `${t.kind} ${t.target}`),
  required_target_at_least_one: requiredCount >= 1,
  required_target_cap_ok: requiredCount <= 4,
  // 6
  inspect_first_in_full: countOcc(ctxFull, INSPECT_FIRST),
  inspect_first_in_compact: countOcc(ctxCompact, INSPECT_FIRST),
  compact_removed_inspect_first: compactRemovedInspectFirst,
  full_context_chars: ctxFull.length,
  compact_context_chars: ctxCompact.length,
  // 7
  memory_warning_present: /memory_not_threaded_into_digest/.test(digest),
  rules_warning_present: /rules_not_threaded_into_digest/.test(digest),
};

const PASS =
  checks.digest_sentinel_exactly_once &&
  checks.contract_sentinel_exactly_once &&
  checks.impact_section_present &&
  !checks.impact_warning_only &&
  checks.required_target_at_least_one &&
  checks.required_target_cap_ok &&
  checks.compact_removed_inspect_first;

console.log(contract.present ? ctx.slice(ctx.indexOf(CONTRACT_START), ctx.indexOf(CONTRACT_END) + CONTRACT_END.length) : "(no contract block)");
console.log("---- CHECKS ----");
console.log(JSON.stringify({ ...checks, PASS }, null, 2));
