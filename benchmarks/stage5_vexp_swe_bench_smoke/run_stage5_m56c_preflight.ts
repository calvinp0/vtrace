/**
 * M56C non-agent injected-context pre-flight (no live agent, no Docker, no spend).
 *
 * Builds the EXACT Stage 5 injected v2 digest (the same `runEngineQuery` path used by
 * --mode run-protocol: capsule v2 subprocess → classifyCapsuleOutput with the M56B
 * DB-backed digestEnrichmentProvider) for ONE case against an already-built workspace
 * index, and asserts the four pre-flight requirements:
 *   1. sentinel start/end present
 *   2. a real `→ impact` section present
 *   3. the impact section is not only a warning
 *   4. memory/rules warnings are honest if no data exists
 *
 * Reuses a persisted workspace index — the index build is unchanged by M56B, so the
 * enrichment computed here is identical to a fresh run's.
 *
 * Usage:
 *   bun run_stage5_m56c_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]
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

const INSTANCE = process.argv[2];
const WORKSPACE = process.argv[3];
const DATASET = process.argv[4] ?? "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
if (INSTANCE === undefined || WORKSPACE === undefined) {
  throw new Error("usage: bun run_stage5_m56c_preflight.ts <instance_id> <workspace_dir> [dataset.jsonl]");
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

const classified = classifyCapsuleOutput(new TextDecoder().decode(proc.stdout), {
  injectDigest: true,
  query: queryText,
  digestEnrichmentProvider: (parsed) =>
    buildStage5DigestEnrichmentsBestEffort({
      dbPath: path.join(WORKSPACE, ".vtrace", "index.sqlite"),
      repoRoot: WORKSPACE,
      query: queryText,
      result: parsed,
      intent: config.capsuleIntent,
    }),
});

const ctx = classified.context ?? "";
const START = "<VTRACE_CAPSULE_V2_DIGEST_START>";
const END = "<VTRACE_CAPSULE_V2_DIGEST_END>";
const s = ctx.indexOf(START);
const e = ctx.indexOf(END);
const digest = s >= 0 && e >= 0 ? ctx.slice(s, e + END.length) : "";

console.log(digest || "(no digest block found)");
const hasStart = ctx.includes(START);
const hasEnd = ctx.includes(END);
const hasImpact = /→ impact/.test(digest);
const impactWarnOnly = /impact_not_threaded_into_digest/.test(digest) && !hasImpact;
console.log("---- CHECKS ----");
console.log(JSON.stringify({
  instance: INSTANCE,
  policyAction: classified.policyAction,
  sentinel_start: hasStart,
  sentinel_end: hasEnd,
  impact_section_present: hasImpact,
  impact_warning_only: impactWarnOnly,
  memory_warning_present: /memory_not_threaded_into_digest/.test(digest),
  rules_warning_present: /rules_not_threaded_into_digest/.test(digest),
  PASS: hasStart && hasEnd && hasImpact && !impactWarnOnly,
}, null, 2));
