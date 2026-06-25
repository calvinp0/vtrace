// Default-off repeated-failure / repeated-read tool-loop guard (M75, candidate C1
// from the M74 Self-Harness-lite audit).
//
// The M74 audit found that the largest, cleanest treatment-failure cluster was
// cost-cap exhaustion / tool-loop thrashing: 6 runs pinned the ~$3 per-run cost
// cap (0/6 resolved) and 9 runs tripped the thrashing signal (repeated reads >= 5
// or tool calls >= 25). The agent re-reads the same file or re-runs the same
// failing command without changing its action, burning budget without progress.
//
// This module turns that observation into a deterministic guard. It is PURE
// (no I/O, no agent invocation, no clock, no randomness): it consumes a normalized
// ordered tool-call event stream and produces guard firings + a compact recovery
// message + run metadata. The harness wires it in behind an explicit, DEFAULT-OFF
// flag. It changes NO retrieval, NO Capsule v2 ranking, NO digest decision
// contract, NO pivot-confidence gate, and is opt-in.
//
// Because the external vexp-swe-bench harness owns the agent turn loop (our wrapper
// injects context once up-front and reads the stream back afterwards), this module
// is structured so the SAME pure code path serves both (a) an offline replay over
// captured artifacts and (b) a future mid-loop injection hook, should the external
// harness expose one. In M75 the guard runs in observe/shadow mode: it detects and
// records, and the rendered recovery text is what WOULD be injected.

export const TOOL_LOOP_GUARD_MARKER = "<VTRACE_TOOL_LOOP_GUARD>";

// One normalized tool-call event. Mirrors the fields available in the captured
// `_tool_calls_with_outputs.json` stream (index, tool, category, path, query,
// command, exitCode, success, output) and degrades gracefully to the leaner
// `_tool_calls.json` stream (index, tool, category, path, query) where the
// command/exit/output fields are absent.
export interface ToolLoopGuardEvent {
  readonly index: number;
  readonly tool: string; // Read | Bash | Grep | Glob | Edit | Write | ...
  readonly category: string; // read | search | edit | other
  readonly path?: string | null;
  readonly query?: string | null;
  readonly command?: string | null;
  readonly exitCode?: number | null;
  readonly success?: boolean | null;
  readonly output?: string | null; // raw output/outputSummary text (for error sig)
}

export type ToolLoopTriggerType =
  | "repeated_failed_command" // same normalized failed command, exact match
  | "repeated_command_family_error" // same command family + same error signature
  | "repeated_read" // same file re-read with no intervening edit/new evidence
  | "repeated_search" // same query with no new result
  | "repeated_edit_failure" // same edit/write target failing the same way
  | "repeated_read_window"; // high repeated-read density over a sliding window

// M79 calibration variant.
//   "v0" — the original M75 detector: read/search/window triggers can fire from
//          pure opening orientation (the first thing the agent does).
//   "v4" — the M78-validated calibration (DEFAULT when the guard is enabled): the
//          three READ-FAMILY triggers (repeated_read / repeated_search /
//          repeated_read_window) may fire ONLY after the agent has already made a
//          progress move (a prior search or edit). The three COMMAND-FAILURE
//          triggers (repeated_failed_command / repeated_command_family_error /
//          repeated_edit_failure) are UNCHANGED — they stay eligible from turn 0,
//          which is what preserves the sympy-12419 helpful command-loop fire.
export type ToolLoopGuardCalibration = "v0" | "v4";

// The READ-FAMILY trigger set that V4's prior-progress requirement gates. The
// command-failure family is deliberately excluded (see ToolLoopGuardCalibration).
export const READ_FAMILY_TRIGGERS: ReadonlySet<ToolLoopTriggerType> = new Set<ToolLoopTriggerType>([
  "repeated_read",
  "repeated_search",
  "repeated_read_window",
]);

// The single suppression reason V4 emits when a read-family trigger is withheld
// because no prior progress (search/edit) preceded it.
export const NO_PRIOR_PROGRESS_REASON = "no_prior_progress_for_read_search_window_trigger";

export interface ToolLoopGuardConfig {
  readonly enabled: boolean;
  // M79 calibration of the read-family triggers. Default "v4" (see type docs);
  // "v0" restores the original M75 behavior for A/B comparison.
  readonly calibration: ToolLoopGuardCalibration;
  // anti-spam caps
  readonly maxInjections: number; // default 3
  readonly cooldownToolCalls: number; // >= this many calls between injections; default 3
  // thresholds
  readonly repeatedReadThreshold: number; // fire on the Nth read of the same path in a streak; default 3
  readonly repeatedSearchThreshold: number; // fire on the Nth identical search; default 2
  readonly repeatedFailureThreshold: number; // fire on the Nth byte-identical failure; default 2
  readonly repeatedFamilyErrorThreshold: number; // fire on the Nth same-family+error (weaker); default 3
  readonly windowSize: number; // sliding window for repeated_read_window; default 6
  readonly windowRepeatedReadThreshold: number; // repeated reads within window to fire; default 4
}

export const DEFAULT_TOOL_LOOP_GUARD_CONFIG: ToolLoopGuardConfig = {
  enabled: false, // DEFAULT-OFF
  calibration: "v4", // M79: V4 is the default behavior whenever the guard is enabled
  maxInjections: 3,
  cooldownToolCalls: 3,
  repeatedReadThreshold: 3,
  repeatedSearchThreshold: 2,
  repeatedFailureThreshold: 2,
  repeatedFamilyErrorThreshold: 3,
  windowSize: 6,
  windowRepeatedReadThreshold: 4,
};

export interface ToolLoopGuardFiring {
  readonly turnIndex: number; // event index that triggered the firing
  readonly triggerType: ToolLoopTriggerType;
  readonly signature: string;
  readonly repeatCount: number;
  readonly message: string;
}

// A read-family trigger that the V4 calibration WITHHELD because no prior progress
// (search/edit) preceded it. Recorded for telemetry; it consumes NO injection cap
// and starts NO cooldown (a suppressed event is as if it never reached the injector).
export interface ToolLoopGuardSuppression {
  readonly turnIndex: number;
  readonly triggerType: ToolLoopTriggerType;
  readonly signature: string;
  readonly repeatCount: number;
  readonly reason: string;
}

export interface ToolLoopGuardResult {
  readonly enabled: boolean;
  readonly calibration: ToolLoopGuardCalibration;
  readonly wouldFire: boolean;
  readonly injectionCount: number;
  readonly events: readonly ToolLoopGuardFiring[];
  readonly signatures: readonly string[];
  readonly firstEventTurn: number | null;
  readonly lastEventTurn: number | null;
  // V4 read-family triggers withheld for lack of prior progress (see type docs).
  readonly suppressedEvents: readonly ToolLoopGuardSuppression[];
  // diagnostic counters — accumulate regardless of the injection caps so the
  // offline replay can characterise thrash even when the guard self-suppresses.
  readonly repeatedReadCount: number;
  readonly repeatedSearchCount: number;
  readonly repeatedCommandFailureCount: number;
  readonly repeatedEditFailureCount: number;
}

// ---------------------------------------------------------------------------
// Signature normalization
// ---------------------------------------------------------------------------

// Strip volatile substrings that would otherwise make two identical actions look
// different: absolute temp/workspace/clone paths, timestamps, line/column numbers,
// hex memory addresses, and run labels. Meaningful tokens (command name, missing
// module, exception type, "permission denied", exit code) are preserved by the
// callers below, which extract them BEFORE normalization collapses the rest.
function stripVolatile(text: string): string {
  return (
    text
      // hex memory addresses: 0x7f3a..., at 0x...
      .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
      // ISO-ish timestamps and clock times
      .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g, "TS")
      .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "TS")
      // absolute temp / workspace / clone paths -> keep only the basename
      .replace(/\/(?:tmp|var\/folders|home\/[^/\s]+\/\.cache)\/[^\s'"):]+/g, (m) => `…/${basename(m)}`)
      .replace(/\/[^\s'"):]*\.bench-repos\/[^\s'"):]+/g, (m) => `…/${basename(m)}`)
      .replace(/\/[^\s'"):]*results\/(?:workspaces|runs|precheck)\/[^\s'"):]+/g, (m) => `…/${basename(m)}`)
      // run-label fragments like eval-… / m71_… / r1 / r2 suffixes
      .replace(/\beval-[a-z0-9_-]+/gi, "RUNLABEL")
      // line:col numbers in tracebacks ("line 123", ":123:")
      .replace(/\bline \d+/g, "line N")
      .replace(/:\d+:\d+\b/g, ":N:N")
      .replace(/:\d+\b/g, ":N")
      // collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

// Family of a shell command: the first meaningful token (program name), skipping
// leading env-assignments and common wrappers. `python -m pytest` -> "pytest";
// `cd /x && python foo.py` -> "python". Deterministic, best-effort.
export function commandFamily(command: string): string {
  const cleaned = command
    .replace(/^\s*(?:cd\s+[^\s&|;]+\s*(?:&&|;)\s*)+/i, "") // drop leading `cd … &&`
    .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)+/i, "") // drop env assignments
    .trim();
  const first = cleaned.split(/\s+/)[0] ?? "";
  if (first === "python" || first === "python3" || first === "python2") {
    const m = cleaned.match(/\s-m\s+(\S+)/);
    if (m) return m[1]!.split(".").pop() ?? first;
  }
  return basename(first);
}

// A stable, normalized command signature for exact-repeat detection.
export function normalizeCommand(command: string): string {
  return stripVolatile(command).toLowerCase();
}

// Extract a stable error signature from tool output text, preserving the tokens
// that distinguish DIFFERENT failures (exception type, missing module/file,
// permission error, syntax error, test-failure class) while discarding volatile
// noise. Returns "" when no error-like content is found.
export function normalizeErrorSignature(text: string | null | undefined): string {
  if (!text) return "";
  const tokens: string[] = [];
  // exception / error class name (e.g. ModuleNotFoundError, ImportError, ValueError)
  const exc = text.match(/\b([A-Z][A-Za-z0-9_]*(?:Error|Exception|Warning))\b/);
  if (exc) tokens.push(exc[1]!);
  // missing module / package
  const mod = text.match(/No module named ['"]?([\w.]+)/i);
  if (mod) tokens.push(`nomodule:${mod[1]}`);
  // missing file / no such file
  const nofile = text.match(/No such file or directory:?\s*['"]?([^\s'"]+)?/i);
  if (nofile) tokens.push(`nofile:${nofile[1] ? basename(nofile[1]) : ""}`);
  // command not found
  const notfound = text.match(/([\w.-]+):?\s*command not found/i);
  if (notfound) tokens.push(`cmdnotfound:${notfound[1]}`);
  // permission denied
  if (/permission denied/i.test(text)) tokens.push("permission_denied");
  // syntax error
  if (/SyntaxError|invalid syntax/i.test(text)) tokens.push("syntax_error");
  // test failure classes
  if (/\bAssertionError\b/.test(text)) tokens.push("assertion");
  const failed = text.match(/(\d+)\s+failed/i);
  if (failed) tokens.push("tests_failed");
  if (/\bFAILED\b/.test(text)) tokens.push("test_failed");
  // generic traceback fallback so two tracebacks aren't treated as empty/equal-to-clean
  if (tokens.length === 0 && /Traceback \(most recent call last\)/.test(text)) tokens.push("traceback");
  return tokens.join("|");
}

// ---------------------------------------------------------------------------
// Recovery message rendering
// ---------------------------------------------------------------------------

// Compact, logged-with-marker recovery instruction. Pure function of the trigger.
export function renderToolLoopGuardMessage(
  triggerType: ToolLoopTriggerType,
  signature: string,
  repeatCount: number,
): string {
  const head = `${TOOL_LOOP_GUARD_MARKER} (${triggerType}, x${repeatCount})`;
  if (triggerType === "repeated_read" || triggerType === "repeated_search" || triggerType === "repeated_read_window") {
    return [
      head,
      "You have repeatedly inspected the same file/query without new evidence.",
      "Stop re-reading it unchanged.",
      "State the current hypothesis and either inspect a different file, edit the likely target,",
      "or run a focused verification command.",
    ].join(" ");
  }
  return [
    head,
    "You have repeated the same failed or unproductive action.",
    "Do not retry it unchanged.",
    "Summarize what failed, inspect the relevant current state, and choose a different recovery action.",
    "If a patch is required and no file has changed yet, make the smallest testable progress move.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

function isFailure(e: ToolLoopGuardEvent): boolean {
  if (e.success === false) return true;
  if (typeof e.exitCode === "number" && e.exitCode !== 0) return true;
  return false;
}

export function runToolLoopGuard(
  events: readonly ToolLoopGuardEvent[],
  config: ToolLoopGuardConfig = DEFAULT_TOOL_LOOP_GUARD_CONFIG,
): ToolLoopGuardResult {
  const firings: ToolLoopGuardFiring[] = [];
  const suppressedEvents: ToolLoopGuardSuppression[] = [];
  const firedSignatures = new Set<string>();
  let lastInjectionIndex = -Infinity;
  let injectionCount = 0;

  // V4 prior-progress tracking. `priorEdit` / `priorSearchSigs` reflect ONLY events
  // strictly before the event currently being evaluated (both are updated at the END
  // of each loop iteration), so a trigger sees the information state that preceded it.
  // A non-read shell command (category "other") is deliberately NOT counted as
  // progress: Bash is ambiguous (it may be `cat`/`echo` — read-like), and excluding
  // it both matches the M78-validated V4 and is the conservative choice (it suppresses
  // more pure-orientation fires), per the M79 protocol's tie-break rule.
  const v4 = config.calibration === "v4";
  let priorEdit = false;
  const priorSearchSigs = new Set<string>();

  // streak / repeat state
  const readStreak = new Map<string, number>(); // path -> consecutive unproductive reads
  const searchSeen = new Map<string, string>(); // query|path -> last output (for "new result")
  const searchOccur = new Map<string, number>(); // query|path -> occurrence count in current streak
  const failureRepeat = new Map<string, number>(); // normalized failed command -> count
  const familyErrorRepeat = new Map<string, number>(); // family|errsig -> count
  const editFailureRepeat = new Map<string, number>(); // path|errsig -> count
  // edit-generation gating: a failure that recurs only AFTER an intervening edit
  // is the red->green->red verify cycle (progress), not a dead loop. We reset a
  // failure signature's repeat count whenever an edit has happened since it last fired.
  const failureGen = new Map<string, number>(); // signature -> editGen at last occurrence
  let editGen = 0;
  const recentReadFlags: boolean[] = []; // sliding-window of "was-repeated-read"

  let repeatedReadCount = 0;
  let repeatedSearchCount = 0;
  let repeatedCommandFailureCount = 0;
  let repeatedEditFailureCount = 0;

  const canInject = (idx: number): boolean =>
    config.enabled &&
    injectionCount < config.maxInjections &&
    idx - lastInjectionIndex >= config.cooldownToolCalls;

  const fire = (
    idx: number,
    triggerType: ToolLoopTriggerType,
    signature: string,
    repeatCount: number,
  ): void => {
    // per-signature suppression (warn once) + caps/cooldown
    if (firedSignatures.has(signature)) return;
    if (!canInject(idx)) return;
    firedSignatures.add(signature);
    lastInjectionIndex = idx;
    injectionCount += 1;
    firings.push({
      turnIndex: idx,
      triggerType,
      signature,
      repeatCount,
      message: renderToolLoopGuardMessage(triggerType, signature, repeatCount),
    });
  };

  // Read-family fire with the V4 prior-progress gate. When V4 withholds the trigger
  // it records a suppression and returns WITHOUT touching the injector — so no cap is
  // consumed, no cooldown starts, and the signature is NOT marked fired (it can still
  // fire later if real progress arrives and the loop recurs).
  const fireReadFamily = (
    idx: number,
    triggerType: ToolLoopTriggerType,
    signature: string,
    repeatCount: number,
    progressOk: boolean,
  ): void => {
    if (v4 && !progressOk) {
      // Record the withheld trigger only when the guard is actually enabled; a
      // disabled guard is fully inert (no firings AND no suppressions).
      if (config.enabled) {
        suppressedEvents.push({ turnIndex: idx, triggerType, signature, repeatCount, reason: NO_PRIOR_PROGRESS_REASON });
      }
      return;
    }
    fire(idx, triggerType, signature, repeatCount);
  };

  // Prior progress for repeated_read / repeated_read_window: any earlier search or edit.
  const readWindowProgressOk = (): boolean => priorEdit || priorSearchSigs.size > 0;
  // Prior progress for repeated_search: an earlier edit, OR an earlier search whose
  // signature DIFFERS from the one now repeating (the repeating query's own first
  // occurrence does not count as progress for itself — otherwise a bare repeated
  // search could never be suppressed).
  const searchProgressOk = (currentSig: string): boolean => {
    if (priorEdit) return true;
    for (const s of priorSearchSigs) if (s !== currentSig) return true;
    return false;
  };

  for (const e of events) {
    const idx = e.index;
    let wasRepeatedRead = false;

    // An edit anywhere is "progress": it resets read streaks (intervening edit) and
    // advances the edit generation (so a later same-signature failure is a fresh try).
    if (e.category === "edit") {
      readStreak.clear();
      editGen += 1;
      if (isFailure(e)) {
        const sig = `editfail:${basename(e.path ?? "")}|${normalizeErrorSignature(e.output)}`;
        const n = (editFailureRepeat.get(sig) ?? 0) + 1;
        editFailureRepeat.set(sig, n);
        if (n >= config.repeatedFailureThreshold) {
          repeatedEditFailureCount += 1;
          fire(idx, "repeated_edit_failure", sig, n);
        }
      }
    } else if (e.category === "read") {
      const p = e.path ?? "";
      if (p) {
        // Per spec signal #3, a same-path re-read is unproductive UNLESS an edit
        // or a new search result intervened (both reset the streak elsewhere).
        const n = (readStreak.get(p) ?? 0) + 1;
        readStreak.set(p, n);
        if (n >= 2) {
          repeatedReadCount += 1;
          wasRepeatedRead = true;
        }
        if (n >= config.repeatedReadThreshold) {
          fireReadFamily(idx, "repeated_read", `read:${basename(p)}`, n, readWindowProgressOk());
        }
      }
    } else if (e.category === "search" && (e.query ?? "")) {
      const key = `${e.query ?? ""}|${e.path ?? ""}`;
      const prevOut = searchSeen.get(key);
      const out = e.output ?? null;
      // "new result": we have a prior non-empty output for this exact query and the
      // new output differs -> the search produced new evidence, not a dead repeat.
      const isNewResult =
        prevOut !== undefined && prevOut !== "" && out !== null && out !== prevOut;
      searchSeen.set(key, out ?? prevOut ?? "");
      const occ = isNewResult ? 1 : (searchOccur.get(key) ?? 0) + 1;
      searchOccur.set(key, occ);
      if (!isNewResult && occ >= config.repeatedSearchThreshold) {
        repeatedSearchCount += 1;
        const sig = stripVolatile(e.query ?? "");
        fireReadFamily(idx, "repeated_search", `search:${sig}`, occ, searchProgressOk(sig));
      }
      // a FIRST-TIME or NEW-RESULT search is new evidence -> reset read streaks.
      if (occ === 1) readStreak.clear();
    } else {
      // "other" — shell/Bash commands. A failed command that recurs only after an
      // intervening edit is a fix-and-reverify attempt, NOT a dead loop, so the
      // edit-generation gate resets the repeat count when editGen has advanced.
      if (e.command && isFailure(e)) {
        const ncmd = normalizeCommand(e.command);
        const cmdSig = `cmd:${ncmd}`;
        const fn = editGen > (failureGen.get(cmdSig) ?? -1) ? 1 : (failureRepeat.get(ncmd) ?? 0) + 1;
        failureRepeat.set(ncmd, fn);
        failureGen.set(cmdSig, editGen);
        const errSig = normalizeErrorSignature(e.output);
        const fam = `${commandFamily(e.command)}|${errSig}`;
        const famSig = `fam:${fam}`;
        const famN = editGen > (failureGen.get(famSig) ?? -1) ? 1 : (familyErrorRepeat.get(fam) ?? 0) + 1;
        familyErrorRepeat.set(fam, famN);
        failureGen.set(famSig, editGen);
        if (fn >= config.repeatedFailureThreshold) {
          repeatedCommandFailureCount += 1;
          fire(idx, "repeated_failed_command", cmdSig, fn);
        } else if (famN >= config.repeatedFamilyErrorThreshold) {
          // same family + same error but not byte-identical command — a weaker
          // signal (two distinct erroring commands can share a family), so it
          // needs a higher repeat count before it injects.
          repeatedCommandFailureCount += 1;
          fire(idx, "repeated_command_family_error", famSig, famN);
        }
      }
    }

    // sliding-window repeated-read density
    recentReadFlags.push(wasRepeatedRead);
    if (recentReadFlags.length > config.windowSize) recentReadFlags.shift();
    const windowRepeats = recentReadFlags.filter(Boolean).length;
    if (windowRepeats >= config.windowRepeatedReadThreshold) {
      fireReadFamily(idx, "repeated_read_window", `window:${idx}`, windowRepeats, readWindowProgressOk());
    }

    // Advance the V4 prior-progress state AFTER all of this event's trigger checks, so
    // every trigger is gated on strictly-earlier progress only. A search records its
    // normalized signature; an edit flips the edit flag. (A read/other never counts.)
    if (e.category === "edit") priorEdit = true;
    else if (e.category === "search" && (e.query ?? "")) priorSearchSigs.add(stripVolatile(e.query ?? ""));
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
    repeatedReadCount,
    repeatedSearchCount,
    repeatedCommandFailureCount,
    repeatedEditFailureCount,
  };
}

// Build the additive run-metadata block recorded for a guarded run. Additive only;
// callers spread this into `_run.meta.json` (or the analyzer reads it back).
export interface ToolLoopGuardMeta {
  readonly tool_loop_guard_enabled: boolean;
  readonly tool_loop_guard_calibration: ToolLoopGuardCalibration;
  readonly tool_loop_guard_injection_count: number;
  readonly tool_loop_guard_events: ReadonlyArray<{
    readonly turn: number;
    readonly trigger_type: ToolLoopTriggerType;
    readonly signature: string;
    readonly repeat_count: number;
  }>;
  readonly tool_loop_guard_signatures: readonly string[];
  readonly tool_loop_guard_first_event_turn: number | null;
  readonly tool_loop_guard_last_event_turn: number | null;
  // M79: read-family triggers withheld by the V4 prior-progress gate.
  readonly tool_loop_guard_suppressed_events: ReadonlyArray<{
    readonly turn: number;
    readonly trigger_type: ToolLoopTriggerType;
    readonly signature: string;
    readonly repeat_count: number;
    readonly reason: string;
  }>;
  readonly tool_loop_guard_suppressed_count: number;
  readonly tool_loop_guard_suppression_reasons: readonly string[];
}

export function toolLoopGuardMeta(result: ToolLoopGuardResult): ToolLoopGuardMeta {
  return {
    tool_loop_guard_enabled: result.enabled,
    tool_loop_guard_calibration: result.calibration,
    tool_loop_guard_injection_count: result.injectionCount,
    tool_loop_guard_events: result.events.map((e) => ({
      turn: e.turnIndex,
      trigger_type: e.triggerType,
      signature: e.signature,
      repeat_count: e.repeatCount,
    })),
    tool_loop_guard_signatures: result.signatures,
    tool_loop_guard_first_event_turn: result.firstEventTurn,
    tool_loop_guard_last_event_turn: result.lastEventTurn,
    tool_loop_guard_suppressed_events: result.suppressedEvents.map((s) => ({
      turn: s.turnIndex,
      trigger_type: s.triggerType,
      signature: s.signature,
      repeat_count: s.repeatCount,
      reason: s.reason,
    })),
    tool_loop_guard_suppressed_count: result.suppressedEvents.length,
    tool_loop_guard_suppression_reasons: [...new Set(result.suppressedEvents.map((s) => s.reason))],
  };
}

// Coerce a raw `_tool_calls(.with_outputs).json` record into a guard event.
// Tolerates both the lean and rich stream shapes. PURE.
export function toGuardEvent(raw: Record<string, unknown>, fallbackIndex: number): ToolLoopGuardEvent {
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
