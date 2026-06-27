# Stage 5 M85 V4 + C7_D Live Validation

Combined **V4 tool-loop guard** + **C7_D cost/no-convergence guard** (`editVerifyChurnThreshold` 3→2,
25-tool gate unchanged), both **runtime-inject**, over the frozen 10-case M85 split (identical
membership to M82/M80/M77). Mechanism-validation slice — **NOT** a 100-task benchmark, **NOT** a
default promotion, **NOT** a VEXP/SWE-bench external claim. Both guards remain **DEFAULT-OFF**.

## Summary

- **Selected cases:** 10 (A=4, B=2, C=2, D=2) — frozen, no replacements.
- **New live runs:** 10 treatment runs (V4 + C7_D inject). **0 operational retries, 0 provider aborts.**
- **Docker evals:** 10 (all produced patches; `rc=0`).
- **Valid runs:** **10 / 10** (all guard + contract + calibration metadata present and correct).
- **V4 injections:** 2 runs (`django-15503` @29 `repeated_read`, `django-16263` @22 `repeated_read`); 0 suppressed.
- **C7_D injections:** 2 runs (`django-15503` ×1 @34 `edit_verify_churn`; `django-16263` ×2 @24 then @34 `edit_verify_churn`+`high_tool_count`).
- **Combined-guard behavior:** combined hook coexists on all runs; V4 and C7_D never collided on the same turn (`same_turn_total=0`); every injected message carried its sentinel marker.
- **Resolution:** **M85 7/10** vs M82 4/10, M80 5/10, M73 5/10.
- **Cost:** **M85 total $12.62** vs M82 $15.01 (split-slice sum).
- **Headline:** C7_D first-fire on `django-16263` moved **34 → 24** (−10 turns), exactly matching the M84 replay prediction. It is the one M82 C7-fired case whose churn pattern **recurred** live.
- **Verdict:** **MIXED** (mechanism + timing + safety validated; efficacy inconclusive — see below).
- **Recommendation:** **Proceed to a larger guarded validation with V4 + C7_D**, keeping both guards default-off.

## M84 Sanity Check

Inspected `stage5_m84_c7d_calibration.json`, `stage5_m84_c7d_replay.json`, and the M84 report
before any live run. All consistent:

- C7_D is **default-off**, a first-class calibration; `--cost-guard-calibration v0|c7d` exists;
  metadata field `cost_guard_calibration`.
- The calibration changes **only** `editVerifyChurnThreshold` (3→2); the 25-tool gate
  (`minToolCallsBeforeFire=25`) and every other threshold are unchanged.
- Replay first-fire by calibration: `django-16263` 34→**24**; `django-12273` 31→31; `sympy-12419` 34→34;
  `django-15503` and `pytest-6197` silent under both. Early fires both zero; control fires both zero;
  protected-early fires both zero. Broad 563-stream corpus delta +3 (all late, none early).
- Replay is offline/deterministic (no agents, no Docker, no spend). **No material contradiction** with
  the M84 report → safe to continue. (No prose typos requiring correction.)

The M85 preflight additionally re-asserted the calibration is correctly *constructed*:
`costGuardConfigForCalibration("c7d")` ⇒ `editVerifyChurnThreshold=2`, `minToolCallsBeforeFire=25`
(v0 keeps 3), and every live `_run.meta.json` carries `cost_guard_calibration=c7d` +
`cost_guard_config.editVerifyChurnThreshold=2`.

## Split

Frozen 10-case membership, identical to M82/M80/M77. Built deterministically by `build_m85_split.ts`
from `stage5_m82_v4_c7_live_split.json` (M73/M80 priors) + `stage5_m82_v4_c7_live_validation.detail.json`
(actual M82 V4+C7_V0 outcomes) + `stage5_m84_c7d_replay.json` (offline C7_D expectation). No case
added/dropped/reordered after seeing live results.

| Group | Instance | M73 res | M80 res | M82 res | M82 C7_V0 fire | M84 expected C7_D fire |
|---|---|:--:|:--:|:--:|---|---|
| A | astropy-14598 | ✗ | ✗ | ✗ | — | — |
| A | django-15503 | ✗ | ✓ | ✗ | — | — |
| A | django-16263 | ✗ | ✗ | ✗ | @34 high_tool | **@24** churn+high_tool |
| A | pytest-6197 | ✓ | ✗ | ✗ | — | — |
| B | pylint-4551 | ✗ | ✗ | ✗ | — | — |
| B | sympy-12419 | ✗ | ✓ | ✓ | @34 high_tool | @34 high_tool |
| C | django-11815 | ✓ | ✓ | ✓ | — | — |
| C | django-12273 | ✓ | ✗ | ✗ | @31 churn | @31 churn |
| D | astropy-7166 | ✓ | ✓ | ✓ | — | — |
| D | django-10880 | ✓ | ✓ | ✓ | — | — |

M82 actually fired C7_V0 on `{django-16263, sympy-12419, django-12273}`; M84 expects C7_D on the same
three, with only `django-16263` expected **earlier**.

## Pre-flight

No-agent gate-on render preflight (`run_stage5_m85_preflight.ts`) → `stage5_m85_v4_c7d_preflight.json`:

- **Valid:** 10/10 (`path=reuse` for all — no clones). 0 partial sentinel, 0 required IMPACT.
- **Hook:** combined PostToolUse hook available (`combined_hook_available=true`); tool-loop + cost
  guard `--settings` both constructible.
- **V4 configured:** inject mode, calibration v4 on all cases.
- **C7_D configured:** inject mode, calibration c7d on all cases; `c7d_correct=true` (churn=2, gate=25).
- **Treatment validity:** digest START/END ×1, decision-contract START/END ×1, bounded structured
  grammar or explicit zero-required marker, compact mode applied, confidence gate enabled — identical
  per-case shape to M82 (neither guard perturbs context). `gate_passes=true`.

External hook patch was already installed and verified by the seam probe (left installed; not re-patched).

## Run Matrix

| Instance | Grp | M73 | M80 | M82 | **M85** | valid | V4 | C7_D | 1st guard turn | cost (M85) | Δcost vs M82 | tools | turns |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|--:|--:|--:|--:|
| astropy-14598 | A | ✗ | ✗ | ✗ | ✗ | ✓ | — | — | — | 1.428 | −0.098 | 22 | 53 |
| django-15503 | A | ✗ | ✓ | ✗ | **✓** | ✓ | @29 | @34 | 29 | 3.001 | +2.514 | 37 | 95 |
| django-16263 | A | ✗ | ✗ | ✗ | ✗ | ✓ | @22 | **@24** | 22 | 3.014 | −0.029 | 35 | 89 |
| pytest-6197 | A | ✓ | ✗ | ✗ | **✓** | ✓ | — | — | — | 0.975 | +0.028 | 14 | 36 |
| pylint-4551 | B | ✗ | ✗ | ✗ | ✗ | ✓ | — | — | — | 1.013 | −0.603 | 17 | 49 |
| sympy-12419 | B | ✗ | ✓ | ✓ | **✓** | ✓ | — | — | — | 0.809 | −2.239 | 17 | 43 |
| django-11815 | C | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | 0.508 | +0.176 | 9 | 26 |
| django-12273 | C | ✓ | ✗ | ✗ | **✓** | ✓ | — | — | — | 0.751 | −2.258 | 10 | 29 |
| astropy-7166 | D | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | 0.647 | +0.001 | 13 | 40 |
| django-10880 | D | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | 0.470 | +0.118 | 10 | 27 |

**Resolved (M85):** django-15503, pytest-6197, sympy-12419, django-11815, django-12273, astropy-7166,
django-10880 = **7/10**. **Unresolved:** astropy-14598, django-16263, pylint-4551.

## Guard Mechanism Analysis

### V4 behavior

V4 fired on the two deepest trajectories only — `django-15503` @29 and `django-16263` @22, both
`repeated_read` after prior progress (gated correctly; no opening-orientation fire). 0 suppressed.
**No pytest-style risky early read fire** anywhere (every fire ≥ turn 22). V4 behavior is consistent
with M80/M82.

### C7_D behavior

C7_D fired on `django-15503` (×1 @34 `edit_verify_churn`, `max_same_file_edits=4`) and `django-16263`
(×2: @24 `edit_verify_churn` → @34 `high_tool_count`, `max_same_file_edits=5`). Both fires are **past
the 25-tool gate** and on genuine same-file churn — the c7d-sensitive trigger. C7_D stayed **silent on
the other 8** cases, including every case below the gate (pytest-6197 14 tools, pylint-4551/sympy-12419
17 tools, django-11815/12273/10880 9–10 tools, astropy-7166 13 tools).

### Same-turn / combined message behavior

Combined hook coexisted on all runs (`cost_guard_coexists_with_tool_loop_guard=true`). V4 and C7_D
**never fired on the same turn** (`same_turn_total=0`), so no combined-message collision occurred;
each guard's messages carried the correct sentinel (`<VTRACE_TOOL_LOOP_GUARD>` / `<VTRACE_COST_GUARD>`)
on every fired run. No evidence the guard messages degraded patch behavior (the two fired runs still
produced patches; one resolved).

### django-16263 (headline)

C7_D fired **@24 vs M82's C7_V0 @34** — earlier by 10, **exactly matching the M84 replay prediction**,
triggered by `edit_verify_churn` (the c7d threshold drop) then `high_tool_count` @34. This is the one
M82-fired case whose churn pattern recurred live (`c7d_recurred_on_m82_fired=[django-16263]`). **But**
the run still ran to the ~$3 cap **unresolved** (cost $3.014 ≈ M82 $3.044; 35 tools = M82's 35). So
C7_D fired earlier **as designed**, yet the earlier nudge **did not alter the no-convergence outcome** —
this is a genuine no-convergence trajectory the guard surfaces earlier but cannot, on this slice, redirect.

### django-15503

C7_D fired @34 `edit_verify_churn` (and V4 @29) on a long 95-turn/37-tool churning trajectory — a
**new** fire relative to M82 (where C7_V0 stayed silent on a short cheap run). Not early (@34 ≫ gate),
legitimately churn-driven, `max_same_file_edits=4`. The run **resolved** (matching M80), so the guard
nudges did not prevent convergence. Cost is up vs M82 ($3.001 vs $0.487) because M85's trajectory was
the long resolving path, not M82's short unresolved one — a different live trajectory, not a calibration effect.

### django-12273 (protected)

C7_D **silent** (and V4 silent). M82 fired C7_V0 @31; here the fresh trajectory was short (10 tools /
29 turns, below the gate) and **resolved cheaply** ($0.751). The protected M73 win is preserved and in
fact **recovered vs M82** (M80/M82 had it cap-hit unresolved at ~$3). No guard-caused mechanism — pure
trajectory variance.

### pytest-6197

Both guards **silent** (14 tools < gate). No early V4 read fire, no early C7_D fire. The run **resolved**
(M73 resolved; M80/M82 did not — variance recovery), cost $0.975 ≈ M82. Clean negative control.

### sympy-12419

C7_D **silent**. M82 fired C7_V0 @34 on a long trajectory; M85's fresh run was short (17 tools / 43
turns, below the gate) and **resolved** at $0.809 (down from M82's $3.048). No interference; V4
command-loop trigger did not recur because the trajectory did not loop. Trajectory variance, favorable.

## Targeted Cost / No-Convergence Cases (before → after)

| Case | M82 (C7_V0) | M85 (C7_D) | C7_D effect |
|---|---|---|---|
| django-16263 | fire @34, $3.044, unresolved | fire **@24**, $3.014, unresolved | **Fired earlier (−10 turns) as designed, but too late to alter the no-convergence outcome.** |
| django-15503 | silent, $0.487, unresolved | fire @34, $3.001, **resolved** | New churn fire on a long resolving trajectory; guard did not block convergence (live variance dominates). |
| sympy-12419 | fire @34, $3.048, resolved | silent, $0.809, resolved | Churn pattern did not recur (short run < gate); C7_D correctly silent. Neutral/favorable. |
| django-15503/others | — | below-gate silent | Gate respected; no early fires. |

**Net:** C7_D improved fire *timing* on the one recurring no-convergence trajectory (django-16263) and
stayed correctly silent elsewhere, but did **not** demonstrably improve cost or resolution on the
targeted fired cases. The resolution/cost gains across the slice are confined to **silent** runs and are
attributable to live trajectory variance, not to the guards.

## Protected Wins / Controls

- **Protected wins (C):** django-11815 resolved (preserved); django-12273 resolved (**recovered vs
  M82**). Neither V4 nor C7_D fired on either — **no guard-caused harm**, no regression vs M73.
- **Controls (D):** astropy-7166 and django-10880 both resolved; **no guard fired**; cost ≈ M82.
- **Guard false-positive behavior:** none — every C7_D/V4 fire was on a deep, past-the-gate, churning
  trajectory; nothing fired on a short/low-cost or protected/control run.

## Success Criteria Check

1. All/nearly all runs valid — **PASS** (10/10).
2. Both guards runtime-active and default-off — **PASS**.
3. C7_D calibration recorded in metadata — **PASS** (`cost_guard_calibration=c7d`, churn=2, gate=25 on all).
4. C7_D fires earlier than C7_V0 on ≥1 recurring targeted no-convergence trajectory — **PASS** (django-16263 @24 vs @34).
5. No early fires on pytest-6197 / controls / protected wins — **PASS** (all fires ≥ turn 22, past the gate).
6. Protected wins / controls not materially harmed — **PASS** (all 4 resolved; django-12273 recovered).
7. V4 safe — no risky early read fire — **PASS**.
8. Cost/tools improve on targeted C7_D-fired cases, or failure explained — **PARTIAL** — django-16263
   cost ≈ flat and still unresolved (earlier fire too late); django-15503 cost up but resolved; gains
   are explained as variance, but no clear guard-driven cost/tool improvement on a fired case.
9. Guard metadata complete for both guards — **PASS** (markers verified on all fired runs).
10. No new sentinel/contract/gate validity failures — **PASS**.
11. No evidence combined guard messages degrade patch behavior — **PASS** (both fired runs produced patches).

## Verdict

**MIXED.**

The guards behave **mechanically correctly and safely**: 10/10 valid, both runtime-active and
default-off, C7_D calibration recorded, the 25-tool gate respected everywhere, no early/false/harmful
fires, V4 safe, protected wins and controls unharmed, combined hook coexisting with no same-turn
collisions, complete metadata. The headline timing improvement is confirmed exactly as predicted
(`django-16263` C7_D @24 vs C7_V0 @34).

It is **MIXED rather than PASS** because the *efficacy* question is inconclusive on this slice, matching
two of the brief's own MIXED clauses: (a) on the single case where C7_D fired earlier, it was **still
too late to alter the outcome** (django-16263 ran to the ~$3 cap unresolved at ≈ the M82 cost); and
(b) the resolution improvement (7/10 vs 4/10) and the large cost reductions are driven by **live
trajectory variance on guard-silent runs** (sympy-12419, django-12273, pytest-6197), not by guard
intervention. The two M82 C7-fired protected/command-loop cases (django-12273, sympy-12419) did not
recur their churn/loop patterns, so C7_D correctly stayed silent — confirming safety but leaving the
"does firing earlier help?" question unanswered.

## Recommendation

**Proceed to a larger guarded validation with V4 + C7_D**, keeping both guards **default-off**.

The mechanism, calibration, timing, and safety are clean and reproducible; the only open question is
whether the earlier C7_D fire yields a measurable cost/resolution benefit, which this 10-case slice
(2 C7_D fires, one outcome-altering opportunity) cannot resolve against live variance. A larger guarded
slice with paired baselines is the right next step to measure efficacy; do **not** promote either guard
to default until that evidence exists. The M82 finding that C7 "fires too late on cap-hit no-convergence
runs" is **partially addressed** by C7_D (it fires earlier) but **not eliminated** — django-16263 shows
even a −10-turn earlier fire was insufficient to redirect that trajectory, which argues for a
turn-/cost-aware signal as the longer-term direction if larger validation confirms the gap.
