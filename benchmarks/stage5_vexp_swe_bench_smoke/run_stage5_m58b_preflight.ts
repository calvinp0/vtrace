/**
 * M58B non-agent injected-context pre-flight (no live agent, no Docker, no spend).
 *
 * Builds the EXACT Stage 5 injected v2 context for the M58 bounded contract path
 * (--inject-capsule-digest --digest-decision-contract --bounded-digest-decisions
 * --compact-digest-injection) for ONE case against an already-built workspace index,
 * and asserts the M58B pre-flight requirements:
 *   1. digest sentinel present exactly once
 *   2. decision contract sentinel present exactly once
 *   3. a real non-warning `→ impact` section present
 *   4. bounded contract text present (three-way decision)
 *   5. decision choices include EDIT / RULE_OUT / INSPECT_ONLY_NO_EDIT
 *   6. required target count > 0 and <= 4
 *   7. required impact reps tightened vs M57 (compare bounded-required vs M57-required)
 *   8. optional context rendered for demoted impact reps (where applicable)
 *   9. compact mode removed the duplicate `## VTRACE inspect-first` block
 *  10. memory/rules warnings honest if no data exists
 *
 * Spawns the capsule query ONCE; classifies the M58 bounded context plus the M57
 * (non-bounded) context to measure the required-target tightening delta.
 *
 * Usage: bun run_stage5_m58b_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]
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
  throw new Error("usage: bun run_stage5_m58b_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]");
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

const ctx = classify({ bounded: true, compact: true }); // the actual M58 treatment context
const ctxBoundedNoCompact = classify({ bounded: true, compact: false });
const ctxM57 = classify({ bounded: false, compact: true }); // M57 contract, same compact

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
const m57Contract = parseDigestDecisionContract(ctxM57);
const m57ImpactReqs = m57Contract.targets.filter((t) => t.kind === "IMPACT").length;
const m58ImpactReqs = contract.targets.filter((t) => t.kind === "IMPACT").length;

const hasImpact = /→ impact/.test(digest);
const impactWarnOnly = /impact_not_threaded_into_digest/.test(digest) && !hasImpact;
const hasBoundedChoices = /decision: EDIT \| RULE_OUT \| INSPECT_ONLY_NO_EDIT/.test(ctx);
const hasAntiOverEdit = /Required target does not mean required edit\./.test(ctx);
const optionalRendered = /Optional context \(NOT required to decide/.test(ctx);
const requiredCount = contract.targets.length;
const compactRemovedInspectFirst =
  countOcc(ctxBoundedNoCompact, INSPECT_FIRST) >= 1 && countOcc(ctx, INSPECT_FIRST) === 0;

const checks = {
  instance: INSTANCE,
  digest_sentinel_exactly_once: countOcc(ctx, DIGEST_START) === 1 && countOcc(ctx, DIGEST_END) === 1,
  contract_sentinel_exactly_once: countOcc(ctx, CONTRACT_START) === 1 && countOcc(ctx, CONTRACT_END) === 1,
  impact_section_present: hasImpact,
  impact_warning_only: impactWarnOnly,
  bounded_contract_present: hasBoundedChoices && hasAntiOverEdit,
  bounded_choices_present: hasBoundedChoices,
  required_target_count: requiredCount,
  required_targets: contract.targets.map((t) => `${t.kind} ${t.target}`),
  required_target_ok: requiredCount > 0 && requiredCount <= 4,
  m57_required_impact_reps: m57ImpactReqs,
  m58_required_impact_reps: m58ImpactReqs,
  impact_reps_tightened_or_equal: m58ImpactReqs <= m57ImpactReqs,
  optional_context_rendered: optionalRendered,
  compact_removed_inspect_first: compactRemovedInspectFirst,
  memory_warning_present: /memory_not_threaded_into_digest/.test(digest),
  rules_warning_present: /rules_not_threaded_into_digest/.test(digest),
};

const PASS =
  checks.digest_sentinel_exactly_once &&
  checks.contract_sentinel_exactly_once &&
  checks.impact_section_present &&
  !checks.impact_warning_only &&
  checks.bounded_contract_present &&
  checks.bounded_choices_present &&
  checks.required_target_ok &&
  checks.impact_reps_tightened_or_equal &&
  checks.compact_removed_inspect_first;

console.log(
  contract.present ? ctx.slice(ctx.indexOf(CONTRACT_START), ctx.indexOf(CONTRACT_END) + CONTRACT_END.length) : "(no contract block)",
);
console.log("---- CHECKS ----");
console.log(JSON.stringify({ ...checks, PASS }, null, 2));
