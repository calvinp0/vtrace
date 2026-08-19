/**
 * M163-A — freeze the callable-tool adoption policy ablation.
 *
 * Offline. Writes the manifest, protocol, policy blocks, prompt-parity proof,
 * arm schedule, rerun policy and the frozen trigger file itself. Spawns nothing
 * and costs nothing.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m163_protocol.ts
 *
 * Everything it writes is an input to the sweep, so it must run to completion
 * BEFORE any money is spent, and it must be re-runnable to prove the frozen
 * values did not move.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { VTRACE_TOOL_SUITE_POLICY } from "../../src/mcp/startServer";
import { frozenCallableMcpToolNames, HARNESS_DEFAULT_ALLOWED_TOOLS } from "./m162Callable";
import {
  buildArmWiring,
  checkArmPolicyLadder,
  estimateTokens,
  HISTORICAL_TOKEN_DISCIPLINE_PROBES,
  M163_ARMS,
  M163_CONTEXT_TOOL_NAME,
  M163_TASK_TRIGGER_TEXT,
  policyComponents,
  policyDelta,
  scanTaskTrigger,
  sha256,
  type M163Arm,
} from "./m163Policy";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const M162_MANIFEST = path.join(RESULTS, "stage5_m162_pilot_manifest.json");
const TRIGGER_FILE = path.join(RESULTS, "stage5_m163_task_trigger.md");

/** The public arm labels used in every artifact and run label. */
const ARM_LABELS: Readonly<Record<M163Arm, string>> = Object.freeze({
  tools_only: "TOOLS_ONLY",
  tools_neutral_policy: "TOOLS_NEUTRAL_POLICY",
  tools_task_trigger: "TOOLS_TASK_TRIGGER",
});

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`  wrote ${name}\n`);
}

function main(): void {
  const failures: string[] = [];

  // --- 1. corpus: the exact M162 twelve, reused deliberately -----------------
  if (!existsSync(M162_MANIFEST)) throw new Error(`missing predecessor manifest: ${M162_MANIFEST}`);
  const m162 = JSON.parse(readFileSync(M162_MANIFEST, "utf8")) as {
    cases: Array<Record<string, unknown>>;
    manifestHash: string;
    repositories: string[];
  };
  const casesHash = sha256(JSON.stringify(m162.cases));
  if (casesHash !== m162.manifestHash) {
    failures.push(`M162 manifest hash mismatch: recomputed ${casesHash}, recorded ${m162.manifestHash}`);
  }
  if (m162.cases.length !== 12) failures.push(`expected 12 M162 cases, found ${m162.cases.length}`);

  const manifest = {
    schemaVersion: 1,
    milestone: "M163",
    workstream: "A",
    title: "M163 callable-tool adoption policy ablation manifest",
    corpusProvenance: "REUSED_FOR_MECHANISTIC_ABLATION",
    independentGeneralizationClaim: false,
    reuseJustification:
      "The treatment variable is agent policy toward already-available callable tools, not corpus retrieval "
      + "performance. Running the complete population on which spontaneous adoption was measured as 0/12 gives "
      + "within-task contrasts against exactly that observation. No case was selected on any M162 outcome, "
      + "retrieval quality, arm performance, repository or gold location.",
    predecessorManifest: "stage5_m162_pilot_manifest.json",
    predecessorManifestHash: m162.manifestHash,
    caseCount: m162.cases.length,
    repositories: m162.repositories,
    cases: m162.cases,
    manifestHash: casesHash,
  };

  // --- 2. policy blocks -------------------------------------------------------
  const ladder = checkArmPolicyLadder();
  if (!ladder.ok) failures.push(...ladder.issues);

  const triggerScan = scanTaskTrigger(M163_TASK_TRIGGER_TEXT);
  if (!triggerScan.ok) {
    failures.push(`frozen trigger fails its own scanner: forbidden=[${triggerScan.forbiddenHits.join(",")}] `
      + `missing=[${triggerScan.missingRequired.join(",")}]`);
  }
  // Known-positive: a detector that has never rejected anything is not evidence.
  for (const probe of HISTORICAL_TOKEN_DISCIPLINE_PROBES) {
    if (scanTaskTrigger(probe).ok) failures.push(`scanner ACCEPTED historical discipline wording: ${probe}`);
  }

  const policyBlocks = {
    schemaVersion: 1,
    milestone: "M163",
    workstream: "A",
    title: "M163 frozen policy blocks",
    tokenDisciplineState: "OFF in all arms (--disable-token-discipline passed identically)",
    neutralPolicy: {
      source: "src/mcp/startServer.ts :: VTRACE_TOOL_SUITE_POLICY",
      channel: "mcp initialize.result.instructions",
      reusedFromM162Verbatim: true,
      text: VTRACE_TOOL_SUITE_POLICY,
      chars: VTRACE_TOOL_SUITE_POLICY.length,
      estimatedTokens: estimateTokens(VTRACE_TOOL_SUITE_POLICY),
      sha256: sha256(VTRACE_TOOL_SUITE_POLICY),
    },
    taskTrigger: {
      channel: "task prompt (VTRACE_TASK_TRIGGER_FILE, appended last)",
      file: path.relative(process.cwd(), TRIGGER_FILE),
      namesTool: M163_CONTEXT_TOOL_NAME,
      text: M163_TASK_TRIGGER_TEXT,
      chars: M163_TASK_TRIGGER_TEXT.length,
      estimatedTokens: estimateTokens(M163_TASK_TRIGGER_TEXT),
      sha256: sha256(M163_TASK_TRIGGER_TEXT),
      scan: triggerScan,
      forcesExposureNotObedience:
        "Mandates one call and its ordering. Says nothing about believing, following or acting on the result, "
        + "and explicitly grants the right to ignore it and to use every normal repository tool without limit.",
    },
    scannerKnownPositives: HISTORICAL_TOKEN_DISCIPLINE_PROBES.map((probe) => ({
      probe,
      rejected: !scanTaskTrigger(probe).ok,
      hits: scanTaskTrigger(probe).forbiddenHits,
    })),
    perArm: M163_ARMS.map((arm) => ({
      arm: ARM_LABELS[arm],
      components: policyComponents(arm).map((component) => ({
        id: component.id,
        channel: component.channel,
        chars: component.chars,
        estimatedTokens: component.estimatedTokens,
        sha256: component.sha256,
      })),
    })),
  };

  // --- 3. prompt parity -------------------------------------------------------
  const wiringOf = (arm: M163Arm) => buildArmWiring({
    arm,
    repoRoot: "<per-task workspace>",
    cliEntry: "<vtrace cli entry>",
    runtime: "bun",
    triggerFile: TRIGGER_FILE,
  });

  const toolSurfaces = M163_ARMS.map((arm) => wiringOf(arm).mcpConfig.mcpServers.vtrace?.args
    .filter((arg) => arg !== "--no-suite-policy").join(" ") ?? "");
  if (new Set(toolSurfaces).size !== 1) {
    failures.push(`arms do not share one MCP invocation modulo the policy flag: ${toolSurfaces.join(" | ")}`);
  }
  const allowedSurfaces = M163_ARMS.map((arm) => wiringOf(arm).allowedTools.join(","));
  if (new Set(allowedSurfaces).size !== 1) failures.push("arms do not share one tool allow-list");

  const ab = policyDelta("tools_only", "tools_neutral_policy");
  const bc = policyDelta("tools_neutral_policy", "tools_task_trigger");

  const promptParity = {
    schemaVersion: 1,
    milestone: "M163",
    workstream: "A",
    title: "M163 prompt and policy parity controls",
    heldIdentical: [
      "task prompt (SWE-bench problem statement)",
      "external harness system prompt",
      "agent version",
      "model",
      "ordinary tool inventory",
      "VTRACE tool inventory (all three arms)",
      "tool permissions",
      "turn cap / cost cap / timeout",
      "grader",
      "dataset",
      "environment and env guards",
      "shared anti-loop tool-use-discipline block",
    ],
    heldOff: [
      "STAGE5_TOKEN_DISCIPLINE",
      "PIVOT_CHECK",
      "EDIT_GUARD",
      "PATCH_VERIFY",
      "context instruction block",
      "static capsule injection (context policy: force-no-context on every arm)",
    ],
    sharedAntiLoopBlockCaveat:
      "The shared tool-use-discipline block is injected identically into all three arms, exactly as in M162's "
      + "three arms. It cancels in every A/B/C contrast. It is disclosed because it does contain mild "
      + "anti-thrash wording, so 'no policy discourages search' is true of the DIFFERENCE between arms, not of "
      + "the absolute prompt.",
    deltas: {
      "TOOLS_ONLY -> TOOLS_NEUTRAL_POLICY": {
        added: ab.added, removed: ab.removed, addedEstimatedTokens: ab.addedTokens,
      },
      "TOOLS_NEUTRAL_POLICY -> TOOLS_TASK_TRIGGER": {
        added: bc.added, removed: bc.removed, addedEstimatedTokens: bc.addedTokens,
      },
    },
    toolInventoryIdenticalAcrossArms: new Set(toolSurfaces).size === 1,
    allowListIdenticalAcrossArms: new Set(allowedSurfaces).size === 1,
    vtraceToolNames: frozenCallableMcpToolNames(),
    ordinaryTools: HARNESS_DEFAULT_ALLOWED_TOOLS,
    ladder,
  };

  // --- 4. arm schedule --------------------------------------------------------
  // Rotating Latin square. Nothing runs all of one arm last, so provider or
  // model drift over the sweep window cannot land on a single treatment.
  const schedule = manifest.cases.map((entry, index) => ({
    order: index + 1,
    instanceId: String(entry.instanceId),
    armOrder: M163_ARMS.map((_, offset) => ARM_LABELS[M163_ARMS[(index + offset) % M163_ARMS.length]!]),
  }));
  const scheduleArtifact = {
    schemaVersion: 1,
    milestone: "M163",
    workstream: "A",
    title: "M163 three-arm execution schedule",
    rule: "Arm order rotates with task position; each arm leads exactly a third of the tasks.",
    armLeadCounts: Object.fromEntries(M163_ARMS.map((arm) => [
      ARM_LABELS[arm], schedule.filter((entry) => entry.armOrder[0] === ARM_LABELS[arm]).length,
    ])),
    totalArms: schedule.length * M163_ARMS.length,
    schedule,
  };
  const leadCounts = Object.values(scheduleArtifact.armLeadCounts);
  if (new Set(leadCounts).size !== 1) failures.push(`unbalanced arm lead counts: ${leadCounts.join(",")}`);
  const scheduleHash = sha256(JSON.stringify(schedule));

  // --- 5. protocol ------------------------------------------------------------
  const protocol = {
    schemaVersion: 1,
    milestone: "M163",
    workstream: "A",
    title: "M163 callable-tool adoption policy ablation protocol",
    frozenBeforeExecution: true,
    question:
      "If VTRACE callable tools are mechanically available but coding agents never spontaneously consider them, "
      + "does a task-level trigger cause adoption, and once VTRACE is actually consulted, does that help?",
    causalChain: ["TOOL AVAILABILITY", "TOOL CONSIDERATION / ADOPTION", "VTRACE EVIDENCE EXPOSURE", "AGENT UTILITY"],
    m162Established: "the first transition; it failed at the second",
    m163Tests: "the second and third, separately",
    arms: Object.fromEntries(M163_ARMS.map((arm) => [ARM_LABELS[arm], {
      callableTools: frozenCallableMcpToolNames(),
      suitePolicyServed: arm !== "tools_only",
      taskTrigger: arm === "tools_task_trigger",
      staticCapsule: false,
      contextPolicy: "force-no-context",
    }])),
    armsNotRun: {
      BASELINE: "M162 supplies descriptive baseline context; M163's causal comparison is within callable policy.",
      STATIC: "M162 supplies descriptive static context; adding it would double the sweep for a different question.",
    },
    primaryCausalComparisons: [
      "TOOLS_ONLY vs TOOLS_NEUTRAL_POLICY: does descriptive policy alone induce consideration?",
      "TOOLS_NEUTRAL_POLICY vs TOOLS_TASK_TRIGGER: does forced exposure induce adoption, and does it help?",
    ],
    triggerComplianceRule:
      "STRICT. A completed trigger-arm run with any ordinary repository action before the required VTRACE call is "
      + "TRIGGER_NOT_COMPLIED. Non-compliance is an outcome and is never a rerun condition.",
    ordinaryRepositoryTools: ["Bash", "Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "NotebookEdit"],
    bookkeepingToolsExcludedFromCompliance: ["TodoWrite"],
    manifestHash: casesHash,
    scheduleHash,
    policyHashes: {
      neutralPolicy: sha256(VTRACE_TOOL_SUITE_POLICY),
      taskTrigger: sha256(M163_TASK_TRIGGER_TEXT),
    },
    productFreeze: {
      changedForM163: [
        "src/mcp/startServer.ts: added --no-suite-policy / serveSuitePolicy (apparatus). Default byte-identical.",
      ],
      unchanged: [
        "indexing", "retrieval", "ranking", "query interpretation", "context selection",
        "candidate bounds", "support selection", "tool result rendering", "tool schemas", "tool descriptions",
      ],
    },
    harnessChanges: [
      "run_stage5_vexp_swe_bench_smoke.ts: seventh adapter patch block (VTRACE_TASK_TRIGGER_FILE) + per-run trigger meta.",
      "m163Policy.ts / m163Adoption.ts: frozen policy surface and adoption/compliance invariants.",
    ],
    significance: {
      claimable: "adoption response (a 0/12 to near-all transition is decisive), paired per-task behavioural deltas",
      notClaimable: "statistical significance on solve rate; n=12 supports none",
    },
    midSweepChanges: "Prohibited. Policy, manifest, schedule and tool inventory are frozen at the hashes above.",
    provenance: {
      head: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
      originMain: git("rev-parse", "origin/main"),
      // M162's callable wiring commit and its final evidence commit. Recorded as
      // literals, not as HEAD: HEAD moves the moment M163 commits anything, and a
      // predecessor pointer that follows HEAD identifies nothing.
      m162ProductSha: git("rev-parse", "78ca90b8"),
      m162FinalSha: git("rev-parse", "53608310"),
    },
  };

  // --- 6. emit ----------------------------------------------------------------
  writeFileSync(TRIGGER_FILE, `${M163_TASK_TRIGGER_TEXT}\n`);
  process.stdout.write(`  wrote ${path.basename(TRIGGER_FILE)}\n`);

  writeJson("stage5_m163_manifest.json", manifest);
  writeJson("stage5_m163_policy_blocks.json", policyBlocks);
  writeJson("stage5_m163_prompt_parity.json", promptParity);
  writeJson("stage5_m163_arm_schedule.json", { ...scheduleArtifact, scheduleHash });
  writeJson("stage5_m163_protocol.json", protocol);

  writeFileSync(path.join(RESULTS, "stage5_m163_rerun_policy.md"), [
    "# M163 rerun policy (frozen before execution)",
    "",
    "## Allowed",
    "",
    "- API or network infrastructure failure",
    "- Agent process crash unrelated to task reasoning",
    "- Corrupted workspace",
    "- Grader infrastructure failure",
    "- MCP server failed to initialize despite a valid harness configuration",
    "",
    "## Not allowed",
    "",
    "- The agent wrote a bad patch",
    "- VTRACE returned weak or misleading but valid evidence",
    "- The agent ignored the tools",
    "- **The agent violated the trigger.** `TRIGGER_NOT_COMPLIED` is a measurement,",
    "  and it is one of the two outcomes the trigger arm exists to produce. Rerunning",
    "  until an arm complies would convert the adoption rate into a description of",
    "  how many attempts were bought.",
    "- Timeout caused by agent strategy",
    "- An inconvenient outcome",
    "",
    "## Record-keeping",
    "",
    "Every rerun retains the original run, the failure reason, the replacement run and",
    "the policy clause that permitted it. Nothing is overwritten. There are no",
    "selective reruns: an allowed failure class is applied by rule, not by inspection",
    "of which arm it would help.",
    "",
  ].join("\n"));
  process.stdout.write("  wrote stage5_m163_rerun_policy.md\n");

  if (failures.length > 0) {
    process.stdout.write(`\nFREEZE FAILED (${failures.length}):\n`);
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\nM163-A freeze OK: 12 cases, 36 arms, 3 policy levels, ${scheduleHash.slice(0, 12)}…\n`);
}

main();
