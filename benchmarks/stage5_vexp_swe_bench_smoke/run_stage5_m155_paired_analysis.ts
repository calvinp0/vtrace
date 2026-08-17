// Stage 5 M155-D/E — paired live-agent outcome, efficiency and cross-tab analysis.
//
// Reads what the live runs already captured — each arm's result row and its
// post-evaluate grade — and produces the M155-D/E evidence. It computes nothing
// from the product, so re-running it cannot move a result.
//
// Two rules encoded here rather than left to prose:
//
//   1. PASS comes from the grader. `modelPatch` existing is not success (§50), so
//      `resolved` is read from the graded row and a run with no grade is
//      `UNGRADED`, never a FAIL.
//   2. Token claims are END-TO-END (§55). The injected-context size is reported
//      separately and is never presented as a saving, because a small capsule
//      followed by more agent turns is a cost, not a reduction.
//
// NO Claude, NO Docker, NO agent run, NO API calls, NO network.

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "node:fs/promises";

import { median, percentile, mean } from "./run_stage5_m155_latency_probe";
import { samePath } from "./run_stage5_m143b_ownership_evidence_audit";

export interface ToolCall {
  readonly index: number;
  readonly tool: string;
  readonly category: string | null;
  readonly path: string | null;
}

export interface OrientationMetrics {
  readonly toolCalls: number;
  readonly firstEditIndex: number | null;
  /** Index of the first call that touched a gold file. null = never touched one. */
  readonly firstGoldTouchIndex: number | null;
  readonly toolCallsBeforeFirstEdit: number | null;
  readonly readsBeforeFirstEdit: number | null;
  readonly searchesBeforeFirstEdit: number | null;
  readonly goldTouchedBeforeFirstEdit: boolean | null;
}

/**
 * Orientation from the ordered tool-call stream (§49/§50/§58). "Time" is measured in
 * tool calls rather than seconds: the stream carries a reliable order and no
 * per-call timestamp, and inventing a duration from run wall-clock would be a
 * fragile metric of exactly the kind §48 warns against.
 *
 * Gold matching goes through `samePath` because telemetry paths are absolute inside
 * the harness bench-repo checkout while gold paths are repository-relative.
 */
export function orientation(calls: readonly ToolCall[], goldFiles: readonly string[]): OrientationMetrics {
  const ordered = [...calls].sort((a, b) => a.index - b.index);
  const isGold = (p: string | null): boolean =>
    p !== null && goldFiles.some((gold) => samePath(gold, p));
  const firstEdit = ordered.findIndex((c) => c.category === "edit");
  const firstGold = ordered.findIndex((c) => isGold(c.path));
  const before = firstEdit < 0 ? ordered : ordered.slice(0, firstEdit);
  return {
    toolCalls: ordered.length,
    firstEditIndex: firstEdit < 0 ? null : firstEdit,
    firstGoldTouchIndex: firstGold < 0 ? null : firstGold,
    toolCallsBeforeFirstEdit: firstEdit < 0 ? null : firstEdit,
    readsBeforeFirstEdit: firstEdit < 0 ? null : before.filter((c) => c.category === "read").length,
    searchesBeforeFirstEdit: firstEdit < 0 ? null : before.filter((c) => c.category === "search").length,
    goldTouchedBeforeFirstEdit: firstEdit < 0 ? null : before.some((c) => isGold(c.path)),
  };
}

export type Grade = "PASS" | "FAIL" | "UNGRADED";

/**
 * Treatment state for a VTRACE arm. These five states are never collapsed.
 *
 * A successful retrieval that truthfully selects nothing is a VALID treatment
 * outcome, not a failure: retrieval ran, chose to inject nothing, and the agent
 * ran normally. It may behave exactly like baseline, and that is the evidence.
 *
 * What is NOT valid is the treatment never being produced. Two distinct causes
 * matter separately: the repository could not be indexed at all (an availability
 * finding about the product), versus context generation erroring (a generation
 * failure). Folding either into "VTRACE lost" would overstate agent harm; folding
 * them into "harmless benchmark noise" would hide a real product limitation.
 */
export type TreatmentState =
  | "VALID_NON_EMPTY"
  | "VALID_EMPTY"
  | "TREATMENT_UNAVAILABLE_INDEX_FAILURE"
  | "TREATMENT_GENERATION_FAILURE"
  | "NOT_RUN";

/** A treatment state counts toward availability only when retrieval delivered a
 *  verdict the agent could run on — empty included. */
export function treatmentAvailable(state: TreatmentState): boolean {
  return state === "VALID_NON_EMPTY" || state === "VALID_EMPTY";
}
export type PairClass =
  | "shared success"
  | "VTRACE unique win"
  | "VTRACE unique loss"
  | "shared failure"
  | "incomplete";

export interface ArmRun {
  readonly instanceId: string;
  readonly arm: "baseline" | "vtrace";
  readonly grade: Grade;
  readonly patchProduced: boolean;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly totalTokens: number | null;
  readonly toolCalls: Readonly<Record<string, number>>;
  /** Capsule tokens injected into the treatment prompt. null for baseline. */
  readonly injectedContextTokens: number | null;
  readonly contextInjected: boolean | null;
  readonly treatmentState: TreatmentState;
  readonly treatmentValid: boolean;
  readonly treatmentInvalidReason: string | null;
  readonly orientation: OrientationMetrics | null;
}

/** End-to-end billable tokens. Cache reads/creations are real usage and are
 *  included; omitting them would understate whichever arm caches more. */
export function totalTokensOf(row: {
  inputTokens?: number | null; outputTokens?: number | null;
  cacheReadTokens?: number | null; cacheCreationTokens?: number | null;
}): number | null {
  const parts = [row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens];
  if (parts.every((p) => p === null || p === undefined)) return null;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
}

export function gradeOf(resolved: unknown): Grade {
  if (resolved === true) return "PASS";
  if (resolved === false) return "FAIL";
  return "UNGRADED";
}

export function classifyPair(baseline: Grade, vtrace: Grade): PairClass {
  if (baseline === "UNGRADED" || vtrace === "UNGRADED") return "incomplete";
  if (baseline === "PASS" && vtrace === "PASS") return "shared success";
  if (baseline === "FAIL" && vtrace === "PASS") return "VTRACE unique win";
  if (baseline === "PASS" && vtrace === "FAIL") return "VTRACE unique loss";
  return "shared failure";
}

/**
 * Two-sided exact McNemar p-value on the discordant pairs. At n=30 a normal
 * approximation is not defensible (§52), and the discordant count is usually tiny,
 * so the exact binomial tail is both cheap and honest.
 */
export function mcnemarExactP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const logFact = (k: number): number => {
    let s = 0;
    for (let i = 2; i <= k; i += 1) s += Math.log(i);
    return s;
  };
  const pmf = (k: number): number => Math.exp(logFact(n) - logFact(k) - logFact(n - k) - n * Math.LN2);
  const observed = Math.min(wins, losses);
  let tail = 0;
  for (let k = 0; k <= observed; k += 1) tail += pmf(k);
  return Math.min(1, 2 * tail);
}

/** Wilson score interval for a pass rate — used instead of a bare delta (§52). */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const halfWidth = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - halfWidth) / d),
    high: Math.min(1, (centre + halfWidth) / d),
  };
}

const round = (v: number | null, dp = 3): number | null =>
  v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp;

export interface ArmAggregate {
  readonly arm: string;
  readonly runs: number;
  readonly graded: number;
  readonly pass: number;
  readonly fail: number;
  readonly ungraded: number;
  readonly patchProduced: number;
  readonly treatmentInvalid: number;
  readonly tokensTotal: number | null;
  readonly tokensMean: number | null;
  readonly tokensMedian: number | null;
  readonly tokensP90: number | null;
  readonly costTotal: number | null;
  readonly costMean: number | null;
  readonly costMedian: number | null;
  readonly costP90: number | null;
  readonly turnsMean: number | null;
  readonly turnsMedian: number | null;
  readonly wallSecTotal: number | null;
  readonly wallSecMedian: number | null;
  readonly toolCallTotals: Readonly<Record<string, number>>;
}

export function aggregateArm(arm: string, runs: readonly ArmRun[]): ArmAggregate {
  const nums = (pick: (r: ArmRun) => number | null): number[] =>
    runs.map(pick).filter((v): v is number => v !== null);
  const tokens = nums((r) => r.totalTokens);
  const cost = nums((r) => r.costUsd);
  const turns = nums((r) => r.numTurns);
  const wall = nums((r) => r.durationMs).map((ms) => ms / 1000);
  const toolTotals: Record<string, number> = {};
  for (const r of runs) for (const [tool, n] of Object.entries(r.toolCalls)) toolTotals[tool] = (toolTotals[tool] ?? 0) + n;
  return {
    arm,
    runs: runs.length,
    graded: runs.filter((r) => r.grade !== "UNGRADED").length,
    pass: runs.filter((r) => r.grade === "PASS").length,
    fail: runs.filter((r) => r.grade === "FAIL").length,
    ungraded: runs.filter((r) => r.grade === "UNGRADED").length,
    patchProduced: runs.filter((r) => r.patchProduced).length,
    treatmentInvalid: runs.filter((r) => !r.treatmentValid).length,
    tokensTotal: tokens.length ? tokens.reduce((s, v) => s + v, 0) : null,
    tokensMean: tokens.length ? Math.round(mean(tokens)!) : null,
    tokensMedian: tokens.length ? Math.round(median(tokens)!) : null,
    tokensP90: tokens.length ? Math.round(percentile(tokens, 0.9)!) : null,
    costTotal: cost.length ? round(cost.reduce((s, v) => s + v, 0), 2) : null,
    costMean: cost.length ? round(mean(cost)!, 4) : null,
    costMedian: cost.length ? round(median(cost)!, 4) : null,
    costP90: cost.length ? round(percentile(cost, 0.9)!, 4) : null,
    turnsMean: turns.length ? round(mean(turns)!, 1) : null,
    turnsMedian: turns.length ? median(turns) : null,
    wallSecTotal: wall.length ? Math.round(wall.reduce((s, v) => s + v, 0)) : null,
    wallSecMedian: wall.length ? Math.round(median(wall)!) : null,
    toolCallTotals: toolTotals,
  };
}

// ---------------------------------------------------------------------------
// Loading captured runs
// ---------------------------------------------------------------------------

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function firstResultRow(dir: string): Promise<Record<string, unknown> | null> {
  const found: string[] = [];
  for await (const entry of glob("swebench-*.jsonl", { cwd: dir })) found.push(entry);
  if (found.length === 0) return null;
  const text = readFileSync(path.join(dir, found.sort()[0]!), "utf8");
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
}

export async function loadArm(
  resultsRoot: string, instanceId: string, arm: "baseline" | "vtrace",
  goldFiles: readonly string[] = [],
): Promise<ArmRun | null> {
  const label = `m155_${arm}_${instanceId.replace(/-/g, "_")}`;
  const dir = path.join(resultsRoot, "runs", label, "raw", arm === "baseline" ? "baseline" : "vtrace");
  if (!existsSync(dir)) return null;
  const row = await firstResultRow(dir);
  if (row === null) return null;
  const runMeta = readJson(path.join(dir, "_run.meta.json")) ?? {};
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

  const contextInjected = arm === "vtrace"
    ? (typeof runMeta.vtraceContextInjected === "boolean" ? runMeta.vtraceContextInjected : null)
    : null;
  const injectedTokens = arm === "vtrace" ? num(runMeta.vtraceCapsuleEstimatedTokens) : null;

  // A VTRACE arm that RAN is a valid treatment, whether or not retrieval selected
  // anything: an empty-but-successful treatment is a product outcome to measure,
  // not an invalid run. Only a capsule-engine fallback invalidates a run that ran,
  // because the fallback packs FAIL_TO_PASS into the retrieval query and makes the
  // arm parity-invalid by contamination.
  let treatmentState: TreatmentState = arm === "vtrace" ? "VALID_NON_EMPTY" : "VALID_NON_EMPTY";
  let treatmentValid = true;
  let treatmentInvalidReason: string | null = null;
  if (arm === "vtrace") {
    if (runMeta.vtraceCapsuleEngineFallbackReason != null) {
      treatmentState = "TREATMENT_GENERATION_FAILURE";
      treatmentValid = false;
      treatmentInvalidReason = `capsule engine fell back: ${String(runMeta.vtraceCapsuleEngineFallbackReason)}`;
    } else if (contextInjected === false || (injectedTokens !== null && injectedTokens === 0)) {
      treatmentState = "VALID_EMPTY";
    }
  }

  const rawCalls = readJson(path.join(dir, "_tool_calls.json"));
  const callList: ToolCall[] = Array.isArray(rawCalls)
    ? (rawCalls as ToolCall[])
    : Array.isArray((rawCalls as { calls?: unknown } | null)?.calls)
      ? ((rawCalls as { calls: ToolCall[] }).calls)
      : [];

  return {
    instanceId,
    arm,
    grade: gradeOf(row.resolved),
    patchProduced: typeof row.modelPatch === "string" && row.modelPatch.trim().length > 0,
    costUsd: num(row.costUsd),
    numTurns: num(row.numTurns),
    durationMs: num(row.durationMs),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    cacheReadTokens: num(row.cacheReadTokens),
    cacheCreationTokens: num(row.cacheCreationTokens),
    totalTokens: totalTokensOf(row as never),
    toolCalls: (row.toolCalls ?? {}) as Record<string, number>,
    injectedContextTokens: injectedTokens,
    contextInjected,
    treatmentState,
    treatmentValid,
    treatmentInvalidReason,
    orientation: callList.length > 0 ? orientation(callList, goldFiles) : null,
  };
}

/**
 * Classify a VTRACE arm that produced no run at all, from the driver's captured
 * stderr. The two causes are reported separately because they say different things:
 * an aborted whole-repository index is a product availability limitation, while a
 * context-generation error is a harness/product fault in assembling context that
 * retrieval did produce.
 */
export function classifyMissingTreatment(resultsRoot: string, instanceId: string): {
  state: TreatmentState; detail: string | null;
} {
  const label = `m155_vtrace_${instanceId.replace(/-/g, "_")}`;
  const logFile = path.join(resultsRoot, "_m155_paired_logs", `${label}.stderr.log`);
  if (!existsSync(logFile)) return { state: "NOT_RUN", detail: null };
  const text = readFileSync(logFile, "utf8");
  if (/vtrace index failed/.test(text)) {
    const parse = /Parser failed: ([^\n]+)/.exec(text);
    return {
      state: "TREATMENT_UNAVAILABLE_INDEX_FAILURE",
      detail: `whole-repository index aborted${parse ? `: ${parse[1]!.trim()}` : ""}`,
    };
  }
  if (/produced no vtrace context/.test(text)) {
    return { state: "TREATMENT_GENERATION_FAILURE", detail: "context generation produced nothing and reported no cause" };
  }
  return { state: "NOT_RUN", detail: null };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0 || argv[i + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[i + 1]!;
  };
  const resultsRoot = get("--results-root");
  const manifest = JSON.parse(await Bun.file(get("--manifest")).text()) as {
    manifestSha256: string;
    cases: Array<{ order: number; instance_id: string; repo: string; difficulty: string;
      armOrder: string[]; m154DeterministicGoldState: string }>;
  };
  const outDir = get("--out-dir");

  // Gold files come from the broad fixture; they are evaluation labels and are used
  // only to locate orientation events in the tool stream, never fed to the agent.
  const goldByInstance = new Map<string, readonly string[]>(
    (JSON.parse(await Bun.file(get("--fixture")).text()) as Array<{ instance_id: string; expected_files: string[] }>)
      .map((e) => [e.instance_id, e.expected_files]),
  );

  const baselineRuns: ArmRun[] = [];
  const vtraceRuns: ArmRun[] = [];
  const pairs = [];

  for (const c of manifest.cases) {
    const gold = goldByInstance.get(c.instance_id) ?? [];
    const b = await loadArm(resultsRoot, c.instance_id, "baseline", gold);
    const v = await loadArm(resultsRoot, c.instance_id, "vtrace", gold);
    const missing = v === null ? classifyMissingTreatment(resultsRoot, c.instance_id) : null;
    const treatmentState: TreatmentState = v?.treatmentState ?? missing!.state;
    if (b) baselineRuns.push(b);
    if (v) vtraceRuns.push(v);
    pairs.push({
      order: c.order,
      instance_id: c.instance_id,
      repo: c.repo,
      difficulty: c.difficulty,
      firstArm: c.armOrder[0],
      m154DeterministicGoldState: c.m154DeterministicGoldState,
      treatmentState,
      treatmentAvailable: treatmentAvailable(treatmentState),
      treatmentDetail: missing?.detail ?? v?.treatmentInvalidReason ?? null,
      baseline: b === null ? null : { grade: b.grade, patch: b.patchProduced, cost: b.costUsd, turns: b.numTurns, tokens: b.totalTokens, tools: b.toolCalls, orientation: b.orientation },
      vtrace: v === null ? null : { grade: v.grade, patch: v.patchProduced, cost: v.costUsd, turns: v.numTurns, tokens: v.totalTokens, tools: v.toolCalls, injectedContextTokens: v.injectedContextTokens, treatmentValid: v.treatmentValid, treatmentInvalidReason: v.treatmentInvalidReason, orientation: v.orientation },
      classification: classifyPair(b?.grade ?? "UNGRADED", v?.grade ?? "UNGRADED"),
    });
  }

  const complete = pairs.filter((p) => p.classification !== "incomplete");
  const counts = {
    "shared success": complete.filter((p) => p.classification === "shared success").length,
    "VTRACE unique win": complete.filter((p) => p.classification === "VTRACE unique win").length,
    "VTRACE unique loss": complete.filter((p) => p.classification === "VTRACE unique loss").length,
    "shared failure": complete.filter((p) => p.classification === "shared failure").length,
    incomplete: pairs.length - complete.length,
  };
  const wins = counts["VTRACE unique win"];
  const losses = counts["VTRACE unique loss"];
  const basePass = complete.filter((p) => p.baseline?.grade === "PASS").length;
  const vtPass = complete.filter((p) => p.vtrace?.grade === "PASS").length;

  // Treatment availability over the ORIGINAL frozen 30 (§3/§4 of the correction).
  // The paired matrix below is conditional on a treatment existing; this is the
  // number that says how often it existed at all, and the two must be read together.
  const stateCounts = pairs.reduce<Record<string, number>>((acc, p) => {
    acc[p.treatmentState] = (acc[p.treatmentState] ?? 0) + 1;
    return acc;
  }, {});
  const availableCases = pairs.filter((p) => p.treatmentAvailable);
  const unavailable = pairs.filter((p) => !p.treatmentAvailable);
  // A task where baseline PASSED and VTRACE could not be delivered at all is real
  // product harm end-to-end, even though no VTRACE agent ran and it is therefore
  // NOT an agent-behaviour unique loss. Reported, never counted in the matrix, and
  // never assumed to have "fallen back to baseline and passed".
  const baselinePassWithNoTreatment = unavailable
    .filter((p) => p.baseline?.grade === "PASS")
    .map((p) => ({ instance_id: p.instance_id, treatmentState: p.treatmentState, detail: p.treatmentDetail }));

  const availability = {
    selectedPairedTasks: pairs.length,
    treatmentAvailable: availableCases.length,
    treatmentUnavailable: unavailable.length,
    availabilityRate: pairs.length ? round(availableCases.length / pairs.length) : null,
    byState: stateCounts,
    unavailableCases: unavailable.map((p) => ({
      instance_id: p.instance_id, repo: p.repo,
      treatmentState: p.treatmentState, detail: p.treatmentDetail,
      baselineGrade: p.baseline?.grade ?? "UNGRADED",
    })),
    baselinePassWithTreatmentUnavailable: baselinePassWithNoTreatment,
    note:
      "The frozen experiment selected 30 tasks. Availability is reported over all 30; the paired outcome matrix "
      + "is conditional on a treatment existing. 28 is not the benchmark size.",
  };

  const outcomes = {
    schemaVersion: "stage5.m155.paired-outcomes.v2",
    manifestSha256: manifest.manifestSha256,
    selectedPairedTasks: pairs.length,
    treatmentAvailability: availability,
    pairedCases: pairs.length,
    completePairs: complete.length,
    matrix: counts,
    netUniqueWins: wins - losses,
    baselinePassRate: complete.length ? round(basePass / complete.length) : null,
    vtracePassRate: complete.length ? round(vtPass / complete.length) : null,
    passRateDelta: complete.length ? round((vtPass - basePass) / complete.length) : null,
    baselinePassWilson95: wilson(basePass, complete.length),
    vtracePassWilson95: wilson(vtPass, complete.length),
    mcnemarExactTwoSidedP: round(mcnemarExactP(wins, losses), 4),
    matrixDenominator: "VALID_PAIRED_AGENT_RUNS — both arms ran and were gradable",
    uncertaintyNote:
      `n=${complete.length} valid paired agent runs of ${pairs.length} selected tasks. The pass-rate delta is dominated by ${wins + losses} discordant pair(s); `
      + "with this few discordant pairs no aggregate difference is distinguishable from noise, and the "
      + "unique-win/unique-loss cases carry the information (§52).",
    pairs,
  };
  await writeFile(path.join(outDir, "stage5_m155_paired30_outcomes.json"), `${JSON.stringify(outcomes, null, 2)}\n`);

  const orientationAggregate = (runs: readonly ArmRun[]) => {
    const vals = (pick: (o: OrientationMetrics) => number | null): number[] =>
      runs.map((r) => (r.orientation === null ? null : pick(r.orientation)))
        .filter((v): v is number => v !== null);
    const reads = vals((o) => o.readsBeforeFirstEdit);
    const searches = vals((o) => o.searchesBeforeFirstEdit);
    const beforeEdit = vals((o) => o.toolCallsBeforeFirstEdit);
    const goldTouch = vals((o) => o.firstGoldTouchIndex);
    const withOrientation = runs.filter((r) => r.orientation !== null);
    return {
      runsWithTelemetry: withOrientation.length,
      medianToolCallsBeforeFirstEdit: median(beforeEdit),
      medianReadsBeforeFirstEdit: median(reads),
      medianSearchesBeforeFirstEdit: median(searches),
      medianFirstGoldTouchIndex: median(goldTouch),
      casesTouchingGoldBeforeFirstEdit: withOrientation.filter((r) => r.orientation!.goldTouchedBeforeFirstEdit === true).length,
      casesNeverTouchingGold: withOrientation.filter((r) => r.orientation!.firstGoldTouchIndex === null).length,
    };
  };

  const tokenCost = {
    schemaVersion: "stage5.m155.token-cost.v1",
    note:
      "End-to-end agent usage. Injected-context tokens are reported separately and are NOT a saving: a smaller "
      + "capsule followed by more turns is a cost (§54/§55).",
    baseline: aggregateArm("baseline", baselineRuns),
    vtrace: aggregateArm("vtrace", vtraceRuns),
    orientation: {
      note: "measured in tool calls, not seconds: the stream carries order but no per-call timestamp (§48/§58)",
      baseline: orientationAggregate(baselineRuns),
      vtrace: orientationAggregate(vtraceRuns),
    },
    injectedContextTokens: {
      cases: vtraceRuns.filter((r) => r.injectedContextTokens !== null).length,
      total: vtraceRuns.reduce((s, r) => s + (r.injectedContextTokens ?? 0), 0),
      median: median(vtraceRuns.map((r) => r.injectedContextTokens).filter((v): v is number => v !== null)),
    },
    unavailableUnderThisProtocol: [
      "get_code_context calls", "get_impact_graph calls", "VTRACE MCP calls",
      "voluntary VTRACE invocation rate", "VTRACE->grep sequencing",
    ],
    unavailableReason:
      "The historical Stage 5 protocol delivers VTRACE as injected context; no VTRACE tool is callable, so these "
      + "are UNAVAILABLE rather than zero (§13/§59).",
  };
  await writeFile(path.join(outDir, "stage5_m155_paired30_token_cost.json"), `${JSON.stringify(tokenCost, null, 2)}\n`);

  // Roadmap evidence, quantified from the frozen sample only and never generalised
  // beyond it (§5 of the correction).
  const indexRobustness = pairs.filter((p) => p.treatmentState === "TREATMENT_UNAVAILABLE_INDEX_FAILURE");
  const roadmap = {
    schemaVersion: "stage5.m155.roadmap-evidence.v1",
    scopeNote: `Counts are observed over the frozen ${pairs.length}-task paired sample. They are not extrapolated.`,
    categories: [
      {
        category: "INDEX_ROBUSTNESS / PER_FILE_PARSE_FAILURE_CONTAINMENT",
        claim:
          "A single unsupported or unparseable source file can make otherwise usable repository context "
          + "completely unavailable: `vtrace index` aborts the whole repository rather than containing the failure "
          + "to that file.",
        observed: `${indexRobustness.length}/${pairs.length} paired SWE tasks`,
        independentOfRankingQuality: true,
        cases: indexRobustness.map((p) => ({ instance_id: p.instance_id, repo: p.repo, detail: p.treatmentDetail })),
        benchmarkDiscrepancy:
          "The deterministic benchmark quarantines the offending file and continues (M134 prepare-targets retry "
          + "loop); the historical live injection path has no such loop and aborts. The deterministic layer's "
          + "ability to work around a product indexing failure does not prove the live treatment can.",
        notFixedInM155: true,
      },
    ],
  };
  await writeFile(path.join(outDir, "stage5_m155_roadmap_evidence.json"), `${JSON.stringify(roadmap, null, 2)}\n`);

  const states = ["GOLD_DELIVERED", "GOLD_DISCOVERED_BUT_DISCARDED", "GOLD_MISSING", "UNKNOWN"];
  const crossTab = {
    schemaVersion: "stage5.m155.gold-state-cross-tab.v1",
    note: "Deterministic M154 gold state (annotation only) against live paired outcome (§60).",
    rows: states.map((state) => {
      const inState = complete.filter((p) => p.m154DeterministicGoldState === state);
      return {
        goldState: state,
        cases: inState.length,
        baselinePass: inState.filter((p) => p.baseline?.grade === "PASS").length,
        vtracePass: inState.filter((p) => p.vtrace?.grade === "PASS").length,
        uniqueWins: inState.filter((p) => p.classification === "VTRACE unique win").length,
        uniqueLosses: inState.filter((p) => p.classification === "VTRACE unique loss").length,
        instanceIds: inState.map((p) => p.instance_id),
      };
    }).filter((r) => r.cases > 0),
  };
  await writeFile(path.join(outDir, "stage5_m155_paired30_gold_state_cross_tab.json"), `${JSON.stringify(crossTab, null, 2)}\n`);

  await writeFile(path.join(outDir, "stage5_m155_baseline30_runs.json"),
    `${JSON.stringify({ schemaVersion: "stage5.m155.arm-runs.v1", arm: "baseline", runs: baselineRuns }, null, 2)}\n`);
  await writeFile(path.join(outDir, "stage5_m155_vtrace30_runs.json"),
    `${JSON.stringify({ schemaVersion: "stage5.m155.arm-runs.v1", arm: "vtrace", runs: vtraceRuns }, null, 2)}\n`);

  process.stdout.write(
    `pairs=${pairs.length} complete=${complete.length} `
    + `shared_success=${counts["shared success"]} wins=${wins} losses=${losses} shared_failure=${counts["shared failure"]} `
    + `incomplete=${counts.incomplete}\n`,
  );
  process.stdout.write(
    `baseline pass=${basePass}/${complete.length} vtrace pass=${vtPass}/${complete.length} `
    + `mcnemar_p=${outcomes.mcnemarExactTwoSidedP}\n`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
