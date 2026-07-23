import type { Database } from "bun:sqlite";

import { listSymbolsByFqName, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { extractFullSymbolSource, ExtractSymbolSourceStatus } from "../capsule/extractSymbolContent";
import { loadSymbolSource } from "../capsule/loadSymbolSource";
import {
  CapsuleBudgetModel,
  CapsuleContentMode,
  CapsuleFileRepresentationMode,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type Capsule,
  type CapsuleItemContent,
  type PivotCapsuleItem,
  type SupportCapsuleItem,
} from "../capsule/types";
import { RunPipelinePresetIntent, type RunPipelineConcretePreset } from "../runPipeline/types";
import { SymbolKind } from "../domain/types";
import { routeQuery, type RoutedQueryResult } from "../intent/routeQuery";
import { buildCapsule } from "./buildCapsule";
import { estimateTokens, roundPercent } from "./tokens";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  NO_DEBUG_ROLE_SIGNALS,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";

export const PRODUCT_RETRIEVAL_AUTHORITY = "product-retrieval-v2" as const;
export const PRODUCT_RETRIEVAL_RANKING_VERSION = "hybrid-shared-core+routed-rescue-v1" as const;
export const PRODUCT_RETRIEVAL_CHARS_PER_TOKEN = 4;

export interface AuthoritativeProductRetrieval {
  readonly version: typeof PRODUCT_RETRIEVAL_AUTHORITY;
  readonly rankingVersion: typeof PRODUCT_RETRIEVAL_RANKING_VERSION;
  readonly result: CapsuleV2Result;
  readonly capsule: Capsule;
  readonly routedQuery: RoutedQueryResult | null;
  readonly timing: {
    readonly authoritativeMs: number;
    readonly routedRescueMs: number;
  };
}

/**
 * One authoritative retrieval/role/packing seam for the product tools.
 *
 * The capsule builder owns the proven hybrid candidate union, score attribution, role
 * refinement, and compressed-cost packing. The adapter only projects that exact
 * selection into the historical Capsule response shape; it never re-ranks or
 * independently selects candidates.
 */
export function buildAuthoritativeProductRetrieval(
  db: Database,
  repoRoot: string,
  input: {
    query: string;
    preset: RunPipelineConcretePreset;
    maxBudgetCharacters: number;
    capsuleIntent?: CapsuleIntent;
    /** Offline profiler seam; result diagnostics remain deterministic by default. */
    includeTimingDiagnostics?: boolean;
  },
): AuthoritativeProductRetrieval {
  const started = performance.now();
  const maxTokens = Math.max(1, Math.floor(input.maxBudgetCharacters / PRODUCT_RETRIEVAL_CHARS_PER_TOKEN));
  const baseResult = buildCapsule({
    db,
    repoRoot,
    task: input.query,
    intent: input.capsuleIntent ?? capsuleIntentForPreset(input.preset),
    maxTokens,
    includeTimingDiagnostics: input.includeTimingDiagnostics,
  });
  const rescued = applyLazyRoutedRescue(
    db,
    repoRoot,
    input.query,
    baseResult,
    input.includeTimingDiagnostics === true,
  );
  const result = rescued.result;
  return {
    version: PRODUCT_RETRIEVAL_AUTHORITY,
    rankingVersion: PRODUCT_RETRIEVAL_RANKING_VERSION,
    result,
    capsule: projectAuthoritativeCapsule(db, input.query, input.maxBudgetCharacters, result),
    routedQuery: rescued.routedQuery,
    timing: {
      authoritativeMs: performance.now() - started,
      routedRescueMs: rescued.routedRescueMs,
    },
  };
}

const COMPOUND_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "across", "whether", "already",
  "have", "has", "add", "trace", "determine", "appropriate", "stable", "exact",
]);
const ARTIFACT_TERMS = new Set([
  "model", "models", "schema", "schemas", "migration", "migrations",
  "projection", "projections", "openapi", "test", "tests", "docs",
  "client", "clients", "types",
]);
const MAX_ROUTED_RESCUE_RESULTS = 100;
const MAX_ROUTED_RESCUE_ADDITIONS = 2;

function applyLazyRoutedRescue(
  db: Database,
  repoRoot: string,
  task: string,
  result: CapsuleV2Result,
  includeTimingDiagnostics: boolean,
): {
  result: CapsuleV2Result;
  routedQuery: RoutedQueryResult | null;
  routedRescueMs: number;
} {
  const decision = decideRoutedRescue(task, result);
  if (decision.trigger === undefined) {
    return {
      routedQuery: null,
      routedRescueMs: 0,
      result: {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          routed_rescue: {
            attempted: false,
            reason: "authoritative_context_sufficient",
            missing_clues: [],
            candidates_added: 0,
            selected_candidates_added: 0,
            timing_ms: 0,
          },
        },
      },
    };
  }

  const started = performance.now();
  const routed = routeQuery(db, task, {
    maxResults: MAX_ROUTED_RESCUE_RESULTS,
    includeTimingDiagnostics: true,
  });
  const selectedPaths = new Set([...result.pivots, ...result.support].map((item) => item.path));
  const additions: CapsuleV2Item[] = [];
  const usedSymbols = new Set<string>();
  for (const clue of decision.missingClues) {
    if (additions.length >= MAX_ROUTED_RESCUE_ADDITIONS) break;
    const terms = clue.toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = routed.rerankedResults.filter((row) => {
      if (selectedPaths.has(row.filePath) || usedSymbols.has(row.symbolId)) return false;
      const haystack = `${row.filePath} ${row.localName} ${row.fqName}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    const candidate = candidates.sort((left, right) =>
      clueCandidateSpecificity(right, terms) - clueCandidateSpecificity(left, terms)
      || right.finalScore - left.finalScore
      || left.fqName.localeCompare(right.fqName)
    )[0];
    if (candidate === undefined) continue;
    const item = routedSupportItem(db, repoRoot, candidate, clue, result.budget.max_tokens);
    if (item === undefined) continue;
    if (result.budget.estimated_tokens + additions.reduce((sum, entry) => sum + entry.estimated_tokens, 0) + item.estimated_tokens > result.budget.max_tokens) {
      continue;
    }
    additions.push(item);
    selectedPaths.add(candidate.filePath);
    usedSymbols.add(candidate.symbolId);
  }
  const timingMs = performance.now() - started;
  const estimatedTokens = result.budget.estimated_tokens + additions.reduce((sum, item) => sum + item.estimated_tokens, 0);
  return {
    routedQuery: routed,
    routedRescueMs: timingMs,
    result: {
      ...result,
      budget: {
        ...result.budget,
        estimated_tokens: estimatedTokens,
        used_percent: result.budget.max_tokens > 0
          ? roundPercent((estimatedTokens / result.budget.max_tokens) * 100)
          : 0,
      },
      support: [...result.support, ...additions],
      diagnostics: {
        ...result.diagnostics,
        support_count: result.support.length + additions.length,
        routed_rescue: {
          attempted: true,
          trigger: decision.trigger,
          missing_clues: decision.missingClues,
          candidates_added: additions.length,
          selected_candidates_added: additions.length,
          timing_ms: includeTimingDiagnostics ? timingMs : 0,
        },
      },
    },
  };
}

function decideRoutedRescue(
  task: string,
  result: CapsuleV2Result,
): {
  trigger?: "no_candidates" | "missing_exact_identifier" | "missing_path" | "low_compound_coverage";
  missingClues: string[];
} {
  if (result.pivots.length === 0) {
    return { trigger: "no_candidates", missingClues: [] };
  }
  const selected = [...result.pivots, ...result.support];
  const selectedText = selected.map((item) => `${item.path} ${item.symbol} ${item.fq_name}`).join(" ").toLowerCase();
  const paths = [...task.matchAll(/(?:^|\s)([\w./-]+\.[A-Za-z0-9]+)(?=\s|$|[,;:])/g)].map((match) => match[1]!);
  const missingPath = paths.find((candidate) => !selected.some((item) => item.path === candidate || item.path.endsWith(`/${candidate}`)));
  if (missingPath !== undefined) {
    return { trigger: "missing_path", missingClues: [missingPath.replace(/[._/-]+/g, " ")] };
  }
  const identifiers = [...new Set([
    ...task.matchAll(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g),
    ...task.matchAll(/\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g),
  ].map((match) => match[0]))];
  const missingIdentifier = identifiers.find((identifier) => !selectedText.includes(identifier.toLowerCase()));
  const words = task.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [];
  if (words.length < 28) {
    return missingIdentifier === undefined
      ? { missingClues: [] }
      : { trigger: "missing_exact_identifier", missingClues: [missingIdentifier.toLowerCase()] };
  }
  const clauses: string[] = [];
  for (let index = 0; index + 1 < words.length; index += 1) {
    const left = words[index]!;
    const right = words[index + 1]!;
    if (COMPOUND_STOPWORDS.has(left) || COMPOUND_STOPWORDS.has(right)) continue;
    if (!ARTIFACT_TERMS.has(left) && !ARTIFACT_TERMS.has(right)) continue;
    const clue = `${left} ${right}`;
    if (!clauses.includes(clue)) clauses.push(clue);
  }
  if (clauses.length < 4) return { missingClues: [] };
  const missingClues = clauses.filter((clue) => {
    const terms = clue.split(" ");
    return !selected.some((item) => {
      const text = `${item.path} ${item.symbol} ${item.fq_name}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  });
  if (missingClues.length >= 2) {
    return { trigger: "low_compound_coverage", missingClues };
  }
  return missingIdentifier === undefined
    ? { missingClues: [] }
    : { trigger: "missing_exact_identifier", missingClues: [missingIdentifier.toLowerCase()] };
}

function clueCandidateSpecificity(
  candidate: ReturnType<typeof routeQuery>["rerankedResults"][number],
  terms: readonly string[],
): number {
  const path = `/${candidate.filePath.toLowerCase()}/`;
  let score = 0;
  for (const term of terms) {
    const singular = term.endsWith("s") ? term.slice(0, -1) : term;
    if (path.includes(`/${term}/`) || path.includes(`/${singular}s/`)) score += 4;
    if (candidate.localName.toLowerCase().includes(singular)) score += 2;
  }
  if (candidate.kind === SymbolKind.Class || candidate.kind === SymbolKind.Function || candidate.kind === SymbolKind.Method) {
    score += 1;
  }
  return score;
}

function routedSupportItem(
  db: Database,
  repoRoot: string,
  candidate: ReturnType<typeof routeQuery>["rerankedResults"][number],
  clue: string,
  maxTokens: number,
): CapsuleV2Item | undefined {
  const loaded = loadSymbolSource(db, repoRoot, candidate.symbolId);
  const extracted = extractFullSymbolSource(loaded);
  const source = extracted.status === ExtractSymbolSourceStatus.Extracted ? extracted.source : undefined;
  const signature = loaded.symbol?.signature;
  if (source === undefined && !signature) return undefined;
  const fullTokens = source === undefined ? Number.POSITIVE_INFINITY : estimateTokens(source);
  const useFull = fullTokens <= Math.max(320, Math.floor(maxTokens * 0.15));
  const text = useFull ? source! : signature!;
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    role: "support",
    role_reason: `routed rescue covers unmatched compound clue \`${clue}\``,
    path: candidate.filePath,
    fq_name: candidate.fqName,
    symbol: candidate.localName,
    kind: candidate.kind,
    content_mode: useFull ? CapsuleV2ContentMode.Full : CapsuleV2ContentMode.Signature,
    ...(useFull ? { source: text, ...(signature ? { signature } : {}) } : { signature: text }),
    evidence: [
      `bounded routed FTS rank covers unmatched clue \`${clue}\``,
      `routed rank score ${candidate.finalScore}`,
    ],
    scorecard: {
      lexical: candidate.lexicalScore,
      symbol: 0,
      path: 0,
      test_to_impl: 0,
      body_literal: 0,
      graph_proximity: candidate.graphScore,
      centrality: 0,
      actionability: 1,
      hub_penalty: 0,
      final: candidate.finalScore,
    },
    estimated_tokens: estimateTokens(text),
  };
}

export function capsuleIntentForPreset(preset: RunPipelineConcretePreset): CapsuleIntent {
  switch (preset) {
    case RunPipelinePresetIntent.Debug:
      return CapsuleIntent.Debug;
    case RunPipelinePresetIntent.Modify:
      return CapsuleIntent.Modify;
    case RunPipelinePresetIntent.Refactor:
      return CapsuleIntent.Refactor;
    case RunPipelinePresetIntent.Explore:
      return CapsuleIntent.Explain;
  }
}

function projectAuthoritativeCapsule(
  db: Database,
  query: string,
  maxCharacters: number,
  result: CapsuleV2Result,
): Capsule {
  const pivots = result.pivots.flatMap((item) => {
    const projected = projectItem(db, item, CapsuleItemRole.Pivot);
    return projected === undefined ? [] : [projected];
  });
  const supportingItems = result.support.flatMap((item) => {
    const projected = projectItem(db, item, CapsuleItemRole.Support);
    return projected === undefined ? [] : [projected];
  });
  const usedCharacters = Math.min(
    maxCharacters,
    query.length + [...pivots, ...supportingItems].reduce((sum, item) => sum + item.budgetCost, 0),
  );
  return {
    query,
    pivots,
    supportingItems,
    budget: {
      model: CapsuleBudgetModel.CharacterCount,
      maxCharacters,
      usedCharacters,
      remainingCharacters: Math.max(0, maxCharacters - usedCharacters),
    },
    truncated: result.discarded.length > 0,
    compressed: [...pivots, ...supportingItems].some((item) => item.compressed),
  };
}

function projectItem(
  db: Database,
  item: CapsuleV2Item,
  role: CapsuleItemRole.Pivot,
): PivotCapsuleItem | undefined;
function projectItem(
  db: Database,
  item: CapsuleV2Item,
  role: CapsuleItemRole.Support,
): SupportCapsuleItem | undefined;
function projectItem(
  db: Database,
  item: CapsuleV2Item,
  role: CapsuleItemRole,
): PivotCapsuleItem | SupportCapsuleItem | undefined {
  const symbol = listSymbolsByFqName(db, item.fq_name).find((entry) => entry.filePath === item.path)
    ?? listSymbolsForFile(db, item.path).find((entry) => entry.localName === item.symbol);
  const content = projectContent(item);
  const budgetCost = Math.max(1, item.estimated_tokens * PRODUCT_RETRIEVAL_CHARS_PER_TOKEN);
  return {
    role,
    symbolId: symbol?.id ?? `product-v2:${item.path}::${item.symbol}`,
    filePath: item.path,
    fqName: item.fq_name,
    localName: item.symbol,
    // Documentation sections have no symbol row; the historical capsule shape
    // has no file-only item, so use its least-actionable module-level kind.
    kind: symbol?.kind ?? SymbolKind.ModuleAlias,
    inclusionReasons: [{
      kind: CapsuleInclusionReasonKind.QueryCoverage,
      note: item.role_reason,
    }],
    content,
    budgetCost,
    compressed: content.mode !== CapsuleContentMode.Full,
    sourceBacked: typeof item.source === "string",
    lexicalScore: item.scorecard.lexical,
    graphScore: item.scorecard.graph_proximity,
    finalScore: item.scorecard.final,
  };
}

function projectContent(item: CapsuleV2Item): CapsuleItemContent {
  if (item.content_mode === CapsuleV2ContentMode.Full && typeof item.source === "string") {
    return { mode: CapsuleContentMode.Full, source: item.source };
  }
  if (typeof item.signature === "string" && item.signature.length > 0) {
    return { mode: CapsuleContentMode.SignatureOnly, signature: item.signature };
  }
  return { mode: CapsuleContentMode.Stub, stub: item.symbol };
}
