// Tests for M17 read-only shadow evaluation of the pivot-revision revised patch.
//
// The PURE core (prepare/classify) is tested directly. The orchestrator
// (runEvaluateRevisedPatch) is driven with a STUBBED evaluator over a temp run-label
// tree — no Docker, no external harness — asserting it (a) uses the REVISED patch as the
// eval source, (b) writes shadow-only artifacts, and (c) leaves canonical artifacts byte
// identical.

import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  prepareRevisedShadowEval,
  classifyShadowEval,
  skipReasonToClassification,
  patchHash,
  REVISED_SHADOW_ARTIFACT_FILES,
} from "./revisedPatchShadowEval";
import { parseArgs, runEvaluateRevisedPatch, type ProcessResult } from "./run_stage5_vexp_swe_bench_smoke";
import { REVISION_ARTIFACT_FILES } from "../../src/capsuleV2/pivotRevisionPass";

const ORIGINAL = "diff --git a/a/lead.py b/a/lead.py\n@@ -1 +1 @@\n-old\n+new\n";
const REVISED = "diff --git a/a/lead.py b/a/lead.py\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/a/other.py b/a/other.py\n@@ -1 +1 @@\n-x\n+y\n";

function canonicalRow(patch: string, resolved: unknown = false): Record<string, unknown> {
  return { instanceId: "demo__demo-1", modelPatch: patch, resolved, costUsd: 1.23, numTurns: 5 };
}

// ---- PURE core: prepare ----------------------------------------------------------

test("1. refuses an empty revised patch (skipped/empty)", () => {
  const r = prepareRevisedShadowEval({ canonicalRecords: [canonicalRow(ORIGINAL)], revisedPatch: "   " });
  assert.equal(r.status, "skipped");
  if (r.status === "skipped") {
    assert.equal(r.reason, "empty_revised_patch");
    assert.equal(skipReasonToClassification(r.reason), "shadow_skipped_empty_or_identical");
  }
});

test("2. refuses an identical revised patch (skipped/identical)", () => {
  const r = prepareRevisedShadowEval({ canonicalRecords: [canonicalRow(ORIGINAL)], revisedPatch: ORIGINAL });
  assert.equal(r.status, "skipped");
  if (r.status === "skipped") {
    assert.equal(r.reason, "identical_revised_patch");
    assert.equal(r.originalPatchHash, r.revisedPatchHash);
    assert.equal(skipReasonToClassification(r.reason), "shadow_skipped_empty_or_identical");
  }
});

test("6. handles a missing revised patch gracefully (skipped/missing)", () => {
  const r = prepareRevisedShadowEval({ canonicalRecords: [canonicalRow(ORIGINAL)], revisedPatch: null });
  assert.equal(r.status, "skipped");
  if (r.status === "skipped") {
    assert.equal(r.reason, "missing_revised_patch");
    assert.equal(r.revisedPatchHash, null);
    assert.equal(skipReasonToClassification(r.reason), "shadow_skipped_empty_or_identical");
  }
});

test("5a. a real, differing revised patch is the eval source (modelPatch swapped, resolved reset)", () => {
  const r = prepareRevisedShadowEval({ canonicalRecords: [canonicalRow(ORIGINAL)], revisedPatch: REVISED });
  assert.equal(r.status, "ready");
  if (r.status === "ready") {
    assert.equal(r.instanceId, "demo__demo-1");
    assert.notEqual(r.originalPatchHash, r.revisedPatchHash);
    const row = JSON.parse(r.shadowJsonl.trim()) as Record<string, unknown>;
    assert.equal(row.modelPatch, REVISED); // eval source is the revised patch
    assert.equal(row.resolved, null); // recomputed by the evaluator
    assert.equal(row.instanceId, "demo__demo-1"); // other fields preserved
  }
});

test("prepare is pure/deterministic", () => {
  const a = prepareRevisedShadowEval({ canonicalRecords: [canonicalRow(ORIGINAL)], revisedPatch: REVISED });
  const b = prepareRevisedShadowEval({ canonicalRecords: [canonicalRow(ORIGINAL)], revisedPatch: REVISED });
  assert.deepEqual(a, b);
});

// ---- PURE core: classify ---------------------------------------------------------

test("classify covers every outcome", () => {
  const base = { ran: true, evaluationError: null } as const;
  assert.equal(classifyShadowEval({ ...base, originalResolved: false, revisedResolved: true }), "shadow_resolution_success");
  assert.equal(classifyShadowEval({ ...base, originalResolved: true, revisedResolved: true }), "shadow_preserves_resolution");
  assert.equal(classifyShadowEval({ ...base, originalResolved: false, revisedResolved: false }), "shadow_no_effect");
  assert.equal(classifyShadowEval({ ...base, originalResolved: true, revisedResolved: false }), "shadow_harm");
  assert.equal(classifyShadowEval({ ran: false, evaluationError: "boom", originalResolved: false, revisedResolved: "unknown" }), "shadow_inconclusive");
  assert.equal(classifyShadowEval({ ...base, originalResolved: "unknown", revisedResolved: true }), "shadow_inconclusive");
});

// ---- 7. structural: shadow eval cannot change retrieval/ranking -------------------

test("7. shadow-eval core imports nothing from retrieval/ranking/scoring/candidate code", async () => {
  const src = await readFile(path.join(import.meta.dir, "revisedPatchShadowEval.ts"), "utf8");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
  // Only node:crypto — no capsule retrieval/ranking/scoring/candidate/parser/index modules.
  assert.deepEqual(imports, ["node:crypto"]);
  for (const bad of ["ranking", "retriev", "scoring", "candidate", "parser", "index", "capsuleV2", "capsule/"]) {
    assert.ok(!imports.some((i) => i.includes(bad)), `unexpected import containing ${bad}`);
  }
});

// ---- orchestrator over a temp run tree (stubbed evaluator) ------------------------

async function makeRunTree(opts: { revised: string | null }): Promise<{ out: string; vexp: string; label: string; vtraceDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "m17-shadow-"));
  const out = path.join(root, "results");
  const label = "eval-m17-test-r1";
  const vtraceDir = path.join(out, "runs", label, "raw", "vtrace");
  await mkdir(vtraceDir, { recursive: true });
  // Canonical artifacts.
  await writeFile(path.join(vtraceDir, "swebench-2026-01-01.jsonl"), JSON.stringify(canonicalRow(ORIGINAL, false)) + "\n");
  await writeFile(path.join(vtraceDir, "_eval.meta.json"), JSON.stringify({ resolvedCount: 0 }) + "\n");
  await writeFile(path.join(vtraceDir, REVISION_ARTIFACT_FILES.record), JSON.stringify({ ran: true }) + "\n");
  await writeFile(path.join(vtraceDir, REVISION_ARTIFACT_FILES.originalPatch), ORIGINAL);
  if (opts.revised !== null) await writeFile(path.join(vtraceDir, REVISION_ARTIFACT_FILES.revisedPatch), opts.revised);
  // Dummy external CLI so the pathExists(cliPath) guard passes.
  const vexp = path.join(root, "vexp");
  await mkdir(path.join(vexp, "dist"), { recursive: true });
  await writeFile(path.join(vexp, "dist", "cli.js"), "// stub\n");
  return { out, vexp, label, vtraceDir };
}

function configFor(out: string, vexp: string, label: string) {
  return parseArgs(["--mode", "evaluate-revised-patch", "--vexp-swe-bench-dir", vexp, "--out", out, "--run-label", label]);
}

// Stub evaluator: behaves like the external `evaluate <jsonl>` — reads the JSONL it is
// given, marks rows resolved=true, writes back in place. Captures the patch it saw.
function stubEvaluator(captured: { patch?: unknown; file?: string }) {
  return async (_command: string, args: readonly string[]): Promise<ProcessResult> => {
    const file = args[2]!; // [cliEntry, "evaluate", <resultsFile>, ...]
    captured.file = file;
    const content = await readFile(file, "utf8");
    const rows = content.split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
    if (rows[0]) captured.patch = rows[0].modelPatch;
    const mutated = rows.map((r) => ({ ...r, resolved: true }));
    await writeFile(file, mutated.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("5b. orchestrator hands the REVISED patch to the evaluator and resolves it", async () => {
  const { out, vexp, label, vtraceDir } = await makeRunTree({ revised: REVISED });
  const captured: { patch?: unknown; file?: string } = {};
  const evidence = await runEvaluateRevisedPatch(configFor(out, vexp, label), { runProcess: stubEvaluator(captured) });
  assert.equal(evidence.length, 1);
  const se = evidence[0]!.shadowEval;
  assert.equal(captured.patch, REVISED); // eval source was the revised patch
  // The evaluator was pointed at the shadow JSONL, not the canonical one.
  assert.ok(captured.file!.endsWith(REVISED_SHADOW_ARTIFACT_FILES.shadowJsonl));
  assert.equal(se.status, "evaluated");
  assert.equal(se.evaluationRan, true);
  assert.equal(se.resolved, true);
  assert.equal(se.originalCanonicalResolved, false);
  assert.equal(se.classification, "shadow_resolution_success");
  assert.equal(se.canonicalArtifactsUntouched, true);
});

test("3. orchestrator leaves the canonical modelPatch / JSONL untouched", async () => {
  const { out, vexp, label, vtraceDir } = await makeRunTree({ revised: REVISED });
  const canonicalPath = path.join(vtraceDir, "swebench-2026-01-01.jsonl");
  const before = await readFile(canonicalPath, "utf8");
  const evidence = await runEvaluateRevisedPatch(configFor(out, vexp, label), { runProcess: stubEvaluator({}) });
  const after = await readFile(canonicalPath, "utf8");
  assert.equal(after, before); // canonical JSONL byte-identical
  const canonicalRowAfter = JSON.parse(after.trim()) as Record<string, unknown>;
  assert.equal(canonicalRowAfter.modelPatch, ORIGINAL); // canonical patch unchanged
  assert.equal(canonicalRowAfter.resolved, false); // canonical resolved unchanged
  assert.equal(evidence[0]!.shadowEval.canonicalArtifactsUntouched, true);
});

test("4. orchestrator writes SEPARATE shadow artifacts (meta + shadow jsonl)", async () => {
  const { out, vexp, label, vtraceDir } = await makeRunTree({ revised: REVISED });
  await runEvaluateRevisedPatch(configFor(out, vexp, label), { runProcess: stubEvaluator({}) });
  const files = await readdir(vtraceDir);
  assert.ok(files.includes(REVISED_SHADOW_ARTIFACT_FILES.meta));
  assert.ok(files.includes(REVISED_SHADOW_ARTIFACT_FILES.shadowJsonl));
  // Canonical artifacts still present.
  assert.ok(files.some((f) => /^swebench-.*\.jsonl$/.test(f)));
  assert.ok(files.includes(REVISION_ARTIFACT_FILES.revisedPatch));
  const meta = JSON.parse(await readFile(path.join(vtraceDir, REVISED_SHADOW_ARTIFACT_FILES.meta), "utf8")) as { shadowEval: Record<string, unknown> };
  assert.equal(meta.shadowEval.sourcePatch, "pivot_revision_revised");
  assert.equal(meta.shadowEval.sourceRunLabel, label);
});

test("6b. orchestrator records a skip (not an eval) when the revised patch is absent", async () => {
  const { out, vexp, label } = await makeRunTree({ revised: null });
  let called = 0;
  const evidence = await runEvaluateRevisedPatch(configFor(out, vexp, label), {
    runProcess: async () => { called++; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(called, 0); // never invokes Docker
  assert.equal(evidence.length, 1);
  const se = evidence[0]!.shadowEval;
  assert.equal(se.status, "skipped");
  assert.equal(se.skipReason, "missing_revised_patch");
  assert.equal(se.classification, "shadow_skipped_empty_or_identical");
  assert.equal(se.canonicalArtifactsUntouched, true);
});
