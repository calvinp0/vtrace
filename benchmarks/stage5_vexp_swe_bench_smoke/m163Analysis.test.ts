import { describe, expect, test } from "bun:test";

import type { RawToolCall, VtraceCallRecord } from "./m162Telemetry";
import {
  classifyAgentReaction,
  classifyEvidenceQuality,
  classifyPairedOutcome,
  classifyQueryEvidence,
  detectFalseAuthority,
  findFalseAbsenceCandidates,
} from "./m163Analysis";

const record = (over: Partial<VtraceCallRecord> = {}): VtraceCallRecord => ({
  sequence: 0,
  rawIndex: 0,
  turn: 1,
  toolId: "get_code_context",
  modelVisibleName: "mcp__vtrace__get_code_context",
  args: { task: "gold tier discount is wrong in the order total" },
  argsHash: "x",
  queryLength: 42,
  resultState: "VALID_NONEMPTY",
  itemCount: 4,
  responseChars: 1000,
  responseEstimatedTokens: 250,
  responseHash: "y",
  latencyMs: 10,
  returnedPaths: ["pkg/core.py", "pkg/api.py"],
  returnedFqNames: ["pkg/core.py::PriceEngine.apply_discount"],
  beforeFirstEdit: true,
  purpose: "INITIAL_ORIENTATION",
  ...over,
} as VtraceCallRecord);

const call = (tool: string, path?: string): RawToolCall =>
  ({ tool, ...(path === undefined ? {} : { path }) } as RawToolCall);

describe("evidence quality is gold-relative and says so", () => {
  test("gold leading the result is GOLD_LED", () => {
    const quality = classifyEvidenceQuality(record(), ["pkg/core.py"]);
    expect(quality.tier).toBe("GOLD_LED");
    expect(quality.goldRelation).toBe("TOP_1");
  });

  test("gold present but not leading is GOLD_PRESENT", () => {
    const quality = classifyEvidenceQuality(record(), ["pkg/api.py"]);
    expect(quality.tier).toBe("GOLD_PRESENT");
    expect(quality.goldRelation).toBe("ANYWHERE");
  });

  test("gold missing is GOLD_ABSENT, which is not the same as useless", () => {
    const quality = classifyEvidenceQuality(record(), ["pkg/other.py"]);
    expect(quality.tier).toBe("GOLD_ABSENT");
    // The tier name describes a relation to benchmark gold and the artifact
    // carries the caveat, so a reader cannot mistake it for a usefulness verdict.
    expect(quality.caveat).toContain("orient usefully");
  });

  test("errors and empties are separated from bad relevance", () => {
    expect(classifyEvidenceQuality(record({ resultState: "TOOL_ERROR" }), ["pkg/core.py"]).tier).toBe("ERROR");
    expect(classifyEvidenceQuality(record({ itemCount: 0, returnedPaths: [] }), ["pkg/core.py"]).tier).toBe("EMPTY");
  });

  test("workspace-prefixed returned paths still match repo-relative gold", () => {
    const quality = classifyEvidenceQuality(
      record({ returnedPaths: ["sympy/printing/latex.py"] }), ["sympy/printing/latex.py"]);
    expect(quality.goldRelation).toBe("TOP_1");
  });
});

describe("query alignment", () => {
  const task = "gold tier discount is wrong when computing the order total";

  test("a task-derived query with leading gold is right question, right evidence", () => {
    const quality = classifyEvidenceQuality(record(), ["pkg/core.py"]);
    expect(classifyQueryEvidence(task, task, quality).classification).toBe("RIGHT_QUERY_RIGHT_EVIDENCE");
  });

  test("a task-derived query with absent gold is right question, wrong evidence", () => {
    const quality = classifyEvidenceQuality(record(), ["pkg/other.py"]);
    expect(classifyQueryEvidence(task, task, quality).classification).toBe("RIGHT_QUERY_WRONG_EVIDENCE");
  });

  test("an unrelated query is flagged as the agent's own misalignment, and marked for inspection", () => {
    const quality = classifyEvidenceQuality(record(), ["pkg/core.py"]);
    const result = classifyQueryEvidence("configure webpack bundler plugins", task, quality);
    expect(result.classification).toBe("QUERY_ITSELF_MISALIGNED");
    // A lexical threshold is a blunt instrument, so it produces a candidate for
    // inspection rather than a finding.
    expect(result.needsInspection).toBe(true);
  });

  test("an empty query is misalignment, not a missing measurement", () => {
    const quality = classifyEvidenceQuality(record(), ["pkg/core.py"]);
    expect(classifyQueryEvidence("", task, quality).classification).toBe("QUERY_ITSELF_MISALIGNED");
  });
});

describe("agent reaction", () => {
  const quality = (gold: string[]) => classifyEvidenceQuality(record(), gold);

  test("opening what it was pointed at is orientation", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Read", "pkg/core.py")],
      [record()], null, quality(["pkg/core.py"]));
    expect(reaction.labels).toContain("USED_AS_ORIENTATION");
    expect(reaction.labels).not.toContain("IGNORED");
  });

  test("touching nothing it returned is IGNORED", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Read", "docs/readme.md"), call("Edit", "docs/readme.md")],
      [record()], null, quality(["pkg/core.py"]));
    expect(reaction.labels).toContain("IGNORED");
  });

  test("orientation and verification are both recorded, not forced into one label", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Grep"), call("Read", "pkg/core.py"), call("Edit", "pkg/core.py")],
      [record()], true, quality(["pkg/core.py"]));
    expect(reaction.labels).toContain("USED_AS_ORIENTATION");
    expect(reaction.labels).toContain("VERIFIED_WITH_NORMAL_TOOLS");
  });

  test("a second VTRACE call is voluntary follow-up", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("mcp__vtrace__get_impact_graph")],
      [record(), record({ sequence: 1, toolId: "get_impact_graph" })], null, quality(["pkg/core.py"]));
    expect(reaction.labels).toContain("REQUESTED_FOLLOWUP_VTRACE");
    expect(reaction.followUpVtraceCalls).toBe(1);
  });

  test("disagreement requires going elsewhere AND being right", () => {
    const calls = [call("mcp__vtrace__get_code_context"), call("Edit", "pkg/elsewhere.py")];
    expect(classifyAgentReaction(calls, [record()], true, quality(["pkg/elsewhere.py"])).labels)
      .toContain("DISAGREED_AND_RECOVERED");
    // Editing elsewhere and failing is not recovery, it is just failing.
    expect(classifyAgentReaction(calls, [record()], false, quality(["pkg/elsewhere.py"])).labels)
      .not.toContain("DISAGREED_AND_RECOVERED");
  });

  test("anchoring requires weak evidence, confined edits AND a wrong outcome", () => {
    const calls = [call("mcp__vtrace__get_code_context"), call("Edit", "pkg/core.py")];
    expect(classifyAgentReaction(calls, [record()], false, quality(["pkg/elsewhere.py"])).labels)
      .toContain("ANCHORED_INCORRECTLY");
    // Same behaviour, right answer: not anchoring.
    expect(classifyAgentReaction(calls, [record()], true, quality(["pkg/elsewhere.py"])).labels)
      .not.toContain("ANCHORED_INCORRECTLY");
    // Same behaviour, evidence contained gold: not anchoring.
    expect(classifyAgentReaction(calls, [record()], false, quality(["pkg/core.py"])).labels)
      .not.toContain("ANCHORED_INCORRECTLY");
  });
});

describe("false authority", () => {
  const weak = classifyEvidenceQuality(record(), ["pkg/elsewhere.py"]);
  const strong = classifyEvidenceQuality(record(), ["pkg/core.py"]);

  test("editing only what a weak result named, with no verification, is false authority", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Edit", "pkg/core.py")], [record()], false, weak);
    expect(detectFalseAuthority(reaction, weak).detected).toBe(true);
  });

  test("verifying first defeats it, even with the same edit", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Read", "pkg/core.py"), call("Edit", "pkg/core.py")],
      [record()], false, weak);
    expect(detectFalseAuthority(reaction, weak).detected).toBe(false);
    expect(detectFalseAuthority(reaction, weak).independentVerificationBeforeEdit).toBeGreaterThan(0);
  });

  test("trusting evidence that was actually right is not false authority", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Edit", "pkg/core.py")], [record()], true, strong);
    expect(detectFalseAuthority(reaction, strong).detected).toBe(false);
  });
});

describe("false absence", () => {
  test("a positive nonexistence claim near a VTRACE mention is a candidate", () => {
    const text = "I called get_code_context and it returned only two files, so there is no validation helper here.";
    const found = findFalseAbsenceCandidates(text);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.nearVtraceMention).toBe(true);
  });

  test("silence produces no candidate, because absence of a mention is not evidence", () => {
    expect(findFalseAbsenceCandidates("I read the file and made the edit.")).toEqual([]);
  });

  test("a nonexistence claim away from any VTRACE mention is recorded but not attributed", () => {
    const found = findFalseAbsenceCandidates("There is no changelog entry for this release.");
    expect(found.length).toBe(1);
    expect(found[0]?.nearVtraceMention).toBe(false);
  });
});

describe("paired outcomes", () => {
  test("all four comparable cells", () => {
    expect(classifyPairedOutcome(true, true)).toBe("SHARED_SUCCESS");
    expect(classifyPairedOutcome(false, false)).toBe("SHARED_FAILURE");
    expect(classifyPairedOutcome(false, true)).toBe("TO_UNIQUE_WIN");
    expect(classifyPairedOutcome(true, false)).toBe("FROM_UNIQUE_WIN");
  });

  test("an ungraded side is not comparable, and is never read as a failure", () => {
    expect(classifyPairedOutcome(null, true)).toBe("NOT_COMPARABLE");
    expect(classifyPairedOutcome(true, null)).toBe("NOT_COMPARABLE");
  });
});

// Positive controls for the M163-D analyzer correction. The sweep found that
// every VTRACE call was declined by the product (`repo_not_ready`), which made
// three labels fire on all twelve runs for reasons that had nothing to do with
// the agent. These pin the corrected behaviour in both directions.
describe("undelivered evidence gates every downstream label", () => {
  const declined = () => classifyEvidenceQuality(
    record({ itemCount: 0, returnedPaths: [], returnedFqNames: [] }),
    ["pkg/core.py"],
    { productDeclined: true },
  );

  test("a declined answer is its own tier, not weak retrieval", () => {
    // EMPTY means retrieval ran and found nothing. This means it never ran.
    expect(declined().tier).toBe("PRODUCT_DECLINED");
    expect(declined().evidenceDelivered).toBe(false);
    expect(classifyEvidenceQuality(record({ itemCount: 0, returnedPaths: [] }), ["pkg/core.py"]).tier).toBe("EMPTY");
  });

  test("IGNORED and DISAGREED_AND_RECOVERED do not fire on an empty result", () => {
    // Before the correction both fired on every run: with no returned paths,
    // "touched nothing it returned" and "edited somewhere it did not name" are
    // true by construction, and were being reported as agent behaviour.
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Grep"), call("Edit", "pkg/core.py")],
      [record()], true, declined());
    expect(reaction.labels).toEqual(["NO_EVIDENCE_DELIVERED"]);
    expect(reaction.labels).not.toContain("IGNORED");
    expect(reaction.labels).not.toContain("DISAGREED_AND_RECOVERED");
  });

  test("a retry after a declined answer is still recorded as a follow-up call", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("mcp__vtrace__get_code_context")],
      [record(), record({ sequence: 1 })], null, declined());
    expect(reaction.labels).toContain("REQUESTED_FOLLOWUP_VTRACE");
    expect(reaction.labels).toContain("NO_EVIDENCE_DELIVERED");
  });

  test("false authority cannot be detected against evidence nobody saw", () => {
    const reaction = classifyAgentReaction(
      [call("mcp__vtrace__get_code_context"), call("Edit", "pkg/core.py")], [record()], false, declined());
    expect(detectFalseAuthority(reaction, declined()).detected).toBe(false);
  });

  test("query alignment is NOT_APPLICABLE, so retrieval is not blamed for a call it never saw", () => {
    const task = "gold tier discount is wrong when computing the order total";
    expect(classifyQueryEvidence(task, task, declined()).classification).toBe("NOT_APPLICABLE");
    // ...and a genuinely delivered result still classifies normally.
    expect(classifyQueryEvidence(task, task, classifyEvidenceQuality(record(), ["pkg/core.py"])).classification)
      .toBe("RIGHT_QUERY_RIGHT_EVIDENCE");
  });
});
