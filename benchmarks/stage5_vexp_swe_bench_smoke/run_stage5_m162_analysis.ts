/**
 * M162-D/E — load the three-arm pilot and produce the architecture comparison.
 *
 * Offline. Reads captured run artifacts only; spawns nothing.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m162_analysis.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  classifyCallableBehaviour, classifyDiscordance, median, vtraceExposure,
  type Arm, type ArmOutcome,
} from "./m162Analysis";
import {
  summarizeRun, type RawToolCall,
} from "./m162Telemetry";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const ARMS: readonly Arm[] = ["baseline", "static", "callable"];
const SCHEMA_TOKENS = 1937;
const POLICY_TOKENS = 128;

function labelFor(arm: Arm, instanceId: string): string {
  return `m162_${arm}_${instanceId.replace(/-/g, "_")}`;
}

function rawDir(arm: Arm, label: string): string {
  return path.join(RESULTS, "runs", label, "raw", arm === "baseline" ? "baseline" : "vtrace");
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
 * Whether the CALLABLE agent was actually offered the tools.
 *
 * Read from the run's OWN init event, never inferred from whether it called
 * them. This is the single field that separates a declined affordance from a
 * treatment failure, and the pilot's first arm was exactly the latter.
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
        return connected && visible.length === 2;
      } catch { /* partial */ }
    }
  }
  return null;
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

function main(): void {
  const manifest = readJson(path.join(RESULTS, "stage5_m162_pilot_manifest.json"));
  const cases = ((manifest?.cases ?? []) as Array<{ instanceId: string; repo: string }>);

  const outcomes: ArmOutcome[] = [];
  const telemetryByTask: Record<string, unknown> = {};

  for (const entry of cases) {
    for (const arm of ARMS) {
      const dir = rawDir(arm, labelFor(arm, entry.instanceId));
      const row = readResultRow(dir);
      const meta = readJson(path.join(dir, "_run.meta.json"));
      const evalMeta = readJson(path.join(dir, "_eval.meta.json"));
      const calls = readOrderedCalls(dir);
      const toolsAvailable = arm === "callable" ? readToolAvailability(dir) : null;

      const telemetry = summarizeRun(calls, {
        toolsAvailable: arm === "callable" && toolsAvailable === true,
        fixedSchemaTokens: arm === "callable" ? SCHEMA_TOKENS : 0,
        fixedPolicyTokens: arm === "callable" ? POLICY_TOKENS : 0,
      });

      const resolvedRaw = row?.resolved ?? evalMeta?.resolvedCount ?? null;
      const resolved = typeof resolvedRaw === "boolean"
        ? resolvedRaw
        : typeof resolvedRaw === "number" ? resolvedRaw > 0 : null;

      outcomes.push({
        arm,
        instanceId: entry.instanceId,
        resolved,
        costUsd: num(row?.costUsd),
        numTurns: num(row?.numTurns),
        inputTokens: num(row?.inputTokens),
        outputTokens: num(row?.outputTokens),
        cacheReadTokens: num(row?.cacheReadTokens),
        cacheCreationTokens: num(row?.cacheCreationTokens),
        durationMs: num(row?.durationMs),
        ordinarySearches: telemetry.navigation.ordinarySearches,
        fileReads: telemetry.navigation.fileReads,
        edits: telemetry.navigation.edits,
        totalOrdinaryToolCalls: telemetry.navigation.totalToolCalls - telemetry.navigation.vtraceCalls,
        vtraceCalls: telemetry.navigation.vtraceCalls,
        firstEditPosition: telemetry.navigation.firstEditPosition,
        staticCapsuleTokens: arm === "static" ? num(meta?.vtraceCapsuleEstimatedTokens) : null,
        toolsAvailable,
        indexBuildMs: num(meta?.vtraceIndexBuildMs ?? meta?.vtraceIndexDurationMs),
      });

      if (arm === "callable") {
        telemetryByTask[entry.instanceId] = {
          toolsAvailable,
          adoption: telemetry.adoption,
          firstCallTiming: telemetry.firstCallTiming,
          callCount: telemetry.calls.length,
          callsBeforeFirstEdit: telemetry.callsBeforeFirstEdit,
          callsAfterFirstEdit: telemetry.callsAfterFirstEdit,
          byTool: telemetry.tokens.byTool,
          resultStateCounts: telemetry.resultStateCounts,
          composition: telemetry.composition,
          utilization: telemetry.utilization,
          redundantLookups: telemetry.redundantLookups,
          dynamicResultTokens: telemetry.tokens.dynamicResultTokens,
          calls: telemetry.calls.map((call) => ({
            sequence: call.sequence, toolId: call.toolId, purpose: call.purpose,
            resultState: call.resultState, itemCount: call.itemCount,
            responseEstimatedTokens: call.responseEstimatedTokens,
            queryLength: call.queryLength, beforeFirstEdit: call.beforeFirstEdit,
            returnedPaths: call.returnedPaths, returnedFqNames: call.returnedFqNames,
          })),
        };
      }
    }
  }

  const byArm = (arm: Arm): ArmOutcome[] => outcomes.filter((entry) => entry.arm === arm);
  const armSummary = (arm: Arm) => {
    const rows = byArm(arm);
    const graded = rows.filter((row) => row.resolved !== null);
    return {
      arm,
      runs: rows.length,
      graded: graded.length,
      resolved: graded.filter((row) => row.resolved === true).length,
      medianCostUsd: median(rows.map((r) => r.costUsd ?? NaN)),
      medianTotalTokens: median(rows.map((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || NaN)),
      medianCacheReadTokens: median(rows.map((r) => r.cacheReadTokens ?? NaN)),
      medianTurns: median(rows.map((r) => r.numTurns ?? NaN)),
      medianOrdinaryToolCalls: median(rows.map((r) => r.totalOrdinaryToolCalls)),
      medianSearches: median(rows.map((r) => r.ordinarySearches)),
      medianReads: median(rows.map((r) => r.fileReads)),
      medianVtraceCalls: median(rows.map((r) => r.vtraceCalls)),
      medianFirstEditPosition: median(rows.map((r) => r.firstEditPosition ?? NaN)),
      medianWallTimeMs: median(rows.map((r) => r.durationMs ?? NaN)),
    };
  };

  const perTask = cases.map((entry) => {
    const get = (arm: Arm) => outcomes.find((row) => row.arm === arm && row.instanceId === entry.instanceId)!;
    const baseline = get("baseline");
    const staticArm = get("static");
    const callable = get("callable");
    const telemetry = telemetryByTask[entry.instanceId] as Record<string, unknown> | undefined;
    const utilization = (telemetry?.utilization ?? []) as Array<{ used: boolean }>;

    return {
      instanceId: entry.instanceId,
      repo: entry.repo,
      resolved: { baseline: baseline.resolved, static: staticArm.resolved, callable: callable.resolved },
      pattern: classifyDiscordance(baseline.resolved, staticArm.resolved, callable.resolved),
      callableBehaviour: classifyCallableBehaviour({
        toolsAvailable: callable.toolsAvailable,
        vtraceCalls: callable.vtraceCalls,
        resultUsedCount: utilization.filter((u) => u.used).length,
        redundantLookupCount: ((telemetry?.redundantLookups ?? []) as unknown[]).length,
        callsAfterFirstEdit: Number(telemetry?.callsAfterFirstEdit ?? 0),
        resolved: callable.resolved,
        baselineResolved: baseline.resolved,
        staticResolved: staticArm.resolved,
      }),
      exposure: {
        baseline: vtraceExposure("baseline", { staticCapsuleTokens: null, schemaTokens: 0, policyTokens: 0, dynamicResultTokens: 0 }),
        static: vtraceExposure("static", { staticCapsuleTokens: staticArm.staticCapsuleTokens, schemaTokens: 0, policyTokens: 0, dynamicResultTokens: 0 }),
        callable: vtraceExposure("callable", {
          staticCapsuleTokens: null, schemaTokens: SCHEMA_TOKENS, policyTokens: POLICY_TOKENS,
          dynamicResultTokens: Number(telemetry?.dynamicResultTokens ?? 0),
        }),
      },
      economics: {
        baseline: { costUsd: baseline.costUsd, tokens: (baseline.inputTokens ?? 0) + (baseline.outputTokens ?? 0), turns: baseline.numTurns },
        static: { costUsd: staticArm.costUsd, tokens: (staticArm.inputTokens ?? 0) + (staticArm.outputTokens ?? 0), turns: staticArm.numTurns },
        callable: { costUsd: callable.costUsd, tokens: (callable.inputTokens ?? 0) + (callable.outputTokens ?? 0), turns: callable.numTurns },
      },
      navigation: {
        baseline: { searches: baseline.ordinarySearches, reads: baseline.fileReads, ordinary: baseline.totalOrdinaryToolCalls, vtrace: 0, firstEdit: baseline.firstEditPosition },
        static: { searches: staticArm.ordinarySearches, reads: staticArm.fileReads, ordinary: staticArm.totalOrdinaryToolCalls, vtrace: 0, firstEdit: staticArm.firstEditPosition },
        callable: { searches: callable.ordinarySearches, reads: callable.fileReads, ordinary: callable.totalOrdinaryToolCalls, vtrace: callable.vtraceCalls, firstEdit: callable.firstEditPosition },
      },
    };
  });

  const callableRows = byArm("callable");
  const adoption = {
    callableTasks: callableRows.length,
    toolsAvailable: callableRows.filter((r) => r.toolsAvailable === true).length,
    toolsUnavailable: callableRows.filter((r) => r.toolsAvailable === false).length,
    tasksWithZeroCalls: callableRows.filter((r) => r.vtraceCalls === 0).length,
    tasksWithOneCall: callableRows.filter((r) => r.vtraceCalls === 1).length,
    tasksWithMultipleCalls: callableRows.filter((r) => r.vtraceCalls > 1).length,
    meanCallsPerTask: callableRows.length === 0 ? 0
      : callableRows.reduce((sum, r) => sum + r.vtraceCalls, 0) / callableRows.length,
    medianCallsPerTask: median(callableRows.map((r) => r.vtraceCalls)),
    byTool: (() => {
      const counts: Record<string, number> = { get_code_context: 0, get_impact_graph: 0 };
      for (const value of Object.values(telemetryByTask)) {
        const byTool = ((value as Record<string, unknown>).byTool ?? {}) as Record<string, { calls: number }>;
        for (const [tool, stats] of Object.entries(byTool)) counts[tool] = (counts[tool] ?? 0) + stats.calls;
      }
      return counts;
    })(),
    compositionEvents: Object.values(telemetryByTask)
      .reduce<number>((sum, value) => sum + (((value as Record<string, unknown>).composition ?? []) as unknown[]).length, 0),
    firstCallTimings: (() => {
      const counts: Record<string, number> = {};
      for (const value of Object.values(telemetryByTask)) {
        const timing = String((value as Record<string, unknown>).firstCallTiming ?? "NEVER_USED");
        counts[timing] = (counts[timing] ?? 0) + 1;
      }
      return counts;
    })(),
  };

  const behaviourCounts: Record<string, number> = {};
  for (const task of perTask) behaviourCounts[task.callableBehaviour] = (behaviourCounts[task.callableBehaviour] ?? 0) + 1;
  const patternCounts: Record<string, number> = {};
  for (const task of perTask) patternCounts[task.pattern] = (patternCounts[task.pattern] ?? 0) + 1;

  const artifacts: Array<[string, unknown]> = [
    ["stage5_m162_three_arm_outcomes.json", {
      armSummaries: ARMS.map(armSummary), perTask, patternCounts,
      discordant: perTask.filter((task) => !["ALL_SUCCESS", "ALL_FAIL"].includes(task.pattern)),
    }],
    ["stage5_m162_tool_usage_summary.json", { adoption, behaviourCounts }],
    ["stage5_m162_tool_calls.json", telemetryByTask],
    ["stage5_m162_token_cost_comparison.json", {
      armSummaries: ARMS.map(armSummary),
      vtraceExposure: {
        staticMedianFixedTokens: median(byArm("static").map((r) => r.staticCapsuleTokens ?? NaN)),
        callableFixedTokens: SCHEMA_TOKENS + POLICY_TOKENS,
        callableMedianDynamicTokens: median(Object.values(telemetryByTask)
          .map((value) => Number((value as Record<string, unknown>).dynamicResultTokens ?? 0))),
        note:
          "CALLABLE's fixed prefix being smaller than STATIC's capsule does not make it cheaper. "
          + "Total exposure is fixed + dynamic, and the end-to-end question is whether sparse, well-timed "
          + "retrieval saves more investigation than it adds.",
      },
      perTask: perTask.map((task) => ({ instanceId: task.instanceId, exposure: task.exposure, economics: task.economics })),
    }],
    ["stage5_m162_navigation_work.json", {
      note: "Components only; no composite score. Fewer greps bought with expensive tool calls is not efficiency.",
      armSummaries: ARMS.map(armSummary),
      perTask: perTask.map((task) => ({ instanceId: task.instanceId, navigation: task.navigation })),
    }],
    ["stage5_m162_unique_wins.json", {
      callableOnly: perTask.filter((t) => t.pattern === "CALLABLE_ONLY_WIN"),
      staticOnly: perTask.filter((t) => t.pattern === "STATIC_ONLY_WIN"),
      baselineOnly: perTask.filter((t) => t.pattern === "BASELINE_ONLY_WIN"),
      vtraceBoth: perTask.filter((t) => t.pattern === "VTRACE_BOTH_WIN"),
    }],
    ["stage5_m162_unique_losses.json", {
      callableOnly: perTask.filter((t) => t.pattern === "CALLABLE_ONLY_LOSS"),
      staticOnly: perTask.filter((t) => t.pattern === "STATIC_ONLY_LOSS"),
      baselineOnly: perTask.filter((t) => t.pattern === "BASELINE_ONLY_LOSS"),
    }],
    ["stage5_m162_grades.json", {
      productSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      outcomes,
    }],
  ];

  mkdirSync(RESULTS, { recursive: true });
  for (const [name, value] of artifacts) {
    writeFileSync(path.join(RESULTS, name), `${JSON.stringify({ schemaVersion: 1, milestone: "M162", workstream: "D", ...(value as object) }, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    armSummaries: ARMS.map(armSummary), patternCounts, behaviourCounts, adoption,
  }, null, 2));
}

main();
