/**
 * M164-C — freeze the protocol BEFORE any money is spent.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m164_protocol.ts
 *
 * M164-C is M163 minus the arm that answered its question. TOOLS_ONLY and
 * TOOLS_NEUTRAL_POLICY both produced 0/12 adoption, so the TOOLS_ONLY arm has
 * nothing left to distinguish and is not run. What remains is the transition
 * M163 could not reach, because every call it produced was refused:
 *
 *   TOOLS_NEUTRAL_POLICY   tools + M162's byte-identical suite policy
 *   TOOLS_TASK_TRIGGER     the same, plus one required initial orientation call
 *
 * NEUTRAL is rerun rather than compared against M163's stored NEUTRAL. The
 * product generation changed at the readiness seam between the two, and a paired
 * comparison across that boundary would confound the treatment with time, model
 * and runtime drift. Both arms run in the same execution window.
 *
 * The neutral policy and trigger bytes are M163's, and this script RECOMPUTES
 * their hashes from live source rather than restating them: the readiness repair
 * touched a file in the same module tree, and "we did not change the policy" is
 * a claim that should be checked, not asserted.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { VTRACE_TOOL_SUITE_POLICY } from "../../src/mcp/startServer";
import { FROZEN_CALLABLE_TOOL_IDS } from "./m162Callable";
import { M163_TASK_TRIGGER_TEXT, sha256 } from "./m163Policy";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const M163_PROTOCOL = path.join(RESULTS, "stage5_m163_protocol.json");
const M163_MANIFEST = path.join(RESULTS, "stage5_m163_manifest.json");
const PROTOCOL_OUT = path.join(RESULTS, "stage5_m164_protocol.json");
const SCHEDULE_OUT = path.join(RESULTS, "stage5_m164_schedule.json");

export type M164Arm = "tools_neutral_policy" | "tools_task_trigger";

/** Frozen arm order. The incremental-policy order, not an execution schedule. */
export const M164_ARMS: readonly M164Arm[] = Object.freeze([
  "tools_neutral_policy",
  "tools_task_trigger",
] as const);

export function armLabel(arm: M164Arm): string {
  return arm.toUpperCase();
}

/**
 * Alternate which arm leads, by task position.
 *
 * Both arms run for every task, so the order is not about balance of exposure —
 * it is about not letting one arm systematically own the first attempt at a
 * freshly cloned workspace, a warm cache, or the earlier half of a long
 * execution window.
 */
export function buildSchedule(instanceIds: readonly string[]): {
  order: number;
  instanceId: string;
  armOrder: readonly string[];
}[] {
  return instanceIds.map((instanceId, index) => ({
    order: index + 1,
    instanceId,
    armOrder: index % 2 === 0
      ? [armLabel("tools_neutral_policy"), armLabel("tools_task_trigger")]
      : [armLabel("tools_task_trigger"), armLabel("tools_neutral_policy")],
  }));
}

function main(): void {
  const m163Protocol = JSON.parse(readFileSync(M163_PROTOCOL, "utf8")) as {
    policyHashes: { neutralPolicy: string; taskTrigger: string };
    manifestHash: string;
  };
  const manifest = JSON.parse(readFileSync(M163_MANIFEST, "utf8")) as {
    cases: { instanceId: string; repo: string; baseCommit: string }[];
    manifestHash: string;
  };

  // Recomputed from live source, then compared to what M163 recorded.
  const neutralPolicy = sha256(VTRACE_TOOL_SUITE_POLICY);
  const taskTrigger = sha256(M163_TASK_TRIGGER_TEXT);
  const policyPreserved = neutralPolicy === m163Protocol.policyHashes.neutralPolicy;
  const triggerPreserved = taskTrigger === m163Protocol.policyHashes.taskTrigger;

  const instanceIds = manifest.cases.map((c) => c.instanceId);
  const schedule = buildSchedule(instanceIds);
  const scheduleHash = createHash("sha256").update(JSON.stringify(schedule)).digest("hex");

  const scheduleReport = {
    schemaVersion: 1,
    milestone: "M164",
    workstream: "C",
    title: "Paired execution order, frozen before the sweep",
    rule: "Both arms run for every task; the leading arm alternates with task position so neither arm systematically owns the first attempt.",
    armLeadCounts: {
      TOOLS_NEUTRAL_POLICY: schedule.filter((s) => s.armOrder[0] === "TOOLS_NEUTRAL_POLICY").length,
      TOOLS_TASK_TRIGGER: schedule.filter((s) => s.armOrder[0] === "TOOLS_TASK_TRIGGER").length,
    },
    totalArms: schedule.length * M164_ARMS.length,
    schedule,
    scheduleHash,
  };

  const protocol = {
    schemaVersion: 1,
    milestone: "M164",
    workstream: "C",
    title: "Conditional utility of callable VTRACE, once its calls can be answered",
    frozenBeforeExecution: true,
    question: "When triggered VTRACE calls actually return repository evidence, does exposure improve agent success or efficiency relative to the same callable architecture with no task-level trigger?",
    causalChain: {
      m162: "AVAILABLE != ADOPTED. Tools connected, permitted, described: 0/12 adoption.",
      m163: "ADOPTED != ABLE TO ANSWER. A task-level trigger produced 12/12 adoption; the product refused all 14 calls.",
      m164: "ABLE TO ANSWER -> EVIDENCE DELIVERED -> HELPFUL? The readiness seam is repaired and delivery is proved; utility is what remains.",
    },
    arms: [
      {
        arm: "TOOLS_NEUTRAL_POLICY",
        tools: FROZEN_CALLABLE_TOOL_IDS,
        policyComponents: [{ component: "suite policy", channel: "initialize.result.instructions", hash: neutralPolicy }],
        taskTrigger: false,
      },
      {
        arm: "TOOLS_TASK_TRIGGER",
        tools: FROZEN_CALLABLE_TOOL_IDS,
        policyComponents: [
          { component: "suite policy", channel: "initialize.result.instructions", hash: neutralPolicy },
          { component: "task trigger", channel: "task/prompt", hash: taskTrigger },
        ],
        taskTrigger: true,
      },
    ],
    armsNotRun: {
      TOOLS_ONLY: "M163 measured 0/12 adoption for both TOOLS_ONLY and NEUTRAL. The arm has nothing left to distinguish.",
      STATIC: "Not a callable-architecture question.",
      BASELINE: "Not a callable-architecture question.",
    },
    primaryCausalComparison: "TOOLS_TASK_TRIGGER - TOOLS_NEUTRAL_POLICY, paired by task.",
    separateTransitions: [
      "ADOPTION: did the trigger still cause calls?",
      "ANSWERABILITY: did those calls return real repository evidence?",
      "UTILITY: did the evidence help?",
    ],
    neutralRerunRationale: "The product generation changed at the readiness seam between M163 and M164. Pairing repaired TRIGGER runs against historical NEUTRAL would confound the treatment with time, model, runtime and harness-generation drift. Both arms run in one execution window.",
    firstCallStatuses: [
      "VALID_NONEMPTY", "VALID_EMPTY", "INVALID_REQUEST", "REPO_NOT_READY", "TOOL_ERROR", "TRIGGER_NOT_COMPLIED",
    ],
    evidenceAccounting: {
      rule: "repo_not_ready is never converted to empty evidence. Refusal and error text is counted separately from repository evidence and never enters an evidence-token total.",
      analyzerGate: "USED_AS_ORIENTATION / IGNORED / DISAGREED_AND_RECOVERED / ANCHORED_INCORRECTLY / evidence quality are computed only when evidenceDelivered is true.",
    },
    triggerComplianceRule: "get_code_context must be the first REPOSITORY action. Runtime/schema-loader events that touch no repository state are permitted before it and are reported explicitly rather than elided.",
    stopCondition: "If the repaired readiness seam systematically fails again across live runs, stop and report rather than interpreting utility. A legitimately weak or wrong VTRACE answer is a result, not a stop condition.",
    rerunPolicy: {
      allowed: ["network/API infrastructure failure", "agent process crash unrelated to behaviour", "workspace corruption", "grader infrastructure failure", "MCP server failing to initialize for infrastructure reasons"],
      forbidden: ["bad patch", "repo_not_ready arising from product behaviour", "weak or wrong VTRACE evidence", "trigger ignored", "malformed tool query produced by the agent", "agent-strategy timeout", "inconvenient grader outcome"],
      originalRecordsPreserved: true,
      selectiveReruns: false,
    },
    tokenDiscipline: "STAGE5_TOKEN_DISCIPLINE OFF on both arms, as in M161/M162/M163. It dictates search and edit policy and would confound the evidence-utility question.",
    productFreeze: {
      readinessRepairFrozenAt: "7dc9385a",
      changedForM164: ["src/mcp/tools.ts: resolveReadyRepoBinding read authority (frozen before the sweep)"],
      unchanged: ["indexing", "retrieval", "ranking", "query interpretation", "context selection", "candidate bounds", "support selection", "tool result rendering", "tool schemas", "tool descriptions", "readiness semantics during the sweep", "policy bytes"],
    },
    spendCap: { liveAgentUsd: 22, arms: 24, authorized: "user, M164-C" },
    policyHashes: { neutralPolicy, taskTrigger },
    policyPreservedFromM163: { neutralPolicy: policyPreserved, taskTrigger: triggerPreserved },
    manifestHash: manifest.manifestHash,
    manifestHashMatchesM163: manifest.manifestHash === m163Protocol.manifestHash,
    scheduleHash,
    caseCount: instanceIds.length,
  };

  writeFileSync(PROTOCOL_OUT, `${JSON.stringify(protocol, null, 2)}\n`);
  writeFileSync(SCHEDULE_OUT, `${JSON.stringify(scheduleReport, null, 2)}\n`);

  process.stdout.write(`neutral policy hash: ${neutralPolicy}\n  preserved from M163: ${policyPreserved}\n`);
  process.stdout.write(`task trigger hash:   ${taskTrigger}\n  preserved from M163: ${triggerPreserved}\n`);
  process.stdout.write(`manifest reused:     ${protocol.manifestHashMatchesM163} (${instanceIds.length} cases)\n`);
  process.stdout.write(`schedule hash:       ${scheduleHash}\n`);
  process.stdout.write(`arms to run:         ${scheduleReport.totalArms}\n`);
  process.stdout.write(`${PROTOCOL_OUT}\n${SCHEDULE_OUT}\n`);

  if (!policyPreserved || !triggerPreserved || !protocol.manifestHashMatchesM163) {
    process.stdout.write("\nFROZEN INPUTS DRIFTED — do not run the sweep.\n");
    process.exitCode = 1;
  }
}

// Guarded: the schedule and arm types are imported by the analysis, and an
// import must never silently re-freeze a protocol that a sweep is running
// against.
if (import.meta.main) main();
