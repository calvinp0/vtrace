// M151: the one place a real product request meets workspace routing.
//
// WHAT WAS WRONG
// ----------------
// M146-M149 built repository nomination, path/symbol membership, evidence
// coverage and cross-repository composition, and nothing in `src/mcp`, `src/cli`
// or `src/runPipeline` called any of it. What the product did instead was worse
// than ignoring it: a `workspace.json` at the bound root made every
// `get_code_context`, `run_pipeline` and `get_context_capsule` call return
// `invalid_request`, advising the caller to "omit repos or select exactly one" —
// advice neither branch of which could succeed, because the gate tested whether a
// workspace EXISTED rather than what the request asked for.
//
// WHERE THIS SITS
// ----------------
// Before the database binding, never at the product producer. `run_pipeline`
// derives both the v1 orchestration and the authoritative product context from one
// `db`; routing the producer alone would leave one response describing two
// repositories. Choosing the repository first means everything downstream is the
// code M150 froze, running unchanged against the member that was chosen.
//
// WHAT DECIDES, AND WHAT DOES NOT
// ----------------
// M132 already fixed repository precedence: an explicit `repo_root` wins, then
// client context, then the server's bound root. Routing is inserted ONLY into that
// last branch — the case where the product used to silently answer from whichever
// checkout the server happened to launch in. A caller who named a repository is
// never overridden (§73).
//
// Within that branch the decision belongs to `nominateRepositories`, whose tiers
// are explicit route, path containment, indexed path and exact symbol. There is no
// behavioural relevance lane in M146-M149 and this module does not invent one: a
// query that names no path and no identifier carries no routing evidence, and the
// honest outcome is the workspace's own configured authority or an abstention —
// never the member whose name the query happened to mention (§73-§75).

import { Database } from "bun:sqlite";

import { resolveIndexDbPath } from "../indexer/indexMeta";
import { resolveRepoLocalPaths } from "../setup/repoState";
import {
  MAX_REPORTED_COVERAGE_EXAMPLES,
  type EvidenceCoverage,
} from "./evidenceClaims";
import {
  resolveWorkspaceConfigPath,
  safeReadWorkspaceConfig,
  type ResolvedWorkspaceRepoConfig,
} from "./config";
import { evaluateWorkspaceReadiness, type WorkspaceReadiness } from "./readiness";
import { extractQueryRouteHints } from "./queryRouteHints";
import {
  resolveWorkspaceRegistry,
  routeWorkspaceRequest,
  WorkspaceRouteSource,
  type RegisteredRepository,
  type WorkspaceRegistry,
  type WorkspaceRouteReason,
  type WorkspaceRouteSelector,
  type WorkspaceRouteResult,
} from "./registry";
import {
  createDatabaseProbe,
  nominateRepositories,
  RepositoryRelevanceStatus,
  type RepositoryNominee,
  type RepositoryProbe,
  type RepositoryRelevanceLimits,
} from "./repositoryRelevance";

/** How the lead repository was arrived at. Provenance, never a confidence score. */
export const ProductRouteOutcome = Object.freeze({
  /** No workspace is configured. The single-repository product path, untouched. */
  SingleRepository: "single_repository",
  /** The caller named a repository. Routing did not decide anything. */
  ExplicitMember: "explicit_member",
  /** Routing evidence chose the lead, and no other member could hold it. */
  Routed: "routed",
  /**
   * Exactly one member positively matched, but members that could not be
   * checked leave that match unproven as the ONLY one. Routing to the sole
   * demonstrated match is not a uniqueness claim, and the response says so.
   */
  SoleEvidenceMatch: "sole_evidence_match",
  /** No evidence, but the workspace declares a sole member or a default. */
  ConfiguredMember: "configured_member",
  /** Several members remain plausible, or none does. No lead. */
  Abstained: "abstained",
  /** A lead exists in principle but no member can currently be queried. */
  NoUsableMember: "no_usable_member",
});

export type ProductRouteOutcome =
  (typeof ProductRouteOutcome)[keyof typeof ProductRouteOutcome];

export interface ProductRouteMember {
  readonly alias: string;
  readonly rootPath: string;
  readonly repositoryId: string | null;
  readonly worktreeId: string | null;
}

/**
 * The model-visible routing record. Bounded by construction: counts and a fixed
 * number of examples, never a member-by-member list (§15, §62).
 */
export interface ProductRoutingMetadata {
  readonly isWorkspace: boolean;
  readonly outcome: ProductRouteOutcome;
  readonly routeSource: string | null;
  readonly reason: string;
  readonly decidingTier: string | null;
  readonly leadRepository: string | null;
  /**
   * Members that could contribute bounded support. Populated ONLY when the
   * request opted into composition: discovering supporters means running the
   * indexed lanes even when an index-free hint already decided, and the default
   * path may not pay that. An empty list here is therefore never a claim that no
   * repository could support the request — `supportersInspected` is what tells
   * those two apart, and `coverage` bounds what any of it covers.
   */
  readonly supportingRepositories: readonly string[];
  readonly supportersInspected: boolean;
  /**
   * Whether the deciding lane PROVED no other member could hold the target.
   * False whenever a member could not be checked. It is never an absence claim
   * either way — `coverage` is what bounds what was actually established.
   */
  readonly uniquenessProven: boolean;
  readonly repositoriesRegistered: number;
  readonly repositoriesEnabled: number;
  readonly repositoriesReady: number;
  readonly repositoriesDeepProbed: number;
  /** Bounded examples; `excludedNotReadyTotal` carries the real count. */
  readonly excludedNotReady: readonly { readonly alias: string; readonly reason: string }[];
  readonly excludedNotReadyTotal: number;
  readonly excludedNotReadyOmitted: number;
  readonly candidates: readonly string[];
  readonly coverage: readonly EvidenceCoverage[];
}

export interface ProductRoute {
  readonly outcome: ProductRouteOutcome;
  /** null whenever the outcome carries no queryable repository. */
  readonly lead: ProductRouteMember | null;
  readonly supporting: readonly ProductRouteMember[];
  readonly routing: ProductRoutingMetadata;
  readonly registry: WorkspaceRegistry;
  readonly readiness: WorkspaceReadiness | null;
  /** Members whose index was opened READ-ONLY to prove a route. Never retrieval. */
  readonly indexesOpenedForRouteProof: readonly string[];
  /**
   * Members excluded as not-ready whose index was nonetheless opened. The
   * §145 hard requirement is that this stays empty, so it is measured rather
   * than asserted in a comment.
   */
  readonly refusedIndexesOpened: readonly string[];
  /**
   * Present when an EXPLICIT selection failed to resolve. Carried through rather
   * than flattened into a message so the product can keep telling a caller which
   * alias it did not recognise and which ones exist.
   */
  readonly explicitSelectionFailure: {
    readonly reason: WorkspaceRouteReason;
    readonly message: string;
    readonly unknownRepos: readonly string[];
    readonly availableRepos: readonly string[];
  } | null;
}

export interface ProductRouteRequest {
  /** The root the server is bound to; where a workspace config would live. */
  readonly boundRepoRoot: string;
  /** An explicit `repo_root`. Present means the caller decided (§73). */
  readonly requestedRoot?: string | undefined;
  /** Explicit `repos` aliases. Present means the caller decided. */
  readonly requestedAliases?: readonly string[] | undefined;
  readonly query: string;
  /** Paths the caller stated structurally rather than in prose. */
  readonly explicitPaths?: readonly string[] | undefined;
  /**
   * Opt in to discovering and composing supporting repositories. Off by default
   * so an ordinary workspace request costs exactly one retrieval, and so the
   * mere existence of another member cannot change what the lead returns.
   */
  readonly includeSupporting?: boolean | undefined;
  readonly limits?: RepositoryRelevanceLimits | undefined;
  /** Injectable for tests and for measuring index opens. */
  readonly openProbeDatabase?: ((repository: RegisteredRepository) => Database | null) | undefined;
}

function toMember(repository: RegisteredRepository): ProductRouteMember {
  return {
    alias: repository.alias,
    rootPath: repository.rootPath,
    repositoryId: repository.repositoryId,
    worktreeId: repository.worktreeId,
  };
}

function nomineeToMember(nominee: RepositoryNominee): ProductRouteMember {
  return {
    alias: nominee.alias,
    rootPath: nominee.rootPath,
    repositoryId: nominee.repositoryId,
    worktreeId: nominee.worktreeId,
  };
}

/** A member of an implicit single-repository "workspace". */
function singleRepoSpec(repoRoot: string): ResolvedWorkspaceRepoConfig {
  const paths = resolveRepoLocalPaths(repoRoot);

  return {
    alias: "repo",
    rootPath: paths.repoRoot,
    configPath: paths.configPath,
    statePath: paths.statePath,
    dbPath: paths.dbPath,
    enabled: true,
  };
}

function emptyRouting(
  outcome: ProductRouteOutcome,
  reason: string,
  registry: WorkspaceRegistry,
): ProductRoutingMetadata {
  return {
    isWorkspace: registry.isWorkspace,
    outcome,
    routeSource: null,
    reason,
    decidingTier: null,
    leadRepository: null,
    supportingRepositories: [],
    supportersInspected: false,
    uniquenessProven: false,
    repositoriesRegistered: registry.repositories.length,
    repositoriesEnabled: registry.repositories.filter((repo) => repo.enabled).length,
    repositoriesReady: 0,
    repositoriesDeepProbed: 0,
    excludedNotReady: [],
    excludedNotReadyTotal: 0,
    excludedNotReadyOmitted: 0,
    candidates: [],
    coverage: [],
  };
}

/**
 * Decide which registered repository a product request concerns.
 *
 * Opens no index at all unless the query carries indexed evidence, and never
 * opens the index of a member readiness refused — being refused is precisely
 * what stops it being asked (§34, §145).
 */
export async function resolveProductRoute(request: ProductRouteRequest): Promise<ProductRoute> {
  const config = await safeReadWorkspaceConfig(resolveWorkspaceConfigPath(request.boundRepoRoot));

  // No workspace configured: the ordinary single-repository path. Nothing is
  // probed, no readiness census runs, and the caller keeps the exact behaviour
  // it had before M151 (§12).
  if (config === undefined) {
    const registry = await resolveWorkspaceRegistry({
      fallbackRepo: singleRepoSpec(request.boundRepoRoot),
    });
    return {
      outcome: ProductRouteOutcome.SingleRepository,
      lead: {
        alias: registry.repositories[0]?.alias ?? "repo",
        rootPath: request.boundRepoRoot,
        repositoryId: registry.repositories[0]?.repositoryId ?? null,
        worktreeId: registry.repositories[0]?.worktreeId ?? null,
      },
      supporting: [],
      routing: {
        ...emptyRouting(
          ProductRouteOutcome.SingleRepository,
          "No workspace is configured; the bound repository answered.",
          registry,
        ),
        leadRepository: registry.repositories[0]?.alias ?? "repo",
        routeSource: WorkspaceRouteSource.SoleMember,
      },
      registry,
      readiness: null,
      indexesOpenedForRouteProof: [],
      refusedIndexesOpened: [],
      explicitSelectionFailure: null,
    };
  }

  const registry = await resolveWorkspaceRegistry({ config });
  const readiness = await evaluateWorkspaceReadiness(registry);
  const readyAliases = new Set(
    readiness.repos.filter((repo) => repo.ready).map((repo) => repo.alias),
  );

  // ---- Explicit selection: the caller decided, routing does not re-decide ----
  const selector = buildExplicitSelector(request);
  if (selector !== null) {
    const route: WorkspaceRouteResult = routeWorkspaceRequest(registry, selector);
    if (route.ok === false) {
      return {
        outcome: ProductRouteOutcome.Abstained,
        lead: null,
        supporting: [],
        routing: {
          ...emptyRouting(ProductRouteOutcome.Abstained, route.message, registry),
          repositoriesReady: readyAliases.size,
        },
        registry,
        readiness,
        indexesOpenedForRouteProof: [],
        refusedIndexesOpened: [],
        explicitSelectionFailure: {
          reason: route.reason,
          message: route.message,
          // Only aliases the workspace does not know. A selection that failed
          // for ambiguity or staleness names none.
          unknownRepos: (request.requestedAliases ?? []).filter(
            (alias) => !route.availableRepos.includes(alias),
          ),
          availableRepos: route.availableRepos,
        },
      };
    }
    return {
      outcome: ProductRouteOutcome.ExplicitMember,
      lead: toMember(route.repository),
      supporting: [],
      routing: {
        ...emptyRouting(
          ProductRouteOutcome.ExplicitMember,
          `The request named ${route.repository.alias}.`,
          registry,
        ),
        leadRepository: route.repository.alias,
        routeSource: route.source,
        repositoriesReady: readyAliases.size,
      },
      registry,
      readiness,
      indexesOpenedForRouteProof: [],
      refusedIndexesOpened: [],
      explicitSelectionFailure: null,
    };
  }

  // ---- Auto-routing over the workspace -------------------------------------
  const hints = extractQueryRouteHints(request.query, request.explicitPaths ?? []);
  const opened: string[] = [];
  const refusedOpened: string[] = [];
  const handles: Database[] = [];

  const probe = (repository: RegisteredRepository): RepositoryProbe | null => {
    // Defence in depth. `nominateRepositories` already restricts indexed lanes
    // to ready members; measuring it here means the §145 requirement is proven
    // by the product rather than inherited from the router's tests.
    if (!readyAliases.has(repository.alias)) {
      refusedOpened.push(repository.alias);
      return null;
    }
    try {
      const db = request.openProbeDatabase !== undefined
        ? request.openProbeDatabase(repository)
        // READ-ONLY on purpose: `openIndexerDatabase` would run the schema
        // initialiser, and a read path may not write to a member's index (§21).
        : new Database(resolveIndexDbPath(repository.rootPath), { readonly: true });
      if (db === null) return null;
      handles.push(db);
      opened.push(repository.alias);
      return createDatabaseProbe(db);
    } catch {
      return null;
    }
  };

  try {
    const relevance = nominateRepositories({
      registry,
      readiness,
      ...(hints.pathHints.length > 0 ? { pathHints: hints.pathHints } : {}),
      ...(hints.symbolHints.length > 0 ? { symbolHints: hints.symbolHints } : {}),
      probe,
      ...(request.limits === undefined ? {} : { limits: request.limits }),
      collectSupportingEvidence: request.includeSupporting === true,
    });

    const diagnostics = relevance.diagnostics;
    const base: Omit<ProductRoutingMetadata, "outcome" | "reason" | "routeSource" | "leadRepository"> = {
      isWorkspace: registry.isWorkspace,
      decidingTier: diagnostics.decidingTier,
      supportingRepositories: relevance.supporting.map((repo) => repo.alias),
      supportersInspected: request.includeSupporting === true,
      // Overridden per outcome below; a decided lane proved uniqueness, a sole
      // match did not.
      uniquenessProven: false,
      repositoriesRegistered: diagnostics.reposRegistered,
      repositoriesEnabled: diagnostics.reposEnabled,
      repositoriesReady: diagnostics.reposReady,
      repositoriesDeepProbed: diagnostics.reposDeepProbed,
      excludedNotReady: diagnostics.reposExcludedNotReady.slice(0, MAX_REPORTED_COVERAGE_EXAMPLES),
      excludedNotReadyTotal: diagnostics.reposExcludedNotReadyTotal,
      excludedNotReadyOmitted: diagnostics.reposExcludedNotReadyOmitted,
      candidates: relevance.candidates.map((repo) => repo.alias),
      coverage: diagnostics.coverage,
    };

    if (relevance.status === RepositoryRelevanceStatus.Selected) {
      const lead = relevance.selected[0]!;
      return {
        outcome: ProductRouteOutcome.Routed,
        lead: nomineeToMember(lead),
        supporting: relevance.supporting.map(nomineeToMember),
        routing: {
          ...base,
          outcome: ProductRouteOutcome.Routed,
          reason: relevance.reason,
          routeSource: diagnostics.decidingTier,
          leadRepository: lead.alias,
          uniquenessProven: true,
        },
        registry,
        readiness,
        indexesOpenedForRouteProof: opened,
        refusedIndexesOpened: refusedOpened,
        explicitSelectionFailure: null,
      };
    }

    // ---- Exactly one member matched, uniqueness unproven ---------------------
    //
    // M147 withholds `selected` when a member could not be checked, because
    // "alpha has it" does not establish "only alpha has it". That is the right
    // rule for a UNIQUENESS claim and the wrong one for choosing where to look:
    // it would make a single stale member turn every symbol query in the
    // workspace into a refusal (§88).
    //
    // So when the plausible set holds exactly one member, that member is the
    // only POSITIVE answer anyone gave, and it leads. What is not claimed is
    // that nowhere else defines the name — `uniquenessProven` stays false and
    // the lane's coverage travels with the response, so a consumer can never
    // read this as an absence claim about the members that were refused.
    if (
      relevance.status === RepositoryRelevanceStatus.Ambiguous
      && relevance.candidates.length === 1
    ) {
      const sole = relevance.candidates[0]!;
      if (sole.ready) {
        return {
          outcome: ProductRouteOutcome.SoleEvidenceMatch,
          lead: nomineeToMember(sole),
          supporting: relevance.supporting.map(nomineeToMember),
          routing: {
            ...base,
            outcome: ProductRouteOutcome.SoleEvidenceMatch,
            reason: relevance.reason,
            routeSource: diagnostics.decidingTier,
            leadRepository: sole.alias,
            uniquenessProven: false,
          },
          registry,
          readiness,
          indexesOpenedForRouteProof: opened,
          refusedIndexesOpened: refusedOpened,
          explicitSelectionFailure: null,
        };
      }
    }

    // ---- No evidence decided. Fall back to the workspace's own authority ----
    //
    // An empty selector resolves through M145: a sole member, or an explicitly
    // configured default. Both are declarations the workspace made, not guesses
    // this module invented, and neither reads the query. When the workspace
    // declares neither, M145's own `workspace_repository_required` is the answer
    // and the product abstains (§27, §73).
    if (relevance.status === RepositoryRelevanceStatus.NoMatch) {
      const fallback = routeWorkspaceRequest(registry, {});
      if (fallback.ok) {
        return {
          outcome: ProductRouteOutcome.ConfiguredMember,
          lead: toMember(fallback.repository),
          supporting: [],
          routing: {
            ...base,
            outcome: ProductRouteOutcome.ConfiguredMember,
            reason: `No routing evidence in the request; the workspace's ${fallback.source} answered.`,
            routeSource: fallback.source,
            leadRepository: fallback.repository.alias,
            // Support discovery is meaningless when nothing chose the lead.
            supportingRepositories: [],
          },
          registry,
          readiness,
          indexesOpenedForRouteProof: opened,
          refusedIndexesOpened: refusedOpened,
          explicitSelectionFailure: null,
        };
      }
    }

    const outcome = relevance.status === RepositoryRelevanceStatus.NotReady
      ? ProductRouteOutcome.NoUsableMember
      : ProductRouteOutcome.Abstained;

    return {
      outcome,
      lead: null,
      supporting: [],
      routing: { ...base, outcome, reason: relevance.reason, routeSource: null, leadRepository: null },
      registry,
      readiness,
      indexesOpenedForRouteProof: opened,
      refusedIndexesOpened: refusedOpened,
      explicitSelectionFailure: null,
    };
  } finally {
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // A probe handle that cannot close must not fail the request.
      }
    }
  }
}

/**
 * The explicit selection carried by the request, or null when the caller named
 * nothing and routing is allowed to decide.
 */
function buildExplicitSelector(request: ProductRouteRequest): WorkspaceRouteSelector | null {
  const aliases = request.requestedAliases ?? [];
  // More than one alias is a multi-repository REQUEST, which the product surface
  // validates before it gets here. Routing must not silently reinterpret it as
  // "no selection" and pick a lead by evidence.
  if (aliases.length === 1) {
    return { alias: aliases[0]! };
  }
  if (request.requestedRoot !== undefined && request.requestedRoot.trim().length > 0) {
    return { repoPath: request.requestedRoot };
  }
  return null;
}
