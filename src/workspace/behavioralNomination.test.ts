import { describe, expect, test } from "bun:test";

import {
  BehavioralEvidenceClass,
  BehavioralNominationStatus,
  classifyRepositoryEvidence,
  isAdmissible,
  isSubjectAligned,
  nominateByEvidenceClass,
  type BehavioralCandidateSummary,
} from "./behavioralNomination";

function candidate(
  fqName: string,
  alignment: BehavioralCandidateSummary["alignment"],
  compatibility: "direct" | "partial" = "direct",
): BehavioralCandidateSummary {
  return { fqName, factKind: "first_item", alignment, compatibility };
}

describe("evidence classes", () => {
  test("both alignments M150 treats as subject-aligned count as aligned", () => {
    expect(isSubjectAligned("direct_operand")).toBe(true);
    expect(isSubjectAligned("local_producer")).toBe(true);
    expect(isSubjectAligned("none")).toBe(false);
    expect(isSubjectAligned("undecidable")).toBe(false);
  });

  test("lexical-only evidence is never admissible", () => {
    expect(isAdmissible(BehavioralEvidenceClass.LexicalOnly)).toBe(false);
    expect(isAdmissible(BehavioralEvidenceClass.DirectAligned)).toBe(true);
    expect(isAdmissible(BehavioralEvidenceClass.DirectUnaligned)).toBe(true);
    expect(isAdmissible(BehavioralEvidenceClass.Partial)).toBe(true);
  });
});

describe("classifyRepositoryEvidence", () => {
  test("a repository with no candidates carries only lexical evidence", () => {
    const evidence = classifyRepositoryEvidence("alpha", []);
    expect(evidence.evidenceClass).toBe(BehavioralEvidenceClass.LexicalOnly);
    expect(evidence.bestCandidate).toBeNull();
  });

  test("the strongest candidate sets the class, not the most numerous", () => {
    const evidence = classifyRepositoryEvidence("alpha", [
      candidate("a.py::one", "none"),
      candidate("a.py::two", "none"),
      candidate("a.py::three", "direct_operand"),
    ]);
    expect(evidence.evidenceClass).toBe(BehavioralEvidenceClass.DirectAligned);
    expect(evidence.bestCandidate?.fqName).toBe("a.py::three");
  });

  test("volume is discarded: forty weak facts still classify as unaligned", () => {
    const many = Array.from({ length: 40 }, (_, i) => candidate(`a.py::f${i}`, "none"));
    expect(classifyRepositoryEvidence("big", many).evidenceClass).toBe(
      BehavioralEvidenceClass.DirectUnaligned,
    );
  });
});

describe("nominateByEvidenceClass", () => {
  test("§44 a small aligned repository beats a large unaligned one", () => {
    const small = classifyRepositoryEvidence("small", [candidate("s.py::pick", "direct_operand")]);
    const large = classifyRepositoryEvidence(
      "large",
      Array.from({ length: 40 }, (_, i) => candidate(`l.py::f${i}`, "none")),
    );
    const nomination = nominateByEvidenceClass([large, small]);
    expect(nomination.status).toBe(BehavioralNominationStatus.Selected);
    expect(nomination.lead?.alias).toBe("small");
    expect(nomination.decidingClass).toBe(BehavioralEvidenceClass.DirectAligned);
  });

  test("§48 two repositories tied at the strongest class abstain", () => {
    const a = classifyRepositoryEvidence("a", [candidate("a.py::pick", "direct_operand")]);
    const b = classifyRepositoryEvidence("b", [candidate("b.py::pick", "direct_operand")]);
    const nomination = nominateByEvidenceClass([a, b]);
    expect(nomination.status).toBe(BehavioralNominationStatus.Ambiguous);
    expect(nomination.lead).toBeNull();
    expect(nomination.tied.map((entry) => entry.alias)).toEqual(["a", "b"]);
  });

  test("a tie is never broken by candidate count", () => {
    const few = classifyRepositoryEvidence("few", [candidate("f.py::a", "direct_operand")]);
    const lots = classifyRepositoryEvidence("lots", [
      candidate("l.py::a", "direct_operand"),
      candidate("l.py::b", "direct_operand"),
      candidate("l.py::c", "direct_operand"),
    ]);
    expect(nominateByEvidenceClass([few, lots]).status).toBe(
      BehavioralNominationStatus.Ambiguous,
    );
  });

  test("§50/§51 word overlap alone never decides", () => {
    const docs = classifyRepositoryEvidence("docs", []);
    const tests = classifyRepositoryEvidence("tests", []);
    const nomination = nominateByEvidenceClass([docs, tests]);
    expect(nomination.status).toBe(BehavioralNominationStatus.NoDecision);
    expect(nomination.lead).toBeNull();
  });

  test("no probed repositories is a no-decision, never a selection", () => {
    expect(nominateByEvidenceClass([]).status).toBe(BehavioralNominationStatus.NoDecision);
  });

  test("a weaker class decides only when nothing stronger exists anywhere", () => {
    const partial = classifyRepositoryEvidence("p", [candidate("p.py::x", "none", "partial")]);
    const other = classifyRepositoryEvidence("o", []);
    const nomination = nominateByEvidenceClass([partial, other]);
    expect(nomination.status).toBe(BehavioralNominationStatus.Selected);
    expect(nomination.lead?.alias).toBe("p");
    expect(nomination.decidingClass).toBe(BehavioralEvidenceClass.Partial);
  });

  test("§103/§104 the verdict does not depend on input order", () => {
    const a = classifyRepositoryEvidence("a", [candidate("a.py::x", "direct_operand")]);
    const b = classifyRepositoryEvidence("b", [candidate("b.py::x", "none")]);
    const forward = nominateByEvidenceClass([a, b]);
    const reversed = nominateByEvidenceClass([b, a]);
    expect(forward.lead?.alias).toBe("a");
    expect(reversed.lead?.alias).toBe("a");
    expect(forward.status).toBe(reversed.status);
  });

  test("a no-decision states it found nothing, never that nothing exists", () => {
    const nomination = nominateByEvidenceClass([classifyRepositoryEvidence("a", [])]);
    expect(nomination.reason).toContain("No repository carries behavioural evidence");
    // §58: the lane may not phrase its failure as an absence proof.
    expect(nomination.reason).not.toContain("does not exist");
    expect(nomination.reason).not.toContain("absent");
  });
});
