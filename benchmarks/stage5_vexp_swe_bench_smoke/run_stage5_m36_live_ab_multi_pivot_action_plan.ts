// M36 — analysis of the LIVE A/B for the M35 Multi-Pivot Action Plan.
//
// READ-ONLY / OFFLINE. This script runs NO agent, NO Docker, NO SWE-bench eval; it
// only reads the artifacts the 12 live protocol runs (and the separate Docker eval)
// already wrote, recomputes per-run actionability with the SAME M34 primitives the
// product accounting uses, and emits the report + CSV + JSON.
//
// Two arms (M36.1 rendering-only toggle), nothing else differs between them:
//   control   — VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0 (no action-plan section)
//   treatment — default env (M35 action-plan section rendered)
//
// The core question is MECHANISM, not headline resolved rate: does the action plan
// make the agent inspect/edit the REQUIRED SECONDARY co-edit pivot more often? Gold
// files are an evaluation oracle for labeling only — never an input to retrieval or
// to the action-plan builder.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  buildProductV2Accounting,
  classifyFunctionalActionability,
  computePostCapsuleToolUse,
  type FunctionalActionabilityLabel,
  type ToolCallWithOutput,
} from "./m34_accounting";

const RESULTS = path.join(import.meta.dir, "results");
const RUNS = path.join(RESULTS, "runs");
const DATASET =
  process.env.STAGE5_DATASET ??
  "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";

type Arm = "control" | "treatment";

interface InstanceSpec {
  instance: string;
  short: string;
  /** Lead gold file (the issue-anchored edit site). */
  leadGold: string;
  /** Required SECONDARY co-edit gold file — the one control tends to skip. */
  secondaryGold: string;
  /** All gold files (oracle, for completeness labeling only). */
  goldFiles: string[];
}

// Oracle gold from the dataset gold patch (verified against swe-bench-100.jsonl).
// NOTE: the secondary co-edit for seaborn-3187 is seaborn/utils.py (gold lead is
// seaborn/_core/scales.py) — NOT _core/properties.py as an earlier brief stated.
const INSTANCES: InstanceSpec[] = [
  {
    instance: "sphinx-doc__sphinx-7462",
    short: "sphinx-7462",
    leadGold: "sphinx/domains/python.py",
    secondaryGold: "sphinx/pycode/ast.py",
    goldFiles: ["sphinx/domains/python.py", "sphinx/pycode/ast.py"],
  },
  {
    instance: "mwaskom__seaborn-3187",
    short: "seaborn-3187",
    leadGold: "seaborn/_core/scales.py",
    secondaryGold: "seaborn/utils.py",
    goldFiles: ["seaborn/_core/scales.py", "seaborn/utils.py"],
  },
];

const ARMS: Arm[] = ["control", "treatment"];
const REPS = [1, 2, 3];

interface RunRecord {
  label: string;
  instance: string;
  short: string;
  arm: Arm;
  replicate: number;
  // presence / validity
  present: boolean;
  valid: boolean;
  patchProduced: boolean;
  contextInjected: boolean | null;
  // rendering
  actionPlanRendered: boolean;
  multiPivotActionPlanTokens: number | null;
  // gold oracle
  goldSurfaced: boolean | null;
  primaryEdited: boolean;
  secondaryInspected: boolean;
  secondaryEdited: boolean;
  goldEditedComplete: boolean;
  patchFiles: string[];
  // eval
  resolved: boolean | null;
  // burden
  toolCalls: number;
  readCalls: number;
  searchCalls: number;
  bashCalls: number;
  uniqueFilesTouched: number;
  inputTokens: number | null;
  costUsd: number | null;
  numTurns: number | null;
  // classification
  functionalLabel: FunctionalActionabilityLabel;
}

function labelFor(arm: Arm, short: string, rep: number): string {
  return `eval-m36-${arm}-${short}-r${rep}`;
}

function rawDir(label: string): string {
  return path.join(RUNS, label, "raw", "vtrace");
}

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function readSwebenchRow(label: string): Record<string, unknown> | null {
  const dir = rawDir(label);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find(
    (f) => f.startsWith("swebench-") && f.endsWith(".jsonl"),
  );
  if (!file) return null;
  const text = readFileSync(path.join(dir, file), "utf8").trim();
  if (text.length === 0) return null;
  const firstLine = text.split("\n")[0]!;
  try {
    return JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function patchFiles(patch: string): string[] {
  const out: string[] = [];
  const re = /^diff --git a\/(\S+) b\//gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) out.push(m[1]!);
  return out;
}

// A tool call inspected `gold` when its path ends with the gold repo-relative path.
function toolTouchedGold(calls: ToolCallWithOutput[], gold: string): boolean {
  return calls.some((c) => {
    const cat = (c.category ?? "").toLowerCase();
    if (cat !== "read" && cat !== "search") return false;
    const p = typeof c.path === "string" ? c.path : "";
    return p.endsWith(`/${gold}`) || p === gold;
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function analyzeLabel(spec: InstanceSpec, arm: Arm, rep: number): RunRecord {
  const label = labelFor(arm, spec.short, rep);
  const base: RunRecord = {
    label,
    instance: spec.instance,
    short: spec.short,
    arm,
    replicate: rep,
    present: false,
    valid: false,
    patchProduced: false,
    contextInjected: null,
    actionPlanRendered: false,
    multiPivotActionPlanTokens: null,
    goldSurfaced: null,
    primaryEdited: false,
    secondaryInspected: false,
    secondaryEdited: false,
    goldEditedComplete: false,
    patchFiles: [],
    resolved: null,
    toolCalls: 0,
    readCalls: 0,
    searchCalls: 0,
    bashCalls: 0,
    uniqueFilesTouched: 0,
    inputTokens: null,
    costUsd: null,
    numTurns: null,
    functionalLabel: "unknown",
  };

  const runMeta = readJson<Record<string, unknown>>(
    path.join(rawDir(label), "_run.meta.json"),
  );
  const row = readSwebenchRow(label);
  if (runMeta === null && row === null) return base;
  base.present = true;

  // Rendering: derive from the captured immutable snapshot.
  const snapshotPath = path.join(RUNS, label, "_vtrace_instructions.snapshot.md");
  if (existsSync(snapshotPath)) {
    const snapshot = readFileSync(snapshotPath, "utf8");
    const acc = buildProductV2Accounting(snapshot, null);
    base.multiPivotActionPlanTokens = acc.multiPivotActionPlanTokens;
    base.actionPlanRendered =
      snapshot.includes("## Multi-Pivot Action Plan") ||
      (acc.multiPivotActionPlanTokens ?? 0) > 0;
  }

  // Pivots surfaced → goldSurfaced (a gold file appears as a capsule pivot).
  const pivots = (runMeta?.["vtraceCapsulePivots"] as
    | Array<{ path?: string }>
    | null
    | undefined) ?? null;
  if (pivots !== null) {
    const pivotPaths = pivots.map((p) => p.path ?? "");
    base.goldSurfaced = spec.goldFiles.some((g) => pivotPaths.includes(g));
  }
  base.contextInjected =
    typeof runMeta?.["vtraceContextInjected"] === "boolean"
      ? (runMeta["vtraceContextInjected"] as boolean)
      : null;

  // Patch-derived edits.
  const patch = typeof row?.["modelPatch"] === "string" ? (row["modelPatch"] as string) : "";
  base.patchProduced = patch.trim().length > 0;
  base.patchFiles = patchFiles(patch);
  base.primaryEdited = base.patchFiles.includes(spec.leadGold);
  base.secondaryEdited = base.patchFiles.includes(spec.secondaryGold);
  base.goldEditedComplete = spec.goldFiles.every((g) => base.patchFiles.includes(g));

  // Tool calls → secondary inspected + burden.
  const calls =
    readJson<ToolCallWithOutput[]>(path.join(rawDir(label), "_tool_calls.json")) ?? [];
  base.secondaryInspected = toolTouchedGold(calls, spec.secondaryGold);
  const tool = computePostCapsuleToolUse(calls.length > 0 ? calls : null);
  base.toolCalls = tool.toolCallsAfterContext;
  base.readCalls = tool.readCallsAfterContext;
  base.searchCalls = tool.grepSearchCallsAfterContext;
  base.bashCalls = tool.bashCallsAfterContext;
  base.uniqueFilesTouched = tool.uniqueFilesTouchedAfterContext;

  base.inputTokens = num(row?.["inputTokens"]);
  base.costUsd = num(row?.["costUsd"]);
  base.numTurns = num(row?.["numTurns"]);

  // Resolution: prefer _eval.meta.json (post-Docker), fall back to the row.
  const evalMeta = readJson<Record<string, unknown>>(
    path.join(rawDir(label), "_eval.meta.json"),
  );
  const evalResolved =
    evalMeta !== null && typeof evalMeta["resolvedCount"] === "number"
      ? (evalMeta["resolvedCount"] as number) > 0
      : null;
  const rowResolved =
    typeof row?.["resolved"] === "boolean" ? (row["resolved"] as boolean) : null;
  base.resolved = evalResolved !== null ? evalResolved : rowResolved;

  // Valid = a real protocol run that injected context and produced a patch.
  base.valid = base.present && base.patchProduced && base.contextInjected === true;

  base.functionalLabel = classifyFunctionalActionability({
    resolved: base.resolved,
    contextInjected: base.contextInjected,
    goldSurfaced: base.goldSurfaced,
    goldEditedComplete: base.goldEditedComplete,
  });

  return base;
}

// ---- aggregation -------------------------------------------------------------

function rate(records: RunRecord[], pred: (r: RunRecord) => boolean): string {
  const valid = records.filter((r) => r.valid);
  if (valid.length === 0) return "n/a (0 valid)";
  const n = valid.filter(pred).length;
  return `${n}/${valid.length} (${Math.round((100 * n) / valid.length)}%)`;
}

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 0 ? (v[mid - 1]! + v[mid]!) / 2 : v[mid]!;
}

function med(records: RunRecord[], pick: (r: RunRecord) => number | null): string {
  const m = median(
    records.filter((r) => r.valid).map(pick).filter((x): x is number => x !== null),
  );
  return m === null ? "n/a" : String(Math.round(m * 1000) / 1000);
}

function fmtBool(b: boolean | null): string {
  return b === null ? "?" : b ? "yes" : "no";
}

// ---- main --------------------------------------------------------------------

const records: RunRecord[] = [];
for (const spec of INSTANCES) {
  for (const arm of ARMS) {
    for (const rep of REPS) {
      records.push(analyzeLabel(spec, arm, rep));
    }
  }
}

const present = records.filter((r) => r.present);
const completed = present.length;

function armRecords(arm: Arm, short?: string): RunRecord[] {
  return records.filter((r) => r.arm === arm && (short === undefined || r.short === short));
}

// ---- CSV ---------------------------------------------------------------------

const csvHeader = [
  "label", "instance", "arm", "replicate", "present", "valid", "patchProduced",
  "actionPlanRendered", "multiPivotActionPlanTokens", "goldSurfaced",
  "primaryEdited", "secondaryInspected", "secondaryEdited", "goldEditedComplete",
  "resolved", "toolCalls", "readCalls", "searchCalls", "bashCalls",
  "uniqueFilesTouched", "inputTokens", "costUsd", "numTurns", "functionalLabel",
  "patchFiles",
].join(",");
const csvRows = records.map((r) =>
  [
    r.label, r.instance, r.arm, r.replicate, r.present, r.valid, r.patchProduced,
    r.actionPlanRendered, r.multiPivotActionPlanTokens ?? "", fmtBool(r.goldSurfaced),
    r.primaryEdited, r.secondaryInspected, r.secondaryEdited, r.goldEditedComplete,
    fmtBool(r.resolved), r.toolCalls, r.readCalls, r.searchCalls, r.bashCalls,
    r.uniqueFilesTouched, r.inputTokens ?? "", r.costUsd ?? "", r.numTurns ?? "",
    r.functionalLabel, `"${r.patchFiles.join(";")}"`,
  ].join(","),
);
writeFileSync(
  path.join(RESULTS, "stage5_m36_live_ab_multi_pivot_action_plan.csv"),
  `${[csvHeader, ...csvRows].join("\n")}\n`,
);

// ---- JSON --------------------------------------------------------------------

function arment(arm: Arm, short?: string) {
  const rs = armRecords(arm, short);
  return {
    secondaryInspectedRate: rate(rs, (r) => r.secondaryInspected),
    secondaryEditedRate: rate(rs, (r) => r.secondaryEdited),
    resolvedRate: rate(rs, (r) => r.resolved === true),
    medianToolCalls: med(rs, (r) => r.toolCalls),
    medianReads: med(rs, (r) => r.readCalls),
    medianSearches: med(rs, (r) => r.searchCalls),
    medianInputTokens: med(rs, (r) => r.inputTokens),
    medianCostUsd: med(rs, (r) => r.costUsd),
    medianNumTurns: med(rs, (r) => r.numTurns),
  };
}

const summary = {
  generatedFromArtifacts: true,
  completedRuns: completed,
  totalPlanned: records.length,
  overall: { control: arment("control"), treatment: arment("treatment") },
  byInstance: INSTANCES.map((s) => ({
    instance: s.instance,
    control: arment("control", s.short),
    treatment: arment("treatment", s.short),
  })),
  runs: records,
};
writeFileSync(
  path.join(RESULTS, "stage5_m36_live_ab_multi_pivot_action_plan.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

// ---- console preview ---------------------------------------------------------

process.stdout.write(`M36 analysis: ${completed}/${records.length} runs present\n`);
process.stdout.write("arm        | sec.inspected | sec.edited | resolved | medTool | medTok | medCost\n");
for (const arm of ARMS) {
  const a = arment(arm);
  process.stdout.write(
    `${arm.padEnd(10)} | ${a.secondaryInspectedRate.padEnd(13)} | ${a.secondaryEditedRate.padEnd(10)} | ${a.resolvedRate.padEnd(8)} | ${a.medianToolCalls.padEnd(7)} | ${a.medianInputTokens.padEnd(6)} | ${a.medianCostUsd}\n`,
  );
}
process.stdout.write("\nper-run:\n");
for (const r of records) {
  if (!r.present) {
    process.stdout.write(`  ${r.label}: ABSENT\n`);
    continue;
  }
  process.stdout.write(
    `  ${r.label.padEnd(38)} plan=${fmtBool(r.actionPlanRendered).padEnd(3)} primEd=${fmtBool(r.primaryEdited).padEnd(3)} secInsp=${fmtBool(r.secondaryInspected).padEnd(3)} secEd=${fmtBool(r.secondaryEdited).padEnd(3)} resolved=${fmtBool(r.resolved).padEnd(3)} tok=${r.multiPivotActionPlanTokens ?? "-"} ${r.functionalLabel}\n`,
  );
}

export {};
