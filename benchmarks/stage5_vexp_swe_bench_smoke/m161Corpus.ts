/**
 * M161 §10-§22 — fresh paired live-utility corpus construction.
 *
 * PURE. Every function is a deterministic function of SWE-bench Verified
 * metadata: instance id, repository, base commit, problem statement, reference
 * patch and the published `difficulty` annotation. Nothing here may read a
 * retrieval result, a capsule, an index, a lead or a score (§14) — the corpus is
 * frozen before the product is ever pointed at it.
 *
 * WHY THIS IS NOT `m160Corpus.buildCandidatePool`
 * -----------------------------------------------
 * M160's pool builder drops two classes that M161 must KEEP, and keeping them is
 * the whole difference between a retrieval corpus and a live-agent corpus:
 *
 *   GOLD_OUTSIDE_INDEXED_SUBTREE — M160 archived django from the `django/`
 *     PACKAGE directory, so gold outside it was unreachable by construction. M161
 *     does not archive anything: `prepareWorkspaceForInstance` clones the WHOLE
 *     repository at the base commit, so the exclusion describes a workspace shape
 *     that does not exist here.
 *
 *   GOLD_ONLY_CREATED_BY_PATCH — a task whose fix is entirely new files is
 *     unretrievable, but it is a perfectly ordinary coding-agent task. Dropping it
 *     would remove precisely the cases where VTRACE has least to offer, which is
 *     conditioning the sample on treatment performance — the thing §14 forbids.
 *
 * So M161 excludes only what makes an instance un-runnable or un-gradable as a
 * BENCHMARK, never what makes it unflattering as a TREATMENT.
 */

import { createHash } from "node:crypto";

import {
  type PoolCandidate,
  type VerifiedInstance,
  allocateDifficultyQuota,
  allocateRepositoryQuota,
  createdFilesInPatch,
  hashOrder,
} from "./m160Corpus";
import { type OrderedCase, orderCases } from "./stage5_m155_paired_selection";

export type { OrderedCase, PoolCandidate, VerifiedInstance };
export { allocateDifficultyQuota, allocateRepositoryQuota, hashOrder, orderCases };

/**
 * The selection salt (§17). It is the seed, in the form of a fixed string rather
 * than a PRNG state: ordering a stratum by `sha256(salt:instance_id)` is a fixed
 * permutation of the pool, independent of iteration order or of how many draws
 * preceded it. A NEW salt per milestone, so M161's sample is not M160's sample
 * shifted by an offset.
 */
export const M161_SELECTION_SALT = "VTRACE-M161-Paired-Utility-v1" as const;

/** A Verified row narrowed to what live-corpus construction reads. */
export interface LiveVerifiedInstance extends VerifiedInstance {
  /** FAIL_TO_PASS, already parsed. An instance with none cannot be graded. */
  readonly failToPass: readonly string[];
}

export type LiveExclusionReason =
  | "IN_BROAD100A"
  | "IN_BROAD100B"
  | "NO_LOCAL_BENCH_CLONE"
  | "MISSING_BASE_COMMIT"
  | "EMPTY_PROBLEM_STATEMENT"
  | "NO_GOLD_FILES"
  | "EMPTY_FAIL_TO_PASS";

export interface LiveExclusion {
  readonly instanceId: string;
  readonly repo: string;
  readonly reason: LiveExclusionReason;
  readonly detail: string;
}

export interface LivePoolBuild {
  readonly candidates: readonly PoolCandidate[];
  readonly exclusions: readonly LiveExclusion[];
}

/** `django/django` -> `django__django`, the on-disk bench clone name. */
export function benchCloneName(repo: string): string {
  return repo.replace("/", "__");
}

/** Gold source files a unified diff touches, in sorted order. */
export function goldFilesInPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const file = match[1]!.trim();
    if (file.length > 0 && file !== "/dev/null") files.add(file);
  }
  return [...files].sort();
}

/**
 * §10-§11, §20 — the eligible pool, with every drop reasoned.
 *
 * `consumed` is the mechanically reconstructed Broad100-A ∪ Broad100-B; the two
 * are passed separately so an overlap is attributed to the corpus that owns it
 * rather than collapsed into one "already used" bucket.
 */
export function buildLivePool(args: {
  readonly verified: readonly LiveVerifiedInstance[];
  readonly broadA: ReadonlySet<string>;
  readonly broadB: ReadonlySet<string>;
  readonly benchCloneExists: (repo: string) => boolean;
}): LivePoolBuild {
  const { verified, broadA, broadB, benchCloneExists } = args;
  const candidates: PoolCandidate[] = [];
  const exclusions: LiveExclusion[] = [];

  for (const row of [...verified].sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1))) {
    const drop = (reason: LiveExclusionReason, detail: string): void => {
      exclusions.push({ instanceId: row.instance_id, repo: row.repo, reason, detail });
    };
    if (broadA.has(row.instance_id)) {
      drop("IN_BROAD100A", "consumed as Broad100-A development/audit evidence");
      continue;
    }
    if (broadB.has(row.instance_id)) {
      drop("IN_BROAD100B", "consumed as Broad100-B independent replication evidence");
      continue;
    }
    if (!benchCloneExists(row.repo)) {
      drop("NO_LOCAL_BENCH_CLONE", `no bench clone at ${benchCloneName(row.repo)}`);
      continue;
    }
    if (row.base_commit.trim().length === 0) {
      drop("MISSING_BASE_COMMIT", "empty base_commit — no source revision to pin either arm to");
      continue;
    }
    if (row.problem_statement.trim().length === 0) {
      drop("EMPTY_PROBLEM_STATEMENT", "no problem statement — the agent would receive no task");
      continue;
    }
    if (row.failToPass.length === 0) {
      drop("EMPTY_FAIL_TO_PASS", "no FAIL_TO_PASS tests — the outcome would not be gradable");
      continue;
    }
    const goldFiles = goldFilesInPatch(row.patch);
    if (goldFiles.length === 0) {
      drop("NO_GOLD_FILES", "reference patch names no file — benchmark integrity cannot be checked");
      continue;
    }
    const created = new Set(createdFilesInPatch(row.patch));
    candidates.push({
      instanceId: row.instance_id,
      repo: row.repo,
      baseCommit: row.base_commit,
      difficulty: row.difficulty,
      expectedFiles: goldFiles,
      // Symbols are an evaluation aid only; M161 grades on FAIL_TO_PASS, so the
      // corpus carries the gold FILES it must integrity-check and nothing more.
      expectedSymbols: [],
      goldFilesCreatedByPatch: goldFiles.filter((file) => created.has(file)),
    });
  }
  return { candidates, exclusions };
}

// ---------------------------------------------------------------------------
// Selection (§15-§17)
// ---------------------------------------------------------------------------

export interface LiveSelection {
  /** The frozen ordering over the whole drawn sample. Any prefix is the paired-N set. */
  readonly ordered: readonly OrderedCase[];
  readonly quotaByRepo: ReadonlyMap<string, number>;
  readonly quotaByStratum: ReadonlyMap<string, number>;
}

/**
 * Draw `target` cases with a BALANCED repository quota, then impose the M155
 * largest-deficit ordering on them so any prefix is approximately proportional to
 * the drawn sample.
 *
 * Two different balances are doing two different jobs and it is worth being
 * explicit about which is which. The repository QUOTA is balanced against the
 * eligible pool (§16): the pool is 59% django, and a proportional draw would make
 * M161 a django experiment. The ORDERING is proportional to the drawn sample
 * (§13): once the 120 are fixed, the first 30 must look like the 120, otherwise
 * "extend to the pre-frozen larger set" would pool two differently-shaped samples.
 */
export function selectAndOrder(
  pool: readonly PoolCandidate[],
  target: number,
  salt: string = M161_SELECTION_SALT,
): LiveSelection {
  const byRepo = new Map<string, PoolCandidate[]>();
  for (const candidate of pool) {
    const bucket = byRepo.get(candidate.repo) ?? [];
    bucket.push(candidate);
    byRepo.set(candidate.repo, bucket);
  }
  const sizes = new Map<string, number>([...byRepo].map(([repo, items]) => [repo, items.length]));
  const quotaByRepo = allocateRepositoryQuota(sizes, target);

  const drawn: PoolCandidate[] = [];
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
      drawn.push(...picked);
      taken += picked.length;
      quotaByStratum.set(`${repo}|${stratum}`, picked.length);
    }
    if (taken !== repoQuota) {
      throw new Error(`repository ${repo} filled ${taken} of quota ${repoQuota}`);
    }
  }

  const ordered = orderCases(
    drawn.map((c) => ({ instance_id: c.instanceId, repo: c.repo, difficulty: c.difficulty })),
  );
  return { ordered, quotaByRepo, quotaByStratum };
}

// ---------------------------------------------------------------------------
// Arm schedule (§45-§46)
// ---------------------------------------------------------------------------

export type Arm = "baseline" | "vtrace";

export interface ScheduledCase {
  readonly order: number;
  readonly instanceId: string;
  readonly repo: string;
  readonly difficulty: string;
  /** [first, second] — which condition runs first for this case. */
  readonly armOrder: readonly [Arm, Arm];
}

/**
 * Alternate which arm runs first, strictly by frozen rank. Provider and
 * environment drift over a multi-hour run window then spreads across both
 * conditions instead of loading onto whichever one was scheduled last — and
 * because the rule is a function of rank alone, it cannot be nudged after an
 * outcome is seen (§46).
 */
export function buildArmSchedule(ordered: readonly OrderedCase[]): ScheduledCase[] {
  return ordered.map((kase) => ({
    order: kase.order,
    instanceId: kase.instance_id,
    repo: kase.repo,
    difficulty: kase.difficulty,
    armOrder: (kase.order % 2 === 1 ? ["baseline", "vtrace"] : ["vtrace", "baseline"]) as [Arm, Arm],
  }));
}

// ---------------------------------------------------------------------------
// Replacement policy (§21-§22)
// ---------------------------------------------------------------------------

export const ALLOWED_REPLACEMENT_REASONS: readonly string[] = [
  "SOURCE_REVISION_UNAVAILABLE",
  "PERSISTENT_BENCHMARK_CORRUPTION",
  "GOLD_FIXTURE_ABSENT_FROM_CHECKOUT",
  "ENVIRONMENT_IMPOSSIBLE_TO_CONSTRUCT",
];

export interface Replacement {
  readonly replacedInstanceId: string;
  readonly replacementInstanceId: string;
  readonly repoMatched: boolean;
}

/**
 * Resolve which reserve case replaces a CORPUS_INVALID one.
 *
 * Same repository first, then reserve rank. Repository matching is not
 * cosmetic: the sample's whole defence against being a django experiment is its
 * repository quota (§16), and letting an invalid matplotlib case be replaced by
 * whatever sits at the head of the reserve would let integrity failures — which
 * are not repository-uniform — quietly re-skew the mix that selection was built
 * to control. Falling back to reserve rank keeps the policy total, so a
 * repository whose reserve is exhausted still yields a decision rather than a
 * judgement call made after the fact.
 */
export function resolveReplacement(
  invalid: { readonly instanceId: string; readonly repo: string },
  reserve: readonly OrderedCase[],
  alreadyUsed: ReadonlySet<string>,
): Replacement | null {
  const available = reserve.filter((c) => !alreadyUsed.has(c.instance_id));
  const sameRepo = available.find((c) => c.repo === invalid.repo);
  const chosen = sameRepo ?? available[0];
  if (chosen === undefined) return null;
  return {
    replacedInstanceId: invalid.instanceId,
    replacementInstanceId: chosen.instance_id,
    repoMatched: sameRepo !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Bind a manifest to its exact membership and order (§17, §118). */
export function manifestHash(cases: readonly { readonly instanceId: string; readonly order: number }[]): string {
  const payload = cases.map((c) => `${c.order}:${c.instanceId}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/** Bind the arm schedule to its exact per-case order (§46). */
export function scheduleHash(schedule: readonly ScheduledCase[]): string {
  const payload = schedule.map((c) => `${c.order}:${c.instanceId}:${c.armOrder[0]}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}
