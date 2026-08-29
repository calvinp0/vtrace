import { describe, expect, test } from "bun:test";

import {
  ORIENTATION_POLICY,
  orientationTokens as productOrientationTokens,
} from "../../src/runPipeline/orientationProjection";
import {
  M183_ARMS,
  M183_ORIENTATION_PREAMBLE,
  TOKENS_PER_CHARACTER,
  allocateProportional,
  armDefinition,
  buildSchedule,
  findLeakage,
  orientationWitness,
  renderOrientationSection,
  selectExtensionSample,
  stratumOrder,
  triggerContentForArm,
  type SampleCandidate,
} from "./m183Treatment";

const packet = Object.freeze({
  schemaVersion: "run_pipeline.orientation/1",
  focus: {
    at: "pkg/mod.py::Thing.method", file: "pkg/mod.py", lines: "10-20",
    form: "skeleton", why: "actionable method", code: "def method(self):", codeTruncated: false,
  },
  related: [
    { at: "pkg/other.py::Other", file: "pkg/other.py", lines: "1-9", how: "direct caller" },
    { at: "pkg/third.py::Third", file: "pkg/third.py", lines: null, how: "co-edit sibling" },
  ],
  boundary: "Focused orientation: ... Items not shown are not thereby absent.",
});

describe("M183 arm contracts", () => {
  test("both arms are frozen and neither carries a policy bundle", () => {
    expect([...M183_ARMS]).toEqual(["baseline", "vtrace_orientation"]);
    for (const arm of M183_ARMS) {
      const d = armDefinition(arm);
      // §7: the four things the treatment may not be.
      expect(d.mandatesPipelineFirst).toBe(false);
      expect(d.prohibitionText).toBe(false);
      expect(d.searchGuard).toBe(false);
      expect(d.antiLoopDiscipline).toBe(false);
      // §7/§8: ordinary tools are never denied, in either arm.
      expect(d.ordinaryToolsDenied).toBe(false);
      // §6: the tool environment is held fixed, so neither arm gets MCP.
      expect(d.mcpToolsPresent).toBe(false);
    }
  });

  test("orientation injection is the ONLY difference between the arms", () => {
    const a = armDefinition("baseline");
    const b = armDefinition("vtrace_orientation");
    const differing = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]);
    // `label` and `arm` are the arm's own identity, not a treatment difference.
    expect(differing.sort()).toEqual(["arm", "disclosure", "label", "orientationInjected"]);
  });

  test("baseline carries no trigger content at all, and null is not empty string", () => {
    expect(triggerContentForArm("baseline", packet)).toBeNull();
    expect(triggerContentForArm("vtrace_orientation", packet)).toBe(renderOrientationSection(packet));
  });
});

describe("M183 injected section", () => {
  test("the preamble contains no imperative addressed to the agent", () => {
    // The mechanical form of §7. Every M168/VEXP-style coercion is an imperative.
    const forbidden = [
      "must", "always", "first", "do not", "don't", "never use", "instead of",
      "call ", "use ", "trust", "ignore",
    ];
    const lower = M183_ORIENTATION_PREAMBLE.toLowerCase();
    for (const phrase of forbidden) expect(lower).not.toContain(phrase);
  });

  test("the section names no product, tool, or benchmark arm", () => {
    const lower = M183_ORIENTATION_PREAMBLE.toLowerCase();
    for (const name of ["vtrace", "run_pipeline", "mcp", "baseline", "treatment", "arm", "benchmark"]) {
      expect(lower).not.toContain(name);
    }
  });

  test("the rendered section is a pure function of the packet", () => {
    expect(renderOrientationSection(packet)).toBe(renderOrientationSection({ ...packet }));
    // Compact, so the injected bytes are the bytes a real MCP reply carries.
    expect(renderOrientationSection(packet)).toContain(JSON.stringify(packet));
    expect(renderOrientationSection(packet)).not.toContain(JSON.stringify(packet, null, 2));
  });
});

describe("M183 treatment witness", () => {
  test("a compact packet is DELIVERED and carries its identity", () => {
    const w = orientationWitness(packet);
    expect(w.deliveryState).toBe("ORIENTATION_DELIVERED");
    expect(w.schemaVersion).toBe("run_pipeline.orientation/1");
    expect(w.focusAt).toBe("pkg/mod.py::Thing.method");
    expect(w.relatedAt).toEqual(["pkg/other.py::Other", "pkg/third.py::Third"]);
    expect(w.relatedFiles).toEqual(["pkg/other.py", "pkg/third.py"]);
    expect(w.semanticHash).toHaveLength(64);
    expect(w.injectedSectionHash).not.toBe(w.semanticHash);
  });

  test("token accounting matches the PRODUCT's own calibration exactly", () => {
    // If the product retunes its calibration, this test fails rather than the
    // benchmark quietly reporting a different number than the product does.
    const w = orientationWitness(packet);
    expect(w.orientationTokens).toBe(productOrientationTokens(packet as never));
    // Several shapes, so the agreement is the calibration rather than a rounding
    // coincidence on one payload length.
    for (const variant of [
      { ...packet, related: [] },
      { ...packet, related: [...packet.related, ...packet.related] },
      { ...packet, focus: { ...packet.focus, code: "x".repeat(1500) } },
    ]) {
      expect(orientationWitness(variant).orientationTokens)
        .toBe(productOrientationTokens(variant as never));
    }
    // The section costs strictly more than the packet: the preamble is real.
    expect(w.injectedSectionTokens).toBeGreaterThan(w.orientationTokens);
  });

  test("the packet stays inside the product's own declared ceiling", () => {
    expect(orientationWitness(packet).orientationTokens).toBeLessThanOrEqual(
      ORIENTATION_POLICY.ceilingTokens);
  });

  test("a decline is a DELIVERY of the current product, not an absence", () => {
    expect(orientationWitness({ resolved: false, reason: "not_ready" }).deliveryState)
      .toBe("ORIENTATION_DECLINED");
  });

  test("an unclassifiable payload fails to ABSENT rather than to compact", () => {
    for (const bad of [null, undefined, "", 7, [], { focus: {} }]) {
      expect(orientationWitness(bad).deliveryState).toBe("ORIENTATION_ABSENT");
    }
    // A packet whose schema is right but which carries no focus is NOT delivered.
    expect(orientationWitness({ schemaVersion: "run_pipeline.orientation/1" }).deliveryState)
      .toBe("ORIENTATION_ABSENT");
  });
});

describe("M183 baseline leakage", () => {
  test("an ordinary task prompt is clean and the treatment section is not", () => {
    expect(findLeakage("Fix the bug in django/core/management.")).toEqual([]);
    expect(findLeakage(renderOrientationSection(packet)).length).toBeGreaterThan(0);
  });
});

describe("M183 sample construction", () => {
  test("largest-remainder allocation sums to the total and respects pool ceilings", () => {
    const pools = new Map([["django", 43], ["sympy", 16], ["mpl", 6], ["pylint", 1]]);
    const alloc = allocateProportional(pools, 18);
    expect([...alloc.values()].reduce((a, b) => a + b, 0)).toBe(18);
    for (const [k, v] of alloc) expect(v).toBeLessThanOrEqual(pools.get(k)!);
  });

  test("allocation cannot exceed the pool even when the total does", () => {
    const alloc = allocateProportional(new Map([["a", 2], ["b", 1]]), 99);
    expect([...alloc.entries()].sort()).toEqual([["a", 2], ["b", 1]]);
  });

  test("the draw is deterministic and independent of input order", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `x-${i}`);
    expect(stratumOrder("seed", ids)).toEqual(stratumOrder("seed", [...ids].reverse()));
    expect(stratumOrder("seed", ids)).not.toEqual(stratumOrder("other", ids));
    expect([...stratumOrder("seed", ids)].sort()).toEqual([...ids].sort());
  });

  test("extension selection stratifies by repository AND difficulty", () => {
    const candidates: SampleCandidate[] = [];
    for (let i = 0; i < 40; i += 1) {
      candidates.push({ instanceId: `django__django-${i}`, repo: "django/django", difficulty: i % 2 ? "a" : "b" });
    }
    for (let i = 0; i < 8; i += 1) {
      candidates.push({ instanceId: `sympy__sympy-${i}`, repo: "sympy/sympy", difficulty: i % 2 ? "a" : "b" });
    }
    const picked = selectExtensionSample(candidates, 12, "s");
    expect(picked).toHaveLength(12);
    expect(new Set(picked).size).toBe(12);
    const byRepo = new Map<string, number>();
    const byTier = new Map<string, number>();
    for (const id of picked) {
      const c = candidates.find((x) => x.instanceId === id)!;
      byRepo.set(c.repo, (byRepo.get(c.repo) ?? 0) + 1);
      byTier.set(c.difficulty, (byTier.get(c.difficulty) ?? 0) + 1);
    }
    expect(byRepo.get("django/django")).toBe(10);
    expect(byRepo.get("sympy/sympy")).toBe(2);
    // Both difficulty tiers are represented rather than one absorbing the draw.
    expect(byTier.get("a")).toBe(6);
    expect(byTier.get("b")).toBe(6);
    // Reproducible.
    expect(selectExtensionSample([...candidates].reverse(), 12, "s")).toEqual(picked);
  });
});

describe("M183 schedule", () => {
  test("arm order is balanced and frozen by position", () => {
    const schedule = buildSchedule(Array.from({ length: 30 }, (_, i) => `task-${i}`));
    expect(schedule).toHaveLength(30);
    const first = schedule.filter((r) => r.armOrder[0] === "baseline").length;
    expect(first).toBe(15);
    expect(schedule[0]!.armOrder).toEqual(["baseline", "vtrace_orientation"]);
    expect(schedule[1]!.armOrder).toEqual(["vtrace_orientation", "baseline"]);
    for (const row of schedule) expect([...row.armOrder].sort()).toEqual([...M183_ARMS].sort());
  });
});
