import { describe, expect, test } from "bun:test";

import {
  baselineCarriesVtraceEvidence,
  checkPromptParity,
  classifyLeadQuality,
  classifyTreatmentState,
  type TreatmentMeta,
} from "./m161Treatment";

const PIVOT = { path: "pkg/mod.py", symbol: "f" };
const SUPPORT = { path: "pkg/other.py", symbol: "g" };

function meta(over: TreatmentMeta = {}): TreatmentMeta {
  return {
    vtraceTreatmentValid: true,
    vtraceInjectionError: null,
    vtraceInjectionObserved: true,
    vtraceIndexedContext: true,
    vtraceCapsulePivots: [PIVOT],
    vtraceCapsuleSupport: [SUPPORT],
    vtraceInstructionsFileSize: 4096,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §32-§34, §122 — every treatment state needs a demonstrated known positive.
// ---------------------------------------------------------------------------

describe("M161 treatment-state detector — known positives (§122)", () => {
  test("VALID_NONEMPTY", () => {
    const got = classifyTreatmentState(meta());
    expect(got.state).toBe("VALID_NONEMPTY");
    expect(got.deliveredItems).toBe(2);
  });

  test("VALID_DELIVERY_EMPTY — retrieval succeeded, delivered nothing", () => {
    const got = classifyTreatmentState(meta({ vtraceCapsulePivots: [], vtraceCapsuleSupport: [] }));
    expect(got.state).toBe("VALID_DELIVERY_EMPTY");
    expect(got.deliveredItems).toBe(0);
  });

  test("DEGRADED_VALID — usable index with contained parse failures", () => {
    const got = classifyTreatmentState(meta({ vtraceIndexDegraded: true, vtraceIndexFailedFiles: ["a.py", "b.pyx"] }));
    expect(got.state).toBe("DEGRADED_VALID");
    expect(got.degraded).toBe(true);
  });

  test("TREATMENT_UNAVAILABLE — injection error", () => {
    const got = classifyTreatmentState(meta({ vtraceInjectionError: "whole-repository index aborted: SyntaxError" }));
    expect(got.state).toBe("TREATMENT_UNAVAILABLE");
  });

  test("TREATMENT_UNAVAILABLE — runner reported the treatment invalid", () => {
    expect(classifyTreatmentState(meta({ vtraceTreatmentValid: false })).state).toBe("TREATMENT_UNAVAILABLE");
  });

  test("CORPUS_INVALID short-circuits before any product judgement", () => {
    expect(classifyTreatmentState(meta(), { corpusInvalid: true }).state).toBe("CORPUS_INVALID");
  });

  test("a product failure that ALSO delivered nothing is UNAVAILABLE, not EMPTY", () => {
    // The M155 misclassification, as a regression test: an aborted index delivers
    // zero items, and calling that a legitimate empty delivery hides a real
    // availability failure inside a normal-looking outcome (§34, §69).
    const got = classifyTreatmentState(meta({
      vtraceInjectionError: "whole-repository index aborted",
      vtraceCapsulePivots: [],
      vtraceCapsuleSupport: [],
    }));
    expect(got.state).toBe("TREATMENT_UNAVAILABLE");
    expect(got.deliveredItems).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §62-§63, §122
// ---------------------------------------------------------------------------

describe("M161 lead-quality detector — known positives (§122)", () => {
  const base = { state: "VALID_NONEMPTY" as const, pivots: [PIVOT], support: [SUPPORT] };

  test("LEAD_GOLD when the lead file is gold", () => {
    const got = classifyLeadQuality({ ...base, goldFiles: ["pkg/mod.py"] });
    expect(got.quality).toBe("LEAD_GOLD");
    expect(got.top1Gold).toBe(true);
    expect(got.top3Gold).toBe(true);
    expect(got.goldDelivered).toEqual(["pkg/mod.py"]);
  });

  test("LEAD_WRONG_GOLD_ELSEWHERE when gold is delivered but not led with", () => {
    const got = classifyLeadQuality({ ...base, goldFiles: ["pkg/other.py"] });
    expect(got.quality).toBe("LEAD_WRONG_GOLD_ELSEWHERE");
    expect(got.top1Gold).toBe(false);
    expect(got.goldAnywhere).toBe(true);
    expect(got.leadFile).toBe("pkg/mod.py");
  });

  test("LEAD_WRONG_NO_GOLD when no delivered item is gold", () => {
    const got = classifyLeadQuality({ ...base, goldFiles: ["pkg/absent.py"] });
    expect(got.quality).toBe("LEAD_WRONG_NO_GOLD");
    expect(got.goldAnywhere).toBe(false);
    expect(got.goldDelivered).toEqual([]);
  });

  test("VALID_EMPTY carries no lead and no gold claim", () => {
    const got = classifyLeadQuality({ state: "VALID_DELIVERY_EMPTY", pivots: [], support: [], goldFiles: ["pkg/mod.py"] });
    expect(got.quality).toBe("VALID_EMPTY");
    expect(got.leadFile).toBeNull();
    expect(got.goldAnywhere).toBe(false);
  });

  test("TREATMENT_UNAVAILABLE never claims gold state", () => {
    const got = classifyLeadQuality({ state: "TREATMENT_UNAVAILABLE", pivots: [PIVOT], support: [], goldFiles: ["pkg/mod.py"] });
    expect(got.quality).toBe("TREATMENT_UNAVAILABLE");
    expect(got.goldAnywhere).toBe(false);
    expect(got.goldDelivered).toEqual([]);
  });

  test("top-3 spans pivots then support in delivery order", () => {
    const got = classifyLeadQuality({
      state: "VALID_NONEMPTY",
      pivots: [{ path: "a.py" }, { path: "b.py" }],
      support: [{ path: "gold.py" }, { path: "d.py" }],
      goldFiles: ["gold.py"],
    });
    expect(got.top1Gold).toBe(false);
    expect(got.top3Gold).toBe(true);
    expect(got.quality).toBe("LEAD_WRONG_GOLD_ELSEWHERE");
  });

  test("gold at position 4 is delivered but not top-3", () => {
    const got = classifyLeadQuality({
      state: "VALID_NONEMPTY",
      pivots: [{ path: "a.py" }, { path: "b.py" }],
      support: [{ path: "c.py" }, { path: "gold.py" }],
      goldFiles: ["gold.py"],
    });
    expect(got.top3Gold).toBe(false);
    expect(got.goldAnywhere).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §83-§85, §122
// ---------------------------------------------------------------------------

describe("M161 prompt parity — known positives and negatives (§84)", () => {
  const SHARED = ["You are working on the acme/pkg repository.", "Fix the issue.", "## TOOL_USE_DISCIPLINE", "- stay focused"].join("\n");
  const EVIDENCE = ["# vtrace instructions", "## Pivots", "- pkg/mod.py::f"].join("\n");
  const stripEvidence = (text: string): string => text.replace(`\n${EVIDENCE}`, "");
  const detectTokenDiscipline = (text: string): boolean => text.includes("## STAGE5_TOKEN_DISCIPLINE");

  test("parity holds when the arms differ only by the evidence block", () => {
    const got = checkPromptParity({
      baseline: SHARED,
      vtrace: `${SHARED}\n${EVIDENCE}`,
      stripEvidence,
      detectTokenDiscipline,
    });
    expect(got.identicalAfterEvidenceRemoval).toBe(true);
    expect(got.residualDifferences).toEqual([]);
    expect(got.vtraceEvidenceBytes).toBe(EVIDENCE.length + 1);
    expect(got.tokenDisciplinePresent).toEqual({ baseline: false, vtrace: false });
  });

  test("parity FAILS on a hidden advice asymmetry (known positive)", () => {
    // The exact defect M161 froze out: an extra instruction riding only the VTRACE
    // arm. Stripping the evidence leaves it behind, so the residual diff catches it.
    const got = checkPromptParity({
      baseline: SHARED,
      vtrace: `${SHARED}\n## STAGE5_TOKEN_DISCIPLINE\n- patch first, do not grep\n${EVIDENCE}`,
      stripEvidence,
      detectTokenDiscipline,
    });
    expect(got.identicalAfterEvidenceRemoval).toBe(false);
    expect(got.tokenDisciplinePresent.vtrace).toBe(true);
    expect(got.tokenDisciplinePresent.baseline).toBe(false);
  });

  test("parity FAILS when VTRACE evidence leaks into the baseline (known positive)", () => {
    const got = checkPromptParity({
      baseline: `${SHARED}\n## Pivots\n- leaked.py`,
      vtrace: `${SHARED}\n${EVIDENCE}`,
      stripEvidence,
      detectTokenDiscipline,
    });
    expect(got.identicalAfterEvidenceRemoval).toBe(false);
    expect(got.residualDifferences.some((d) => d.includes("VTRACE evidence marker"))).toBe(true);
  });

  test("the baseline evidence detector fires and stays silent correctly (§83)", () => {
    expect(baselineCarriesVtraceEvidence(SHARED)).toEqual([]);
    expect(baselineCarriesVtraceEvidence(`${SHARED}\n## Support\n- x.py`)).toEqual(["## Support"]);
  });
});
