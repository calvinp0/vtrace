/**
 * M172-C — the five controls that must hold before the frozen policy is allowed
 * near a holdout capture.
 *
 * M171's projector declared a token ceiling and never applied it; the bound that
 * actually acted was an undeclared count cap. M172 inverts that, which means the
 * ceiling has to be shown DOING something before it can be trusted as the sole
 * bound. Four of the five controls below would have passed vacuously against
 * M171's projector — the ceiling never bound there, so nothing could be observed
 * about its behaviour. They are written against a supply large enough to reach
 * it.
 */

import { describe, expect, test } from "bun:test";

import { auditPacket } from "./m171Soundness";
import { ORIENTATION_BOUNDARY, readPacketClaims } from "./m171Projection";
import {
  NO_RELATION_PHRASE,
  P_SUPPLY,
  packetTokens,
  projectOrientationM172,
  type OrientationPolicy,
} from "./m172Projection";

/**
 * A synthetic authoritative response with `count` related symbols.
 *
 * Shaped exactly like a captured one — items carry their bodies in
 * `modelVisibleContext` under `## [id]` headings, because that is the only place
 * a serialized response holds source text. Synthetic rather than captured
 * because development supply never exceeds 7 and the controls need the ceiling
 * to be reachable.
 */
function authoritativeState(count: number, bodyChars = 200): Record<string, unknown> {
  const items = Array.from({ length: count + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 },
    contentMode: "full",
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : `direct caller of pkg/focus.py::Focus.run`],
  }));
  const rendered = items
    .map((item) => `\n## [${item.id}]\nroles: ${item.roles.join(",")}\nlines: ${item.lineSpan.start}-${item.lineSpan.end}\n\n${"x".repeat(bodyChars)}`)
    .join("\n");
  return {
    productContext: {
      resolved: true,
      retrievalFound: true,
      deliveryFailed: false,
      leadPivot: "pkg/focus.py::Focus.run",
      items,
      modelVisibleContext: rendered,
      freshness: { status: "fresh", reason: "" },
    },
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
  };
}

const withCeiling = (ceilingTokens: number): OrientationPolicy =>
  Object.freeze({ ...P_SUPPLY, name: `P_SUPPLY@${ceilingTokens}`, ceilingTokens });

describe("M172 control 1 — the ceiling constrains the model-facing orientation", () => {
  test("a supply that would overflow the ceiling is bounded by it", () => {
    const state = authoritativeState(200);
    const packet = projectOrientationM172(state, P_SUPPLY);

    // The bound acts: not everything offered is delivered, and what is
    // delivered fits. Under M171 this assertion was unreachable.
    expect(packet.related.length).toBeLessThan(200);
    expect(packetTokens(packet)).toBeLessThanOrEqual(P_SUPPLY.ceilingTokens);
  });

  test("a lower ceiling admits strictly less", () => {
    const state = authoritativeState(200);
    const wide = projectOrientationM172(state, withCeiling(2000)).related.length;
    const narrow = projectOrientationM172(state, withCeiling(800)).related.length;
    expect(narrow).toBeLessThan(wide);
    expect(packetTokens(projectOrientationM172(state, withCeiling(800)))).toBeLessThanOrEqual(800);
  });

  test("the focus and its interpretation-critical notes are never evicted by the ceiling", () => {
    // §48 — a claim that cannot be rendered truthfully is omitted, never
    // weakened. A packet whose qualifier was dropped for budget is precisely the
    // overstrong rendering the rule forbids.
    const packet = projectOrientationM172(authoritativeState(200, 4000), withCeiling(50));
    expect(packet.focus).not.toBeNull();
    expect(packet.focus!.at).toBe("pkg/focus.py::Focus.run");
    expect(packet.focus!.codeTruncated).toBe(true);
    expect(packet.notes).toContain("The excerpt above is the head of a longer span.");
    expect(packet.boundary).toBe(ORIENTATION_BOUNDARY);
  });
});

describe("M172 control 2 — below the ceiling nothing is arbitrarily capped", () => {
  test("all authoritative supply is delivered when it fits", () => {
    for (const count of [1, 3, 5, 6, 7, 9, 12]) {
      const packet = projectOrientationM172(authoritativeState(count), P_SUPPLY);
      expect(packetTokens(packet)).toBeLessThanOrEqual(P_SUPPLY.ceilingTokens);
      expect(packet.related.length).toBe(count);
    }
  });

  test("supply beyond M171's cap of five is no longer withheld", () => {
    const packet = projectOrientationM172(authoritativeState(7), P_SUPPLY);
    expect(packet.related.length).toBe(7);
  });
});

describe("M172 control 3 — at and above the ceiling, selection stays deterministic and truthful", () => {
  test("projection is a pure function of state and policy", () => {
    const state = authoritativeState(200);
    const once = JSON.stringify(projectOrientationM172(state, P_SUPPLY));
    for (let i = 0; i < 5; i += 1) {
      expect(JSON.stringify(projectOrientationM172(state, P_SUPPLY))).toBe(once);
    }
  });

  test("the projector does not mutate the authoritative state it reads", () => {
    const state = authoritativeState(200);
    const before = JSON.stringify(state);
    projectOrientationM172(state, P_SUPPLY);
    expect(JSON.stringify(state)).toBe(before);
  });

  test("a ceiling-bound packet asserts nothing the state does not support", () => {
    const state = authoritativeState(200);
    const packet = projectOrientationM172(state, P_SUPPLY);
    expect(auditPacket(packet, state)).toEqual([]);
  });

  test("truncation by the ceiling never becomes a claim of absence", () => {
    // §7 — omitted is not absent. The boundary is what licenses the omission, so
    // it must be present exactly when the packet is most selective.
    const packet = projectOrientationM172(authoritativeState(200), withCeiling(400));
    expect(packet.related.length).toBeLessThan(200);
    expect(packet.boundary).toBe(ORIENTATION_BOUNDARY);
    expect(packet.boundary).toContain("not an exhaustive repository listing");
    expect(packet.boundary).toContain("Items not shown are not thereby absent");
  });

  test("admission is a prefix of the authoritative order, never a re-ranking", () => {
    const state = authoritativeState(40);
    const bound = projectOrientationM172(state, withCeiling(600));
    const full = projectOrientationM172(state, withCeiling(1_000_000));
    expect(full.related.slice(0, bound.related.length).map((r) => r.at))
      .toEqual(bound.related.map((r) => r.at));
  });
});

describe("M172 control 4 — raising the ceiling never removes admitted evidence", () => {
  test("evidence sets are nested across ascending ceilings", () => {
    const state = authoritativeState(60);
    const ceilings = [300, 500, 800, 1200, 1600, 2000, 2500];
    let previous: string[] = [];
    for (const ceiling of ceilings) {
      const named = projectOrientationM172(state, withCeiling(ceiling)).related.map((r) => r.at);
      for (const at of previous) expect(named).toContain(at);
      expect(named.length).toBeGreaterThanOrEqual(previous.length);
      previous = named;
    }
  });

  test("the focus excerpt grows monotonically and stays a prefix", () => {
    const state = authoritativeState(5, 6000);
    const short = projectOrientationM172(state, { ...P_SUPPLY, focusCodeCharacters: 500 }).focus!.code!;
    const long = projectOrientationM172(state, { ...P_SUPPLY, focusCodeCharacters: 3000 }).focus!.code!;
    expect(long.startsWith(short)).toBe(true);
  });
});

describe("M172 control 5 — unused capacity attracts nothing", () => {
  test("a packet complete below its ceiling is byte-identical at a higher one", () => {
    // The direct answer to M166, where freeing bytes made the packer reach for
    // more evidence. Supply of 6 is complete far below any of these ceilings.
    const state = authoritativeState(6);
    const baseline = JSON.stringify(projectOrientationM172(state, withCeiling(2000)));
    for (const ceiling of [2500, 5000, 20_000, Number.MAX_SAFE_INTEGER]) {
      expect(JSON.stringify(projectOrientationM172(state, withCeiling(ceiling)))).toBe(baseline);
    }
  });

  test("freeing unrelated internal bytes does not move the orientation", () => {
    // §53 — the packet must not change because some component elsewhere in the
    // authoritative response got smaller.
    const lean = authoritativeState(6);
    const fat = authoritativeState(6);
    (fat as Record<string, unknown>).diagnostics = {
      freshness: { readiness: { ready: true } },
      ballast: Array.from({ length: 400 }, (_, i) => ({ i, note: "x".repeat(200) })),
    };
    expect(JSON.stringify(projectOrientationM172(fat, P_SUPPLY)))
      .toBe(JSON.stringify(projectOrientationM172(lean, P_SUPPLY)));
  });

  test("no proximity-only entry is promoted to fill space", () => {
    // Removing the cap must not become a licence to reach for weaker material:
    // what the packet carries is what the authoritative state supplied, and a
    // state supplying no proximity entries yields a packet containing none.
    const packet = projectOrientationM172(authoritativeState(6), P_SUPPLY);
    const claims = readPacketClaims(packet);
    expect(packet.related.some((r) => r.how === NO_RELATION_PHRASE)).toBe(false);
    expect(claims.relationClaims.every((c) => c.how !== "")).toBe(true);
  });
});
