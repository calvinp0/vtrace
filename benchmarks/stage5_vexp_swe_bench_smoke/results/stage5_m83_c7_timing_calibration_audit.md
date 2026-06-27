# Stage 5 M83 C7 Timing Calibration Audit

Offline audit/calibration of the **C7 cost / no-convergence guard** fire timing. **No live
agents, no Docker, no API spend, no benchmark.** C7 behavior is **unchanged** — every
"variant" is a config object passed to the existing pure `runCostGuard`; `costGuard.ts` is
untouched. Both guards remain **DEFAULT-OFF**.

## Summary

- **M82 verdict recap:** **MIXED.** Both guards mechanically correct, default-off, 10/10
  valid. C7 fired on its headline target (django-16263) but **@34 of 35 tools, after ~$3
  already spent** — too late to steer convergence or save cost. Resolution 4/10 vs M80 5/10
  = live variance; the one protected-win regression (django-12273) **predates C7** (it also
  regressed in M80 V4-only).
- **Key timing findings:** C7's productive live trigger is the **positional** `high_tool_count`
  (35) — a stream trigger that, by construction, fires only at tool call #35. On the two
  cap-hit targets it therefore lands at the very end. The `edit_verify_churn` trigger needs
  3 same-file edits; django-16263 made only **2** edits to `query.py` (amid **17** failing
  verifies), so churn never reached threshold and only `high_tool@35` caught it.
- **Structural ceiling (the central finding):** tool-count is a **weak proxy for cost** on
  these runs. django-16263 = **86 turns / 35 tools** (~2.5 turns/tool); most of the $3 is
  spent in cached-context **turns between** tool calls. So even the earliest *safe*
  tool-position fire lands after most of the budget is gone. **No tool-position threshold
  alone can prevent cap-burn on turn-heavy runs.**
- **Best threshold candidate:** **C7_D — `editVerifyChurnThreshold` 3 → 2** (brief option
  **C**). It gives the **largest safe lead** on django-16263 (fires at tool 25, +10 vs V0),
  **uniquely leaves the winning sympy-12419 run untouched**, and across **563 captured
  streams** adds only **+3 fires** (4.6% vs V0 4.1%) with **zero early fires**.
- **Recommendation for M84:** **OFFLINE** validation of C7_D (default-off) over the full
  corpus; **defer any live re-validation** until a turn-/cost-aware live signal is designed.
  Keep C7 inject-capable but default-off. No guard promoted.

## Method

- **Inputs inspected:** `stage5_m82_v4_c7_live_validation.{md,detail.json}`,
  `stage5_m82_v4_c7_live_split.json`, `stage5_m82_v4_c7_preflight.json`,
  `stage5_m81_cost_guard{,_replay}.json`, M80 priors (via the M82 detail), and `costGuard.ts`
  (detector source, **read-only**).
- **Raw artifacts inspected (replay only, never staged):** 10/10 M82 streams
  (`runs/m82_v4_c7_guard_*`), 10/10 M80 streams (`runs/m80_tool_loop_guard_v4_*`), and a
  **563-stream broad corpus** (every non-empty `_tool_calls.json` in `runs/`).
- **Harness:** `run_stage5_m83_c7_threshold_sweep.ts` — replays `runCostGuard` under 9
  panel variants (with run-context) + 5 broad-corpus variants (stream-only, live-faithful).
- **Offline / gold evidence:** outcomes (`resolved`, cost, turns) come from the captured
  result rows, **not** gold labels; no trigger uses gold. M82 C7-active streams are valid for
  measuring *earlier-than-@34* fires because the live injection happened **at** tool 34, so
  the prefix is unperturbed.
- **Limitations:** (1) **M73 full streams are NOT captured** (only eval logs); M73 outcomes
  come from split metadata. (2) Per-turn cost is not in the streams, so "cost already spent at
  an earlier fire" is **inferred** from the turn/tool ratio, not measured. (3) The broad
  corpus lacks per-case cohort labels, so it bounds **fire-rate / early-rate**, not
  cohort-level harm.

## M82 C7 Timing Reconstruction

V0 replay reproduces the M82 live fires exactly (16263 @34, sympy @34, 12273 @31).

| instance | group | M82 | C7 fired | first fire | trigger | tool/edit/verify @ fire · cost | mechanism | conf |
|---|---|---|---|---|---|---|---|---|
| astropy-14598 | neutral | F $1.53 | no | – | – | 24 tools < gate | silent_correct | high |
| django-15503 | targeted | F $0.49 | no | – | – | 8 tools, short variance path | silent_correct | high |
| **django-16263** | targeted (headline) | F $3.04 | **yes** | **34** | high_tool_count | 35 / 2 / 17 · **$3.04 (cap)** | **useful_but_late** | high |
| pytest-6197 | control | F $0.95 | no | – | – | 19 tools; maxSameFile=1 | silent_correct | high |
| pylint-4551 | neutral | F $1.62 | no | – | – | 33<35; churn pre-gate (supp×2) | silent_miss | medium |
| sympy-12419 | protected | **T** $3.05 | **yes** | **34** | high_tool_count | 35 / 2 / 21 · $3.05 | **neutral_late** | high |
| django-11815 | protected | T $0.33 | no | – | – | 4 tools | silent_correct | high |
| **django-12273** | protected | F $3.01 | **yes** | **31** | edit_verify_churn (`churn:base.py`) | 32 / 3 / 12 · $3.01 (cap) | **neutral_late** | high |
| astropy-7166 | control | T $0.65 | no | – | – | 13 tools | silent_correct | high |
| django-10880 | control | T $0.35 | no | – | – | 6 tools | silent_correct | high |

Cross-check (M80 C7-absent streams, V0): django-15503 @27, django-16263 @28, django-12273
@34 — consistent with the M81 offline expectation.

## Deep Dives

### django-16263 (headline)
- **What caused the fire:** the positional `high_tool_count` (35) — the run reached 35 tool
  calls without convergence. At fire: **2 edits, 17 verify (test) runs, 4 reads, 7 searches**,
  patch seen, est cost **$3.04 (cap)**.
- **Edits/verifies before C7:** 2 edits to `query.py` against **17 failing verifies** — a real
  thrash, but `edit_verify_churn` needs **3** same-file edits and
  `repeated_verification_no_progress` needs the **same failure signature** to persist ×3; the
  failure signatures varied / edits stayed at 2, so neither fired. Only `high_tool@35` caught it.
- **Already near cap:** **yes** — $3.04 at fire.
- **What an earlier fire would have seen:** churn-2 → tool 25 (2nd `query.py` edit); high_tool-30
  → tool 30; high_tool-28 → tool 28.
- **Would earlier C7 change behavior:** **likely not the outcome** — the run is **patch-quality
  limited** (2 edits / 17 failing verifies = it never found the fix). An earlier nudge might trim
  the tail cost or prompt a no-patch stop, but resolution was unlikely. Most cost accrued via 86
  turns regardless of tool position.
- **Threshold that fires before the cap (tool-count):** churn-2 (tool 25) is earliest; but in
  **cost** terms no variant provably fires before ~$3 is mostly spent (turn-driven accrual).

### django-12273 (protected)
- **Why churn fired @31:** the **3rd** edit to `base.py` (threshold 3) at tool 32, with 12
  prior verify failures; cap-hit $3.01.
- **Already failing before C7:** **yes** — V4 (`repeated_read`) fired @30, one tool earlier;
  the run was a 32-tool / 87-turn cap-hit before C7.
- **Did C7 precede harm or occur during failing churn:** **during** already-failing churn (3rd
  edit near the end). It did **not** precede the damage.
- **Threshold changes to fire earlier:** churn-2 does **not** help here — 12273's 2nd `base.py`
  edit landed **before** the 25-tool gate (suppressed), so the next qualifying churn is still
  the 3rd @31. high_tool-30 would fire @29 (2 earlier).
- **Helpful / harmful / unknowable:** **unknowable, leaning unhelpful** — the regression
  predates C7 (M80 V4-only also regressed); failure is patch-quality, not steering.
- **Protect from early C7 fire?** No special handling needed: the M73 win was a *different*
  9-tool trajectory; the cap-hit 32-tool trajectory is genuinely non-converging, and churn-2
  happens not to pull its fire earlier anyway. The 25-tool gate is sufficient.

### sympy-12419 (command-loop / protected)
- **Why high_tool fired despite resolving:** the M82 run was costlier ($3.05 / 91 turns / 35
  tools) and legitimately crossed 35 tools. It is a **long but converging** verification path
  (21 verify runs, **1** file edited, eventually correct).
- **Late enough to be harmless:** **yes** — fired at the last tool; the run was essentially done
  and **resolved**.
- **Would lower thresholds fire too early / disrupt:** churn-2 leaves it **exactly untouched**
  (@34) because sympy has **no same-file churn** (maxSameFile=1). high_tool-30/28 pull its fire
  to @29/@27 — still late, still resolved, but a 5–7 tool earlier nudge on a *winning* run is a
  mild, unnecessary disruption.
- **Variants preserving it safe:** **churn-2 (C7_D) preserves it perfectly**; the high_tool
  variants only nudge it earlier (low, not zero, risk).

### django-15503
- **Correctly silent?** **Yes** — the M82 trajectory was 8 tools / $0.49 / 25 turns, far below
  the 25-tool gate. (The M80 stream *would* have fired @27 — a different $3 trajectory.)
- **Short/low-cost enough that C7 should not fire?** Yes; firing would be a false positive.
- **Lower thresholds → false positive here?** No — 8 tools never reaches 28/30 high_tool and is
  below the churn gate. Safe under all variants.

### pytest-6197 (risky-early-fire check)
- **Either guard silent?** **Yes** — both silent in M82 (19 tools, $0.95).
- **Would lower C7 thresholds fire early?** **No** — 19 tools < 28/30 high_tool, and
  maxSameFile=1 so churn is impossible. Silent under **every** variant (confirmed on panel and
  in the 563-stream early-fire = 0 result).
- **Recreate the V4 early-intervention risk?** **No** — C7's 25-tool gate sits far above
  pytest's 19 tools; no early C7 fire is reachable.

## Threshold Sweep

**Panel (10-case M82 split, with run-context).** Every variant: **0 early fires, 0 control
fires, 0 protected-early fires, pytest silent, sympy never early.**

| variant | config | total fires | tgt earlier (≥5t) | protected (early) | control (early) | pytest | sympy | 16263 first fire | risk |
|---|---|---|---|---|---|---|---|---|---|
| C7_V0 | current | 3 | 0 | 2 (0) | 0 (0) | – | late | tool 35 (@34) | low |
| C7_A | highTool 30 | 4 | 2 | 2 (0) | 0 (0) | – | late | tool 30 (@29) | low |
| C7_B | highTool 28 | 4 | 2 | 2 (0) | 0 (0) | – | late | tool 28 (@27) | low |
| C7_C | min20 + highTool 30 | 4 | 2 | 2 (0) | 0 (0) | – | late | tool 30 (@29) | low |
| **C7_D** | **churn 2** | **3** | **1** | **2 (0)** | **0 (0)** | – | **untouched** | **tool 25 (@24)** | **low** |
| C7_E | min20+high30+churn2 | 4 | 2 | 2 (0) | 0 (0) | – | late | tool 25 (@24) | low |
| C7_F | costCap 0.70 | 3 | 0 | 2 (0) | 0 (0) | – | late | tool 35 (@34) | low |
| C7_G | high28 + churn2 | 4 | 2 | 2 (0) | 0 (0) | – | late | tool 25 (@24) | low |
| C7_H | conservative high30 | 4 | 2 | 2 (0) | 0 (0) | – | late | tool 30 (@29) | low |

C7_F (costCap 0.70) does nothing to first-fire timing — `cost_cap_approaching` is
**observe-only / end-attributed** and cannot fire mid-loop live.

**Broad corpus (563 captured streams, stream-only / live-faithful).**

| variant | fired | fire-rate | early fires | churn fires | high-tool fires |
|---|---|---|---|---|---|
| V0 | 23 | 4.1% | **0** | 14 | 15 |
| high_tool 30 | 36 | 6.4% | **0** | 13 | 31 |
| high_tool 28 | 43 | 7.6% | **0** | 9 | 41 |
| **churn 2** | **26** | **4.6%** | **0** | 18 | 15 |
| min20+high30+churn2 | 45 | 8.0% | **0** | 32 | 30 |

**Reading:** **churn-2 adds only +3 fires** vs V0 at scale (14→18 churn fires), while
high_tool-30 adds **+13**. The **25-tool orientation gate provably contains every variant**
(zero early fires across 563 streams). The only change that materially inflates churn fires is
**lowering the gate** (min20 → 14→32) — so the **gate, not the churn count, is the protective
lever**. This refutes the a-priori worry that "2 same-file edits = normal refinement would
over-fire": past the 25-tool gate, a 2nd same-file edit is rare and correlates with
non-convergence.

## Candidate Recommendation

**Chosen: C7_D — `editVerifyChurnThreshold` 3 → 2 (brief option C: lower editVerifyChurn only).**

- **Why:** largest **safe** lead on the no-convergence target (django-16263 at tool 25, +10 vs
  V0); **uniquely leaves the winning sympy-12419 trajectory untouched** (no same-file churn);
  adds only **+3 fires / 563 streams** (4.6%) with **zero early fires**; keeps the 25-tool gate
  and high_tool=35 intact; one knob, deterministic, no gold labels.
- **Expected benefit:** an earlier nudge on genuine same-file edit/verify churn, **without**
  pulling forward fires on long-but-converging verification runs (sympy-class).
- **Regression risk:** **low** on the captured corpus. Residual: the **structural ceiling** —
  even @tool-25 likely lands after much of the cost on turn-heavy runs; the benefit is a partial
  cost trim, not a cap-burn fix.
- **Rejected alternatives:**
  - **A (keep current):** M82 live confirmed too-late firing; doing nothing wastes the
    calibration opportunity.
  - **B (lower highToolCount):** defensible (+5/+7 lead, low risk) but adds +13 fires at scale
    and **pulls the winning sympy run's fire 5–7 tools earlier** — less surgical than churn-2.
  - **E (density/slope via min20):** lowering the gate inflates churn fires 14→32; the gate is
    the protective lever — do not weaken it.
  - **F (observe-only):** C7 is mechanically sound and safe-capable; a calibrated default-off
    inject candidate is more useful than freezing it.
  - **G (abandon for C2 no-patch recovery):** premature; C2 does not apply to 16263/12273 (both
    **produced** patches and churned). Keep C7 as the churn/no-convergence lever.

## External Hook Patch Status

- **Installed:** **yes** — `vexp-swe-bench/dist/agents/claude-code.js` carries the Stage 5
  patch blocks (tool-loop-guard / vtrace-instructions / tool-use-discipline / stream).
- **Backup:** **present** — `vexp-swe-bench/dist/agents/claude-code.js.stage5-vtrace-backup`.
- **Default-off safety:** **safe.** Every patched block is **env-gated**
  (`VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS`, `VTRACE_AGENT_INSTRUCTIONS_FILE`,
  `VTRACE_TOOL_USE_DISCIPLINE_FILE`) and the guard hook `existsSync`-checks the settings file;
  with no env set the adapter is behaviorally equivalent to the backup. No risk from leaving it
  installed (inert without explicit opt-in).
- **Recommendation:** **leave installed; M84 = verify-only.** No revert needed; backup
  available. **No external repo change was performed in M83.**

## Recommended M84

- **Step:** **OFFLINE** validation of **C7_D** (`editVerifyChurn` 3 → 2), default-off, over the
  full 563-stream corpus (+ any recoverable M73 streams): quantify fire-rate, early-fire (expect
  0), and per-cohort fire deltas. **No live agents, no Docker, no spend.**
- **Non-goals:** no live run; no Docker; no V4 change; no retrieval / scoring / ranking /
  Capsule-v2 / digest-contract / pivot-gate change; no default promotion; no external repo change.
- **Validation gate:** adopt C7_D as the inject candidate **only if** offline shows 0 early
  fires at scale, no new control/protected **early** fires, and the sympy-class winning
  trajectories stay untouched. **Defer live re-validation** until a **turn-/cost-aware live
  signal** is designed — the structural ceiling means tool-position calibration alone cannot
  fix cap-burn on turn-heavy runs.
