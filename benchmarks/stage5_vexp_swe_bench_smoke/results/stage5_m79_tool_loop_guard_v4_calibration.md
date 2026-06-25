# Stage 5 M79 Tool Loop Guard V4 Calibration

## Summary

- **V4 implemented?** Yes — as a first-class calibration of the shipped detector
  (`toolLoopGuard.ts`), not a post-hoc filter. `ToolLoopGuardConfig.calibration:
  "v0" | "v4"`.
- **Default behavior:** the guard remains **DEFAULT-OFF**. When it *is* enabled
  (`--tool-loop-guard-mode inject` / `--tool-loop-guard`), **V4 is the default
  calibration**. `--tool-loop-guard-calibration v0|v4` is an advanced A/B knob.
- **Trigger classes changed (now gated on prior progress):** `repeated_read`,
  `repeated_search`, `repeated_read_window`.
- **Trigger classes unchanged (still eligible from turn 0):**
  `repeated_failed_command`, `repeated_command_family_error`,
  `repeated_edit_failure`.
- **Offline replay result:** ALL expectations pass. cap/thrash recall **5/9 → 5/9**
  (unchanged); normal-control FP **3/71 → 2/71** (reduced); pytest-6197 suppressed;
  astropy-14598 + sympy-12419 preserved; django-16263 still no-fire; runtime
  observe/inject parity + determinism hold.
- **Recommendation:** **proceed to a small guarded live re-validation with V4**
  (still default-off; no default promotion, no C7, no multi-file detector).

## M78 Recap

- **pytest-6197:** the guard *plausibly contributed* but at **low confidence**. The
  earliest possible repeated-read fire was at idx 2, after **3 opening reads** of
  `python.py` with **no prior search/edit** — a pure-orientation fire. The
  search-led M73 run passed; live variance is a strong co-explanation. → the fire we
  want to **suppress**.
- **astropy-14598:** the guard **helped**. Injection came after 6 reads of
  `card.py`, the agent edited the gold `card.py`, the run finished at $1.62 instead
  of pinning the $3.00 cap. Searches preceded the reads → genuine prior progress. →
  the fire we want to **preserve**.
- **sympy-12419:** the guard **helped**, and the fire was a
  **`repeated_failed_command`**, not a read — it broke a failing-command loop, newly
  resolved, $3.00 → $1.54. → must stay eligible **without** any read-family gating.
- **django-16263:** **not a read-detector gap** — single-file edit/verify churn in
  `query.py`, a cost/no-convergence problem that belongs to a future C7 cost guard,
  not the read-loop detector. → must stay **no-fire**.
- **Why V4 was chosen (from the M78 sweep):** it suppresses the pytest-6197 early
  fire, suppresses 2 of 3 control false positives, preserves the astropy-14598 and
  sympy-12419 helpful fires, keeps full cap/thrash recall, and avoids the multi-file
  read-window false positive that V5–V7 introduced. V1 lost a recall unit; V2/V7
  killed the sympy win; V3 was equivalent to the current guard.

## Implementation

### Prior-progress definition (deterministic, from the tool-call event stream)

A read-family trigger at event *i* counts as having **prior progress** iff some
event at index `< i` is a progress action:

- `repeated_read` / `repeated_read_window`: a prior **edit** OR a prior **search**.
- `repeated_search` (signature *S*): a prior **edit** OR a prior **search whose
  signature differs from *S***. The repeating query's own first occurrence does
  **not** count as progress for itself — otherwise a bare repeated search could
  never be suppressed.

The progress state (`priorEdit`, `priorSearchSigs`) is advanced at the **end** of
each event's processing, so every trigger is gated on strictly-earlier progress.

**Documented approximation (conservative tie-break).** A non-read shell command
(category `other`, i.e. Bash) is **not** counted as progress. Bash is ambiguous — it
may be `cat`/`echo` (read-like) — and excluding it (a) matches the M78-validated V4
gate and (b) suppresses *more* pure-orientation fires, which is the conservative
choice the M79 protocol requests when the event model cannot cleanly distinguish a
case. The command-*failure* triggers are unaffected by this (they are never gated).

### Suppression rule

When V4 withholds a read-family trigger, the detector records a
`ToolLoopGuardSuppression` and returns **without touching the injector**: no
injection cap is consumed, no cooldown starts, and the signature is **not** marked
fired (so the same loop can still fire later if real progress arrives and it
recurs). A disabled guard records nothing (fully inert).

### Metadata fields

`toolLoopGuardMeta` now emits:

- `tool_loop_guard_calibration: "v4"`
- `tool_loop_guard_suppressed_events` — `[{turn, trigger_type, signature,
  repeat_count, reason}]`
- `tool_loop_guard_suppressed_count`
- `tool_loop_guard_suppression_reasons` — unique reasons

Suppressed read/search/window fires use reason
`no_prior_progress_for_read_search_window_trigger`. This lets us verify, e.g., that
pytest-6197 is suppressed at turn 2 *for the intended reason* (see Offline Replay).

### Runtime behavior

The runtime injector (`toolLoopGuardRuntime.ts`) re-runs the same pure detector over
the accumulated prefix, so it inherits V4 with no logic change. `parseHookConfig`
defaults the hook to V4 (overridable via `VTRACE_TOOL_LOOP_GUARD_CONFIG`).
Observe-mode and inject-mode fire at identical turns under V4 (verified below).

### Config / flag behavior

- Default-off preserved; `DEFAULT_TOOL_LOOP_GUARD_CONFIG.calibration = "v4"`.
- `--tool-loop-guard-mode inject` and `--tool-loop-guard` use V4.
- `--tool-loop-guard-calibration v0|v4` — advanced; does **not** enable the guard.
- The runner records the effective `tool_loop_guard_config` (incl. calibration) and
  passes calibration into the inject-mode hook env.

## Offline Replay

V0 vs V4 over the M71/M72 treatment cohort (99 captured streams) and the four named
M77 LIVE guarded streams, using the **shipped** detector run twice (not a post-hoc
filter). Gold labels are used only to label groups, never by the detector.

| Cohort group | V0 fires | V4 fires | Suppressed (V4) | Interpretation |
|---|---|---|---|---|
| cap_hit + thrashing_signal (recall) | 5/9 | 5/9 | — | **recall unchanged** |
| normal_resolved_control + treatment_only_win + baseline_only_loss (FP) | 3/71 | 2/71 | — | **FP reduced** |
| treatment_only_win | 0 fires | 0 fires | — | no regressions introduced |
| baseline_only_loss | 0 fires | 0 fires | — | no regressions introduced |
| total injections (all cohort) | 11 | 7 | 8 | V4 quieter; 8 early read-family fires withheld |

Deep-dive cases (M77 live streams):

| Case | V0 | V4 | Why |
|---|---|---|---|
| pytest-6197 | FIRE @2 (`repeated_read`) | **suppressed** @2 (reason `no_prior_progress_…`) | 3 opening reads, no prior search/edit |
| astropy-14598 | FIRE @13 | **FIRE @13** (`repeated_read`) | searches precede the card.py re-reads |
| sympy-12419 | FIRE @5 | **FIRE @5** (`repeated_failed_command`) | command-failure trigger, never gated |
| django-16263 | no-fire | **no-fire** | interleaved churn, no same-file read streak |

**M77 selected split.** The M77 live split injected on 3/10 (astropy-14598 @13,
pytest-6197 @2, sympy-12419 @5). Under V4 the split becomes **2/10**: the two
*helpful* fires (astropy-14598, sympy-12419) are preserved and the one *risky*
early read fire (pytest-6197) is suppressed — exactly the calibration intent.

**Discrepancy vs the M78 prediction (reported, not forced).** The M78 sweep modeled
V4 as a post-hoc filter over V0's firing list and predicted normal-control FP =
**1/71**. The shipped implementation yields **2/71**. The difference is a *more
faithful* behavior, not a regression: because a V4-suppressed read does not mark its
signature as fired, a loop that recurs **after** later genuine progress can fire at
the later turn, whereas the post-hoc model dropped that signature entirely. Both
satisfy the hard criterion (FP must not increase vs V0=3/71); V4 reduces it to 2/71.

## Tests

Added / updated (all passing):

- `toolLoopGuard.test.ts` — new `V4 calibration (M79)` block covering: read/search/
  window suppressed before prior progress (1–3); read/search firing after prior
  search/edit (4–6); command-failure / family-error / edit-failure remaining
  eligible with no prior progress (7–9); suppression-metadata reason (10);
  suppressed event consumes no injection cap (11) and starts no cooldown (12);
  default-off unchanged (16). Plus a `named M77/M78 case shapes` block with compact
  synthetic fixtures for pytest-6197 / astropy-14598 / sympy-12419 / django-16263
  (13–15 + django). Pre-existing pure-read mechanics tests were pinned to an explicit
  `ON_V0` config (calibration-independent machinery).
- `toolLoopGuardRuntime.test.ts` — V4 state-machine behavior (pure read loop injects
  nothing; same loop after a search injects), command-failure still injects under
  V4, `parseHookConfig` defaults to V4 + honors override, hook V4 default suppresses
  a pure read loop (17). Mechanics tests pinned to `ON_V0`.
- `run_stage5_vexp_swe_bench_smoke.test.ts` — `--tool-loop-guard-calibration`
  parsing: defaults to v4, override to v0 does not enable the guard, bad value
  rejected.

Verification: `bun test` (full suite) green; `bun run typecheck` +
`bun run typecheck:benchmarks` clean; `git diff --check` clean. Offline replay is
deterministic across reruns (18) and observe/inject parity holds for all named cases.

## Recommendation

**Proceed to a small guarded live re-validation with V4.** The offline evidence is
clean: recall preserved (5/9), false positives reduced (3→2 controls), the one risky
early read fire suppressed for the intended reason, both helpful fires preserved,
django-16263 untouched, and runtime parity/determinism confirmed. Keep the guard
**default-off** and **observe-eligible**; do **not** promote V4 to default behavior,
do **not** add the C7 cost guard or the multi-file read-window detector yet. The
live re-validation should confirm the pytest-6197 suppression and the preserved
astropy/sympy wins before any broader rollout.
