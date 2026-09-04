/**
 * M214 — tests for the falsification suite itself.
 *
 * The suite's job is to prove the guards can fail. This file's job is to prove
 * the suite can fail, which is a different claim: a control that asserts a
 * guard fires is only evidence if the same guard stays silent on a compliant
 * input, and if breaking the guard breaks the control.
 */

import { describe, expect, test } from "bun:test";

import {
  type SuiteInputs,
  auditExclusion,
  auditM213Immutability,
  auditManifestBudgetSymmetry,
  auditManifestHash,
  auditPreregistrationHash,
  auditRandomization,
  auditRun,
  auditStopping,
  auditTaskSet,
  runFalsificationSuite,
  suitePasses,
} from "./m214Falsification";
import {
  M214_AGENT,
  M214_BUDGET,
  M214_EXCLUSIONS,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_RANDOMIZATION_SEED,
  M214_TASK_POPULATION_PATH,
  armDefinition,
  assignArmOrders,
  buildRunManifest,
  loadFrozenTaskPopulation,
  m214ManifestHash,
  m214PreregistrationHash,
} from "./m214Preregistration";
import { M214_EXTERNAL_REFERENCE, externalReferenceHash } from "./m214ExternalReference";

const population = loadFrozenTaskPopulation(M214_TASK_POPULATION_PATH);
const VTRACE_COMMIT = "a".repeat(40);
const VTRACE_TREE = "b".repeat(40);

const manifest = buildRunManifest({
  population,
  rows: population.instanceIds.map((instanceId) => ({
    instance_id: instanceId,
    repo: "example/repo",
    base_commit: "cafebabe",
  })),
  agentVersion: M214_AGENT.version,
  model: M214_MODEL.model,
  vtraceCommit: VTRACE_COMMIT,
  vtraceProductTreeSha: VTRACE_TREE,
});

const preregistrationDocument: Record<string, unknown> = {
  schemaVersion: "stage5.m214.preregistration.v1",
  benchmarkName: "VTRACE_EXTERNAL_VEXP_100",
  arms: ["baseline", "vtrace"],
  budgets: M214_BUDGET,
};

const m213Document: Record<string, unknown> = {
  schemaVersion: "stage5.m213.preregistration.v1",
  benchmarkName: "VTRACE_VEXP_CAUSAL_100",
  armCount: 3,
  arms: ["baseline", "vtrace", "vexp"],
  launchAuthorized: false,
};

function inputs(overrides: Partial<SuiteInputs> = {}): SuiteInputs {
  return {
    frozenInstanceIds: population.instanceIds,
    manifest,
    expectedOrders: assignArmOrders(population.instanceIds),
    seed: M214_RANDOMIZATION_SEED,
    preregistrationDocument,
    preregistrationHashRecorded: m214PreregistrationHash(preregistrationDocument),
    manifestHashRecorded: m214ManifestHash(manifest),
    legitimateExclusionCategories: M214_EXCLUSIONS.legitimate,
    vtraceCommit: VTRACE_COMMIT,
    vtraceProductTreeSha: VTRACE_TREE,
    frozenTaskArtifactSha256: population.sha256,
    externalReferenceHashRecorded: externalReferenceHash(),
    m213Document,
    m213PreregistrationHashRecorded: (() => {
      // M213's own rule, applied to the fixture, so F1's clean case is real.
      const { preregistrationHash } = require("./m213Preregistration") as {
        preregistrationHash: (document: Record<string, unknown>) => string;
      };
      return preregistrationHash(m213Document);
    })(),
    vendorScriptDerivedInstanceIds: population.instanceIds
      .slice(0, 22)
      .concat(Array.from({ length: 78 }, (_, index) => `script__only-${index}`))
      .sort(),
    vendorHardcodedPatchExclusions: [".vexp", ".claude", ".bench-mcp-config.json"],
    vendorCleanPreservedPaths: [".vexp", ".claude", ".bench-mcp-config.json"],
    scopedTypecheckDetectsInjectedError: true,
    ...overrides,
  };
}

describe("the suite as a whole", () => {
  const controls = runFalsificationSuite(inputs());

  test("passes on a compliant preregistration", () => {
    const failed = controls.filter((entry) => !entry.satisfied);
    expect(failed.map((entry) => `${entry.id}: ${entry.detail}`)).toEqual([]);
    expect(suitePasses(controls)).toBe(true);
  });

  test("covers F1 through F24 plus negative controls", () => {
    const ids = new Set(controls.map((entry) => entry.id));
    for (let index = 1; index <= 24; index += 1) {
      const covered = [...ids].some((id) => id === `F${index}` || id.startsWith(`F${index}_`));
      expect(covered).toBe(true);
    }
    expect([...ids].filter((id) => id.startsWith("F0_")).length).toBeGreaterThan(0);
  });

  test("contains genuine negative controls, not only positive ones", () => {
    const silent = controls.filter((entry) => entry.expectation === "GUARD_SILENT");
    const fires = controls.filter((entry) => entry.expectation === "GUARD_FIRES");
    expect(silent.length).toBeGreaterThan(5);
    expect(fires.length).toBeGreaterThan(15);
    expect(silent.every((entry) => !entry.fired)).toBe(true);
    expect(fires.every((entry) => entry.fired)).toBe(true);
  });

  test("every firing control reports what it caught", () => {
    for (const entry of controls.filter((c) => c.expectation === "GUARD_FIRES")) {
      expect(entry.detail).not.toBe("no issue reported");
      expect(entry.detail.length).toBeGreaterThan(10);
    }
  });
});

describe("the suite can fail", () => {
  test("a tampered preregistration hash fails F0_CLEAN_HASHES", () => {
    const controls = runFalsificationSuite(inputs({
      preregistrationHashRecorded: "0".repeat(64),
    }));
    expect(suitePasses(controls)).toBe(false);
    expect(controls.find((entry) => entry.id === "F0_CLEAN_HASHES")!.satisfied).toBe(false);
  });

  test("a vendor harness that already excluded .vtrace would still fail F4_HARDCODED", () => {
    const controls = runFalsificationSuite(inputs({
      vendorHardcodedPatchExclusions: [".vtrace", ".vexp", ".claude"],
    }));
    expect(controls.find((entry) => entry.id === "F4_HARDCODED")!.satisfied).toBe(true);
  });

  test("a symmetric vendor clean policy would make F20 unsatisfied", () => {
    const controls = runFalsificationSuite(inputs({ vendorCleanPreservedPaths: [".claude"] }));
    expect(controls.find((entry) => entry.id === "F20")!.satisfied).toBe(false);
  });

  test("a scoped typecheck that misses an injected error fails F21", () => {
    const controls = runFalsificationSuite(inputs({ scopedTypecheckDetectsInjectedError: false }));
    expect(controls.find((entry) => entry.id === "F21")!.satisfied).toBe(false);
    expect(suitePasses(controls)).toBe(false);
  });

  test("a vendor script subset that happened to match would make F2 unsatisfied", () => {
    const controls = runFalsificationSuite(inputs({
      vendorScriptDerivedInstanceIds: population.instanceIds,
    }));
    expect(controls.find((entry) => entry.id === "F2")!.satisfied).toBe(false);
  });
});

describe("per-run audit", () => {
  const contract = {
    instanceId: "astropy__astropy-14365",
    arm: "vtrace" as const,
    agentVersion: M214_AGENT.version,
    model: M214_MODEL.model,
    vtraceCommit: VTRACE_COMMIT,
    vtraceProductTreeSha: VTRACE_TREE,
    baseCommit: "deadbeef",
    canonicalTrackedSourceDigest: "canonical",
  };

  const observed = {
    runId: "r",
    instanceId: "astropy__astropy-14365",
    arm: "vtrace" as const,
    agentVersion: M214_AGENT.version,
    model: M214_MODEL.model,
    maxTurns: M214_BUDGET.maxTurns,
    perRunCostCapUsd: M214_BUDGET.perRunCostCapUsd,
    wallClockTimeoutSecondsPerRun: M214_BUDGET.wallClockTimeoutSecondsPerRun,
    nativeTools: M214_NATIVE_TOOLS,
    mcpServers: armDefinition("vtrace").mcpServers,
    modelVisibleToolNames: armDefinition("vtrace").modelVisibleToolNames,
    environmentVariableNames: ["PATH"],
    workspaceRootEntries: ["src", ".git"],
    systemPromptAppendix: null,
    userPromptTemplate: M214_AGENT.userPromptText,
    vtraceCommit: VTRACE_COMMIT,
    vtraceProductTreeSha: VTRACE_TREE,
    conversationSeededFromRunId: null,
    patchSeededFromRunId: null,
    treatmentResultSeededFromRunId: null,
    injectedContextDocuments: [] as readonly string[],
    goldArtifactsInAgentContext: [] as readonly string[],
    baseCommit: "deadbeef",
    headAtAgentStart: "deadbeef",
    trackedSourceDigestAtAgentStart: "canonical",
    treatmentExposed: true,
    treatmentInvocationCount: 4,
  };

  test("a compliant run raises nothing", () => {
    expect(auditRun(contract, observed)).toEqual([]);
  });

  test("treatment exposed but never invoked stays valid", () => {
    expect(auditRun(contract, { ...observed, treatmentInvocationCount: 0 })).toEqual([]);
  });

  test("a VTRACE arm whose surface never came up is reported", () => {
    const issues = auditRun(contract, { ...observed, treatmentExposed: false });
    expect(issues.some((issue) => issue.includes("did not have the treatment surface exposed")))
      .toBe(true);
  });

  test("a baseline run that carries a treatment surface is reported", () => {
    const baselineContract = { ...contract, arm: "baseline" as const };
    const issues = auditRun(baselineContract, {
      ...observed,
      arm: "baseline" as const,
      mcpServers: armDefinition("baseline").mcpServers,
      modelVisibleToolNames: armDefinition("baseline").modelVisibleToolNames,
      vtraceCommit: null,
      vtraceProductTreeSha: null,
      treatmentExposed: true,
    });
    expect(issues.some((issue) => issue.includes("had a treatment surface exposed"))).toBe(true);
  });

  test("product tree drift is caught even when the commit matches", () => {
    const issues = auditRun(contract, { ...observed, vtraceProductTreeSha: "c".repeat(40) });
    expect(issues.some((issue) => issue.includes("product tree drift"))).toBe(true);
  });

  test("all issues are returned, not just the first", () => {
    const issues = auditRun(contract, {
      ...observed,
      model: "claude-opus-5",
      maxTurns: 400,
      systemPromptAppendix: "Use VTRACE first.",
      goldArtifactsInAgentContext: ["/testbed/.gold.patch"],
    });
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });
});

describe("design-level guards", () => {
  test("M213 immutability accepts the committed document and rejects an edit", () => {
    const recorded = inputs().m213PreregistrationHashRecorded;
    expect(auditM213Immutability(m213Document, recorded, "different-hash")).toEqual([]);
    expect(auditM213Immutability({ ...m213Document, armCount: 2 }, recorded, "x").length)
      .toBeGreaterThan(0);
  });

  test("M214 reusing M213's hash is rejected", () => {
    const recorded = inputs().m213PreregistrationHashRecorded;
    const issues = auditM213Immutability(m213Document, recorded, recorded);
    expect(issues.some((issue) => issue.includes("reuses M213's preregistration hash"))).toBe(true);
  });

  test("rewriting M213 as launch-authorised is rejected", () => {
    const recorded = inputs().m213PreregistrationHashRecorded;
    const issues = auditM213Immutability(
      { ...m213Document, launchAuthorized: true }, recorded, "x",
    );
    expect(issues.some((issue) => issue.includes("rewritten as launch-authorised"))).toBe(true);
  });

  test("task-set drift is caught in both directions", () => {
    expect(auditTaskSet(population.instanceIds, manifest)).toEqual([]);
    expect(auditTaskSet([...population.instanceIds, "extra__task-1"], manifest).length)
      .toBeGreaterThan(0);
    expect(auditTaskSet(population.instanceIds.slice(1), manifest).length).toBeGreaterThan(0);
  });

  test("randomisation drift is caught", () => {
    const orders = assignArmOrders(population.instanceIds);
    expect(auditRandomization(manifest, orders, M214_RANDOMIZATION_SEED)).toEqual([]);
    expect(auditRandomization(manifest, orders, "other-seed").length).toBeGreaterThan(0);
  });

  test("budget symmetry is checked over the whole manifest", () => {
    expect(auditManifestBudgetSymmetry(manifest)).toEqual([]);
    expect(auditManifestBudgetSymmetry([
      manifest[0]!, { ...manifest[1]!, budgetIdentity: "other" },
    ]).length).toBeGreaterThan(0);
  });

  test("hashes are checked against the recorded values", () => {
    expect(auditPreregistrationHash(
      preregistrationDocument, m214PreregistrationHash(preregistrationDocument),
    )).toEqual([]);
    expect(auditManifestHash(manifest, m214ManifestHash(manifest))).toEqual([]);
    expect(auditManifestHash(manifest, "0".repeat(64)).length).toBe(1);
  });

  test("only preregistered exclusion categories are accepted", () => {
    expect(auditExclusion("CONTAINER_CANNOT_START", M214_EXCLUSIONS.legitimate)).toEqual([]);
    for (const invented of ["AGENT_FAILED_TASK", "TREATMENT_NEVER_INVOKED", "TOO_EXPENSIVE"]) {
      expect(auditExclusion(invented, M214_EXCLUSIONS.legitimate).length).toBe(1);
    }
  });

  test("no never-exclusion is also a legitimate category", () => {
    for (const never of M214_EXCLUSIONS.neverExclusions) {
      expect(M214_EXCLUSIONS.legitimate as readonly string[]).not.toContain(never);
    }
  });

  test("stopping requires every planned run to be terminal", () => {
    expect(auditStopping(200, 200)).toEqual([]);
    expect(auditStopping(200, 199).length).toBe(1);
  });
});

describe("the external reference never becomes an arm", () => {
  test("the frozen reference is not one of the manifest's arms", () => {
    const arms = new Set(manifest.map((row) => row.arm as string));
    expect(arms).toEqual(new Set(["baseline", "vtrace"]));
    expect(M214_EXTERNAL_REFERENCE.evidenceClass).toBe("EXTERNAL_VENDOR_REFERENCE");
  });

  test("no manifest row carries a vendor arm, identity or container", () => {
    // The experiment NAME contains VEXP, deliberately — it says which external
    // reference this cohort is comparable to. What must not exist is a row that
    // would be executed as a vendor arm, so the fields are checked, not the
    // serialisation.
    for (const row of manifest) {
      expect(["baseline", "vtrace"]).toContain(row.arm);
      expect(row.armOrder.every((arm) => arm === "baseline" || arm === "vtrace")).toBe(true);
      expect(row.containerImage.toLowerCase()).not.toContain("vexp");
      expect(Object.keys(row).some((key) => key.toLowerCase().includes("vexp"))).toBe(false);
    }
  });
});
