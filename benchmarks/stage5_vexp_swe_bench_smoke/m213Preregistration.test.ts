import { describe, expect, test } from "bun:test";

import {
  M213_ARMS,
  M213_ARM_ORDERS,
  M213_BUDGET,
  M213_NATIVE_TOOLS,
  M213_RANDOMIZATION_SEED,
  M213_TASK_POPULATION_SHA256,
  VEXP_DEFAULT_TOOL_CATALOG_3_1_1,
  VEXP_PUBLISHED_DISTRIBUTION,
  VTRACE_DEFAULT_TOOL_CATALOG,
  armDefinition,
  assignArmOrders,
  buildRunManifest,
  canonicalize,
  evaluateLaunchGates,
  instanceImageKey,
  launchAuthorized,
  loadFrozenTaskPopulation,
  manifestHash,
  preregistrationHash,
  verifyPopulation,
  vexpComplexityScore,
  type GateInputs,
  type M213Arm,
} from "./m213Preregistration";

const population = loadFrozenTaskPopulation();
const rows = (await Bun.file(population.path).text()).trim().split("\n")
  .map((line) => JSON.parse(line) as { instance_id: string; repo: string; base_commit: string });

function manifest() {
  return buildRunManifest({
    population,
    rows,
    agentVersion: "2.1.260",
    model: "claude-opus-4-5-20251101",
    vtraceCommit: "abc123",
    vexpVersion: "3.1.1",
  });
}

describe("frozen task population", () => {
  test("is VEXP's own 100-instance subset, byte-pinned", () => {
    expect(population.sha256).toBe(M213_TASK_POPULATION_SHA256);
    expect(population.instanceIds.length).toBe(100);
    expect(new Set(population.instanceIds).size).toBe(100);
  });

  test("matches every property VEXP published about it", () => {
    const verification = verifyPopulation(population);
    expect(verification.verified).toBe(true);
    expect(verification.allTwelveRepositoriesPresent).toBe(true);
    expect(verification.distributionMatchesPublishedTable).toBe(true);
    expect(verification.complexityCeilingRespected).toBe(true);
    expect(verification.complexityMedianMatchesPublished).toBe(true);
  });

  test("the published repository table is reproduced instance for instance", () => {
    for (const [repo, count] of Object.entries(VEXP_PUBLISHED_DISTRIBUTION)) {
      expect(population.countsByRepository[repo]).toBe(count);
    }
  });

  test("verification fails when the population is perturbed", () => {
    const perturbed = {
      ...population,
      instanceIds: population.instanceIds.slice(0, 99),
      countsByRepository: { ...population.countsByRepository, "django/django": 43 },
    };
    expect(verifyPopulation(perturbed).verified).toBe(false);
  });

  test("the complexity proxy reproduces VEXP's published formula", () => {
    expect(vexpComplexityScore({ FAIL_TO_PASS: JSON.stringify(["a", "b"]), patch: "+x\n-y\n z" })).toBe(22);
    expect(vexpComplexityScore({ FAIL_TO_PASS: ["a"], patch: "+x" })).toBe(11);
    expect(vexpComplexityScore({ FAIL_TO_PASS: "not json", patch: "" })).toBe(0);
  });
});

describe("arms", () => {
  test("every arm gets the identical native tool set", () => {
    for (const arm of M213_ARMS) {
      expect([...armDefinition(arm).nativeTools].sort()).toEqual([...M213_NATIVE_TOOLS].sort());
    }
  });

  test("baseline is exposed to no treatment at all", () => {
    const baseline = armDefinition("baseline");
    expect(baseline.mcpServers).toEqual([]);
    expect(baseline.treatmentToolCatalog).toEqual([]);
    expect(baseline.modelVisibleToolNames).toEqual(M213_NATIVE_TOOLS);
  });

  test("each treatment arm sees its own product-default catalogue and no other", () => {
    const vtrace = armDefinition("vtrace");
    expect(vtrace.treatmentToolCatalog).toEqual(VTRACE_DEFAULT_TOOL_CATALOG);
    expect(vtrace.modelVisibleToolNames.some((name) => name.startsWith("mcp__vexp__"))).toBe(false);

    const vexp = armDefinition("vexp");
    expect(vexp.treatmentToolCatalog).toEqual(VEXP_DEFAULT_TOOL_CATALOG_3_1_1);
    expect(vexp.modelVisibleToolNames.some((name) => name.startsWith("mcp__vtrace__"))).toBe(false);
  });

  /**
   * VTRACE's own product default ships a tool called `expand_vexp_ref`, so its
   * model-visible name is `mcp__vtrace__expand_vexp_ref`. A contamination guard
   * that asked "does any tool name contain 'vexp'?" would report the VTRACE arm
   * as contaminated on every single run. The guards therefore compare server
   * names and whole catalogues, never substrings — pinned here because the
   * naive check is the obvious one to reach for later.
   */
  test("a substring contamination check would false-positive; the real guard does not", () => {
    const vtrace = armDefinition("vtrace");
    expect(vtrace.treatmentToolCatalog).toContain("expand_vexp_ref");
    expect(vtrace.modelVisibleToolNames.some((name) => name.includes("vexp"))).toBe(true);
    expect(vtrace.mcpServers).toEqual(["vtrace"]);
  });

  test("no arm carries a treatment-specific prompt instruction", () => {
    for (const arm of M213_ARMS) expect(armDefinition(arm).treatmentInstruction).toBeNull();
  });

  test("get_impact_graph is absent from the VEXP arm, as VEXP ships it", () => {
    expect(VEXP_DEFAULT_TOOL_CATALOG_3_1_1).not.toContain("get_impact_graph");
  });
});

describe("randomisation", () => {
  test("is deterministic under the frozen seed", () => {
    const first = assignArmOrders(population.instanceIds);
    const second = assignArmOrders(population.instanceIds);
    for (const id of population.instanceIds) {
      expect(second.get(id)).toEqual(first.get(id));
    }
  });

  test("does not depend on the order instances are presented in", () => {
    const forward = assignArmOrders(population.instanceIds);
    const reversed = assignArmOrders([...population.instanceIds].reverse());
    for (const id of population.instanceIds) {
      expect(reversed.get(id)).toEqual(forward.get(id));
    }
  });

  test("changes completely under a different seed", () => {
    const frozen = assignArmOrders(population.instanceIds);
    const other = assignArmOrders(population.instanceIds, "some-other-seed");
    const identical = population.instanceIds
      .filter((id) => frozen.get(id)!.join(">") === other.get(id)!.join(">")).length;
    expect(identical).toBeLessThan(population.instanceIds.length);
  });

  test("balances the six orders and never puts baseline first systematically", () => {
    const orders = assignArmOrders(population.instanceIds);
    const counts = new Map<string, number>();
    for (const [, order] of orders) {
      counts.set(order.join(">"), (counts.get(order.join(">")) ?? 0) + 1);
    }
    expect(counts.size).toBe(M213_ARM_ORDERS.length);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(16);
      expect(count).toBeLessThanOrEqual(17);
    }
    const baselineFirst = [...orders.values()].filter((order) => order[0] === "baseline").length;
    expect(baselineFirst).toBeLessThan(population.instanceIds.length);
    expect(baselineFirst).toBeGreaterThan(0);
  });

  test("every order is a permutation of the three arms", () => {
    for (const order of M213_ARM_ORDERS) {
      expect([...order].sort()).toEqual(["baseline", "vexp", "vtrace"]);
    }
  });
});

describe("run manifest", () => {
  test("is 300 rows: every frozen task under every arm", () => {
    const rowsOut = manifest();
    expect(rowsOut.length).toBe(300);
    const perInstance = new Map<string, Set<M213Arm>>();
    for (const row of rowsOut) {
      if (!perInstance.has(row.instanceId)) perInstance.set(row.instanceId, new Set());
      perInstance.get(row.instanceId)!.add(row.arm);
    }
    expect(perInstance.size).toBe(100);
    for (const arms of perInstance.values()) expect(arms.size).toBe(3);
  });

  test("every row is PLANNED — the manifest predates execution", () => {
    expect(manifest().every((row) => row.status === "PLANNED")).toBe(true);
  });

  test("budgets are identical in every row", () => {
    const budgets = new Set(manifest().map((row) => `${row.maxTurns}:${row.perRunCostCapUsd}`));
    expect(budgets.size).toBe(1);
    expect([...budgets][0]).toBe(`${M213_BUDGET.maxTurns}:${M213_BUDGET.perRunCostCapUsd}`);
  });

  test("agent and model are identical in every row", () => {
    expect(new Set(manifest().map((row) => row.agentVersion)).size).toBe(1);
    expect(new Set(manifest().map((row) => row.model)).size).toBe(1);
  });

  test("a treatment identity appears only on its own arm", () => {
    for (const row of manifest()) {
      expect(row.vtraceCommit === null).toBe(row.arm !== "vtrace");
      expect(row.vexpVersion === null).toBe(row.arm !== "vexp");
    }
  });

  test("arm order index agrees with the row's own frozen order", () => {
    for (const row of manifest()) {
      expect(row.armOrder[row.armOrderIndex]).toBe(row.arm);
    }
  });

  test("throws rather than silently dropping an instance with no row", () => {
    expect(() => buildRunManifest({
      population, rows: rows.slice(0, 50),
      agentVersion: "2.1.260", model: "m", vtraceCommit: "c", vexpVersion: "3.1.1",
    })).toThrow();
  });

  test("image keys follow the official swebench naming", () => {
    expect(instanceImageKey("pallets__flask-5014"))
      .toBe("swebench/sweb.eval.x86_64.pallets_1776_flask-5014:latest");
  });
});

describe("hashing", () => {
  test("canonicalisation is key-order independent", () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: { d: 2, c: 3 } })))
      .toBe(JSON.stringify(canonicalize({ a: { c: 3, d: 2 }, b: 1 })));
  });

  test("the preregistration hash ignores the hash fields themselves", () => {
    const document = { a: 1, b: [1, 2] };
    const digest = preregistrationHash(document);
    expect(preregistrationHash({ ...document, preregistrationHash: digest })).toBe(digest);
    expect(preregistrationHash({ ...document, preregistrationHashRule: "x" })).toBe(digest);
  });

  test("the preregistration hash changes when any other field changes", () => {
    expect(preregistrationHash({ a: 1 })).not.toBe(preregistrationHash({ a: 2 }));
  });

  test("the manifest hash is stable and order-sensitive", () => {
    const rowsOut = manifest();
    expect(manifestHash(rowsOut)).toBe(manifestHash(manifest()));
    expect(manifestHash([...rowsOut].reverse())).not.toBe(manifestHash(rowsOut));
  });

  test("dropping one task changes the manifest hash", () => {
    const rowsOut = manifest();
    expect(manifestHash(rowsOut.slice(0, 297))).not.toBe(manifestHash(rowsOut));
  });
});

describe("launch gates", () => {
  const allPass: GateInputs = {
    preregistrationCommitted: true,
    preregistrationHashRecorded: true,
    populationVerified: true,
    manifestRowCount: 300,
    vtraceExecutable: true,
    vexpExecutable: true,
    baselineContaminationGuardPasses: true,
    treatmentContaminationGuardsPass: true,
    identicalAgentVerified: true,
    identicalModelVerified: true,
    identicalBudgetsVerified: true,
    identicalNativeToolsVerified: true,
    repositoryStateEquivalenceVerified: true,
    evaluatorValidated: true,
    exclusionRulesFrozen: true,
    statisticalPlanFrozen: true,
    stoppingRuleFrozen: true,
    randomizationFrozen: true,
    falsificationControlsPass: true,
    noOutcomeBearingRunHasOccurred: true,
    treatmentStatePatchNeutrality: "PASS",
    warmColdIndexSymmetry: "PASS",
    vendorHarnessPatchCaptureIsSymmetric: true,
    vendorHarnessIndexWarmthIsSymmetric: true,
  };

  test("authorise only when every gate passes", () => {
    expect(launchAuthorized(evaluateLaunchGates(allPass))).toBe(true);
  });

  test("G6 alone withholds authorisation", () => {
    const gates = evaluateLaunchGates({ ...allPass, vexpExecutable: false });
    expect(gates.find((gate) => gate.id === "G6")?.status).toBe("FAIL");
    expect(launchAuthorized(gates)).toBe(false);
  });

  test("a short manifest fails G4", () => {
    const gates = evaluateLaunchGates({ ...allPass, manifestRowCount: 299 });
    expect(gates.find((gate) => gate.id === "G4")?.status).toBe("FAIL");
  });

  test("the harness-defect gates exist and are separately addressable", () => {
    const gates = evaluateLaunchGates({
      ...allPass,
      treatmentStatePatchNeutrality: "FAIL",
      warmColdIndexSymmetry: "FAIL",
    });
    expect(gates.find((gate) => gate.id === "G21")?.status).toBe("FAIL");
    expect(gates.find((gate) => gate.id === "G22")?.status).toBe("FAIL");
    expect(launchAuthorized(gates)).toBe(false);
  });

  /**
   * BLOCKED is not PASS. The distinction exists so "we have not been able to
   * establish this yet" cannot be read as "we checked and it is fine", and it
   * must withhold authorisation exactly as a FAIL does.
   */
  test("a BLOCKED gate withholds authorisation without claiming a defect", () => {
    const gates = evaluateLaunchGates({
      ...allPass,
      treatmentStatePatchNeutrality: "BLOCKED",
      warmColdIndexSymmetry: "BLOCKED",
    });
    expect(gates.find((gate) => gate.id === "G21")?.status).toBe("BLOCKED");
    expect(gates.find((gate) => gate.id === "G22")?.status).toBe("BLOCKED");
    expect(launchAuthorized(gates)).toBe(false);
  });

  test("every gate G1..G22 is present exactly once", () => {
    const ids = evaluateLaunchGates(allPass).map((gate) => gate.id);
    expect(ids.length).toBe(22);
    expect(new Set(ids).size).toBe(22);
    for (let index = 1; index <= 22; index += 1) expect(ids).toContain(`G${index}`);
  });
});

describe("budget and stopping discipline", () => {
  test("the total spend cap is the per-run cap over all intended runs", () => {
    expect(M213_BUDGET.totalIntendedRuns).toBe(300);
    const cap: number = M213_BUDGET.totalSpendCapUsd;
    expect(cap).toBe(M213_BUDGET.perRunCostCapUsd * M213_BUDGET.totalIntendedRuns);
  });

  test("the per-run cap sits above the most expensive untreated arm on record", () => {
    expect(M213_BUDGET.perRunCostCapUsd).toBeGreaterThan(3.0384);
  });

  test("the frozen seed is committed as a literal, not derived at runtime", () => {
    expect(M213_RANDOMIZATION_SEED).toBe("M213-VTRACE-VEXP-CAUSAL-100-v1");
  });
});

describe("hash idempotence", () => {
  test("the hash ignores the render timestamp but not the design", () => {
    const design = { arms: 3, seed: "s" };
    const first = preregistrationHash({ ...design, generatedAt: "2026-09-04T00:00:00.000Z" });
    const second = preregistrationHash({ ...design, generatedAt: "2027-01-01T00:00:00.000Z" });
    expect(second).toBe(first);
    expect(preregistrationHash({ ...design, seed: "t" })).not.toBe(first);
    expect(preregistrationHash({ ...design, arms: 2 })).not.toBe(first);
  });
});
