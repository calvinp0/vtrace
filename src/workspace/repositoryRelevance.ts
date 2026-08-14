/**
 * M146-B Workstream B3: which registered repositories are relevant to a query.
 *
 * M145 answers where an object BELONGS. This answers whether a repository
 * MATTERS to this request, and they are deliberately different questions —
 * identity is a property of the data, relevance is a property of the query.
 *
 * The ordering below is the whole design. Evidence is grouped into tiers, the
 * highest tier that produces any evidence decides, and within a tier more than
 * one repository means AMBIGUOUS rather than a winner. There is no blended
 * score: M146-B §32 refuses to assume one repository's raw retrieval score is
 * comparable to another's, and a tie-break by registration order or path would
 * be a semantic decision disguised as an implementation detail.
 *
 *   0. explicit selection      index-free   authority, never overridden
 *   1. path containment        index-free   an absolute path inside a root
 *   2. indexed path            INDEXED      suffix membership via M145
 *   3. exact symbol            INDEXED      bounded name lookup
 *
 * The split down the middle of that table is the M146-A invariant. Tiers 2 and 3
 * read state some indexer derived, so a repository whose index this runtime has
 * already refused MUST NOT contribute them — otherwise obsolete semantics decide
 * routing and the stale index effectively selects itself, after which we would
 * rebuild it and call the answer current. Tiers 0 and 1 read only the request,
 * the workspace registration, and the filesystem, so they stay available for a
 * repository that cannot be queried yet. That is what makes "TCKDB is the right
 * repository AND its index must be repaired first" expressible at all.
 */
import type { Database } from "bun:sqlite";

import { createPathMembershipResolver, PathMembershipStatus, type PathMembershipScope } from "./pathMembership";
import { normalizePathHint } from "./pathMembership";
import type { RegisteredRepository, WorkspaceRegistry, WorkspaceRouteSelector } from "./registry";
import { routeWorkspaceRequest } from "./registry";
import type { WorkspaceReadiness, WorkspaceRepoReadiness } from "./readiness";

export const RepositoryRelevanceStatus = Object.freeze({
  /** Exactly one repository is relevant and can be queried. */
  Selected: "selected",
  /** Several remain plausible. §28: abstain, never pick one. */
  Ambiguous: "ambiguous",
  /** No repository carries meaningful evidence. Not "the least bad one". */
  NoMatch: "no_match",
  /** Identified, but its index cannot answer safely yet. */
  NotReady: "not_ready",
});

export type RepositoryRelevanceStatus =
  (typeof RepositoryRelevanceStatus)[keyof typeof RepositoryRelevanceStatus];

export const RepositoryEvidenceKind = Object.freeze({
  ExplicitRoute: "explicit_route",
  PathContainment: "path_containment",
  IndexedPath: "indexed_path",
  ExactSymbol: "exact_symbol",
});

export type RepositoryEvidenceKind =
  (typeof RepositoryEvidenceKind)[keyof typeof RepositoryEvidenceKind];

/**
 * Whether a kind of evidence reads indexer-derived state. The single place this
 * question is answered; `nominateRepositories` gates on it rather than on a
 * hand-written condition per lane, so a new lane cannot forget the gate.
 */
export const EVIDENCE_REQUIRES_READY_INDEX: Readonly<Record<RepositoryEvidenceKind, boolean>> = Object.freeze({
  [RepositoryEvidenceKind.ExplicitRoute]: false,
  [RepositoryEvidenceKind.PathContainment]: false,
  [RepositoryEvidenceKind.IndexedPath]: true,
  [RepositoryEvidenceKind.ExactSymbol]: true,
});

/**
 * The member pool a lane may draw on, derived from the table above rather than
 * chosen per lane. A lane that reads indexer-derived state sees ready members
 * only, so adding one cannot accidentally omit the gate.
 */
const TIER_ORDER: readonly RepositoryEvidenceKind[] = [
  RepositoryEvidenceKind.ExplicitRoute,
  RepositoryEvidenceKind.PathContainment,
  RepositoryEvidenceKind.IndexedPath,
  RepositoryEvidenceKind.ExactSymbol,
];

function poolForEvidence(
  kind: RepositoryEvidenceKind,
  members: readonly RegisteredRepository[],
  readyMembers: readonly RegisteredRepository[],
): readonly RegisteredRepository[] {
  return EVIDENCE_REQUIRES_READY_INDEX[kind] ? readyMembers : members;
}

export interface RepositoryEvidence {
  readonly kind: RepositoryEvidenceKind;
  readonly alias: string;
  readonly worktreeId: string | null;
  /** The query fragment that produced it. Provenance, never a score. */
  readonly hint: string;
  /** Bounded supporting detail for diagnostics. */
  readonly detail?: string;
}

export interface RepositoryNominee {
  readonly alias: string;
  readonly rootPath: string;
  readonly repositoryId: string | null;
  readonly worktreeId: string | null;
  readonly ready: boolean;
  /** Why it cannot be queried, when `ready` is false. */
  readonly notReadyReason: string | null;
  readonly evidence: readonly RepositoryEvidence[];
}

export interface RepositoryProbe {
  /** Indexed relative paths. Read lazily; only ever called for ready members. */
  readonly indexedPaths: () => readonly string[];
  /** Does this repository define this exact local or fully-qualified name? */
  readonly hasExactSymbol: (name: string) => boolean;
}

export interface RepositoryRelevanceLimits {
  /** Ready repositories that may be deep-probed for one request. */
  readonly maxDeepProbes?: number;
  /** Nominees reported when the answer is ambiguous. Diagnostics stay bounded. */
  readonly maxReportedCandidates?: number;
}

export const DEFAULT_RELEVANCE_LIMITS: Required<RepositoryRelevanceLimits> = Object.freeze({
  // Deep probes are bounded so workspace SIZE never sets query cost (§25). The
  // tiering means a decisive path already answers with zero of them.
  maxDeepProbes: 8,
  maxReportedCandidates: 4,
});

export interface RepositoryRelevanceRequest {
  readonly registry: WorkspaceRegistry;
  readonly readiness: WorkspaceReadiness;
  /** Explicit selection. When it resolves, it wins outright. */
  readonly selector?: WorkspaceRouteSelector | undefined;
  /** Paths named by the query, including M144 failure-evidence frames. */
  readonly pathHints?: readonly string[] | undefined;
  /** Exact identifiers named by the query. Prose tokens do not belong here. */
  readonly symbolHints?: readonly string[] | undefined;
  /** Opens bounded read-only access to a member. Only called for ready members. */
  readonly probe?: ((repository: RegisteredRepository) => RepositoryProbe | null) | undefined;
  readonly limits?: RepositoryRelevanceLimits | undefined;
  /**
   * Also collect repositories whose evidence sits BELOW the deciding tier, as
   * bounded supporting context for a task that genuinely spans repositories.
   *
   * Off by default, and that default is load-bearing: gathering support means
   * running the indexed lanes even when an index-free hint already decided, so
   * a decisive path would start opening indexes to look for repositories that
   * merely could contribute. The lead is chosen by the same frozen rule either
   * way — support is additive and never changes who leads.
   */
  readonly collectSupportingEvidence?: boolean | undefined;
}

export interface RepositoryRelevanceDiagnostics {
  readonly reposRegistered: number;
  readonly reposEnabled: number;
  readonly reposReady: number;
  /** Members whose registration/readiness was consulted. No index opened. */
  readonly reposMetadataChecked: number;
  /** Members whose index was actually opened and queried. */
  readonly reposDeepProbed: number;
  /** Members excluded from indexed lanes because their index is unusable. */
  readonly reposExcludedNotReady: readonly { readonly alias: string; readonly reason: string }[];
  /** Which tier produced the decision. null when nothing did. */
  readonly decidingTier: RepositoryEvidenceKind | null;
  readonly candidatesOmitted: number;
}

export interface RepositoryRelevance {
  readonly status: RepositoryRelevanceStatus;
  /** Non-empty only for `selected`. */
  readonly selected: readonly RepositoryNominee[];
  /** Bounded. The plausible set for `ambiguous`, the blocked set for `not_ready`. */
  readonly candidates: readonly RepositoryNominee[];
  /**
   * Ready repositories carrying evidence at a strictly weaker tier than the
   * lead. Empty unless `collectSupportingEvidence` was requested. Distinct from
   * `candidates`: these are not rival answers, they are additional context.
   */
  readonly supporting: readonly RepositoryNominee[];
  readonly reason: string;
  readonly diagnostics: RepositoryRelevanceDiagnostics;
}

/**
 * Decide which registered repositories a request concerns.
 *
 * Costs nothing but registration metadata unless the query actually carries
 * indexed evidence: the deep lanes run only when the index-free tiers produced
 * nothing, which is why a 1000-member workspace with a decisive path answers
 * without opening a single index.
 */
export function nominateRepositories(request: RepositoryRelevanceRequest): RepositoryRelevance {
  const limits = { ...DEFAULT_RELEVANCE_LIMITS, ...(request.limits ?? {}) };
  const members = request.registry.repositories.filter((repo) => repo.enabled);
  const readinessByAlias = new Map(request.readiness.repos.map((repo) => [repo.alias, repo]));

  const readyMembers = members.filter((repo) => readinessByAlias.get(repo.alias)?.ready === true);
  const excluded = members
    .filter((repo) => readinessByAlias.get(repo.alias)?.ready !== true)
    .map((repo) => ({
      alias: repo.alias,
      // §48: a safety exclusion is not a relevance judgement, and saying "low
      // relevance" here would send someone looking for the wrong problem.
      reason: readinessByAlias.get(repo.alias)?.reason ?? "not registered as ready",
    }));

  // Counted per member, not per lane: consulting one index twice is one probe.
  const deepProbedAliases = new Set<string>();
  const evidence: RepositoryEvidence[] = [];
  // Composition is opt-in precisely so the default path keeps its measured cost:
  // a decisive index-free hint must not start opening indexes to look for repos
  // that merely COULD support it.
  const collectSupporting = request.collectSupportingEvidence === true;
  let decidingTier: RepositoryEvidenceKind | null = null;

  // ---- Tier 0: explicit selection -----------------------------------------
  // Highest authority (§17). Resolved through M145 so its ambiguity and
  // staleness rules apply unchanged; auto-routing never overrides it.
  if (hasSelector(request.selector)) {
    const route = routeWorkspaceRequest(request.registry, request.selector!);
    if (route.ok) {
      evidence.push({
        kind: RepositoryEvidenceKind.ExplicitRoute,
        alias: route.repository.alias,
        worktreeId: route.repository.worktreeId,
        hint: route.source,
      });
      return decide({
        tier: RepositoryEvidenceKind.ExplicitRoute,
        evidence,
        members,
        readinessByAlias,
        limits,
        diagnostics: baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size),
      });
    }
  }

  // ---- Tier 1: path containment (index-free) -------------------------------
  // An absolute path inside a registered worktree root names a LOCATION, and
  // deciding that needs no index at all — which is exactly why a repository
  // whose index is refused can still be identified as the right one.
  const pathHints = (request.pathHints ?? []).filter((hint) => hint.trim().length > 0);
  const containmentPool = poolForEvidence(RepositoryEvidenceKind.PathContainment, members, readyMembers);
  for (const hint of pathHints) {
    for (const repo of containingRepositories(containmentPool, hint)) {
      evidence.push({
        kind: RepositoryEvidenceKind.PathContainment,
        alias: repo.alias,
        worktreeId: repo.worktreeId,
        hint,
        detail: `absolute path lies inside ${repo.rootPath}`,
      });
    }
  }
  if (hasTier(evidence, RepositoryEvidenceKind.PathContainment) && !collectSupporting) {
    return decide({
      tier: RepositoryEvidenceKind.PathContainment,
      evidence,
      members,
      readinessByAlias,
      limits,
      diagnostics: baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size),
    });
  }
  decidingTier ??= hasTier(evidence, RepositoryEvidenceKind.PathContainment)
    ? RepositoryEvidenceKind.PathContainment
    : null;

  // ---- Tier 2: indexed path membership (READY MEMBERS ONLY) ----------------
  // Both indexed lanes draw from the same gated pool, bounded so workspace size
  // never sets query cost.
  const indexedPool = poolForEvidence(RepositoryEvidenceKind.IndexedPath, members, readyMembers);
  const probeTargets = decidingTier !== null && !collectSupporting
    ? []
    : indexedPool.slice(0, limits.maxDeepProbes);
  // Probing a prefix of the ready members cannot establish that a match is
  // UNIQUE across the workspace: the cap is what makes cost bounded, and the
  // unprobed remainder is exactly where a rival would hide. Measured: with ten
  // ready members and a cap of eight, a symbol defined in the first and last
  // reported `selected` on the first, and reversing registration order would
  // have named the other one.
  const deepProbeTruncated = probeTargets.length < indexedPool.length;
  const probes = new Map<string, RepositoryProbe>();
  if (request.probe !== undefined && pathHints.length > 0) {
    const scopes: PathMembershipScope[] = [];
    for (const repo of probeTargets) {
      const probe = openProbe(request.probe, repo, probes);
      if (probe === null || repo.worktreeId === null || repo.repositoryId === null) continue;
      deepProbedAliases.add(repo.alias);
      scopes.push({
        worktreeId: repo.worktreeId,
        repositoryId: repo.repositoryId,
        alias: repo.alias,
        worktreeRoot: repo.rootPath,
        indexedPaths: probe.indexedPaths,
      });
    }

    if (scopes.length > 0) {
      const resolver = createPathMembershipResolver(scopes);
      const aliasByWorktree = new Map(scopes.map((scope) => [scope.worktreeId, scope.alias]));
      for (const hint of pathHints) {
        const resolution = resolver.resolve(hint);
        if (resolution.status === PathMembershipStatus.External
          || resolution.status === PathMembershipStatus.Unresolved) {
          continue;
        }
        for (const match of resolution.matches) {
          evidence.push({
            kind: RepositoryEvidenceKind.IndexedPath,
            alias: aliasByWorktree.get(match.worktreeId) ?? match.alias,
            worktreeId: match.worktreeId,
            hint,
            detail: `${match.kind} match on ${match.matchedPaths.join(", ")}`,
          });
        }
      }
    }
  }
  if (hasTier(evidence, RepositoryEvidenceKind.IndexedPath) && decidingTier === null && !collectSupporting) {
    return decide({
      tier: RepositoryEvidenceKind.IndexedPath,
      evidence,
      members,
      readinessByAlias,
      limits,
      deepProbeTruncated,
      diagnostics: baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size),
    });
  }
  decidingTier ??= hasTier(evidence, RepositoryEvidenceKind.IndexedPath)
    ? RepositoryEvidenceKind.IndexedPath
    : null;

  // ---- Tier 3: exact symbol (READY MEMBERS ONLY) ---------------------------
  const symbolHints = (request.symbolHints ?? []).filter((hint) => hint.trim().length > 0);
  if (request.probe !== undefined && symbolHints.length > 0) {
    for (const repo of probeTargets) {
      const probe = openProbe(request.probe, repo, probes);
      if (probe === null) continue;
      deepProbedAliases.add(repo.alias);
      for (const name of symbolHints) {
        if (!probe.hasExactSymbol(name)) continue;
        evidence.push({
          kind: RepositoryEvidenceKind.ExactSymbol,
          alias: repo.alias,
          worktreeId: repo.worktreeId,
          hint: name,
          detail: "exact local or fully-qualified name",
        });
      }
    }
  }
  decidingTier ??= hasTier(evidence, RepositoryEvidenceKind.ExactSymbol)
    ? RepositoryEvidenceKind.ExactSymbol
    : null;
  if (decidingTier !== null) {
    return decide({
      tier: decidingTier,
      evidence,
      members,
      readinessByAlias,
      limits,
      deepProbeTruncated,
      diagnostics: baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size),
    });
  }

  // §29: no evidence means no match. Never the highest weak score.
  return {
    status: RepositoryRelevanceStatus.NoMatch,
    selected: [],
    candidates: [],
    supporting: [],
    reason: members.length === 0
      ? "No enabled repository is registered in this workspace."
      : "No repository carries evidence for this request.",
    diagnostics: {
      ...baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size),
      decidingTier: null,
      candidatesOmitted: 0,
    },
  };
}

function decide(input: {
  tier: RepositoryEvidenceKind;
  evidence: readonly RepositoryEvidence[];
  members: readonly RegisteredRepository[];
  readinessByAlias: ReadonlyMap<string, WorkspaceRepoReadiness>;
  limits: Required<RepositoryRelevanceLimits>;
  /** True when the indexed lanes saw only a prefix of the ready members. */
  deepProbeTruncated?: boolean;
  diagnostics: Omit<RepositoryRelevanceDiagnostics, "decidingTier" | "candidatesOmitted">;
}): RepositoryRelevance {
  const tierEvidence = input.evidence.filter((entry) => entry.kind === input.tier);
  const aliases = [...new Set(tierEvidence.map((entry) => entry.alias))].sort();
  const nominees = aliases.map((alias) => buildNominee(alias, input.members, input.readinessByAlias, tierEvidence));

  // Support is drawn only from strictly weaker tiers, and never from a
  // repository already leading: a repo that matched the deciding tier is an
  // answer or a rival, not context.
  const leadTierIndex = TIER_ORDER.indexOf(input.tier);
  const weaker = input.evidence.filter((entry) => TIER_ORDER.indexOf(entry.kind) > leadTierIndex);
  const supportingAliases = [...new Set(weaker.map((entry) => entry.alias))]
    .filter((alias) => !aliases.includes(alias))
    .sort();
  const supporting = supportingAliases
    .map((alias) => buildNominee(alias, input.members, input.readinessByAlias, weaker))
    // Support reads indexed state by construction, so an unready member can
    // never be support even though it can still be a lead nominee.
    .filter((nominee) => nominee.ready)
    .slice(0, input.limits.maxReportedCandidates);

  const diagnostics = (candidatesOmitted: number): RepositoryRelevanceDiagnostics => ({
    ...input.diagnostics,
    decidingTier: input.tier,
    candidatesOmitted,
  });

  if (nominees.length > 1) {
    // §28. Reporting who matched is useful; choosing between them is not ours.
    const reported = nominees.slice(0, input.limits.maxReportedCandidates);
    return {
      status: RepositoryRelevanceStatus.Ambiguous,
      selected: [],
      candidates: reported,
      supporting: [],
      reason: `${nominees.length} repositories match this request on ${input.tier} evidence: ${aliases.join(", ")}.`,
      diagnostics: diagnostics(nominees.length - reported.length),
    };
  }

  // One match among a truncated pool is not a unique match. Fail closed rather
  // than report certainty the probe never earned; the alternative would also
  // make the answer depend on registration order past the cap.
  if (input.deepProbeTruncated === true && EVIDENCE_REQUIRES_READY_INDEX[input.tier]) {
    return {
      status: RepositoryRelevanceStatus.Ambiguous,
      selected: [],
      candidates: nominees.slice(0, input.limits.maxReportedCandidates),
      supporting: [],
      reason: `${nominees.length} repository match(es) found, but only part of the workspace was probed, so uniqueness is unproven: ${aliases.join(", ")}.`,
      diagnostics: diagnostics(0),
    };
  }

  const nominee = nominees[0]!;
  if (!nominee.ready) {
    // Identified, not answerable. The distinction §27 asks for: this is not a
    // relevance failure, and reporting it as one would hide a repairable index.
    return {
      status: RepositoryRelevanceStatus.NotReady,
      selected: [],
      candidates: [nominee],
      supporting: [],
      reason: `${nominee.alias} is the relevant repository but its index cannot answer: ${nominee.notReadyReason}.`,
      diagnostics: diagnostics(0),
    };
  }

  return {
    status: RepositoryRelevanceStatus.Selected,
    selected: [nominee],
    candidates: [nominee],
    supporting,
    reason: `${nominee.alias} selected on ${input.tier} evidence.`,
    diagnostics: diagnostics(0),
  };
}

function buildNominee(
  alias: string,
  members: readonly RegisteredRepository[],
  readinessByAlias: ReadonlyMap<string, WorkspaceRepoReadiness>,
  evidence: readonly RepositoryEvidence[],
): RepositoryNominee {
  const member = members.find((repo) => repo.alias === alias);
  const readiness = readinessByAlias.get(alias);
  return {
    alias,
    rootPath: member?.rootPath ?? "",
    repositoryId: member?.repositoryId ?? null,
    worktreeId: member?.worktreeId ?? null,
    ready: readiness?.ready === true,
    notReadyReason: readiness?.ready === true ? null : readiness?.reason ?? "unknown readiness",
    evidence: evidence.filter((entry) => entry.alias === alias),
  };
}

/**
 * Registered roots that contain `hint` as a filesystem location. Only absolute
 * hints qualify: a bare `src/utils.py` names a shape, not a place, and treating
 * it as containment would make every repository with that layout a match.
 */
function containingRepositories(
  members: readonly RegisteredRepository[],
  hint: string,
): RegisteredRepository[] {
  if (!namesAbsoluteLocation(hint)) return [];
  const normalizedHint = normalizePathHint(hint);
  const matches: RegisteredRepository[] = [];
  for (const repo of members) {
    if (repo.rootPath.trim().length === 0) continue;
    const root = normalizePathHint(repo.rootPath);
    if (root.length === 0) continue;
    if (normalizedHint === root || normalizedHint.startsWith(`${root}/`)) {
      matches.push(repo);
    }
  }
  // A nested checkout can make two roots contain one path. Deepest root owns it:
  // that is containment, not a tie-break, and M132 already forbids the parent
  // from indexing a nested worktree at all.
  if (matches.length > 1) {
    const deepest = Math.max(...matches.map((repo) => normalizePathHint(repo.rootPath).length));
    return matches.filter((repo) => normalizePathHint(repo.rootPath).length === deepest);
  }
  return matches;
}

function namesAbsoluteLocation(hint: string): boolean {
  return hint.startsWith("/") || /^[A-Za-z]:[\\/]/.test(hint) || hint.startsWith("\\\\");
}

function hasSelector(selector: WorkspaceRouteSelector | undefined): boolean {
  if (selector === undefined) return false;
  return [selector.worktreeId, selector.repositoryId, selector.alias, selector.repoPath, selector.cwd]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}

function hasTier(evidence: readonly RepositoryEvidence[], kind: RepositoryEvidenceKind): boolean {
  return evidence.some((entry) => entry.kind === kind);
}

function openProbe(
  open: (repository: RegisteredRepository) => RepositoryProbe | null,
  repository: RegisteredRepository,
  cache: Map<string, RepositoryProbe>,
): RepositoryProbe | null {
  const cached = cache.get(repository.alias);
  if (cached !== undefined) return cached;
  const probe = open(repository);
  if (probe !== null) cache.set(repository.alias, probe);
  return probe;
}

function baseDiagnostics(
  members: readonly RegisteredRepository[],
  readyMembers: readonly RegisteredRepository[],
  excluded: readonly { alias: string; reason: string }[],
  deepProbed: number,
): Omit<RepositoryRelevanceDiagnostics, "decidingTier" | "candidatesOmitted"> {
  return {
    reposRegistered: members.length,
    reposEnabled: members.length,
    reposReady: readyMembers.length,
    reposMetadataChecked: members.length,
    reposDeepProbed: deepProbed,
    reposExcludedNotReady: excluded,
  };
}

/** Bounded read-only probe over a member's own index. Zero source reads. */
export function createDatabaseProbe(db: Database): RepositoryProbe {
  let paths: readonly string[] | null = null;
  return {
    indexedPaths: (): readonly string[] => {
      if (paths === null) {
        paths = (db.query("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>)
          .map((row) => row.path);
      }
      return paths;
    },
    hasExactSymbol: (name: string): boolean => {
      const row = db.query(
        "SELECT 1 AS hit FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1",
      ).get(name, name) as { hit: number } | null;
      return row !== null;
    },
  };
}
