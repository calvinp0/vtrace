/**
 * M160 §10-§18 — Broad100-B construction primitives.
 *
 * PURE. Every function here is a deterministic function of benchmark metadata
 * that never mentions VTRACE: repository, gold patch, problem statement and the
 * SWE-bench Verified `difficulty` label. Nothing in this module may read a
 * retrieval result, a capsule, an index or a score (§13) — the corpus has to be
 * frozen before the product is ever pointed at it.
 *
 * The selection rule is BALANCED rather than proportional. Broad100-A is 44%
 * django, and M159's largest residual class was 8 cases across 4 repositories
 * with a heavy sympy weight. The question M160 exists to answer is whether a
 * mechanism is repository-general (§19, §55), and a corpus that spends nearly
 * half its cases on one repository has little power to answer that. So the quota
 * fills every eligible repository equally up to its available pool, and the
 * shortfall from small repositories redistributes to the rest.
 *
 * The cost is that aggregate rates are NOT directly comparable to Broad100-A's
 * repository mix; §64 already expects different difficulty, and M160-E reports
 * the comparison both raw and reweighted to A's mix.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A SWE-bench Verified row, narrowed to the fields corpus construction uses. */
export interface VerifiedInstance {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string;
  readonly patch: string;
  readonly problem_statement: string;
  readonly difficulty: string;
}

/** A pool member plus the gold labels derived from its reference patch. */
export interface PoolCandidate {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly difficulty: string;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
  /**
   * Gold files the reference patch CREATES. They cannot exist at the base commit
   * and their absence there is correct, not a corpus defect (§80) — but they are
   * also unretrievable by construction, so an instance whose gold is entirely new
   * files is not a retrieval instance at all.
   */
  readonly goldFilesCreatedByPatch: readonly string[];
}

/**
 * The subtree each repository's Stage 5 workspace is archived from, inherited
 * from Broad100-A's preparation rather than chosen here.
 *
 * Broad100-A prepared django from the bench clone's `django/` PACKAGE directory
 * and every other repository from its repository root, so a django workspace
 * holds ~827 .py files and carries no `tests/`, `docs/` or `scripts/`, while an
 * astropy workspace holds the whole repository. The asymmetry is a property of
 * the corpus M160 is replicating against; reproducing it keeps the comparison
 * about retrieval, and "fixing" it here would confound a protocol change with the
 * replication result (§119).
 */
export const ARCHIVE_SUBTREE_BY_REPO: Readonly<Record<string, string>> = {
  "django/django": "django",
};

export function archiveSubtree(repo: string): string {
  return ARCHIVE_SUBTREE_BY_REPO[repo] ?? "";
}

/**
 * Is a repo-relative gold path inside the subtree the workspace is archived
 * from? A gold file outside it can never be indexed, so counting its absence as
 * a product failure would be the §80 error in a new costume.
 */
export function withinArchiveSubtree(repo: string, goldPath: string): boolean {
  const subtree = archiveSubtree(repo);
  if (subtree.length === 0) return true;
  return goldPath === subtree || goldPath.startsWith(`${subtree}/`);
}

/**
 * The gold path as it appears INSIDE the workspace: the archive strips the
 * subtree prefix, so django's `django/db/models/aggregates.py` is on disk as
 * `db/models/aggregates.py`.
 */
export function goldPathInWorkspace(repo: string, goldPath: string): string {
  const subtree = archiveSubtree(repo);
  if (subtree.length === 0) return goldPath;
  return goldPath.startsWith(`${subtree}/`) ? goldPath.slice(subtree.length + 1) : goldPath;
}

/** Files a unified diff CREATES (`new file mode` / `--- /dev/null`). */
export function createdFilesInPatch(patch: string): string[] {
  const created = new Set<string>();
  const lines = patch.split(/\r?\n/);
  let newFile = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      newFile = false;
      continue;
    }
    if (line.startsWith("new file mode")) {
      newFile = true;
      continue;
    }
    if (line.startsWith("--- /dev/null")) {
      newFile = true;
      continue;
    }
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    if (match) {
      if (newFile) created.add(match[1]!.trim());
      newFile = false;
    }
  }
  return [...created].sort();
}

export type PoolExclusionReason =
  | "IN_BROAD100A"
  | "NO_LOCAL_BENCH_CLONE"
  | "NO_GOLD_FILES"
  | "GOLD_OUTSIDE_INDEXED_SUBTREE"
  | "GOLD_ONLY_CREATED_BY_PATCH"
  | "EMPTY_PROBLEM_STATEMENT"
  | "MISSING_BASE_COMMIT";

export interface PoolExclusion {
  readonly instanceId: string;
  readonly repo: string;
  readonly reason: PoolExclusionReason;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Deterministic ordering (§16)
// ---------------------------------------------------------------------------

/**
 * The selection salt. It is the seed §16 asks for, in the form of a fixed
 * string rather than a PRNG state: ordering by `sha256(salt + instance_id)` is a
 * fixed permutation of the pool, so the same pool always yields the same sample
 * with no dependence on iteration order or on how many draws preceded it.
 */
export const SELECTION_SALT = "VTRACE-M160-Broad100-B-v1" as const;

export function selectionKey(instanceId: string, salt: string = SELECTION_SALT): string {
  return createHash("sha256").update(`${salt}:${instanceId}`).digest("hex");
}

/** Order a stratum by its fixed permutation, ties broken by instance id. */
export function hashOrder<T extends { readonly instanceId: string }>(
  items: readonly T[],
  salt: string = SELECTION_SALT,
): T[] {
  return [...items].sort((a, b) => {
    const ka = selectionKey(a.instanceId, salt);
    const kb = selectionKey(b.instanceId, salt);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.instanceId < b.instanceId ? -1 : 1;
  });
}

// ---------------------------------------------------------------------------
// Repository quota (§18)
// ---------------------------------------------------------------------------

/**
 * Water-fill `target` cases across repositories, equally, bounded by what each
 * repository actually has. A repository smaller than its equal share is filled
 * to its pool and its shortfall redistributes over the rest; the final partial
 * round hands out single cases in repository-name order so the result does not
 * depend on map iteration order.
 */
export function allocateRepositoryQuota(
  poolByRepo: ReadonlyMap<string, number>,
  target: number,
): Map<string, number> {
  const quota = new Map<string, number>();
  const repos = [...poolByRepo.keys()].filter((repo) => (poolByRepo.get(repo) ?? 0) > 0).sort();
  for (const repo of repos) quota.set(repo, 0);

  let remaining = Math.min(
    target,
    repos.reduce((sum, repo) => sum + (poolByRepo.get(repo) ?? 0), 0),
  );

  while (remaining > 0) {
    const active = repos.filter((repo) => (quota.get(repo) ?? 0) < (poolByRepo.get(repo) ?? 0));
    if (active.length === 0) break;
    const base = Math.floor(remaining / active.length);
    if (base === 0) {
      for (const repo of active) {
        if (remaining === 0) break;
        quota.set(repo, (quota.get(repo) ?? 0) + 1);
        remaining -= 1;
      }
      break;
    }
    for (const repo of active) {
      const headroom = (poolByRepo.get(repo) ?? 0) - (quota.get(repo) ?? 0);
      const take = Math.min(base, headroom);
      quota.set(repo, (quota.get(repo) ?? 0) + take);
      remaining -= take;
    }
  }
  return quota;
}

/**
 * Split a repository's quota across its `difficulty` strata in proportion to the
 * strata present in that repository's pool, by largest remainder. Difficulty is
 * a published SWE-bench Verified annotation, so the split preserves each
 * repository's own difficulty profile without consulting anything VTRACE knows.
 */
export function allocateDifficultyQuota(
  strataSizes: ReadonlyMap<string, number>,
  repoQuota: number,
): Map<string, number> {
  const strata = [...strataSizes.keys()].filter((key) => (strataSizes.get(key) ?? 0) > 0).sort();
  const total = strata.reduce((sum, key) => sum + (strataSizes.get(key) ?? 0), 0);
  const quota = new Map<string, number>();
  if (total === 0 || repoQuota <= 0) {
    for (const key of strata) quota.set(key, 0);
    return quota;
  }

  const exact = strata.map((key) => ({
    key,
    ideal: (repoQuota * (strataSizes.get(key) ?? 0)) / total,
  }));
  let assigned = 0;
  for (const entry of exact) {
    const floored = Math.min(Math.floor(entry.ideal), strataSizes.get(entry.key) ?? 0);
    quota.set(entry.key, floored);
    assigned += floored;
  }

  // Largest remainder, then strictly by stratum name, so ties are reproducible.
  const byRemainder = [...exact].sort((a, b) => {
    const ra = a.ideal - Math.floor(a.ideal);
    const rb = b.ideal - Math.floor(b.ideal);
    if (ra !== rb) return rb - ra;
    return a.key < b.key ? -1 : 1;
  });
  let cursor = 0;
  while (assigned < repoQuota && cursor < byRemainder.length * 4) {
    const entry = byRemainder[cursor % byRemainder.length]!;
    const size = strataSizes.get(entry.key) ?? 0;
    if ((quota.get(entry.key) ?? 0) < size) {
      quota.set(entry.key, (quota.get(entry.key) ?? 0) + 1);
      assigned += 1;
    }
    cursor += 1;
  }
  return quota;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectionResult {
  readonly selected: readonly PoolCandidate[];
  readonly quotaByRepo: ReadonlyMap<string, number>;
  readonly quotaByStratum: ReadonlyMap<string, number>;
}

/**
 * Freeze a sample of `target` candidates. The pool handed in must already be
 * integrity-valid (§22): selection never sees, and therefore can never react to,
 * an instance that would later be excluded.
 */
export function selectCorpus(
  pool: readonly PoolCandidate[],
  target: number,
  salt: string = SELECTION_SALT,
): SelectionResult {
  const byRepo = new Map<string, PoolCandidate[]>();
  for (const candidate of pool) {
    const bucket = byRepo.get(candidate.repo) ?? [];
    bucket.push(candidate);
    byRepo.set(candidate.repo, bucket);
  }
  const sizes = new Map<string, number>([...byRepo].map(([repo, items]) => [repo, items.length]));
  const quotaByRepo = allocateRepositoryQuota(sizes, target);

  const selected: PoolCandidate[] = [];
  const quotaByStratum = new Map<string, number>();
  for (const repo of [...byRepo.keys()].sort()) {
    const items = byRepo.get(repo) ?? [];
    const repoQuota = quotaByRepo.get(repo) ?? 0;
    const strataSizes = new Map<string, number>();
    for (const item of items) {
      strataSizes.set(item.difficulty, (strataSizes.get(item.difficulty) ?? 0) + 1);
    }
    const strataQuota = allocateDifficultyQuota(strataSizes, repoQuota);
    let taken = 0;
    for (const stratum of [...strataQuota.keys()].sort()) {
      const want = strataQuota.get(stratum) ?? 0;
      if (want === 0) continue;
      const members = hashOrder(items.filter((item) => item.difficulty === stratum), salt);
      const picked = members.slice(0, want);
      selected.push(...picked);
      taken += picked.length;
      quotaByStratum.set(`${repo}|${stratum}`, picked.length);
    }
    // A stratum can only under-deliver if its quota exceeded its size, which
    // allocateDifficultyQuota forbids; the guard keeps the invariant explicit.
    if (taken !== repoQuota) {
      throw new Error(`repository ${repo} filled ${taken} of quota ${repoQuota}`);
    }
  }

  selected.sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));
  return { selected, quotaByRepo, quotaByStratum };
}

// ---------------------------------------------------------------------------
// Disjointness (§11)
// ---------------------------------------------------------------------------

export interface DisjointnessResult {
  readonly overlap: readonly string[];
  readonly disjoint: boolean;
  readonly aCount: number;
  readonly bCount: number;
}

/** Mechanical overlap assertion — never a visual inspection (§11). */
export function assertDisjoint(
  broadA: readonly string[],
  broadB: readonly string[],
): DisjointnessResult {
  const a = new Set(broadA);
  const overlap = [...new Set(broadB.filter((id) => a.has(id)))].sort();
  return { overlap, disjoint: overlap.length === 0, aCount: a.size, bCount: new Set(broadB).size };
}
