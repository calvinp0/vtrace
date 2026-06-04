// @ts-nocheck
import type { Database } from "bun:sqlite";

import { listAllEdges } from "../db/repositories/edgesRepository";
import { listAllSymbols, listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import {
  EdgeType,
  Language,
  type EdgeRecord,
  type SymbolKind,
  type SymbolRecord,
} from "../domain/types";
import { detectLanguage } from "../fs/languageDetection";

export interface SearchLogicFlowInput {
  readonly start: string;
  readonly end: string;
  readonly maxPaths: number;
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
}

export interface LogicFlowPath {
  readonly pathIndex: number;
  readonly edgeCount: number;
  readonly nodeCount: number;
  readonly nodes: readonly LogicFlowSymbolSummary[];
  readonly steps: readonly LogicFlowStep[];
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

export function searchLogicFlow(
  db: Database,
  input: SearchLogicFlowInput,
): LogicFlowResult {
  const resolvedStart = resolveExactSymbol(db, input.start, "start");

  if (!resolvedStart.ok) {
    return resolvedStart;
  }

  const resolvedEnd = resolveExactSymbol(db, input.end, "end");

  if (!resolvedEnd.ok) {
    return resolvedEnd;
  }

  const symbolsById = new Map(
    listAllSymbols(db).map((symbol) => [symbol.id, symbol] as const),
  );
  const graph = buildGraph(listAllEdges(db), symbolsById);
  const callFlowEvidenceAvailable = graph.graphEdgeTypes.has(EdgeType.Calls);
  const distanceFromStart = computeForwardDistances(resolvedStart.symbol.id, graph.outgoingBySymbolId);
  const shortestPathEdgeCount = distanceFromStart.get(resolvedEnd.symbol.id) ?? null;

  let returnedPaths: LogicFlowPath[] = [];
  let truncated = false;

  if (shortestPathEdgeCount !== null) {
    const distanceToEnd = computeReverseDistances(resolvedEnd.symbol.id, graph.incomingBySymbolId);
    const enumeratedStepPaths = enumerateShortestStepPaths(
      resolvedStart.symbol.id,
      resolvedEnd.symbol.id,
      input.maxPaths + 1,
      shortestPathEdgeCount,
      distanceFromStart,
      distanceToEnd,
      graph.outgoingBySymbolId,
      symbolsById,
    );

    truncated = enumeratedStepPaths.length > input.maxPaths;
    returnedPaths = enumeratedStepPaths
      .slice(0, input.maxPaths)
      .map((steps, index) => toLogicFlowPath(index + 1, resolvedStart.symbol, steps, symbolsById));
  }

  const observedEdgeTypes = collectObservedEdgeTypes(returnedPaths);
  const callFlowEvidenceUsed = observedEdgeTypes.includes(EdgeType.Calls);
  const crossLanguageEvidenceUsed = hasCrossLanguagePythonCythonStep(returnedPaths);

  return {
    ok: true,
    output: {
      requested: {
        start: resolvedStart.symbol.fqName,
        end: resolvedEnd.symbol.fqName,
        maxPaths: input.maxPaths,
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
        ),
      },
      summary: {
        reachable: returnedPaths.length > 0,
        pathCount: returnedPaths.length,
        maxPaths: input.maxPaths,
        shortestPathEdgeCount,
        truncated,
      },
      paths: returnedPaths,
    },
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

function buildGraph(
  edges: readonly EdgeRecord[],
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): {
  readonly outgoingBySymbolId: ReadonlyMap<string, readonly EdgeRecord[]>;
  readonly incomingBySymbolId: ReadonlyMap<string, readonly EdgeRecord[]>;
  readonly graphEdgeTypes: ReadonlySet<EdgeType>;
} {
  const outgoingBySymbolId = new Map<string, EdgeRecord[]>();
  const incomingBySymbolId = new Map<string, EdgeRecord[]>();
  const graphEdgeTypes = new Set<EdgeType>();

  for (const edge of edges) {
    if (!SUPPORTED_EDGE_TYPES.includes(edge.edgeType)) {
      continue;
    }

    if (!symbolsById.has(edge.srcSymbolId) || !symbolsById.has(edge.dstSymbolId)) {
      continue;
    }

    graphEdgeTypes.add(edge.edgeType);

    const outgoing = outgoingBySymbolId.get(edge.srcSymbolId);

    if (outgoing === undefined) {
      outgoingBySymbolId.set(edge.srcSymbolId, [edge]);
    } else {
      outgoing.push(edge);
    }

    const incoming = incomingBySymbolId.get(edge.dstSymbolId);

    if (incoming === undefined) {
      incomingBySymbolId.set(edge.dstSymbolId, [edge]);
    } else {
      incoming.push(edge);
    }
  }

  for (const outgoing of outgoingBySymbolId.values()) {
    outgoing.sort((left, right) => compareOutgoingEdges(left, right, symbolsById));
  }

  for (const incoming of incomingBySymbolId.values()) {
    incoming.sort((left, right) => compareIncomingEdges(left, right, symbolsById));
  }

  return {
    outgoingBySymbolId,
    incomingBySymbolId,
    graphEdgeTypes,
  };
}

function computeForwardDistances(
  startSymbolId: string,
  outgoingBySymbolId: ReadonlyMap<string, readonly EdgeRecord[]>,
): ReadonlyMap<string, number> {
  return computeDistances(startSymbolId, outgoingBySymbolId, (edge) => edge.dstSymbolId);
}

function computeReverseDistances(
  endSymbolId: string,
  incomingBySymbolId: ReadonlyMap<string, readonly EdgeRecord[]>,
): ReadonlyMap<string, number> {
  return computeDistances(endSymbolId, incomingBySymbolId, (edge) => edge.srcSymbolId);
}

function computeDistances(
  rootSymbolId: string,
  adjacencyBySymbolId: ReadonlyMap<string, readonly EdgeRecord[]>,
  getNextSymbolId: (edge: EdgeRecord) => string,
): ReadonlyMap<string, number> {
  const distances = new Map<string, number>([[rootSymbolId, 0]]);
  const queue = [rootSymbolId];

  for (let index = 0; index < queue.length; index += 1) {
    const currentSymbolId = queue[index]!;
    const currentDistance = distances.get(currentSymbolId)!;

    for (const edge of adjacencyBySymbolId.get(currentSymbolId) ?? []) {
      const nextSymbolId = getNextSymbolId(edge);

      if (distances.has(nextSymbolId)) {
        continue;
      }

      distances.set(nextSymbolId, currentDistance + 1);
      queue.push(nextSymbolId);
    }
  }

  return distances;
}

function enumerateShortestStepPaths(
  startSymbolId: string,
  endSymbolId: string,
  maxPaths: number,
  shortestPathEdgeCount: number,
  distanceFromStart: ReadonlyMap<string, number>,
  distanceToEnd: ReadonlyMap<string, number>,
  outgoingBySymbolId: ReadonlyMap<string, readonly EdgeRecord[]>,
  symbolsById: ReadonlyMap<string, SymbolRecord>,
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
      .sort((left, right) => compareOutgoingEdges(left, right, symbolsById));

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
  symbolsById: ReadonlyMap<string, SymbolRecord>,
): LogicFlowPath {
  const nodes = [toLogicFlowSymbolSummary(startSymbol)];

  for (const step of steps) {
    nodes.push(toLogicFlowSymbolSummary(symbolsById.get(step.dstSymbolId)!));
  }

  return {
    pathIndex,
    edgeCount: steps.length,
    nodeCount: nodes.length,
    nodes,
    steps: steps.map((step) => ({
      edgeId: step.id,
      edgeType: step.edgeType,
      fromSymbolId: step.srcSymbolId,
      fromFqName: symbolsById.get(step.srcSymbolId)!.fqName,
      toSymbolId: step.dstSymbolId,
      toFqName: symbolsById.get(step.dstSymbolId)!.fqName,
    })),
  };
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
    notes.push(`No indexed structural path was found from ${startSymbol.fqName} to ${endSymbol.fqName}.`);
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
