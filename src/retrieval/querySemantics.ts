// Deterministic, request-local interpretation of task prose.
//
// This is deliberately a small grammar, not a general NLP parser. It recognizes
// only high-confidence contrast constructions and explicit identifier contexts.
// The derived value is immutable input to retrieval lanes and candidate scoring,
// so polarity/confidence is computed once rather than rediscovered per candidate.

export type ContrastConfidence = "high" | "none";
export type QueryIntentKind = "capability_lookup" | "general";
export type IdentifierConfidence =
  | "explicit_identifier"
  | "strong_literal"
  | "weak_short_literal"
  | "ordinary_prose";

export interface ContrastClause {
  readonly cue: string;
  readonly positivePhrase?: string;
  readonly contrastPhrase: string;
  readonly positiveTerms: readonly string[];
  readonly contrastTerms: readonly string[];
  readonly positiveIdentifiers: readonly string[];
  readonly contrastIdentifiers: readonly string[];
  readonly confidence: ContrastConfidence;
  readonly start: number;
  readonly end: number;
}

export interface IdentifierSignal {
  readonly term: string;
  readonly confidence: IdentifierConfidence;
  readonly source: SymbolHypothesisSource;
  readonly eligibleAsSymbol: boolean;
  readonly reason: string;
}

export type SymbolHypothesisSource =
  | "backtick"
  | "call_syntax"
  | "comparison"
  | "declaration_phrase"
  | "explicit_lookup"
  | "path_qualified"
  | "project_reference"
  | "short_literal";

export interface DerivedQueryIntent {
  readonly originalTask: string;
  readonly kind: QueryIntentKind;
  readonly intentReason?: string;
  /** Task prose with high-confidence excluded spans removed. */
  readonly positiveSearchText: string;
  readonly positiveTerms: readonly string[];
  readonly contrastTerms: readonly string[];
  readonly contrastPhrases: readonly string[];
  /** Token-normalized once per request for bounded phrase matching. */
  readonly normalizedContrastPhrases: readonly string[];
  readonly contrastClauses: readonly ContrastClause[];
  readonly explicitIdentifiers: readonly string[];
  readonly contrastIdentifiers: readonly string[];
  readonly comparisonIdentifiers: readonly string[];
  readonly identifierSignals: readonly IdentifierSignal[];
  /** The only task-prose symbols eligible to seed symbol-oriented consumers. */
  readonly symbolHypotheses: readonly IdentifierSignal[];
  /** Repository-name mentions retained as context, never silently as symbols. */
  readonly projectReferences: readonly string[];
  readonly weakLiteralTokens: readonly string[];
}

export interface DeriveQueryIntentOptions {
  readonly projectNameAliases?: ReadonlySet<string>;
}

// Small task-language set. This affects identifier confidence only; tokens stay
// available to document/FTS language processing unless they are in an excluded
// contrast span.
export const ORDINARY_LANGUAGE_IDENTIFIER_WORDS: ReadonlySet<string> = new Set([
  "a", "am", "an", "and", "as", "at", "be", "but", "by", "do", "for",
  "from", "go", "i", "id", "if", "in", "is", "it", "no", "not", "of",
  "on", "or", "the", "to", "with",
]);

const TERM_STOPWORDS: ReadonlySet<string> = new Set([
  ...ORDINARY_LANGUAGE_IDENTIFIER_WORDS,
  "also", "does", "find", "function", "given", "itself", "only", "one",
  "rather", "show", "symbol", "than", "that", "this", "using", "version", "where",
  "why", "without",
]);

const IDENTIFIER = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*`;
const MAX_SCOPE_TOKENS = 12;

export function deriveQueryIntent(task: string, options: DeriveQueryIntentOptions = {}): DerivedQueryIntent {
  const contrastClauses = parseContrastClauses(task);
  const comparisonIdentifiers = collectComparisonIdentifiers(task);
  const contrastIdentifiers = unique(contrastClauses.flatMap((clause) => clause.contrastIdentifiers));
  const explicitSignals = collectExplicitIdentifierSignals(task, contrastClauses, comparisonIdentifiers);
  const projectReferences = collectProjectReferences(task, options.projectNameAliases ?? new Set());
  const explicit = explicitSignals
    .filter((signal) => !projectReferences.some((term) => sameIdentifier(term, signal.term)) || hasExplicitProjectSymbolContext(task, signal.term))
    .map((signal) => signal.term);
  const explicitIdentifiers = explicit.filter((term) =>
    !contrastIdentifiers.some((excluded) => sameIdentifier(term, excluded))
    || comparisonIdentifiers.some((compared) => sameIdentifier(term, compared))
  );
  const eligibleExplicitSignals = explicitSignals.filter((signal) =>
    explicitIdentifiers.some((term) => sameIdentifier(term, signal.term))
    || contrastIdentifiers.some((term) => sameIdentifier(term, signal.term)));
  const identifierSignals = classifyIdentifierSignals(task, eligibleExplicitSignals, projectReferences);
  const symbolHypotheses = identifierSignals.filter((signal) => signal.eligibleAsSymbol);
  const removals = contrastClauses.map((clause) => ({ start: clause.start, end: clause.end }));
  const positiveSearchText = removeSpans(task, removals);
  const positiveTerms = contentTerms(positiveSearchText);
  const contrastTerms = unique(contrastClauses.flatMap((clause) => clause.contrastTerms));
  const contrastPhrases = unique(contrastClauses.map((clause) => clause.contrastPhrase.toLowerCase()));
  const weakLiteralTokens = unique(identifierSignals
    .filter((signal) => signal.confidence === "weak_short_literal" || signal.confidence === "ordinary_prose")
    .map((signal) => signal.term.toLowerCase()));

  const capabilityIntent = detectCapabilityLookup(task, comparisonIdentifiers);

  return {
    originalTask: task,
    kind: capabilityIntent.kind,
    ...(capabilityIntent.reason === undefined ? {} : { intentReason: capabilityIntent.reason }),
    positiveSearchText,
    positiveTerms,
    contrastTerms,
    contrastPhrases,
    normalizedContrastPhrases: contrastPhrases.map(normalizePhrase).filter(Boolean),
    contrastClauses,
    explicitIdentifiers,
    contrastIdentifiers,
    comparisonIdentifiers,
    identifierSignals,
    symbolHypotheses,
    projectReferences,
    weakLiteralTokens,
  };
}

export function parseContrastClauses(task: string): ContrastClause[] {
  // These traps mention/compare a symbol but do not exclude it as a target.
  const protectedRanges = ranges(task, [
    /\bnot\s+only\b[^.!?;\n]*\bbut\s+also\b/giu,
    /\bwhether\s+or\s+not\b[^.!?;\n]*/giu,
    /\bno\s+longer\s+(?:calls?|uses?|invokes?)\b[^.!?;\n]*/giu,
    /\bdoes\s+not\b[^.!?;\n]*/giu,
    /\bdoesn't\b[^.!?;\n]*/giu,
    /\bnot\s+[^,.!?;\n]+\s+itself\s*,?\s*but\b[^.!?;\n]*/giu,
    // Bug reports commonly contrast observed failure with expected behavior.
    // Both sides are relevant; the RHS is not an implementation exclusion.
    /\b(?:raises?|throws?|fails?|crashes?)\b[^.!?;\n]*\binstead\s+of\b[^.!?;\n]*/giu,
    /\buses\b[^.!?;\n]*\binstead\s+of\b[^.!?;\n]*/giu,
    /\bexcept\s+(?:sometimes|when|that|for)\b[^.!?;\n]*/giu,
    /\b(?:is|are|was|were)\s+(?:\w+\s+){0,4}without\b[^.!?;\n]*/giu,
  ]);
  const clauses: ContrastClause[] = [];
  const add = (
    cue: string,
    positivePhrase: string | undefined,
    contrastPhrase: string,
    start: number,
    end: number,
  ): void => {
    if (protectedRanges.some((range) => overlaps(start, end, range.start, range.end))) return;
    const contrast = cleanPhrase(contrastPhrase);
    const positive = positivePhrase === undefined ? undefined : cleanPhrase(positivePhrase);
    if (contrast.length === 0) return;
    clauses.push({
      cue,
      ...(positive === undefined || positive.length === 0 ? {} : { positivePhrase: positive }),
      contrastPhrase: contrast,
      positiveTerms: positive === undefined ? [] : contentTerms(positive),
      contrastTerms: contentTerms(contrast),
      positiveIdentifiers: positive === undefined ? [] : identifiersInPhrase(positive),
      contrastIdentifiers: identifiersInPhrase(contrast),
      confidence: "high",
      start,
      end,
    });
  };

  // Preferred side precedes the cue; only the excluded right-hand span is
  // removed. Scope ends at sentence punctuation/adversative conjunction or the
  // deterministic token cap. "and" remains inside the phrase (four atom indices).
  for (const match of task.matchAll(/\b(rather\s+than|instead\s+of|other\s+than)\b/giu)) {
    const cueStart = match.index ?? 0;
    const rhsStart = cueStart + match[0].length;
    const right = boundedRight(task, rhsStart);
    add(match[1]!.toLowerCase(), boundedLeft(task, cueStart), right.text, cueStart, right.end);
  }

  for (const match of task.matchAll(/\b(without|excluding|except)\b/giu)) {
    const cueStart = match.index ?? 0;
    const rhsStart = cueStart + match[0].length;
    const right = boundedRight(task, rhsStart);
    add(match[1]!.toLowerCase(), undefined, right.text, cueStart, right.end);
  }

  for (const match of task.matchAll(/\bbut\s+not\s+([^,.!?;\n]{1,120})/giu)) {
    const start = match.index ?? 0;
    add("but not", boundedLeft(task, start), match[1]!, start, start + match[0].length);
  }

  for (const match of task.matchAll(new RegExp(String.raw`\b(?:not\s+the\s+(${IDENTIFIER})(?:\s+version)?|not\s+(${IDENTIFIER})\s+version)\b`, "giu"))) {
    const start = match.index ?? 0;
    add("not … version", undefined, (match[1] ?? match[2])!, start, start + match[0].length);
  }

  // "not B, but A": B is excluded and A is preferred. Deliberately narrow;
  // protected traps above and the required `but` avoid generic negation.
  for (const match of task.matchAll(/\bnot\s+([^,.!?;\n]{1,120}?)\s*,?\s+but\s+([^,.!?;\n]{1,120})/giu)) {
    const start = match.index ?? 0;
    const positiveOffset = match[0].lastIndexOf(match[2]!);
    add("not … but", match[2], match[1]!, start, start + positiveOffset);
  }

  return dedupeClauses(clauses).sort((a, b) => a.start - b.start || a.end - b.end);
}

function collectComparisonIdentifiers(task: string): string[] {
  const out: string[] = [];
  for (const match of task.matchAll(new RegExp(String.raw`\bcompare\s+(${IDENTIFIER})\s+(?:with|and|to)\s+(${IDENTIFIER})`, "giu"))) {
    out.push(match[1]!, match[2]!);
  }
  for (const match of task.matchAll(new RegExp(String.raw`\bwhy\s+(?:doesn't|does\s+not)\s+(${IDENTIFIER})\s+(?:call|use|invoke)\s+(${IDENTIFIER})`, "giu"))) {
    out.push(match[1]!, match[2]!);
  }
  return unique(out);
}

function collectExplicitIdentifierSignals(
  task: string,
  clauses: readonly ContrastClause[],
  comparisonIdentifiers: readonly string[],
): IdentifierSignal[] {
  const out: IdentifierSignal[] = [];
  const add = (term: string, source: SymbolHypothesisSource, reason: string): void => {
    out.push({ term, confidence: "explicit_identifier", source, eligibleAsSymbol: true, reason });
  };
  for (const term of comparisonIdentifiers) add(term, "comparison", "explicit comparison operand");
  for (const term of clauses.flatMap((clause) => clause.positiveIdentifiers)) {
    add(term, "explicit_lookup", "identifier on preferred contrast side");
  }
  const patterns: ReadonlyArray<readonly [RegExp, SymbolHypothesisSource, string]> = [
    [new RegExp(String.raw`[` + "`" + String.raw`"](${IDENTIFIER})(?:\(\))?[` + "`" + String.raw`"]`, "gu"), "backtick", "author-marked code identifier"],
    [/\b(?:class|method|symbol|element|type)\s+([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu, "declaration_phrase", "explicit symbol-kind phrase"],
    [/\b([A-Z][A-Za-z0-9_]*)\s+(?:class|symbol|type)\b/gu, "declaration_phrase", "explicit trailing symbol-kind phrase"],
    [/\b(?:def|function|func|fn)\s+(?:named\s+|called\s+)?([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu, "declaration_phrase", "explicit function declaration/name phrase"],
    [/\b(?:find|show|locate|explain)\s+([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu, "explicit_lookup", "explicit lookup verb with code-shaped identifier"],
    [/\b([A-Z][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9_./-]+::[A-Za-z_][A-Za-z0-9_]*)\b/gu, "path_qualified", "member/path-qualified identifier"],
    [/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu, "call_syntax", "call syntax"],
  ];
  for (const [pattern, source, reason] of patterns) {
    for (const match of task.matchAll(pattern)) add(match[1]!, source, reason);
  }
  // Uppercase two/three-letter code tokens are explicit when they participate in
  // a parsed contrast clause (DB rather than IO), never merely because of case.
  for (const clause of clauses) {
    for (const term of clause.positiveIdentifiers) add(term, "explicit_lookup", "identifier on preferred contrast side");
  }
  return dedupeSignals(out).filter((signal) => {
    const last = leaf(signal.term);
    const lower = last.toLowerCase();
    return !TERM_STOPWORDS.has(lower) || last !== lower;
  });
}

function classifyIdentifierSignals(
  task: string,
  explicit: readonly IdentifierSignal[],
  projectReferences: readonly string[],
): IdentifierSignal[] {
  const out: IdentifierSignal[] = [...explicit];
  const explicitLower = new Set(explicit.map((signal) => leaf(signal.term).toLowerCase()));
  for (const term of projectReferences) {
    if (explicitLower.has(leaf(term).toLowerCase())) continue;
    out.push({
      term,
      confidence: "ordinary_prose",
      source: "project_reference",
      eligibleAsSymbol: false,
      reason: "known repository/project reference without explicit symbol context",
    });
  }
  for (const match of task.matchAll(/(?<!['’])\b[A-Za-z][A-Za-z0-9_]{0,2}\b/gu)) {
    const term = match[0];
    const lower = term.toLowerCase();
    if (explicitLower.has(lower)) continue;
    if (term.length <= 2 && ORDINARY_LANGUAGE_IDENTIFIER_WORDS.has(lower)) {
      out.push({ term, confidence: "ordinary_prose", source: "short_literal", eligibleAsSymbol: false, reason: "short ordinary-language token without explicit identifier context" });
    } else if (term.length <= 2) {
      out.push({ term, confidence: "weak_short_literal", source: "short_literal", eligibleAsSymbol: false, reason: "short token without explicit identifier context" });
    }
  }
  return dedupeSignals(out);
}

function collectProjectReferences(task: string, aliases: ReadonlySet<string>): string[] {
  if (aliases.size === 0) return [];
  const out: string[] = [];
  for (const match of task.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]*\b/gu)) {
    if (aliases.has(match[0].toLowerCase()) && !hasExplicitProjectSymbolContext(task, match[0])) out.push(match[0]);
  }
  return unique(out);
}

function hasExplicitProjectSymbolContext(task: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`\\b(?:class|symbol|constructor)\\s+${escaped}\\b`, "i"),
    new RegExp(`\\b${escaped}\\s+(?:class|symbol|constructor|object|instance)\\b`, "i"),
    new RegExp(`\\b${escaped}(?:\\.[A-Za-z_]|\\s*\\()`),
    new RegExp(`[\\w./-]+::${escaped}\\b`),
    new RegExp("[`'\"]" + escaped + "[`'\"]"),
  ].some((pattern) => pattern.test(task));
}

function detectCapabilityLookup(
  task: string,
  comparisonIdentifiers: readonly string[],
): { kind: QueryIntentKind; reason?: string } {
  if (comparisonIdentifiers.length > 0) return { kind: "general" };
  const patterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/\b(?:is there|does there exist)\s+(?:already\s+)?(?:a|an|any)\s+(?:function|method|helper)\b/iu, "existence question"],
    [/\bdoes\s+(?:a|the)\s+(?:function|method|helper)\s+exist\b/iu, "existence question"],
    [/\bdo\s+we\s+already\s+have\b/iu, "existing-capability question"],
    [/\b(?:find|where is)\s+(?:the|a)\s+(?:function|method|helper)\s+that\b/iu, "definition lookup phrase"],
    [/\b(?:which|what)\s+(?:function|method|helper)\b/iu, "capability selection question"],
    [/\bwhere\s+(?:is|does)\s+(?:the\s+)?(?:function|method|helper)\b/iu, "definition location question"],
    [/\b(?:a|the)\s+(?:function|method|helper)\s+that\s+(?:returns?|parses?|loads?|computes?|calculates?|normalizes?|converts?|creates?|finds?|gets?|handles?)\b/iu, "capability description"],
  ];
  for (const [pattern, reason] of patterns) {
    if (pattern.test(task)) return { kind: "capability_lookup", reason };
  }
  return { kind: "general" };
}

function boundedRight(task: string, start: number): { text: string; end: number } {
  const tail = task.slice(start);
  const boundary = tail.search(/[.!?;\n]|\s+(?:but|while|although|though|because|so|running|causing|resulting)\s+/iu);
  const raw = boundary === -1 ? tail : tail.slice(0, boundary);
  const capped = capWords(raw, MAX_SCOPE_TOKENS);
  return { text: capped.text, end: start + capped.end };
}

function boundedLeft(task: string, end: number): string {
  let head = task.slice(0, end).trimEnd();
  if (head.endsWith(",")) head = head.slice(0, -1).trimEnd();
  const boundary = Math.max(head.lastIndexOf("."), head.lastIndexOf("?"), head.lastIndexOf("!"), head.lastIndexOf(";"), head.lastIndexOf("\n"), head.lastIndexOf(","));
  const phrase = head.slice(boundary + 1).trim();
  const words = phrase.split(/\s+/u).filter(Boolean);
  return words.slice(-MAX_SCOPE_TOKENS).join(" ");
}

function capWords(text: string, max: number): { text: string; end: number } {
  const matches = [...text.matchAll(/\S+/gu)];
  if (matches.length <= max) return { text, end: text.length };
  const last = matches[max - 1]!;
  const end = (last.index ?? 0) + last[0].length;
  return { text: text.slice(0, end), end };
}

function cleanPhrase(value: string): string {
  return value.trim().replace(/^[,:\-\s]+|[,\-\s]+$/gu, "").replace(/\s+/gu, " ");
}

function identifiersInPhrase(phrase: string): string[] {
  const out: string[] = [];
  for (const match of phrase.matchAll(new RegExp(String.raw`\b${IDENTIFIER}\b`, "gu"))) {
    const term = match[0];
    const lower = term.toLowerCase();
    if (term.includes("_") || term.includes(".") || term.includes("::") || /^[A-Z]{1,3}$/u.test(term)) {
      out.push(term);
    } else if (term.length > 2 && !TERM_STOPWORDS.has(lower) && /^[a-z][a-z0-9]*$/u.test(term)) {
      // Ordinary phrase nouns remain terms, not identifiers.
    }
  }
  return unique(out);
}

function contentTerms(value: string): string[] {
  return unique(tokenize(value).filter((term) => term.length >= 2 && !TERM_STOPWORDS.has(term)));
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .map((term) => term.toLowerCase())
    .filter(Boolean);
}

function removeSpans(task: string, spans: readonly { start: number; end: number }[]): string {
  let out = task;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, span.start)} ${out.slice(span.end)}`;
  }
  return out.replace(/\s+/gu, " ").trim();
}

function ranges(task: string, patterns: readonly RegExp[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    for (const match of task.matchAll(pattern)) {
      const start = match.index ?? 0;
      out.push({ start, end: start + match[0].length });
    }
  }
  return out;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function sameIdentifier(a: string, b: string): boolean {
  return leaf(a).toLowerCase() === leaf(b).toLowerCase();
}

function leaf(value: string): string {
  return value.split(/::|\./u).at(-1) ?? value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeSignals(values: readonly IdentifierSignal[]): IdentifierSignal[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.term.toLowerCase()}\0${value.confidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeClauses(values: readonly ContrastClause[]): ContrastClause[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.start}\0${value.end}\0${value.contrastPhrase.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface CandidateContrastEvaluation {
  readonly positiveObjectiveScore: number;
  readonly contrastPenalty: number;
  readonly matchedPositiveTerms: readonly string[];
  readonly matchedContrastTerms: readonly string[];
  readonly matchedContrastPhrases: readonly string[];
  readonly reason?: string;
}

export interface DirectAnswerEvaluation {
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly matchedPhrases: readonly string[];
  readonly parameterShapeMatched: boolean;
  readonly reason?: string;
}

const CAPABILITY_META_TERMS: ReadonlySet<string> = new Set([
  "already", "directly", "exist", "exists", "helper", "method", "please", "project",
]);

/**
 * Bounded deterministic definition-local capability evidence. The candidate body
 * is intentionally absent: name, kind, indexed signature and indexed docstring
 * are enough to distinguish an answer from a merely related implementation.
 */
export function evaluateDirectAnswer(
  intent: DerivedQueryIntent,
  candidate: {
    readonly localName: string;
    readonly kind: string;
    readonly signature: string;
    readonly docstring?: string | null;
  },
): DirectAnswerEvaluation {
  if (intent.kind !== "capability_lookup" || !["function", "method"].includes(candidate.kind)) {
    return { score: 0, matchedTerms: [], matchedPhrases: [], parameterShapeMatched: false };
  }

  const queryTerms = intent.positiveTerms
    .filter((term) => !CAPABILITY_META_TERMS.has(term))
    .slice(0, 12);
  const nameTokens = normalizedCapabilityTokens(candidate.localName);
  const signatureTokens = normalizedCapabilityTokens(candidate.signature);
  const docTokens = normalizedCapabilityTokens(candidate.docstring ?? "");
  const definitionTokens = new Set([...nameTokens, ...signatureTokens, ...docTokens]);
  const matchedTerms = queryTerms.filter((term) => definitionTokens.has(normalizeCapabilityTerm(term)));
  const nameMatches = queryTerms.filter((term) => nameTokens.includes(normalizeCapabilityTerm(term)));
  const docMatches = queryTerms.filter((term) => docTokens.includes(normalizeCapabilityTerm(term)));

  const queryPairs = adjacentPairs(queryTerms.map(normalizeCapabilityTerm));
  const definitionText = [...nameTokens, ...signatureTokens, ...docTokens].join(" ");
  const matchedPhrases = queryPairs.filter((pair) => definitionText.includes(pair)).slice(0, 3);
  const parameterShapeMatched = matchesParameterShape(intent.positiveSearchText, candidate.signature);
  const coverage = queryTerms.length === 0 ? 0 : matchedTerms.length / queryTerms.length;
  const hasNameConcept = nameMatches.length > 0;
  const hasDefinitionExplanation = docMatches.length >= 2 || matchedPhrases.length > 0;

  let score = coverage * 0.62
    + Math.min(0.16, matchedPhrases.length * 0.08)
    + (hasNameConcept && hasDefinitionExplanation ? 0.12 : 0)
    + (parameterShapeMatched ? 0.1 : 0);
  // Incidental prose may mention every query word. Without a matching symbol-name
  // concept it remains related context, never a primary answer-bearing boost.
  if (!hasNameConcept) score = Math.min(score, 0.28);
  // A single generic overlap (e.g. only "vector") is insufficient capability evidence.
  if (matchedTerms.length < 2) score = 0;
  score = Math.round(Math.min(0.95, score) * 1e4) / 1e4;

  return {
    score,
    matchedTerms: matchedTerms.slice(0, 8),
    matchedPhrases,
    parameterShapeMatched,
    ...(score > 0
      ? { reason: `direct definition matches requested capability: ${matchedTerms.slice(0, 6).join(", ")}${parameterShapeMatched ? "; parameter shape aligns" : ""}` }
      : {}),
  };
}

function normalizedCapabilityTokens(value: string): string[] {
  return tokenize(value).map(normalizeCapabilityTerm);
}

function normalizeCapabilityTerm(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 3 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

function adjacentPairs(terms: readonly string[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index + 1 < terms.length; index += 1) pairs.push(`${terms[index]} ${terms[index + 1]}`);
  return unique(pairs);
}

function matchesParameterShape(query: string, signature: string): boolean {
  const countWords: Readonly<Record<string, number>> = { single: 1, one: 1, two: 2, three: 3, four: 4 };
  const countMatch = query.toLowerCase().match(/\b(single|one|two|three|four)\s+([a-z][a-z0-9_]*)/u);
  const paramsMatch = signature.match(/\(([^)]*)\)/u);
  if (countMatch === null || paramsMatch === null) return false;
  const requested = countWords[countMatch[1]!] ?? 0;
  const concept = normalizeCapabilityTerm(countMatch[2]!);
  const params = paramsMatch[1]!.split(",").map((part) => part.trim().split(/[:=]/u)[0]!.trim()).filter(Boolean);
  const conceptInitial = concept.at(0) ?? "";
  const aligned = params.filter((param) => {
    const tokens = normalizedCapabilityTokens(param);
    return tokens.includes(concept) || new RegExp(`^${conceptInitial}\\d+$`, "iu").test(param);
  });
  return requested > 0 && aligned.length >= requested;
}

export function identifierConfidenceForSymbol(
  intent: DerivedQueryIntent,
  localName: string,
): IdentifierConfidence {
  const lower = localName.toLowerCase();
  if (intent.explicitIdentifiers.some((term) => leaf(term).toLowerCase() === lower)
    || intent.comparisonIdentifiers.some((term) => leaf(term).toLowerCase() === lower)
    || intent.contrastIdentifiers.some((term) => leaf(term).toLowerCase() === lower)) {
    return "explicit_identifier";
  }
  if (localName.length <= 2 && ORDINARY_LANGUAGE_IDENTIFIER_WORDS.has(lower)) {
    return "ordinary_prose";
  }
  if (localName.length <= 2) return "weak_short_literal";
  return "strong_literal";
}

/** Bounded candidate-local scoring over one already-derived request intent. */
export function evaluateCandidateContrast(
  intent: DerivedQueryIntent,
  candidate: {
    readonly localName: string;
    readonly fqName: string;
    readonly filePath: string;
    readonly signature: string;
    readonly docstring?: string | null;
  },
): CandidateContrastEvaluation {
  if (intent.contrastClauses.length === 0) {
    return { positiveObjectiveScore: 0, contrastPenalty: 0, matchedPositiveTerms: [], matchedContrastTerms: [], matchedContrastPhrases: [] };
  }
  const identity = `${candidate.localName} ${candidate.fqName} ${candidate.filePath}`;
  const text = `${identity} ${candidate.signature} ${candidate.docstring ?? ""}`;
  const tokenList = tokenize(text);
  const tokens = new Set(tokenList);
  const matchedPositiveTerms = intent.positiveTerms.filter((term) => tokens.has(term)).slice(0, 4);
  const matchedContrastTerms = intent.contrastTerms.filter((term) => tokens.has(term)).slice(0, 4);
  const normalizedText = tokenList.join(" ");
  const matchedContrastPhrases = intent.normalizedContrastPhrases
    .filter((phrase) => normalizedText.includes(phrase))
    .slice(0, 2);
  const localLower = candidate.localName.toLowerCase();
  const exactContrastIdentifier = intent.contrastIdentifiers.some((term) => leaf(term).toLowerCase() === localLower);
  const exactPositiveIdentifier = intent.explicitIdentifiers.some((term) => leaf(term).toLowerCase() === localLower)
    || intent.comparisonIdentifiers.some((term) => leaf(term).toLowerCase() === localLower);
  const positiveObjectiveScore = Math.min(0.24, matchedPositiveTerms.length * 0.06);
  const rawPenalty = matchedContrastTerms.length * 0.14
    + matchedContrastPhrases.length * 0.18
    + (exactContrastIdentifier ? 0.45 : 0);
  // An explicitly targeted/comparison symbol remains an anchor even if generic
  // descriptive words around it are contrasted. An explicitly excluded symbol
  // is intentionally not protected.
  const contrastPenalty = exactPositiveIdentifier && !exactContrastIdentifier
    ? 0
    : Math.min(0.75, rawPenalty);
  return {
    positiveObjectiveScore,
    contrastPenalty,
    matchedPositiveTerms,
    matchedContrastTerms,
    matchedContrastPhrases,
    ...(contrastPenalty > 0
      ? { reason: `high-confidence contrast matched ${[...matchedContrastTerms, ...matchedContrastPhrases].join(", ") || candidate.localName}` }
      : {}),
  };
}

function normalizePhrase(value: string): string {
  return tokenize(value).join(" ");
}
