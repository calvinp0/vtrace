/**
 * M168-E sample selection — twelve tasks drawn from the frozen public VEXP
 * 100-task manifest, BEFORE any arm exists and BEFORE any treatment runs.
 *
 * Selection may read only variables that are published with the task and are
 * independent of every treatment: the repository, the gold patch size and the
 * FAIL_TO_PASS count. It may not read VTRACE success, VEXP success, retrieval
 * quality, gold localisation, or any prior Stage 5 outcome. `difficulty` is
 * carried through for description only and never steers a choice.
 *
 * Shape: ONE task per repository, twelve repositories, twelve tasks.
 *
 * Proportional allocation is the parent manifest's design and it is the wrong
 * design here. At n=12, proportional allocation spends five slots on django and
 * leaves seven repositories unrepresented, and the primary comparison (B vs C)
 * is PAIRED — every task is run under every arm, so task difficulty is already
 * controlled by the pairing. What pairing cannot control is repository shape,
 * and repository shape is exactly what a search-suppression policy should
 * interact with: a policy that forbids Grep costs more in a large unfamiliar
 * tree than in a small one. Breadth is therefore the stratification that buys
 * signal, and the twelve slots are spread across the complexity range so the
 * breadth is not purchased by collapsing onto easy tasks.
 */

/** VEXP's own published complexity proxy (scripts/select-subset.py). */
export function complexityScore(instance: {
  FAIL_TO_PASS: string | readonly string[];
  patch: string;
}): number {
  let failToPass: readonly string[] = [];
  if (Array.isArray(instance.FAIL_TO_PASS)) {
    failToPass = instance.FAIL_TO_PASS;
  } else if (typeof instance.FAIL_TO_PASS === "string") {
    try {
      const parsed: unknown = JSON.parse(instance.FAIL_TO_PASS);
      if (Array.isArray(parsed)) failToPass = parsed as readonly string[];
    } catch {
      failToPass = [];
    }
  }

  const patchLines = instance.patch
    .split("\n")
    .filter((l) => l.startsWith("+") || l.startsWith("-"))
    .length;

  return failToPass.length * 10 + patchLines;
}

export interface SelectableInstance {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string;
  readonly difficulty?: string;
  readonly FAIL_TO_PASS: string | readonly string[];
  readonly patch: string;
}

export interface SelectedTask {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly complexity: number;
  readonly difficulty: string;
  /** Rank of this task's complexity within its own repository, 1-based. */
  readonly withinRepoComplexityRank: number;
  readonly withinRepoTaskCount: number;
  /** The quantile this repository was assigned, in [0,1]. */
  readonly targetQuantile: number;
}

/**
 * Deterministic 32-bit hash. Used to permute repositories so that the mapping
 * from repository to complexity quantile is fixed and reproducible without
 * being alphabetical — alphabetical order would tie complexity to repo name,
 * and repo name correlates with tree size.
 */
function seededRank(repo: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < repo.length; i++) {
    h ^= repo.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export interface SampleSelection {
  readonly seed: number;
  readonly poolSize: number;
  readonly repositories: number;
  readonly selected: readonly SelectedTask[];
  /** Everything not selected. Untouched, reserved for extension. */
  readonly holdoutInstanceIds: readonly string[];
}

export function selectSample(
  pool: readonly SelectableInstance[],
  seed = 42,
): SampleSelection {
  const byRepo = new Map<string, SelectableInstance[]>();
  for (const inst of pool) {
    const list = byRepo.get(inst.repo) ?? [];
    list.push(inst);
    byRepo.set(inst.repo, list);
  }

  // Repositories in a fixed, seeded, non-alphabetical order.
  const repos = [...byRepo.keys()].sort((a, b) => {
    const ha = seededRank(a, seed);
    const hb = seededRank(b, seed);
    return ha === hb ? a.localeCompare(b) : ha - hb;
  });

  const selected: SelectedTask[] = [];

  repos.forEach((repo, index) => {
    const instances = [...byRepo.get(repo)!].sort((a, b) => {
      const ca = complexityScore(a);
      const cb = complexityScore(b);
      return ca === cb ? a.instance_id.localeCompare(b.instance_id) : ca - cb;
    });

    // Spread the twelve slots evenly across the complexity range: repository i
    // of n takes the (i + 0.5)/n quantile of its own complexity distribution.
    const targetQuantile = (index + 0.5) / repos.length;
    const position = Math.min(
      instances.length - 1,
      Math.max(0, Math.round(targetQuantile * instances.length - 0.5)),
    );
    const chosen = instances[position]!;

    selected.push({
      instanceId: chosen.instance_id,
      repo,
      baseCommit: chosen.base_commit,
      complexity: complexityScore(chosen),
      difficulty: chosen.difficulty ?? "UNKNOWN",
      withinRepoComplexityRank: position + 1,
      withinRepoTaskCount: instances.length,
      targetQuantile,
    });
  });

  selected.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const chosenIds = new Set(selected.map((t) => t.instanceId));

  return {
    seed,
    poolSize: pool.length,
    repositories: repos.length,
    selected,
    holdoutInstanceIds: pool
      .map((i) => i.instance_id)
      .filter((id) => !chosenIds.has(id))
      .sort(),
  };
}
