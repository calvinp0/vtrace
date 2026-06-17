import { describe, expect, it } from "bun:test";
import {
  buildAgentCommandVerification,
  buildSkippedVerification,
  canonicalizeCommand,
  decideVerificationEligibility,
  type AgentCommandExecutionResult,
} from "./agentTestCommandVerifier";
import type { AgentTestCommandPlan } from "./agentTestCommandPlanner";

function eligiblePlan(overrides: Partial<AgentTestCommandPlan> = {}): AgentTestCommandPlan {
  return {
    mode: "plan-agent-test-command",
    sourceRunLabel: "label-1",
    instanceId: "django__django-12345",
    patchSource: "pivot_revision_revised",
    patchPath: "/runs/label-1/raw/vtrace/_pivot_revision_revised.patch",
    patchSha256: "abc123def456",
    commandSource: "pivot_revision_test_commands",
    selectedCommand: "python -m pytest tests/test_x.py::test_y",
    selectedTests: ["tests/test_x.py::test_y"],
    commandFramework: "pytest",
    commandSafety: { allowed: true, reason: "allowed fair test form (pytest)" },
    fairProvenance: { classification: "agent_discovered", allowedForFairVerification: true, evidence: [] },
    verificationPatchState: { canVerifyFinalPatch: false, reason: "dry_run_only" },
    imagePlan: {
      instanceId: "django__django-12345",
      expectedImageKey: "swebench/sweb.eval.x86_64.django_1776_django-12345:latest",
      imageNamespace: "swebench",
      architecture: "x86_64",
      derivation: "test",
      testbed: "/testbed",
    },
    plannedArtifacts: [],
    eligibleForFutureExecution: true,
    blockers: [],
    ...overrides,
  };
}

function ineligiblePlan(overrides: Partial<AgentTestCommandPlan> = {}): AgentTestCommandPlan {
  return eligiblePlan({
    eligibleForFutureExecution: false,
    blockers: ['provenance "injected_metadata" is not allowed for fair verification'],
    fairProvenance: { classification: "injected_metadata", allowedForFairVerification: false, evidence: [] },
    ...overrides,
  });
}

function exec(overrides: Partial<AgentCommandExecutionResult> = {}): AgentCommandExecutionResult {
  return {
    dockerStarted: true,
    patchApplied: true,
    appliedPatchSha256: "abc123def456",
    commandRan: true,
    exitCode: 0,
    rawToolSuccess: true,
    stdout: "============ 1 passed in 0.12s ============\n",
    stderr: "",
    worktreeDiffHashBeforeCommand: "before",
    worktreeDiffHashAfterCommand: "after",
    ...overrides,
  };
}

// agent_discovered: no injected match, the test appears in prior exploration.
const agentDiscoveredContext = {
  injectedTestNames: null,
  priorCommandText: ["tests/test_x.py::test_y"],
};

describe("verifier — eligibility gating (no Docker)", () => {
  it("1. an ineligible plan skips without Docker", () => {
    const decision = decideVerificationEligibility(ineligiblePlan());
    expect(decision.eligible).toBe(false);
    const skipped = buildSkippedVerification({
      plan: ineligiblePlan(),
      reason: "plan_ineligible",
      blockers: decision.blockers,
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.dockerStarted).toBe(false);
    expect(skipped.commandExecuted).toBe(false);
  });

  it("2. an injected_metadata plan is ineligible", () => {
    const decision = decideVerificationEligibility(
      ineligiblePlan({ fairProvenance: { classification: "injected_metadata", allowedForFairVerification: false, evidence: [] } }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.blockers.some((b) => b.includes("injected_metadata"))).toBe(true);
  });

  it("3. a shell-piped command is ineligible for fair execution", () => {
    const decision = decideVerificationEligibility(
      ineligiblePlan({
        commandSafety: { allowed: false, diagnosticOnly: true, reason: 'shell pipeline/redirect token "|"' },
        blockers: ['command not fair-executable as captured: shell pipeline/redirect token "|"'],
      }),
    );
    expect(decision.eligible).toBe(false);
  });
});

describe("verifier — command canonicalization", () => {
  it("4. an eligible pytest command canonicalizes to a safe command", () => {
    const canon = canonicalizeCommand({
      capturedCommand: "python -m pytest tests/test_x.py::test_y -xvs 2>&1 | head -50",
      framework: "pytest",
      selectedTests: ["tests/test_x.py::test_y"],
    });
    expect(canon.commandCanonicalized).toBe(true);
    expect(canon.executedCommand).toBe("python -m pytest 'tests/test_x.py::test_y'");
    // The raw piped capture is discarded.
    expect(canon.executedCommand).not.toContain("|");
  });

  it("single-quotes pytest param ids with shell metacharacters", () => {
    const canon = canonicalizeCommand({
      capturedCommand: "pytest 'tests/test_pycode_ast.py::test_unparse[()-()]'",
      framework: "pytest",
      selectedTests: ["tests/test_pycode_ast.py::test_unparse[()-()]"],
    });
    expect(canon.executedCommand).toBe("python -m pytest 'tests/test_pycode_ast.py::test_unparse[()-()]'");
  });

  it("refuses to canonicalize a pytest command with no selected tests", () => {
    const canon = canonicalizeCommand({ capturedCommand: "pytest", framework: "pytest", selectedTests: [] });
    expect(canon.commandCanonicalized).toBe(false);
    expect(canon.executedCommand).toBeNull();
  });

  it("canonicalizes selector-free frameworks to their base command", () => {
    expect(canonicalizeCommand({ capturedCommand: "tox -e py39 | tee log", framework: "tox", selectedTests: [] }).executedCommand).toBe("tox");
    expect(canonicalizeCommand({ capturedCommand: "go test", framework: "go", selectedTests: [] }).executedCommand).toBe("go test ./...");
  });
});

describe("verifier — patch / instance preconditions", () => {
  it("5. refuses (skips) a plan with a missing patch", () => {
    const plan = ineligiblePlan({
      patchSha256: null,
      patchPath: null,
      blockers: ['patch source "pivot_revision_revised" artifact not found'],
    });
    const decision = decideVerificationEligibility(plan);
    expect(decision.eligible).toBe(false);
    expect(decision.blockers.some((b) => b.includes("artifact not found"))).toBe(true);
  });

  it("6. refuses (skips) a plan with a missing instance id / image key", () => {
    const plan = ineligiblePlan({
      instanceId: "",
      imagePlan: { instanceId: "", expectedImageKey: null, derivation: "unavailable_in_ts_dry_run" },
      blockers: ["image_key_not_computed"],
    });
    const decision = decideVerificationEligibility(plan);
    expect(decision.eligible).toBe(false);
  });
});

describe("verifier — diagnostic record (no grading)", () => {
  it("7. never includes grading helpers/fields in the unit-testable path", () => {
    const v = buildAgentCommandVerification({
      plan: eligiblePlan(),
      canonicalization: canonicalizeCommand({
        capturedCommand: "pytest tests/test_x.py::test_y",
        framework: "pytest",
        selectedTests: ["tests/test_x.py::test_y"],
      }),
      execution: exec(),
      provenanceContext: agentDiscoveredContext,
    });
    const serialized = JSON.stringify(v);
    for (const forbidden of ["resolved", "failToPass", "passToPass", "getEvalReport", "get_resolution_status", "PASS_TO_PASS", "FAIL_TO_PASS"]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });

  it("8. final_patch_verified requires patchApplied + commandRanAfterPatchApply + matching sha + evidence", () => {
    const canon = canonicalizeCommand({
      capturedCommand: "pytest tests/test_x.py::test_y",
      framework: "pytest",
      selectedTests: ["tests/test_x.py::test_y"],
    });
    const verified = buildAgentCommandVerification({
      plan: eligiblePlan(),
      canonicalization: canon,
      execution: exec({ patchApplied: true, commandRan: true, appliedPatchSha256: "abc123def456" }),
      provenanceContext: agentDiscoveredContext,
    });
    expect(verified.agentCommandVerification.finalPatchVerified).toBe(true);
    expect(verified.verificationPatchState.classification).toBe("final_patch_verified");
    expect(verified.verificationPatchState.canVerifyFinalPatch).toBe(true);
    expect(verified.finalPatchProof.evidence.length).toBeGreaterThan(0);

    // Patch not applied ⇒ never final_patch_verified.
    const notApplied = buildAgentCommandVerification({
      plan: eligiblePlan(),
      canonicalization: canon,
      execution: exec({ patchApplied: false }),
      provenanceContext: agentDiscoveredContext,
    });
    expect(notApplied.agentCommandVerification.finalPatchVerified).toBe(false);
    expect(notApplied.verificationPatchState.canVerifyFinalPatch).toBe(false);
    expect(notApplied.status).toBe("error");

    // SHA mismatch ⇒ never final_patch_verified.
    const shaMismatch = buildAgentCommandVerification({
      plan: eligiblePlan(),
      canonicalization: canon,
      execution: exec({ appliedPatchSha256: "WRONG" }),
      provenanceContext: agentDiscoveredContext,
    });
    expect(shaMismatch.agentCommandVerification.finalPatchVerified).toBe(false);
  });

  it("9. a skipped artifact records dockerStarted=false and commandExecuted=false", () => {
    const skipped = buildSkippedVerification({
      plan: ineligiblePlan(),
      reason: "plan_ineligible",
      blockers: ineligiblePlan().blockers,
    });
    expect(skipped.dockerStarted).toBe(false);
    expect(skipped.commandExecuted).toBe(false);
    expect(skipped.canonicalArtifactsUntouched).toBe(true);
  });

  it("10. the verifier does not mutate its input plan, and asserts canonical untouched", () => {
    const plan = Object.freeze(eligiblePlan()) as AgentTestCommandPlan;
    const v = buildAgentCommandVerification({
      plan,
      canonicalization: canonicalizeCommand({
        capturedCommand: "pytest tests/test_x.py::test_y",
        framework: "pytest",
        selectedTests: ["tests/test_x.py::test_y"],
      }),
      execution: exec(),
      provenanceContext: agentDiscoveredContext,
    });
    expect(v.canonicalArtifactsUntouched).toBe(true);
    expect(plan.selectedTests).toEqual(["tests/test_x.py::test_y"]); // unchanged
  });

  it("11. parsed outcome + environment classification are included in the result shape", () => {
    const v = buildAgentCommandVerification({
      plan: eligiblePlan(),
      canonicalization: canonicalizeCommand({
        capturedCommand: "pytest tests/test_x.py::test_y",
        framework: "pytest",
        selectedTests: ["tests/test_x.py::test_y"],
      }),
      execution: exec(),
      provenanceContext: agentDiscoveredContext,
    });
    expect(v.agentCommandVerification.parsedOutcome.status).toBe("passed");
    expect(v.agentCommandVerification.environmentClassification.classification).toBe("test_passed");
    expect(typeof v.agentCommandVerification.outcomeMismatch).toBe("boolean");
    expect(typeof v.agentCommandVerification.fairVerificationUsable).toBe("boolean");
  });

  it("13. inherits the planner's hidden-match provenance instead of recomputing to ambiguous (M29.1)", () => {
    // Plan-time provenance was `agent_discovered_hidden_match` (allowed), derived from the full
    // discovery/prompt-exposure context. The verify-time context here would recompute to
    // `ambiguous` (the selected test is an injected/hidden match with no prior exploration), which
    // pre-M29.1 silently downgraded the verdict. The verifier must inherit the plan's verdict.
    const hiddenMatchContext = {
      injectedTestNames: ["tests/test_x.py::test_y"], // hidden match...
      priorCommandText: [], // ...with NO discovery chain ⇒ standalone recompute = ambiguous
    };
    const v = buildAgentCommandVerification({
      plan: eligiblePlan({
        fairProvenance: {
          classification: "agent_discovered_hidden_match",
          allowedForFairVerification: true,
          evidence: ["hidden-label match upgraded: strong repo discovery and no prompt exposure"],
        },
      }),
      canonicalization: canonicalizeCommand({
        capturedCommand: "pytest tests/test_x.py::test_y",
        framework: "pytest",
        selectedTests: ["tests/test_x.py::test_y"],
      }),
      execution: exec(),
      provenanceContext: hiddenMatchContext,
    });
    // No provenance blocker, and (passed + final-patch verified) ⇒ fair verification is usable.
    expect(
      v.agentCommandVerification.fairVerificationBlockers.some((b) => b.includes("provenance")),
    ).toBe(false);
    expect(v.agentCommandVerification.fairVerificationUsable).toBe(true);
    expect(v.verificationPatchState.classification).toBe("final_patch_verified");
  });

  it("14. a disallowed planner provenance is still inherited (verifier never UPGRADES it)", () => {
    // Symmetric guard: inheritance reuses the plan verdict verbatim, so a disallowed plan stays a
    // provenance blocker even if the verify-time context alone might have looked agent-discovered.
    const v = buildAgentCommandVerification({
      plan: eligiblePlan({
        fairProvenance: {
          classification: "injected_metadata",
          allowedForFairVerification: false,
          evidence: ["withheld label was exposed in the prompt"],
        },
      }),
      canonicalization: canonicalizeCommand({
        capturedCommand: "pytest tests/test_x.py::test_y",
        framework: "pytest",
        selectedTests: ["tests/test_x.py::test_y"],
      }),
      execution: exec(),
      provenanceContext: agentDiscoveredContext,
    });
    expect(
      v.agentCommandVerification.fairVerificationBlockers.some((b) =>
        b.includes('provenance "injected_metadata"'),
      ),
    ).toBe(true);
    expect(v.agentCommandVerification.fairVerificationUsable).toBe(false);
  });

  it("12. the mode is diagnostic-only — never sets replacementRecommended/canonicalReplaced", () => {
    const verified = buildAgentCommandVerification({
      plan: eligiblePlan(),
      canonicalization: canonicalizeCommand({
        capturedCommand: "pytest tests/test_x.py::test_y",
        framework: "pytest",
        selectedTests: ["tests/test_x.py::test_y"],
      }),
      execution: exec(),
      provenanceContext: agentDiscoveredContext,
    });
    const skipped = buildSkippedVerification({ plan: ineligiblePlan(), reason: "plan_ineligible", blockers: [] });
    for (const artifact of [verified, skipped]) {
      expect(artifact.replacementRecommended).toBe(false);
      expect(artifact.canonicalReplaced).toBe(false);
    }
  });
});
