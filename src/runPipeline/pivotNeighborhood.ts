// Pivot-neighborhood enrichment for the product Capsule v2 run_pipeline path.
//
// Why this exists: the `flow` and `impact` sections only emit source excerpts
// when the query resolves two flow endpoints (flow) or carries refactor-like
// intent (impact). Normal debug/modify queries trigger neither, so they got zero
// inline relationship source even though Capsule v2 had already pinned the right
// pivots. This module closes that gap: after Capsule v2 selects pivots, it walks
// a small, bounded neighborhood around the top pivot(s) and attaches honest,
// freshness-gated symbol-window excerpts so a debug query gets useful nearby
// source without an explicit flow/impact trigger.
//
// Honesty contract: indexed edges carry no call-site line, so every excerpt is
// the NEIGHBOR symbol's own indexed span (a symbol-window), never an exact
// call/reference line. The `reason` names the structural relationship the
// neighbor was reached through (caller/callee/importer/imported/reference/
// support/sibling); `fallback_symbol_window` is used only for a same-file
// neighbor reached through no edge at all. We never claim a window is an exact
// edge site.
//
// Scope discipline: this does NOT tune retrieval, change Capsule v2
// ranking/scoring/candidate generation, or replace the flow/impact sections. It
// is a pure, additive read over already-selected pivots. Building it never fails
// run_pipeline: any per-pivot or per-neighbor failure degrades to a skipped
// marker, and a total failure degrades to an empty section.

import type { Database } from "bun:sqlite";

import { listEdgesForSymbol } from "../db/repositories/edgesRepository";
import {
  getSymbolById,
  listSymbolsByFqName,
  listSymbolsForFile,
} from "../db/repositories/symbolsRepository";
import { EdgeType, type EdgeRecord, type SymbolRecord } from "../domain/types";
import {
  buildSymbolSourceExcerpt,
  type SymbolExcerptMode,
} from "../source/sourceExcerpt";
import type { CapsuleV2ProductResponse } from "../capsuleV2/productAdapter";

export type PivotNeighborhoodReason =
  | "caller"
  | "callee"
  | "importer"
  | "imported"
  | "reference"
  | "support"
  | "sibling"
  | "fallback_symbol_window";

export interface PivotNeighborhoodExcerpt {
  readonly filePath: string;
  readonly symbol: string | null;
  readonly fqName: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly reason: PivotNeighborhoodReason;
  readonly truncated: boolean;
}

export interface PivotNeighborhoodSkip {
  readonly target: string;
  readonly reason: string;
}

export interface PivotNeighborhoodContext {
  readonly pivot: {
    readonly path: string;
    readonly symbol: string | null;
    readonly fqName: string | null;
  };
  readonly excerpts: readonly PivotNeighborhoodExcerpt[];
  readonly skipped?: readonly PivotNeighborhoodSkip[];
}

export const PIVOT_NEIGHBORHOOD_DEFAULTS = Object.freeze({
  /** Top pivots seeded (only the strongest 1-2 anchor the neighborhood). */
  maxPivots: 2,
  /** Excerpts emitted per pivot before the budget cuts off. */
  maxExcerptsPerPivot: 4,
});

// Deterministic priority of relationship reasons: stronger/structurally-closer
// relationships first, generic same-file windows last. Used to order candidates
// and to keep the highest-priority reason when a neighbor is reachable two ways.
const REASON_PRIORITY: Record<PivotNeighborhoodReason, number> = {
  support: 0,
  caller: 1,
  callee: 2,
  importer: 3,
  imported: 4,
  reference: 5,
  sibling: 6,
  fallback_symbol_window: 7,
};

// Which excerpt window each relationship gets. Relationship sites where the body
// shows the interaction get the wider span window; identity-only neighbors get
// the tighter signature window. Both are still hard-bounded by the source helper.
const REASON_MODE: Record<PivotNeighborhoodReason, SymbolExcerptMode> = {
  support: "signature",
  caller: "span",
  callee: "span",
  importer: "signature",
  imported: "signature",
  reference: "span",
  sibling: "signature",
  fallback_symbol_window: "signature",
};

export interface BuildPivotNeighborhoodsOptions {
  readonly maxPivots?: number;
  readonly maxExcerptsPerPivot?: number;
}

interface NeighborCandidate {
  readonly symbol: SymbolRecord;
  readonly reason: PivotNeighborhoodReason;
}

/**
 * Build bounded pivot-neighborhood contexts for a Capsule v2 product response.
 * Returns [] when there is no pivot symbol identity to anchor on, or when the
 * response is not a v2 capsule. Never throws.
 */
export function buildPivotNeighborhoods(
  db: Database,
  repoRoot: string,
  capsuleV2: CapsuleV2ProductResponse,
  options?: BuildPivotNeighborhoodsOptions,
): PivotNeighborhoodContext[] {
  try {
    const maxPivots = options?.maxPivots ?? PIVOT_NEIGHBORHOOD_DEFAULTS.maxPivots;
    const maxExcerptsPerPivot =
      options?.maxExcerptsPerPivot ?? PIVOT_NEIGHBORHOOD_DEFAULTS.maxExcerptsPerPivot;

    const pivots = Array.isArray(capsuleV2.pivots) ? capsuleV2.pivots : [];
    const support = Array.isArray(capsuleV2.support) ? capsuleV2.support : [];

    const contexts: PivotNeighborhoodContext[] = [];

    for (const pivot of pivots.slice(0, Math.max(0, maxPivots))) {
      contexts.push(
        buildOnePivotNeighborhood(db, repoRoot, pivot, support, maxExcerptsPerPivot),
      );
    }

    return contexts;
  } catch {
    return [];
  }
}

function buildOnePivotNeighborhood(
  db: Database,
  repoRoot: string,
  pivot: CapsuleV2ProductResponse["pivots"][number],
  support: CapsuleV2ProductResponse["support"],
  maxExcerptsPerPivot: number,
): PivotNeighborhoodContext {
  const pivotHeader = {
    path: pivot.path,
    symbol: pivot.symbol ?? null,
    fqName: pivot.fqName ?? null,
  };
  const skipped: PivotNeighborhoodSkip[] = [];

  const pivotSymbol = resolveUniqueSymbol(db, pivot.fqName);

  if (pivotSymbol === null) {
    skipped.push({
      target: pivot.fqName ?? pivot.path,
      reason: "pivot_symbol_unresolved",
    });
    return { pivot: pivotHeader, excerpts: [], skipped };
  }

  const candidates = collectNeighborCandidates(db, pivotSymbol, support);
  const excerpts: PivotNeighborhoodExcerpt[] = [];

  for (const candidate of candidates) {
    if (excerpts.length >= maxExcerptsPerPivot) {
      break;
    }

    const excerpt = buildSymbolSourceExcerpt(db, repoRoot, candidate.symbol.id, {
      mode: REASON_MODE[candidate.reason],
    });

    if (excerpt === null) {
      skipped.push({ target: candidate.symbol.fqName, reason: "source_unavailable" });
      continue;
    }

    excerpts.push({
      filePath: excerpt.filePath,
      symbol: candidate.symbol.localName,
      fqName: candidate.symbol.fqName,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      text: excerpt.text,
      // The relationship is what we know for certain; downgrade to the honest
      // generic window label only when the source helper itself fell back to a
      // truncated head window AND the relationship was already the generic one.
      reason: candidate.reason,
      truncated: excerpt.truncated,
    });
  }

  return {
    pivot: pivotHeader,
    excerpts,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/**
 * Gather neighbor candidates around a pivot symbol in deterministic priority
 * order, deduplicated by symbol id (keeping the highest-priority reason), and
 * never including the pivot itself.
 */
function collectNeighborCandidates(
  db: Database,
  pivotSymbol: SymbolRecord,
  support: CapsuleV2ProductResponse["support"],
): NeighborCandidate[] {
  const byId = new Map<string, NeighborCandidate>();

  const consider = (symbol: SymbolRecord | null, reason: PivotNeighborhoodReason): void => {
    if (symbol === null || symbol.id === pivotSymbol.id) {
      return;
    }

    const existing = byId.get(symbol.id);
    if (existing === undefined || REASON_PRIORITY[reason] < REASON_PRIORITY[existing.reason]) {
      byId.set(symbol.id, { symbol, reason });
    }
  };

  // 1. Capsule v2 support items in the pivot's file or directory, if they carry
  //    a resolvable symbol identity. These are already vetted as relevant.
  const pivotDir = directoryOf(pivotSymbol.filePath);
  for (const item of support) {
    if (item.path !== pivotSymbol.filePath && directoryOf(item.path) !== pivotDir) {
      continue;
    }
    consider(resolveUniqueSymbol(db, item.fqName), "support");
  }

  // 2. Direct graph neighbors of the pivot symbol (cheap single-symbol edge
  //    lookup). Direction + edge type name the relationship honestly.
  for (const edge of listEdgesForSymbol(db, pivotSymbol.id)) {
    const reason = classifyEdge(edge, pivotSymbol.id);
    if (reason === null) {
      continue;
    }
    const otherId = edge.srcSymbolId === pivotSymbol.id ? edge.dstSymbolId : edge.srcSymbolId;
    consider(getSymbolById(db, otherId) ?? null, reason);
  }

  // 3. Same-file neighbors. True structural siblings (same parent scope/class)
  //    are labeled `sibling`; any other same-file symbol is a generic
  //    `fallback_symbol_window` so it is never mistaken for an edge relationship.
  for (const symbol of listSymbolsForFile(db, pivotSymbol.filePath)) {
    if (symbol.id === pivotSymbol.id) {
      continue;
    }
    const isSibling =
      pivotSymbol.parentSymbolId !== undefined
      && symbol.parentSymbolId === pivotSymbol.parentSymbolId;
    consider(symbol, isSibling ? "sibling" : "fallback_symbol_window");
  }

  return [...byId.values()].sort(compareCandidates);
}

function classifyEdge(edge: EdgeRecord, pivotId: string): PivotNeighborhoodReason | null {
  const pivotIsSrc = edge.srcSymbolId === pivotId;
  const pivotIsDst = edge.dstSymbolId === pivotId;

  if (!pivotIsSrc && !pivotIsDst) {
    return null;
  }

  switch (edge.edgeType) {
    case EdgeType.Calls:
      // Stored direction is caller -> callee. A dst-pivot has callers; a
      // src-pivot has callees.
      return pivotIsDst ? "caller" : "callee";
    case EdgeType.Imports:
      // Stored direction is importer -> imported.
      return pivotIsDst ? "importer" : "imported";
    case EdgeType.References:
      return "reference";
    default:
      // contains / unknown edges are not useful relationship excerpts.
      return null;
  }
}

function compareCandidates(left: NeighborCandidate, right: NeighborCandidate): number {
  return (
    REASON_PRIORITY[left.reason] - REASON_PRIORITY[right.reason]
    || left.symbol.filePath.localeCompare(right.symbol.filePath)
    || left.symbol.fqName.localeCompare(right.symbol.fqName)
    || left.symbol.startByte - right.symbol.startByte
    || left.symbol.id.localeCompare(right.symbol.id)
  );
}

/**
 * Resolve a fully qualified name to a single indexed symbol. Returns null for a
 * missing, blank, or ambiguous name (Capsule v2 items carry no DB symbol id, so
 * the fqName is the only identity handle; ambiguity is treated as unresolved
 * rather than guessed).
 */
function resolveUniqueSymbol(db: Database, fqName: string | null | undefined): SymbolRecord | null {
  if (typeof fqName !== "string" || fqName.length === 0) {
    return null;
  }

  const matches = listSymbolsByFqName(db, fqName);
  return matches.length === 1 ? matches[0]! : null;
}

function directoryOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}
