/**
 * M164-D — the conditional-utility analysis.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m164_analysis.ts
 *
 * Three transitions, kept apart from first to last, because M163 collapsed them
 * once and produced a confident wrong reading:
 *
 *   ADOPTION       did the trigger still cause calls?
 *   ANSWERABILITY  did those calls return real repository evidence?
 *   UTILITY        did the evidence help?
 *
 * Every quality, reaction and gold-relation label is gated on
 * `evidenceDelivered`. Refusal text is counted in its own column and never
 * enters a repository-evidence total. A missing arm contributes null, never
 * zero, and every aggregate names the denominator it used.
 *
 * The artifact readers below are ported from M163's CORRECTED readers — the
 * three that were fixed during M163-D, in particular reading the tool query from
 * the harness's own `query` field rather than the always-null `args`. They are
 * duplicated rather than imported because M163's analysis script runs its own
 * `main()` on import; the ported semantics are pinned by
 * `run_stage5_m164_analysis.test.ts`.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  classifyAgentReaction,
  classifyEvidenceQuality,
  classifyQueryEvidence,
  detectFalseAuthority,
  findFalseAbsenceCandidates,
} from "./m163Analysis";
import {
  classifyFirstCall,
  classifySolve,
  pairedDelta,
  splitCalls,
  summarizeDeltas,
  type FirstCallStatus,
  type PairedDelta,
} from "./m164Analysis";
import { frozenCallableMcpToolNames } from "./m162Callable";
import { tokenTraffic } from "./m163Adoption";
import { summarizeRun, type VtraceCallRecord } from "./m162Telemetry";
import { M164_ARMS, type M164Arm } from "./run_stage5_m164_protocol";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

const ARM_LABELS: Record<M164Arm, string> = {
  tools_neutral_policy: "TOOLS_NEUTRAL_POLICY",
  tools_task_trigger: "TOOLS_TASK_TRIGGER",
};

function labelFor(arm: M164Arm, instanceId: string): string {
  return `m164_${arm}_${instanceId.replace(/-/g, "_")}`;
}

function rawDir(label: string): string {
  return path.join(RESULTS, "runs", label, "raw", "vtrace");
}

function readJson(file: string): Record<string, any> | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, any>; } catch { return null; }
}

function readResultRow(dir: string): Record<string, any> | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("swebench-") || !name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try { return JSON.parse(line) as Record<string, any>; } catch { /* next */ }
    }
  }
  return null;
}

function streamLines(dir: string): string[] {
  for (const name of ["_agent_stream.first_pass.jsonl", "_agent_stream.jsonl"]) {
    const file = path.join(dir, name);
    if (existsSync(file)) return readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
  }
  return [];
}

/** Availability proven from the run's own init event, never from driver config. */
function readToolAvailability(dir: string): boolean | null {
  const lines = streamLines(dir);
  if (lines.length === 0) return null;
  const expected = frozenCallableMcpToolNames();
  for (const line of lines) {
    if (!/mcp__vtrace__/.test(line)) continue;
    if (expected.every((name) => line.includes(name))) return true;
  }
  return false;
}

function readObservedToolNames(dir: string): string[] {
  const names = new Set<string>();
  for (const line of streamLines(dir)) {
    for (const match of line.matchAll(/mcp__vtrace__[a-z_]+/g)) names.add(match[0]);
  }
  return [...names].sort();
}

function readAssistantText(dir: string): string {
  const parts: string[] = [];
  for (const line of streamLines(dir)) {
    try {
      const row = JSON.parse(line) as Record<string, any>;
      const content = row?.message?.content ?? row?.content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) if (typeof block?.text === "string") parts.push(block.text);
      }
    } catch { /* skip */ }
  }
  return parts.join("\n");
}

interface RawToolCall { tool?: unknown; output?: unknown; query?: unknown; args?: unknown; category?: unknown }

function readOrderedCalls(dir: string): RawToolCall[] {
  for (const name of ["_tool_calls_with_outputs.json", "_tool_calls.json"]) {
    const parsed = readJson(path.join(dir, name));
    if (parsed === null) continue;
    const raw = Array.isArray(parsed) ? parsed : (parsed["calls"] ?? parsed["toolCalls"] ?? []);
    if (Array.isArray(raw)) return raw as RawToolCall[];
  }
  return [];
}

/**
 * The query the agent actually sent.
 *
 * M163-D's correction: the harness records MCP tool inputs in its own `query`
 * field and leaves `args` null, so reading `args` alone scored every query as
 * empty and therefore misaligned — a finding about the capture format, not the
 * agent.
 */
export function queryOf(call: RawToolCall | undefined, record: VtraceCallRecord | undefined): string {
  // Most authoritative first: the query as the PRODUCT received it, echoed back
  // in the response envelope. M164 found the harness writing the literal "None"
  // into its own `query` column for MCP calls, so both of M163's sources are
  // silent here and reading only them would score every query empty — the same
  // class of capture-format artefact M163-D had to retract labels over.
  const text = typeof call?.output === "string" ? call.output : JSON.stringify(call?.output ?? "");
  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text) as Record<string, any>;
      const echoed = parsed?.["result"]?.output?.request?.query ?? parsed?.["result"]?.output?.request?.task;
      if (typeof echoed === "string" && echoed.length > 0) return echoed;
    } catch {
      // The harness TRUNCATES large tool outputs, so the envelope is often not
      // parseable JSON at all — 8182 characters ending mid-string is the common
      // shape. The echoed query sits near the front of the payload and survives
      // the truncation, so it is recovered textually. Without this the query
      // reads as empty on every large result, which would be reported as the
      // agent asking nothing.
      const match = /"request"\s*:\s*\{\s*"query"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      if (match?.[1] !== undefined) {
        try { return JSON.parse(`"${match[1]}"`) as string; } catch { return match[1]; }
      }
    }
  }
  const fromArgs = String((record?.args as Record<string, unknown> | undefined)?.["task"]
    ?? (record?.args as Record<string, unknown> | undefined)?.["query"] ?? "");
  if (fromArgs.length > 0 && fromArgs !== "undefined") return fromArgs;
  const raw = call?.query;
  return typeof raw === "string" && raw !== "None" ? raw : "";
}

function isVtraceCall(call: RawToolCall): boolean {
  return /vtrace/i.test(String(call.tool ?? ""));
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countCategory(calls: readonly RawToolCall[], predicate: (tool: string, category: string) => boolean): number {
  return calls.filter((call) => predicate(String(call.tool ?? "").toLowerCase(), String(call.category ?? "").toLowerCase())).length;
}

interface ArmRecord {
  readonly arm: M164Arm;
  readonly armLabel: string;
  readonly instanceId: string;
  readonly repo: string;
  readonly runLabel: string;
  readonly executed: boolean;
  readonly [key: string]: unknown;
}

function main(): void {
  const manifest = readJson(path.join(RESULTS, "stage5_m163_manifest.json"));
  const cases = (manifest?.["cases"] ?? []) as Array<{ instanceId: string; repo: string; expectedFiles?: string[] }>;

  const taskTextById = new Map<string, string>();
  if (existsSync(CORPUS)) {
    for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
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

    for (const arm of M164_ARMS) {
      const label = labelFor(arm, entry.instanceId);
      const dir = rawDir(label);
      const row = readResultRow(dir);
      const meta = readJson(path.join(dir, "_run.meta.json"));
      const evalMeta = readJson(path.join(dir, "_eval.meta.json"));
      const calls = readOrderedCalls(dir);
      const executed = row !== null;
      const toolsAvailable = executed ? readToolAvailability(dir) : null;
      const isTriggerArm = arm === "tools_task_trigger";

      // A trigger arm whose treatment never reached the prompt is INVALID, not
      // non-compliant: it silently became the neutral arm.
      const triggerDelivered = meta?.["stage5M163TriggerInjected"] === true;
      const triggerMissing = meta?.["stage5M163TriggerMissing"] === true;
      const treatmentFailure = executed
        && ((isTriggerArm && (!triggerDelivered || triggerMissing)) || (!isTriggerArm && triggerDelivered));

      const telemetry = summarizeRun(calls as never, {
        toolsAvailable: toolsAvailable === true,
        fixedSchemaTokens: 0,
        fixedPolicyTokens: 0,
      });
      const vtraceCalls = calls.filter(isVtraceCall);
      const firstRawCall = vtraceCalls[0];
      const first: VtraceCallRecord | undefined = telemetry.calls[0];

      const firstCall = classifyFirstCall({
        triggerServed: isTriggerArm && triggerDelivered,
        toolsAvailable: toolsAvailable === true,
        callMade: vtraceCalls.length > 0,
        rawOutput: firstRawCall?.output ?? null,
      });

      // Every VTRACE call in the run, classified the same way, so voluntary
      // follow-ups are separable from the one the trigger mandated.
      const allStatuses: FirstCallStatus[] = vtraceCalls.map((call) => classifyFirstCall({
        triggerServed: isTriggerArm && triggerDelivered,
        toolsAvailable: toolsAvailable === true,
        callMade: true,
        rawOutput: call.output ?? null,
      }).status);
      const callSplit = splitCalls(allStatuses);

      // Grading. An empty patch is unresolvable by definition and the grader
      // declines to run on one, leaving `resolved` null; recording that as
      // ungraded would drop the task from the denominator. Applied per arm on
      // the same condition, so it cannot favour one.
      const resolvedRaw = row?.["resolved"] ?? evalMeta?.["resolvedCount"] ?? null;
      let resolved = typeof resolvedRaw === "boolean"
        ? resolvedRaw
        : typeof resolvedRaw === "number" ? resolvedRaw > 0 : null;
      const emptyPatch = row !== null && (typeof row["modelPatch"] !== "string" || String(row["modelPatch"]).trim().length === 0);
      if (resolved === null && emptyPatch) resolved = false;

      // THE GATE. Nothing below runs on a refusal.
      const eligible = firstCall.evidenceDelivered && first !== undefined;
      const quality = eligible ? classifyEvidenceQuality(first!, goldFiles, { productDeclined: false }) : null;
      const queryText = queryOf(firstRawCall, first);
      const queryAlignment = eligible && quality !== null ? classifyQueryEvidence(queryText, taskText, quality) : null;
      const reaction = eligible && quality !== null ? classifyAgentReaction(calls as never, telemetry.calls, resolved, quality) : null;
      const falseAuthority = reaction !== null && quality !== null ? detectFalseAuthority(reaction, quality) : null;
      const falseAbsence = eligible ? findFalseAbsenceCandidates(readAssistantText(dir)) : [];

      const traffic = tokenTraffic({
        inputTokens: num(row?.["inputTokens"]),
        cacheReadTokens: num(row?.["cacheReadTokens"]),
        cacheCreationTokens: num(row?.["cacheCreationTokens"]),
        outputTokens: num(row?.["outputTokens"]),
      });

      const ordinaryCalls = calls.filter((call) => !isVtraceCall(call));
      const firstEditIndex = calls.findIndex((call) => String(call.category ?? "").toLowerCase() === "edit");

      records.push({
        arm,
        armLabel: ARM_LABELS[arm],
        instanceId: entry.instanceId,
        repo: entry.repo,
        runLabel: label,
        executed,
        availability: {
          toolsAvailable,
          observedToolNames: readObservedToolNames(dir),
          expectedToolNames: frozenCallableMcpToolNames(),
          provenFromRunInitEvent: true,
        },
        triggerDelivered,
        triggerMissing,
        treatmentFailure,
        firstCall: {
          status: firstCall.status,
          evidenceDelivered: firstCall.evidenceDelivered,
          evidenceCharacters: firstCall.evidenceCharacters,
          refusalCharacters: firstCall.refusalCharacters,
          returnedPaths: firstCall.returnedPaths,
          detail: firstCall.detail,
          query: queryText,
          queryChars: queryText.length,
        },
        vtraceCalls: { total: vtraceCalls.length, statuses: allStatuses, ...callSplit },
        analyzerEligible: eligible,
        evidenceQuality: quality,
        queryAlignment,
        agentReaction: reaction,
        falseAuthority,
        falseAbsenceCandidates: falseAbsence,
        resolved,
        emptyPatch,
        metrics: {
          turns: num(row?.["numTurns"]),
          ordinaryCalls: executed ? ordinaryCalls.length : null,
          searches: executed ? countCategory(ordinaryCalls, (tool, cat) => cat === "search" || /grep|glob|search/.test(tool)) : null,
          reads: executed ? countCategory(ordinaryCalls, (tool, cat) => cat === "read" || /^read$/.test(tool)) : null,
          tests: executed ? countCategory(ordinaryCalls, (tool) => /pytest|test/.test(tool)) : null,
          firstEditTurn: firstEditIndex === -1 ? null : firstEditIndex + 1,
          wallTimeMs: num(row?.["durationMs"]) ?? num(row?.["wallTimeMs"]),
          costUsd: num(row?.["costUsd"]),
        },
        tokens: {
          inputTokens: num(row?.["inputTokens"]),
          cacheReadTokens: num(row?.["cacheReadTokens"]),
          cacheCreationTokens: num(row?.["cacheCreationTokens"]),
          outputTokens: num(row?.["outputTokens"]),
          totalModelTraffic: traffic.totalModelTraffic,
        },
      });
    }
  }

  // ---- pairing -------------------------------------------------------------

  const byInstance = new Map<string, Partial<Record<M164Arm, ArmRecord>>>();
  for (const record of records) {
    const bucket = byInstance.get(record.instanceId) ?? {};
    bucket[record.arm] = record;
    byInstance.set(record.instanceId, bucket);
  }

  const METRICS = ["turns", "ordinaryCalls", "searches", "reads", "firstEditTurn", "wallTimeMs", "costUsd"] as const;
  const deltas: PairedDelta[] = [];
  const solveMatrix: Record<string, string> = {};

  for (const [instanceId, pair] of byInstance) {
    const neutral = pair.tools_neutral_policy;
    const trigger = pair.tools_task_trigger;
    solveMatrix[instanceId] = classifySolve(
      (neutral?.resolved as boolean | null) ?? null,
      (trigger?.resolved as boolean | null) ?? null,
    );
    for (const metric of METRICS) {
      deltas.push(pairedDelta(
        instanceId,
        metric,
        ((neutral?.metrics as Record<string, number | null> | undefined)?.[metric]) ?? null,
        ((trigger?.metrics as Record<string, number | null> | undefined)?.[metric]) ?? null,
      ));
    }
    deltas.push(pairedDelta(
      instanceId,
      "totalModelTraffic",
      ((neutral?.tokens as Record<string, number | null> | undefined)?.["totalModelTraffic"]) ?? null,
      ((trigger?.tokens as Record<string, number | null> | undefined)?.["totalModelTraffic"]) ?? null,
    ));
  }

  const deltaSummaries = [...METRICS, "totalModelTraffic"].map((metric) =>
    summarizeDeltas(metric, deltas.filter((d) => d.metric === metric)));

  const executedRecords = records.filter((r) => r.executed);
  const triggerRecords = records.filter((r) => r.arm === "tools_task_trigger" && r.executed);
  const neutralRecords = records.filter((r) => r.arm === "tools_neutral_policy" && r.executed);
  const statusCount = (rows: ArmRecord[], status: FirstCallStatus): number =>
    rows.filter((r) => (r.firstCall as { status: FirstCallStatus }).status === status).length;

  const denominators = {
    tasksInManifest: cases.length,
    armsIntended: cases.length * M164_ARMS.length,
    armsCompleted: executedRecords.length,
    runtimeValidArms: executedRecords.filter((r) => r.availability !== null && (r.availability as { toolsAvailable: boolean | null }).toolsAvailable === true && !r.treatmentFailure).length,
    gradablePairs: [...byInstance.values()].filter((p) => p.tools_neutral_policy?.resolved !== null && p.tools_neutral_policy?.resolved !== undefined && p.tools_task_trigger?.resolved !== null && p.tools_task_trigger?.resolved !== undefined).length,
    triggerArmsCompleted: triggerRecords.length,
    evidenceDeliveredCalls: triggerRecords.filter((r) => (r.firstCall as { evidenceDelivered: boolean }).evidenceDelivered).length,
  };

  const report = {
    schemaVersion: 1,
    milestone: "M164",
    workstream: "D",
    title: "Conditional utility of callable VTRACE, once its calls return evidence",
    denominators,
    adoption: {
      neutral: {
        completed: neutralRecords.length,
        available: neutralRecords.filter((r) => (r.availability as { toolsAvailable: boolean | null }).toolsAvailable === true).length,
        used: neutralRecords.filter((r) => (r.vtraceCalls as { total: number }).total > 0).length,
      },
      trigger: {
        completed: triggerRecords.length,
        available: triggerRecords.filter((r) => (r.availability as { toolsAvailable: boolean | null }).toolsAvailable === true).length,
        used: triggerRecords.filter((r) => (r.vtraceCalls as { total: number }).total > 0).length,
        complied: triggerRecords.length - statusCount(triggerRecords, "TRIGGER_NOT_COMPLIED"),
      },
    },
    answerability: {
      denominator: denominators.triggerArmsCompleted,
      VALID_NONEMPTY: statusCount(triggerRecords, "VALID_NONEMPTY"),
      VALID_EMPTY: statusCount(triggerRecords, "VALID_EMPTY"),
      INVALID_REQUEST: statusCount(triggerRecords, "INVALID_REQUEST"),
      REPO_NOT_READY: statusCount(triggerRecords, "REPO_NOT_READY"),
      TOOL_ERROR: statusCount(triggerRecords, "TOOL_ERROR"),
      TRIGGER_NOT_COMPLIED: statusCount(triggerRecords, "TRIGGER_NOT_COMPLIED"),
      repositoryEvidenceCharacters: triggerRecords.reduce((total, r) => total + (r.firstCall as { evidenceCharacters: number }).evidenceCharacters, 0),
      refusalOrErrorCharacters: triggerRecords.reduce((total, r) => total + (r.firstCall as { refusalCharacters: number }).refusalCharacters, 0),
      accountingRule: "The last two are never summed. M163 reported 1370 dynamic VTRACE tokens that were entirely refusal text.",
    },
    utility: {
      resolved: {
        neutral: neutralRecords.filter((r) => r.resolved === true).length,
        trigger: triggerRecords.filter((r) => r.resolved === true).length,
        neutralDenominator: neutralRecords.filter((r) => r.resolved !== null).length,
        triggerDenominator: triggerRecords.filter((r) => r.resolved !== null).length,
      },
      solveMatrix,
      solveCounts: ["SHARED_SUCCESS", "TRIGGER_UNIQUE_WIN", "NEUTRAL_UNIQUE_WIN", "SHARED_FAILURE", "INCOMPLETE"]
        .reduce<Record<string, number>>((acc, cell) => {
          acc[cell] = Object.values(solveMatrix).filter((value) => value === cell).length;
          return acc;
        }, {}),
      pairedDeltas: deltaSummaries,
      deltaConvention: "TRIGGER - NEUTRAL. Negative means the trigger arm used less of the metric.",
    },
    perRun: records,
    pairedDeltaDetail: deltas,
    standingConditions: [
      "STAGE5_TOKEN_DISCIPLINE is OFF on both arms, as instructed.",
      "STAGE5_TOOL_USE_DISCIPLINE — a DIFFERENT harness block — is injected on both arms, as it was on all 36 M163 runs. It carries mild search guidance, so it is a constant that cannot confound TRIGGER-NEUTRAL but may dampen the magnitude of any search-reduction effect.",
    ],
  };

  writeFileSync(path.join(RESULTS, "stage5_m164_analysis.json"), `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`arms completed: ${denominators.armsCompleted}/${denominators.armsIntended}\n`);
  process.stdout.write(`adoption:  neutral ${report.adoption.neutral.used}/${report.adoption.neutral.completed}  trigger ${report.adoption.trigger.used}/${report.adoption.trigger.completed}\n`);
  process.stdout.write(`answerability: VALID_NONEMPTY ${report.answerability.VALID_NONEMPTY}/${denominators.triggerArmsCompleted}  REPO_NOT_READY ${report.answerability.REPO_NOT_READY}  VALID_EMPTY ${report.answerability.VALID_EMPTY}  INVALID ${report.answerability.INVALID_REQUEST}\n`);
  process.stdout.write(`resolved:  neutral ${report.utility.resolved.neutral}/${report.utility.resolved.neutralDenominator}  trigger ${report.utility.resolved.trigger}/${report.utility.resolved.triggerDenominator}\n`);
  process.stdout.write(`solve:     ${JSON.stringify(report.utility.solveCounts)}\n`);
  for (const summary of deltaSummaries) {
    process.stdout.write(`delta ${summary.metric.padEnd(18)} pairs=${summary.pairs} median=${summary.medianDelta ?? "n/a"} mean=${summary.meanDelta === null ? "n/a" : summary.meanDelta.toFixed(2)}\n`);
  }
  process.stdout.write(`${path.join(RESULTS, "stage5_m164_analysis.json")}\n`);
}

// Guarded so the ported readers can be imported and pinned by tests without the
// analysis running as an import side effect — the reason M163's readers had to be
// duplicated here rather than reused.
if (import.meta.main) main();
