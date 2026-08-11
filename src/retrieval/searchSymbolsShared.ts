// @ts-nocheck
import type { Database } from "bun:sqlite";

import { parseSymbolKind } from "../domain/guards";
import { type SymbolKind } from "../domain/types";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type SymbolSearchMatch,
  type SymbolSearchResult,
} from "./types";

export interface SearchCandidateRow {
  symbol_id: string;
  file_path: string;
  fq_name: string;
  local_name: string;
  kind: string;
  signature: string;
  docstring: string | null;
}

interface WeightedFieldMatch {
  field: SymbolSearchMatchField;
  exact: number;
  prefix: number;
  substring: number;
}

interface QueryTermGroup {
  label: string;
  variants: readonly string[];
}

export interface BoundaryQueryContext {
  readonly matchedTerms: readonly string[];
  readonly candidateExtensions: readonly string[];
}

export interface BroadQueryContext {
  readonly orderedTerms: readonly string[];
  readonly termGroups: readonly QueryTermGroup[];
  readonly phraseGroups: readonly QueryTermGroup[];
  readonly admissionDisjuncts: readonly (readonly QueryTermGroup[])[];
}

export interface TestAwareQueryContext {
  readonly penalizeLikelyTests: boolean;
  readonly matchedTestTerms: readonly string[];
}

export interface PathSignalQueryContext {
  readonly pathTerms: readonly string[];
  readonly variantsByTerm: ReadonlyMap<string, readonly string[]>;
}

type TechnicalQueryDimension =
  | "entrypoint"
  | "io"
  | "lowlevel"
  | "parser"
  | "serialization"
  | "utility";

export interface TechnicalQueryContext {
  readonly matchedDimensions: readonly TechnicalQueryDimension[];
}

export interface LikelyTestCandidateSignals {
  readonly pathSignal: boolean;
  readonly symbolSignal: boolean;
}

export interface SearchRankingContexts {
  readonly boundaryContext?: BoundaryQueryContext;
  readonly broadContext?: BroadQueryContext;
  readonly testContext?: TestAwareQueryContext;
  readonly technicalContext?: TechnicalQueryContext;
  readonly pathSignalContext?: PathSignalQueryContext;
}

/**
 * SQL predicate excluding STRUCTURAL symbols from retrieval candidate
 * generation (M140).
 *
 * A module scope symbol exists so module-level imports have a stable owner. It
 * has no body to deliver and no identifier a user would search for, but its
 * `fq_name` and file path would still match path-shaped queries — so without
 * this it would occupy candidate slots, lexical ranking positions, and delivery
 * budget that belong to real definitions. It remains fully visible to graph
 * consumers (expansion, rerank, impact, upstream rescue).
 */
export const EXCLUDE_STRUCTURAL_SYMBOLS_SQL = "symbols.kind != 'module'";

export const SYMBOL_SEARCH_SCORE_WEIGHTS = Object.freeze({
  localNameExact: 100,
  localNamePrefix: 60,
  localNameSubstring: 40,
  fqNameExact: 30,
  fqNamePrefix: 25,
  fqNameSubstring: 20,
  signatureSubstring: 10,
  docstringSubstring: 8,
  filePathSubstring: 4,
  boundaryHintBase: 18,
  boundaryHintPerMatchedTerm: 4,
  boundaryHintMatchedTermMax: 8,
  boundaryPreferredExtension: 8,
  boundaryTopLevelKind: 4,
  boundaryPrivatePenalty: 2,
  broadTermLocalNameExact: 28,
  broadTermLocalNamePrefix: 20,
  broadTermLocalNameSubstring: 14,
  broadTermFqNameExact: 22,
  broadTermFqNamePrefix: 18,
  broadTermFqNameSubstring: 14,
  broadTermSignatureSubstring: 12,
  broadTermDocstringSubstring: 10,
  broadTermFilePathSubstring: 12,
  broadCoveragePerTerm: 6,
  broadCoverageMax: 18,
  likelyTestPathPenalty: 12,
  likelyTestSymbolPenalty: 8,
  likelyTestPenaltyMax: 18,
  technicalHintBase: 8,
  technicalHintPerDimension: 4,
  technicalHintMax: 20,
  technicalLowLevelCythonBonus: 8,
  technicalSerializationBonus: 6,
  technicalEntrypointBonus: 6,
  pathSegmentSignalBase: 14,
  pathSegmentSignalPerExtraTerm: 6,
  pathSegmentSignalMax: 30,
  pathSegmentSiblingBonus: 4,
});

const PATH_SIGNAL_CANDIDATE_LIMIT = 96;

const ALL_CYTHON_EXTENSIONS = Object.freeze([".pxd", ".pxi", ".pyx"]);
const BROAD_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "by",
  "did",
  "does",
  "end",
  "for",
  "from",
  "get",
  "gets",
  "getting",
  "how",
  "in",
  "is",
  "new",
  "of",
  "on",
  "or",
  "the",
  "then",
  "to",
  "work",
  "worked",
  "working",
  "works",
  "where",
  "with",
]);
const TEST_ORIENTED_QUERY_TERMS = new Set([
  "benchmark",
  "benchmarks",
  "fixture",
  "fixtures",
  "integration",
  "mock",
  "mocks",
  "regression",
  "smoke",
  "spec",
  "specs",
  "test",
  "testing",
  "tests",
  "unit",
]);
const TEST_PATH_SEGMENTS = new Set([
  "__specs__",
  "__tests__",
  "spec",
  "specs",
  "test",
  "testing",
  "tests",
]);
const EXPLICIT_BROAD_TERM_VARIANTS = new Map<string, readonly string[]>([
  ["action", ["act", "acted", "acting", "actions", "command", "commands", "dispatch"]],
  ["actions", ["action", "act", "command", "commands", "dispatch"]],
  ["debug", ["diagnose", "diagnostic", "diagnostics", "error", "failure", "troubleshoot", "troubleshooting"]],
  ["decision", ["decide", "decided", "decides", "determine", "determined", "evaluate"]],
  ["determine", ["decide", "derive", "determined", "determines", "evaluate", "evaluated", "resolve", "resolved", "resolution"]],
  ["error", ["errors", "exception", "exceptions", "failure", "failures", "failing", "invalid"]],
  ["errors", ["error", "exception", "exceptions", "failure", "failures", "failing", "invalid"]],
  ["fallback", ["backoff", "default", "defaults", "downgrade", "recover", "recovery"]],
  ["handle", ["handled", "handler", "handlers", "handling", "process", "processed", "processing"]],
  ["handler", ["handle", "handled", "handlers", "handling", "process", "processing"]],
  ["dict", ["dictionary", "as_dict", "to_dict", "from_dict", "json", "yaml", "serialize", "dump", "load"]],
  ["fast", ["compiled", "cython", "performance", "pyx"]],
  ["helper", ["utility", "utilities", "util", "utils", "common", "core", "internal"]],
  ["input", ["read", "load", "import"]],
  ["map", ["mapped", "mapping", "maps", "route", "routes", "routing", "translate", "translation"]],
  ["mapped", ["map", "mapping", "maps", "route", "routing", "translate"]],
  ["mapping", ["map", "mapped", "maps", "route", "routing", "translate"]],
  ["output", ["write", "dump", "export"]],
  ["parse", ["parser", "parsing", "adapter"]],
  ["parsed", ["parse", "parser", "parsing", "adapter"]],
  ["parser", ["parse", "parsing", "adapter"]],
  ["pattern", ["match", "matched", "matching", "patterns", "rule", "rules"]],
  ["process", ["handle", "handler", "handling", "processed", "processing"]],
  ["recognized", ["classify", "classified", "classification", "detect", "detected", "detection", "recognize", "recognition"]],
  ["recognize", ["classified", "classification", "classify", "detect", "detected", "detection", "recognized", "recognition"]],
  ["retry", ["backoff", "recover", "recovery", "retries", "retried", "retrying"]],
  ["run", ["main", "start", "launch", "execute", "cli"]],
  ["status", ["condition", "conditions", "state", "states"]],
  ["troubleshoot", ["debug", "diagnose", "diagnostic", "diagnostics", "failure", "recovery", "troubleshooting"]],
  ["troubleshooting", ["debug", "diagnose", "diagnostic", "diagnostics", "failure", "recovery", "troubleshoot"]],
  ["utility", ["utilities", "util", "utils", "helper", "helpers", "common", "core", "internal"]],
  ["workflow", ["flow", "pipeline", "pipelines", "workflows"]],
]);
const EXPLICIT_BROAD_PHRASE_VARIANTS = new Map<string, readonly string[]>([
  ["low level", ["low level", "low-level", "lowlevel", "compiled", "cython", "core", "internal", "pyx"]],
]);

const LOCAL_NAME_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.LocalName,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.localNameExact,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.localNamePrefix,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.localNameSubstring,
};

const FQ_NAME_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.FQName,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.fqNameExact,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.fqNamePrefix,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.fqNameSubstring,
};

const SIGNATURE_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.Signature,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.signatureSubstring,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.signatureSubstring,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.signatureSubstring,
};

const DOCSTRING_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.Docstring,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.docstringSubstring,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.docstringSubstring,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.docstringSubstring,
};

const FILE_PATH_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.FilePath,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.filePathSubstring,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.filePathSubstring,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.filePathSubstring,
};

const BROAD_TERM_LOCAL_NAME_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.LocalName,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermLocalNameExact,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermLocalNamePrefix,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermLocalNameSubstring,
};

const BROAD_TERM_FQ_NAME_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.FQName,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermFqNameExact,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermFqNamePrefix,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermFqNameSubstring,
};

const BROAD_TERM_SIGNATURE_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.Signature,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermSignatureSubstring,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermSignatureSubstring,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermSignatureSubstring,
};

const BROAD_TERM_DOCSTRING_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.Docstring,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermDocstringSubstring,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermDocstringSubstring,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermDocstringSubstring,
};

const BROAD_TERM_FILE_PATH_MATCH: WeightedFieldMatch = {
  field: SymbolSearchMatchField.FilePath,
  exact: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermFilePathSubstring,
  prefix: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermFilePathSubstring,
  substring: SYMBOL_SEARCH_SCORE_WEIGHTS.broadTermFilePathSubstring,
};

export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\\/g, "/").toLowerCase();
}

export function normalizeMaxResults(maxResults: number): number {
  if (!Number.isInteger(maxResults) || maxResults < 0) {
    throw new Error("maxResults must be a non-negative integer");
  }

  return maxResults;
}

export function makeLikePattern(query: string): string {
  return `%${escapeLikePattern(query)}%`;
}

export function rankSearchCandidates(
  candidates: readonly SearchCandidateRow[],
  query: string,
  maxResults: number,
  contexts: SearchRankingContexts = {},
): SymbolSearchResult[] {
  return candidates
    .map((candidate) => scoreCandidate(candidate, query, contexts))
    .filter((result): result is SymbolSearchResult => result !== undefined)
    .sort(compareSearchResults)
    .slice(0, maxResults);
}

export function buildFtsSearchText(value: string): string {
  return collectSearchTerms(value).join(" ");
}

export function buildFtsMatchQuery(query: string): string | undefined {
  return buildFtsMatchQueryForContext(query);
}

export function buildFtsMatchQueryForContext(
  query: string,
  broadContext?: BroadQueryContext,
): string | undefined {
  if (broadContext !== undefined) {
    const disjuncts = broadContext.admissionDisjuncts
      .map((groups) => {
        const groupExpressions = groups.map(renderTermGroupMatchExpression);

        return groupExpressions.length === 1
          ? groupExpressions[0]!
          : `(${groupExpressions.join(" AND ")})`;
      })
      .filter((expression): expression is string => expression !== undefined && expression.length > 0);

    if (disjuncts.length > 0) {
      return [...new Set(disjuncts)].join(" OR ");
    }
  }

  const terms = collectSearchTerms(query);

  if (terms.length === 0) {
    return undefined;
  }

  return terms.map((term) => `"${term}"`).join(" AND ");
}

export function buildFtsSingleTermRecoveryQueryForContext(
  broadContext?: BroadQueryContext,
): string | undefined {
  if (broadContext === undefined || broadContext.termGroups.length === 0) {
    return undefined;
  }

  const disjuncts = broadContext.termGroups
    .map(renderTermGroupMatchExpression)
    .filter((expression): expression is string => expression !== undefined && expression.length > 0)
    .slice(0, 8);

  if (disjuncts.length === 0) {
    return undefined;
  }

  return [...new Set(disjuncts)].join(" OR ");
}

export function resolveBoundaryQueryContext(
  query: string,
  enableBoundaryBoosts = true,
): BoundaryQueryContext | undefined {
  if (!enableBoundaryBoosts) {
    return undefined;
  }

  const terms = new Set(collectSearchTerms(query));
  const matchedTerms = new Set<string>();
  const candidateExtensions = new Set<string>();

  if (terms.has("cython")) {
    matchedTerms.add("cython");

    for (const extension of ALL_CYTHON_EXTENSIONS) {
      candidateExtensions.add(extension);
    }
  }

  if (terms.has("cimport")) {
    matchedTerms.add("cimport");
    candidateExtensions.add(".pxd");
  }

  if (terms.has("compiled")) {
    matchedTerms.add("compiled");
    candidateExtensions.add(".pyx");
  }

  if (terms.has("kernel")) {
    matchedTerms.add("kernel");
    candidateExtensions.add(".pyx");
  }

  if (terms.has("extension")) {
    matchedTerms.add("extension");
    candidateExtensions.add(".pyx");
  }

  if (terms.has("performance") && (terms.has("critical") || terms.has("routine"))) {
    matchedTerms.add("performance");
    candidateExtensions.add(".pyx");
  }

  if (terms.has("wrapper") && terms.has("cython")) {
    matchedTerms.add("wrapper");
    candidateExtensions.add(".pxd");
    candidateExtensions.add(".pyx");
  }

  if (terms.has("fast") && terms.has("parser")) {
    matchedTerms.add("fast");
    matchedTerms.add("parser");
    candidateExtensions.add(".pyx");
  }

  if (
    (terms.has("lowlevel") || terms.has("low-level") || (terms.has("low") && terms.has("level")))
    && (terms.has("utility") || terms.has("helper") || terms.has("core"))
  ) {
    matchedTerms.add("low");
    matchedTerms.add("utility");
    candidateExtensions.add(".pyx");
  }

  if (matchedTerms.size === 0) {
    return undefined;
  }

  return {
    matchedTerms: [...matchedTerms].sort(),
    candidateExtensions: [...candidateExtensions].sort(),
  };
}

export function resolveBroadQueryContext(
  query: string,
  enableBroadQueryBoosts = true,
  enableCompoundTaskDecomposition = false,
): BroadQueryContext | undefined {
  if (!enableBroadQueryBoosts) {
    return undefined;
  }

  const trimmedQuery = query.trim();

  // Preserve exact handling for a standalone repository path, but do not let a
  // prose separator such as "immutability/supersession" disable decomposition
  // for an otherwise natural-language task. Treating every slash as a path made
  // the fallback builder require every word in a compound task in one FTS row.
  if (
    enableCompoundTaskDecomposition
      ? isStandalonePathLikeQuery(trimmedQuery)
      : /[\\/]/.test(trimmedQuery)
  ) {
    return undefined;
  }

  if (!/[\s_-]/.test(trimmedQuery)) {
    return undefined;
  }

  const orderedTerms = collectOrderedSearchTerms(query)
    .filter((term) => term.length > 1)
    .filter((term) => !BROAD_QUERY_STOPWORDS.has(term));
  const uniqueOrderedTerms = collectUniqueInOrder(orderedTerms);

  if (uniqueOrderedTerms.length < 2) {
    return undefined;
  }

  if (!shouldApplyBroadQueryBoosts(trimmedQuery, uniqueOrderedTerms)) {
    return undefined;
  }

  const termGroups = uniqueOrderedTerms.map((term) => ({
    label: term,
    variants: buildBroadTermVariants(term),
  }));
  const phraseGroups = buildBroadPhraseGroups(uniqueOrderedTerms);
  const admissionDisjuncts = buildBroadAdmissionDisjuncts(
    termGroups,
    phraseGroups,
    enableCompoundTaskDecomposition,
  );

  if (admissionDisjuncts.length === 0) {
    return undefined;
  }

  return {
    orderedTerms: uniqueOrderedTerms,
    termGroups,
    phraseGroups,
    admissionDisjuncts,
  };
}

export function resolveTestAwareQueryContext(
  query: string,
  broadContext: BroadQueryContext | undefined,
  enableTestAwareDownweighting = true,
): TestAwareQueryContext | undefined {
  if (!enableTestAwareDownweighting || broadContext === undefined) {
    return undefined;
  }

  const matchedTestTerms = collectSearchTerms(query)
    .filter((term) => TEST_ORIENTED_QUERY_TERMS.has(term));

  return {
    penalizeLikelyTests: matchedTestTerms.length === 0,
    matchedTestTerms: collectUniqueInOrder(matchedTestTerms).sort(),
  };
}

export function resolveTechnicalQueryContext(
  query: string,
  broadContext: BroadQueryContext | undefined,
  enableTechnicalQueryBoosts = true,
): TechnicalQueryContext | undefined {
  if (!enableTechnicalQueryBoosts) {
    return undefined;
  }

  const trimmedQuery = query.trim();

  if (trimmedQuery.length === 0) {
    return undefined;
  }

  const terms = new Set(collectSearchTerms(query));
  const matchedDimensions = new Set<TechnicalQueryDimension>();

  if (terms.has("run") || terms.has("execute") || terms.has("launch") || terms.has("start")) {
    matchedDimensions.add("entrypoint");
  }

  if (
    terms.has("dict")
    || terms.has("dictionary")
    || terms.has("json")
    || terms.has("yaml")
    || terms.has("serialize")
    || terms.has("serialization")
    || terms.has("deserialize")
    || terms.has("dump")
    || terms.has("load")
  ) {
    matchedDimensions.add("serialization");
  }

  if (
    terms.has("parse")
    || terms.has("parsed")
    || terms.has("parser")
    || terms.has("parsing")
    || terms.has("adapter")
    || terms.has("ess")
  ) {
    matchedDimensions.add("parser");
  }

  if (
    terms.has("utility")
    || terms.has("utilities")
    || terms.has("util")
    || terms.has("utils")
    || terms.has("helper")
    || terms.has("helpers")
    || terms.has("common")
    || terms.has("core")
    || terms.has("internal")
  ) {
    matchedDimensions.add("utility");
  }

  if (
    terms.has("fast")
    || terms.has("compiled")
    || terms.has("cython")
    || terms.has("extension")
    || terms.has("performance")
    || terms.has("lowlevel")
    || terms.has("low-level")
    || ((terms.has("low") || terms.has("lower")) && terms.has("level"))
  ) {
    matchedDimensions.add("lowlevel");
  }

  if (
    terms.has("input")
    || terms.has("output")
    || terms.has("read")
    || terms.has("write")
    || terms.has("load")
    || terms.has("dump")
    || terms.has("parse")
    || terms.has("parser")
    || terms.has("io")
    || terms.has("ess")
  ) {
    matchedDimensions.add("io");
  }

  if (matchedDimensions.size === 0) {
    return undefined;
  }

  if (broadContext === undefined && !/[_\s.-]/.test(trimmedQuery)) {
    return undefined;
  }

  return {
    matchedDimensions: [...matchedDimensions].sort(),
  };
}

export function resolvePathSignalQueryContext(
  query: string,
  broadContext: BroadQueryContext | undefined,
  enablePathSignalBoosts = true,
  enableCompoundTaskDecomposition = false,
): PathSignalQueryContext | undefined {
  if (!enablePathSignalBoosts) {
    return undefined;
  }

  const variantsByTerm = new Map<string, readonly string[]>();
  const pathTerms: string[] = [];

  // Historical SQL/hybrid callers retain their broad-term path-signal behavior.
  // The explicit extractor is the routed product-mode correction and is enabled
  // only with compound-task decomposition, as routeQuery requests.
  if (!enableCompoundTaskDecomposition) {
    if (broadContext === undefined) return undefined;
    for (const group of broadContext.termGroups) {
      if (!isLegacyPathLikeTerm(group.label)) continue;
      pathTerms.push(group.label);
      variantsByTerm.set(group.label, group.variants);
    }
    if (pathTerms.length < 2) return undefined;
    return { pathTerms, variantsByTerm };
  }

  for (const term of extractExplicitPathTerms(query)) {
    pathTerms.push(term);
    const broadGroup = broadContext?.termGroups.find((group) => group.label === term);
    variantsByTerm.set(term, broadGroup?.variants ?? buildBroadTermVariants(term));
  }

  if (pathTerms.length < 2) {
    return undefined;
  }

  return {
    pathTerms,
    variantsByTerm,
  };
}

export function extractPathSegments(filePath: string): string[] {
  return filePath
    .toLowerCase()
    .replace(/\\/g, "/")
    .split(/[/.\-_]/)
    .filter((segment) => segment.length > 0);
}

export function queryPathSignalCandidates(
  db: Database,
  pathSignalContext: PathSignalQueryContext | undefined,
  kind?: SymbolKind,
): SearchCandidateRow[] {
  if (pathSignalContext === undefined) {
    return [];
  }

  const variants = collectUniqueInOrder(
    [...pathSignalContext.variantsByTerm.values()].flat(),
  );

  if (variants.length === 0) {
    return [];
  }

  const conditions = variants.map(() => "lower(files.path) LIKE ? ESCAPE '\\'").join(" OR ");
  const sql = `
    SELECT
      symbols.id AS symbol_id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.docstring
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE ${EXCLUDE_STRUCTURAL_SYMBOLS_SQL}
      AND (${conditions})
      ${kind === undefined ? "" : "AND symbols.kind = ?"}
    ORDER BY files.path ASC, symbols.fq_name ASC, symbols.id ASC
    LIMIT ?
  `;
  const params: unknown[] = variants.map((variant) => makeLikePattern(variant));

  if (kind !== undefined) {
    params.push(kind);
  }

  params.push(PATH_SIGNAL_CANDIDATE_LIMIT);

  return db.query(sql).all(...params) as SearchCandidateRow[];
}

function isStandalonePathLikeQuery(query: string): boolean {
  if (/\s/.test(query)) return false;
  return extractPathFragments(query).some((fragment) => fragment === query || stripWrappingPunctuation(fragment) === stripWrappingPunctuation(query));
}

function isLegacyPathLikeTerm(term: string): boolean {
  return /^[a-z][a-z0-9]{2,}$/.test(term) && !BROAD_QUERY_STOPWORDS.has(term);
}

function extractExplicitPathTerms(query: string): string[] {
  const terms: string[] = [];
  for (const fragment of extractPathFragments(query)) {
    const withoutUrlPrefix = fragment.replace(/^https?:\/\/[^/]+/i, "");
    for (const segment of withoutUrlPrefix.replace(/\\/g, "/").split(/[/._-]+/)) {
      const normalized = segment.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalized.length > 1 && !BROAD_QUERY_STOPWORDS.has(normalized)) terms.push(normalized);
    }
  }
  return collectUniqueInOrder(terms);
}

function extractPathFragments(query: string): string[] {
  const tokens = query.match(/https?:\/\/[^\s"'`),;]+|(?:[A-Za-z]:)?[\\/][^\s"'`),;]+|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g) ?? [];
  return tokens
    .map(stripWrappingPunctuation)
    .filter((token) => {
      if (/^https?:\/\//i.test(token) || /^(?:[A-Za-z]:)?[\\/]/.test(token)) return true;
      const slashCount = (token.match(/[\\/]/g) ?? []).length;
      const finalSegment = token.split(/[\\/]/).at(-1) ?? "";
      return slashCount >= 2
        || /\.[A-Za-z0-9]{1,8}$/.test(finalSegment)
        || /^v\d+(?:[\\/]|$)/i.test(token);
    });
}

function stripWrappingPunctuation(value: string): string {
  return value.replace(/^["'`(]+/, "").replace(/["'`).,;:]+$/, "");
}

export function classifyLikelyTestCandidate(input: {
  filePath: string;
  localName: string;
  fqName: string;
}): LikelyTestCandidateSignals | undefined {
  const normalizedPath = input.filePath.replace(/\\/g, "/").toLowerCase();
  const pathSignal = hasLikelyTestPathSignal(normalizedPath);
  const symbolSignal = hasLikelyTestSymbolSignal(input.localName, input.fqName);

  if (!pathSignal && !symbolSignal) {
    return undefined;
  }

  return {
    pathSignal,
    symbolSignal,
  };
}

export function isLikelyTestCandidate(input: {
  filePath: string;
  localName: string;
  fqName: string;
}): boolean {
  return classifyLikelyTestCandidate(input) !== undefined;
}

export function queryBoundaryCandidates(
  db: Database,
  boundaryContext: BoundaryQueryContext | undefined,
  kind?: SymbolKind,
): SearchCandidateRow[] {
  if (boundaryContext === undefined) {
    return [];
  }

  const extensionConditions = boundaryContext.candidateExtensions
    .map(() => "files.path LIKE ?")
    .join(" OR ");

  if (extensionConditions.length === 0) {
    return [];
  }

  const sql = `
    SELECT
      symbols.id AS symbol_id,
      files.path AS file_path,
      symbols.fq_name,
      symbols.local_name,
      symbols.kind,
      symbols.signature,
      symbols.docstring
    FROM symbols
    INNER JOIN files ON files.id = symbols.file_id
    WHERE symbols.parent_symbol_id IS NULL
      AND ${EXCLUDE_STRUCTURAL_SYMBOLS_SQL}
      AND (${extensionConditions})
      ${kind === undefined ? "" : "AND symbols.kind = ?"}
    ORDER BY files.path ASC, symbols.fq_name ASC, symbols.id ASC
  `;
  const params = boundaryContext.candidateExtensions.map((extension) => `%${extension}`);

  if (kind === undefined) {
    return db.query(sql).all(...params) as SearchCandidateRow[];
  }

  return db.query(sql).all(...params, kind) as SearchCandidateRow[];
}

export function mergeSearchCandidates(
  primaryCandidates: readonly SearchCandidateRow[],
  supplementalCandidates: readonly SearchCandidateRow[],
): SearchCandidateRow[] {
  const merged = new Map<string, SearchCandidateRow>();

  for (const candidate of primaryCandidates) {
    merged.set(candidate.symbol_id, candidate);
  }

  for (const candidate of supplementalCandidates) {
    if (!merged.has(candidate.symbol_id)) {
      merged.set(candidate.symbol_id, candidate);
    }
  }

  return [...merged.values()];
}

function scoreCandidate(
  candidate: SearchCandidateRow,
  query: string,
  contexts: SearchRankingContexts,
): SymbolSearchResult | undefined {
  const matches: SymbolSearchMatch[] = [];
  addMatch(matches, candidate.local_name, query, LOCAL_NAME_MATCH);
  addMatch(matches, candidate.fq_name, query, FQ_NAME_MATCH);
  addMatch(matches, candidate.signature, query, SIGNATURE_MATCH);
  addMatch(matches, candidate.docstring ?? "", query, DOCSTRING_MATCH);
  addMatch(matches, candidate.file_path, query, FILE_PATH_MATCH);
  addBroadQueryMatches(matches, candidate, contexts.broadContext);
  addBoundaryHintMatch(matches, candidate, contexts.boundaryContext);
  addLikelyTestPenaltyMatch(matches, candidate, contexts.testContext);
  addTechnicalHintMatch(matches, candidate, contexts.technicalContext, contexts.testContext);
  addPathSignalMatch(matches, candidate, contexts.pathSignalContext);

  if (matches.length === 0) {
    return undefined;
  }

  return {
    symbolId: candidate.symbol_id,
    filePath: candidate.file_path,
    fqName: candidate.fq_name,
    localName: candidate.local_name,
    kind: parseSymbolKind(candidate.kind),
    score: matches.reduce((sum, match) => sum + match.scoreContribution, 0),
    matches,
  };
}

function addMatch(
  matches: SymbolSearchMatch[],
  value: string,
  query: string,
  weights: WeightedFieldMatch,
): void {
  const normalizedValue = value.toLowerCase();

  if (normalizedValue.length === 0 || !normalizedValue.includes(query)) {
    return;
  }

  if (normalizedValue === query) {
    matches.push(makeMatch(weights.field, SymbolSearchMatchType.Exact, weights.exact));
    return;
  }

  if (normalizedValue.startsWith(query)) {
    matches.push(makeMatch(weights.field, SymbolSearchMatchType.Prefix, weights.prefix));
    return;
  }

  matches.push(makeMatch(weights.field, SymbolSearchMatchType.Substring, weights.substring));
}

function addBoundaryHintMatch(
  matches: SymbolSearchMatch[],
  candidate: SearchCandidateRow,
  boundaryContext?: BoundaryQueryContext,
): void {
  const scoreContribution = scoreBoundaryHint(candidate, boundaryContext);

  if (scoreContribution <= 0) {
    return;
  }

  matches.push(makeMatch(
    SymbolSearchMatchField.BoundaryHint,
    SymbolSearchMatchType.Exact,
    scoreContribution,
  ));
}

function addBroadQueryMatches(
  matches: SymbolSearchMatch[],
  candidate: SearchCandidateRow,
  broadContext?: BroadQueryContext,
): void {
  if (broadContext === undefined) {
    return;
  }

  const fields = [
    { value: candidate.local_name.toLowerCase(), weights: BROAD_TERM_LOCAL_NAME_MATCH },
    { value: candidate.fq_name.toLowerCase(), weights: BROAD_TERM_FQ_NAME_MATCH },
    { value: candidate.signature.toLowerCase(), weights: BROAD_TERM_SIGNATURE_MATCH },
    { value: (candidate.docstring ?? "").toLowerCase(), weights: BROAD_TERM_DOCSTRING_MATCH },
    { value: candidate.file_path.toLowerCase(), weights: BROAD_TERM_FILE_PATH_MATCH },
  ];
  let matchedTermCount = 0;

  for (const group of broadContext.termGroups) {
    const bestMatch = findBestBroadTermMatch(fields, group);

    if (bestMatch === undefined) {
      continue;
    }

    matches.push(bestMatch);
    matchedTermCount += 1;
  }

  if (matchedTermCount < 2) {
    return;
  }

  matches.push(makeMatch(
    SymbolSearchMatchField.QueryCoverage,
    SymbolSearchMatchType.Exact,
    Math.min(
      matchedTermCount * SYMBOL_SEARCH_SCORE_WEIGHTS.broadCoveragePerTerm,
      SYMBOL_SEARCH_SCORE_WEIGHTS.broadCoverageMax,
    ),
  ));
}

function addLikelyTestPenaltyMatch(
  matches: SymbolSearchMatch[],
  candidate: SearchCandidateRow,
  testContext?: TestAwareQueryContext,
): void {
  if (testContext?.penalizeLikelyTests !== true) {
    return;
  }

  const signals = classifyLikelyTestCandidate({
    filePath: candidate.file_path,
    localName: candidate.local_name,
    fqName: candidate.fq_name,
  });

  if (signals === undefined) {
    return;
  }

  let penalty = 0;

  if (signals.pathSignal) {
    penalty += SYMBOL_SEARCH_SCORE_WEIGHTS.likelyTestPathPenalty;
  }

  if (signals.symbolSignal) {
    penalty += SYMBOL_SEARCH_SCORE_WEIGHTS.likelyTestSymbolPenalty;
  }

  penalty = Math.min(penalty, SYMBOL_SEARCH_SCORE_WEIGHTS.likelyTestPenaltyMax);

  if (penalty <= 0) {
    return;
  }

  matches.push(makeMatch(
    SymbolSearchMatchField.LikelyTestPenalty,
    SymbolSearchMatchType.Exact,
    -penalty,
  ));
}

function addPathSignalMatch(
  matches: SymbolSearchMatch[],
  candidate: SearchCandidateRow,
  pathSignalContext?: PathSignalQueryContext,
): void {
  if (pathSignalContext === undefined) {
    return;
  }

  const segments = new Set(extractPathSegments(candidate.file_path));

  if (segments.size === 0) {
    return;
  }

  let matchedTermCount = 0;

  for (const [, variants] of pathSignalContext.variantsByTerm) {
    if (variants.some((variant) => segments.has(variant))) {
      matchedTermCount += 1;
    }
  }

  if (matchedTermCount === 0) {
    return;
  }

  const extraTerms = matchedTermCount - 1;
  const siblingBonus = pathSignalContext.pathTerms.length >= 3
    ? SYMBOL_SEARCH_SCORE_WEIGHTS.pathSegmentSiblingBonus
    : 0;
  const score = Math.min(
    SYMBOL_SEARCH_SCORE_WEIGHTS.pathSegmentSignalBase
      + extraTerms * SYMBOL_SEARCH_SCORE_WEIGHTS.pathSegmentSignalPerExtraTerm
      + siblingBonus,
    SYMBOL_SEARCH_SCORE_WEIGHTS.pathSegmentSignalMax,
  );

  matches.push(makeMatch(
    SymbolSearchMatchField.PathSegmentSignal,
    SymbolSearchMatchType.Exact,
    score,
  ));
}

function addTechnicalHintMatch(
  matches: SymbolSearchMatch[],
  candidate: SearchCandidateRow,
  technicalContext?: TechnicalQueryContext,
  testContext?: TestAwareQueryContext,
): void {
  if (technicalContext === undefined) {
    return;
  }

  if (
    testContext?.penalizeLikelyTests === true
    && isLikelyTestCandidate({
      filePath: candidate.file_path,
      localName: candidate.local_name,
      fqName: candidate.fq_name,
    })
  ) {
    return;
  }

  const scoreContribution = scoreTechnicalHint(candidate, technicalContext);

  if (scoreContribution <= 0) {
    return;
  }

  matches.push(makeMatch(
    SymbolSearchMatchField.TechnicalHint,
    SymbolSearchMatchType.Exact,
    scoreContribution,
  ));
}

function scoreTechnicalHint(
  candidate: SearchCandidateRow,
  technicalContext: TechnicalQueryContext,
): number {
  const matchedDimensions = technicalContext.matchedDimensions
    .filter((dimension) => candidateMatchesTechnicalDimension(candidate, dimension));

  if (matchedDimensions.length === 0) {
    return 0;
  }

  let score = SYMBOL_SEARCH_SCORE_WEIGHTS.technicalHintBase;
  score += Math.min(
    (matchedDimensions.length - 1) * SYMBOL_SEARCH_SCORE_WEIGHTS.technicalHintPerDimension,
    SYMBOL_SEARCH_SCORE_WEIGHTS.technicalHintMax - SYMBOL_SEARCH_SCORE_WEIGHTS.technicalHintBase,
  );

  if (
    matchedDimensions.includes("lowlevel")
    && getCythonExtension(candidate.file_path) !== undefined
  ) {
    score += SYMBOL_SEARCH_SCORE_WEIGHTS.technicalLowLevelCythonBonus;
  }

  if (
    matchedDimensions.includes("serialization")
    && hasSerializationLocalSignal(candidate.local_name)
  ) {
    score += SYMBOL_SEARCH_SCORE_WEIGHTS.technicalSerializationBonus;
  }

  if (
    matchedDimensions.includes("entrypoint")
    && isLikelyEntrypointCandidate(candidate.file_path, candidate.local_name)
  ) {
    score += SYMBOL_SEARCH_SCORE_WEIGHTS.technicalEntrypointBonus;
  }

  return Math.min(score, SYMBOL_SEARCH_SCORE_WEIGHTS.technicalHintMax);
}

function findBestBroadTermMatch(
  fields: ReadonlyArray<{ value: string; weights: WeightedFieldMatch }>,
  group: QueryTermGroup,
): SymbolSearchMatch | undefined {
  let bestMatch: SymbolSearchMatch | undefined;

  for (const field of fields) {
    for (const variant of group.variants) {
      const match = describeMatch(field.value, variant, field.weights);

      if (
        match !== undefined
        && (bestMatch === undefined || match.scoreContribution > bestMatch.scoreContribution)
      ) {
        bestMatch = match;
      }
    }
  }

  return bestMatch;
}

function makeMatch(
  field: SymbolSearchMatchField,
  matchType: SymbolSearchMatchType,
  scoreContribution: number,
): SymbolSearchMatch {
  return {
    field,
    matchType,
    scoreContribution,
  };
}

function compareSearchResults(
  left: SymbolSearchResult,
  right: SymbolSearchResult,
): number {
  return (
    right.score - left.score
    || left.fqName.localeCompare(right.fqName)
    || left.symbolId.localeCompare(right.symbolId)
  );
}

function collectOrderedSearchTerms(value: string): string[] {
  const rawSegments = value.replace(/\\/g, "/").match(/[A-Za-z0-9]+/g) ?? [];
  const terms: string[] = [];

  for (const rawSegment of rawSegments) {
    const splitSegments = rawSegment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/)
      .filter((segment) => segment.length > 0);

    if (splitSegments.length === 0) {
      continue;
    }

    terms.push(...splitSegments);
  }

  return terms;
}

function collectSearchTerms(value: string): string[] {
  const rawSegments = value.replace(/\\/g, "/").match(/[A-Za-z0-9]+/g) ?? [];
  const terms = new Set<string>();

  for (const rawSegment of rawSegments) {
    const lowerRawSegment = rawSegment.toLowerCase();

    if (lowerRawSegment.length === 0) {
      continue;
    }

    terms.add(lowerRawSegment);

    const splitSegments = rawSegment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/)
      .filter((segment) => segment.length > 0);

    for (const segment of splitSegments) {
      terms.add(segment);
    }

    for (let start = 0; start < splitSegments.length; start += 1) {
      let combined = "";

      for (let end = start; end < splitSegments.length; end += 1) {
        combined += splitSegments[end] ?? "";

        if (end > start) {
          terms.add(combined);
        }
      }
    }
  }

  return [...terms].sort();
}

function buildBroadTermVariants(term: string): string[] {
  const variants = new Set<string>([term]);
  const explicitVariants = EXPLICIT_BROAD_TERM_VARIANTS.get(term);

  if (explicitVariants !== undefined) {
    for (const variant of explicitVariants) {
      variants.add(variant);
    }
  }

  if (term.endsWith("y") && term.length > 3) {
    variants.add(`${term.slice(0, -1)}ies`);
  } else if (!term.endsWith("s") && term.length > 3) {
    variants.add(`${term}s`);

    if (/(s|x|z|ch|sh)$/.test(term)) {
      variants.add(`${term}es`);
    }
  }

  if (term.endsWith("ies") && term.length > 4) {
    variants.add(`${term.slice(0, -3)}y`);
  }

  if (term.endsWith("ation") && term.length > 7) {
    variants.add(`${term.slice(0, -5)}ate`);
  }

  if (term.endsWith("es") && term.length > 4) {
    variants.add(term.slice(0, -2));
  }

  if (term.endsWith("s") && term.length > 3 && !term.endsWith("ss")) {
    variants.add(term.slice(0, -1));
  }

  if (term.endsWith("ing") && term.length > 5) {
    addVerbStemVariants(variants, term.slice(0, -3));
  }

  if (term.endsWith("ed") && term.length > 4) {
    addVerbStemVariants(variants, term.slice(0, -2));
  }

  return [...variants].filter((variant) => variant.length > 1).sort();
}

function addVerbStemVariants(variants: Set<string>, stem: string): void {
  if (stem.length <= 1) {
    return;
  }

  variants.add(stem);

  if (/(bb|dd|ff|gg|ll|mm|nn|pp|rr|ss|tt)$/.test(stem)) {
    variants.add(stem.slice(0, -1));
  }

  if (/(at|iz|ur|v)$/.test(stem)) {
    variants.add(`${stem}e`);
  }
}

function buildBroadPhraseGroups(orderedTerms: readonly string[]): QueryTermGroup[] {
  const groups: QueryTermGroup[] = [];

  for (let index = 0; index < orderedTerms.length - 1; index += 1) {
    const left = orderedTerms[index];
    const right = orderedTerms[index + 1];

    if (left === undefined || right === undefined) {
      continue;
    }

    const label = `${left} ${right}`;

    groups.push({
      label,
      variants: EXPLICIT_BROAD_PHRASE_VARIANTS.get(label) ?? [label],
    });
  }

  return groups;
}

function buildBroadAdmissionDisjuncts(
  termGroups: readonly QueryTermGroup[],
  phraseGroups: readonly QueryTermGroup[],
  boundCompoundTask: boolean,
): readonly (readonly QueryTermGroup[])[] {
  if (termGroups.length === 0) {
    return [];
  }

  if (termGroups.length <= 2) {
    return [termGroups];
  }

  if (!boundCompoundTask) {
    const legacyDisjuncts: QueryTermGroup[][] = phraseGroups.map((group) => [group]);
    for (let leftIndex = 0; leftIndex < termGroups.length - 1; leftIndex += 1) {
      const left = termGroups[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < termGroups.length; rightIndex += 1) {
        const right = termGroups[rightIndex];
        if (left !== undefined && right !== undefined) legacyDisjuncts.push([left, right]);
      }
    }
    return legacyDisjuncts;
  }

  // Long implementation tasks can contain dozens of concerns. The complete
  // pairwise expansion is quadratic (and can admit most of a large index), so
  // keep every bounded adjacent phrase and only then add deterministic cross-
  // concept pairs up to a fixed ceiling. Short queries retain their prior full
  // expansion exactly.
  const BROAD_ADMISSION_DISJUNCT_LIMIT = 96;
  const disjuncts: QueryTermGroup[][] = phraseGroups
    .slice(0, BROAD_ADMISSION_DISJUNCT_LIMIT)
    .map((group) => [group]);

  // FTS phrase positions do not always cross identifier punctuation (notably
  // `reproducibility_assessment`). Preserve each adjacent concept as an AND
  // pair before spending the remaining budget on non-adjacent combinations.
  const isCompoundTask = true;
  for (let index = 0; index < termGroups.length - 1; index += 1) {
    if (disjuncts.length >= BROAD_ADMISSION_DISJUNCT_LIMIT) {
      return disjuncts;
    }
    const left = termGroups[index]!;
    const right = termGroups[index + 1]!;
    if (!isCompoundTask || left.label.length + right.label.length >= 17) {
      disjuncts.push([left, right]);
    }
  }

  // Spend the remaining fixed budget on non-adjacent, high-information concept
  // pairs. This recovers files that connect distant concerns (for example
  // "reproducibility" + "projection") without restoring the complete O(n²)
  // expansion or admitting pairs of short generic terms.
  for (let leftIndex = 0; leftIndex < termGroups.length - 2; leftIndex += 1) {
    const left = termGroups[leftIndex]!;
    for (let rightIndex = leftIndex + 2; rightIndex < termGroups.length; rightIndex += 1) {
      const right = termGroups[rightIndex]!;
      const combinedLength = left.label.length + right.label.length;
      const bothHighInformation = left.label.length >= 8 && right.label.length >= 8;
      const boundedSkipOnePair = rightIndex === leftIndex + 2
        && combinedLength >= 12
        && Math.max(left.label.length, right.label.length) >= 8;
      if (!bothHighInformation && !boundedSkipOnePair) continue;
      disjuncts.push([left, right]);
      if (disjuncts.length >= BROAD_ADMISSION_DISJUNCT_LIMIT) return disjuncts;
    }
  }

  return disjuncts;
}

function shouldApplyBroadQueryBoosts(
  query: string,
  orderedTerms: readonly string[],
): boolean {
  if (/[_-]/.test(query)) {
    return true;
  }

  if (orderedTerms.length >= 3) {
    return true;
  }

  return orderedTerms.some(hasBroadMorphologyHint);
}

function hasBroadMorphologyHint(term: string): boolean {
  return term.endsWith("ies")
    || term.endsWith("ing")
    || term.endsWith("ed")
    || term.endsWith("ation")
    || (term.endsWith("es") && term.length > 4)
    || (term.endsWith("s") && term.length > 3 && !term.endsWith("ss"));
}

function renderTermGroupMatchExpression(group: QueryTermGroup): string {
  const variants = group.variants.map((variant) => `"${variant}"`);

  return variants.length === 1
    ? variants[0]!
    : `(${variants.join(" OR ")})`;
}

function scoreBoundaryHint(
  candidate: SearchCandidateRow,
  boundaryContext?: BoundaryQueryContext,
): number {
  if (boundaryContext === undefined) {
    return 0;
  }

  const extension = getCythonExtension(candidate.file_path);

  if (extension === undefined) {
    return 0;
  }

  const candidateTerms = candidateBoundaryTerms(extension);
  const matchedTerms = boundaryContext.matchedTerms.filter((term) => candidateTerms.has(term));

  if (matchedTerms.length === 0) {
    return 0;
  }

  let score = SYMBOL_SEARCH_SCORE_WEIGHTS.boundaryHintBase;
  score += Math.min(
    matchedTerms.length * SYMBOL_SEARCH_SCORE_WEIGHTS.boundaryHintPerMatchedTerm,
    SYMBOL_SEARCH_SCORE_WEIGHTS.boundaryHintMatchedTermMax,
  );

  if (boundaryContext.candidateExtensions.includes(extension)) {
    score += SYMBOL_SEARCH_SCORE_WEIGHTS.boundaryPreferredExtension;
  }

  if (isBoundaryPreferredKind(candidate.kind)) {
    score += SYMBOL_SEARCH_SCORE_WEIGHTS.boundaryTopLevelKind;
  }

  if (candidate.local_name.startsWith("_")) {
    score = Math.max(0, score - SYMBOL_SEARCH_SCORE_WEIGHTS.boundaryPrivatePenalty);
  }

  return score;
}

function candidateBoundaryTerms(extension: string): ReadonlySet<string> {
  switch (extension) {
    case ".pyx":
      return new Set([
        "compiled",
        "core",
        "cython",
        "extension",
        "fast",
        "helper",
        "kernel",
        "low",
        "parser",
        "performance",
        "utility",
      ]);
    case ".pxd":
      return new Set(["cimport", "core", "cython", "helper", "low", "utility"]);
    case ".pxi":
      return new Set(["core", "cython", "helper", "utility"]);
    default:
      return new Set();
  }
}

function getCythonExtension(filePath: string): string | undefined {
  const normalizedPath = filePath.toLowerCase();

  return ALL_CYTHON_EXTENSIONS.find((extension) => normalizedPath.endsWith(extension));
}

function isBoundaryPreferredKind(kind: string): boolean {
  return kind === "class" || kind === "function";
}

function describeMatch(
  normalizedValue: string,
  query: string,
  weights: WeightedFieldMatch,
): SymbolSearchMatch | undefined {
  if (normalizedValue.length === 0 || !normalizedValue.includes(query)) {
    return undefined;
  }

  if (normalizedValue === query) {
    return makeMatch(weights.field, SymbolSearchMatchType.Exact, weights.exact);
  }

  if (normalizedValue.startsWith(query)) {
    return makeMatch(weights.field, SymbolSearchMatchType.Prefix, weights.prefix);
  }

  return makeMatch(weights.field, SymbolSearchMatchType.Substring, weights.substring);
}

function hasLikelyTestPathSignal(normalizedPath: string): boolean {
  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const basename = segments.at(-1) ?? normalizedPath;
  const basenameWithoutExtension = basename.replace(/\.[^.]+$/, "");

  return segments.some((segment) => TEST_PATH_SEGMENTS.has(segment))
    || /^test[._-]/.test(basename)
    || /\.(test|spec)\.[^.]+$/.test(basename)
    || /(^|[._-])(test|tests|spec|specs)([._-]|$)/.test(basenameWithoutExtension);
}

function hasLikelyTestSymbolSignal(localName: string, fqName: string): boolean {
  const normalizedLocalName = localName.toLowerCase();
  const symbolPath = fqName.includes("::") ? fqName.split("::").slice(1).join("::") : fqName;

  return normalizedLocalName === "test"
    || normalizedLocalName.startsWith("test_")
    || /^Test[A-Z0-9_]/.test(localName)
    || /(^|::|\.)Test[A-Z0-9_]/.test(symbolPath)
    || /(^|::|\.)test_/.test(symbolPath);
}

function candidateMatchesTechnicalDimension(
  candidate: SearchCandidateRow,
  dimension: TechnicalQueryDimension,
): boolean {
  const candidateTerms = collectAnchoredTechnicalCandidateTerms(candidate);
  const normalizedPath = candidate.file_path.replace(/\\/g, "/").toLowerCase();
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;

  switch (dimension) {
    case "entrypoint":
      return basename === "main.py"
        || basename === "cli.py"
        || basename === "__main__.py"
        || candidateTerms.has("main")
        || candidateTerms.has("cli")
        || candidateTerms.has("run")
        || candidate.local_name.startsWith("run_")
        || candidate.local_name.startsWith("execute_")
        || candidate.local_name.startsWith("launch_")
        || candidate.local_name.startsWith("start_");
    case "io":
      return candidateTerms.has("input")
        || candidateTerms.has("output")
        || candidateTerms.has("read")
        || candidateTerms.has("write")
        || candidateTerms.has("load")
        || candidateTerms.has("dump")
        || candidateTerms.has("parse")
        || candidateTerms.has("parser")
        || candidateTerms.has("io")
        || candidateTerms.has("ess");
    case "lowlevel":
      return getCythonExtension(candidate.file_path) !== undefined
        || candidateTerms.has("compiled")
        || candidateTerms.has("extension")
        || candidateTerms.has("internal")
        || candidateTerms.has("core")
        || candidateTerms.has("lowlevel")
        || normalizedPath.includes("low-level");
    case "parser":
      return candidateTerms.has("parse")
        || candidateTerms.has("parser")
        || candidateTerms.has("parsing")
        || candidateTerms.has("adapter")
        || candidateTerms.has("ess")
        || normalizedPath.includes("/parser/");
    case "serialization":
      return candidateTerms.has("dict")
        || candidateTerms.has("dictionary")
        || candidateTerms.has("json")
        || candidateTerms.has("yaml")
        || candidateTerms.has("serialize")
        || candidateTerms.has("dump")
        || candidateTerms.has("load")
        || hasSerializationLocalSignal(candidate.local_name);
    case "utility":
      return candidateTerms.has("utility")
        || candidateTerms.has("utilities")
        || candidateTerms.has("util")
        || candidateTerms.has("utils")
        || candidateTerms.has("helper")
        || candidateTerms.has("helpers")
        || candidateTerms.has("common")
        || candidateTerms.has("core")
        || candidateTerms.has("internal")
        || normalizedPath.includes("/utils/")
        || normalizedPath.includes("/common.")
        || normalizedPath.includes("/helper");
  }
}

function collectAnchoredTechnicalCandidateTerms(candidate: SearchCandidateRow): ReadonlySet<string> {
  return new Set(collectSearchTerms([
    candidate.file_path,
    candidate.local_name,
    candidate.fq_name,
  ].join(" ")));
}

function hasSerializationLocalSignal(localName: string): boolean {
  const normalizedLocalName = localName.toLowerCase();

  return normalizedLocalName === "as_dict"
    || normalizedLocalName === "to_dict"
    || normalizedLocalName === "from_dict"
    || normalizedLocalName.includes("serialize")
    || normalizedLocalName.includes("dump")
    || normalizedLocalName.includes("load");
}

function isLikelyEntrypointCandidate(filePath: string, localName: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  const normalizedLocalName = localName.toLowerCase();

  return normalizedPath.endsWith("/main.py")
    || normalizedPath.endsWith("/cli.py")
    || normalizedPath.endsWith("/__main__.py")
    || normalizedLocalName === "main"
    || normalizedLocalName.startsWith("run_")
    || normalizedLocalName.startsWith("execute_")
    || normalizedLocalName.startsWith("launch_")
    || normalizedLocalName.startsWith("start_");
}

function collectUniqueInOrder<T>(values: readonly T[]): T[] {
  const uniqueValues: T[] = [];
  const seen = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
