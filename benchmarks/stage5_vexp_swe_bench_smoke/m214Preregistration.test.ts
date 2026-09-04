/**
 * M214 — tests for the preregistration authority.
 *
 * These check the properties the experiment's validity rests on: that the two
 * arms differ in exactly one thing, that the population is the vendor's own,
 * that the manifest is complete and balanced, and that the hash is both stable
 * under a no-op regeneration and sensitive to every committing field.
 */

import { describe, expect, test } from "bun:test";

import { preregistrationHash as m213Hash } from "./m213Preregistration";
import {
  M214_AGENT,
  M214_ARMS,
  M214_ARM_ORDERS,
  M214_BUDGET,
  M214_EXPERIMENT_NAME,
  M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_PARENT,
  M214_PUBLISHED_CONDITION_MATRIX,
  M214_RANDOMIZATION_SEED,
  M214_TASK_POPULATION_PATH,
  M214_VTRACE_TREATMENT_CATALOG,
  type M214Arm,
  armDefinition,
  assignArmOrders,
  budgetIdentity,
  buildRunManifest,
  deferredRuntimeGates,
  evaluateLaunchGates,
  launchAuthorized,
  preregistrationComplete,
  loadFrozenTaskPopulation,
  m214ManifestHash,
  m214PreregistrationHash,
  verifyPopulation,
} from "./m214Preregistration";

const population = loadFrozenTaskPopulation(M214_TASK_POPULATION_PATH);

const manifestRows = population.instanceIds.map((instanceId) => ({
  instance_id: instanceId,
  repo: "example/repo",
  base_commit: "cafebabe",
}));

function manifest() {
  return buildRunManifest({
    population,
    rows: manifestRows,
    agentVersion: M214_AGENT.version,
    model: M214_MODEL.model,
    vtraceCommit: "a".repeat(40),
    vtraceProductTreeSha: "b".repeat(40),
  });
}

describe("frozen task population", () => {
  test("is the vendor's own artifact, verified against their published table", () => {
    const verification = verifyPopulation(population);
    expect(verification.verified).toBe(true);
    expect(verification.instanceCount).toBe(100);
    expect(verification.allTwelveRepositoriesPresent).toBe(true);
    expect(verification.distributionMatchesPublishedTable).toBe(true);
  });

  test("the external-reference artifact digest is the population's own digest", () => {
    expect(population.sha256).toBe(M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256);
  });

  test("instance ids are unique and sorted", () => {
    expect(new Set(population.instanceIds).size).toBe(100);
    expect([...population.instanceIds].sort()).toEqual([...population.instanceIds]);
  });
});

describe("arm definitions", () => {
  test("there are exactly two arms and neither is VEXP", () => {
    expect(M214_ARMS).toEqual(["baseline", "vtrace"]);
    expect(M214_ARMS as readonly string[]).not.toContain("vexp");
  });

  test("the arms differ in exactly one dimension: the treatment surface", () => {
    const baseline = armDefinition("baseline");
    const vtrace = armDefinition("vtrace");

    expect(baseline.nativeTools).toEqual(vtrace.nativeTools);
    expect(baseline.treatmentInstruction).toBeNull();
    expect(vtrace.treatmentInstruction).toBeNull();

    expect(baseline.mcpServers).toEqual([]);
    expect(vtrace.mcpServers).toEqual(["vtrace"]);
    expect(baseline.treatmentToolCatalog).toEqual([]);
    expect(vtrace.treatmentToolCatalog).toEqual(M214_VTRACE_TREATMENT_CATALOG);
  });

  test("the baseline's model-visible surface is exactly the native tools", () => {
    expect(armDefinition("baseline").modelVisibleToolNames).toEqual(M214_NATIVE_TOOLS);
  });

  test("the VTRACE surface is the native tools plus the namespaced catalogue", () => {
    const visible = armDefinition("vtrace").modelVisibleToolNames;
    expect(visible.length).toBe(M214_NATIVE_TOOLS.length + M214_VTRACE_TREATMENT_CATALOG.length);
    for (const tool of M214_VTRACE_TREATMENT_CATALOG) {
      expect(visible).toContain(`mcp__vtrace__${tool}`);
    }
  });

  test("neither arm may see the other's — or the competitor's — workspace state", () => {
    expect(armDefinition("baseline").forbiddenWorkspaceEntries).toContain(".vtrace");
    expect(armDefinition("baseline").forbiddenWorkspaceEntries).toContain(".vexp");
    expect(armDefinition("vtrace").forbiddenWorkspaceEntries).toContain(".vexp");
    expect(armDefinition("vtrace").forbiddenWorkspaceEntries).not.toContain(".vtrace");
  });

  test("only the VTRACE arm declares treatment state", () => {
    expect(armDefinition("baseline").treatmentStatePaths).toEqual([]);
    expect(armDefinition("vtrace").treatmentStatePaths).toEqual([".vtrace"]);
  });
});

describe("randomisation", () => {
  test("assigns exactly 50/50 across the two orders", () => {
    const orders = assignArmOrders(population.instanceIds);
    const counts = new Map<string, number>();
    for (const order of orders.values()) {
      const key = order.join(">");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.get("baseline>vtrace")).toBe(50);
    expect(counts.get("vtrace>baseline")).toBe(50);
  });

  test("is deterministic under the frozen seed and moves under another", () => {
    const a = assignArmOrders(population.instanceIds, M214_RANDOMIZATION_SEED);
    const b = assignArmOrders(population.instanceIds, M214_RANDOMIZATION_SEED);
    const c = assignArmOrders(population.instanceIds, "some-other-seed");
    for (const id of population.instanceIds) {
      expect(a.get(id)).toEqual(b.get(id)!);
    }
    const moved = population.instanceIds
      .filter((id) => a.get(id)!.join(">") !== c.get(id)!.join(">"));
    expect(moved.length).toBeGreaterThan(0);
  });

  test("covers every task and only the frozen orders", () => {
    const orders = assignArmOrders(population.instanceIds);
    expect(orders.size).toBe(100);
    const allowed = M214_ARM_ORDERS.map((order) => order.join(">"));
    for (const order of orders.values()) {
      expect(allowed).toContain(order.join(">"));
    }
  });
});

describe("run manifest", () => {
  test("is exactly 200 PLANNED rows, two per task, no VEXP row", () => {
    const rows = manifest();
    expect(rows.length).toBe(200);
    expect(rows.every((row) => row.status === "PLANNED")).toBe(true);
    expect(rows.every((row) => M214_ARMS.includes(row.arm))).toBe(true);

    const perTask = new Map<string, Set<M214Arm>>();
    for (const row of rows) {
      if (!perTask.has(row.instanceId)) perTask.set(row.instanceId, new Set());
      perTask.get(row.instanceId)!.add(row.arm);
    }
    expect(perTask.size).toBe(100);
    for (const arms of perTask.values()) expect(arms.size).toBe(2);
  });

  test("carries one budget identity and equal budget fields on every row", () => {
    const rows = manifest();
    expect(new Set(rows.map((row) => row.budgetIdentity)).size).toBe(1);
    expect(rows[0]!.budgetIdentity).toBe(budgetIdentity());
    expect(new Set(rows.map((row) => row.maxTurns))).toEqual(new Set([M214_BUDGET.maxTurns]));
    expect(new Set(rows.map((row) => row.perRunCostCapUsd)))
      .toEqual(new Set([M214_BUDGET.perRunCostCapUsd]));
  });

  test("declares a VTRACE identity on VTRACE rows only", () => {
    for (const row of manifest()) {
      if (row.arm === "vtrace") {
        expect(row.vtraceCommit).not.toBeNull();
        expect(row.vtraceProductTreeSha).not.toBeNull();
      } else {
        expect(row.vtraceCommit).toBeNull();
        expect(row.vtraceProductTreeSha).toBeNull();
      }
    }
  });

  test("execution order is a dense permutation of 0..199", () => {
    const orders = manifest().map((row) => row.executionOrder).sort((a, b) => a - b);
    expect(orders).toEqual(Array.from({ length: 200 }, (_, index) => index));
  });

  test("a task's two rows are adjacent and in its assigned order", () => {
    const rows = manifest();
    const assigned = assignArmOrders(population.instanceIds);
    for (let index = 0; index < rows.length; index += 2) {
      const first = rows[index]!;
      const second = rows[index + 1]!;
      expect(second.instanceId).toBe(first.instanceId);
      expect([first.arm, second.arm]).toEqual([...assigned.get(first.instanceId)!]);
    }
  });

  test("the manifest hash moves when any row changes", () => {
    const rows = manifest();
    const baseline = m214ManifestHash(rows);
    expect(m214ManifestHash([...rows])).toBe(baseline);
    expect(m214ManifestHash([...rows.slice(0, 199), { ...rows[199]!, maxTurns: 251 }]))
      .not.toBe(baseline);
    expect(m214ManifestHash(rows.slice(0, 199))).not.toBe(baseline);
  });
});

describe("preregistration hash", () => {
  const document = {
    schemaVersion: "stage5.m214.preregistration.v1",
    generatedAt: "2026-09-04T00:00:00.000Z",
    benchmarkName: M214_EXPERIMENT_NAME,
    arms: ["baseline", "vtrace"],
    budgets: M214_BUDGET,
  } as Record<string, unknown>;

  test("ignores generatedAt so an unchanged design rehashes identically", () => {
    const a = m214PreregistrationHash(document);
    const b = m214PreregistrationHash({ ...document, generatedAt: "2027-01-01T00:00:00.000Z" });
    expect(a).toBe(b);
  });

  test("is key-order independent", () => {
    const reversed = Object.fromEntries(Object.entries(document).reverse());
    expect(m214PreregistrationHash(reversed)).toBe(m214PreregistrationHash(document));
  });

  test("moves when any committing field changes", () => {
    const baseline = m214PreregistrationHash(document);
    expect(m214PreregistrationHash({ ...document, arms: ["baseline"] })).not.toBe(baseline);
    expect(m214PreregistrationHash({ ...document, benchmarkName: "OTHER" })).not.toBe(baseline);
    expect(m214PreregistrationHash({ ...document, budgets: { ...M214_BUDGET, maxTurns: 1 } }))
      .not.toBe(baseline);
  });

  test("is domain-separated from M213's, so an identical document cannot collide", () => {
    expect(m214PreregistrationHash(document)).not.toBe(m213Hash(document));
  });
});

describe("budget and identity equality", () => {
  test("there is exactly one budget object and it declares arm equality", () => {
    expect(M214_BUDGET.identicalAcrossArms).toBe(true);
    expect(M214_BUDGET.totalIntendedRuns).toBe(200);
    expect(Object.keys(M214_BUDGET).some((key) => /baseline|vtrace|arm[A-Z]/.test(key))).toBe(false);
  });

  test("the model is declared identical across arms and pins one identifier", () => {
    expect(M214_MODEL.identicalAcrossArms).toBe(true);
    expect(M214_MODEL.model).toBe("claude-opus-4-5-20251101");
  });

  test("neither arm's prompt carries a treatment instruction", () => {
    expect(M214_AGENT.userPromptContainsTreatmentInstruction).toBe(false);
    expect(M214_AGENT.userPromptText.toLowerCase()).not.toContain("vtrace");
  });
});

describe("M213 lineage", () => {
  test("the parent record preserves the three-arm blocked experiment", () => {
    expect(M214_PARENT.milestone).toBe("M213");
    expect(M214_PARENT.armCount).toBe(3);
    expect(M214_PARENT.intendedRuns).toBe(300);
    expect(M214_PARENT.status).toContain("VEXP_TREATMENT_NOT_EXECUTABLE");
    expect(M214_PARENT.verdict).toBe("M213 — INCOMPLETE");
  });

  test("M214's experiment name and seed are distinct from M213's", () => {
    expect(M214_EXPERIMENT_NAME).not.toBe(M214_PARENT.experimentName);
    expect(M214_RANDOMIZATION_SEED).toContain("M214");
  });
});

describe("published-condition matrix", () => {
  test("every row is classified", () => {
    const allowed = new Set(["MATCH", "APPROXIMATE", "UNKNOWN", "DIFFERS"]);
    for (const row of M214_PUBLISHED_CONDITION_MATRIX) {
      expect(allowed.has(row.match)).toBe(true);
      expect(row.note.length).toBeGreaterThan(0);
    }
  });

  test("the task artifact matches and the cost cap honestly differs", () => {
    const byCondition = new Map(M214_PUBLISHED_CONDITION_MATRIX.map((row) => [row.condition, row]));
    expect(byCondition.get("task artifact")!.match).toBe("MATCH");
    expect(byCondition.get("cost cap")!.match).toBe("DIFFERS");
  });

  test("not every condition is known, so exact replication cannot be claimed", () => {
    const unknown = M214_PUBLISHED_CONDITION_MATRIX.filter((row) => row.match === "UNKNOWN");
    expect(unknown.length).toBeGreaterThan(0);
  });
});

describe("launch gates", () => {
  const passing = {
    preregistrationCommitted: true,
    preregistrationHashRecorded: true,
    m213Immutable: true,
    externalTaskArtifactVerified: true,
    taskIdsFrozen: true,
    manifestRowCount: 200,
    baselineTreatmentFree: true,
    vtraceExecutable: true,
    vtraceIdentityFrozen: true,
    agentIdentityFrozen: true,
    modelIdentityFrozen: true,
    nativeToolsIdentical: true,
    budgetsIdentical: true,
    sourceStateEquivalence: "DEFERRED_TO_LAUNCH" as const,
    indexingObservational: "PASS" as const,
    treatmentStateExcludedFromPatch: "PASS" as const,
    resetWarmPolicySymmetric: "PASS" as const,
    executionOrderFrozen: true,
    evaluatorValidated: true,
    pairedAnalysisFrozen: true,
    efficiencyAnalysisFrozen: true,
    invalidRunRulesFrozen: true,
    stoppingRuleFrozen: true,
    externalReferenceFrozen: true,
    externalReferenceCannotEnterCausalAnalysis: true,
    falsificationSuitePasses: true,
    noOutcomeBearingRunHasOccurred: true,
    liveModelSpendIsZero: true,
    scopedTypecheckClean: true,
    modelAvailabilityEvidence: "PASS" as const,
    treatmentLifecycleOrderVerified: "PASS" as const,
    launchExecutorExists: true,
    runtimeGuards: { sourceStateEquivalence: "auditSourceStateEquivalence" },
  };

  test("an all-clear input authorises launch", () => {
    const gates = evaluateLaunchGates({ ...passing, sourceStateEquivalence: "PASS" as const });
    expect(gates.length).toBe(32);
    expect(launchAuthorized(gates)).toBe(true);
  });

  test("every gate declares its class", () => {
    const allowed = new Set(["PREREGISTRATION", "RUNTIME", "INFRASTRUCTURE"]);
    for (const gate of evaluateLaunchGates(passing)) {
      expect(allowed.has(gate.gateClass)).toBe(true);
    }
  });

  test("deferral is not authorisation", () => {
    const gates = evaluateLaunchGates({
      ...passing, sourceStateEquivalence: "DEFERRED_TO_LAUNCH" as const,
    });
    const deferred = deferredRuntimeGates(gates);
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.every((gate) => gate.status === "DEFERRED_TO_LAUNCH")).toBe(true);
    expect(launchAuthorized(gates)).toBe(false);
    // …but the design can still be complete: deferral is a scheduling fact.
    expect(preregistrationComplete(gates)).toBe(true);
  });

  test("a RUNTIME gate names the guard that will assert it", () => {
    const gate = deferredRuntimeGates(evaluateLaunchGates(passing))[0]!;
    expect(gate.evidence).toContain("auditSourceStateEquivalence");
  });

  test("a RUNTIME gate can pass once a launch executor asserts it", () => {
    const gates = evaluateLaunchGates({ ...passing, sourceStateEquivalence: "PASS" as const });
    expect(gates.find((gate) => gate.id === "G14")!.status).toBe("PASS");
    expect(launchAuthorized(gates)).toBe(true);
  });

  test("the design can be complete while launch is blocked on infrastructure", () => {
    const gates = evaluateLaunchGates({ ...passing, launchExecutorExists: false });
    expect(preregistrationComplete(gates)).toBe(true);
    expect(launchAuthorized(gates)).toBe(false);
    expect(gates.find((gate) => gate.id === "G32")!.status).toBe("FAIL");
  });

  test("a design hole makes the preregistration incomplete, not merely unready", () => {
    const gates = evaluateLaunchGates({ ...passing, pairedAnalysisFrozen: false });
    expect(preregistrationComplete(gates)).toBe(false);
  });

  test("a 300-row manifest fails the two-arm run-count gate", () => {
    const gates = evaluateLaunchGates({ ...passing, manifestRowCount: 300 });
    expect(gates.find((gate) => gate.id === "G6")!.status).toBe("FAIL");
    expect(launchAuthorized(gates)).toBe(false);
  });

  test("a mutated M213 blocks launch", () => {
    const gates = evaluateLaunchGates({ ...passing, m213Immutable: false });
    expect(gates.find((gate) => gate.id === "G3")!.status).toBe("FAIL");
    expect(launchAuthorized(gates)).toBe(false);
  });

  test("a BLOCKED tri-state gate is not a pass", () => {
    const gates = evaluateLaunchGates({
      ...passing,
      treatmentLifecycleOrderVerified: "BLOCKED" as const,
    });
    expect(gates.find((gate) => gate.id === "G31")!.status).toBe("BLOCKED");
    expect(launchAuthorized(gates)).toBe(false);
    expect(preregistrationComplete(gates)).toBe(false);
  });

  test("every gate input can block launch on its own", () => {
    const authorising = { ...passing, sourceStateEquivalence: "PASS" as const };
    for (const key of Object.keys(authorising) as (keyof typeof authorising)[]) {
      if (key === "runtimeGuards") continue; // a label map, not a condition
      const broken = { ...authorising } as Record<string, unknown>;
      const value = authorising[key];
      broken[key] = typeof value === "boolean" ? false
        : typeof value === "number" ? 199
          : "FAIL";
      expect(launchAuthorized(evaluateLaunchGates(broken as typeof authorising))).toBe(false);
    }
  });
});
