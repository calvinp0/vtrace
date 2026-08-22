/**
 * M169 — economic primitives over captured M168 run artifacts.
 *
 * M166 established the five representations of one repository-context call and
 * refused to let two of them be spoken of as one. M169 needs the same discipline
 * one level up, over a whole run, and adds one thing M166 did not need: a
 * BILLING IDENTITY that reproduces the provider's own dollar figure from the
 * provider's own token counts. Once that identity holds, a counterfactual can be
 * priced instead of guessed.
 *
 * Three facts about the capture format drive every design choice here:
 *
 *   1. Streaming emits one `assistant` event PER CONTENT BLOCK, each repeating
 *      the same request usage. Summing them multiplies the input side by the
 *      number of blocks. M169 deduplicates on `message.id`, which is exact,
 *      rather than on usage equality, which is a heuristic that collapses two
 *      genuinely distinct requests whenever both wrote nothing to cache.
 *
 *   2. `output_tokens` at message_start is 1 — the real figure only ever arrives
 *      in the terminal `result` event. Per-request output is therefore NOT
 *      observable, and this module returns null for it rather than a plausible
 *      number. Whole-run output is exact.
 *
 *   3. A run killed by the cost guard has NO `result` event. Its input side is
 *      still exactly reconstructible from the deduplicated requests; its output
 *      side is not reconstructible at all. That run is CENSORED, and censoring
 *      travels with every figure derived from it.
 *
 * PURE. No I/O, no clock, no network.
 */

import { calibrateResultTokens, TokenAuthority, type Calibration } from "./m166Boundary";

export { TokenAuthority, type Calibration };

// ── billing identity ────────────────────────────────────────────────

export interface Pricing {
  readonly inputPerMTok: number;
  readonly cacheWrite1hPerMTok: number;
  readonly cacheWrite5mPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * Claude Code's own list price for the model M168 ran on. This is asserted
 * against every uncensored run's `total_cost_usd` before any dollar figure
 * derived from it is allowed to stand — see `checkBillingIdentity`.
 *
 * Note the 1h cache-write rate: Claude Code used the one-hour TTL throughout
 * M168, billed at 2x input. The external harness prices every cache write at
 * the 5m rate (1.25x), which is one of two reasons its own cost arithmetic
 * disagrees with the provider's.
 */
export const OPUS_4_5_PRICING: Pricing = Object.freeze({
  inputPerMTok: 5,
  cacheWrite1hPerMTok: 10,
  cacheWrite5mPerMTok: 6.25,
  cacheReadPerMTok: 0.5,
  outputPerMTok: 25,
});

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly cacheCreation1hTokens: number;
  readonly cacheCreation5mTokens: number;
  readonly cacheReadTokens: number;
  /** null when no `result` event exists — a censored run cannot report output. */
  readonly outputTokens: number | null;
}

export function priceUsage(usage: ProviderUsage, pricing: Pricing = OPUS_4_5_PRICING): number {
  return (
    (usage.inputTokens * pricing.inputPerMTok
      + usage.cacheCreation1hTokens * pricing.cacheWrite1hPerMTok
      + usage.cacheCreation5mTokens * pricing.cacheWrite5mPerMTok
      + usage.cacheReadTokens * pricing.cacheReadPerMTok
      + (usage.outputTokens ?? 0) * pricing.outputPerMTok) / 1_000_000
  );
}

export interface BillingIdentityReport {
  readonly holds: boolean;
  readonly calculatedUsd: number;
  readonly reportedUsd: number | null;
  readonly deltaUsd: number | null;
  readonly toleranceUsd: number;
}

/** The identity that licenses pricing a counterfactual. Checked, never assumed. */
export function checkBillingIdentity(
  usage: ProviderUsage,
  reportedUsd: number | null,
  pricing: Pricing = OPUS_4_5_PRICING,
  toleranceUsd = 1e-6,
): BillingIdentityReport {
  const calculated = priceUsage(usage, pricing);
  if (reportedUsd === null) {
    return { holds: false, calculatedUsd: calculated, reportedUsd: null, deltaUsd: null, toleranceUsd };
  }
  const delta = Math.abs(calculated - reportedUsd);
  return { holds: delta <= toleranceUsd, calculatedUsd: calculated, reportedUsd, deltaUsd: delta, toleranceUsd };
}

// ── request-level reconstruction ────────────────────────────────────

export interface ToolUse {
  readonly name: string;
  readonly inputCharacters: number;
  readonly command: string | null;
  readonly filePath: string | null;
}

export interface RequestRecord {
  readonly index: number;
  readonly messageId: string;
  readonly inputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheCreation1hTokens: number;
  readonly cacheCreation5mTokens: number;
  readonly cacheReadTokens: number;
  /** input + cache_creation + cache_read: everything this request was billed to carry. */
  readonly promptTokens: number;
  /** Assistant-authored characters: text + thinking + serialized tool input. */
  readonly authoredCharacters: number;
  readonly toolUses: readonly ToolUse[];
}

export interface ToolResultRecord {
  /** Index of the request whose tool call this answers. */
  readonly afterRequestIndex: number;
  readonly orderIndex: number;
  readonly characters: number;
  readonly isError: boolean;
}

export interface ResultEvent {
  readonly usage: ProviderUsage;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly terminalReason: string | null;
}

export interface ParsedRun {
  readonly requests: readonly RequestRecord[];
  readonly toolResults: readonly ToolResultRecord[];
  readonly result: ResultEvent | null;
}

interface RawBlock {
  type?: unknown; text?: unknown; thinking?: unknown; name?: unknown;
  input?: unknown; content?: unknown; is_error?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse a Claude Code stream-json transcript into requests and tool results.
 *
 * Deduplication is on `message.id`. Two consecutive requests that both write
 * nothing to cache carry identical usage, so usage-equality merging would fuse
 * them into one and silently shorten the run.
 */
export function parseRun(lines: readonly string[]): ParsedRun {
  const requests: RequestRecord[] = [];
  const toolResults: ToolResultRecord[] = [];
  const byId = new Map<string, number>();
  let result: ResultEvent | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (row.type === "assistant") {
      const message = row.message as Record<string, unknown> | undefined;
      const id = asString(message?.id);
      if (message === undefined || id === null) continue;
      const usage = (message.usage ?? {}) as Record<string, unknown>;
      const num = (key: string): number => {
        const value = usage[key];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      };
      const creationDetail = (usage.cache_creation ?? {}) as Record<string, unknown>;
      const detailNum = (key: string): number => {
        const value = creationDetail[key];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      };
      const blocks = (Array.isArray(message.content) ? message.content : []) as RawBlock[];
      let authored = 0;
      const uses: ToolUse[] = [];
      for (const block of blocks) {
        if (typeof block.text === "string") authored += block.text.length;
        if (typeof block.thinking === "string") authored += block.thinking.length;
        if (block.type === "tool_use") {
          const serialized = JSON.stringify(block.input ?? {});
          authored += serialized.length;
          const input = (block.input ?? {}) as Record<string, unknown>;
          uses.push({
            name: typeof block.name === "string" ? block.name : "unknown",
            inputCharacters: serialized.length,
            command: asString(input.command),
            filePath: asString(input.file_path) ?? asString(input.path) ?? asString(input.pattern),
          });
        }
      }

      const existing = byId.get(id);
      if (existing !== undefined) {
        const previous = requests[existing]!;
        requests[existing] = {
          ...previous,
          authoredCharacters: previous.authoredCharacters + authored,
          toolUses: [...previous.toolUses, ...uses],
        };
        continue;
      }
      const cacheCreation = num("cache_creation_input_tokens");
      const inputTokens = num("input_tokens");
      const cacheRead = num("cache_read_input_tokens");
      byId.set(id, requests.length);
      requests.push({
        index: requests.length,
        messageId: id,
        inputTokens,
        cacheCreationTokens: cacheCreation,
        cacheCreation1hTokens: detailNum("ephemeral_1h_input_tokens"),
        cacheCreation5mTokens: detailNum("ephemeral_5m_input_tokens"),
        cacheReadTokens: cacheRead,
        promptTokens: inputTokens + cacheCreation + cacheRead,
        authoredCharacters: authored,
        toolUses: uses,
      });
      continue;
    }

    if (row.type === "user") {
      const message = row.message as Record<string, unknown> | undefined;
      const blocks = (Array.isArray(message?.content) ? message?.content : []) as RawBlock[];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const content = block.content;
        const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
        toolResults.push({
          afterRequestIndex: requests.length - 1,
          orderIndex: toolResults.length,
          characters: text.length,
          isError: block.is_error === true,
        });
      }
      continue;
    }

    if (row.type === "result") {
      const usage = (row.usage ?? {}) as Record<string, unknown>;
      const num = (key: string): number => {
        const value = usage[key];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      };
      const creationDetail = (usage.cache_creation ?? {}) as Record<string, unknown>;
      const detailNum = (key: string): number => {
        const value = creationDetail[key];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      };
      const cost = row.total_cost_usd;
      result = {
        usage: {
          inputTokens: num("input_tokens"),
          cacheCreation1hTokens: detailNum("ephemeral_1h_input_tokens"),
          cacheCreation5mTokens: detailNum("ephemeral_5m_input_tokens"),
          cacheReadTokens: num("cache_read_input_tokens"),
          outputTokens: num("output_tokens"),
        },
        costUsd: typeof cost === "number" ? cost : 0,
        numTurns: typeof row.num_turns === "number" ? row.num_turns : 0,
        terminalReason: asString(row.terminal_reason),
      };
    }
  }

  return { requests, toolResults, result };
}

/**
 * Sum the deduplicated requests. Exact on the input side for EVERY run,
 * including a censored one. Output is null: the per-request figure is a
 * streaming placeholder and there is nothing to sum.
 */
export function reconstructInputSide(requests: readonly RequestRecord[]): ProviderUsage {
  let inputTokens = 0, c1h = 0, c5m = 0, cacheRead = 0;
  for (const request of requests) {
    inputTokens += request.inputTokens;
    c1h += request.cacheCreation1hTokens;
    c5m += request.cacheCreation5mTokens;
    cacheRead += request.cacheReadTokens;
  }
  return { inputTokens, cacheCreation1hTokens: c1h, cacheCreation5mTokens: c5m, cacheReadTokens: cacheRead, outputTokens: null };
}

export const Censoring = Object.freeze({
  Uncensored: "UNCENSORED",
  CostCensored: "COST_CENSORED",
});
export type Censoring = (typeof Censoring)[keyof typeof Censoring];

export function censoringOf(run: ParsedRun): Censoring {
  return run.result === null ? Censoring.CostCensored : Censoring.Uncensored;
}

// ── the cache identity that licenses attribution ────────────────────

export interface CacheIdentityReport {
  readonly checked: number;
  readonly held: number;
  readonly violations: readonly number[];
  readonly holdsEverywhere: boolean;
}

/**
 * Everything request n wrote to cache, request n+1 reads back. Where it fails —
 * a TTL expiry, a re-prefixed conversation — the appended-token figure for that
 * step is not derivable and must be reported as such.
 */
export function checkCacheIdentity(requests: readonly RequestRecord[]): CacheIdentityReport {
  const violations: number[] = [];
  let checked = 0;
  for (let i = 1; i < requests.length; i += 1) {
    const previous = requests[i - 1]!;
    const current = requests[i]!;
    checked += 1;
    if (current.cacheReadTokens !== previous.cacheReadTokens + previous.cacheCreationTokens) {
      violations.push(current.index);
    }
  }
  return {
    checked,
    held: checked - violations.length,
    violations: Object.freeze(violations),
    holdsEverywhere: violations.length === 0 && checked > 0,
  };
}

/**
 * Tokens appended to the conversation between request n and n+1: the assistant's
 * own output plus whatever the tool handed back. Measured, not estimated —
 * it is the difference of two provider-reported prompt sizes.
 */
export function appendedTokens(requests: readonly RequestRecord[], stepIndex: number): number | null {
  const before = requests[stepIndex];
  const after = requests[stepIndex + 1];
  if (before === undefined || after === undefined) return null;
  return after.promptTokens - before.promptTokens;
}

// ── tool-call taxonomy ──────────────────────────────────────────────

export const ActionKind = Object.freeze({
  Pipeline: "PIPELINE",
  Search: "SEARCH",
  Read: "READ",
  ShellInspection: "SHELL_INSPECTION",
  TestRun: "TEST_RUN",
  Execute: "EXECUTE",
  Environment: "ENVIRONMENT",
  Edit: "EDIT",
  Other: "OTHER",
});
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

/** The kinds that constitute repository investigation, as opposed to doing the work. */
export const INVESTIGATION_KINDS: readonly ActionKind[] = Object.freeze([
  ActionKind.Search, ActionKind.Read, ActionKind.ShellInspection,
]);

const TEST_PATTERN = /(^|[\s;&|(])(pytest|tox|nosetests|unittest|py\.test)\b|python[0-9.]*\s+-m\s+(pytest|unittest)|\brun_tests?\b|\bmake\s+test\b/;
const ENVIRONMENT_PATTERN = /\b(pip[0-9]*|uv|conda|poetry)\s+(install|add|sync)\b|python[0-9.]*\s+-m\s+pip\s+install|\bwhich\s+(python|pip)/;
const INSPECTION_PATTERN = /(^|[\s;&|(])(grep|rg|ag|ack|find|ls|cat|head|tail|wc|tree|nl|stat|file)\b|(^|[\s;&|(])sed\s+-n\b|(^|[\s;&|(])git\s+(grep|log|blame|show|diff|status|ls-files)\b/;

/**
 * Classify one tool call.
 *
 * Bash is the hard case and the reason M168's coercion finding exists: a policy
 * that denies Grep and Glob pushes the same work into Bash, so a Bash call must
 * be read for what it DOES, not counted as one undifferentiated thing.
 *
 * Order matters. Environment setup is checked before test running because
 * `pip install -e . && pytest` is dominated by the install; test running is
 * checked before inspection because `pytest -k foo | head` ends in a pipe to
 * `head` and is not thereby an inspection.
 */
export function classifyAction(toolName: string, command: string | null): ActionKind {
  if (toolName.includes("__")) return ActionKind.Pipeline;
  if (toolName === "Grep" || toolName === "Glob") return ActionKind.Search;
  if (toolName === "Read" || toolName === "NotebookRead") return ActionKind.Read;
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
    return ActionKind.Edit;
  }
  if (toolName !== "Bash" && toolName !== "BashOutput") return ActionKind.Other;
  if (command === null) return ActionKind.Other;
  if (ENVIRONMENT_PATTERN.test(command)) return ActionKind.Environment;
  if (TEST_PATTERN.test(command)) return ActionKind.TestRun;
  if (INSPECTION_PATTERN.test(command)) return ActionKind.ShellInspection;
  return ActionKind.Execute;
}

export function isInvestigation(kind: ActionKind): boolean {
  return INVESTIGATION_KINDS.includes(kind);
}

// ── attributing appended traffic to a single tool result ────────────

export interface AttributedPayload {
  readonly requestIndex: number;
  readonly toolName: string;
  readonly kind: ActionKind;
  readonly resultCharacters: number;
  /** The whole appended block: assistant output AND tool result. Measured. */
  readonly appendedTokensMeasured: number | null;
  /** Calibrated share of that block attributable to the tool result alone. */
  readonly payloadTokensEstimated: number | null;
  readonly payloadTokensLowerBound: number | null;
  readonly payloadTokensUpperBound: number | null;
  /** Requests that re-read this payload as cache after it was written. */
  readonly amplificationRequests: number;
  readonly writeCostUsd: number | null;
  readonly amplificationCostUsd: number | null;
  readonly totalAttributableCostUsd: number | null;
  readonly authority: TokenAuthority;
  readonly derivable: boolean;
}

/**
 * Price one tool result's whole life in the conversation: written into cache
 * once, then re-read by every request that follows.
 *
 * M166 stopped at "the first call is not the whole tax". This is the arithmetic
 * that finishes the sentence — and on a long run the amplification term is the
 * larger of the two, which is exactly why shrinking a payload pays back more
 * than its own size.
 */
export function attributePayload(
  run: ParsedRun,
  toolResultOrderIndex: number,
  calibration: Calibration | null,
  pricing: Pricing = OPUS_4_5_PRICING,
): AttributedPayload | null {
  const toolResult = run.toolResults[toolResultOrderIndex];
  if (toolResult === undefined) return null;
  const issuing = run.requests[toolResult.afterRequestIndex];
  if (issuing === undefined) return null;

  // The k-th tool_use of the issuing request answers the k-th tool_result after it.
  const siblingIndex = run.toolResults
    .filter((r) => r.afterRequestIndex === toolResult.afterRequestIndex)
    .findIndex((r) => r.orderIndex === toolResult.orderIndex);
  const use = issuing.toolUses[Math.max(0, siblingIndex)] ?? issuing.toolUses[0];
  const toolName = use?.name ?? "unknown";
  const kind = classifyAction(toolName, use?.command ?? null);

  const measured = appendedTokens(run.requests, issuing.index);
  const writer = run.requests[issuing.index + 1];
  const amplification = writer === undefined ? 0 : Math.max(0, run.requests.length - (writer.index + 1));

  if (measured === null || calibration === null) {
    return {
      requestIndex: issuing.index,
      toolName,
      kind,
      resultCharacters: toolResult.characters,
      appendedTokensMeasured: measured,
      payloadTokensEstimated: null,
      payloadTokensLowerBound: null,
      payloadTokensUpperBound: measured,
      amplificationRequests: amplification,
      writeCostUsd: null,
      amplificationCostUsd: null,
      totalAttributableCostUsd: null,
      authority: TokenAuthority.OfflineEstimated,
      derivable: false,
    };
  }

  const estimated = Math.max(0, Math.round(toolResult.characters * calibration.resultTokensPerCharacter));
  const authoredShare = Math.max(
    0,
    Math.round(issuing.authoredCharacters * calibration.authoredTokensPerCharacter + calibration.fixedTokensPerRequest),
  );
  const lower = Math.max(0, Math.min(estimated, measured - authoredShare));
  const upper = Math.max(estimated, Math.max(0, measured));

  const write = (estimated * pricing.cacheWrite1hPerMTok) / 1_000_000;
  const reads = (estimated * amplification * pricing.cacheReadPerMTok) / 1_000_000;

  return {
    requestIndex: issuing.index,
    toolName,
    kind,
    resultCharacters: toolResult.characters,
    appendedTokensMeasured: measured,
    payloadTokensEstimated: estimated,
    payloadTokensLowerBound: lower,
    payloadTokensUpperBound: upper,
    amplificationRequests: amplification,
    writeCostUsd: write,
    amplificationCostUsd: reads,
    totalAttributableCostUsd: write + reads,
    authority: TokenAuthority.DerivedFromReported,
    derivable: true,
  };
}

/**
 * Fit the character->token conversion on real billed cache-writes.
 *
 * Every step whose appended block is measurable contributes one sample. The
 * calibration is fit ACROSS RUNS so that no single run's estimate is fit to
 * itself, and its R^2 is reported so that a bad fit disqualifies the estimates
 * rather than quietly degrading them.
 */
export function calibrateAcrossRuns(runs: readonly ParsedRun[]): Calibration | null {
  const samples: { resultCharacters: number; authoredCharacters: number; cacheCreationTokens: number }[] = [];
  for (const run of runs) {
    for (const toolResult of run.toolResults) {
      const issuing = run.requests[toolResult.afterRequestIndex];
      if (issuing === undefined) continue;
      const measured = appendedTokens(run.requests, issuing.index);
      if (measured === null || measured < 0) continue;
      const siblings = run.toolResults.filter((r) => r.afterRequestIndex === toolResult.afterRequestIndex);
      // Only single-result steps are unambiguous samples.
      if (siblings.length !== 1) continue;
      samples.push({
        resultCharacters: toolResult.characters,
        authoredCharacters: issuing.authoredCharacters,
        cacheCreationTokens: measured,
      });
    }
  }
  return calibrateResultTokens(samples);
}

// ── phases ──────────────────────────────────────────────────────────

export const Phase = Object.freeze({
  PreEdit: "PRE_EDIT_INVESTIGATION",
  Implementation: "IMPLEMENTATION",
  DebugTest: "DEBUG_TEST_CORRECTION",
});
export type Phase = (typeof Phase)[keyof typeof Phase];

export interface Landmarks {
  readonly firstRepositoryActionRequest: number | null;
  readonly firstEditRequest: number | null;
  readonly firstTestRequest: number | null;
  readonly lastEditRequest: number | null;
}

/**
 * Observable landmarks only (§11). No semantic phase is inferred from reasoning
 * text. `PRE_EDIT_INVESTIGATION` is deliberately NOT called "localization" (§13):
 * an agent may edit far too early, and naming the window after what it hoped to
 * have finished would beg the question.
 */
export function landmarksOf(run: ParsedRun): Landmarks {
  let firstAction: number | null = null;
  let firstEdit: number | null = null;
  let firstTest: number | null = null;
  let lastEdit: number | null = null;
  for (const request of run.requests) {
    for (const use of request.toolUses) {
      const kind = classifyAction(use.name, use.command);
      if (firstAction === null) firstAction = request.index;
      if (kind === ActionKind.Edit) {
        if (firstEdit === null) firstEdit = request.index;
        lastEdit = request.index;
      }
      if (kind === ActionKind.TestRun && firstTest === null) firstTest = request.index;
    }
  }
  return {
    firstRepositoryActionRequest: firstAction,
    firstEditRequest: firstEdit,
    firstTestRequest: firstTest,
    lastEditRequest: lastEdit,
  };
}

export function phaseOfRequest(index: number, landmarks: Landmarks): Phase {
  const { firstEditRequest, lastEditRequest } = landmarks;
  if (firstEditRequest === null) return Phase.PreEdit;
  if (index < firstEditRequest) return Phase.PreEdit;
  if (lastEditRequest !== null && index <= lastEditRequest) return Phase.Implementation;
  return Phase.DebugTest;
}

export interface PhaseCost {
  readonly phase: Phase;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  /** EXACT. Output is excluded because it is not per-request observable. */
  readonly inputSideCostUsd: number;
  /** Whole-run output apportioned by authored characters. ESTIMATED. */
  readonly estimatedOutputCostUsd: number | null;
  readonly authority: TokenAuthority;
}

export function phaseCosts(
  run: ParsedRun,
  pricing: Pricing = OPUS_4_5_PRICING,
): readonly PhaseCost[] {
  const landmarks = landmarksOf(run);
  const totalAuthored = run.requests.reduce((sum, r) => sum + r.authoredCharacters, 0);
  const totalOutput = run.result?.usage.outputTokens ?? null;
  const buckets = new Map<Phase, { requests: number; input: number; create1h: number; create5m: number; read: number; authored: number }>();
  for (const phase of [Phase.PreEdit, Phase.Implementation, Phase.DebugTest]) {
    buckets.set(phase, { requests: 0, input: 0, create1h: 0, create5m: 0, read: 0, authored: 0 });
  }
  for (const request of run.requests) {
    const bucket = buckets.get(phaseOfRequest(request.index, landmarks))!;
    bucket.requests += 1;
    bucket.input += request.inputTokens;
    bucket.create1h += request.cacheCreation1hTokens;
    bucket.create5m += request.cacheCreation5mTokens;
    bucket.read += request.cacheReadTokens;
    bucket.authored += request.authoredCharacters;
  }
  return Object.freeze([...buckets.entries()].map(([phase, b]) => ({
    phase,
    requests: b.requests,
    inputTokens: b.input,
    cacheCreationTokens: b.create1h + b.create5m,
    cacheReadTokens: b.read,
    inputSideCostUsd: priceUsage(
      {
        inputTokens: b.input,
        cacheCreation1hTokens: b.create1h,
        cacheCreation5mTokens: b.create5m,
        cacheReadTokens: b.read,
        outputTokens: null,
      },
      pricing,
    ),
    estimatedOutputCostUsd: totalOutput === null || totalAuthored === 0
      ? null
      : (totalOutput * (b.authored / totalAuthored) * pricing.outputPerMTok) / 1_000_000,
    authority: TokenAuthority.DerivedFromReported,
  })));
}

// ── run-level investigation accounting ──────────────────────────────

export interface InvestigationAccount {
  readonly calls: number;
  readonly payloadTokens: number;
  readonly attributableCostUsd: number;
  readonly byKind: Readonly<Record<string, { calls: number; payloadTokens: number; costUsd: number }>>;
  readonly derivableCalls: number;
  readonly nonDerivableCalls: number;
}

/**
 * Total attributable cost of a set of actions in one run.
 *
 * `window` restricts to the pre-edit window when the caller wants the
 * investigation figure rather than the whole-run figure.
 */
export function accountFor(
  run: ParsedRun,
  calibration: Calibration | null,
  predicate: (kind: ActionKind, requestIndex: number) => boolean,
  pricing: Pricing = OPUS_4_5_PRICING,
): InvestigationAccount {
  const byKind: Record<string, { calls: number; payloadTokens: number; costUsd: number }> = {};
  let calls = 0, payload = 0, cost = 0, derivable = 0, nonDerivable = 0;
  for (const toolResult of run.toolResults) {
    const attributed = attributePayload(run, toolResult.orderIndex, calibration, pricing);
    if (attributed === null) continue;
    if (!predicate(attributed.kind, attributed.requestIndex)) continue;
    calls += 1;
    if (!attributed.derivable || attributed.payloadTokensEstimated === null) {
      nonDerivable += 1;
      continue;
    }
    derivable += 1;
    payload += attributed.payloadTokensEstimated;
    cost += attributed.totalAttributableCostUsd ?? 0;
    const bucket = byKind[attributed.kind] ?? { calls: 0, payloadTokens: 0, costUsd: 0 };
    byKind[attributed.kind] = {
      calls: bucket.calls + 1,
      payloadTokens: bucket.payloadTokens + attributed.payloadTokensEstimated,
      costUsd: bucket.costUsd + (attributed.totalAttributableCostUsd ?? 0),
    };
  }
  return { calls, payloadTokens: payload, attributableCostUsd: cost, byKind: Object.freeze(byKind), derivableCalls: derivable, nonDerivableCalls: nonDerivable };
}

// ── economic classification ─────────────────────────────────────────

export const EconomicClass = Object.freeze({
  Win: "PIPELINE_ECONOMIC_WIN",
  BreakEven: "ROUGH_BREAK_EVEN",
  Loss: "PIPELINE_ECONOMIC_LOSS",
  NotMeasurable: "NOT_MEASURABLE",
});
export type EconomicClass = (typeof EconomicClass)[keyof typeof EconomicClass];

/** Frozen in the M169 plan before any economic result was inspected. */
export const ECONOMIC_THRESHOLDS = Object.freeze({ winAtOrBelow: 0.8, breakEvenAtOrBelow: 1.25 });

export interface EconomicVerdict {
  readonly ratio: number | null;
  readonly ratioLabel: string;
  readonly economicClass: EconomicClass;
}

export function classifyEconomics(
  pipelineCostUsd: number | null,
  displacedCostUsd: number | null,
  measurable: boolean,
): EconomicVerdict {
  if (!measurable || pipelineCostUsd === null || displacedCostUsd === null) {
    return { ratio: null, ratioLabel: "NOT_MEASURABLE", economicClass: EconomicClass.NotMeasurable };
  }
  if (displacedCostUsd <= 0) {
    return pipelineCostUsd > 0
      ? { ratio: null, ratioLabel: "DISPLACED_NOTHING", economicClass: EconomicClass.Loss }
      : { ratio: null, ratioLabel: "NOTHING_SPENT_NOTHING_DISPLACED", economicClass: EconomicClass.NotMeasurable };
  }
  const ratio = pipelineCostUsd / displacedCostUsd;
  const economicClass = ratio <= ECONOMIC_THRESHOLDS.winAtOrBelow
    ? EconomicClass.Win
    : ratio <= ECONOMIC_THRESHOLDS.breakEvenAtOrBelow
      ? EconomicClass.BreakEven
      : EconomicClass.Loss;
  return { ratio: Number(ratio.toFixed(4)), ratioLabel: ratio.toFixed(2), economicClass };
}

/**
 * The largest payload the pipeline could have delivered and still cost no more
 * than the investigation it displaced. Inverts `attributePayload`'s arithmetic.
 */
export function breakEvenPayloadTokens(
  displacedCostUsd: number,
  amplificationRequests: number,
  pricing: Pricing = OPUS_4_5_PRICING,
): number {
  const perToken = (pricing.cacheWrite1hPerMTok + amplificationRequests * pricing.cacheReadPerMTok) / 1_000_000;
  if (perToken <= 0) return 0;
  return Math.max(0, Math.floor(displacedCostUsd / perToken));
}
