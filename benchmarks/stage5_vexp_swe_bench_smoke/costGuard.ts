// Default-off cost / no-convergence guard (M81, candidate C7 from the M74 Self-Harness
// audit). SEPARATE from — but compatible with — the M75–M80 tool-loop guard.
//
// The M80 V4 live validation closed the LOCAL repeated-action loop vector (the
// tool-loop guard catches repeated_read / repeated_search / repeated_failed_command /
// repeated_edit_failure), but the dominant REMAINING unresolved vector is GLOBAL run
// risk: edit/verify churn, high turn/tool count, cost drift toward the per-task cap, and
// repeated patch attempts that never converge (django-16263 ran 42 tools / 97 turns with
// no cap and stayed unresolved; django-12273 burned the ~$3 cap over 7 edits). A single
// late tool-loop advisory does not steer that to convergence. C7 turns those run-level
// signals into a deterministic guard that injects a compact "stop and commit" recovery.
//
// Distinction from the tool-loop guard (kept clean so the two never alias):
//   * tool-loop guard  — LOCAL: the same action repeats WITHOUT intervening progress
//                        (re-read unchanged, re-run the byte-identical failing command).
//                        Its edit-generation gate RESETS a failure once an edit lands.
//   * cost guard (C7)  — GLOBAL: the run as a whole is approaching budget without
//                        convergence — many edit/verify cycles on one file, a failure
//                        class that PERSISTS despite edits, high tool/turn count, cost
//                        near the cap, or no patch produced near budget.
//
// This module is PURE / deterministic (no I/O, no agent, no clock, no randomness): it
// consumes a normalized ordered tool-call event stream plus an optional run-context
// (estimated cost / turn count, available offline or in observe mode) and produces guard
// firings + a compact recovery message + run metadata. The harness wires it in behind an
// explicit, DEFAULT-OFF flag. It changes NO retrieval, NO Capsule v2 ranking, NO digest
// decision contract, NO pivot-confidence gate, and NO tool-loop guard behavior.

import { normalizeErrorSignature, type ToolLoopGuardEvent } from "./toolLoopGuard";

export const COST_GUARD_MARKER = "<VTRACE_COST_GUARD>";

// C7 reuses the tool-loop guard's normalized event shape (index, tool, category, path,
// query, command, exitCode, success, output). Sharing the event type is the "shared
// runtime-hook infrastructure" the M81 brief permits; the metadata + trigger names below
// stay distinct.
export type CostGuardEvent = ToolLoopGuardEvent;

export type CostGuardTriggerType =
  | "high_tool_count" // tool-call count crossed the high threshold (no convergence)
  | "high_turn_count" // turn count crossed the high threshold (run-context only)
  | "edit_verify_churn" // repeated edit/verify cycles on the SAME file
  | "no_patch_drift" // many tool calls with no edit/write produced yet
  | "repeated_verification_no_progress" // same verify-failure class PERSISTS across edits
  | "cost_cap_approaching"; // estimated cost near the per-task cap (run-context only)

// The three triggers whose recovery text is the generic "approaching budget" message.
const GENERAL_TRIGGERS: ReadonlySet<CostGuardTriggerType> = new Set<CostGuardTriggerType>([
  "high_tool_count",
  "high_turn_count",
  "cost_cap_approaching",
]);
// The two triggers whose recovery text is the edit/verify-churn message.
const CHURN_TRIGGERS: ReadonlySet<CostGuardTriggerType> = new Set<CostGuardTriggerType>([
  "edit_verify_churn",
  "repeated_verification_no_progress",
]);

// M84 first-class C7 calibration. A named, A/B-selectable tuning of the guard.
//   "v0"  — the M81/M82/M83 default: editVerifyChurnThreshold = 3.
//   "c7d" — the M83-recommended calibration: editVerifyChurnThreshold = 2, EVERY other
//           threshold unchanged. It lets the SAME-file edit/verify churn trigger fire one
//           cycle earlier (the largest safe timing lead found in the M83 sweep — e.g.
//           django-16263 first-fires +10 tools earlier — without lowering the 25-tool
//           protective gate, without new early/control fires, and leaving the winning
//           sympy-12419 trajectory untouched).
// The calibration changes ONLY editVerifyChurnThreshold; the 25-tool gate, turn gate,
// high tool/turn counts, no-patch drift, repeated-verify, cost cap, and anti-spam caps
// are all identical between v0 and c7d.
export type CostGuardCalibration = "v0" | "c7d";

// The single source mapping a calibration to its edit/verify-churn threshold. The ONLY
// dimension a calibration changes.
export const COST_GUARD_CALIBRATION_CHURN_THRESHOLD: Readonly<Record<CostGuardCalibration, number>> = {
  v0: 3,
  c7d: 2,
};

// Optional run-level signals. Available offline / in observe mode (read back from the
// result row); usually ABSENT in the live PostToolUse hook, where only stream proxies
// (tool / read / search / edit / command counts) are observable. When a signal is null,
// the trigger that depends on it is simply not evaluated (no guessing).
export interface CostGuardRunContext {
  readonly estimatedCostUsd?: number | null;
  readonly costCapUsd?: number | null; // falls back to config.defaultCostCapUsd
  readonly turnCount?: number | null; // total turns so far
}

export interface CostGuardConfig {
  readonly enabled: boolean;
  // M84 named calibration. Provenance for the run + the canonical knob that selects
  // editVerifyChurnThreshold (see costGuardConfigForCalibration). Default "v0".
  readonly calibration: CostGuardCalibration;
  // anti-spam caps
  readonly maxInjections: number; // default 2
  readonly cooldownToolCalls: number; // >= this many calls between injections; default 8
  // global gates: NO C7 trigger may fire before BOTH are satisfied (avoids firing
  // during normal early exploration / orientation).
  readonly minToolCallsBeforeFire: number; // default 25
  readonly minTurnsBeforeFire: number; // default 8 (run-context; satisfied when absent)
  // thresholds
  readonly highToolCountThreshold: number; // fire high_tool_count at >= N tool calls; default 35
  readonly highTurnCountThreshold: number; // fire high_turn_count at >= N turns; default 90
  readonly editVerifyChurnThreshold: number; // edits to the SAME file to call it churn; default 3
  readonly noPatchToolThreshold: number; // tool calls with zero edits to call it drift; default 30
  readonly repeatedVerifyThreshold: number; // same post-edit verify-failure class repeats; default 3
  readonly costCapFraction: number; // fraction of the cap that counts as "approaching"; default 0.85
  readonly defaultCostCapUsd: number; // per-task cost cap when run-context omits one; default 3.0
}

export const DEFAULT_COST_GUARD_CONFIG: CostGuardConfig = {
  enabled: false, // DEFAULT-OFF
  calibration: "v0", // module default stays v0 (the harness selects c7d when it enables the guard)
  maxInjections: 2,
  cooldownToolCalls: 8,
  minToolCallsBeforeFire: 25,
  minTurnsBeforeFire: 8,
  highToolCountThreshold: 35,
  highTurnCountThreshold: 90,
  editVerifyChurnThreshold: 3,
  noPatchToolThreshold: 30,
  repeatedVerifyThreshold: 3,
  costCapFraction: 0.85,
  defaultCostCapUsd: 3.0,
};

// Build the canonical config for a named calibration. The calibration is the single knob
// that selects editVerifyChurnThreshold (v0 -> 3, c7d -> 2); EVERY other field comes from
// DEFAULT_COST_GUARD_CONFIG so c7d differs from v0 in exactly one threshold (plus the
// recorded calibration label). Optional `overrides` win last (the harness passes
// `{ enabled: true }`; the offline sweep may pass extra threshold overrides). PURE.
export function costGuardConfigForCalibration(
  calibration: CostGuardCalibration,
  overrides: Partial<CostGuardConfig> = {},
): CostGuardConfig {
  return {
    ...DEFAULT_COST_GUARD_CONFIG,
    calibration,
    editVerifyChurnThreshold: COST_GUARD_CALIBRATION_CHURN_THRESHOLD[calibration],
    ...overrides,
  };
}

// A snapshot of the run-state proxies at the moment a trigger fired. Recorded per event
// so the offline replay / metadata can characterise WHY the guard fired.
export interface CostGuardSnapshot {
  readonly toolCount: number;
  readonly turnCount: number | null;
  readonly readCount: number;
  readonly searchCount: number;
  readonly editCount: number;
  readonly verifyCount: number;
  readonly patchSeen: boolean;
  readonly estimatedCostUsd: number | null;
}

export interface CostGuardFiring {
  readonly turnIndex: number; // event index that triggered the firing
  readonly triggerType: CostGuardTriggerType;
  readonly signature: string;
  readonly reason: string;
  readonly message: string;
  readonly snapshot: CostGuardSnapshot;
}

// A trigger that crossed its threshold but was WITHHELD — because a gate was not yet
// satisfied, a cap/cooldown was active, or its signature already warned once. Recorded
// for telemetry; consumes NO injection cap and starts NO cooldown.
export interface CostGuardSuppression {
  readonly turnIndex: number;
  readonly triggerType: CostGuardTriggerType;
  readonly signature: string;
  readonly reason: string;
}

export interface CostGuardResult {
  readonly enabled: boolean;
  readonly calibration: CostGuardCalibration; // the calibration this result was produced under
  readonly wouldFire: boolean;
  readonly injectionCount: number;
  readonly events: readonly CostGuardFiring[];
  readonly signatures: readonly string[];
  readonly firstEventTurn: number | null;
  readonly lastEventTurn: number | null;
  readonly suppressedEvents: readonly CostGuardSuppression[];
  // diagnostic counters (accumulate regardless of the caps).
  readonly maxSameFileEditCount: number;
  readonly noPatchToolStreak: number; // tool calls before the first edit (0 if an edit led)
  readonly repeatedVerifyFailureCount: number;
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

// A shell command is a "verify" when it runs tests / the interpreter / a build — the
// commands an agent uses to check whether its edit worked. Deterministic, best-effort.
const VERIFY_RE = /\b(pytest|py\.test|unittest|tox|nox|nosetests|make|python\s|python3\s|python2\s|coverage|runtests)/i;
export function isVerifyCommand(command: string | null | undefined): boolean {
  return !!command && VERIFY_RE.test(command);
}

function isFailure(e: CostGuardEvent): boolean {
  if (e.success === false) return true;
  if (typeof e.exitCode === "number" && e.exitCode !== 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Recovery message rendering (pure function of the trigger). Uses the exact M81 texts.
// ---------------------------------------------------------------------------

export function renderCostGuardMessage(triggerType: CostGuardTriggerType): string {
  if (CHURN_TRIGGERS.has(triggerType)) {
    return [
      COST_GUARD_MARKER,
      "You are in an edit/verify churn pattern.",
      "Do not keep making small unrelated edits. Summarize the failing signal, identify the single most likely remaining cause, and make one coherent corrective patch or stop with a clear no-patch reason.",
      "</VTRACE_COST_GUARD>",
    ].join("\n");
  }
  if (triggerType === "no_patch_drift") {
    return [
      COST_GUARD_MARKER,
      "No patch has been produced after substantial exploration.",
      "If this task requires a code change, make the smallest testable edit now. If no safe patch exists, explicitly state the blocker and stop rather than continuing to spend budget.",
      "</VTRACE_COST_GUARD>",
    ].join("\n");
  }
  // GENERAL_TRIGGERS
  return [
    COST_GUARD_MARKER,
    "You appear to be approaching the budget without clear convergence.",
    "Stop broad exploration. State the current best hypothesis, choose the smallest coherent patch or no-patch conclusion, and run the most focused available verification.",
    "Avoid more read/edit/verify churn unless it directly changes the patch.",
    "</VTRACE_COST_GUARD>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function runCostGuard(
  events: readonly CostGuardEvent[],
  config: CostGuardConfig = DEFAULT_COST_GUARD_CONFIG,
  context: CostGuardRunContext = {},
): CostGuardResult {
  const firings: CostGuardFiring[] = [];
  const suppressedEvents: CostGuardSuppression[] = [];
  const firedSignatures = new Set<string>();
  let lastInjectionIndex = -Infinity;
  let injectionCount = 0;

  // run-state proxies, advanced as we walk the stream
  let toolCount = 0;
  let readCount = 0;
  let searchCount = 0;
  let editCount = 0;
  let verifyCount = 0;
  let patchSeen = false;
  let noPatchToolStreak = 0; // tool calls seen before the first edit
  const editsPerFile = new Map<string, number>(); // path -> total edits
  let maxSameFileEditCount = 0;
  let repeatedVerifyFailureCount = 0;

  // repeated-verification-no-progress: count occurrences of the same verify-failure
  // signature where AT LEAST ONE edit happened since that signature last appeared. This
  // is the failure-class-PERSISTS-DESPITE-edits pattern, deliberately the complement of
  // the tool-loop guard (which RESETS on an intervening edit). Keyed by error signature.
  const verifyErrSig = new Map<string, number>(); // errsig -> persistent-recurrence count
  const verifyErrEditGen = new Map<string, number>(); // errsig -> editGen at last occurrence
  let editGen = 0;

  const turnCount = typeof context.turnCount === "number" ? context.turnCount : null;
  const estimatedCostUsd = typeof context.estimatedCostUsd === "number" ? context.estimatedCostUsd : null;
  const costCap = typeof context.costCapUsd === "number" ? context.costCapUsd : config.defaultCostCapUsd;

  const snapshot = (): CostGuardSnapshot => ({
    toolCount,
    turnCount,
    readCount,
    searchCount,
    editCount,
    verifyCount,
    patchSeen,
    estimatedCostUsd,
  });

  // Global gate: every C7 trigger is held until the run is deep enough that a firing is
  // not just normal orientation. minTurns is satisfied when run-context omits turns.
  const gatesOpen = (): boolean =>
    toolCount >= config.minToolCallsBeforeFire &&
    (turnCount === null || turnCount >= config.minTurnsBeforeFire);

  const canInject = (idx: number): boolean =>
    config.enabled &&
    injectionCount < config.maxInjections &&
    idx - lastInjectionIndex >= config.cooldownToolCalls;

  const fire = (idx: number, triggerType: CostGuardTriggerType, signature: string, reason: string): void => {
    if (!gatesOpen()) {
      if (config.enabled) suppressedEvents.push({ turnIndex: idx, triggerType, signature, reason: "gates_not_open" });
      return;
    }
    if (firedSignatures.has(signature)) return; // warn once per signature
    if (!canInject(idx)) {
      if (config.enabled) {
        const why = injectionCount >= config.maxInjections ? "max_injections_reached" : "cooldown_active";
        suppressedEvents.push({ turnIndex: idx, triggerType, signature, reason: why });
      }
      return;
    }
    firedSignatures.add(signature);
    lastInjectionIndex = idx;
    injectionCount += 1;
    firings.push({
      turnIndex: idx,
      triggerType,
      signature,
      reason,
      message: renderCostGuardMessage(triggerType),
      snapshot: snapshot(),
    });
  };

  for (const e of events) {
    const idx = e.index;
    toolCount += 1;

    if (e.category === "edit") {
      editCount += 1;
      editGen += 1;
      if (!patchSeen) patchSeen = true;
      const p = basename(e.path ?? "");
      if (p) {
        const n = (editsPerFile.get(p) ?? 0) + 1;
        editsPerFile.set(p, n);
        if (n > maxSameFileEditCount) maxSameFileEditCount = n;
        if (n >= config.editVerifyChurnThreshold) {
          fire(idx, "edit_verify_churn", `churn:${p}`, `${n} edits to ${p}`);
        }
      }
    } else if (e.category === "read") {
      readCount += 1;
      if (editCount === 0) noPatchToolStreak += 1;
    } else if (e.category === "search") {
      searchCount += 1;
      if (editCount === 0) noPatchToolStreak += 1;
    } else {
      // "other" — shell/Bash. May be a verify (test/build) command.
      if (editCount === 0) noPatchToolStreak += 1;
      if (isVerifyCommand(e.command)) {
        verifyCount += 1;
        if (isFailure(e) && editCount > 0) {
          // a verify failure AFTER at least one edit. If an edit landed since this
          // signature last failed, the failure has PERSISTED despite a fix attempt.
          const sig = normalizeErrorSignature(e.output) || "verify_failed";
          const lastGen = verifyErrEditGen.get(sig) ?? -1;
          const advanced = editGen > lastGen;
          const n = advanced ? (verifyErrSig.get(sig) ?? 0) + 1 : verifyErrSig.get(sig) ?? 0;
          verifyErrSig.set(sig, n);
          verifyErrEditGen.set(sig, editGen);
          if (advanced && n >= 1) repeatedVerifyFailureCount = Math.max(repeatedVerifyFailureCount, n);
          if (n >= config.repeatedVerifyThreshold) {
            fire(idx, "repeated_verification_no_progress", `verifyfail:${sig}`, `same verify failure '${sig}' persisted across ${n} edits`);
          }
        }
      }
    }

    // no_patch_drift: many tool calls and STILL no edit produced.
    if (editCount === 0 && toolCount >= config.noPatchToolThreshold) {
      fire(idx, "no_patch_drift", "nopatch", `${toolCount} tool calls, no edit produced`);
    }

    // high_tool_count: the run is deep with no convergence yet. A positional STREAM
    // trigger — fires at the tool call where the count crosses the threshold.
    if (toolCount >= config.highToolCountThreshold) {
      fire(idx, "high_tool_count", "tools", `${toolCount} tool calls`);
    }
  }

  // Run-context aggregate triggers (high_turn_count / cost_cap_approaching) are END-OF-RUN
  // facts: turns and cost are run-level totals, not per-tool-call observables, so we do NOT
  // know they crossed earlier. We therefore attribute them to the LAST event (the latest
  // honest point at which the aggregate is certainly true), AFTER the positional stream
  // triggers have set first_fire_turn. They are observe-only — the live runtime hook has no
  // run-context, so these never fire mid-loop; the stream triggers carry production.
  const lastIdx = events.length > 0 ? events[events.length - 1]!.index : 0;
  if (turnCount !== null && turnCount >= config.highTurnCountThreshold) {
    fire(lastIdx, "high_turn_count", "turns", `${turnCount} turns`);
  }
  if (estimatedCostUsd !== null && estimatedCostUsd >= config.costCapFraction * costCap) {
    fire(lastIdx, "cost_cap_approaching", "cost", `est cost $${estimatedCostUsd.toFixed(2)} >= ${(config.costCapFraction * 100).toFixed(0)}% of $${costCap.toFixed(2)} cap`);
  }

  return {
    enabled: config.enabled,
    calibration: config.calibration,
    wouldFire: firings.length > 0,
    injectionCount,
    events: firings,
    signatures: firings.map((f) => f.signature),
    firstEventTurn: firings.length ? firings[0]!.turnIndex : null,
    lastEventTurn: firings.length ? firings[firings.length - 1]!.turnIndex : null,
    suppressedEvents,
    maxSameFileEditCount,
    noPatchToolStreak,
    repeatedVerifyFailureCount,
  };
}

// ---------------------------------------------------------------------------
// Run metadata (additive; callers spread into _run.meta.json / analyzer reads back)
// ---------------------------------------------------------------------------

export type CostGuardMode = "observe_post_run" | "runtime_injection";

export interface CostGuardMeta {
  readonly cost_guard_enabled: boolean;
  readonly cost_guard_calibration: CostGuardCalibration;
  readonly cost_guard_mode: CostGuardMode;
  readonly cost_guard_injection_count: number;
  readonly cost_guard_events: ReadonlyArray<{
    readonly turn_or_event_index: number;
    readonly calibration: CostGuardCalibration;
    readonly trigger_type: CostGuardTriggerType;
    readonly signature: string;
    readonly reason: string;
    readonly tool_count: number;
    readonly turn_count: number | null;
    readonly read_count: number;
    readonly search_count: number;
    readonly edit_count: number;
    readonly verify_count: number;
    readonly patch_seen: boolean;
    readonly estimated_cost_if_available: number | null;
  }>;
  readonly cost_guard_injected_messages: readonly string[];
  readonly cost_guard_signatures: readonly string[];
  readonly cost_guard_first_event_turn: number | null;
  readonly cost_guard_last_event_turn: number | null;
  readonly cost_guard_suppressed_events: ReadonlyArray<{
    readonly turn_or_event_index: number;
    readonly trigger_type: CostGuardTriggerType;
    readonly signature: string;
    readonly reason: string;
  }>;
  readonly cost_guard_suppressed_count: number;
}

export function costGuardMeta(result: CostGuardResult, mode: CostGuardMode): CostGuardMeta {
  return {
    cost_guard_enabled: result.enabled,
    cost_guard_calibration: result.calibration,
    cost_guard_mode: mode,
    cost_guard_injection_count: result.injectionCount,
    cost_guard_events: result.events.map((e) => ({
      turn_or_event_index: e.turnIndex,
      calibration: result.calibration,
      trigger_type: e.triggerType,
      signature: e.signature,
      reason: e.reason,
      tool_count: e.snapshot.toolCount,
      turn_count: e.snapshot.turnCount,
      read_count: e.snapshot.readCount,
      search_count: e.snapshot.searchCount,
      edit_count: e.snapshot.editCount,
      verify_count: e.snapshot.verifyCount,
      patch_seen: e.snapshot.patchSeen,
      estimated_cost_if_available: e.snapshot.estimatedCostUsd,
    })),
    cost_guard_injected_messages: result.events.map((e) => e.message),
    cost_guard_signatures: result.signatures,
    cost_guard_first_event_turn: result.firstEventTurn,
    cost_guard_last_event_turn: result.lastEventTurn,
    cost_guard_suppressed_events: result.suppressedEvents.map((s) => ({
      turn_or_event_index: s.turnIndex,
      trigger_type: s.triggerType,
      signature: s.signature,
      reason: s.reason,
    })),
    cost_guard_suppressed_count: result.suppressedEvents.length,
  };
}

// Coerce a raw `_tool_calls(.with_outputs).json` record into a cost-guard event.
// Tolerates both the lean and rich stream shapes. PURE.
export function toCostGuardEvent(raw: Record<string, unknown>, fallbackIndex: number): CostGuardEvent {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    index: typeof raw.index === "number" ? raw.index : fallbackIndex,
    tool: str(raw.tool) ?? "",
    category: str(raw.category) ?? "other",
    path: str(raw.path),
    query: str(raw.query),
    command: str(raw.command),
    exitCode: num(raw.exitCode),
    success: typeof raw.success === "boolean" ? raw.success : null,
    output: str(raw.output) ?? str(raw.outputSummary) ?? str(raw.output_summary),
  };
}
