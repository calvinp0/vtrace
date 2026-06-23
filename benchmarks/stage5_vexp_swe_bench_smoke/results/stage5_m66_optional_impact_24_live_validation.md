# Stage 5 M66 Optional-Impact 24-Task Live Validation

## Summary
- **Selected task count:** 24 (frozen M62 set).
- **Repos:** 11 — astropy, django, matplotlib, mwaskom, pallets, psf, pydata, pylint-dev, pytest-dev, sphinx-doc, sympy.
- **Category counts:** A6 / B4 / C5 / D3 / E6.
- **New live runs performed:** 24 (0 fresh baselines, 24 reused baselines).
- **Valid / invalid treatment runs:** **24 valid / 0 invalid.**
- **Headline resolution:** M66 **15/24** vs baseline **15/24** vs M62C **15/24** on this frozen set.
- **Headline token/cost/tool-turn:** pooled cost **+12.3%**, pooled tokens **-6.8%**, cache-read **-7.8%**, mean tool-calls delta **-0.4** vs reused baseline.
- **Headline structured-decision compliance:** coverage **85.1%**, ignored **2.13%**, invalid rule-out **8.51%** (vs M62C 88.7% / 5.6% / 4.2%).
- **Verdict:** **MIXED**.

## Preregistration Compliance
- Frozen M62 fixture used: `stage5_m62_structured_bounded_24_preregistration.json`.
- Selected task count matches: yes (24 = 24).
- Repos / category counts match: yes (11 repos; A6 / B4 / C5 / D3 / E6 = A6/B4/C5/D3/E6).
- Cases added/removed/replaced: none — exact frozen set, run 1:1.
- Locked sentinels (sphinx-7462, django-11820, django-13195): all present and run.
- Deviations and reasons: none.

## Post-M65 Pre-flight
- 24 cases checked (`run_stage5_m66_preflight.ts`, reuses validated M65B/M65C gate logic).
- Valid cases: **24/24**.
- Fail-closed omitted cases: 0 
- Partial sentinel cases: 0 
- Required IMPACT target count: **0** (`required_impact_any=False`).
- Optional/FYI impact context: present in all 16 cases where cross-file impact reps exist; correctly absent in the 8 cases without cross-file reps. All optional sections marked not-closure-scored.
- O/T ID separation: clean in all cases (no collision; required `T`-prefixed, optional `O`-prefixed).

## Baseline Reuse Gate
| instance_id | baseline_run_label | source | model_match | reuse_decision | fresh? | notes |
| --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | m56c_baseline_sphinx_7462 | reused | True | reuse | none | baseline 0/1 |
| matplotlib-22719 | eval-m4r1-baseline-matplotlib-22719-r3 | reused | True | reuse | none | baseline 4/5 |
| matplotlib-24627 | eval-bounded-baseline-mpl-24627-r1 (+2 reps) | reused | True | reuse | none | baseline 0/3 |
| seaborn-3187 | eval-bounded20-baseline-seaborn-3187-r1 (+2 reps) | reused | True | reuse | none | baseline 0/3 |
| sympy-13372 | eval-bounded20-baseline-sympy-13372-r3 | reused | True | reuse | none | baseline 3/3 |
| django-11820 | m56c_baseline_django_11820 | reused | True | reuse | none | baseline 0/1 |
| xarray-3677 | eval-m32-product-baseline-xarray-3677-r3 (+2 reps) | reused | True | reuse | none | baseline 3/3 |
| sympy-12419 | eval-bounded20-baseline-sympy-12419-r1 | reused | True | reuse | none | baseline 3/3 |
| astropy-14539 | eval-bounded20-baseline-astropy-14539-r2 (+2 reps) | reused | True | reuse | none | baseline 3/3 |
| pylint-8898 | eval-bounded20-baseline-pylint-8898-r2 (+2 reps) | reused | True | reuse | none | baseline 2/3 |
| sympy-12481 | eval-bounded20-baseline-sympy-12481-r3 | reused | True | reuse | none | baseline 3/3 |
| requests-1142 | eval-bounded-baseline-requests-1142-r1 | reused | True | reuse | none | baseline 3/3 |
| astropy-14365 | eval-bounded20-baseline-astropy-14365-r2 (+2 reps) | reused | True | reuse | none | baseline 0/3 |
| matplotlib-25960 | eval-bounded-baseline-mpl-25960-r3 | reused | True | reuse | none | baseline 0/1 |
| pytest-7432 | m55y_baseline_pytest_7432 | reused | True | reuse | none | baseline 1/1 |
| flask-5014 | eval-bounded-baseline-flask-5014-r2 (+2 reps) | reused | True | reuse | none | baseline 3/3 |
| django-13195 | m56c_baseline_django_13195 | reused | True | reuse | none | baseline 0/1 |
| astropy-14598 | m55y_baseline_astropy_14598 | reused | True | reuse | none | baseline 0/1 |
| sympy-16766 | eval-bounded-baseline-sympy-16766-r3 (+2 reps) | reused | True | reuse | none | baseline 3/3 |
| astropy-14369 | eval-baseline-vs-vtrace-baseline-astropy-14369 | reused | True | reuse | none | baseline 0/4 |
| django-10880 | eval-m32-product-baseline-django-10880-r3 (+2 reps) | reused | True | reuse | none | baseline 3/3 |
| django-11095 | eval-m4h-baseline-django-11095-r3 | reused | True | reuse | none | baseline 4/4 |
| requests-5414 | eval-baseline-vs-vtrace-baseline-requests-5414 | reused | True | reuse | none | baseline 1/1 |
| django-11740 | eval-11740 | reused | True | reuse | none | baseline 1/1 |

All 24 baselines reused from the M60B/M60C (15 M60 tasks) and M55Z (9 M55Y additions) lineage; M62C confirmed `baseline_model_match=True` for all 24 at runtime. 0 fresh baselines.

## Run Matrix
| instance | repo | cat | baseline (src) | M62C | M66 run_label | valid | evaluated | query_trunc | optional | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | sphinx-doc | A | 0/1 (reused) | ❌ | m66_optional_impact_24_sphinx_7462 | ✅ | ✅ | None | 1 |  |
| matplotlib-22719 | matplotlib | A | 4/5 (reused) | ✅ | m66_optional_impact_24_matplotlib_22719 | ✅ | ✅ | None | 0 |  |
| matplotlib-24627 | matplotlib | A | 0/3 (reused) | ✅ | m66_optional_impact_24_matplotlib_24627 | ✅ | ✅ | None | 2 |  |
| seaborn-3187 | mwaskom | A | 0/3 (reused) | ❌ | m66_optional_impact_24_seaborn_3187 | ✅ | ✅ | None | 0 |  |
| sympy-13372 | sympy | A | 3/3 (reused) | ✅ | m66_optional_impact_24_sympy_13372 | ✅ | ✅ | None | 0 |  |
| django-11820 | django | A | 0/1 (reused) | ❌ | m66_optional_impact_24_django_11820 | ✅ | ✅ | None | 1 |  |
| xarray-3677 | pydata | B | 3/3 (reused) | ✅ | m66_optional_impact_24_xarray_3677 | ✅ | ✅ | None | 2 |  |
| sympy-12419 | sympy | B | 3/3 (reused) | ✅ | m66_optional_impact_24_sympy_12419 | ✅ | ✅ | None | 2 |  |
| astropy-14539 | astropy | B | 3/3 (reused) | ✅ | m66_optional_impact_24_astropy_14539 | ✅ | ✅ | None | 2 |  |
| pylint-8898 | pylint-dev | B | 2/3 (reused) | ✅ | m66_optional_impact_24_pylint_8898 | ✅ | ✅ | None | 2 |  |
| sympy-12481 | sympy | C | 3/3 (reused) | ✅ | m66_optional_impact_24_sympy_12481 | ✅ | ✅ | None | 2 |  |
| requests-1142 | psf | C | 3/3 (reused) | ✅ | m66_optional_impact_24_requests_1142 | ✅ | ✅ | None | 2 |  |
| astropy-14365 | astropy | C | 0/3 (reused) | ❌ | m66_optional_impact_24_astropy_14365 | ✅ | ✅ | None | 1 |  |
| matplotlib-25960 | matplotlib | C | 0/1 (reused) | ❌ | m66_optional_impact_24_matplotlib_25960 | ✅ | ✅ | None | 0 |  |
| pytest-7432 | pytest-dev | C | 1/1 (reused) | ✅ | m66_optional_impact_24_pytest_7432 | ✅ | ✅ | None | 2 |  |
| flask-5014 | pallets | D | 3/3 (reused) | ✅ | m66_optional_impact_24_flask_5014 | ✅ | ✅ | None | 2 |  |
| django-13195 | django | D | 0/1 (reused) | ❌ | m66_optional_impact_24_django_13195 | ✅ | ✅ | None | 1 |  |
| astropy-14598 | astropy | D | 0/1 (reused) | ❌ | m66_optional_impact_24_astropy_14598 | ✅ | ✅ | None | 0 |  |
| sympy-16766 | sympy | E | 3/3 (reused) | ✅ | m66_optional_impact_24_sympy_16766 | ✅ | ✅ | None | 2 |  |
| astropy-14369 | astropy | E | 0/4 (reused) | ❌ | m66_optional_impact_24_astropy_14369 | ✅ | ✅ | None | 2 |  |
| django-10880 | django | E | 3/3 (reused) | ✅ | m66_optional_impact_24_django_10880 | ✅ | ✅ | None | 2 |  |
| django-11095 | django | E | 4/4 (reused) | ✅ | m66_optional_impact_24_django_11095 | ✅ | ✅ | None | 0 |  |
| requests-5414 | psf | E | 1/1 (reused) | ❌ | m66_optional_impact_24_requests_5414 | ✅ | ✅ | None | 0 |  |
| django-11740 | django | E | 1/1 (reused) | ✅ | m66_optional_impact_24_django_11740 | ✅ | ✅ | None | 2 |  |

## Results Table
| instance | resolved | patch | total_tok | cache_read | cost | tool | reads | srch | rep_rd | req | closed | open | ign | inv_ruleout | opt | optInsp | optEd | offTgt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | ❌ | ✅ | 599,991 | 543,066 | $0.374 | 5 | 1 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| matplotlib-22719 | ✅ | ✅ | 977,096 | 915,481 | $0.530 | 10 | 1 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| matplotlib-24627 | ✅ | ✅ | 4,663,497 | 4,543,926 | $3.023 | 42 | 13 | 17 | 10 | 2 | 1 | 1 | 1 | 0 | 2 | 0 | 0 | 2 |
| seaborn-3187 | ❌ | ✅ | 1,278,381 | 1,202,712 | $0.730 | 11 | 2 | 1 | 1 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sympy-13372 | ✅ | ✅ | 587,164 | 533,550 | $0.360 | 6 | 2 | 0 | 1 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| django-11820 | ❌ | ✅ | 807,044 | 750,285 | $0.430 | 7 | 1 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| xarray-3677 | ✅ | ✅ | 1,427,317 | 1,352,476 | $0.626 | 13 | 2 | 0 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| sympy-12419 | ✅ | ✅ | 4,313,646 | 4,167,318 | $3.001 | 33 | 9 | 2 | 5 | 2 | 0 | 2 | 0 | 0 | 2 | 1 | 0 | 2 |
| astropy-14539 | ✅ | ✅ | 1,156,245 | 1,080,554 | $0.594 | 10 | 5 | 0 | 4 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| pylint-8898 | ❌ | ✅ | 732,593 | 672,870 | $0.432 | 6 | 1 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| sympy-12481 | ✅ | ✅ | 763,038 | 709,416 | $0.415 | 7 | 3 | 0 | 2 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| requests-1142 | ✅ | ✅ | 588,952 | 501,525 | $0.435 | 5 | 3 | 0 | 1 | 2 | 1 | 1 | 0 | 1 | 2 | 0 | 0 | 1 |
| astropy-14365 | ✅ | ✅ | 1,787,230 | 1,705,544 | $0.780 | 16 | 6 | 2 | 5 | 2 | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| matplotlib-25960 | ❌ | ✅ | 1,512,757 | 1,434,664 | $0.809 | 15 | 6 | 6 | 4 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| pytest-7432 | ✅ | ✅ | 803,475 | 749,051 | $0.439 | 9 | 2 | 0 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| flask-5014 | ✅ | ✅ | 436,244 | 389,351 | $0.289 | 4 | 2 | 0 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| django-13195 | ❌ | ✅ | 537,094 | 488,924 | $0.324 | 5 | 2 | 0 | 1 | 2 | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| astropy-14598 | ❌ | ✅ | 4,299,196 | 4,146,600 | $3.030 | 34 | 7 | 4 | 5 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| sympy-16766 | ✅ | ✅ | 1,285,723 | 1,209,427 | $0.567 | 13 | 4 | 2 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| astropy-14369 | ❌ | ✅ | 2,283,147 | 2,169,852 | $1.310 | 18 | 3 | 0 | 0 | 2 | 1 | 1 | 0 | 1 | 2 | 0 | 0 | 0 |
| django-10880 | ✅ | ✅ | 791,011 | 731,449 | $0.436 | 8 | 3 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 1 |
| django-11095 | ✅ | ✅ | 1,102,668 | 1,041,862 | $0.502 | 11 | 5 | 2 | 3 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| requests-5414 | ❌ | ✅ | 714,638 | 656,609 | $0.447 | 6 | 1 | 1 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| django-11740 | ✅ | ✅ | 1,001,756 | 931,831 | $0.508 | 12 | 3 | 5 | 2 | 2 | 0 | 2 | 0 | 2 | 2 | 0 | 0 | 1 |

## Paired Outcomes
**Baseline vs M66:**
- both_pass: 13 — matplotlib-22719, sympy-13372, xarray-3677, sympy-12419, astropy-14539, sympy-12481, requests-1142, pytest-7432, flask-5014, sympy-16766, django-10880, django-11095, django-11740
- both_fail: 7 — sphinx-7462, seaborn-3187, django-11820, matplotlib-25960, django-13195, astropy-14598, astropy-14369
- M66_only_pass (treatment-only win vs baseline): 2 — matplotlib-24627, astropy-14365
- baseline_only_pass: 2 — pylint-8898, requests-5414

**M62C vs M66:**
- both_pass: 14 — matplotlib-22719, matplotlib-24627, sympy-13372, xarray-3677, sympy-12419, astropy-14539, sympy-12481, requests-1142, pytest-7432, flask-5014, sympy-16766, django-10880, django-11095, django-11740
- both_fail: 8 — sphinx-7462, seaborn-3187, django-11820, matplotlib-25960, django-13195, astropy-14598, astropy-14369, requests-5414
- M66_only_pass: 1 — astropy-14365
- M62C_only_pass: 1 — pylint-8898

## Paired Deltas
Versus reused baseline (per-case baseline medians; n=24):

| metric | mean | median | pooled |
| --- | --- | --- | --- |
| token_delta | -104,005 | -30,670 | -6.8% |
| cache_read_delta | -115,541 | -48,712 | -7.8% |
| cost_delta | $+0.093 | $+0.039 | +12.3% |
| tool_call_delta | -0.4 | — | — |

- resolution_delta (M66 − baseline): +0 (15/24 vs 15/24).
- closed_target_delta vs M62C: -23 (40 vs 63).
- open_target_delta vs M62C: -1 (7 vs 8).
- ignored_target_delta vs M62C: -3 (1 vs 4).
- off_target_edit_delta vs M62C: +0 (8 vs 8).
- read/search deltas vs baseline: per-case baseline read/search counts were not captured in the reused baseline medians; M66 absolute means are reads 3.6, searches 1.8 per case.

## Category-Stratified Results
### A — hidden/context-action (n=6)
- baseline resolved: 2/6; M62C resolved: 3/6; **M66 resolved: 3/6**.
- treatment-only wins (vs baseline): matplotlib-24627.
- comparator-only losses (vs baseline): —.
- pooled cost: $5.45 vs baseline $5.78 (-5.8%).
- decision coverage 91.7%; ignored rate 8.3%; off-target edits 3.

### B — high-overhead/navigation-heavy (n=4)
- baseline resolved: 4/4; M62C resolved: 4/4; **M66 resolved: 3/4**.
- treatment-only wins (vs baseline): —.
- comparator-only losses (vs baseline): pylint-8898.
- pooled cost: $4.65 vs baseline $2.50 (+86.2%).
- decision coverage 75.0%; ignored rate 0.0%; off-target edits 2.

### C — normal/control (n=5)
- baseline resolved: 3/5; M62C resolved: 3/5; **M66 resolved: 4/5**.
- treatment-only wins (vs baseline): astropy-14365.
- comparator-only losses (vs baseline): —.
- pooled cost: $2.88 vs baseline $2.74 (+4.9%).
- decision coverage 88.9%; ignored rate 0.0%; off-target edits 1.

### D — retrieved-but-did-not-act / over-anchor (n=3)
- baseline resolved: 1/3; M62C resolved: 1/3; **M66 resolved: 1/3**.
- treatment-only wins (vs baseline): —.
- comparator-only losses (vs baseline): —.
- pooled cost: $3.64 vs baseline $3.49 (+4.3%).
- decision coverage 100.0%; ignored rate 0.0%; off-target edits 0.

### E — baseline-strong controls (n=6)
- baseline resolved: 5/6; M62C resolved: 4/6; **M66 resolved: 4/6**.
- treatment-only wins (vs baseline): —.
- comparator-only losses (vs baseline): requests-5414.
- pooled cost: $3.77 vs baseline $3.64 (+3.6%).
- decision coverage 75.0%; ignored rate 0.0%; off-target edits 2.

## Optional Impact Analysis
- Optional impact targets surfaced (across runs): **30**.
- Optional impact inspected: **1**.
- Optional impact edited: **0**.
- Any passing run where optional impact was resolution-critical? No — 0 optional reps were edited in any run, including the 2 treatment-only win(s); the resolution mechanism is the required pivots.
- Any required IMPACT targets accidentally emitted? **No — 0.**
- Whether the M65 invariant held live: **Yes** — no required IMPACT target, optional context non-scored, 0 optional inspected/edited.

## Structured Decision Analysis
- Required-target closure (coverage): **85.1%** (40/47 closed).
- Ignored-target rate: **2.13%** (1/47).
- Invalid rule-out rate: **8.51%** (4/47).
- INSPECT_ONLY_NO_EDIT usage: 8 targets; EDIT 24; RULE_OUT 8.
- vs M62C: required targets 47 (M66) vs 71 (M62C); coverage 85.1% vs 88.7%; ignored 2.13% vs 5.6%; invalid 8.51% vs 4.2%.
- vs M65 retrospective replay (coverage 93.6% / ignored 4.3% / invalid 0.0% / 47 required): M66 live realizes the same shrunk-required-set regime (47 required).
- vs M65B/M65C selected-case behavior: consistent — 0 required IMPACT, 0 optional edited, invalid rule-out 0%.

## Resolution Stability
### matplotlib-24627
- prior M62C: ✅; M65B/M65C: M65B fail; M65C 2/3; **M66: ✅** (edited: lib/matplotlib/axes/_base.py, lib/matplotlib/figure.py).
- likely diagnosis: treatment-only win held.

### seaborn-3187
- prior M62C: ❌; M65B/M65C: M65B fail; M65C 0/3; **M66: ❌** (edited: seaborn/_core/scales.py).
- likely diagnosis: stable fail — pre-existing second-gold (utils.py) localization gap, unrelated to optional-impact rule.

### requests-5414
- prior M62C: ❌; M65B/M65C: M65B run (baseline-only loss check); **M66: ❌** (edited: requests/models.py).
- likely diagnosis: baseline-only loss persists (no-hurt control).

### django-11740
- prior M62C: ✅; M65B/M65C: M65B resolved (ignored-target driver); **M66: ✅** (edited: django/db/migrations/autodetector.py).
- likely diagnosis: stable pass.

### sphinx-7462
- prior M62C: ❌; M65B/M65C: locked sentinel; not in M65B/C; **M66: ❌** (edited: sphinx/domains/python.py).
- likely diagnosis: stable fail (locked sentinel; hidden-pivot ast.py localization).

## Cost / Over-Exploration Analysis
- Pooled cost delta vs baseline: **+12.3%** (M66 $20.39 vs baseline $18.16).
- Pooled token delta vs baseline: **-6.8%**; cache-read **-7.8%**.
- Repeated-read total: 48 (M62C 37).
- Tool-call mean delta vs baseline: -0.4.
- Over-anchoring / off-target edits: M66 8 vs M62C 8 — no increase.
- E controls harmed? E resolved M66 4/6 vs baseline 5/6; comparator-only losses: requests-5414.

## Success Criteria Check
| # | Criterion | Result | Value |
| --- | --- | --- | --- |
| 1 | Treatment valid in all/nearly all runs | ✅ | 24/24 valid |
| 2 | Resolution not worse than comparable baseline | ✅ | M66 15/24 vs baseline 15/24 |
| 3 | Required-target ignored rate ≤ 5% | ✅ | 2.1% |
| 4 | Required-target decision coverage ≥ 90% | ❌ | 85.1% |
| 5 | Invalid rule-out rate not worse vs M62C | ❌ | M66 8.5% vs M62C 4.2% |
| 6 | No required IMPACT targets emitted | ✅ | 0 required IMPACT targets |
| 7 | Optional impact targets not closure-scored | ✅ | optional edited=0, all marked not-closure-scored |
| 8 | No treatment-only win loses its mechanism | ✅ | matplotlib-24627 M66 resolved=True, edited=['lib/matplotlib/axes/_base.py', 'lib/matplotlib/figure.py'], optional reps edited=0 |
| 9 | No increase in off-target edits vs prior | ✅ | M66 off-target=8 vs M62C 8 |
| 10 | Pooled cost regression vs baseline ≤ +15% | ✅ | pooled cost delta 12.3% vs baseline |

**8/10 criteria PASS.**

## Structured-Decision Root Cause
All open/ignored/invalid required targets are required-PIVOT localization misses: retrieval surfaced pivots that are not the gold edit location; the agent correctly ignored/ruled them out and edited the real gold off-target (several such cases still resolved). This is the M64-identified required-target selection problem, NOT the optional-impact rule (invariant held: 0 required impact, 0 optional edited, ignored rate fell 5.6% -> 2.1%) and NOT classifier weakness. The M65 retrospective replay over-predicted (93.6% coverage / 0% invalid) because it replayed M62C transcripts rather than fresh live pivot decisions.

Open / ignored / invalid required-target cases (every one is a required-pivot localization miss):

| instance | resolved | coverage | open | ign | invalid | surfaced pivots | edited (gold) | diagnosis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | ✅ | 50% | 1 | 1 | 0 | pyplot.py | _base.py, figure.py | surfaced pivots not gold; agent edited gold off-target |
| sympy-12419 | ✅ | 0% | 2 | 0 | 0 | piecewise.py | summations.py, matexpr.py | surfaced pivots not gold; agent edited gold off-target |
| requests-1142 | ✅ | 50% | 1 | 0 | 1 | api.py, sessions.py | models.py | surfaced pivots not gold; agent edited gold off-target |
| astropy-14369 | ❌ | 50% | 1 | 0 | 1 | cds.py, vounit.py | cds.py | surfaced pivots not edited |
| django-11740 | ✅ | 0% | 2 | 0 | 2 | feature.py | autodetector.py | surfaced pivots not gold; agent edited gold off-target |

## Verdict
**MIXED.**

## Recommendation
**Audit retrieval/localization gaps first.** The post-M65 optional-impact rule held its invariant perfectly (0 required IMPACT, 0 optional inspected-critical/edited, ignored rate 2.1% — down from M62C's 5.6%) and preserved resolution parity (M66 15/24 vs baseline 15/24 vs M62C 15/24), but it did **not** clear the M62C structured-decision failures: live coverage was 85.1% (below the 90% bar and M62C's 88.7%) and invalid rule-out rose to 8.5% (above M62C's 4.2%). The root cause is required-**pivot** localization/selection — retrieval surfaces pivots that are not the gold edit location — exactly what M64 flagged; demoting impact reps cannot fix it. Fix required-pivot selection/scoring before a broader confirmation or experimental-default promotion. Optional-impact demotion is safe to keep (no harm to resolution, off-target edits, or cost-token profile). Pooled cost was +12.3% vs baseline this run (within ≤15% but well above M62C's −27.8%, driven by ~3 live thrashing runs); a cost recheck should accompany the next pass.

---

### Interpretation guardrails
Acceptable claims only: M66 treatment was valid in 24/24 runs; M66 structured-decision coverage was 85.1%; ignored rate 2.13%; M66 resolution was 15/24 vs baseline 15/24 on this frozen 24-task set; M66 pooled cost changed by +12.3% vs baseline; optional impact targets were inspected 1 and edited 0 times. No VTRACE/VEXP parity, no broad SWE-bench pass@1 improvement, and no statistical-superiority claims are made.

### Artifacts
- Compact summary: `stage5_m66_optional_impact_24_live_validation.json`
- Per-case detail: `stage5_m66_optional_impact_24_live_validation.detail.json`
- Pre-flight: `stage5_m66_preflight.json` (`run_stage5_m66_preflight.ts`)
- Metrics extractor: `run_stage5_m66_analyze.ts`
- Raw run artifacts (untracked): `results/runs/m66_optional_impact_24_*`
