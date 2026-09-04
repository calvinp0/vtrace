/**
 * M213 §41 — the falsification suite, and the guards it falsifies.
 *
 * Two halves that must be read together:
 *
 *   GUARDS      deterministic auditors that compare an OBSERVED run
 *               configuration against the frozen preregistration and return
 *               human-readable issues.
 *   CONTROLS    F1–F22, each of which deliberately breaks one thing and
 *               asserts the corresponding guard notices.
 *
 * A suite of controls without a clean negative control proves nothing: a guard
 * that rejects everything would pass F1–F22 and be useless. `F0_CLEAN` is
 * therefore part of the suite, and a compliant configuration must produce zero
 * issues.
 *
 * PURE. No spawning, no network, no model, no product import.
 */

import {
  M213_AGENT,
  M213_BUDGET,
  M213_MODEL,
  M213_NATIVE_TOOLS,
  type M213Arm,
  type RunManifestRow,
  armDefinition,
  manifestHash,
  preregistrationHash,
} from "./m213Preregistration";

// ── Observed configuration ──────────────────────────────────────────

export interface ObservedRunConfiguration {
  readonly runId: string;
  readonly instanceId: string;
  readonly arm: M213Arm;
  readonly agentVersion: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly perRunCostCapUsd: number;
  readonly wallClockTimeoutSecondsPerRun: number;
  readonly nativeTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly modelVisibleToolNames: readonly string[];
  readonly environmentVariableNames: readonly string[];
  /** Entries visible at the agent's workspace root the moment the agent starts. */
  readonly workspaceRootEntries: readonly string[];
  readonly systemPromptAppendix: string | null;
  readonly userPromptTemplate: string;
  readonly vtraceCommit: string | null;
  readonly vexpVersion: string | null;
  /** Non-null when this run inherited state from another run (§17). */
  readonly conversationSeededFromRunId: string | null;
  readonly patchSeededFromRunId: string | null;
  readonly treatmentResultSeededFromRunId: string | null;
  /** Any text document reachable as instruction context at agent start. */
  readonly injectedContextDocuments: readonly string[];
  /** Any evaluation artifact present in the agent's context (§18). */
  readonly goldArtifactsInAgentContext: readonly string[];
  readonly baseCommit: string;
  readonly headAtAgentStart: string;
  readonly trackedSourceDigestAtAgentStart: string;
}

export interface ExpectedRunContract {
  readonly instanceId: string;
  readonly arm: M213Arm;
  readonly agentVersion: string;
  readonly model: string;
  readonly vtraceCommit: string;
  readonly vexpVersion: string | null;
  readonly baseCommit: string;
  readonly canonicalTrackedSourceDigest: string;
}

/** Environment-variable prefixes each arm must not carry (§36). */
const ARM_FORBIDDEN_ENV_PREFIXES: Readonly<Record<M213Arm, readonly string[]>> = Object.freeze({
  baseline: ["VTRACE_", "VEXP_"],
  vtrace: ["VEXP_"],
  vexp: ["VTRACE_"],
});

/** Workspace entries each arm must not see at agent start (§35, §36). */
const ARM_FORBIDDEN_WORKSPACE_ENTRIES: Readonly<Record<M213Arm, readonly string[]>> = Object.freeze({
  baseline: [".vtrace", ".vexp"],
  vtrace: [".vexp"],
  vexp: [".vtrace"],
});

// ── Guards ──────────────────────────────────────────────────────────

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

  // §8 agent identity, §9 model identity — identical in every arm.
  if (observed.agentVersion !== expected.agentVersion) {
    issues.push(`agent version drift: expected ${expected.agentVersion}, observed ${observed.agentVersion}`);
  }
  if (observed.model !== expected.model) {
    issues.push(`model drift: expected ${expected.model}, observed ${observed.model}`);
  }
  if (observed.systemPromptAppendix !== null) {
    issues.push("system prompt carries an appendix; every arm must use the CLI default");
  }
  if (observed.userPromptTemplate !== M213_AGENT.userPromptText) {
    issues.push("user prompt drift: the prompt template differs from the frozen text");
  }

  // §10 budget equality.
  if (observed.maxTurns !== M213_BUDGET.maxTurns) {
    issues.push(`turn budget drift: expected ${M213_BUDGET.maxTurns}, observed ${observed.maxTurns}`);
  }
  if (observed.perRunCostCapUsd !== M213_BUDGET.perRunCostCapUsd) {
    issues.push(`cost cap drift: expected ${M213_BUDGET.perRunCostCapUsd}, observed ${observed.perRunCostCapUsd}`);
  }
  if (observed.wallClockTimeoutSecondsPerRun !== M213_BUDGET.wallClockTimeoutSecondsPerRun) {
    issues.push("wall-clock timeout drift");
  }

  // §11 native tool parity — no arm may be narrowed or widened.
  const nativeExpected = [...M213_NATIVE_TOOLS].sort().join(",");
  const nativeObserved = [...observed.nativeTools].sort().join(",");
  if (nativeExpected !== nativeObserved) {
    issues.push(`native tool set differs from the frozen set: observed [${nativeObserved}]`);
  }

  // §12 treatment surface — exactly the arm's own catalogue, nothing else.
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

  // §35, §36 contamination.
  for (const prefix of ARM_FORBIDDEN_ENV_PREFIXES[observed.arm]) {
    const offenders = observed.environmentVariableNames.filter((name) => name.startsWith(prefix));
    if (offenders.length > 0) {
      issues.push(`${observed.arm} arm carries forbidden environment variables: ${offenders.join(", ")}`);
    }
  }
  for (const entry of ARM_FORBIDDEN_WORKSPACE_ENTRIES[observed.arm]) {
    if (observed.workspaceRootEntries.includes(entry)) {
      issues.push(`${observed.arm} arm workspace contains forbidden entry ${entry} at agent start`);
    }
  }
  if (observed.injectedContextDocuments.length > 0) {
    issues.push(
      `injected instruction context present: ${observed.injectedContextDocuments.join(", ")}`,
    );
  }

  // §31 treatment identity pinning.
  if (observed.arm === "vtrace" && observed.vtraceCommit !== expected.vtraceCommit) {
    issues.push(`VTRACE identity drift: expected ${expected.vtraceCommit}, observed ${observed.vtraceCommit ?? "null"}`);
  }
  if (observed.arm === "vexp") {
    if (observed.vexpVersion === null || observed.vexpVersion.length === 0) {
      issues.push("VEXP version is not pinned; a versionless competitor arm cannot launch (F20)");
    } else if (observed.vexpVersion !== expected.vexpVersion) {
      issues.push(`VEXP identity drift: expected ${expected.vexpVersion ?? "null"}, observed ${observed.vexpVersion}`);
    }
  }
  if (observed.arm !== "vtrace" && observed.vtraceCommit !== null) {
    issues.push(`${observed.arm} arm declares a VTRACE commit`);
  }
  if (observed.arm !== "vexp" && observed.vexpVersion !== null) {
    issues.push(`${observed.arm} arm declares a VEXP version`);
  }

  // §14 repository state equivalence.
  if (observed.headAtAgentStart !== expected.baseCommit) {
    issues.push(`repository HEAD at agent start is not the frozen base commit`);
  }
  if (observed.trackedSourceDigestAtAgentStart !== expected.canonicalTrackedSourceDigest) {
    issues.push("tracked source state differs from the canonical state for this instance");
  }

  // §17 independence.
  if (observed.conversationSeededFromRunId !== null) {
    issues.push(`conversation state reused from ${observed.conversationSeededFromRunId}`);
  }
  if (observed.patchSeededFromRunId !== null) {
    issues.push(`patch state reused from ${observed.patchSeededFromRunId}`);
  }
  if (observed.treatmentResultSeededFromRunId !== null) {
    issues.push(`treatment result reused from ${observed.treatmentResultSeededFromRunId}`);
  }

  // §18 evaluation leakage.
  if (observed.goldArtifactsInAgentContext.length > 0) {
    issues.push(
      `evaluation artifacts reachable from agent context: ${observed.goldArtifactsInAgentContext.join(", ")}`,
    );
  }

  return issues;
}

/** §9 task-set identity: the manifest must cover the frozen population exactly. */
export function auditTaskSet(
  frozenInstanceIds: readonly string[],
  manifest: readonly RunManifestRow[],
): readonly string[] {
  const issues: string[] = [];
  const frozen = new Set(frozenInstanceIds);
  const seen = new Set(manifest.map((row) => row.instanceId));
  for (const id of seen) if (!frozen.has(id)) issues.push(`manifest contains non-frozen instance ${id}`);
  for (const id of frozen) if (!seen.has(id)) issues.push(`frozen instance missing from manifest: ${id}`);
  const perInstance = new Map<string, Set<M213Arm>>();
  for (const row of manifest) {
    if (!perInstance.has(row.instanceId)) perInstance.set(row.instanceId, new Set());
    perInstance.get(row.instanceId)!.add(row.arm);
  }
  for (const [instanceId, arms] of perInstance) {
    if (arms.size !== 3) issues.push(`instance ${instanceId} has ${arms.size} arms, expected 3`);
  }
  if (manifest.length !== frozenInstanceIds.length * 3) {
    issues.push(`manifest has ${manifest.length} rows, expected ${frozenInstanceIds.length * 3}`);
  }
  return issues;
}

/** §16 randomisation identity: the arm orders must be the seeded ones. */
export function auditRandomization(
  manifest: readonly RunManifestRow[],
  expectedOrders: ReadonlyMap<string, readonly M213Arm[]>,
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

/** §38 preregistration immutability. */
export function auditPreregistrationHash(
  document: Record<string, unknown>,
  recordedHash: string,
): readonly string[] {
  const actual = preregistrationHash(document);
  return actual === recordedHash
    ? []
    : [`preregistration hash mismatch: recorded ${recordedHash}, computed ${actual}`];
}

/** §39 manifest immutability. */
export function auditManifestHash(
  rows: readonly RunManifestRow[],
  recordedHash: string,
): readonly string[] {
  const actual = manifestHash(rows);
  return actual === recordedHash
    ? []
    : [`manifest hash mismatch: recorded ${recordedHash}, computed ${actual}`];
}

/** §6 exclusions: only preregistered infrastructure categories, never outcomes. */
export function auditExclusion(
  category: string,
  legitimateCategories: readonly string[],
): readonly string[] {
  return legitimateCategories.includes(category)
    ? []
    : [`exclusion category ${category} is not preregistered; outcomes are not exclusions`];
}

/** §29 stopping: a cohort is finalisable only when every planned run is terminal. */
export function auditStopping(
  plannedRuns: number,
  terminalRuns: number,
): readonly string[] {
  return terminalRuns >= plannedRuns
    ? []
    : [`cohort is not finalisable: ${terminalRuns} of ${plannedRuns} planned runs are terminal`];
}

/**
 * §21/§41 F21 — treatment-generated state must not be able to enter a captured
 * patch, and the exclusion must be SYMMETRIC across arms.
 *
 * Measured against the real vexp-swe-bench `capturePatch` pathspec, which
 * excludes `.vexp` and does not exclude `.vtrace`.
 */
export const TREATMENT_STATE_DIRECTORIES: readonly string[] = Object.freeze([
  ".vtrace", ".vexp", ".claude", ".bench-mcp-config.json",
]);

export function auditPatchCaptureExclusions(
  excludedPaths: readonly string[],
): readonly string[] {
  const issues: string[] = [];
  for (const directory of TREATMENT_STATE_DIRECTORIES) {
    if (!excludedPaths.includes(directory)) {
      issues.push(
        `patch capture does not exclude ${directory}; that arm's generated state would enter its patch`,
      );
    }
  }
  return issues;
}

/** The same check applied to an actually-captured patch's file list. */
export function auditCapturedPatchPaths(paths: readonly string[]): readonly string[] {
  return paths
    .filter((entry) => TREATMENT_STATE_DIRECTORIES.some((dir) => entry === dir || entry.startsWith(`${dir}/`)))
    .map((entry) => `captured patch contains treatment-generated path ${entry}`);
}

/**
 * §41 F22 — index warmth must be symmetric.
 *
 * The harness's `resetRepo` preserves `.vexp` across tasks and would delete
 * `.vtrace`, which silently gives one treatment a warm index and the other a
 * cold rebuild per task. Either both survive or neither does; §13 then reports
 * the chosen regime as cold or warm rather than mixing them.
 */
export function auditIndexWarmthSymmetry(
  cleanPreservedPaths: readonly string[],
): readonly string[] {
  const preservesVtrace = cleanPreservedPaths.includes(".vtrace");
  const preservesVexp = cleanPreservedPaths.includes(".vexp");
  return preservesVtrace === preservesVexp
    ? []
    : [
      `index warmth is asymmetric: .vtrace ${preservesVtrace ? "preserved" : "wiped"} but `
      + `.vexp ${preservesVexp ? "preserved" : "wiped"} between tasks`,
    ];
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
  readonly expectedOrders: ReadonlyMap<string, readonly M213Arm[]>;
  readonly seed: string;
  readonly preregistrationDocument: Record<string, unknown>;
  readonly preregistrationHashRecorded: string;
  readonly manifestHashRecorded: string;
  readonly legitimateExclusionCategories: readonly string[];
  readonly vtraceCommit: string;
  readonly vexpVersion: string | null;
  /** The pathspec exclusions the real harness applies when capturing a patch. */
  readonly observedPatchCaptureExclusions: readonly string[];
  /** The paths the real harness preserves when cleaning between tasks. */
  readonly observedCleanPreservedPaths: readonly string[];
}

function cleanObserved(
  arm: M213Arm,
  input: SuiteInputs,
  overrides: Partial<ObservedRunConfiguration> = {},
): ObservedRunConfiguration {
  const definition = armDefinition(arm);
  return {
    runId: `control:${arm}`,
    instanceId: "astropy__astropy-14365",
    arm,
    agentVersion: M213_AGENT.version,
    model: M213_MODEL.model,
    maxTurns: M213_BUDGET.maxTurns,
    perRunCostCapUsd: M213_BUDGET.perRunCostCapUsd,
    wallClockTimeoutSecondsPerRun: M213_BUDGET.wallClockTimeoutSecondsPerRun,
    nativeTools: M213_NATIVE_TOOLS,
    mcpServers: definition.mcpServers,
    modelVisibleToolNames: definition.modelVisibleToolNames,
    environmentVariableNames: ["PATH", "HOME", "LANG"],
    workspaceRootEntries: ["src", "tests", "setup.py", ".git"],
    systemPromptAppendix: null,
    userPromptTemplate: M213_AGENT.userPromptText,
    vtraceCommit: arm === "vtrace" ? input.vtraceCommit : null,
    vexpVersion: arm === "vexp" ? input.vexpVersion : null,
    conversationSeededFromRunId: null,
    patchSeededFromRunId: null,
    treatmentResultSeededFromRunId: null,
    injectedContextDocuments: [],
    goldArtifactsInAgentContext: [],
    baseCommit: "deadbeef",
    headAtAgentStart: "deadbeef",
    trackedSourceDigestAtAgentStart: "canonical-digest",
    ...overrides,
  };
}

function contractFor(arm: M213Arm, input: SuiteInputs): ExpectedRunContract {
  return {
    instanceId: "astropy__astropy-14365",
    arm,
    agentVersion: M213_AGENT.version,
    model: M213_MODEL.model,
    vtraceCommit: input.vtraceCommit,
    vexpVersion: input.vexpVersion,
    baseCommit: "deadbeef",
    canonicalTrackedSourceDigest: "canonical-digest",
  };
}

/** F0 and F1–F22, in order. */
export function runFalsificationSuite(input: SuiteInputs): readonly FalsificationControl[] {
  const controls: FalsificationControl[] = [];

  // F0 — the negative control. A guard that fires on a compliant run is useless.
  for (const arm of ["baseline", "vtrace", "vexp"] as const) {
    controls.push(control(
      `F0_CLEAN_${arm.toUpperCase()}`,
      `a fully compliant ${arm} run raises no issue`,
      "GUARD_SILENT",
      auditRun(contractFor(arm, input), cleanObserved(arm, input)),
    ));
  }

  // F1 — baseline contamination.
  controls.push(control(
    "F1",
    "a VTRACE tool is injected into the baseline arm",
    "GUARD_FIRES",
    auditRun(contractFor("baseline", input), cleanObserved("baseline", input, {
      mcpServers: ["vtrace"],
      modelVisibleToolNames: [...M213_NATIVE_TOOLS, "mcp__vtrace__get_code_context"],
    })),
  ));

  // F2 — VEXP exposed in the VTRACE arm.
  controls.push(control(
    "F2",
    "VEXP is exposed inside the VTRACE arm",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      mcpServers: ["vtrace", "vexp"],
      modelVisibleToolNames: [
        ...armDefinition("vtrace").modelVisibleToolNames,
        "mcp__vexp__run_pipeline",
      ],
      workspaceRootEntries: ["src", "tests", "setup.py", ".git", ".vexp"],
    })),
  ));

  // F3 — VTRACE exposed in the VEXP arm.
  controls.push(control(
    "F3",
    "VTRACE is exposed inside the VEXP arm",
    "GUARD_FIRES",
    auditRun(contractFor("vexp", input), cleanObserved("vexp", input, {
      mcpServers: ["vexp", "vtrace"],
      modelVisibleToolNames: [
        ...armDefinition("vexp").modelVisibleToolNames,
        "mcp__vtrace__get_code_context",
      ],
      environmentVariableNames: ["PATH", "HOME", "VTRACE_HOME"],
    })),
  ));

  // F4 — treatment identity drift after manifest generation.
  controls.push(control(
    "F4",
    "the VTRACE commit changes after the manifest is generated",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      vtraceCommit: "0000000000000000000000000000000000000000",
    })),
  ));

  // F5 — model drift.
  controls.push(control(
    "F5",
    "one arm runs a different model id",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      model: "claude-sonnet-5",
    })),
  ));

  // F6 — prompt drift.
  controls.push(control(
    "F6",
    "a treatment-specific instruction is appended to one arm's prompt",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      systemPromptAppendix: "Always call get_code_context before editing.",
    })),
  ));

  // F7 — budget drift.
  controls.push(control(
    "F7",
    "one arm is given a larger turn and cost budget",
    "GUARD_FIRES",
    auditRun(contractFor("vexp", input), cleanObserved("vexp", input, {
      maxTurns: 400,
      perRunCostCapUsd: 6,
    })),
  ));

  // F8 — repository-state drift.
  controls.push(control(
    "F8",
    "source is modified before one arm starts",
    "GUARD_FIRES",
    auditRun(contractFor("baseline", input), cleanObserved("baseline", input, {
      trackedSourceDigestAtAgentStart: "mutated-digest",
    })),
  ));

  // F9 — task-set mutation.
  const mutatedManifest = input.manifest.filter((row) => row.instanceId !== input.frozenInstanceIds[0]);
  controls.push(control(
    "F9",
    "a task is removed from the manifest after preregistration",
    "GUARD_FIRES",
    [
      ...auditTaskSet(input.frozenInstanceIds, mutatedManifest),
      ...auditManifestHash(mutatedManifest, input.manifestHashRecorded),
    ],
  ));

  // F10 — randomisation mutation.
  const reseeded = input.manifest.map((row) => ({ ...row, seed: "some-other-seed" }));
  controls.push(control(
    "F10",
    "the arm-order seed is changed after preregistration",
    "GUARD_FIRES",
    [
      ...auditRandomization(reseeded, input.expectedOrders, input.seed),
      ...auditManifestHash(reseeded, input.manifestHashRecorded),
    ],
  ));

  // F11 — exclusion invented after an outcome.
  controls.push(control(
    "F11",
    "an ordinary unresolved run is marked invalid with no infrastructure reason",
    "GUARD_FIRES",
    auditExclusion("AGENT_DID_NOT_SOLVE_IT", input.legitimateExclusionCategories),
  ));

  // F12 — tool non-use. THE RUN MUST REMAIN VALID.
  controls.push(control(
    "F12",
    "a treatment arm exposes its tool and the agent never invokes it: the run stays valid under ITT",
    "GUARD_SILENT",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input)),
  ));

  // F13 — treatment initialisation failure is a preregistered category, never a silent baseline.
  controls.push(control(
    "F13_CLASSIFIED",
    "treatment initialisation failure is a preregistered exclusion category",
    "GUARD_SILENT",
    auditExclusion("TREATMENT_INITIALISATION_FAILURE", input.legitimateExclusionCategories),
  ));
  controls.push(control(
    "F13_NO_SILENT_BASELINE",
    "a VTRACE arm whose treatment failed to initialise is silently run as baseline",
    "GUARD_FIRES",
    auditRun(contractFor("vtrace", input), cleanObserved("vtrace", input, {
      mcpServers: [],
      modelVisibleToolNames: M213_NATIVE_TOOLS,
      vtraceCommit: null,
    })),
  ));

  // F14 — preregistration mutation after hashing.
  controls.push(control(
    "F14",
    "the preregistration document is edited after its hash is recorded",
    "GUARD_FIRES",
    auditPreregistrationHash(
      { ...input.preregistrationDocument, stoppingRule: "stop when it looks good" },
      input.preregistrationHashRecorded,
    ),
  ));

  // F15 — partial-cohort stopping.
  controls.push(control(
    "F15",
    "the cohort is finalised after 180 of 300 planned runs",
    "GUARD_FIRES",
    auditStopping(300, 180),
  ));

  // F16 — outcome-dependent task filtering.
  const filtered = input.manifest.filter((_row, index) => index >= 30);
  controls.push(control(
    "F16",
    "tasks are dropped from the analysis because a treatment lost them",
    "GUARD_FIRES",
    auditTaskSet(input.frozenInstanceIds, filtered),
  ));

  // F17 — arm-specific native tools.
  controls.push(control(
    "F17",
    "Grep is removed from one arm",
    "GUARD_FIRES",
    auditRun(contractFor("vexp", input), cleanObserved("vexp", input, {
      nativeTools: M213_NATIVE_TOOLS.filter((tool) => tool !== "Grep"),
      modelVisibleToolNames: armDefinition("vexp").modelVisibleToolNames
        .filter((tool) => tool !== "Grep"),
    })),
  ));

  // F18 — evaluation leakage.
  controls.push(control(
    "F18",
    "the gold patch is reachable from the agent's context",
    "GUARD_FIRES",
    auditRun(contractFor("baseline", input), cleanObserved("baseline", input, {
      goldArtifactsInAgentContext: ["gold_patch.diff", "FAIL_TO_PASS.json"],
    })),
  ));

  // F19 — same-run independence.
  controls.push(control(
    "F19",
    "a later arm reuses the previous arm's conversation and patch",
    "GUARD_FIRES",
    auditRun(contractFor("vexp", input), cleanObserved("vexp", input, {
      conversationSeededFromRunId: "VTRACE_VEXP_CAUSAL_100:astropy__astropy-14365:vtrace",
      patchSeededFromRunId: "VTRACE_VEXP_CAUSAL_100:astropy__astropy-14365:vtrace",
    })),
  ));

  // F20 — versionless VEXP.
  controls.push(control(
    "F20",
    "the VEXP arm cannot pin a version",
    "GUARD_FIRES",
    auditRun(
      { ...contractFor("vexp", input), vexpVersion: null },
      cleanObserved("vexp", input, { vexpVersion: null }),
    ),
  ));

  // F21 — treatment state in a captured patch (measured harness defect).
  controls.push(control(
    "F21_HARNESS",
    "the harness's own patch-capture exclusion list is asymmetric across treatments",
    "GUARD_FIRES",
    auditPatchCaptureExclusions(input.observedPatchCaptureExclusions),
  ));
  controls.push(control(
    "F21_PATCH",
    "a captured patch contains the treatment's generated index state",
    "GUARD_FIRES",
    auditCapturedPatchPaths([
      "src/flask/app.py", ".vtrace/index.meta.json", ".vtrace/index.sqlite",
    ]),
  ));
  controls.push(control(
    "F21_CLEAN",
    "a captured patch containing only source changes raises no issue",
    "GUARD_SILENT",
    auditCapturedPatchPaths(["src/flask/app.py", "src/flask/blueprints.py"]),
  ));

  // F22 — asymmetric index warmth (measured harness defect).
  controls.push(control(
    "F22",
    "the harness preserves one treatment's index between tasks and wipes the other's",
    "GUARD_FIRES",
    auditIndexWarmthSymmetry(input.observedCleanPreservedPaths),
  ));
  controls.push(control(
    "F22_CLEAN",
    "a symmetric clean policy raises no issue",
    "GUARD_SILENT",
    auditIndexWarmthSymmetry([".claude"]),
  ));

  return controls;
}

export function suitePasses(controls: readonly FalsificationControl[]): boolean {
  return controls.every((entry) => entry.satisfied);
}
