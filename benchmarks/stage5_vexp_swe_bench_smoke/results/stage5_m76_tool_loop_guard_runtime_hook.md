# Stage 5 M76 Tool Loop Guard Runtime Hook

## Summary

- **Runtime hook implemented?** Yes. The M75 tool-loop guard can now affect live
  agent behavior via a Claude Code `PostToolUse` hook, wired through a tracked,
  idempotent, fail-closed adapter patch block. Implementation + offline/unit
  validation only — **no live agents, no Docker, no API spend** in this milestone.
- **Flag / mode names:**
  - `--tool-loop-guard` — enable the guard (M75 back-compat; stays **observe**).
  - `--tool-loop-guard-mode observe|inject` — explicit mode select; any value
    implies the guard is enabled.
  - `--tool-loop-guard-inject` — shorthand for `--tool-loop-guard-mode inject`.
  - Config: `toolLoopGuardMode: "observe" | "inject"` (default `"observe"`).
- **Default behavior:** unchanged. With no flag the guard is OFF and the run is
  byte-identical to before M76 (no env, no settings file, no `--settings`, no
  metadata). Verified by `--tool-loop-guard` default-off / mode-default tests.
- **Observe mode status:** preserved. `--tool-loop-guard` (or `…-mode observe`)
  still runs the M75 post-run detector and records `tool_loop_guard_*` metadata
  with `tool_loop_guard_mode: "observe_post_run"`. No injection occurs.
- **Injection mode status:** implemented and explicit-only. `…-mode inject`
  registers the runtime PostToolUse hook so the deterministic detector injects a
  compact `<VTRACE_TOOL_LOOP_GUARD>` recovery message into the live agent's next
  turn, respecting caps / cooldown / once-per-signature.
- **Adapter patch status:** a fifth optional patch block
  (`STAGE5_TOOL_LOOP_GUARD_HOOK_PATCH`) is generated into the external Claude Code
  adapter at install/migrate time. It pushes `--settings <file>` only when the env
  var is set **and** the settings file exists (fail-closed). It is idempotent and
  is **skipped** if its anchor (the tool-whitelist line) is absent — no brittle
  best-effort code. The external repo is never permanently edited (the existing
  install/backup/migrate machinery owns that, and only patches `dist/` locally).
- **Offline simulation result:** **PASS.** Replaying all 99 captured M71/M72/M73
  treatment streams event-by-event through the runtime injector reproduces the M75
  observe-mode firing list **exactly** (99/99 timing match) and is **deterministic**
  across reruns (99/99). Per-turn injection counts match observe per group:
  cap_hit 3/6, thrashing 2/3 (= 5/9 thrash-or-cap), normal controls 3/54,
  other-unresolved 1/18, treatment-only wins 0/10, baseline-only losses 0/7.
- **Recommendation:** **proceed to a small live validation with runtime injection
  enabled** (the hook point is officially supported and the offline behavior is
  deterministic + matches M75), gated behind the explicit `--tool-loop-guard-mode
  inject` flag and a tiny instance set.

## M75 Recap

- **Detector result:** the PURE deterministic detector (`runToolLoopGuard`) over
  the captured treatment streams would fire on **5/9** M74 cap-hit + thrashing
  cases, **0/10** treatment-only wins, **0/7** baseline-only losses, and only
  **3/54** normal controls. Verdict: PASS as an observe-mode detector.
- **Observe-mode limitation (M75 y9j5di):** the external `vexp-swe-bench` adapter
  spawns `claude -p … --output-format stream-json` as a **single-shot headless
  process**. The agent's entire turn loop runs *inside* that subprocess; the
  adapter only monitors the stream for cost and reads back `rawOutput` after the
  process exits. There is no place in the adapter to feed a message back between
  turns, so M75 could only compute guard metadata *after* the run.
- **Why a runtime hook is needed before live validation:** to show the guard can
  actually change agent behavior (break a cost-cap thrash loop), the recovery
  message has to reach the model *mid-loop*. That requires a real in-loop hook
  point, which the adapter alone cannot provide.

## Implementation

### Hook point

The real mid-loop hook point is **Claude Code's own hook system**, not the adapter.
`claude -p` honors a `--settings` file (when run *without* `--bare`) that registers
a `PostToolUse` command hook. A `PostToolUse` hook receives the tool event JSON
(`tool_name`, `tool_input`, `tool_output`) on stdin and can inject text into the
model's next turn via:

```json
{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "<recovery message>" } }
```

So the runtime path is: each tool result → a PostToolUse hook process → the
deterministic detector → (maybe) an injected `additionalContext` message.

### State machine

`toolLoopGuardRuntime.ts` is PURE and reuses the M75 batch detector as the single
source of truth. `stepToolLoopGuardRuntime(state, event, config)` appends one event
and **re-runs `runToolLoopGuard` over the accumulated prefix**. Because every firing
depends only on events at index ≤ its trigger index, firings are **prefix-stable**:
the firing list over a growing prefix only grows, never reorders. Therefore the
runtime injector fires at *exactly* the same turns as observe mode, by construction.
Under the production config (cooldown ≥ 1) the detector self-suppresses any
co-firing signal at an already-injected index, so the runtime delivers **at most one
message per tool result**.

Hooks run as separate processes, so state is serialized to a session-keyed file
between invocations (`serializeRuntimeState` / `deserializeRuntimeState`).

### Injected message

The compact, action-forcing recovery messages are the M75 renderings, each carrying
the stable marker `<VTRACE_TOOL_LOOP_GUARD>` (read/search loops get the
"stop re-reading, state the hypothesis, inspect/edit elsewhere" variant; failed
commands get the "do not retry unchanged, summarize the failure, make the smallest
testable progress move" variant).

### Metadata

Guarded runs record (additive; default runs emit none):

```
tool_loop_guard_enabled
tool_loop_guard_mode: "observe_post_run" | "runtime_injection"
tool_loop_guard_injection_count
tool_loop_guard_events
tool_loop_guard_injected_messages
tool_loop_guard_signatures
tool_loop_guard_first_event_turn
tool_loop_guard_last_event_turn
tool_loop_guard_runtime_hook_available            (inject mode)
tool_loop_guard_runtime_hook_unavailable_reason   (inject mode, when unavailable)
```

In inject mode, `tool_loop_guard_runtime_hook_available` is true only when the
external adapter actually carries the M76 hook patch; otherwise it records a
fail-closed reason (e.g. adapter not located / patch absent).

### Caps / cooldowns

Unchanged from M75: `maxInjections` (default 3), `cooldownToolCalls` (default 3),
per-signature warn-once. These are enforced inside the shared pure detector, so
observe and runtime obey identical limits.

### Fail-closed behavior

- The hook body (`runToolLoopGuardHook`) catches everything and emits the inert
  no-op payload on any error — a malformed event or corrupt state file can never
  steer or crash the agent. The executable wrapper always exits 0.
- The adapter patch block adds `--settings` only when the env var is set **and**
  `existsSync(settingsFile)` — a missing file logs a skip and the run proceeds with
  no hook.
- The patch block is skipped entirely when its anchor is absent, and the inject-mode
  metadata records the hook as unavailable. No best-effort guessing.

### External adapter patch details

`buildToolLoopGuardHookPatchBlock()` emits the fifth block, inserted after the
tool-whitelist anchor (same anchor as the Phase-1 disallowed-tools block, since both
push onto the assembled `args` array). It is wired into `applyVtracePatch` as an
OPTIONAL block (own marker, migrated independently), surfaced in `verify-vtrace-patch`
notes, and migrated by `migrateOptionalPatchesIfMissing`. The settings file the
adapter reads is written by the harness (in inject mode only) to the results root,
where `vexp`'s `--output` clean cannot delete it; its PostToolUse command is
`bun <toolLoopGuardHook.ts>`. A clean per-run state dir is created each run so prior
events cannot leak in.

## Offline Simulation

99 captured M71/M72/M73 treatment streams replayed event-by-event through the
runtime injector vs the M75 observe-mode batch detector. No agents, no Docker.

| group                   | cases | observe events (M75) | simulated runtime injections | caps/cooldown behavior | deterministic? |
|-------------------------|------:|---------------------:|-----------------------------:|------------------------|----------------|
| cap_hit                 |     6 |                    3 |                            3 | respected (≤3/run)     | 6/6            |
| thrashing_signal        |     3 |                    2 |                            2 | respected              | 3/3            |
| treatment_only_win      |    10 |                    0 |                            0 | n/a                    | 10/10          |
| baseline_only_loss      |     7 |                    0 |                            0 | n/a                    | 7/7            |
| no_patch_exhaustion     |     1 |                    0 |                            0 | n/a                    | 1/1            |
| normal_resolved_control |    54 |                    3 |                            3 | respected              | 54/54          |
| other_unresolved        |    18 |                    1 |                            1 | respected              | 18/18          |
| **total**               |  **99** |                **9** |                        **9** | —                      | **99/99**      |

- **Timing parity:** 99/99 cases — the runtime injector's per-turn injections match
  the observe firing list exactly (turn index, trigger type, signature).
- **Determinism:** 99/99 cases identical across two independent reruns.
- **No difference to explain:** the runtime path reproduces the M75 5/9
  thrash-or-cap detection and the 3/54 control rate exactly, because both modes
  consume the same pure detector over the same stream.

## Tests

Added `toolLoopGuardRuntime.test.ts` (30 tests) and extended
`run_stage5_vexp_swe_bench_smoke.test.ts`:

1. default-off behavior unchanged (mode default `observe`; injection inactive).
2. observe mode remains available and is the bare-`--tool-loop-guard` default.
3. injection mode parsed/wired explicitly (`…-mode inject`, shorthand, invalid rejected).
4. runtime state machine injects exactly one message for a repeated failed command.
5. runtime state machine injects exactly one message for a repeated read / search loop.
6. cooldown suppresses an immediate repeated injection.
7. max-injection cap respected.
8. same signature warned once.
9. progress event (intervening edit / new search) resets the repeated-read streak.
10. injected message contains `<VTRACE_TOOL_LOOP_GUARD>`.
11. metadata includes the injected-message list + hook availability + reason.
12. generated external-harness hook patch is idempotent, anchored, and marker-bearing.
13. fail-closed: missing anchor → block skipped; malformed stdin → inert no-op payload.
14. no injection occurs unless injection mode is explicitly enabled.
15. offline simulation deterministic across reruns (timing parity + determinism).

Plus an end-to-end test that pipes events through the real `bun toolLoopGuardHook.ts`
executable (no agents) and asserts the second repeat emits `additionalContext`.

**Verification result:** `bun run typecheck`, `bun run typecheck:benchmarks`,
`bun test` (3203 pass / 0 fail), and `git diff --check` all clean. Retrieval evals
not required (no retrieval / scoring / ranking / Capsule v2 / decision-contract code
touched).

## Recommendation

**Proceed to a small live validation with runtime injection enabled.** The hook
point (`PostToolUse` + `additionalContext` in headless `claude -p`) is officially
supported; the runtime injector is deterministic and reproduces M75 observe-mode
timing exactly; and every path is default-off, explicit-opt-in, and fail-closed.
A minimal live check (a handful of the M74 cap-hit / thrash instances under
`--tool-loop-guard-mode inject`) is the right next step to confirm the injected
message actually breaks the loop and reduces cost — that step requires explicit
approval and API spend and is out of scope for M76.
