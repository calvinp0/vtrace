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
 *   4. behavioural mechanism   INDEXED      M153: subject + operation evidence
 *
 * Tier 4 is the only one that decides from what the request MEANS rather than
 * from something the caller already knew how to name, which is exactly why it is
 * last: a path or an identifier is authoritative, and a behavioural match may
 * never overrule one. Within it the comparison is still over evidence KINDS —
 * each repository is reduced to its single strongest class — so the module's
 * refusal to compare scores across repositories survives intact.
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

import type { BehavioralObjective } from "../retrieval/behavioralObjective";
import { generateOperationFactCandidates } from "../retrieval/operationFactCandidates";
import { isTestPath } from "../retrieval/conceptOwnerRetrieval";
import {
  BehavioralNominationStatus,
  classifyRepositoryEvidence,
  nominateByEvidenceClass,
  type BehavioralCandidateSummary,
  type BehavioralNomination,
  type BehavioralRepositoryEvidence,
} from "./behavioralNomination";
import {
  composeCoverage,
  EvidenceCapability,
  EvidenceScope,
  MAX_REPORTED_COVERAGE_EXAMPLES,
  type CoverageExample,
  type EvidenceCoverage,
} from "./evidenceClaims";
import { createPathMembershipResolver, PathMembershipStatus, type PathMembershipScope } from "./pathMembership";
import { normalizePathHint } from "./pathMembership";
import type { RegisteredRepository, WorkspaceRegistry, WorkspaceRouteSelector } from "./registry";
import { routeWorkspaceRequest } from "./registry";
import type { WorkspaceReadiness, WorkspaceRepoReadiness } from "./readiness";
import {
  MembershipAccessPath,
  PresenceUnknownReason,
  proveExactUniqueness,
  RepositoryPresenceState,
  UniquenessProofStatus,
  type RepositoryPresenceObservation,
  type UniquenessProof,
} from "./repositoryPresence";

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
  /**
   * M153. The only lane that decides from what the request MEANS rather than
   * from something the caller already knew how to name. Deliberately weakest:
   * a path or an identifier is authoritative evidence, and a behavioural match
   * may never overrule one (§56).
   */
  BehavioralMechanism: "behavioral_mechanism",
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
  [RepositoryEvidenceKind.BehavioralMechanism]: true,
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
  RepositoryEvidenceKind.BehavioralMechanism,
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
  /**
   * Which physical access path answers `hasExactSymbol`, OBSERVED rather than
   * assumed. An index carrying a name access path answers in microseconds; one
   * without it scans its symbol table. Both return the same answer — only the
   * latency differs — but a router that bounds its own cost may not assume a
   * performance it has not checked for, so the mode travels with the result.
   */
  readonly membershipAccessPath?: () => MembershipAccessPath;
  /**
   * M153. Bounded behavioural evidence for a derived objective, summarised to
   * the shape nomination is allowed to see — a class and one provenance item,
   * never a score.
   *
   * Absent on a probe that cannot answer it, which is an UNKNOWN rather than a
   * negative: a repository whose probe lacks this capability has not been shown
   * to be free of the behaviour.
   */
  readonly behavioralEvidence?: (
    objective: BehavioralObjective,
  ) => readonly BehavioralCandidateSummary[];
}

export interface RepositoryRelevanceLimits {
  /**
   * Ready repositories whose indexed path set may be read while gathering
   * SUPPORTING evidence — context beneath an already-decided lead. Support
   * makes no uniqueness claim, so a prefix of the members is sound here in a
   * way it never was for a deciding lane.
   */
  readonly maxDeepProbes?: number;
  /** Nominees reported when the answer is ambiguous. Diagnostics stay bounded. */
  readonly maxReportedCandidates?: number;
  /**
   * Ready repositories that may be asked an exact-name membership question in
   * one request. Distinct from `maxDeepProbes`, and much larger, because the
   * two bound different things: a deep probe reads a repository's indexed path
   * set, while a membership question is a single keyed lookup whose measured
   * cost does not grow with the repository.
   */
  readonly maxPresenceScans?: number;
  /**
   * Ready repositories that may be asked an indexed-path membership question
   * when the lane can DECIDE. M148-B measured the access pattern rather than
   * assuming it: `files` carries a UNIQUE covering index on `path`, so reading
   * a repository's whole path set costs 0.08 ms for ARC's 325 files and 0.21 ms
   * for TCKDB's 1232, against a 0.02-0.14 ms open — the same order as the
   * exact-name lane, which is why the two share a bound rather than the path
   * lane keeping the far smaller cost bound that used to double as a
   * correctness bound.
   */
  readonly maxPathMembershipScans?: number;
  /**
   * Ready repositories whose index may be asked for behavioural evidence in one
   * request. Larger than `maxDeepProbes` and smaller than the membership bounds
   * because the costs differ in kind: a membership question is one keyed lookup,
   * while a behavioural probe reads a bounded slice of the mechanism-fact table
   * (400 rows, 64 owners, 3 admitted) and evaluates alignment over it.
   *
   * The bound is what stops workspace SIZE from setting query cost. Members
   * beyond it are UNKNOWN, never absent, so exceeding it can only cost a route
   * — it can never invent one (§59, §108).
   */
  readonly maxBehavioralProbes?: number;
}

export const DEFAULT_RELEVANCE_LIMITS: Required<RepositoryRelevanceLimits> = Object.freeze({
  // Support gathering is bounded so workspace SIZE never sets query cost (§25).
  // The tiering means a decisive path already answers with zero of them.
  maxDeepProbes: 8,
  maxReportedCandidates: 4,
  maxPresenceScans: 1024,
  maxPathMembershipScans: 1024,
  maxBehavioralProbes: 64,
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
  /**
   * M153. The behavioural objective derived from the request, when one could be
   * derived. Absent means the request described no behaviour this runtime
   * recognises, and the behavioural lane simply does not run — which is a
   * statement about the REQUEST, not about the workspace.
   */
  readonly behavioralObjective?: BehavioralObjective | null | undefined;
}

export interface RepositoryRelevanceDiagnostics {
  readonly reposRegistered: number;
  readonly reposEnabled: number;
  readonly reposReady: number;
  /** Members whose registration/readiness was consulted. No index opened. */
  readonly reposMetadataChecked: number;
  /** Members whose index was actually opened and queried. */
  readonly reposDeepProbed: number;
  /**
   * Members excluded from indexed lanes because their index is unusable,
   * BOUNDED (M149 §51). `reposExcludedNotReadyTotal` is the real count; a
   * workspace with 900 refused members reports the count and four examples, not
   * 900 records.
   */
  readonly reposExcludedNotReady: readonly { readonly alias: string; readonly reason: string }[];
  readonly reposExcludedNotReadyTotal: number;
  readonly reposExcludedNotReadyOmitted: number;
  /** Which tier produced the decision. null when nothing did. */
  readonly decidingTier: RepositoryEvidenceKind | null;
  readonly candidatesOmitted: number;
  /**
   * The M147 exact-name presence proof, when the exact-symbol lane ran. This is
   * what a uniqueness claim rests on, so it is reported rather than summarised
   * into a boolean: `unproven` and `absent` are different facts with different
   * remedies, and so are the members that could not answer.
   */
  readonly presenceProof: UniquenessProof | null;
  /** Ready members actually asked a membership question. */
  readonly reposPresenceScanned: number;
  /** Access paths observed during the scan. Never assumed from configuration. */
  readonly presenceAccessPaths: Readonly<Record<MembershipAccessPath, number>>;
  /**
   * M148-B: the same proof for the indexed-path lane, when that lane could
   * decide. Reported separately from `presenceProof` because the two lanes ask
   * different questions of different evidence and can reach different verdicts
   * about the same workspace.
   */
  readonly indexedPathProof: UniquenessProof | null;
  /** Ready members actually asked an indexed-path membership question. */
  readonly reposPathMembershipScanned: number;
  /**
   * M149: what each lane that ran actually covered. At most one entry per lane,
   * so this is bounded by construction rather than by a cap.
   *
   * Reported even when routing succeeded, because a POSITIVE answer can still
   * rest on a partial scan — `supporting` naming three repositories after a
   * bounded prefix scan is not a claim that only three support the request, and
   * without this a consumer had no way to tell the difference.
   */
  readonly coverage: readonly EvidenceCoverage[];
  /** M153: ready members whose index was asked for behavioural evidence. */
  readonly reposBehaviorallyProbed: number;
  /**
   * M153: what the behavioural lane concluded, when it ran. `null` means it did
   * not run — the request described no behaviour, or a stronger lane had
   * already decided. A `no_decision` verdict is NOT an absence claim (§58).
   */
  readonly behavioralNomination: BehavioralNomination | null;
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

  // ---- Tier 2: indexed path membership -------------------------------------
  //
  // M148-B applies M147's correction to this lane. It used to draw on the READY
  // members alone, which silently equated "we did not inspect that repository"
  // with "that repository does not index this path" — and reported the one
  // ready match as the unique owner. Measured on a three-member workspace where
  // the refused member DID index the path: `selected(a)` on indexed_path
  // evidence, a global negative claim about a repository that was never asked.
  //
  //   NOT ASKED IS NOT ABSENT.  REFUSED IS UNKNOWN.
  //
  // So the eligible population is every ENABLED member. A ready member answers
  // present or absent from its own index; a refused one contributes UNKNOWN,
  // and one unknown is enough to withhold a uniqueness claim. Its stale index
  // is still never opened — being unknown is precisely what stops us asking it.
  const probes = new Map<string, RepositoryProbe>();
  // A lane that only gathers SUPPORT beneath a decided lead makes no uniqueness
  // claim, so it keeps the small prefix bound and computes no proof. A lane that
  // may decide must ask everyone.
  const indexedPathDecides = decidingTier === null;
  const indexedPathRuns = request.probe !== undefined && pathHints.length > 0
    && (indexedPathDecides || collectSupporting);
  let indexedPathProof: UniquenessProof | null = null;
  let pathMembershipScanned = 0;
  // What each lane covered, accumulated as the lanes run. At most one entry per
  // lane, so no cap is needed to keep it bounded.
  const coverage: EvidenceCoverage[] = [];
  const pathObservations: RepositoryPresenceObservation[] = [];

  if (indexedPathRuns) {
    const scopes: PathMembershipScope[] = [];
    const scanned: string[] = [];
    const population = indexedPathDecides
      ? members
      : poolForEvidence(RepositoryEvidenceKind.IndexedPath, members, readyMembers)
        .slice(0, limits.maxDeepProbes);
    const bound = indexedPathDecides ? limits.maxPathMembershipScans : limits.maxDeepProbes;

    for (const repo of population) {
      const unknownReason = pathProbeRefusal({
        ready: readinessByAlias.get(repo.alias)?.ready === true,
        withinBound: pathMembershipScanned < bound,
      });
      if (unknownReason !== null) {
        pathObservations.push(unknownObservation(repo.alias, unknownReason));
        continue;
      }
      const probe = openProbe(request.probe!, repo, probes);
      // No identity means no scope: M145 keys membership on worktree identity,
      // and a member that cannot be scoped could not be asked — which is an
      // unknown answer, not an absent one.
      if (probe === null || repo.worktreeId === null || repo.repositoryId === null) {
        pathObservations.push(unknownObservation(repo.alias, PresenceUnknownReason.ProbeUnavailable));
        continue;
      }
      deepProbedAliases.add(repo.alias);
      pathMembershipScanned += 1;
      scanned.push(repo.alias);
      scopes.push({
        worktreeId: repo.worktreeId,
        repositoryId: repo.repositoryId,
        alias: repo.alias,
        worktreeRoot: repo.rootPath,
        indexedPaths: probe.indexedPaths,
      });
    }

    // A support-mode scan reads a PREFIX of the ready members, so the ones it
    // never reached owe an observation too. Without them `supporting` reads as
    // the complete list of repositories that could contribute, when it is only
    // the list among those we got around to asking (M149 §27).
    if (!indexedPathDecides) {
      const observed = new Set(pathObservations.map((entry) => entry.alias));
      for (const repo of members) {
        if (observed.has(repo.alias) || scanned.includes(repo.alias)) continue;
        pathObservations.push(unknownObservation(
          repo.alias,
          readinessByAlias.get(repo.alias)?.ready === true
            ? PresenceUnknownReason.BeyondScanBound
            : PresenceUnknownReason.IndexRefused,
        ));
      }
    }

    const matched = new Set<string>();
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
          const alias = aliasByWorktree.get(match.worktreeId) ?? match.alias;
          matched.add(alias);
          evidence.push({
            kind: RepositoryEvidenceKind.IndexedPath,
            alias,
            worktreeId: match.worktreeId,
            hint,
            detail: `${match.kind} match on ${match.matchedPaths.join(", ")}`,
          });
        }
      }
    }

    // PRESENT means "carried decisive path evidence", which is the same thing
    // the lane nominates on. An absolute hint that resolves EXACTLY inside one
    // worktree outranks a repository that merely indexes the same shape (M145),
    // and counting the outranked member as present would make an unambiguous
    // absolute path ambiguous the moment a similarly-laid-out repository joined.
    for (const alias of scanned) {
      pathObservations.push({
        alias,
        state: matched.has(alias)
          ? RepositoryPresenceState.Present
          : RepositoryPresenceState.DefinitelyAbsent,
        unknownReason: null,
        // The access-path field describes the exact-NAME lookup M147 measured;
        // this lane reads the `files` covering index and reports nothing here.
        accessPath: MembershipAccessPath.Unreported,
      });
    }

    if (indexedPathDecides) {
      indexedPathProof = proveExactUniqueness(pathObservations, { verb: "indexes", noun: "this path" });
    }
    coverage.push(coverageFromObservations({
      capability: EvidenceCapability.PathMembership,
      purpose: indexedPathDecides ? "deciding" : "support",
      considered: members.length,
      observations: pathObservations,
    }));
  }

  if (hasTier(evidence, RepositoryEvidenceKind.IndexedPath) && decidingTier === null && !collectSupporting) {
    return decide({
      tier: RepositoryEvidenceKind.IndexedPath,
      evidence,
      members,
      readinessByAlias,
      limits,
      presenceProof: indexedPathProof,
      diagnostics: baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size, {
        pathMembershipScanned,
        indexedPathProof,
        coverage,
      }),
    });
  }
  decidingTier ??= hasTier(evidence, RepositoryEvidenceKind.IndexedPath)
    ? RepositoryEvidenceKind.IndexedPath
    : null;

  // ---- Tier 3: exact symbol (READY MEMBERS ONLY) ---------------------------
  // M147 replaces "probe a PREFIX of the ready members" with "ask every eligible
  // member and record what each one answered". The change is not that more work
  // happens — a membership question is the same query M146 already ran — but
  // that the unasked remainder becomes a named UNKNOWN instead of silently
  // vanishing from a uniqueness claim it was entitled to refute.
  const symbolHints = (request.symbolHints ?? []).filter((hint) => hint.trim().length > 0);
  let presenceProof: UniquenessProof | null = null;
  const accessPaths: Record<MembershipAccessPath, number> = {
    [MembershipAccessPath.Indexed]: 0,
    [MembershipAccessPath.Fallback]: 0,
    [MembershipAccessPath.Unreported]: 0,
  };
  let presenceScanned = 0;

  if (request.probe !== undefined && symbolHints.length > 0) {
    const observations: RepositoryPresenceObservation[] = [];
    // The eligible population is every enabled member, not every READY one: a
    // member whose derivation was refused is still somewhere the name could
    // live, so it owes an answer it cannot give.
    for (const repo of members) {
      const ready = readinessByAlias.get(repo.alias)?.ready === true;
      if (!ready) {
        observations.push({
          alias: repo.alias,
          state: RepositoryPresenceState.Unknown,
          unknownReason: PresenceUnknownReason.IndexRefused,
          accessPath: MembershipAccessPath.Unreported,
        });
        continue;
      }
      if (presenceScanned >= limits.maxPresenceScans) {
        observations.push({
          alias: repo.alias,
          state: RepositoryPresenceState.Unknown,
          unknownReason: PresenceUnknownReason.BeyondScanBound,
          accessPath: MembershipAccessPath.Unreported,
        });
        continue;
      }
      const probe = openProbe(request.probe, repo, probes);
      if (probe === null) {
        observations.push({
          alias: repo.alias,
          state: RepositoryPresenceState.Unknown,
          unknownReason: PresenceUnknownReason.ProbeUnavailable,
          accessPath: MembershipAccessPath.Unreported,
        });
        continue;
      }
      deepProbedAliases.add(repo.alias);
      presenceScanned += 1;
      const accessPath = probe.membershipAccessPath?.() ?? MembershipAccessPath.Unreported;
      accessPaths[accessPath] += 1;

      const defines = symbolHints.some((name) => probe.hasExactSymbol(name));
      observations.push({
        alias: repo.alias,
        state: defines ? RepositoryPresenceState.Present : RepositoryPresenceState.DefinitelyAbsent,
        unknownReason: null,
        accessPath,
      });
      if (!defines) continue;
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
    presenceProof = proveExactUniqueness(observations);
    coverage.push(coverageFromObservations({
      capability: EvidenceCapability.SymbolExactLookup,
      purpose: "deciding",
      considered: members.length,
      observations,
    }));
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
      // Each lane waits on ITS OWN proof and no other. A path-tier answer is not
      // a claim about symbol membership, so a symbol-lane unknown may not
      // withhold it — and vice versa.
      presenceProof: decidingTier === RepositoryEvidenceKind.ExactSymbol
        ? presenceProof
        : decidingTier === RepositoryEvidenceKind.IndexedPath ? indexedPathProof : null,
      diagnostics: baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size, {
        presenceScanned,
        presenceAccessPaths: accessPaths,
        presenceProof,
        pathMembershipScanned,
        indexedPathProof,
        coverage,
      }),
    });
  }

  // ---- Tier 4: behavioural mechanism (READY MEMBERS ONLY) ------------------
  //
  // The last lane, and the only one that decides from what the request MEANS.
  // It runs exactly when every stronger lane produced nothing, so a caller who
  // named a path or an identifier can never be re-routed by it (§55, §56).
  //
  // Each probed member is reduced to ONE evidence class by
  // `classifyRepositoryEvidence`, and the comparison is over classes alone. A
  // repository with many weak facts is represented by its best weak fact, so
  // size buys nothing (§43, §44).
  //
  // Members past the probe bound, and members whose probe cannot answer, are
  // simply absent from the comparison. That can only cost a nomination; it can
  // never manufacture one, which is the right direction for a lane that is
  // allowed to decline.
  let behavioralNomination: BehavioralNomination | null = null;
  let behavioralProbed = 0;
  if (request.probe !== undefined && request.behavioralObjective != null) {
    const gathered: BehavioralRepositoryEvidence[] = [];
    for (const repo of members) {
      if (readinessByAlias.get(repo.alias)?.ready !== true) continue;
      if (behavioralProbed >= limits.maxBehavioralProbes) break;
      const probe = openProbe(request.probe, repo, probes);
      if (probe?.behavioralEvidence === undefined) continue;
      deepProbedAliases.add(repo.alias);
      behavioralProbed += 1;
      gathered.push(
        classifyRepositoryEvidence(
          repo.alias,
          probe.behavioralEvidence(request.behavioralObjective),
        ),
      );
    }

    behavioralNomination = nominateByEvidenceClass(gathered);
    if (behavioralNomination.status === BehavioralNominationStatus.Selected) {
      const lead = behavioralNomination.lead!;
      evidence.push({
        kind: RepositoryEvidenceKind.BehavioralMechanism,
        alias: lead.alias,
        worktreeId: members.find((repo) => repo.alias === lead.alias)?.worktreeId ?? null,
        // Provenance, never a score: the operation asked for and the definition
        // that answered it.
        hint: request.behavioralObjective.operation,
        detail: lead.bestCandidate === null
          ? lead.evidenceClass
          : `${lead.evidenceClass} via ${lead.bestCandidate.fqName} (${lead.bestCandidate.factKind})`,
      });
      return decide({
        tier: RepositoryEvidenceKind.BehavioralMechanism,
        evidence,
        members,
        readinessByAlias,
        limits,
        // A behavioural match is NOT an exact-uniqueness claim, so it carries no
        // presence proof. Attaching one would let a fuzzy lane strengthen a
        // claim only an exact lane can earn (§58).
        presenceProof: null,
        diagnostics: baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size, {
          presenceScanned,
          presenceAccessPaths: accessPaths,
          presenceProof,
          pathMembershipScanned,
          indexedPathProof,
          coverage,
          behavioralProbed,
          behavioralNomination,
        }),
      });
    }
  }

  // §29: no evidence means no match. Never the highest weak score.
  //
  // "No repository carries evidence" is itself a claim about every member, so it
  // may not be made over members that were never asked. When either lane ran and
  // some member could not answer, the outcome is still `no_match` — nothing was
  // found, and declining to answer selects no repository — but the reason says
  // which members are missing instead of asserting a global negative the scan
  // did not establish. M148-B extends that to the path lane: an unknown member
  // could be exactly the repository that indexes the path.
  //
  // M149 sharpens what that sentence may claim. Before, ONE string covered three
  // epistemically different outcomes: every member was asked and none matched;
  // some member could not be asked; and no lane ran at all because the request
  // named nothing to check. Measured on a two-member workspace with no hints:
  //
  //   reason  No repository carries evidence for this request.
  //   probed  0
  //
  // Nothing was checked, and the sentence read as a finding about the workspace.
  // A negative may now only be stated as far as a lane actually reached, so the
  // proof's own wording — which already says how many members were checked — is
  // preferred over the generic sentence whenever a lane produced one.
  const laneProofs = [indexedPathProof, presenceProof]
    .filter((proof): proof is UniquenessProof => proof !== null);
  const unprovenLane = laneProofs.find((proof) => proof.status === UniquenessProofStatus.Unproven) ?? null;
  const absentLane = laneProofs.find((proof) => proof.status === UniquenessProofStatus.Absent) ?? null;
  return {
    status: RepositoryRelevanceStatus.NoMatch,
    selected: [],
    candidates: [],
    supporting: [],
    reason: members.length === 0
      ? "No enabled repository is registered in this workspace."
      : unprovenLane !== null
        ? unprovenLane.reason
        : absentLane !== null
          // Earned: every eligible member answered from an exact source.
          ? absentLane.reason
          : nothingCheckedReason(pathHints.length + symbolHints.length > 0),
    diagnostics: {
      ...baseDiagnostics(members, readyMembers, excluded, deepProbedAliases.size, {
        presenceScanned,
        presenceAccessPaths: accessPaths,
        presenceProof,
        pathMembershipScanned,
        indexedPathProof,
        coverage,
        behavioralProbed,
        behavioralNomination,
      }),
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
  /** The presence proof computed by the DECIDING lane, when it computed one. */
  presenceProof?: UniquenessProof | null;
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

  // M147, extended to the indexed-path lane by M148-B: a single match is only a
  // UNIQUE match once every other eligible repository is proven not to hold the
  // evidence. `unproven` means some member could not answer — a refused index,
  // or one past the scan bound — so the global negative was never established
  // and the match stands alone only by assumption. Fail closed, and say which
  // members are missing rather than reporting a bare ambiguity nobody can act on.
  if (input.presenceProof !== null && input.presenceProof !== undefined
    && input.presenceProof.status === UniquenessProofStatus.Unproven) {
    return {
      status: RepositoryRelevanceStatus.Ambiguous,
      selected: [],
      candidates: nominees.slice(0, input.limits.maxReportedCandidates),
      supporting: [],
      reason: input.presenceProof.reason,
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

const NO_PRESENCE_SCAN: Readonly<Record<MembershipAccessPath, number>> = Object.freeze({
  [MembershipAccessPath.Indexed]: 0,
  [MembershipAccessPath.Fallback]: 0,
  [MembershipAccessPath.Unreported]: 0,
});

interface PresenceDiagnostics {
  readonly presenceScanned?: number;
  readonly presenceAccessPaths?: Readonly<Record<MembershipAccessPath, number>>;
  readonly presenceProof?: UniquenessProof | null;
  readonly pathMembershipScanned?: number;
  readonly indexedPathProof?: UniquenessProof | null;
  readonly coverage?: readonly EvidenceCoverage[];
  readonly behavioralProbed?: number;
  readonly behavioralNomination?: BehavioralNomination | null;
}

function baseDiagnostics(
  members: readonly RegisteredRepository[],
  readyMembers: readonly RegisteredRepository[],
  excluded: readonly { alias: string; reason: string }[],
  deepProbed: number,
  presence: PresenceDiagnostics = {},
): Omit<RepositoryRelevanceDiagnostics, "decidingTier" | "candidatesOmitted"> {
  return {
    reposRegistered: members.length,
    reposEnabled: members.length,
    reposReady: readyMembers.length,
    reposMetadataChecked: members.length,
    reposDeepProbed: deepProbed,
    // Bounded: the COUNT is the fact a caller acts on, and four named examples
    // are enough to start diagnosing. A workspace-sized list is not (§51).
    reposExcludedNotReady: excluded.slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
    reposExcludedNotReadyTotal: excluded.length,
    reposExcludedNotReadyOmitted: Math.max(0, excluded.length - MAX_REPORTED_COVERAGE_EXAMPLES),
    reposPresenceScanned: presence.presenceScanned ?? 0,
    presenceAccessPaths: presence.presenceAccessPaths ?? NO_PRESENCE_SCAN,
    presenceProof: presence.presenceProof ?? null,
    reposPathMembershipScanned: presence.pathMembershipScanned ?? 0,
    indexedPathProof: presence.indexedPathProof ?? null,
    coverage: presence.coverage ?? [],
    reposBehaviorallyProbed: presence.behavioralProbed ?? 0,
    behavioralNomination: presence.behavioralNomination ?? null,
  };
}

/**
 * Turn a lane's observations into a bounded coverage record.
 *
 * The unknown REASONS are kept apart rather than summed, because they have
 * different remedies and a consumer that cannot tell them apart will suggest the
 * wrong one: a refused index is repaired by rebuilding it, and a member past the
 * bound is reached by raising the bound.
 */
function coverageFromObservations(input: {
  readonly capability: EvidenceCapability;
  readonly purpose: "deciding" | "support";
  readonly considered: number;
  readonly observations: readonly RepositoryPresenceObservation[];
}): EvidenceCoverage {
  const unknown = input.observations.filter(
    (entry) => entry.state === RepositoryPresenceState.Unknown,
  );
  const examples: CoverageExample[] = unknown.map((entry) => ({
    alias: entry.alias,
    reason: entry.unknownReason ?? PresenceUnknownReason.ProbeUnavailable,
  }));
  const countBy = (reason: PresenceUnknownReason): number =>
    unknown.filter((entry) => entry.unknownReason === reason).length;
  return composeCoverage({
    capability: input.capability,
    purpose: input.purpose,
    // A lane asks the enabled members; a disabled member is outside the
    // population entirely, so no lane may speak for the whole workspace.
    scope: EvidenceScope.EnabledMembers,
    considered: input.considered,
    answered: input.observations.length - unknown.length,
    refusedWithoutEvidence: countBy(PresenceUnknownReason.IndexRefused),
    omittedByBound: countBy(PresenceUnknownReason.BeyondScanBound),
    unknownOther: countBy(PresenceUnknownReason.ProbeUnavailable),
    examples,
  });
}

/**
 * The sentence for "no lane produced an answer". Split by WHY, because the two
 * cases have different remedies and neither is a finding about the workspace.
 */
function nothingCheckedReason(hintsPresent: boolean): string {
  return hintsPresent
    ? "No repository could be checked for this request: no index probe was available."
    : "This request names no path or symbol to route on, so no repository was checked.";
}

/**
 * Why a member cannot contribute a path-membership ANSWER, or null when it can.
 *
 * Named rather than inlined so the two reasons stay distinguishable in the
 * proof: a refused index is repaired by rebuilding it, and a member past the
 * scan bound is reached by raising the bound. Reporting both as "unknown" would
 * send a user to the wrong remedy.
 */
function pathProbeRefusal(state: {
  readonly ready: boolean;
  readonly withinBound: boolean;
}): PresenceUnknownReason | null {
  if (!state.ready) return PresenceUnknownReason.IndexRefused;
  if (!state.withinBound) return PresenceUnknownReason.BeyondScanBound;
  return null;
}

function unknownObservation(alias: string, reason: PresenceUnknownReason): RepositoryPresenceObservation {
  return {
    alias,
    state: RepositoryPresenceState.Unknown,
    unknownReason: reason,
    accessPath: MembershipAccessPath.Unreported,
  };
}

/**
 * The exact-name membership question, in one place.
 *
 * There is deliberately ONE statement rather than an indexed variant and a
 * fallback variant. An index carrying `idx_symbols_local_name` answers it with
 * a keyed lookup and one without it scans the symbol table, but the rows
 * considered are identical either way, so the two paths cannot disagree — the
 * equivalence is structural rather than asserted. Only the latency differs, and
 * `membershipAccessPath` reports which one was taken so the router never
 * assumes a speed it has not observed.
 */
const MEMBERSHIP_SQL = "SELECT 1 AS hit FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1";

/** The access paths whose presence turns membership into a keyed lookup. */
const NAME_ACCESS_PATH_INDEXES = ["idx_symbols_local_name", "idx_symbols_fq_name"] as const;

/** Bounded read-only probe over a member's own index. Zero source reads. */
export function createDatabaseProbe(db: Database): RepositoryProbe {
  let paths: readonly string[] | null = null;
  let accessPath: MembershipAccessPath | null = null;
  return {
    indexedPaths: (): readonly string[] => {
      if (paths === null) {
        paths = (db.query("SELECT path FROM files ORDER BY path").all() as Array<{ path: string }>)
          .map((row) => row.path);
      }
      return paths;
    },
    hasExactSymbol: (name: string): boolean => {
      const row = db.query(MEMBERSHIP_SQL).get(name, name) as { hit: number } | null;
      return row !== null;
    },
    membershipAccessPath: (): MembershipAccessPath => {
      if (accessPath === null) {
        // Read from the catalogue rather than inferring from a query plan: this
        // asks what the database HAS, which is the fact the router needs, and
        // costs one keyed lookup once per probe.
        const found = (db.query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbols'",
        ).all() as Array<{ name: string }>).map((row) => row.name);
        accessPath = NAME_ACCESS_PATH_INDEXES.every((index) => found.includes(index))
          ? MembershipAccessPath.Indexed
          : MembershipAccessPath.Fallback;
      }
      return accessPath;
    },
    // M153. Reuse M150's candidate generator rather than reimplementing subject
    // alignment inside the router (§38). It is already the right shape for a
    // route probe: bounded by construction (400 fact rows, 64 owners, 3
    // admitted), keyed on the existing `(kind, symbol_id)` index, and documented
    // as performing ZERO source reads — which is exactly the §37 requirement
    // that nomination must not hydrate source.
    //
    // Only the fields nomination may look at are carried out. The generator's
    // scores stay behind, because a router that could see one would eventually
    // be asked to compare two across repositories that never calibrated them.
    behavioralEvidence: (objective): readonly BehavioralCandidateSummary[] => {
      const result = generateOperationFactCandidates(db, objective);
      return result.candidates
        // §51, §66. A test that NAMES a behaviour is not a repository that
        // IMPLEMENTS it, and routing is a claim about implementation ownership.
        // Measured: "Where is the list of parsers ordered by priority?" routed to
        // astropy, whose only admitted candidates were two `sort_eq` helpers in
        // `astropy/table/tests/`, aligned because their operand `list1` shares a
        // token with the query's word "list". Sphinx, which owns the mechanism,
        // was outranked by another repository's test fixtures.
        //
        // Applied to the ROUTING probe only. The same definitions remain
        // ordinary retrieval candidates inside their own repository, where a test
        // is legitimate context; what they may not do is decide which repository
        // a request belongs to.
        .filter((candidate) => !isTestPath(candidate.symbol.fqName.split("::")[0] ?? ""))
        .map((candidate) => ({
        fqName: candidate.symbol.fqName,
        factKind: candidate.factKind,
        alignment: candidate.alignment,
        // The generator admits on DIRECT fact kinds only: a partial fact may
        // strengthen a candidate retrieval already reached, but is never
        // authority to pull a new definition into the pool.
        compatibility: "direct",
      }));
    },
  };
}
