/**
 * M146-B: workspace retrieval through the authoritative product context.
 *
 * This composes `assembleProductContext` rather than replacing or reimplementing
 * it. Repository-local retrieval keeps every semantic M122-M145 established,
 * because it is literally the same call; what this adds is deciding WHICH
 * repositories to make that call against, and merging the results under one
 * budget when a task genuinely spans two.
 *
 * Two consequences are deliberate.
 *
 * Single-repository behaviour is untouched by construction, not by careful
 * matching. Ordinary requests never reach this module at all, and a workspace
 * that resolves to one repository returns that repository's own response
 * object — same items, same lead, same accounting — with bounded routing
 * metadata beside it. There is no second capsule and no parallel selection
 * pipeline; M142 already measured what duplicated context representations cost.
 *
 * And the readiness gate survives orchestration. Repositories are chosen before
 * any index is opened for retrieval, so a member whose derivation this runtime
 * refused is excluded from the decision rather than filtered out of its results.
 */
import type { Database } from "bun:sqlite";

import type { ProductContextItem, ProductContextResponse } from "../productContext/types";
import { aggregateCrossRepoContext, type CrossRepoCandidate } from "./crossRepoAggregation";
import type { RegisteredRepository, WorkspaceRegistry, WorkspaceRouteSelector } from "./registry";
import type { WorkspaceReadiness } from "./readiness";
import {
  nominateRepositories,
  RepositoryRelevanceStatus,
  type RepositoryProbe,
  type RepositoryRelevance,
  type RepositoryRelevanceLimits,
} from "./repositoryRelevance";

/** One repository's retrieval, as this module needs to invoke it. */
export type RepositoryContextAssembler = (input: {
  readonly repository: RegisteredRepository;
  readonly db: Database;
  readonly task: string;
  readonly budgetTokens: number | undefined;
}) => Promise<ProductContextResponse>;

export interface WorkspaceProductContextInput {
  readonly registry: WorkspaceRegistry;
  readonly readiness: WorkspaceReadiness;
  readonly task: string;
  readonly budgetTokens?: number | undefined;
  readonly selector?: WorkspaceRouteSelector | undefined;
  readonly pathHints?: readonly string[] | undefined;
  readonly symbolHints?: readonly string[] | undefined;
  /**
   * Allow a second repository to contribute bounded support. Off by default so
   * an ordinary workspace query costs exactly what routing measured.
   */
  readonly compose?: boolean | undefined;
  /** Bounded read-only probe for routing. Only ever called for ready members. */
  readonly probe?: ((repository: RegisteredRepository) => RepositoryProbe | null) | undefined;
  /** Opens a member's index for RETRIEVAL. Called only for selected members. */
  readonly openRepository: (repository: RegisteredRepository) => Database | null;
  readonly assemble: RepositoryContextAssembler;
  readonly limits?: RepositoryRelevanceLimits | undefined;
}

export interface WorkspaceRoutingSummary {
  readonly autoRouted: boolean;
  readonly status: RepositoryRelevanceStatus;
  readonly reason: string;
  readonly decidingTier: string | null;
  readonly leadRepository: string | null;
  readonly supportingRepositories: readonly string[];
  readonly repositoriesRegistered: number;
  readonly repositoriesReady: number;
  readonly repositoriesDeepProbed: number;
  /** Members excluded because their index cannot answer. Never "low relevance". */
  readonly excludedNotReady: readonly { readonly alias: string; readonly reason: string }[];
  readonly candidates: readonly string[];
}

export interface WorkspaceProductContextResult {
  readonly routing: WorkspaceRoutingSummary;
  /** null when routing did not resolve to a queryable repository. */
  readonly context: ProductContextResponse | null;
  /** Per-repository token accounting when more than one contributed. */
  readonly perRepository: readonly {
    readonly alias: string;
    readonly itemsSelected: number;
    readonly tokens: number;
    readonly itemsOmitted: number;
  }[];
  /** Indexes opened for retrieval, in order. The stale-index control reads this. */
  readonly indexesOpenedForRetrieval: readonly string[];
}

export async function assembleWorkspaceProductContext(
  input: WorkspaceProductContextInput,
): Promise<WorkspaceProductContextResult> {
  const relevance = nominateRepositories({
    registry: input.registry,
    readiness: input.readiness,
    selector: input.selector,
    pathHints: input.pathHints,
    symbolHints: input.symbolHints,
    probe: input.probe,
    limits: input.limits,
    collectSupportingEvidence: input.compose === true,
  });

  const summary = summarize(relevance, input.compose === true);

  // Ambiguous, no_match and not_ready all stop here. Retrieving "the best
  // guess" from an ambiguous set would be the silent first-match this milestone
  // exists to prevent, and retrieving from a not_ready member would consume the
  // derivation the runtime already refused.
  if (relevance.status !== RepositoryRelevanceStatus.Selected) {
    return { routing: summary, context: null, perRepository: [], indexesOpenedForRetrieval: [] };
  }

  const opened: string[] = [];
  const lead = relevance.selected[0]!;
  const leadRepository = findMember(input.registry, lead.alias);
  if (leadRepository === null) {
    return { routing: summary, context: null, perRepository: [], indexesOpenedForRetrieval: [] };
  }

  const leadDb = input.openRepository(leadRepository);
  if (leadDb === null) {
    return { routing: summary, context: null, perRepository: [], indexesOpenedForRetrieval: [] };
  }
  opened.push(lead.alias);
  const leadContext = await input.assemble({
    repository: leadRepository,
    db: leadDb,
    task: input.task,
    budgetTokens: input.budgetTokens,
  });

  const supporting = input.compose === true ? relevance.supporting : [];
  if (supporting.length === 0) {
    // Exactly one repository contributed. Return ITS response, so a
    // one-repository workspace is indistinguishable from querying that
    // repository directly.
    return {
      routing: summary,
      context: leadContext,
      perRepository: [{
        alias: lead.alias,
        itemsSelected: leadContext.items.length,
        tokens: leadContext.accounting.usedTokensEstimate,
        itemsOmitted: 0,
      }],
      indexesOpenedForRetrieval: opened,
    };
  }

  const contributions = [{ alias: lead.alias, response: leadContext }];
  for (const supporter of supporting) {
    const member = findMember(input.registry, supporter.alias);
    if (member === null) continue;
    const db = input.openRepository(member);
    if (db === null) continue;
    opened.push(supporter.alias);
    contributions.push({
      alias: supporter.alias,
      response: await input.assemble({
        repository: member,
        db,
        task: input.task,
        budgetTokens: input.budgetTokens,
      }),
    });
  }

  return {
    routing: summary,
    ...mergeContributions(contributions, leadContext, input.budgetTokens),
    indexesOpenedForRetrieval: opened,
  };
}

/**
 * Merge several repositories' responses into ONE product context under a single
 * shared budget. The lead repository's response is the base, so its request-level
 * facts (repository identity, freshness, intent) stay authoritative rather than
 * being recomputed from a blend.
 */
function mergeContributions(
  contributions: readonly { alias: string; response: ProductContextResponse }[],
  leadContext: ProductContextResponse,
  budgetTokens: number | undefined,
): Pick<WorkspaceProductContextResult, "context" | "perRepository"> {
  const budget = budgetTokens ?? leadContext.accounting.budgetTokens ?? Number.MAX_SAFE_INTEGER;

  const aggregated = aggregateCrossRepoContext({
    totalBudget: budget,
    repositories: contributions.map((contribution) => ({
      alias: contribution.alias,
      candidates: contribution.response.items.map((item, index) => toCandidate(contribution, item, index)),
    })),
  });

  const itemByKey = new Map<string, { alias: string; item: ProductContextItem }>();
  for (const contribution of contributions) {
    for (const item of contribution.response.items) {
      itemByKey.set(candidateKey(contribution.alias, item), { alias: contribution.alias, item });
    }
  }

  const contributingRepositories = aggregated.budget.repositoriesContributing;
  const items: ProductContextItem[] = [];
  for (const selected of aggregated.selected) {
    const source = itemByKey.get(candidateKey(selected.repositoryAlias, {
      path: selected.relativePath,
      symbol: selected.symbol ?? undefined,
    } as ProductContextItem));
    if (source === undefined) continue;
    items.push({
      ...source.item,
      metadata: {
        ...(source.item.metadata ?? {}),
        // Provenance travels with the item rather than being reconstructed from
        // position. Two repositories may hold the same path and the same name.
        repository: {
          alias: selected.repositoryAlias,
          repositoryId: selected.repositoryId,
          worktreeId: selected.worktreeId,
        },
        ...(contributingRepositories > 1 ? { crossRepositoryRole: selected.role } : {}),
      },
    });
  }

  const usedTokens = aggregated.budget.totalSelectedTokens;
  const context: ProductContextResponse = {
    ...leadContext,
    items,
    accounting: {
      ...leadContext.accounting,
      budgetTokens: budgetTokens ?? leadContext.accounting.budgetTokens,
      usedTokensEstimate: usedTokens,
    },
    roleCounts: recountRoles(leadContext, items),
  };

  return {
    context,
    perRepository: aggregated.budget.perRepository.map((repo) => ({
      alias: repo.repositoryAlias,
      itemsSelected: repo.candidatesSelected,
      tokens: repo.selectedTokens,
      itemsOmitted: repo.candidatesOmitted,
    })),
  };
}

function toCandidate(
  contribution: { alias: string; response: ProductContextResponse },
  item: ProductContextItem,
  index: number,
): CrossRepoCandidate {
  return {
    repositoryAlias: contribution.alias,
    repositoryId: contribution.response.repository.repositoryId,
    worktreeId: contribution.response.repository.worktreeId,
    relativePath: item.path ?? "",
    symbol: item.symbol ?? null,
    // The repository's own ordering IS its rank. Nothing here re-ranks it.
    localRank: index + 1,
    tokens: item.estimatedTokens,
  };
}

function candidateKey(alias: string, item: Pick<ProductContextItem, "path" | "symbol">): string {
  return [alias, item.path ?? "", item.symbol ?? ""].join("\0");
}

function recountRoles(
  leadContext: ProductContextResponse,
  items: readonly ProductContextItem[],
): ProductContextResponse["roleCounts"] {
  const counts = Object.fromEntries(
    Object.keys(leadContext.roleCounts).map((role) => [role, 0]),
  ) as ProductContextResponse["roleCounts"];
  for (const item of items) {
    for (const role of item.roles) {
      if (role in counts) counts[role] += 1;
    }
  }
  return counts;
}

function findMember(registry: WorkspaceRegistry, alias: string): RegisteredRepository | null {
  return registry.repositories.find((repo) => repo.alias === alias) ?? null;
}

function summarize(relevance: RepositoryRelevance, composed: boolean): WorkspaceRoutingSummary {
  return {
    autoRouted: true,
    status: relevance.status,
    reason: relevance.reason,
    decidingTier: relevance.diagnostics.decidingTier,
    leadRepository: relevance.selected[0]?.alias ?? null,
    supportingRepositories: composed ? relevance.supporting.map((repo) => repo.alias) : [],
    repositoriesRegistered: relevance.diagnostics.reposRegistered,
    repositoriesReady: relevance.diagnostics.reposReady,
    repositoriesDeepProbed: relevance.diagnostics.reposDeepProbed,
    excludedNotReady: relevance.diagnostics.reposExcludedNotReady,
    // Bounded: the plausible set, never the workspace.
    candidates: relevance.candidates.map((repo) => repo.alias),
  };
}
