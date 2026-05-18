import type { Database } from "bun:sqlite";

import { listEdgesForSymbols } from "../db/repositories/edgesRepository";
import { getSymbolById, listSymbolsByFqName } from "../db/repositories/symbolsRepository";
import {
  EdgeType,
  type EdgeRecord,
  type SymbolKind,
  type SymbolRecord,
} from "../domain/types";

export const IMPACT_FORMATS = ["list", "tree", "mermaid"] as const;

export type ImpactFormat = (typeof IMPACT_FORMATS)[number];

export interface GetImpactGraphInput {
  readonly symbolFqn: string;
  readonly depth: number;
  readonly format: ImpactFormat;
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
): ImpactGraphResult {
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
  const { distanceById, symbolsById } = discoverImpactSymbols(db, resolvedSymbol, input.depth);
  const nodes = buildImpactNodes(distanceById, symbolsById);
  const edges = buildImpactEdges(db, distanceById, symbolsById);
  const primaryParentEdges = buildPrimaryParentEdges(edges, symbolsById);
  const dependentFiles = collectDependentFiles(nodes);
  const observedEdgeTypes = collectObservedEdgeTypes(edges);
  const memberEvidencePresent = hasMemberResolutionEvidence(edges, symbolsById);
  const inheritedEvidencePresent = hasInheritedMemberEvidence(edges, symbolsById);
  const notes = buildCoverageNotes(
    edges,
    nodes,
    input.depth,
    memberEvidencePresent,
    inheritedEvidencePresent,
  );

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
    },
  };
}

function discoverImpactSymbols(
  db: Database,
  resolvedSymbol: SymbolRecord,
  maxDepth: number,
): {
  readonly distanceById: ReadonlyMap<string, number>;
  readonly symbolsById: ReadonlyMap<string, SymbolRecord>;
} {
  const distanceById = new Map<string, number>([[resolvedSymbol.id, 0]]);
  const symbolsById = new Map<string, SymbolRecord>([[resolvedSymbol.id, resolvedSymbol]]);
  let frontier = [resolvedSymbol.id];

  for (let distance = 0; distance < maxDepth && frontier.length > 0; distance += 1) {
    const frontierSet = new Set(frontier);
    const nextSymbolsById = new Map<string, SymbolRecord>();

    for (const edge of listEdgesForSymbols(db, frontier)) {
      if (!frontierSet.has(edge.dstSymbolId) || edge.srcSymbolId === edge.dstSymbolId) {
        continue;
      }

      if (distanceById.has(edge.srcSymbolId)) {
        continue;
      }

      const dependentSymbol = getSymbolById(db, edge.srcSymbolId);

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
  }

  return {
    distanceById,
    symbolsById,
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

function buildCoverageNotes(
  edges: readonly ImpactEdge[],
  nodes: readonly ImpactNode[],
  maxDepth: number,
  memberEvidencePresent: boolean,
  inheritedEvidencePresent: boolean,
): string[] {
  const observed = new Set(edges.map((edge) => edge.edgeType));
  const notes = [
    "Structural-only reverse impact view built from indexed contains, imports, calls, and references edges.",
    "Exact FQN resolution is required; no fuzzy symbol matching is applied.",
    "Caller/reference edges are statically extracted for Python only in this milestone; other languages contribute contains/imports evidence only.",
    "Call/reference edges are emitted only when the target resolves exactly via same-file, imported-name, module-qualified, or same-class self.method lookup. Ambiguous targets are skipped conservatively.",
    "Non-call references cover conservative Python cases: inheritance bases, decorators, type annotations, exception classes in raise/except, alias assignments, and other exact imported-name or module-qualified uses. Ambiguous or dynamic references are skipped.",
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
