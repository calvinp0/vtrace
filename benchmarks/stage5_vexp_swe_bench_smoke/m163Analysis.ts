/**
 * M163-D — conditional-utility classifiers.
 *
 * Pure. These only become meaningful once an agent has actually consulted
 * VTRACE, which is precisely the state M162 never reached: it could not ask
 * whether the evidence was good, because no question was ever asked.
 *
 * Two separations are maintained throughout, because collapsing either would
 * produce a confident wrong answer:
 *
 *   gold match          IS NOT   useful orientation
 *   called the tool     IS NOT   helped by the tool
 */

import type { RawToolCall, VtraceCallRecord } from "./m162Telemetry";
import { isVtraceCall } from "./m162Telemetry";
import { ORDINARY_REPOSITORY_TOOLS } from "./m163Adoption";

function normalize(tool: string): string {
  return tool.trim().toLowerCase().replace(/^mcp__[^_]+__/, "");
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "bash"]);
const READ_TOOLS = new Set(["read"]);

// ---------------------------------------------------------------------------
// First-call evidence quality
// ---------------------------------------------------------------------------

/**
 * Gold-relative tiers. The names describe the RELATION TO BENCHMARK GOLD, not a
 * judgement about usefulness — §83 keeps those apart, and `agentUse` below is
 * where the usefulness question is actually answered.
 */
export type EvidenceTier =
  | "ERROR"
  /**
   * The product was reached and declined to answer (e.g. `repo_not_ready`).
   * Distinct from EMPTY on purpose: EMPTY means retrieval ran and found nothing,
   * which is a retrieval result. This means retrieval never ran, which is not.
   * Collapsing them would let a delivery failure be reported as weak evidence.
   */
  | "PRODUCT_DECLINED"
  | "EMPTY"
  | "GOLD_LED"
  | "GOLD_PRESENT"
  | "GOLD_ABSENT";

export type GoldRelation = "TOP_1" | "ANYWHERE" | "ABSENT";

export interface EvidenceQuality {
  readonly tier: EvidenceTier;
  readonly goldRelation: GoldRelation;
  readonly goldFilesExpected: readonly string[];
  readonly goldFilesReturned: readonly string[];
  readonly returnedPathCount: number;
  readonly leadPath: string | null;
  readonly itemCount: number;
  readonly responseEstimatedTokens: number;
  /** Did any repository evidence actually reach the agent? Gates every downstream label. */
  readonly evidenceDelivered: boolean;
  readonly caveat: string;
}

/** Compare on repo-relative paths; a suffix match handles workspace prefixes. */
function pathMatches(returned: string, gold: string): boolean {
  const a = returned.replace(/^\.?\//, "");
  const b = gold.replace(/^\.?\//, "");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function classifyEvidenceQuality(
  record: VtraceCallRecord,
  goldFiles: readonly string[],
  options: { readonly productDeclined?: boolean } = {},
): EvidenceQuality {
  const returned = record.returnedPaths;
  const lead = returned[0] ?? null;
  const goldReturned = goldFiles.filter((gold) => returned.some((path) => pathMatches(path, gold)));
  const goldRelation: GoldRelation = lead !== null && goldFiles.some((gold) => pathMatches(lead, gold))
    ? "TOP_1"
    : goldReturned.length > 0 ? "ANYWHERE" : "ABSENT";

  const tier: EvidenceTier = record.resultState === "TOOL_ERROR"
    ? "ERROR"
    : options.productDeclined === true
      ? "PRODUCT_DECLINED"
      : record.itemCount === 0
        ? "EMPTY"
        : goldRelation === "TOP_1" ? "GOLD_LED" : goldRelation === "ANYWHERE" ? "GOLD_PRESENT" : "GOLD_ABSENT";
  const evidenceDelivered = tier === "GOLD_LED" || tier === "GOLD_PRESENT" || tier === "GOLD_ABSENT";

  return {
    tier,
    goldRelation,
    goldFilesExpected: goldFiles,
    goldFilesReturned: Object.freeze(goldReturned),
    returnedPathCount: returned.length,
    leadPath: lead,
    itemCount: record.itemCount,
    responseEstimatedTokens: record.responseEstimatedTokens,
    evidenceDelivered,
    caveat:
      "Gold-relative only. Evidence can omit the patch gold and still orient usefully, and evidence containing "
      + "the gold can still mislead. See agentReaction for what the agent did with it.",
  };
}

// ---------------------------------------------------------------------------
// Query alignment: right question vs wrong evidence
// ---------------------------------------------------------------------------

export type QueryEvidenceClass =
  | "RIGHT_QUERY_RIGHT_EVIDENCE"
  | "RIGHT_QUERY_PARTIAL_EVIDENCE"
  | "RIGHT_QUERY_WRONG_EVIDENCE"
  | "QUERY_ITSELF_MISALIGNED"
  | "NOT_APPLICABLE";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on", "for", "and", "or", "not",
  "with", "when", "that", "this", "it", "as", "by", "from", "at", "if", "but", "should", "would", "can",
]);

function contentTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

/**
 * Did the agent ask a question derived from the task?
 *
 * A blunt lexical overlap, and deliberately so: the alternative is a judgement
 * call that would quietly become the finding. A low score is reported as a
 * CANDIDATE for inspection, not as a conclusion — see `overlap` on the result.
 */
export interface QueryAlignment {
  readonly classification: QueryEvidenceClass;
  readonly overlap: number;
  readonly queryChars: number;
  readonly needsInspection: boolean;
}

export const QUERY_ALIGNMENT_THRESHOLD = 0.2;

export function classifyQueryEvidence(
  query: string,
  taskText: string,
  quality: EvidenceQuality,
): QueryAlignment {
  // Order matters. The evidence gate comes FIRST: when nothing was delivered the
  // query cannot be judged against evidence at all, and an uncaptured query is
  // not a misaligned one. Checking emptiness first scored three runs whose query
  // the harness simply did not record as the agent's own misalignment.
  if (!quality.evidenceDelivered) {
    // The question may have been perfectly good; there is simply no evidence to
    // hold it against. Scoring this as WRONG_EVIDENCE would blame retrieval for
    // a call that never reached retrieval.
    const tokens = contentTokens(query);
    const shared = [...tokens].filter((token) => contentTokens(taskText).has(token)).length;
    return {
      classification: "NOT_APPLICABLE",
      overlap: tokens.size === 0 ? 0 : shared / tokens.size,
      queryChars: query.length,
      needsInspection: false,
    };
  }
  if (query.trim().length === 0) {
    return { classification: "QUERY_ITSELF_MISALIGNED", overlap: 0, queryChars: 0, needsInspection: true };
  }
  const queryTokens = contentTokens(query);
  const taskTokens = contentTokens(taskText);
  const shared = [...queryTokens].filter((token) => taskTokens.has(token)).length;
  const overlap = queryTokens.size === 0 ? 0 : shared / queryTokens.size;

  if (overlap < QUERY_ALIGNMENT_THRESHOLD) {
    return { classification: "QUERY_ITSELF_MISALIGNED", overlap, queryChars: query.length, needsInspection: true };
  }
  const classification: QueryEvidenceClass = quality.tier === "ERROR" || quality.tier === "EMPTY"
    ? "RIGHT_QUERY_WRONG_EVIDENCE"
    : quality.goldRelation === "TOP_1"
      ? "RIGHT_QUERY_RIGHT_EVIDENCE"
      : quality.goldRelation === "ANYWHERE" ? "RIGHT_QUERY_PARTIAL_EVIDENCE" : "RIGHT_QUERY_WRONG_EVIDENCE";
  return { classification, overlap, queryChars: query.length, needsInspection: false };
}

// ---------------------------------------------------------------------------
// Agent reaction
// ---------------------------------------------------------------------------

export type AgentReaction =
  | "USED_AS_ORIENTATION"
  | "VERIFIED_WITH_NORMAL_TOOLS"
  | "IGNORED"
  | "DISAGREED_AND_RECOVERED"
  | "ANCHORED_INCORRECTLY"
  | "REQUESTED_FOLLOWUP_VTRACE"
  /** No evidence reached the agent, so there is nothing it could have reacted to. */
  | "NO_EVIDENCE_DELIVERED";

export interface ReactionAnalysis {
  readonly labels: readonly AgentReaction[];
  readonly openedReturnedPath: boolean;
  readonly editedReturnedPath: boolean;
  readonly editedNonReturnedPath: boolean;
  readonly ordinaryCallsAfterFirstVtrace: number;
  readonly searchesBetweenCallAndFirstEdit: number;
  readonly followUpVtraceCalls: number;
}

/**
 * Multiple labels are allowed. An agent that opens what it was pointed at AND
 * greps around it is doing both, and forcing a single label would erase the
 * distinction between orientation and blind trust.
 */
export function classifyAgentReaction(
  calls: readonly RawToolCall[],
  records: readonly VtraceCallRecord[],
  resolved: boolean | null,
  quality: EvidenceQuality,
): ReactionAnalysis {
  const firstVtraceIndex = calls.findIndex(isVtraceCall);
  const after = firstVtraceIndex === -1 ? [] : calls.slice(firstVtraceIndex + 1);
  const returned = records[0]?.returnedPaths ?? [];

  const touches = (call: RawToolCall): boolean =>
    call.path !== undefined && call.path !== null && returned.some((path) => pathMatches(path, call.path!));

  const openedReturnedPath = after.some((call) => READ_TOOLS.has(normalize(call.tool)) && touches(call));
  const editedReturnedPath = after.some((call) => EDIT_TOOLS.has(normalize(call.tool)) && touches(call));
  const editedNonReturnedPath = after.some((call) => EDIT_TOOLS.has(normalize(call.tool)) && !touches(call));
  const ordinaryCallsAfterFirstVtrace = after.filter((call) =>
    ORDINARY_REPOSITORY_TOOLS.has(normalize(call.tool))).length;

  const firstEditAfter = after.findIndex((call) => EDIT_TOOLS.has(normalize(call.tool)));
  const beforeEdit = firstEditAfter === -1 ? after : after.slice(0, firstEditAfter);
  const searchesBetweenCallAndFirstEdit = beforeEdit.filter((call) =>
    SEARCH_TOOLS.has(normalize(call.tool)) || READ_TOOLS.has(normalize(call.tool))).length;

  const followUpVtraceCalls = Math.max(0, records.length - 1);

  const labels = new Set<AgentReaction>();

  // With no returned paths, "ignored what it returned" and "edited somewhere it
  // did not name" are both trivially true of every run, and would be reported as
  // findings about the agent. They are facts about the empty result instead.
  if (!quality.evidenceDelivered) {
    labels.add("NO_EVIDENCE_DELIVERED");
    if (followUpVtraceCalls > 0) labels.add("REQUESTED_FOLLOWUP_VTRACE");
    return {
      labels: Object.freeze([...labels]),
      openedReturnedPath, editedReturnedPath, editedNonReturnedPath,
      ordinaryCallsAfterFirstVtrace, searchesBetweenCallAndFirstEdit, followUpVtraceCalls,
    };
  }

  if (openedReturnedPath || editedReturnedPath) labels.add("USED_AS_ORIENTATION");
  if (searchesBetweenCallAndFirstEdit > 0) labels.add("VERIFIED_WITH_NORMAL_TOOLS");
  if (!openedReturnedPath && !editedReturnedPath) labels.add("IGNORED");
  if (followUpVtraceCalls > 0) labels.add("REQUESTED_FOLLOWUP_VTRACE");

  // Disagreement is only visible when the agent went somewhere else AND that
  // somewhere else worked. Editing elsewhere and failing is not recovery.
  if (quality.goldRelation === "ABSENT" && editedNonReturnedPath && resolved === true) {
    labels.add("DISAGREED_AND_RECOVERED");
  }
  // Anchoring requires all three: the evidence missed gold, the agent edited only
  // where it pointed, and the outcome was wrong. Two of the three is a guess.
  if (quality.goldRelation === "ABSENT" && editedReturnedPath && !editedNonReturnedPath && resolved === false) {
    labels.add("ANCHORED_INCORRECTLY");
  }

  return {
    labels: Object.freeze([...labels]),
    openedReturnedPath,
    editedReturnedPath,
    editedNonReturnedPath,
    ordinaryCallsAfterFirstVtrace,
    searchesBetweenCallAndFirstEdit,
    followUpVtraceCalls,
  };
}

// ---------------------------------------------------------------------------
// False authority
// ---------------------------------------------------------------------------

export interface FalseAuthorityFinding {
  readonly detected: boolean;
  readonly reason: string;
  readonly evidenceMissedGold: boolean;
  readonly editedOnlyReturnedPaths: boolean;
  readonly independentVerificationBeforeEdit: number;
}

/**
 * Did the agent treat a weak result as authoritative?
 *
 * The operational definition is behavioural, not rhetorical: the evidence missed
 * gold, the agent edited only what the evidence named, and it performed no
 * independent search or read in between. A required call must not become a
 * required belief, and this is the measurement that would show it had.
 */
export function detectFalseAuthority(
  reaction: ReactionAnalysis,
  quality: EvidenceQuality,
): FalseAuthorityFinding {
  // False authority is only definable against evidence the agent actually saw.
  const evidenceMissedGold = quality.evidenceDelivered && quality.goldRelation === "ABSENT";
  const editedOnlyReturnedPaths = reaction.editedReturnedPath && !reaction.editedNonReturnedPath;
  const detected = evidenceMissedGold
    && editedOnlyReturnedPaths
    && reaction.searchesBetweenCallAndFirstEdit === 0;

  return {
    detected,
    reason: detected
      ? "edited only the paths the weak result named, with no independent read or search first"
      : "not all of: evidence missed gold, edits confined to returned paths, zero independent verification",
    evidenceMissedGold,
    editedOnlyReturnedPaths,
    independentVerificationBeforeEdit: reaction.searchesBetweenCallAndFirstEdit,
  };
}

// ---------------------------------------------------------------------------
// False absence
// ---------------------------------------------------------------------------

/**
 * Phrases that assert nonexistence. Absence of a MENTION is never evidence — §82
 * — so this scans the agent's own words for a positive claim and returns
 * candidates for inspection rather than a verdict.
 */
const NONEXISTENCE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bdoes(?:n't| not) (?:exist|appear to exist)\b/i,
  /\bthere is no\b/i,
  /\bno such (?:file|function|method|class|symbol)\b/i,
  /\bcould not find any\b/i,
  /\bis not (?:present|defined|implemented) (?:in|anywhere in) (?:the|this) (?:repo|repository|codebase)\b/i,
  /\bnothing (?:like that|of the sort) exists\b/i,
]);

export interface FalseAbsenceCandidate {
  readonly phrase: string;
  readonly context: string;
  readonly nearVtraceMention: boolean;
}

export function findFalseAbsenceCandidates(
  assistantText: string,
  windowChars = 400,
): readonly FalseAbsenceCandidate[] {
  const candidates: FalseAbsenceCandidate[] = [];
  for (const pattern of NONEXISTENCE_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags.includes("g") ? "" : "g"}${pattern.flags}`);
    let match: RegExpExecArray | null = global.exec(assistantText);
    while (match !== null) {
      const start = Math.max(0, match.index - windowChars);
      const context = assistantText.slice(start, match.index + windowChars);
      candidates.push({
        phrase: match[0],
        context,
        nearVtraceMention: /vtrace|get_code_context|get_impact_graph/i.test(context),
      });
      match = global.exec(assistantText);
    }
  }
  return Object.freeze(candidates);
}

// ---------------------------------------------------------------------------
// Paired outcome matrix
// ---------------------------------------------------------------------------

export type PairedOutcome =
  | "SHARED_SUCCESS"
  | "SHARED_FAILURE"
  | "TO_UNIQUE_WIN"
  | "FROM_UNIQUE_WIN"
  | "NOT_COMPARABLE";

export function classifyPairedOutcome(
  from: boolean | null,
  to: boolean | null,
): PairedOutcome {
  if (from === null || to === null) return "NOT_COMPARABLE";
  if (from && to) return "SHARED_SUCCESS";
  if (!from && !to) return "SHARED_FAILURE";
  return to ? "TO_UNIQUE_WIN" : "FROM_UNIQUE_WIN";
}
