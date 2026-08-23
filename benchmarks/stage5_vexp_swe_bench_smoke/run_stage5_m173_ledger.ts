/**
 * M173-C — reconstruct the paired ledger from raw run authority.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_ledger.ts
 *
 * Reads captured artifacts ONLY. Spawns nothing, spends nothing, writes nothing
 * outside `results/`.
 *
 * The economic primitives are imported from `m169Economics` unchanged — the
 * deduplication on `message.id`, the billing identity, the action taxonomy, the
 * pre-edit landmark and the payload attribution. §27 forbids redefining
 * "investigation" after seeing results, and the cheapest way to keep that
 * promise is to not own a second copy of the definition.
 *
 * What is NEW here, because M173 asks a question M169 could not:
 *
 *   DISCLOSURE     every pipeline tool_result is classified by what the MODEL
 *                  saw — compact orientation, authoritative debug, or a failure
 *                  envelope. §49's contamination check is a measurement, not an
 *                  assumption, because `detail` is an argument the agent can
 *                  reach and blocking it would be a product change.
 *   INVENTORY      the OBSERVED tool list from each run's system/init event.
 *                  The harness's declared whitelist is not evidence of it: the
 *                  agent is spawned by the external VEXP harness and inherits
 *                  the full Claude Code tool set.
 *   COMPLIANCE     whether run_pipeline was the first repository action, with
 *                  the ordinary actions that preceded it named if any did.
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
  priceUsage,
  reconstructInputSide,
  type Calibration,
  type ParsedRun,
} from "./m169Economics";
import { Disclosure, classifyDisclosure } from "./m173Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

type Arm = "baseline" | "vtrace_compact";
const ARMS: readonly Arm[] = ["baseline", "vtrace_compact"];

// ── loading ─────────────────────────────────────────────────────────

interface LoadedRun {
  readonly label: string;
  readonly arm: Arm;
  readonly instanceId: string;
  readonly parsed: ParsedRun;
  readonly lines: readonly string[];
  readonly rowCostUsd: number;
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
  const arm = ARMS.find((a) => label.startsWith(`m173_${a}_`));
  if (arm === undefined) return null;
  const raw = rawDir(label);
  if (raw === null) return null;
  const rowFile = readdirSync(raw).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))!;
  const line = readFileSync(path.join(raw, rowFile), "utf-8").split("\n").find((l) => l.trim());
  if (line === undefined) return null;
  const row = JSON.parse(line) as Record<string, unknown>;
  const streamFile = path.join(raw, "_agent_stream.first_pass.jsonl");
  if (!existsSync(streamFile)) return null;
  const lines = readFileSync(streamFile, "utf-8").split("\n");
  return {
    label,
    arm,
    instanceId: String(row.instanceId),
    parsed: parseRun(lines),
    lines,
    rowCostUsd: Number(row.costUsd ?? 0),
    rowNumTurns: Number(row.numTurns ?? 0),
    resolved: row.resolved === null || row.resolved === undefined ? null : Boolean(row.resolved),
    patchEmpty: String(row.modelPatch ?? "").trim() === "",
  };
}

// ── the observed session, read from the stream rather than declared ──

interface ObservedSession {
  readonly model: string | null;
  readonly tools: readonly string[];
  readonly vtraceTools: readonly string[];
  readonly mcpServers: readonly string[];
}

function observedSession(lines: readonly string[]): ObservedSession {
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.type !== "system" || row.subtype !== "init") continue;
    const tools = (Array.isArray(row.tools) ? row.tools : []).map(String).sort();
    const servers = (Array.isArray(row.mcp_servers) ? row.mcp_servers : [])
      .map((s) => String((s as { name?: unknown }).name ?? "")).sort();
    return {
      model: typeof row.model === "string" ? row.model : null,
      tools: Object.freeze(tools),
      vtraceTools: Object.freeze(tools.filter((t) => t.toLowerCase().includes("vtrace"))),
      mcpServers: Object.freeze(servers),
    };
  }
  return { model: null, tools: [], vtraceTools: [], mcpServers: [] };
}

// ── what the model was handed by every pipeline call ────────────────

interface PipelineCall {
  readonly ordinal: number;
  readonly requestIndex: number;
  readonly toolName: string;
  /** The arguments the agent chose, so a `detail` request is visible. */
  readonly requestedDetail: string | null;
  readonly resultCharacters: number;
  readonly disclosure: Disclosure;
  readonly focusFile: string | null;
  readonly focusAt: string | null;
  readonly relatedFiles: readonly string[];
  readonly isError: boolean;
}

/**
 * Walk the stream pairing each MCP tool_use with the tool_result that answers
 * it. The k-th tool_use of a request answers the k-th tool_result after it —
 * the same rule `attributePayload` uses, so the two views cannot disagree about
 * which result belongs to which call.
 */
function pipelineCalls(run: ParsedRun, lines: readonly string[]): readonly PipelineCall[] {
  // Raw argument objects, in tool_use order, keyed by request index.
  const argumentsByRequest = new Map<number, Record<string, unknown>[]>();
  {
    const byId = new Map<string, number>();
    let index = 0;
    for (const line of lines) {
      if (line.trim() === "") continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (row.type !== "assistant") continue;
      const message = row.message as Record<string, unknown> | undefined;
      const id = typeof message?.id === "string" ? message.id : null;
      if (message === undefined || id === null) continue;
      let requestIndex = byId.get(id);
      if (requestIndex === undefined) { requestIndex = index; byId.set(id, index); index += 1; }
      const blocks = (Array.isArray(message.content) ? message.content : []) as Record<string, unknown>[];
      const bucket = argumentsByRequest.get(requestIndex) ?? [];
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        bucket.push((block.input ?? {}) as Record<string, unknown>);
      }
      argumentsByRequest.set(requestIndex, bucket);
    }
  }

  // Raw tool_result texts, in order.
  const resultTexts: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.type !== "user") continue;
    const message = row.message as Record<string, unknown> | undefined;
    const blocks = (Array.isArray(message?.content) ? message?.content : []) as Record<string, unknown>[];
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      resultTexts.push(typeof content === "string" ? content : JSON.stringify(content ?? ""));
    }
  }

  const calls: PipelineCall[] = [];
  let ordinal = 0;
  for (const toolResult of run.toolResults) {
    const issuing = run.requests[toolResult.afterRequestIndex];
    if (issuing === undefined) continue;
    const siblings = run.toolResults.filter((r) => r.afterRequestIndex === toolResult.afterRequestIndex);
    const siblingIndex = Math.max(0, siblings.findIndex((r) => r.orderIndex === toolResult.orderIndex));
    const use = issuing.toolUses[siblingIndex] ?? issuing.toolUses[0];
    if (use === undefined) continue;
    if (classifyAction(use.name, use.command) !== ActionKind.Pipeline) continue;

    const args = (argumentsByRequest.get(issuing.index) ?? [])[siblingIndex] ?? {};
    const text = resultTexts[toolResult.orderIndex] ?? "";
    const disclosure = classifyDisclosure(text);

    let focusFile: string | null = null;
    let focusAt: string | null = null;
    let relatedFiles: string[] = [];
    try {
      const parsedText = JSON.parse(text) as Record<string, any>;
      const output = parsedText?.result?.output ?? parsedText;
      if (typeof output?.focus?.file === "string") focusFile = output.focus.file;
      if (typeof output?.focus?.at === "string") focusAt = output.focus.at;
      if (Array.isArray(output?.related)) {
        relatedFiles = output.related
          .map((r: Record<string, unknown>) => (typeof r?.file === "string" ? r.file : null))
          .filter((f: string | null): f is string => f !== null);
      }
    } catch { /* not JSON: the disclosure classifier already recorded that */ }

    ordinal += 1;
    calls.push({
      ordinal,
      requestIndex: issuing.index,
      toolName: use.name,
      requestedDetail: typeof args.detail === "string" ? args.detail : null,
      resultCharacters: toolResult.characters,
      disclosure,
      focusFile,
      focusAt,
      relatedFiles: Object.freeze([...new Set(relatedFiles)]),
      isError: toolResult.isError,
    });
  }
  return Object.freeze(calls);
}

// ── gold, for post-hoc landmarks only ───────────────────────────────

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

function derive(run: LoadedRun, calibration: Calibration | null): Record<string, unknown> {
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
  const session = observedSession(run.lines);
  const calls = pipelineCalls(parsed, run.lines);

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

  const attributedPipelines = parsed.toolResults
    .map((tr) => attributePayload(parsed, tr.orderIndex, calibration))
    .filter((a) => a !== null && a.kind === ActionKind.Pipeline);
  const firstPipeline = attributedPipelines[0] ?? null;

  const phases = phaseCosts(parsed);
  const phaseByName = Object.fromEntries(phases.map((p) => [p.phase, p]));

  let preEditInputSideCostUsd = 0;
  for (const request of parsed.requests) {
    if (!preEdit(request.index)) break;
    preEditInputSideCostUsd += priceUsage({
      inputTokens: request.inputTokens,
      cacheCreation1hTokens: request.cacheCreation1hTokens,
      cacheCreation5mTokens: request.cacheCreation5mTokens,
      cacheReadTokens: request.cacheReadTokens,
      outputTokens: null,
    });
  }

  const countKind = (kind: ActionKind, within: boolean): number =>
    actions.filter((a) => a.kind === kind && (!within || preEdit(a.requestIndex))).length;

  // §55 — ordinary repository actions taken BEFORE the first pipeline call.
  const firstPipelineAction = actions.findIndex((a) => a.kind === ActionKind.Pipeline);
  const ordinaryActionsBeforePipeline = firstPipelineAction === -1
    ? actions.filter((a) => a.kind !== ActionKind.Pipeline).length
    : actions.slice(0, firstPipelineAction).filter((a) => a.kind !== ActionKind.Pipeline).length;

  const gold = goldFiles.get(run.instanceId) ?? null;
  const touchedGold = gold === null
    ? null
    : actions.find((a) => a.filePath !== null && gold.some((g) => a.filePath!.endsWith(g))) ?? null;

  const orientation = calls[0] ?? null;

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

    observedModel: session.model,
    observedToolCount: session.tools.length,
    observedVtraceTools: session.vtraceTools,
    observedMcpServers: session.mcpServers,

    requests: parsed.requests.length,
    providerNumTurns: parsed.result?.numTurns ?? null,
    rowNumTurns: run.rowNumTurns,

    providerCostUsd: parsed.result?.costUsd ?? null,
    rowCostUsd: run.rowCostUsd,

    inputTokens: inputSide.inputTokens,
    cacheCreationTokens: inputSide.cacheCreation1hTokens + inputSide.cacheCreation5mTokens,
    cacheReadTokens: inputSide.cacheReadTokens,
    outputTokens: providerUsage?.outputTokens ?? null,
    totalTrafficTokens: providerUsage === null
      ? null
      : inputSide.inputTokens + inputSide.cacheCreation1hTokens + inputSide.cacheCreation5mTokens
        + inputSide.cacheReadTokens + (providerUsage.outputTokens ?? 0),

    inputSideCostUsd: Number(priceUsage({ ...inputSide, outputTokens: null }).toFixed(6)),
    outputCostUsd: providerUsage === null
      ? null
      : Number((((providerUsage.outputTokens ?? 0) * OPUS_4_5_PRICING.outputPerMTok) / 1_000_000).toFixed(6)),

    toolCalls: actions.length,
    searches: countKind(ActionKind.Search, false),
    reads: countKind(ActionKind.Read, false),
    shellInspections: countKind(ActionKind.ShellInspection, false),
    testRuns: countKind(ActionKind.TestRun, false),
    edits: countKind(ActionKind.Edit, false),
    pipelineCalls: countKind(ActionKind.Pipeline, false),
    voluntaryPipelineReuse: Math.max(0, countKind(ActionKind.Pipeline, false) - 1),
    firstActionKind: actions[0]?.kind ?? null,
    filesInspected: new Set(actions.filter((a) => a.filePath !== null).map((a) => a.filePath!)).size,

    firstEditRequest: firstEdit,
    firstTestRequest: landmarks.firstTestRequest,
    lastEditRequest: landmarks.lastEditRequest,
    preEditRequests: parsed.requests.filter((r) => preEdit(r.index)).length,
    preEditInputSideCostUsd: Number(preEditInputSideCostUsd.toFixed(6)),
    preEditSearches: countKind(ActionKind.Search, true),
    preEditReads: countKind(ActionKind.Read, true),
    preEditShellInspections: countKind(ActionKind.ShellInspection, true),
    preEditFilesInspected: new Set(
      actions.filter((a) => preEdit(a.requestIndex) && a.filePath !== null).map((a) => a.filePath!),
    ).size,

    phasePreEditCostUsd: Number((phaseByName[Phase.PreEdit]?.inputSideCostUsd ?? 0).toFixed(6)),
    phaseImplementationCostUsd: Number((phaseByName[Phase.Implementation]?.inputSideCostUsd ?? 0).toFixed(6)),
    phaseDebugTestCostUsd: Number((phaseByName[Phase.DebugTest]?.inputSideCostUsd ?? 0).toFixed(6)),

    // §55 compliance
    firstRepositoryActionIsPipeline: actions[0]?.kind === ActionKind.Pipeline,
    ordinaryActionsBeforePipeline,

    // §20/§49/§53 disclosure
    orientationDisclosure: orientation?.disclosure ?? null,
    orientationCharacters: orientation?.resultCharacters ?? null,
    orientationPayloadTokens: firstPipeline?.payloadTokensEstimated ?? null,
    orientationFocusFile: orientation?.focusFile ?? null,
    orientationFocusAt: orientation?.focusAt ?? null,
    orientationRelatedFiles: orientation?.relatedFiles ?? null,
    orientationAmplificationRequests: firstPipeline?.amplificationRequests ?? null,
    orientationWriteCostUsd: firstPipeline?.writeCostUsd ?? null,
    orientationAmplificationCostUsd: firstPipeline?.amplificationCostUsd ?? null,
    orientationAttributableCostUsd: firstPipeline?.totalAttributableCostUsd === undefined
      ? null : Number((firstPipeline?.totalAttributableCostUsd ?? 0).toFixed(6)),
    allPipelineAttributableCostUsd: pipelineAll.attributableCostUsd === 0
      ? null : Number(pipelineAll.attributableCostUsd.toFixed(6)),
    agentRequestedDetailLevels: calls.map((c) => c.requestedDetail).filter((d): d is string => d !== null),
    anyAuthoritativeDebugSeen: calls.some((c) => c.disclosure === Disclosure.AuthoritativeDebug),
    pipelineCallDetail: calls,

    investigationCallsAll: investigationAll.calls,
    investigationTokensAll: investigationAll.payloadTokens,
    investigationCostUsdAll: Number(investigationAll.attributableCostUsd.toFixed(6)),
    investigationCallsPreEdit: investigationPreEdit.calls,
    investigationTokensPreEdit: investigationPreEdit.payloadTokens,
    investigationCostUsdPreEdit: Number(investigationPreEdit.attributableCostUsd.toFixed(6)),
    investigationByKind: investigationAll.byKind,

    goldFiles: gold,
    firstGoldFileRequest: touchedGold?.requestIndex ?? null,
    firstGoldFileTool: touchedGold?.tool ?? null,
  };
}

// ── main ────────────────────────────────────────────────────────────

const labels = existsSync(RUNS) ? readdirSync(RUNS).filter((l) => l.startsWith("m173_")).sort() : [];
const loaded = labels.map(loadRun).filter((r): r is LoadedRun => r !== null);

if (loaded.length === 0) {
  console.log("no M173 runs found yet");
  process.exit(0);
}

// Calibrated ACROSS all runs so that no run's payload estimate is fit to itself.
const calibration = calibrateAcrossRuns(loaded.map((r) => r.parsed));
const perRun = loaded.map((run) => derive(run, calibration));

const byInstance = new Map<string, Partial<Record<Arm, Record<string, unknown>>>>();
for (const row of perRun) {
  const instanceId = row.instanceId as string;
  const bucket = byInstance.get(instanceId) ?? {};
  bucket[row.arm as Arm] = row;
  byInstance.set(instanceId, bucket);
}

const pairs = [...byInstance.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([instanceId, arms]) => {
  const a = arms.baseline ?? null;
  const b = arms.vtrace_compact ?? null;
  const uncensored = a !== null && b !== null
    && a.censoring === Censoring.Uncensored && b.censoring === Censoring.Uncensored;
  const delta = (key: string): number | null =>
    !uncensored || a === null || b === null || typeof a[key] !== "number" || typeof b[key] !== "number"
      ? null
      : Number(((b[key] as number) - (a[key] as number)).toFixed(6));
  return {
    instanceId,
    armsPresent: ARMS.filter((arm) => arms[arm] !== undefined),
    uncensoredEconomicPair: uncensored,
    censoredArms: ARMS.filter((arm) => arms[arm]?.censoring === Censoring.CostCensored),
    resolvedBaseline: (a?.resolved ?? null) as boolean | null,
    resolvedCompact: (b?.resolved ?? null) as boolean | null,
    costBaselineUsd: (a?.providerCostUsd ?? null) as number | null,
    costCompactUsd: (b?.providerCostUsd ?? null) as number | null,
    deltaCostUsd: delta("providerCostUsd"),
    deltaTotalTrafficTokens: delta("totalTrafficTokens"),
    deltaPreEditInputSideCostUsd: delta("preEditInputSideCostUsd"),
    deltaInvestigationCostUsdPreEdit: delta("investigationCostUsdPreEdit"),
    deltaInvestigationCostUsdAll: delta("investigationCostUsdAll"),
    deltaRequests: delta("requests"),
    deltaSearches: delta("searches"),
    deltaReads: delta("reads"),
    deltaShellInspections: delta("shellInspections"),
    deltaFirstEditRequest: delta("firstEditRequest"),
    orientationAttributableCostUsd: (b?.orientationAttributableCostUsd ?? null) as number | null,
    orientationCharacters: (b?.orientationCharacters ?? null) as number | null,
    orientationPayloadTokens: (b?.orientationPayloadTokens ?? null) as number | null,
  };
});

const report = {
  schemaVersion: "stage5.m173.paired-ledger.v1",
  milestone: "M173",
  workstream: "M173-C",
  accounting: {
    module: "m169Economics, imported unchanged",
    deduplicationKey: "message.id",
    validatedBy: "stage5_m173_accounting_controls.json",
  },
  calibration,
  runsFound: loaded.length,
  pairsFound: pairs.length,
  completePairs: pairs.filter((p) => p.armsPresent.length === 2).length,
  uncensoredPairs: pairs.filter((p) => p.uncensoredEconomicPair).length,
  perRun,
  pairs,
};

writeFileSync(path.join(RESULTS, "stage5_m173_paired_ledger.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`M173 ledger: ${loaded.length} runs, ${report.completePairs} complete pairs, ${report.uncensoredPairs} uncensored`);
for (const pair of pairs) {
  console.log(
    `  ${pair.instanceId.padEnd(34)} A=${pair.resolvedBaseline} B=${pair.resolvedCompact}`
    + ` ΔcostUsd=${pair.deltaCostUsd ?? "-"} orientation=${pair.orientationCharacters ?? "-"}ch`,
  );
}
