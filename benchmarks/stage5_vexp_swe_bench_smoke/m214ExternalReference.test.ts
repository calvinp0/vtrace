/**
 * M214 — tests for the external-reference separation.
 *
 * The property under test is the one the whole milestone turns on: the vendor's
 * published number is usable as context and unusable as a causal comparator.
 * A test suite that only checked the frozen figures would miss the failure that
 * actually happens, which is a correct analysis rendered into a table with one
 * row too many.
 */

import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_VENDOR_REFERENCE,
  FORBIDDEN_EXTERNAL_CLAIM_PATTERNS,
  M214_EXPERIMENTAL_ARM,
  M214_EXTERNAL_REFERENCE,
  auditCausalTableMembership,
  auditEvidenceClassLabel,
  auditExternalComparisonWording,
  auditExternalReferenceSnapshot,
  auditExternalReferenceTaskArtifact,
  auditPairedComparison,
  externalReferenceHash,
  renderCausalConclusion,
  renderExternalComparison,
} from "./m214ExternalReference";
import { M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256 } from "./m214Preregistration";

describe("the frozen reference", () => {
  test("records the published figures and their evidence class", () => {
    expect(M214_EXTERNAL_REFERENCE.evidenceClass).toBe(EXTERNAL_VENDOR_REFERENCE);
    expect(M214_EXTERNAL_REFERENCE.publishedPassAt1Count).toBe(73);
    expect(M214_EXTERNAL_REFERENCE.taskCount).toBe(100);
    expect(M214_EXTERNAL_REFERENCE.publishedCostPerTaskUsd).toBe(0.67);
    expect(M214_EXTERNAL_REFERENCE.publishedTurnBudget).toBe(250);
    expect(M214_EXTERNAL_REFERENCE.publishedCostLimitUsdPerTask).toBe(3);
    expect(M214_EXTERNAL_REFERENCE.repositoriesRepresented).toBe(12);
  });

  test("is pinned to the same task artifact the experiment runs", () => {
    expect(M214_EXTERNAL_REFERENCE.taskArtifactSha256)
      .toBe(M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256);
  });

  test("every source carries a URL, a pinned commit, a digest and a retrieval date", () => {
    expect(M214_EXTERNAL_REFERENCE.sources.length).toBeGreaterThan(0);
    for (const source of M214_EXTERNAL_REFERENCE.sources) {
      expect(source.url).toStartWith("https://");
      expect(source.vendorCommit.length).toBe(40);
      expect(source.fileSha256.length).toBe(64);
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.quotedLine.length).toBeGreaterThan(0);
    }
  });

  test("records that no per-task outcomes exist, which is why no pairing is possible", () => {
    expect(M214_EXTERNAL_REFERENCE.perTaskOutcomesPublished).toBe(false);
  });

  test("the hash is stable and moves on any edit", () => {
    const baseline = externalReferenceHash();
    expect(externalReferenceHash(M214_EXTERNAL_REFERENCE)).toBe(baseline);
    expect(externalReferenceHash({ ...M214_EXTERNAL_REFERENCE, publishedPassAt1Count: 74 }))
      .not.toBe(baseline);
    expect(externalReferenceHash({ ...M214_EXTERNAL_REFERENCE, publishedCostPerTaskUsd: 0.68 }))
      .not.toBe(baseline);
  });
});

describe("task-artifact guard", () => {
  test("accepts the frozen artifact", () => {
    expect(auditExternalReferenceTaskArtifact(M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256))
      .toEqual([]);
  });

  test("rejects any other artifact, and says the comparison is void", () => {
    const issues = auditExternalReferenceTaskArtifact("0".repeat(64));
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("void until");
  });
});

describe("snapshot guard", () => {
  test("accepts the frozen snapshot at its own digest", () => {
    expect(auditExternalReferenceSnapshot(M214_EXTERNAL_REFERENCE, externalReferenceHash()))
      .toEqual([]);
  });

  test("rejects a published score edited after preregistration", () => {
    const issues = auditExternalReferenceSnapshot(
      { ...M214_EXTERNAL_REFERENCE, publishedPassAt1Count: 80 },
      externalReferenceHash(),
    );
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("requires a new preregistration");
  });

  test("rejects a source digest that moved under the same figures", () => {
    const moved = {
      ...M214_EXTERNAL_REFERENCE,
      sources: M214_EXTERNAL_REFERENCE.sources.map((source, index) =>
        index === 0 ? { ...source, fileSha256: "9".repeat(64) } : source),
    };
    expect(auditExternalReferenceSnapshot(moved, externalReferenceHash()).length).toBe(1);
  });
});

describe("paired-comparison entry point", () => {
  test("accepts the two executed arms", () => {
    expect(auditPairedComparison({ left: "baseline", right: "vtrace" })).toEqual([]);
  });

  test("rejects the external reference as an operand", () => {
    const issues = auditPairedComparison({
      left: "vtrace",
      right: "vexp_published",
      evidenceClasses: { vexp_published: EXTERNAL_VENDOR_REFERENCE },
    });
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("cannot enter a causal statistic");
  });

  test("rejects a bare 'vexp' operand even with no evidence class attached", () => {
    expect(auditPairedComparison({ left: "vtrace", right: "vexp" }).length).toBe(1);
  });

  test("rejects an arm compared with itself", () => {
    expect(auditPairedComparison({ left: "vtrace", right: "vtrace" }).length).toBe(1);
  });
});

describe("causal table membership", () => {
  test("two arms are a valid causal table", () => {
    expect(auditCausalTableMembership([
      { label: "baseline", evidenceClass: M214_EXPERIMENTAL_ARM },
      { label: "VTRACE", evidenceClass: M214_EXPERIMENTAL_ARM },
    ])).toEqual([]);
  });

  test("a third external row is rejected", () => {
    const issues = auditCausalTableMembership([
      { label: "baseline", evidenceClass: M214_EXPERIMENTAL_ARM },
      { label: "VTRACE", evidenceClass: M214_EXPERIMENTAL_ARM },
      { label: "VEXP published", evidenceClass: EXTERNAL_VENDOR_REFERENCE },
    ]);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("separate external-reference table");
  });
});

describe("evidence-class labelling", () => {
  test("rejects arm-like labels on the external reference", () => {
    for (const label of ["Arm C", "experimental arm", "third arm", "causal head-to-head result"]) {
      expect(auditEvidenceClassLabel(label, EXTERNAL_VENDOR_REFERENCE).length).toBe(1);
    }
  });

  test("accepts a descriptive label", () => {
    expect(auditEvidenceClassLabel(
      "Published external reference (vendor)", EXTERNAL_VENDOR_REFERENCE,
    )).toEqual([]);
  });

  test("does not police labels on actual arms", () => {
    expect(auditEvidenceClassLabel("baseline", M214_EXPERIMENTAL_ARM)).toEqual([]);
  });
});

describe("wording discipline", () => {
  test("rejects the head-to-head claims, before any outcome exists", () => {
    const rejected = [
      "VTRACE beat VEXP by 3%.",
      "VTRACE beats VEXP.",
      "VTRACE outperformed VEXP on the same tasks.",
      "Results: VTRACE vs VEXP.",
      "We finally beat VEXP on their own benchmark.",
      "This is an exact replication of the VEXP benchmark.",
    ];
    for (const sentence of rejected) {
      expect(auditExternalComparisonWording(sentence).length).toBeGreaterThan(0);
    }
  });

  test("requires a cross-study qualifier on any numeric side-by-side", () => {
    const unqualified = "VTRACE resolved 76% where VEXP published 73%.";
    expect(auditExternalComparisonWording(unqualified).length).toBeGreaterThan(0);
  });

  test("accepts the permitted phrasing from the preregistration", () => {
    const permitted =
      "VTRACE achieved 76% on the exact published task population, compared descriptively with "
      + "VEXP's published 73%. This 3-point cross-study difference is not a causal head-to-head "
      + "comparison.";
    expect(auditExternalComparisonWording(permitted)).toEqual([]);
  });

  test("accepts the unfavourable phrasing just as readily", () => {
    const permitted =
      "VTRACE's observed absolute pass rate was 3 points below VEXP's published result; because "
      + "the systems were not run in the same harness, this difference is descriptive rather than "
      + "causal.";
    expect(auditExternalComparisonWording(permitted)).toEqual([]);
  });

  test("every forbidden pattern has a stated reason", () => {
    for (const entry of FORBIDDEN_EXTERNAL_CLAIM_PATTERNS) {
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });
});

describe("generated sentences", () => {
  test("the external comparison always passes its own wording audit", () => {
    for (const vtraceResolved of [0, 60, 73, 74, 76, 100]) {
      const sentence = renderExternalComparison({
        baselineResolved: 70, vtraceResolved, tasks: 100,
      });
      expect(auditExternalComparisonWording(sentence)).toEqual([]);
      expect(sentence).toContain("was not executed in the M214 harness");
      expect(sentence).toContain("cross-study descriptive");
    }
  });

  test("the causal conclusion states an unfavourable result as plainly as a favourable one", () => {
    expect(renderCausalConclusion(70, 75, 100)).toContain("improved resolution");
    expect(renderCausalConclusion(70, 70, 100)).toBe(
      "No resolution benefit was observed relative to the matched baseline.",
    );
    expect(renderCausalConclusion(70, 65, 100)).toContain("reduced resolution");
    expect(renderCausalConclusion(70, 65, 100)).toContain("5 / 100");
  });

  test("the causal conclusion never mentions the vendor", () => {
    for (const [a, b] of [[70, 80], [70, 70], [80, 70]]) {
      expect(renderCausalConclusion(a!, b!, 100).toLowerCase()).not.toContain("vexp");
    }
  });
});
