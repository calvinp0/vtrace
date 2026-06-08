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
import { GENERIC_TOKEN_STOPLIST, type ShapedSweQuery } from "../capsule/sweQueryShaping";
import { isLikelyTestCandidate } from "../retrieval/searchSymbolsShared";
import { tokenize } from "../retrieval/hybridScoring";
import type { HybridCandidate } from "../retrieval/hybridRetrieval";
import {
  isQueryBuilderEntrypointSymbol,
  isSqlRenderingImplementationSymbol,
  sqlRenderingRelevance,
} from "./sqlRenderingBackfill";
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

/**
 * `Class.method` expansion result: the symbol ids of the containing class(es) an
 * issue named (e.g. `ModelAdmin`) and of the EXISTING nearby methods recovered
 * under them (e.g. `get_inline_instances`), with each method's overlap score with
 * the requested method/issue. The role refinement uses this to prefer the
 * actionable method edit-sites over the broad class.
 */
export interface ClassMethodExpansion {
  classSymbolIds: ReadonlySet<string>;
  methodSymbolIds: ReadonlySet<string>;
  methodScores: ReadonlyMap<string, number>;
}

export interface RefineDebugRolesOptions {
  /**
   * Resolve a candidate's focused source text by symbol id. When the static call
   * graph lacks a `calls` edge for an in-pool dispatcher (the parser missed or
   * could not resolve it), the refinement falls back to scanning the source body
   * for direct calls to other in-pool candidate names. Optional: omitted, the
   * fallback is simply skipped and only static edges are used.
   */
  sourceTextOf?: (symbolId: string) => string | undefined;
  /**
   * `Class.method` expansion targets. When present, recovered existing methods are
   * promoted as edit-sites over their containing class. Optional.
   */
  expansion?: ClassMethodExpansion;
  /**
   * SQL-rendering bug context. Present when the issue describes query composition
   * plus SQL rendering/output behaviour: the SQL rendering implementation (e.g.
   * `SQLCompiler.get_combinator_sql`) is promoted to pivot and the query-builder
   * public API (e.g. `QuerySet.values_list`) demoted to support. `compositionTerms`
   * are the composition words found in the task, used to rank rendering pivots.
   */
  sqlRendering?: { compositionTerms: ReadonlySet<string> };
  /**
   * File-line anchor targets. When the task prose cited a source anchor (e.g.
   * `compiler.py#L428-L433`) that resolved to an indexed symbol, its id is here:
   * the symbol is promoted to pivot (unless it is a test or a low-actionability
   * kind) and ranked first among pivots — the issue named the edit site outright.
   */
  lineAnchor?: { symbolIds: ReadonlySet<string> };
}

export interface RefineDebugResult {
  refined: RefinedRoledCandidate[];
  /** The issue subsystem directory the refinement inferred (if any). */
  subsystemRoot?: string;
  /** True when a dispatcher->helper call was recovered from source bodies. */
  sourceBodyCallFallbackUsed: boolean;
}

// Boilerplate/structural tokens the shaped query injects, plus generic verbs that
// carry no edit-target signal. Kept small and conservative.
export const STOPWORDS: ReadonlySet<string> = new Set([
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
  options: RefineDebugRolesOptions = {},
): RefineDebugResult {
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

  // Source-body call fallback: when the static graph gave an actionable candidate
  // no in-pool callees, inspect its source body for direct calls to other in-pool
  // candidate names (e.g. `simplify_regex` calling `replace_named_groups(...)`).
  // This recovers the dispatcher->helper split when the parser missed the edge,
  // without hardcoding any instance.
  const sourceBodyCallFallbackUsed = addSourceBodyCalls(base, callsOut, callsIn, options.sourceTextOf);

  const issueTokens = collectIssueTokens(shaped);
  const nameOverlap = (candidate: HybridCandidate): number =>
    nameTokens(candidate.localName).filter((token) => issueTokens.has(token)).length;

  const subsystemDir = resolveLocalSubsystem(base, nameOverlap, issueTokens);
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

  const expansion = options.expansion;
  const isExpansionTarget = (symbolId: string): boolean =>
    expansion?.methodSymbolIds.has(symbolId) ?? false;
  const isContainingClass = (symbolId: string): boolean =>
    expansion?.classSymbolIds.has(symbolId) ?? false;
  // Only demote a containing class when at least one of its recovered methods is
  // actually in the pool — otherwise the class is the best target we have.
  const hasExpansionTargetInPool = base.some((entry) => isExpansionTarget(entry.candidate.symbolId));

  // A body-literal hit on a function/method is the most specific edit site; when one
  // exists, the containing CLASS that also carries the literal (its body encloses the
  // method) is context, not the target.
  const hasBodyLiteralMethodInPool = base.some(
    (entry) =>
      entry.candidate.scores.bodyLiteral > 0
      && ACTIONABLE_FUNCTION_KINDS.has(entry.candidate.kind)
      && !isLikelyTestCandidate(entry.candidate),
  );

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

    // Class.method expansion overrides (applied last, so they win): a recovered
    // EXISTING method is the actionable edit site — more specific than the broad
    // containing class, which is demoted to context when such a method is present.
    let isClassMethodExpansionTarget = false;
    let isContainingClassContext = false;
    let entryPoint = dispatcher;
    let implementationHelper = helper;
    if (
      isExpansionTarget(candidate.symbolId)
      && ACTIONABLE_FUNCTION_KINDS.has(candidate.kind)
      && !isLikelyTestCandidate(candidate)
    ) {
      role = CandidateRole.Pivot;
      roleReason =
        "existing method recovered from Class.method expansion — more actionable than containing class";
      isClassMethodExpansionTarget = true;
      implementationHelper = true;
      entryPoint = false;
    } else if (isContainingClass(candidate.symbolId) && hasExpansionTargetInPool) {
      role = CandidateRole.Support;
      roleReason = "containing class for recovered edit-site methods";
      isContainingClassContext = true;
    }

    // SQL query-builder / renderer split (applied last, so it wins for a composed-
    // query SQL-output bug): the compiler/rendering implementation IN the issue
    // subsystem is the actual edit site, while the public query-construction API is
    // only the entry point. Centrality/lexical never reverse this for such a bug.
    let isQueryBuilderEntrypoint = false;
    let isSqlRenderingImplementation = false;
    if (options.sqlRendering !== undefined && !isLikelyTestCandidate(candidate)) {
      if (
        isSqlRenderingImplementationSymbol(candidate.localName, candidate.filePath, candidate.kind)
        && inLocalSubsystem(candidate)
      ) {
        role = CandidateRole.Pivot;
        roleReason = "SQL rendering implementation for combined-query output bug";
        isSqlRenderingImplementation = true;
        implementationHelper = true;
        entryPoint = false;
      } else if (isQueryBuilderEntrypointSymbol(candidate.localName)) {
        role = CandidateRole.Support;
        roleReason =
          "query-construction API entry point — the edit site is the SQL rendering implementation it composes";
        isQueryBuilderEntrypoint = true;
        entryPoint = true;
        implementationHelper = false;
      }
    }

    // Body-literal override (applied last, so it wins): the issue cited a
    // distinctive literal — a diagnostic/error code or a quoted message — that
    // appears in THIS symbol's source body. Like a line anchor, that is an explicit
    // edit-site signal (the bug names exactly what this code emits). A function/
    // method match becomes the pivot; a containing class is demoted to context when
    // such a method is in the pool, else it is itself the target. Test symbols and
    // low-actionability kinds are never promoted.
    if (
      candidate.scores.bodyLiteral > 0
      && !isLikelyTestCandidate(candidate)
    ) {
      if (ACTIONABLE_FUNCTION_KINDS.has(candidate.kind)) {
        role = CandidateRole.Pivot;
        roleReason = "task diagnostic literal appears in this symbol's body — explicit edit site";
        implementationHelper = true;
        entryPoint = false;
      } else if (candidate.kind === SymbolKind.Class && hasBodyLiteralMethodInPool) {
        role = CandidateRole.Support;
        roleReason = "containing class for the body-literal edit-site method";
        isContainingClassContext = true;
      } else if (isAnchorActionableKind(candidate.kind)) {
        role = CandidateRole.Pivot;
        roleReason = "task diagnostic literal appears in this symbol's body — explicit edit site";
        implementationHelper = true;
        entryPoint = false;
      }
    }

    // File-line anchor override (applied last, so it wins): the issue cited this
    // exact symbol by file + line range. That is the most explicit edit-site
    // signal there is, so it becomes the pivot — UNLESS it is a test symbol or a
    // low-actionability kind (a module variable the line happened to fall on),
    // which an anchor must not blindly promote into production context.
    if (
      options.lineAnchor?.symbolIds.has(candidate.symbolId)
      && isAnchorActionableKind(candidate.kind)
      && !isLikelyTestCandidate(candidate)
    ) {
      role = CandidateRole.Pivot;
      roleReason = "source line anchor in the issue points at this symbol — explicit edit site";
      implementationHelper = true;
      entryPoint = false;
    }

    return {
      candidate,
      role,
      roleReason,
      signals: {
        is_entry_point: entryPoint,
        is_implementation_helper: implementationHelper,
        is_generic_infrastructure: genericInfra,
        is_class_method_expansion_target: isClassMethodExpansionTarget,
        is_containing_class_context: isContainingClassContext,
        is_query_builder_entrypoint: isQueryBuilderEntrypoint,
        is_sql_rendering_implementation: isSqlRenderingImplementation,
      },
    };
  });

  return {
    refined: capPivots(refined, maxPivots, expansion, options.sqlRendering, options.lineAnchor),
    ...(subsystemDir === undefined ? {} : { subsystemRoot: subsystemDir }),
    sourceBodyCallFallbackUsed,
  };
}

const ANCHOR_ACTIONABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

// A file-line anchor edit can land on a function/method/class — but never a
// module-level variable/alias the line happened to fall on (low-actionability).
function isAnchorActionableKind(kind: SymbolKind): boolean {
  return ANCHOR_ACTIONABLE_KINDS.has(kind);
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
      is_class_method_expansion_target: false,
      is_containing_class_context: false,
      is_query_builder_entrypoint: false,
      is_sql_rendering_implementation: false,
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

// Cap pivots to `maxPivots`; demote the rest to support. A file-line anchor edit
// site ranks FIRST of all (the issue named it outright); then SQL-rendering edit
// sites (by composition relevance, so `get_combinator_sql` leads a "combined" bug
// ahead of a generic `as_sql`); then Class.method edit-site methods (by their
// expansion overlap score), so a recovered method claims a scarce pivot slot ahead
// of a broad class or a generic candidate. Within a group, ties broken by final
// score then fqName/symbolId for determinism.
function capPivots(
  refined: RefinedRoledCandidate[],
  maxPivots: number,
  expansion: ClassMethodExpansion | undefined,
  sqlRendering: { compositionTerms: ReadonlySet<string> } | undefined,
  lineAnchor: { symbolIds: ReadonlySet<string> } | undefined,
): RefinedRoledCandidate[] {
  const anchorScore = (entry: RefinedRoledCandidate): number =>
    lineAnchor?.symbolIds.has(entry.candidate.symbolId) ? 1 : 0;
  const expansionScore = (entry: RefinedRoledCandidate): number =>
    entry.signals.is_class_method_expansion_target
      ? expansion?.methodScores.get(entry.candidate.symbolId) ?? 0
      : -1;
  // Rendering relevance: -1 for non-renderers (so any renderer outranks them),
  // else the candidate's composition-term overlap (the more on-topic renderer wins).
  const renderingScore = (entry: RefinedRoledCandidate): number =>
    entry.signals.is_sql_rendering_implementation && sqlRendering !== undefined
      ? sqlRenderingRelevance(entry.candidate.localName, sqlRendering.compositionTerms)
      : -1;
  const pivotIds = refined
    .filter((entry) => entry.role === CandidateRole.Pivot)
    .sort(
      (left, right) =>
        anchorScore(right) - anchorScore(left)
        || renderingScore(right) - renderingScore(left)
        || expansionScore(right) - expansionScore(left)
        || right.candidate.scores.final - left.candidate.scores.final
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

// The issue's local subsystem: the directory the issue most clearly points at.
//
// Raw candidate COUNT alone is the wrong signal — generic infrastructure (a
// `django/utils` regex pile) routinely outnumbers the real subsystem
// (`django/contrib/admindocs`), so counting hands the subsystem to the infra and
// the real edit sites fall "outside" it. The decisive signal is the issue text
// itself: a directory whose own path segments appear in the issue ("admindocs",
// "admin") is what the issue is ABOUT. We rank directories by (issue-path
// overlap, then anchored-candidate count), ties broken lexicographically.
function resolveLocalSubsystem(
  base: readonly RoledCandidate[],
  nameOverlap: (candidate: HybridCandidate) => number,
  issueTokens: ReadonlySet<string>,
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
  let bestPathOverlap = -1;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    const pathOverlap = pathSegmentOverlap(dir, issueTokens);
    if (
      pathOverlap > bestPathOverlap
      || (pathOverlap === bestPathOverlap && count > bestCount)
      || (pathOverlap === bestPathOverlap && count === bestCount && (best === undefined || dir < best))
    ) {
      best = dir;
      bestPathOverlap = pathOverlap;
      bestCount = count;
    }
  }
  return best;
}

// How many distinct path segments of `dir` (tokenised the same way symbol names
// are) appear in the issue tokens. `django/contrib/admindocs` against an issue
// mentioning "admindocs" scores 1; `django/utils` scores 0.
function pathSegmentOverlap(dir: string, issueTokens: ReadonlySet<string>): number {
  const segmentTokens = new Set(
    dir
      .split("/")
      .flatMap((segment) => nameTokens(segment))
      .filter((token) => issueTokens.has(token)),
  );
  return segmentTokens.size;
}

// Source-body call fallback. For each actionable candidate whose static in-pool
// call set is empty, scan its source text for `name(` calls to OTHER in-pool
// candidate names and add the recovered edges. Returns true when any edge was
// added. Only fills gaps — a candidate the static graph already connected is
// left untouched, so this never fabricates calls the parser did resolve.
function addSourceBodyCalls(
  base: readonly RoledCandidate[],
  callsOut: Map<string, Set<string>>,
  callsIn: Map<string, Set<string>>,
  sourceTextOf: ((symbolId: string) => string | undefined) | undefined,
): boolean {
  if (sourceTextOf === undefined) {
    return false;
  }

  // in-pool name -> the symbol ids that bear it (a name can be non-unique).
  const idsByName = new Map<string, string[]>();
  for (const entry of base) {
    const name = entry.candidate.localName;
    if (name.length === 0) {
      continue;
    }
    const list = idsByName.get(name);
    if (list === undefined) {
      idsByName.set(name, [entry.candidate.symbolId]);
    } else {
      list.push(entry.candidate.symbolId);
    }
  }

  let used = false;
  for (const entry of base) {
    const candidate = entry.candidate;
    if (!ACTIONABLE_FUNCTION_KINDS.has(candidate.kind) || isLikelyTestCandidate(candidate)) {
      continue;
    }
    if ((callsOut.get(candidate.symbolId)?.size ?? 0) > 0) {
      continue; // static graph already resolved this caller's in-pool calls.
    }
    const source = sourceTextOf(candidate.symbolId);
    if (source === undefined || source.length === 0) {
      continue;
    }
    for (const [name, calleeIds] of idsByName) {
      if (!callsLocalName(source, name)) {
        continue;
      }
      for (const calleeId of calleeIds) {
        if (calleeId === candidate.symbolId) {
          continue;
        }
        addEdge(callsOut, candidate.symbolId, calleeId);
        addEdge(callsIn, calleeId, candidate.symbolId);
        used = true;
      }
    }
  }
  return used;
}

// True when `source` contains a direct call `name(` (allowing whitespace), with a
// non-identifier char before `name` so `replace_named_groups` does not match a
// call to `named_groups`.
function callsLocalName(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`(?<![A-Za-z0-9_.])${escaped}\s*\(`).test(source);
}

function hasLocalEvidence(candidate: HybridCandidate): boolean {
  const s = candidate.scores;
  return s.localEvidence > 0 || s.lexical > 0 || s.domain > 0;
}

function nameTokens(localName: string): string[] {
  return tokenize(localName).filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

export function collectIssueTokens(shaped: ShapedSweQuery): Set<string> {
  const tokens = new Set<string>();
  const sources = [
    ...tokenize(shaped.query),
    ...shaped.identifiers.flatMap(tokenize),
    ...shaped.likelySymbols.flatMap(tokenize),
  ];
  for (const token of sources) {
    // Generic bug-report words (`multiple`, `command`, ...) survive in the raw
    // query lead, so exclude them here too — otherwise a directory that merely
    // shares the word (`.../commands`) could win subsystem selection on noise.
    if (token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token) && !GENERIC_TOKEN_STOPLIST.has(token)) {
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
