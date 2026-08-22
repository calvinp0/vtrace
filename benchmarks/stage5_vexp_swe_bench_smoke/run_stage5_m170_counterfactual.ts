/**
 * M170-C — replay every whole-file Read the baseline agents issued, and price
 * the narrowed version of the same operation.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m170_counterfactual.ts
 *
 * Level 1 only (§26): could the mediated result have carried the material the
 * agent went on to use, for fewer model-visible tokens? Whether an agent would
 * behave better with it is not decidable here and is not claimed.
 *
 * Every window comes from the shipped ranker reading a real index of the real
 * tree at the real base commit. No live agents. No paid APIs.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { openProductIndexDatabase } from "../../src/db/sqlite";
import { hybridRetrieve } from "../../src/retrieval/hybridRetrieval";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { searchSymbols } from "../../src/retrieval/searchSymbols";
import { listSymbolsForFile } from "../../src/db/repositories/symbolsRepository";
import type { FilePath } from "../../src/domain/types";

import { OperationIntent, parseOperations, type OperationRecord } from "./m170Investigation";
import {
  WindowPolicy, WINDOW_PARAMETERS, selectWindow, renderCatN, disclosureFor,
  classifyMediation, MediationVerdict, type LineSpan, type RankedSpan,
} from "./m170Mediation";
import { parseRun, calibrateAcrossRuns, attributePayload, OPUS_4_5_PRICING } from "./m169Economics";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const WORKSPACES = path.join(RESULTS, "workspaces");
const DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";

const POLICIES: readonly WindowPolicy[] = [
  WindowPolicy.TopSymbol, WindowPolicy.TopSymbolScope, WindowPolicy.CoverTopK,
  WindowPolicy.CoverAllRanked, WindowPolicy.Oracle,
];

// ── corpus ──────────────────────────────────────────────────────────

const problemStatements = new Map<string, string>();
if (existsSync(DATASET)) {
  for (const line of readFileSync(DATASET, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.instance_id === "string" && typeof row.problem_statement === "string") {
        problemStatements.set(row.instance_id, row.problem_statement);
      }
    } catch { /* not a dataset row */ }
  }
}

/** The vtrace-arm workspace is the same tree at the same base commit, indexed. */
function workspaceFor(instanceLabel: string): { root: string; instanceId: string } | null {
  const outer = path.join(WORKSPACES, `m168_vtrace_clean_${instanceLabel}`);
  if (!existsSync(outer)) return null;
  const inner = readdirSync(outer).filter((entry) => statSync(path.join(outer, entry)).isDirectory());
  if (inner.length === 0) return null;
  return { root: path.join(outer, inner[0]!), instanceId: inner[0]! };
}

/** Bench absolute path -> repository-relative path. */
function repoRelative(absolute: string): string | null {
  const marker = ".bench-repos/";
  const at = absolute.indexOf(marker);
  if (at < 0) return null;
  const rest = absolute.slice(at + marker.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? null : rest.slice(slash + 1);
}

function anchorLine(fileText: string, needle: string): number | null {
  if (needle === "") return null;
  const at = fileText.indexOf(needle);
  if (at < 0) return null;
  return fileText.slice(0, at).split("\n").length;
}

// ── replay ──────────────────────────────────────────────────────────

interface OperationRow extends Record<string, unknown> {}

const perTask: Record<string, unknown>[] = [];
const operationRows: OperationRow[] = [];

const labels = readdirSync(RUNS).filter((l) => l.startsWith("m168_baseline_")).sort();

// Calibration is shared across the whole corpus, exactly as in M169.
const streams = new Map<string, string[]>();
for (const label of labels) {
  const stream = path.join(RUNS, label, "raw", "baseline", "_agent_stream.first_pass.jsonl");
  if (existsSync(stream)) streams.set(label, readFileSync(stream, "utf-8").split("\n"));
}
const calibration = calibrateAcrossRuns([...streams.values()].map((lines) => parseRun(lines)));

for (const label of labels) {
  const lines = streams.get(label);
  if (lines === undefined) continue;
  const instanceLabel = label.slice("m168_baseline_".length);
  const workspace = workspaceFor(instanceLabel);
  const run = parseRun(lines);
  const operations = parseOperations(lines);
  const wholeFileReads = operations.filter((op) => op.intent === OperationIntent.WholeFileRead && !op.isError);

  if (workspace === null) {
    perTask.push({ instanceLabel, status: "NO_WORKSPACE", wholeFileReads: wholeFileReads.length });
    continue;
  }
  const indexPath = path.join(workspace.root, ".vtrace", "index.sqlite");
  if (!existsSync(indexPath)) {
    perTask.push({ instanceLabel, instanceId: workspace.instanceId, status: "NO_INDEX", wholeFileReads: wholeFileReads.length });
    continue;
  }
  const task = problemStatements.get(workspace.instanceId) ?? null;
  if (task === null) {
    perTask.push({ instanceLabel, instanceId: workspace.instanceId, status: "NO_TASK_TEXT", wholeFileReads: wholeFileReads.length });
    continue;
  }
  if (wholeFileReads.length === 0) {
    perTask.push({ instanceLabel, instanceId: workspace.instanceId, status: "NO_FIRE_NO_WHOLE_FILE_READ", wholeFileReads: 0 });
    continue;
  }

  const db = openProductIndexDatabase(indexPath);

  // The product's own retrieval, in process. `searchSymbols` alone is a NAME
  // lookup: given 2,600 characters of prose it matches nothing at all, which is
  // recorded here as a producer fact rather than discovered twice.
  const nameLookupOnly = searchSymbols(db, { query: task, maxResults: 60 }).length;
  const rankStarted = performance.now();
  const shaped = shapeSweQuery({ problemStatement: task });
  const retrieval = hybridRetrieve(db, {
    query: shaped.query,
    shaped,
    taskText: task,
    maxResults: 60,
  });
  const rankedAll = retrieval.candidates;
  const rankMs = performance.now() - rankStarted;

  const taskRows: Record<string, unknown>[] = [];
  for (const op of wholeFileReads) {
    const absolute = typeof op.input.file_path === "string" ? op.input.file_path : "";
    const relative = repoRelative(absolute);
    const onDisk = relative === null ? null : path.join(workspace.root, relative);
    if (relative === null || onDisk === null || !existsSync(onDisk)) {
      taskRows.push({ orderIndex: op.orderIndex, status: "FILE_NOT_RESOLVED", absolute });
      continue;
    }
    const fileText = readFileSync(onDisk, "utf-8");
    const fileLines = fileText.split("\n");
    const totalLines = fileLines.length;

    // Control: does the tree we are replaying against reproduce what the agent
    // was actually shown? If not, every saving below is measured off a
    // different file and the row is not evidence.
    const nativeRendered = renderCatN(fileLines, { first: 1, last: totalLines });
    const nativeCharacters = op.resultCharacters;
    const reproduces = Math.abs(nativeRendered.length - nativeCharacters) <= Math.max(64, nativeCharacters * 0.02);

    // What the agent went on to use, from the observed trace only.
    const later = operations.filter((o) => o.orderIndex > op.orderIndex);
    const editAnchors: number[] = [];
    for (const other of later) {
      if (other.tool !== "Edit" && other.tool !== "MultiEdit" && other.tool !== "Write") continue;
      if (other.input.file_path !== absolute) continue;
      const oldString = typeof other.input.old_string === "string" ? other.input.old_string : "";
      const line = anchorLine(fileText, oldString);
      if (line !== null) editAnchors.push(line);
    }
    const rereadSpans: LineSpan[] = [];
    for (const other of later) {
      if (other.tool !== "Read" || other.input.file_path !== absolute) continue;
      const offset = typeof other.input.offset === "number" ? other.input.offset : null;
      const limit = typeof other.input.limit === "number" ? other.input.limit : null;
      if (offset === null && limit === null) continue;
      const first = offset ?? 1;
      rereadSpans.push({ first, last: limit === null ? totalLines : first + limit - 1 });
    }

    // VTRACE's own ranking, restricted to this file, with the index's spans.
    const fileSymbols = listSymbolsForFile(db, relative as FilePath);
    const spans = new Map<string, { startLine: number; endLine: number }>();
    const byId = new Map<number, typeof fileSymbols[number]>();
    for (const symbol of fileSymbols) {
      spans.set(symbol.fqName, { startLine: symbol.startLine, endLine: symbol.endLine });
      byId.set(symbol.id as unknown as number, symbol);
    }
    // Outermost enclosing symbol that is not the file-level `<module>`.
    const outermostScope = (fqName: string): LineSpan | undefined => {
      let current = fileSymbols.find((s) => s.fqName === fqName);
      let scope: typeof current | undefined;
      while (current?.parentSymbolId !== null && current?.parentSymbolId !== undefined) {
        const parent = byId.get(current.parentSymbolId as unknown as number);
        if (parent === undefined || parent.fqName.endsWith("::<module>")) break;
        scope = parent;
        current = parent;
      }
      return scope === undefined ? undefined : { first: scope.startLine, last: scope.endLine };
    };
    const ranked: RankedSpan[] = [];
    rankedAll.forEach((result, index) => {
      if (result.filePath !== relative) return;
      const span = spans.get(result.fqName);
      if (span === undefined) return;
      // `<module>` owns the whole file and would make every window the file.
      if (result.fqName.endsWith("::<module>")) return;
      const scope = outermostScope(result.fqName);
      ranked.push({
        fqName: result.fqName, rank: index, first: span.startLine, last: span.endLine,
        ...(scope === undefined ? {} : { scope }),
      });
    });

    const attributed = attributePayload(run, op.orderIndex, calibration, OPUS_4_5_PRICING);
    const nativeTokens = attributed?.payloadTokensEstimated ?? null;
    const nativeCostUsd = attributed?.totalAttributableCostUsd ?? null;

    const oracleSpans: LineSpan[] = [
      ...editAnchors.map((line) => ({ first: line, last: line })),
      ...rereadSpans,
    ];

    const policies: Record<string, unknown> = {};
    for (const policy of POLICIES) {
      const window = selectWindow(policy, ranked, totalLines, oracleSpans);
      if (window === null) {
        policies[policy] = { fired: false, verdict: MediationVerdict.Declined, savedCharacters: 0, savedTokensEstimated: 0 };
        continue;
      }
      const body = renderCatN(fileLines, window);
      const disclosure = disclosureFor(relative, window, totalLines);
      const mediatedCharacters = body.length + disclosure.length + 1;
      const ratio = nativeCharacters === 0 ? 0 : mediatedCharacters / nativeCharacters;
      policies[policy] = {
        fired: true,
        window,
        deliveredLines: window.last - window.first + 1,
        mediatedCharacters,
        disclosureCharacters: disclosure.length,
        reductionShare: Number((1 - ratio).toFixed(4)),
        savedCharacters: Math.max(0, nativeCharacters - mediatedCharacters),
        savedTokensEstimated: nativeTokens === null ? null : Math.round(nativeTokens * Math.max(0, 1 - ratio)),
        savedCostUsdEstimated: nativeCostUsd === null ? null : Number((nativeCostUsd * Math.max(0, 1 - ratio)).toFixed(6)),
        verdict: classifyMediation(window, { editAnchors, rereadSpans }),
      };
    }

    const row = {
      instanceId: workspace.instanceId,
      orderIndex: op.orderIndex,
      filePath: relative,
      totalLines,
      nativeCharacters,
      nativeTokensEstimated: nativeTokens,
      nativeCostUsd,
      nativeReproducesFromWorkspace: reproduces,
      renderedCharacters: nativeRendered.length,
      rankedInFile: ranked.length,
      rankedInFileTop: ranked.slice(0, 4).map((r) => ({ fqName: r.fqName, rank: r.rank, first: r.first, last: r.last })),
      editAnchors,
      rereadSpans,
      rankMs: Number(rankMs.toFixed(1)),
      nameLookupOnlyResults: nameLookupOnly,
      policies,
    };
    taskRows.push(row);
    operationRows.push(row);
  }
  db.close();

  perTask.push({
    instanceLabel,
    instanceId: workspace.instanceId,
    status: "REPLAYED",
    wholeFileReads: wholeFileReads.length,
    rankMs: Number(rankMs.toFixed(1)),
    operations: taskRows,
  });
}

// ── aggregate ───────────────────────────────────────────────────────

const usable = operationRows.filter((r) => r.nativeReproducesFromWorkspace === true);
const summarize = (policy: WindowPolicy) => {
  const fired = usable.filter((r) => (r.policies as any)[policy]?.fired === true);
  const nativeChars = fired.reduce((n, r) => n + (r.nativeCharacters as number), 0);
  const mediatedChars = fired.reduce((n, r) => n + ((r.policies as any)[policy].mediatedCharacters as number), 0);
  const savedCost = fired.reduce((n, r) => n + (((r.policies as any)[policy].savedCostUsdEstimated as number) ?? 0), 0);
  const verdicts: Record<string, number> = {};
  for (const r of usable) {
    const v = (r.policies as any)[policy]?.verdict ?? MediationVerdict.Declined;
    verdicts[v] = (verdicts[v] ?? 0) + 1;
  }
  return {
    firedOperations: fired.length,
    declinedOperations: usable.length - fired.length,
    nativeCharacters: nativeChars,
    mediatedCharacters: mediatedChars,
    operationLocalReduction: nativeChars === 0 ? 0 : Number((1 - mediatedChars / nativeChars).toFixed(4)),
    savedCostUsdEstimated: Number(savedCost.toFixed(6)),
    verdicts,
    unsafeMediations: verdicts[MediationVerdict.Unsafe] ?? 0,
  };
};

const policySummary: Record<string, unknown> = {};
for (const policy of POLICIES) policySummary[policy] = summarize(policy);

// Whole-run denominator: uncensored runs only (§M169 censoring rule).
const runCosts = labels.map((label) => {
  const lines = streams.get(label);
  const run = lines === undefined ? null : parseRun(lines);
  return { label, costUsd: run?.result?.costUsd ?? null };
});
const uncensored = runCosts.filter((r) => r.costUsd !== null && r.costUsd > 0);
const wholeRunCost = uncensored.reduce((n, r) => n + (r.costUsd ?? 0), 0);
const censoredLabels = runCosts.filter((r) => r.costUsd === null || r.costUsd === 0).map((r) => r.label);
const censoredInstances = new Set(censoredLabels.map((l) => l.slice("m168_baseline_".length).replace(/_(\d+)$/, "-$1").replace(/_/g, "__").toLowerCase()));

const wholeRunProjection: Record<string, unknown> = {};
for (const policy of POLICIES) {
  const saved = usable
    .filter((r) => !censoredLabels.some((label) => label.includes(String(r.instanceId).replace(/-/g, "_"))))
    .reduce((n, r) => n + (((r.policies as any)[policy]?.savedCostUsdEstimated as number) ?? 0), 0);
  wholeRunProjection[policy] = {
    savedCostUsdEstimatedUncensored: Number(saved.toFixed(6)),
    wholeRunCostUsdUncensored: Number(wholeRunCost.toFixed(6)),
    wholeRunReductionShare: wholeRunCost === 0 ? 0 : Number((saved / wholeRunCost).toFixed(4)),
    tasksInCorpus: labels.length,
    tasksWhereMediationFired: new Set(usable.filter((r) => (r.policies as any)[policy]?.fired === true).map((r) => r.instanceId)).size,
  };
}

const report = {
  schemaVersion: "stage5.m170.counterfactual.v1",
  milestone: "M170",
  workstream: "C",
  title: "Counterfactual read mediation over the M168 baseline arm",
  level: "LEVEL_1_DETERMINISTIC_OPPORTUNITY_ONLY",
  method: {
    seam: "PreToolUse updatedInput — offset/limit on the agent's own Read",
    ranker: "src/capsule/sweQueryShaping.shapeSweQuery + src/retrieval/hybridRetrieval.hybridRetrieve, "
      + "in process, over the workspace's own .vtrace/index.sqlite — the product's own retrieval, not a proxy",
    spans: "src/db/repositories/symbolsRepository.listSymbolsForFile",
    query: "the SWE-bench problem statement, which is what the agent's own prompt carries; "
      + "a live hook reads it from the transcript at zero model cost",
    windowParameters: WINDOW_PARAMETERS,
    disclosure: "every mediated result carries a partial-view banner, because the harness will not emit one",
    liveSpendUsd: 0,
  },
  controls: {
    operationsReplayed: operationRows.length,
    workspaceReproducesNativeResult: usable.length,
    workspaceMismatch: operationRows.length - usable.length,
    mismatchDetail: operationRows.filter((r) => r.nativeReproducesFromWorkspace !== true)
      .map((r) => ({ instanceId: r.instanceId, filePath: r.filePath, nativeCharacters: r.nativeCharacters, renderedCharacters: r.renderedCharacters })),
    censoredRunsExcludedFromWholeRunProjection: censoredLabels,
  },
  policySummary,
  wholeRunProjection,
  perTask,
};

const out = path.join(RESULTS, "stage5_m170_counterfactual.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`operations replayed ${operationRows.length}, workspace reproduces native ${usable.length}`);
for (const policy of POLICIES) {
  const s = policySummary[policy] as any;
  const w = wholeRunProjection[policy] as any;
  console.log(`${policy.padEnd(24)} fired=${s.firedOperations} declined=${s.declinedOperations} op-local=${(s.operationLocalReduction * 100).toFixed(1)}%  whole-run=${(w.wholeRunReductionShare * 100).toFixed(2)}%  unsafe=${s.unsafeMediations}  ${JSON.stringify(s.verdicts)}`);
}
console.log(`→ ${out}`);
