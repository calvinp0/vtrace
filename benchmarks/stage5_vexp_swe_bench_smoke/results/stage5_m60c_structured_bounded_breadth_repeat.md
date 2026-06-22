# Stage 5 M60C Structured Bounded Breadth Repeat

Live **repeat/confirmation** of the M60 pre-registration after the M61 atomic-truncation
fix: **14 structured-bounded treatment runs** (the 14 M60 cases that pass post-M61
pre-flight; the 1 known over-budget outlier `pylint-8898` excluded), all Docker-evaluated,
compared against the **same reused M60B baselines** and against the **M60B treatment** for
stability. Treatment = `vtrace-indexed · force-inject · v2 · debug · 8000 ·
inject-capsule-digest · digest-decision-contract · bounded-digest-decisions ·
compact-digest-injection`. Model `claude-opus-4-5-20251101` (vexp default; runner does not
override; matches all reused baselines and M60B). Full per-instance data in
`stage5_m60c_structured_bounded_breadth_repeat.json`. Not a benchmark; not a pass-rate
claim.

## Summary

- **Fixture task count:** 15 (the pre-registered set).
- **Pre-flight-valid cases:** 14 (post-M61 offline replay; the M61B atomic-truncation
  check).
- **Fail-closed omitted cases:** 1 — `pylint-8898` (digest+contract = 12,803 > 12,000;
  excluded from live runs by pre-flight, exactly as planned).
- **New live runs performed:** **14** (14 treatment, 0 fresh baselines) — under the 15-run
  cap; all exit 0; all Docker-evaluated.
- **Reused baselines:** 14 (same comparators as M60B, all model-matched `opus-4-5`).
  **Fresh baselines:** 0.
- **Valid / invalid treatment runs:** **14 valid / 0 invalid.** Every run carried all four
  sentinels exactly once + structured grammar + bounded three-way + compact + required-target
  count ≤ 4. **No partial sentinel on any case** — the M60B `legacy_slice` contract-eviction
  failure (which invalidated pylint-8898 in M60B) did **not** recur; the M61 atomic fix held
  live across all 14.
- **Headline resolution:** treatment **9/14** vs baseline **7/14** (**+2**). Paired
  (vs baseline): 6 both-pass, 4 both-fail, **3 treatment-only** (sphinx-7462,
  matplotlib-24627, seaborn-3187), **1 baseline-only** (requests-5414).
- **Headline token/cost/tool-turn:** pooled (valid) total tokens **−21.1%**, cache-read
  **−22.1%**, cost **−23.9%** ($8.78 vs $11.53). Median per-case cost **+$0.06** (the M55Z
  pattern: cheaper in aggregate on heavy cases, marginally pricier on light cases).
- **Headline structured-decision compliance:** across the **44** required targets on the
  14 valid runs, **44 closed / 0 open / 0 ignored / 0 invalid** → decision coverage
  **100%**, ignored rate **0.0%** (improves on M60B's 97.7% / 0.0%: django-13195's lone
  M60B open rule-out is closed this draw).
- **Verdict: PASS.** **Recommendation: proceed to a 24-task repeat with this treatment**
  (digest-header compaction for over-budget outliers like pylint is a recommended,
  non-blocking parallel improvement, not a gate).

## Fixture and Pre-flight

- **Fixture path:** `stage5_m60_structured_bounded_breadth_preregistration.json` (15 tasks;
  11 repos; A=4 B=3 D=3 E=3 C=2; locked sentinels sphinx-7462, django-11820, django-13195
  — all present). Consistent.
- **M61B replay path:** `stage5_m61b_m60_budget_replay.json` (14 VALID, 1 FAIL_CLOSED, 0
  partial sentinel). Consistent.
- **15 cases checked (offline, post-M61 code), before any live agent:** 14 VALID, 1
  FAIL_CLOSED_OMITTED.

| case | preflight_status |
|---|---|
| sphinx-doc__sphinx-7462 | VALID |
| django__django-11820 | VALID |
| matplotlib__matplotlib-24627 | VALID |
| mwaskom__seaborn-3187 | VALID |
| pydata__xarray-3677 | VALID |
| astropy__astropy-14539 | VALID |
| **pylint-dev__pylint-8898** | **FAIL_CLOSED_OMITTED (skipped)** |
| django__django-13195 | VALID |
| pallets__flask-5014 | VALID |
| astropy__astropy-14598 | VALID |
| django__django-10880 | VALID |
| psf__requests-5414 | VALID |
| sympy__sympy-16766 | VALID |
| astropy__astropy-14365 | VALID |
| pytest-dev__pytest-7432 | VALID |

- **pylint-8898 skipped?** Yes — FAIL_CLOSED_OMITTED, not run (the known over-budget
  outlier; M61B `digest+contract = 12,803 > 12,000`).
- **Any partial sentinel in pre-flight?** No (0).
- **Any live run before pre-flight?** No — pre-flight ran first; then the 14 valid cases ran
  sequentially. Each live snapshot was independently re-validated post-run: all 14 carried
  exactly one of each sentinel (no partial sentinel anywhere).

## Run Matrix

| instance | repo | cat | preflight | baseline (source) | M60B label | M60C label | M60C valid | evaluated | notes |
|---|---|---|---|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | sphinx | A | VALID | reused (m56c) | m60_…_sphinx_7462 | m60c_…_sphinx_7462 | yes | yes | treatment-only win |
| django__django-11820 | django | A | VALID | reused (m56c) | m60_…_django_11820 | m60c_…_django_11820 | yes | yes | localize-but-fail |
| matplotlib__matplotlib-24627 | matplotlib | A | VALID | reused | m60_…_matplotlib_24627 | m60c_…_matplotlib_24627 | yes | yes | treatment-only win |
| mwaskom__seaborn-3187 | seaborn | A | VALID | reused | m60_…_seaborn_3187 | m60c_…_seaborn_3187 | yes | yes | treatment-only win |
| pydata__xarray-3677 | xarray | B | VALID | reused | m60_…_xarray_3677 | m60c_…_xarray_3677 | yes | yes | both-pass |
| astropy__astropy-14539 | astropy | B | VALID | reused | m60_…_astropy_14539 | m60c_…_astropy_14539 | yes | yes | both-pass |
| pylint-dev__pylint-8898 | pylint | B | **FAIL_CLOSED** | (reused; not used) | m60_…_pylint_8898 (invalid) | — skipped — | — | — | over-budget outlier |
| django__django-13195 | django | D | VALID | reused (m56c) | m60_…_django_13195 | m60c_…_django_13195 | yes | yes | both-fail; cleaner this draw |
| pallets__flask-5014 | flask | D | VALID | reused | m60_…_flask_5014 | m60c_…_flask_5014 | yes | yes | both-pass |
| astropy__astropy-14598 | astropy | D | VALID | reused (m55y) | m60_…_astropy_14598 | m60c_…_astropy_14598 | yes | yes | both-fail; heavy |
| django__django-10880 | django | E | VALID | reused | m60_…_django_10880 | m60c_…_django_10880 | yes | yes | both-pass |
| psf__requests-5414 | requests | E | VALID | reused | m60_…_requests_5414 | m60c_…_requests_5414 | yes | yes | baseline-only |
| sympy__sympy-16766 | sympy | E | VALID | reused | m60_…_sympy_16766 | m60c_…_sympy_16766 | yes | yes | both-pass |
| astropy__astropy-14365 | astropy | C | VALID | reused | m60_…_astropy_14365 | m60c_…_astropy_14365 | yes | yes | both-fail |
| pytest-dev__pytest-7432 | pytest | C | VALID | reused (m55y) | m60_…_pytest_7432 | m60c_…_pytest_7432 | yes | yes | both-pass |

## Results Table

Treatment per-run; `resolved b` = baseline any-replicate resolved. `off` = edits outside
required targets. `clo/opn/ign/inv` = closed/open/ignored/invalid required targets.

| instance | cat | resolved | resolved b | total_tok | cache_rd | cost | tools | reads | srch | rpt | req | clo | opn | ign | inv | off | valid |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | A | ✓ | ✗ | 937,733 | 859,053 | $0.498 | 11 | 2 | 1 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | valid |
| django-11820 | A | ✗ | ✗ | 936,325 | 871,668 | $0.496 | 9 | 2 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | valid |
| matplotlib-24627 | A | ✓ | ✗ | 2,340,072 | 2,235,659 | $0.932 | 23 | 8 | 5 | 3 | 3 | 3 | 0 | 0 | 0 | 2† | valid |
| seaborn-3187 | A | ✓ | ✗ | 1,520,981 | 1,452,408 | $0.700 | 15 | 4 | 4 | 1 | 2 | 2 | 0 | 0 | 0 | 1† | valid |
| xarray-3677 | B | ✓ | ✓ | 943,044 | 884,590 | $0.480 | 9 | 4 | 0 | 0 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| astropy-14539 | B | ✓ | ✓ | 1,086,246 | 1,019,533 | $0.489 | 12 | 1 | 0 | 0 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| django-13195 | D | ✗ | ✗ | 622,919 | 575,723 | $0.378 | 6 | 1 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | valid |
| flask-5014 | D | ✓ | ✓ | 578,414 | 533,623 | $0.337 | 6 | 2 | 0 | 0 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| astropy-14598 | D | ✗ | ✗ | 3,894,822 | 3,744,540 | $2.310 | 29 | 6 | 8 | 4 | 2 | 2 | 0 | 0 | 0 | 0 | valid |
| django-10880 | E | ✓ | ✓ | 625,275 | 580,724 | $0.380 | 6 | 1 | 0 | 0 | 4 | 4 | 0 | 0 | 0 | 1† | valid |
| requests-5414 | E | ✗ | ✓ | 493,609 | 447,892 | $0.399 | 4 | 1 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | valid |
| sympy-16766 | E | ✓ | ✓ | 1,008,238 | 945,000 | $0.526 | 10 | 3 | 0 | 0 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| astropy-14365 | C | ✗ | ✗ | 596,557 | 549,575 | $0.372 | 5 | 1 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | valid |
| pytest-7432 | C | ✓ | ✓ | 885,408 | 829,360 | $0.479 | 10 | 1 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | valid |

† The `off` edits are **correct gold edits not named in the contract's required-target
list**, not over-edits, on **resolved** runs: mpl-24627 `axes/_base.py`+`figure.py` (the
gold fix; digest pivots off-target per M55Z), seaborn `utils.py` (2nd gold file),
django-10880 `aggregates.py` (the gold file; its required-target path differed by spelling).
M60C's total off-target count is **4**, **down from M60B's 6** — django-13195's two M60B
co-edits did not recur this draw (it closed all 3 targets cleanly and edited only the lead
pivot path; still both-fail).

## Paired Outcomes

On the 14 valid M60C runs:

- **baseline vs M60B** (M60B valid set): both_pass 6, both_fail 4, M60B_only_pass 3
  (sphinx, mpl, seaborn), baseline_only_pass 1 (requests-5414).
- **baseline vs M60C:** both_pass 6 (xarray, astropy-14539, flask, django-10880, sympy,
  pytest), both_fail 4 (django-11820, astropy-14598, django-13195, astropy-14365),
  **M60C_only_pass 3** (sphinx-7462, matplotlib-24627, seaborn-3187), **baseline_only_pass
  1** (requests-5414). Net **+2**.
- **M60B vs M60C:** both_pass **9**, both_fail **5**, M60C_only_pass 0, M60B_only_pass 0
  — **every one of the 14 resolution outcomes repeated.**

The baseline-vs-M60C paired result is **identical** to baseline-vs-M60B (same 3
treatment-only wins, same 1 baseline-only loss). sphinx-7462 is the clean
digest-attributable win (lead **and** hidden pivot edited). mpl-24627/seaborn-3187 are
treatment-only over best-of-3 failing baselines (favorable but partly variance).
requests-5414 is the one loss (correct localization, patch-quality variance; reproduces the
M55Z 1→0).

## Paired Deltas

(valid set; baseline = median across reused replicates)

| metric | mean per-case | median per-case | pooled (Σt/Σb) |
|---|---|---|---|
| total_tokens | −315,260 | −36,460 | **−21.1%** |
| cache_read_tokens | −314,226 | −62,375 | **−22.1%** |
| cost (USD) | −0.20 | **+0.06** | **−23.9%** ($8.78 vs $11.53) |
| tool_call_count | −2.14 | — | — |
| resolution | treatment 9 vs baseline 7 (+2) | — | — |
| closed required targets | — | — | **44/44** |
| open required targets | — | — | 0/44 |
| ignored required targets | — | — | **0/44** |
| off-target edits | — | — | 4 (≤ M60B 6; no increase) |

The pooled-vs-median split repeats the M55Z signature: **pooled** cost/tokens fall sharply
(heavy cases — mpl-24627, astropy-14598, seaborn-3187 — much cheaper than their baselines),
while the **median** case is marginally pricier (+$0.06) from the digest's own injected
text. M60C's pooled win (−23.9%) is larger than M60B's (−9.1%) — favourable run-to-run
variance on the heavy cases this draw (e.g. astropy-14598 $2.31 vs M60B $3.07); the
direction is the same.

## Category-Stratified Results

| cat | n (valid) | base→M60B→M60C resolved | M60C-only | baseline-only | coverage | pooled cost% | interpretation |
|---|---|---|---|---|---|---|---|
| A hidden-pivot | 4 | 0→3→3 | sphinx, mpl, seaborn | – | 11/11 | **−47.8%** | **Best stratum, repeated:** +3 resolution and much cheaper. sphinx digest-attributable; mpl/seaborn over failing best-of-3 (partly variance). |
| B nav-heavy | 2 | 2→2→2 | – | – | 8/8 | −2.8% | Resolution held; full coverage. (pylint-8898 excluded — over-budget outlier.) |
| D over-anchor | 3 | 1→1→1 | – | – | 9/9 | −13.4% | flask both-pass; django-13195 both-fail (cleaner this draw, all 3 closed, 0 off); astropy-14598 both-fail & heavy. **No over-anchoring** to non-gold required targets. |
| E baseline-strong | 3 | 3→2→2 | – | requests-5414 | 10/10 | +24.9% | One variance loss (requests-5414, reproduces M55Z). Cost up on **cheap** E baselines (light-case digest overhead, small absolute $), **not** over-exploration; no over-edit (django-10880 edited only gold). |
| C normal | 2 | 1→1→1 | – | – | 6/6 | −11.6% | Neutral controls; coverage full. |

Every stratum repeats its M60B resolution outcome. **Hidden/non-traceback pivot edited on
5/14 valid runs** (sphinx, xarray, astropy-14598, django-13195, pytest) — same magnitude as
M60B. **Impact representatives edited: 0** (no impact-rep over-edit anywhere).

## Stability Analysis (M60B vs M60C)

- **Repeated resolution outcomes:** **14/14** (0 changed). Both passes never flipped to
  fails and vice-versa.
- **Repeated cost-direction (vs baseline):** 13/14 cases kept the same cheaper/pricier
  direction; 1 flipped (seaborn-3187 went from slightly pricier in M60B to cheaper in M60C
  — favourable).
- **Decision-coverage stability:** 97.7% (M60B) → **100%** (M60C). The single M60B
  open/uncredited rule-out (django-13195) is closed this draw. No new opens/ignores.
- **Ignored-target stability:** 0.0% in both M60B and M60C.
- **Off-target-edit stability:** M60B 6 → M60C 4 (no increase; the django-13195 co-edit did
  not recur this draw). E controls flat/down in both.
- **Validity stability:** M60B 14/15 valid (1 truncation-invalid) → M60C **14/14 valid**
  (the truncation failure mode is gone after M61).

## Success Criteria Check

Applying the pre-registered M60 PASS criteria to the **14 valid** M60C runs:

1. **Treatment valid in all or nearly all selected runs** — **PASS:** 14/14 valid (no
   partial-sentinel; M61 fix held live). Stronger than M60B's 14/15.
2. **Resolution not worse than comparable baseline** — **PASS:** 9 vs 7 (+2); identical to
   M60B's valid-set result.
3. **Required-target ignored rate ≤ 5%** — **PASS:** 0.0% (0/44).
4. **Required-target decision coverage ≥ 90%** — **PASS:** 100% (44/44).
5. **No increase in off-target edits vs comparable prior VTRACE artifacts** — **PASS:** 4
   vs M60B's 6; the off edits are correct-gold-not-in-contract on resolved runs; E controls
   flat/down; no over-anchoring.
6. **Pooled cost regression vs baseline ≤ +15%** — **PASS:** −23.9% (a reduction).

All six met, on the strict reading (all runs valid) as well — M60C carries PASS without the
validity caveat that qualified M60B.

## Verdict

**PASS.**

On all 14 valid runs the structured bounded contract: was valid **14/14** (the M60B
truncation invalidation did not recur — M61 held live); closed **44/44** required targets
with **0 ignored** (**100%** coverage); **did not regress resolution** (9 vs 7 baseline,
+2; one variance loss on requests-5414); **reduced pooled cost −23.9%**, cache-read −22.1%,
tokens −21.1%; showed **no over-anchoring** and **no over-edit increase** on the D and E
control strata (off-target edits 4 vs M60B 6); and **repeated every one of M60B's 14
resolution outcomes**. The A stratum is again the standout (+3 resolution, −48% cost). M60C
confirms M60B's favorable result on a second live pass with the atomic-truncation fix in
place and the known over-budget outlier excluded by pre-flight.

## Recommendation

**Proceed to a 24-task repeat with this treatment.**

M60B's recommendation ("proceed to broader confirmation, gated on first fixing the
`legacy_slice` contract-eviction truncation") is now satisfied: M61 fixed the truncation,
M61B confirmed it offline across the M60 set, and M60C confirms it live (14/14 valid, no
partial sentinel, identical favorable result). The treatment is stable and favorable on this
preregistered targeted set, so a 24-task repeat — with the same preregistration discipline
and ideally 2–3 replicates on the A+E strata to absorb the requests-5414-style variance — is
the natural next step before any 100-task planning. **Do not promote the structured bounded
treatment to a Stage 5 default yet.**

One scoped, **non-blocking** parallel improvement is recommended before scaling: **add
digest-header compaction for over-budget outliers** (cap the verbatim issue-description text
in the digest header). pylint-8898 is the sole over-budget case in this set (12,803 chars,
over by only 803; the ~8k issue-description header dominates) and currently fails closed and
is excluded by pre-flight — safe but it reduces valid-N. At 24/100 tasks more large-issue
cases will hit the same fail-closed path; a header cap would recover them without touching
pivots, support, impact, or the decision contract. This is an enhancement to maximize
coverage at scale, **not** a gate on the 24-task repeat.

## Interpretation Rules / Non-Claims

- **Acceptable claims supported here:** the M60C treatment was valid in **14/14** attempted
  runs; **repeated M60B's resolution result on 14/14 comparable cases**; improved resolution
  by **+2 tasks** on this preregistered set (valid subset) against a best-of-replicates
  baseline; changed pooled cost by **−23.9%**; achieved **100%** required-target decision
  coverage and a **0.0%** ignored rate.
- **Not claimed:** VTRACE beats VEXP; VTRACE improves SWE-bench pass@1 generally;
  statistical superiority (single treatment run per case vs reused/best-of-N baselines);
  that the contract *caused* every pass (only sphinx-7462 is mechanistically attributable;
  mpl/seaborn are favorable-but-variance).
- **Method caveats:** baseline resolution is best-of-up-to-3 replicates vs a single
  treatment run (conservative for resolution, noisy per-case); reused baselines span
  milestone families on the same model/harness; no retrieval/scoring/ranking/candidate code
  was changed — differences come from the injected product output and agent behavior. Gold
  labels were read only after runs, for scoring. pylint-8898 was excluded by pre-flight as
  the known over-budget fail-closed outlier.

---

### Provenance

- Pre-flight: `run_stage5_m61b_budget_replay.ts` (offline post-M61 atomic-truncation replay
  over the persisted M60 workspaces; the M61B check).
- Live runs: `run-protocol --protocol vtrace-indexed --context-policy force-inject
  --capsule-engine v2 --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest
  --digest-decision-contract --bounded-digest-decisions --compact-digest-injection` →
  labels `m60c_structured_bounded_<safe>`. Docker evaluate per label.
- Metrics + decision classification: `run_stage5_m58b_analyze.ts` (current
  `classifyDigestDecisionContract` structured-table parser + closed/open partition) over
  `_m60c_logs/spec.json`. Baseline + M60B comparators reused from
  `stage5_m60b_structured_bounded_breadth_live_validation.json` (same reused baselines).
- Compact JSON summary: `stage5_m60c_structured_bounded_breadth_repeat.json`.
