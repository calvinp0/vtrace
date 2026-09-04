/**
 * M215 §53 — the falsification suite, run as a test.
 *
 * The suite itself is the evidence; this file makes it fail a build rather than
 * only a report, and adds the two properties a suite cannot check about itself:
 * that it contains both kinds of control, and that removing a guard makes it
 * fail. A suite that only ever passes is indistinguishable from one that cannot.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import {
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import {
  type M215Control,
  runM215FalsificationSuite,
  suitePasses,
} from "./m215Falsification";
import {
  M215_ADAPTER_BINDINGS,
  assertBindingUsable,
  authoritativeBindingAvailable,
  bindingFor,
} from "./m215AdapterBindings";

const RESULTS_DIR = join(import.meta.dir, "results");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

const preregistrationDocument = readJson(M215_PREREGISTRATION_FILE);
const manifestDocument = readJson(M215_MANIFEST_FILE) as unknown as {
  rows: RunManifestRow[]; manifestHash: string;
};
const externalReferenceDocument = readJson(M215_EXTERNAL_REFERENCE_FILE);
const authorities = verifyFrozenAuthorities(
  preregistrationDocument, manifestDocument, externalReferenceDocument,
);
const observedVtraceProductTreeSha = execFileSync(
  "git", ["-C", join(import.meta.dir, "..", ".."), "rev-parse", "HEAD:src"],
).toString().trim();

let cached: readonly M215Control[] | null = null;

async function controls(): Promise<readonly M215Control[]> {
  if (cached === null) {
    cached = await runM215FalsificationSuite({
      authorities,
      preregistrationDocument,
      manifestDocument,
      externalReferenceDocument,
      observedVtraceProductTreeSha,
    });
  }
  return cached;
}

describe("M215 falsification suite", () => {
  test("every control is satisfied", async () => {
    const entries = await controls();
    const failures = entries.filter((entry) => !entry.satisfied);
    expect(failures.map((entry) => `${entry.id}: ${entry.detail}`)).toEqual([]);
    expect(suitePasses(entries)).toBe(true);
  }, 300_000);

  test("the suite carries both kinds of control", async () => {
    const entries = await controls();
    const fires = entries.filter((entry) => entry.expectation === "GUARD_FIRES");
    const silent = entries.filter((entry) => entry.expectation === "GUARD_SILENT");
    // Negative controls are what distinguish a working suite from one whose
    // guards fire on everything.
    expect(fires.length).toBeGreaterThan(20);
    expect(silent.length).toBeGreaterThan(10);
  }, 300_000);

  test("the prompt's numbered controls are all present", async () => {
    const ids = (await controls()).map((entry) => entry.id);
    const required = [
      "F1_PREREGISTRATION_MUTATION", "F2_MANIFEST_MUTATION", "F3_EXTERNAL_REFERENCE_MUTATION",
      "F4_INVALID_ARM_VEXP", "F5_TASK_OUTSIDE_MANIFEST", "F6_MODEL_MISMATCH",
      "F7_AGENT_VERSION_MISMATCH", "F8_NATIVE_TOOL_DRIFT", "F9_PROMPT_DRIFT",
      "F10_TREATMENT_IDENTITY_DRIFT", "F11_MISSING_TREATMENT_TOOL", "F12_BASELINE_CONTAMINATION",
      "F13_SOURCE_MUTATED_BY_TREATMENT", "F14_PATCH_INIT_ROUTE", "F15_PATCH_INDEX_ONLY_ROUTE",
      "F16_REAL_SOURCE_EDIT", "F17_CONVERSATION_REUSE", "F18_PATCH_REUSE",
      "F19_EXECUTION_ORDER_VIOLATION", "F20_DUPLICATE_VALID_OUTCOME",
      "F21_INFRASTRUCTURE_RETRY_PERMITTED", "F22_VALID_OUTCOME_RETRY_REFUSED",
      "F23_EARLY_FINAL_ANALYSIS", "F24_TREATMENT_EXPOSED_NEVER_USED",
      "F25_TREATMENT_INITIALISATION_FAILURE", "F26_GOLD_LEAKAGE", "F27_SPEND_CEILING",
      "F28_NO_SPEND_AUTHORIZATION", "F29_SYNTHETIC_MODE_ISOLATION", "F30_RESULT_MUTATION",
      "F31_RUNTIME_GATE_OMISSION", "F32_PROVIDER_IDENTITY_ABSENT",
      "F33_EVALUATION_FAILURE_IS_NOT_UNRESOLVED", "F34_ARM_BUDGET_ASYMMETRY", "F35_RESUME",
      "F36_OPERATOR_ROW_SELECTION", "F37_SECRET_LEAKAGE", "F38_RESULT_ARM_MISMATCH",
      "F39_EXTERNAL_VEXP_IN_PAIRED_ANALYSIS", "F40_RESET_PRESERVES_TREATMENT_STATE",
    ];
    expect(required.filter((id) => !ids.includes(id))).toEqual([]);
  }, 300_000);

  test("the historical defect controls reproduce M213 and M214's own findings", async () => {
    const entries = await controls();
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    // The old behaviour must FAIL a control the M215 path passes; without this,
    // the executor could bypass M214's repair with every other control green.
    for (const id of [
      "H1_LEGACY_PATCH_CAPTURE_LEAKS_TREATMENT_STATE",
      "H2_TREATMENT_METADATA_WARM_ASYMMETRY",
      "H3_SNAPSHOT_BEFORE_TREATMENT_INITIALISATION",
    ]) {
      expect(byId.get(id)?.expectation).toBe("GUARD_FIRES");
      expect(byId.get(id)?.fired).toBe(true);
    }
    expect(byId.get("H3B_EXECUTOR_USES_THE_REPAIRED_ORDER")?.fired).toBe(false);
    expect(byId.get("F14_PATCH_INIT_ROUTE")?.fired).toBe(false);
    expect(byId.get("F15_PATCH_INDEX_ONLY_ROUTE")?.fired).toBe(false);
  }, 300_000);
});

describe("adapter bindings", () => {
  test("only the synthetic binding is implemented, and it is not authoritative", () => {
    expect(bindingFor("SYNTHETIC").status).toBe("IMPLEMENTED");
    expect(bindingFor("SYNTHETIC").authoritative).toBe(false);
    expect(bindingFor("DOCKER_SWEBENCH").status).toBe("DECLARED_UNIMPLEMENTED");
    expect(authoritativeBindingAvailable()).toBe(false);
  });

  test("an unimplemented binding fails closed rather than falling back to fakes", () => {
    expect(() => assertBindingUsable("DOCKER_SWEBENCH")).toThrow(/DECLARED_UNIMPLEMENTED/);
    expect(() => assertBindingUsable("SYNTHETIC")).not.toThrow();
  });

  test("the unimplemented binding names the work it is waiting on", () => {
    const binding = bindingFor("DOCKER_SWEBENCH");
    expect(binding.outstandingWork.length).toBeGreaterThan(0);
    expect(binding.inheritedFrom).toContain("m193_container_adapter.py");
    expect(M215_ADAPTER_BINDINGS).toHaveLength(2);
  });
});
