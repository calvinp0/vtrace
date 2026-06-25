import { describe, expect, test } from "bun:test";
import {
  runToolLoopGuard,
  DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  TOOL_LOOP_GUARD_MARKER,
  type ToolLoopGuardEvent,
  type ToolLoopGuardConfig,
  type ToolLoopGuardFiring,
} from "./toolLoopGuard";
import {
  initRuntimeState,
  stepToolLoopGuardRuntime,
  runtimeResult,
  serializeRuntimeState,
  deserializeRuntimeState,
  postToolUseEventToGuardEvent,
  toolNameToCategory,
  renderHookStdout,
  TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT,
  buildToolLoopGuardHookSettings,
  parseHookConfig,
  runToolLoopGuardHook,
  toolLoopGuardRuntimeMeta,
  TOOL_LOOP_GUARD_OBSERVE_MODE,
  TOOL_LOOP_GUARD_RUNTIME_MODE,
  type ToolLoopGuardRuntimeState,
  type ToolLoopGuardHookIo,
} from "./toolLoopGuardRuntime";

// ON = enabled at the DEFAULT calibration (V4, M79). ON_V0 restores the pre-M79
// behavior for state-machine mechanics tests built on pure opening-orientation read/
// search loops (which V4 deliberately suppresses).
const ON: ToolLoopGuardConfig = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true };
const ON_V0: ToolLoopGuardConfig = { ...ON, calibration: "v0" };

// ---- event builders (mirror toolLoopGuard.test.ts) ------------------------
let auto = 0;
function bash(command: string, opts: { success?: boolean; output?: string } = {}): ToolLoopGuardEvent {
  return { index: auto++, tool: "Bash", category: "other", command, success: opts.success ?? null, output: opts.output ?? null };
}
function read(path: string): ToolLoopGuardEvent {
  return { index: auto++, tool: "Read", category: "read", path, output: null };
}
function search(query: string, path = "/x", output?: string): ToolLoopGuardEvent {
  return { index: auto++, tool: "Grep", category: "search", query, path, output: output ?? null };
}
function edit(path: string): ToolLoopGuardEvent {
  return { index: auto++, tool: "Edit", category: "edit", path, success: true, output: null };
}
function reindex(events: ToolLoopGuardEvent[]): ToolLoopGuardEvent[] {
  return events.map((e, i) => ({ ...e, index: i }));
}

// Drive a full event stream through the incremental runtime state machine.
function drive(events: ToolLoopGuardEvent[], config: ToolLoopGuardConfig = ON): {
  state: ToolLoopGuardRuntimeState;
  injections: ToolLoopGuardFiring[];
} {
  let state = initRuntimeState();
  const injections: ToolLoopGuardFiring[] = [];
  for (const e of events) {
    const step = stepToolLoopGuardRuntime(state, e, config);
    state = step.state;
    if (step.injection) injections.push(step.injection);
  }
  return { state, injections };
}

// ---- default-off + observe parity -----------------------------------------
describe("runtime injector — default-off & observe parity", () => {
  test("disabled config accumulates events but NEVER injects", () => {
    auto = 0;
    const events = reindex([bash("pytest", { success: false }), bash("pytest", { success: false })]);
    const { state, injections } = drive(events, { ...ON, enabled: false });
    expect(injections).toEqual([]);
    expect(state.events.length).toBe(2);
    expect(state.injectedSignatures).toEqual([]);
  });

  test("runtimeResult equals the batch observe-mode result over the same events", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py"), bash("pytest", { success: false, output: "1 failed" })]);
    const { state } = drive(events, ON);
    const batch = runToolLoopGuard(events, ON);
    expect(runtimeResult(state, ON)).toEqual(batch);
  });

  test("incremental injection sequence matches the batch firing list exactly (timing parity)", () => {
    auto = 0;
    const events = reindex([
      read("/a.py"), read("/a.py"), read("/a.py"), // repeated_read fires at idx 2
      bash("cmdA", { success: false, output: "ValueError" }),
      bash("cmdA", { success: false, output: "ValueError" }), // repeated_failed_command later
    ]);
    const { injections } = drive(events, ON);
    const batch = runToolLoopGuard(events, ON).events;
    expect(injections.map((f) => [f.turnIndex, f.triggerType, f.signature])).toEqual(
      batch.map((f) => [f.turnIndex, f.triggerType, f.signature]),
    );
  });
});

// ---- per-trigger injection -------------------------------------------------
describe("runtime injector — triggers", () => {
  test("injects exactly one message for a repeated failed command", () => {
    auto = 0;
    const events = reindex([
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
    ]);
    const { injections } = drive(events, ON);
    expect(injections.length).toBe(1);
    expect(injections[0]!.triggerType).toBe("repeated_failed_command");
    expect(injections[0]!.message).toContain(TOOL_LOOP_GUARD_MARKER);
  });

  test("injects exactly one message for a repeated read loop (V0 mechanics)", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py")]);
    const { injections } = drive(events, ON_V0);
    expect(injections.length).toBe(1);
    expect(injections[0]!.triggerType).toBe("repeated_read");
  });

  test("injects exactly one message for a repeated search loop (V0 mechanics)", () => {
    auto = 0;
    const events = reindex([search("class Foo", "/p", "hit"), search("class Foo", "/p", "hit")]);
    const { injections } = drive(events, ON_V0);
    expect(injections.length).toBe(1);
    expect(injections[0]!.triggerType).toBe("repeated_search");
  });

  // (17) under V4 (the default), a pure opening read loop is NOT injected mid-loop; the
  // same loop AFTER a search IS — the runtime state machine honors the calibration.
  test("V4: a pure opening read loop injects nothing, but the same loop after a search injects", () => {
    auto = 0;
    const pure = drive(reindex([read("/a.py"), read("/a.py"), read("/a.py")]), ON);
    expect(pure.injections).toEqual([]);
    auto = 0;
    const afterSearch = drive(reindex([search("q", "/p", "hit"), read("/a.py"), read("/a.py"), read("/a.py")]), ON);
    expect(afterSearch.injections.length).toBe(1);
    expect(afterSearch.injections[0]!.triggerType).toBe("repeated_read");
  });

  // V4: command-failure loops are still injected with no prior search/edit.
  test("V4: a repeated failed command still injects without prior progress", () => {
    auto = 0;
    const events = reindex([
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
    ]);
    const { injections } = drive(events, ON);
    expect(injections.length).toBe(1);
    expect(injections[0]!.triggerType).toBe("repeated_failed_command");
  });

  test("a progress event (intervening edit) resets the repeated-read streak — no injection", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), edit("/a.py"), read("/a.py")]);
    const { injections } = drive(events, ON);
    expect(injections).toEqual([]);
  });

  test("a progress event (new search) resets the repeated-read streak — no injection", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), search("new query"), read("/a.py")]);
    const { injections } = drive(events, ON);
    expect(injections).toEqual([]);
  });
});

// ---- caps / cooldown / suppression ----------------------------------------
describe("runtime injector — caps, cooldown, suppression", () => {
  test("cooldown suppresses an immediate second injection", () => {
    auto = 0;
    const events = reindex([
      bash("cmdA", { success: false, output: "ValueError" }),
      bash("cmdA", { success: false, output: "ValueError" }), // fires at idx 1
      bash("cmdB", { success: false, output: "KeyError" }),
      bash("cmdB", { success: false, output: "KeyError" }), // idx 3 — within cooldown 5 of idx 1
    ]);
    const tight = drive(events, { ...ON, cooldownToolCalls: 5, maxInjections: 3 });
    expect(tight.injections.length).toBe(1);
    auto = 0;
    const events2 = reindex([
      bash("cmdA", { success: false, output: "ValueError" }),
      bash("cmdA", { success: false, output: "ValueError" }),
      bash("cmdB", { success: false, output: "KeyError" }),
      bash("cmdB", { success: false, output: "KeyError" }),
    ]);
    const loose = drive(events2, { ...ON, cooldownToolCalls: 0, maxInjections: 3 });
    expect(loose.injections.length).toBe(2);
  });

  test("maxInjections cap is respected across distinct loops", () => {
    auto = 0;
    const events: ToolLoopGuardEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(read(`/f${i}.py`), read(`/f${i}.py`), read(`/f${i}.py`));
    // cooldown 1 = realistic "at most one delivered message per turn"; the detector
    // self-suppresses the co-firing window signal at an already-injected index.
    const { state, injections } = drive(reindex(events), { ...ON_V0, cooldownToolCalls: 1, maxInjections: 3 });
    expect(injections.length).toBe(3);
    expect(state.injectedSignatures.length).toBe(3); // canonical firing set is also capped
  });

  test("the same loop signature injects at most once", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py"), read("/a.py"), read("/a.py")]);
    // Under the production cooldown the same read:a.py loop warns exactly once.
    const { injections } = drive(events, ON_V0);
    expect(injections.length).toBe(1);
    expect(injections[0]!.signature).toBe("read:a.py");
  });
});

// ---- determinism -----------------------------------------------------------
describe("runtime injector — determinism", () => {
  test("identical streams yield identical injections across reruns", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py"), bash("pytest", { success: false, output: "1 failed" }), bash("pytest", { success: false, output: "1 failed" })]);
    const a = drive(events, { ...ON, cooldownToolCalls: 0 });
    const b = drive(events, { ...ON, cooldownToolCalls: 0 });
    expect(JSON.stringify(a.injections)).toBe(JSON.stringify(b.injections));
  });
});

// ---- state serialization ---------------------------------------------------
describe("runtime injector — state serialization", () => {
  test("serialize/deserialize round-trips and resumes injection across a split stream", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py")]);
    // step 1
    let step = stepToolLoopGuardRuntime(initRuntimeState(), events[0]!, ON_V0);
    const wire = serializeRuntimeState(step.state);
    // resume from serialized state for the rest
    let state = deserializeRuntimeState(wire);
    const injections: ToolLoopGuardFiring[] = [];
    for (const e of events.slice(1)) {
      step = stepToolLoopGuardRuntime(state, e, ON_V0);
      state = step.state;
      if (step.injection) injections.push(step.injection);
    }
    expect(injections.length).toBe(1);
    expect(injections[0]!.triggerType).toBe("repeated_read");
  });

  test("deserialize tolerates garbage and returns an empty state", () => {
    expect(deserializeRuntimeState("not json")).toEqual(initRuntimeState());
    expect(deserializeRuntimeState(null)).toEqual(initRuntimeState());
    expect(deserializeRuntimeState("123")).toEqual(initRuntimeState());
  });
});

// ---- PostToolUse normalization --------------------------------------------
describe("PostToolUse normalization", () => {
  test("tool name maps to the right category", () => {
    expect(toolNameToCategory("Read")).toBe("read");
    expect(toolNameToCategory("Grep")).toBe("search");
    expect(toolNameToCategory("Edit")).toBe("edit");
    expect(toolNameToCategory("Bash")).toBe("other");
  });

  test("Read event maps file_path -> path / read", () => {
    const e = postToolUseEventToGuardEvent({ tool_name: "Read", tool_input: { file_path: "/repo/x.py" }, tool_output: "contents" }, 4);
    expect(e).toMatchObject({ index: 4, category: "read", path: "/repo/x.py" });
  });

  test("Bash failure maps command + error output + success=false", () => {
    const e = postToolUseEventToGuardEvent(
      { tool_name: "Bash", tool_input: { command: "pytest" }, tool_output: { stdout: "1 failed AssertionError", is_error: true, exitCode: 1 } },
      0,
    );
    expect(e.category).toBe("other");
    expect(e.command).toBe("pytest");
    expect(e.success).toBe(false);
    expect(e.exitCode).toBe(1);
    expect(e.output).toContain("AssertionError");
  });

  test("Grep event maps pattern -> query / search; tolerates tool_response alias", () => {
    const e = postToolUseEventToGuardEvent({ tool_name: "Grep", tool_input: { pattern: "class Foo", path: "/p" }, tool_response: "hit" }, 1);
    expect(e.category).toBe("search");
    expect(e.query).toBe("class Foo");
    expect(e.output).toBe("hit");
  });
});

// ---- hook stdout rendering -------------------------------------------------
describe("hook stdout", () => {
  test("inject payload carries additionalContext with the marker", () => {
    const out = JSON.parse(renderHookStdout("MSG with " + TOOL_LOOP_GUARD_MARKER));
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain(TOOL_LOOP_GUARD_MARKER);
  });

  test("noop payload is well-formed and has NO additionalContext", () => {
    const out = JSON.parse(TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  test("settings builder registers a PostToolUse command hook for all tools", () => {
    const s = buildToolLoopGuardHookSettings("bun /x/toolLoopGuardHook.ts");
    expect(s.hooks.PostToolUse[0]!.matcher).toBe("*");
    expect(s.hooks.PostToolUse[0]!.hooks[0]!.command).toBe("bun /x/toolLoopGuardHook.ts");
    expect(s.hooks.PostToolUse[0]!.hooks[0]!.type).toBe("command");
  });

  test("parseHookConfig defaults to enabled+V4 and merges overrides", () => {
    expect(parseHookConfig(undefined).enabled).toBe(true);
    expect(parseHookConfig(undefined).calibration).toBe("v4"); // M79 default
    expect(parseHookConfig('{"enabled":false}').enabled).toBe(true); // forced on
    expect(parseHookConfig('{"repeatedReadThreshold":2}').repeatedReadThreshold).toBe(2);
    expect(parseHookConfig('{"calibration":"v0"}').calibration).toBe("v0"); // override honored
    expect(parseHookConfig("garbage").enabled).toBe(true);
  });
});

// ---- the fail-closed hook body --------------------------------------------
function memIo(): { io: ToolLoopGuardHookIo; store: Map<string, string>; logs: string[] } {
  const store = new Map<string, string>();
  const logs: string[] = [];
  return {
    store,
    logs,
    io: {
      readState: (f) => (store.has(f) ? store.get(f)! : null),
      writeState: (f, c) => void store.set(f, c),
      appendLog: (_f, l) => void logs.push(l),
    },
  };
}

const STATE = "/tmp/__test_state.json";

describe("runToolLoopGuardHook — fail-closed body", () => {
  test("two identical failed Bash commands -> second invocation injects exactly once", () => {
    const { io, logs } = memIo();
    const ev = JSON.stringify({ tool_name: "Bash", tool_input: { command: "python repro.py" }, tool_output: { stdout: "ValueError: boom", is_error: true } });
    const first = runToolLoopGuardHook(ev, { stateFile: STATE, logFile: "/tmp/__log.jsonl" }, io);
    expect(first.injected).toBe(false);
    const second = runToolLoopGuardHook(ev, { stateFile: STATE, logFile: "/tmp/__log.jsonl" }, io);
    expect(second.injected).toBe(true);
    const out = JSON.parse(second.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain(TOOL_LOOP_GUARD_MARKER);
    expect(logs.length).toBe(1);
    expect(logs[0]!).toContain(TOOL_LOOP_GUARD_MARKER);
  });

  test("repeated read loop injects once on the threshold-th invocation (V0 mechanics)", () => {
    const { io } = memIo();
    const ev = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/a.py" }, tool_output: "x" });
    const cfg = { stateFile: STATE, configJson: '{"calibration":"v0"}' };
    const r1 = runToolLoopGuardHook(ev, cfg, io);
    const r2 = runToolLoopGuardHook(ev, cfg, io);
    const r3 = runToolLoopGuardHook(ev, cfg, io);
    expect([r1.injected, r2.injected, r3.injected]).toEqual([false, false, true]);
  });

  test("V4 (hook default): a pure opening read loop never injects", () => {
    const { io } = memIo();
    const ev = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/a.py" }, tool_output: "x" });
    // No configJson => parseHookConfig defaults to V4. Three pure reads => no injection.
    const r1 = runToolLoopGuardHook(ev, { stateFile: STATE }, io);
    const r2 = runToolLoopGuardHook(ev, { stateFile: STATE }, io);
    const r3 = runToolLoopGuardHook(ev, { stateFile: STATE }, io);
    expect([r1.injected, r2.injected, r3.injected]).toEqual([false, false, false]);
  });

  test("malformed stdin fails closed: no inject, well-formed noop payload, no throw", () => {
    const { io } = memIo();
    const res = runToolLoopGuardHook("}{ not json", { stateFile: STATE }, io);
    expect(res.injected).toBe(false);
    expect(res.stdout).toBe(TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT);
  });

  test("session-keyed state files isolate distinct sessions (no cross-session injection)", () => {
    const { io } = memIo();
    const evA = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/a.py" }, tool_output: "x", session_id: "S1" });
    const evB = JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/a.py" }, tool_output: "x", session_id: "S2" });
    // interleave two sessions; neither reaches the threshold on its own
    expect(runToolLoopGuardHook(evA, { stateDir: "/tmp/st" }, io).injected).toBe(false);
    expect(runToolLoopGuardHook(evB, { stateDir: "/tmp/st" }, io).injected).toBe(false);
    expect(runToolLoopGuardHook(evA, { stateDir: "/tmp/st" }, io).injected).toBe(false); // S1 has 2 reads
    expect(runToolLoopGuardHook(evB, { stateDir: "/tmp/st" }, io).injected).toBe(false); // S2 has 2 reads
  });
});

// ---- executable hook wrapper (end-to-end, no agents) ----------------------
describe("toolLoopGuardHook.ts executable", () => {
  test("piping two identical failed-command events makes the 2nd emit additionalContext", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const pathMod = await import("node:path");
    const dir = await mkdtemp(pathMod.join(os.tmpdir(), "tlg-hook-"));
    const stateFile = pathMod.join(dir, "state.json");
    const script = pathMod.join(import.meta.dir, "toolLoopGuardHook.ts");
    const ev = JSON.stringify({ tool_name: "Bash", tool_input: { command: "python repro.py" }, tool_output: { stdout: "ValueError: boom", is_error: true } });
    const runOnce = async (): Promise<string> => {
      const proc = Bun.spawn(["bun", script], {
        stdin: new TextEncoder().encode(ev),
        env: { ...process.env, VTRACE_TOOL_LOOP_GUARD_STATE_FILE: stateFile },
        stdout: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    };
    try {
      const first = JSON.parse(await runOnce());
      expect(first.hookSpecificOutput.additionalContext).toBeUndefined();
      const second = JSON.parse(await runOnce());
      expect(second.hookSpecificOutput.hookEventName).toBe("PostToolUse");
      expect(second.hookSpecificOutput.additionalContext).toContain(TOOL_LOOP_GUARD_MARKER);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- runtime metadata ------------------------------------------------------
describe("toolLoopGuardRuntimeMeta", () => {
  test("records mode, injected messages, and hook availability", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py")]);
    const result = runToolLoopGuard(events, ON_V0);
    const meta = toolLoopGuardRuntimeMeta(result, TOOL_LOOP_GUARD_RUNTIME_MODE, true);
    expect(meta.tool_loop_guard_mode).toBe(TOOL_LOOP_GUARD_RUNTIME_MODE);
    expect(meta.tool_loop_guard_injected_messages.length).toBe(1);
    expect(meta.tool_loop_guard_injected_messages[0]!).toContain(TOOL_LOOP_GUARD_MARKER);
    expect(meta.tool_loop_guard_runtime_hook_available).toBe(true);
    expect(meta.tool_loop_guard_runtime_hook_unavailable_reason).toBeNull();
  });

  test("records a fail-closed unavailable reason when the hook is not wired", () => {
    const result = runToolLoopGuard([], ON);
    const meta = toolLoopGuardRuntimeMeta(result, TOOL_LOOP_GUARD_RUNTIME_MODE, false, "adapter not patched");
    expect(meta.tool_loop_guard_runtime_hook_available).toBe(false);
    expect(meta.tool_loop_guard_runtime_hook_unavailable_reason).toBe("adapter not patched");
  });

  test("observe mode is still a valid mode token", () => {
    const result = runToolLoopGuard([], ON);
    const meta = toolLoopGuardRuntimeMeta(result, TOOL_LOOP_GUARD_OBSERVE_MODE, false);
    expect(meta.tool_loop_guard_mode).toBe(TOOL_LOOP_GUARD_OBSERVE_MODE);
  });
});
