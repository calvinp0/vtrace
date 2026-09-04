import { describe, expect, test } from "bun:test";

import {
  M213_EXCLUSIONS,
  M213_RANDOMIZATION_SEED,
  assignArmOrders,
  buildRunManifest,
  loadFrozenTaskPopulation,
  manifestHash,
  preregistrationHash,
} from "./m213Preregistration";
import {
  auditCapturedPatchPaths,
  auditExclusion,
  auditIndexWarmthSymmetry,
  auditManifestHash,
  auditPatchCaptureExclusions,
  auditPreregistrationHash,
  auditRandomization,
  auditStopping,
  auditTaskSet,
  runFalsificationSuite,
  suitePasses,
  type SuiteInputs,
} from "./m213Falsification";

const population = loadFrozenTaskPopulation();
const rows = (await Bun.file(population.path).text()).trim().split("\n")
  .map((line) => JSON.parse(line) as { instance_id: string; repo: string; base_commit: string });

const manifest = buildRunManifest({
  population, rows,
  agentVersion: "2.1.260",
  model: "claude-opus-4-5-20251101",
  vtraceCommit: "abc123",
  vexpVersion: "3.1.1",
});

const document = { design: "frozen", arms: 3 };

/**
 * The suite is fed the REAL, measured harness pathspecs — the ones this
 * milestone read out of vexp-swe-bench's own JavaScript. F21 and F22 are
 * therefore controls that assert a defect exists, not hypotheticals.
 */
const baseInputs: SuiteInputs = {
  frozenInstanceIds: population.instanceIds,
  manifest,
  expectedOrders: assignArmOrders(population.instanceIds),
  seed: M213_RANDOMIZATION_SEED,
  preregistrationDocument: document,
  preregistrationHashRecorded: preregistrationHash(document),
  manifestHashRecorded: manifestHash(manifest),
  legitimateExclusionCategories: M213_EXCLUSIONS.legitimate,
  vtraceCommit: "abc123",
  vexpVersion: "3.1.1",
  observedPatchCaptureExclusions: [".bench-mcp-config.json", ".claude", ".vexp"],
  observedCleanPreservedPaths: [".bench-mcp-config.json", ".claude", ".vexp"],
};

describe("falsification suite", () => {
  const controls = runFalsificationSuite(baseInputs);

  test("every control is satisfied", () => {
    const failures = controls.filter((control) => !control.satisfied);
    expect(failures.map((control) => `${control.id}: ${control.detail}`)).toEqual([]);
    expect(suitePasses(controls)).toBe(true);
  });

  test("F1 through F22 are all present", () => {
    const ids = controls.map((control) => control.id).join(" ");
    for (let index = 1; index <= 22; index += 1) {
      expect(ids).toContain(`F${index}`);
    }
  });

  test("the suite contains real negative controls, not only rejections", () => {
    const silent = controls.filter((control) => control.expectation === "GUARD_SILENT");
    expect(silent.length).toBeGreaterThanOrEqual(4);
    expect(silent.every((control) => !control.fired)).toBe(true);
  });

  test("a compliant run of every arm raises nothing", () => {
    for (const arm of ["BASELINE", "VTRACE", "VEXP"]) {
      const control = controls.find((entry) => entry.id === `F0_CLEAN_${arm}`);
      expect(control?.fired).toBe(false);
    }
  });

  test("F12 keeps an unused treatment inside the experiment", () => {
    const f12 = controls.find((control) => control.id === "F12");
    expect(f12?.expectation).toBe("GUARD_SILENT");
    expect(f12?.satisfied).toBe(true);
  });

  test("F13 refuses a silent baseline substitution", () => {
    expect(controls.find((control) => control.id === "F13_NO_SILENT_BASELINE")?.fired).toBe(true);
    expect(controls.find((control) => control.id === "F13_CLASSIFIED")?.fired).toBe(false);
  });

  test("the harness controls F21 and F22 fire against the real measured pathspecs", () => {
    expect(controls.find((control) => control.id === "F21_HARNESS")?.fired).toBe(true);
    expect(controls.find((control) => control.id === "F22")?.fired).toBe(true);
  });

  test("F21 and F22 go silent once the harness is made symmetric", () => {
    const repaired = runFalsificationSuite({
      ...baseInputs,
      observedPatchCaptureExclusions: [".bench-mcp-config.json", ".claude", ".vexp", ".vtrace"],
      observedCleanPreservedPaths: [".bench-mcp-config.json", ".claude", ".vexp", ".vtrace"],
    });
    expect(repaired.find((control) => control.id === "F21_HARNESS")?.fired).toBe(false);
    expect(repaired.find((control) => control.id === "F22")?.fired).toBe(false);
    // Those two controls then become UNSATISFIED, which is the point: they are
    // written to assert a present defect, and a repaired harness must be
    // reported as repaired rather than as still-broken.
    expect(repaired.find((control) => control.id === "F21_HARNESS")?.satisfied).toBe(false);
  });
});

describe("individual guards", () => {
  test("task-set mutation is caught in both directions", () => {
    expect(auditTaskSet(population.instanceIds, manifest)).toEqual([]);
    expect(auditTaskSet(population.instanceIds, manifest.slice(3)).length).toBeGreaterThan(0);
    expect(auditTaskSet(population.instanceIds.slice(0, 99), manifest).length).toBeGreaterThan(0);
  });

  test("an added non-frozen instance is caught", () => {
    const intruder = { ...manifest[0]!, instanceId: "not__a-real-1" };
    expect(auditTaskSet(population.instanceIds, [...manifest, intruder]).length).toBeGreaterThan(0);
  });

  test("randomisation drift is caught", () => {
    const orders = assignArmOrders(population.instanceIds);
    expect(auditRandomization(manifest, orders, M213_RANDOMIZATION_SEED)).toEqual([]);
    const reseeded = manifest.map((row) => ({ ...row, seed: "other" }));
    expect(auditRandomization(reseeded, orders, M213_RANDOMIZATION_SEED).length).toBeGreaterThan(0);
    const reordered = manifest.map((row) => ({ ...row, armOrder: ["vexp", "vtrace", "baseline"] as const }));
    expect(auditRandomization(reordered, orders, M213_RANDOMIZATION_SEED).length).toBeGreaterThan(0);
  });

  test("hash guards are silent on the recorded document and fire on any edit", () => {
    expect(auditPreregistrationHash(document, preregistrationHash(document))).toEqual([]);
    expect(auditPreregistrationHash({ ...document, arms: 2 }, preregistrationHash(document)).length)
      .toBeGreaterThan(0);
    expect(auditManifestHash(manifest, manifestHash(manifest))).toEqual([]);
    expect(auditManifestHash(manifest.slice(1), manifestHash(manifest)).length).toBeGreaterThan(0);
  });

  test("only preregistered infrastructure categories can exclude a run", () => {
    for (const category of M213_EXCLUSIONS.legitimate) {
      expect(auditExclusion(category, M213_EXCLUSIONS.legitimate)).toEqual([]);
    }
    for (const outcome of M213_EXCLUSIONS.neverExclusions) {
      expect(auditExclusion(outcome, M213_EXCLUSIONS.legitimate).length).toBeGreaterThan(0);
    }
  });

  test("a cohort cannot be finalised early", () => {
    expect(auditStopping(300, 300)).toEqual([]);
    expect(auditStopping(300, 299).length).toBeGreaterThan(0);
    expect(auditStopping(300, 180).length).toBeGreaterThan(0);
  });

  test("patch-capture exclusions must cover every treatment's state", () => {
    expect(auditPatchCaptureExclusions([".vtrace", ".vexp", ".claude", ".bench-mcp-config.json"]))
      .toEqual([]);
    expect(auditPatchCaptureExclusions([".vexp", ".claude", ".bench-mcp-config.json"])
      .some((issue) => issue.includes(".vtrace"))).toBe(true);
    expect(auditPatchCaptureExclusions([".vtrace", ".claude", ".bench-mcp-config.json"])
      .some((issue) => issue.includes(".vexp"))).toBe(true);
  });

  test("a captured patch carrying treatment state is caught, and a clean one is not", () => {
    expect(auditCapturedPatchPaths(["src/flask/app.py"])).toEqual([]);
    expect(auditCapturedPatchPaths(["src/flask/app.py", ".vtrace/index.sqlite"]).length).toBe(1);
    expect(auditCapturedPatchPaths([".vexp/db"]).length).toBe(1);
    // A source file that merely starts with the same letters is not treatment state.
    expect(auditCapturedPatchPaths([".vtracers/notes.py"])).toEqual([]);
  });

  test("index warmth asymmetry is caught in either direction", () => {
    expect(auditIndexWarmthSymmetry([".claude"])).toEqual([]);
    expect(auditIndexWarmthSymmetry([".vtrace", ".vexp"])).toEqual([]);
    expect(auditIndexWarmthSymmetry([".vexp"]).length).toBe(1);
    expect(auditIndexWarmthSymmetry([".vtrace"]).length).toBe(1);
  });
});
