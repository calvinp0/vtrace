// Stage 5 turn-count waste scorer.
//
// The Stage 5 token-path audit found that VTRACE's measured token overhead was
// primarily a TURN-COUNT / cache-read amplification problem, not a capsule-size
// problem: 96% of the positive token deltas were cache-read movement caused by
// extra agent turns (repeated Read/Grep/Bash search loops that re-read the
// conversation prefix). matplotlib-22719 is the canonical case: +1.55M tokens,
// 30 tool calls, a 16-deep Bash loop, repeated Read/Grep, and VTRACE lost a
// task the baseline had resolved.
//
// This module is a PURE, deterministic classifier over an already-parsed ordered
// tool-call list (see toolCallLog.parseOrderedToolCalls). It runs no agents, no
// Docker, no model calls, and reads no files — it only scores telemetry. It does
// NOT change retrieval, ranking, prompt assembly, or patch generation.

import {
  isBashTool,
  type OrderedToolCall,
  summarizeOrderedToolCalls,
} from "./toolCallLog";

// Default pre-edit tool budgets for the strong-context patch-first policy. These
// are the single source of truth: the Stage 5 token-discipline instruction block
// (benchmarks/.../run_stage5_vexp_swe_bench_smoke.ts) re-exports and renders these
// exact numbers, so the prose the agent reads and the budget the scorer checks can
// never drift apart.
//   SEARCH: at most N read/grep/search calls before the first edit when the capsule
//           names a lead pivot.
//   BASH:   at most N Bash inspection commands before the first edit (test runs aside).
//   REPEATED_FILE_READ: how many re-reads of an already-read file are tolerated
//           before it counts as a loop (1 = a single re-read is fine; a 2nd is waste).
export const DEFAULT_PRE_EDIT_SEARCH_BUDGET = 2;
export const DEFAULT_PRE_EDIT_BASH_BUDGET = 1;
export const DEFAULT_REPEATED_FILE_READ_LIMIT = 1;

// Loop thresholds, kept in step with toolCallLog's internal heuristics so the
// scorer and the diagnostic summary agree on what "long" / "repeated" mean.
export const TURN_COUNT_LONG_BASH_LOOP_THRESHOLD = 8;
export const TURN_COUNT_REPEATED_SEARCH_THRESHOLD = 5;
// A run with this many total tool calls AND a positive token delta is treated as a
// turn-count amplification proxy when no explicit cache-read share is supplied.
export const TURN_COUNT_HIGH_TOOL_CALL_THRESHOLD = 12;
// Moderate (not yet "long") Bash use that still warrants a medium flag.
export const TURN_COUNT_MEDIUM_BASH_THRESHOLD = 4;
// At/above this share of the positive token delta coming from cache reads, the
// delta is attributable to cache-read amplification rather than injected context.
export const CACHE_READ_AMPLIFICATION_SHARE = 0.5;

export type TokenReductionRisk = "low" | "medium" | "high";

// Optional context for the scorer. All fields are optional so a caller with only
// an ordered tool-call list can still get a verdict; the token-path / cache-read
// fields sharpen the cache-read-amplification signal when they are available.
export interface TurnCountWasteContextMeta {
  // True when VTRACE had a STRONG capsule lead for this task (lead pivot + file +
  // support + context injected) — i.e. the agent was expected to patch-first.
  // Strong context plus heavy search is the "strongContextOversearch" loss mode.
  readonly strongContext?: boolean;
  // Total token delta vs baseline, as a percentage (positive = VTRACE spent more).
  readonly tokenDeltaPct?: number | null;
  // Share (0..1) of the POSITIVE token delta attributable to cache reads, when the
  // token-path audit computed it. The audit's headline finding was ~0.96 here.
  readonly cacheReadShareOfPositiveDelta?: number | null;
  // Budgets the run was expected to honor; default to the constants above.
  readonly preEditSearchBudget?: number;
  readonly preEditBashBudget?: number;
  readonly repeatedFileReadLimit?: number;
}

export interface TurnCountWasteResult {
  readonly toolCallCount: number;
  readonly bashCount: number;
  readonly searchLikeCount: number;
  readonly repeatedFileReads: number;
  readonly repeatedSearches: number;
  // Tool calls observed BEFORE the first edit call. undefined when no edit was
  // made (we cannot define a pre-edit window without an edit boundary).
  readonly preEditToolCalls?: number;
  readonly longBashLoopHeuristic: boolean;
  readonly repeatedSearchHeuristic: boolean;
  // Strong capsule context yet the agent still over-searched (the policy's prime
  // target: it should have patched from the capsule before broad rediscovery).
  readonly strongContextOversearch: boolean;
  // The token delta is most plausibly cache-read amplification from extra turns,
  // not injected-context size.
  readonly likelyCacheReadAmplification: boolean;
  readonly tokenReductionRisk: TokenReductionRisk;
  readonly reasons: readonly string[];
}

// Count re-accesses: for each distinct key (file path for reads, query for
// searches), the number of accesses BEYOND the first. Two reads of the same file
// => 1 repeated read; three => 2. Calls with a null key are ignored.
function countRepeats(keys: readonly (string | null)[]): number {
  const seen = new Map<string, number>();
  let repeats = 0;
  for (const key of keys) {
    if (key === null) continue;
    const next = (seen.get(key) ?? 0) + 1;
    seen.set(key, next);
    if (next >= 2) repeats += 1;
  }
  return repeats;
}

// Classify turn-count waste for one run from its ordered tool-call list. Pure and
// deterministic. With an empty list every count is 0 and the risk is "low".
//
// Risk tiers (Balanced policy — high = a likely token-reduction REGRESSION from
// turn-count/cache-read amplification, not merely "more tools than ideal"):
//   high   <- a long Bash loop OR strong-context oversearch.
//   medium <- repeated search/read loops, over-budget pre-edit search, moderate
//             Bash use, or a high total tool-call count (suspicious but not yet a
//             proven regression — paired reruns decide).
//   low    <- otherwise.
export function analyzeTurnCountWaste(
  toolCalls: readonly OrderedToolCall[],
  contextMeta: TurnCountWasteContextMeta = {},
): TurnCountWasteResult {
  const summary = summarizeOrderedToolCalls(toolCalls, true);
  const bashCount = summary.bashToolCalls;
  const searchLikeCount = summary.grepLikeToolCalls;

  const repeatedFileReads = countRepeats(
    toolCalls.filter((c) => c.category === "read").map((c) => c.path),
  );
  const repeatedSearches = countRepeats(
    toolCalls.filter((c) => c.category === "search").map((c) => c.query),
  );

  // Pre-edit window: tool calls before the first edit. undefined when no edit.
  const firstEditIndex = toolCalls.findIndex((c) => c.category === "edit");
  const preEditToolCalls = firstEditIndex >= 0 ? firstEditIndex : undefined;

  const searchBudget = contextMeta.preEditSearchBudget ?? DEFAULT_PRE_EDIT_SEARCH_BUDGET;
  const bashBudget = contextMeta.preEditBashBudget ?? DEFAULT_PRE_EDIT_BASH_BUDGET;
  const readLimit = contextMeta.repeatedFileReadLimit ?? DEFAULT_REPEATED_FILE_READ_LIMIT;

  const longBashLoopHeuristic = bashCount >= TURN_COUNT_LONG_BASH_LOOP_THRESHOLD;
  const repeatedSearchHeuristic = summary.repeatedSearchHeuristic;

  const reasons: string[] = [];

  // HEAVY over-search: a genuine loop, not merely "a bit over the ideal budget".
  // The Balanced policy reserves the high tier for likely token-reduction
  // REGRESSIONS (real Read/Grep/Bash loops that amplify cache reads), so modest
  // budget exceedance alone (e.g. 3 Bash vs an ideal of 1) does NOT qualify here —
  // it is caught by the softer medium tier and the "would be capped" signal. A run
  // qualifies as heavy over-search when it has a long Bash loop, the repeated-search
  // heuristic fired, it re-ran reads/searches beyond the tolerated re-read, or it
  // searched/pre-edit-explored well past (>= 2x) the budget.
  const heavyOversearch =
    longBashLoopHeuristic ||
    repeatedSearchHeuristic ||
    repeatedFileReads > readLimit ||
    repeatedSearches > readLimit ||
    searchLikeCount >= 2 * searchBudget ||
    (preEditToolCalls !== undefined && preEditToolCalls >= 2 * (searchBudget + bashBudget));

  const strongContext = contextMeta.strongContext === true;
  const strongContextOversearch = strongContext && heavyOversearch;

  // Cache-read amplification: prefer the audited share when present, else fall back
  // to the turn-count proxy (many calls + a positive token delta).
  const share = contextMeta.cacheReadShareOfPositiveDelta;
  const tokenDeltaPct = contextMeta.tokenDeltaPct ?? null;
  const likelyCacheReadAmplification =
    (share !== undefined && share !== null && share >= CACHE_READ_AMPLIFICATION_SHARE) ||
    (toolCalls.length >= TURN_COUNT_HIGH_TOOL_CALL_THRESHOLD &&
      tokenDeltaPct !== null &&
      tokenDeltaPct > 0);

  // ----- Balanced risk tiering -----
  let tokenReductionRisk: TokenReductionRisk;
  if (longBashLoopHeuristic) {
    reasons.push(`long Bash loop: ${bashCount} Bash calls (>= ${TURN_COUNT_LONG_BASH_LOOP_THRESHOLD})`);
    tokenReductionRisk = "high";
  } else if (strongContextOversearch) {
    reasons.push("strong-context oversearch: strong capsule lead but the agent kept searching instead of patching first");
    tokenReductionRisk = "high";
  } else if (
    repeatedSearchHeuristic ||
    repeatedSearches > 0 ||
    repeatedFileReads > 0 ||
    searchLikeCount > searchBudget ||
    bashCount >= TURN_COUNT_MEDIUM_BASH_THRESHOLD ||
    toolCalls.length >= TURN_COUNT_HIGH_TOOL_CALL_THRESHOLD
  ) {
    if (repeatedSearchHeuristic) reasons.push("repeated-search heuristic fired");
    if (repeatedSearches > 0) reasons.push(`${repeatedSearches} repeated search query/queries`);
    if (repeatedFileReads > 0) reasons.push(`${repeatedFileReads} repeated file read(s)`);
    if (searchLikeCount > searchBudget) reasons.push(`${searchLikeCount} search/grep calls (> budget ${searchBudget})`);
    if (bashCount >= TURN_COUNT_MEDIUM_BASH_THRESHOLD) reasons.push(`${bashCount} Bash calls (>= ${TURN_COUNT_MEDIUM_BASH_THRESHOLD})`);
    if (toolCalls.length >= TURN_COUNT_HIGH_TOOL_CALL_THRESHOLD) reasons.push(`${toolCalls.length} total tool calls (>= ${TURN_COUNT_HIGH_TOOL_CALL_THRESHOLD})`);
    tokenReductionRisk = "medium";
  } else {
    reasons.push("no turn-count waste signal");
    tokenReductionRisk = "low";
  }

  // Annotate the cross-cutting flags so the report can explain a verdict.
  if (strongContextOversearch && !longBashLoopHeuristic) {
    // already recorded above as the high reason; nothing more.
  }
  if (likelyCacheReadAmplification) {
    reasons.push(
      share !== undefined && share !== null
        ? `cache-read amplification: ${(share * 100).toFixed(0)}% of the positive token delta is cache-read movement`
        : "cache-read amplification (proxy): high tool-call count with a positive token delta",
    );
  }

  return {
    toolCallCount: toolCalls.length,
    bashCount,
    searchLikeCount,
    repeatedFileReads,
    repeatedSearches,
    preEditToolCalls,
    longBashLoopHeuristic,
    repeatedSearchHeuristic,
    strongContextOversearch,
    likelyCacheReadAmplification,
    tokenReductionRisk,
    reasons,
  };
}

// Re-exported for callers that want to count Bash calls themselves without
// reaching into toolCallLog (keeps the scorer's surface self-contained).
export { isBashTool };
