// Tests for the M14 revision-pass ORCHESTRATOR (executePivotRevisionPass).
//
// Drives the orchestrator with a STUBBED second pass (no live agents, no Docker, no
// external harness) over a temp dir, validating: a compliant verdict records a no-run
// and never calls the second pass; a non-compliant verdict runs it, persists the
// original + revised patches in SEPARATE artifact files, and replaces the final patch
// only on a strict compliance improvement (and calls installFinalPatch then).

import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executePivotRevisionPass } from "./run_stage5_vexp_swe_bench_smoke";
import { buildPivotInspectionContract } from "../../src/capsuleV2/pivotInspectionContract";
import { computePivotInspectionCompliance } from "../../src/capsuleV2/pivotInspectionCompliance";
import { REVISION_ARTIFACT_FILES } from "../../src/capsuleV2/pivotRevisionPass";

function contract() {
  return buildPivotInspectionContract(
    [{ path: "a/lead.py", symbol: "lead" }, { path: "a/other.py", symbol: "other" }],
    [],
  );
}
function nonCompliant() {
  return computePivotInspectionCompliance({
    enabled: true, contract: contract(),
    editedFiles: ["a/lead.py"], inspectedFiles: ["a/other.py"],
  });
}
function compliant() {
  return computePivotInspectionCompliance({
    enabled: true, contract: contract(),
    editedFiles: ["a/lead.py", "a/other.py"], inspectedFiles: [],
  });
}
const ORIGINAL = "diff --git a/a/lead.py b/a/lead.py\n@@ -1 +1 @@\n-old\n+new\n";
const REVISED = "diff --git a/a/lead.py b/a/lead.py\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/a/other.py b/a/other.py\n@@ -1 +1 @@\n-x\n+y\n";

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "m14-rev-")); }

test("compliant first patch ⇒ no-run record, second pass never called", async () => {
  const dir = await tmp();
  let called = 0;
  const rec = await executePivotRevisionPass({
    decisionInput: {
      revisionPassEnabled: true, enforcementEnabled: true, capsuleV2Injected: true,
      hasModelPatch: true, complianceBefore: compliant(),
    },
    originalPatch: ORIGINAL, outputDir: dir,
    runSecondPass: async () => { called++; return { revisedPatch: null, revisionResponse: null, complianceAfter: null }; },
  });
  assert.equal(called, 0);
  assert.equal(rec.ran, false);
  assert.equal(rec.replacedFinalPatch, false);
  // record + original persisted; no revised patch file
  const files = await readdir(dir);
  assert.ok(files.includes(REVISION_ARTIFACT_FILES.record));
  assert.ok(files.includes(REVISION_ARTIFACT_FILES.originalPatch));
  assert.ok(!files.includes(REVISION_ARTIFACT_FILES.revisedPatch));
});

test("non-compliant + improving revision ⇒ runs, persists separately, replaces", async () => {
  const dir = await tmp();
  let installed: string | null = null;
  const rec = await executePivotRevisionPass({
    decisionInput: {
      revisionPassEnabled: true, enforcementEnabled: true, capsuleV2Injected: true,
      hasModelPatch: true, complianceBefore: nonCompliant(),
    },
    originalPatch: ORIGINAL, outputDir: dir,
    runSecondPass: async (prompt) => {
      assert.match(prompt, /You previously produced this patch\./); // prompt carries patch
      return { revisedPatch: REVISED, revisionResponse: "revised: edited a/other.py", complianceAfter: compliant() };
    },
    installFinalPatch: async (p) => { installed = p; },
  });
  assert.equal(rec.ran, true);
  assert.equal(rec.replacedFinalPatch, true);
  assert.equal(installed, REVISED);
  // original and revised persisted in SEPARATE files with the right contents
  assert.equal(await readFile(path.join(dir, REVISION_ARTIFACT_FILES.originalPatch), "utf8"), ORIGINAL);
  assert.equal(await readFile(path.join(dir, REVISION_ARTIFACT_FILES.revisedPatch), "utf8"), REVISED);
  const persisted = JSON.parse(await readFile(path.join(dir, REVISION_ARTIFACT_FILES.record), "utf8"));
  assert.equal(persisted.originalPatch, ORIGINAL);
  assert.equal(persisted.revisedPatch, REVISED);
  assert.equal(persisted.replacedFinalPatch, true);
});

test("non-compliant but non-improving revision ⇒ runs but keeps original", async () => {
  const dir = await tmp();
  let installed = 0;
  const rec = await executePivotRevisionPass({
    decisionInput: {
      revisionPassEnabled: true, enforcementEnabled: true, capsuleV2Injected: true,
      hasModelPatch: true, complianceBefore: nonCompliant(),
    },
    originalPatch: ORIGINAL, outputDir: dir,
    // revision did not improve compliance (still non-compliant)
    runSecondPass: async () => ({ revisedPatch: REVISED, revisionResponse: null, complianceAfter: nonCompliant() }),
    installFinalPatch: async () => { installed++; },
  });
  assert.equal(rec.ran, true);
  assert.equal(rec.replacedFinalPatch, false);
  assert.equal(installed, 0); // never installed when not improving
  assert.equal(rec.originalPatch, ORIGINAL); // original preserved
});

test("M15: first-pass assistant text path + markers + test expectation are persisted in the record", async () => {
  const dir = await tmp();
  const rec = await executePivotRevisionPass({
    decisionInput: {
      revisionPassEnabled: true, enforcementEnabled: true, capsuleV2Injected: true,
      hasModelPatch: true, complianceBefore: nonCompliant(),
    },
    originalPatch: ORIGINAL, outputDir: dir,
    testExpectation: { failToPass: ["tests/test_x.py::test_empty"], source: "instance_metadata" },
    firstPassAssistantTextPath: path.join(dir, REVISION_ARTIFACT_FILES.firstPassAssistant),
    firstPassPivotDecisions: [{ path: "a/other.py", decision: "RULED_OUT", evidence: "off the changed code path" }],
    runSecondPass: async () => ({ revisedPatch: null, revisionResponse: null, complianceAfter: nonCompliant() }),
  });
  assert.equal(rec.ran, true);
  const persisted = JSON.parse(await readFile(path.join(dir, REVISION_ARTIFACT_FILES.record), "utf8"));
  assert.ok(String(persisted.firstPassAssistantTextPath).endsWith(REVISION_ARTIFACT_FILES.firstPassAssistant));
  assert.equal(persisted.firstPassPivotDecisions[0].decision, "RULED_OUT");
  assert.equal(persisted.testExpectation.source, "instance_metadata");
  assert.equal(persisted.testExpectation.failToPass[0], "tests/test_x.py::test_empty");
});

test("M15: missing first-pass assistant text is handled gracefully (null path)", async () => {
  const dir = await tmp();
  const rec = await executePivotRevisionPass({
    decisionInput: {
      revisionPassEnabled: true, enforcementEnabled: true, capsuleV2Injected: true,
      hasModelPatch: true, complianceBefore: nonCompliant(),
    },
    originalPatch: ORIGINAL, outputDir: dir,
    firstPassAssistantTextPath: null,
    runSecondPass: async () => ({ revisedPatch: null, revisionResponse: null, complianceAfter: nonCompliant() }),
  });
  const persisted = JSON.parse(await readFile(path.join(dir, REVISION_ARTIFACT_FILES.record), "utf8"));
  assert.equal(persisted.firstPassAssistantTextPath, null);
  assert.deepEqual(persisted.firstPassPivotDecisions, []);
});
