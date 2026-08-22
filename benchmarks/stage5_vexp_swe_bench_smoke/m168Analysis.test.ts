import { describe, expect, test } from "bun:test";

import {
  behaviour,
  coercionVerdict,
  outcomeMatrix,
  pairedDelta,
  totalTraffic,
  type RunRecord,
} from "./m168Analysis";

function run(over: Partial<RunRecord> & { label: string; arm: RunRecord["arm"] }): RunRecord {
  return {
    instanceId: "a__a-1",
    costUsd: 0.5,
    inputTokens: 10,
    outputTokens: 100,
    cacheReadTokens: 500_000,
    cacheCreationTokens: 20_000,
    numTurns: 20,
    resolved: true,
    toolCalls: [],
    guardEvents: [],
    patchEmpty: false,
    ...over,
  };
}

const call = (tool: string, path: string | null = null) => ({ tool, category: "other", path });

describe("behaviour", () => {
  test("counts the investigation phase up to the first edit", () => {
    const b = behaviour(run({
      label: "l", arm: "vtrace_clean",
      toolCalls: [
        call("mcp__vtrace__run_pipeline"),
        call("Read", "/a.py"), call("Grep"), call("Read", "/b.py"),
        call("Edit", "/a.py"), call("Bash"), call("Edit", "/a.py"),
      ],
    }));
    expect(b.firstEditAtCall).toBe(4);
    expect(b.callsBeforeFirstEdit).toBe(4);
    expect(b.searchAttempts).toBe(1);
    expect(b.reads).toBe(2);
    expect(b.edits).toBe(2);
    expect(b.filesOpened).toBe(2);
    expect(b.firstActionWasPipeline).toBe(true);
  });

  test("a run that never edits reports null, not zero", () => {
    const b = behaviour(run({ label: "l", arm: "baseline", toolCalls: [call("Read", "/a.py")] }));
    expect(b.firstEditAtCall).toBeNull();
    expect(b.callsBeforeFirstEdit).toBe(1);
  });

  test("pipeline reuse excludes the mandated first call", () => {
    const b = behaviour(run({
      label: "l", arm: "vtrace_clean",
      toolCalls: [call("mcp__vtrace__run_pipeline"), call("mcp__vtrace__run_pipeline")],
    }));
    expect(b.pipelineCalls).toBe(2);
    expect(b.pipelineReuse).toBe(1);
  });

  test("a run with no tool calls makes no claim about its first action", () => {
    expect(behaviour(run({ label: "l", arm: "baseline" })).firstActionWasPipeline).toBeNull();
  });
});

describe("guard status is never assumed", () => {
  test("a strict run whose guard denied is GUARDED", () => {
    const b = behaviour(run({
      label: "l", arm: "vtrace_strict",
      guardEvents: [{ decision: "deny", indexPresent: true }],
    }));
    expect(b.guardStatus).toBe("GUARDED");
    expect(b.guardDenials).toBe(1);
  });

  test("a strict run whose guard ran and ALLOWED a search is GUARD_DEGRADED", () => {
    const b = behaviour(run({
      label: "l", arm: "vtrace_strict",
      toolCalls: [call("Grep")],
      guardEvents: [{ decision: "allow", indexPresent: false }],
    }));
    expect(b.guardStatus).toBe("GUARD_DEGRADED");
  });

  test("a strict run that never attempted a search is UNEXERCISED, not degraded — "
    + "the policy was in force, it simply was not needed", () => {
    const b = behaviour(run({
      label: "l", arm: "vtrace_strict", toolCalls: [call("Read", "/a.py")],
    }));
    expect(b.guardStatus).toBe("GUARD_UNEXERCISED");
  });

  test("searches attempted but no hook invocation at all is an apparatus FAULT", () => {
    const b = behaviour(run({
      label: "l", arm: "vtrace_strict", toolCalls: [call("Grep")], guardEvents: [],
    }));
    expect(b.guardStatus).toBe("GUARD_FAULT");
  });

  test("non-strict arms are NO_GUARD, distinct from an inactive guard", () => {
    for (const arm of ["baseline", "vtrace_clean"] as const) {
      expect(behaviour(run({ label: "l", arm })).guardStatus).toBe("NO_GUARD");
    }
  });
});

describe("paired comparison respects its own denominator", () => {
  test("only tasks present on both sides are paired", () => {
    const left = new Map([["t1", 10], ["t2", 20], ["t3", 30]]);
    const right = new Map([["t1", 15], ["t2", 18]]);
    const d = pairedDelta("x", left, right);
    expect(d.pairs).toBe(2);
    expect(d.medianPairedDelta).toBe((-5 + 2) / 2);
  });

  test("an empty pair set produces zeroes and says so", () => {
    const d = pairedDelta("x", new Map(), new Map([["t1", 1]]));
    expect(d.pairs).toBe(0);
    expect(d.medianPairedDelta).toBe(0);
  });

  test("direction counts are reported, not just the central tendency", () => {
    const d = pairedDelta("x", new Map([["a", 1], ["b", 9]]), new Map([["a", 5], ["b", 2]]));
    expect(d.leftLower).toBe(1);
    expect(d.rightLower).toBe(1);
  });
});

describe("outcome matrix", () => {
  const left = new Map<string, boolean | null>([["t1", true], ["t2", true], ["t3", false], ["t4", false]]);
  const right = new Map<string, boolean | null>([["t1", true], ["t2", false], ["t3", true], ["t4", false]]);

  test("classifies shared and unique outcomes", () => {
    const m = outcomeMatrix("B", "C", left, right);
    expect(m).toMatchObject({
      pairs: 4, sharedSuccess: 1, leftUniqueWin: 1, rightUniqueWin: 1, sharedFailure: 1, ungraded: 0,
    });
  });

  test("an ungraded side is ungraded, never a failure", () => {
    const m = outcomeMatrix("B", "C",
      new Map<string, boolean | null>([["t1", null]]),
      new Map<string, boolean | null>([["t1", true]]));
    expect(m.ungraded).toBe(1);
    expect(m.sharedFailure).toBe(0);
    expect(m.rightUniqueWin).toBe(0);
  });
});

describe("coercion verdict", () => {
  const base = {
    searchDelta: pairedDelta("search", new Map([["t", 2]]), new Map([["t", 10]])),
    costDelta: pairedDelta("cost", new Map([["t", 0.4]]), new Map([["t", 0.5]])),
    trafficDelta: pairedDelta("traffic", new Map([["t", 100]]), new Map([["t", 200]])),
    outcomes: outcomeMatrix("B", "C",
      new Map<string, boolean | null>([["t", true]]),
      new Map<string, boolean | null>([["t", true]])),
    guardedRuns: 1,
    guardUnexercisedRuns: 0,
    guardDegradedRuns: 0,
    guardFaultRuns: 0,
  };

  test("a sweep where the policy was nowhere in force cannot answer the question", () => {
    expect(coercionVerdict({
      ...base, guardedRuns: 0, guardUnexercisedRuns: 0, guardDegradedRuns: 12,
    }).verdict).toBe("INCONCLUSIVE_GUARD_INACTIVE");
  });

  test("unexercised runs still count as the policy being in force", () => {
    expect(coercionVerdict({ ...base, guardedRuns: 0, guardUnexercisedRuns: 6 }).verdict)
      .not.toBe("INCONCLUSIVE_GUARD_INACTIVE");
  });

  test("less work, same outcomes", () => {
    expect(coercionVerdict(base).verdict).toBe("COERCION_REDUCES_WORK_WITHOUT_OUTCOME_COST");
  });

  test("less work, lost tasks", () => {
    const outcomes = outcomeMatrix("B", "C",
      new Map<string, boolean | null>([["t", false]]),
      new Map<string, boolean | null>([["t", true]]));
    expect(coercionVerdict({ ...base, outcomes }).verdict)
      .toBe("COERCION_REDUCES_WORK_AT_OUTCOME_COST");
  });

  test("more searching under coercion is reported as increased work", () => {
    const searchDelta = pairedDelta("search", new Map([["t", 12]]), new Map([["t", 3]]));
    expect(coercionVerdict({ ...base, searchDelta }).verdict).toBe("COERCION_INCREASES_WORK");
  });

  test("work unchanged but cost up is increased work, not neutral", () => {
    const searchDelta = pairedDelta("search", new Map([["t", 5]]), new Map([["t", 5]]));
    const costDelta = pairedDelta("cost", new Map([["t", 0.9]]), new Map([["t", 0.5]]));
    expect(coercionVerdict({ ...base, searchDelta, costDelta }).verdict)
      .toBe("COERCION_INCREASES_WORK");
  });
});

describe("traffic", () => {
  test("sums all four billed channels", () => {
    expect(totalTraffic(run({ label: "l", arm: "baseline" }))).toBe(10 + 100 + 500_000 + 20_000);
  });
});
