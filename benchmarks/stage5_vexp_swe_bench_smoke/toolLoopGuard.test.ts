import { describe, expect, test } from "bun:test";
import {
  runToolLoopGuard,
  normalizeCommand,
  normalizeErrorSignature,
  commandFamily,
  renderToolLoopGuardMessage,
  toolLoopGuardMeta,
  toGuardEvent,
  DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  TOOL_LOOP_GUARD_MARKER,
  type ToolLoopGuardEvent,
  type ToolLoopGuardConfig,
} from "./toolLoopGuard";

const ON: ToolLoopGuardConfig = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true };

let auto = 0;
function bash(command: string, opts: { success?: boolean; exitCode?: number; output?: string } = {}): ToolLoopGuardEvent {
  return {
    index: auto++,
    tool: "Bash",
    category: "other",
    command,
    success: opts.success ?? null,
    exitCode: opts.exitCode ?? null,
    output: opts.output ?? null,
  };
}
function read(path: string, output?: string): ToolLoopGuardEvent {
  return { index: auto++, tool: "Read", category: "read", path, output: output ?? null };
}
function search(query: string, path = "/x", output?: string): ToolLoopGuardEvent {
  return { index: auto++, tool: "Grep", category: "search", query, path, output: output ?? null };
}
function edit(path: string, opts: { success?: boolean; output?: string } = {}): ToolLoopGuardEvent {
  return { index: auto++, tool: "Edit", category: "edit", path, success: opts.success ?? null, output: opts.output ?? null };
}
function reindex(events: ToolLoopGuardEvent[]): ToolLoopGuardEvent[] {
  return events.map((e, i) => ({ ...e, index: i }));
}

describe("toolLoopGuard — default-off", () => {
  // (11) default-off byte-identical: disabled config never fires
  test("default config is disabled and never fires", () => {
    auto = 0;
    const events = reindex([bash("pytest", { success: false }), bash("pytest", { success: false })]);
    const res = runToolLoopGuard(events); // DEFAULT (disabled)
    expect(DEFAULT_TOOL_LOOP_GUARD_CONFIG.enabled).toBe(false);
    expect(res.enabled).toBe(false);
    expect(res.wouldFire).toBe(false);
    expect(res.injectionCount).toBe(0);
    expect(res.events).toEqual([]);
  });

  // (12) flag wiring: enabling the config makes the SAME stream fire
  test("enabling the guard turns the same stream into a firing", () => {
    auto = 0;
    const events = reindex([bash("pytest", { success: false }), bash("pytest", { success: false })]);
    const off = runToolLoopGuard(events, { ...ON, enabled: false });
    const on = runToolLoopGuard(events, ON);
    expect(off.wouldFire).toBe(false);
    expect(on.wouldFire).toBe(true);
  });
});

describe("toolLoopGuard — command detection", () => {
  // (1) identical failed command repeated twice triggers
  test("identical failed command repeated twice triggers", () => {
    auto = 0;
    const events = reindex([
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events[0]!.triggerType).toBe("repeated_failed_command");
    expect(res.repeatedCommandFailureCount).toBeGreaterThanOrEqual(1);
  });

  // (2) same family + normalized same error triggers (after enough repeats)
  test("same command family + same error signature triggers at family threshold", () => {
    auto = 0;
    const events = reindex([
      bash("python a.py", { success: false, output: "ModuleNotFoundError: No module named 'foo'" }),
      bash("python b.py", { success: false, output: "ModuleNotFoundError: No module named 'foo'" }),
      bash("python c.py", { success: false, output: "ModuleNotFoundError: No module named 'foo'" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events.some((e) => e.triggerType === "repeated_command_family_error")).toBe(true);
  });

  // (4) distinct errors do not collapse incorrectly
  test("distinct errors / commands do not trigger", () => {
    auto = 0;
    const events = reindex([
      bash("python a.py", { success: false, output: "ValueError: x" }),
      bash("python b.py", { success: false, output: "KeyError: y" }),
      bash("ls /tmp", { success: true, output: "files" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(false);
  });

  // a failed command repeated only AFTER an intervening edit is progress, not a loop
  test("intervening edit resets a failed-command repeat (red->edit->red)", () => {
    auto = 0;
    const events = reindex([
      bash("pytest test_x.py", { success: false, output: "1 failed AssertionError" }),
      edit("/repo/x.py"),
      bash("pytest test_x.py", { success: false, output: "1 failed AssertionError" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(false);
  });
});

describe("toolLoopGuard — read/search detection", () => {
  // (5) repeated file read triggers only after threshold
  test("repeated read triggers only at the threshold", () => {
    auto = 0;
    const two = runToolLoopGuard(reindex([read("/a.py"), read("/a.py")]), ON);
    expect(two.wouldFire).toBe(false); // 2 reads < threshold 3
    auto = 0;
    const three = runToolLoopGuard(reindex([read("/a.py"), read("/a.py"), read("/a.py")]), ON);
    expect(three.wouldFire).toBe(true);
    expect(three.events[0]!.triggerType).toBe("repeated_read");
  });

  // (6) repeated read does NOT trigger if an edit or new search intervenes
  test("intervening edit resets the read streak", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), edit("/a.py"), read("/a.py")]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(false);
  });

  test("intervening new search resets the read streak", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), search("new query"), read("/a.py")]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(false);
  });

  // (7) repeated search query with no new result triggers
  test("repeated identical search with no new result triggers", () => {
    auto = 0;
    const events = reindex([search("class Foo", "/p", "hit"), search("class Foo", "/p", "hit")]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events[0]!.triggerType).toBe("repeated_search");
  });

  test("repeated search that returns a NEW result does not trigger", () => {
    auto = 0;
    const events = reindex([search("class Foo", "/p", "old"), search("class Foo", "/p", "DIFFERENT")]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(false);
  });

  // repeated edit/write failure with same target + same error triggers
  test("repeated edit failure on same target triggers", () => {
    auto = 0;
    const events = reindex([
      edit("/a.py", { success: false, output: "SyntaxError: invalid syntax" }),
      edit("/a.py", { success: false, output: "SyntaxError: invalid syntax" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events.some((e) => e.triggerType === "repeated_edit_failure")).toBe(true);
  });
});

describe("toolLoopGuard — caps and cooldown", () => {
  // (8) max injections per run
  test("respects maxInjections per run", () => {
    auto = 0;
    const events: ToolLoopGuardEvent[] = [];
    // 5 distinct loop signatures, each a triple read of a distinct path
    for (let i = 0; i < 5; i++) {
      events.push(read(`/f${i}.py`), read(`/f${i}.py`), read(`/f${i}.py`));
    }
    const res = runToolLoopGuard(reindex(events), { ...ON, cooldownToolCalls: 0, maxInjections: 3 });
    expect(res.injectionCount).toBe(3);
  });

  // (9) cooldown window after an injection
  test("respects cooldown between injections", () => {
    auto = 0;
    // two distinct failed-command pairs (commands don't feed the read-window),
    // so the only firings are the two repeated_failed_command signatures.
    const events = reindex([
      bash("cmdA", { success: false, output: "ValueError" }),
      bash("cmdA", { success: false, output: "ValueError" }),
      bash("cmdB", { success: false, output: "KeyError" }),
      bash("cmdB", { success: false, output: "KeyError" }),
    ]);
    const tight = runToolLoopGuard(events, { ...ON, cooldownToolCalls: 5, maxInjections: 3 });
    expect(tight.injectionCount).toBe(1); // 2nd firing (idx3) is within cooldown of the 1st (idx1)
    const loose = runToolLoopGuard(events, { ...ON, cooldownToolCalls: 0, maxInjections: 3 });
    expect(loose.injectionCount).toBe(2);
  });

  // (10) same signature warned once
  test("same signature fires at most once", () => {
    auto = 0;
    // read /a.py many times -> repeated_read signature is read:a.py once only
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py"), read("/a.py"), read("/a.py")]);
    const res = runToolLoopGuard(events, { ...ON, cooldownToolCalls: 0, maxInjections: 3 });
    const sigs = res.events.map((e) => e.signature);
    expect(new Set(sigs).size).toBe(sigs.length);
    expect(sigs.filter((s) => s === "read:a.py").length).toBe(1);
  });
});

describe("toolLoopGuard — signature normalization", () => {
  // (3) volatile paths/timestamps/addresses normalized
  test("normalizeCommand strips volatile temp paths and run labels", () => {
    const a = normalizeCommand("python /tmp/abc123/repro.py");
    const b = normalizeCommand("python /tmp/xyz999/repro.py");
    expect(a).toBe(b);
  });

  test("normalizeErrorSignature strips timestamps/addresses/line numbers but keeps the exception type", () => {
    const a = normalizeErrorSignature("2026-01-02 03:04:05 ValueError at 0x7ffaa line 42: bad");
    const b = normalizeErrorSignature("2025-12-31 23:59:59 ValueError at 0x123bb line 7: bad");
    expect(a).toBe(b);
    expect(a).toContain("ValueError");
  });

  test("normalizeErrorSignature preserves meaningful differences", () => {
    expect(normalizeErrorSignature("No module named 'foo'")).not.toBe(normalizeErrorSignature("No module named 'bar'"));
    expect(normalizeErrorSignature("ImportError: x")).not.toBe(normalizeErrorSignature("ValueError: x"));
    expect(normalizeErrorSignature("Permission denied")).toContain("permission_denied");
    expect(normalizeErrorSignature("SyntaxError: invalid syntax")).toContain("syntax_error");
  });

  test("commandFamily extracts the program family", () => {
    expect(commandFamily("cd /repo && python -m pytest tests/")).toBe("pytest");
    expect(commandFamily("FOO=1 python repro.py")).toBe("python");
    expect(commandFamily("/usr/bin/grep -rn x .")).toBe("grep");
  });

  test("two failed commands differing only by volatile path collapse to one signature", () => {
    auto = 0;
    const events = reindex([
      bash("python /tmp/aaa/repro.py", { success: false, output: "ValueError" }),
      bash("python /tmp/bbb/repro.py", { success: false, output: "ValueError" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events[0]!.triggerType).toBe("repeated_failed_command");
  });
});

describe("toolLoopGuard — rendering and metadata", () => {
  test("rendered message carries the stable marker and trigger", () => {
    const msg = renderToolLoopGuardMessage("repeated_read", "read:a.py", 3);
    expect(msg).toContain(TOOL_LOOP_GUARD_MARKER);
    expect(msg).toContain("repeated_read");
    expect(msg.length).toBeLessThan(400); // compact
  });

  // (13) metadata records guard events
  test("toolLoopGuardMeta records events, count, signatures, turns", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py")]);
    const res = runToolLoopGuard(events, ON);
    const meta = toolLoopGuardMeta(res);
    expect(meta.tool_loop_guard_enabled).toBe(true);
    expect(meta.tool_loop_guard_injection_count).toBe(1);
    expect(meta.tool_loop_guard_events.length).toBe(1);
    expect(meta.tool_loop_guard_events[0]!.trigger_type).toBe("repeated_read");
    expect(meta.tool_loop_guard_signatures).toContain("read:a.py");
    expect(meta.tool_loop_guard_first_event_turn).toBe(2);
    expect(meta.tool_loop_guard_last_event_turn).toBe(2);
  });

  test("disabled guard emits inert metadata", () => {
    auto = 0;
    const res = runToolLoopGuard(reindex([read("/a.py"), read("/a.py"), read("/a.py")]));
    const meta = toolLoopGuardMeta(res);
    expect(meta.tool_loop_guard_enabled).toBe(false);
    expect(meta.tool_loop_guard_injection_count).toBe(0);
    expect(meta.tool_loop_guard_first_event_turn).toBeNull();
  });

  test("toGuardEvent tolerates both lean and rich stream shapes", () => {
    const lean = toGuardEvent({ index: 4, tool: "Read", category: "read", path: "/a", query: null }, 0);
    expect(lean.index).toBe(4);
    expect(lean.command).toBeNull();
    const rich = toGuardEvent(
      { tool: "Bash", category: "other", command: "pytest", exitCode: 1, success: false, output_summary: "fail" },
      9,
    );
    expect(rich.index).toBe(9); // fallback index
    expect(rich.success).toBe(false);
    expect(rich.output).toBe("fail");
  });
});

describe("toolLoopGuard — determinism", () => {
  // (14) offline detector produces deterministic output
  test("identical input yields identical output across runs", () => {
    auto = 0;
    const events = reindex([
      read("/a.py"), read("/a.py"), read("/a.py"),
      bash("pytest", { success: false, output: "1 failed" }),
      bash("pytest", { success: false, output: "1 failed" }),
    ]);
    const a = runToolLoopGuard(events, { ...ON, cooldownToolCalls: 0 });
    const b = runToolLoopGuard(events, { ...ON, cooldownToolCalls: 0 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
