import type { Database } from "bun:sqlite";

import { listCallSitesForEdges, listEdgesForSymbol, listEdgesForSymbols } from "../db/repositories/edgesRepository";
import { getSymbolById, getSymbolsByIds, listSymbolsByFqName } from "../db/repositories/symbolsRepository";
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
  classifyEntrypoint,
  compareEvidenceStrength,
  findDocumentationEvidence,
  findImportSyntaxEvidence,
  isTestSymbol,
  minimumEvidenceStrength,
  type StaticEvidenceStrength,
  type StaticRelationEvidence,
  type StaticRelationKind,
} from "./staticEvidence";

export const IMPACT_FORMATS = ["list", "tree", "mermaid"] as const;

export type ImpactFormat = (typeof IMPACT_FORMATS)[number];

export interface GetImpactGraphInput {
  readonly symbolFqn: string;
  readonly depth: number;
  readonly format: ImpactFormat;
  /** Additive M120 controls. Legacy nodes/edges remain the reverse-impact view. */
  readonly direction?: "upstream" | "downstream" | "both";
  readonly relations?: readonly StaticRelationKind[];
  readonly maxPaths?: number;
  readonly maxEdges?: number;
  readonly maxTokens?: number;
  readonly includeLexical?: boolean;
  readonly includeUnresolved?: boolean;
  readonly includeEvidence?: boolean;
}

/**
 * Optional knobs that let the product/MCP layer enrich dependents with bounded
 * inline source excerpts. The default (no `repoRoot`) path is byte-identical to
 * the pure structural result, so engine tests and determinism are unaffected.
 */
export interface GetImpactGraphOptions {
  readonly repoRoot?: string;
  readonly includeSourceExcerpts?: boolean;
  readonly maxExcerpts?: number;
  /** Opt-in wall-clock detail; default false preserves deterministic engine payloads. */
  readonly measureTiming?: boolean;
}

export const IMPACT_GRAPH_ERROR_CODE = Object.freeze({
  UnknownSymbol: "unknown_symbol",
  AmbiguousSymbol: "ambiguous_symbol",
});

export type ImpactGraphErrorCode =
  (typeof IMPACT_GRAPH_ERROR_CODE)[keyof typeof IMPACT_GRAPH_ERROR_CODE];

export interface ImpactSymbolSummary {
  readonly symbolId: string;
  readonly filePath: string;
  readonly fqName: string;
  readonly localName: string;
  readonly kind: SymbolKind;
}

export interface ImpactNode extends ImpactSymbolSummary {
  readonly distance: number;
  /**
   * Bounded signature-focused excerpt of the dependent symbol, showing why it
   * depends on the focal symbol (the caller/referrer source). Present only when
   * the product layer requested excerpts and source loaded freshly; null when
   * source was unavailable or the response-wide excerpt budget was exhausted.
   * Absent entirely on the pure structural (no-repoRoot) path, and never set on
   * the focal root node (distance 0).
   */
  readonly sourceExcerpt?: SourceExcerpt | null;
}

export interface ImpactEdge {
  readonly edgeId: string;
  readonly edgeType: EdgeType;
  readonly fromSymbolId: string;
  readonly fromFqName: string;
  readonly toSymbolId: string;
  readonly toFqName: string;
}

export interface ImpactCoverage {
  readonly analysisKind: "structural";
  readonly resolutionMode: "exact_fqn";
  readonly crossRepo: false;
  readonly supportedEdgeTypes: readonly EdgeType[];
  readonly observedEdgeTypes: readonly EdgeType[];
  readonly notes: readonly string[];
}

export interface ImpactSummary {
  readonly dependentSymbolCount: number;
  readonly dependentFileCount: number;
  readonly maxDepth: number;
  readonly maxObservedDistance: number;
}

export interface ImpactView {
  readonly format: ImpactFormat;
  readonly lines: readonly string[];
}

export interface ImpactGraphOutput {
  readonly requested: {
    readonly symbolFqn: string;
    readonly depth: number;
    readonly crossRepo: false;
    readonly format: ImpactFormat;
  };
  readonly resolvedSymbol: ImpactSymbolSummary;
  readonly coverage: ImpactCoverage;
  readonly summary: ImpactSummary;
  readonly dependentFiles: readonly string[];
  readonly nodes: readonly ImpactNode[];
  readonly edges: readonly ImpactEdge[];
  readonly view: ImpactView;
  /** M120 additive evidence model; canonical legacy fields above remain compatible. */
  readonly directRelations: readonly StaticRelationEvidence[];
  readonly paths: readonly StaticImpactPath[];
  readonly affectedFiles: readonly AffectedFileSummary[];
  readonly entrypoints: readonly ImpactClassifiedSymbol[];
  readonly tests: readonly ImpactClassifiedSymbol[];
  readonly richSummary: RichImpactSummary;
  readonly limits: ImpactLimits;
  readonly timing: ImpactTiming;
  readonly diagnostics: ImpactDiagnostics;
}

export interface StaticImpactPath {
  readonly id: string;
  readonly direction: "entrypoint_to_target" | "caller_to_target" | "target_to_dependent" | "target_to_callee" | "import_to_definition" | "test_to_target" | "inheritance_chain";
  readonly nodes: readonly ImpactSymbolSummary[];
  readonly edges: readonly StaticRelationEvidence[];
  readonly length: number;
  readonly minimumStrength: StaticEvidenceStrength;
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface AffectedFileSummary {
  readonly path: string;
  readonly direct: boolean;
  readonly minimumDistance: number;
  readonly relationKinds: readonly StaticRelationKind[];
  readonly strongestEvidence: StaticEvidenceStrength;
  readonly reviewGuidance: "high_confidence" | "uncertain";
}

export interface ImpactClassifiedSymbol extends ImpactSymbolSummary {
  readonly entrypointKind: "exported_api" | "test";
  readonly strength: StaticEvidenceStrength;
  readonly evidence: string;
  readonly limitations: readonly string[];
}

export interface RichImpactSummary {
  readonly directIncoming: number;
  readonly directOutgoing: number;
  readonly transitiveIncoming: number;
  readonly transitiveOutgoing: number;
  readonly affectedFiles: number;
  readonly affectedSymbols: number;
  readonly countsByRelation: Readonly<Record<string, number>>;
  readonly countsByStrength: Readonly<Record<string, number>>;
  readonly truncated: boolean;
  readonly omittedPaths: number;
  readonly omittedEdges: number;
}

export interface ImpactLimits {
  readonly maxDepth: number;
  readonly maxPaths: number;
  readonly maxEdges: number;
  readonly maxTokens: number;
}

export interface ImpactTiming {
  readonly targetResolutionMs: number;
  readonly directNeighborQueryMs: number;
  readonly pathTraversalMs: number;
  readonly renderMs: number;
  readonly totalImpactMs: number;
}

export interface ImpactDiagnostics {
  readonly staticEvidenceOnly: true;
  readonly nodesVisited: number;
  readonly edgesInspected: number;
  readonly pathsConsidered: number;
  readonly pathsReturned: number;
  /** Canonical model-facing graph accounting (distinct from traversal work). */
  readonly canonicalEdgesRetained: number;
  readonly canonicalNodesRetained: number;
  readonly canonicalEdgesOmitted: number;
  readonly deliveryTruncated: boolean;
  readonly traversalLimitReached: boolean;
  readonly limitations: readonly string[];
}

export interface ImpactGraphError {
  readonly code: ImpactGraphErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type ImpactGraphResult =
  | {
    readonly ok: true;
    readonly output: ImpactGraphOutput;
  }
  | {
    readonly ok: false;
    readonly error: ImpactGraphError;
  };

const SUPPORTED_EDGE_TYPES = Object.freeze([
  EdgeType.Contains,
  EdgeType.Imports,
  EdgeType.Calls,
  EdgeType.References,
]);

export function getImpactGraph(
  db: Database,
  input: GetImpactGraphInput,
  options?: GetImpactGraphOptions,
): ImpactGraphResult {
  const timingEnabled = options?.measureTiming === true;
  const totalStarted = timingEnabled ? performance.now() : 0;
  const targetStarted = totalStarted;
  const matches = listSymbolsByFqName(db, input.symbolFqn);

  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: IMPACT_GRAPH_ERROR_CODE.UnknownSymbol,
        message: `Unknown indexed symbol FQN: ${input.symbolFqn}`,
        details: {
          symbolFqn: input.symbolFqn,
          resolutionMode: "exact_fqn",
        },
      },
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: IMPACT_GRAPH_ERROR_CODE.AmbiguousSymbol,
        message: `Exact indexed symbol FQN is ambiguous: ${input.symbolFqn}`,
        details: {
          symbolFqn: input.symbolFqn,
          resolutionMode: "exact_fqn",
          matchingSymbolIds: matches.map((symbol) => symbol.id),
        },
      },
    };
  }

  const resolvedSymbol = matches[0]!;
  const targetResolutionMs = measuredElapsed(targetStarted, timingEnabled);
  const maxEdges = Math.min(MAX_INSPECTED_EDGES, Math.max(1, input.maxEdges ?? DEFAULT_MAX_EDGES));
  const discovery = discoverImpactSymbols(db, resolvedSymbol, input.depth, maxEdges);
  const { distanceById, symbolsById } = discovery;
  const discoveredEdges = buildImpactEdges(db, distanceById, symbolsById);
  const edges = discoveredEdges.slice(0, maxEdges);
  const canonicalNodeIds = new Set<string>([resolvedSymbol.id]);
  for (const edge of edges) {
    canonicalNodeIds.add(edge.fromSymbolId);
    canonicalNodeIds.add(edge.toSymbolId);
  }
  const canonicalDistances = new Map(
    [...distanceById].filter(([symbolId]) => canonicalNodeIds.has(symbolId)),
  );
  const canonicalSymbols = new Map(
    [...symbolsById].filter(([symbolId]) => canonicalNodeIds.has(symbolId)),
  );
  const baseNodes = buildImpactNodes(canonicalDistances, canonicalSymbols);
  const nodes = options?.repoRoot !== undefined && options.includeSourceExcerpts !== false
    ? attachImpactSourceExcerpts(
      db,
      options.repoRoot,
      baseNodes,
      options.maxExcerpts ?? SOURCE_EXCERPT_DEFAULTS.maxImpactExcerpts,
    )
    : baseNodes;
  const primaryParentEdges = buildPrimaryParentEdges(edges, canonicalSymbols);
  const dependentFiles = collectDependentFiles(nodes);
  const observedEdgeTypes = collectObservedEdgeTypes(edges);
  const memberEvidencePresent = hasMemberResolutionEvidence(edges, symbolsById);
  const inheritedEvidencePresent = hasInheritedMemberEvidence(edges, symbolsById);
  const crossLanguageEvidencePresent = hasCrossLanguagePythonCythonEvidence(edges, nodes);
  const notes = buildCoverageNotes(
    edges,
    nodes,
    input.depth,
    memberEvidencePresent,
    inheritedEvidencePresent,
    crossLanguageEvidencePresent,
  );
  const rich = buildRichImpact(db, resolvedSymbol, input, options, targetResolutionMs, totalStarted);
  const canonicalEdgesOmitted = discovery.omittedDependents
    + Math.max(0, discoveredEdges.length - edges.length);

  return {
    ok: true,
    output: {
      requested: {
        symbolFqn: resolvedSymbol.fqName,
        depth: input.depth,
        crossRepo: false,
        format: input.format,
      },
      resolvedSymbol: toImpactSymbolSummary(resolvedSymbol),
      coverage: {
        analysisKind: "structural",
        resolutionMode: "exact_fqn",
        crossRepo: false,
        supportedEdgeTypes: SUPPORTED_EDGE_TYPES,
        observedEdgeTypes,
        notes,
      },
      summary: {
        dependentSymbolCount: Math.max(nodes.length - 1, 0),
        dependentFileCount: dependentFiles.length,
        maxDepth: input.depth,
        maxObservedDistance: nodes.at(-1)?.distance ?? 0,
      },
      dependentFiles,
      nodes,
      edges,
      view: {
        format: input.format,
        lines: buildImpactViewLines(
          input.format,
          nodes,
          edges,
          primaryParentEdges,
        ),
      },
      ...rich,
      richSummary: {
        ...rich.richSummary,
        truncated: rich.richSummary.truncated || canonicalEdgesOmitted > 0,
        omittedEdges: rich.richSummary.omittedEdges + canonicalEdgesOmitted,
      },
      diagnostics: {
        ...rich.diagnostics,
        canonicalEdgesRetained: edges.length,
        canonicalNodesRetained: nodes.length,
        canonicalEdgesOmitted,
        deliveryTruncated: canonicalEdgesOmitted > 0,
        traversalLimitReached: discovery.limitReached,
      },
    },
  };
}

const DEFAULT_MAX_PATHS = 3;
const DEFAULT_MAX_EDGES = 64;
const DEFAULT_MAX_TOKENS = 1_200;
const MAX_INSPECTED_EDGES = 2_000;
const HARD_MAX_DEPTH = 8;
const HARD_MAX_PATHS = 16;
const HARD_MAX_TOKENS = 20_000;

function buildRichImpact(
  db: Database,
  root: SymbolRecord,
  input: GetImpactGraphInput,
  options: GetImpactGraphOptions | undefined,
  targetResolutionMs: number,
  totalStarted: number,
): Pick<ImpactGraphOutput, "directRelations" | "paths" | "affectedFiles" | "entrypoints" | "tests" | "richSummary" | "limits" | "timing" | "diagnostics"> {
  const direction = input.direction ?? "both";
  const maxDepth = Math.min(HARD_MAX_DEPTH, Math.max(0, input.depth));
  const maxPaths = Math.min(HARD_MAX_PATHS, Math.max(1, input.maxPaths ?? DEFAULT_MAX_PATHS));
  const maxEdges = Math.min(MAX_INSPECTED_EDGES, Math.max(1, input.maxEdges ?? DEFAULT_MAX_EDGES));
  const maxTokens = Math.min(HARD_MAX_TOKENS, Math.max(1, input.maxTokens ?? DEFAULT_MAX_TOKENS));
  const relationFilter = input.relations === undefined ? null : new Set(input.relations);
  const timingEnabled = options?.measureTiming === true;
  const directStarted = timingEnabled ? performance.now() : 0;
  let edgesInspected = 0;
  const directCandidates = listEdgesForSymbol(db, root.id);
  edgesInspected += directCandidates.length;
  const symbolCache = new Map<string, SymbolRecord>([[root.id, root]]);
  const symbolFor = (id: string): SymbolRecord | undefined => {
    const cached = symbolCache.get(id);
    if (cached !== undefined) return cached;
    const symbol = getSymbolById(db, id);
    if (symbol !== undefined) symbolCache.set(id, symbol);
    return symbol;
  };
  // One batched lookup for the direct neighbourhood's recorded call sites, so
  // the headline relations carry exact provenance instead of a body scan. The
  // transitive traversal below still scans; see the M131 impact audit.
  const directCallSites = listCallSitesForEdges(db, directCandidates.map((edge) => edge.id));
  const persistedDirectRelations = directCandidates.flatMap((edge): StaticRelationEvidence[] => {
    const source = symbolFor(edge.srcSymbolId);
    const target = symbolFor(edge.dstSymbolId);
    if (source === undefined || target === undefined) return [];
    const relation = buildStaticRelationEvidence(db, edge, source, target, {
      direction: edge.dstSymbolId === root.id ? "incoming" : "outgoing",
      repoRoot: options?.repoRoot,
      includeSourceEvidence: input.includeEvidence ?? true,
      callSites: directCallSites.get(edge.id) ?? [],
    });
    return relationAllowed(relation, relationFilter, input) ? [relation] : [];
  });
  const documentationRelations = input.includeLexical === true && options?.repoRoot !== undefined
    ? findDocumentationEvidence(options.repoRoot, root)
    : [];
  const importSyntaxRelations = options?.repoRoot !== undefined && input.includeEvidence !== false
    ? findImportSyntaxEvidence(db, options.repoRoot, root, [...symbolCache.values()])
    : [];
  const allDirectRelations = deduplicateRelations([
    ...persistedDirectRelations,
    ...importSyntaxRelations,
    ...documentationRelations,
  ]).sort(compareStaticRelations);
  const directNeighborQueryMs = measuredElapsed(directStarted, timingEnabled);

  const traversalStarted = timingEnabled ? performance.now() : 0;
  const traversals: TraversedRelation[] = [];
  let remainingTraversalEdges = maxEdges;
  if (direction !== "downstream") {
    const upstream = traverseRelations(db, root, "incoming", maxDepth, relationFilter, input, options, symbolCache, remainingTraversalEdges);
    traversals.push(...upstream);
    remainingTraversalEdges = Math.max(0, remainingTraversalEdges - upstream.reduce((sum, item) => sum + item.inspectedEdges, 0));
  }
  if (direction !== "upstream" && remainingTraversalEdges > 0) {
    const downstream = traverseRelations(db, root, "outgoing", maxDepth, relationFilter, input, options, symbolCache, remainingTraversalEdges);
    traversals.push(...downstream);
    remainingTraversalEdges = Math.max(0, remainingTraversalEdges - downstream.reduce((sum, item) => sum + item.inspectedEdges, 0));
  }
  edgesInspected += traversals.reduce((sum, item) => sum + item.inspectedEdges, 0);
  const pathCandidates = traversals
    .filter((item) => item.path.length > 0)
    .map((item) => toStaticImpactPath(root, item.path, item.symbols, item.direction));
  const rankedPaths = deduplicatePaths(pathCandidates).sort(compareStaticPaths);
  const tokenBounded = takePathsWithinTokenBudget(rankedPaths, maxPaths, maxTokens);
  const paths = tokenBounded.paths;
  const pathTraversalMs = measuredElapsed(traversalStarted, timingEnabled);

  const directRelations = allDirectRelations.slice(0, maxEdges);
  const omittedDirectEdges = Math.max(0, allDirectRelations.length - directRelations.length);
  const affected = summarizeAffectedFiles(traversals, root.filePath);
  const reachedSymbols = uniqueSymbols(traversals.flatMap((item) => item.symbols.slice(1)));
  const classified = reachedSymbols.flatMap((symbol): ImpactClassifiedSymbol[] => {
    const entrypoint = classifyEntrypoint(symbol);
    if (entrypoint === null) return [];
    return [{
      ...toImpactSymbolSummary(symbol),
      entrypointKind: entrypoint.kind,
      strength: entrypoint.strength,
      evidence: entrypoint.evidence,
      limitations: entrypoint.limitations,
    }];
  });
  const entrypoints = classified.filter((entry) => entry.entrypointKind !== "test").sort(compareImpactSymbols);
  const tests = classified.filter((entry) => entry.entrypointKind === "test").sort(compareImpactSymbols);
  const renderStarted = timingEnabled ? performance.now() : 0;
  const renderMs = measuredElapsed(renderStarted, timingEnabled);
  const omittedPaths = Math.max(0, rankedPaths.length - paths.length);
  const truncated = omittedDirectEdges > 0 || omittedPaths > 0 || traversals.some((item) => item.truncated);
  const directIncoming = directRelations.filter((relation) => relation.direction === "incoming").length;
  const directOutgoing = directRelations.filter((relation) => relation.direction === "outgoing").length;
  const transitiveIncoming = traversals.filter((item) => item.direction === "incoming" && item.distance > 1).length;
  const transitiveOutgoing = traversals.filter((item) => item.direction === "outgoing" && item.distance > 1).length;

  return {
    directRelations,
    paths,
    affectedFiles: affected,
    entrypoints,
    tests,
    richSummary: {
      directIncoming,
      directOutgoing,
      transitiveIncoming,
      transitiveOutgoing,
      affectedFiles: affected.length,
      affectedSymbols: reachedSymbols.length,
      countsByRelation: countBy(directRelations.map((relation) => relation.kind)),
      countsByStrength: countBy(directRelations.map((relation) => relation.strength)),
      truncated,
      omittedPaths,
      omittedEdges: omittedDirectEdges + traversals.reduce((sum, item) => sum + item.omittedEdges, 0),
    },
    limits: { maxDepth, maxPaths, maxEdges, maxTokens },
    timing: {
      targetResolutionMs,
      directNeighborQueryMs,
      pathTraversalMs,
      renderMs,
      totalImpactMs: measuredElapsed(totalStarted, timingEnabled),
    },
    diagnostics: {
      staticEvidenceOnly: true,
      nodesVisited: reachedSymbols.length + 1,
      edgesInspected,
      pathsConsidered: rankedPaths.length,
      pathsReturned: paths.length,
      canonicalEdgesRetained: 0,
      canonicalNodesRetained: 0,
      canonicalEdgesOmitted: 0,
      deliveryTruncated: false,
      traversalLimitReached: remainingTraversalEdges === 0,
      limitations: [
        "Static repository evidence only; paths are not runtime execution traces.",
        "Dynamic dispatch, monkey patching, reflection, and dependency injection are not resolved.",
        "Edge-site lines are returned only when the target name occurs in the fresh bounded source-symbol excerpt.",
        "Unresolved parser candidates are skipped by the current persisted graph and cannot be reconstructed by this query.",
      ],
    },
  };
}

interface TraversedRelation {
  relation: StaticRelationEvidence;
  direction: "incoming" | "outgoing";
  distance: number;
  path: readonly StaticRelationEvidence[];
  symbols: readonly SymbolRecord[];
  inspectedEdges: number;
  omittedEdges: number;
  truncated: boolean;
}

function traverseRelations(
  db: Database,
  root: SymbolRecord,
  direction: "incoming" | "outgoing",
  maxDepth: number,
  relationFilter: ReadonlySet<StaticRelationKind> | null,
  input: GetImpactGraphInput,
  options: GetImpactGraphOptions | undefined,
  symbolCache: Map<string, SymbolRecord>,
  maxInspectedEdges: number,
): TraversedRelation[] {
  const results: TraversedRelation[] = [];
  const visited = new Set<string>([root.id]);
  let frontier: Array<{ symbol: SymbolRecord; path: StaticRelationEvidence[]; symbols: SymbolRecord[] }> = [{ symbol: root, path: [], symbols: [root] }];
  let inspected = 0;
  let omitted = 0;

  for (let distance = 1; distance <= maxDepth && frontier.length > 0; distance += 1) {
    const next: typeof frontier = [];
    for (const state of frontier.sort((a, b) => compareSymbolRecords(a.symbol, b.symbol))) {
      const incident = listEdgesForSymbol(db, state.symbol.id);
      for (const edge of incident) {
        if (inspected >= Math.min(maxInspectedEdges, MAX_INSPECTED_EDGES)) { omitted += incident.length; break; }
        inspected += 1;
        if (direction === "incoming" && edge.dstSymbolId !== state.symbol.id) continue;
        if (direction === "outgoing" && edge.srcSymbolId !== state.symbol.id) continue;
        const nextId = direction === "incoming" ? edge.srcSymbolId : edge.dstSymbolId;
        if (visited.has(nextId) || nextId === state.symbol.id) continue;
        let nextSymbol = symbolCache.get(nextId);
        if (nextSymbol === undefined) {
          nextSymbol = getSymbolById(db, nextId);
          if (nextSymbol !== undefined) symbolCache.set(nextId, nextSymbol);
        }
        if (nextSymbol === undefined) continue;
        const source = direction === "incoming" ? nextSymbol : state.symbol;
        const target = direction === "incoming" ? state.symbol : nextSymbol;
        const relation = buildStaticRelationEvidence(db, edge, source, target, {
          direction,
          repoRoot: options?.repoRoot,
          includeSourceEvidence: input.includeEvidence ?? true,
        });
        if (!relationAllowed(relation, relationFilter, input)) continue;
        visited.add(nextId);
        const path = [...state.path, relation];
        const symbols = [...state.symbols, nextSymbol];
        const item: TraversedRelation = {
          relation,
          direction,
          distance,
          path,
          symbols,
          inspectedEdges: 0,
          omittedEdges: 0,
          truncated: false,
        };
        results.push(item);
        next.push({ symbol: nextSymbol, path, symbols });
      }
      if (inspected >= Math.min(maxInspectedEdges, MAX_INSPECTED_EDGES)) break;
    }
    frontier = next;
    if (inspected >= Math.min(maxInspectedEdges, MAX_INSPECTED_EDGES)) break;
  }
  if (results.length > 0) {
    results[0] = { ...results[0]!, inspectedEdges: inspected, omittedEdges: omitted, truncated: omitted > 0 };
  }
  return results;
}

function relationAllowed(
  relation: StaticRelationEvidence,
  filter: ReadonlySet<StaticRelationKind> | null,
  input: GetImpactGraphInput,
): boolean {
  if (filter !== null && !filter.has(relation.kind)) return false;
  if (relation.strength === "lexical" && input.includeLexical !== true) return false;
  if (relation.strength === "unresolved" && input.includeUnresolved !== true) return false;
  return true;
}

function toStaticImpactPath(
  root: SymbolRecord,
  edges: readonly StaticRelationEvidence[],
  symbols: readonly SymbolRecord[],
  traversalDirection: "incoming" | "outgoing",
): StaticImpactPath {
  const orderedSymbols = traversalDirection === "incoming" ? [...symbols].reverse() : [...symbols];
  const orderedEdges = traversalDirection === "incoming" ? [...edges].reverse() : [...edges];
  const first = orderedEdges[0];
  const sourceSymbol = traversalDirection === "incoming" ? symbols.at(-1)! : root;
  const entrypoint = classifyEntrypoint(sourceSymbol);
  let direction: StaticImpactPath["direction"];
  if (traversalDirection === "outgoing") direction = "target_to_callee";
  else if (entrypoint?.kind === "test") direction = "test_to_target";
  else if (entrypoint !== null) direction = "entrypoint_to_target";
  else if (orderedEdges.every((edge) => edge.kind === "inherits" || edge.kind === "implements")) direction = "inheritance_chain";
  else if (first?.kind === "imports" || first?.kind === "re_exports") direction = "import_to_definition";
  else direction = "caller_to_target";
  return {
    id: hashPath(orderedEdges.map((edge) => edge.id)),
    direction,
    nodes: orderedSymbols.map(toImpactSymbolSummary),
    edges: orderedEdges,
    length: orderedEdges.length,
    minimumStrength: minimumEvidenceStrength(orderedEdges.map((edge) => edge.strength)),
    truncated: false,
    limitations: ["Bounded static repository path; it does not prove runtime execution."],
  };
}

function compareStaticRelations(left: StaticRelationEvidence, right: StaticRelationEvidence): number {
  return (left.direction === right.direction ? 0 : left.direction === "incoming" ? -1 : 1)
    || compareEvidenceStrength(left.strength, right.strength)
    || left.kind.localeCompare(right.kind)
    || (left.source.path ?? "").localeCompare(right.source.path ?? "")
    || (left.source.symbol ?? "").localeCompare(right.source.symbol ?? "")
    || left.id.localeCompare(right.id);
}

function compareStaticPaths(left: StaticImpactPath, right: StaticImpactPath): number {
  return compareEvidenceStrength(left.minimumStrength, right.minimumStrength)
    || left.length - right.length
    || crossFileTransitions(left) - crossFileTransitions(right)
    || pathKey(left).localeCompare(pathKey(right));
}

function crossFileTransitions(path: StaticImpactPath): number {
  let count = 0;
  for (let index = 1; index < path.nodes.length; index += 1) {
    if (path.nodes[index - 1]!.filePath !== path.nodes[index]!.filePath) count += 1;
  }
  return count;
}

function pathKey(path: StaticImpactPath): string {
  return path.nodes.map((node) => `${node.filePath}::${node.fqName}`).join("\0");
}

function deduplicatePaths(paths: readonly StaticImpactPath[]): StaticImpactPath[] {
  return [...new Map(paths.map((path) => [path.id, path])).values()];
}

function deduplicateRelations(relations: readonly StaticRelationEvidence[]): StaticRelationEvidence[] {
  return [...new Map(relations.map((relation) => [relation.id, relation])).values()];
}

function takePathsWithinTokenBudget(
  paths: readonly StaticImpactPath[],
  maxPaths: number,
  maxTokens: number,
): { paths: StaticImpactPath[] } {
  const selected: StaticImpactPath[] = [];
  let used = 0;
  for (const path of paths) {
    if (selected.length >= maxPaths) break;
    const cost = Math.ceil(JSON.stringify(path).length / 4);
    if (used + cost > maxTokens) break;
    selected.push(path);
    used += cost;
  }
  return { paths: selected };
}

function summarizeAffectedFiles(
  traversals: readonly TraversedRelation[],
  rootPath: string,
): AffectedFileSummary[] {
  const byPath = new Map<string, TraversedRelation[]>();
  for (const item of traversals) {
    if (item.direction !== "incoming") continue;
    const symbol = item.symbols.at(-1);
    if (symbol === undefined || symbol.filePath === rootPath) continue;
    const values = byPath.get(symbol.filePath) ?? [];
    values.push(item);
    byPath.set(symbol.filePath, values);
  }
  return [...byPath.entries()].map(([filePath, items]) => {
    const strengths = items.map((item) => item.relation.strength).sort(compareEvidenceStrength);
    return {
      path: filePath,
      direct: items.some((item) => item.distance === 1),
      minimumDistance: Math.min(...items.map((item) => item.distance)),
      relationKinds: [...new Set(items.map((item) => item.relation.kind))].sort(),
      strongestEvidence: strengths[0] ?? "unresolved",
      reviewGuidance: (strengths[0] === "exact" || strengths[0] === "resolved" ? "high_confidence" : "uncertain") as AffectedFileSummary["reviewGuidance"],
    };
  }).sort((left, right) => Number(right.direct) - Number(left.direct) || left.minimumDistance - right.minimumDistance || left.path.localeCompare(right.path));
}

function uniqueSymbols(symbols: readonly SymbolRecord[]): SymbolRecord[] {
  return [...new Map(symbols.map((symbol) => [symbol.id, symbol])).values()].sort(compareSymbolRecords);
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function hashPath(edgeIds: readonly string[]): string {
  return `path_${edgeIds.join("_").slice(0, 96)}`;
}

function measuredElapsed(start: number, enabled: boolean): number {
  return enabled ? Math.max(0, performance.now() - start) : 0;
}

function discoverImpactSymbols(
  db: Database,
  resolvedSymbol: SymbolRecord,
  maxDepth: number,
  maxRetainedEdges: number,
): {
  readonly distanceById: ReadonlyMap<string, number>;
  readonly symbolsById: ReadonlyMap<string, SymbolRecord>;
  readonly omittedDependents: number;
  readonly limitReached: boolean;
} {
  const distanceById = new Map<string, number>([[resolvedSymbol.id, 0]]);
  const symbolsById = new Map<string, SymbolRecord>([[resolvedSymbol.id, resolvedSymbol]]);
  let frontier = [resolvedSymbol.id];
  let omittedDependents = 0;
  let limitReached = false;

  for (let distance = 0; distance < maxDepth && frontier.length > 0; distance += 1) {
    const frontierSet = new Set(frontier);
    // Collect the whole frontier's dependent ids first, then hydrate them in ONE
    // query. The per-edge lookup this replaces issued a query per dependent, so
    // its cost tracked the frontier's edge count rather than the level count.
    // Insertion order is preserved for determinism, but the returned nodes are
    // sorted below regardless, so hydration order cannot affect the result.
    const dependentIds: string[] = [];
    const seenDependentIds = new Set<string>();

    for (const edge of listEdgesForSymbols(db, frontier)) {
      if (!frontierSet.has(edge.dstSymbolId) || edge.srcSymbolId === edge.dstSymbolId) {
        continue;
      }

      if (distanceById.has(edge.srcSymbolId) || seenDependentIds.has(edge.srcSymbolId)) {
        continue;
      }

      seenDependentIds.add(edge.srcSymbolId);
      dependentIds.push(edge.srcSymbolId);
    }

    const remaining = Math.max(0, maxRetainedEdges - (symbolsById.size - 1));
    const retainedDependentIds = dependentIds.slice(0, remaining);
    omittedDependents += Math.max(0, dependentIds.length - retainedDependentIds.length);
    if (retainedDependentIds.length < dependentIds.length) limitReached = true;
    const hydrated = getSymbolsByIds(db, retainedDependentIds);
    const nextSymbolsById = new Map<string, SymbolRecord>();

    for (const dependentId of retainedDependentIds) {
      const dependentSymbol = hydrated.get(dependentId);
      // A dangling edge target is skipped exactly as the single-row lookup did.
      if (dependentSymbol === undefined) {
        continue;
      }
      nextSymbolsById.set(dependentSymbol.id, dependentSymbol);
    }

    const nextFrontier = [...nextSymbolsById.values()].sort(compareSymbolRecords);

    for (const symbol of nextFrontier) {
      symbolsById.set(symbol.id, symbol);
      distanceById.set(symbol.id, distance + 1);
    }

    frontier = nextFrontier.map((symbol) => symbol.id);
    if (symbolsById.size - 1 >= maxRetainedEdges) {
      limitReached = limitReached || frontier.length > 0;
      break;
    }
  }

  return {
    distanceById,
    symbolsById,
    omittedDependents,
    limitReached,
  };
}

function buildImpactNodes(
  distanceById: ReadonlyMap<string, number>,
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): ImpactNode[] {
  return [...symbolsById.values()]
    .map((symbol) => ({
      ...toImpactSymbolSummary(symbol),
      distance: distanceById.get(symbol.id) ?? 0,
    }))
    .sort(compareImpactNodes);
}

/**
 * Attach a bounded signature-focused excerpt to the first `maxExcerpts`
 * dependent nodes (distance > 0) in deterministic node order. The focal root
 * node (distance 0) is never enriched. Dependents beyond the budget, or whose
 * source could not be loaded freshly, get an explicit null marker.
 */
function attachImpactSourceExcerpts(
  db: Database,
  repoRoot: string,
  nodes: readonly ImpactNode[],
  maxExcerpts: number,
): ImpactNode[] {
  let emitted = 0;

  return nodes.map((node) => {
    if (node.distance === 0) {
      return node;
    }

    if (emitted >= maxExcerpts) {
      return { ...node, sourceExcerpt: null };
    }

    emitted += 1;
    return {
      ...node,
      sourceExcerpt: buildSymbolSourceExcerpt(db, repoRoot, node.symbolId, { mode: "signature" }),
    };
  });
}

function buildImpactEdges(
  db: Database,
  distanceById: ReadonlyMap<string, number>,
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): ImpactEdge[] {
  const symbolIds = [...distanceById.keys()];

  return listEdgesForSymbols(db, symbolIds)
    .filter((edge) => isShortestLayerImpactEdge(edge, distanceById))
    .map((edge) => ({
      edgeId: edge.id,
      edgeType: edge.edgeType,
      fromSymbolId: edge.srcSymbolId,
      fromFqName: symbolsById.get(edge.srcSymbolId)!.fqName,
      toSymbolId: edge.dstSymbolId,
      toFqName: symbolsById.get(edge.dstSymbolId)!.fqName,
    }))
    .sort((left, right) => compareImpactEdges(left, right, symbolsById));
}

function isShortestLayerImpactEdge(
  edge: EdgeRecord,
  distanceById: ReadonlyMap<string, number>,
): boolean {
  const srcDistance = distanceById.get(edge.srcSymbolId);
  const dstDistance = distanceById.get(edge.dstSymbolId);

  if (srcDistance === undefined || dstDistance === undefined || edge.srcSymbolId === edge.dstSymbolId) {
    return false;
  }

  return dstDistance + 1 === srcDistance;
}

function buildPrimaryParentEdges(
  edges: readonly ImpactEdge[],
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): ReadonlyMap<string, ImpactEdge> {
  const primaryParentEdges = new Map<string, ImpactEdge>();

  for (const edge of edges) {
    const existing = primaryParentEdges.get(edge.fromSymbolId);

    if (existing === undefined || compareImpactEdges(edge, existing, symbolsById) < 0) {
      primaryParentEdges.set(edge.fromSymbolId, edge);
    }
  }

  return primaryParentEdges;
}

function collectDependentFiles(nodes: readonly ImpactNode[]): string[] {
  return [...new Set(
    nodes
      .filter((node) => node.distance > 0)
      .map((node) => node.filePath),
  )].sort((left, right) => left.localeCompare(right));
}

function collectObservedEdgeTypes(edges: readonly ImpactEdge[]): EdgeType[] {
  return [...new Set(edges.map((edge) => edge.edgeType))]
    .sort((left, right) => left.localeCompare(right)) as EdgeType[];
}

function hasMemberResolutionEvidence(
  edges: readonly ImpactEdge[],
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): boolean {
  for (const edge of edges) {
    if (edge.edgeType !== EdgeType.Calls && edge.edgeType !== EdgeType.References) {
      continue;
    }

    const fromSymbol = symbolsById.get(edge.fromSymbolId);
    const toSymbol = symbolsById.get(edge.toSymbolId);

    if (fromSymbol?.parentSymbolId !== undefined || toSymbol?.parentSymbolId !== undefined) {
      return true;
    }
  }

  return false;
}

/**
 * Heuristic proxy for "inherited-member / super() / cross-class-qualified
 * evidence was used": any calls/references edge whose endpoints are members of
 * two different classes. This catches edges produced by inherited self/cls
 * fallback, super().x, and same-file/imported ClassName.x cross-class access.
 * The note is deliberately worded to describe what is observed, not claim
 * dynamic dispatch truth.
 */
function hasInheritedMemberEvidence(
  edges: readonly ImpactEdge[],
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): boolean {
  for (const edge of edges) {
    if (edge.edgeType !== EdgeType.Calls && edge.edgeType !== EdgeType.References) {
      continue;
    }

    const fromSymbol = symbolsById.get(edge.fromSymbolId);
    const toSymbol = symbolsById.get(edge.toSymbolId);

    if (
      fromSymbol?.parentSymbolId !== undefined
      && toSymbol?.parentSymbolId !== undefined
      && fromSymbol.parentSymbolId !== toSymbol.parentSymbolId
    ) {
      return true;
    }
  }

  return false;
}

function hasCrossLanguagePythonCythonEvidence(
  edges: readonly ImpactEdge[],
  nodes: readonly ImpactNode[],
): boolean {
  const languageBySymbolId = new Map<string, ReturnType<typeof detectLanguage>>();

  for (const node of nodes) {
    languageBySymbolId.set(node.symbolId, detectLanguage(node.filePath));
  }

  return edges.some((edge) => {
    const fromLanguage = languageBySymbolId.get(edge.fromSymbolId);
    const toLanguage = languageBySymbolId.get(edge.toSymbolId);

    return (fromLanguage === Language.Python && toLanguage === Language.Cython)
      || (fromLanguage === Language.Cython && toLanguage === Language.Python);
  });
}

function buildCoverageNotes(
  edges: readonly ImpactEdge[],
  nodes: readonly ImpactNode[],
  maxDepth: number,
  memberEvidencePresent: boolean,
  inheritedEvidencePresent: boolean,
  crossLanguageEvidencePresent: boolean,
): string[] {
  const observed = new Set(edges.map((edge) => edge.edgeType));
  const notes = [
    "Structural-only reverse impact view built from indexed contains, imports, calls, and references edges.",
    "Exact FQN resolution is required; no fuzzy symbol matching is applied.",
    "Caller/reference edges are statically extracted for Python, TypeScript, and Cython in this milestone; other languages contribute contains/imports evidence only.",
    "Call/reference edges are emitted only when the target resolves exactly via same-file, imported-name, module-qualified, or same-class self.method lookup. Ambiguous targets are skipped conservatively.",
    "Non-call references cover conservative Python cases: inheritance bases, decorators, type annotations, exception classes in raise/except, alias assignments, and other exact imported-name or module-qualified uses. Ambiguous or dynamic references are skipped.",
    "TypeScript call/reference extraction is conservative static evidence: calls resolve to same-file functions, exactly-imported functions, same-class this.method, and same-file ClassName.method; references cover type annotations, extends/implements, type-alias targets, new ClassName(), and class/method decorators. Arbitrary object receivers and dynamic dispatch are skipped.",
    "Cython call/reference extraction is conservative static evidence over a token-level model: cdef classes and their def/cdef/cpdef methods are indexed with contains edges; calls resolve to same-file functions/classes, exactly resolved import/cimport/include callables, receiver.method on the enclosing method's first parameter, and same-file ClassName.method; references cover exact inheritance bases and exact same-file/imported name uses. Ambiguous receivers and dynamic dispatch are skipped.",
    "Member/attribute resolution is enabled for self.x (in methods whose first parameter is self), cls.x (in methods whose first parameter is cls), and ClassName.x (same-file or imported class). Calls resolve only to methods; references resolve to methods and class-level attributes. Arbitrary obj.x, runtime instance-type inference, and dynamic dispatch are never attempted.",
    "Inherited-member and super() resolution is conservative and exact-first: super().x, self.x, cls.x, and ClassName.x may fall back to a direct base-class member when exactly one resolved direct base exposes that member. Bases must resolve exactly (same-file class or imported class). Multi-base ambiguity, unresolved bases, and transitive grandparent chains are skipped.",
    "This does not represent runtime execution flow, semantic reachability, dataflow, or dynamic dispatch truth.",
  ];

  if (!observed.has(EdgeType.Calls) && !observed.has(EdgeType.References)) {
    notes.push(
      "No caller/reference evidence was observed for this symbol; result relies on contains/imports edges only.",
    );
  }

  if (memberEvidencePresent) {
    notes.push(
      "Member/attribute resolution contributed evidence to this result (at least one calls/references edge connects a class-nested symbol).",
    );
  }

  if (inheritedEvidencePresent) {
    notes.push(
      "Inherited-member or cross-class-qualified evidence contributed to this result (at least one calls/references edge connects members of different classes, consistent with super(), inherited self/cls, or ClassName.x fallback).",
    );
  }

  if (crossLanguageEvidencePresent) {
    notes.push(
      "Cross-language Python<->Cython evidence contributed to this result (at least one calls/references edge connects a Python symbol and a Cython symbol through an exact import/reference).",
    );
  }

  if (edges.length > Math.max(nodes.length - 1, 0)) {
    notes.push(
      "Multiple shortest structural parent paths exist for at least one dependent; list/tree views pick a deterministic primary path while edges retain the full shortest-path set.",
    );
  }

  if (nodes.length === 1) {
    notes.push(`No indexed reverse dependents were found within depth ${maxDepth}.`);
  }

  return notes;
}

function buildImpactViewLines(
  format: ImpactFormat,
  nodes: readonly ImpactNode[],
  edges: readonly ImpactEdge[],
  primaryParentEdges: ReadonlyMap<string, ImpactEdge>,
): string[] {
  switch (format) {
    case "list":
      return buildListLines(nodes, primaryParentEdges);
    case "tree":
      return buildTreeLines(nodes, primaryParentEdges);
    case "mermaid":
      return buildMermaidLines(nodes, edges);
  }
}

function buildListLines(
  nodes: readonly ImpactNode[],
  primaryParentEdges: ReadonlyMap<string, ImpactEdge>,
): string[] {
  const lines = [formatImpactNodeLine(nodes[0]!, null)];

  for (const node of nodes.slice(1)) {
    const edge = primaryParentEdges.get(node.symbolId) ?? null;
    lines.push(formatImpactNodeLine(node, edge));
  }

  return lines;
}

function buildTreeLines(
  nodes: readonly ImpactNode[],
  primaryParentEdges: ReadonlyMap<string, ImpactEdge>,
): string[] {
  const lines: string[] = [];
  const nodesById = new Map(nodes.map((node) => [node.symbolId, node]));
  const childrenByParentId = new Map<string, ImpactNode[]>();

  for (const node of nodes.slice(1)) {
    const edge = primaryParentEdges.get(node.symbolId);

    if (edge === undefined) {
      continue;
    }

    const siblings = childrenByParentId.get(edge.toSymbolId);

    if (siblings === undefined) {
      childrenByParentId.set(edge.toSymbolId, [node]);
      continue;
    }

    siblings.push(node);
  }

  for (const siblings of childrenByParentId.values()) {
    siblings.sort(compareImpactNodes);
  }

  const visit = (symbolId: string, indentLevel: number): void => {
    const node = nodesById.get(symbolId);

    if (node === undefined) {
      return;
    }

    const edge = primaryParentEdges.get(symbolId) ?? null;
    lines.push(`${"  ".repeat(indentLevel)}${formatImpactNodeLine(node, edge)}`);

    for (const child of childrenByParentId.get(symbolId) ?? []) {
      visit(child.symbolId, indentLevel + 1);
    }
  };

  visit(nodes[0]!.symbolId, 0);
  return lines;
}

function buildMermaidLines(
  nodes: readonly ImpactNode[],
  edges: readonly ImpactEdge[],
): string[] {
  const aliasBySymbolId = new Map<string, string>();
  const lines = ["flowchart TD"];

  nodes.forEach((node, index) => {
    const alias = `n${index}`;
    aliasBySymbolId.set(node.symbolId, alias);
    lines.push(`  ${alias}[\"${escapeMermaidText(`d${node.distance} ${node.fqName} (${node.kind})`)}\"]`);
  });

  for (const edge of edges) {
    lines.push(
      `  ${aliasBySymbolId.get(edge.fromSymbolId)} -->|${edge.edgeType}| ${aliasBySymbolId.get(edge.toSymbolId)}`,
    );
  }

  return lines;
}

function formatImpactNodeLine(node: ImpactNode, edge: ImpactEdge | null): string {
  if (edge === null) {
    return `d${node.distance} ${node.fqName} (${node.kind})`;
  }

  return `d${node.distance} ${node.fqName} (${node.kind}) ${edge.edgeType} ${edge.toFqName}`;
}

function toImpactSymbolSummary(symbol: SymbolRecord): ImpactSymbolSummary {
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
  };
}

function compareImpactNodes(left: ImpactNode, right: ImpactNode): number {
  return left.distance - right.distance || compareImpactSymbols(left, right);
}

function compareImpactEdges(
  left: ImpactEdge,
  right: ImpactEdge,
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): number {
  const leftFrom = symbolsById.get(left.fromSymbolId)!;
  const rightFrom = symbolsById.get(right.fromSymbolId)!;
  const leftTo = symbolsById.get(left.toSymbolId)!;
  const rightTo = symbolsById.get(right.toSymbolId)!;

  return compareSymbolRecords(leftFrom, rightFrom)
    || compareSymbolRecords(leftTo, rightTo)
    || left.edgeType.localeCompare(right.edgeType)
    || left.edgeId.localeCompare(right.edgeId);
}

function compareImpactSymbols(left: ImpactSymbolSummary, right: ImpactSymbolSummary): number {
  return left.filePath.localeCompare(right.filePath)
    || left.fqName.localeCompare(right.fqName)
    || left.kind.localeCompare(right.kind)
    || left.symbolId.localeCompare(right.symbolId);
}

function compareSymbolRecords(left: SymbolRecord, right: SymbolRecord): number {
  return left.filePath.localeCompare(right.filePath)
    || left.fqName.localeCompare(right.fqName)
    || left.kind.localeCompare(right.kind)
    || left.startByte - right.startByte
    || left.endByte - right.endByte
    || left.id.localeCompare(right.id);
}

function escapeMermaidText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "#quot;");
}
