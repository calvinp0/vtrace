# Stage 5 M82 V4 + C7 Live Validation

Combined runtime validation of the two DEFAULT-OFF guards together — the M79 calibrated **V4
tool-loop guard** and the M81 **C7 cost / no-convergence guard** — both in `inject` (runtime
hook) mode over the frozen M77/M80 10-case split.

> Scope: mechanism validation slice (10 cases). NOT a 100-task benchmark, NOT a paired
> significance claim, NOT a VEXP/SWE-bench external claim, NOT a default promotion. Both guards
> remain DEFAULT-OFF.

## Summary

- **Selected cases:** 10 (frozen M82 split = identical membership to M77/M80; A=4, B=2, C=2, D=2).
- **New live runs:** 10 treatment runs (run-protocol) + 10 Docker evals. 7 valid on the first
  pass; **3 operational retries** (django-11815, django-12273, astropy-7166) after a session
  teardown corrupted their first launch (no swebench row, $0.00, no agent output — infrastructure
  abort, recorded separately, within the 4-launch cap). 0 provider/quota aborts.
- **Valid runs:** **10 / 10** (analyzer `valid_run`), 0 invalid. 0 partial sentinel, 0 required
  IMPACT, confidence gate applied on all.
- **Both guards runtime-active & default-off:** `both_guards_runtime_active_all=true`,
  `tool_loop_guard_mode=runtime_injection`+`calibration=v4`, `cost_guard_mode=runtime_injection`,
  `cost_guard_coexists_with_tool_loop_guard=true` on all 10. Markers verified on every fire.
- **V4 injections:** fired in **3/10** (django-15503 @7, pylint-4551 @24, django-12273 @30; all
  `repeated_read`). 2 events suppressed by the V4 calibration. No `repeated_read` ≤ turn 3.
- **C7 injections:** fired in **3/10** (django-16263 @34 `high_tool_count`, sympy-12419 @34
  `high_tool_count`, django-12273 @31 `edit_verify_churn`). 0 control fires, 0 early-orientation
  fires (earliest @31, all past the 25-tool / 8-turn gate).
- **Combined guard behavior:** django-12273 is the only run where **both** guards fired — V4 @30
  and C7 @31 on **adjacent** turns → two separate messages. `combined_same_turn_total=0`: no
  same-tool-result double-fire occurred, so the "one combined message" priority path was **not**
  exercised live (coexistence demonstrated; collision path untested).
- **Resolution:** **M82 4/10**, M80 5/10, M73 5/10. The single delta vs M80 is **django-15503**
  (M80 resolved → M82 unresolved), where C7 did **not** fire and the trajectory was a short
  $0.49 / 25-turn path (vs M80's $3.01 / 100-turn cap-hit) — live variance, not guard-caused.
- **Cost/tool-calls:** M82 total **$15.01** vs M80 $14.48 (+$0.53) vs M73 $18.55. C7's headline
  target django-16263 **did not improve** (cost +$1.12 vs M80, still cap-hit, unresolved): C7
  detected the pattern but fired **late** (@34, near cap) — too late to steer convergence.
- **Verdict:** **MIXED.**
- **Recommendation:** **Audit C7 thresholds (fire timing) before more live validation.** Keep both
  guards default-off.

## M81 Sanity Check

Inspected `stage5_m81_cost_guard.json`, `stage5_m81_cost_guard_replay.json`,
`stage5_m81_cost_guard.md` before any live run.

- **C7 default-off:** confirmed (`default_off=true`; flags `--cost-guard`, `--cost-guard-mode
  observe|inject`, `--cost-guard-inject`; opt-in only).
- **Combined hook available:** confirmed (the cost guard reuses the M76 PostToolUse `--settings`
  registration; `verify-vtrace-patch` shows the tool-loop-guard runtime hook patch present in the
  external adapter, backup present).
- **Replay deterministic:** the M81 replay JSON is the offline `runCostGuard` over frozen streams;
  rollups and per-case data are internally consistent.
- **M81 fires on django-16263:** confirmed (cohort `high_cost_no_convergence`, fire @28).
- **django-12273 fire status & classification:** **CLASSIFIED PROTECTED** (cohort
  `protected_win_high_cost`). C7 **did** fire on it in M81 (fire_count 1, first_fire_turn 34,
  `high_tool_count`, **`late_fire=true`**).
- **Normal-control fires:** 0 (pytest-6197, astropy-7166, django-10880 all silent).
- **Protected-win fires:** the headline metric `protected_win_or_command_loop_fires=0` is a
  **prose imprecision** — django-12273 (a protected win) *did* fire, but **late**; the cohort
  rollup and the MD table (`protected_win_high_cost | fired 1 | late 1`) record it openly. The
  rolled-up metric counts only **early/harmful** protected-win fires.
- **Verdict on the pasted ambiguity:** **prose-only, not material.** No material contradiction
  per the task's criteria (C7 is default-off, controls don't fire early, no *early* protected-win
  fire, hook available, metadata present, replay deterministic). **Continued without exclusions.**

## Split

Frozen M82 split (`stage5_m82_v4_c7_live_split.json`), identical membership to M77/M80, regrouped
to the M82 brief. **No replacements; no membership change after seeing results.**

| grp | instance | M73 res / cost | M80 res / cost | M80 V4 | M81 expected C7 |
|---|---|---|---|---|---|
| A | astropy-14598 | F / $3.00 | F / $1.61 | @14 | silent (19t<gate) |
| A | django-15503 | F / $3.04 | **T** / $3.01 | – | fire @27 churn+tools |
| A | django-16263 | F / $3.02 | F / $1.92 | @18 | **fire @28** churn+tools |
| A | pytest-6197 | **T** / $1.75 | F / $0.64 | – | silent (15t<gate) |
| B | pylint-4551 | F / $3.01 | F / $0.91 | – | silent (12t<gate) |
| B | sympy-12419 | F / $3.00 | **T** / $1.90 | – | silent (28t<35; preserve win) |
| C | django-11815 | **T** / $0.44 | **T** / $0.41 | – | silent |
| C | django-12273 | **T** / $0.54 | F / $3.03 | @36 | fire @34 high_tool (**late**) |
| D | astropy-7166 | **T** / $0.40 | **T** / $0.61 | – | silent |
| D | django-10880 | **T** / $0.35 | **T** / $0.43 | – | silent |

## Pre-flight

`run_stage5_m82_preflight.ts` → `stage5_m82_v4_c7_preflight.json` (no agents, no Docker, no spend).

- **Valid:** **10 / 10** (`by_status={VALID:10}`); gate **PASSES**.
- 0 partial sentinel · 0 required IMPACT · confidence gate enabled on all · compact mode applied.
- **Combined hook available:** true · **cost-guard settings constructible:** true ·
  **tool-loop-guard settings constructible:** true.
- V4 inject configured (calibration v4) on all · C7 inject configured on all.
- External hook patch already installed (left as-is; backup present; no manual edits to the
  external repo).

## Run Matrix

| instance | grp | M73 | M80 | **M82** | valid | V4 fire | C7 fire | first guard turn | cost Δ vs M80 | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| astropy-14598 | A | F | F | **F** | ✓ | – | – | – | −0.09 | no fire; $1.53 |
| django-15503 | A | F | T | **F** | ✓ | @7 read | – | 7 | **−2.52** | short path $0.49/25t; **regressed vs M80** (not C7) |
| django-16263 | A | F | F | **F** | ✓ | – | **@34 high_tool** | 34 | **+1.12** | **headline target**; cap-hit $3.04; C7 late |
| pytest-6197 | A | T | F | **F** | ✓ | – | – | – | +0.30 | **no early fire** ✓; $0.95 |
| pylint-4551 | B | F | F | **F** | ✓ | @24 read | – | 24 | +0.71 | V4 only; $1.62 |
| sympy-12419 | B | F | T | **T** | ✓ | – | **@34 high_tool** | 34 | **+1.14** | C7 fired (costlier run) yet **resolved** |
| django-11815 | C | T | T | **T** | ✓ | – | – | – | −0.08 | protected win held; $0.33/13t |
| django-12273 | C | T | F | **F** | ✓ | @30 read | **@31 churn** | 30 | −0.02 | **both fired** (adjacent); cap-hit; regressed (≈M80) |
| astropy-7166 | D | T | T | **T** | ✓ | – | – | – | +0.04 | control held |
| django-10880 | D | T | T | **T** | ✓ | – | – | – | −0.08 | control held (canary) |

Resolution: **M82 4 / M80 5 / M73 5.** Cost: **M82 $15.01 / M80 $14.48 / M73 $18.55.**

## Guard Mechanism Analysis

- **V4 (tool-loop):** fired 3× (django-15503 @7, pylint-4551 @24, django-12273 @30), all
  `repeated_read`; 2 events suppressed by the V4 calibration (prior-progress gating). No
  opening-orientation fire (no `repeated_read` ≤ turn 3). Markers present on every fire. The M80 V4
  fire set (astropy-14598/16263/12273) differs from M82's (15503/4551/12273) — expected live
  variance in which runs actually loop; **django-12273 fired V4 in both** rounds.
- **C7 (cost):** fired 3× — django-16263 @34 (`high_tool_count`), sympy-12419 @34
  (`high_tool_count`), django-12273 @31 (`edit_verify_churn`). All deep (≥31), all past the 25-tool
  / 8-turn gate; **0 control / 0 orientation fires**. `c7_fired_before_cap_all=false`: every C7 fire
  landed on a run that had already reached / neared the $3 cap — i.e. **C7 fired late**.
- **Combined / same-turn behavior:** `combined_same_turn_total=0`. django-12273 is the only
  both-fired run (V4 @30, C7 @31 — adjacent, not same tool result), so two distinct messages were
  emitted, not a merged one. Coexistence (both guards independently live, separate state
  namespaces, distinct markers) is **demonstrated**; the same-result "one combined message"
  priority path was **not exercised** live.
- **django-16263 (headline):** C7 fired @34 `high_tool_count` (M81 predicted; pattern recurred).
  V4 did **not** fire this round (M80 fired @18). Cost $3.04 (cap-hit), **+$1.12 vs M80**,
  unresolved. The run was still a no-convergence cap burn — the single late nudge @34 did not steer
  it to convergence. **C7 activated correctly but did not help here.**
- **django-15503:** M81 expected a C7 fire; the M82 trajectory was a short $0.49 / 25-turn / 8-tool
  path far below the C7 gate, so C7 correctly stayed **silent**. V4 fired @7 (`repeated_read`, after
  prior progress — not an orientation fire). Unresolved (M80 had resolved at the cap). The
  resolution loss is **live variance**, not guard-caused (C7 silent; V4 @7 is a legitimate
  post-progress fire in a non-protected group-A case that M73 also failed).
- **django-12273 (protected):** both guards fired late on a cap-hit ($3.01) trajectory; unresolved,
  **regressed vs M73** — but this regression also occurred in **M80 (V4-only, no C7)**, so it
  **predates C7** and is not guard-caused. C7 @31 (`edit_verify_churn`) was a late nudge on an
  already-failing run; it did not rescue it. M81 expected exactly a late fire here.
- **pytest-6197 (risky-early-fire check):** **neither guard fired** (`early_v4_read_fire=false`,
  `early_c7_fire=false`). No early-intervention harm recreated. Unresolved (no guard fired → not
  guard-caused; M80 also unresolved).
- **sympy-12419 (command-loop preservation):** C7 **fired** @34 `high_tool_count` — a deviation
  from M81's "silent" expectation, but **explained**: this M82 run was costlier ($3.05 / 91 turns /
  35 tools vs M80 $1.90 / 77 / 28), legitimately crossing the high-tool gate. No
  `repeated_failed_command` loop recurred this round, so V4's command pathway simply had nothing to
  fire on (`v4_command_trigger_present=false`). Critically, the case **still resolved** → C7 firing
  on a genuinely high-cost run caused **no harm**.

## Targeted Cost / No-Convergence Cases

| case | C7 fired | trigger @ turn | cost (Δ vs M80) | resolved | helped? |
|---|---|---|---|---|---|
| django-16263 | yes | high_tool @34 | $3.04 (+1.12) | F | **no** — late, still cap-hit |
| django-15503 | no | — (below gate) | $0.49 (−2.52) | F | n/a — C7 silent; short variance path |
| sympy-12419 | yes | high_tool @34 | $3.05 (+1.14) | **T** | neutral — resolved anyway |
| django-12273 | yes | churn @31 | $3.01 (−0.02) | F | **no** — late, regression predates C7 |

C7 **activates on the intended high-cost / churn / no-convergence vector** (criterion 3 met:
django-16263), but on the cap-hit runs it fires **late** (@31–34, after ~$3 already spent), so it
did **not** reduce cost or rescue convergence on the cases it targeted. Where it fired and the run
still resolved (sympy-12419), it was harmless. This confirms — now **live** — the M81 caveat that
C7 timing on cap-hit runs lands too late.

## Protected Wins / Controls

- **Protected wins (C):** django-11815 **held** (resolved, $0.33, no fire). django-12273
  **regressed** (unresolved, cap-hit) — but the regression is **not guard-caused** (same outcome in
  M80 V4-only without C7; C7 fired late on an already-failing trajectory). `recovered_vs_m80=[]`.
- **Controls (D):** astropy-7166 and django-10880 **both resolved**, **neither guard fired**
  (`controls_summary.any_guard_fired=false`). No false positives, no harm.
- **Guard false-positive behavior:** none on controls; the only protected-win fire was the
  M81-anticipated late django-12273 fire.

## Success Criteria Check

1. all / nearly all valid — **PASS** (10/10 valid, 0 invalid).
2. both guards runtime-active & default-off — **PASS**.
3. C7 fires on ≥1 targeted cost/no-convergence case when the pattern recurs — **PASS**
   (django-16263).
4. C7 does not fire early during normal orientation — **PASS** (earliest @31; gate held; controls
   silent).
5. protected wins / controls not materially harmed — **PASS (guard-causally)** / **partial on
   outcome**: controls fully held; 1 protected win (django-12273) unresolved, but not guard-caused
   (regression predates C7).
6. V4 safe, no pytest-style risky early read fire — **PASS** (pytest-6197 silent; earliest V4 @7
   is a legitimate post-progress fire).
7. cost/tool-calls improve on C7-fired targeted cases, or failures explained — **PARTIAL**: no cost
   improvement on the fired targeted case (django-16263 +$1.12, still cap-hit); explained as
   late-fire timing + inherent cap-hit trajectory.
8. metadata complete for both guards — **PASS** (all required `tool_loop_guard_*` + `cost_guard_*`
   fields present; markers verified).
9. no new sentinel/contract/gate validity failures — **PASS** (10/10 valid).
10. no evidence combined messages degrade patch behavior — **PASS** (no same-turn combined message
    occurred; the one both-fired run's regression predates C7).

## Verdict

**MIXED.**

Both guards behave **mechanically correctly** — runtime-active, default-off, V4 calibration safe
with no risky early fire, C7 activating on its intended high-cost/no-convergence vector with zero
control/orientation false positives, complete metadata, all 10 runs valid. But **live variance
makes the resolution/cost outcome inconclusive** (4/10 vs 5/10, costs swing both ways), and the one
protected-win regression (django-12273) occurs **without a guard-caused mechanism** (it predates C7
in M80). C7's headline target (django-16263) shows C7 fires **too late** on cap-hit runs to steer
convergence. This matches the task's MIXED definition on both clauses.

## Recommendation

**Audit C7 thresholds (fire timing) before more live validation.** The live evidence confirms the
M81 caveat: on cap-hit / no-convergence runs C7's `high_tool_count` (35) and `edit_verify_churn`
triggers fire at ~31–34 tools, when ~$3 is already spent — too late to prevent the cap burn or
steer convergence (django-16263, django-12273 both still capped after C7 fired). Before any larger
guarded validation or promotion, revisit the C7 gate/threshold timing so it fires **earlier** on
the no-convergence vector (e.g. lower `highToolCountThreshold` / earlier churn detection, while
keeping the orientation gate that kept controls silent). C7 is otherwise safe to keep
**inject-capable but default-off**; V4 remains inject-capable and validated. **No guard is
promoted; both stay default-off.**
