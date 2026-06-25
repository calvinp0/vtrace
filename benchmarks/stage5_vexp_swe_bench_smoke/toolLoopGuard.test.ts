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

// ON = the enabled guard at its DEFAULT calibration (V4, M79). ON_V0 restores the
// pre-M79 behavior for the mechanics tests that exercise pure opening-orientation
// read/search loops (which V4 deliberately suppresses); the detection machinery they
// cover — thresholds, caps, cooldown, once-per-signature, metadata — is
// calibration-independent, so pinning them to V0 keeps their intent.
const ON: ToolLoopGuardConfig = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true };
const ON_V0: ToolLoopGuardConfig = { ...ON, calibration: "v0" };

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
    const two = runToolLoopGuard(reindex([read("/a.py"), read("/a.py")]), ON_V0);
    expect(two.wouldFire).toBe(false); // 2 reads < threshold 3
    auto = 0;
    const three = runToolLoopGuard(reindex([read("/a.py"), read("/a.py"), read("/a.py")]), ON_V0);
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
    const res = runToolLoopGuard(events, ON_V0);
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
    const res = runToolLoopGuard(reindex(events), { ...ON_V0, cooldownToolCalls: 0, maxInjections: 3 });
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
    const res = runToolLoopGuard(events, { ...ON_V0, cooldownToolCalls: 0, maxInjections: 3 });
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
    const res = runToolLoopGuard(events, ON_V0);
    const meta = toolLoopGuardMeta(res);
    expect(meta.tool_loop_guard_enabled).toBe(true);
    expect(meta.tool_loop_guard_calibration).toBe("v0");
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

describe("toolLoopGuard — V4 calibration (M79)", () => {
  // (16) default-off behavior is unchanged: the default config carries calibration v4
  // but stays disabled, so nothing fires.
  test("default config is v4 and still default-off", () => {
    expect(DEFAULT_TOOL_LOOP_GUARD_CONFIG.calibration).toBe("v4");
    expect(DEFAULT_TOOL_LOOP_GUARD_CONFIG.enabled).toBe(false);
    auto = 0;
    const res = runToolLoopGuard(reindex([read("/a.py"), read("/a.py"), read("/a.py")]));
    expect(res.wouldFire).toBe(false);
    expect(res.suppressedEvents).toEqual([]);
  });

  // (1) repeated_read with no prior search/edit is suppressed under V4 (it fired under V0).
  test("repeated_read before any prior progress is suppressed", () => {
    auto = 0;
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py")]);
    const v4 = runToolLoopGuard(events, ON);
    const v0 = runToolLoopGuard(events, ON_V0);
    expect(v0.wouldFire).toBe(true); // V0 fires on pure orientation
    expect(v4.wouldFire).toBe(false); // V4 withholds it
    expect(v4.suppressedEvents.length).toBe(1);
    expect(v4.suppressedEvents[0]!.triggerType).toBe("repeated_read");
  });

  // (2) repeated_search with no prior progress (only the repeating query itself) is suppressed.
  test("repeated_search before any prior progress is suppressed", () => {
    auto = 0;
    const events = reindex([search("class Foo", "/p", "hit"), search("class Foo", "/p", "hit")]);
    const v4 = runToolLoopGuard(events, ON);
    expect(v4.wouldFire).toBe(false);
    expect(v4.suppressedEvents.some((s) => s.triggerType === "repeated_search")).toBe(true);
    // V0 still fires on the same stream.
    expect(runToolLoopGuard(events, ON_V0).wouldFire).toBe(true);
  });

  // (3) repeated_read_window with no prior progress is suppressed.
  test("repeated_read_window before any prior progress is suppressed", () => {
    auto = 0;
    // Six reads of one file: V0 trips both repeated_read and the read-window; V4 withholds both.
    const events = reindex([read("/a.py"), read("/a.py"), read("/a.py"), read("/a.py"), read("/a.py"), read("/a.py")]);
    const v4 = runToolLoopGuard(events, ON);
    const v0 = runToolLoopGuard(events, ON_V0);
    expect(v0.events.some((e) => e.triggerType === "repeated_read_window")).toBe(true);
    expect(v4.wouldFire).toBe(false);
    expect(v4.suppressedEvents.some((s) => s.triggerType === "repeated_read_window")).toBe(true);
  });

  // (4) repeated_read AFTER a prior search may fire.
  test("repeated_read after a prior search may fire", () => {
    auto = 0;
    const events = reindex([search("anything", "/p", "hit"), read("/a.py"), read("/a.py"), read("/a.py")]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events[0]!.triggerType).toBe("repeated_read");
  });

  // (5) repeated_read AFTER a prior edit may fire (edit clears the streak, so re-read 3x after it).
  test("repeated_read after a prior edit may fire", () => {
    auto = 0;
    const events = reindex([edit("/b.py"), read("/a.py"), read("/a.py"), read("/a.py")]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events[0]!.triggerType).toBe("repeated_read");
  });

  // (6) repeated_search after a prior DIFFERENT search (or edit) may fire.
  test("repeated_search after a prior different search may fire", () => {
    auto = 0;
    const events = reindex([
      search("other query", "/p", "hit"),
      search("class Foo", "/p", "hit"),
      search("class Foo", "/p", "hit"),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.events.some((e) => e.triggerType === "repeated_search")).toBe(true);
  });

  test("repeated_search after a prior edit may fire", () => {
    auto = 0;
    const events = reindex([edit("/b.py"), search("class Foo", "/p", "hit"), search("class Foo", "/p", "hit")]);
    const res = runToolLoopGuard(events, ON);
    expect(res.events.some((e) => e.triggerType === "repeated_search")).toBe(true);
  });

  // (7) repeated_failed_command stays eligible with NO prior search/edit (sympy-12419 case).
  test("repeated_failed_command remains eligible without prior search/edit", () => {
    auto = 0;
    const events = reindex([
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
      bash("python repro.py", { success: false, output: "ValueError: boom" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    expect(res.events[0]!.triggerType).toBe("repeated_failed_command");
    expect(res.suppressedEvents).toEqual([]);
  });

  // (8) repeated_command_family_error stays eligible with no prior search/edit.
  test("repeated_command_family_error remains eligible without prior search/edit", () => {
    auto = 0;
    const events = reindex([
      bash("python a.py", { success: false, output: "ModuleNotFoundError: No module named 'foo'" }),
      bash("python b.py", { success: false, output: "ModuleNotFoundError: No module named 'foo'" }),
      bash("python c.py", { success: false, output: "ModuleNotFoundError: No module named 'foo'" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.events.some((e) => e.triggerType === "repeated_command_family_error")).toBe(true);
  });

  // (9) repeated_edit_failure stays eligible with no prior search/edit.
  test("repeated_edit_failure remains eligible without prior search/edit", () => {
    auto = 0;
    const events = reindex([
      edit("/a.py", { success: false, output: "SyntaxError: invalid syntax" }),
      edit("/a.py", { success: false, output: "SyntaxError: invalid syntax" }),
    ]);
    const res = runToolLoopGuard(events, ON);
    expect(res.events.some((e) => e.triggerType === "repeated_edit_failure")).toBe(true);
  });

  // (10) suppression metadata records the reason.
  test("suppression metadata records the no-prior-progress reason", () => {
    auto = 0;
    const res = runToolLoopGuard(reindex([read("/a.py"), read("/a.py"), read("/a.py")]), ON);
    const meta = toolLoopGuardMeta(res);
    expect(meta.tool_loop_guard_calibration).toBe("v4");
    expect(meta.tool_loop_guard_suppressed_count).toBe(1);
    expect(meta.tool_loop_guard_suppressed_events[0]!.reason).toBe("no_prior_progress_for_read_search_window_trigger");
    expect(meta.tool_loop_guard_suppression_reasons).toEqual(["no_prior_progress_for_read_search_window_trigger"]);
  });

  // (11) a suppressed read does NOT consume the injection cap — a later genuine command
  // loop still injects (the cap was untouched by the suppressed read).
  test("a suppressed read does not consume the injection cap", () => {
    auto = 0;
    const events = reindex([
      read("/a.py"), read("/a.py"), read("/a.py"), // suppressed (no prior progress)
      bash("pytest", { success: false, output: "1 failed" }),
      bash("pytest", { success: false, output: "1 failed" }), // command loop still fires
    ]);
    const res = runToolLoopGuard(events, { ...ON, maxInjections: 1 });
    expect(res.injectionCount).toBe(1);
    expect(res.events[0]!.triggerType).toBe("repeated_failed_command");
    expect(res.suppressedEvents.length).toBe(1);
  });

  // (12) a suppressed read does NOT start a cooldown — a command loop one step later
  // (within the cooldown window) still injects because the suppressed read never did.
  test("a suppressed read does not start a cooldown", () => {
    auto = 0;
    const events = reindex([
      read("/a.py"), read("/a.py"), read("/a.py"), // would-be fire at idx2, but suppressed
      bash("pytest", { success: false, output: "1 failed" }), // idx3
      bash("pytest", { success: false, output: "1 failed" }), // idx4 fires; cooldown 5 from a real idx2 fire would have blocked it
    ]);
    const res = runToolLoopGuard(events, { ...ON, cooldownToolCalls: 5 });
    expect(res.events.some((e) => e.triggerType === "repeated_failed_command")).toBe(true);
  });
});

describe("toolLoopGuard — named M77/M78 case shapes (V4)", () => {
  // Compact synthetic streams derived from the captured M77 guarded tool-call shapes
  // (the raw streams are untracked benchmark artifacts and are NOT committed). Each
  // reproduces the relevant prefix that drives the documented V4 outcome.

  // pytest-6197: three opening reads of python.py, no prior search/edit -> V0 fired the
  // repeated_read at idx 2; V4 suppresses it (the M78 "risky early fire" we calibrated out).
  test("pytest-6197 shape: early repeated_read with no prior progress is suppressed under V4", () => {
    auto = 0;
    const stream = reindex([
      read("/repo/src/_pytest/python.py"),
      read("/repo/src/_pytest/python.py"),
      read("/repo/src/_pytest/python.py"),
    ]);
    expect(runToolLoopGuard(stream, ON_V0).wouldFire).toBe(true); // V0 fired @2
    const v4 = runToolLoopGuard(stream, ON);
    expect(v4.wouldFire).toBe(false); // V4 suppressed
    expect(v4.suppressedEvents[0]!.triggerType).toBe("repeated_read");
  });

  // astropy-14598: searches precede the heavy card.py re-reads, so the repeated_read has
  // prior progress -> the helpful fire is PRESERVED under V4.
  test("astropy-14598 shape: repeated_read after prior search is preserved under V4", () => {
    auto = 0;
    const stream = reindex([
      search("class Card", "/repo/astropy/io/fits/card.py", "hit"),
      read("/repo/astropy/io/fits/card.py"),
      read("/repo/astropy/io/fits/card.py"),
      read("/repo/astropy/io/fits/card.py"),
    ]);
    const v4 = runToolLoopGuard(stream, ON);
    expect(v4.wouldFire).toBe(true);
    expect(v4.events[0]!.triggerType).toBe("repeated_read");
  });

  // sympy-12419: the helpful fire was a repeated FAILED command (not a read) -> it is NOT
  // gated by V4 and stays eligible from the opening turns.
  test("sympy-12419 shape: repeated failed command fires under V4 with no prior search/edit", () => {
    auto = 0;
    const stream = reindex([
      read("/repo/sympy/core/expr.py"),
      bash("python -c 'import sympy; sympy.S(...)'", { success: false, output: "RecursionError: maximum recursion depth" }),
      bash("python -c 'import sympy; sympy.S(...)'", { success: false, output: "RecursionError: maximum recursion depth" }),
    ]);
    const v4 = runToolLoopGuard(stream, ON);
    expect(v4.wouldFire).toBe(true);
    expect(v4.events.some((e) => e.triggerType === "repeated_failed_command")).toBe(true);
    expect(v4.suppressedEvents).toEqual([]);
  });

  // django-16263: mixed read/search/edit churn, never a same-file repeated-read streak ->
  // no fire under either calibration (the cost/no-convergence case belongs to a future
  // C7 cost guard, not the read-loop detector).
  test("django-16263 shape: interleaved read/search/edit churn does not fire (V0 or V4)", () => {
    auto = 0;
    const stream = reindex([
      read("/repo/django/db/models/sql/query.py"),
      search("def add_q", "/repo/django/db/models/sql/query.py", "hit"),
      read("/repo/django/db/models/sql/query.py"),
      search("def build_filter", "/repo/django/db/models/sql/query.py", "hit2"),
      edit("/repo/django/db/models/sql/query.py"),
      read("/repo/django/db/models/sql/query.py"),
      edit("/repo/django/db/models/sql/query.py"),
    ]);
    expect(runToolLoopGuard(stream, ON).wouldFire).toBe(false);
    expect(runToolLoopGuard(stream, ON_V0).wouldFire).toBe(false);
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
