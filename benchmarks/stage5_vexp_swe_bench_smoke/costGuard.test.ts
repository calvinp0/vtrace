import { describe, expect, test } from "bun:test";
import {
  runCostGuard,
  renderCostGuardMessage,
  costGuardMeta,
  toCostGuardEvent,
  isVerifyCommand,
  DEFAULT_COST_GUARD_CONFIG,
  COST_GUARD_MARKER,
  type CostGuardConfig,
  type CostGuardEvent,
} from "./costGuard";

// ON = the enabled guard at its DEFAULT thresholds (the production config minus default-off).
const ON: CostGuardConfig = { ...DEFAULT_COST_GUARD_CONFIG, enabled: true };

let auto = 0;
function read(path = "/repo/a.py"): CostGuardEvent {
  return { index: auto++, tool: "Read", category: "read", path };
}
function search(query = "thing"): CostGuardEvent {
  return { index: auto++, tool: "Grep", category: "search", query, path: "/repo" };
}
function edit(path = "/repo/a.py"): CostGuardEvent {
  return { index: auto++, tool: "Edit", category: "edit", path };
}
function bash(command: string, opts: { success?: boolean; exitCode?: number; output?: string } = {}): CostGuardEvent {
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
function times<T>(n: number, fn: () => T): T[] {
  return Array.from({ length: n }, fn);
}
function reindex(events: CostGuardEvent[]): CostGuardEvent[] {
  return events.map((e, i) => ({ ...e, index: i }));
}

describe("costGuard — default-off", () => {
  // (1) default-off byte-identical: disabled config never fires.
  test("default config is disabled and never fires", () => {
    auto = 0;
    const events = reindex(times(40, () => read()));
    const res = runCostGuard(events); // DEFAULT (disabled)
    expect(DEFAULT_COST_GUARD_CONFIG.enabled).toBe(false);
    expect(res.enabled).toBe(false);
    expect(res.wouldFire).toBe(false);
    expect(res.injectionCount).toBe(0);
    expect(res.events).toEqual([]);
    expect(res.suppressedEvents).toEqual([]); // disabled guard is fully inert
  });
});

describe("costGuard — threshold gating", () => {
  // (8) early orientation does not fire: churn within the first few tool calls is held.
  test("early edit-churn before the min-tool gate is suppressed, not fired", () => {
    auto = 0;
    const events = reindex([edit("/repo/x.py"), edit("/repo/x.py"), edit("/repo/x.py"), read(), read()]);
    const res = runCostGuard(events, ON);
    expect(res.wouldFire).toBe(false);
    expect(res.suppressedEvents.some((s) => s.reason === "gates_not_open")).toBe(true);
  });

  // (4) high tool-count fires only AFTER the threshold, not before.
  test("high_tool_count fires at the threshold and not before", () => {
    auto = 0;
    // one early edit so no_patch_drift cannot fire; then reads up to the high threshold.
    const events = reindex([edit(), ...times(DEFAULT_COST_GUARD_CONFIG.highToolCountThreshold - 1, () => read())]);
    const res = runCostGuard(events, ON);
    expect(res.wouldFire).toBe(true);
    const ht = res.events.find((e) => e.triggerType === "high_tool_count");
    expect(ht).toBeTruthy();
    // fired exactly when toolCount reached the threshold
    expect(ht!.snapshot.toolCount).toBe(DEFAULT_COST_GUARD_CONFIG.highToolCountThreshold);
  });

  test("a run that stays below every threshold does not fire (normal control)", () => {
    auto = 0;
    // 9 tool calls, 2 edits to different files — like django-11815 (low cost win).
    const events = reindex([read(), search(), edit("/repo/a.py"), read(), edit("/repo/b.py"), search(), read(), bash("python -m pytest", { success: true }), read()]);
    const res = runCostGuard(events, ON, { estimatedCostUsd: 0.41, turnCount: 24 });
    expect(res.wouldFire).toBe(false);
  });
});

describe("costGuard — trigger families", () => {
  // (5) edit-verify churn fires after repeated cycles on the SAME file.
  test("edit_verify_churn fires on the Nth edit to the same file (after the gate)", () => {
    auto = 0;
    const events = reindex([
      ...times(25, () => read()), // open the gate
      edit("/repo/same.py"),
      bash("pytest", { success: false }),
      edit("/repo/same.py"),
      bash("pytest", { success: false }),
      edit("/repo/same.py"), // 3rd edit to same.py -> churn
    ]);
    const res = runCostGuard(events, ON);
    const churn = res.events.find((e) => e.triggerType === "edit_verify_churn");
    expect(churn).toBeTruthy();
    expect(churn!.signature).toBe("churn:same.py");
  });

  // (6) no-patch drift fires after many tool calls with zero edits.
  test("no_patch_drift fires after the threshold with no edit produced", () => {
    auto = 0;
    const events = reindex(times(DEFAULT_COST_GUARD_CONFIG.noPatchToolThreshold, () => read()));
    const res = runCostGuard(events, ON);
    const drift = res.events.find((e) => e.triggerType === "no_patch_drift");
    expect(drift).toBeTruthy();
    expect(drift!.snapshot.patchSeen).toBe(false);
    expect(drift!.snapshot.editCount).toBe(0);
  });

  test("repeated_verification_no_progress fires when the same failure persists across edits", () => {
    auto = 0;
    const fail = { success: false as const, output: "E   AssertionError: values differ\nFAILED test_x" };
    // edits to DIFFERENT files so same-file churn does not fire first and consume the
    // injection budget — this isolates the persistent-failure trigger.
    const events = reindex([
      ...times(25, () => read()),
      edit("/repo/a.py"),
      bash("python -m pytest test_x.py", fail),
      edit("/repo/b.py"),
      bash("python -m pytest test_x.py", fail),
      edit("/repo/c.py"),
      bash("python -m pytest test_x.py", fail), // 3rd persistent same-signature failure post-edit
    ]);
    const res = runCostGuard(events, ON);
    const rv = res.events.find((e) => e.triggerType === "repeated_verification_no_progress");
    expect(rv).toBeTruthy();
    expect(res.repeatedVerifyFailureCount).toBeGreaterThanOrEqual(3);
  });

  test("high_turn_count / cost_cap_approaching fire only with run-context, attributed to the last event", () => {
    auto = 0;
    const events = reindex([edit(), ...times(30, () => read())]);
    const withCtx = runCostGuard(events, ON, { estimatedCostUsd: 2.9, turnCount: 95 });
    const lastIdx = events[events.length - 1]!.index;
    const turn = withCtx.events.find((e) => e.triggerType === "high_turn_count");
    const cost = withCtx.events.find((e) => e.triggerType === "cost_cap_approaching");
    // at least one context trigger lands (cap of 2 may absorb the other); whichever lands
    // is attributed to the final event index.
    expect(turn || cost).toBeTruthy();
    for (const e of [turn, cost].filter(Boolean)) expect(e!.turnIndex).toBe(lastIdx);
    // without context the two aggregate triggers are inert
    const noCtx = runCostGuard(events, ON);
    expect(noCtx.events.some((e) => e.triggerType === "high_turn_count" || e.triggerType === "cost_cap_approaching")).toBe(false);
  });
});

describe("costGuard — anti-spam", () => {
  // (9) max injection cap respected.
  test("never exceeds maxInjections", () => {
    auto = 0;
    // a long churning run that crosses many thresholds.
    const events = reindex([
      ...times(25, () => read()),
      ...times(20, () => edit("/repo/same.py")),
      bash("pytest", { success: false }),
    ]);
    const res = runCostGuard(events, ON);
    expect(res.injectionCount).toBeLessThanOrEqual(ON.maxInjections);
    expect(res.events.length).toBeLessThanOrEqual(ON.maxInjections);
  });

  // (10) cooldown respected: two fires are >= cooldown apart.
  test("consecutive injections respect the cooldown", () => {
    auto = 0;
    const events = reindex([
      ...times(25, () => read()),
      edit("/repo/same.py"),
      edit("/repo/same.py"),
      edit("/repo/same.py"), // churn fire
      ...times(15, () => read()), // push toolCount past high threshold
    ]);
    const res = runCostGuard(events, ON);
    if (res.events.length >= 2) {
      const gap = res.events[1]!.turnIndex - res.events[0]!.turnIndex;
      expect(gap).toBeGreaterThanOrEqual(ON.cooldownToolCalls);
    }
  });

  // (11) same signature warned once.
  test("a single churn signature warns at most once", () => {
    auto = 0;
    const events = reindex([...times(25, () => read()), ...times(8, () => edit("/repo/same.py"))]);
    const res = runCostGuard(events, ON);
    const churnFires = res.events.filter((e) => e.signature === "churn:same.py");
    expect(churnFires.length).toBeLessThanOrEqual(1);
  });
});

describe("costGuard — messages + metadata", () => {
  test("messages carry the stable marker and the right variant per trigger", () => {
    expect(renderCostGuardMessage("high_tool_count")).toContain(COST_GUARD_MARKER);
    expect(renderCostGuardMessage("edit_verify_churn")).toContain("edit/verify churn");
    expect(renderCostGuardMessage("no_patch_drift")).toContain("No patch has been produced");
    expect(renderCostGuardMessage("cost_cap_approaching")).toContain("approaching the budget");
  });

  // (12) metadata records trigger details.
  test("costGuardMeta records per-event trigger detail", () => {
    auto = 0;
    const events = reindex([edit(), ...times(34, () => read())]);
    const res = runCostGuard(events, ON, { estimatedCostUsd: 1.0, turnCount: 40 });
    const meta = costGuardMeta(res, "observe_post_run");
    expect(meta.cost_guard_enabled).toBe(true);
    expect(meta.cost_guard_mode).toBe("observe_post_run");
    expect(meta.cost_guard_injection_count).toBe(res.injectionCount);
    expect(meta.cost_guard_events.length).toBe(res.events.length);
    const e0 = meta.cost_guard_events[0]!;
    expect(e0.trigger_type).toBeTruthy();
    expect(typeof e0.tool_count).toBe("number");
    expect(typeof e0.edit_count).toBe("number");
    expect("patch_seen" in e0).toBe(true);
    expect(meta.cost_guard_injected_messages[0]).toContain(COST_GUARD_MARKER);
  });

  test("isVerifyCommand recognises test/build commands and rejects plain shell", () => {
    expect(isVerifyCommand("python -m pytest tests/")).toBe(true);
    expect(isVerifyCommand("tox -e py39")).toBe(true);
    expect(isVerifyCommand("ls -la")).toBe(false);
    expect(isVerifyCommand(null)).toBe(false);
  });

  test("toCostGuardEvent tolerates lean and rich stream records", () => {
    const lean = toCostGuardEvent({ index: 3, tool: "Read", category: "read", path: "/x.py" }, 0);
    expect(lean.index).toBe(3);
    expect(lean.category).toBe("read");
    const rich = toCostGuardEvent({ tool: "Bash", category: "other", command: "pytest", output_summary: "boom" }, 7);
    expect(rich.index).toBe(7); // fallback index
    expect(rich.output).toBe("boom");
  });
});

describe("costGuard — determinism", () => {
  // (16) offline replay deterministic: same input -> identical result.
  test("runCostGuard is a pure function of its inputs", () => {
    auto = 0;
    const events = reindex([...times(25, () => read()), ...times(6, () => edit("/repo/same.py")), bash("pytest", { success: false })]);
    const ctx = { estimatedCostUsd: 2.7, turnCount: 92 };
    const a = runCostGuard(events, ON, ctx);
    const b = runCostGuard(events, ON, ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
