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
  path: number;
  symbol: number;
  graph: number;
  centrality: number;
  /** Combined local relevance (lexical/symbol/path/test) used by the hub gate. */
  local_evidence_score: number;
  /** Global dependent count (in-degree); high values flag a generic hub. */
  in_degree_or_dependent_count: number;
  /** Graph+centrality boost stripped from a generic hub; 0 for normal items. */
  hub_penalty: number;
  final: number;
}

export interface CapsuleSelectionDiagnostic {
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
  target_confidence: TargetConfidence;
  likely_files: string[];
  likely_symbols: string[];
  retrieval_reason: string;
  /** Per-item score breakdown + evidence; omitted when no breakdown is known. */
  selection?: CapsuleSelectionDiagnostic[];
}

export interface BuildCapsuleDiagnosticsInput {
  mode: CapsuleMode;
  capsule: Capsule;
  recommendation: ModeRecommendation;
  /** Likely files from SWE shaping; falls back to capsule pivot files. */
  likelyFiles?: readonly string[];
  /** Likely symbols from SWE shaping; falls back to capsule pivot symbols. */
  likelySymbols?: readonly string[];
  /** Char/item counts of the emitted context; falls back to capsule metrics. */
  contextChars?: number;
  contextItems?: number;
  /** Per-item score breakdown + evidence; attached verbatim when provided. */
  selection?: readonly CapsuleSelectionDiagnostic[];
}

export function buildCapsuleDiagnostics(
  input: BuildCapsuleDiagnosticsInput,
): CapsuleDiagnostics {
  const items = capsuleItems(input.capsule);

  return {
    mode: input.mode,
    context_chars: input.contextChars ?? input.capsule.budget.usedCharacters,
    context_items: input.contextItems ?? items.length,
    recommended_mode: input.recommendation.recommendedMode,
    target_confidence: input.recommendation.targetConfidence,
    likely_files: dedupe(
      input.likelyFiles ?? items.map((item) => item.filePath),
    ),
    likely_symbols: dedupe(
      input.likelySymbols ?? items.map((item) => item.localName),
    ),
    retrieval_reason: input.recommendation.retrievalReason,
    ...(input.selection && input.selection.length > 0
      ? { selection: [...input.selection] }
      : {}),
  };
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
}

export interface CompactCapsuleResult {
  text: string;
  chars: number;
  items: number;
}

const DEFAULT_SNIPPET_CHARS = 600;

// Render a capsule as a compact, injection-ready context block. Pivots lead
// (they are the likely edit targets); supporting items contribute symbol
// references. The full problem statement is never emitted here.
export function renderCompactCapsule(
  capsule: Capsule,
  options: CompactCapsuleOptions,
): CompactCapsuleResult {
  const maxSnippetChars = options.maxSnippetChars ?? DEFAULT_SNIPPET_CHARS;
  const pivots = capsule.pivots;
  const supporting = capsule.supportingItems;
  const lines: string[] = ["# vtrace context"];

  const likelyTargets = dedupe(pivots.map((item) => `${item.filePath} — ${item.localName}`));
  if (likelyTargets.length > 0) {
    lines.push("", "## likely edit targets", ...likelyTargets.map((t) => `- ${t}`));
  }

  const symbols = dedupe(
    [...pivots, ...supporting].map((item) => `${item.fqName} (${item.kind})`),
  );
  if (symbols.length > 0) {
    lines.push("", "## relevant symbols", ...symbols.map((s) => `- ${s}`));
  }

  const snippets = pivots
    .map((item) => renderSnippet(item, maxSnippetChars))
    .filter((snippet): snippet is string => snippet !== undefined);
  if (snippets.length > 0) {
    lines.push("", "## snippets", ...snippets);
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
