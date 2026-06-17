// Tests for the M31 read-only context/actionability scorecard helper. Pure-function only:
// no Docker, no live agents, no command execution, no artifact mutation. Synthetic inputs.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  UNKNOWN,
  buildRunRecord,
  changedFilesFromPatch,
  classifyPivotCompliance,
  classifyRevisionDelta,
  classifyVerifier,
  deriveToolCounts,
  emptyArtifacts,
  parsePairRole,
  primaryClassification,
  sha256Hex,
} from "./run_stage5_m31_context_actionability_scorecard";

const PYTHON_ONLY_PATCH = `diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py
index 3ca730e..ca3457a 100644
--- a/sphinx/domains/python.py
+++ b/sphinx/domains/python.py
@@ -1,1 +1,1 @@
-old
+new
`;

const PYTHON_AND_AST_PATCH = `diff --git a/sphinx/domains/python.py b/sphinx/domains/python.py
index 3ca730e..ca3457a 100644
--- a/sphinx/domains/python.py
+++ b/sphinx/domains/python.py
@@ -1,1 +1,1 @@
-old
+new
diff --git a/sphinx/pycode/ast.py b/sphinx/pycode/ast.py
index aaa..bbb 100644
--- a/sphinx/pycode/ast.py
+++ b/sphinx/pycode/ast.py
@@ -2,1 +2,1 @@
-x
+y
`;

describe("M31 scorecard — category 1: missing run directory handled as unknown", () => {
  it("an empty artifacts bundle yields an all-unknown record classified unknown", () => {
    const rec = buildRunRecord("eval-does-not-exist", emptyArtifacts(), null);
    expect(rec.classification).toBe("unknown");
    expect(rec.condition).toBe(UNKNOWN);
    expect(rec.conditionRole).toBe("unknown");
    expect(rec.instanceId).toBe(UNKNOWN);
    expect(rec.patchProduced).toBe(UNKNOWN);
    expect(rec.resolved).toBe(UNKNOWN);
    expect(rec.tools.totalToolCalls).toBe(UNKNOWN);
    expect(rec.tools.source).toBe("unknown");
    expect(rec.modelPatchFiles).toEqual([]);
    expect(rec.pivotFiles).toEqual([]);
  });
});

describe("M31 scorecard — category 2: patch hashes + changed files", () => {
  it("sha256Hex is deterministic and distinguishes different patches", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex(PYTHON_ONLY_PATCH)).not.toBe(sha256Hex(PYTHON_AND_AST_PATCH));
    // known SHA-256 of the literal string "abc"
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("changedFilesFromPatch extracts the b/ side, sorted + de-duped", () => {
    expect(changedFilesFromPatch(PYTHON_ONLY_PATCH)).toEqual(["sphinx/domains/python.py"]);
    expect(changedFilesFromPatch(PYTHON_AND_AST_PATCH)).toEqual([
      "sphinx/domains/python.py",
      "sphinx/pycode/ast.py",
    ]);
    expect(changedFilesFromPatch("")).toEqual([]);
    expect(changedFilesFromPatch(null)).toEqual([]);
  });
});

describe("M31 scorecard — category 3: tool-call counts from captured calls", () => {
  it("prefers the captured summary when present", () => {
    const counts = deriveToolCounts(
      {
        totalToolCalls: 18,
        bashToolCalls: 8,
        grepLikeToolCalls: 4,
        fileReadToolCalls: 4,
        fileWriteToolCalls: 2,
        uniqueFilesTouchedByTools: 4,
      },
      null,
    );
    expect(counts.source).toBe("summary");
    expect(counts.totalToolCalls).toBe(18);
    expect(counts.grepLikeToolCalls).toBe(4);
    expect(counts.uniqueFilesTouchedByTools).toBe(4);
  });
  it("recomputes from the raw tool-call log when no summary exists", () => {
    const counts = deriveToolCounts(null, [
      { tool: "Grep", category: "search", args: { pattern: "x" } },
      { tool: "Read", category: "read", path: "a.py" },
      { tool: "Read", category: "read", path: "a.py" },
      { tool: "Bash", category: "bash", args: {} },
      { tool: "Edit", category: "edit", args: { file_path: "b.py" } },
    ]);
    expect(counts.source).toBe("raw_tool_calls");
    expect(counts.totalToolCalls).toBe(5);
    expect(counts.grepLikeToolCalls).toBe(1);
    expect(counts.fileReadToolCalls).toBe(2);
    expect(counts.bashToolCalls).toBe(1);
    expect(counts.fileWriteToolCalls).toBe(1);
    expect(counts.uniqueFilesTouchedByTools).toBe(2); // a.py (deduped) + b.py
  });
  it("returns unknown (not zero) when neither source is available", () => {
    const counts = deriveToolCounts(null, null);
    expect(counts.totalToolCalls).toBe(UNKNOWN);
    expect(counts.bashToolCalls).toBe(UNKNOWN);
    expect(counts.source).toBe("unknown");
  });
});

describe("M31 scorecard — category 4: pivot inspected/edited classification", () => {
  it("reads required/edited/ruledOut/ruleOutConflict from complianceAfter", () => {
    const c = classifyPivotCompliance({
      complianceAfter: {
        enabled: true,
        required: [{ path: "sphinx/pycode/ast.py", symbol: "unparse" }],
        edited: ["sphinx/pycode/ast.py::unparse"],
        ruledOut: [],
        unclear: [],
        missing: [],
        ruleOutConflicts: [],
      },
    });
    expect(c.enabled).toBe(true);
    expect(c.requiredPivots).toEqual(["sphinx/pycode/ast.py::unparse"]);
    expect(c.edited).toEqual(["sphinx/pycode/ast.py::unparse"]);
    expect(c.inspected).toBe(true); // edited >= 1
    expect(c.ruleOutConflict).toBe(false);
  });
  it("flags a rule-out conflict and treats an unclear-only pivot as not inspected", () => {
    const c = classifyPivotCompliance({
      complianceAfter: {
        enabled: true,
        required: [{ path: "sphinx/pycode/ast.py", symbol: "unparse" }],
        edited: [],
        ruledOut: [],
        unclear: ["sphinx/pycode/ast.py::unparse"],
        missing: [],
        ruleOutConflicts: [{ id: "sphinx/pycode/ast.py::unparse" }],
      },
    });
    expect(c.ruleOutConflict).toBe(true);
    expect(c.inspected).toBe(false); // neither edited nor ruled out
    expect(c.unclear).toEqual(["sphinx/pycode/ast.py::unparse"]);
  });
  it("empty/missing record yields a disabled, empty compliance", () => {
    const c = classifyPivotCompliance(null);
    expect(c.enabled).toBe(false);
    expect(c.inspected).toBe(UNKNOWN);
    expect(c.requiredPivots).toEqual([]);
  });
});

describe("M31 scorecard — category 5: revision delta classification", () => {
  it("revised patch newly touching a missed required pivot = revision_helped_actionability", () => {
    const d = classifyRevisionDelta({
      ran: true,
      originalPatch: PYTHON_ONLY_PATCH,
      revisedPatch: PYTHON_AND_AST_PATCH,
      complianceAfter: {
        required: [{ path: "sphinx/pycode/ast.py", symbol: "unparse" }],
        edited: [],
        ruledOut: [],
        unclear: ["sphinx/pycode/ast.py::unparse"],
        missing: [],
        ruleOutConflicts: [],
      },
    });
    expect(d.revisionRan).toBe(true);
    expect(d.revisionChanged).toBe(true);
    expect(d.revisedTouchesMissedPivot).toBe(true);
    expect(d.classification).toBe("revision_helped_actionability");
  });
  it("byte-identical revision = revision_noop", () => {
    const d = classifyRevisionDelta({
      ran: true,
      originalPatch: PYTHON_ONLY_PATCH,
      revisedPatch: PYTHON_ONLY_PATCH,
      complianceAfter: { required: [{ path: "sphinx/pycode/ast.py", symbol: "unparse" }] },
    });
    expect(d.revisionChanged).toBe(false);
    expect(d.classification).toBe("revision_noop");
  });
  it("changed-but-pivot-still-missing revision = revision_noop", () => {
    const otherPatch = PYTHON_ONLY_PATCH.replace("+new", "+other");
    const d = classifyRevisionDelta({
      ran: true,
      originalPatch: PYTHON_ONLY_PATCH,
      revisedPatch: otherPatch,
      complianceAfter: { required: [{ path: "sphinx/pycode/ast.py", symbol: "unparse" }] },
    });
    expect(d.revisionChanged).toBe(true);
    expect(d.revisedTouchesMissedPivot).toBe(false);
    expect(d.classification).toBe("revision_noop");
  });
  it("no revision recorded = n/a", () => {
    expect(classifyRevisionDelta(null).classification).toBe("n/a");
    expect(classifyRevisionDelta({ ran: false }).classification).toBe("n/a");
  });
});

describe("M31 scorecard — category 6: verifier is diagnostic, never implies resolution", () => {
  it("both patch sides present = non_discriminative_verifier, no resolution implied", () => {
    const v = classifyVerifier([
      "_agent_test_command_verify.original_model_patch.meta.json",
      "_agent_test_command_verify.pivot_revision_revised.meta.json",
    ]);
    expect(v.classification).toBe("non_discriminative_verifier");
    expect(v.impliesResolution).toBe(false);
    // The verifier result object must never carry a resolution/grading field.
    expect(Object.keys(v)).not.toContain("resolved");
    expect(Object.keys(v)).not.toContain("resolvedCount");
  });
  it("single-sided verify artifact = verification_diagnostic_only, no resolution implied", () => {
    const v = classifyVerifier(["_agent_test_command_verify.meta.json"]);
    expect(v.classification).toBe("verification_diagnostic_only");
    expect(v.impliesResolution).toBe(false);
  });
  it("no verify artifacts = n/a", () => {
    const v = classifyVerifier([]);
    expect(v.verifierRan).toBe(false);
    expect(v.classification).toBe("n/a");
    expect(v.impliesResolution).toBe(false);
  });
  it("a diagnostic-only verified run is never promoted to a resolution claim", () => {
    // Build a record whose only verifier signal is diagnostic; resolution stays whatever the
    // canonical row said (here unknown) and is NOT inferred from the verifier.
    const art = emptyArtifacts();
    art.condition = "vtrace";
    art.verifyFiles = ["_agent_test_command_verify.meta.json"];
    const rec = buildRunRecord("eval-x", art, null);
    expect(rec.verifier.impliesResolution).toBe(false);
    expect(rec.resolved).toBe(UNKNOWN); // not fabricated from the verifier
    expect(rec.classification).toBe("verification_diagnostic_only");
  });
});

describe("M31 scorecard — category 7: no Docker / live-agent / command execution in the helper", () => {
  it("the helper source imports no process-spawning API and invokes none", () => {
    const src = readFileSync(
      path.join(import.meta.dir, "run_stage5_m31_context_actionability_scorecard.ts"),
      "utf8",
    );
    // No child-process import, no spawn/exec invocation, no docker SDK usage.
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/\bspawn(Sync)?\s*\(/);
    expect(src).not.toMatch(/\bexec(Sync|File|FileSync)?\s*\(/);
    expect(src).not.toMatch(/Bun\.spawn/);
    expect(src).not.toMatch(/import\s+.*\bdocker\b/);
    // The runner's Docker-verify flag must never be passed by this read-only helper.
    expect(src).not.toMatch(/argv.*allow-docker-verify/);
  });
});

describe("M31 scorecard — pairing helper", () => {
  it("derives matching pairKeys for baseline and current-clean of the same instance", () => {
    const b = parsePairRole("eval-bounded20-baseline-django-11728-r1");
    const t = parsePairRole("eval-bounded20-current-clean-django-11728-r3");
    expect(b.role).toBe("baseline");
    expect(t.role).toBe("treatment");
    expect(b.pairKey).toBe(t.pairKey);
    expect(b.family).toBe("bounded20");
  });
  it("control (baseline) records classify as control", () => {
    const art = emptyArtifacts();
    art.condition = "baseline";
    const rec = buildRunRecord("eval-bounded20-baseline-django-11728-r1", art, null);
    expect(rec.conditionRole).toBe("control");
    expect(primaryClassification(rec)).toBe("control");
  });
});
