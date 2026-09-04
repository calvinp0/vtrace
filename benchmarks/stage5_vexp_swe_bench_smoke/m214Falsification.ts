/**
 * M214 §45 — the falsification suite, and the guards it falsifies.
 *
 * Two halves that must be read together:
 *
 *   GUARDS    deterministic auditors that compare an OBSERVED configuration
 *             against the frozen preregistration and return human-readable
 *             issues.
 *   CONTROLS  F1–F24, each of which deliberately breaks one thing and asserts
 *             the corresponding guard notices.
 *
 * A suite of controls without a clean negative control proves nothing: a guard
 * that rejects everything would pass F1–F24 and be useless. `F0_CLEAN_*` and
 * the `*_CLEAN` companions are therefore part of the suite, and a compliant
 * configuration must produce zero issues.
 *
 * PURE. No spawning, no network, no model, no product import.
 */

import {
  preregistrationHash as m213PreregistrationHash,
} from "./m213Preregistration";
import {
  EXTERNAL_VENDOR_REFERENCE,
  M214_EXPERIMENTAL_ARM,
  M214_EXTERNAL_REFERENCE,
  auditCausalTableMembership,
  auditEvidenceClassLabel,
  auditExternalComparisonWording,
  auditExternalReferenceSnapshot,
  auditExternalReferenceTaskArtifact,
  auditPairedComparison,
  externalReferenceHash,
  renderExternalComparison,
} from "./m214ExternalReference";
import {
  M214_AGENT,
  M214_BUDGET,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  type M214Arm,
  type RunManifestRow,
  armDefinition,
  m214ManifestHash,
  m214PreregistrationHash,
} from "./m214Preregistration";
import {
  M214_LIFECYCLE_ORDER,
  auditBaselineIsolation,
  auditCapturedPatchPaths,
  auditDerivedExclusionCoversTreatmentState,
  auditHardcodedExclusionList,
  auditLifecycleOrder,
  auditResetPreservedPaths,
  auditSourceStateEquivalence,
  auditTreatmentArmContainment,
  auditWarmthPolicy,
} from "./m214TreatmentLifecycle";

// ── Observed configuration ──────────────────────────────────────────

export interface ObservedRunConfiguration {
  readonly runId: string;
  readonly instanceId: string;
  readonly arm: M214Arm;
  readonly agentVersion: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly perRunCostCapUsd: number;
  readonly wallClockTimeoutSecondsPerRun: number;
  readonly nativeTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly modelVisibleToolNames: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly workspaceRootEntries: readonly string[];
  readonly systemPromptAppendix: string | null;
  readonly userPromptTemplate: string;
  readonly vtraceCommit: string | null;
  readonly vtraceProductTreeSha: string | null;
  /** Non-null when this run inherited state from another run (§45 F23). */
  readonly conversationSeededFromRunId: string | null;
  readonly patchSeededFromRunId: string | null;
  readonly treatmentResultSeededFromRunId: string | null;
  readonly injectedContextDocuments: readonly string[];
  /** Any evaluation artifact present in the agent's context (§45 F22). */
  readonly goldArtifactsInAgentContext: readonly string[];
  readonly baseCommit: string;
  readonly headAtAgentStart: string;
  readonly trackedSourceDigestAtAgentStart: string;
  /** Whether the treatment surface was exposed and whether the agent used it (§45 F15). */
  readonly treatmentExposed: boolean;
  readonly treatmentInvocationCount: number;
}

export interface ExpectedRunContract {
  readonly instanceId: string;
  readonly arm: M214Arm;
  readonly agentVersion: string;
  readonly model: string;
  readonly vtraceCommit: string;
  readonly vtraceProductTreeSha: string;
  readonly baseCommit: string;
  readonly canonicalTrackedSourceDigest: string;
}

/**
 * The whole per-run audit. Returns every issue rather than the first, because a
 * contaminated run usually violates several clauses at once and fixing them one
 * launch at a time would be its own kind of tuning.
 */
export function auditRun(
  expected: ExpectedRunContract,
  observed: ObservedRunConfiguration,
): readonly string[] {
  const issues: string[] = [];
  const definition = armDefinition(observed.arm);

  if (observed.arm !== expected.arm) {
    issues.push(`arm mismatch: assigned ${expected.arm}, observed ${observed.arm}`);
  }
  if (observed.instanceId !== expected.instanceId) {
    issues.push(`instance mismatch: expected ${expected.instanceId}, observed ${observed.instanceId}`);
  }

  // §12 agent identity, §13 model identity — identical in both arms.
  if (observed.agentVersion !== expected.agentVersion) {
    issues.push(`agent version drift: expected ${expected.agentVersion}, observed ${observed.agentVersion}`);
  }
  if (observed.model !== expected.model) {
    issues.push(`model drift: expected ${expected.model}, observed ${observed.model}`);
  }
  if (observed.systemPromptAppendix !== null) {
    issues.push("system prompt carries an appendix; both arms must use the CLI default");
  }
  if (observed.userPromptTemplate !== M214_AGENT.userPromptText) {
    issues.push("user prompt drift: the prompt template differs from the frozen text");
  }

  // §15 budget equality.
  if (observed.maxTurns !== M214_BUDGET.maxTurns) {
    issues.push(`turn budget drift: expected ${M214_BUDGET.maxTurns}, observed ${observed.maxTurns}`);
  }
  if (observed.perRunCostCapUsd !== M214_BUDGET.perRunCostCapUsd) {
    issues.push(`cost cap drift: expected ${M214_BUDGET.perRunCostCapUsd}, observed ${observed.perRunCostCapUsd}`);
  }
  if (observed.wallClockTimeoutSecondsPerRun !== M214_BUDGET.wallClockTimeoutSecondsPerRun) {
    issues.push("wall-clock timeout drift");
  }

  // §12 native tool parity — neither arm may be narrowed or widened.
  const nativeExpected = [...M214_NATIVE_TOOLS].sort().join(",");
  const nativeObserved = [...observed.nativeTools].sort().join(",");
  if (nativeExpected !== nativeObserved) {
    issues.push(`native tool set differs from the frozen set: observed [${nativeObserved}]`);
  }

  // §11 treatment surface — exactly the arm's own catalogue, nothing else.
  const surfaceExpected = [...definition.modelVisibleToolNames].sort().join(",");
  const surfaceObserved = [...observed.modelVisibleToolNames].sort().join(",");
  if (surfaceExpected !== surfaceObserved) {
    issues.push(`model-visible tool surface differs from the ${observed.arm} arm definition`);
  }
  const serversExpected = [...definition.mcpServers].sort().join(",");
  const serversObserved = [...observed.mcpServers].sort().join(",");
  if (serversExpected !== serversObserved) {
    issues.push(`MCP servers differ from the ${observed.arm} arm definition: observed [${serversObserved}]`);
  }

  // §30, §31 contamination.
  for (const prefix of definition.forbiddenEnvironmentPrefixes) {
    const offenders = observed.environmentVariableNames.filter((name) => name.startsWith(prefix));
    if (offenders.length > 0) {
      issues.push(`${observed.arm} arm carries forbidden environment variables: ${offenders.join(", ")}`);
    }
  }
  for (const entry of definition.forbiddenWorkspaceEntries) {
    if (observed.workspaceRootEntries.includes(entry)) {
      issues.push(`${observed.arm} arm workspace contains forbidden entry ${entry} at agent start`);
    }
  }
  if (observed.injectedContextDocuments.length > 0) {
    issues.push(`injected instruction context present: ${observed.injectedContextDocuments.join(", ")}`);
  }

  // §11 treatment identity pinning: the commit AND the product tree.
  if (observed.arm === "vtrace") {
    if (observed.vtraceCommit !== expected.vtraceCommit) {
      issues.push(
        `VTRACE identity drift: expected ${expected.vtraceCommit}, observed ${observed.vtraceCommit ?? "null"}`,
      );
    }
    if (observed.vtraceProductTreeSha !== expected.vtraceProductTreeSha) {
      issues.push(
        `VTRACE product tree drift: expected ${expected.vtraceProductTreeSha}, observed `
        + `${observed.vtraceProductTreeSha ?? "null"}`,
      );
    }
    if (!observed.treatmentExposed) {
      issues.push("VTRACE arm did not have the treatment surface exposed");
    }
  } else {
    if (observed.vtraceCommit !== null || observed.vtraceProductTreeSha !== null) {
      issues.push(`${observed.arm} arm declares a VTRACE identity`);
    }
    if (observed.treatmentExposed) {
      issues.push(`${observed.arm} arm had a treatment surface exposed`);
    }
  }

  // §32 repository state equivalence.
  if (observed.headAtAgentStart !== expected.baseCommit) {
    issues.push("repository HEAD at agent start is not the frozen base commit");
  }
  if (observed.trackedSourceDigestAtAgentStart !== expected.canonicalTrackedSourceDigest) {
    issues.push("tracked source state differs from the canonical state for this instance");
  }

  // §45 F23 independence.
  if (observed.conversationSeededFromRunId !== null) {
    issues.push(`conversation state reused from ${observed.conversationSeededFromRunId}`);
  }
  if (observed.patchSeededFromRunId !== null) {
    issues.push(`patch state reused from ${observed.patchSeededFromRunId}`);
  }
  if (observed.treatmentResultSeededFromRunId !== null) {
    issues.push(`treatment result reused from ${observed.treatmentResultSeededFromRunId}`);
  }

  // §45 F22 evaluation leakage.
  if (observed.goldArtifactsInAgentContext.length > 0) {
    issues.push(
      `evaluation artifacts reachable from agent context: ${observed.goldArtifactsInAgentContext.join(", ")}`,
    );
  }

  return issues;
}

// ── Design-level guards ─────────────────────────────────────────────

/**
 * §3, §45 F1 — M213's preregistration is immutable, and M214's identity is
 * distinct from it.
 *
 * Two independent properties in one guard because they fail together in
 * practice: the way M213 gets "updated" is by someone regenerating it as a
 * two-arm document and keeping the filename.
 */
export function auditM213Immutability(
  m213Document: Record<string, unknown>,
  m213RecordedHash: string,
  m214Hash: string,
): readonly string[] {
  const issues: string[] = [];
  const actual = m213PreregistrationHash(m213Document);
  if (actual !== m213RecordedHash) {
    issues.push(
      `M213 preregistration has been modified: recorded ${m213RecordedHash}, computed ${actual}`,
    );
  }
  if (m214Hash === m213RecordedHash) {
    issues.push("M214 reuses M213's preregistration hash; it must have its own identity");
  }
  if (String(m213Document.armCount ?? "") !== "3") {
    issues.push(
      `M213's three-arm structure has been altered: armCount is ${String(m213Document.armCount)}`,
    );
  }
  if (m213Document.launchAuthorized !== false) {
    issues.push("M213 has been rewritten as launch-authorised; it was, and remains, blocked");
  }
  return issues;
}

/** §24 task-set identity: the manifest must cover the frozen population exactly. */
export function auditTaskSet(
  frozenInstanceIds: readonly string[],
  manifest: readonly RunManifestRow[],
): readonly string[] {
  const issues: string[] = [];
  const frozen = new Set(frozenInstanceIds);
  const seen = new Set(manifest.map((row) => row.instanceId));
  for (const id of seen) if (!frozen.has(id)) issues.push(`manifest contains non-frozen instance ${id}`);
  for (const id of frozen) if (!seen.has(id)) issues.push(`frozen instance missing from manifest: ${id}`);
  const perInstance = new Map<string, Set<M214Arm>>();
  for (const row of manifest) {
    if (!perInstance.has(row.instanceId)) perInstance.set(row.instanceId, new Set());
    perInstance.get(row.instanceId)!.add(row.arm);
  }
  for (const [instanceId, arms] of perInstance) {
    if (arms.size !== 2) issues.push(`instance ${instanceId} has ${arms.size} arms, expected 2`);
  }
  if (manifest.length !== frozenInstanceIds.length * 2) {
    issues.push(`manifest has ${manifest.length} rows, expected ${frozenInstanceIds.length * 2}`);
  }
  return issues;
}

/** §26 randomisation identity: the arm orders must be the seeded ones. */
export function auditRandomization(
  manifest: readonly RunManifestRow[],
  expectedOrders: ReadonlyMap<string, readonly M214Arm[]>,
  expectedSeed: string,
): readonly string[] {
  const issues: string[] = [];
  for (const row of manifest) {
    if (row.seed !== expectedSeed) {
      issues.push(`run ${row.runId} carries seed ${row.seed}, expected ${expectedSeed}`);
      continue;
    }
    const expected = expectedOrders.get(row.instanceId);
    if (expected === undefined) {
      issues.push(`no frozen arm order for ${row.instanceId}`);
      continue;
    }
    if (expected.join(">") !== row.armOrder.join(">")) {
      issues.push(`arm order drift for ${row.instanceId}: ${row.armOrder.join(">")} vs ${expected.join(">")}`);
    }
    if (expected[row.armOrderIndex] !== row.arm) {
      issues.push(`arm order index mismatch for ${row.runId}`);
    }
  }
  return issues;
}

/** §15 budget equality, checked over the manifest rather than over one run. */
export function auditManifestBudgetSymmetry(
  manifest: readonly RunManifestRow[],
): readonly string[] {
  const identities = new Set(manifest.map((row) => row.budgetIdentity));
  const turns = new Set(manifest.map((row) => row.maxTurns));
  const caps = new Set(manifest.map((row) => row.perRunCostCapUsd));
  const issues: string[] = [];
  if (identities.size > 1) {
    issues.push(`manifest carries ${identities.size} distinct budget identities; exactly one is allowed`);
  }
  if (turns.size > 1) issues.push(`manifest carries ${turns.size} distinct turn budgets`);
  if (caps.size > 1) issues.push(`manifest carries ${caps.size} distinct cost caps`);
  return issues;
}

/** §44 preregistration immutability. */
export function auditPreregistrationHash(
  document: Record<string, unknown>,
  recordedHash: string,
): readonly string[] {
  const actual = m214PreregistrationHash(document);
  return actual === recordedHash
    ? []
    : [`preregistration hash mismatch: recorded ${recordedHash}, computed ${actual}`];
}

/** §25 manifest immutability. */
export function auditManifestHash(
  rows: readonly RunManifestRow[],
  recordedHash: string,
): readonly string[] {
  const actual = m214ManifestHash(rows);
  return actual === recordedHash
    ? []
    : [`manifest hash mismatch: recorded ${recordedHash}, computed ${actual}`];
}

/** §37 exclusions: only preregistered infrastructure categories, never outcomes. */
export function auditExclusion(
  category: string,
  legitimateCategories: readonly string[],
): readonly string[] {
  return legitimateCategories.includes(category)
    ? []
    : [`exclusion category ${category} is not preregistered; outcomes are not exclusions`];
}

/** §36 stopping: a cohort is finalisable only when every planned run is terminal. */
export function auditStopping(
  plannedRuns: number,
  terminalRuns: number,
): readonly string[] {
  return terminalRuns >= plannedRuns
    ? []
    : [`cohort is not finalisable: ${terminalRuns} of ${plannedRuns} planned runs are terminal`];
}

/** §42 the external artifact guard, expressed over the frozen population. */
export function auditExternalArtifactGuard(
  observedArtifactSha256: string,
): readonly string[] {
  return auditExternalReferenceTaskArtifact(observedArtifactSha256);
}

// ── Controls ────────────────────────────────────────────────────────

export interface FalsificationControl {
  readonly id: string;
  readonly description: string;
  readonly expectation: "GUARD_FIRES" | "GUARD_SILENT";
  readonly fired: boolean;
  readonly satisfied: boolean;
  readonly detail: string;
}

function control(
  id: string,
  description: string,
  expectation: "GUARD_FIRES" | "GUARD_SILENT",
  issues: readonly string[],
): FalsificationControl {
  const fired = issues.length > 0;
  return {
    id,
    description,
    expectation,
    fired,
    satisfied: expectation === "GUARD_FIRES" ? fired : !fired,
    detail: fired ? issues.join("; ") : "no issue reported",
  };
}

export interface SuiteInputs {
  readonly frozenInstanceIds: readonly string[];
  readonly manifest: readonly RunManifestRow[];
  readonly expectedOrders: ReadonlyMap<string, readonly M214Arm[]>;
  readonly seed: string;
  readonly preregistrationDocument: Record<string, unknown>;
  readonly preregistrationHashRecorded: string;
  readonly manifestHashRecorded: string;
  readonly legitimateExclusionCategories: readonly string[];
  readonly vtraceCommit: string;
  readonly vtraceProductTreeSha: string;
  readonly frozenTaskArtifactSha256: string;
  readonly externalReferenceHashRecorded: string;
  /** M213's committed preregistration and its recorded digest (§3, F1). */
  readonly m213Document: Record<string, unknown>;
  readonly m213PreregistrationHashRecorded: string;
  /** The instance ids the vendor's own selection script produces (§45 F2). */
  readonly vendorScriptDerivedInstanceIds: readonly string[];
  /** The vendor harness's real hardcoded pathspecs, read from its shipped JS. */
  readonly vendorHardcodedPatchExclusions: readonly string[];
  readonly vendorCleanPreservedPaths: readonly string[];
  /** Whether an M214-owned source file currently fails the scoped typecheck (§45 F21). */
  readonly scopedTypecheckDetectsInjectedError: boolean;
}

const CONTROL_INSTANCE = "astropy__astropy-14365";

function cleanObserved(
  arm: M214Arm,
  input: SuiteInputs,
  overrides: Partial<ObservedRunConfiguration> = {},
): ObservedRunConfiguration {
  const definition = armDefinition(arm);
  return {
    runId: `control:${arm}`,
    instanceId: CONTROL_INSTANCE,
    arm,
    agentVersion: M214_AGENT.version,
    model: M214_MODEL.model,
    maxTurns: M214_BUDGET.maxTurns,
    perRunCostCapUsd: M214_BUDGET.perRunCostCapUsd,
    wallClockTimeoutSecondsPerRun: M214_BUDGET.wallClockTimeoutSecondsPerRun,
    nativeTools: M214_NATIVE_TOOLS,
    mcpServers: definition.mcpServers,
    modelVisibleToolNames: definition.modelVisibleToolNames,
    environmentVariableNames: ["PATH", "HOME", "LANG"],
    workspaceRootEntries: ["src", "tests", "setup.py", ".git"],
    systemPromptAppendix: null,
    userPromptTemplate: M214_AGENT.userPromptText,
    vtraceCommit: arm === "vtrace" ? input.vtraceCommit : null,
    vtraceProductTreeSha: arm === "vtrace" ? input.vtraceProductTreeSha : null,
    conversationSeededFromRunId: null,
    patchSeededFromRunId: null,
    treatmentResultSeededFromRunId: null,
    injectedContextDocuments: [],
    goldArtifactsInAgentContext: [],
    baseCommit: "deadbeef",
    headAtAgentStart: "deadbeef",
    trackedSourceDigestAtAgentStart: "canonical-digest",
    treatmentExposed: arm === "vtrace",
    treatmentInvocationCount: arm === "vtrace" ? 3 : 0,
    ...overrides,
  };
}

function contractFor(arm: M214Arm, input: SuiteInputs): ExpectedRunContract {
  return {
    instanceId: CONTROL_INSTANCE,
    arm,
    agentVersion: M214_AGENT.version,
    model: M214_MODEL.model,
    vtraceCommit: input.vtraceCommit,
    vtraceProductTreeSha: input.vtraceProductTreeSha,
    baseCommit: "deadbeef",
    canonicalTrackedSourceDigest: "canonical-digest",
  };
}

function cleanIsolation(arm: M214Arm) {
  const definition = armDefinition(arm);
  return {
    mcpServers: definition.mcpServers,
    modelVisibleToolNames: definition.modelVisibleToolNames,
    environmentVariableNames: ["PATH", "HOME", "LANG"],
    workspaceRootEntries: arm === "vtrace"
      ? ["src", "tests", "setup.py", ".git", ".vtrace"]
      : ["src", "tests", "setup.py", ".git"],
    injectedContextDocuments: [] as readonly string[],
    daemonSocketsReachable: [] as readonly string[],
    treatmentBinariesOnPath: [] as readonly string[],
    systemPromptAppendix: null,
  };
}

/** F0 and F1–F24, in order. */
export function runFalsificationSuite(input: SuiteInputs): readonly FalsificationControl[] {
  const controls: FalsificationControl[] = [];
  const preAgentUntracked = [".vtrace"];

  // F0 — the negative controls. A guard that fires on a compliant run is useless.
  for (const arm of ["baseline", "vtrace"] as const) {
    controls.push(control(
      `F0_CLEAN_${arm.toUpperCase()}`,
      `a fully compliant ${arm} run raises no issue`,
      "GUARD_SILENT",
      auditRun(contractFor(arm, input), cleanObserved(arm, input)),
    ));
  }
  controls.push(control(
    "F0_CLEAN_TASKSET",
    "the frozen manifest matches the frozen population",
    "GUARD_SILENT",
    auditTaskSet(input.frozenInstanceIds, input.manifest),
  ));
  controls.push(control(
    "F0_CLEAN_RANDOMIZATION",
    "the frozen manifest carries the seeded arm orders",
    "GUARD_SILENT",
    auditRandomization(input.manifest, input.expectedOrders, input.seed),
  ));
  controls.push(control(
    "F0_CLEAN_HASHES",
    "the committed preregistration and manifest rehash to their recorded digests",
    "GUARD_SILENT",
    [
      ...auditPreregistrationHash(input.preregistrationDocument, input.preregistrationHashRecorded),
      ...auditManifestHash(input.manifest, input.manifestHashRecorded),
    ],
  ));
  controls.push(control(
    "F0_CLEAN_LIFECYCLE",
    "the frozen lifecycle order raises no issue",
    "GUARD_SILENT",
    auditLifecycleOrder(M214_LIFECYCLE_ORDER),
  ));

  // F1 — M213 must be immutable, and M214 must be a separate identity.
  controls.push(control(
    "F1",
    "M213's preregistration artifact is modified",
    "GUARD_FIRES",
    auditM213Immutability(
      { ...input.m213Document, armCount: 2, arms: ["baseline", "vtrace"] },
      input.m213PreregistrationHashRecorded,
      input.preregistrationHashRecorded,
    ),
  ));
  controls.push(control(
    "F1_CLEAN",
    "the committed M213 artifact is unmodified and M214's hash differs from it",
    "GUARD_SILENT",
    auditM213Immutability(
      input.m213Document,
      input.m213PreregistrationHashRecorded,
      input.preregistrationHashRecorded,
    ),
  ));

  // F2 — the vendor's selection-script output is not the vendor's published set.
  controls.push(control(
    "F2",
    "the vendor selection-script subset is swapped in for the published artifact",
    "GUARD_FIRES",
    auditTaskSet(input.vendorScriptDerivedInstanceIds, input.manifest),
  ));
  controls.push(control(
    "F2_ARTIFACT",
    "a task artifact whose digest is not the published one fails the external guard",
    "GUARD_FIRES",
    auditExternalArtifactGuard("0".repeat(64)),
  ));
  controls.push(control(
    "F2_CLEAN",
    "the frozen artifact's digest satisfies the external guard",
    "GUARD_SILENT",
    auditExternalArtifactGuard(input.frozenTaskArtifactSha256),
  ));

  // F3 — baseline contamination.
  controls.push(control(
    "F3",
    "VTRACE tools, env and workspace state are exposed to the baseline arm",
    "GUARD_FIRES",
    auditBaselineIsolation({
      ...cleanIsolation("baseline"),
      mcpServers: ["vtrace"],
      modelVisibleToolNames: [...M214_NATIVE_TOOLS, "mcp__vtrace__get_code_context"],
      environmentVariableNames: ["PATH", "HOME", "VTRACE_REPO_ROOT"],
      workspaceRootEntries: ["src", "tests", ".git", ".vtrace"],
      daemonSocketsReachable: ["/tmp/vtrace-daemon.sock"],
    }),
  ));
  controls.push(control(
    "F3_CLEAN",
    "an isolated baseline raises no issue",
    "GUARD_SILENT",
    auditBaselineIsolation(cleanIsolation("baseline")),
  ));

  // F4 — treatment metadata must not enter a captured patch.
  controls.push(control(
    "F4",
    "the captured patch contains .vtrace index metadata although no source changed",
    "GUARD_FIRES",
    auditCapturedPatchPaths(
      [".vtrace/index.meta.json", ".vtrace/index.sqlite", ".vtrace/session.sqlite"],
      preAgentUntracked,
    ),
  ));
  controls.push(control(
    "F4_HARDCODED",
    "the vendor harness's hardcoded exclusion list is judged by the derived rule",
    "GUARD_FIRES",
    auditHardcodedExclusionList(input.vendorHardcodedPatchExclusions, [".vtrace", ".vexp"]),
  ));
  controls.push(control(
    "F4_ORDERING",
    "the pre-agent snapshot is taken before treatment initialisation, so .vtrace is uncovered",
    "GUARD_FIRES",
    auditDerivedExclusionCoversTreatmentState("vtrace", [], [".vtrace"], [".vtrace"]),
  ));
  controls.push(control(
    "F4_CLEAN",
    "a source-only patch under the derived exclusion raises no issue",
    "GUARD_SILENT",
    auditCapturedPatchPaths(["astropy/units/quantity.py"], preAgentUntracked),
  ));
  controls.push(control(
    "F4_ORDERING_CLEAN",
    "a snapshot taken after treatment initialisation covers the treatment state",
    "GUARD_SILENT",
    auditDerivedExclusionCoversTreatmentState("vtrace", preAgentUntracked, [".vtrace"], preAgentUntracked),
  ));
  controls.push(control(
    "F4_NOT_ENUMERABLE_CLEAN",
    "treatment state hidden from git by .git/info/exclude is covered by the second route",
    "GUARD_SILENT",
    auditDerivedExclusionCoversTreatmentState("vtrace", [], [".vtrace"], []),
  ));

  // F5 — treatment initialisation must not mutate tracked source.
  controls.push(control(
    "F5",
    "tracked source is modified while the treatment indexes the repository",
    "GUARD_FIRES",
    auditSourceStateEquivalence({
      arm: "vtrace",
      instanceId: CONTROL_INSTANCE,
      baseCommit: "deadbeef",
      headAtAgentStart: "deadbeef",
      trackedSourceDigestBeforeTreatment: "canonical-digest",
      trackedSourceDigestAfterTreatment: "mutated-digest",
      canonicalTrackedSourceDigest: "canonical-digest",
      untrackedSourceAffectingPaths: [],
    }),
  ));
  controls.push(control(
    "F5_CLEAN",
    "observational indexing leaves the tracked source digest unchanged",
    "GUARD_SILENT",
    auditSourceStateEquivalence({
      arm: "vtrace",
      instanceId: CONTROL_INSTANCE,
      baseCommit: "deadbeef",
      headAtAgentStart: "deadbeef",
      trackedSourceDigestBeforeTreatment: "canonical-digest",
      trackedSourceDigestAfterTreatment: "canonical-digest",
      canonicalTrackedSourceDigest: "canonical-digest",
      untrackedSourceAffectingPaths: [],
    }),
  ));

  // F6 — arm budget asymmetry.
  controls.push(control(
    "F6",
    "the VTRACE arm is given a larger turn budget",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, { maxTurns: 400 })),
  ));
  controls.push(control(
    "F6_MANIFEST",
    "a manifest carrying two budget identities is rejected",
    "GUARD_FIRES",
    auditManifestBudgetSymmetry([
      ...input.manifest.slice(0, 1),
      { ...input.manifest[1]!, budgetIdentity: "tampered", perRunCostCapUsd: 9 },
    ]),
  ));
  controls.push(control(
    "F6_CLEAN",
    "the frozen manifest carries exactly one budget identity",
    "GUARD_SILENT",
    auditManifestBudgetSymmetry(input.manifest),
  ));

  // F7 — native-tool asymmetry.
  controls.push(control(
    "F7",
    "a native tool is removed from the baseline arm",
    "GUARD_FIRES",
    auditRun(contractFor("baseline", input), cleanObserved("baseline", input, {
      nativeTools: M214_NATIVE_TOOLS.filter((tool) => tool !== "Grep"),
      modelVisibleToolNames: M214_NATIVE_TOOLS.filter((tool) => tool !== "Grep"),
    })),
  ));

  // F8 — model drift.
  controls.push(control(
    "F8",
    "the model identifier changes mid-cohort",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, { model: "claude-opus-5" })),
  ));

  // F9 — prompt drift.
  controls.push(control(
    "F9",
    "a system prompt appendix and an altered user prompt are introduced",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      systemPromptAppendix: "Always call VTRACE before reading any file.",
      userPromptTemplate: "Fix it. Use the vtrace tools first.",
    })),
  ));

  // F10 — VTRACE product identity drift.
  controls.push(control(
    "F10",
    "the VTRACE product commit and tree change after preregistration",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      vtraceCommit: "0".repeat(40),
      vtraceProductTreeSha: "1".repeat(40),
    })),
  ));

  // F11 — task-set drift.
  controls.push(control(
    "F11",
    "one task is added to the frozen population",
    "GUARD_FIRES",
    auditTaskSet([...input.frozenInstanceIds, "django__django-99999"], input.manifest),
  ));
  controls.push(control(
    "F11_REMOVED",
    "one task is removed from the frozen population",
    "GUARD_FIRES",
    auditTaskSet(input.frozenInstanceIds.slice(1), input.manifest),
  ));

  // F12 — run-order drift.
  controls.push(control(
    "F12",
    "the committed execution-order randomisation is changed",
    "GUARD_FIRES",
    auditRandomization(
      input.manifest.map((row) => ({
        ...row,
        armOrder: ["baseline", "vtrace"] as readonly M214Arm[],
        arm: "baseline" as M214Arm,
        armOrderIndex: 0,
      })),
      input.expectedOrders,
      input.seed,
    ),
  ));
  controls.push(control(
    "F12_SEED",
    "the committed seed is changed",
    "GUARD_FIRES",
    auditRandomization(
      input.manifest.map((row) => ({ ...row, seed: "some-other-seed" })),
      input.expectedOrders,
      input.seed,
    ),
  ));

  // F13 — early stopping.
  controls.push(control(
    "F13",
    "the cohort is finalised before every planned run is terminal",
    "GUARD_FIRES",
    auditStopping(200, 148),
  ));
  controls.push(control(
    "F13_CLEAN",
    "a complete cohort is finalisable",
    "GUARD_SILENT",
    auditStopping(200, 200),
  ));

  // F14 — outcome-dependent exclusion.
  controls.push(control(
    "F14",
    "a normally-unresolved task is excluded after the fact",
    "GUARD_FIRES",
    auditExclusion("AGENT_FAILED_TASK", input.legitimateExclusionCategories),
  ));
  controls.push(control(
    "F14_UNUSED",
    "a run is excluded because the treatment was never invoked",
    "GUARD_FIRES",
    auditExclusion("TREATMENT_NEVER_INVOKED", input.legitimateExclusionCategories),
  ));
  controls.push(control(
    "F14_CLEAN",
    "a preregistered infrastructure category is accepted",
    "GUARD_SILENT",
    auditExclusion("CONTAINER_CANNOT_START", input.legitimateExclusionCategories),
  ));

  // F15 — treatment exposed but never invoked is a VALID intention-to-treat run.
  controls.push(control(
    "F15",
    "the VTRACE surface is exposed and the agent never calls it",
    "GUARD_SILENT",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      treatmentInvocationCount: 0,
    })),
  ));

  // F16 — the vendor's number may not enter a paired causal statistic.
  controls.push(control(
    "F16",
    "the published 73/100 is passed to the paired-comparison entry point",
    "GUARD_FIRES",
    auditPairedComparison({
      left: "vtrace",
      right: "vexp_published",
      evidenceClasses: { vexp_published: EXTERNAL_VENDOR_REFERENCE },
    }),
  ));
  controls.push(control(
    "F16_TABLE",
    "the external reference is added as a row of the causal table",
    "GUARD_FIRES",
    auditCausalTableMembership([
      { label: "baseline", evidenceClass: M214_EXPERIMENTAL_ARM },
      { label: "VTRACE", evidenceClass: M214_EXPERIMENTAL_ARM },
      { label: "VEXP published", evidenceClass: EXTERNAL_VENDOR_REFERENCE },
    ]),
  ));
  controls.push(control(
    "F16_CLEAN",
    "the two executed arms are a valid paired comparison",
    "GUARD_SILENT",
    auditPairedComparison({ left: "baseline", right: "vtrace" }),
  ));

  // F17 — external-reference relabelling.
  controls.push(control(
    "F17",
    "the external reference is labelled an experimental arm",
    "GUARD_FIRES",
    auditEvidenceClassLabel("Arm C — experimental arm (VEXP)", EXTERNAL_VENDOR_REFERENCE),
  ));
  controls.push(control(
    "F17_WORDING",
    "an unqualified head-to-head claim is written about the published number",
    "GUARD_FIRES",
    auditExternalComparisonWording("VTRACE beat VEXP by 3 points, 76% versus 73%."),
  ));
  controls.push(control(
    "F17_CLEAN",
    "the generated external-comparison sentence passes its own wording audit",
    "GUARD_SILENT",
    auditExternalComparisonWording(
      renderExternalComparison({ baselineResolved: 74, vtraceResolved: 76, tasks: 100 }),
    ),
  ));

  // F18 — wrong external task hash.
  controls.push(control(
    "F18",
    "the external reference is applied to a different task artifact",
    "GUARD_FIRES",
    auditExternalReferenceTaskArtifact("f".repeat(64)),
  ));

  // F19 — warm-index asymmetry.
  controls.push(control(
    "F19",
    "one arm is warm under the frozen COLD_UNIFORM policy",
    "GUARD_FIRES",
    auditWarmthPolicy([
      { arm: "baseline", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [] },
      { arm: "vtrace", treatmentStateInheritedFromPreviousRun: [".vtrace"], resetPreservedPaths: [".vtrace"] },
    ]),
  ));
  controls.push(control(
    "F19_CLEAN",
    "a uniformly cold cohort raises no issue",
    "GUARD_SILENT",
    auditWarmthPolicy([
      { arm: "baseline", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [] },
      { arm: "vtrace", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [] },
    ]),
  ));

  // F20 — source-reset asymmetry.
  controls.push(control(
    "F20",
    "the reset preserves one treatment's state between tasks",
    "GUARD_FIRES",
    auditResetPreservedPaths(input.vendorCleanPreservedPaths, [".vtrace", ".vexp"]),
  ));
  controls.push(control(
    "F20_CLEAN",
    "a reset that preserves no treatment state raises no issue",
    "GUARD_SILENT",
    auditResetPreservedPaths([".claude"], [".vtrace", ".vexp"]),
  ));

  // F21 — a type error in an M214-owned file must fail the scoped typecheck.
  controls.push(control(
    "F21",
    "an injected type error in an M214-owned test file fails the scoped typecheck",
    "GUARD_FIRES",
    input.scopedTypecheckDetectsInjectedError
      ? ["tsconfig.m214.json reports an error for the injected fault"]
      : [],
  ));

  // F22 — gold leakage.
  controls.push(control(
    "F22",
    "gold patch and FAIL_TO_PASS artifacts are reachable from the agent's context",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      goldArtifactsInAgentContext: ["/testbed/.gold.patch", "/testbed/FAIL_TO_PASS.json"],
    })),
  ));

  // F23 — conversation reuse across arms.
  controls.push(control(
    "F23",
    "the VTRACE run is seeded from the baseline run's transcript and patch",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      conversationSeededFromRunId: `${CONTROL_INSTANCE}:baseline`,
      patchSeededFromRunId: `${CONTROL_INSTANCE}:baseline`,
    })),
  ));

  // F24 — the external reference is updated after preregistration.
  controls.push(control(
    "F24",
    "the vendor's published score is edited after the snapshot was frozen",
    "GUARD_FIRES",
    auditExternalReferenceSnapshot(
      { ...M214_EXTERNAL_REFERENCE, publishedPassAt1Count: 80, publishedPassAt1Percent: 80 },
      input.externalReferenceHashRecorded,
    ),
  ));
  controls.push(control(
    "F24_CLEAN",
    "the frozen external reference rehashes to its recorded digest",
    "GUARD_SILENT",
    auditExternalReferenceSnapshot(M214_EXTERNAL_REFERENCE, input.externalReferenceHashRecorded),
  ));

  // Extra controls M214's own audit forced, beyond the prompt's F1–F24.
  controls.push(control(
    "F25_ARM_CROSS_CONTAMINATION",
    "VEXP state appears inside the VTRACE arm",
    "GUARD_FIRES",
    auditTreatmentArmContainment({
      ...cleanIsolation("vtrace"),
      workspaceRootEntries: ["src", ".git", ".vtrace", ".vexp"],
      environmentVariableNames: ["PATH", "VEXP_LICENSE"],
    }),
  ));
  controls.push(control(
    "F25_CLEAN",
    "a compliant VTRACE arm raises no containment issue",
    "GUARD_SILENT",
    auditTreatmentArmContainment(cleanIsolation("vtrace")),
  ));
  controls.push(control(
    "F26_LIFECYCLE_ORDER",
    "the pre-agent snapshot is reordered before treatment initialisation",
    "GUARD_FIRES",
    auditLifecycleOrder([
      "CONTAINER_START",
      "SOURCE_CHECKOUT_AT_BASE_COMMIT",
      "SOURCE_STATE_DIGEST_BEFORE_TREATMENT",
      "PRE_AGENT_UNTRACKED_SNAPSHOT",
      "TREATMENT_INITIALISATION",
      "SOURCE_STATE_DIGEST_AFTER_TREATMENT",
      "AGENT_RUN",
      "PATCH_CAPTURE",
      "EVALUATION",
    ]),
  ));
  controls.push(control(
    "F27_EXTERNAL_HASH_STABLE",
    "the frozen external reference's digest is what the artifact records",
    "GUARD_SILENT",
    externalReferenceHash() === input.externalReferenceHashRecorded
      ? []
      : [`external reference hash ${externalReferenceHash()} != recorded ${input.externalReferenceHashRecorded}`],
  ));

  return controls;
}

export function suitePasses(controls: readonly FalsificationControl[]): boolean {
  return controls.every((entry) => entry.satisfied);
}
