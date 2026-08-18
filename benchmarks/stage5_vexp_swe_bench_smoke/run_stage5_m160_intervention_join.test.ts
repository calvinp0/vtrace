import { describe, expect, test } from "bun:test";

import { crossCorpusVerdict } from "./run_stage5_m160_intervention_join";

function intervention(targetsAffected: number, recovered: number) {
  return {
    id: "X",
    scope: "s",
    describe: "d",
    targets: [] as string[],
    targetsAffected,
    recovered,
    recoveredInstances: [] as string[],
    blockedByDeliveryCeiling: [] as string[],
    repoCount: 1,
    verdict: "v",
    note: "n",
  };
}

describe("M160 cross-corpus intervention verdicts (§59)", () => {
  test("recovering on the derived corpus only is a fit, not generalization", () => {
    const result = crossCorpusVerdict(intervention(8, 5), intervention(6, 0));
    expect(result.verdict).toBe("REJECTED_CORPUS_SPECIFIC");
  });

  test("recovering on both corpora is the only recommendable outcome", () => {
    expect(crossCorpusVerdict(intervention(8, 5), intervention(6, 3)).verdict).toBe("RECOVERS_BOTH_CORPORA");
  });

  test("zero on both is rejected outright", () => {
    expect(crossCorpusVerdict(intervention(3, 0), intervention(4, 0)).verdict).toBe("REJECTED_BOTH_CORPORA");
  });

  test("no population on either corpus is distinguished from a failed intervention", () => {
    expect(crossCorpusVerdict(intervention(0, 0), intervention(0, 0)).verdict).toBe("NO_POPULATION");
  });

  test("a recovery that appears only on the independent corpus needs its own confirmation", () => {
    expect(crossCorpusVerdict(intervention(0, 0), intervention(5, 2)).verdict).toBe("NEW_ON_B_ONLY");
  });

  test("a missing simulation on one side is treated as zero, never as unknown-good", () => {
    expect(crossCorpusVerdict(intervention(4, 2), undefined).verdict).toBe("REJECTED_CORPUS_SPECIFIC");
  });
});
