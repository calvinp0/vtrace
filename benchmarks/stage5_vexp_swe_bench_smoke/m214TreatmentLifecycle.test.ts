/**
 * M214 — tests for the treatment lifecycle repair.
 *
 * The two vendor-harness asymmetries M213 found are one line of pathspec each,
 * and both would have been invisible in the analysis. These tests pin the
 * general rule that replaces them: the agent's patch is what changed minus what
 * was already there, with no product name anywhere in the mechanism.
 */

import { describe, expect, test } from "bun:test";

import {
  M214_INDEX_WARMTH_POLICY,
  M214_LIFECYCLE_ORDER,
  auditBaselineIsolation,
  auditCapturedPatchPaths,
  auditDerivedExclusionCoversTreatmentState,
  auditHardcodedExclusionList,
  auditLifecycleOrder,
  auditResetPreservedPaths,
  auditSourceStateEquivalence,
  auditTreatmentArmContainment,
  auditWarmthPolicy,
  classifyExclusionRoute,
  derivePatchCaptureExclusions,
  patchCapturePathspec,
} from "./m214TreatmentLifecycle";
import { M214_NATIVE_TOOLS, armDefinition } from "./m214Preregistration";

/** The vendor harness's real pathspecs, read from its shipped JavaScript. */
const VENDOR_PATCH_EXCLUSIONS = [".vexp", ".claude", ".bench-mcp-config.json"];
const VENDOR_CLEAN_PRESERVED = [".vexp", ".claude", ".bench-mcp-config.json"];

describe("lifecycle ordering", () => {
  test("the frozen order is accepted", () => {
    expect(auditLifecycleOrder(M214_LIFECYCLE_ORDER)).toEqual([]);
  });

  test("the snapshot must not precede treatment initialisation", () => {
    const reordered = [
      "CONTAINER_START",
      "SOURCE_CHECKOUT_AT_BASE_COMMIT",
      "SOURCE_STATE_DIGEST_BEFORE_TREATMENT",
      "PRE_AGENT_UNTRACKED_SNAPSHOT",
      "TREATMENT_INITIALISATION",
      "SOURCE_STATE_DIGEST_AFTER_TREATMENT",
      "AGENT_RUN",
      "PATCH_CAPTURE",
      "EVALUATION",
    ];
    const issues = auditLifecycleOrder(reordered);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.includes("BEFORE treatment initialisation"))).toBe(true);
  });

  test("a missing phase is reported by name", () => {
    const issues = auditLifecycleOrder(
      M214_LIFECYCLE_ORDER.filter((phase) => phase !== "PATCH_CAPTURE"),
    );
    expect(issues).toContain("lifecycle phase missing: PATCH_CAPTURE");
  });

  test("an unknown phase is rejected rather than ignored", () => {
    const issues = auditLifecycleOrder([...M214_LIFECYCLE_ORDER, "SECRETLY_REINDEX"]);
    expect(issues).toContain("unknown lifecycle phase: SECRETLY_REINDEX");
  });
});

describe("derived patch-capture exclusions", () => {
  test("are exactly the pre-agent untracked paths, deduplicated and sorted", () => {
    expect(derivePatchCaptureExclusions([".vtrace/", "node_modules", ".vtrace"]))
      .toEqual([".vtrace", "node_modules"]);
  });

  test("name no product when the snapshot is empty", () => {
    expect(derivePatchCaptureExclusions([])).toEqual([]);
    expect(patchCapturePathspec([])).toBe("");
  });

  test("render as a git pathspec", () => {
    expect(patchCapturePathspec([".vtrace"])).toBe("':(exclude).vtrace'");
  });

  test("a treatment directory in the snapshot keeps its files out of the patch", () => {
    const issues = auditCapturedPatchPaths(
      [".vtrace/index.sqlite", ".vtrace/session.sqlite", "pkg/core.py"],
      [".vtrace"],
    );
    expect(issues.length).toBe(2);
    expect(issues.every((issue) => issue.includes("not an agent change"))).toBe(true);
  });

  test("a real source edit is never filtered out", () => {
    expect(auditCapturedPatchPaths(["pkg/core.py"], [".vtrace"])).toEqual([]);
  });

  test("the rule is treatment-agnostic: it catches an unnamed future treatment too", () => {
    expect(auditCapturedPatchPaths([".newtool/db"], [".newtool"]).length).toBe(1);
    expect(auditCapturedPatchPaths([".vexp/graph.db"], [".vexp"]).length).toBe(1);
  });
});

describe("exclusion routes", () => {
  test("a snapshotted path is covered by the derived exclusion", () => {
    expect(classifyExclusionRoute(".vtrace", [".vtrace"], [".vtrace"]))
      .toBe("DERIVED_SNAPSHOT_EXCLUSION");
  });

  test("a path git cannot enumerate is covered by the second route", () => {
    expect(classifyExclusionRoute(".vtrace", [], [])).toBe("NOT_ENUMERABLE_BY_GIT");
  });

  test("an enumerable path missing from the snapshot is uncovered", () => {
    expect(classifyExclusionRoute(".vtrace", [], [".vtrace"])).toBe("UNCOVERED");
  });

  test("only the uncovered route raises an issue", () => {
    expect(auditDerivedExclusionCoversTreatmentState("vtrace", [".vtrace"], [".vtrace"], [".vtrace"]))
      .toEqual([]);
    expect(auditDerivedExclusionCoversTreatmentState("vtrace", [], [".vtrace"], []))
      .toEqual([]);
    expect(auditDerivedExclusionCoversTreatmentState("vtrace", [], [".vtrace"], [".vtrace"]).length)
      .toBe(1);
  });

  test("the baseline arm creating treatment state is always an issue", () => {
    const issues = auditDerivedExclusionCoversTreatmentState(
      "baseline", [".vtrace"], [".vtrace"], [".vtrace"],
    );
    expect(issues.some((issue) => issue.includes("baseline arm created treatment state"))).toBe(true);
  });
});

describe("the vendor harness's hardcoded list", () => {
  test("is reported both for what it misses and for being hardcoded", () => {
    const issues = auditHardcodedExclusionList(VENDOR_PATCH_EXCLUSIONS, [".vtrace", ".vexp"]);
    expect(issues.some((issue) => issue.includes("does not exclude .vtrace"))).toBe(true);
    expect(issues.some((issue) => issue.includes("hardcoded exclusion list"))).toBe(true);
  });

  test("a complete hardcoded list is still reported as hardcoded", () => {
    const issues = auditHardcodedExclusionList([".vtrace", ".vexp"], [".vtrace", ".vexp"]);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("hardcoded exclusion list");
  });

  test("deriving exclusions instead raises nothing", () => {
    expect(auditHardcodedExclusionList([], [".vtrace", ".vexp"])).toEqual([]);
  });
});

describe("reset and warmth policy", () => {
  test("the frozen policy is cold and preserves nothing", () => {
    expect(M214_INDEX_WARMTH_POLICY.regime).toBe("COLD_UNIFORM");
    expect(M214_INDEX_WARMTH_POLICY.survivesBetweenRuns).toEqual([]);
    expect(M214_INDEX_WARMTH_POLICY.indexBuildChargedToModelBudget).toBe(false);
  });

  test("a uniformly cold cohort is accepted", () => {
    expect(auditWarmthPolicy([
      { arm: "baseline", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [] },
      { arm: "vtrace", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [] },
    ])).toEqual([]);
  });

  test("an inherited index under a cold policy is rejected", () => {
    const issues = auditWarmthPolicy([
      { arm: "baseline", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [] },
      { arm: "vtrace", treatmentStateInheritedFromPreviousRun: [".vtrace"], resetPreservedPaths: [] },
    ]);
    expect(issues.some((issue) => issue.includes("inherited treatment state"))).toBe(true);
  });

  test("an asymmetric preserve list is rejected even when nothing was inherited", () => {
    const issues = auditWarmthPolicy([
      { arm: "baseline", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [] },
      { arm: "vtrace", treatmentStateInheritedFromPreviousRun: [], resetPreservedPaths: [".vtrace"] },
    ]);
    expect(issues.some((issue) => issue.includes("asymmetric across arms"))).toBe(true);
  });

  test("the vendor's clean flags fail the cold policy", () => {
    const issues = auditResetPreservedPaths(VENDOR_CLEAN_PRESERVED, [".vtrace", ".vexp"]);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain(".vexp");
  });

  test("a reset preserving no treatment state is accepted", () => {
    expect(auditResetPreservedPaths([".claude"], [".vtrace", ".vexp"])).toEqual([]);
  });
});

describe("source-state equivalence", () => {
  const clean = {
    arm: "vtrace" as const,
    instanceId: "astropy__astropy-14365",
    baseCommit: "deadbeef",
    headAtAgentStart: "deadbeef",
    trackedSourceDigestBeforeTreatment: "canonical",
    trackedSourceDigestAfterTreatment: "canonical",
    canonicalTrackedSourceDigest: "canonical",
    untrackedSourceAffectingPaths: [] as readonly string[],
  };

  test("observational indexing is accepted", () => {
    expect(auditSourceStateEquivalence(clean)).toEqual([]);
  });

  test("indexing that mutates tracked source is rejected", () => {
    const issues = auditSourceStateEquivalence({
      ...clean, trackedSourceDigestAfterTreatment: "mutated",
    });
    expect(issues.some((issue) => issue.includes("mutated tracked source"))).toBe(true);
  });

  test("a checkout at the wrong commit is rejected", () => {
    const issues = auditSourceStateEquivalence({ ...clean, headAtAgentStart: "other" });
    expect(issues.some((issue) => issue.includes("not the frozen base commit"))).toBe(true);
  });

  test("untracked source-affecting state at agent start is rejected", () => {
    const issues = auditSourceStateEquivalence({
      ...clean, untrackedSourceAffectingPaths: ["pkg/patch.py"],
    });
    expect(issues.some((issue) => issue.includes("untracked source-affecting"))).toBe(true);
  });
});

describe("baseline isolation", () => {
  const cleanBaseline = {
    mcpServers: [] as readonly string[],
    modelVisibleToolNames: M214_NATIVE_TOOLS,
    environmentVariableNames: ["PATH", "HOME", "LANG"],
    workspaceRootEntries: ["src", "tests", ".git"],
    injectedContextDocuments: [] as readonly string[],
    daemonSocketsReachable: [] as readonly string[],
    treatmentBinariesOnPath: [] as readonly string[],
    systemPromptAppendix: null,
  };

  test("an isolated baseline raises nothing", () => {
    expect(auditBaselineIsolation(cleanBaseline)).toEqual([]);
  });

  test.each([
    ["an MCP server", { mcpServers: ["vtrace"] }],
    ["a treatment tool", { modelVisibleToolNames: [...M214_NATIVE_TOOLS, "mcp__vtrace__run_pipeline"] }],
    ["an environment variable", { environmentVariableNames: ["PATH", "VTRACE_REPO_ROOT"] }],
    ["a workspace directory", { workspaceRootEntries: ["src", ".git", ".vtrace"] }],
    ["a nested workspace path", { workspaceRootEntries: ["src", ".vtrace/index.sqlite"] }],
    ["an injected document", { injectedContextDocuments: ["VTRACE_CONTEXT.md"] }],
    ["a daemon socket", { daemonSocketsReachable: ["/tmp/vtrace.sock"] }],
    ["a system prompt appendix", { systemPromptAppendix: "Use VTRACE." }],
  ])("rejects %s leaking into the baseline", (_label, override) => {
    expect(auditBaselineIsolation({ ...cleanBaseline, ...override }).length).toBeGreaterThan(0);
  });

  test("a baseline missing a native tool is rejected too, not only a widened one", () => {
    const issues = auditBaselineIsolation({
      ...cleanBaseline,
      modelVisibleToolNames: M214_NATIVE_TOOLS.filter((tool) => tool !== "Grep"),
    });
    expect(issues.some((issue) => issue.includes("missing native tools"))).toBe(true);
  });
});

describe("treatment-arm containment", () => {
  const cleanVtrace = {
    mcpServers: armDefinition("vtrace").mcpServers,
    modelVisibleToolNames: armDefinition("vtrace").modelVisibleToolNames,
    environmentVariableNames: ["PATH", "HOME"],
    workspaceRootEntries: ["src", ".git", ".vtrace"],
    injectedContextDocuments: [] as readonly string[],
    daemonSocketsReachable: [] as readonly string[],
    treatmentBinariesOnPath: [] as readonly string[],
    systemPromptAppendix: null,
  };

  test("a compliant VTRACE arm raises nothing, and .vtrace is allowed there", () => {
    expect(auditTreatmentArmContainment(cleanVtrace)).toEqual([]);
  });

  test("competitor state inside the VTRACE arm is rejected", () => {
    const issues = auditTreatmentArmContainment({
      ...cleanVtrace,
      workspaceRootEntries: ["src", ".git", ".vtrace", ".vexp"],
      environmentVariableNames: ["PATH", "VEXP_LICENSE"],
    });
    expect(issues.length).toBe(2);
  });

  test("a widened treatment catalogue is rejected", () => {
    const issues = auditTreatmentArmContainment({
      ...cleanVtrace,
      modelVisibleToolNames: [...cleanVtrace.modelVisibleToolNames, "mcp__vtrace__search_symbols"],
    });
    expect(issues.some((issue) => issue.includes("tool surface differs"))).toBe(true);
  });
});
