import { describe, expect, test } from "bun:test";

import type { RawToolCall } from "./m162Telemetry";
import {
  adoptionRate,
  aggregate,
  classifyAdoption,
  classifyTriggerCompliance,
  pairedDeltas,
  summarizePairedDeltas,
  tokenTraffic,
  triggerComplianceRate,
} from "./m163Adoption";

const call = (tool: string): RawToolCall => ({ tool } as RawToolCall);
const VT = call("mcp__vtrace__get_code_context");

describe("adoption state", () => {
  test("an arm that never ran is NOT_RUN, whatever else is known", () => {
    expect(classifyAdoption({ executed: false, toolsAvailable: true, vtraceCallCount: 0 })).toBe("NOT_RUN");
    expect(classifyAdoption({ executed: false, toolsAvailable: null, vtraceCallCount: 0 })).toBe("NOT_RUN");
  });

  test("AVAILABLE_UNUSED requires an executed run with proven availability", () => {
    // The claim "the agent had the tools and did not use them" is M163's central
    // measurement. It may never be produced by an arm that did not run, and it
    // may never be inferred from configuration intent.
    expect(classifyAdoption({ executed: false, toolsAvailable: true, vtraceCallCount: 0 })).not.toBe("AVAILABLE_UNUSED");
    expect(classifyAdoption({ executed: true, toolsAvailable: null, vtraceCallCount: 0 })).toBe("INVALID");
    expect(classifyAdoption({ executed: true, toolsAvailable: false, vtraceCallCount: 0 })).toBe("TOOLS_UNAVAILABLE");
    expect(classifyAdoption({ executed: true, toolsAvailable: true, vtraceCallCount: 0 })).toBe("AVAILABLE_UNUSED");
  });

  test("a run whose treatment failed to arrive is INVALID, not non-adoption", () => {
    expect(classifyAdoption({
      executed: true, toolsAvailable: true, vtraceCallCount: 0, treatmentFailure: true,
    })).toBe("INVALID");
  });

  test("adoption rate excludes and counts every non-denominator state", () => {
    const rate = adoptionRate([
      "AVAILABLE_USED", "AVAILABLE_USED", "AVAILABLE_UNUSED",
      "NOT_RUN", "TOOLS_UNAVAILABLE", "INVALID",
    ]);
    expect(rate).toEqual({
      used: 2,
      unused: 1,
      denominator: 3,
      rate: 2 / 3,
      excluded: { NOT_RUN: 1, TOOLS_UNAVAILABLE: 1, INVALID: 1 },
    });
  });

  test("an empty denominator yields null, never a 0% adoption claim", () => {
    expect(adoptionRate(["NOT_RUN", "NOT_RUN"]).rate).toBeNull();
    expect(adoptionRate(["NOT_RUN", "NOT_RUN"]).denominator).toBe(0);
  });
});

describe("trigger compliance", () => {
  const ctx = { isTriggerArm: true, adoption: "AVAILABLE_USED" } as const;

  test("VTRACE first is compliant", () => {
    const result = classifyTriggerCompliance([VT, call("Read"), call("Edit")], ctx);
    expect(result.state).toBe("TRIGGER_COMPLIED");
    expect(result.ordinaryCallsBefore).toBe(0);
    expect(result.firstVtraceCallIndex).toBe(0);
  });

  test("any ordinary repository action first is non-compliant, even if VTRACE follows", () => {
    const result = classifyTriggerCompliance([call("Grep"), VT], ctx);
    expect(result.state).toBe("TRIGGER_NOT_COMPLIED");
    expect(result.ordinaryCallsBefore).toBe(1);
  });

  test("bash counts as an ordinary repository action", () => {
    expect(classifyTriggerCompliance([call("Bash"), VT], ctx).state).toBe("TRIGGER_NOT_COMPLIED");
  });

  test("TodoWrite is bookkeeping and is reported without breaking compliance", () => {
    const result = classifyTriggerCompliance([call("TodoWrite"), VT], ctx);
    expect(result.state).toBe("TRIGGER_COMPLIED");
    expect(result.bookkeepingCallsBefore).toBe(1);
    expect(result.ordinaryCallsBefore).toBe(0);
  });

  test("a delivered trigger with no VTRACE call at all is non-compliance, not absence", () => {
    const result = classifyTriggerCompliance([call("Read"), call("Edit")], {
      isTriggerArm: true, adoption: "AVAILABLE_UNUSED",
    });
    expect(result.state).toBe("TRIGGER_NOT_COMPLIED");
  });

  test("compliance is undefined for arms that did not run or lacked tools", () => {
    for (const adoption of ["NOT_RUN", "TOOLS_UNAVAILABLE", "INVALID"] as const) {
      expect(classifyTriggerCompliance([], { isTriggerArm: true, adoption }).state).toBe("NOT_MEASURABLE");
    }
  });

  test("non-trigger arms are NOT_APPLICABLE and never enter the rate", () => {
    expect(classifyTriggerCompliance([VT], { isTriggerArm: false, adoption: "AVAILABLE_USED" }).state)
      .toBe("NOT_APPLICABLE");
    const rate = triggerComplianceRate([
      "TRIGGER_COMPLIED", "TRIGGER_NOT_COMPLIED", "NOT_APPLICABLE", "NOT_MEASURABLE",
    ]);
    expect(rate).toEqual({
      complied: 1,
      notComplied: 1,
      denominator: 2,
      rate: 0.5,
      excluded: { NOT_APPLICABLE: 1, NOT_MEASURABLE: 1 },
    });
  });
});

describe("aggregation never coerces absence to zero", () => {
  test("missing values are dropped and counted, not treated as 0", () => {
    // The M162 defect: a 4-of-36 sweep reported medians pulled toward zero by
    // the 32 arms that had not run, which read as a very cheap experiment.
    expect(aggregate([10, 20, 30, null, undefined])).toEqual({
      median: 20, mean: 20, n: 3, missing: 2,
    });
    expect(aggregate([10, 20, 30, 0, 0]).median).toBe(10);
  });

  test("an all-absent column yields null, not 0", () => {
    expect(aggregate([null, null])).toEqual({ median: null, mean: null, n: 0, missing: 2 });
  });

  test("NaN and Infinity are absent, not values", () => {
    expect(aggregate([1, Number.NaN, Number.POSITIVE_INFINITY]).n).toBe(1);
  });
});

describe("token traffic", () => {
  test("cache reads are inside total model traffic", () => {
    // M162: uncached input+output in the hundreds, cache reads ~1e6. Omitting
    // the dominant term describes a different experiment than the one that ran.
    const traffic = tokenTraffic({
      inputTokens: 300, cacheReadTokens: 1_000_000, cacheCreationTokens: 20_000, outputTokens: 4_000,
    });
    expect(traffic.totalModelTraffic).toBe(1_024_300);
  });

  test("all-absent traffic is null, not zero", () => {
    expect(tokenTraffic({}).totalModelTraffic).toBeNull();
  });

  test("a partially reported row totals what is present and keeps the parts visible", () => {
    const traffic = tokenTraffic({ inputTokens: 100, outputTokens: 50 });
    expect(traffic.totalModelTraffic).toBe(150);
    expect(traffic.cacheReadTokens).toBeNull();
  });
});

describe("paired deltas", () => {
  const ids = ["a", "b", "c"];
  const from = new Map<string, number | null>([["a", 30], ["b", 20], ["c", null]]);
  const to = new Map<string, number | null>([["a", 25], ["b", 26], ["c", 10]]);

  test("a pair with either side absent is incomparable, not a delta of the present side", () => {
    const deltas = pairedDeltas(ids, from, to);
    expect(deltas.map((entry) => entry.delta)).toEqual([-5, 6, null]);
  });

  test("direction is explicit, so the same routine cannot invert a verdict", () => {
    const deltas = pairedDeltas(ids, from, to);
    expect(summarizePairedDeltas(deltas, { lowerIsBetter: true })).toEqual({
      improved: 1, worsened: 1, unchanged: 0, comparable: 2, incomparable: 1, medianDelta: 0.5,
    });
    expect(summarizePairedDeltas(deltas, { lowerIsBetter: false }).improved).toBe(1);
    expect(summarizePairedDeltas(deltas, { lowerIsBetter: false }).worsened).toBe(1);
  });
});
