// M84 — first-class C7 cost-guard calibration (v0 | c7d). c7d lowers editVerifyChurnThreshold
// 3 -> 2 so same-file edit/verify churn fires one cycle earlier; EVERY other threshold
// (incl. the 25-tool protective gate) is unchanged. These tests pin: the default-off
// invariant, the calibration constructor, the churn-timing delta on compact django-16263 /
// sympy-12419 fixtures, metadata provenance, observe + inject (runtime) parity, V4
// coexistence config validity, and determinism. PURE detector — no agents, no Docker.

import { describe, expect, test } from "bun:test";
import {
  runCostGuard,
  costGuardMeta,
  costGuardConfigForCalibration,
  COST_GUARD_CALIBRATION_CHURN_THRESHOLD,
  DEFAULT_COST_GUARD_CONFIG,
  type CostGuardConfig,
  type CostGuardEvent,
} from "./costGuard";
import {
  initCostGuardState,
  stepCostGuardRuntime,
  parseCostGuardHookConfig,
  runCostGuardHook,
  type CostGuardRuntimeState,
} from "./costGuardRuntime";
import { TOOL_LOOP_GUARD_MARKER } from "./toolLoopGuard";
import type { ToolLoopGuardHookIo } from "./toolLoopGuardRuntime";

const V0: CostGuardConfig = costGuardConfigForCalibration("v0", { enabled: true });
const C7D: CostGuardConfig = costGuardConfigForCalibration("c7d", { enabled: true });

let auto = 0;
function read(path = "/repo/a.py"): CostGuardEvent {
  return { index: auto++, tool: "Read", category: "read", path };
}
function edit(path = "/repo/same.py"): CostGuardEvent {
  return { index: auto++, tool: "Edit", category: "edit", path };
}
function bash(command: string, opts: { success?: boolean; output?: string } = {}): CostGuardEvent {
  return { index: auto++, tool: "Bash", category: "other", command, success: opts.success ?? null, output: opts.output ?? null };
}
function times<T>(n: number, fn: () => T): T[] {
  return Array.from({ length: n }, fn);
}
function reindex(events: CostGuardEvent[]): CostGuardEvent[] {
  return events.map((e, i) => ({ ...e, index: i }));
}

// ---------------------------------------------------------------------------
// (1)+(10) default-off / early-orientation
// ---------------------------------------------------------------------------
describe("M84 calibration — default-off invariant", () => {
  test("(1) the module default is default-off AND calibration v0; a disabled config never fires", () => {
    expect(DEFAULT_COST_GUARD_CONFIG.enabled).toBe(false);
    expect(DEFAULT_COST_GUARD_CONFIG.calibration).toBe("v0");
    auto = 0;
    const events = reindex(times(40, () => read()));
    const res = runCostGuard(events); // DEFAULT (disabled)
    expect(res.enabled).toBe(false);
    expect(res.wouldFire).toBe(false);
    expect(res.events).toEqual([]);
    expect(res.suppressedEvents).toEqual([]); // fully inert
  });

  test("(10) early orientation does not fire under EITHER calibration (gate held)", () => {
    auto = 0;
    // two same-file edits at the very start: c7d's threshold of 2 is met, but the 25-tool
    // gate is not — so the churn is suppressed, never fired, for both calibrations.
    const events = reindex([edit("/repo/x.py"), edit("/repo/x.py"), read(), read()]);
    for (const cfg of [V0, C7D]) {
      const res = runCostGuard(events, cfg);
      expect(res.wouldFire).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (2)+(4)+(5)+(6) constructor / threshold invariants
// ---------------------------------------------------------------------------
describe("M84 calibration — constructor + threshold invariants", () => {
  test("(2)+(4) the calibration constructor records the calibration and the right churn threshold", () => {
    expect(COST_GUARD_CALIBRATION_CHURN_THRESHOLD).toEqual({ v0: 3, c7d: 2 });
    expect(V0.calibration).toBe("v0");
    expect(C7D.calibration).toBe("c7d");
    expect(V0.editVerifyChurnThreshold).toBe(3);
    expect(C7D.editVerifyChurnThreshold).toBe(2);
    expect(V0.enabled).toBe(true);
    expect(C7D.enabled).toBe(true);
  });

  test("(5)+(6) c7d differs from v0 in ONLY editVerifyChurnThreshold (and the calibration label)", () => {
    const keys = Object.keys(V0) as Array<keyof CostGuardConfig>;
    const differing = keys.filter((k) => V0[k] !== C7D[k]);
    expect(differing.sort()).toEqual(["calibration", "editVerifyChurnThreshold"]);
    // every protected default is byte-identical across the two calibrations.
    expect(C7D.minToolCallsBeforeFire).toBe(25);
    expect(C7D.minTurnsBeforeFire).toBe(8);
    expect(C7D.highToolCountThreshold).toBe(35);
    expect(C7D.highTurnCountThreshold).toBe(90);
    expect(C7D.noPatchToolThreshold).toBe(30);
    expect(C7D.repeatedVerifyThreshold).toBe(3);
    expect(C7D.costCapFraction).toBe(0.85);
    expect(C7D.maxInjections).toBe(2);
    expect(C7D.cooldownToolCalls).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// (7)+(8)+(9) churn-cycle behavior + gate
// ---------------------------------------------------------------------------
describe("M84 calibration — edit/verify churn timing", () => {
  // A two-cycle same-file churn that lands AFTER the 25-tool gate is open.
  function twoCycleChurnAfterGate(): CostGuardEvent[] {
    return reindex([
      ...times(25, () => read()), // open the 25-tool gate
      edit("/repo/same.py"),
      bash("pytest", { success: false }),
      edit("/repo/same.py"), // 2nd edit to same.py
    ]);
  }

  test("(7) c7d fires edit_verify_churn after 2 cycles once the gate is satisfied", () => {
    const events = twoCycleChurnAfterGate();
    const res = runCostGuard(events, C7D);
    const churn = res.events.find((e) => e.triggerType === "edit_verify_churn");
    expect(churn).toBeTruthy();
    expect(churn!.signature).toBe("churn:same.py");
  });

  test("(8) v0 does NOT fire on the same 2-cycle churn (threshold still 3)", () => {
    const events = twoCycleChurnAfterGate();
    const res = runCostGuard(events, V0);
    expect(res.events.some((e) => e.triggerType === "edit_verify_churn")).toBe(false);
    // and nothing else fires either: 28 tools < high/no-patch thresholds.
    expect(res.wouldFire).toBe(false);
  });

  test("(9) the 25-tool gate still gates c7d: a 2-cycle churn BEFORE the gate is suppressed", () => {
    auto = 0;
    const events = reindex([edit("/repo/same.py"), edit("/repo/same.py")]); // toolCount 2, gate closed
    const res = runCostGuard(events, C7D);
    expect(res.wouldFire).toBe(false);
    expect(res.suppressedEvents.some((s) => s.reason === "gates_not_open")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (11)+(12)+(13) compact case fixtures derived from the M83 event shapes
// ---------------------------------------------------------------------------
describe("M84 calibration — compact case fixtures", () => {
  // django-16263 shape: high tool count, only TWO edits to the same file separated by a
  // verify, the 2nd landing at toolCount 25 (turnIndex 24); the run continues to 35 tools.
  //   V0 : churn (3) never reached -> first fire is high_tool_count at turnIndex 34.
  //   c7d: churn (2) fires at the 2nd same-file edit -> first fire at turnIndex 24 (+10 earlier).
  function django16263(): CostGuardEvent[] {
    return reindex([
      ...times(22, () => read()), // toolCount 22
      edit("/repo/models.py"), // idx22, same.py edit #1, toolCount 23
      bash("python -m pytest", { success: false }), // idx23, toolCount 24
      edit("/repo/models.py"), // idx24, same.py edit #2, toolCount 25 -> c7d churn
      ...times(10, () => read()), // push toolCount to 35 (idx34) -> high_tool_count
    ]);
  }

  test("(12) django-16263: c7d first-fires +10 tools earlier than v0", () => {
    const events = django16263();
    const v0 = runCostGuard(events, V0);
    const c7d = runCostGuard(events, C7D);
    expect(v0.firstEventTurn).toBe(34);
    expect(v0.events[0]!.triggerType).toBe("high_tool_count");
    expect(c7d.firstEventTurn).toBe(24);
    expect(c7d.events[0]!.triggerType).toBe("edit_verify_churn");
    expect(v0.firstEventTurn! - c7d.firstEventTurn!).toBe(10);
  });

  // sympy-12419 shape: a deep run that reaches the high tool count WITHOUT ever editing the
  // SAME file twice (distinct single edits + repeated failing commands). Lowering the churn
  // threshold therefore changes nothing — the winning trajectory is untouched.
  function sympy12419(): CostGuardEvent[] {
    return reindex([
      ...times(20, () => read()),
      edit("/repo/a.py"), // distinct file
      ...times(13, () => bash("python repro.py", { success: false })), // command loop, not edit churn
      edit("/repo/b.py"), // distinct file (no same-file 2nd edit anywhere)
    ]); // 35 tools -> high_tool_count at turnIndex 34 under both
  }

  test("(13) sympy-12419: c7d does NOT fire earlier and matches v0 exactly (trajectory safe)", () => {
    const events = sympy12419();
    const v0 = runCostGuard(events, V0);
    const c7d = runCostGuard(events, C7D);
    expect(c7d.firstEventTurn).toBe(v0.firstEventTurn);
    expect(c7d.firstEventTurn).toBe(34);
    expect(c7d.events[0]!.triggerType).toBe("high_tool_count");
    expect(c7d.events.some((e) => e.triggerType === "edit_verify_churn")).toBe(false);
  });

  test("(11) a pytest-style short run stays silent under BOTH calibrations", () => {
    auto = 0;
    // ~12 tools, a couple of edits to different files, a passing verify — like a quick win.
    const events = reindex([
      read(), read(), bash("grep -r foo .", { success: true }), read(),
      edit("/repo/a.py"), read(), bash("python -m pytest test_a.py", { success: true }),
      edit("/repo/b.py"), read(), read(), bash("python -m pytest", { success: true }), read(),
    ]);
    for (const cfg of [V0, C7D]) {
      const res = runCostGuard(events, cfg, { estimatedCostUsd: 0.4, turnCount: 18 });
      expect(res.wouldFire).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (14)+(15)+(16) metadata + observe / inject (runtime) parity
// ---------------------------------------------------------------------------
describe("M84 calibration — metadata + observe/inject parity", () => {
  test("(14)+(15) costGuardMeta records cost_guard_calibration top-level and per-event (observe mode)", () => {
    auto = 0;
    const events = reindex([...times(25, () => read()), edit("/repo/same.py"), bash("pytest", { success: false }), edit("/repo/same.py")]);
    const res = runCostGuard(events, C7D);
    const meta = costGuardMeta(res, "observe_post_run");
    expect(meta.cost_guard_calibration).toBe("c7d");
    expect(meta.cost_guard_mode).toBe("observe_post_run");
    expect(meta.cost_guard_events.length).toBeGreaterThan(0);
    expect(meta.cost_guard_events.every((e) => e.calibration === "c7d")).toBe(true);
    // v0 path records the v0 label.
    const metaV0 = costGuardMeta(runCostGuard(events, V0), "observe_post_run");
    expect(metaV0.cost_guard_calibration).toBe("v0");
  });

  test("(15)+(16) the runtime injector uses the selected calibration (inject mode parity)", () => {
    auto = 0;
    const events = reindex([
      ...times(22, () => read()),
      edit("/repo/models.py"),
      bash("python -m pytest", { success: false }),
      edit("/repo/models.py"), // c7d churn at turnIndex 24
      ...times(10, () => read()),
    ]);
    // Drive the incremental runtime state machine under each calibration; the first
    // injection turn must match the batch detector (prefix-stable) for that calibration.
    for (const cfg of [V0, C7D]) {
      const batch = runCostGuard(events, cfg);
      let state: CostGuardRuntimeState = initCostGuardState();
      const injectedTurns: number[] = [];
      for (const e of events) {
        const step = stepCostGuardRuntime(state, e, cfg);
        state = step.state;
        if (step.injection) injectedTurns.push(step.injection.turnIndex);
      }
      expect(injectedTurns).toEqual(batch.events.map((f) => f.turnIndex));
    }
    // Concretely: c7d injects churn at 24 first; v0's first injection is high_tool at 34.
    const firstC7d = runCostGuard(events, C7D).events[0]!;
    const firstV0 = runCostGuard(events, V0).events[0]!;
    expect(firstC7d.turnIndex).toBe(24);
    expect(firstC7d.triggerType).toBe("edit_verify_churn");
    expect(firstV0.turnIndex).toBe(34);
  });
});

// ---------------------------------------------------------------------------
// (17) V4 + C7_D combined hook config validity
// ---------------------------------------------------------------------------
describe("M84 calibration — V4 coexistence", () => {
  function memIo(): ToolLoopGuardHookIo & { files: Record<string, string> } {
    const files: Record<string, string> = {};
    return {
      files,
      readState: (f) => (f in files ? files[f]! : null),
      writeState: (f, c) => {
        files[f] = c;
      },
      appendLog: () => {},
    };
  }

  test("(17) the runner's c7d hook config parses to a valid enabled c7d config", () => {
    // Exactly what sharedConditionEnv serializes into VTRACE_COST_GUARD_CONFIG.
    const json = JSON.stringify(costGuardConfigForCalibration("c7d", { enabled: true }));
    const cfg = parseCostGuardHookConfig(json);
    expect(cfg.enabled).toBe(true);
    expect(cfg.calibration).toBe("c7d");
    expect(cfg.editVerifyChurnThreshold).toBe(2);
    expect(cfg.minToolCallsBeforeFire).toBe(25); // gate intact
  });

  test("(17) combined cost(c7d) + tool-loop(v4) hook runs without throwing and persists both states", () => {
    const io = memIo();
    const env = {
      stateDir: "/cg",
      configJson: JSON.stringify(costGuardConfigForCalibration("c7d", { enabled: true, minToolCallsBeforeFire: 3, highToolCountThreshold: 4, noPatchToolThreshold: 4 })),
      toolLoopStateDir: "/tlg",
      toolLoopConfigJson: JSON.stringify({ calibration: "v4", repeatedReadThreshold: 3, cooldownToolCalls: 1 }),
    };
    let injectedAny = false;
    for (let i = 0; i < 8; i++) {
      const r = runCostGuardHook(
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/loop.py" }, tool_output: "", session_id: "s" }),
        env,
        io,
      );
      if (r.injected) injectedAny = true;
    }
    expect(injectedAny).toBe(true); // the combined hook produced at least one recovery message
    expect(Object.keys(io.files).some((f) => f.includes("cost_guard"))).toBe(true);
    expect(Object.keys(io.files).some((f) => f.includes("tool_loop_guard"))).toBe(true);
    // sanity: the marker constant is wired (coexistence path imports it)
    expect(TOOL_LOOP_GUARD_MARKER.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (18) determinism
// ---------------------------------------------------------------------------
describe("M84 calibration — determinism", () => {
  test("(18) runCostGuard is a pure function of (events, calibration) for both v0 and c7d", () => {
    auto = 0;
    const events = reindex([...times(25, () => read()), ...times(4, () => edit("/repo/same.py")), bash("pytest", { success: false })]);
    for (const cfg of [V0, C7D]) {
      const a = runCostGuard(events, cfg);
      const b = runCostGuard(events, cfg);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    // and the two calibrations are genuinely distinguishable on this churn input.
    expect(JSON.stringify(runCostGuard(events, V0))).not.toBe(JSON.stringify(runCostGuard(events, C7D)));
  });
});
