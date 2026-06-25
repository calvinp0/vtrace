// M76 runtime injection hook for the M75 tool-loop guard.
//
// M75 shipped the PURE deterministic detector (`runToolLoopGuard`) but could only
// run it in OBSERVE mode: the external vexp-swe-bench adapter spawns `claude -p`
// as a single-shot headless process, so the agent's whole turn loop runs INSIDE
// that subprocess and the adapter only sees `rawOutput` after it exits. There was
// no place to feed a recovery message back mid-loop (M75 limitation y9j5di).
//
// M76 closes that gap WITHOUT changing the detector. The real mid-loop hook point
// is Claude Code's own hook system: `claude -p` honours a `--settings` file that
// registers a `PostToolUse` command hook, and that hook can inject text into the
// model's next turn via `hookSpecificOutput.additionalContext`. So the runtime
// path is: each tool result -> PostToolUse hook process -> this module's state
// machine -> (maybe) an injected recovery message.
//
// This module is PURE / deterministic (no I/O, no clock, no randomness). It
// reuses the M75 batch detector as the single source of truth:
//
//   * `stepToolLoopGuardRuntime` appends one event and RE-RUNS `runToolLoopGuard`
//     over the accumulated prefix. Because every firing depends only on events at
//     index <= its trigger index, firings are PREFIX-STABLE — the firing list over
//     a growing prefix only grows, never reorders. So the runtime injector fires
//     at EXACTLY the same turns as observe mode, by construction (proven by the
//     M76 offline simulation).
//   * `runToolLoopGuardHook` is the thin, fail-closed hook body: parse the
//     PostToolUse event, normalize it, load/append/persist state, and render the
//     `additionalContext` payload when a firing occurs.
//
// It changes NO retrieval, NO Capsule v2 ranking, NO digest decision contract, NO
// pivot-confidence gate. It is reachable only when the harness explicitly enables
// injection mode (default-off; observe mode unaffected).

import {
  runToolLoopGuard,
  DEFAULT_TOOL_LOOP_GUARD_CONFIG,
  TOOL_LOOP_GUARD_MARKER,
  type ToolLoopGuardEvent,
  type ToolLoopGuardConfig,
  type ToolLoopGuardFiring,
  type ToolLoopGuardResult,
} from "./toolLoopGuard";

// Stable mode tokens recorded in run metadata.
export const TOOL_LOOP_GUARD_OBSERVE_MODE = "observe_post_run" as const;
export const TOOL_LOOP_GUARD_RUNTIME_MODE = "runtime_injection" as const;
export type ToolLoopGuardRuntimeMode =
  | typeof TOOL_LOOP_GUARD_OBSERVE_MODE
  | typeof TOOL_LOOP_GUARD_RUNTIME_MODE;

// ---------------------------------------------------------------------------
// Incremental state machine (wraps the PURE batch detector)
// ---------------------------------------------------------------------------

export interface ToolLoopGuardRuntimeState {
  // The ordered events seen so far. Serialized between hook process invocations.
  readonly events: readonly ToolLoopGuardEvent[];
  // Signatures already surfaced/recorded as firings, so the same loop warns ONCE
  // even across separate hook processes (mirrors the batch detector's per-signature
  // suppression).
  readonly injectedSignatures: readonly string[];
}

export function initRuntimeState(): ToolLoopGuardRuntimeState {
  return { events: [], injectedSignatures: [] };
}

export interface ToolLoopGuardRuntimeStep {
  readonly state: ToolLoopGuardRuntimeState;
  // The single firing surfaced THIS turn (at most one message injected per tool
  // result), or null. Under the production config (cooldown >= 1) the detector
  // fires at most once per event index, so this captures every new firing.
  readonly injection: ToolLoopGuardFiring | null;
  readonly injectedMessage: string | null;
  // Every firing newly admitted by appending this event (>1 only with cooldown 0,
  // which the production config never uses). Recorded so suppression stays exact.
  readonly firingsThisStep: readonly ToolLoopGuardFiring[];
}

// Append one event, recompute the canonical firing set over the whole prefix, and
// surface any firing the prefix did not already contain. Deterministic. When the
// config is disabled it is a pure accumulate-only no-op (never injects).
export function stepToolLoopGuardRuntime(
  state: ToolLoopGuardRuntimeState,
  event: ToolLoopGuardEvent,
  config: ToolLoopGuardConfig = DEFAULT_TOOL_LOOP_GUARD_CONFIG,
): ToolLoopGuardRuntimeStep {
  const events = [...state.events, event];
  if (!config.enabled) {
    return {
      state: { events, injectedSignatures: state.injectedSignatures },
      injection: null,
      injectedMessage: null,
      firingsThisStep: [],
    };
  }
  const result = runToolLoopGuard(events, config);
  const already = new Set(state.injectedSignatures);
  const fresh = result.events.filter((f) => !already.has(f.signature));
  const injection = fresh.length > 0 ? fresh[0]! : null;
  const injectedSignatures = [...state.injectedSignatures, ...fresh.map((f) => f.signature)];
  return {
    state: { events, injectedSignatures },
    injection,
    injectedMessage: injection ? injection.message : null,
    firingsThisStep: fresh,
  };
}

// The canonical run result for the accumulated state — identical to what observe
// mode would compute over the same events (single source of truth for parity).
export function runtimeResult(
  state: ToolLoopGuardRuntimeState,
  config: ToolLoopGuardConfig = DEFAULT_TOOL_LOOP_GUARD_CONFIG,
): ToolLoopGuardResult {
  return runToolLoopGuard(state.events, { ...config, enabled: true });
}

// ---------------------------------------------------------------------------
// State serialization (persisted to a session-keyed file between hook processes)
// ---------------------------------------------------------------------------

export function serializeRuntimeState(state: ToolLoopGuardRuntimeState): string {
  return JSON.stringify({ events: state.events, injectedSignatures: state.injectedSignatures });
}

export function deserializeRuntimeState(text: string | null | undefined): ToolLoopGuardRuntimeState {
  if (!text) return initRuntimeState();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return initRuntimeState();
    const obj = parsed as Record<string, unknown>;
    const events = Array.isArray(obj.events) ? (obj.events as ToolLoopGuardEvent[]) : [];
    const injectedSignatures = Array.isArray(obj.injectedSignatures)
      ? (obj.injectedSignatures as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    return { events, injectedSignatures };
  } catch {
    return initRuntimeState();
  }
}

// ---------------------------------------------------------------------------
// PostToolUse event normalization
// ---------------------------------------------------------------------------

// Claude Code tool names -> guard category. Mirrors the READ/SEARCH/EDIT sets the
// runner's telemetry parser uses; anything else (notably Bash) is "other".
const READ_TOOLS = new Set(["read", "view", "notebookread", "cat", "open"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "ls", "search", "find"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "applypatch", "apply_patch"]);

export function toolNameToCategory(tool: string): string {
  const t = tool.toLowerCase();
  if (READ_TOOLS.has(t)) return "read";
  if (SEARCH_TOOLS.has(t)) return "search";
  if (EDIT_TOOLS.has(t)) return "edit";
  return "other";
}

// Shape of a Claude Code PostToolUse hook event (the fields we consume). The CLI
// has shipped both `tool_output` and `tool_response`; we tolerate either.
export interface PostToolUseHookEvent {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_output?: unknown;
  readonly tool_response?: unknown;
  readonly session_id?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// Best-effort extraction of (output text, success, exitCode) from a tool result
// that may be a plain string or a structured object. Degrades to nulls — the
// detector tolerates missing fields.
function normalizeToolResult(out: unknown): {
  output: string | null;
  success: boolean | null;
  exitCode: number | null;
} {
  if (out == null) return { output: null, success: null, exitCode: null };
  if (typeof out === "string") return { output: out, success: null, exitCode: null };
  if (typeof out !== "object") return { output: String(out), success: null, exitCode: null };
  const o = out as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const exitCode = num(o.exitCode) ?? num(o.exit_code) ?? num(o.returnCode) ?? num(o.code);
  let success: boolean | null = null;
  if (typeof o.is_error === "boolean") success = !o.is_error;
  else if (typeof o.isError === "boolean") success = !o.isError;
  else if (typeof o.success === "boolean") success = o.success;
  else if (typeof exitCode === "number") success = exitCode === 0;
  const textParts = [o.stdout, o.stderr, o.output, o.content, o.text, o.result]
    .filter((v): v is string => typeof v === "string");
  const output = textParts.length > 0 ? textParts.join("\n") : JSON.stringify(o);
  return { output, success, exitCode };
}

// Convert one PostToolUse hook event into a normalized guard event. PURE.
export function postToolUseEventToGuardEvent(raw: PostToolUseHookEvent, index: number): ToolLoopGuardEvent {
  const tool = asString(raw.tool_name) ?? "";
  const category = toolNameToCategory(tool);
  const input =
    raw.tool_input && typeof raw.tool_input === "object"
      ? (raw.tool_input as Record<string, unknown>)
      : {};
  const path = asString(input.file_path) ?? asString(input.path) ?? asString(input.notebook_path);
  const query = asString(input.pattern) ?? asString(input.query);
  const command = asString(input.command);
  const { output, success, exitCode } = normalizeToolResult(
    raw.tool_output !== undefined ? raw.tool_output : raw.tool_response,
  );
  return { index, tool, category, path, query, command, exitCode, success, output };
}

// ---------------------------------------------------------------------------
// Hook stdout rendering
// ---------------------------------------------------------------------------

export interface PostToolUseHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PostToolUse";
    readonly additionalContext?: string;
  };
}

// The inert payload emitted when nothing fires: a well-formed PostToolUse output
// with NO additionalContext, so the agent's turn is untouched.
export const TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse" },
} satisfies PostToolUseHookOutput);

// The injecting payload: feeds the recovery message into the model's next turn.
export function renderHookStdout(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message },
  } satisfies PostToolUseHookOutput);
}

// ---------------------------------------------------------------------------
// Claude Code --settings hook registration
// ---------------------------------------------------------------------------

export interface ClaudeHookSettings {
  readonly hooks: {
    readonly PostToolUse: ReadonlyArray<{
      readonly matcher: string;
      readonly hooks: ReadonlyArray<{ readonly type: "command"; readonly command: string }>;
    }>;
  };
}

// Build the `--settings` JSON that registers `command` as a PostToolUse hook for
// every tool (matcher "*"). PURE.
export function buildToolLoopGuardHookSettings(command: string): ClaudeHookSettings {
  return {
    hooks: {
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
    },
  };
}

// ---------------------------------------------------------------------------
// Hook body (fail-closed). Pure w.r.t. injected I/O so it is unit-testable
// without a live agent: the executable wrapper (toolLoopGuardHook.ts) supplies
// real fs/stdin/env.
// ---------------------------------------------------------------------------

export interface ToolLoopGuardHookIo {
  // Returns the file's contents, or null if it does not exist / is unreadable.
  readState(stateFile: string): string | null;
  writeState(stateFile: string, content: string): void;
  // Optional structured log of injection events (one JSON line per injection).
  appendLog?(logFile: string, line: string): void;
}

export interface ToolLoopGuardHookEnv {
  // Explicit state file path, OR a state directory the hook keys by session id.
  readonly stateFile?: string;
  readonly stateDir?: string;
  // Optional JSON override of the guard config (merged over the defaults; enabled
  // is always forced true because the hook is only registered in inject mode).
  readonly configJson?: string;
  // Optional injection-event log file.
  readonly logFile?: string;
  // Fallback session id when the event omits one.
  readonly sessionId?: string;
}

export function parseHookConfig(configJson: string | undefined): ToolLoopGuardConfig {
  const base = { ...DEFAULT_TOOL_LOOP_GUARD_CONFIG, enabled: true };
  if (!configJson) return base;
  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) return base;
    return { ...base, ...(parsed as Partial<ToolLoopGuardConfig>), enabled: true };
  } catch {
    return base;
  }
}

function resolveStateFile(env: ToolLoopGuardHookEnv, sessionId: string | null): string {
  if (env.stateFile) return env.stateFile;
  const dir = env.stateDir ?? ".";
  const sid = (sessionId ?? env.sessionId ?? "session").replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${dir.replace(/\/+$/, "")}/tool_loop_guard_${sid}.json`;
}

export interface ToolLoopGuardHookResult {
  readonly stdout: string;
  readonly injected: boolean;
  readonly signature: string | null;
  readonly turn: number | null;
}

// The complete hook body: parse -> normalize -> step -> persist -> render. Catches
// everything and FAILS CLOSED — on any error it injects nothing and emits the inert
// no-op payload, so a malformed event or a corrupt state file can never steer or
// crash the agent.
export function runToolLoopGuardHook(
  stdinText: string,
  env: ToolLoopGuardHookEnv,
  io: ToolLoopGuardHookIo,
): ToolLoopGuardHookResult {
  try {
    const raw = JSON.parse(stdinText) as PostToolUseHookEvent;
    const config = parseHookConfig(env.configJson);
    const sessionId = asString(raw.session_id);
    const stateFile = resolveStateFile(env, sessionId);
    const state = deserializeRuntimeState(io.readState(stateFile));
    const index = state.events.length;
    const event = postToolUseEventToGuardEvent(raw, index);
    const step = stepToolLoopGuardRuntime(state, event, config);
    io.writeState(stateFile, serializeRuntimeState(step.state));
    if (step.injection && step.injectedMessage) {
      if (env.logFile && io.appendLog) {
        io.appendLog(
          env.logFile,
          JSON.stringify({
            marker: TOOL_LOOP_GUARD_MARKER,
            turn: step.injection.turnIndex,
            trigger_type: step.injection.triggerType,
            signature: step.injection.signature,
            repeat_count: step.injection.repeatCount,
          }),
        );
      }
      return {
        stdout: renderHookStdout(step.injectedMessage),
        injected: true,
        signature: step.injection.signature,
        turn: step.injection.turnIndex,
      };
    }
    return { stdout: TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT, injected: false, signature: null, turn: null };
  } catch {
    return { stdout: TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT, injected: false, signature: null, turn: null };
  }
}

// ---------------------------------------------------------------------------
// Runtime-injection run metadata (additive; superset of the observe-mode meta)
// ---------------------------------------------------------------------------

export interface ToolLoopGuardRuntimeMeta {
  readonly tool_loop_guard_mode: ToolLoopGuardRuntimeMode;
  readonly tool_loop_guard_injected_messages: readonly string[];
  readonly tool_loop_guard_runtime_hook_available: boolean;
  readonly tool_loop_guard_runtime_hook_unavailable_reason: string | null;
}

// Build the runtime-specific metadata block. `result` is the canonical firing set
// (observe or runtime — they agree by construction). `hookAvailable` reflects
// whether the external adapter actually carries the runtime hook patch for this run.
export function toolLoopGuardRuntimeMeta(
  result: ToolLoopGuardResult,
  mode: ToolLoopGuardRuntimeMode,
  hookAvailable: boolean,
  unavailableReason: string | null = null,
): ToolLoopGuardRuntimeMeta {
  return {
    tool_loop_guard_mode: mode,
    tool_loop_guard_injected_messages: result.events.map((f) => f.message),
    tool_loop_guard_runtime_hook_available: hookAvailable,
    tool_loop_guard_runtime_hook_unavailable_reason: hookAvailable ? null : unavailableReason,
  };
}
