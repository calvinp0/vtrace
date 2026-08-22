/**
 * M169-E — pre-treatment features.
 *
 * Everything here is computable BEFORE the pipeline is invoked, or (for the
 * PRE_DELIVERY tier) after retrieval but before delivery. Nothing here may read
 * the grader, the gold patch, the treatment arm's behaviour, or the baseline's
 * observed cost — those are labels, and §41 forbids them as inputs.
 *
 * The families were frozen in `stage5_m169_plan.md` before any economic class
 * existed. n=12 is far too small to fit anything to (§43); these functions exist
 * so that a distribution can be LOOKED AT across three corpora, not so that a
 * rule can be found in twelve tasks.
 *
 * PURE.
 */

export const FeatureTier = Object.freeze({
  /** Computable with zero retrieval work: the task text and the index's size. */
  PreInvocation: "PRE_INVOCATION",
  /** Needs retrieval, but not delivery, and never the outcome. */
  PreDelivery: "PRE_DELIVERY",
});
export type FeatureTier = (typeof FeatureTier)[keyof typeof FeatureTier];

export const FeatureFamily = Object.freeze({
  TaskExplicitness: "TASK_EXPLICITNESS",
  RepositoryScale: "REPOSITORY_SCALE",
  RetrievalAmbiguity: "RETRIEVAL_AMBIGUITY",
  ExpectedImpactBreadth: "EXPECTED_IMPACT_BREADTH",
});
export type FeatureFamily = (typeof FeatureFamily)[keyof typeof FeatureFamily];

export interface TaskExplicitness {
  readonly characters: number;
  readonly explicitFilePaths: number;
  readonly distinctExplicitFilePaths: number;
  readonly codeIdentifiers: number;
  readonly tracebackPresent: boolean;
  readonly namedDefinitionPresent: boolean;
  readonly codeFencePresent: boolean;
}

/** A path-shaped token with a source extension. Not every dotted word is a file. */
const FILE_PATH = /\b[\w./-]*[\w-]+\.(py|pyx|pyi|js|ts|tsx|rs|go|java|c|h|cpp|rb|txt|cfg|toml|ini|rst|md)\b/g;
/** Dotted, snake_cased or CamelCased tokens: the shapes a symbol name takes. */
const CODE_IDENTIFIER = /\b(?:[A-Za-z_][\w]*\.[A-Za-z_][\w.]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g;

export function taskExplicitness(taskText: string): TaskExplicitness {
  const paths = taskText.match(FILE_PATH) ?? [];
  const identifiers = taskText.match(CODE_IDENTIFIER) ?? [];
  return {
    characters: taskText.length,
    explicitFilePaths: paths.length,
    distinctExplicitFilePaths: new Set(paths).size,
    codeIdentifiers: identifiers.length,
    tracebackPresent: /Traceback \(most recent call last\)/.test(taskText),
    namedDefinitionPresent: /\b(def|class)\s+[A-Za-z_]\w*/.test(taskText),
    codeFencePresent: taskText.includes("```"),
  };
}

export interface RepositoryScale {
  readonly indexedFiles: number;
  readonly indexedSymbols: number;
}

export interface RetrievalAmbiguity {
  readonly candidates: number;
  readonly topScore: number | null;
  readonly secondScore: number | null;
  /** rank 1 minus rank 2. A wide margin means retrieval was not torn. */
  readonly scoreMargin: number | null;
  /** Candidates scoring at least 80% of the top score. */
  readonly nearTopCandidates: number | null;
  readonly distinctFilesInTopTen: number;
}

interface RankedItem { readonly path?: unknown; readonly pivotRankScore?: unknown }

/**
 * Ambiguity as retrieval itself saw it, from the ranking artifact.
 *
 * The scores are ranks, not probabilities, so nothing is normalized: a margin is
 * reported in the units the ranker produced, and a corpus comparison must
 * compare like with like or not at all.
 */
export function retrievalAmbiguity(items: readonly RankedItem[]): RetrievalAmbiguity {
  const scored = items
    .map((item) => (typeof item.pivotRankScore === "number" ? item.pivotRankScore : null))
    .filter((score): score is number => score !== null)
    .sort((a, b) => b - a);
  const top = scored[0] ?? null;
  const second = scored[1] ?? null;
  return {
    candidates: items.length,
    topScore: top,
    secondScore: second,
    scoreMargin: top === null || second === null ? null : Number((top - second).toFixed(4)),
    nearTopCandidates: top === null ? null : scored.filter((score) => score >= 0.8 * top).length,
    distinctFilesInTopTen: new Set(
      items.slice(0, 10).map((item) => (typeof item.path === "string" ? item.path : "")).filter(Boolean),
    ).size,
  };
}

export interface ExpectedImpactBreadth {
  readonly deliveredPivots: number;
  readonly deliveredDistinctFiles: number;
}

export interface PreTreatmentFeatures {
  readonly instanceId: string;
  readonly tier: Readonly<Record<FeatureFamily, FeatureTier>>;
  readonly taskExplicitness: TaskExplicitness;
  readonly repositoryScale: RepositoryScale | null;
  readonly retrievalAmbiguity: RetrievalAmbiguity | null;
  readonly expectedImpactBreadth: ExpectedImpactBreadth | null;
}

export const FAMILY_TIERS: Readonly<Record<FeatureFamily, FeatureTier>> = Object.freeze({
  [FeatureFamily.TaskExplicitness]: FeatureTier.PreInvocation,
  [FeatureFamily.RepositoryScale]: FeatureTier.PreInvocation,
  [FeatureFamily.RetrievalAmbiguity]: FeatureTier.PreDelivery,
  [FeatureFamily.ExpectedImpactBreadth]: FeatureTier.PreDelivery,
});

// ── separation, descriptively ───────────────────────────────────────

export interface Separation {
  readonly feature: string;
  readonly family: FeatureFamily;
  readonly tier: FeatureTier;
  readonly groupA: string;
  readonly groupB: string;
  readonly nA: number;
  readonly nB: number;
  readonly medianA: number | null;
  readonly medianB: number | null;
  /** Values in A strictly above every value in B, or vice versa. */
  readonly cleanlySeparated: boolean;
  /** Fraction of (a, b) pairs where a > b. 0.5 is no signal, 1.0 is perfect. */
  readonly rankOverlapStatistic: number | null;
  readonly verdict: "SEPARATES" | "WEAK" | "NULL" | "NOT_ENOUGH_DATA";
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * Describe whether a feature tells two groups apart, and refuse to overstate it.
 *
 * The statistic is the common-language effect size (the probability that a
 * random member of A exceeds a random member of B). At these group sizes it is
 * descriptive; no p-value is computed, because none would mean anything, and
 * quoting one would invite exactly the over-reading §43 forbids.
 */
export function separation(
  feature: string,
  family: FeatureFamily,
  groupAName: string,
  groupAValues: readonly number[],
  groupBName: string,
  groupBValues: readonly number[],
): Separation {
  const base = {
    feature, family, tier: FAMILY_TIERS[family],
    groupA: groupAName, groupB: groupBName,
    nA: groupAValues.length, nB: groupBValues.length,
    medianA: median(groupAValues), medianB: median(groupBValues),
  };
  if (groupAValues.length < 3 || groupBValues.length < 3) {
    return { ...base, cleanlySeparated: false, rankOverlapStatistic: null, verdict: "NOT_ENOUGH_DATA" };
  }
  let above = 0, ties = 0;
  for (const a of groupAValues) {
    for (const b of groupBValues) {
      if (a > b) above += 1;
      else if (a === b) ties += 1;
    }
  }
  const total = groupAValues.length * groupBValues.length;
  const statistic = (above + ties / 2) / total;
  const clean = Math.min(...groupAValues) > Math.max(...groupBValues)
    || Math.max(...groupAValues) < Math.min(...groupBValues);
  const distance = Math.abs(statistic - 0.5);
  const verdict = clean ? "SEPARATES" : distance >= 0.25 ? "WEAK" : "NULL";
  return { ...base, cleanlySeparated: clean, rankOverlapStatistic: Number(statistic.toFixed(4)), verdict };
}
