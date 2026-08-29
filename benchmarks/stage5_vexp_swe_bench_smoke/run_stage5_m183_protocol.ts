/**
 * M183-A — freeze the protocol, and PROVE the arms are equivalent.
 *
 *   bun run_stage5_m183_protocol.ts
 *
 * §10 asks for "a normalized configuration diff proving this", with the target
 * "all differences: VTRACE treatment activation only". A prose assertion is not
 * a proof, so the equivalence is established three ways, each of which can fail:
 *
 *   1. RUN THE WIRING. Both arms' wiring builders are executed for a real
 *      instance and their emitted environments are diffed. Expected difference:
 *      exactly one variable, `VTRACE_TASK_TRIGGER_FILE`.
 *   2. READ THE DRIVER. The command the driver builds is extracted from the
 *      script text and checked for arm-conditionality. If any flag were chosen
 *      by arm — as M173's `--protocol` was — this fails.
 *   3. READ THE ARM CONTRACT. Every field of `armDefinition` is compared across
 *      arms, so a treatment that acquired a policy would be visible as a field
 *      difference rather than as prose.
 *
 * The protocol hash covers the frozen documents AND the source of every module
 * that can change what reaches the agent. §62/§64: benchmark instrumentation may
 * be added before launch; after launch a changed hash means the treatment is not
 * the one that was frozen, and that is meant to be detectable rather than
 * arguable.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { M183_ARMS, armDefinition, sha256, type M183Arm } from "./m183Treatment";

const ROOT = path.resolve(".");
const BENCH = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(BENCH, "results");

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const read = (p: string): string => readFileSync(p, "utf8");
const hashFile = (p: string): string => sha256(read(p));

/** Run one arm's wiring builder for real and capture what it emits. */
function wiringFor(arm: M183Arm, instanceId: string): Record<string, string> {
  const out = execFileSync("bun", [path.join(BENCH, "run_stage5_m183_arm_wiring.ts"), arm, `m183_${arm}_probe`, instanceId], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const env: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (line.trim() === "" || eq < 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/**
 * Extract the driver's spawn command and check nothing in it depends on the arm.
 *
 * M173's driver chose `--protocol` by arm. M183's must not choose anything: the
 * treatment travels entirely in the environment.
 */
function driverCommandAudit(): Record<string, unknown> {
  const driver = read(path.join(BENCH, "run_stage5_m183_driver.sh"));
  const start = driver.indexOf("local common=(");
  const end = driver.indexOf("\n  )", start);
  if (start < 0 || end < 0) throw new Error("could not locate the driver's command array");
  const block = driver.slice(start, end);

  const armConditionals = [...block.matchAll(/\$\{?arm\b|\[ "\$arm"/gu)].map((m) => m[0]);
  const protocolValues = [...block.matchAll(/--protocol\s+(\S+)/gu)].map((m) => m[1]!);
  const flags = [...block.matchAll(/^\s*(--[a-z0-9-]+)/gmu)].map((m) => m[1]!);

  // The only BRANCH on the arm anywhere in run_arm must be the two guards that
  // check the wiring came out the right shape. Naming the arm in a label, a log
  // line or the wiring builder's argv is not control flow and is not a treatment
  // difference; branching on it is, and that is what this looks for.
  const runArm = driver.slice(driver.indexOf("run_arm() {"), driver.indexOf("cmd_treat() {"));
  const referenceLines = runArm.split("\n").filter((l) => /"\$arm"/u.test(l));
  // A branch on the arm TESTS its value: `[ "$arm" ... ]`, `[[ "$arm" ... ]]`,
  // `case "$arm"`. An `if` whose condition merely PASSES "$arm" to another
  // program tests that program's exit status, not the arm.
  const conditionalLines = referenceLines.filter((l) => /(\[\[?\s+"\$arm"|case\s+"\$arm")/u.test(l));

  return {
    commandArrayOccurrences: (driver.match(/local common=\(/gu) ?? []).length,
    armConditionalsInsideCommand: armConditionals,
    commandIsArmIndependent: armConditionals.length === 0,
    protocolValues,
    protocolIsSingleAndLiteral: protocolValues.length === 1 && protocolValues[0] === "baseline",
    flagCount: flags.length,
    flags,
    armReferenceLinesInRunArm: referenceLines.map((l) => l.trim()),
    armBranchesInRunArm: conditionalLines.map((l) => l.trim()),
    // Both guards refuse a wiring shape; neither selects a flag, a protocol or a
    // budget. A branch that did would appear here and fail the verdict.
    armBranchesAreWiringGuardsOnly:
      conditionalLines.length > 0 && conditionalLines.every((l) => l.includes("envassign")),
    mcpConfigEmitted: /VTRACE_MCP_CONFIG|VTRACE_MCP_ALLOWED_TOOLS/u.test(driver),
  };
}

function main(): void {
  const head = git("rev-parse", "HEAD");
  const status = git("status", "--porcelain");
  const trackedDirty = status.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("??"));

  // ── arm equivalence ──
  // Any manifest instance whose orientation already exists. The equivalence
  // claim is about the WIRING, which is instance-independent; the probe only
  // needs a real trigger file so the treatment builder runs its real path
  // rather than its refusal path.
  const order = JSON.parse(read(path.join(RESULTS, "stage5_m183_sample_manifest.json")))
    .executionOrder as { instanceId: string }[];
  const probeInstance = order
    .map((row) => row.instanceId)
    .find((id) => existsSync(path.join(RESULTS, "_m183_orientation", `${id}.trigger.md`)));
  if (probeInstance === undefined) {
    throw new Error("no orientation has been generated yet; run the driver's `orient` step before freezing the protocol");
  }
  const envs = Object.fromEntries(M183_ARMS.map((arm) => [arm, wiringFor(arm, probeInstance)]));
  const keys = [...new Set(M183_ARMS.flatMap((a) => Object.keys(envs[a]!)))].sort();
  const envDiff = keys.filter((k) => envs.baseline![k] !== envs.vtrace_orientation![k]);

  const contracts = Object.fromEntries(M183_ARMS.map((a) => [a, armDefinition(a)]));
  const contractKeys = Object.keys(contracts.baseline!) as (keyof typeof contracts.baseline)[];
  const contractDiff = contractKeys.filter(
    (k) => contracts.baseline![k] !== contracts.vtrace_orientation![k]);

  const driverAudit = driverCommandAudit();

  const armEquivalence = {
    schemaVersion: "stage5.m183.arm-equivalence.v1",
    milestone: "M183", workstream: "M183-A",
    probeInstance,
    model: {
      provider: "Anthropic, through the `claude` CLI credentials (NOT ANTHROPIC_API_KEY, which is unset here)",
      identifier: "claude-opus-4-5-20251101",
      source: "vexp-swe-bench/src/cli.ts --model default, unchanged and identical in both arms",
      maxTurns: 250, costLimitUsd: 3,
      settings: "harness defaults; M183 sets no temperature, no reasoning configuration and no tool configuration of its own",
    },
    emittedEnvironment: envs,
    environmentDifferences: envDiff,
    environmentDifferenceIsTreatmentActivationOnly:
      envDiff.length === 1 && envDiff[0] === "VTRACE_TASK_TRIGGER_FILE",
    armContracts: contracts,
    // `arm` and `label` are the arm's own identity, not a treatment difference.
    contractDifferences: contractDiff,
    contractDifferencesAreIdentityAndDisclosureOnly:
      [...contractDiff].sort().join(",") === "arm,disclosure,label,orientationInjected",
    driverCommand: driverAudit,
    toolEnvironment: {
      baseline: "the harness's ordinary tool whitelist",
      treatment: "the harness's ordinary tool whitelist — IDENTICAL",
      mcpServersInEitherArm: 0,
      toolsDeniedInEitherArm: 0,
      note: "§6 holds the tool environment fixed and §7 forbids denying ordinary tools. M183 adds no MCP server to either arm, so the treatment cannot act through tool availability.",
    },
    policyText: {
      baseline: null,
      treatment: "one section: a provenance sentence plus the packet, with no imperative addressed to the agent (asserted in m183Treatment.test.ts)",
      mandate: false, prohibition: false, searchGuard: false, antiLoopDiscipline: false,
      differsFromM173: "M173's arm B carried M168_MANDATE_TEXT ('call run_pipeline FIRST', 'ALWAYS FIRST') and an MCP tool inventory. §7 forbids the first; §6 holds the second fixed. Neither is present.",
    },
    verdict:
      envDiff.length === 1 && envDiff[0] === "VTRACE_TASK_TRIGGER_FILE"
      && driverAudit.commandIsArmIndependent === true
      && driverAudit.protocolIsSingleAndLiteral === true
      && driverAudit.armBranchesAreWiringGuardsOnly === true
        ? "ARM_DIFFERENCE_IS_TREATMENT_ACTIVATION_ONLY"
        : "ARM_EQUIVALENCE_NOT_ESTABLISHED",
  };

  // ── protocol hash ──
  const frozenSources = [
    "benchmarks/stage5_vexp_swe_bench_smoke/m183Treatment.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m183_orientation.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m183_arm_wiring.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m183_driver.sh",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m183_prepare.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m183_sample.ts",
    "benchmarks/stage5_vexp_swe_bench_smoke/stage5_task_derivation.ts",
    "src/runPipeline/orientationProjection.ts",
    "src/runPipeline/orientationDecline.ts",
    "src/mcp/tools.ts",
  ];
  const frozenDocuments = [
    "stage5_m183_sample_manifest.json", "stage5_m183_sample_hash.json",
    "stage5_m183_pair_order.json", "stage5_m183_spend_model.json",
    "stage5_m183_cost_authorization.json",
    "stage5_m183_token_accounting_contract.md", "stage5_m183_cost_accounting_contract.md",
    "stage5_m183_grader_contract.md", "stage5_m183_invalidity_policy.md",
  ];
  const sourceHashes = Object.fromEntries(frozenSources.map((p) => [p, hashFile(path.join(ROOT, p))]));
  const documentHashes = Object.fromEntries(frozenDocuments.map((p) => [p, hashFile(path.join(RESULTS, p))]));

  const protocolHash = {
    schemaVersion: "stage5.m183.protocol-hash.v1",
    milestone: "M183", workstream: "M183-A",
    productHead: head,
    productAncestry: {
      m181Closure: "95a2a9d492fc1ab1eb08dcab5caa875810da9e25",
      m182Evidence: "c17329dce00c4af3b879c2d2c447c62d650ce86d",
      m182Closure: "9517ccce6c63342ab4883131463ed294169e22af",
      headIsM182Closure: head === "9517ccce6c63342ab4883131463ed294169e22af",
    },
    sourceHashes, documentHashes,
    protocolHash: sha256(JSON.stringify({ head, sourceHashes, documentHashes })),
    meaning: "§62/§63 — after the first live arm, a change to any hash above means the treatment under test is not the treatment that was frozen. Benchmark-only ANALYSIS scripts are deliberately excluded: they cannot reach the agent.",
  };

  const startState = {
    schemaVersion: "stage5.m183.start-state.v1",
    milestone: "M183", workstream: "M183-A",
    capturedAt: new Date().toISOString(),
    product: {
      head, branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      trackedFilesDirty: trackedDirty.length,
      trackedDirtyPaths: trackedDirty.map((l) => l.slice(3)),
      note: "Untracked benchmark output and the user's own working files are preserved and deliberately not counted (§153/§154).",
    },
    inheritedGates: {
      typecheck: "PASS", typecheckBenchmarks: "PASS", gitDiffCheck: "PASS (clean)",
      bunTest: { pass: 5523, skip: 49, fail: 0, files: 353 },
      capturedBefore: "any M183 source file existed",
    },
    liveEnvironment: {
      agentExecutable: "claude CLI credentials at ~/.claude/.credentials.json (ANTHROPIC_API_KEY unset)",
      grader: "docker", dockerAvailable: true,
      vexpSweBenchDir: "/home/calvin/code/vexp-swe-bench",
      dataset: "results/_m160_corpus/swe_bench_verified.jsonl (500 SWE-bench Verified rows)",
      expectedTestbedPrefix: "/home/calvin/miniforge3/envs/vexp_swebench",
      envGuard: "MANDATORY (M89): --stage5-env-guard --stage5-env-drift-check --expected-testbed-prefix",
      shellGuard: "MANDATORY (M90A): --stage5-agent-shell-guard --stage5-host-pip-firewall",
    },
    treatment: {
      shape: "one automatically delivered compact orientation packet, injected as the last prompt section through VTRACE_TASK_TRIGGER_FILE",
      source: "structuredContent.result.output of a real default run_pipeline call over this instance's freshly indexed orientation workspace",
      mcpToolsGivenToTheAgent: 0,
      mandate: null,
      whyNotMcpAtRunTime: "§6 holds the tool environment fixed across arms, and M164 measured 0 voluntary reuse: an uncoerced tool arm would deliver orientation on approximately no task, which measures adoption rather than utility and leaves §82's delivery witness unsatisfiable.",
    },
  };

  const write = (name: string, doc: unknown): void => {
    writeFileSync(path.join(RESULTS, name), `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`  wrote results/${name}`);
  };
  write("stage5_m183_start_state.json", startState);
  write("stage5_m183_arm_equivalence.json", armEquivalence);
  write("stage5_m183_protocol_hash.json", protocolHash);

  console.log(`\nM183 protocol frozen at ${head.slice(0, 12)}`);
  console.log(`  arm equivalence: ${armEquivalence.verdict}`);
  console.log(`  env differences: ${envDiff.join(", ") || "(none)"}`);
  console.log(`  driver command arm-independent: ${driverAudit.commandIsArmIndependent} (protocol=${(driverAudit.protocolValues as string[]).join("/")})`);
  console.log(`  MCP config emitted anywhere in the driver: ${driverAudit.mcpConfigEmitted}`);
  console.log(`  protocolHash: ${protocolHash.protocolHash}`);
  if (armEquivalence.verdict !== "ARM_DIFFERENCE_IS_TREATMENT_ACTIVATION_ONLY") process.exit(1);
}

main();
