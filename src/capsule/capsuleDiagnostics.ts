// Capsule diagnostics + compact rendering.
//
// Every capsule can report a small machine-readable diagnostics object so a
// caller (CLI, benchmark, MCP) can reason about sizing without parsing prose.
// The compact renderer turns a capsule into an injection-ready block that
// carries only retrieved context — likely edit targets, relevant symbols,
// compact snippets, a short rationale, and relevant tests — and deliberately
// omits the full problem statement (the agent already receives the issue text).

import { CapsuleContentMode, type Capsule, type CapsuleItem } from "./types";
import type { CapsuleMode } from "./capsuleModes";
import type { ModeRecommendation, RecommendedCapsuleMode, TargetConfidence } from "./recommendMode";

// Per-item score breakdown reported alongside each selected capsule item, so a
// caller can see WHY it was chosen rather than just THAT it was. The component
// keys mirror the hybrid retrieval scorer (Requirement 5).
export interface CapsuleItemScores {
  lexical: number;
  /** Alias of the BM25/TF-IDF lexical sub-signal (scorecard vocabulary). */
  bm25: number;
  path: number;
  symbol: number;
  /** Test-to-implementation strength: how strongly a failing test reaches this. */
  testToImpl: number;
  /** Issue-derived domain relevance (query terms matching path/name tokens). */
  domain: number;
  graph: number;
  /** Alias of `graph`: graph proximity to the working set (scorecard vocabulary). */
  graphProximity: number;
  centrality: number;
  /** Edit-target actionability: 1 for function/method/class, 0 for module vars. */
  actionability: number;
  /** Combined local relevance (lexical/symbol/path/domain/test) for the gate. */
  local_evidence_score: number;
  /** Global dependent count (in-degree); high values flag a generic hub. */
  in_degree_or_dependent_count: number;
  /** Graph+centrality boost stripped from a generic hub; 0 for normal items. */
  hub_penalty: number;
  /** Graph+domain boost stripped from a low-actionability module var; else 0. */
  actionability_penalty: number;
  final: number;
}

/** The role a candidate was assigned during selection (Requirement 3). */
export type CapsuleSelectionRole = "pivot" | "support";

/**
 * How hard the agent should search before trusting the capsule (Requirement 5).
 *   low      — high-confidence pivot with direct evidence; try it first.
 *   moderate — pivot recovered but indirect/medium-confidence; check one support.
 *   high     — no pivot or ambiguous; broad search (or skip) is warranted.
 */
export type SearchBudget = "low" | "moderate" | "high";

/**
 * The decisive "edit here first" header rendered atop a capsule (Requirement 1).
 * `has_target` is false when no high-confidence pivot was recovered, in which
 * case the renderer emits a "do not inject context" directive instead of a
 * target. The structured fields let a caller reason about the directive without
 * parsing the rendered prose.
 */
export interface CapsuleActionHeader {
  /** True iff a concrete, high-confidence edit target was recovered. */
  has_target: boolean;
  /** The pivot file to open/edit first; null when `has_target` is false. */
  pivot_file: string | null;
  /** The pivot symbol to open/edit first; null when `has_target` is false. */
  pivot_symbol: string | null;
  /** Top evidence lines explaining why this is the target (≤3). */
  why: string[];
  /** One-line, pattern-based "what change to look for" cue; null when none. */
  edit_intent_hint: string | null;
}

export interface CapsuleSelectionDiagnostic {
  /** pivot = likely edit target (full source); support = context (skeleton). */
  role: CapsuleSelectionRole;
  path: string;
  symbol: string;
  scores: CapsuleItemScores;
  evidence: string[];
}

export interface CapsuleDiagnostics {
  mode: CapsuleMode;
  context_chars: number;
  context_items: number;
  recommended_mode: RecommendedCapsuleMode;
  /** The mode actually emitted (may be `skip` when no pivot was recovered). */
  actual_mode: RecommendedCapsuleMode;
  target_confidence: TargetConfidence;
  /** Number of pivot (likely edit target) items in the emitted capsule. */
  pivot_count: number;
  /** Number of support (context) items in the emitted capsule. */
  support_count: number;
  likely_files: string[];
  likely_symbols: string[];
  retrieval_reason: string;
  /** How hard to search before trusting the capsule (Requirement 5). */
  search_budget: SearchBudget;
  /** Why the search budget was classified as it was. */
  search_budget_reason: string;
  /** The decisive "edit here first" directive (Requirement 1). */
  action_header: CapsuleActionHeader;
  /** Per-item role + score breakdown + evidence; omitted when none is known. */
  selection?: CapsuleSelectionDiagnostic[];
}

export interface BuildCapsuleDiagnosticsInput {
  mode: CapsuleMode;
  capsule: Capsule;
  recommendation: ModeRecommendation;
  /** The mode actually emitted; defaults to `mode` (use `skip` for empty). */
  actualMode?: RecommendedCapsuleMode;
  /** Likely files from SWE shaping; falls back to capsule pivot files. */
  likelyFiles?: readonly string[];
  /** Likely symbols from SWE shaping; falls back to capsule pivot symbols. */
  likelySymbols?: readonly string[];
  /** Char/item counts of the emitted context; falls back to capsule metrics. */
  contextChars?: number;
  contextItems?: number;
  /** Search budget; defaults from confidence + pivot presence when omitted. */
  searchBudget?: SearchBudget;
  searchBudgetReason?: string;
  /** Action header; defaults from the capsule's lead pivot when omitted. */
  actionHeader?: CapsuleActionHeader;
  /** Per-item role + score breakdown + evidence; attached verbatim when provided. */
  selection?: readonly CapsuleSelectionDiagnostic[];
}

export function buildCapsuleDiagnostics(
  input: BuildCapsuleDiagnosticsInput,
): CapsuleDiagnostics {
  const items = capsuleItems(input.capsule);
  const actualMode = input.actualMode ?? input.mode;
  const leadPivot = input.capsule.pivots[0];
  const hasTarget = actualMode !== "skip" && leadPivot !== undefined;

  // The action header + search budget are normally computed by the orchestrator
  // (which has the full scorecard, ambiguity, and edit-intent hint). When a
  // caller does not supply them, fall back to a well-formed default derived from
  // the capsule's lead pivot so the fields are always present (Requirement 8).
  const actionHeader: CapsuleActionHeader = input.actionHeader ?? {
    has_target: hasTarget,
    pivot_file: hasTarget ? (leadPivot?.filePath ?? null) : null,
    pivot_symbol: hasTarget ? (leadPivot?.localName ?? null) : null,
    why: [],
    edit_intent_hint: null,
  };
  const searchBudget: SearchBudget =
    input.searchBudget ?? defaultSearchBudget(hasTarget, input.recommendation.targetConfidence);
  const searchBudgetReason =
    input.searchBudgetReason ?? defaultSearchBudgetReason(hasTarget, searchBudget);

  return {
    mode: input.mode,
    context_chars: input.contextChars ?? input.capsule.budget.usedCharacters,
    context_items: input.contextItems ?? items.length,
    recommended_mode: input.recommendation.recommendedMode,
    actual_mode: actualMode,
    target_confidence: input.recommendation.targetConfidence,
    pivot_count: input.capsule.pivots.length,
    support_count: input.capsule.supportingItems.length,
    likely_files: dedupe(
      input.likelyFiles ?? items.map((item) => item.filePath),
    ),
    likely_symbols: dedupe(
      input.likelySymbols ?? items.map((item) => item.localName),
    ),
    retrieval_reason: input.recommendation.retrievalReason,
    search_budget: searchBudget,
    search_budget_reason: searchBudgetReason,
    action_header: actionHeader,
    ...(input.selection && input.selection.length > 0
      ? { selection: [...input.selection] }
      : {}),
  };
}

// A minimal default used only when the orchestrator does not pass an explicit
// budget. Without the pivot's scorecard we cannot know whether its evidence is
// direct, so a high-confidence target defaults to moderate (not low) — the
// orchestrator path supplies low when it has verified direct evidence.
function defaultSearchBudget(
  hasTarget: boolean,
  confidence: TargetConfidence,
): SearchBudget {
  if (!hasTarget) {
    return "high";
  }
  return confidence === "low" ? "high" : "moderate";
}

function defaultSearchBudgetReason(hasTarget: boolean, budget: SearchBudget): string {
  if (!hasTarget) {
    return "No high-confidence edit target recovered; broad search or skip.";
  }
  return budget === "moderate"
    ? "Pivot recovered; check it before searching broadly."
    : "Low-confidence pivot; verify against the failing test before editing.";
}

export interface CompactCapsuleOptions {
  /** Hard cap on the rendered block. */
  maxChars: number;
  /** Per-snippet character cap. */
  maxSnippetChars?: number;
  /** Relevant test ids to surface (e.g. SWE failing tests). */
  tests?: readonly string[];
  /** Short rationale line. */
  reason?: string;
  /** Decisive "edit here first" directive rendered atop the block (Req 1). */
  actionHeader?: CapsuleActionHeader;
  /** Search budget surfaced in the action header (Req 1/5). */
  searchBudget?: SearchBudget;
}

export interface CompactCapsuleResult {
  text: string;
  chars: number;
  items: number;
}

const DEFAULT_SNIPPET_CHARS = 600;

// Render a capsule as a compact, injection-ready context block. The block leads
// with a decisive "## Recommended first action" directive (open/edit the pivot
// first), then the single primary edit target with its source, then support
// context explicitly labelled "do not edit first" so the agent does not treat
// every listed file as an edit candidate. The full problem statement is never
// emitted here.
export function renderCompactCapsule(
  capsule: Capsule,
  options: CompactCapsuleOptions,
): CompactCapsuleResult {
  const maxSnippetChars = options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS;
  const pivots = capsule.pivots;
  const supporting = capsule.supportingItems;
  const lines: string[] = ["# vtrace context"];

  if (options.actionHeader) {
    lines.push("", "## Recommended first action", ...renderActionHeader(options.actionHeader, options.searchBudget));
  }

  const primaryTargets = dedupe(pivots.map((item) => `${item.filePath} — ${item.localName}`));
  if (primaryTargets.length > 0) {
    lines.push("", "## Primary edit target", ...primaryTargets.map((t) => `- ${t}`));
  }

  const snippets = pivots
    .map((item) => renderSnippet(item, maxSnippetChars))
    .filter((snippet): snippet is string => snippet !== undefined);
  if (snippets.length > 0) {
    lines.push("", "## snippets", ...snippets);
  }

  // Support context is explicitly NOT an edit target — label it so the agent
  // does not treat it as another likely place to change (Requirement 3).
  const supportSymbols = dedupe(supporting.map((item) => `${item.fqName} (${item.kind})`));
  if (supportSymbols.length > 0) {
    lines.push("", "## Support context — do not edit first", ...supportSymbols.map((s) => `- ${s}`));
  }

  if (options.tests && options.tests.length > 0) {
    lines.push("", "## relevant tests", ...dedupe(options.tests).map((t) => `- ${t}`));
  }

  if (options.reason && options.reason.trim().length > 0) {
    lines.push("", "## why", options.reason.trim());
  }

  const full = lines.join("\n").trim();
  const text = full.length > options.maxChars
    ? `${full.slice(0, options.maxChars).trimEnd()}\n[truncated to ${options.maxChars} chars]`
    : full;

  return { text, chars: text.length, items: pivots.length + supporting.length };
}

// Render the body of the "## Recommended first action" section. With a target,
// it is a directive ("Open/edit X first") plus why/intent/budget; without one,
// a single line telling the agent not to inject context for this task (Req 1).
function renderActionHeader(header: CapsuleActionHeader, budget?: SearchBudget): string[] {
  if (!header.has_target || !header.pivot_file || !header.pivot_symbol) {
    return ["", "No high-confidence edit target recovered. Do not inject context for this task."];
  }

  const lines: string[] = ["", `Open/edit \`${header.pivot_file}::${header.pivot_symbol}\` first.`];
  if (header.why.length > 0) {
    lines.push("", "Why:", ...header.why.map((reason) => `- ${reason}`));
  }
  if (header.edit_intent_hint) {
    lines.push("", `Edit intent: ${header.edit_intent_hint}`);
  }
  if (budget) {
    lines.push("", `Search budget: ${budget}`);
  }
  lines.push("", "Do not search broadly unless this target does not explain the failing test.");
  return lines;
}

function renderSnippet(item: CapsuleItem, maxChars: number): string | undefined {
  const body = snippetBody(item);
  if (body === undefined) {
    return undefined;
  }

  const trimmed = body.length > maxChars ? `${body.slice(0, maxChars).trimEnd()}\n…` : body;
  return `### ${item.filePath}::${item.localName}\n\`\`\`\n${trimmed}\n\`\`\``;
}

function snippetBody(item: CapsuleItem): string | undefined {
  const content = item.content;

  switch (content.mode) {
    case CapsuleContentMode.Full:
      return content.source;
    case CapsuleContentMode.Summary:
      return content.signature ? `${content.signature}\n${content.summary}` : content.summary;
    case CapsuleContentMode.SignatureOnly:
      return content.signature;
    case CapsuleContentMode.Stub:
      return content.stub;
    case CapsuleContentMode.Skeleton:
      return `(skeleton: ${item.filePath})`;
  }
}

function capsuleItems(capsule: Capsule): CapsuleItem[] {
  return [...capsule.pivots, ...capsule.supportingItems];
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
