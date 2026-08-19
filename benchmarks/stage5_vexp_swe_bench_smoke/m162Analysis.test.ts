import { describe, expect, test } from "bun:test";

import {
  classifyCallableBehaviour,
  classifyDiscordance,
  median,
  vtraceExposure,
} from "./m162Analysis";

describe("discordance", () => {
  test("labels the pattern that would most support the thesis", () => {
    expect(classifyDiscordance(false, false, true)).toBe("CALLABLE_ONLY_WIN");
  });
  test("labels unique callable harm", () => {
    expect(classifyDiscordance(true, true, false)).toBe("CALLABLE_ONLY_LOSS");
  });
  test("labels both VTRACE arms beating baseline", () => {
    expect(classifyDiscordance(false, true, true)).toBe("VTRACE_BOTH_WIN");
  });
  test("an ungraded arm is INCOMPLETE, never a failure", () => {
    expect(classifyDiscordance(true, null, true)).toBe("INCOMPLETE");
  });
  test("concordant cases", () => {
    expect(classifyDiscordance(true, true, true)).toBe("ALL_SUCCESS");
    expect(classifyDiscordance(false, false, false)).toBe("ALL_FAIL");
  });
});

describe("callable behaviour", () => {
  const base = {
    hasRun: true, toolsAvailable: true, vtraceCalls: 1, resultUsedCount: 0, redundantLookupCount: 0,
    callsAfterFirstEdit: 0, resolved: true, baselineResolved: true, staticResolved: true,
  };

  test("a missing run is never counted as an adoption datum", () => {
    expect(classifyCallableBehaviour({ ...base, hasRun: false, vtraceCalls: 0 })).toBe("NO_RUN");
  });

  test("unavailable tools are never reported as unused", () => {
    // A treatment failure and a declined affordance look identical in a call
    // count; only availability separates them.
    expect(classifyCallableBehaviour({ ...base, toolsAvailable: false, vtraceCalls: 0 }))
      .toBe("TOOLS_UNAVAILABLE");
  });

  test("zero calls with tools connected is a legitimate outcome", () => {
    expect(classifyCallableBehaviour({ ...base, vtraceCalls: 0 })).toBe("AVAILABLE_UNUSED");
  });

  test("unique harm outranks every positive label", () => {
    expect(classifyCallableBehaviour({
      ...base, resultUsedCount: 3, resolved: false, baselineResolved: true, staticResolved: true,
    })).toBe("USED_HARMFULLY");
  });

  test("a post-edit query that was acted on is the adaptation STATIC cannot do", () => {
    expect(classifyCallableBehaviour({ ...base, callsAfterFirstEdit: 1, resultUsedCount: 1 }))
      .toBe("USED_LATE_ADAPTIVE");
  });

  test("used and acted on", () => {
    expect(classifyCallableBehaviour({ ...base, resultUsedCount: 2 })).toBe("USED_EFFECTIVELY");
  });

  test("used, rediscovered, and never acted on", () => {
    expect(classifyCallableBehaviour({ ...base, redundantLookupCount: 2, resultUsedCount: 0 }))
      .toBe("USED_REDUNDANTLY");
  });
});

describe("exposure accounting", () => {
  test("baseline carries no VTRACE tokens", () => {
    expect(vtraceExposure("baseline", { staticCapsuleTokens: null, schemaTokens: 1937, policyTokens: 128, dynamicResultTokens: 0 }))
      .toEqual({ fixedTokens: 0, dynamicTokens: 0, totalTokens: 0 });
  });

  test("static is all fixed", () => {
    expect(vtraceExposure("static", { staticCapsuleTokens: 2565, schemaTokens: 0, policyTokens: 0, dynamicResultTokens: 0 }))
      .toEqual({ fixedTokens: 2565, dynamicTokens: 0, totalTokens: 2565 });
  });

  test("callable is fixed PLUS what it fetched, never fixed alone", () => {
    // The comparison that would be wrong: 2,065 < 2,565 therefore cheaper.
    const exposure = vtraceExposure("callable", {
      staticCapsuleTokens: null, schemaTokens: 1937, policyTokens: 128, dynamicResultTokens: 5337,
    });
    expect(exposure.fixedTokens).toBe(2065);
    expect(exposure.totalTokens).toBe(7402);
    expect(exposure.totalTokens).toBeGreaterThan(2565);
  });
});

describe("median", () => {
  test("odd and even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  test("empty is null, not zero", () => {
    expect(median([])).toBeNull();
  });
});
