/**
 * M214 §27–§32 — the treatment lifecycle: what survives between runs, what
 * counts as the agent's patch, and what the baseline is allowed to see.
 *
 * M213 audited the benchmark harness it was about to inherit and found two
 * asymmetries, both a single line of pathspec, both favouring the competitor:
 *
 *   capturePatch   `git add -A -- . :(exclude).vexp :(exclude).claude …`
 *                  excludes the competitor's generated state, not `.vtrace`.
 *                  Reproduced: a run that changed no source produced a
 *                  105,321-byte "patch" of VTRACE index metadata.
 *   resetRepo      `git clean -fdx -e .vexp -e .claude …`
 *                  the competitor's index survives between tasks; `.vtrace` is
 *                  deleted, so one product is warm across all 44 django tasks
 *                  and the other rebuilds each time.
 *
 * VEXP is no longer a live arm, so neither defect can bias M214's result. They
 * are repaired anyway, because the defect is not "the list names the wrong
 * vendor" — it is that a hardcoded list names ANY vendor. A harness whose
 * fairness depends on someone remembering to add a directory will be unfair
 * again the next time a treatment is added.
 *
 * The repair is therefore DERIVED, not renamed:
 *
 *   the agent's patch  =  what changed, minus what was already there before the
 *                         agent started
 *
 * Nothing in that sentence contains a product name. `.vtrace` is excluded
 * because it was present at the snapshot, exactly as `.vexp` would be, exactly
 * as a treatment invented tomorrow would be. The arm's DECLARED treatment paths
 * are then used as a cross-check that the snapshot was taken late enough — the
 * ordering property that a correct pathspec alone cannot guarantee, and the one
 * M213 had to leave open.
 *
 * PURE. No spawning, no filesystem, no product import. Every function takes the
 * observed state and returns issues, so the real probe and the falsification
 * fixtures exercise identical code.
 */

import { type M214Arm, armDefinition } from "./m214Preregistration";

// ── Lifecycle ordering (§27, §31) ───────────────────────────────────

/**
 * The phases of one run, in the only order that makes patch capture honest.
 *
 * `PRE_AGENT_UNTRACKED_SNAPSHOT` sits AFTER `TREATMENT_INITIALISATION` on
 * purpose. Taken before it, the snapshot would not contain `.vtrace`, the
 * derived exclusion would not cover it, and every VTRACE-arm patch would carry
 * the index — which is precisely the vendor harness's bug, reintroduced by
 * ordering instead of by pathspec.
 */
export const M214_LIFECYCLE_ORDER: readonly string[] = Object.freeze([
  "CONTAINER_START",
  "SOURCE_CHECKOUT_AT_BASE_COMMIT",
  "SOURCE_STATE_DIGEST_BEFORE_TREATMENT",
  "TREATMENT_INITIALISATION",
  "SOURCE_STATE_DIGEST_AFTER_TREATMENT",
  "PRE_AGENT_UNTRACKED_SNAPSHOT",
  "AGENT_RUN",
  "PATCH_CAPTURE",
  "EVALUATION",
]);

export function auditLifecycleOrder(observed: readonly string[]): readonly string[] {
  const issues: string[] = [];
  const expectedIndex = new Map(M214_LIFECYCLE_ORDER.map((phase, index) => [phase, index] as const));

  for (const phase of M214_LIFECYCLE_ORDER) {
    if (!observed.includes(phase)) issues.push(`lifecycle phase missing: ${phase}`);
  }
  let previous = -1;
  for (const phase of observed) {
    const index = expectedIndex.get(phase);
    if (index === undefined) {
      issues.push(`unknown lifecycle phase: ${phase}`);
      continue;
    }
    if (index < previous) {
      issues.push(`lifecycle phase out of order: ${phase} occurs after a later phase`);
    }
    previous = index;
  }

  // The single ordering that the whole patch-capture repair rests on, checked
  // by name so the failure message says what actually broke.
  const snapshot = observed.indexOf("PRE_AGENT_UNTRACKED_SNAPSHOT");
  const init = observed.indexOf("TREATMENT_INITIALISATION");
  if (snapshot >= 0 && init >= 0 && snapshot < init) {
    issues.push(
      "the pre-agent untracked snapshot is taken BEFORE treatment initialisation; treatment state "
      + "created afterwards would be attributed to the agent",
    );
  }
  return issues;
}

// ── Derived patch-capture exclusions (§28) ──────────────────────────

/**
 * The exclusion pathspec, derived entirely from the observed snapshot.
 *
 * Mirrors `m193b_changed_source.exclusion_pathspec`, which is the mechanism the
 * production authority already runs; expressed here so the launch harness and
 * the falsification suite check the same rule the Python side applies.
 */
export function derivePatchCaptureExclusions(
  preAgentUntrackedPaths: readonly string[],
): readonly string[] {
  return Object.freeze([...new Set(preAgentUntrackedPaths.map(normalizePath))].sort());
}

export function patchCapturePathspec(preAgentUntrackedPaths: readonly string[]): string {
  return derivePatchCaptureExclusions(preAgentUntrackedPaths)
    .map((entry) => `':(exclude)${entry}'`)
    .join(" ");
}

function normalizePath(entry: string): string {
  return entry.replace(/\/+$/, "");
}

function isUnder(candidate: string, prefix: string): boolean {
  const path = normalizePath(candidate);
  const root = normalizePath(prefix);
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The two routes by which treatment state can be kept out of a captured patch.
 *
 * M214's probe measured a third state nobody had written down: `vtrace init`
 * appends `/.vtrace/` to `.git/info/exclude`, so on a repository initialised
 * that way the directory is invisible to `git ls-files --others
 * --exclude-standard` and never reaches the snapshot at all. `vtrace index`
 * alone does NOT write that entry, and with it absent the vendor's `git add -A`
 * captures every `.vtrace` file as agent output.
 *
 * So "is the treatment state excluded?" has two correct answers, and a guard
 * that accepted only the first would fail a compliant run while a guard that
 * accepted only the second would pass a broken one.
 */
export type ExclusionRoute = "DERIVED_SNAPSHOT_EXCLUSION" | "NOT_ENUMERABLE_BY_GIT" | "UNCOVERED";

export function classifyExclusionRoute(
  treatmentStatePath: string,
  preAgentUntrackedPaths: readonly string[],
  gitEnumerableUntrackedPaths: readonly string[],
): ExclusionRoute {
  const excluded = derivePatchCaptureExclusions(preAgentUntrackedPaths);
  if (excluded.some((prefix) => isUnder(treatmentStatePath, prefix))) {
    return "DERIVED_SNAPSHOT_EXCLUSION";
  }
  const enumerable = gitEnumerableUntrackedPaths
    .some((entry) => isUnder(treatmentStatePath, entry) || isUnder(entry, treatmentStatePath));
  return enumerable ? "UNCOVERED" : "NOT_ENUMERABLE_BY_GIT";
}

/**
 * §28's cross-check: every path the treatment created must be provably outside
 * the captured patch, by a route the harness can name.
 *
 * This is the ordering bug's second detector, and it catches what
 * `auditLifecycleOrder` cannot: a harness that reports the phases in the right
 * order but takes its snapshot from a stale cache. Relying on
 * `NOT_ENUMERABLE_BY_GIT` alone would be relying on the treatment to keep
 * writing a git exclude entry for itself — a courtesy no benchmark's fairness
 * should depend on — so that route is accepted and recorded rather than
 * trusted, and the launch harness still takes its snapshot after initialisation.
 */
export function auditDerivedExclusionCoversTreatmentState(
  arm: M214Arm,
  preAgentUntrackedPaths: readonly string[],
  observedTreatmentStatePaths: readonly string[],
  gitEnumerableUntrackedPaths: readonly string[] = preAgentUntrackedPaths,
): readonly string[] {
  const declared = armDefinition(arm).treatmentStatePaths;
  const issues: string[] = [];

  for (const path of observedTreatmentStatePaths) {
    const route = classifyExclusionRoute(path, preAgentUntrackedPaths, gitEnumerableUntrackedPaths);
    if (route === "UNCOVERED") {
      issues.push(
        `treatment state ${path} is enumerable by git and is not covered by the derived patch `
        + "exclusion; the pre-agent snapshot was taken before treatment initialisation created it",
      );
    }
  }
  for (const path of declared) {
    if (observedTreatmentStatePaths.length > 0
      && !observedTreatmentStatePaths.some((observed) => isUnder(observed, path))) {
      issues.push(
        `${arm} arm declares treatment state at ${path} but the observed treatment state does not `
        + "include it",
      );
    }
  }
  if (arm === "baseline" && observedTreatmentStatePaths.length > 0) {
    issues.push(
      `baseline arm created treatment state: ${observedTreatmentStatePaths.join(", ")}`,
    );
  }
  return issues;
}

/**
 * §28's falsifiable property: a run that changed no source must produce an
 * EMPTY source patch, whatever the treatment left behind.
 */
export function auditCapturedPatchPaths(
  capturedPaths: readonly string[],
  preAgentUntrackedPaths: readonly string[],
): readonly string[] {
  const excluded = derivePatchCaptureExclusions(preAgentUntrackedPaths);
  return capturedPaths
    .filter((path) => excluded.some((prefix) => isUnder(path, prefix)))
    .map((path) =>
      `captured patch contains pre-agent path ${path}; it existed before the agent started and is `
      + "not an agent change");
}

/**
 * The vendor harness's own pathspec, judged by the rule above.
 *
 * A hardcoded exclusion list is a defect even when it happens to be complete,
 * so the audit reports BOTH facts: which treatment directories the list misses,
 * and that the list is hardcoded at all.
 */
export function auditHardcodedExclusionList(
  hardcodedExclusions: readonly string[],
  treatmentStateDirectoriesInPlay: readonly string[],
): readonly string[] {
  // An empty list is not an incomplete hardcoded list; it is the absence of one,
  // which is what deriving exclusions from observed state looks like.
  if (hardcodedExclusions.length === 0) return [];

  const issues: string[] = [];
  const normalized = hardcodedExclusions.map(normalizePath);
  for (const directory of treatmentStateDirectoriesInPlay) {
    if (!normalized.includes(normalizePath(directory))) {
      issues.push(
        `patch capture does not exclude ${directory}; that treatment's generated state would enter `
        + "its patch",
      );
    }
  }
  {
    issues.push(
      `patch capture uses a hardcoded exclusion list [${normalized.join(", ")}] rather than deriving `
      + "exclusions from observed pre-agent state; the next treatment added will be captured as "
      + "agent output",
    );
  }
  return issues;
}

// ── Reset / warm policy (§27, §29) ──────────────────────────────────

export type IndexWarmthRegime = "COLD_UNIFORM" | "WARM_UNIFORM";

export const M214_INDEX_WARMTH_POLICY = Object.freeze({
  regime: "COLD_UNIFORM" as IndexWarmthRegime,
  rationale:
    "Every run gets a fresh container and a fresh checkout, so no treatment state can survive into "
    + "the next task by construction rather than by a clean rule that has to be maintained. The "
    + "product-use scenario this matches is an agent arriving at a repository it has not indexed — "
    + "which is what a SWE-bench instance is.",
  indexBuiltBeforeAgentStart: true,
  indexBuildChargedToModelBudget: false,
  reportedSeparately: ["index build wall-clock seconds", "index size on disk", "treatment tool latency"],
  survivesBetweenRuns: Object.freeze([] as readonly string[]),
  baselineIsNeverIndexed: true,
  statement:
    "Source checkout is reset identically for both arms. Treatment index construction happens "
    + "outside the source reset, after checkout and before the agent starts, and is measured rather "
    + "than charged. `.vtrace` persistence is never a side effect of a generic `git clean`: nothing "
    + "persists, for either arm, and the policy says so rather than the clean flags implying it.",
});

export interface ObservedWarmth {
  readonly arm: M214Arm;
  /** Treatment state present at checkout time, i.e. inherited from a previous run. */
  readonly treatmentStateInheritedFromPreviousRun: readonly string[];
  /** Paths a reset explicitly preserves for this arm. */
  readonly resetPreservedPaths: readonly string[];
}

/**
 * §29 — the warm/cold regime must be the frozen one, and the same one for both
 * arms.
 *
 * Two distinct failures, reported separately because they have different fixes:
 * a preserved path that contradicts the declared regime, and a preservation
 * policy that differs BETWEEN arms even if it contradicts nothing.
 */
export function auditWarmthPolicy(
  observed: readonly ObservedWarmth[],
  regime: IndexWarmthRegime = M214_INDEX_WARMTH_POLICY.regime,
): readonly string[] {
  const issues: string[] = [];

  for (const entry of observed) {
    if (regime === "COLD_UNIFORM" && entry.treatmentStateInheritedFromPreviousRun.length > 0) {
      issues.push(
        `${entry.arm} arm inherited treatment state under a COLD_UNIFORM policy: `
        + `${entry.treatmentStateInheritedFromPreviousRun.join(", ")}`,
      );
    }
    if (regime === "WARM_UNIFORM" && entry.treatmentStateInheritedFromPreviousRun.length === 0
      && armDefinition(entry.arm).treatmentStatePaths.length > 0) {
      issues.push(
        `${entry.arm} arm carries no treatment state under a WARM_UNIFORM policy; its index was `
        + "rebuilt while another arm's survived",
      );
    }
  }

  const signatures = new Map<string, M214Arm[]>();
  for (const entry of observed) {
    const key = [...entry.resetPreservedPaths].map(normalizePath).sort().join("|");
    if (!signatures.has(key)) signatures.set(key, []);
    signatures.get(key)!.push(entry.arm);
  }
  if (signatures.size > 1) {
    const rendered = [...signatures.entries()]
      .map(([key, arms]) => `${arms.join("+")} preserve [${key || "nothing"}]`)
      .join("; ");
    issues.push(`reset policy is asymmetric across arms: ${rendered}`);
  }
  return issues;
}

/**
 * The generic form of the vendor's `resetRepo` defect, checked without naming a
 * vendor: under a cold policy, a reset may not preserve ANY treatment state.
 */
export function auditResetPreservedPaths(
  resetPreservedPaths: readonly string[],
  treatmentStateDirectoriesInPlay: readonly string[],
  regime: IndexWarmthRegime = M214_INDEX_WARMTH_POLICY.regime,
): readonly string[] {
  if (regime !== "COLD_UNIFORM") return [];
  return resetPreservedPaths
    .filter((path) => treatmentStateDirectoriesInPlay.some((dir) => isUnder(path, dir)))
    .map((path) =>
      `reset preserves treatment state ${path} under a COLD_UNIFORM policy; that treatment would be `
      + "warm on the next task while any treatment not on the preserve list rebuilds");
}

// ── Source-state equivalence (§32) ──────────────────────────────────

export interface SourceStateObservation {
  readonly arm: M214Arm;
  readonly instanceId: string;
  readonly baseCommit: string;
  readonly headAtAgentStart: string;
  readonly trackedSourceDigestBeforeTreatment: string;
  readonly trackedSourceDigestAfterTreatment: string;
  readonly canonicalTrackedSourceDigest: string;
  readonly untrackedSourceAffectingPaths: readonly string[];
}

/**
 * §32 — treatment indexing may create metadata; it may not mutate source.
 *
 * Measured as a digest taken on both sides of initialisation, rather than
 * argued from "indexing is read-only". M213 measured this across all twelve
 * repositories and found byte-identical digests, which is why the property is
 * checkable at all — but a launch gate that trusts a past measurement is not a
 * gate, so it is re-taken per run.
 */
export function auditSourceStateEquivalence(
  observed: SourceStateObservation,
): readonly string[] {
  const issues: string[] = [];
  if (observed.headAtAgentStart !== observed.baseCommit) {
    issues.push(
      `${observed.arm} arm HEAD at agent start is ${observed.headAtAgentStart}, not the frozen base `
      + `commit ${observed.baseCommit}`,
    );
  }
  if (observed.trackedSourceDigestBeforeTreatment !== observed.trackedSourceDigestAfterTreatment) {
    issues.push(
      `treatment initialisation mutated tracked source in the ${observed.arm} arm: `
      + `${observed.trackedSourceDigestBeforeTreatment} → ${observed.trackedSourceDigestAfterTreatment}`,
    );
  }
  if (observed.trackedSourceDigestAfterTreatment !== observed.canonicalTrackedSourceDigest) {
    issues.push(
      `${observed.arm} arm tracked source differs from the canonical state for `
      + `${observed.instanceId}`,
    );
  }
  if (observed.untrackedSourceAffectingPaths.length > 0) {
    issues.push(
      `${observed.arm} arm carries untracked source-affecting state at agent start: `
      + observed.untrackedSourceAffectingPaths.join(", "),
    );
  }
  return issues;
}

// ── Baseline contamination (§30) ────────────────────────────────────

export interface BaselineIsolationObservation {
  readonly mcpServers: readonly string[];
  readonly modelVisibleToolNames: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly workspaceRootEntries: readonly string[];
  readonly injectedContextDocuments: readonly string[];
  readonly daemonSocketsReachable: readonly string[];
  readonly treatmentBinariesOnPath: readonly string[];
  readonly systemPromptAppendix: string | null;
}

/**
 * §30 — prove the baseline cannot reach the treatment.
 *
 * `treatmentBinariesOnPath` is deliberately a WARNING-free field rather than an
 * automatic failure: a CLI binary that is installed but never invoked, whose
 * daemon is not running, whose MCP server is not configured and whose state
 * directory is absent leaves the agent nothing to find. What matters is that no
 * VTRACE INFORMATION is reachable. Preferring stronger isolation, the launch
 * harness keeps the binary out of the baseline image anyway, and this guard
 * records the fact rather than relying on it.
 */
export function auditBaselineIsolation(
  observed: BaselineIsolationObservation,
): readonly string[] {
  const issues: string[] = [];
  const definition = armDefinition("baseline");

  if (observed.mcpServers.length > 0) {
    issues.push(`baseline arm has MCP servers configured: ${observed.mcpServers.join(", ")}`);
  }
  const extraTools = observed.modelVisibleToolNames
    .filter((name) => !definition.modelVisibleToolNames.includes(name));
  if (extraTools.length > 0) {
    issues.push(`baseline arm exposes non-native tools: ${extraTools.join(", ")}`);
  }
  const missingTools = definition.modelVisibleToolNames
    .filter((name) => !observed.modelVisibleToolNames.includes(name));
  if (missingTools.length > 0) {
    issues.push(`baseline arm is missing native tools: ${missingTools.join(", ")}`);
  }
  for (const prefix of definition.forbiddenEnvironmentPrefixes) {
    const offenders = observed.environmentVariableNames.filter((name) => name.startsWith(prefix));
    if (offenders.length > 0) {
      issues.push(`baseline arm carries treatment environment variables: ${offenders.join(", ")}`);
    }
  }
  for (const entry of definition.forbiddenWorkspaceEntries) {
    if (observed.workspaceRootEntries.some((candidate) => isUnder(candidate, entry))) {
      issues.push(`baseline arm workspace contains ${entry} at agent start`);
    }
  }
  if (observed.injectedContextDocuments.length > 0) {
    issues.push(
      `baseline arm has injected context documents: ${observed.injectedContextDocuments.join(", ")}`,
    );
  }
  if (observed.daemonSocketsReachable.length > 0) {
    issues.push(
      `baseline arm can reach treatment daemon sockets: ${observed.daemonSocketsReachable.join(", ")}`,
    );
  }
  if (observed.systemPromptAppendix !== null) {
    issues.push("baseline arm carries a system prompt appendix; every arm uses the CLI default");
  }
  return issues;
}

/** §31 — the treatment arm's own containment: VTRACE state is allowed, VEXP state is not. */
export function auditTreatmentArmContainment(
  observed: BaselineIsolationObservation,
  arm: M214Arm = "vtrace",
): readonly string[] {
  const issues: string[] = [];
  const definition = armDefinition(arm);

  const expectedServers = [...definition.mcpServers].sort().join(",");
  const observedServers = [...observed.mcpServers].sort().join(",");
  if (expectedServers !== observedServers) {
    issues.push(`${arm} arm MCP servers differ from the arm definition: [${observedServers}]`);
  }
  const expectedTools = [...definition.modelVisibleToolNames].sort().join(",");
  const observedTools = [...observed.modelVisibleToolNames].sort().join(",");
  if (expectedTools !== observedTools) {
    issues.push(`${arm} arm model-visible tool surface differs from the arm definition`);
  }
  for (const prefix of definition.forbiddenEnvironmentPrefixes) {
    const offenders = observed.environmentVariableNames.filter((name) => name.startsWith(prefix));
    if (offenders.length > 0) {
      issues.push(`${arm} arm carries forbidden environment variables: ${offenders.join(", ")}`);
    }
  }
  for (const entry of definition.forbiddenWorkspaceEntries) {
    if (observed.workspaceRootEntries.some((candidate) => isUnder(candidate, entry))) {
      issues.push(`${arm} arm workspace contains forbidden entry ${entry} at agent start`);
    }
  }
  if (observed.injectedContextDocuments.length > 0) {
    issues.push(`${arm} arm has injected context documents: ${observed.injectedContextDocuments.join(", ")}`);
  }
  if (observed.systemPromptAppendix !== null) {
    issues.push(`${arm} arm carries a system prompt appendix; every arm uses the CLI default`);
  }
  return issues;
}
