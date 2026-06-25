# Stage 5 M77 Tool Loop Guard Live Validation

## Summary

- **Selected cases:** 10 (frozen split from M73/M74/M75/M76 artifacts).
- **Validation groups:** A = targeted thrash/cap-hit, guard *fired* in M75 replay (4); B = targeted, guard *not fired* in M75 (2); C = protected treatment-only wins (2); D = normal resolved / low-cost controls (2).
- **New live runs:** 10 treatment runs (within the ≤12 approval cap). 0 baselines. 0 corrective/revision/oracle arms.
- **Operational retries / quota aborts:** 0.
- **Docker evals:** 10 (one per produced patch).
- **Valid / invalid runs:** **10 / 0** valid. Runtime injection mode active on all 10 (`tool_loop_guard_mode = runtime_injection`, hook available = true). Treatment validity (digest + decision contract + confidence gate) intact on all 10.
- **Guard injections:** fired live in **3 / 10** cases — `astropy-14598` (turn 13), `pytest-6197` (turn 2), `sympy-12419` (turn 5). Every injected message carried the stable `<VTRACE_TOOL_LOOP_GUARD>` marker; injection-count ↔ events ↔ marker ↔ first-turn metadata consistent on all 10.
- **Resolution result:** **M77 5/10 vs prior M73 5/10** — net flat. Composition shifted: +1 new win `sympy-12419` (B, guard-fired), −1 regression `pytest-6197` (A, guard-fired). **Both protected wins (C) and both normal controls (D) preserved (4/4 P→P).**
- **Cost / tool-call result:** slice cost **$10.93 vs $18.55 prior (−41%)**; targeted-fired-case mean cost **$1.45 vs $2.58**, mean tool calls **23.3 vs 28.7**. *Caveat: the cost drop is only partly guard-attributable — see Targeted cases.*
- **Changed-behavior result:** the runtime hook is demonstrably live (mid-loop injections with verified markers; per-run state file accumulated tool-call events during the run). 3/4 Group A and both Group B cases dropped off the prior $3 cap; one (`astropy-14598`) via a confirmed live injection.
- **Verdict:** **MIXED.**
- **Recommendation:** **Proceed to a larger guarded validation (kept default-off)**, watching for the early-fire regression pattern; keep observe-only/diagnostics as the conservative fallback.

## Split Construction

- **Input artifacts:** `stage5_m73_final_100_paired.detail.json`, `stage5_m74_self_harness_lite_audit.json`, `stage5_m75_tool_loop_guard_replay.json`, `stage5_m76_tool_loop_guard_runtime_simulation.json`. (The protocol named `stage5_m73_final_100_paired_summary.detail.json`; the on-disk detail file is `stage5_m73_final_100_paired.detail.json`.)
- **Selection rule (outcome-blind):** per group, sort candidate `instance_id`s ascending and take the first N; Group A prioritizes the M74 cost-cap-exhaustion cluster (`cap_hit`) fired cases then thrashing fired; Group B prioritizes `cap_hit` not-fired. Never selected on resolved/cost.
- **Selected cases by group:**
  - **A (4):** `astropy-14598`, `django-15503`, `django-16263` (cap_hit, fired), `pytest-6197` (thrashing, fired).
  - **B (2):** `pylint-4551`, `sympy-12419` (cap_hit, not fired in M75).
  - **C (2):** `django-11815`, `django-12273` (treatment-only wins).
  - **D (2):** `astropy-7166`, `django-10880` (normal resolved, low-cost).
- **Anti-cherry-picking notes:** the split was frozen before any live run; within each group candidates were sorted by id and the first N taken, independent of pass/fail/cost; Groups A+B cover 5 of the 6 M74 cost-cap-exhaustion cluster instances (only `sympy-15599`, the 7th-ranked, excluded). No case was added, dropped, or reordered after seeing live results.
- **Prior M73 outcomes:** Group A/B are the expensive cluster — 5 of the 6 cap-hit cases ran to the ~$3 cap unresolved in M73; `pytest-6197` resolved at $1.75. Group C are M73 treatment-only wins; Group D are cheap both-pass controls.

## Pre-flight

- **No-agent render pre-flight** over all 10 selected cases re-rendered the exact M73 structured-bounded + pivot-confidence treatment context offline and classified validity with the M72/M73 gate-on rules, plus a runtime-hook availability probe.
- **Result: 10 / 10 VALID.** 0 partial sentinel, 0 required IMPACT, confidence gate enabled on all, compact mode applied, bounded structured grammar (or explicit no-high-confidence marker) present.
- **Hook availability:** the M76 runtime-hook patch was initially **absent** from the external adapter (`dist/agents/claude-code.js`) — runtime injection would have failed-closed (all runs invalid as `m77_runtime_hook_unavailable`). Installed via the supported `--mode install-vtrace-patch` (backup created; reversible) and re-verified: all four patches (instructions, stream, tool-use-discipline, **tool-loop-guard hook**) present. Pre-flight then recorded `runtime_hook_available = true` and `settings_constructible = true` for all 10.
- **Gate:** valid ≥ 8 ✓, partial-sentinel = 0 ✓, hook available ✓ → **gate PASSES.**

## Run Matrix

| instance | grp | prior_guard_would_fire (M75) | prior M73 resolved | M77 resolved | valid | guard fired | inj | first fire turn | cost (M77 / prior) | tool calls (M77 / prior) | repeated reads | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy-14598 | A | yes | F | F | ✓ | yes | 1 | 13 | $1.62 / $3.00 | 19 / 32 | 5 | cap avoided via live injection |
| django-15503 | A | yes | F | F | ✓ | no | 0 | – | $0.62 / $3.04 | 11 / 44 | 1 | cap avoided; trajectory didn't loop |
| django-16263 | A | yes | F | F | ✓ | no | 0 | – | $3.03 / $3.02 | 36 / 35 | 9 | **still capped**; thrash not repeated-read-shaped |
| pytest-6197 | A | yes | **P** | **F** | ✓ | yes | 1 | 2 | $1.19 / $1.75 | 17 / 23 | 6 | **regression**; guard nudged edit of correct file |
| pylint-4551 | B | no | F | F | ✓ | no | 0 | – | $1.10 / $3.01 | 20 / 26 | 1 | cap avoided; no fire (variance) |
| sympy-12419 | B | no | **F** | **P** | ✓ | yes | 1 | 5 | $1.54 / $3.00 | 34 / 31 | 2 | **new win**; guard fired though M75 didn't predict it |
| django-11815 | C | no | P | P | ✓ | no | 0 | – | $0.37 / $0.44 | 6 / 10 | 0 | protected win preserved |
| django-12273 | C | no | P | P | ✓ | no | 0 | – | $0.47 / $0.54 | 10 / 9 | 1 | protected win preserved |
| astropy-7166 | D | no | P | P | ✓ | no | 0 | – | $0.49 / $0.40 | 8 / 5 | 1 | control preserved (+$0.09, no fire) |
| django-10880 | D | no | P | P | ✓ | no | 0 | – | $0.51 / $0.35 | 11 / 5 | 0 | control preserved (+$0.16, no fire) |

(`tool calls` M77 = ordered tool-call count for the live run; prior = M73 treatment tool_calls. `repeated reads` = redundant same-path read events in the M77 run.)

## Guard Mechanism Analysis

- **Expected vs observed firing (live-vs-M75):**
  - `predicted_fired & live_fired`: `astropy-14598`, `pytest-6197` (2).
  - `predicted_fired & live_no_fire` (trajectory diverged): `django-15503`, `django-16263` (2).
  - `not_predicted & live_fired`: `sympy-12419` (1).
  - `not_predicted & live_no_fire`: `pylint-4551` + all of C, D (5).
  - The guarded live trajectory legitimately diverges from the M75 prediction (computed on the *unguarded* M73 stream). Two predicted cases didn't loop live; one unpredicted case (`sympy-12419`) did loop and the guard fired. So M75 (observe over old streams) is a useful but imperfect predictor of live firing — as designed.
- **Injection marker verification:** all injected messages contained `<VTRACE_TOOL_LOOP_GUARD>` (`guard_marker_verified_all_fired = true`). Metadata internally consistent on all 10 (`guard_metadata_consistent_all = true`): injection_count == events length, first/last turn set iff fired, message count == injection count.
- **Trigger types:** all three live fires were `repeated_read` (same-file re-inspection). No `repeated_command_failure` / `repeated_search` / family-error fires occurred in this slice.
- **Timing:** fires at turns 2, 5, 13 — all early/mid-run, well before the ~$3 cost cap that the prior unguarded runs hit at the end. For `astropy-14598` the turn-13 injection preceded a finish at $1.62 (no cap).
- **Caps / cooldowns:** ≤1 injection per fired case (max 3 configured), respecting once-per-signature + cooldown; no runaway re-injection.
- **Changed-behavior evidence:** runtime hook confirmed live (adapter logged `--settings`; per-run `_tool_loop_guard_state` file accumulated events during each run). On `astropy-14598` the injection demonstrably preceded the cap-avoiding finish; on `pytest-6197` the injection at turn 2 was immediately followed by an edit of the correct gold file (`_pytest/python.py`).

## Targeted Thrash/Cap Cases (Groups A + B)

Per-case before/after is in the Run Matrix. Aggregate over the 3 **guard-fired** targeted cases: mean cost **$1.45 vs $2.58**, mean tool calls **23.3 vs 28.7**, resolved **1 vs 1**.

**Honesty caveat on cost attribution.** Of the 5 expensive targeted cases (4 prior cap-hit + `pytest-6197`), 4 came in below the prior $3 cap, but only **2 of those had a live guard fire** (`astropy-14598`, `sympy-12419`). `django-15503` and `pylint-4551` dropped well below cap with **0 injections** — i.e. via run-to-run trajectory variance, not the guard. So the −41% slice-level cost delta is **partly guard, partly variance** and must not be wholly attributed to the guard. The clean guard-attributable cost win is `astropy-14598` ($3.00 cap → $1.62 after a turn-13 injection).

- **Helped:** `astropy-14598` (fired @13, cap avoided), `sympy-12419` (fired @5, cap avoided **and** newly resolved).
- **Neutral / variance:** `django-15503`, `pylint-4551` (cheaper, no fire).
- **Too late / didn't fire:** `django-16263` — still capped at $3.03 with 36 tool calls and 9 redundant reads, but the redundancy was spread across files so no single `repeated_read` signature crossed the threshold; the guard never fired. **Coverage gap:** the repeated-read detector does not catch multi-file read-twice thrash.
- **Regression:** `pytest-6197` (fired @2, P→F) — see Protected Wins / Controls.

## Protected Wins / Controls

- **Protected treatment-only wins (Group C):** both **preserved** (`django-11815`, `django-12273` P→P), both slightly cheaper, **0 injections**. No harm.
- **Normal controls (Group D):** both **preserved** (`astropy-7166`, `django-10880` P→P), **0 injections**. Cost rose marginally (+$0.09, +$0.16) but the guard did not fire on either, so this is ordinary live variance, not guard-caused. Not material.
- **False-positive behavior:** the guard fired on **0** of the 4 C/D control cases (`any_guard_fired = false`), consistent with the low M75 false-positive rate. No control was steered by an injection.
- **The one regression — `pytest-6197` (Group A, not a protected control):** P→F under a turn-2 injection. The guard fired after 3 redundant reads of `_pytest/python.py` and nudged "stop re-reading; edit the likely target." The agent then edited `_pytest/python.py` — the **correct** gold file — at the very next call. So the guard pushed *toward* the right file, not away; the non-resolution is a patch-quality (not file-selection) failure. The early (turn-2) commitment to an edit cannot be fully exonerated as a contributor, but there is no evidence the guard misdirected the agent. It is a single, non-protected, thrash-classified case, offset by the `sympy-12419` win.

## Success Criteria Check

1. **All/nearly all runs valid** — ✅ 10/10 valid.
2. **Runtime injection actually active** — ✅ `runtime_injection` + hook available on all 10.
3. **Targeted fired cases inject before/during the loop phase** — ✅ fires at turns 2/5/13, before the cap.
4. **Treatment-only win controls not harmed** — ✅ Group C both preserved.
5. **Normal controls not materially harmed** — ✅ Group D both preserved (immaterial cost variance, no fire).
6. **Cost/tool-calls/repeated-reads improve on targeted fired cases** — ✅ mean cost $1.45<$2.58, tool calls 23.3<28.7 (with the variance caveat above).
7. **No new sentinel/contract/gate validity failures** — ✅ 0 invalid; pre-flight clean.
8. **Injected messages logged with stable marker** — ✅ marker verified on all fired cases.
9. **No evidence of guard causing worse patch behavior** — ⚠️ **ambiguous**: `pytest-6197` regressed on a guard-fired case, but the guard nudged toward the correct file; cannot cleanly attribute the regression to the guard, and protected controls were untouched.

8/9 clear pass; criterion 9 is the single ambiguous signal.

## Verdict

**MIXED.**

The mechanism is validated end-to-end: runtime injection is genuinely active (10/10), fires mid-loop with verified markers and consistent metadata, respects caps/cooldowns, and on at least one case (`astropy-14598`) demonstrably converts a $3 cap-hit into a $1.62 finish. Protected wins and normal controls are fully preserved (4/4 P→P), and validity is intact with zero new sentinel/contract/gate failures. However, resolution is **inconclusive** (net 5→5: one new guard-fired win against one ambiguous guard-fired regression), the slice-level cost win is only **partly** guard-attributable (two cap drops had no injection), and there is a **coverage gap** (`django-16263` thrashed past the cap because its redundancy wasn't single-signature repeated-read). This fits MIXED: the guard fires correctly and does no demonstrable harm to the protected set, but its resolution/cost benefit on this 10-case slice is not yet conclusive.

## Recommendation

**Proceed to a larger guarded validation, kept default-off.**

The mechanism and safety (protected set untouched, no validity regressions, capped injection) are demonstrated; what a 10-case slice cannot settle is whether the guard is resolution-neutral or occasionally harmful, and how much of the cost benefit is real vs variance. A larger guarded run (with fresh paired baselines) is the right next step, specifically instrumented to watch (a) the **early-fire regression pattern** seen on `pytest-6197` (consider a minimum-turn or post-first-edit gate before injecting), and (b) the **multi-file read-twice coverage gap** seen on `django-16263`. If the reviewer weights the single regression heavily, the conservative fallback is to **keep the guard observe-only / default-off for diagnostics** until the early-fire gate is added. Under no reading is promotion-to-default warranted from this slice.
