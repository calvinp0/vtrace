// Debug-intent role refinement.
//
// The base role gate (`assignCandidateRoles`) scores each candidate in
// ISOLATION. For a debug task that is the wrong unit of analysis: the candidate
// with the best lexical match to the issue TITLE is often a thin wrapper/entry
// point, while the real edit site is a helper it CALLS, and a generic parser
// class from another subsystem can ride a coincidental lexical hit into a pivot.
//
// This module re-decides roles for debug intent using three structural signals
// the per-candidate scorecard cannot express:
//
//   * entry-point / caller   — a function that DELEGATES to several issue-relevant
//                              local helpers; the edit site is the helper, not it;
//   * implementation helper  — a local function whose name matches the issue and
//                              that does the actual work (a leaf, or a dispatcher's
//                              callee); promoted to pivot even on weak lexical;
//   * generic infrastructure — a class/parser OUTSIDE the issue's subsystem with
//                              no direct issue/test evidence; support at most.
//
// It is purely index-driven (in-pool `calls` edges + the shaped query); it
// hardcodes no file paths or instance ids.

import type { Database } from "bun:sqlite";

import {
  CandidateRole,
  type RoledCandidate,
} from "../capsule/assignCandidateRoles";
import { listEdgesForSymbols } from "../db/repositories/edgesRepository";
import { EdgeType, SymbolKind } from "../domain/types";
import type { ShapedSweQuery } from "../capsule/sweQueryShaping";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { tokenize } from "../retrieval/hybridScoring";
import type { HybridCandidate } from "../retrieval/hybridRetrieval";
import {
  type DebugRoleSignals,
  type NoContextExplanation,
} from "./types";

export interface RefinedRoledCandidate {
  candidate: HybridCandidate;
  role: CandidateRole;
  /** Clean, role-decisive justification (no `pivot:`/`support:` prefix). */
  roleReason: string;
  signals: DebugRoleSignals;
}

// Boilerplate/structural tokens the shaped query injects, plus generic verbs that
// carry no edit-target signal. Kept small and conservative.
const STOPWORDS: ReadonlySet<string> = new Set([
  "fix", "the", "for", "and", "with", "that", "this", "into", "from", "when",
  "does", "not", "should", "must", "will", "have", "has", "but", "all", "any",
  "failing", "test", "tests", "issue", "issues", "repo", "file", "files",
  "symbol", "symbols", "based", "set", "use", "using", "via", "per", "out",
  "new", "get", "self", "add", "produces", "produce", "wrong",
]);

const MIN_TOKEN_LENGTH = 3;
// A helper whose name overlaps the issue by at least this many tokens is treated
// as a likely edit site on name evidence alone.
const HELPER_NAME_OVERLAP = 2;
// A function delegating to at least this many issue-relevant local helpers is a
// wrapper/dispatcher rather than the edit site.
const DISPATCHER_FANOUT = 2;

const ACTIONABLE_FUNCTION_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
]);

/**
 * Re-assign roles for debug intent. Returns one refined entry per input
 * candidate (input order preserved), with structural signals and a clean role
 * reason, after capping pivots to `maxPivots` by final score.
 */
export function refineDebugRoles(
  db: Database,
  base: readonly RoledCandidate[],
  shaped: ShapedSweQuery,
  maxPivots: number,
): RefinedRoledCandidate[] {
  const ids = base.map((entry) => entry.candidate.symbolId);
  const idSet = new Set(ids);
  const byId = new Map(base.map((entry) => [entry.candidate.symbolId, entry] as const));

  // In-pool call graph: only `calls` edges with BOTH endpoints in the pool.
  const callsOut = new Map<string, Set<string>>();
  const callsIn = new Map<string, Set<string>>();
  for (const edge of listEdgesForSymbols(db, ids)) {
    if (edge.edgeType !== EdgeType.Calls) {
      continue;
    }
    if (!idSet.has(edge.srcSymbolId) || !idSet.has(edge.dstSymbolId)) {
      continue;
    }
    addEdge(callsOut, edge.srcSymbolId, edge.dstSymbolId);
    addEdge(callsIn, edge.dstSymbolId, edge.srcSymbolId);
  }

  const issueTokens = collectIssueTokens(shaped);
  const nameOverlap = (candidate: HybridCandidate): number =>
    nameTokens(candidate.localName).filter((token) => issueTokens.has(token)).length;

  const subsystemDir = resolveLocalSubsystem(base, nameOverlap);
  const inLocalSubsystem = (candidate: HybridCandidate): boolean =>
    subsystemDir !== undefined && samePackage(dirname(candidate.filePath), subsystemDir);

  const isQualifyingHelper = (candidate: HybridCandidate): boolean =>
    !isLikelyTestCandidate(candidate)
    && ACTIONABLE_FUNCTION_KINDS.has(candidate.kind)
    && inLocalSubsystem(candidate)
    && hasLocalEvidence(candidate)
    && (nameOverlap(candidate) >= 1 || candidate.scores.domain > 0);

  const isDispatcher = (entry: RoledCandidate): boolean => {
    if (isLikelyTestCandidate(entry.candidate) || !ACTIONABLE_FUNCTION_KINDS.has(entry.candidate.kind)) {
      return false;
    }
    const callees = callsOut.get(entry.candidate.symbolId) ?? new Set<string>();
    let qualifying = 0;
    for (const calleeId of callees) {
      const callee = byId.get(calleeId);
      if (callee !== undefined && isQualifyingHelper(callee.candidate)) {
        qualifying += 1;
      }
    }
    return qualifying >= DISPATCHER_FANOUT;
  };

  const isCalledByDispatcher = (symbolId: string): boolean => {
    for (const callerId of callsIn.get(symbolId) ?? new Set<string>()) {
      const caller = byId.get(callerId);
      if (caller !== undefined && isDispatcher(caller)) {
        return true;
      }
    }
    return false;
  };

  const refined: RefinedRoledCandidate[] = base.map((entry) => {
    const candidate = entry.candidate;
    const dispatcher = isDispatcher(entry);
    const genericInfra = isGenericInfrastructure(candidate, inLocalSubsystem(candidate), nameOverlap(candidate));
    const helper =
      !dispatcher
      && isQualifyingHelper(candidate)
      && (nameOverlap(candidate) >= HELPER_NAME_OVERLAP || isCalledByDispatcher(candidate.symbolId));

    let role = entry.role;
    let roleReason = stripRolePrefix(entry.why);

    if (genericInfra && candidate.scores.testToImpl === 0) {
      role = CandidateRole.Support;
      roleReason =
        `generic infrastructure outside the issue's subsystem (${candidate.kind}) `
        + "— support only without direct failing-test or issue evidence";
    } else if (helper) {
      role = CandidateRole.Pivot;
      roleReason = isCalledByDispatcher(candidate.symbolId)
        ? "local implementation helper invoked by the entry point — likely edit site"
        : "local implementation helper whose name matches the issue — likely edit site";
    }
    if (dispatcher) {
      role = CandidateRole.Support;
      roleReason = "entry point/caller delegating to local helpers — the edit site is the helper it calls";
    }

    return {
      candidate,
      role,
      roleReason,
      signals: {
        is_entry_point: dispatcher,
        is_implementation_helper: helper,
        is_generic_infrastructure: genericInfra,
      },
    };
  });

  return capPivots(refined, maxPivots);
}

/** Wrap base roles unchanged (non-debug intents): no structural signals. */
export function passthroughRoles(base: readonly RoledCandidate[]): RefinedRoledCandidate[] {
  return base.map((entry) => ({
    candidate: entry.candidate,
    role: entry.role,
    roleReason: stripRolePrefix(entry.why),
    signals: {
      is_entry_point: false,
      is_implementation_helper: false,
      is_generic_infrastructure: false,
    },
  }));
}

/**
 * Explain a no-context decision: for the strongest non-test near-misses, why
 * each failed the pivot gate. Makes "no high-confidence edit target" auditable.
 */
export function buildNoContextExplanations(
  refined: readonly RefinedRoledCandidate[],
  shaped: ShapedSweQuery,
  limit = 3,
): NoContextExplanation[] {
  const issueTokens = collectIssueTokens(shaped);
  return refined
    .filter((entry) => !isLikelyTestCandidate(entry.candidate))
    .slice(0, limit)
    .map((entry) => ({
      path: entry.candidate.filePath,
      symbol: entry.candidate.localName,
      why_not_pivot: whyNotPivot(entry, issueTokens),
    }));
}

// --- structural predicates ----------------------------------------------------

// A candidate is generic infrastructure (support at most) when it is OUTSIDE the
// issue's subsystem, has no direct issue/test pointer (symbol-name / likely-file
// / failing-test), and its name barely overlaps the issue — i.e. it was reached
// through graph expansion or a coincidental lexical hit, not because the issue is
// about it. Applies to any kind (a regex `Group` class OR a `normalize` helper in
// another package): centrality/graph reach must not promote it to a pivot.
function isGenericInfrastructure(
  candidate: HybridCandidate,
  inLocalSubsystem: boolean,
  nameOverlap: number,
): boolean {
  if (isLikelyTestCandidate(candidate) || inLocalSubsystem) {
    return false;
  }
  const directEvidence =
    candidate.scores.symbol > 0 || candidate.scores.path > 0 || candidate.scores.testToImpl > 0;
  if (directEvidence || nameOverlap >= HELPER_NAME_OVERLAP) {
    return false;
  }
  return true;
}

function whyNotPivot(entry: RefinedRoledCandidate, issueTokens: ReadonlySet<string>): string {
  if (entry.signals.is_generic_infrastructure) {
    return "generic infrastructure outside the issue's subsystem with no direct issue/test evidence";
  }
  const s = entry.candidate.scores;
  const reasons: string[] = [];
  if (s.actionability !== 1) {
    reasons.push(`low-actionability ${entry.candidate.kind}`);
  }
  if (s.testToImpl === 0) {
    reasons.push("no failing-test route");
  }
  if (s.symbol === 0 && s.path === 0) {
    reasons.push("no symbol-name or likely-file pointer");
  }
  if (s.lexical < 0.5) {
    reasons.push(`weak lexical match (${s.lexical} < 0.5)`);
  }
  const overlap = nameTokens(entry.candidate.localName).filter((token) => issueTokens.has(token)).length;
  if (overlap < HELPER_NAME_OVERLAP) {
    reasons.push(`issue name-overlap ${overlap} (< ${HELPER_NAME_OVERLAP})`);
  }
  return reasons.length > 0 ? reasons.join("; ") : "did not clear the pivot bar";
}

// --- helpers ------------------------------------------------------------------

// Cap pivots to `maxPivots` by final score; demote the rest to support. Stable:
// ties broken by fqName then symbolId so the kept set is deterministic.
function capPivots(
  refined: RefinedRoledCandidate[],
  maxPivots: number,
): RefinedRoledCandidate[] {
  const pivotIds = refined
    .filter((entry) => entry.role === CandidateRole.Pivot)
    .sort(
      (left, right) =>
        right.candidate.scores.final - left.candidate.scores.final
        || left.candidate.fqName.localeCompare(right.candidate.fqName)
        || left.candidate.symbolId.localeCompare(right.candidate.symbolId),
    )
    .slice(0, Math.max(0, maxPivots))
    .map((entry) => entry.candidate.symbolId);
  const keep = new Set(pivotIds);

  return refined.map((entry) => {
    if (entry.role === CandidateRole.Pivot && !keep.has(entry.candidate.symbolId)) {
      return {
        ...entry,
        role: CandidateRole.Support,
        roleReason: `strong target beyond the pivot budget — ${entry.roleReason}`,
      };
    }
    return entry;
  });
}

// The issue's local subsystem: the directory shared by the most issue-anchored,
// non-test candidates. Ties broken lexicographically for determinism.
function resolveLocalSubsystem(
  base: readonly RoledCandidate[],
  nameOverlap: (candidate: HybridCandidate) => number,
): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of base) {
    const candidate = entry.candidate;
    if (isLikelyTestCandidate(candidate)) {
      continue;
    }
    const s = candidate.scores;
    const anchored =
      nameOverlap(candidate) >= 1 || s.domain > 0 || s.lexical >= 0.2 || s.symbol > 0 || s.path > 0;
    if (!anchored) {
      continue;
    }
    const dir = dirname(candidate.filePath);
    if (dir.length === 0) {
      continue;
    }
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === undefined || dir < best))) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

function hasLocalEvidence(candidate: HybridCandidate): boolean {
  const s = candidate.scores;
  return s.localEvidence > 0 || s.lexical > 0 || s.domain > 0;
}

function nameTokens(localName: string): string[] {
  return tokenize(localName).filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function collectIssueTokens(shaped: ShapedSweQuery): Set<string> {
  const tokens = new Set<string>();
  const sources = [
    ...tokenize(shaped.query),
    ...shaped.identifiers.flatMap(tokenize),
    ...shaped.likelySymbols.flatMap(tokenize),
  ];
  for (const token of sources) {
    if (token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function samePackage(dir: string, subsystem: string): boolean {
  return dir === subsystem || dir.startsWith(`${subsystem}/`) || subsystem.startsWith(`${dir}/`);
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function addEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  const existing = map.get(from);
  if (existing === undefined) {
    map.set(from, new Set([to]));
  } else {
    existing.add(to);
  }
}

function stripRolePrefix(why: string): string {
  return why.replace(/^(pivot|support|discard):\s*/i, "");
}
