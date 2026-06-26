import { describe, expect, test } from "bun:test";
import {
  initCostGuardState,
  stepCostGuardRuntime,
  costGuardRuntimeResult,
  serializeCostGuardState,
  deserializeCostGuardState,
  parseCostGuardHookConfig,
  combineGuardInjections,
  runCostGuardHook,
  costGuardRuntimeMeta,
  COST_GUARD_OBSERVE_MODE,
  COST_GUARD_RUNTIME_MODE,
  type CostGuardRuntimeState,
} from "./costGuardRuntime";
import { runCostGuard, DEFAULT_COST_GUARD_CONFIG, COST_GUARD_MARKER, type CostGuardConfig, type CostGuardFiring } from "./costGuard";
import { TOOL_LOOP_GUARD_MARKER, type ToolLoopGuardFiring } from "./toolLoopGuard";
import type { ToolLoopGuardHookIo } from "./toolLoopGuardRuntime";

const ON: CostGuardConfig = { ...DEFAULT_COST_GUARD_CONFIG, enabled: true };

// In-memory IO so the fail-closed hook body is testable without a live agent.
function memIo(seed: Record<string, string> = {}): ToolLoopGuardHookIo & { files: Record<string, string>; log: string[] } {
  const files: Record<string, string> = { ...seed };
  const log: string[] = [];
  return {
    files,
    log,
    readState: (f) => (f in files ? files[f]! : null),
    writeState: (f, c) => {
      files[f] = c;
    },
    appendLog: (_f, line) => {
      log.push(line);
    },
  };
}

function postToolUse(tool: string, input: Record<string, unknown>, output?: unknown): string {
  return JSON.stringify({ tool_name: tool, tool_input: input, tool_output: output ?? "", session_id: "s1" });
}

describe("costGuardRuntime — state machine", () => {
  test("disabled config: accumulate-only no-op (never injects)", () => {
    let state = initCostGuardState();
    for (let i = 0; i < 40; i++) {
      const step = stepCostGuardRuntime(state, { index: i, tool: "Read", category: "read", path: "/a.py" }, DEFAULT_COST_GUARD_CONFIG);
      state = step.state;
      expect(step.injection).toBeNull();
    }
    expect(state.events.length).toBe(40);
  });

  // (16) runtime fires at EXACTLY the same turns as the batch detector (prefix-stable).
  test("incremental injections match the batch detector firing set", () => {
    const events = [
      ...Array.from({ length: 25 }, (_v, i) => ({ index: i, tool: "Read", category: "read", path: "/r.py" })),
      ...Array.from({ length: 6 }, (_v, i) => ({ index: 25 + i, tool: "Edit", category: "edit", path: "/same.py" })),
    ];
    const batch = runCostGuard(events, ON);
    let state: CostGuardRuntimeState = initCostGuardState();
    const incremental: number[] = [];
    for (const e of events) {
      const step = stepCostGuardRuntime(state, e, ON);
      state = step.state;
      if (step.injection) incremental.push(step.injection.turnIndex);
    }
    expect(incremental).toEqual(batch.events.map((f) => f.turnIndex));
    // and the canonical recomputed result agrees with the batch result
    expect(costGuardRuntimeResult(state, ON).injectionCount).toBe(batch.injectionCount);
  });

  test("state serialization round-trips", () => {
    let state = initCostGuardState();
    state = stepCostGuardRuntime(state, { index: 0, tool: "Read", category: "read", path: "/a.py" }, ON).state;
    const round = deserializeCostGuardState(serializeCostGuardState(state));
    expect(round.events.length).toBe(1);
    expect(deserializeCostGuardState(null).events).toEqual([]);
    expect(deserializeCostGuardState("not json").events).toEqual([]);
  });

  test("parseCostGuardHookConfig always forces enabled and merges overrides", () => {
    expect(parseCostGuardHookConfig(undefined).enabled).toBe(true);
    const merged = parseCostGuardHookConfig(JSON.stringify({ enabled: false, highToolCountThreshold: 50 }));
    expect(merged.enabled).toBe(true); // forced
    expect(merged.highToolCountThreshold).toBe(50);
    expect(parseCostGuardHookConfig("garbage").enabled).toBe(true);
  });
});

describe("costGuardRuntime — guard priority / combination", () => {
  const costFiring: CostGuardFiring = {
    turnIndex: 30,
    triggerType: "high_tool_count",
    signature: "tools",
    reason: "35 tool calls",
    message: `${COST_GUARD_MARKER}\ncost text\n</VTRACE_COST_GUARD>`,
    snapshot: { toolCount: 35, turnCount: null, readCount: 30, searchCount: 0, editCount: 1, verifyCount: 0, patchSeen: true, estimatedCostUsd: null },
  };
  const toolLoopFiring: ToolLoopGuardFiring = {
    turnIndex: 30,
    triggerType: "repeated_read",
    signature: "read:a.py",
    repeatCount: 3,
    message: `${TOOL_LOOP_GUARD_MARKER} loop text`,
  };

  // (14) combined/prioritized message behavior if both fire.
  test("both fire -> one combined message led by the cost guard, with a tool-loop tail", () => {
    const d = combineGuardInjections(costFiring, toolLoopFiring);
    expect(d.source).toBe("combined");
    expect(d.message).toContain(COST_GUARD_MARKER);
    expect(d.message).toContain(TOOL_LOOP_GUARD_MARKER);
    // cost text comes first (priority near budget)
    expect(d.message!.indexOf(COST_GUARD_MARKER)).toBeLessThan(d.message!.indexOf(TOOL_LOOP_GUARD_MARKER));
  });

  test("only cost fires -> cost message; only tool-loop fires -> tool-loop message; neither -> null", () => {
    expect(combineGuardInjections(costFiring, null)).toEqual({ source: "cost", message: costFiring.message });
    expect(combineGuardInjections(null, toolLoopFiring)).toEqual({ source: "tool_loop", message: toolLoopFiring.message });
    expect(combineGuardInjections(null, null)).toEqual({ source: null, message: null });
  });
});

describe("costGuardRuntime — hook body (fail-closed)", () => {
  // (15) runtime hook marker contains <VTRACE_COST_GUARD>.
  test("cost-guard-only hook injects the marker once the run is deep enough", () => {
    const io = memIo();
    const env = { stateFile: "/state/cost.json", logFile: "/log.jsonl", configJson: JSON.stringify({ minToolCallsBeforeFire: 3, highToolCountThreshold: 4 }) };
    let injected = false;
    // feed reads until the (lowered) thresholds trip
    for (let i = 0; i < 6; i++) {
      const r = runCostGuardHook(postToolUse("Read", { file_path: "/a.py" }), env, io);
      if (r.injected) {
        injected = true;
        expect(r.stdout).toContain(COST_GUARD_MARKER);
        expect(r.source).toBe("cost");
        break;
      }
    }
    expect(injected).toBe(true);
    expect(io.log.length).toBeGreaterThanOrEqual(1);
  });

  test("malformed stdin fails closed (inert no-op, never throws)", () => {
    const io = memIo();
    const r = runCostGuardHook("{not json", { stateFile: "/s.json" }, io);
    expect(r.injected).toBe(false);
    expect(r.stdout).not.toContain(COST_GUARD_MARKER);
  });

  // (13) cost guard and tool-loop guard can coexist via the combined hook.
  test("coexistence: combined hook evaluates BOTH guards when the tool-loop env is present", () => {
    const io = memIo();
    // Lower BOTH guards' thresholds so a short repeated-read run trips them on the same step.
    const env = {
      stateDir: "/cg",
      configJson: JSON.stringify({ minToolCallsBeforeFire: 3, highToolCountThreshold: 4, noPatchToolThreshold: 4 }),
      toolLoopStateDir: "/tlg",
      // tool-loop v0 so a pure-read loop is eligible; tiny thresholds to fire fast.
      toolLoopConfigJson: JSON.stringify({ calibration: "v0", repeatedReadThreshold: 3, cooldownToolCalls: 1, windowRepeatedReadThreshold: 99 }),
      logFile: "/log.jsonl",
    };
    let sawAnyInjection = false;
    let sawCostMarker = false;
    let sawToolLoopMarker = false;
    for (let i = 0; i < 8; i++) {
      const r = runCostGuardHook(postToolUse("Read", { file_path: "/loop.py" }), env, io);
      if (r.injected) {
        sawAnyInjection = true;
        if (r.stdout.includes(COST_GUARD_MARKER)) sawCostMarker = true;
        if (r.stdout.includes(TOOL_LOOP_GUARD_MARKER)) sawToolLoopMarker = true;
      }
    }
    // The combined hook evaluated BOTH guards over the same stream: the tool-loop guard
    // catches the repeated_read loop early, the cost guard catches no-patch drift later.
    expect(sawAnyInjection).toBe(true);
    expect(sawCostMarker).toBe(true);
    expect(sawToolLoopMarker).toBe(true);
    // both guards persisted their own state files (distinct namespaces)
    expect(Object.keys(io.files).some((f) => f.includes("cost_guard"))).toBe(true);
    expect(Object.keys(io.files).some((f) => f.includes("tool_loop_guard"))).toBe(true);
  });

  test("cost-guard-only hook does NOT touch tool-loop state when its env is absent", () => {
    const io = memIo();
    const env = { stateDir: "/cg", configJson: JSON.stringify({ minToolCallsBeforeFire: 3 }) };
    runCostGuardHook(postToolUse("Read", { file_path: "/a.py" }), env, io);
    expect(Object.keys(io.files).every((f) => !f.includes("tool_loop_guard"))).toBe(true);
  });
});

describe("costGuardRuntime — metadata", () => {
  test("runtime meta records hook availability + coexistence", () => {
    const avail = costGuardRuntimeMeta(true, true, null);
    expect(avail.cost_guard_runtime_hook_available).toBe(true);
    expect(avail.cost_guard_coexists_with_tool_loop_guard).toBe(true);
    const missing = costGuardRuntimeMeta(false, false, "patch absent");
    expect(missing.cost_guard_runtime_hook_available).toBe(false);
    expect(missing.cost_guard_runtime_hook_unavailable_reason).toBe("patch absent");
  });

  test("mode tokens are the stable strings", () => {
    expect(COST_GUARD_OBSERVE_MODE).toBe("observe_post_run");
    expect(COST_GUARD_RUNTIME_MODE).toBe("runtime_injection");
  });
});
