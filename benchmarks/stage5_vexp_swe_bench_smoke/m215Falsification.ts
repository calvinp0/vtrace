/**
 * M215 §53, §54 — the falsification suite for the launch executor.
 *
 * M214's suite falsified a DESIGN: it perturbed frozen documents and checked
 * that the auditors noticed. This one falsifies an EXECUTOR, so almost every
 * control runs the real `executeManifestRow` against synthetic adapters and
 * asks what the machine did, not what a checker said about a fixture.
 *
 * Two rules the suite holds itself to.
 *
 * Every control moves exactly ONE property of a world that is otherwise
 * compliant, and the F0 negative controls establish that the compliant world
 * really is silent — a suite of guards that fire on everything would look
 * identical to a suite that works.
 *
 * §54's historical controls are not tests of new code. They reproduce the two
 * defects M213 and M214 found — treatment metadata entering patch capture, and
 * an asymmetric warm/reset lifecycle — and require the OLD behaviour to fail a
 * control the M215 path passes. Without them the executor could quietly bypass
 * M214's repair and every other control would still be green.
 *
 * No control spends money and none touches a frozen task with a live model.
 */

import {
  M214_ARMS,
  M214_BUDGET,
  M214_EXCLUSIONS,
  M214_NATIVE_TOOLS,
  M214_VTRACE_TREATMENT_CATALOG,
  type M214Arm,
  type RunManifestRow,
  mcpToolName,
} from "./m214Preregistration";
import {
  EXTERNAL_VENDOR_REFERENCE,
  auditPairedComparison,
} from "./m214ExternalReference";
import {
  auditLifecycleOrder,
  auditResetPreservedPaths,
} from "./m214TreatmentLifecycle";
import { auditRun } from "./m214Falsification";
import {
  type ExecutionResult,
  type ExecutorDependencies,
  type FrozenAuthorities,
  type RowSelector,
  type SpendAuthorization,
  M215_AUTHORIZED_CEILING_USD,
  auditFrozenTreatmentTree,
  auditRuntimeGateCoverage,
  auditSerializedArtifactForSecrets,
  auditSpendAuthorization,
  auditSpendCeiling,
  canFinalizeCausalReport,
  executeManifestRow,
  observedConfigurationFrom,
  projectSpend,
  renderProgress,
  resolveManifestRow,
  retryPermitted,
  runCohort,
  selectNextRow,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import {
  type RunResultRecord,
  CohortLedger,
  resultDigest,
} from "./m215CohortLedger";
import {
  type SyntheticWorld,
  syntheticAdapters,
  syntheticClock,
  syntheticWorld,
} from "./m215Fixtures";

// ── Control shape ───────────────────────────────────────────────────

export interface M215Control {
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
): M215Control {
  const fired = issues.length > 0;
  return {
    id,
    description,
    expectation,
    fired,
    satisfied: expectation === "GUARD_FIRES" ? fired : !fired,
    detail: fired ? issues.join(" | ") : "no issue reported",
  };
}

export function suitePasses(controls: readonly M215Control[]): boolean {
  return controls.length > 0 && controls.every((entry) => entry.satisfied);
}

// ── Harness ─────────────────────────────────────────────────────────

export const SYNTHETIC_AUTHORIZATION: SpendAuthorization = Object.freeze({
  authorized: true,
  authorizedByOperator: "m215-falsification-suite (synthetic, no paid call is reachable)",
  authorizedCeilingUsd: M215_AUTHORIZED_CEILING_USD,
  authorizedAt: "2026-09-04T00:00:00.000Z",
  statement:
    "A SYNTHETIC-mode authorisation object, used only so the authorisation guard itself can be "
    + "exercised. SYNTHETIC mode reaches no provider and writes no authoritative cohort result.",
});

interface RunAttempt {
  readonly result: ExecutionResult | null;
  readonly error: Error | null;
}

/**
 * Run one row through the real executor against a synthetic world.
 *
 * `deps` is rebuilt every call so a control cannot accidentally inherit another
 * control's adapters; only the ledger is shared, because ordering and
 * exactly-once are properties OF the ledger.
 */
async function runRow(
  authorities: FrozenAuthorities,
  ledger: CohortLedger,
  world: SyntheticWorld,
  selector: RowSelector,
  overrides: Partial<ExecutorDependencies> = {},
): Promise<RunAttempt> {
  const adapters = syntheticAdapters(world);
  const deps: ExecutorDependencies = {
    mode: "SYNTHETIC",
    authorities,
    container: adapters.container,
    agent: adapters.agent,
    evaluator: adapters.evaluator,
    ledger,
    now: syntheticClock(),
    spendAuthorization: SYNTHETIC_AUTHORIZATION,
    ...overrides,
  };
  try {
    return { result: await executeManifestRow(deps, selector), error: null };
  } catch (error) {
    return { result: null, error: error as Error };
  }
}

/** Drive clean rows in frozen order up to (but excluding) one execution order. */
async function advanceTo(
  authorities: FrozenAuthorities,
  ledger: CohortLedger,
  executionOrder: number,
): Promise<void> {
  for (let ordinal = 0; ordinal < executionOrder; ordinal += 1) {
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: ordinal });
    if (attempt.error !== null) throw attempt.error;
  }
}

function freshLedger(authorities: FrozenAuthorities): CohortLedger {
  return new CohortLedger(
    "SYNTHETIC",
    authorities.preregistrationHash.actual,
    authorities.manifestHash.actual,
  );
}

/**
 * The refusal an attempt produced, or nothing if it was not refused.
 *
 * Deliberately returns EMPTY when the run was accepted, including when that
 * acceptance is itself the failure the control is looking for. A control that
 * reported "the executor accepted this" as an issue would be satisfied by
 * `GUARD_FIRES` whether the guard fired or not, which is a suite that cannot
 * fail — the exact defect this helper exists to make unexpressible.
 */
function attemptIssues(attempt: RunAttempt): readonly string[] {
  if (attempt.error !== null) return [attempt.error.message];
  const record = attempt.result!.record;
  if (record.validity.valid) return [];
  return [`${record.validity.infrastructureCategory}: ${record.validity.reason}`];
}

function rowFor(
  authorities: FrozenAuthorities, executionOrder: number,
): RunManifestRow {
  return resolveManifestRow(authorities.manifest, { executionOrder });
}

/** The first execution order whose row is the VTRACE arm and is first in its pair. */
export function firstVtraceLeadingOrder(manifest: readonly RunManifestRow[]): number {
  const row = [...manifest]
    .sort((left, right) => left.executionOrder - right.executionOrder)
    .find((candidate) => candidate.arm === "vtrace" && candidate.armOrderIndex === 0);
  if (row === undefined) throw new Error("no vtrace-leading row in the frozen manifest");
  return row.executionOrder;
}

// ── The suite ───────────────────────────────────────────────────────

export interface M215SuiteInputs {
  readonly authorities: FrozenAuthorities;
  readonly preregistrationDocument: Record<string, unknown>;
  readonly manifestDocument: { rows: RunManifestRow[]; manifestHash?: string };
  readonly externalReferenceDocument: Record<string, unknown>;
  readonly observedVtraceProductTreeSha: string;
}

export async function runM215FalsificationSuite(
  input: M215SuiteInputs,
): Promise<readonly M215Control[]> {
  const { authorities } = input;
  const controls: M215Control[] = [];
  const vtraceLead = firstVtraceLeadingOrder(authorities.manifest);

  // ── F0 — negative controls ────────────────────────────────────────
  // A guard that fires on a compliant run is not a guard, so the compliant run
  // is established first and every later control moves one property from it.

  for (const arm of M214_ARMS) {
    const ledger = freshLedger(authorities);
    const order = arm === "baseline" ? 0 : vtraceLead;
    await advanceTo(authorities, ledger, order);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: order });
    controls.push(control(
      `F0_CLEAN_${arm.toUpperCase()}`,
      `a fully compliant ${arm} run reaches a valid outcome with every required gate asserted`,
      "GUARD_SILENT",
      [
        ...attemptIssues(attempt),
        ...(attempt.result === null
          ? ["no result produced"]
          : auditRuntimeGateCoverage(attempt.result.record.runtimeGates)),
      ],
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    const record = attempt.result!.record;
    controls.push(control(
      "F0_CLEAN_AUDIT_RUN",
      "M214's own per-run auditor is silent on the executor's observed configuration",
      "GUARD_SILENT",
      auditRun(
        {
          instanceId: record.instanceId,
          arm: record.arm,
          agentVersion: record.agent.version,
          model: record.modelTarget,
          vtraceCommit: record.vtraceCommit ?? "",
          vtraceProductTreeSha: record.vtraceProductTreeSha ?? "",
          baseCommit: record.sourceState.baseCommit,
          canonicalTrackedSourceDigest: record.sourceState.canonicalTrackedSourceDigest,
        },
        observedConfigurationFrom(
          rowFor(authorities, 0),
          await syntheticAdapters(syntheticWorld()).container.inspectArmSurface(
            { image: "", imageDigest: "", workingDirectory: "", dependencyEnvironment: "" },
            rowFor(authorities, 0),
          ),
          record.sourceState.headAtAgentStart,
          record.sourceState.canonicalTrackedSourceDigest,
          record.treatment.invocationCount,
        ),
      ),
    ));
  }

  // ── F1–F3 — frozen authority mutation ─────────────────────────────

  {
    const mutated = { ...input.preregistrationDocument, benchmarkName: "VTRACE_EXTERNAL_VEXP_101" };
    const authoritiesM = verifyFrozenAuthorities(
      mutated, input.manifestDocument, input.externalReferenceDocument,
    );
    const ledger = freshLedger(authoritiesM);
    const attempt = await runRow(authoritiesM, ledger, syntheticWorld(), { executionOrder: 0 });
    controls.push(control(
      "F1_PREREGISTRATION_MUTATION",
      "one altered preregistration field refuses the launch before any container starts",
      "GUARD_FIRES",
      [...authoritiesM.issues, ...attemptIssues(attempt)],
    ));
  }

  {
    const rows = input.manifestDocument.rows.map((row, index) =>
      index === 7 ? { ...row, maxTurns: row.maxTurns + 1 } : row);
    const authoritiesM = verifyFrozenAuthorities(
      input.preregistrationDocument, { rows }, input.externalReferenceDocument,
    );
    const ledger = freshLedger(authoritiesM);
    const attempt = await runRow(authoritiesM, ledger, syntheticWorld(), { executionOrder: 0 });
    controls.push(control(
      "F2_MANIFEST_MUTATION",
      "one altered manifest row refuses the launch of every row, not only that one",
      "GUARD_FIRES",
      [...authoritiesM.issues, ...attemptIssues(attempt)],
    ));
  }

  {
    const mutated = { ...input.externalReferenceDocument, externalReferenceHash: "0".repeat(64) };
    const authoritiesM = verifyFrozenAuthorities(
      input.preregistrationDocument, input.manifestDocument, mutated,
    );
    const ledger = freshLedger(authoritiesM);
    const attempt = await runRow(authoritiesM, ledger, syntheticWorld(), { executionOrder: 0 });
    controls.push(control(
      "F3_EXTERNAL_REFERENCE_MUTATION",
      "the external reference is part of experiment identity: altering it fails the launch, while "
      + "never influencing execution",
      "GUARD_FIRES",
      [...authoritiesM.issues, ...attemptIssues(attempt)],
    ));
  }

  // ── F4, F5 — arm and task admissibility ───────────────────────────

  {
    const issues: string[] = [];
    try {
      resolveManifestRow(authorities.manifest, { instanceId: "astropy__astropy-14365", arm: "vexp" });
    } catch (error) {
      issues.push((error as Error).message);
    }
    controls.push(control(
      "F4_INVALID_ARM_VEXP",
      "arm=VEXP is refused: the vendor's published figure is an external reference, never an arm",
      "GUARD_FIRES",
      issues,
    ));
  }

  {
    const issues: string[] = [];
    try {
      resolveManifestRow(authorities.manifest, { instanceId: "not__a-real-task-1", arm: "baseline" });
    } catch (error) {
      issues.push((error as Error).message);
    }
    controls.push(control(
      "F5_TASK_OUTSIDE_MANIFEST",
      "a task outside the frozen 100 cannot be addressed by the executor",
      "GUARD_FIRES",
      issues,
    ));
  }

  // ── F6, F32 — provider model identity ─────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ providerModelIdentity: "claude-sonnet-4-5-20250929" }),
      { executionOrder: 0 },
    );
    const record = attempt.result?.record;
    controls.push(control(
      "F6_MODEL_MISMATCH",
      "a provider init event reporting another model rejects the run before it can be authoritative",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
    controls.push(control(
      "F6B_MODEL_MISMATCH_NOT_VALID",
      "the model-mismatched run is INFRASTRUCTURE_INVALID under MODEL_IDENTITY_DRIFT, not unresolved",
      "GUARD_SILENT",
      record !== undefined
        && record.validity.status === "INFRASTRUCTURE_INVALID"
        && record.validity.infrastructureCategory === "MODEL_IDENTITY_DRIFT"
        ? []
        : [`classification was ${record?.validity.status ?? "absent"}`],
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ providerModelIdentity: "" }), { executionOrder: 0 },
    );
    controls.push(control(
      "F32_PROVIDER_IDENTITY_ABSENT",
      "no authoritative model init event means the run cannot become a valid outcome; silence is "
      + "not confirmation",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  // ── F7, F8, F9 — agent, tools, prompt ─────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ agentVersion: "2.1.261" }), { executionOrder: 0 },
    );
    controls.push(control(
      "F7_AGENT_VERSION_MISMATCH",
      "a different agent version fails; 'close enough' is not a version match",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({ nativeToolNames: M214_NATIVE_TOOLS.filter((tool) => tool !== "Grep") }),
      { executionOrder: 0 },
    );
    controls.push(control(
      "F8_NATIVE_TOOL_DRIFT",
      "removing one native tool fails: both arms derive their catalogue from one authority",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({ userPromptTemplate: "Fix the bug. Use VTRACE first." }),
      { executionOrder: 0 },
    );
    controls.push(control(
      "F9_PROMPT_DRIFT",
      "a changed user prompt fails; neither arm carries a treatment instruction",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  // ── F10 — treatment identity drift ────────────────────────────────

  controls.push(control(
    "F10_TREATMENT_IDENTITY_DRIFT",
    "a VTRACE product tree other than the frozen HEAD:src identity fails the cohort",
    "GUARD_FIRES",
    auditFrozenTreatmentTree(authorities.manifest, "0".repeat(40)),
  ));

  controls.push(control(
    "F10B_TREATMENT_IDENTITY_FROZEN",
    "the observed product tree IS the frozen one, checked by tree identity rather than by "
    + "repository HEAD so harness commits do not mutate the treatment",
    "GUARD_SILENT",
    auditFrozenTreatmentTree(authorities.manifest, input.observedVtraceProductTreeSha),
  ));

  // ── F11, F12 — treatment catalogue and baseline contamination ─────

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({
        exposedTreatmentToolIds: M214_VTRACE_TREATMENT_CATALOG.filter(
          (tool) => tool !== "get_impact_graph",
        ),
      }),
      { executionOrder: vtraceLead },
    );
    controls.push(control(
      "F11_MISSING_TREATMENT_TOOL",
      "a VTRACE arm missing one frozen treatment tool fails: a null result on a narrowed treatment "
      + "would be unreadable",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({
        // One treatment tool injected into the baseline surface, which is the
        // realistic contamination: an MCP config left behind, not a rewritten arm.
        nativeToolNames: [...M214_NATIVE_TOOLS, mcpToolName("vtrace", "get_code_context")],
      }),
      { executionOrder: 0 },
    );
    controls.push(control(
      "F12_BASELINE_CONTAMINATION",
      "one VTRACE tool reachable from the baseline fails before the agent starts",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ extraEnvironment: { VTRACE_REPO_ROOT: "/testbed" } }),
      { executionOrder: 0 },
    );
    controls.push(control(
      "F12B_BASELINE_ENV_CONTAMINATION",
      "a VTRACE environment variable in the baseline fails; contamination is observable, not asserted away",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ daemonSocketsReachable: ["/run/vtrace.sock"] }),
      { executionOrder: 0 },
    );
    controls.push(control(
      "F12C_BASELINE_DAEMON_REACHABLE",
      "a reachable treatment daemon socket contaminates the baseline even with no tool configured",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  // ── F13 — source mutation before launch ───────────────────────────

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({ digestAfterTreatment: "f".repeat(64) }),
      { executionOrder: vtraceLead },
    );
    controls.push(control(
      "F13_SOURCE_MUTATED_BY_TREATMENT",
      "treatment initialisation that changes tracked source fails; indexing is observational",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ headAtAgentStart: "0".repeat(40) }),
      { executionOrder: 0 },
    );
    controls.push(control(
      "F13B_HEAD_NOT_BASE_COMMIT",
      "a HEAD that is not the frozen base commit fails before the agent starts",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  // ── F14, F15, F16 — patch capture ─────────────────────────────────

  for (const [id, route] of [
    ["F14_PATCH_INIT_ROUTE", "INIT_WRITES_GIT_EXCLUDE"],
    ["F15_PATCH_INDEX_ONLY_ROUTE", "INDEX_ONLY_NO_GIT_EXCLUDE"],
  ] as const) {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({ treatmentRoute: route, agentEditedSourcePaths: [] }),
      { executionOrder: vtraceLead },
    );
    const record = attempt.result?.record;
    const issues: string[] = [...attemptIssues(attempt)];
    if (record === undefined) {
      issues.push("no result produced");
    } else if (record.capturedPatchBytes !== 0 || record.capturedPatchPaths.length > 0) {
      issues.push(
        `captured ${record.capturedPatchBytes} bytes over `
        + `[${record.capturedPatchPaths.join(", ")}] with no source edit`,
      );
    }
    controls.push(control(
      id,
      `treatment state on the ${route} route, no source edit: the captured source patch is empty`,
      "GUARD_SILENT",
      issues,
    ));
  }

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({
        treatmentRoute: "INDEX_ONLY_NO_GIT_EXCLUDE",
        agentEditedSourcePaths: ["pkg/core.py"],
      }),
      { executionOrder: vtraceLead },
    );
    const record = attempt.result?.record;
    const paths = record?.capturedPatchPaths ?? [];
    controls.push(control(
      "F16_REAL_SOURCE_EDIT",
      "one edited source file is captured exactly, with treatment metadata excluded",
      "GUARD_SILENT",
      [
        ...attemptIssues(attempt),
        ...(paths.length === 1 && paths[0] === "pkg/core.py"
          ? []
          : [`captured [${paths.join(", ")}] rather than exactly pkg/core.py`]),
      ],
    ));
  }

  // ── F17, F18 — paired-run independence ────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    const record = attempt.result!.record;
    const surface = await syntheticAdapters(syntheticWorld()).container.inspectArmSurface(
      { image: "", imageDigest: "", workingDirectory: "", dependencyEnvironment: "" },
      rowFor(authorities, 0),
    );
    const expected = {
      instanceId: record.instanceId,
      arm: record.arm,
      agentVersion: record.agent.version,
      model: record.modelTarget,
      vtraceCommit: record.vtraceCommit ?? "",
      vtraceProductTreeSha: record.vtraceProductTreeSha ?? "",
      baseCommit: record.sourceState.baseCommit,
      canonicalTrackedSourceDigest: record.sourceState.canonicalTrackedSourceDigest,
    };
    const observed = observedConfigurationFrom(
      rowFor(authorities, 0), surface, record.sourceState.headAtAgentStart,
      record.sourceState.canonicalTrackedSourceDigest, 0,
    );
    controls.push(control(
      "F17_CONVERSATION_REUSE",
      "a run seeded from the paired arm's conversation fails",
      "GUARD_FIRES",
      auditRun(expected, { ...observed, conversationSeededFromRunId: "…:astropy__astropy-14365:vtrace" }),
    ));
    controls.push(control(
      "F18_PATCH_REUSE",
      "a run seeded from the paired arm's patch fails",
      "GUARD_FIRES",
      auditRun(expected, { ...observed, patchSeededFromRunId: "…:astropy__astropy-14365:vtrace" }),
    ));
    controls.push(control(
      "F18B_TREATMENT_RESULT_REUSE",
      "a run reusing the paired arm's treatment output fails",
      "GUARD_FIRES",
      auditRun(expected, { ...observed, treatmentResultSeededFromRunId: "…:vtrace" }),
    ));
  }

  // ── F19, F36 — execution order ────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const pairSecond = authorities.manifest.find((row) => row.armOrderIndex === 1)!;
    const attempt = await runRow(
      authorities, ledger, syntheticWorld(), { executionOrder: pairSecond.executionOrder },
    );
    controls.push(control(
      "F19_EXECUTION_ORDER_VIOLATION",
      "running a pair's second arm before its first is refused; the frozen order is not a choice",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, 4);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 40 });
    controls.push(control(
      "F36_OPERATOR_ROW_SELECTION",
      "an operator selecting a later manifest row while an earlier one is unfinished is refused",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, 6);
    const next = selectNextRow(authorities.manifest, ledger);
    controls.push(control(
      "F36B_SCHEDULER_PICKS_FROZEN_ORDER",
      "the scheduler, not the operator, picks the next row, and it picks the frozen next one",
      "GUARD_SILENT",
      next?.executionOrder === 6 ? [] : [`scheduler offered ${next?.executionOrder ?? "nothing"}`],
    ));
  }

  // ── F20 — exactly-once ────────────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const first = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    const duplicate = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    controls.push(control(
      "F20_DUPLICATE_VALID_OUTCOME",
      "a second valid completion of the same (instance, arm) is a cohort-integrity failure, not a "
      + "newer result",
      "GUARD_FIRES",
      duplicate.error !== null ? [duplicate.error.message] : [],
    ));
    controls.push(control(
      "F20B_ORIGINAL_OUTCOME_RETAINED",
      "the original outcome is still the only one in the ledger after the refusal",
      "GUARD_SILENT",
      ledger.entries.length === 1 && ledger.entries[0]!.attemptId === first.result!.record.attemptId
        ? []
        : [`ledger holds ${ledger.entries.length} entries`],
    ));
  }

  // ── F21, F22 — retry policy ───────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const failed = await runRow(
      authorities, ledger, syntheticWorld({ evaluatorRan: false, evaluatorExitStatus: 137 }),
      { executionOrder: 0 },
    );
    const firstEntry = ledger.entries[0]!;
    const decision = retryPermitted(firstEntry);
    const retry = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    controls.push(control(
      "F21_INFRASTRUCTURE_RETRY_PERMITTED",
      "a preregistered infrastructure failure may be retried, and the original attempt is retained",
      "GUARD_SILENT",
      [
        ...(decision.permitted ? [] : [`retry refused: ${decision.reason}`]),
        ...attemptIssues(retry),
        ...(ledger.entries.length === 2 ? [] : [`ledger holds ${ledger.entries.length} attempts`]),
        ...(ledger.entries[0]!.attemptId === failed.result!.record.attemptId
          ? [] : ["the original attempt record was replaced"]),
        ...(ledger.entries[0]!.attempt === 1 && ledger.entries[1]!.attempt === 2
          ? [] : ["attempt numbering did not advance"]),
      ],
    ));
  }

  {
    const ledger = freshLedger(authorities);
    await runRow(authorities, ledger, syntheticWorld({ resolved: false }), { executionOrder: 0 });
    const decision = retryPermitted(ledger.entries[0]!);
    const retry = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    // Both the policy and the executor must refuse. Either alone would leave the
    // other free to accept the rerun in some future call path.
    const bothRefused = !decision.permitted && retry.error !== null;
    controls.push(control(
      "F22_VALID_OUTCOME_RETRY_REFUSED",
      "a valid unresolved run is not retryable; a bad patch is not infrastructure",
      "GUARD_FIRES",
      bothRefused ? [decision.reason, retry.error!.message] : [],
    ));
  }

  {
    const invented = "OUTCOME_WAS_INCONVENIENT";
    controls.push(control(
      "F22B_INVENTED_EXCLUSION_CATEGORY",
      "an exclusion category outside M214's frozen list cannot be used to invalidate a run",
      "GUARD_FIRES",
      (M214_EXCLUSIONS.legitimate as readonly string[]).includes(invented)
        ? []
        : [`${invented} is not one of the ${M214_EXCLUSIONS.legitimate.length} frozen categories`],
    ));
  }

  // ── F23 — fixed-N finalisation ────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, 100);
    const decision = canFinalizeCausalReport(authorities.manifest, ledger, "COHORT");
    controls.push(control(
      "F23_EARLY_FINAL_ANALYSIS",
      "a cohort at 50% refuses to produce a final causal report",
      "GUARD_FIRES",
      decision.permitted ? [] : decision.reasons,
    ));
    controls.push(control(
      "F23B_SYNTHETIC_NEVER_FINAL",
      "a SYNTHETIC ledger can never produce a final causal report, complete or not",
      "GUARD_FIRES",
      canFinalizeCausalReport(authorities.manifest, ledger, "SYNTHETIC").reasons,
    ));
  }

  // ── F24, F25 — treatment usage and initialisation ─────────────────

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ treatmentInvocations: 0 }),
      { executionOrder: vtraceLead },
    );
    const record = attempt.result?.record;
    controls.push(control(
      "F24_TREATMENT_EXPOSED_NEVER_USED",
      "a treatment-exposed run the agent never invoked is a VALID intention-to-treat outcome",
      "GUARD_SILENT",
      [
        ...attemptIssues(attempt),
        ...(record?.validity.valid === true ? [] : ["the run was not valid"]),
        ...(record?.treatment.exposed === true && record.treatment.invocationCount === 0
          ? [] : ["treatment telemetry did not record exposed-but-unused"]),
      ],
    ));
  }

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({
        treatmentInitialises: false,
        treatmentInitFailureCategory: "TREATMENT_INITIALISATION_FAILURE",
      }),
      { executionOrder: vtraceLead },
    );
    const record = attempt.result?.record;
    controls.push(control(
      "F25_TREATMENT_INITIALISATION_FAILURE",
      "a treatment that fails to initialise is classified under the frozen category, not silently run",
      "GUARD_SILENT",
      record?.validity.infrastructureCategory === "TREATMENT_INITIALISATION_FAILURE"
        ? []
        : [`classified as ${record?.validity.infrastructureCategory ?? "nothing"}`],
    ));
  }

  // ── F26 — gold leakage ────────────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({ goldArtifactsInAgentContext: ["/testbed/.gold/patch.diff"] }),
      { executionOrder: 0 },
    );
    controls.push(control(
      "F26_GOLD_LEAKAGE",
      "a gold patch reachable from the agent's context fails preflight before the model is called",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  // ── F27, F28 — spend ──────────────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    // Two rows at an implausibly high per-run cost bring the running total to the
    // authorised ceiling; the guard must refuse the next call rather than the
    // call after it overspends.
    await runRow(authorities, ledger, syntheticWorld({ costUsd: 350 }), { executionOrder: 0 });
    await runRow(authorities, ledger, syntheticWorld({ costUsd: 349 }), { executionOrder: 1 });
    const projection = projectSpend(ledger, authorities.manifest);
    controls.push(control(
      "F27_SPEND_CEILING",
      "with cumulative spend near the frozen ceiling, the next model call is refused",
      "GUARD_FIRES",
      auditSpendCeiling(ledger),
    ));
    controls.push(control(
      "F27B_PROJECTION_BINDS_NOT_TOTAL",
      "the ceiling binds on the projected maximum, not on what has already been spent",
      "GUARD_SILENT",
      projection.projectedMaximumUsd > projection.cumulativeUsd && !projection.withinCeiling
        ? []
        : ["the projection did not exceed the running total"],
    ));
  }

  controls.push(control(
    "F28_NO_SPEND_AUTHORIZATION",
    "a COHORT launch without explicit operator spend authorisation is refused",
    "GUARD_FIRES",
    auditSpendAuthorization(null, "COHORT"),
  ));

  controls.push(control(
    "F28B_AUTHORIZATION_CEILING_MUST_MATCH",
    "an authorisation for a different ceiling than the frozen one is refused",
    "GUARD_FIRES",
    auditSpendAuthorization(
      { ...SYNTHETIC_AUTHORIZATION, authorizedCeilingUsd: 2_000 }, "COHORT",
    ),
  ));

  {
    const ledger = new CohortLedger(
      "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
    );
    const adapters = syntheticAdapters(syntheticWorld());
    let error: Error | null = null;
    try {
      await executeManifestRow({
        mode: "COHORT",
        authorities,
        container: adapters.container,
        agent: adapters.agent,
        evaluator: adapters.evaluator,
        ledger,
        now: syntheticClock(),
        spendAuthorization: null,
      }, { executionOrder: 0 });
    } catch (caught) {
      error = caught as Error;
    }
    controls.push(control(
      "F28C_UNAUTHORIZED_COHORT_LAUNCH_REFUSED",
      "the executor refuses an unauthorised COHORT row before starting a container",
      "GUARD_FIRES",
      error !== null && adapters.container.started.length === 0 ? [error.message] : [],
    ));
  }

  // ── F29 — synthetic mode isolation ────────────────────────────────

  {
    const synthetic = freshLedger(authorities);
    await runRow(authorities, synthetic, syntheticWorld(), { executionOrder: 0 });
    const syntheticRecord = synthetic.records[0]!;
    const cohort = new CohortLedger(
      "COHORT", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
    );
    let error: Error | null = null;
    try {
      cohort.append(syntheticRecord, "2026-09-04T00:00:00.000Z");
    } catch (caught) {
      error = caught as Error;
    }
    controls.push(control(
      "F29_SYNTHETIC_MODE_ISOLATION",
      "a SYNTHETIC result cannot be written into an authoritative cohort ledger",
      "GUARD_FIRES",
      error === null ? [] : [error.message],
    ));
  }

  // ── F30 — result immutability ─────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    const original = attempt.result!.record;
    const entry = attempt.result!.entry;
    const mutated: RunResultRecord = { ...original, costUsd: original.costUsd + 0.01 };
    const restored = CohortLedger.restore(
      "SYNTHETIC", ledger.preregistrationHash, ledger.manifestHash, [mutated], [entry],
    );
    controls.push(control(
      "F30_RESULT_MUTATION",
      "editing a completed result's bytes fails digest verification on replay",
      "GUARD_FIRES",
      [
        ...(resultDigest(mutated) === entry.resultDigest ? ["digest did not change"] : []),
        ...restored.issues,
      ],
    ));
    const correction = ledger.appendCorrection(
      original.attemptId, "container.imageDigest", "registry digest re-read after the run",
      "2026-09-04T01:00:00.000Z",
    );
    controls.push(control(
      "F30B_CORRECTION_IS_APPEND_ONLY",
      "metadata repair appends a correction and leaves the original outcome and its digest intact",
      "GUARD_SILENT",
      [
        ...(correction.originalResultDigest === entry.resultDigest
          ? [] : ["the correction did not retain the original digest"]),
        ...ledger.verifyIntegrity(),
      ],
    ));
  }

  // ── F31 — runtime gate omission ───────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    const gates = attempt.result!.record.runtimeGates;
    const without = gates.filter((gate) => gate.gateId !== "R6_SOURCE_STATE_EQUIVALENCE");
    controls.push(control(
      "F31_RUNTIME_GATE_OMISSION",
      "a required gate missing from the run's evidence fails coverage, even when every gate present "
      + "passes",
      "GUARD_FIRES",
      auditRuntimeGateCoverage(without),
    ));
    controls.push(control(
      "F31B_GATE_COVERAGE_COMPLETE",
      "a compliant run carries every required prelaunch and runtime gate",
      "GUARD_SILENT",
      auditRuntimeGateCoverage(gates),
    ));
  }

  // ── F33 — evaluator authority ─────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ evaluatorRan: false, evaluatorExitStatus: 1 }),
      { executionOrder: 0 },
    );
    const record = attempt.result?.record;
    controls.push(control(
      "F33_EVALUATION_FAILURE_IS_NOT_UNRESOLVED",
      "an evaluator that did not run yields EVALUATOR_INFRA_FAILURE, never an implied unresolved task",
      "GUARD_SILENT",
      record?.validity.infrastructureCategory === "EVALUATOR_INFRA_FAILURE"
        && record.validity.status === "INFRASTRUCTURE_INVALID"
        ? []
        : [`classified as ${record?.validity.status ?? "nothing"}`],
    ));
  }

  // ── F34 — budget symmetry ─────────────────────────────────────────

  {
    const rows = input.manifestDocument.rows.map((row) =>
      row.arm === "vtrace" ? { ...row, maxTurns: M214_BUDGET.maxTurns + 50 } : row);
    const authoritiesM = verifyFrozenAuthorities(
      input.preregistrationDocument, { rows }, input.externalReferenceDocument,
    );
    const ledger = freshLedger(authoritiesM);
    const attempt = await runRow(authoritiesM, ledger, syntheticWorld(), { executionOrder: 0 });
    controls.push(control(
      "F34_ARM_BUDGET_ASYMMETRY",
      "giving one arm extra turns fails; there is no per-arm budget field to express it in",
      "GUARD_FIRES",
      [...authoritiesM.issues, ...attemptIssues(attempt)],
    ));
  }

  // ── F35 — resume ──────────────────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const adapters = syntheticAdapters(syntheticWorld());
    const deps: ExecutorDependencies = {
      mode: "SYNTHETIC",
      authorities,
      container: adapters.container,
      agent: adapters.agent,
      evaluator: adapters.evaluator,
      ledger,
      now: syntheticClock(),
      spendAuthorization: SYNTHETIC_AUTHORIZATION,
    };
    const firstLeg = await runCohort(deps, { maxRows: 5 });

    // Persist and reload, exactly as an interrupted cohort would.
    const persisted = JSON.parse(JSON.stringify({
      records: ledger.records, entries: ledger.entries, corrections: ledger.corrections,
    })) as {
      records: RunResultRecord[];
      entries: (typeof ledger.entries)[number][];
      corrections: (typeof ledger.corrections)[number][];
    };
    const restored = CohortLedger.restore(
      "SYNTHETIC", ledger.preregistrationHash, ledger.manifestHash,
      persisted.records, persisted.entries, persisted.corrections,
    );
    const secondAdapters = syntheticAdapters(syntheticWorld());
    const secondLeg = await runCohort({
      ...deps, ledger: restored.ledger, container: secondAdapters.container,
      agent: secondAdapters.agent, evaluator: secondAdapters.evaluator,
    }, { maxRows: 4 });

    const executedTwice = firstLeg.executed.filter((id) => secondLeg.executed.includes(id));
    const orders = restored.ledger.entries.map((entry) => entry.manifestRowOrdinal);
    controls.push(control(
      "F35_RESUME",
      "an interrupted cohort resumes at exactly the next frozen row, with no duplicates and no "
      + "reordering",
      "GUARD_SILENT",
      [
        ...restored.issues,
        ...(firstLeg.executed.length === 5 ? [] : [`first leg ran ${firstLeg.executed.length} rows`]),
        ...(secondLeg.executed.length === 4 ? [] : [`resumed leg ran ${secondLeg.executed.length} rows`]),
        ...(executedTwice.length === 0 ? [] : [`${executedTwice.length} attempts ran twice`]),
        ...(orders.join(",") === "0,1,2,3,4,5,6,7,8"
          ? [] : [`rows completed in order [${orders.join(",")}]`]),
        ...restored.ledger.verifyIntegrity(),
      ],
    ));
  }

  // ── F37 — secret handling ─────────────────────────────────────────

  {
    const secret = "M215-FAKE-CREDENTIAL-VALUE-0123456789";
    const world = syntheticWorld({ extraEnvironment: { ANTHROPIC_API_KEY: secret } });
    const ledger = freshLedger(authorities);
    const attempt = await runRow(authorities, ledger, world, { executionOrder: 0 });
    const record = attempt.result?.record;
    const serialized = JSON.stringify(record ?? {});
    controls.push(control(
      "F37_SECRET_LEAKAGE",
      "a credential in the run environment never reaches the persisted result; its name is recorded "
      + "and flagged, its value is not",
      "GUARD_SILENT",
      [
        ...attemptIssues(attempt),
        ...(serialized.includes(secret) ? ["the persisted result contains the credential"] : []),
        ...auditSerializedArtifactForSecrets(serialized, world.extraEnvironment),
        ...(record?.environment.redactedVariableNames.includes("ANTHROPIC_API_KEY")
          ? [] : ["the credential's name was not flagged as redacted"]),
      ],
    ));
    controls.push(control(
      "F37B_SECRET_SCANNER_DETECTS_A_LEAK",
      "the leak scanner is not vacuous: a value deliberately embedded in an artifact is detected",
      "GUARD_FIRES",
      auditSerializedArtifactForSecrets(
        `{"note":"${secret}"}`, { ANTHROPIC_API_KEY: secret },
      ),
    ));
  }

  // ── F38 — result arm mismatch ─────────────────────────────────────

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    const record = attempt.result!.record;
    const row = rowFor(authorities, 0);
    const claimed: M214Arm = record.arm === "baseline" ? "vtrace" : "baseline";
    const surface = await syntheticAdapters(syntheticWorld()).container.inspectArmSurface(
      { image: "", imageDigest: "", workingDirectory: "", dependencyEnvironment: "" }, row,
    );
    controls.push(control(
      "F38_RESULT_ARM_MISMATCH",
      "a result claiming an arm the manifest row does not assign fails",
      "GUARD_FIRES",
      auditRun(
        {
          instanceId: row.instanceId, arm: row.arm, agentVersion: record.agent.version,
          model: record.modelTarget, vtraceCommit: "", vtraceProductTreeSha: "",
          baseCommit: row.baseCommit,
          canonicalTrackedSourceDigest: record.sourceState.canonicalTrackedSourceDigest,
        },
        {
          ...observedConfigurationFrom(
            row, surface, record.sourceState.headAtAgentStart,
            record.sourceState.canonicalTrackedSourceDigest, 0,
          ),
          arm: claimed,
        },
      ),
    ));
  }

  // ── F39 — the external reference stays out of causal analysis ─────

  controls.push(control(
    "F39_EXTERNAL_VEXP_IN_PAIRED_ANALYSIS",
    "feeding the external vendor reference into the paired analyser is refused",
    "GUARD_FIRES",
    auditPairedComparison({
      left: "vtrace",
      right: "vexp",
      evidenceClasses: { vexp: EXTERNAL_VENDOR_REFERENCE },
    }),
  ));

  controls.push(control(
    "F39B_TWO_ARM_PAIRED_ANALYSIS_ADMITTED",
    "the two executed arms remain a legitimate paired comparison",
    "GUARD_SILENT",
    auditPairedComparison({ left: "baseline", right: "vtrace" }),
  ));

  // ── F40 — treatment metadata lifecycle ────────────────────────────

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger, syntheticWorld({ resetPreservedPaths: [".vtrace"] }),
      { executionOrder: vtraceLead },
    );
    controls.push(control(
      "F40_RESET_PRESERVES_TREATMENT_STATE",
      "a reset that preserves treatment state under the frozen COLD_UNIFORM policy fails",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({ treatmentStateInheritedFromPreviousRun: [".vtrace/index.sqlite"] }),
      { executionOrder: vtraceLead },
    );
    controls.push(control(
      "F40B_WARM_STATE_INHERITED",
      "treatment state inherited from a previous run fails the frozen cold policy",
      "GUARD_FIRES",
      attemptIssues(attempt),
    ));
  }

  // ── §54 — historical defect controls ──────────────────────────────
  // These do not test new code. They reproduce the two defects M213 and M214
  // found and require the OLD behaviour to fail a control the M215 path passes,
  // so the executor cannot quietly bypass M214's repair.

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, vtraceLead);
    const attempt = await runRow(
      authorities, ledger,
      syntheticWorld({
        treatmentRoute: "INDEX_ONLY_NO_GIT_EXCLUDE",
        agentEditedSourcePaths: [],
        useLegacyVendorPatchCapture: true,
      }),
      { executionOrder: vtraceLead },
    );
    const record = attempt.result?.record;
    controls.push(control(
      "H1_LEGACY_PATCH_CAPTURE_LEAKS_TREATMENT_STATE",
      "the pre-repair vendor rule (hardcoded vendor pathspec) captures treatment metadata as agent "
      + "output on the index-only route, and the executor rejects that run",
      "GUARD_FIRES",
      [
        ...attemptIssues(attempt),
        ...(record?.validity.infrastructureCategory === "PATCH_EXTRACTION_FAILURE"
          ? [] : ["the legacy capture was not classified as a patch-extraction failure"]),
      ],
    ));
  }

  controls.push(control(
    "H2_TREATMENT_METADATA_WARM_ASYMMETRY",
    "the pre-repair reset rule, which preserved the vendor's own state directory across runs, "
    + "fails the frozen cold policy",
    "GUARD_FIRES",
    auditResetPreservedPaths([".vexp"], [".vtrace", ".vexp"]),
  ));

  controls.push(control(
    "H3_SNAPSHOT_BEFORE_TREATMENT_INITIALISATION",
    "taking the pre-agent untracked snapshot before treatment initialisation reintroduces the leak "
    + "by ordering rather than by pathspec, and the lifecycle audit names it",
    "GUARD_FIRES",
    auditLifecycleOrder([
      "CONTAINER_START", "SOURCE_CHECKOUT_AT_BASE_COMMIT", "SOURCE_STATE_DIGEST_BEFORE_TREATMENT",
      "PRE_AGENT_UNTRACKED_SNAPSHOT", "TREATMENT_INITIALISATION",
      "SOURCE_STATE_DIGEST_AFTER_TREATMENT", "AGENT_RUN", "PATCH_CAPTURE", "EVALUATION",
    ]),
  ));

  {
    const ledger = freshLedger(authorities);
    const attempt = await runRow(authorities, ledger, syntheticWorld(), { executionOrder: 0 });
    controls.push(control(
      "H3B_EXECUTOR_USES_THE_REPAIRED_ORDER",
      "the executor's own observed lifecycle takes the snapshot AFTER treatment initialisation",
      "GUARD_SILENT",
      auditLifecycleOrder(attempt.result!.record.lifecyclePhasesObserved),
    ));
  }

  // ── Operational monitoring (§37, §38) ─────────────────────────────

  {
    const ledger = freshLedger(authorities);
    await advanceTo(authorities, ledger, 6);
    const progress = renderProgress(authorities.manifest, ledger, null);
    const outcomeShaped = Object.keys(progress).filter((key) =>
      /win|passRate|resolvedCount|pValue|mcnemar|discordant|byArm|baselineResolved|vtraceResolved/i
        .test(key));
    controls.push(control(
      "F38C_OUTCOME_BLIND_DASHBOARD",
      "the operational dashboard exposes completion, spend and infrastructure health, and cannot "
      + "answer which arm is ahead",
      "GUARD_SILENT",
      outcomeShaped.length === 0
        ? []
        : [`progress exposes outcome-shaped fields: ${outcomeShaped.join(", ")}`],
    ));
  }

  return Object.freeze(controls);
}
