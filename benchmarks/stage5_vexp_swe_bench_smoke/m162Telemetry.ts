/**
 * M162-C — ordered VTRACE tool-call telemetry (pure).
 *
 * M161 could only count the agent's ordinary tools, so "did VTRACE help" had to
 * be inferred from downstream behaviour. M162 can finally observe the VTRACE
 * interaction itself — but only if the observation survives the sweep, which is
 * why this is built and controlled BEFORE any live run rather than after.
 *
 * Design follows the seam the harness already uses: the injected adapter patch
 * stays dumb (it dumps the raw authoritative stream), and all interpretation
 * happens here, in ordinary benchmark code that can be unit-tested and revised
 * without touching a live run.
 *
 * Everything here is evaluator-side. None of these labels may reach product
 * behaviour, and nothing may act on them mid-sweep.
 */

import { createHash } from "node:crypto";

import { FROZEN_CALLABLE_TOOL_IDS, VTRACE_MCP_SERVER_NAME } from "./m162Callable";

/** One ordered agent tool call, as `_tool_calls_with_outputs.json` records it. */
export interface RawToolCall {
  readonly index: number | string;
  readonly tool: string;
  readonly category?: string | null;
  readonly path?: string | null;
  readonly args?: Record<string, unknown> | null;
  readonly command?: string | null;
  readonly output?: unknown;
  readonly latencyMs?: number | null;
  readonly turn?: number | null;
}

export type VtraceResultState = "VALID_NONEMPTY" | "VALID_EMPTY" | "DEGRADED_VALID" | "TOOL_ERROR";

/**
 * Why a call was made, assigned post-hoc from ordered evidence. Evaluator-only:
 * these labels exist to make transcripts comparable, never to steer the agent.
 */
export type VtraceCallPurpose =
  | "INITIAL_ORIENTATION"
  | "TARGETED_IMPLEMENTATION_LOOKUP"
  | "IMPACT_ANALYSIS"
  | "FOLLOW_UP_HYPOTHESIS"
  | "TEST_TO_IMPLEMENTATION"
  | "CONFIRMATION_OR_REDUNDANT"
  | "OTHER";

export interface VtraceCallRecord {
  readonly sequence: number;
  readonly rawIndex: number | string;
  readonly turn: number | null;
  readonly toolId: string;
  readonly modelVisibleName: string;
  readonly args: Record<string, unknown>;
  readonly argsHash: string;
  readonly queryLength: number;
  readonly resultState: VtraceResultState;
  readonly itemCount: number;
  readonly responseChars: number;
  readonly responseEstimatedTokens: number;
  readonly responseHash: string;
  readonly latencyMs: number | null;
  /** Repo-relative paths this call returned — the basis for utilization analysis. */
  readonly returnedPaths: readonly string[];
  /** Canonical identities this call returned — the basis for composition analysis. */
  readonly returnedFqNames: readonly string[];
  readonly beforeFirstEdit: boolean;
  readonly purpose: VtraceCallPurpose;
}

/** Whether the agent used the tools at all. Zero use is a legitimate outcome. */
export type ToolAdoptionState = "TOOLS_AVAILABLE_USED" | "TOOLS_AVAILABLE_NOT_USED" | "TOOLS_UNAVAILABLE";

/**
 * When the FIRST VTRACE call happened relative to the agent's own work.
 *
 * Precedence is fixed here, before any live run, so an ambiguous transcript
 * cannot be resolved in whichever direction flatters the result. Categories are
 * evaluated in declaration order and the first match wins.
 */
export type FirstVtraceCallTiming =
  | "NEVER_USED"
  | "BEFORE_ANY_REPO_SEARCH"
  | "AFTER_REPO_SEARCH_BEFORE_READ"
  | "AFTER_READ_BEFORE_EDIT"
  | "AFTER_TEST_FAILURE"
  | "AFTER_FIRST_EDIT";

const SEARCH_TOOLS = new Set(["grep", "glob"]);
const READ_TOOLS = new Set(["read"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

function normalizeToolName(tool: string): string {
  return tool.toLowerCase().trim();
}

/** The model-visible MCP name for a frozen tool id. */
export function modelVisibleName(toolId: string): string {
  return `mcp__${VTRACE_MCP_SERVER_NAME}__${toolId}`;
}

/** Map a model-visible name back to a frozen tool id, or undefined. */
export function vtraceToolIdOf(tool: string): string | undefined {
  const normalized = normalizeToolName(tool);
  for (const toolId of FROZEN_CALLABLE_TOOL_IDS) {
    if (normalized === modelVisibleName(toolId).toLowerCase()) return toolId;
  }
  return undefined;
}

export function isVtraceCall(call: RawToolCall): boolean {
  return vtraceToolIdOf(call.tool) !== undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

/** Recursive degradation probe — the signal is nested, not top-level. */
function hasDegradationSignal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDegradationSignal);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.coverageComplete === false) return true;
  if (typeof record.failedFiles === "number" && record.failedFiles > 0) return true;
  return Object.values(record).some(hasDegradationSignal);
}

export interface ParsedVtraceResponse {
  readonly state: VtraceResultState;
  readonly itemCount: number;
  readonly paths: readonly string[];
  readonly fqNames: readonly string[];
}

/**
 * Interpret one VTRACE tool result.
 *
 * The four states are kept strictly separate. An empty result is a SUCCESSFUL
 * call that found nothing, and an error is a call that could not be answered;
 * collapsing them in either direction is the specific mistake that made M155
 * file a product failure as an empty delivery and M161 file a correct refusal
 * as a failure.
 */
export function parseVtraceResponse(output: unknown): ParsedVtraceResponse {
  const text = outputText(output);
  if (text.length === 0) {
    return { state: "TOOL_ERROR", itemCount: 0, paths: [], fqNames: [] };
  }

  let parsed: Record<string, unknown> | undefined;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = undefined; }
  if (parsed === undefined) {
    // Unparseable payloads are errors, not silent empties.
    return { state: "TOOL_ERROR", itemCount: 0, paths: [], fqNames: [] };
  }

  if (typeof parsed.code === "string" && typeof parsed.message === "string" && parsed.productContext === undefined) {
    return { state: "TOOL_ERROR", itemCount: 0, paths: [], fqNames: [] };
  }

  const productContext = parsed.productContext as Record<string, unknown> | undefined;
  const items = (productContext?.items ?? []) as Array<Record<string, unknown>>;
  const paths = items.map((item) => item.path).filter((value): value is string => typeof value === "string");
  const fqNames = items
    .map((item) => item.fqName)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const resolvedSymbol = parsed.resolvedSymbol as Record<string, unknown> | undefined;
  const nodes = (parsed.nodes ?? []) as unknown[];
  if (resolvedSymbol !== undefined) {
    const symbolPath = typeof resolvedSymbol.filePath === "string" ? [resolvedSymbol.filePath] : [];
    const symbolFq = typeof resolvedSymbol.fqName === "string" ? [resolvedSymbol.fqName] : [];
    const state: VtraceResultState = hasDegradationSignal(parsed) ? "DEGRADED_VALID" : "VALID_NONEMPTY";
    return { state, itemCount: nodes.length, paths: symbolPath, fqNames: symbolFq };
  }

  const degraded = hasDegradationSignal(parsed);
  if (items.length === 0) {
    return { state: degraded ? "DEGRADED_VALID" : "VALID_EMPTY", itemCount: 0, paths: [], fqNames: [] };
  }
  return {
    state: degraded ? "DEGRADED_VALID" : "VALID_NONEMPTY",
    itemCount: items.length,
    paths,
    fqNames,
  };
}

/** Index of the first edit/write in the ordered sequence, or null. */
export function firstEditPosition(calls: readonly RawToolCall[]): number | null {
  const index = calls.findIndex((call) => EDIT_TOOLS.has(normalizeToolName(call.tool)));
  return index === -1 ? null : index;
}

function looksLikeFailingTest(call: RawToolCall): boolean {
  const command = (call.command ?? "").toLowerCase();
  if (command.length === 0) return false;
  const isTestCommand = /\b(pytest|tox|unittest|nose|py\.test)\b/.test(command)
    || /python\s+-m\s+pytest/.test(command);
  if (!isTestCommand) return false;
  const output = outputText(call.output).toLowerCase();
  return /\b(failed|error|assertionerror|traceback)\b/.test(output);
}

/**
 * Classify when the agent first reached for VTRACE.
 *
 * Precedence, highest first: never used; before any repository search; after a
 * search but before opening a file; after a test failure; after the first edit;
 * otherwise after a read but before editing.
 */
export function classifyFirstCallTiming(calls: readonly RawToolCall[]): FirstVtraceCallTiming {
  const firstVtrace = calls.findIndex(isVtraceCall);
  if (firstVtrace === -1) return "NEVER_USED";

  const before = calls.slice(0, firstVtrace);
  const searched = before.some((call) => SEARCH_TOOLS.has(normalizeToolName(call.tool)));
  const read = before.some((call) => READ_TOOLS.has(normalizeToolName(call.tool)));
  const edited = before.some((call) => EDIT_TOOLS.has(normalizeToolName(call.tool)));
  const testFailed = before.some(looksLikeFailingTest);

  if (!searched && !read && !edited) return "BEFORE_ANY_REPO_SEARCH";
  if (searched && !read && !edited) return "AFTER_REPO_SEARCH_BEFORE_READ";
  if (testFailed) return "AFTER_TEST_FAILURE";
  if (edited) return "AFTER_FIRST_EDIT";
  return "AFTER_READ_BEFORE_EDIT";
}

function classifyPurpose(
  call: RawToolCall,
  toolId: string,
  sequence: number,
  precedingVtrace: readonly VtraceCallRecord[],
  before: readonly RawToolCall[],
): VtraceCallPurpose {
  if (toolId === "get_impact_graph") return "IMPACT_ANALYSIS";

  const args = (call.args ?? {}) as Record<string, unknown>;
  const query = String(args.task ?? args.query ?? "");

  if (sequence === 0 && before.every((entry) => !SEARCH_TOOLS.has(normalizeToolName(entry.tool)))) {
    return "INITIAL_ORIENTATION";
  }
  // An identical query repeated is a confirmation, not new investigation.
  if (precedingVtrace.some((entry) => String((entry.args.task ?? entry.args.query) ?? "") === query)) {
    return "CONFIRMATION_OR_REDUNDANT";
  }
  if (before.some(looksLikeFailingTest)) return "TEST_TO_IMPLEMENTATION";
  if (precedingVtrace.length > 0) return "FOLLOW_UP_HYPOTHESIS";
  return "TARGETED_IMPLEMENTATION_LOOKUP";
}

/** Extract every VTRACE call, in order, with its interpreted result. */
export function extractVtraceCalls(calls: readonly RawToolCall[]): readonly VtraceCallRecord[] {
  const firstEdit = firstEditPosition(calls);
  const records: VtraceCallRecord[] = [];

  calls.forEach((call, position) => {
    const toolId = vtraceToolIdOf(call.tool);
    if (toolId === undefined) return;

    const args = (call.args ?? {}) as Record<string, unknown>;
    const parsed = parseVtraceResponse(call.output);
    const text = outputText(call.output);
    const query = String(args.task ?? args.query ?? args.symbol_fqn ?? "");

    records.push({
      sequence: records.length,
      rawIndex: call.index,
      turn: call.turn ?? null,
      toolId,
      modelVisibleName: modelVisibleName(toolId),
      args,
      argsHash: sha256(stableStringify(args)),
      queryLength: query.length,
      resultState: parsed.state,
      itemCount: parsed.itemCount,
      responseChars: text.length,
      responseEstimatedTokens: Math.ceil(text.length / 4),
      responseHash: sha256(text),
      latencyMs: call.latencyMs ?? null,
      returnedPaths: parsed.paths,
      returnedFqNames: parsed.fqNames,
      beforeFirstEdit: firstEdit === null || position < firstEdit,
      purpose: classifyPurpose(call, toolId, records.length, records, calls.slice(0, position)),
    });
  });

  return records;
}

export interface CompositionEvent {
  readonly contextSequence: number;
  readonly impactSequence: number;
  /** True when the impact argument is byte-identical to a returned fqName. */
  readonly identifierFromReturnedFqName: boolean;
  readonly identifier: string;
}

/**
 * Detect `get_code_context` → `get_impact_graph` composition.
 *
 * Whether the identifier was COPIED from a previous result or invented is the
 * whole point: it separates two tools that happen to be available from a scaffold
 * the agent can actually chain. M162-A existed because that chain was broken.
 */
export function detectComposition(records: readonly VtraceCallRecord[]): readonly CompositionEvent[] {
  const events: CompositionEvent[] = [];

  records.forEach((record) => {
    if (record.toolId !== "get_impact_graph") return;
    const identifier = String(record.args.symbol_fqn ?? "");
    if (identifier.length === 0) return;

    for (let index = record.sequence - 1; index >= 0; index -= 1) {
      const earlier = records[index]!;
      if (earlier.toolId !== "get_code_context") continue;
      events.push({
        contextSequence: earlier.sequence,
        impactSequence: record.sequence,
        identifierFromReturnedFqName: earlier.returnedFqNames.includes(identifier),
        identifier,
      });
      return;
    }
  });

  return events;
}

export type UtilizationOutcome =
  | "READ_RETURNED_PATH"
  | "EDITED_RETURNED_PATH"
  | "IMPACT_ON_RETURNED_FQNAME"
  | "TESTED_RETURNED_PATH"
  | "IGNORED";

export interface UtilizationRecord {
  readonly sequence: number;
  readonly outcomes: readonly UtilizationOutcome[];
  readonly used: boolean;
}

/**
 * What the agent did with each result.
 *
 * Far more informative than counting calls: a tool that is called and ignored
 * and a tool that is called and acted on look identical in a call count.
 */
export function analyzeUtilization(
  calls: readonly RawToolCall[],
  records: readonly VtraceCallRecord[],
): readonly UtilizationRecord[] {
  const positionOf = new Map<number, number>();
  let seen = 0;
  calls.forEach((call, position) => {
    if (isVtraceCall(call)) {
      positionOf.set(seen, position);
      seen += 1;
    }
  });

  return records.map((record) => {
    const start = positionOf.get(record.sequence) ?? 0;
    const after = calls.slice(start + 1);
    const outcomes = new Set<UtilizationOutcome>();

    for (const call of after) {
      const tool = normalizeToolName(call.tool);
      const target = call.path ?? null;
      const matchesPath = target !== null && record.returnedPaths.includes(target);

      if (matchesPath && READ_TOOLS.has(tool)) outcomes.add("READ_RETURNED_PATH");
      if (matchesPath && EDIT_TOOLS.has(tool)) outcomes.add("EDITED_RETURNED_PATH");
      if (vtraceToolIdOf(call.tool) === "get_impact_graph") {
        const identifier = String(((call.args ?? {}) as Record<string, unknown>).symbol_fqn ?? "");
        if (record.returnedFqNames.includes(identifier)) outcomes.add("IMPACT_ON_RETURNED_FQNAME");
      }
      const command = (call.command ?? "").toLowerCase();
      if (command.length > 0 && record.returnedPaths.some((entry) => command.includes(entry.toLowerCase()))) {
        outcomes.add("TESTED_RETURNED_PATH");
      }
    }

    const list = [...outcomes];
    return {
      sequence: record.sequence,
      outcomes: list.length === 0 ? ["IGNORED"] : list,
      used: list.length > 0,
    };
  });
}

export interface RedundantLookup {
  readonly sequence: number;
  readonly rediscoveredTerm: string;
  readonly tool: string;
}

/**
 * Rediscovery detector: the agent is handed a location and immediately searches
 * for it anyway.
 *
 * Deliberately conservative. Reading an implementation after orientation is
 * expected and useful, and counting it as redundant would manufacture evidence
 * that VTRACE does not substitute for investigation. Only a search whose pattern
 * IS an already-returned unique identifier or path counts, and only in the
 * window before the agent does anything else with the result.
 */
export function detectRedundantLookups(
  calls: readonly RawToolCall[],
  records: readonly VtraceCallRecord[],
  windowSize = 3,
): readonly RedundantLookup[] {
  const positionOf = new Map<number, number>();
  let seen = 0;
  calls.forEach((call, position) => {
    if (isVtraceCall(call)) { positionOf.set(seen, position); seen += 1; }
  });

  const findings: RedundantLookup[] = [];

  for (const record of records) {
    if (record.resultState !== "VALID_NONEMPTY" && record.resultState !== "DEGRADED_VALID") continue;
    const start = positionOf.get(record.sequence) ?? 0;
    const window = calls.slice(start + 1, start + 1 + windowSize);

    // Terms VTRACE already located: the returned paths and the bare local names
    // of returned canonical identities.
    const terms = new Set<string>();
    for (const entry of record.returnedPaths) terms.add(entry);
    for (const fqName of record.returnedFqNames) {
      const local = fqName.split("::").pop()?.split(".").pop();
      if (local !== undefined && local.length >= 4) terms.add(local);
    }

    for (const call of window) {
      const tool = normalizeToolName(call.tool);
      const isSearch = SEARCH_TOOLS.has(tool)
        || (tool === "bash" && /\b(rg|grep|find|ag)\b/.test((call.command ?? "")));
      if (!isSearch) continue;

      const args = (call.args ?? {}) as Record<string, unknown>;
      const pattern = String(args.pattern ?? args.query ?? call.command ?? "").trim();
      if (pattern.length === 0) continue;

      for (const term of terms) {
        // The search must BE the term, not merely mention it: a broad search
        // that happens to contain the word is ordinary investigation.
        const bare = pattern.replace(/^(rg|grep|find|ag)\s+(-\w+\s+)*/, "").replace(/["']/g, "").trim();
        if (bare === term || pattern === term) {
          findings.push({ sequence: record.sequence, rediscoveredTerm: term, tool: call.tool });
          break;
        }
      }
    }
  }

  return findings;
}

export interface NavigationWork {
  readonly ordinarySearches: number;
  readonly fileReads: number;
  readonly edits: number;
  readonly vtraceCalls: number;
  readonly totalToolCalls: number;
  readonly firstEditPosition: number | null;
}

/**
 * Component counts, never a composite score.
 *
 * "Three fewer greps" is not efficiency if it was bought with five expensive
 * VTRACE calls, and a single blended number would hide exactly that trade.
 */
export function summarizeNavigationWork(calls: readonly RawToolCall[]): NavigationWork {
  let ordinarySearches = 0;
  let fileReads = 0;
  let edits = 0;
  let vtraceCalls = 0;

  for (const call of calls) {
    if (isVtraceCall(call)) { vtraceCalls += 1; continue; }
    const tool = normalizeToolName(call.tool);
    if (SEARCH_TOOLS.has(tool)) ordinarySearches += 1;
    else if (READ_TOOLS.has(tool)) fileReads += 1;
    else if (EDIT_TOOLS.has(tool)) edits += 1;
    else if (tool === "bash" && /\b(rg|grep|find|ag)\b/.test(call.command ?? "")) ordinarySearches += 1;
  }

  return {
    ordinarySearches,
    fileReads,
    edits,
    vtraceCalls,
    totalToolCalls: calls.length,
    firstEditPosition: firstEditPosition(calls),
  };
}

export interface VtraceTokenAccounting {
  readonly fixedSchemaTokens: number;
  readonly fixedPolicyTokens: number;
  readonly dynamicResultTokens: number;
  readonly callCount: number;
  readonly byTool: Readonly<Record<string, { calls: number; tokens: number }>>;
  readonly totalVtraceContextExposure: number;
}

/**
 * Total VTRACE-specific context exposure for one run.
 *
 * Fixed and dynamic are reported separately and then summed, because the
 * central M162 hypothesis is about WHICH of the two dominates. Reporting only
 * the total would answer a different question.
 */
export function accountVtraceTokens(
  records: readonly VtraceCallRecord[],
  fixedSchemaTokens: number,
  fixedPolicyTokens: number,
): VtraceTokenAccounting {
  const byTool: Record<string, { calls: number; tokens: number }> = {};
  let dynamic = 0;

  for (const record of records) {
    const entry = byTool[record.toolId] ?? { calls: 0, tokens: 0 };
    entry.calls += 1;
    entry.tokens += record.responseEstimatedTokens;
    byTool[record.toolId] = entry;
    dynamic += record.responseEstimatedTokens;
  }

  return {
    fixedSchemaTokens,
    fixedPolicyTokens,
    dynamicResultTokens: dynamic,
    callCount: records.length,
    byTool,
    totalVtraceContextExposure: fixedSchemaTokens + fixedPolicyTokens + dynamic,
  };
}

export interface RunTelemetry {
  readonly adoption: ToolAdoptionState;
  readonly firstCallTiming: FirstVtraceCallTiming;
  readonly calls: readonly VtraceCallRecord[];
  readonly callsBeforeFirstEdit: number;
  readonly callsAfterFirstEdit: number;
  readonly composition: readonly CompositionEvent[];
  readonly utilization: readonly UtilizationRecord[];
  readonly redundantLookups: readonly RedundantLookup[];
  readonly navigation: NavigationWork;
  readonly tokens: VtraceTokenAccounting;
  readonly resultStateCounts: Readonly<Record<VtraceResultState, number>>;
}

/**
 * Reduce one run's ordered calls into the M162 telemetry record.
 *
 * `toolsAvailable` must come from the arm's configuration, not from whether any
 * call is present: an agent that was offered the tools and declined them is a
 * real finding, and a run where the tools never loaded is a treatment failure.
 * Inferring one from the other would erase the distinction.
 */
export function summarizeRun(
  calls: readonly RawToolCall[],
  options: { toolsAvailable: boolean; fixedSchemaTokens: number; fixedPolicyTokens: number },
): RunTelemetry {
  const records = extractVtraceCalls(calls);
  const adoption: ToolAdoptionState = !options.toolsAvailable
    ? "TOOLS_UNAVAILABLE"
    : records.length > 0 ? "TOOLS_AVAILABLE_USED" : "TOOLS_AVAILABLE_NOT_USED";

  const resultStateCounts: Record<VtraceResultState, number> = {
    VALID_NONEMPTY: 0, VALID_EMPTY: 0, DEGRADED_VALID: 0, TOOL_ERROR: 0,
  };
  for (const record of records) resultStateCounts[record.resultState] += 1;

  return {
    adoption,
    firstCallTiming: options.toolsAvailable ? classifyFirstCallTiming(calls) : "NEVER_USED",
    calls: records,
    callsBeforeFirstEdit: records.filter((record) => record.beforeFirstEdit).length,
    callsAfterFirstEdit: records.filter((record) => !record.beforeFirstEdit).length,
    composition: detectComposition(records),
    utilization: analyzeUtilization(calls, records),
    redundantLookups: detectRedundantLookups(calls, records),
    navigation: summarizeNavigationWork(calls),
    tokens: accountVtraceTokens(records, options.fixedSchemaTokens, options.fixedPolicyTokens),
    resultStateCounts,
  };
}
