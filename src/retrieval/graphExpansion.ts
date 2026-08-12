// Bounded graph expansion + centrality.
//
// Lexical retrieval answers "which symbols look like the query?". It cannot
// answer "which symbols sit next to the ones that look like the query?" — yet
// the actual edit target is frequently a graph neighbour of a lexical hit (the
// function a matched test imports; the implementation a matched class contains;
// a central module everything in the area depends on).
//
// This module takes SEED symbols (the lexical/symbol/path hits) and walks the
// relationship graph outward to surface those neighbours as NEW candidates —
// the thing the audit says the existing intra-pool rerank cannot do. The walk is
// deliberately bounded (shallow depth, hard candidate cap) so a hub symbol does
// not detonate the pool.

import type { Database } from "bun:sqlite";

import { listEdgesForSymbols } from "../db/repositories/edgesRepository";
import {
  getSymbolsByIds,
  listSymbolsUnderDirectory,
} from "../db/repositories/symbolsRepository";
import {
  EdgeType,
  isStructuralSymbolKind,
  type SymbolId,
  type SymbolRecord,
} from "../domain/types";

export enum ExpansionRelation {
  Imports = "imports",
  Calls = "calls",
  References = "references",
  Contains = "contains",
  SameModule = "same_module",
}

export interface ExpansionEvidence {
  relation: ExpansionRelation;
  /** The already-in-pool symbol we expanded FROM to reach this candidate. */
  viaSymbolId: SymbolId;
  /** Edge direction relative to `viaSymbolId` (n/a for same-module neighbours). */
  direction: "outgoing" | "incoming" | "sibling";
}

export interface ExpandedCandidate {
  symbol: SymbolRecord;
  /** Hops from the nearest seed (1..maxDepth); same-module neighbours are 1. */
  depth: number;
  evidence: ExpansionEvidence[];
  /** Seeds from which this candidate was reached, sorted. */
  seedSymbolIds: SymbolId[];
}

export interface GraphExpansionOptions {
  /** Hops to walk; clamped to [1, 2]. Default 1. */
  maxDepth?: number;
  /** Hard cap on returned candidates. Default 24. */
  maxExpandedCandidates?: number;
  /** Also surface same-directory (same package) siblings. Default true. */
  includeSameModule?: boolean;
  /** Per-seed cap on same-module siblings. Default 6. */
  sameModuleLimit?: number;
}

const DEFAULTS = Object.freeze({
  maxDepth: 1,
  maxExpandedCandidates: 24,
  includeSameModule: true,
  sameModuleLimit: 6,
});

const RELATION_BY_EDGE_TYPE: Readonly<Record<EdgeType, ExpansionRelation>> = Object.freeze({
  [EdgeType.Imports]: ExpansionRelation.Imports,
  [EdgeType.Calls]: ExpansionRelation.Calls,
  [EdgeType.References]: ExpansionRelation.References,
  [EdgeType.Contains]: ExpansionRelation.Contains,
});

interface PendingCandidate {
  depth: number;
  evidence: ExpansionEvidence[];
  seedSymbolIds: Set<SymbolId>;
}

// Expand outward from `seedSymbolIds` and return the neighbours that are NOT
// themselves seeds, deepest-first-bounded and capped. Deterministic: seeds are
// processed in sorted order, edges arrive id-ordered, and the result is sorted
// by (depth, symbolId).
export function expandGraphCandidates(
  db: Database,
  seedSymbolIds: readonly SymbolId[],
  options: GraphExpansionOptions = {},
): ExpandedCandidate[] {
  const maxDepth = clamp(options.maxDepth ?? DEFAULTS.maxDepth, 1, 2);
  const maxCandidates = Math.max(0, options.maxExpandedCandidates ?? DEFAULTS.maxExpandedCandidates);
  const includeSameModule = options.includeSameModule ?? DEFAULTS.includeSameModule;
  const sameModuleLimit = Math.max(0, options.sameModuleLimit ?? DEFAULTS.sameModuleLimit);

  const seeds = [...new Set(seedSymbolIds)].sort();
  if (seeds.length === 0 || maxCandidates === 0) {
    return [];
  }

  const seedSet = new Set(seeds);
  const pending = new Map<SymbolId, PendingCandidate>();
  // Track which seed a frontier symbol traces back to, so multi-hop evidence
  // still attributes a candidate to its originating seed(s).
  const frontierSeeds = new Map<SymbolId, Set<SymbolId>>();
  for (const seed of seeds) {
    frontierSeeds.set(seed, new Set([seed]));
  }

  let frontier = [...seeds];

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    if (frontier.length === 0) {
      break;
    }
    const edges = listEdgesForSymbols(db, frontier);
    const nextFrontier = new Set<SymbolId>();

    const considerNeighbour = (
      from: SymbolId,
      to: SymbolId,
      direction: "outgoing" | "incoming",
      relation: ExpansionRelation,
    ): void => {
      const originSeeds = frontierSeeds.get(from);
      if (originSeeds === undefined) {
        // `from` was not on the current frontier (it is the OTHER endpoint).
        return;
      }
      if (seedSet.has(to)) {
        return; // Already a seed; not a new candidate.
      }
      const existing = pending.get(to);
      const evidence: ExpansionEvidence = { relation, viaSymbolId: from, direction };
      if (existing === undefined) {
        pending.set(to, {
          depth,
          evidence: [evidence],
          seedSymbolIds: new Set(originSeeds),
        });
      } else {
        existing.evidence.push(evidence);
        for (const seed of originSeeds) {
          existing.seedSymbolIds.add(seed);
        }
      }
      const carried = frontierSeeds.get(to) ?? new Set<SymbolId>();
      for (const seed of originSeeds) {
        carried.add(seed);
      }
      frontierSeeds.set(to, carried);
      nextFrontier.add(to);
    };

    for (const edge of edges) {
      const relation = RELATION_BY_EDGE_TYPE[edge.edgeType];
      if (relation === undefined) {
        continue;
      }
      considerNeighbour(edge.srcSymbolId, edge.dstSymbolId, "outgoing", relation);
      considerNeighbour(edge.dstSymbolId, edge.srcSymbolId, "incoming", relation);
    }

    frontier = [...nextFrontier].sort();
  }

  if (includeSameModule && sameModuleLimit > 0) {
    addSameModuleNeighbours(db, seeds, seedSet, pending, sameModuleLimit);
  }

  return materialize(db, pending, maxCandidates);
}

// Surface same-directory siblings of each seed as depth-1 candidates. This is
// how an important nearby implementation file enters the pool even when no edge
// (TS/Cython emit few) connects it to a seed — Requirement 3's "centrality /
// neighbour expansion so important nearby files can enter the pool".
function addSameModuleNeighbours(
  db: Database,
  seeds: readonly SymbolId[],
  seedSet: ReadonlySet<SymbolId>,
  pending: Map<SymbolId, PendingCandidate>,
  perSeedLimit: number,
): void {
  const seedsById = getSymbolsByIds(db, seeds);
  const symbolsByDirectory = new Map<string, SymbolRecord[]>();
  for (const seedId of seeds) {
    const seed = seedsById.get(seedId);
    if (seed === undefined) {
      continue;
    }
    const directory = directoryOf(seed.filePath);
    let siblings = symbolsByDirectory.get(directory);
    if (siblings === undefined) {
      siblings = listSymbolsUnderDirectory(db, directory);
      symbolsByDirectory.set(directory, siblings);
    }

    let added = 0;
    for (const sibling of siblings) {
      if (added >= perSeedLimit) {
        break;
      }
      if (seedSet.has(sibling.id) || sibling.filePath === seed.filePath) {
        continue; // Skip seeds and same-file symbols (covered by contains edges).
      }
      const evidence: ExpansionEvidence = {
        relation: ExpansionRelation.SameModule,
        viaSymbolId: seedId,
        direction: "sibling",
      };
      const existing = pending.get(sibling.id);
      if (existing === undefined) {
        pending.set(sibling.id, {
          depth: 1,
          evidence: [evidence],
          seedSymbolIds: new Set([seedId]),
        });
      } else {
        existing.evidence.push(evidence);
        existing.seedSymbolIds.add(seedId);
      }
      added += 1;
    }
  }
}

function materialize(
  db: Database,
  pending: ReadonlyMap<SymbolId, PendingCandidate>,
  maxCandidates: number,
): ExpandedCandidate[] {
  const candidates: ExpandedCandidate[] = [];
  const symbolsById = getSymbolsByIds(db, [...pending.keys()]);
  for (const [symbolId, info] of pending) {
    const symbol = symbolsById.get(symbolId);
    if (symbol === undefined) {
      continue;
    }
    // Structural scopes are graph nodes, not deliverable content. The walk above
    // still traverses THROUGH them — that bridging is the reason they exist — but
    // a <module> must never surface as a candidate the packer can select, quote,
    // or spend budget on. Filtering here rather than in the walk keeps the bridge
    // and drops only the delivery.
    if (isStructuralSymbolKind(symbol.kind)) {
      continue;
    }
    candidates.push({
      symbol,
      depth: info.depth,
      evidence: dedupeEvidence(info.evidence),
      seedSymbolIds: [...info.seedSymbolIds].sort(),
    });
  }
  candidates.sort(
    (left, right) => left.depth - right.depth || left.symbol.id.localeCompare(right.symbol.id),
  );
  return candidates.slice(0, maxCandidates);
}

// ----- centrality -------------------------------------------------------------

// Global in-degree per symbol: how many DEPENDENT SYMBOLS point AT it across the
// whole graph. A high in-degree means many things depend on the symbol, so among
// otherwise-similar candidates it is the more likely shared implementation
// target. Returned as raw counts; the hybrid scorer normalises against the pool.
//
// Structural sources are excluded. A `<module>` scope owns its file's imports so
// those edges have a stable owner, but it is not a symbol anyone can retrieve,
// select, or edit — counting it would report a module/file dependency inside a
// number that is surfaced to the model as "N indexed symbol(s) depend on this"
// and used to order pivots. The edges themselves stay in the graph and remain
// available to every other consumer; only this centrality metric filters them.
// Module-import fan-in, if it later proves useful for ranking, belongs in an
// explicit separate feature rather than overloaded onto this count.
export function computeInDegreeCentrality(
  db: Database,
  symbolIds: readonly SymbolId[],
): Map<SymbolId, number> {
  const ids = [...new Set(symbolIds)];
  const centrality = new Map<SymbolId, number>();
  for (const id of ids) {
    centrality.set(id, 0);
  }
  if (ids.length === 0) {
    return centrality;
  }
  const idSet = new Set(ids);
  const incoming = listEdgesForSymbols(db, ids)
    .filter((edge) => idSet.has(edge.dstSymbolId));
  const structuralSources = structuralSymbolIds(
    db,
    incoming.map((edge) => edge.srcSymbolId),
  );
  for (const edge of incoming) {
    if (structuralSources.has(edge.srcSymbolId)) {
      continue;
    }
    centrality.set(edge.dstSymbolId, (centrality.get(edge.dstSymbolId) ?? 0) + 1);
  }
  return centrality;
}

// The subset of `symbolIds` whose symbols are structural scopes. Resolved in one
// batched lookup rather than per edge, since a hub's adjacency can be large.
function structuralSymbolIds(
  db: Database,
  symbolIds: readonly SymbolId[],
): Set<SymbolId> {
  const unique = [...new Set(symbolIds)];
  if (unique.length === 0) {
    return new Set();
  }
  const structural = new Set<SymbolId>();
  for (const symbol of getSymbolsByIds(db, unique).values()) {
    if (isStructuralSymbolKind(symbol.kind)) {
      structural.add(symbol.id);
    }
  }
  return structural;
}

// ----- helpers ----------------------------------------------------------------

function directoryOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "" : filePath.slice(0, index);
}

function dedupeEvidence(evidence: readonly ExpansionEvidence[]): ExpansionEvidence[] {
  const seen = new Set<string>();
  const out: ExpansionEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.relation}\0${item.viaSymbolId}\0${item.direction}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out.sort(
    (left, right) =>
      left.relation.localeCompare(right.relation)
      || left.viaSymbolId.localeCompare(right.viaSymbolId)
      || left.direction.localeCompare(right.direction),
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
