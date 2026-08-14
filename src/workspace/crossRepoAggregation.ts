/**
 * M146-B Workstream B4: assemble bounded context from several repositories.
 *
 * The hard constraint is that N repositories do not create N times the model
 * budget. One request has one budget, and repositories compete inside it.
 *
 * What this deliberately does NOT do is compare raw retrieval scores across
 * repositories. Each repository's ranking was calibrated against its own corpus
 * by M122-M145, and nothing has established that A's 1.9 outranks B's 1.8 or
 * even that rank 1 in A is worth rank 1 in B. So aggregation consumes only the
 * LOCAL RANK each repository assigned, which is meaningful within a repository
 * by construction, and takes repository order from routing evidence rather than
 * from any score.
 *
 * Admission runs in rounds of local rank: every selected repository offers its
 * rank 1, then its rank 2, and so on. That gives the primary repository's best
 * answer the lead slot before any support is considered, so cross-repository
 * mode cannot displace a strong direct answer for the sake of looking diverse —
 * while still letting a second repository contribute when the task genuinely
 * spans both.
 *
 * Provenance is never collapsed. Two repositories may hold the same relative
 * path, the same fully-qualified name, and byte-identical contents; M145's
 * principle is that computation may be shared but authority may not, so identity
 * here is always (worktreeId, path, symbol) and never any part of it alone.
 */

export interface CrossRepoCandidate {
  readonly repositoryAlias: string;
  readonly repositoryId: string | null;
  readonly worktreeId: string | null;
  readonly relativePath: string;
  readonly symbol: string | null;
  /** 1-based rank assigned by this repository's own retrieval. */
  readonly localRank: number;
  /** Kept for reporting only. Never compared across repositories. */
  readonly localScore?: number | undefined;
  readonly tokens: number;
}

export interface AggregatedCandidate extends CrossRepoCandidate {
  /** Position in the delivered context, 1-based. */
  readonly globalRank: number;
  readonly role: "lead" | "support";
}

export interface CrossRepoBudgetReport {
  readonly totalBudget: number;
  readonly totalSelectedTokens: number;
  readonly perRepository: readonly {
    readonly repositoryAlias: string;
    readonly worktreeId: string | null;
    readonly candidatesAvailable: number;
    readonly candidatesSelected: number;
    readonly selectedTokens: number;
    readonly candidatesOmitted: number;
  }[];
  readonly repositoriesConsidered: number;
  readonly repositoriesContributing: number;
}

export interface CrossRepoAggregation {
  /** The single global lead, or null when nothing fit. */
  readonly lead: AggregatedCandidate | null;
  readonly selected: readonly AggregatedCandidate[];
  readonly budget: CrossRepoBudgetReport;
}

export interface CrossRepoAggregationInput {
  /**
   * Selected repositories in ROUTING order — strongest evidence first. Order is
   * the caller's declared decision, not something re-derived from scores here.
   */
  readonly repositories: readonly {
    readonly alias: string;
    readonly candidates: readonly CrossRepoCandidate[];
  }[];
  /** The one model budget this request has, in tokens. */
  readonly totalBudget: number;
  /** Cap on delivered items, independent of the token budget. */
  readonly maxCandidates?: number;
}

const DEFAULT_MAX_CANDIDATES = 24;

export function aggregateCrossRepoContext(input: CrossRepoAggregationInput): CrossRepoAggregation {
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const queues = input.repositories.map((repository) => ({
    alias: repository.alias,
    // Sorted by the repository's own rank; ties keep input order, which is that
    // repository's own decision rather than ours.
    remaining: [...repository.candidates].sort((left, right) => left.localRank - right.localRank),
    available: repository.candidates.length,
    selected: 0,
    tokens: 0,
    worktreeId: repository.candidates[0]?.worktreeId ?? null,
  }));

  const selected: AggregatedCandidate[] = [];
  const admitted = new Set<string>();
  let spent = 0;

  // Round-robin by local rank. The first admission is the primary repository's
  // best candidate, which is what keeps a direct answer from being evicted by
  // support from elsewhere.
  let round = 0;
  let progressed = true;
  while (progressed && selected.length < maxCandidates) {
    progressed = false;
    for (const queue of queues) {
      if (queue.remaining.length === 0) continue;
      progressed = true;
      const candidate = queue.remaining.shift()!;

      const key = identityKey(candidate);
      if (admitted.has(key)) continue;

      if (selected.length >= maxCandidates) break;
      if (spent + candidate.tokens > input.totalBudget) {
        // Out of budget for this one. Other repositories may still have cheaper
        // candidates, so the round continues rather than stopping outright.
        continue;
      }

      admitted.add(key);
      spent += candidate.tokens;
      queue.selected += 1;
      queue.tokens += candidate.tokens;
      selected.push({
        ...candidate,
        globalRank: selected.length + 1,
        role: selected.length === 0 ? "lead" : "support",
      });
    }
    round += 1;
    if (round > 1000) break;
  }

  return {
    lead: selected[0] ?? null,
    selected,
    budget: {
      totalBudget: input.totalBudget,
      totalSelectedTokens: spent,
      perRepository: queues.map((queue) => ({
        repositoryAlias: queue.alias,
        worktreeId: queue.worktreeId,
        candidatesAvailable: queue.available,
        candidatesSelected: queue.selected,
        selectedTokens: queue.tokens,
        candidatesOmitted: queue.available - queue.selected,
      })),
      repositoriesConsidered: queues.length,
      repositoriesContributing: queues.filter((queue) => queue.selected > 0).length,
    },
  };
}

/**
 * The identity two cross-repository candidates are the same by. Every component
 * of it is required: sharing a relative path, a symbol name, or even byte
 * contents does not make two files in different repositories one file.
 */
function identityKey(candidate: CrossRepoCandidate): string {
  return [candidate.worktreeId ?? candidate.repositoryAlias, candidate.relativePath, candidate.symbol ?? ""].join("\0");
}

/**
 * Model-visible provenance for a delivered candidate. Only rendered when more
 * than one repository contributed: labelling every line of an ordinary
 * single-repository answer costs budget and tells the reader nothing.
 */
export function formatRepositoryProvenance(
  candidate: AggregatedCandidate,
  contributingRepositories: number,
): string {
  const location = candidate.symbol === null
    ? candidate.relativePath
    : `${candidate.relativePath}::${candidate.symbol}`;
  return contributingRepositories > 1 ? `[repository: ${candidate.repositoryAlias}] ${location}` : location;
}
