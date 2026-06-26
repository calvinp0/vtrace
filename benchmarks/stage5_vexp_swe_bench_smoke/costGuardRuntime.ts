// M81 runtime injection hook for the C7 cost / no-convergence guard, and the COMBINED
// hook that lets C7 coexist with the M76 V4 tool-loop guard without message spam.
//
// Like the tool-loop guard, the external vexp-swe-bench adapter spawns `claude -p` as a
// single-shot headless process, so the only mid-loop injection point is Claude Code's own
// PostToolUse `--settings` hook (each tool result -> hook process -> injected text into
// the model's next turn via `hookSpecificOutput.additionalContext`). M81 reuses that exact
// M76 infrastructure (event normalization, --settings registration, fail-closed hook body).
//
// Two guards, one hook. When BOTH guards run in inject mode we register a SINGLE combined
// hook process (not two PostToolUse hooks) so at most ONE recovery message is injected per
// tool result. The priority rule (M81 brief): the cost/no-convergence guard owns the
// near-budget decision and takes priority; the tool-loop guard owns local repeated-action
// loops. If both fire on the same tool result we emit ONE combined compact message led by
// the cost-guard text with a one-line tool-loop tail (never two separate messages).
//
// This module is PURE / deterministic (no I/O, no clock, no randomness). It reuses the M75
// batch detector (`runCostGuard`) as the single source of truth: `stepCostGuardRuntime`
// appends one event and RE-RUNS `runCostGuard` over the accumulated prefix; because every
// firing depends only on events at index <= its trigger index, firings are PREFIX-STABLE,
// so the runtime injector fires at EXACTLY the same turns as observe mode. It changes NO
// retrieval, NO Capsule v2 ranking, NO digest decision contract, NO pivot-confidence gate,
// and NO tool-loop guard behavior; it is reachable only when the harness explicitly enables
// cost-guard injection (default-off).

import {
  runCostGuard,
  DEFAULT_COST_GUARD_CONFIG,
  COST_GUARD_MARKER,
  type CostGuardEvent,
  type CostGuardConfig,
  type CostGuardFiring,
  type CostGuardResult,
} from "./costGuard";
import {
  TOOL_LOOP_GUARD_MARKER,
  type ToolLoopGuardConfig,
  type ToolLoopGuardFiring,
} from "./toolLoopGuard";
import {
  postToolUseEventToGuardEvent,
  renderHookStdout,
  TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT,
  parseHookConfig as parseToolLoopHookConfig,
  deserializeRuntimeState as deserializeToolLoopState,
  serializeRuntimeState as serializeToolLoopState,
  stepToolLoopGuardRuntime,
  type PostToolUseHookEvent,
  type ToolLoopGuardHookIo,
} from "./toolLoopGuardRuntime";

// Stable mode tokens recorded in run metadata (mirrors CostGuardMode in costGuard.ts).
export const COST_GUARD_OBSERVE_MODE = "observe_post_run" as const;
export const COST_GUARD_RUNTIME_MODE = "runtime_injection" as const;

// The inert PostToolUse payload (no additionalContext) — shared with the tool-loop guard.
export const COST_GUARD_HOOK_NOOP_STDOUT = TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT;

// ---------------------------------------------------------------------------
// Incremental state machine (wraps the PURE batch detector)
// ---------------------------------------------------------------------------

export interface CostGuardRuntimeState {
  readonly events: readonly CostGuardEvent[];
  readonly injectedSignatures: readonly string[];
}

export function initCostGuardState(): CostGuardRuntimeState {
  return { events: [], injectedSignatures: [] };
}

export interface CostGuardRuntimeStep {
  readonly state: CostGuardRuntimeState;
  readonly injection: CostGuardFiring | null;
  readonly injectedMessage: string | null;
  readonly firingsThisStep: readonly CostGuardFiring[];
}

// Append one event, recompute the canonical firing set over the whole prefix, and surface
// any firing the prefix did not already contain. Deterministic. When disabled it is a pure
// accumulate-only no-op. The live runtime has no run-context (cost / turns are run-level
// aggregates not visible per tool result), so only the stream-proxy triggers can fire here;
// observe mode supplies the context and may additionally surface cost/turn triggers.
export function stepCostGuardRuntime(
  state: CostGuardRuntimeState,
  event: CostGuardEvent,
  config: CostGuardConfig = DEFAULT_COST_GUARD_CONFIG,
): CostGuardRuntimeStep {
  const events = [...state.events, event];
  if (!config.enabled) {
    return {
      state: { events, injectedSignatures: state.injectedSignatures },
      injection: null,
      injectedMessage: null,
      firingsThisStep: [],
    };
  }
  const result = runCostGuard(events, config);
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

export function costGuardRuntimeResult(
  state: CostGuardRuntimeState,
  config: CostGuardConfig = DEFAULT_COST_GUARD_CONFIG,
): CostGuardResult {
  return runCostGuard(state.events, { ...config, enabled: true });
}

export function serializeCostGuardState(state: CostGuardRuntimeState): string {
  return JSON.stringify({ events: state.events, injectedSignatures: state.injectedSignatures });
}

export function deserializeCostGuardState(text: string | null | undefined): CostGuardRuntimeState {
  if (!text) return initCostGuardState();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return initCostGuardState();
    const obj = parsed as Record<string, unknown>;
    const events = Array.isArray(obj.events) ? (obj.events as CostGuardEvent[]) : [];
    const injectedSignatures = Array.isArray(obj.injectedSignatures)
      ? (obj.injectedSignatures as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    return { events, injectedSignatures };
  } catch {
    return initCostGuardState();
  }
}

export function parseCostGuardHookConfig(configJson: string | undefined): CostGuardConfig {
  const base = { ...DEFAULT_COST_GUARD_CONFIG, enabled: true };
  if (!configJson) return base;
  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) return base;
    return { ...base, ...(parsed as Partial<CostGuardConfig>), enabled: true };
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------------------
// Guard priority / combination (pure)
// ---------------------------------------------------------------------------

export type CombinedGuardSource = "cost" | "tool_loop" | "combined" | null;

export interface CombinedGuardDecision {
  readonly source: CombinedGuardSource;
  readonly message: string | null;
}

// Compact one-line tail summarising the tool-loop firing, appended to the cost message
// when BOTH fire on the same tool result so the model still hears the local-loop signal.
function toolLoopTail(firing: ToolLoopGuardFiring): string {
  return `${TOOL_LOOP_GUARD_MARKER} also: a local ${firing.triggerType} loop (x${firing.repeatCount}) is active — break it as part of converging.`;
}

// The M81 ordering rule. Cost/no-convergence has priority near budget; the tool-loop guard
// handles local loops; if BOTH fire we emit ONE combined message led by the cost text.
export function combineGuardInjections(
  costInjection: CostGuardFiring | null,
  toolLoopInjection: ToolLoopGuardFiring | null,
): CombinedGuardDecision {
  if (costInjection && toolLoopInjection) {
    return { source: "combined", message: `${costInjection.message}\n${toolLoopTail(toolLoopInjection)}` };
  }
  if (costInjection) return { source: "cost", message: costInjection.message };
  if (toolLoopInjection) return { source: "tool_loop", message: toolLoopInjection.message };
  return { source: null, message: null };
}

// ---------------------------------------------------------------------------
// Hook body (fail-closed). Pure w.r.t. injected I/O so it is unit-testable without a live
// agent: the executable wrapper (costGuardHook.ts) supplies real fs/stdin/env.
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export interface CostGuardHookEnv {
  // Cost-guard state file/dir + optional JSON config override + optional injection log.
  readonly stateFile?: string;
  readonly stateDir?: string;
  readonly configJson?: string;
  readonly logFile?: string;
  readonly sessionId?: string;
  // When present, the combined hook ALSO evaluates the tool-loop guard (coexistence).
  // Absent -> cost-guard-only hook.
  readonly toolLoopStateFile?: string;
  readonly toolLoopStateDir?: string;
  readonly toolLoopConfigJson?: string;
  readonly toolLoopLogFile?: string;
}

function resolveStateFile(
  explicit: string | undefined,
  dir: string | undefined,
  prefix: string,
  sessionId: string | null,
  fallbackSession: string | undefined,
): string {
  if (explicit) return explicit;
  const d = dir ?? ".";
  const sid = (sessionId ?? fallbackSession ?? "session").replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${d.replace(/\/+$/, "")}/${prefix}_${sid}.json`;
}

export interface CostGuardHookResult {
  readonly stdout: string;
  readonly injected: boolean;
  readonly source: CombinedGuardSource;
  readonly signature: string | null;
  readonly turn: number | null;
}

// The complete combined hook body: parse -> normalize -> step BOTH guards -> persist ->
// render the single prioritized payload. Catches everything and FAILS CLOSED — on any
// error it injects nothing and emits the inert no-op payload. The tool-loop guard is
// evaluated only when its env is present (coexistence mode); otherwise this is the
// cost-guard-only hook.
export function runCostGuardHook(stdinText: string, env: CostGuardHookEnv, io: ToolLoopGuardHookIo): CostGuardHookResult {
  try {
    const raw = JSON.parse(stdinText) as PostToolUseHookEvent;
    const sessionId = asString(raw.session_id);

    // --- cost guard step ---
    const costConfig = parseCostGuardHookConfig(env.configJson);
    const costStateFile = resolveStateFile(env.stateFile, env.stateDir, "cost_guard", sessionId, env.sessionId);
    const costState = deserializeCostGuardState(io.readState(costStateFile));
    const costEvent = postToolUseEventToGuardEvent(raw, costState.events.length);
    const costStep = stepCostGuardRuntime(costState, costEvent, costConfig);
    io.writeState(costStateFile, serializeCostGuardState(costStep.state));

    // --- tool-loop guard step (only when its env is present: coexistence) ---
    let toolLoopInjection: ToolLoopGuardFiring | null = null;
    const toolLoopEnabled = env.toolLoopStateFile !== undefined || env.toolLoopStateDir !== undefined;
    if (toolLoopEnabled) {
      const tlConfig: ToolLoopGuardConfig = parseToolLoopHookConfig(env.toolLoopConfigJson);
      const tlStateFile = resolveStateFile(env.toolLoopStateFile, env.toolLoopStateDir, "tool_loop_guard", sessionId, env.sessionId);
      const tlState = deserializeToolLoopState(io.readState(tlStateFile));
      const tlEvent = postToolUseEventToGuardEvent(raw, tlState.events.length);
      const tlStep = stepToolLoopGuardRuntime(tlState, tlEvent, tlConfig);
      io.writeState(tlStateFile, serializeToolLoopState(tlStep.state));
      toolLoopInjection = tlStep.injection;
    }

    const decision = combineGuardInjections(costStep.injection, toolLoopInjection);
    if (decision.message) {
      if (env.logFile && io.appendLog) {
        io.appendLog(
          env.logFile,
          JSON.stringify({
            marker: COST_GUARD_MARKER,
            source: decision.source,
            cost_turn: costStep.injection?.turnIndex ?? null,
            cost_trigger: costStep.injection?.triggerType ?? null,
            cost_signature: costStep.injection?.signature ?? null,
            tool_loop_trigger: toolLoopInjection?.triggerType ?? null,
            tool_loop_signature: toolLoopInjection?.signature ?? null,
          }),
        );
      }
      return {
        stdout: renderHookStdout(decision.message),
        injected: true,
        source: decision.source,
        signature: costStep.injection?.signature ?? toolLoopInjection?.signature ?? null,
        turn: costStep.injection?.turnIndex ?? toolLoopInjection?.turnIndex ?? null,
      };
    }
    return { stdout: COST_GUARD_HOOK_NOOP_STDOUT, injected: false, source: null, signature: null, turn: null };
  } catch {
    return { stdout: COST_GUARD_HOOK_NOOP_STDOUT, injected: false, source: null, signature: null, turn: null };
  }
}

// ---------------------------------------------------------------------------
// Runtime-injection run metadata (additive; superset of the observe-mode meta)
// ---------------------------------------------------------------------------

export interface CostGuardRuntimeMeta {
  readonly cost_guard_runtime_hook_available: boolean;
  readonly cost_guard_runtime_hook_unavailable_reason: string | null;
  readonly cost_guard_coexists_with_tool_loop_guard: boolean;
}

export function costGuardRuntimeMeta(
  hookAvailable: boolean,
  coexistsWithToolLoopGuard: boolean,
  unavailableReason: string | null = null,
): CostGuardRuntimeMeta {
  return {
    cost_guard_runtime_hook_available: hookAvailable,
    cost_guard_runtime_hook_unavailable_reason: hookAvailable ? null : unavailableReason,
    cost_guard_coexists_with_tool_loop_guard: coexistsWithToolLoopGuard,
  };
}
