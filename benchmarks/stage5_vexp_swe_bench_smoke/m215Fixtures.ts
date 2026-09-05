/**
 * M215 §44 — synthetic adapters for the dry-run layers.
 *
 * The executor takes containers, the agent and the evaluator as interfaces, and
 * this module supplies deterministic stand-ins for exactly those three. Nothing
 * else is faked: the frozen authorities are the committed files, the gates are
 * the real gates, the ledger is the real ledger, and the patch-capture rule is
 * the real derivation. That is what lets a $0 milestone falsify a $700 machine.
 *
 * Every fixture is built from one `SyntheticWorld` with overrides, so a
 * falsification control perturbs exactly one property and the reader can see
 * which. A suite where each control constructs its own world would let a
 * control pass for a reason its author did not intend.
 *
 * `mode` is SYNTHETIC throughout. A record produced here cannot enter an
 * authoritative cohort ledger, and F29 checks that rather than assuming it.
 */

import { createHash } from "node:crypto";

import {
  M214_AGENT,
  M214_NATIVE_TOOLS,
  M214_VTRACE_TREATMENT_CATALOG,
  type M214Arm,
  type RunManifestRow,
  armDefinition,
  mcpToolName,
} from "./m214Preregistration";
import {
  type AgentAdapter,
  type AgentRunHooks,
  type AgentRunOutcome,
  type AgentRunSpec,
  type ArmSurfaceObservation,
  type CapturedPatch,
  type ContainerAdapter,
  type ContainerHandle,
  type EvaluationOutcome,
  type EvaluatorAdapter,
  type TreatmentInitialisation,
  LEGACY_VENDOR_PATCH_EXCLUSIONS,
  treatmentCatalogSha256,
} from "./m215LaunchExecutor";
import type { TeardownReport } from "./m217ContinuationSafety";
import type { TelemetryEvent } from "./m215CohortLedger";

// ── Treatment-state routes (§31, §54) ───────────────────────────────

/**
 * The two ways `.vtrace` relates to git, which M214's probe discovered.
 *
 * `vtrace init` appends `/.vtrace/` to `.git/info/exclude`, so the directory is
 * invisible to `git ls-files --others --exclude-standard` and never reaches the
 * pre-agent snapshot at all. `vtrace index` alone writes no such entry, so the
 * same index IS enumerable. A patch-capture guard that handled only one route
 * would pass a broken run or fail a compliant one, so both are fixtures.
 */
export type TreatmentStateRoute = "INIT_WRITES_GIT_EXCLUDE" | "INDEX_ONLY_NO_GIT_EXCLUDE";

export const SYNTHETIC_TREATMENT_FILES: readonly string[] = Object.freeze([
  ".vtrace/index.sqlite",
  ".vtrace/session.sqlite",
  ".vtrace/config.json",
]);

// ── World ───────────────────────────────────────────────────────────

export interface SyntheticWorld {
  readonly canonicalTrackedSourceDigest: string;
  readonly digestBeforeTreatment: string;
  readonly digestAfterTreatment: string;
  readonly headAtAgentStart: string | null;
  readonly treatmentRoute: TreatmentStateRoute;
  readonly treatmentInitialises: boolean;
  readonly treatmentInitFailureCategory: string | null;
  readonly exposedTreatmentToolIds: readonly string[];
  readonly nativeToolNames: readonly string[];
  readonly agentVersion: string;
  readonly userPromptTemplate: string;
  readonly systemPromptAppendix: string | null;
  readonly extraEnvironment: Readonly<Record<string, string>>;
  readonly extraWorkspaceEntries: readonly string[];
  readonly injectedContextDocuments: readonly string[];
  readonly goldArtifactsInAgentContext: readonly string[];
  readonly daemonSocketsReachable: readonly string[];
  readonly resetPreservedPaths: readonly string[];
  readonly treatmentStateInheritedFromPreviousRun: readonly string[];
  readonly untrackedSourceAffectingPaths: readonly string[];
  /** Tracked source files the agent edits during its run. */
  readonly agentEditedSourcePaths: readonly string[];
  readonly providerModelIdentity: string | null;
  readonly agentFailureCategory: string | null;
  readonly treatmentInvocations: number;
  readonly treatmentInvokedBeforeFirstEdit: boolean;
  readonly costUsd: number;
  readonly turnCount: number;
  readonly terminationReason: AgentRunOutcome["terminationReason"];
  readonly evaluatorRan: boolean;
  readonly evaluatorExitStatus: number;
  readonly resolved: boolean;
  /** Use the pre-repair vendor capture rule, for §54's historical control. */
  readonly useLegacyVendorPatchCapture: boolean;
}

export const SYNTHETIC_CANONICAL_DIGEST =
  createHash("sha256").update("m215-synthetic-canonical-source").digest("hex");

export function syntheticWorld(overrides: Partial<SyntheticWorld> = {}): SyntheticWorld {
  return {
    canonicalTrackedSourceDigest: SYNTHETIC_CANONICAL_DIGEST,
    digestBeforeTreatment: SYNTHETIC_CANONICAL_DIGEST,
    digestAfterTreatment: SYNTHETIC_CANONICAL_DIGEST,
    headAtAgentStart: null,
    treatmentRoute: "INDEX_ONLY_NO_GIT_EXCLUDE",
    treatmentInitialises: true,
    treatmentInitFailureCategory: null,
    exposedTreatmentToolIds: M214_VTRACE_TREATMENT_CATALOG,
    nativeToolNames: M214_NATIVE_TOOLS,
    agentVersion: M214_AGENT.version,
    userPromptTemplate: M214_AGENT.userPromptText,
    systemPromptAppendix: null,
    extraEnvironment: {},
    extraWorkspaceEntries: [],
    injectedContextDocuments: [],
    goldArtifactsInAgentContext: [],
    daemonSocketsReachable: [],
    resetPreservedPaths: [],
    treatmentStateInheritedFromPreviousRun: [],
    untrackedSourceAffectingPaths: [],
    agentEditedSourcePaths: ["pkg/core.py"],
    providerModelIdentity: null,
    agentFailureCategory: null,
    treatmentInvocations: 3,
    treatmentInvokedBeforeFirstEdit: true,
    costUsd: 0.42,
    turnCount: 17,
    terminationReason: "AGENT_COMPLETED",
    evaluatorRan: true,
    evaluatorExitStatus: 0,
    resolved: true,
    useLegacyVendorPatchCapture: false,
    ...overrides,
  };
}

// ── Container ───────────────────────────────────────────────────────

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export class SyntheticContainerAdapter implements ContainerAdapter {
  readonly started: string[] = [];
  readonly stopped: string[] = [];

  /**
   * Per-run state, reset by `start`.
   *
   * The adapter is deliberately reusable across rows so the resume and
   * exactly-once controls can drive many rows through one instance; that only
   * works if nothing leaks between runs, which is the same property the real
   * container must have.
   */
  private row: RunManifestRow | undefined;
  private digestCalls = 0;

  constructor(private readonly world: SyntheticWorld) {}

  /** Treatment files present on disk once the arm's treatment has initialised. */
  private treatmentFiles(row: RunManifestRow): readonly string[] {
    if (armDefinition(row.arm).treatmentStatePaths.length === 0) return [];
    if (!this.world.treatmentInitialises) return [];
    return SYNTHETIC_TREATMENT_FILES;
  }

  /** What `git ls-files --others --exclude-standard` would enumerate. */
  private enumerableUntracked(row: RunManifestRow): readonly string[] {
    if (this.world.treatmentRoute === "INIT_WRITES_GIT_EXCLUDE") return [];
    return this.treatmentFiles(row).length > 0 ? [".vtrace"] : [];
  }

  async start(row: RunManifestRow): Promise<ContainerHandle> {
    this.started.push(row.runId);
    this.row = row;
    this.digestCalls = 0;
    return {
      image: row.containerImage,
      imageDigest: createHash("sha256").update(row.containerImage).digest("hex"),
      workingDirectory: `/testbed/${row.instanceId}`,
      dependencyEnvironment: `conda:testbed:${row.repo}`,
    };
  }

  async resetToBaseCommit(): Promise<void> {}

  /** First call is the pre-treatment digest, every later call the post-treatment one. */
  async trackedSourceDigest(): Promise<string> {
    this.digestCalls += 1;
    return this.digestCalls === 1
      ? this.world.digestBeforeTreatment
      : this.world.digestAfterTreatment;
  }

  async head(): Promise<string> {
    return this.world.headAtAgentStart ?? this.currentRow().baseCommit;
  }

  async untrackedPaths(): Promise<readonly string[]> {
    return this.enumerableUntracked(this.currentRow());
  }

  async untrackedSourceAffectingPaths(): Promise<readonly string[]> {
    return this.world.untrackedSourceAffectingPaths;
  }

  private currentRow(): RunManifestRow {
    if (this.row === undefined) throw new Error("synthetic container used before start()");
    return this.row;
  }

  async initialiseTreatment(_handle: ContainerHandle, row: RunManifestRow): Promise<TreatmentInitialisation> {
    this.row = row;
    return {
      initialised: this.world.treatmentInitialises,
      catalogSha256: this.world.treatmentInitialises
        ? treatmentCatalogSha256(this.world.exposedTreatmentToolIds)
        : null,
      exposedToolNames: this.world.exposedTreatmentToolIds.map((id) => mcpToolName("vtrace", id)),
      indexBuildSeconds: this.world.treatmentInitialises ? 12.5 : null,
      indexSizeBytes: this.world.treatmentInitialises ? 4_194_304 : null,
      failureCategory: this.world.treatmentInitFailureCategory,
    };
  }

  async inspectArmSurface(
    _handle: ContainerHandle, row: RunManifestRow,
  ): Promise<ArmSurfaceObservation> {
    this.row = row;
    const definition = armDefinition(row.arm);
    const treatmentToolNames = definition.treatmentToolCatalog.length === 0
      ? []
      : this.world.exposedTreatmentToolIds.map((id) => mcpToolName("vtrace", id));
    const workspace = ["src", "tests", "setup.py", ".git", ...this.world.extraWorkspaceEntries];
    if (this.treatmentFiles(row).length > 0) workspace.push(".vtrace");
    return {
      mcpServers: definition.mcpServers,
      modelVisibleToolNames: [...this.world.nativeToolNames, ...treatmentToolNames],
      nativeToolNames: this.world.nativeToolNames,
      environmentVariableNames: Object.keys({ PATH: "", HOME: "", LANG: "", ...this.world.extraEnvironment }),
      workspaceRootEntries: workspace,
      injectedContextDocuments: this.world.injectedContextDocuments,
      daemonSocketsReachable: this.world.daemonSocketsReachable,
      treatmentBinariesOnPath: [],
      systemPromptAppendix: this.world.systemPromptAppendix,
      userPromptTemplate: this.world.userPromptTemplate,
      agentVersion: this.world.agentVersion,
      canonicalTrackedSourceDigest: this.world.canonicalTrackedSourceDigest,
      goldArtifactsInAgentContext: this.world.goldArtifactsInAgentContext,
      environment: { PATH: "/usr/bin:/bin", HOME: "/root", LANG: "C.UTF-8", ...this.world.extraEnvironment },
      resetPreservedPaths: this.world.resetPreservedPaths,
      treatmentStateInheritedFromPreviousRun: this.world.treatmentStateInheritedFromPreviousRun,
      cpuLimit: "4 cpus",
      memoryLimit: "8g",
      networkPolicy: "egress: provider api only",
      systemPromptSha256: createHash("sha256").update(M214_AGENT.systemPrompt).digest("hex"),
    };
  }

  /**
   * Simulate `git diff HEAD` plus the untracked lane, filtered by a pathspec.
   *
   * Faithful to the mechanism rather than to its output text: what changes
   * between the derived rule and the legacy vendor rule is only the exclusion
   * set, which is exactly the variable §54's historical control needs to move.
   */
  async capturePatch(_handle: ContainerHandle, exclusions: readonly string[]): Promise<CapturedPatch> {
    const applied = this.world.useLegacyVendorPatchCapture
      ? LEGACY_VENDOR_PATCH_EXCLUSIONS
      : exclusions;
    const candidates = [
      ...this.world.agentEditedSourcePaths,
      ...(this.world.treatmentRoute === "INDEX_ONLY_NO_GIT_EXCLUDE"
        ? this.treatmentFiles(this.currentRow())
        : []),
    ];
    const paths = candidates
      .filter((path) => !applied.some((entry) => isUnder(path, entry)))
      .sort();
    const patch = paths
      .map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`)
      .join("");
    return { patch, paths, exclusions: applied };
  }

  /** M217 — a synthetic teardown reports clean; the synthetic probe decides residue. */
  async stop(handle: ContainerHandle): Promise<TeardownReport> {
    this.stopped.push(handle.workingDirectory);
    return {
      attempted: true, reported: true, containerRemoved: true, mountRemoved: true,
      armRootRemoved: true, errors: [],
    };
  }
}

// ── Agent ───────────────────────────────────────────────────────────

/**
 * A deterministic transcript, and the model-identity assertion armed on it.
 *
 * `assertProviderModelIdentity` is called at the top of the run, before any
 * telemetry is produced, which is what proves the gate fires before a run can
 * become an authoritative outcome rather than after it has cost something.
 */
export class SyntheticAgentAdapter implements AgentAdapter {
  readonly runs: string[] = [];

  constructor(private readonly world: SyntheticWorld) {}

  async run(spec: AgentRunSpec, hooks: AgentRunHooks): Promise<AgentRunOutcome> {
    this.runs.push(spec.attemptId);
    const identity = this.world.providerModelIdentity ?? spec.modelTarget;
    hooks.assertProviderModelIdentity(
      this.world.providerModelIdentity === "" ? null : identity,
    );

    const treatmentExposed = spec.mcpServers.includes("vtrace");
    const events: TelemetryEvent[] = [];
    let ordinal = 0;
    const push = (event: Omit<TelemetryEvent, "ordinal">): void => {
      events.push({ ordinal: ordinal++, ...event });
    };

    push({
      kind: "AGENT_INIT", turn: 0, name: "init", detail: `agent ${spec.agentVersion}`,
      outputBytes: 0, latencyMs: 0,
    });
    push({
      kind: "MODEL_IDENTITY", turn: 0, name: identity, detail: "provider init event",
      outputBytes: 0, latencyMs: 0,
    });

    const invocations = treatmentExposed ? this.world.treatmentInvocations : 0;
    if (this.world.treatmentInvokedBeforeFirstEdit) {
      for (let index = 0; index < invocations; index += 1) {
        push({
          kind: "TREATMENT_TOOL_CALL", turn: 1 + index,
          name: mcpToolName("vtrace", "get_code_context"),
          detail: "orientation", outputBytes: 4_096, latencyMs: 180,
        });
      }
    }
    push({
      kind: "NATIVE_TOOL_CALL", turn: 2, name: "Grep", detail: "search", outputBytes: 2_048, latencyMs: 40,
    });
    for (const path of this.world.agentEditedSourcePaths) {
      push({ kind: "EDIT", turn: 3, name: path, detail: "edit", outputBytes: 512, latencyMs: 20 });
    }
    if (!this.world.treatmentInvokedBeforeFirstEdit) {
      for (let index = 0; index < invocations; index += 1) {
        push({
          kind: "TREATMENT_TOOL_CALL", turn: 4 + index,
          name: mcpToolName("vtrace", "get_code_context"),
          detail: "orientation", outputBytes: 4_096, latencyMs: 180,
        });
      }
    }
    push({
      kind: "TERMINATION", turn: this.world.turnCount, name: this.world.terminationReason,
      detail: "run end", outputBytes: 0, latencyMs: 0,
    });

    return {
      providerModelIdentity: identity,
      telemetry: Object.freeze(events),
      turnCount: this.world.turnCount,
      inputTokens: 120_000,
      outputTokens: 8_400,
      cachedInputTokens: 96_000,
      costUsd: this.world.costUsd,
      wallClockSeconds: 214.5,
      terminationReason: this.world.terminationReason,
      failureCategory: this.world.agentFailureCategory,
    };
  }
}

// ── Evaluator ───────────────────────────────────────────────────────

export class SyntheticEvaluatorAdapter implements EvaluatorAdapter {
  constructor(private readonly world: SyntheticWorld) {}

  async evaluate(row: RunManifestRow, patch: string): Promise<EvaluationOutcome> {
    return {
      command: `python -m swebench.harness.run_evaluation --instance_ids ${row.instanceId}`,
      evaluatorIdentity: "swebench==4.1.0",
      exitStatus: this.world.evaluatorExitStatus,
      rawResult: JSON.stringify({
        instance_id: row.instanceId,
        resolved: this.world.resolved,
        patch_bytes: patch.length,
      }),
      // An empty patch cannot resolve, whatever the world declares: letting a
      // fixture assert resolution without a patch would hide a patch-capture
      // regression behind a hand-written outcome.
      resolved: this.world.evaluatorRan && this.world.resolved && patch.length > 0,
      evaluatorRan: this.world.evaluatorRan,
    };
  }
}

export interface SyntheticAdapters {
  readonly container: SyntheticContainerAdapter;
  readonly agent: SyntheticAgentAdapter;
  readonly evaluator: SyntheticEvaluatorAdapter;
}

export function syntheticAdapters(world: SyntheticWorld): SyntheticAdapters {
  return {
    container: new SyntheticContainerAdapter(world),
    agent: new SyntheticAgentAdapter(world),
    evaluator: new SyntheticEvaluatorAdapter(world),
  };
}

/** A monotonic clock, so a synthetic ledger is reproducible byte for byte. */
export function syntheticClock(start = Date.UTC(2026, 8, 4, 0, 0, 0)): () => string {
  let tick = 0;
  return () => new Date(start + tick++ * 1_000).toISOString();
}

export type { M214Arm };
