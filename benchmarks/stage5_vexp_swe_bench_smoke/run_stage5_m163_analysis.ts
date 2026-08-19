/**
 * M163-D — load the three-arm policy ablation and produce the adoption and
 * conditional-utility analysis.
 *
 * Offline. Reads captured run artifacts only; spawns nothing.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m163_analysis.ts
 *
 * Safe to run against a PARTIAL sweep. Arms with no result row are NOT_RUN and
 * enter no aggregate, no denominator and no median. That is asserted by
 * m163Adoption.test.ts rather than assumed here.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { summarizeRun, type RawToolCall, type VtraceCallRecord } from "./m162Telemetry";
import {
  adoptionRate, aggregate, classifyAdoption, classifyTriggerCompliance,
  pairedDeltas, summarizePairedDeltas, tokenTraffic, triggerComplianceRate,
  type M163AdoptionState, type M163TriggerState,
} from "./m163Adoption";
import {
  classifyAgentReaction, classifyEvidenceQuality, classifyPairedOutcome, classifyQueryEvidence,
  detectFalseAuthority, findFalseAbsenceCandidates,
} from "./m163Analysis";
import { frozenCallableMcpToolNames } from "./m162Callable";
import { M163_ARMS, sha256, type M163Arm } from "./m163Policy";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

/** M162 measured these on the same two-tool surface; the schemas are unchanged. */
const SCHEMA_TOKENS = 1937;
const POLICY_TOKENS = 128;

const ARM_LABELS: Readonly<Record<M163Arm, string>> = Object.freeze({
  tools_only: "TOOLS_ONLY",
  tools_neutral_policy: "TOOLS_NEUTRAL_POLICY",
  tools_task_trigger: "TOOLS_TASK_TRIGGER",
});

function labelFor(arm: M163Arm, instanceId: string): string {
  return `m163_${arm}_${instanceId.replace(/-/g, "_")}`;
}

function rawDir(label: string): string {
  return path.join(RESULTS, "runs", label, "raw", "vtrace");
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return null; }
}

function readResultRow(dir: string): Record<string, unknown> | null {
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((name) => name.startsWith("swebench-") && name.endsWith(".jsonl"));
  if (file === undefined) return null;
  const lines = readFileSync(path.join(dir, file), "utf8").split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try { return JSON.parse(last) as Record<string, unknown>; } catch { return null; }
}

/**
 * Tool availability from the run's OWN init event.
 *
 * Never inferred from the driver's configuration and never from whether any call
 * appears. M162's pilot produced an untooled arm that was indistinguishable from
 * zero adoption in every other field; this is the only field that separated them.
 * `null` means the evidence could not be read, which is INVALID, not zero.
 */
function readToolAvailability(dir: string): boolean | null {
  for (const name of ["_agent_stream.first_pass.jsonl", "_agent_stream.jsonl"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== "system" || event.subtype !== "init") continue;
        const servers = (event.mcp_servers ?? []) as Array<{ name?: string; status?: string }>;
        const tools = ((event.tools ?? []) as unknown[]).filter((t): t is string => typeof t === "string");
        const connected = servers.some((s) => s.name === "vtrace" && s.status === "connected");
        const visible = tools.filter((t) => t.toLowerCase().includes("vtrace"));
        return connected && visible.length === frozenCallableMcpToolNames().length;
      } catch { /* partial line */ }
    }
  }
  return null;
}

function readObservedToolNames(dir: string): readonly string[] {
  for (const name of ["_agent_stream.first_pass.jsonl", "_agent_stream.jsonl"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== "system" || event.subtype !== "init") continue;
        return ((event.tools ?? []) as unknown[])
          .filter((t): t is string => typeof t === "string")
          .filter((t) => t.toLowerCase().includes("vtrace"));
      } catch { /* partial */ }
    }
  }
  return [];
}

function readAssistantText(dir: string): string {
  const parts: string[] = [];
  for (const name of ["_agent_stream.first_pass.jsonl", "_agent_stream.jsonl"]) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const message = event.message as { content?: unknown[] } | undefined;
        for (const block of Array.isArray(message?.content) ? message.content : []) {
          if (block === null || typeof block !== "object") continue;
          const record = block as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
          if (record.type === "thinking" && typeof record.thinking === "string") parts.push(record.thinking);
        }
      } catch { /* partial */ }
    }
    if (parts.length > 0) break;
  }
  return parts.join("\n");
}

function readOrderedCalls(dir: string): RawToolCall[] {
  for (const name of ["_tool_calls_with_outputs.json", "_tool_calls.json"]) {
    const parsed = readJson(path.join(dir, name));
    if (parsed === null) continue;
    const raw = Array.isArray(parsed) ? parsed : (parsed.calls ?? parsed.toolCalls ?? []);
    if (Array.isArray(raw)) return raw as RawToolCall[];
  }
  return [];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ArmRecord {
  readonly arm: M163Arm;
  readonly armLabel: string;
  readonly instanceId: string;
  readonly repo: string;
  readonly executed: boolean;
  readonly adoption: M163AdoptionState;
  readonly triggerState: M163TriggerState;
  readonly [key: string]: unknown;
}

function main(): void {
  const manifest = readJson(path.join(RESULTS, "stage5_m163_manifest.json"));
  const cases = (manifest?.cases ?? []) as Array<{
    instanceId: string; repo: string; expectedFiles?: string[];
  }>;
  const dataset = path.join(RESULTS, "_m160_corpus", "swe_bench_verified.jsonl");
  const taskTextById = new Map<string, string>();
  if (existsSync(dataset)) {
    for (const line of readFileSync(dataset, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const row = JSON.parse(line) as { instance_id?: string; problem_statement?: string };
        if (typeof row.instance_id === "string" && typeof row.problem_statement === "string") {
          taskTextById.set(row.instance_id, row.problem_statement);
        }
      } catch { /* skip */ }
    }
  }

  const records: ArmRecord[] = [];

  for (const entry of cases) {
    const goldFiles = entry.expectedFiles ?? [];
    const taskText = taskTextById.get(entry.instanceId) ?? "";

    for (const arm of M163_ARMS) {
      const label = labelFor(arm, entry.instanceId);
      const dir = rawDir(label);
      const row = readResultRow(dir);
      const meta = readJson(path.join(dir, "_run.meta.json"));
      const evalMeta = readJson(path.join(dir, "_eval.meta.json"));
      const calls = readOrderedCalls(dir);
      const executed = row !== null;
      const toolsAvailable = executed ? readToolAvailability(dir) : null;

      // A trigger arm whose treatment did not reach the prompt is INVALID, not
      // non-compliance: it silently became the neutral arm.
      const triggerDelivered = meta?.stage5M163TriggerInjected === true;
      const triggerMissing = meta?.stage5M163TriggerMissing === true;
      const treatmentFailure = executed
        && ((arm === "tools_task_trigger" && (!triggerDelivered || triggerMissing))
          || (arm !== "tools_task_trigger" && triggerDelivered));

      const telemetry = summarizeRun(calls, {
        toolsAvailable: toolsAvailable === true,
        fixedSchemaTokens: SCHEMA_TOKENS,
        fixedPolicyTokens: arm === "tools_only" ? 0 : POLICY_TOKENS,
      });

      const adoption = classifyAdoption({
        executed,
        toolsAvailable,
        vtraceCallCount: telemetry.calls.length,
        treatmentFailure,
      });
      const compliance = classifyTriggerCompliance(calls, {
        isTriggerArm: arm === "tools_task_trigger",
        adoption,
      });

      // Grading. An empty patch is unresolvable by definition and the grader
      // declines to run on one, leaving `resolved` null; recording that as
      // ungraded would drop the task from the denominator. The rule is applied
      // per arm on the same condition, so it cannot favour one.
      const resolvedRaw = row?.resolved ?? evalMeta?.resolvedCount ?? null;
      let resolved = typeof resolvedRaw === "boolean"
        ? resolvedRaw
        : typeof resolvedRaw === "number" ? resolvedRaw > 0 : null;
      const emptyPatch = row !== null
        && (typeof row.modelPatch !== "string" || row.modelPatch.trim().length === 0);
      if (resolved === null && emptyPatch) resolved = false;

      const first: VtraceCallRecord | undefined = telemetry.calls[0];
      const quality = first === undefined ? null : classifyEvidenceQuality(first, goldFiles);
      const queryAlignment = first === undefined || quality === null
        ? null
        : classifyQueryEvidence(String(first.args.task ?? first.args.query ?? ""), taskText, quality);
      const reaction = first === undefined || quality === null
        ? null
        : classifyAgentReaction(calls, telemetry.calls, resolved, quality);
      const falseAuthority = reaction === null || quality === null
        ? null
        : detectFalseAuthority(reaction, quality);
      const falseAbsence = adoption === "AVAILABLE_USED"
        ? findFalseAbsenceCandidates(readAssistantText(dir))
        : [];

      const traffic = tokenTraffic({
        inputTokens: num(row?.inputTokens),
        cacheReadTokens: num(row?.cacheReadTokens),
        cacheCreationTokens: num(row?.cacheCreationTokens),
        outputTokens: num(row?.outputTokens),
      });

      records.push({
        arm,
        armLabel: ARM_LABELS[arm],
        instanceId: entry.instanceId,
        repo: entry.repo,
        runLabel: label,
        executed,
        adoption,
        triggerState: compliance.state,
        triggerCompliance: compliance,
        treatmentFailure,
        triggerDelivered,
        triggerMissing,
        availability: {
          toolsAvailable,
          observedToolNames: readObservedToolNames(dir),
          expectedToolNames: frozenCallableMcpToolNames(),
        },
        resolved,
        emptyPatch,
        costUsd: num(row?.costUsd),
        numTurns: num(row?.numTurns),
        durationMs: num(row?.durationMs),
        tokens: traffic,
        vtraceCallCount: telemetry.calls.length,
        requiredInitialCalls: arm === "tools_task_trigger" && compliance.state === "TRIGGER_COMPLIED" ? 1 : 0,
        voluntaryFollowUpCalls: Math.max(0, telemetry.calls.length
          - (arm === "tools_task_trigger" && compliance.state === "TRIGGER_COMPLIED" ? 1 : 0)),
        firstCallTiming: telemetry.firstCallTiming,
        navigation: telemetry.navigation,
        vtraceTokens: telemetry.tokens,
        composition: telemetry.composition,
        utilization: telemetry.utilization,
        firstCallEvidence: quality,
        queryAlignment,
        agentReaction: reaction,
        falseAuthority,
        falseAbsenceCandidates: falseAbsence,
        vtraceCalls: telemetry.calls.map((call) => ({
          sequence: call.sequence,
          toolId: call.toolId,
          purpose: call.purpose,
          resultState: call.resultState,
          itemCount: call.itemCount,
          responseEstimatedTokens: call.responseEstimatedTokens,
          returnedPaths: call.returnedPaths,
          query: String(call.args.task ?? call.args.query ?? call.args.symbol_fqn ?? ""),
        })),
      });
    }
  }

  const byArm = (arm: M163Arm): ArmRecord[] => records.filter((record) => record.arm === arm);
  const mapOf = (arm: M163Arm, key: string): Map<string, number | null> =>
    new Map(byArm(arm).map((record) => [record.instanceId, (record[key] as number | null) ?? null]));
  const trafficMap = (arm: M163Arm): Map<string, number | null> =>
    new Map(byArm(arm).map((record) =>
      [record.instanceId, (record.tokens as { totalModelTraffic: number | null }).totalModelTraffic]));

  const instanceIds = cases.map((entry) => entry.instanceId);

  const adoptionTable = M163_ARMS.map((arm) => {
    const arms = byArm(arm);
    const rate = adoptionRate(arms.map((record) => record.adoption));
    const used = arms.filter((record) => record.adoption === "AVAILABLE_USED");
    return {
      arm: ARM_LABELS[arm],
      ...rate,
      firstCallMedianIndex: aggregate(used.map((record) =>
        (record.triggerCompliance as { firstVtraceCallIndex: number | null }).firstVtraceCallIndex)).median,
      tasksWithVoluntaryFollowUp: used.filter((record) => (record.voluntaryFollowUpCalls as number) > 0).length,
      totalVtraceCalls: arms.reduce((sum, record) => sum + (record.vtraceCallCount as number), 0),
    };
  });

  const solveTable = M163_ARMS.map((arm) => {
    const arms = byArm(arm).filter((record) => record.executed && record.adoption !== "INVALID");
    const gradable = arms.filter((record) => record.resolved !== null);
    return {
      arm: ARM_LABELS[arm],
      resolved: gradable.filter((record) => record.resolved === true).length,
      validRuns: arms.length,
      gradedRuns: gradable.length,
      ungraded: arms.length - gradable.length,
      notRun: byArm(arm).filter((record) => record.adoption === "NOT_RUN").length,
    };
  });

  const efficiencyTable = M163_ARMS.map((arm) => {
    const arms = byArm(arm).filter((record) => record.executed);
    const nav = (key: string) => aggregate(arms.map((record) =>
      (record.navigation as Record<string, number>)[key] ?? null));
    return {
      arm: ARM_LABELS[arm],
      runs: arms.length,
      turns: aggregate(arms.map((record) => record.numTurns as number | null)),
      costUsd: aggregate(arms.map((record) => record.costUsd as number | null)),
      totalModelTraffic: aggregate(arms.map((record) =>
        (record.tokens as { totalModelTraffic: number | null }).totalModelTraffic)),
      cacheReadTokens: aggregate(arms.map((record) =>
        (record.tokens as { cacheReadTokens: number | null }).cacheReadTokens)),
      outputTokens: aggregate(arms.map((record) =>
        (record.tokens as { outputTokens: number | null }).outputTokens)),
      wallMs: aggregate(arms.map((record) => record.durationMs as number | null)),
      ordinarySearches: nav("ordinarySearches"),
      fileReads: nav("fileReads"),
      ordinaryToolCalls: nav("totalToolCalls"),
      firstEditPosition: nav("firstEditPosition"),
    };
  });

  const pairedMetric = (key: string, lowerIsBetter: boolean) => {
    const deltas = pairedDeltas(instanceIds, mapOf("tools_neutral_policy", key), mapOf("tools_task_trigger", key));
    return { metric: key, ...summarizePairedDeltas(deltas, { lowerIsBetter }), deltas };
  };
  const trafficDeltas = pairedDeltas(instanceIds, trafficMap("tools_neutral_policy"), trafficMap("tools_task_trigger"));

  const navMap = (arm: M163Arm, key: string): Map<string, number | null> =>
    new Map(byArm(arm).map((record) =>
      [record.instanceId, (record.navigation as Record<string, number>)[key] ?? null]));
  const pairedNav = (key: string) => {
    const deltas = pairedDeltas(instanceIds, navMap("tools_neutral_policy", key), navMap("tools_task_trigger", key));
    return { metric: key, ...summarizePairedDeltas(deltas, { lowerIsBetter: true }), deltas };
  };

  const outcomeMatrix = instanceIds.map((instanceId) => {
    const b = byArm("tools_neutral_policy").find((record) => record.instanceId === instanceId);
    const c = byArm("tools_task_trigger").find((record) => record.instanceId === instanceId);
    return {
      instanceId,
      neutral: b?.resolved ?? null,
      trigger: c?.resolved ?? null,
      outcome: classifyPairedOutcome(b?.resolved as boolean | null ?? null, c?.resolved as boolean | null ?? null),
    };
  });

  const complianceRate = triggerComplianceRate(records.map((record) => record.triggerState));

  const artifact = {
    schemaVersion: 1,
    milestone: "M163",
    workstream: "D",
    title: "M163 adoption and conditional-utility analysis",
    generatedFrom: {
      manifest: "stage5_m163_manifest.json",
      manifestHash: manifest?.manifestHash ?? null,
      caseCount: cases.length,
      armsExpected: cases.length * M163_ARMS.length,
      armsExecuted: records.filter((record) => record.executed).length,
    },
    completeness: {
      completed: `${records.filter((record) => record.executed).length} / ${cases.length * M163_ARMS.length}`,
      notRun: records.filter((record) => record.adoption === "NOT_RUN").length,
      invalid: records.filter((record) => record.adoption === "INVALID").length,
      rule: "NOT_RUN and INVALID arms enter no aggregate, no median and no denominator.",
    },
    adoptionTable,
    adoptionDenominatorRule: "AVAILABLE_USED / (AVAILABLE_USED + AVAILABLE_UNUSED)",
    triggerCompliance: complianceRate,
    triggerComplianceDenominatorRule: "TRIGGER_COMPLIED / valid trigger-arm runs with tools available",
    solveTable,
    efficiencyTable,
    pairedNeutralToTrigger: {
      note: "Per-task paired deltas, NEUTRAL -> TRIGGER. A pair with either side absent is incomparable, never 0.",
      resolvedMatrix: outcomeMatrix,
      turns: pairedMetric("numTurns", true),
      costUsd: pairedMetric("costUsd", true),
      wallMs: pairedMetric("durationMs", true),
      totalModelTraffic: {
        metric: "totalModelTraffic",
        ...summarizePairedDeltas(trafficDeltas, { lowerIsBetter: true }),
        deltas: trafficDeltas,
      },
      ordinaryToolCalls: pairedNav("totalToolCalls"),
      ordinarySearches: pairedNav("ordinarySearches"),
      fileReads: pairedNav("fileReads"),
      firstEditPosition: pairedNav("firstEditPosition"),
    },
    tokenEconomics: M163_ARMS.map((arm) => {
      const arms = byArm(arm).filter((record) => record.executed);
      const vt = (key: string) => aggregate(arms.map((record) =>
        (record.vtraceTokens as Record<string, number>)[key] ?? null));
      return {
        arm: ARM_LABELS[arm],
        fixedSchemaTokens: SCHEMA_TOKENS,
        fixedPolicyTokens: arm === "tools_only" ? 0 : POLICY_TOKENS,
        dynamicEvidenceTokens: vt("dynamicResultTokens"),
        totalVtraceContextExposure: vt("totalVtraceContextExposure"),
        note: "Fixed and dynamic are separated because which dominates IS the hypothesis.",
      };
    }),
    evidenceUse: {
      requiredFirstCalls: byArm("tools_task_trigger")
        .filter((record) => record.triggerState === "TRIGGER_COMPLIED").length,
      byTier: Object.fromEntries(["GOLD_LED", "GOLD_PRESENT", "GOLD_ABSENT", "EMPTY", "ERROR"].map((tier) => [
        tier,
        byArm("tools_task_trigger")
          .filter((record) => (record.firstCallEvidence as { tier?: string } | null)?.tier === tier).length,
      ])),
      byQueryClass: Object.fromEntries([
        "RIGHT_QUERY_RIGHT_EVIDENCE", "RIGHT_QUERY_PARTIAL_EVIDENCE",
        "RIGHT_QUERY_WRONG_EVIDENCE", "QUERY_ITSELF_MISALIGNED",
      ].map((cls) => [
        cls,
        byArm("tools_task_trigger")
          .filter((record) => (record.queryAlignment as { classification?: string } | null)?.classification === cls).length,
      ])),
      byReaction: Object.fromEntries([
        "USED_AS_ORIENTATION", "VERIFIED_WITH_NORMAL_TOOLS", "IGNORED",
        "DISAGREED_AND_RECOVERED", "ANCHORED_INCORRECTLY", "REQUESTED_FOLLOWUP_VTRACE",
      ].map((label) => [
        label,
        byArm("tools_task_trigger")
          .filter((record) => ((record.agentReaction as { labels?: string[] } | null)?.labels ?? []).includes(label)).length,
      ])),
      falseAuthorityDetected: byArm("tools_task_trigger")
        .filter((record) => (record.falseAuthority as { detected?: boolean } | null)?.detected === true)
        .map((record) => record.instanceId),
      falseAbsenceCandidates: records
        .filter((record) => (record.falseAbsenceCandidates as unknown[]).length > 0)
        .map((record) => ({
          instanceId: record.instanceId,
          arm: record.armLabel,
          candidates: record.falseAbsenceCandidates,
        })),
    },
    runs: records,
  };

  writeFileSync(path.join(RESULTS, "stage5_m163_runs.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    completed: artifact.completeness.completed,
    adoption: adoptionTable.map((row) => `${row.arm}: ${row.used}/${row.denominator}`),
    triggerCompliance: `${complianceRate.complied}/${complianceRate.denominator}`,
    resolved: solveTable.map((row) => `${row.arm}: ${row.resolved}/${row.gradedRuns}`),
  }, null, 2)}\n`);
}

main();
