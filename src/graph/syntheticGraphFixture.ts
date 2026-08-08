import type { Database } from "bun:sqlite";

import { insertEdges } from "../db/repositories/edgesRepository";
import { replaceFile } from "../db/repositories/filesRepository";
import { insertSymbolsForFile } from "../db/repositories/symbolsRepository";
import {
  EdgeType,
  Language,
  SymbolKind,
  computeFileId,
  computeSymbolId,
  type EdgeRecord,
  type FileRecord,
  type SymbolRecord,
} from "../domain/types";

/**
 * Deterministic synthetic graphs for scale-sensitive tests.
 *
 * M130's flow defect was invisible to the whole test suite for one reason: every
 * fixture was a repository smaller than the bound that caused the bug. More
 * example repositories would never have found it — the missing dimension was
 * SIZE. This builder makes graph size a first-class test input, so "the answer
 * must not change when the graph grows" and "short-path work must not scale with
 * the graph" become assertions instead of hopes.
 *
 * The graph is written straight to SQLite. No source files are produced: at a
 * hundred thousand edges the parser would dominate, and traversal correctness is
 * a property of the graph, not of the text it came from.
 */
export interface SyntheticGraphSpec {
  /** Total edges in the graph, including the planted path. */
  readonly totalEdges: number;
  /** Outgoing filler edges per filler node. Controls symbols-per-edge density. */
  readonly fanOut?: number;
  /** Edges on the planted start->end path. */
  readonly plantedPathLength?: number;
  /**
   * Where the planted path's rows land in insertion order. `interleaved` spreads
   * them evenly through the filler, `shuffled` permutes the whole edge list with
   * a seeded generator. Correctness must not depend on any of these.
   */
  readonly plantedPosition?: "first" | "middle" | "last" | "interleaved" | "shuffled";
  readonly seed?: number;
  /**
   * When set, the start node also gets this many outgoing edges to dead-end
   * nodes. Used to build a frontier that genuinely outgrows a traversal budget.
   */
  readonly startFanOut?: number;
}

export interface SyntheticGraph {
  readonly startFqName: string;
  readonly endFqName: string;
  readonly totalEdges: number;
  readonly plantedPathLength: number;
  readonly symbolCount: number;
}

const ANCHOR_PATH = "syn/anchor.py";
const FILLER_PATH_PREFIX = "syn/filler";
/** Filler symbols per synthetic file, so file rows stay proportionate. */
const SYMBOLS_PER_FILE = 250;

export function buildSyntheticGraph(db: Database, spec: SyntheticGraphSpec): SyntheticGraph {
  const fanOut = Math.max(1, spec.fanOut ?? 10);
  const plantedPathLength = Math.max(1, spec.plantedPathLength ?? 1);
  const startFanOut = Math.max(0, spec.startFanOut ?? 0);
  const plantedEdgeCount = plantedPathLength + startFanOut;
  const fillerEdgeCount = Math.max(0, spec.totalEdges - plantedEdgeCount);
  const fillerNodeCount = Math.max(fanOut + 1, Math.ceil(fillerEdgeCount / fanOut));

  // Anchor file: the planted path plus any dead-end fan-out from the start.
  const anchorSymbols: SymbolRecord[] = [];
  const pathNodeCount = plantedPathLength + 1;
  for (let index = 0; index < pathNodeCount; index += 1) {
    anchorSymbols.push(makeSymbol(ANCHOR_PATH, `flow_node_${index}`, index));
  }
  for (let index = 0; index < startFanOut; index += 1) {
    anchorSymbols.push(makeSymbol(ANCHOR_PATH, `dead_end_${index}`, pathNodeCount + index));
  }

  const plantedEdges: EdgeRecord[] = [];
  for (let index = 0; index < plantedPathLength; index += 1) {
    plantedEdges.push(makeCallEdge(anchorSymbols[index]!, anchorSymbols[index + 1]!, index + 1));
  }
  for (let index = 0; index < startFanOut; index += 1) {
    plantedEdges.push(makeCallEdge(anchorSymbols[0]!, anchorSymbols[pathNodeCount + index]!, 100 + index));
  }

  const fillerSymbols: SymbolRecord[] = [];
  for (let index = 0; index < fillerNodeCount; index += 1) {
    const fileIndex = Math.floor(index / SYMBOLS_PER_FILE);
    fillerSymbols.push(makeSymbol(
      `${FILLER_PATH_PREFIX}_${String(fileIndex).padStart(4, "0")}.py`,
      `filler_${index}`,
      index % SYMBOLS_PER_FILE,
    ));
  }

  // A ring with fixed fan-out: every filler node has the same small out-degree,
  // so growing the graph grows the number of nodes rather than any one node's
  // neighbourhood. That is what makes "unrelated growth" genuinely unrelated.
  const fillerEdges: EdgeRecord[] = [];
  for (let index = 0; index < fillerEdgeCount; index += 1) {
    const from = fillerSymbols[index % fillerNodeCount]!;
    const step = 1 + Math.floor(index / fillerNodeCount);
    const to = fillerSymbols[(index + step) % fillerNodeCount]!;

    if (from.id === to.id) {
      continue;
    }

    fillerEdges.push(makeCallEdge(from, to, index));
  }

  const symbolsByPath = new Map<string, SymbolRecord[]>();
  for (const symbol of [...anchorSymbols, ...fillerSymbols]) {
    const bucket = symbolsByPath.get(symbol.filePath);
    if (bucket === undefined) {
      symbolsByPath.set(symbol.filePath, [symbol]);
    } else {
      bucket.push(symbol);
    }
  }

  const write = db.transaction(() => {
    for (const [filePath, symbols] of [...symbolsByPath.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const file = makeFile(filePath);
      replaceFile(db, file);
      insertSymbolsForFile(db, file, symbols);
    }

    insertEdges(db, orderEdges(plantedEdges, fillerEdges, spec));
  });
  write();

  return {
    startFqName: anchorSymbols[0]!.fqName,
    endFqName: anchorSymbols[plantedPathLength]!.fqName,
    totalEdges: plantedEdges.length + fillerEdges.length,
    plantedPathLength,
    symbolCount: anchorSymbols.length + fillerSymbols.length,
  };
}

/**
 * Insertion order of the edge rows. Traversal correctness must be invariant to
 * this: SQLite row order is not a semantic input, and M130's defect was in the
 * end a dependence on exactly this ordering.
 */
function orderEdges(
  planted: readonly EdgeRecord[],
  filler: readonly EdgeRecord[],
  spec: SyntheticGraphSpec,
): EdgeRecord[] {
  const position = spec.plantedPosition ?? "middle";

  if (position === "first") {
    return [...planted, ...filler];
  }

  if (position === "last") {
    return [...filler, ...planted];
  }

  if (position === "shuffled") {
    return shuffle([...planted, ...filler], spec.seed ?? 1);
  }

  const combined = [...filler];
  const stride = position === "interleaved"
    ? Math.max(1, Math.floor(filler.length / (planted.length + 1)))
    : Math.floor(filler.length / 2);

  planted.forEach((edge, index) => {
    combined.splice(Math.min(combined.length, stride * (index + 1)), 0, edge);
  });

  return combined;
}

/** Seeded Fisher-Yates. A fixed seed keeps "random" order reproducible. */
function shuffle<T>(values: T[], seed: number): T[] {
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [values[index], values[swap]] = [values[swap]!, values[index]!];
  }

  return values;
}

function makeFile(filePath: string): FileRecord {
  return {
    id: computeFileId(filePath),
    path: filePath,
    language: Language.Python,
    contentHash: `synthetic_${filePath}`,
    sizeBytes: 1,
  };
}

function makeSymbol(filePath: string, localName: string, ordinal: number): SymbolRecord {
  const startLine = 1 + ordinal * 4;
  return {
    id: computeSymbolId({
      filePath,
      fqName: `${filePath}::${localName}`,
      kind: SymbolKind.Function,
      startByte: ordinal * 40,
      endByte: ordinal * 40 + 30,
    }),
    filePath,
    fqName: `${filePath}::${localName}`,
    localName,
    kind: SymbolKind.Function,
    signature: `def ${localName}():`,
    startLine,
    endLine: startLine + 2,
    startByte: ordinal * 40,
    endByte: ordinal * 40 + 30,
    exported: false,
  };
}

function makeCallEdge(source: SymbolRecord, target: SymbolRecord, line: number): EdgeRecord {
  return {
    id: `syn_${source.id.slice(0, 16)}_${target.id.slice(0, 16)}`,
    srcSymbolId: source.id,
    dstSymbolId: target.id,
    edgeType: EdgeType.Calls,
    confidence: 1,
    callSites: [{
      startLine: source.startLine + (line % 3),
      startColumn: 4,
      endLine: source.startLine + (line % 3),
      endColumn: 20,
      precision: "span",
    }],
  };
}
