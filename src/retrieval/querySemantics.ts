// Deterministic, request-local interpretation of task prose.
//
// This is deliberately a small grammar, not a general NLP parser. It recognizes
// only high-confidence contrast constructions and explicit identifier contexts.
// The derived value is immutable input to retrieval lanes and candidate scoring,
// so polarity/confidence is computed once rather than rediscovered per candidate.

export type ContrastConfidence = "high" | "none";
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
  readonly reason: string;
}

export interface DerivedQueryIntent {
  readonly originalTask: string;
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
  readonly weakLiteralTokens: readonly string[];
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

export function deriveQueryIntent(task: string): DerivedQueryIntent {
  const contrastClauses = parseContrastClauses(task);
  const comparisonIdentifiers = collectComparisonIdentifiers(task);
  const contrastIdentifiers = unique(contrastClauses.flatMap((clause) => clause.contrastIdentifiers));
  const explicit = collectExplicitIdentifiers(task, contrastClauses, comparisonIdentifiers);
  const explicitIdentifiers = explicit.filter((term) =>
    !contrastIdentifiers.some((excluded) => sameIdentifier(term, excluded))
    || comparisonIdentifiers.some((compared) => sameIdentifier(term, compared))
  );
  const identifierSignals = classifyIdentifierSignals(task, unique([...explicitIdentifiers, ...contrastIdentifiers]));
  const removals = contrastClauses.map((clause) => ({ start: clause.start, end: clause.end }));
  const positiveSearchText = removeSpans(task, removals);
  const positiveTerms = contentTerms(positiveSearchText);
  const contrastTerms = unique(contrastClauses.flatMap((clause) => clause.contrastTerms));
  const contrastPhrases = unique(contrastClauses.map((clause) => clause.contrastPhrase.toLowerCase()));
  const weakLiteralTokens = unique(identifierSignals
    .filter((signal) => signal.confidence === "weak_short_literal" || signal.confidence === "ordinary_prose")
    .map((signal) => signal.term.toLowerCase()));

  return {
    originalTask: task,
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

function collectExplicitIdentifiers(
  task: string,
  clauses: readonly ContrastClause[],
  comparisonIdentifiers: readonly string[],
): string[] {
  const out = [...comparisonIdentifiers, ...clauses.flatMap((clause) => clause.positiveIdentifiers)];
  const patterns = [
    new RegExp(String.raw`[` + "`" + String.raw`"](${IDENTIFIER})[` + "`" + String.raw`"]`, "gu"),
    /\b(?:class|method|symbol|element|type)\s+([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu,
    /\bfunction\s+(?:named\s+|called\s+)?([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu,
    /\b(?:find|show|locate|explain)\s+([A-Z][A-Za-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gu,
    /\b([A-Z][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z0-9_./-]+::[A-Za-z_][A-Za-z0-9_]*)\b/gu,
  ];
  for (const pattern of patterns) {
    for (const match of task.matchAll(pattern)) out.push(match[1]!);
  }
  // Uppercase two/three-letter code tokens are explicit when they participate in
  // a parsed contrast clause (DB rather than IO), never merely because of case.
  for (const clause of clauses) {
    out.push(...clause.positiveIdentifiers);
  }
  return unique(out).filter((term) => {
    const last = leaf(term);
    const lower = last.toLowerCase();
    return !TERM_STOPWORDS.has(lower) || last !== lower;
  });
}

function classifyIdentifierSignals(task: string, explicit: readonly string[]): IdentifierSignal[] {
  const out: IdentifierSignal[] = explicit.map((term) => ({
    term,
    confidence: "explicit_identifier",
    reason: "explicit code/symbol context",
  }));
  const explicitLower = new Set(explicit.map((term) => leaf(term).toLowerCase()));
  for (const match of task.matchAll(/(?<!['’])\b[A-Za-z][A-Za-z0-9_]{0,2}\b/gu)) {
    const term = match[0];
    const lower = term.toLowerCase();
    if (explicitLower.has(lower)) continue;
    if (term.length <= 2 && ORDINARY_LANGUAGE_IDENTIFIER_WORDS.has(lower)) {
      out.push({ term, confidence: "ordinary_prose", reason: "short ordinary-language token without explicit identifier context" });
    } else if (term.length <= 2) {
      out.push({ term, confidence: "weak_short_literal", reason: "short token without explicit identifier context" });
    }
  }
  return dedupeSignals(out);
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
