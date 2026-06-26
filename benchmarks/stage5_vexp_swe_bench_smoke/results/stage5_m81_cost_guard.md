# Stage 5 M81 Cost/No-Convergence Guard

## Summary

- **C7 implemented?** Yes — a default-off deterministic cost / no-convergence guard,
  SEPARATE from but compatible with the M75–M80 tool-loop guard.
- **Flag / mode names:** `--cost-guard` (enable, observe by default), `--cost-guard-mode
  observe|inject`, `--cost-guard-inject` (shorthand for inject). Default-off.
- **Default behavior:** unchanged. With no flag the guard never runs and emits no
  metadata; observe/inject are opt-in. `bun test`, both typechecks, and `git diff --check`
  are clean; the full suite is **3253 pass / 0 fail**.
- **Runtime integration point:** the M76 Claude Code `PostToolUse` `--settings` hook,
  reused verbatim. A single **combined** hook (`costGuardHook.ts`) owns the one PostToolUse
  registration when the cost guard injects; it also evaluates the tool-loop guard when that
  guard's state env is present, so the two coexist with at most one message per tool result.
- **Offline replay result:** over the frozen M80 V4 split (10 cases), C7 fires on **3/10** —
  the three high-cost / cap-hit / no-convergence runs (django-16263, django-12273,
  django-15503) — and is silent on all 7 protected wins and normal controls
  (**0 protected-win fires, 0 normal-control fires, 0 early-orientation fires**).
- **Recommendation:** **Proceed to small live validation with V4 + C7.** The detector is
  deterministic, default-off, gated against orientation, fires on the intended vector, and
  has zero offline false positives on protected/normal cohorts.

## M80 Recap

- **Why V4 is not enough.** M80 confirmed V4 is mechanically correct and should stay (it
  preserved the astropy-14598 useful read fire and the sympy-12419 command-loop win), but
  it only addresses **local** repeated-action loops. The dominant *remaining* unresolved
  vector is **global run risk**: edit/verify churn, high turn/tool count, cost drift toward
  the ~$3 per-task cap, and repeated patch attempts that never converge. A single late
  tool-loop advisory does not steer those to convergence.
- **django-16263.** 42 tool calls / 97 turns / $1.92, 3 edits, unresolved. No cap hit, V4
  fired once at turn 18 but the run still did not converge — textbook cost/no-convergence.
- **django-12273.** 41 tool calls / 103 turns / $3.03 (cap-hit), 7 edits, unresolved — a
  protected-win regression attributed in M80 to live variance / no-convergence rather than
  the V4 mechanism.
- **Cost/no-convergence vector.** edit-verify churn · high turn count · high cost drift ·
  repeated patch attempts without resolving · late single advisory insufficient to steer.

## Implementation

### Detector (`costGuard.ts`, PURE)

Consumes the normalized ordered tool-call event stream (shared shape with the tool-loop
guard) plus an optional **run-context** (`estimatedCostUsd`, `turnCount`) read back from the
result row in observe mode. No I/O, no clock, no randomness; deterministic and prefix-stable.

### Trigger types (6; names distinct from the tool-loop guard)

| trigger | kind | signal |
|---|---|---|
| `high_tool_count` | stream | tool-call count crossed the high threshold |
| `edit_verify_churn` | stream | ≥N edits to the **same** file |
| `no_patch_drift` | stream | many tool calls and **no** edit produced yet |
| `repeated_verification_no_progress` | stream | same verify-failure class **persists across edits** |
| `high_turn_count` | run-context | turn count crossed the high threshold (observe-only) |
| `cost_cap_approaching` | run-context | estimated cost ≥ fraction of the per-task cap (observe-only) |

The clean distinction from the tool-loop guard: the tool-loop guard fires when an action
**repeats without intervening progress** and *resets on an edit*; C7's
`repeated_verification_no_progress` fires when a failure class **persists despite edits** —
the deliberate complement, so the two never alias. The two run-context triggers are
attributed to the **last** event (end-of-run facts; turns/cost are run-level totals we
cannot know crossed earlier), after the positional stream triggers set `first_fire_turn`;
they are inert in the live runtime hook (no context there), so the stream triggers carry
production.

### Thresholds (conservative defaults; not fit to a single case)

```
minToolCallsBeforeFire: 25   minTurnsBeforeFire: 8
highToolCountThreshold: 35   highTurnCountThreshold: 90
editVerifyChurnThreshold: 3  noPatchToolThreshold: 30
repeatedVerifyThreshold: 3   costCapFraction: 0.85  defaultCostCapUsd: 3.0
maxInjections: 2             cooldownToolCalls: 8
```

The min-tool / min-turn **gate** holds every trigger until the run is demonstrably deep, so
normal early orientation can never fire. The thresholds are grounded in the M80 ground truth:
the no-convergence failures cluster at 40+ tools / 90+ turns / ~$3, while the protected win
sympy-12419 sits at 28 tools / 77 turns / $1.90 and the controls at ≤19 tools — so
`high_tool_count=35`, `high_turn_count=90`, `cost_cap=0.85×$3` separate them without fitting
any one case.

### Injected messages (stable marker `<VTRACE_COST_GUARD>`)

Three variants per the brief: general "approaching budget" (high tool/turn/cost), edit-verify
churn (churn + persistent-verify triggers), and no-patch drift.

### Guard priority with the tool-loop guard

`combineGuardInjections` implements the ordering rule: cost/no-convergence has priority near
budget; the tool-loop guard handles local loops; **if both fire on the same tool result, one
combined compact message** is emitted — the cost text leads with a one-line tool-loop tail —
never two separate messages. The combined hook (`costGuardHook.ts`) keeps each guard's state
in its own namespace (`_cost_guard_state/`, `_tool_loop_guard_state/`) so metadata and
triggers stay distinct.

### Metadata

Observe and inject both emit additive `cost_guard_*` fields: `cost_guard_enabled`,
`cost_guard_mode` (`observe_post_run` | `runtime_injection`), `cost_guard_injection_count`,
`cost_guard_events` (each with `turn_or_event_index`, `trigger_type`, `signature`, `reason`,
`tool_count`, `turn_count`, `read/search/edit/verify_count`, `patch_seen`,
`estimated_cost_if_available`), `cost_guard_injected_messages`, `cost_guard_signatures`,
`cost_guard_first/last_event_turn`, `cost_guard_suppressed_events`, `cost_guard_config`, plus
runtime fields `cost_guard_runtime_hook_available` / `_unavailable_reason` /
`cost_guard_coexists_with_tool_loop_guard`.

## Offline Replay

No agents, no Docker. `runCostGuard` replayed at the DEFAULT config over the frozen M80 V4
split (raw streams local-only; cost/turns joined from the tracked detail JSON). Full per-case
data in `stage5_m81_cost_guard_replay.json`.

| cohort | cases | C7 fired | early fire | late fire | resolved | cost | notes |
|---|---|---|---|---|---|---|---|
| high_cost_no_convergence (django-16263) | 1 | 1 | 1 | 0 | 0 | $1.92 | churn@28 + high_tool@35; the headline target |
| cap_hit_high_cost_resolved (django-15503) | 1 | 1 | 1 | 0 | 1 | $3.01 | churn@27 + high_tool@35; resolved anyway, mid-run nudge harmless |
| protected_win_high_cost (django-12273) | 1 | 1 | 0 | 1 | 0 | $3.03 | high_tool@34 of 41 — **late**; see below |
| protected_win_command_loop (sympy-12419) | 1 | 0 | – | – | 1 | $1.90 | **silent** — preserves the useful command-loop win |
| treatment_only_win_low_cost (django-11815) | 1 | 0 | – | – | 1 | $0.41 | silent — protected low-cost win |
| cap_hit_cluster (astropy-14598) | 1 | 0 | – | – | 0 | $1.61 | silent (19 tools < gate); V4 owns it |
| cap_hit_cluster_not_fired (pylint-4551) | 1 | 0 | – | – | 0 | $0.91 | silent (12 tools) |
| normal_control_low_cost (pytest-6197, astropy-7166, django-10880) | 3 | 0 | – | – | 2 | ≤$0.64 | silent (≤15 tools); pytest-6197 has **no** early V0-style read fire |

Totals: **fired 3/10, not-fired 7/10, 0 protected-win/command-loop fires, 0 normal-control
fires, 0 early-orientation fires.**

Specific M80 expectations (all met):

- **django-16263** — detected as cost/no-convergence (`edit_verify_churn`@28 + `high_tool_count`@35). ✓
- **django-12273** — fires via `high_tool_count` at tool 34 of 41 (`late_fire=True`); its
  earlier same-file churn (max 5 edits) was correctly **gate-suppressed** as exploration.
  Assessment: **likely too late to fully prevent the cap burn, but could still force a final
  convergence**; a marginal-but-not-harmful nudge on an already-unresolved cap-hit run.
- **pytest-6197** — silent (15 tools < the 25 gate): does **not** recreate the early V0
  read-fire problem. ✓
- **astropy-14598** — silent (19 tools); V4 already addressed it, no need to force C7. ✓
- **sympy-12419** — silent: C7 does **not** suppress the useful command-loop pathway
  (28 tools < 35, 77 turns < 90, $1.90 < $2.55, 1 edit, patch produced). ✓

## Tests

New: `costGuard.test.ts` (16) + `costGuardRuntime.test.ts` (12) = **28 tests**, all passing.
Coverage maps to the M81 required list: default-off; observe/inject metadata vs injection;
high-tool-count gate; edit-verify churn; no-patch drift; persistent-verify; low-cost control
silent; early-orientation suppressed; max-injection cap; cooldown; once-per-signature;
metadata detail; cost+tool-loop coexistence; combined/prioritized message; runtime marker
`<VTRACE_COST_GUARD>`; deterministic replay. Updated three full-`CliConfig` builders
(`run_stage5_vexp_swe_bench_smoke.test.ts`, `run_stage5_live_capsule_precheck.ts`, and the
runner default) for the two new fields. Verification: `bun test` 3253 pass / 0 fail,
`bun run typecheck`, `bun run typecheck:benchmarks`, `git diff --check` all clean. No
retrieval/scoring/ranking/Capsule-v2/decision-contract code touched (no retrieval eval
required).

## Recommendation

**Proceed to small live validation with V4 + C7.** C7 is default-off, deterministic, gated
against orientation, fires on the intended high-cost/no-convergence vector, has zero offline
false positives on protected wins and normal controls, coexists with V4 via a single
prioritized combined hook, and ships with 28 passing tests. The one caveat to watch live is
**timing on cap-hit runs** (django-12273 fires late) — live validation should confirm whether
the mid-run nudge changes convergence or merely lands too late; thresholds can be revisited
from that evidence before any promotion. C7 remains default-off and no guard is promoted.
