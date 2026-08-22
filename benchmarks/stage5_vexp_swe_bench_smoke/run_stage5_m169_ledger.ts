/**
 * M169-A — reconstruct the paired economic ledger from raw run authority.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m169_ledger.ts
 *
 * Reads captured artifacts ONLY. Spawns nothing, spends nothing, writes nothing
 * outside `results/`.
 *
 * The M168 summary is deliberately NOT an input (§6). Two of its inputs turn out
 * not to survive contact with the stream:
 *
 *   - the canonical `swebench-*.jsonl` row sums `message.usage` over every
 *     streamed CONTENT BLOCK, so its input side is multiplied by blocks-per-
 *     response and its `outputTokens` is the count of streamed placeholders;
 *   - `numTurns` in that row counts those same events, not requests.
 *
 * Both are recomputed here from the deduplicated requests and the terminal
 * `result` event, and the disagreement is reported rather than reconciled away.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ActionKind,
  Censoring,
  OPUS_4_5_PRICING,
  Phase,
  accountFor,
  attributePayload,
  calibrateAcrossRuns,
  censoringOf,
  checkBillingIdentity,
  checkCacheIdentity,
  classifyAction,
  isInvestigation,
  landmarksOf,
  parseRun,
  phaseCosts,
  phaseOfRequest,
  priceUsage,
  reconstructInputSide,
  type Calibration,
  type ParsedRun,
} from "./m169Economics";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";

type Arm = "baseline" | "vtrace_clean" | "vtrace_strict";
const ARMS: readonly Arm[] = ["baseline", "vtrace_clean", "vtrace_strict"];

interface LoadedRun {
  readonly label: string;
  readonly arm: Arm;
  readonly instanceId: string;
  readonly parsed: ParsedRun;
  readonly rowCostUsd: number;
  readonly rowInputTokens: number;
  readonly rowOutputTokens: number;
  readonly rowCacheReadTokens: number;
  readonly rowCacheCreationTokens: number;
  readonly rowNumTurns: number;
  readonly resolved: boolean | null;
  readonly patchEmpty: boolean;
}

function rawDir(label: string): string | null {
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return null;
  for (const child of readdirSync(parent)) {
    const dir = path.join(parent, child);
    if (readdirSync(dir).some((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))) return dir;
  }
  return null;
}

function loadRun(label: string): LoadedRun | null {
  const arm = ARMS.find((a) => label.startsWith(`m168_${a}_`));
  if (arm === undefined) return null;
  const raw = rawDir(label);
  if (raw === null) return null;
  const rowFile = readdirSync(raw).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))!;
  const line = readFileSync(path.join(raw, rowFile), "utf-8").split("\n").find((l) => l.trim());
  if (line === undefined) return null;
  const row = JSON.parse(line) as Record<string, any>;
  const streamFile = path.join(raw, "_agent_stream.first_pass.jsonl");
  if (!existsSync(streamFile)) return null;
  return {
    label,
    arm,
    instanceId: String(row.instanceId),
    parsed: parseRun(readFileSync(streamFile, "utf-8").split("\n")),
    rowCostUsd: Number(row.costUsd ?? 0),
    rowInputTokens: Number(row.inputTokens ?? 0),
    rowOutputTokens: Number(row.outputTokens ?? 0),
    rowCacheReadTokens: Number(row.cacheReadTokens ?? 0),
    rowCacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
    rowNumTurns: Number(row.numTurns ?? 0),
    resolved: row.resolved === null || row.resolved === undefined ? null : Boolean(row.resolved),
    patchEmpty: String(row.modelPatch ?? "").trim() === "",
  };
}

// ── gold, for post-hoc landmarks only (§14, §25) ────────────────────

const goldFiles = new Map<string, readonly string[]>();
if (existsSync(DATASET)) {
  for (const line of readFileSync(DATASET, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { instance_id: string; patch: string };
    const files = [...String(row.patch ?? "").matchAll(/^diff --git a\/(\S+) b\/\S+/gm)].map((m) => m[1]!);
    goldFiles.set(row.instance_id, Object.freeze([...new Set(files)]));
  }
}

// ── per-run derivation ──────────────────────────────────────────────

interface RunLedger extends Record<string, unknown> {
  readonly label: string;
  readonly arm: Arm;
  readonly instanceId: string;
}

function derive(run: LoadedRun, calibration: Calibration | null): RunLedger {
  const { parsed } = run;
  const censoring = censoringOf(parsed);
  const inputSide = reconstructInputSide(parsed.requests);
  const cacheIdentity = checkCacheIdentity(parsed.requests);
  const landmarks = landmarksOf(parsed);
  const providerUsage = parsed.result?.usage ?? null;
  const billing = checkBillingIdentity(
    providerUsage ?? { ...inputSide, outputTokens: null },
    parsed.result?.costUsd ?? null,
  );

  const inputSideCostUsd = priceUsage({ ...inputSide, outputTokens: null });
  const outputCostUsd = providerUsage === null
    ? null
    : ((providerUsage.outputTokens ?? 0) * OPUS_4_5_PRICING.outputPerMTok) / 1_000_000;

  // Ordered actions with their kinds.
  const actions: { requestIndex: number; tool: string; kind: ActionKind; filePath: string | null }[] = [];
  for (const request of parsed.requests) {
    for (const use of request.toolUses) {
      actions.push({
        requestIndex: request.index,
        tool: use.name,
        kind: classifyAction(use.name, use.command),
        filePath: use.filePath,
      });
    }
  }
  const firstEdit = landmarks.firstEditRequest;
  const preEdit = (requestIndex: number): boolean => firstEdit === null || requestIndex < firstEdit;

  const investigationAll = accountFor(parsed, calibration, (kind) => isInvestigation(kind));
  const investigationPreEdit = accountFor(parsed, calibration, (kind, index) => isInvestigation(kind) && preEdit(index));
  const pipelineAll = accountFor(parsed, calibration, (kind) => kind === ActionKind.Pipeline);

  const pipelineResults = parsed.toolResults
    .map((tr) => attributePayload(parsed, tr.orderIndex, calibration))
    .filter((a) => a !== null && a.kind === ActionKind.Pipeline);
  const firstPipeline = pipelineResults[0] ?? null;

  const phases = phaseCosts(parsed);
  const phaseByName = Object.fromEntries(phases.map((p) => [p.phase, p]));

  // Cost accumulated up to (not including) the request that issued the first edit.
  let preEditInputSideCostUsd = 0;
  let preEditPromptTokens = 0;
  for (const request of parsed.requests) {
    if (!preEdit(request.index)) break;
    preEditInputSideCostUsd += priceUsage({
      inputTokens: request.inputTokens,
      cacheCreation1hTokens: request.cacheCreation1hTokens,
      cacheCreation5mTokens: request.cacheCreation5mTokens,
      cacheReadTokens: request.cacheReadTokens,
      outputTokens: null,
    });
    preEditPromptTokens = request.promptTokens;
  }

  const filesPreEdit = new Set(actions.filter((a) => preEdit(a.requestIndex) && a.filePath !== null).map((a) => a.filePath!));
  const filesAll = new Set(actions.filter((a) => a.filePath !== null).map((a) => a.filePath!));

  // Gold landmark — diagnostic only, never an input to anything (§14, §25).
  const gold = goldFiles.get(run.instanceId) ?? null;
  let goldLandmark: Record<string, unknown> = { status: "GOLD_LANDMARK_UNAVAILABLE", reason: "no gold patch for instance" };
  if (gold !== null && gold.length > 0) {
    const touched = actions.find((a) => a.filePath !== null && gold.some((g) => a.filePath!.endsWith(g)));
    goldLandmark = touched === undefined
      ? { status: "GOLD_LANDMARK_UNAVAILABLE", reason: "no observed action names a gold file", goldFiles: gold }
      : {
          status: "OBSERVED",
          goldFiles: gold,
          firstGoldFileRequest: touched.requestIndex,
          firstGoldFileAction: actions.indexOf(touched),
          firstGoldFileTool: touched.tool,
        };
  }

  const countKind = (kind: ActionKind, within: boolean): number =>
    actions.filter((a) => a.kind === kind && (!within || preEdit(a.requestIndex))).length;

  return {
    label: run.label,
    arm: run.arm,
    instanceId: run.instanceId,
    resolved: run.resolved,
    patchEmpty: run.patchEmpty,

    censoring,
    terminalReason: parsed.result?.terminalReason ?? "NO_RESULT_EVENT",
    billingIdentityHolds: billing.holds,
    billingIdentityDeltaUsd: billing.deltaUsd,
    cacheIdentityHolds: cacheIdentity.holdsEverywhere,
    cacheIdentityViolations: cacheIdentity.violations,

    requests: parsed.requests.length,
    providerNumTurns: parsed.result?.numTurns ?? null,
    rowNumTurns: run.rowNumTurns,

    providerCostUsd: parsed.result?.costUsd ?? null,
    rowCostUsd: run.rowCostUsd,
    costUsdBasisAgrees: parsed.result === null ? false : Math.abs(parsed.result.costUsd - run.rowCostUsd) < 1e-9,

    inputTokens: inputSide.inputTokens,
    cacheCreationTokens: inputSide.cacheCreation1hTokens + inputSide.cacheCreation5mTokens,
    cacheReadTokens: inputSide.cacheReadTokens,
    outputTokens: providerUsage?.outputTokens ?? null,
    totalTrafficTokens: providerUsage === null
      ? null
      : inputSide.inputTokens + inputSide.cacheCreation1hTokens + inputSide.cacheCreation5mTokens
        + inputSide.cacheReadTokens + (providerUsage.outputTokens ?? 0),

    rowInputTokens: run.rowInputTokens,
    rowOutputTokens: run.rowOutputTokens,
    rowCacheReadTokens: run.rowCacheReadTokens,
    rowCacheCreationTokens: run.rowCacheCreationTokens,
    rowCacheReadInflationFactor: inputSide.cacheReadTokens === 0
      ? null
      : Number((run.rowCacheReadTokens / inputSide.cacheReadTokens).toFixed(4)),

    inputSideCostUsd: Number(inputSideCostUsd.toFixed(6)),
    outputCostUsd: outputCostUsd === null ? null : Number(outputCostUsd.toFixed(6)),

    toolCalls: actions.length,
    searches: countKind(ActionKind.Search, false),
    reads: countKind(ActionKind.Read, false),
    shellInspections: countKind(ActionKind.ShellInspection, false),
    testRuns: countKind(ActionKind.TestRun, false),
    environmentCalls: countKind(ActionKind.Environment, false),
    executes: countKind(ActionKind.Execute, false),
    edits: countKind(ActionKind.Edit, false),
    pipelineCalls: countKind(ActionKind.Pipeline, false),
    pipelineReuse: Math.max(0, countKind(ActionKind.Pipeline, false) - 1),
    firstActionKind: actions[0]?.kind ?? null,
    filesInspected: filesAll.size,

    firstEditRequest: firstEdit,
    firstTestRequest: landmarks.firstTestRequest,
    lastEditRequest: landmarks.lastEditRequest,
    preEditRequests: parsed.requests.filter((r) => preEdit(r.index)).length,
    preEditInputSideCostUsd: Number(preEditInputSideCostUsd.toFixed(6)),
    preEditPromptTokens,
    preEditSearches: countKind(ActionKind.Search, true),
    preEditReads: countKind(ActionKind.Read, true),
    preEditShellInspections: countKind(ActionKind.ShellInspection, true),
    preEditFilesInspected: filesPreEdit.size,

    phasePreEditCostUsd: Number((phaseByName[Phase.PreEdit]?.inputSideCostUsd ?? 0).toFixed(6)),
    phaseImplementationCostUsd: Number((phaseByName[Phase.Implementation]?.inputSideCostUsd ?? 0).toFixed(6)),
    phaseDebugTestCostUsd: Number((phaseByName[Phase.DebugTest]?.inputSideCostUsd ?? 0).toFixed(6)),
    phasePreEditOutputCostUsd: phaseByName[Phase.PreEdit]?.estimatedOutputCostUsd ?? null,
    phaseImplementationOutputCostUsd: phaseByName[Phase.Implementation]?.estimatedOutputCostUsd ?? null,
    phaseDebugTestOutputCostUsd: phaseByName[Phase.DebugTest]?.estimatedOutputCostUsd ?? null,

    pipelinePayloadTokens: firstPipeline?.payloadTokensEstimated ?? null,
    pipelinePayloadLowerBound: firstPipeline?.payloadTokensLowerBound ?? null,
    pipelinePayloadUpperBound: firstPipeline?.payloadTokensUpperBound ?? null,
    pipelineResultCharacters: firstPipeline?.resultCharacters ?? null,
    pipelineAmplificationRequests: firstPipeline?.amplificationRequests ?? null,
    pipelineWriteCostUsd: firstPipeline?.writeCostUsd ?? null,
    pipelineAmplificationCostUsd: firstPipeline?.amplificationCostUsd ?? null,
    pipelineAttributableCostUsd: pipelineAll.attributableCostUsd === 0 ? null : Number(pipelineAll.attributableCostUsd.toFixed(6)),
    pipelineAttributableTokens: pipelineAll.payloadTokens === 0 ? null : pipelineAll.payloadTokens,

    investigationCallsAll: investigationAll.calls,
    investigationTokensAll: investigationAll.payloadTokens,
    investigationCostUsdAll: Number(investigationAll.attributableCostUsd.toFixed(6)),
    investigationCallsPreEdit: investigationPreEdit.calls,
    investigationTokensPreEdit: investigationPreEdit.payloadTokens,
    investigationCostUsdPreEdit: Number(investigationPreEdit.attributableCostUsd.toFixed(6)),
    investigationByKind: investigationAll.byKind,
    nonDerivableInvestigationCalls: investigationAll.nonDerivableCalls,

    goldLandmark,
  };
}

// ── main ────────────────────────────────────────────────────────────

const labels = existsSync(RUNS) ? readdirSync(RUNS).filter((l) => l.startsWith("m168_")).sort() : [];
const loaded = labels.map(loadRun).filter((r): r is LoadedRun => r !== null);

// Calibrated ACROSS all 36 runs so that no run's payload estimate is fit to itself.
const calibration = calibrateAcrossRuns(loaded.map((r) => r.parsed));
const ledger = loaded.map((run) => derive(run, calibration));

const byInstance = new Map<string, Partial<Record<Arm, RunLedger>>>();
for (const row of ledger) {
  const bucket = byInstance.get(row.instanceId as string) ?? {};
  bucket[row.arm as Arm] = row;
  byInstance.set(row.instanceId as string, bucket);
}

const pairs = [...byInstance.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([instanceId, arms]) => {
  const a = arms.baseline ?? null;
  const c = arms.vtrace_clean ?? null;
  const b = arms.vtrace_strict ?? null;
  const uncensored = a !== null && c !== null
    && a.censoring === Censoring.Uncensored && c.censoring === Censoring.Uncensored;
  const delta = (key: string): number | null =>
    !uncensored || a === null || c === null || typeof a[key] !== "number" || typeof c[key] !== "number"
      ? null
      : Number(((c[key] as number) - (a[key] as number)).toFixed(6));
  return {
    instanceId,
    armsPresent: ARMS.filter((arm) => arms[arm] !== undefined),
    uncensoredEconomicPair: uncensored,
    censoredArms: ARMS.filter((arm) => arms[arm]?.censoring === Censoring.CostCensored),
    resolvedBaseline: a?.resolved ?? null,
    resolvedClean: c?.resolved ?? null,
    resolvedStrict: b?.resolved ?? null,
    costBaselineUsd: a?.providerCostUsd ?? null,
    costCleanUsd: c?.providerCostUsd ?? null,
    deltaCostUsd: delta("providerCostUsd"),
    deltaCacheCreationTokens: delta("cacheCreationTokens"),
    deltaCacheReadTokens: delta("cacheReadTokens"),
    deltaOutputTokens: delta("outputTokens"),
    deltaTotalTrafficTokens: delta("totalTrafficTokens"),
    deltaRequests: delta("requests"),
    deltaSearches: delta("searches"),
    deltaReads: delta("reads"),
    deltaShellInspections: delta("shellInspections"),
    deltaFilesInspected: delta("filesInspected"),
    deltaPreEditInputSideCostUsd: delta("preEditInputSideCostUsd"),
    deltaInvestigationCostUsdPreEdit: delta("investigationCostUsdPreEdit"),
  };
});

const uncensoredPairs = pairs.filter((p) => p.uncensoredEconomicPair);

const censoring = {
  schemaVersion: "stage5.m169.censoring.v1",
  milestone: "M169",
  note: "Twelve grader pairs; economic statistics require complete observations (§4).",
  graderPairs: pairs.length,
  uncensoredEconomicPairs: uncensoredPairs.length,
  censoredRuns: ledger.filter((r) => r.censoring === Censoring.CostCensored).map((r) => ({
    label: r.label,
    instanceId: r.instanceId,
    arm: r.arm,
    recordedCostUsd: r.rowCostUsd,
    recordedCostBasis: "external harness calculateCost over non-deduplicated stream events at the 5m cache-write rate",
    providerCostUsd: null,
    reconstructedInputSideCostUsd: r.inputSideCostUsd,
    outputTokensRecoverable: false,
    note: "The recorded figure is not a provider endpoint and is not on the same basis as the other eleven pairs. "
      + "It is the number that triggered the kill; the provider's own cost at kill time is at least the reconstructed "
      + "input-side figure plus an unobservable output term.",
  })),
};

const accountingDisagreement = {
  schemaVersion: "stage5.m169.accounting-disagreement.v1",
  milestone: "M169",
  finding: "The canonical swebench row's token fields are not usable as economics.",
  mechanism: "Claude Code streams one `assistant` event per content block, each repeating the whole request's usage. "
    + "The external harness sums them without deduplicating on message id, so the input side is multiplied by "
    + "blocks-per-response and `outputTokens` counts streaming placeholders (output_tokens: 1) rather than output.",
  rows: ledger.map((r) => ({
    label: r.label,
    rowCacheReadTokens: r.rowCacheReadTokens,
    providerCacheReadTokens: r.cacheReadTokens,
    inflationFactor: r.rowCacheReadInflationFactor,
    rowOutputTokens: r.rowOutputTokens,
    providerOutputTokens: r.outputTokens,
    rowNumTurns: r.rowNumTurns,
    providerNumTurns: r.providerNumTurns,
    costUsdBasisAgrees: r.costUsdBasisAgrees,
  })),
};

const write = (name: string, doc: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${name}`);
};

write("stage5_m169_paired_ledger.json", {
  schemaVersion: "stage5.m169.paired-ledger.v1",
  milestone: "M169",
  workstream: "M169-A",
  pricing: OPUS_4_5_PRICING,
  calibration: calibration === null ? null : {
    samples: calibration.samples,
    resultCharactersPerToken: Number(calibration.resultCharactersPerToken.toFixed(4)),
    authoredTokensPerCharacter: Number(calibration.authoredTokensPerCharacter.toFixed(6)),
    fixedTokensPerRequest: Number(calibration.fixedTokensPerRequest.toFixed(2)),
    rSquared: Number(calibration.rSquared.toFixed(4)),
    note: "Fit across all runs on measured cache-writes; no run's payload estimate is fit to itself.",
  },
  runs: ledger.length,
  pairs,
  perRun: ledger,
});
write("stage5_m169_censoring.json", censoring);
write("stage5_m169_accounting_disagreement.json", accountingDisagreement);

// ── console summary ─────────────────────────────────────────────────

console.log(`\nruns ${ledger.length}  grader pairs ${pairs.length}  uncensored economic pairs ${uncensoredPairs.length}`);
console.log(`billing identity holds: ${ledger.filter((r) => r.billingIdentityHolds).length}/${ledger.length}`);
console.log(`cache identity holds:   ${ledger.filter((r) => r.cacheIdentityHolds).length}/${ledger.length}`);
if (calibration !== null) {
  console.log(`calibration: ${calibration.resultCharactersPerToken.toFixed(2)} chars/token, R2=${calibration.rSquared.toFixed(3)}, n=${calibration.samples}`);
}
const cleanHigher = uncensoredPairs.filter((p) => (p.deltaCostUsd ?? 0) > 0).length;
console.log(`CLEAN cost higher on ${cleanHigher}/${uncensoredPairs.length} uncensored pairs`);
const deltas = uncensoredPairs.map((p) => p.deltaCostUsd ?? 0).sort((x, y) => x - y);
const mid = deltas.length === 0 ? 0 : deltas.length % 2 === 1
  ? deltas[(deltas.length - 1) / 2]!
  : (deltas[deltas.length / 2 - 1]! + deltas[deltas.length / 2]!) / 2;
console.log(`median paired cost delta (CLEAN - BASELINE): $${mid.toFixed(4)}`);
