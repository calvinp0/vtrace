/**
 * M215 §6–§22, §28–§33, §47 — the executor's enforcement, unit by unit.
 *
 * The falsification suite runs whole rows and asks what the machine did; these
 * tests pin the individual rules so a failure says which one broke rather than
 * "a run was refused". Both are needed: the suite would still pass if two
 * guards were wrong in compensating ways.
 *
 * Nothing here contacts a provider, starts a container or reads a frozen task
 * with a live model.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_AGENT,
  M214_BUDGET,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_VTRACE_TREATMENT_CATALOG,
  type RunManifestRow,
  budgetIdentity,
  mcpToolName,
} from "./m214Preregistration";
import {
  type FrozenAuthorities,
  LEGACY_VENDOR_PATCH_EXCLUSIONS,
  M215_AUTHORIZED_CEILING_USD,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_FROZEN_MANIFEST_HASH,
  M215_FROZEN_PREREGISTRATION_HASH,
  M215_FROZEN_EXTERNAL_REFERENCE_HASH,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  M215_REQUIRED_RUNTIME_GATE_IDS,
  assertExecutableArm,
  auditAgentIdentity,
  auditCapturedPatch,
  auditFrozenTreatmentTree,
  auditNativeToolEquality,
  auditProviderModelIdentity,
  auditRowBudget,
  auditRuntimeGateCoverage,
  auditRuntimeOverrides,
  auditSerializedArtifactForSecrets,
  auditSpendAuthorization,
  auditSpendCeiling,
  auditTreatmentCatalogue,
  canFinalizeCausalReport,
  derivedPatchExclusions,
  derivedPatchPathspec,
  executeManifestRow,
  projectSpend,
  recomputePreregistrationHash,
  redactEnvironmentSnapshot,
  renderProgress,
  resolveManifestRow,
  selectNextRow,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { CohortLedger, gateRecord } from "./m215CohortLedger";
import { SYNTHETIC_AUTHORIZATION, firstVtraceLeadingOrder } from "./m215Falsification";
import { syntheticAdapters, syntheticClock, syntheticWorld } from "./m215Fixtures";
import { parseLaunchArgs } from "./run_stage5_m215_launch";

const RESULTS_DIR = join(import.meta.dir, "results");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

const preregistrationDocument = readJson(M215_PREREGISTRATION_FILE);
const manifestDocument = readJson(M215_MANIFEST_FILE) as unknown as {
  rows: RunManifestRow[]; manifestHash: string;
};
const externalReferenceDocument = readJson(M215_EXTERNAL_REFERENCE_FILE);

const authorities: FrozenAuthorities = verifyFrozenAuthorities(
  preregistrationDocument, manifestDocument, externalReferenceDocument,
);

function ledger(): CohortLedger {
  return new CohortLedger(
    "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
  );
}

function deps(book: CohortLedger, world = syntheticWorld()) {
  const adapters = syntheticAdapters(world);
  return {
    mode: "SYNTHETIC" as const,
    authorities,
    container: adapters.container,
    agent: adapters.agent,
    evaluator: adapters.evaluator,
    ledger: book,
    now: syntheticClock(),
    spendAuthorization: SYNTHETIC_AUTHORIZATION,
  };
}

describe("frozen authorities", () => {
  test("all three recompute to the digests M214 froze", () => {
    expect(authorities.preregistrationHash.actual).toBe(M215_FROZEN_PREREGISTRATION_HASH);
    expect(authorities.manifestHash.actual).toBe(M215_FROZEN_MANIFEST_HASH);
    expect(authorities.externalReferenceHash.actual).toBe(M215_FROZEN_EXTERNAL_REFERENCE_HASH);
    expect(authorities.verified).toBe(true);
    expect(authorities.issues).toEqual([]);
  });

  test("the manifest is exactly 200 planned rows over 100 tasks and two arms", () => {
    expect(authorities.manifest).toHaveLength(200);
    expect(new Set(authorities.manifest.map((row) => row.instanceId)).size).toBe(100);
    expect(new Set(authorities.manifest.map((row) => row.arm))).toEqual(
      new Set(["baseline", "vtrace"]),
    );
    expect(authorities.manifest.every((row) => row.status === "PLANNED")).toBe(true);
  });

  test("one changed byte changes the preregistration digest", () => {
    const mutated = { ...preregistrationDocument, benchmarkName: "SOMETHING_ELSE" };
    expect(recomputePreregistrationHash(mutated)).not.toBe(M215_FROZEN_PREREGISTRATION_HASH);
  });

  test("a mutated authority fails closed rather than being blessed", () => {
    const mutated = verifyFrozenAuthorities(
      { ...preregistrationDocument, arms: "tampered" }, manifestDocument, externalReferenceDocument,
    );
    expect(mutated.verified).toBe(false);
    expect(mutated.issues.length).toBeGreaterThan(0);
  });
});

describe("arm admissibility", () => {
  test("the executable arms are exactly baseline and vtrace", () => {
    expect(() => assertExecutableArm("baseline")).not.toThrow();
    expect(() => assertExecutableArm("vtrace")).not.toThrow();
    expect(() => assertExecutableArm("vexp")).toThrow(/EXTERNAL_VENDOR_REFERENCE/);
    expect(() => assertExecutableArm("VEXP")).toThrow(/not an executable arm/);
  });

  test("the frozen manifest contains no vendor row", () => {
    expect(authorities.manifest.some((row) => String(row.arm) === "vexp")).toBe(false);
  });
});

describe("row resolution", () => {
  test("a selector addresses a row and cannot supply one", () => {
    const row = resolveManifestRow(authorities.manifest, { executionOrder: 0 });
    expect(row.executionOrder).toBe(0);
    expect(row.maxTurns).toBe(M214_BUDGET.maxTurns);
    expect(row.model).toBe(M214_MODEL.model);
  });

  test("a task outside the frozen 100 cannot be addressed", () => {
    expect(() => resolveManifestRow(authorities.manifest, { instanceId: "made__up-1" }))
      .toThrow(/outside the frozen/);
  });

  test("an ambiguous selector is refused rather than resolved arbitrarily", () => {
    expect(() => resolveManifestRow(authorities.manifest, { arm: "baseline" }))
      .toThrow(/addressed uniquely/);
  });
});

describe("runtime overrides", () => {
  test("frozen properties are refused as runtime arguments", () => {
    expect(auditRuntimeOverrides({ model: "other" })).toHaveLength(1);
    expect(auditRuntimeOverrides({ maxTurns: 400, arm: "vtrace" })).toHaveLength(2);
    expect(auditRuntimeOverrides({ resultsDir: "/tmp" })).toEqual([]);
  });

  test("the launcher rejects a frozen-property flag by name", () => {
    expect(() => parseLaunchArgs(["--model", "claude-sonnet-5"])).toThrow(/frozen property 'model'/);
    expect(() => parseLaunchArgs(["--max-turns", "400"])).toThrow(/frozen property 'maxTurns'/);
    expect(() => parseLaunchArgs(["--arm", "vtrace"])).toThrow(/frozen property 'arm'/);
    expect(() => parseLaunchArgs(["--force-any-task"])).toThrow(/unknown argument/);
  });

  test("the launcher accepts only operational arguments", () => {
    const args = parseLaunchArgs(["--plan", "--binding", "SYNTHETIC", "--resume"]);
    expect(args.plan).toBe(true);
    expect(args.binding).toBe("SYNTHETIC");
    expect(args.resume).toBe(true);
    expect(args.authorizeSpend).toBeNull();
  });
});

describe("model identity", () => {
  test("the provider's own answer is required; silence is not confirmation", () => {
    expect(auditProviderModelIdentity(M214_MODEL.model)).toEqual([]);
    expect(auditProviderModelIdentity(null)).toHaveLength(1);
    expect(auditProviderModelIdentity("")).toHaveLength(1);
    expect(auditProviderModelIdentity("claude-sonnet-4-5-20250929")).toHaveLength(1);
  });

  test("the alias is not the identity", () => {
    expect(auditProviderModelIdentity(M214_MODEL.alias)).toHaveLength(1);
  });
});

describe("agent and tool identity", () => {
  test("an exact agent version is required", () => {
    expect(auditAgentIdentity(
      M214_AGENT.version, M214_AGENT.userPromptText, M214_NATIVE_TOOLS,
    )).toEqual([]);
    expect(auditAgentIdentity(
      "2.1.261", M214_AGENT.userPromptText, M214_NATIVE_TOOLS,
    )).toHaveLength(1);
  });

  test("both arms hash to one native-tool authority", () => {
    expect(auditNativeToolEquality(M214_NATIVE_TOOLS, M214_NATIVE_TOOLS)).toEqual([]);
    const narrowed = M214_NATIVE_TOOLS.filter((tool) => tool !== "Grep");
    expect(auditNativeToolEquality(narrowed, M214_NATIVE_TOOLS).length).toBeGreaterThan(0);
    // Two arms that drifted IDENTICALLY still fail: the comparison is against
    // the authority, not between the arms.
    expect(auditNativeToolEquality(narrowed, narrowed).length).toBeGreaterThan(0);
  });

  test("the treatment catalogue must be exactly the frozen one", () => {
    const exposed = M214_VTRACE_TREATMENT_CATALOG.map((id) => mcpToolName("vtrace", id));
    expect(auditTreatmentCatalogue("vtrace", exposed)).toEqual([]);
    expect(auditTreatmentCatalogue("vtrace", exposed.slice(1))).toHaveLength(1);
    expect(auditTreatmentCatalogue(
      "vtrace", [...exposed, mcpToolName("vtrace", "secret_debug_tool")],
    )).toHaveLength(1);
    expect(auditTreatmentCatalogue("baseline", [])).toEqual([]);
    expect(auditTreatmentCatalogue("baseline", [exposed[0]!])).toHaveLength(1);
  });
});

describe("budgets and spend", () => {
  test("every frozen row carries the one frozen budget", () => {
    for (const row of authorities.manifest) expect(auditRowBudget(row)).toEqual([]);
    expect(new Set(authorities.manifest.map((row) => row.budgetIdentity)))
      .toEqual(new Set([budgetIdentity()]));
  });

  test("a per-arm budget is refused", () => {
    const row = { ...authorities.manifest[0]!, maxTurns: 400 };
    expect(auditRowBudget(row).length).toBeGreaterThan(0);
  });

  test("the ceiling binds on the projection, not on the running total", () => {
    const book = ledger();
    const projection = projectSpend(book, authorities.manifest);
    expect(projection.cumulativeUsd).toBe(0);
    expect(projection.remainingRuns).toBe(200);
    expect(projection.projectedMaximumUsd).toBe(200 * M214_BUDGET.perRunCostCapUsd);
    expect(projection.ceilingUsd).toBe(M215_AUTHORIZED_CEILING_USD);
    expect(auditSpendCeiling(book)).toEqual([]);
  });

  test("authorisation is required, and must name the frozen ceiling", () => {
    expect(auditSpendAuthorization(null, "COHORT")).toHaveLength(1);
    expect(auditSpendAuthorization(null, "SYNTHETIC")).toEqual([]);
    expect(auditSpendAuthorization(SYNTHETIC_AUTHORIZATION, "COHORT")).toEqual([]);
    expect(auditSpendAuthorization(
      { ...SYNTHETIC_AUTHORIZATION, authorizedCeilingUsd: 1_000 }, "COHORT",
    )).toHaveLength(1);
    expect(auditSpendAuthorization(
      { ...SYNTHETIC_AUTHORIZATION, authorizedByOperator: "  " }, "COHORT",
    )).toHaveLength(1);
  });
});

describe("patch capture", () => {
  test("exclusions are derived from the snapshot, not from a vendor name", () => {
    expect(derivedPatchExclusions([".vtrace/", ".vtrace"])).toEqual([".vtrace"]);
    expect(derivedPatchPathspec([".vtrace"])).toBe("':(exclude).vtrace'");
    expect(derivedPatchExclusions([])).toEqual([]);
    expect(LEGACY_VENDOR_PATCH_EXCLUSIONS).toEqual([".vexp"]);
  });

  test("a captured patch containing excluded state fails", () => {
    expect(auditCapturedPatch(
      { patch: "", paths: ["pkg/core.py"], exclusions: [".vtrace"] }, [".vtrace"],
    )).toEqual([]);
    expect(auditCapturedPatch(
      { patch: "", paths: [".vtrace/index.sqlite"], exclusions: [".vtrace"] }, [".vtrace"],
    )).toHaveLength(1);
  });

  test("the legacy vendor exclusion set omits the derived one", () => {
    expect(auditCapturedPatch(
      { patch: "", paths: [".vtrace/index.sqlite"], exclusions: LEGACY_VENDOR_PATCH_EXCLUSIONS },
      [".vtrace"],
    ).length).toBeGreaterThan(0);
  });
});

describe("secrets", () => {
  test("the snapshot records names and never values", () => {
    const snapshot = redactEnvironmentSnapshot(
      { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-ant-fake-0123456789", HOME: "/root" },
      { cpuLimit: "4", memoryLimit: "8g", networkPolicy: "none" },
    );
    expect(snapshot.environmentVariableNames).toContain("ANTHROPIC_API_KEY");
    expect(snapshot.redactedVariableNames).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(snapshot)).not.toContain("sk-ant-fake-0123456789");
    expect(snapshot.pathEntries).toEqual(["/usr/bin", "/bin"]);
  });

  test("the leak scanner detects a value that reached an artifact", () => {
    const environment = { ANTHROPIC_API_KEY: "sk-ant-fake-0123456789" };
    expect(auditSerializedArtifactForSecrets('{"a":1}', environment)).toEqual([]);
    expect(auditSerializedArtifactForSecrets(
      '{"a":"sk-ant-fake-0123456789"}', environment,
    )).toHaveLength(1);
  });
});

describe("gate coverage", () => {
  test("a table missing a required gate fails even when every present gate passes", () => {
    const full = [...M215_REQUIRED_RUNTIME_GATE_IDS].map(
      (id) => gateRecord(id, "RUNTIME", true, [], "evidence"),
    );
    const prelaunch = ["P1_PREREGISTRATION_HASH", "P2_MANIFEST_HASH", "P3_EXTERNAL_REFERENCE_HASH",
      "P4_ROW_IS_FROZEN", "P5_NO_RUNTIME_OVERRIDES", "P6_EXECUTION_ORDER", "P7_SPEND_AUTHORIZATION",
      "P8_SPEND_CEILING", "P9_LEDGER_INTEGRITY", "P10_CONTINUATION_SAFETY"]
      .map((id) => gateRecord(id, "PREREGISTRATION", true, [], "evidence"));
    expect(auditRuntimeGateCoverage([...prelaunch, ...full])).toEqual([]);
    expect(auditRuntimeGateCoverage([...prelaunch, ...full.slice(1)])).toHaveLength(1);
  });
});

describe("execution", () => {
  test("a compliant row produces a valid outcome with every gate asserted", async () => {
    const book = ledger();
    const { record } = await executeManifestRow(deps(book), { executionOrder: 0 });
    expect(record.validity.status).toBe("VALID_RESOLVED");
    expect(record.mode).toBe("SYNTHETIC");
    expect(record.modelIdentityVerified).toBe(true);
    expect(record.providerModelIdentity).toBe(M214_MODEL.model);
    expect(auditRuntimeGateCoverage(record.runtimeGates)).toEqual([]);
    expect(record.lifecyclePhasesObserved).toEqual([
      "CONTAINER_START", "SOURCE_CHECKOUT_AT_BASE_COMMIT", "SOURCE_STATE_DIGEST_BEFORE_TREATMENT",
      "TREATMENT_INITIALISATION", "SOURCE_STATE_DIGEST_AFTER_TREATMENT",
      "PRE_AGENT_UNTRACKED_SNAPSHOT", "AGENT_RUN", "PATCH_CAPTURE", "EVALUATION",
    ]);
  });

  test("the vtrace arm exposes the treatment and excludes its metadata from the patch", async () => {
    const book = ledger();
    const lead = firstVtraceLeadingOrder(authorities.manifest);
    for (let ordinal = 0; ordinal < lead; ordinal += 1) {
      await executeManifestRow(deps(book), { executionOrder: ordinal });
    }
    const { record } = await executeManifestRow(deps(book), { executionOrder: lead });
    expect(record.arm).toBe("vtrace");
    expect(record.treatment.exposed).toBe(true);
    expect(record.treatment.initialised).toBe(true);
    expect(record.patchCaptureExclusions).toEqual([".vtrace"]);
    expect(record.capturedPatchPaths).toEqual(["pkg/core.py"]);
    expect(record.vtraceProductTreeSha).not.toBeNull();
  });

  test("the baseline arm carries no treatment identity and no treatment state", async () => {
    const book = ledger();
    const { record } = await executeManifestRow(deps(book), { executionOrder: 0 });
    expect(record.arm).toBe("baseline");
    expect(record.vtraceCommit).toBeNull();
    expect(record.vtraceProductTreeSha).toBeNull();
    expect(record.treatment.exposed).toBe(false);
    expect(record.treatment.invocationCount).toBe(0);
    expect(record.patchCaptureExclusions).toEqual([]);
  });

  test("the scheduler advances through the frozen order", async () => {
    const book = ledger();
    expect(selectNextRow(authorities.manifest, book)!.executionOrder).toBe(0);
    await executeManifestRow(deps(book), { executionOrder: 0 });
    expect(selectNextRow(authorities.manifest, book)!.executionOrder).toBe(1);
  });

  test("progress is outcome-blind", async () => {
    const book = ledger();
    await executeManifestRow(deps(book), { executionOrder: 0 });
    const progress = renderProgress(authorities.manifest, book, null);
    expect(progress.plannedRuns).toBe(200);
    expect(progress.terminalRuns).toBe(1);
    expect(Object.keys(progress)).not.toContain("baselineResolved");
    expect(Object.keys(progress)).not.toContain("passRate");
    expect(JSON.stringify(progress)).not.toContain("VALID_RESOLVED");
  });

  test("the finaliser refuses a partial cohort", async () => {
    const book = ledger();
    await executeManifestRow(deps(book), { executionOrder: 0 });
    const decision = canFinalizeCausalReport(authorities.manifest, book, "COHORT");
    expect(decision.permitted).toBe(false);
    expect(decision.reasons.join(" ")).toContain("FIXED_N");
  });
});

describe("treatment identity", () => {
  test("the manifest freezes one product tree for every vtrace row", () => {
    const trees = new Set(
      authorities.manifest.filter((row) => row.arm === "vtrace").map((row) => row.vtraceProductTreeSha),
    );
    expect(trees.size).toBe(1);
    const frozen = [...trees][0]!;
    expect(auditFrozenTreatmentTree(authorities.manifest, frozen)).toEqual([]);
    expect(auditFrozenTreatmentTree(authorities.manifest, "0".repeat(40))).toHaveLength(1);
  });
});
