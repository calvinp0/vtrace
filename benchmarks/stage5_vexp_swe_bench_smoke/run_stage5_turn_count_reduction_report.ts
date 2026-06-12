// Stage 5 turn-count reduction — intervention readiness report.
//
// READ-ONLY. No agents, no Docker, no repair, no model calls. This script reads
// the existing Stage 5 token-path audit (stage5_token_path_audit.json) and the
// per-run ordered tool-call telemetry (runs/<label>/raw/vtrace/_tool_calls.json),
// runs the pure turn-count-waste scorer over each task, and reports whether the new
// STAGE5_TOKEN_DISCIPLINE policy would have applied to (and capped) the known token
// blowups. It does NOT rerun the benchmark and proves no new token-reduction number.
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_turn_count_reduction_report.ts \
//     --results benchmarks/stage5_vexp_swe_bench_smoke/results

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrderedToolCall } from "../../src/capsule/toolCallLog";
import {
  analyzeTurnCountWaste,
  DEFAULT_PRE_EDIT_BASH_BUDGET,
  DEFAULT_PRE_EDIT_SEARCH_BUDGET,
  DEFAULT_REPEATED_FILE_READ_LIMIT,
  type TurnCountWasteResult,
} from "../../src/capsule/turnCountWaste";

export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const DEFAULT_OUT_NAME = "stage5_turn_count_reduction";
export const TOKEN_PATH_AUDIT_FILE = "stage5_token_path_audit.json";

// Pre-edit budgets the report measures against (single source of truth shared with
// the injected STAGE5_TOKEN_DISCIPLINE block and the scorer).
export interface ReportBudgets {
  readonly preEditSearchBudget: number;
  readonly preEditBashBudget: number;
  readonly repeatedFileReadLimit: number;
}

export const DEFAULT_REPORT_BUDGETS: ReportBudgets = {
  preEditSearchBudget: DEFAULT_PRE_EDIT_SEARCH_BUDGET,
  preEditBashBudget: DEFAULT_PRE_EDIT_BASH_BUDGET,
  repeatedFileReadLimit: DEFAULT_REPEATED_FILE_READ_LIMIT,
};

// One task's inputs to the pure analysis. `toolCalls` is null when the run has no
// ordered telemetry (older paired runs); `strongContext` is derived from the audit
// (a Capsule v2 lead pivot was surfaced/inspected). All token fields come straight
// from the token-path audit.
export interface ReductionCaseInput {
  readonly instanceId: string;
  readonly vtraceRunLabel: string | null;
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly cacheReadDelta: number | null;
  readonly strongContext: boolean;
  readonly toolCalls: readonly OrderedToolCall[] | null;
}

export type ReductionRisk = "low" | "medium" | "high" | "unknown";

// One classified case in the report.
export interface ReductionCase {
  readonly instanceId: string;
  readonly tokenDeltaPct: number | null;
  readonly isOverhead: boolean; // tokenDeltaPct > 0
  readonly hasTelemetry: boolean;
  readonly risk: ReductionRisk;
  readonly waste: TurnCountWasteResult | null;
  // The policy decisions this case would have received:
  readonly turnCountCaused: boolean; // overhead attributable to tool/turn loops
  readonly wouldGetPatchFirst: boolean; // strong_context_patch_first would apply
  readonly wouldBeCappedByBudget: boolean; // pre-edit budgets would have capped it
  readonly needsRerun: boolean; // overhead case lacking telemetry → must rerun
  readonly reasons: readonly string[];
}

export interface TurnCountReductionReport {
  readonly budgets: ReportBudgets;
  readonly cases: readonly ReductionCase[];
  readonly summary: {
    readonly caseCount: number;
    readonly overheadCount: number;
    readonly highRiskCount: number;
    readonly turnCountCausedCount: number;
    readonly patchFirstCount: number;
    readonly cappedCount: number;
    readonly needsRerunCount: number;
    readonly highRiskInstances: readonly string[];
  };
}

// Pure: classify one case from its inputs and the configured budgets.
export function analyzeReductionCase(
  input: ReductionCaseInput,
  budgets: ReportBudgets = DEFAULT_REPORT_BUDGETS,
): ReductionCase {
  const isOverhead = (input.tokenDeltaPct ?? 0) > 0;
  const hasTelemetry = input.toolCalls !== null;
  const reasons: string[] = [];

  if (!hasTelemetry) {
    // No ordered telemetry → we cannot attribute the delta to turn-count waste.
    const needsRerun = isOverhead;
    reasons.push(
      isOverhead
        ? "overhead case with no ordered tool-call telemetry — cause cannot be attributed; needs a paired rerun"
        : "no ordered tool-call telemetry (not an overhead case)",
    );
    return {
      instanceId: input.instanceId,
      tokenDeltaPct: input.tokenDeltaPct,
      isOverhead,
      hasTelemetry: false,
      risk: "unknown",
      waste: null,
      turnCountCaused: false,
      // Patch-first would still apply if the capsule was strong, but we cannot
      // confirm a cap without telemetry, so capped stays false.
      wouldGetPatchFirst: input.strongContext,
      wouldBeCappedByBudget: false,
      needsRerun,
      reasons,
    };
  }

  // Cache-read share of the positive delta, when both are positive (the audit's
  // headline: most positive deltas are cache-read movement from extra turns).
  const cacheReadShareOfPositiveDelta =
    input.tokenDelta !== null &&
    input.tokenDelta > 0 &&
    input.cacheReadDelta !== null &&
    input.cacheReadDelta > 0
      ? Math.min(1, input.cacheReadDelta / input.tokenDelta)
      : null;

  const waste = analyzeTurnCountWaste(input.toolCalls ?? [], {
    strongContext: input.strongContext,
    tokenDeltaPct: input.tokenDeltaPct,
    cacheReadShareOfPositiveDelta,
    preEditSearchBudget: budgets.preEditSearchBudget,
    preEditBashBudget: budgets.preEditBashBudget,
    repeatedFileReadLimit: budgets.repeatedFileReadLimit,
  });

  const loopSignal =
    waste.longBashLoopHeuristic ||
    waste.repeatedSearchHeuristic ||
    waste.repeatedSearches > 0 ||
    waste.repeatedFileReads > 0 ||
    waste.strongContextOversearch;
  // Turn-count caused: an overhead case whose risk is at least medium and that
  // carries an actual loop/oversearch signal (not merely a high call count).
  const turnCountCaused =
    isOverhead && waste.tokenReductionRisk !== "low" && loopSignal;

  const wouldGetPatchFirst = input.strongContext;
  const wouldBeCappedByBudget =
    waste.longBashLoopHeuristic ||
    waste.bashCount > budgets.preEditBashBudget ||
    waste.searchLikeCount > budgets.preEditSearchBudget ||
    (waste.preEditToolCalls !== undefined &&
      waste.preEditToolCalls > budgets.preEditSearchBudget + budgets.preEditBashBudget);

  reasons.push(...waste.reasons);
  if (wouldGetPatchFirst) {
    reasons.push("strong capsule context → strong_context_patch_first policy would apply");
  } else {
    reasons.push("weak capsule context → weak_context_explore policy (more exploration allowed)");
  }
  if (wouldBeCappedByBudget) {
    reasons.push(
      `pre-edit budgets (search ${budgets.preEditSearchBudget}, bash ${budgets.preEditBashBudget}) would have capped this run`,
    );
  }

  return {
    instanceId: input.instanceId,
    tokenDeltaPct: input.tokenDeltaPct,
    isOverhead,
    hasTelemetry: true,
    risk: waste.tokenReductionRisk,
    waste,
    turnCountCaused,
    wouldGetPatchFirst,
    wouldBeCappedByBudget,
    needsRerun: false,
    reasons,
  };
}

// Pure: build the whole report from the per-case inputs.
export function buildTurnCountReductionReport(
  inputs: readonly ReductionCaseInput[],
  budgets: ReportBudgets = DEFAULT_REPORT_BUDGETS,
): TurnCountReductionReport {
  const cases = inputs.map((input) => analyzeReductionCase(input, budgets));
  const overhead = cases.filter((c) => c.isOverhead);
  const highRisk = cases.filter((c) => c.risk === "high");
  return {
    budgets,
    cases,
    summary: {
      caseCount: cases.length,
      overheadCount: overhead.length,
      highRiskCount: highRisk.length,
      turnCountCausedCount: cases.filter((c) => c.turnCountCaused).length,
      patchFirstCount: cases.filter((c) => c.wouldGetPatchFirst).length,
      cappedCount: cases.filter((c) => c.wouldBeCappedByBudget).length,
      needsRerunCount: cases.filter((c) => c.needsRerun).length,
      highRiskInstances: highRisk.map((c) => c.instanceId),
    },
  };
}

function fmtPct(value: number | null): string {
  if (value === null) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function renderMarkdown(report: TurnCountReductionReport): string {
  const { budgets, summary } = report;
  const overheadCases = report.cases.filter((c) => c.isOverhead || c.hasTelemetry);
  const patchFirst = report.cases.filter((c) => c.wouldGetPatchFirst);
  const capped = report.cases.filter((c) => c.wouldBeCappedByBudget);
  const needsRerun = report.cases.filter((c) => c.needsRerun);
  const noTelemetry = report.cases.filter((c) => !c.hasTelemetry);

  const lines: string[] = [];
  lines.push("# Stage 5 turn-count reduction policy");
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Classified ${summary.caseCount} task(s) from the token-path audit: `
      + `${summary.overheadCount} overhead case(s), ${summary.highRiskCount} high-risk, `
      + `${summary.turnCountCausedCount} attributable to turn-count/tool loops, `
      + `${summary.patchFirstCount} would receive strong_context_patch_first, `
      + `${summary.cappedCount} would be capped by the new pre-edit tool budgets, `
      + `${summary.needsRerunCount} lack telemetry and need a rerun.`,
  );
  if (summary.highRiskInstances.length > 0) {
    lines.push("");
    lines.push(`High-risk instances: ${summary.highRiskInstances.join(", ")}.`);
  }
  lines.push("");

  lines.push("## Token-path audit finding");
  lines.push("");
  lines.push(
    "The token-path audit showed that VTRACE's overhead was primarily a turn-count/cache-read "
      + "amplification problem, not a capsule-size problem. 96% of the positive token deltas were "
      + "cache-read movement caused by extra agent turns: repeated Read/Grep/Bash search loops that "
      + "re-read the conversation prefix and erase the first-pass token savings.",
  );
  lines.push("");

  lines.push("## Policy added");
  lines.push("");
  lines.push(
    "This milestone converts that finding into an active Stage 5 token-discipline policy "
      + "(STAGE5_TOKEN_DISCIPLINE), injected on the vtrace-only context path. When Capsule v2 "
      + "provides a strong lead pivot, the agent is instructed to patch from the capsule before "
      + "broad rediscovery, under concrete pre-edit tool budgets. The goal is to reduce repeated "
      + "Read/Grep/Bash turns that re-read the conversation prefix and erase first-pass token savings.",
  );
  lines.push("");
  lines.push("Pre-edit tool budgets (strong-context patch-first mode):");
  lines.push(`- at most ${budgets.preEditSearchBudget} search/grep/read calls before the first edit;`);
  lines.push(`- at most ${budgets.preEditBashBudget} Bash inspection command before the first edit (test runs aside);`);
  lines.push(`- at most ${budgets.repeatedFileReadLimit} re-read of an already-read file.`);
  lines.push("");

  lines.push("## Strong-context patch-first mode");
  lines.push("");
  lines.push(
    "strong_context is true when a Capsule v2 lead pivot exists, the lead pivot names a file, "
      + "support snippets exist, and the context was injected successfully. Such tasks receive the "
      + "patch-first / low-search policy; weak-context tasks receive weaker, exploratory guidance.",
  );
  lines.push("");
  if (patchFirst.length > 0) {
    lines.push("Tasks that would receive strong_context_patch_first:");
    for (const c of patchFirst) lines.push(`- ${c.instanceId}`);
  } else {
    lines.push("No tasks in this audit qualified for strong_context_patch_first.");
  }
  lines.push("");

  lines.push("## Historical overhead cases");
  lines.push("");
  lines.push("| instance | tokenΔ% | telemetry | risk | turn-count caused | patch-first | capped by budget |");
  lines.push("|---|---:|---|---|---|---|---|");
  for (const c of overheadCases) {
    lines.push(
      `| ${c.instanceId} | ${fmtPct(c.tokenDeltaPct)} | ${c.hasTelemetry ? "yes" : "no"} | ${c.risk} | `
        + `${yesNo(c.turnCountCaused)} | ${yesNo(c.wouldGetPatchFirst)} | ${yesNo(c.wouldBeCappedByBudget)} |`,
    );
  }
  lines.push("");
  for (const c of overheadCases) {
    if (c.waste === null) continue;
    lines.push(
      `- **${c.instanceId}**: ${c.waste.toolCallCount} tool calls, ${c.waste.bashCount} Bash, `
        + `${c.waste.searchLikeCount} search/grep, ${c.waste.repeatedFileReads} repeated read(s), `
        + `${c.waste.repeatedSearches} repeated search(es); `
        + `longBashLoop=${yesNo(c.waste.longBashLoopHeuristic)}, `
        + `strongContextOversearch=${yesNo(c.waste.strongContextOversearch)}, `
        + `risk=${c.waste.tokenReductionRisk}.`,
    );
  }
  lines.push("");

  lines.push("## Expected token impact");
  lines.push("");
  if (capped.length > 0) {
    lines.push(
      `${capped.length} case(s) would have hit the new pre-edit tool budgets and had their search/Bash `
        + "loops cut short: " + capped.map((c) => c.instanceId).join(", ") + ". "
        + "Because most of the positive token delta on these cases was cache-read amplification from "
        + "those extra turns, capping the turns is the lever expected to recover the lost token savings.",
    );
  } else {
    lines.push("No case in this audit would have been capped by the new pre-edit tool budgets.");
  }
  lines.push("");
  lines.push(
    "This is a readiness estimate from historical telemetry, not a measured reduction. The actual "
      + "token impact is only established by paired baseline-vs-vtrace reruns with the policy active.",
  );
  lines.push("");

  lines.push("## Telemetry gaps");
  lines.push("");
  if (noTelemetry.length > 0) {
    lines.push("Cases without ordered tool-call telemetry (cause cannot be attributed):");
    for (const c of noTelemetry) {
      lines.push(`- ${c.instanceId} (tokenΔ ${fmtPct(c.tokenDeltaPct)})${c.needsRerun ? " — overhead, needs rerun" : ""}`);
    }
  } else {
    lines.push("All classified cases carried ordered tool-call telemetry.");
  }
  lines.push("");

  lines.push("## Recommended rerun");
  lines.push("");
  if (needsRerun.length > 0) {
    lines.push("Rerun these paired tasks with STAGE5_TOKEN_DISCIPLINE active to measure the real delta:");
    for (const c of needsRerun) lines.push(`- ${c.instanceId}`);
  } else {
    lines.push("No overhead case is blocked on missing telemetry.");
  }
  lines.push("");
  lines.push(
    "Recommended next step: paired baseline-vs-vtrace reruns of the high-risk and capped cases above, "
      + "comparing total tokens with and without the policy, capturing ordered tool logs for every run.",
  );
  lines.push("");

  lines.push("## Non-claims");
  lines.push("");
  lines.push("- This report does not prove a new token-reduction percentage.");
  lines.push("- This report does not run agents or Docker.");
  lines.push("- This report does not claim the loop issue is solved until paired reruns are performed.");
  lines.push("- This report does not change generated-parser repair accounting.");
  lines.push("");

  return lines.join("\n");
}

export function renderJson(report: TurnCountReductionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ---- IO layer (kept thin; the analysis above is pure and unit-tested) ----

export interface CliConfig {
  readonly resultsDir: string;
  readonly outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = DEFAULT_OUT_NAME;
  const next = (i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${argv[i]}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--results":
        resultsDir = next(i);
        i += 1;
        break;
      case "--out-name":
        outName = next(i);
        i += 1;
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, outName };
}

interface AuditTask {
  readonly instanceId: string;
  readonly vtraceRunLabel: string | null;
  readonly tokenDelta: number | null;
  readonly tokenDeltaPct: number | null;
  readonly cacheReadDelta: number | null;
  readonly pivotsSurfaced: number | null;
  readonly hasVtraceToolCallLog: boolean;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

// Load the ordered tool-call list for one run, or null when absent/unparseable.
async function loadToolCalls(resultsDir: string, runLabel: string | null): Promise<OrderedToolCall[] | null> {
  if (runLabel === null) return null;
  const file = path.join(resultsDir, "runs", runLabel, "raw", "vtrace", "_tool_calls.json");
  try {
    const data = await readJson(file);
    if (!Array.isArray(data)) return null;
    return data as OrderedToolCall[];
  } catch {
    return null;
  }
}

// Build the per-case inputs from the token-path audit + ordered telemetry on disk.
export async function loadReductionCaseInputs(resultsDir: string): Promise<ReductionCaseInput[]> {
  const audit = (await readJson(path.join(resultsDir, TOKEN_PATH_AUDIT_FILE))) as { tasks?: AuditTask[] };
  const tasks = audit.tasks ?? [];
  const inputs: ReductionCaseInput[] = [];
  for (const task of tasks) {
    const toolCalls = task.hasVtraceToolCallLog ? await loadToolCalls(resultsDir, task.vtraceRunLabel) : null;
    // Strong context: a Capsule v2 lead pivot was surfaced for the task.
    const strongContext = (task.pivotsSurfaced ?? 0) >= 1;
    inputs.push({
      instanceId: task.instanceId,
      vtraceRunLabel: task.vtraceRunLabel ?? null,
      tokenDelta: task.tokenDelta ?? null,
      tokenDeltaPct: task.tokenDeltaPct ?? null,
      cacheReadDelta: task.cacheReadDelta ?? null,
      strongContext,
      toolCalls,
    });
  }
  return inputs;
}

export async function main(config: CliConfig): Promise<TurnCountReductionReport> {
  const inputs = await loadReductionCaseInputs(config.resultsDir);
  const report = buildTurnCountReductionReport(inputs);
  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));
  process.stdout.write(
    [
      `Stage 5 turn-count reduction report → ${mdPath}`,
      `  cases=${report.summary.caseCount} overhead=${report.summary.overheadCount} high=${report.summary.highRiskCount} `
        + `turnCountCaused=${report.summary.turnCountCausedCount} patchFirst=${report.summary.patchFirstCount} `
        + `capped=${report.summary.cappedCount} needsRerun=${report.summary.needsRerunCount}`,
      report.summary.highRiskInstances.length > 0
        ? `  high-risk: ${report.summary.highRiskInstances.join(", ")}`
        : "  high-risk: (none)",
      "",
    ].join("\n"),
  );
  return report;
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
