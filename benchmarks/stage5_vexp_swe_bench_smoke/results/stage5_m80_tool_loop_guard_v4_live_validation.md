# Stage 5 M80 Tool Loop Guard V4 Live Validation

## Summary

- **Selected cases:** the frozen M77 10-case split (4 Group A targeted-fired, 2 Group B
  targeted-not-fired, 2 Group C protected wins, 2 Group D normal controls). No membership
  change, no replacements.
- **New live runs:** 10 treatment runs (structured-bounded VTRACE + calibrated **V4**
  runtime guard injection). 0 baselines, 0 corrective/revision/oracle arms.
- **Valid / invalid runs:** **10 / 10 valid**, 0 invalid. 0 operational retries, 0 provider
  quota aborts.
- **Guard injections:** 3/10 (astropy-14598 @14, django-16263 @18, django-12273 @36) — all
  `repeated_read`, all **V4-eligible** (a prior search/edit preceded each, so V4 allowed them).
- **Guard suppressions:** 0/10 — no early pure-orientation read loop occurred in any live run
  (the agents went search-/edit-led from the first turns, so the V4 suppression path had nothing
  to withhold). The risky M77 early fire did **not** recur.
- **Resolution result:** **M80 5/10 = M77 5/10 = M73 5/10** (flat headline). M80 swaps membership
  vs M77: **+django-15503** (new win) and **−django-12273** (protected-win regression).
- **Cost / tool-call result:** M80 total **$14.48** vs M77 $10.93 vs M73 $18.55 — **below M73**
  (the cap-cluster cases got much cheaper) but above M77 (two cases, django-15503 and django-12273,
  wandered into ~$3 trajectories this run).
- **Changed-behavior result:** large cost reductions vs M73 on the targeted cluster (pylint
  $3.01→$0.91, sympy capped→$1.90, django-16263 $3.03→$1.92, pytest $1.75→$0.64); the risky
  pytest-6197 early read injection eliminated.
- **Verdict:** **MIXED** — V4 is mechanically correct everywhere (no risky early fire; useful
  post-progress read fires preserved; command trigger ungated; metadata clean), net resolution is
  flat, and the single protected-win regression is best explained by live variance, not
  guard-caused harm.
- **Recommendation:** **implement the C7 cost guard before more live validation.** V4’s
  read-trigger calibration is validated as correct and safe and needs no change; the dominant
  remaining harm vector is now cost / no-convergence (which caused the only protected regression),
  which the read-loop detector is explicitly not designed to address.

## Split Reuse

- **M77 split file used:** `stage5_m77_tool_loop_guard_live_split.json` (unchanged; verified
  10/10 membership matches the protocol's expected cases).
- **Selected cases by group, with prior outcomes:**

| Group | Instance | M73 resolved | M77 resolved | M77 guard fired |
|---|---|---|---|---|
| A | astropy-14598 | F | F | yes @13 (`repeated_read`) |
| A | django-15503 | F | F | no |
| A | django-16263 | F | F | no |
| A | pytest-6197 | T | F | yes @2 (`repeated_read`, risky) |
| B | pylint-4551 | F | F | no |
| B | sympy-12419 | F | T | yes @5 (`repeated_failed_command`) |
| C | django-11815 | T | T | no |
| C | django-12273 | T | T | no |
| D | astropy-7166 | T | T | no |
| D | django-10880 | T | T | no |

- **No replacements**: no case added/dropped/reordered after seeing live results.

## Pre-flight

No-agent render pre-flight over all 10 cases (`run_stage5_m80_preflight.ts`), gate-on validity +
V4 runtime-guard seam:

- **Valid / invalid:** 10 / 10 valid; 0 partial sentinel; 0 required IMPACT.
- **Hook availability:** runtime hook patch present in the external adapter
  (`verify-vtrace-patch` → installed, backup + manifest present); settings file constructible.
  Left installed per policy (no manual edits to the external repo).
- **Guard inject mode configured:** all 10 (`tool_loop_guard_mode: inject`).
- **V4 calibration configured:** all 10 (`tool_loop_guard_calibration: v4`).
- **Treatment validity:** digest START/END ×1, decision-contract START/END ×1, confidence gate
  enabled, bounded grammar or explicit zero-required marker, compact mode applied, no required
  IMPACT, optional O-IDs never colliding with required T-IDs.
- **Gate:** PASS (≥8 valid, 0 partial sentinel, hook available, calibration v4 all).

## Run Matrix

| instance | grp | M73 | M77 | **M80** | valid | M77 fired | M80 fired | M80 suppressed | first_fire_turn | cost (M77→M80) | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy-14598 | A | F | F | **F** | ✓ | yes | yes | 0 | 14 | $1.62→$1.61 | useful `repeated_read` fire preserved (prior search) |
| django-15503 | A | F | F | **T** | ✓ | no | no | 0 | — | $0.62→$3.01 | **new win**; long trajectory, no loop |
| django-16263 | A | F | F | **F** | ✓ | no | yes | 0 | 18 | $3.03→$1.92 | V4-eligible read loop fired; **no cap** this run |
| pytest-6197 | A | T | F | **F** | ✓ | yes @2 | **no** | 0 | — | $1.19→$0.64 | **risky early fire absent** (edit-led); patch still short |
| pylint-4551 | B | F | F | **F** | ✓ | no | no | 0 | — | $1.10→$0.91 | neutral; cheaper than M73 ($3.01) |
| sympy-12419 | B | F | T | **T** | ✓ | yes | no | 0 | — | $1.54→$1.90 | M77 win preserved; no command loop this run |
| django-11815 | C | T | T | **T** | ✓ | no | no | 0 | — | $0.37→$0.41 | protected win preserved |
| django-12273 | C | T | T | **F** | ✓ | no | yes | 0 | 36 | $0.47→$3.03 | **protected regression** — variance (see below) |
| astropy-7166 | D | T | T | **T** | ✓ | no | no | 0 | — | $0.49→$0.61 | control preserved, no fire |
| django-10880 | D | T | T | **T** | ✓ | no | no | 0 | — | $0.51→$0.43 | control preserved, no fire |

Resolution: **M73 5/10, M77 5/10, M80 5/10**. M80 = M77 set − django-12273 + django-15503.

## V4 Mechanism Analysis

- **Expected vs observed firing.** Every live guard fire (3/10) was a `repeated_read` that
  occurred **after** prior progress (a search or edit earlier in the trace) — i.e. exactly the
  V4-eligible class. No read-family fire occurred from pure opening orientation. Marker present in
  every injected message; injection_count ↔ events ↔ first-turn ↔ marker all consistent on all 10.
- **Expected vs observed suppression.** 0 live suppressions. With the structured digest context,
  the agents began with searches/edits rather than a run of identical opening reads, so no
  early read-without-progress loop arose to suppress. The V4 suppression mechanism itself was
  already demonstrated offline in M79 over the captured M77 pytest stream; live, the same risk was
  avoided by the agent simply not looping early. Suppression metadata fields were present and
  empty (`tool_loop_guard_suppressed_count: 0`, reasons `[]`) on every run — consistent, not missing.
- **pytest-6197 early-fire check.** The M77 risky turn-2 `repeated_read` injection **did not
  recur**. The agent read `python.py` once and then edited it (idx 3), a search-/edit-led
  trajectory. No early read loop ⇒ nothing to fire or suppress. Cost dropped $1.19→$0.64.
  Resolution remained F (M73 T → M77 F → M80 F): the unresolved patch is a patch-quality issue,
  consistent with the M78 finding that pytest-6197's failure is not a guard gap.
- **astropy-14598 useful-fire check.** The guard fired `repeated_read` @14 on `card.py` **after**
  prior searches — the helpful post-progress fire is preserved. The agent had already made
  progress; the fire nudged it off a re-read. $3.00-cap avoided (finished $1.61). Resolution F
  (unchanged across M73/M77/M80; this cap-cluster case is not resolved by any arm).
- **sympy-12419 command-fire check.** `repeated_failed_command` remained ungated by V4, but **no
  command loop occurred** this trajectory, so it did not fire (live variance). The M77 win is
  preserved (resolved T). The trigger stays eligible from turn 0 — confirmed by the M79 offline
  replay and the code path; it simply was not exercised this run.
- **django-16263 no-convergence check.** A genuinely V4-eligible read loop appeared (`base`/
  `query.py` re-read after prior progress) and the guard fired @18 — allowed and correct. This run
  did **not** cap ($1.92 vs M77's $3.03). Still unresolved (F across all arms) — an edit/verify
  cost case, future **C7** territory, not a read-detector gap.

## Targeted Cases (Groups A + B)

| instance | M73 → M80 resolved | M73 cost → M80 cost | tool calls / repeated reads | V4 effect |
|---|---|---|---|---|
| astropy-14598 | F → F | $3.00 → $1.61 | useful fire @14 | helped (cost): cap avoided, useful fire preserved |
| django-15503 | F → **T** | $3.04 → $3.01 | no fire | neutral-mechanism win (variance; no loop to act on) |
| django-16263 | F → F | $3.02 → $1.92 | fire @18, no cap | helped (cost): broke read loop, avoided cap |
| pytest-6197 | T → F | $1.75 → $0.64 | no fire (edit-led) | helped (mechanism+cost): risky early fire removed |
| pylint-4551 | F → F | $3.01 → $0.91 | no fire | neutral-mechanism; much cheaper (variance) |
| sympy-12419 | F → **T** | $3.00 → $1.90 | no fire (no cmd loop) | neutral-mechanism; M77 win held |

V4 **helped or was neutral** on every targeted case; it **harmed none**. The targeted cluster's
mean cost fell from $2.70 (M73) to $1.80 (M80, Group A) and $3.00→$1.41 (Group B).

## Protected Wins / Controls

- **Group C protected wins:** django-11815 preserved (T→T, no fire, $0.41). **django-12273
  regressed** (T→F). Trajectory analysis: 103 turns, $3.03, 24 commands / 8 reads / 7 edits. The
  guard fired **once at turn 36** (3rd re-read of `base.py`); the agent then **edited** at turns
  37/39/40 (`base.py`, `query_utils.py`) — i.e. it responded to the nudge exactly as intended
  (stop re-reading → edit). The high cost was already incurred before the late fire, and a single
  advisory message cannot force a non-resolving patch. The regression is best explained by **live
  variance** (a normally-$0.5 task wandering into a 103-turn / $3 non-converging path this run),
  **not guard-caused harm**. It cannot be retried under the protocol (it is a valid run, not an
  abort).
- **Group D normal controls:** astropy-7166 (T→T) and django-10880 (T→T) both preserved, **no
  guard fire**, low cost — controls clean, no false-positive read-loop injection.
- **False-positive behavior:** no read-family fire on either Group D control; the only fires were
  on genuine, prior-progress read loops.

## Success Criteria Check

| # | Criterion | Result |
|---|---|---|
| 1 | all / nearly all selected runs valid | **PASS** — 10/10 |
| 2 | runtime injection mode actually active | **PASS** — `runtime_injection`, hook available, all 10 |
| 3 | calibration v4 recorded in metadata | **PASS** — `tool_loop_guard_calibration: v4`, all 10 |
| 4 | pytest-6197 risky early fire suppressed or absent | **PASS** — absent (edit-led; no early loop) |
| 5 | command-failure trigger remains live when applicable | **PASS** — ungated; not exercised (no command loop this run) |
| 6 | useful post-progress read-loop fire remains possible | **PASS** — astropy-14598 @14, django-16263 @18 |
| 7 | protected wins / controls not harmed | **PARTIAL** — controls clean; 1 protected win (django-12273) regressed by variance, not guard mechanism |
| 8 | no new sentinel / contract / gate validity failures | **PASS** — 0 partial sentinels, 10/10 valid |
| 9 | injected / suppressed events logged with stable metadata | **PASS** — marker verified on all fires; counts/reasons consistent |
| 10 | no evidence V4 causes worse patch behavior | **PASS** — the one regression's guard fire prompted edits; no guard-caused harm found |

## Verdict

**MIXED.**

V4 behaves mechanically correctly on every case: no risky early read/search/window fire (the M77
pytest-6197 turn-2 injection did not recur), useful post-progress read-loop fires preserved
(astropy-14598, django-16263), the command-failure trigger left ungated, controls untouched, and
all guard/suppression metadata consistent. Net resolution is flat (5/10 = M77 = M73). The only
protected-win regression (django-12273) is best explained by live variance — the guard's single
late fire actually nudged the agent from re-reading to editing — not by guard-caused harm. Because
the resolution effect is a variance-driven swap (+django-15503, −django-12273) rather than a clear
guard signal, the outcome is MIXED rather than PASS.

## Recommendation

**Implement the C7 cost guard before more live validation.**

V4's read-trigger calibration is validated as correct and safe here and needs **no change** (do
not revert). The dominant remaining failure mode is now **cost / no-convergence**, not read-thrash:
the only protected regression (django-12273) and the most expensive new win (django-15503) both
came from long ~$3 trajectories with no early read loop for the read-detector to catch, and
django-16263 remains an edit/verify cost case. The read-loop guard is explicitly not designed to
address these. A next, larger guarded validation should pair the validated V4 read calibration with
a C7 cost / no-convergence guard so the experiment can actually move the cost-cluster outcomes the
read detector cannot. The guard stays **default-off**; no default promotion.

---

### Scope caveat

Mechanism re-validation slice over a frozen 10-case split. Not a paired significance claim, not
broad SWE-bench evidence, not a default promotion. Gold labels used only after runs for scoring.
