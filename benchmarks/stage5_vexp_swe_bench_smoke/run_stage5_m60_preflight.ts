/**
 * M60 non-agent injected-context pre-flight (no live agent, no Docker, no spend).
 *
 * Builds the EXACT Stage 5 injected v2 context for the M60 structured-bounded treatment
 * (--inject-capsule-digest --digest-decision-contract --bounded-digest-decisions
 * --compact-digest-injection) for ONE case against an already-built workspace index,
 * and asserts the M60 pre-flight requirements (Gate 1):
 *   1. Capsule digest sentinel present exactly once.
 *   2. Decision contract sentinel present exactly once.
 *   3. Real non-warning `→ impact` section present.
 *   4. Structured grammar present (target_id / target / decision / reason / files_touched).
 *   5. target_id present.
 *   6. decision / reason / files_touched fields present.
 *   7. Required target count > 0 and <= 4.
 *   8. compact-digest-injection applied (no duplicate `## VTRACE inspect-first`).
 *   9. memory/rules warnings honest if no data exists.
 * Plus the bounded three-way (EDIT / RULE_OUT / INSPECT_ONLY_NO_EDIT) is present.
 *
 * The index build is deterministic from repo source (unchanged by the M56–M59 contract
 * work), so the enrichment computed here is identical to a fresh run's. Reuses the
 * persisted M55Z digest workspaces under results/workspaces/.
 *
 * Usage: bun run_stage5_m60_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]
 * Emits a single JSON object on the LAST line (prefixed RESULT_JSON: ) for machine parse.
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
import { truncateContextByPriority } from "../../src/capsuleV2/sectionBudgetAccounting.ts";

// The default Stage 5 injected-context char budget (DEFAULT_CONFIG.vtraceContextMaxChars).
// M60B pylint-8898 evicted the contract END sentinel at exactly this budget; the M61 fix
// preserves the digest + contract atomically through this truncation step.
const VTRACE_CONTEXT_MAX_CHARS = 12_000;

const INSTANCE = process.argv[2];
const WORKSPACE = process.argv[3];
const DATASET = process.argv[4] ?? "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
if (INSTANCE === undefined || WORKSPACE === undefined) {
  throw new Error("usage: bun run_stage5_m60_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]");
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

function classify(opts: { bounded: boolean; compact: boolean }): string {
  return (
    classifyCapsuleOutput(stdout, {
      injectDigest: true,
      query: queryText,
      digestEnrichmentProvider: enrichmentProvider,
      digestDecisionContract: true,
      boundedDigestDecisions: opts.bounded,
      compactDigestInjection: opts.compact,
    }).context ?? ""
  );
}

const ctx = classify({ bounded: true, compact: true }); // the actual M60 treatment context
const ctxNoCompact = classify({ bounded: true, compact: false });

// M61: the harness truncates the injected context to 12,000 chars BEFORE the agent sees
// it. Reproduce that step here so the pre-flight validates the context the agent actually
// receives, not the untruncated build. With the atomic-block option the digest + contract
// sentinel blocks must survive WHOLE (the pylint-8898 regression target).
const truncated = truncateContextByPriority(ctx, VTRACE_CONTEXT_MAX_CHARS, {
  atomicBlocks: STAGE5_ATOMIC_SENTINEL_BLOCKS,
});
const ctxTruncated = truncated.text;

const DIGEST_START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const DIGEST_END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
const CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";
const INSPECT_FIRST = "## VTRACE inspect-first";

function countOcc(h: string, n: string): number {
  return h.split(n).length - 1;
}

const ds = ctx.indexOf(DIGEST_START);
const de = ctx.indexOf(DIGEST_END);
const digest = ds >= 0 && de >= 0 ? ctx.slice(ds, de + DIGEST_END.length) : "";

const contract = parseDigestDecisionContract(ctx);
const requiredCount = contract.targets.length;

const hasImpact = /→ impact/.test(digest);
const impactWarnOnly = /impact_not_threaded_into_digest/.test(digest) && !hasImpact;
const hasBoundedChoices = /EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(ctx);
// structured M59 grammar fields
const hasTargetId = /target_id/.test(ctx);
const hasTargetField = /\btarget:/.test(ctx) || /\btarget\b/.test(ctx);
const hasDecisionField = /decision:/.test(ctx);
const hasReasonField = /reason:/.test(ctx);
const hasFilesTouched = /files_touched/.test(ctx);
const structuredGrammarPresent =
  hasTargetId && hasDecisionField && hasReasonField && hasFilesTouched;
const compactApplied =
  countOcc(ctxNoCompact, INSPECT_FIRST) >= 1 && countOcc(ctx, INSPECT_FIRST) === 0;

// M61: re-validate the four sentinels + strict contract parse on the TRUNCATED context.
const postTruncationContract = parseDigestDecisionContract(ctxTruncated);
const post_digest_ok =
  countOcc(ctxTruncated, DIGEST_START) === 1 && countOcc(ctxTruncated, DIGEST_END) === 1;
const post_contract_ok =
  countOcc(ctxTruncated, CONTRACT_START) === 1 && countOcc(ctxTruncated, CONTRACT_END) === 1;

const checks = {
  instance: INSTANCE,
  digest_sentinel_exactly_once: countOcc(ctx, DIGEST_START) === 1 && countOcc(ctx, DIGEST_END) === 1,
  contract_sentinel_exactly_once: countOcc(ctx, CONTRACT_START) === 1 && countOcc(ctx, CONTRACT_END) === 1,
  // M61 atomic-truncation regression checks (12,000-char budget, the M60B failure point).
  post_truncation_mode: truncated.budget.truncationMode,
  post_truncation_atomic_preserved: truncated.budget.atomicBlocksPreserved ?? [],
  post_truncation_atomic_omitted: truncated.budget.atomicBlocksOmitted ?? [],
  post_truncation_digest_sentinel_exactly_once: post_digest_ok,
  post_truncation_contract_sentinel_exactly_once: post_contract_ok,
  post_truncation_contract_present: postTruncationContract.present,
  impact_section_present: hasImpact,
  impact_warning_only: impactWarnOnly,
  structured_grammar_present: structuredGrammarPresent,
  has_target_id: hasTargetId,
  has_decision_field: hasDecisionField,
  has_reason_field: hasReasonField,
  has_files_touched: hasFilesTouched,
  bounded_three_way_present: hasBoundedChoices,
  required_target_count: requiredCount,
  required_targets: contract.targets.map((t) => `${t.kind} ${t.target}`),
  required_target_ok: requiredCount > 0 && requiredCount <= 4,
  compact_mode_applied: compactApplied,
  memory_warning_present: /memory_not_threaded_into_digest/.test(digest),
  rules_warning_present: /rules_not_threaded_into_digest/.test(digest),
};

const PASS =
  checks.digest_sentinel_exactly_once &&
  checks.contract_sentinel_exactly_once &&
  checks.impact_section_present &&
  !checks.impact_warning_only &&
  checks.structured_grammar_present &&
  checks.bounded_three_way_present &&
  checks.required_target_ok &&
  checks.compact_mode_applied &&
  // M61: the digest + contract must remain valid AFTER 12k truncation.
  checks.post_truncation_digest_sentinel_exactly_once &&
  checks.post_truncation_contract_sentinel_exactly_once &&
  checks.post_truncation_contract_present;

console.log("RESULT_JSON: " + JSON.stringify({ ...checks, PASS }));
