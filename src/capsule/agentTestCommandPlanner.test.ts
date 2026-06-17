import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildAgentTestCommandPlan,
  classifyCommandSafety,
  deriveExpectedImageKey,
  type BuildPlanInput,
  type PlanCommandCandidate,
} from "./agentTestCommandPlanner";
import type { TestFramework, VerificationProvenance } from "./toolOutputCapture";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function provenance(
  classification: VerificationProvenance["classification"],
  allowed: boolean,
): VerificationProvenance {
  return {
    classification,
    evidence: [`provenance=${classification}`],
    allowedForFairVerification: allowed,
    ...(allowed ? {} : { disallowReason: `not ${classification}-fair` }),
  };
}

function candidate(overrides: Partial<PlanCommandCandidate> = {}): PlanCommandCandidate {
  return {
    command: "python -m pytest tests/test_x.py::test_y",
    framework: "pytest" as TestFramework,
    selectedTests: ["tests/test_x.py::test_y"],
    provenance: provenance("agent_discovered", true),
    parsedOutcomeStatus: "passed",
    ...overrides,
  };
}

function planInput(overrides: Partial<BuildPlanInput> = {}): BuildPlanInput {
  return {
    sourceRunLabel: "label-1",
    instanceId: "django__django-12345",
    patchSource: "pivot_revision_revised",
    patchPath: "/runs/label-1/raw/vtrace/_pivot_revision_revised.patch",
    patchText: "diff --git a/x b/x\n",
    commandSource: "pivot_revision_test_commands",
    candidates: [candidate()],
    imagePlan: deriveExpectedImageKey({ instanceId: "django__django-12345" }),
    plannedArtifacts: ["/runs/label-1/raw/vtrace/_agent_test_command_plan.json"],
    ...overrides,
  };
}

describe("agentTestCommandPlanner — patch resolution", () => {
  it("1. resolves the original model patch hash", () => {
    const text = "diff --git a/foo.py b/foo.py\n@@ -1 +1 @@\n-old\n+new\n";
    const plan = buildAgentTestCommandPlan(
      planInput({ patchSource: "original_model_patch", patchText: text, patchPath: "/p/original.patch" }),
    );
    expect(plan.patchSource).toBe("original_model_patch");
    expect(plan.patchSha256).toBe(sha256(text));
    expect(plan.patchPath).toBe("/p/original.patch");
  });

  it("2. resolves the pivot revision patch hash", () => {
    const text = "diff --git a/bar.py b/bar.py\n@@ -2 +2 @@\n-a\n+b\n";
    const plan = buildAgentTestCommandPlan(
      planInput({ patchSource: "pivot_revision_revised", patchText: text }),
    );
    expect(plan.patchSource).toBe("pivot_revision_revised");
    expect(plan.patchSha256).toBe(sha256(text));
    // The two known patch sources hash differently when their text differs.
    const other = buildAgentTestCommandPlan(planInput({ patchText: "diff --git a/z b/z\n" }));
    expect(other.patchSha256).not.toBe(plan.patchSha256);
  });

  it("3. missing revised patch produces a graceful blocker (no throw)", () => {
    const plan = buildAgentTestCommandPlan(planInput({ patchText: null, patchPath: null }));
    expect(plan.patchSha256).toBeNull();
    expect(plan.blockers).toContain('patch source "pivot_revision_revised" artifact not found');
    expect(plan.eligibleForFutureExecution).toBe(false);
  });
});

describe("agentTestCommandPlanner — provenance gating", () => {
  it("4. an injected_metadata command is ineligible", () => {
    const plan = buildAgentTestCommandPlan(
      planInput({ candidates: [candidate({ provenance: provenance("injected_metadata", false) })] }),
    );
    expect(plan.fairProvenance.classification).toBe("injected_metadata");
    expect(plan.fairProvenance.allowedForFairVerification).toBe(false);
    expect(plan.eligibleForFutureExecution).toBe(false);
    expect(plan.blockers).toContain(
      'provenance "injected_metadata" is not allowed for fair verification',
    );
  });

  it("5. an agent_discovered command is eligible when every other gate passes", () => {
    const plan = buildAgentTestCommandPlan(planInput());
    expect(plan.fairProvenance.classification).toBe("agent_discovered");
    expect(plan.commandSafety.allowed).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.eligibleForFutureExecution).toBe(true);
  });

  it("6. ambiguous and unknown provenance are ineligible", () => {
    for (const cls of ["ambiguous", "unknown"] as const) {
      const plan = buildAgentTestCommandPlan(
        planInput({ candidates: [candidate({ provenance: provenance(cls, false) })] }),
      );
      expect(plan.eligibleForFutureExecution).toBe(false);
      expect(plan.blockers).toContain(
        `provenance "${cls}" is not allowed for fair verification`,
      );
    }
  });
});

describe("agentTestCommandPlanner — command safety", () => {
  it("7. a piped command is diagnosticOnly and not fair-allowed", () => {
    const safety = classifyCommandSafety("python -m pytest tests/test_x.py -xvs 2>&1 | head -50");
    expect(safety.allowed).toBe(false);
    expect(safety.diagnosticOnly).toBe(true);

    const plan = buildAgentTestCommandPlan(
      planInput({
        candidates: [candidate({ command: "python -m pytest tests/test_x.py::test_y 2>&1 | head -50" })],
      }),
    );
    expect(plan.commandSafety.diagnosticOnly).toBe(true);
    expect(plan.eligibleForFutureExecution).toBe(false);
    expect(plan.blockers.some((b) => b.includes("not fair-executable as captured"))).toBe(true);
  });

  it("8. unsafe tokens are rejected (not merely diagnostic)", () => {
    for (const cmd of [
      "pytest tests/test_x.py && rm -rf /tmp/x",
      "pip install foo; pytest tests/test_x.py",
      "sudo pytest tests/test_x.py",
      "pytest tests/test_x.py && git reset --hard",
    ]) {
      const safety = classifyCommandSafety(cmd);
      expect(safety.allowed).toBe(false);
    }
    // A rejected token blocks fair execution outright.
    const rm = classifyCommandSafety("rm -rf build && pytest tests/test_x.py");
    expect(rm.allowed).toBe(false);
    expect(rm.diagnosticOnly).toBeUndefined();
    expect(rm.reason).toContain("rejected token");
    // A clean fair form is allowed.
    expect(classifyCommandSafety("python -m pytest tests/test_x.py::test_y").allowed).toBe(true);
    expect(classifyCommandSafety("tox -e py39").allowed).toBe(true);
  });

  it("9. pytest selected tests are preserved on the plan", () => {
    const tests = ["tests/test_a.py::test_one", "tests/test_b.py::test_two"];
    const plan = buildAgentTestCommandPlan(
      planInput({
        candidates: [candidate({ command: "pytest " + tests.join(" "), selectedTests: tests })],
      }),
    );
    expect(plan.selectedTests).toEqual(tests);
    expect(plan.commandFramework).toBe("pytest");
  });
});

describe("agentTestCommandPlanner — image key + honesty invariants", () => {
  it("10. image key unavailable is reported honestly when not computable", () => {
    const img = deriveExpectedImageKey({ instanceId: "" });
    expect(img.expectedImageKey).toBeNull();
    expect(img.derivation).toContain("unavailable_in_ts_dry_run");

    const plan = buildAgentTestCommandPlan(planInput({ instanceId: "", imagePlan: img }));
    expect(plan.blockers).toContain("image_key_not_computed");
    expect(plan.eligibleForFutureExecution).toBe(false);
  });

  it("derives the remote SWE-bench image key with the __→_1776_ remap", () => {
    const img = deriveExpectedImageKey({ instanceId: "sphinx-doc__sphinx-7462" });
    expect(img.expectedImageKey).toBe("swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest");
    expect(img.imageNamespace).toBe("swebench");
    expect(img.architecture).toBe("x86_64");
  });

  it("derives a local image key (no namespace, no remap) when namespace=null", () => {
    const img = deriveExpectedImageKey({ instanceId: "sphinx-doc__sphinx-7462", namespace: null });
    expect(img.expectedImageKey).toBe("sweb.eval.x86_64.sphinx-doc__sphinx-7462:latest");
    expect(img.imageNamespace).toBeUndefined();
  });

  it("11. the planner never sets canVerifyFinalPatch=true in dry-run", () => {
    const eligible = buildAgentTestCommandPlan(planInput());
    const ineligible = buildAgentTestCommandPlan(
      planInput({ candidates: [candidate({ provenance: provenance("injected_metadata", false) })] }),
    );
    for (const plan of [eligible, ineligible]) {
      expect(plan.verificationPatchState.canVerifyFinalPatch).toBe(false);
      expect(plan.verificationPatchState.reason).toBe("dry_run_only");
    }
  });

  it("12. the planner does not mutate its (canonical-derived) inputs", () => {
    const candidates = Object.freeze([Object.freeze(candidate())]) as readonly PlanCommandCandidate[];
    const plannedArtifacts = Object.freeze(["/a", "/b"]) as readonly string[];
    const input = planInput({ candidates, plannedArtifacts });
    // Frozen inputs ⇒ any mutation attempt would throw.
    expect(() => buildAgentTestCommandPlan(input)).not.toThrow();
    const plan = buildAgentTestCommandPlan(input);
    // The plan's arrays are copies, not the same references.
    expect(plan.plannedArtifacts).not.toBe(plannedArtifacts);
    expect(plan.selectedTests).not.toBe(candidates[0]!.selectedTests);
    expect(candidates[0]!.selectedTests).toEqual(["tests/test_x.py::test_y"]);
  });

  it("selects the first command that classifies as a test command", () => {
    const plan = buildAgentTestCommandPlan(
      planInput({
        candidates: [
          candidate({ command: "ls -la", framework: "unknown", selectedTests: [] }),
          candidate({ command: "pytest tests/test_real.py::t", selectedTests: ["tests/test_real.py::t"] }),
        ],
      }),
    );
    expect(plan.selectedCommand).toBe("pytest tests/test_real.py::t");
  });

  it("blocks a pytest command with no selected tests (gate 6)", () => {
    const plan = buildAgentTestCommandPlan(
      planInput({ candidates: [candidate({ command: "pytest", selectedTests: [] })] }),
    );
    expect(plan.eligibleForFutureExecution).toBe(false);
    expect(plan.blockers.some((b) => b.includes("needs explicit test selectors"))).toBe(true);
  });
});

describe("agentTestCommandPlanner — M28 fair discovery eligibility", () => {
  // M28-10. A synthetic agent-discovered, canonically-formed pytest command is planner-eligible.
  it("10. a safe agent_discovered pytest command is eligible for future execution", () => {
    const plan = buildAgentTestCommandPlan(
      planInput({
        candidates: [
          candidate({
            command: "python -m pytest tests/test_domain_py.py::test_parse_annotation",
            selectedTests: ["tests/test_domain_py.py::test_parse_annotation"],
            provenance: provenance("agent_discovered", true),
          }),
        ],
      }),
    );
    expect(plan.fairProvenance.classification).toBe("agent_discovered");
    expect(plan.fairProvenance.allowedForFairVerification).toBe(true);
    expect(plan.commandSafety.allowed).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.eligibleForFutureExecution).toBe(true);
  });

  // M28-11. The same agent_discovered command, but shell-piped/truncated, is rejected: a fair
  // re-run never executes a captured pipeline as-is.
  it("11. an agent_discovered command wrapped in a shell pipe is rejected", () => {
    const plan = buildAgentTestCommandPlan(
      planInput({
        candidates: [
          candidate({
            command: "python -m pytest tests/test_domain_py.py::test_parse_annotation 2>&1 | head -50",
            selectedTests: ["tests/test_domain_py.py::test_parse_annotation"],
            provenance: provenance("agent_discovered", true),
          }),
        ],
      }),
    );
    expect(plan.commandSafety.allowed).toBe(false);
    expect(plan.commandSafety.diagnosticOnly).toBe(true);
    expect(plan.eligibleForFutureExecution).toBe(false);
    expect(plan.blockers.some((b) => b.includes("not fair-executable as captured"))).toBe(true);
  });
});
