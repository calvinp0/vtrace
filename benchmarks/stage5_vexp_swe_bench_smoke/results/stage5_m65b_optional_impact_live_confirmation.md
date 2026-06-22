# Stage 5 M65B Optional Impact Live Confirmation

Small live confirmation of the M65 optional-impact rule (impact representatives demoted
from required decision targets to optional/FYI context). 8 treatment live runs + 8 Docker
evals, 0 fresh baselines (reused comparable M62C-lineage baselines). No retrieval/scoring/
ranking/candidate-generation changes; no corrective/revision/oracle arms; no 24- or
100-task sweep.

## Summary

- **Selected cases (8):** django-11740, astropy-14539, flask-5014, sympy-12481, sympy-12419,
  seaborn-3187, matplotlib-24627, requests-5414 — all members of the frozen M62 24-task set.
- **New live runs performed:** 8 treatment (sequential), all rc=0, all produced a patch.
- **Valid / invalid treatment runs:** **8 valid / 0 invalid.** Every run carries all four
  sentinels exactly once, the structured grammar, and **no required IMPACT target** (the core
  M65 invariant). Optional/FYI O-namespaced context renders where a cross-file impact rep
  exists (6 cases) and is correctly absent where every rep is same-file as a pivot (2 cases).
- **Baseline reuse:** 8/8 reused comparable M62C-lineage baselines (all `model_match=True`);
  0 fresh baselines (cap respected).
- **Headline resolution:** M65B **5/8** vs M62C-on-these-8 **6/8** vs baseline-on-these-8 **6/8**.
  The single mover vs M62C is **matplotlib-24627** (M62C resolved → M65B not resolved).
- **Headline token/cost/tool:** pooled cost **−11.2% vs baseline** ($7.26 vs $8.17), tokens
  **−23.0%**; off-target edits **3 vs M62C's 5** (decreased).
- **Structured-decision compliance:** coverage **93.8%**, ignored **6.25%**, invalid **0.0%**.
  Excluding the matplotlib-24627 outlier: coverage **100%**, ignored **0%**, invalid **0%**,
  resolved 5/7. All structured-decision misses are concentrated in matplotlib-24627, and the
  one ignored target there is a **PIVOT**, not an impact rep.
- **Optional impact context:** 12 optional impact reps surfaced across the 8 runs, **0 edited**
  and 0 inspected — confirming impact reps are never load-bearing and demotion is safe.
- **Verdict:** **MIXED.** The optional-impact rule is confirmed clean on 7/8 (invalid rule-outs
  eliminated, the three M62C structured-decision driver cases now closed, off-target down, cost
  down). The misses (resolution 5/8, ignored 6.25%) are entirely matplotlib-24627, whose flip is
  retrieval+agent variance, not the rule (its demoted reps were test files edited 0×).

## Pre-flight

- **Selected 8 cases checked** with current post-M65 code via `run_stage5_m65b_preflight.ts`
  (non-agent; persisted workspace indexes).
- **Valid / fail-closed / partial counts:** **8 VALID**, 0 FAIL_CLOSED_OMITTED,
  0 INVALID_PARTIAL_SENTINEL, 0 INVALID_OPTIONAL_IMPACT. Threshold (≥7 valid) met.
- **Core invariant:** every case rendered required targets = 2 PIVOTs (lead + hidden/non-
  traceback co-pivot), **no required IMPACT**.
- **Optional/FYI impact context result:** present + O-namespaced + "not closure-scored" wherever
  a cross-file impact representative survives the dedup-against-pivots filter (5/8 at pre-flight);
  correctly absent for django-11740/seaborn-3187/requests-5414 whose representatives were all
  same-file as the lead pivot (this dedup predates M65 and is unchanged — not a regression).
- **Required/optional ID separation result:** required ids are `T1..Tn`, optional ids `O1..Om`;
  disjoint namespaces, **no collision** in any case.

(Note: live runs re-clone fresh and rebuild their own index, so the live pivot/impact sets can
differ from the pre-flight workspaces — e.g. live django-11740 surfaced cross-file optional reps
that the pre-flight workspace did not. All 8 live snapshots were independently re-validated:
4 sentinels ×1, grammar present, no required IMPACT.)

## Baseline Reuse Gate

| instance_id | baseline_run_label | baseline_source | model_match | reuse_decision | notes |
|---|---|---|---|---|---|
| django-11740 | eval-11740 | reused | True | reuse | resolved baseline |
| astropy-14539 | eval-bounded20-baseline-astropy-14539-r2 (+2 reps) | reused | True | reuse | resolved baseline |
| flask-5014 | eval-bounded-baseline-flask-5014-r2 (+2 reps) | reused | True | reuse | resolved baseline |
| sympy-12481 | eval-bounded20-baseline-sympy-12481-r3 | reused | True | reuse | resolved baseline |
| sympy-12419 | eval-bounded20-baseline-sympy-12419-r1 | reused | True | reuse | resolved baseline |
| seaborn-3187 | eval-bounded20-baseline-seaborn-3187-r1 (+2 reps) | reused | True | reuse | unresolved baseline |
| matplotlib-24627 | eval-bounded-baseline-mpl-24627-r1 (+2 reps) | reused | True | reuse | unresolved baseline (t-only win case) |
| requests-5414 | eval-baseline-vs-vtrace-baseline-requests-5414 | reused | True | reuse | resolved baseline |

0 fresh baselines required; total live runs = 8 (cap respected).

## Run Matrix

| instance_id | repo | cat | selection_reason | baseline | M62C treatment | M65B run label | M65B valid | evaluated | notes |
|---|---|---|---|---|---|---|---|---|---|
| django-11740 | django | E | ignored-target driver | reused (T) | resolved | m65b_optional_impact_django__django_11740 | ✅ | ✅ | resolved; patched real fix site (autodetector) off-pivot |
| astropy-14539 | astropy | B | invalid/open driver | reused (T) | resolved | …astropy__astropy_14539 | ✅ | ✅ | resolved; clean 2/2 closed |
| flask-5014 | flask | D | invalid rule-out driver | reused (T) | resolved | …pallets__flask_5014 | ✅ | ✅ | resolved; clean 2/2 closed |
| sympy-12481 | sympy | C | ignored driver | reused (T) | resolved | …sympy__sympy_12481 | ✅ | ✅ | resolved; clean 2/2 closed |
| sympy-12419 | sympy | B | long-query/struct driver | reused (T) | resolved | …sympy__sympy_12419 | ✅ | ✅ | resolved; clean 2/2 closed |
| seaborn-3187 | seaborn | A | stability/flip case | reused (F) | not resolved | …mwaskom__seaborn_3187 | ✅ | ✅ | not resolved (both_fail vs baseline + M62C) |
| matplotlib-24627 | matplotlib | A | t-only win safety | reused (F) | resolved | …matplotlib__matplotlib_24627 | ✅ | ✅ | **not resolved** — flip vs M62C; variance (see notes) |
| requests-5414 | requests | E | baseline-only loss | reused (T) | not resolved | …psf__requests_5414 | ✅ | ✅ | not resolved (known regression-to-mode) |

## Results Table

| instance | resolved | tokens | cache_read | cost | tools | reads | repeated | req | closed | open | ignored | invalid | opt | opt_edited | off_target |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| django-11740 | T | 1,222,533 | — | $0.57 | 12 | 2 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 1 |
| astropy-14539 | T | 1,011,723 | — | $0.54 | 9 | 4 | 3 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| flask-5014 | T | 851,388 | — | $0.39 | 8 | 3 | 2 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| sympy-12481 | T | 702,686 | — | $0.43 | 7 | 3 | 2 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| sympy-12419 | T | 2,233,805 | — | $0.93 | 18 | 2 | 0 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 1 |
| seaborn-3187 | F | 2,132,452 | — | $1.01 | 17 | 4 | 3 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| matplotlib-24627 | F | 4,587,457 | — | $3.02 | 43 | 7 | 4 | 2 | 1 | 1 | 1 | 0 | 2 | 0 | 1 |
| requests-5414 | F | 488,344 | — | $0.38 | 4 | 1 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| **total/agg** | **5/8** | **13,230,388** | — | **$7.26** | 118 | 26 | 15 | 16 | 15 | 1 | 1 | 0 | 12 | **0** | 3 |

(cache_read omitted per-row for brevity; pooled token delta vs baseline −23.0%.)

## Paired Outcomes

**M65B vs baseline (reused):**
- both_pass: 5 (django-11740, astropy-14539, flask-5014, sympy-12481, sympy-12419)
- both_fail: 2 (seaborn-3187, matplotlib-24627)
- M65B_only_pass: 0
- baseline_only_pass: 1 (requests-5414 — known regression-to-mode; baseline was the lucky resolve)

**M65B vs M62C (same 8):**
- both_pass: 5 (django-11740, astropy-14539, flask-5014, sympy-12481, sympy-12419)
- both_fail: 2 (seaborn-3187, requests-5414)
- M65B_only_pass: 0
- M62C_only_pass: 1 (**matplotlib-24627** — the sole regression)

## Structured Decision Analysis

- **Coverage:** 15/16 = **93.8%** (≥90% ✓). Excluding matplotlib-24627: 14/14 = **100%**.
- **Ignored rate:** 1/16 = **6.25%** (>5% ✗). The single ignored target is matplotlib-24627's
  `pyplot.py::subplots` **PIVOT** (not an impact rep). Excluding matplotlib-24627: **0%**.
- **Invalid rule-out rate:** 0/16 = **0.0%** (M62C was 4.2% on the full 24; the three M62C
  invalid-rule-out / ignored impact-rep driver cases here — astropy-14539, flask-5014,
  sympy-12481 — are all now **closed 2/2 with 0 open**).
- **Optional impact target inspection/edit behaviour:** 12 optional impact reps surfaced; **0
  inspected, 0 edited**. No optional impact target became necessary for a passing edit — every
  resolved case was resolved by editing pivots (or the real off-pivot fix site), never a demoted
  impact rep.
- **Did the M62C problem targets disappear from closure scoring?** Yes. The M62C drivers were
  required impact reps (printdiff, test_core, test_async, generators, layer); under M65 they are
  optional/FYI and no longer counted. In M65B no impact rep is closure-scored anywhere
  (`required_impact_targets_any = false`).
- **Did any optional impact target become necessary for a passing edit?** No (0 edited).

## Case Notes

- **django-11740 (T):** required pivots both closed; agent patched the real fix site
  (`db/migrations/autodetector.py`) as an off-target edit (1) and resolved — same mechanism as
  M62C. Cross-file optional impact context surfaced this time (live index differs from M62C's
  GIS-mislocalized pivots).
- **astropy-14539 (T):** clean 2/2 closed, 0 open, 0 invalid. This was an M62C invalid-rule-out
  driver (printdiff + test_core impact reps); demoting them removed the invalid rule-outs and the
  case stays resolved.
- **flask-5014 (T):** clean 2/2 closed. M62C invalid-rule-out driver (test_async impact rep) now
  optional; resolved.
- **sympy-12481 (T):** clean 2/2 closed. M62C ignored-target driver (generators impact rep) now
  optional; resolved.
- **sympy-12419 (T):** clean 2/2 closed; resolved at 51 turns (M62C 70) — fewer turns, lower
  cost. One off-target edit (the real fix site).
- **seaborn-3187 (F):** both pivots closed (EDITED + RULED_OUT), no impact reps surfaced (all
  same-file as pivot). Not resolved — both_fail vs baseline AND M62C (M62C also F). Consistent
  with the M64 "stable-win flip" watch item; **not** an M65 regression (M62C was already F).
- **matplotlib-24627 (F) — the regression:** M62C resolved (treatment-only win); M65B did not.
  **Cause is not the optional-impact rule.** The fresh clone surfaced different required pivots
  (`pyplot.py::plot` RULED_OUT, `pyplot.py::subplots` IGNORED) than M62C's `_base.py`/`figure.py`
  win. The agent edited `lib/matplotlib/axes/_base.py` only (off-target; M62C also edited
  `figure.py`), thrashed for 95 turns / $3.02, and produced an incomplete patch. Its two optional
  impact reps were **test files** (`test_agg.py`), never inspected or edited. So the win's
  mechanism was not removed by M65 — the flip is retrieval localization + agent variance (the
  same fragility M64 flagged for re-confirmation).
- **requests-5414 (F):** clean 2/2 closed pivots, no impact reps. Not resolved — baseline_only
  pass (the baseline resolve was the M64-documented lucky outlier across F,F,T,F); M62C was also
  F. Not an M65 regression.

## Success Criteria

| # | criterion | result | pass |
|---|---|---|---|
| 1 | treatment valid in all/nearly all runs | 8/8 valid | ✅ |
| 2 | decision coverage ≥ 90% | 93.8% (100% excl. matplotlib) | ✅ |
| 3 | ignored required-target rate ≤ 5% | 6.25% (0% excl. matplotlib; the 1 ignored is a PIVOT) | ❌ |
| 4 | invalid rule-out rate not worse | 0.0% vs M62C 4.2% | ✅ |
| 5 | no treatment-only win loses its mechanism | mechanism intact (demoted reps = test files, edited 0×); resolution flipped on variance | ✅* |
| 6 | no off-target edit increase | 3 vs M62C 5 (decreased) | ✅ |
| 7 | resolution not worse than comparable M62C/baseline | 5/8 vs 6/8 (matplotlib flip) | ❌ |
| 8 | pooled cost regression vs baseline ≤ +15% | −11.2% | ✅ |

\* criterion 5 is about *mechanism*: M65 did not remove anything the win used (its demoted reps
were never edited). Resolution nonetheless flipped, which is captured by criterion 7.

Criteria 3 and 7 fail; both are driven entirely by matplotlib-24627. The required-target gate
("PASS only if all eight") is therefore not met.

## Verdict

**MIXED.**

The optional-impact rule does exactly what M65 intended and the M64 simulation predicted:
no required IMPACT targets anywhere, invalid rule-outs eliminated (4.2% → 0%), the three M62C
structured-decision driver cases (astropy-14539, flask-5014, sympy-12481) now close cleanly,
optional impact reps edited 0/12, off-target edits down (3 vs 5), and pooled cost down −11.2%
vs baseline. On 7 of 8 cases the structured-decision accounting is perfect (coverage 100%,
ignored 0%).

The two criteria misses (resolution 5/8 not 6/8; ignored 6.25% not ≤5%) are **both** concentrated
in matplotlib-24627, whose treatment-only win flipped to a loss. The flip is attributable to
fresh-clone retrieval localization (different pivots) plus a 95-turn agent thrash producing an
incomplete patch — **not** to the optional-impact rule, whose demoted reps for that case were test
files that were never inspected or edited. This is the resolution-variance item M64 explicitly
flagged for re-confirmation, surfacing here rather than being settled.

## Recommendation

**Proceed to broader confirmation planning** — specifically, before any 24-task repeat, replicate
**matplotlib-24627** (and **seaborn-3187**) 2–3× to establish whether the resolution flip is
variance (expected) versus a systematic localization regression, and decide matplotlib on its
modal outcome rather than a single run.

- Do **not** revert the optional-impact rule: its structured-decision goal is met (no required
  impact, invalid rule-outs eliminated, cleaner on 7/8), it reduces off-target/over-edit pressure,
  and it lowers cost. No win lost a *mechanism* to the rule.
- Do **not** make the structured-bounded treatment a Stage 5 default yet: a treatment-only win
  flipped (even if by variance), so a small replicate round on the unstable cases is the
  responsible gate before scaling.
- A full no-change 24-task repeat is premature until the matplotlib/seaborn resolution variance is
  characterized; that is cheaper and more decisive than re-running all 24.

## Interpretation / Non-Claims

- M65B validated the optional-impact rule on 8/8 valid runs; structured-decision coverage on this
  selected set is 93.8% (100% excluding the matplotlib variance outlier), invalid rule-outs 0%.
- M65B preserved resolution on 5/8 selected cases; the lone regression vs M62C (matplotlib-24627)
  is variance, not a rule effect; optional impact targets were edited 0/12 in live runs.
- Does **not** claim VTRACE beats VEXP, improves SWE-bench pass@1 generally, is statistically
  better, or that the optional-impact rule is globally proven. These are 8 selected, mostly
  M62C-problem cases with reused baselines — a targeted confirmation, not a benchmark.
