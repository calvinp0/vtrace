/**
 * The decline contract.
 *
 * A compact default is only honest if its NON-answers are compact too. Before
 * M174-A, an orientation the projector declined to make cost the model 6,482
 * tokens to say one sentence, because the fallback shipped the whole
 * authoritative result. These are the properties the replacement has to have
 * before it is allowed to replace it: it must stay small, it must never claim
 * absence, it must not soften a repository failure into a shrug, and it must
 * decline to compact anything it cannot positively identify.
 */

import { describe, expect, test } from "bun:test";

import {
  DECLINE_BOUNDARY,
  DECLINE_FROZEN_PHRASES,
  DECLINE_SCHEMA_VERSION,
  DECLINE_SUMMARIES,
  OrientationDeclineState,
  decideDecline,
  declineTokens,
  projectOrientationDecline,
  readDeclineEvidence,
} from "./orientationDecline";

/** A resolved-but-degraded result shaped like the real matplotlib one. */
function degraded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    diagnostics: { freshness: { readiness: { ready: true } } },
    productContext: {
      resolved: false,
      retrievalFound: true,
      deliveryFailed: true,
      resultState: "delivery_failure",
      leadPivot: "lib/matplotlib/axis.py::Axis.convert_units",
      topMatchReference: "lib/matplotlib/axis.py::Axis.convert_units",
      items: [],
      delivery: { status: "failed", selectedItemsBeforeBudget: 10, deliveredItems: 0 },
      freshness: { status: "fresh", reason: "" },
      modelVisibleContext: "# VTRACE delivery failure\nRelevant evidence was found, but the minimum deliverable representation could not fit the complete response envelope.\nIncrease max_tokens or narrow the request.",
      ...(overrides.productContext as Record<string, unknown> ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "productContext")),
  };
}

describe("the decline is compact and truthful", () => {
  test("it replaces the authoritative dossier with a small result", () => {
    const decline = projectOrientationDecline(degraded())!;
    expect(decline.schemaVersion).toBe(DECLINE_SCHEMA_VERSION);
    // §13's experimental target. The path it replaces measured 6,482.
    expect(declineTokens(decline)).toBeLessThanOrEqual(250);
  });

  test("it carries the boundary on every decline, unconditionally", () => {
    for (const output of [degraded(), degraded({ productContext: { retrievalFound: false, deliveryFailed: false } })]) {
      expect(projectOrientationDecline(output)!.boundary).toBe(DECLINE_BOUNDARY);
    }
  });

  test("the boundary refuses to turn an absent focus into an absent implementation", () => {
    expect(DECLINE_BOUNDARY).toContain("not an assertion that relevant code does not exist");
  });

  test("it authors nothing outside the frozen phrases and the authoritative record", () => {
    const decline = projectOrientationDecline(degraded())!;
    expect(DECLINE_FROZEN_PHRASES).toContain(decline.summary);
    expect(DECLINE_FROZEN_PHRASES).toContain(decline.boundary);
    // The remedy is quoted from the product's own degraded context, not written here.
    expect(decline.nextStep).toBe("Increase max_tokens or narrow the request.");
  });
});

describe("the four states are distinguished, not conflated (§9)", () => {
  test("evidence found and then evicted is a delivery failure, not an empty search", () => {
    // The matplotlib case: retrievalFound AND deliveryFailed are both true. A
    // policy that tested retrieval first would call this a successful no-result.
    const decline = projectOrientationDecline(degraded())!;
    expect(decline.state).toBe(OrientationDeclineState.EvidenceFoundButUndelivered);
    expect(decline.summary).toBe(DECLINE_SUMMARIES[OrientationDeclineState.EvidenceFoundButUndelivered]);
  });

  test("retrieval finding nothing is reported as retrieval finding nothing", () => {
    const decline = projectOrientationDecline(
      degraded({ productContext: { retrievalFound: false, deliveryFailed: false, topMatchReference: "", leadPivot: "" } }),
    )!;
    expect(decline.state).toBe(OrientationDeclineState.NoRelevantEvidence);
  });

  test("an unready index is a repository state and outranks everything else", () => {
    const decline = projectOrientationDecline({
      ...degraded(),
      diagnostics: { freshness: { readiness: { ready: false } } },
    })!;
    expect(decline.state).toBe(OrientationDeclineState.RepositoryNotReady);
  });

  test("delivered items with no projectable identity are a valid empty orientation", () => {
    const decline = projectOrientationDecline(
      degraded({ productContext: { resolved: true, deliveryFailed: false, items: [{ path: "a.py" }] } }),
    )!;
    expect(decline.state).toBe(OrientationDeclineState.NoFocusSelected);
  });
});

describe("the top match is disclosed only where the record holds one", () => {
  test("a lost-to-budget result names its top match, because the match is real", () => {
    expect(projectOrientationDecline(degraded())!.topMatch).toBe("lib/matplotlib/axis.py::Axis.convert_units");
  });

  test("an empty retrieval names nothing, because a top match of nothing is a false lead", () => {
    const decline = projectOrientationDecline(
      degraded({ productContext: { retrievalFound: false, deliveryFailed: false } }),
    )!;
    expect(decline.topMatch).toBeUndefined();
  });

  test("an unready index names nothing", () => {
    const decline = projectOrientationDecline({
      ...degraded(),
      diagnostics: { freshness: { readiness: { ready: false } } },
    })!;
    expect(decline.topMatch).toBeUndefined();
  });
});

describe("it fails closed on shapes it cannot identify", () => {
  test.each([
    ["a non-record", 42],
    ["null", null],
    ["a result with no productContext", { diagnostics: {} }],
  ])("%s keeps the full authoritative envelope", (_name, value) => {
    expect(projectOrientationDecline(value)).toBeNull();
    expect(readDeclineEvidence(value)).toBeNull();
  });
});

describe("interpretation-critical state survives", () => {
  test("a stale index says so, verbatim", () => {
    const decline = projectOrientationDecline(
      degraded({ productContext: { freshness: { status: "stale", reason: "head moved" } } }),
    )!;
    expect(decline.notes).toEqual(["Index freshness: stale (head moved)."]);
  });

  test("a fresh index adds no note", () => {
    expect(projectOrientationDecline(degraded())!.notes).toBeUndefined();
  });
});

describe("the policy's ordering is the policy", () => {
  test("readiness outranks retrieval and delivery", () => {
    expect(decideDecline({
      ready: false, retrievalFound: true, deliveryFailed: true, deliveredItems: 0,
      selectedBeforeBudget: 10, topMatch: "a.py::B", freshnessStatus: "fresh", freshnessReason: "",
    }).state).toBe(OrientationDeclineState.RepositoryNotReady);
  });

  test("a genuine empty retrieval outranks the delivery flag", () => {
    expect(decideDecline({
      ready: true, retrievalFound: false, deliveryFailed: true, deliveredItems: 0,
      selectedBeforeBudget: 0, topMatch: "", freshnessStatus: "fresh", freshnessReason: "",
    }).state).toBe(OrientationDeclineState.NoRelevantEvidence);
  });
});
