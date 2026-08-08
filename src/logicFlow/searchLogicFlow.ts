import type { Database } from "bun:sqlite";

import {
  EDGE_ADJACENCY_CHUNK_SIZE,
  countEdges,
  hasResolvableEdgeOfType,
  listCallSitesForEdges,
  listIncomingEdgesForSymbols,
  listOutgoingEdgesForSymbols,
} from "../db/repositories/edgesRepository";
import { getSymbolsByIds, listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import {
  createTraversalBudget,
  traverseFrontier,
  type FrontierExpansion,
  type FrontierTraversalCounters,
  type TraversalBudget,
} from "../graph/frontierTraversal";
import {
  EdgeType,
  Language,
  type EdgeRecord,
  type SymbolKind,
  type SymbolRecord,
} from "../domain/types";
import { detectLanguage } from "../fs/languageDetection";
import {
  SOURCE_EXCERPT_DEFAULTS,
  buildSymbolSourceExcerpt,
  type SourceExcerpt,
} from "../source/sourceExcerpt";
import {
  buildStaticRelationEvidence,
  compareEvidenceStrength,
  minimumEvidenceStrength,
  type StaticEvidenceStrength,
  type StaticRelationEvidence,
  type StaticRelationKind,
} from "../impact/staticEvidence";

export interface SearchLogicFlowInput {
  readonly start: string;
  readonly end: string;
  readonly maxPaths: number;
  readonly maxDepth?: number;
  readonly maxEdges?: number;
  readonly maxTokens?: number;
  readonly relations?: readonly StaticRelationKind[];
  readonly includeLexical?: boolean;
}

/**
 * Optional knobs that let the product/MCP layer enrich the structural result
 * with bounded inline source excerpts. The default (no `repoRoot`) path is
 * byte-identical to the pure structural result, so engine tests and determinism
 * are unaffected.
 */
export interface SearchLogicFlowOptions {
  readonly repoRoot?: string;
  readonly includeSourceExcerpts?: boolean;
  readonly maxExcerptsPerPath?: number;
  /** Opt-in wall-clock detail; default false preserves deterministic engine payloads. */
  readonly measureTiming?: boolean;
}

export const LOGIC_FLOW_ERROR_CODE = Object.freeze({
  UnknownStart: "unknown_start",
  UnknownEnd: "unknown_end",
  AmbiguousStart: "ambiguous_start",
  AmbiguousEnd: "ambiguous_end",
});

export type LogicFlowErrorCode =
  (typeof LOGIC_FLOW_ERROR_CODE)[keyof typeof LOGIC_FLOW_ERROR_CODE];

export interface LogicFlowSymbolSummary {
  readonly symbolId: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly localName: string;
  readonly kind: SymbolKind;
}

export interface LogicFlowStep {
  readonly edgeId: string;
  readonly edgeType: EdgeType;
  readonly fromSymbolId: string;
  readonly fromFqName: string;
  readonly toSymbolId: string;
  readonly toFqName: string;
  /**
   * Bounded excerpt around the edge source (the `from` symbol, where the
   * call/import/reference originates). Present only when the product layer
   * requested excerpts and source loaded freshly; null when source was
   * unavailable or the per-path excerpt budget was exhausted. Absent entirely
   * on the pure structural (no-repoRoot) path.
   */
  readonly sourceExcerpt?: SourceExcerpt | null;
  /** M120 typed, source-grounded interpretation of the persisted edge. */
  readonly relation?: StaticRelationEvidence;
}

export interface LogicFlowPath {
  readonly pathIndex: number;
  readonly edgeCount: number;
  readonly nodeCount: number;
  readonly nodes: readonly LogicFlowSymbolSummary[];
  readonly steps: readonly LogicFlowStep[];
  readonly minimumStrength?: StaticEvidenceStrength;
  readonly crossFileTransitions?: number;
  readonly limitations?: readonly string[];
}

export interface LogicFlowCoverage {
  readonly analysisKind: "structural";
  readonly resolutionMode: "exact_fqn";
  readonly direction: "forward";
  readonly crossRepo: false;
  readonly supportedEdgeTypes: readonly EdgeType[];
  readonly observedEdgeTypes: readonly EdgeType[];
  /**
   * Whether any statically resolved `calls` edge existed in the indexed graph
   * for the queried repo. When false, no call-flow evidence was available and
   * any returned path rests purely on structural containment/import edges.
   */
  readonly callFlowEvidenceAvailable: boolean;
  /** Whether at least one `calls` edge appears in the returned paths. */
  readonly callFlowEvidenceUsed: boolean;
  readonly notes: readonly string[];
}

export interface LogicFlowSummary {
  readonly reachable: boolean;
  readonly pathCount: number;
  readonly maxPaths: number;
  readonly shortestPathEdgeCount: number | null;
  readonly truncated: boolean;
  /**
   * True when the bounded traversal stopped expanding before the reachable set
   * was exhausted. An unreachable result carrying this flag is "not found within
   * the traversal budget", never "provably not connected" — callers must not
   * render it as a negative connectivity claim.
   */
  readonly traversalLimitReached: boolean;
}

export interface LogicFlowOutput {
  readonly requested: {
    readonly start: string;
    readonly end: string;
    readonly maxPaths: number;
    readonly crossRepo: false;
  };
  readonly resolvedStart: LogicFlowSymbolSummary;
  readonly resolvedEnd: LogicFlowSymbolSummary;
  readonly coverage: LogicFlowCoverage;
  readonly summary: LogicFlowSummary;
  readonly paths: readonly LogicFlowPath[];
  readonly limits: {
    readonly maxDepth: number;
    readonly maxPaths: number;
    readonly maxEdges: number;
    readonly maxTokens: number;
  };
  readonly timing: {
    readonly targetResolutionMs: number;
    readonly pathTraversalMs: number;
    readonly renderMs: number;
    readonly totalFlowMs: number;
  };
  readonly diagnostics: {
    readonly staticEvidenceOnly: true;
    readonly nodesVisited: number;
    /** Edges the index holds, counted rather than loaded. */
    readonly edgesAvailable: number;
    /** Edges actually relaxed by the bounded traversal. */
    readonly edgesInspected: number;
    readonly pathsConsidered: number;
    readonly pathsReturned: number;
    readonly omittedPaths: number;
    readonly omittedEdges: number;
    readonly traversalLimitReached: boolean;
    readonly traversal: LogicFlowTraversalDiagnostics;
    readonly limitations: readonly string[];
  };
}

/**
 * How much of the graph the answer actually cost. Every field is structural and
 * deterministic — no wall-clock values — so identical queries produce identical
 * diagnostics and semantic hashes stay stable.
 */
export interface LogicFlowTraversalDiagnostics {
  readonly mode: "indexed_frontier_expansion";
  /** Forward-only for an unreachable result; forward + reverse when a path exists. */
  readonly traversals: number;
  readonly nodesExpanded: number;
  /** Adjacency rows the batched queries returned. */
  readonly edgesFetched: number;
  readonly edgesRelaxed: number;
  readonly frontierBatches: number;
  readonly maxFrontierSize: number;
  readonly visitedNodes: number;
  /** Indexed queries issued, including batched symbol hydration. */
  readonly dbQueries: number;
  readonly budgetLimit: number;
  readonly budgetExhausted: boolean;
}

export interface LogicFlowError {
  readonly code: LogicFlowErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type LogicFlowResult =
  | {
    readonly ok: true;
    readonly output: LogicFlowOutput;
  }
  | {
    readonly ok: false;
    readonly error: LogicFlowError;
  };

const SUPPORTED_EDGE_TYPES = Object.freeze([
  EdgeType.Contains,
  EdgeType.Imports,
  EdgeType.Calls,
]);

/**
 * Edge-relaxation budget for the bounded breadth-first search. This bounds work,
 * not graph membership: before M130 the same number pre-sliced the repository
 * edge list, so any repo above the bound lost real edges and answered
 * "not connected" for relationships it had indexed correctly.
 */
export const DEFAULT_TRAVERSAL_EDGE_BUDGET = 20_000;
export const MAX_TRAVERSAL_EDGE_BUDGET = 200_000;

export function searchLogicFlow(
  db: Database,
  input: SearchLogicFlowInput,
  options?: SearchLogicFlowOptions,
): LogicFlowResult {
  const timingEnabled = options?.measureTiming === true;
  const totalStarted = timingEnabled ? performance.now() : 0;
  const targetStarted = totalStarted;
  const resolvedStart = resolveExactSymbol(db, input.start, "start");

  // `x.ok === false` rather than `!x.ok`: the explicit comparison is what narrows
  // a readonly discriminated union to its error member on return.
  if (resolvedStart.ok === false) {
    return { ok: false, error: resolvedStart.error };
  }

  const resolvedEnd = resolveExactSymbol(db, input.end, "end");

  if (resolvedEnd.ok === false) {
    return { ok: false, error: resolvedEnd.error };
  }

  const targetResolutionMs = flowElapsed(targetStarted, timingEnabled);
  const maxDepth = Math.min(12, Math.max(0, input.maxDepth ?? 8));
  const maxPaths = Math.min(16, Math.max(1, input.maxPaths));
  const maxEdges = Math.min(MAX_TRAVERSAL_EDGE_BUDGET, Math.max(1, input.maxEdges ?? DEFAULT_TRAVERSAL_EDGE_BUDGET));
  const maxTokens = Math.min(20_000, Math.max(1, input.maxTokens ?? 20_000));
  const traversalStarted = timingEnabled ? performance.now() : 0;

  // Nothing repository-wide is materialised. The graph is reached through
  // batched indexed adjacency queries driven by the frontier, so a one-edge
  // answer costs one level of expansion regardless of how large the repository
  // graph is (M131).
  const access = createFlowGraphAccess(db, input, options);
  access.hydrate([resolvedStart.symbol, resolvedEnd.symbol]);
  const budget = createTraversalBudget(maxEdges);
  const callFlowEvidenceAvailable = flowCallEvidenceAvailable(db, input);
  // Size of the searchable graph, counted rather than loaded. Reported so a
  // bounded search stays legible: `edgesInspected` against `edgesAvailable` says
  // how much of the graph the answer rests on.
  const edgesAvailable = countEdges(db);

  const forwardTraversal = traverseFrontier<EdgeRecord>({
    startSymbolId: resolvedStart.symbol.id,
    targetSymbolId: resolvedEnd.symbol.id,
    maxDepth,
    budget,
    expandFrontier: access.expandOutgoing,
    edgeOrigin: (edge) => edge.srcSymbolId,
    edgeTarget: (edge) => edge.dstSymbolId,
    compareEdges: access.compareOutgoingEdges,
    compareNodes: access.compareNodes,
  });
  const distanceFromStart = forwardTraversal.distances;
  const shortestPathEdgeCount = distanceFromStart.get(resolvedEnd.symbol.id) ?? null;

  let returnedPaths: LogicFlowPath[] = [];
  let truncated = false;
  let traversalLimitReached = forwardTraversal.counters.budgetExhausted;
  let traversalCounters: FrontierTraversalCounters[] = [forwardTraversal.counters];

  if (shortestPathEdgeCount !== null) {
    const reverseTraversal = traverseFrontier<EdgeRecord>({
      startSymbolId: resolvedEnd.symbol.id,
      targetSymbolId: resolvedStart.symbol.id,
      maxDepth,
      budget,
      expandFrontier: access.expandIncoming,
      edgeOrigin: (edge) => edge.dstSymbolId,
      edgeTarget: (edge) => edge.srcSymbolId,
      compareEdges: access.compareIncomingEdges,
      compareNodes: access.compareNodes,
    });
    const distanceToEnd = reverseTraversal.distances;
    traversalLimitReached = traversalLimitReached || reverseTraversal.counters.budgetExhausted;
    traversalCounters = [forwardTraversal.counters, reverseTraversal.counters];
    const enumeratedStepPaths = enumerateShortestStepPaths(
      resolvedStart.symbol.id,
      resolvedEnd.symbol.id,
      maxPaths + 1,
      shortestPathEdgeCount,
      distanceFromStart,
      distanceToEnd,
      forwardTraversal.adjacency,
      access,
    );

    truncated = enumeratedStepPaths.length > maxPaths;
    returnedPaths = enumeratedStepPaths
      .slice(0, maxPaths)
      .map((steps, index) => toLogicFlowPath(index + 1, resolvedStart.symbol, steps, access, db, options))
      .sort(compareLogicFlowPaths);
  }

  if (options?.repoRoot !== undefined && options.includeSourceExcerpts !== false) {
    returnedPaths = attachFlowSourceExcerpts(
      db,
      options.repoRoot,
      returnedPaths,
      options.maxExcerptsPerPath ?? SOURCE_EXCERPT_DEFAULTS.maxFlowExcerptsPerPath,
    );
  }

  const tokenBoundedPaths: LogicFlowPath[] = [];
  let tokenEstimate = 0;
  for (const path of returnedPaths) {
    const cost = Math.ceil(JSON.stringify(path).length / 4);
    if (tokenEstimate + cost > maxTokens) { truncated = true; break; }
    tokenBoundedPaths.push(path);
    tokenEstimate += cost;
  }
  const pathsConsidered = returnedPaths.length;
  returnedPaths = tokenBoundedPaths;
  const pathTraversalMs = flowElapsed(traversalStarted, timingEnabled);

  const observedEdgeTypes = collectObservedEdgeTypes(returnedPaths);
  const callFlowEvidenceUsed = observedEdgeTypes.includes(EdgeType.Calls);
  const crossLanguageEvidenceUsed = hasCrossLanguagePythonCythonStep(returnedPaths);

  return {
    ok: true,
    output: {
      requested: {
        start: resolvedStart.symbol.fqName,
        end: resolvedEnd.symbol.fqName,
        maxPaths,
        crossRepo: false,
      },
      resolvedStart: toLogicFlowSymbolSummary(resolvedStart.symbol),
      resolvedEnd: toLogicFlowSymbolSummary(resolvedEnd.symbol),
      coverage: {
        analysisKind: "structural",
        resolutionMode: "exact_fqn",
        direction: "forward",
        crossRepo: false,
        supportedEdgeTypes: SUPPORTED_EDGE_TYPES,
        observedEdgeTypes,
        callFlowEvidenceAvailable,
        callFlowEvidenceUsed,
        notes: buildCoverageNotes(
          resolvedStart.symbol,
          resolvedEnd.symbol,
          returnedPaths,
          truncated,
          callFlowEvidenceAvailable,
          callFlowEvidenceUsed,
          crossLanguageEvidenceUsed,
          traversalLimitReached,
        ),
      },
      summary: {
        reachable: returnedPaths.length > 0,
        pathCount: returnedPaths.length,
        maxPaths: input.maxPaths,
        shortestPathEdgeCount,
        truncated,
        traversalLimitReached,
      },
      paths: returnedPaths,
      limits: { maxDepth, maxPaths, maxEdges, maxTokens },
      timing: {
        targetResolutionMs,
        pathTraversalMs,
        renderMs: 0,
        totalFlowMs: flowElapsed(totalStarted, timingEnabled),
      },
      diagnostics: {
        staticEvidenceOnly: true,
        nodesVisited: distanceFromStart.size,
        edgesAvailable,
        edgesInspected: budget.spent,
        pathsConsidered,
        pathsReturned: returnedPaths.length,
        omittedPaths: Math.max(0, pathsConsidered - returnedPaths.length),
        omittedEdges: traversalLimitReached ? Math.max(0, edgesAvailable - budget.spent) : 0,
        traversalLimitReached,
        traversal: summarizeTraversalCounters(traversalCounters, access.dbQueryCount()),
        limitations: [
          "Static repository evidence only; returned paths are not runtime execution traces.",
          "Dynamic dispatch, reflection, monkey patching, and dependency injection are not resolved.",
          "Exact edge-site lines are available only when the parser persisted a call-site span for the edge; otherwise provenance is the indexed source-symbol span.",
          "A result with no path means no path was found in the current index within the traversal budget; it is not proof the endpoints are unconnected.",
        ],
      },
    },
  };
}

/**
 * Whether any statically resolved `calls` edge exists for this query at all.
 *
 * Answered with one `LIMIT 1` existence probe instead of scanning the graph: a
 * persisted `calls` edge whose endpoints both resolve always classifies as the
 * `calls` relation at exact/resolved/conservative strength, so the only thing
 * that can exclude it is the caller's own `relations` filter.
 */
function flowCallEvidenceAvailable(db: Database, input: SearchLogicFlowInput): boolean {
  if (input.relations !== undefined && !input.relations.includes("calls")) {
    return false;
  }
  return hasResolvableEdgeOfType(db, EdgeType.Calls);
}

/**
 * Indexed, memoized access to the parts of the graph a query actually touches.
 *
 * Symbol records are hydrated in batches as edges surface them and cached for
 * the lifetime of the query, so a symbol reached from several directions is
 * fetched once. Nothing here reads the whole `symbols` or `edges` table.
 */
interface FlowGraphAccess {
  readonly hydrate: (symbols: readonly SymbolRecord[]) => void;
  readonly symbol: (symbolId: string) => SymbolRecord | undefined;
  readonly requireSymbol: (symbolId: string) => SymbolRecord;
  readonly expandOutgoing: (symbolIds: readonly string[]) => FrontierExpansion<EdgeRecord>;
  readonly expandIncoming: (symbolIds: readonly string[]) => FrontierExpansion<EdgeRecord>;
  readonly compareOutgoingEdges: (left: EdgeRecord, right: EdgeRecord) => number;
  readonly compareIncomingEdges: (left: EdgeRecord, right: EdgeRecord) => number;
  readonly compareNodes: (left: string, right: string) => number;
  readonly dbQueryCount: () => number;
}

function createFlowGraphAccess(
  db: Database,
  input: SearchLogicFlowInput,
  options: SearchLogicFlowOptions | undefined,
): FlowGraphAccess {
  const symbolsById = new Map<string, SymbolRecord>();
  const allowed = input.relations === undefined ? null : new Set(input.relations);
  let dbQueries = 0;

  const hydrate = (symbols: readonly SymbolRecord[]): void => {
    for (const symbol of symbols) {
      symbolsById.set(symbol.id, symbol);
    }
  };

  const hydrateMissing = (symbolIds: readonly string[]): number => {
    const missing = [...new Set(symbolIds.filter((symbolId) => !symbolsById.has(symbolId)))];

    if (missing.length === 0) {
      return 0;
    }

    let queries = 0;
    for (let index = 0; index < missing.length; index += SYMBOL_HYDRATION_CHUNK_SIZE) {
      const chunk = missing.slice(index, index + SYMBOL_HYDRATION_CHUNK_SIZE);
      queries += 1;
      hydrate([...getSymbolsByIds(db, chunk).values()]);
    }
    return queries;
  };

  /**
   * The M130 edge predicate, unchanged in meaning: an edge participates when it
   * is a supported structural type, both endpoints resolve, its relation kind is
   * allowed, and it is not lexical-only. Applying it per fetched batch instead
   * of over the whole table is the entire difference.
   */
  const participates = (edge: EdgeRecord): boolean => {
    if (!SUPPORTED_EDGE_TYPES.includes(edge.edgeType)) {
      return false;
    }

    const source = symbolsById.get(edge.srcSymbolId);
    const target = symbolsById.get(edge.dstSymbolId);

    if (source === undefined || target === undefined) {
      return false;
    }

    const relation = buildStaticRelationEvidence(db, edge, source, target, {
      direction: "outgoing",
      repoRoot: options?.repoRoot,
      includeSourceEvidence: false,
    });

    if (allowed !== null && !allowed.has(relation.kind)) {
      return false;
    }

    return input.includeLexical === true || relation.strength !== "lexical";
  };

  const expand = (
    symbolIds: readonly string[],
    fetch: (db: Database, ids: readonly string[]) => EdgeRecord[],
  ): FrontierExpansion<EdgeRecord> => {
    const started = dbQueries;
    // One batched adjacency query per chunk of the frontier, then one batched
    // symbol hydration for the endpoints it surfaced. Two query shapes per
    // level, never one query per node.
    dbQueries += Math.max(1, Math.ceil(new Set(symbolIds).size / EDGE_ADJACENCY_CHUNK_SIZE));
    const fetched = fetch(db, symbolIds);
    dbQueries += hydrateMissing(fetched.flatMap((edge) => [edge.srcSymbolId, edge.dstSymbolId]));

    return {
      edges: fetched.filter(participates),
      fetched: fetched.length,
      dbQueries: dbQueries - started,
    };
  };

  const requireSymbol = (symbolId: string): SymbolRecord => {
    const symbol = symbolsById.get(symbolId);

    if (symbol === undefined) {
      throw new Error(`Flow traversal reached unhydrated symbol ${symbolId}`);
    }

    return symbol;
  };

  return {
    hydrate,
    symbol: (symbolId) => symbolsById.get(symbolId),
    requireSymbol,
    expandOutgoing: (symbolIds) => expand(symbolIds, listOutgoingEdgesForSymbols),
    expandIncoming: (symbolIds) => expand(symbolIds, listIncomingEdgesForSymbols),
    compareOutgoingEdges: (left, right) => compareOutgoingEdges(left, right, symbolsById),
    compareIncomingEdges: (left, right) => compareIncomingEdges(left, right, symbolsById),
    compareNodes: (left, right) => {
      const leftSymbol = symbolsById.get(left);
      const rightSymbol = symbolsById.get(right);

      if (leftSymbol === undefined || rightSymbol === undefined) {
        return left.localeCompare(right);
      }

      return compareSymbolRecords(leftSymbol, rightSymbol);
    },
    dbQueryCount: () => dbQueries,
  };
}

/** Batch size for hydrating symbol records surfaced by frontier expansion. */
const SYMBOL_HYDRATION_CHUNK_SIZE = 500;

/**
 * Fold the per-traversal counters into the one diagnostics block the product
 * surfaces. Purely structural: no wall-clock value enters here, so the flow
 * result stays byte-stable across repeated identical queries.
 */
function summarizeTraversalCounters(
  counters: readonly FrontierTraversalCounters[],
  dbQueries: number,
): LogicFlowTraversalDiagnostics {
  const sum = (pick: (item: FrontierTraversalCounters) => number): number =>
    counters.reduce((total, item) => total + pick(item), 0);

  return {
    mode: "indexed_frontier_expansion",
    traversals: counters.length,
    nodesExpanded: sum((item) => item.nodesExpanded),
    edgesFetched: sum((item) => item.edgesFetched),
    edgesRelaxed: sum((item) => item.edgesRelaxed),
    frontierBatches: sum((item) => item.frontierBatches),
    maxFrontierSize: counters.reduce((largest, item) => Math.max(largest, item.maxFrontierSize), 0),
    visitedNodes: sum((item) => item.visitedNodes),
    dbQueries,
    budgetLimit: counters[0]?.budgetLimit ?? 0,
    budgetExhausted: counters.some((item) => item.budgetExhausted),
  };
}

function resolveExactSymbol(
  db: Database,
  fqName: string,
  field: "start" | "end",
): {
  readonly ok: true;
  readonly symbol: SymbolRecord;
} | {
  readonly ok: false;
  readonly error: LogicFlowError;
} {
  const matches = listSymbolsByFqName(db, fqName);

  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: field === "start"
          ? LOGIC_FLOW_ERROR_CODE.UnknownStart
          : LOGIC_FLOW_ERROR_CODE.UnknownEnd,
        message: `Unknown indexed ${field} symbol FQN: ${fqName}`,
        details: {
          field,
          symbolFqn: fqName,
          resolutionMode: "exact_fqn",
        },
      },
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: field === "start"
          ? LOGIC_FLOW_ERROR_CODE.AmbiguousStart
          : LOGIC_FLOW_ERROR_CODE.AmbiguousEnd,
        message: `Exact indexed ${field} symbol FQN is ambiguous: ${fqName}`,
        details: {
          field,
          symbolFqn: fqName,
          resolutionMode: "exact_fqn",
          matchingSymbolIds: matches.map((symbol) => symbol.id),
        },
      },
    };
  }

  return {
    ok: true,
    symbol: matches[0]!,
  };
}

function enumerateShortestStepPaths(
  startSymbolId: string,
  endSymbolId: string,
  maxPaths: number,
  shortestPathEdgeCount: number,
  distanceFromStart: ReadonlyMap<string, number>,
  distanceToEnd: ReadonlyMap<string, number>,
  outgoingBySymbolId: ReadonlyMap<string, readonly EdgeRecord[]>,
  access: FlowGraphAccess,
): EdgeRecord[][] {
  if (shortestPathEdgeCount === 0) {
    return [[]];
  }

  const paths: EdgeRecord[][] = [];
  const activeSteps: EdgeRecord[] = [];

  const visit = (currentSymbolId: string): void => {
    if (paths.length >= maxPaths) {
      return;
    }

    if (currentSymbolId === endSymbolId) {
      paths.push([...activeSteps]);
      return;
    }

    const nextEdges = (outgoingBySymbolId.get(currentSymbolId) ?? [])
      .filter((edge) => isShortestPathEdge(
        edge,
        shortestPathEdgeCount,
        distanceFromStart,
        distanceToEnd,
      ))
      .sort(access.compareOutgoingEdges);

    for (const edge of nextEdges) {
      activeSteps.push(edge);
      visit(edge.dstSymbolId);
      activeSteps.pop();

      if (paths.length >= maxPaths) {
        return;
      }
    }
  };

  visit(startSymbolId);
  return paths;
}

function isShortestPathEdge(
  edge: EdgeRecord,
  shortestPathEdgeCount: number,
  distanceFromStart: ReadonlyMap<string, number>,
  distanceToEnd: ReadonlyMap<string, number>,
): boolean {
  const startDistance = distanceFromStart.get(edge.srcSymbolId);
  const nextDistance = distanceFromStart.get(edge.dstSymbolId);
  const remainingDistance = distanceToEnd.get(edge.dstSymbolId);

  if (
    startDistance === undefined
    || nextDistance === undefined
    || remainingDistance === undefined
  ) {
    return false;
  }

  return startDistance + 1 === nextDistance
    && startDistance + 1 + remainingDistance === shortestPathEdgeCount;
}

function toLogicFlowPath(
  pathIndex: number,
  startSymbol: SymbolRecord,
  steps: readonly EdgeRecord[],
  access: FlowGraphAccess,
  db: Database,
  options: SearchLogicFlowOptions | undefined,
): LogicFlowPath {
  const nodes = [toLogicFlowSymbolSummary(startSymbol)];

  for (const step of steps) {
    nodes.push(toLogicFlowSymbolSummary(access.requireSymbol(step.dstSymbolId)));
  }

  // Occurrence rows are fetched only for the handful of edges that made it onto
  // a returned path — never during traversal, where they would be dead weight.
  const callSitesByEdgeId = listCallSitesForEdges(db, steps.map((step) => step.id));
  const relations = steps.map((step) => buildStaticRelationEvidence(
    db,
    step,
    access.requireSymbol(step.srcSymbolId),
    access.requireSymbol(step.dstSymbolId),
    {
      direction: "outgoing",
      repoRoot: options?.repoRoot,
      includeSourceEvidence: true,
      callSites: callSitesByEdgeId.get(step.id) ?? [],
    },
  ));
  const crossFileTransitions = relations.filter((relation) => relation.source.path !== relation.target.path).length;
  return {
    pathIndex,
    edgeCount: steps.length,
    nodeCount: nodes.length,
    nodes,
    steps: steps.map((step, index) => ({
      edgeId: step.id,
      edgeType: step.edgeType,
      fromSymbolId: step.srcSymbolId,
      fromFqName: access.requireSymbol(step.srcSymbolId).fqName,
      toSymbolId: step.dstSymbolId,
      toFqName: access.requireSymbol(step.dstSymbolId).fqName,
      relation: relations[index],
    })),
    minimumStrength: minimumEvidenceStrength(relations.map((relation) => relation.strength)),
    crossFileTransitions,
    limitations: ["Bounded static structural path; it does not prove runtime execution."],
  };
}

function compareLogicFlowPaths(left: LogicFlowPath, right: LogicFlowPath): number {
  return compareEvidenceStrength(left.minimumStrength ?? "unresolved", right.minimumStrength ?? "unresolved")
    || left.edgeCount - right.edgeCount
    || (left.crossFileTransitions ?? 0) - (right.crossFileTransitions ?? 0)
    || left.nodes.map((node) => `${node.filePath}::${node.fqName}`).join("\0")
      .localeCompare(right.nodes.map((node) => `${node.filePath}::${node.fqName}`).join("\0"))
    || left.steps.map((step) => flowEdgeRank(step.edgeType)).join("")
      .localeCompare(right.steps.map((step) => flowEdgeRank(step.edgeType)).join(""))
    || left.steps.map((step) => step.edgeId).join("\0").localeCompare(right.steps.map((step) => step.edgeId).join("\0"));
}

function flowEdgeRank(edgeType: EdgeType): number {
  switch (edgeType) {
    case EdgeType.Calls: return 0;
    case EdgeType.Imports: return 1;
    case EdgeType.Contains: return 2;
    case EdgeType.References: return 3;
  }
}

function flowElapsed(start: number, enabled: boolean): number {
  return enabled ? Math.max(0, performance.now() - start) : 0;
}

/**
 * Attach a bounded excerpt of the edge source (the `from` symbol) to the first
 * `maxExcerptsPerPath` steps of each path. Excerpts are memoized per symbol so a
 * symbol shared across paths is loaded once. Steps beyond the budget, or whose
 * source could not be loaded freshly, get an explicit null marker.
 */
function attachFlowSourceExcerpts(
  db: Database,
  repoRoot: string,
  paths: readonly LogicFlowPath[],
  maxExcerptsPerPath: number,
): LogicFlowPath[] {
  const excerptCache = new Map<string, SourceExcerpt | null>();

  // Keyed by (edge source, anchor) because the same caller yields a different
  // anchored window per outgoing edge.
  const excerptFor = (symbolId: string, anchor: FlowExcerptAnchor): SourceExcerpt | null => {
    const cacheKey = `${symbolId}\u0000${anchor.anchorLine ?? ""}\u0000${anchor.anchorName ?? ""}`;
    const cached = excerptCache.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const excerpt = buildSymbolSourceExcerpt(db, repoRoot, symbolId, {
      mode: "span",
      ...(anchor.anchorLine === undefined ? {} : { anchorLine: anchor.anchorLine }),
      ...(anchor.anchorName === undefined ? {} : { anchorName: anchor.anchorName }),
    });
    excerptCache.set(cacheKey, excerpt);
    return excerpt;
  };

  return paths.map((path) => ({
    ...path,
    steps: path.steps.map((step, index) => ({
      ...step,
      sourceExcerpt: index < maxExcerptsPerPath
        ? excerptFor(step.fromSymbolId, flowStepAnchor(step))
        : null,
    })),
  }));
}

interface FlowExcerptAnchor {
  readonly anchorLine?: number;
  readonly anchorName?: string;
}

/**
 * Where to centre the excerpt for a step. An edge whose parser-recorded call site
 * survived validation anchors on that exact line; anything else falls back to the
 * resolved callee name, which yields an honestly-labelled `call_site_scan` window.
 */
function flowStepAnchor(step: LogicFlowStep): FlowExcerptAnchor {
  const relation = step.relation;

  if (relation !== undefined && relation.evidence.locationKind === "edge_site") {
    const anchorLine = relation.source.lineSpan?.start;

    if (typeof anchorLine === "number") {
      return { anchorLine };
    }
  }

  const referenceName = relation?.evidence.referenceName;
  return typeof referenceName === "string" && referenceName.length > 0
    ? { anchorName: referenceName }
    : {};
}

function hasCrossLanguagePythonCythonStep(
  paths: readonly LogicFlowPath[],
): boolean {
  for (const path of paths) {
    for (let index = 0; index + 1 < path.nodes.length; index += 1) {
      const fromLanguage = detectLanguage(path.nodes[index].filePath);
      const toLanguage = detectLanguage(path.nodes[index + 1].filePath);

      if (
        (fromLanguage === Language.Python && toLanguage === Language.Cython)
        || (fromLanguage === Language.Cython && toLanguage === Language.Python)
      ) {
        return true;
      }
    }
  }

  return false;
}

function buildCoverageNotes(
  startSymbol: SymbolRecord,
  endSymbol: SymbolRecord,
  paths: readonly LogicFlowPath[],
  truncated: boolean,
  callFlowEvidenceAvailable: boolean,
  callFlowEvidenceUsed: boolean,
  crossLanguageEvidenceUsed: boolean,
  traversalLimitReached: boolean,
): string[] {
  const notes = [
    "Directed structural path search built from indexed contains, imports, and statically resolved calls edges.",
    "Exact FQN resolution is required; no fuzzy symbol matching is applied.",
    "Calls edges are static, conservative call-target resolution (Python, TypeScript, and Cython in this milestone); ambiguous or dynamic-dispatch targets are skipped rather than guessed.",
    "This does not represent runtime execution flow, semantic reachability, or dataflow; even paths that traverse calls edges are static evidence, not proof a call executes.",
    "This first version only returns shortest structural paths; longer alternative paths are not enumerated once the minimum distance is found.",
  ];

  if (!callFlowEvidenceAvailable) {
    notes.push(
      "No statically resolved calls edges were available for the indexed repo (e.g. a JavaScript-only repo, or a language/file set with no extracted call edges); this result is structural containment/import traversal only and does not trace call flow.",
    );
  } else if (callFlowEvidenceUsed) {
    notes.push(
      "At least one returned path traverses a statically resolved calls edge, so the path reflects static call-flow evidence (not runtime execution truth).",
    );
  } else {
    notes.push(
      "Calls edges existed in the indexed graph but none lay on a returned shortest path; the returned paths rest on contains/imports edges only.",
    );
  }

  if (crossLanguageEvidenceUsed) {
    notes.push(
      "At least one returned path crosses a Python<->Cython boundary through an exact import/reference, so the path reflects cross-language structural evidence.",
    );
  }

  if (startSymbol.id === endSymbol.id) {
    notes.push("Start and end resolve to the same indexed symbol; the zero-edge path is returned.");
  }

  if (paths.length === 0) {
    notes.push(
      `No indexed structural path was found from ${startSymbol.fqName} to ${endSymbol.fqName} in the current index.`,
    );
    notes.push(
      "Static analysis cannot prove two endpoints are unconnected; this states only that the current index contains no such path, and dynamic or unindexed relationships remain possible.",
    );
  }

  if (traversalLimitReached) {
    notes.push(
      "The bounded traversal stopped before the reachable set was exhausted; raise max_edges or narrow the endpoints before treating any negative result as complete.",
    );
  }

  if (truncated) {
    notes.push("More shortest structural paths exist than were returned; output was truncated deterministically by maxPaths.");
  }

  return notes;
}

function collectObservedEdgeTypes(paths: readonly LogicFlowPath[]): EdgeType[] {
  return [...new Set(
    paths.flatMap((path) => path.steps.map((step) => step.edgeType)),
  )].sort((left, right) => left.localeCompare(right)) as EdgeType[];
}

function toLogicFlowSymbolSummary(symbol: SymbolRecord): LogicFlowSymbolSummary {
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
  };
}

function compareOutgoingEdges(
  left: EdgeRecord,
  right: EdgeRecord,
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): number {
  return compareSymbolRecords(
    symbolsById.get(left.dstSymbolId)!,
    symbolsById.get(right.dstSymbolId)!,
  )
    || left.edgeType.localeCompare(right.edgeType)
    || left.id.localeCompare(right.id);
}

function compareIncomingEdges(
  left: EdgeRecord,
  right: EdgeRecord,
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): number {
  return compareSymbolRecords(
    symbolsById.get(left.srcSymbolId)!,
    symbolsById.get(right.srcSymbolId)!,
  )
    || left.edgeType.localeCompare(right.edgeType)
    || left.id.localeCompare(right.id);
}

function compareSymbolRecords(left: SymbolRecord, right: SymbolRecord): number {
  return left.filePath.localeCompare(right.filePath)
    || left.fqName.localeCompare(right.fqName)
    || left.kind.localeCompare(right.kind)
    || left.startByte - right.startByte
    || left.endByte - right.endByte
    || left.id.localeCompare(right.id);
}
