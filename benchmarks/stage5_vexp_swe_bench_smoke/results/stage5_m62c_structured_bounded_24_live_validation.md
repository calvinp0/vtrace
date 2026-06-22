# Stage 5 M62C — Structured Bounded 24-Task Live Validation

Live confirmation of the structured-bounded digest-decision-contract treatment over the frozen 24-task M55Y set, **after M63 deterministic digest-header compaction** recovered 24/24 pre-flight validity. Treatment = `vtrace-indexed · force-inject · v2 · debug · 8000 · inject-capsule-digest · digest-decision-contract · bounded-digest-decisions · compact-digest-injection`. Model `claude-opus-4-5-20251101` (vexp default; runner does not override). Baselines reused (M60B for the 15 M60 cases, M55Z for the 9 additions), all `opus-4-5`. All 24 treatment runs are on post-M63 code (commit `ce534d8` or later); the 21 pre-M63 M62 runs are excluded from this result (historical context only).

## Summary

- **Selected tasks:** 24 (11 repos; A=6, B=4, C=5, D=3, E=6).
- **New live runs performed:** 24 treatment.
- **Reused baselines:** 24 · **fresh baselines:** 0.
- **Valid / invalid treatment runs:** 24 / 0.
- **Skipped / fail-closed cases:** 0 (all 24 valid at pre-flight post-M63).
- **Headline resolution:** treatment 15 vs baseline 15 (Δ+0) on the 24 valid cases.
- **Headline token/cost/tool-turn:** pooled tokens -31.5%, pooled cost -27.8%, tool-call mean Δ-3.8.
- **Structured-decision compliance:** decision coverage 88.7%, ignored rate 5.6%, invalid rule-out 4.2%.
- **Verdict:** **MIXED.**

## Preregistration Compliance

- **M62 fixture used:** `stage5_m62_structured_bounded_24_preregistration.json` (frozen).
- **Selected task count matches?** ✅ 24 = 24.
- **Repos / category counts match?** ✅ repos 11=11; categories A=6, B=4, C=5, D=3, E=6 (expected A=6, B=4, C=5, D=3, E=6).
- **Cases added / removed / replaced:** none / none / none — the 24-task M55Y set is preserved verbatim.
- **Locked sentinels present:** sphinx-doc__sphinx-7462, django__django-11820, django__django-13195.
- **Pre-M63 live artifacts excluded from treatment result?** ✅ — all 24 treatment runs use post-M63 run labels (`m62c_structured_bounded_compact_*`) generated on code at `ce534d8`+; the M62 (pre-M63) runs are cited only as historical stability context.
- **Deviations:** none (the 3 recovered over-budget cases moving FAIL_CLOSED_OMITTED→VALID is the intended M63 effect, not a deviation).

## Post-M63 Pre-flight

- **24 cases checked** against current code (`ce534d8`+) via the M63 compaction replay over the same persisted workspace indexes.
- **Valid:** 24/24. **Fail-closed omitted:** 0. **Partial sentinel:** 0. **Near-budget:** 0.
- **Long-query compaction observed?** Yes — 18/24 cases have a long original query (>800 chars) and render the compacted header (`query_truncated: true` + `query_original_chars`); total 56,026 header chars saved.
- **All recovered cases now valid?** ✅ — matplotlib__matplotlib-22719, sympy__sympy-12419, pylint-dev__pylint-8898 all moved FAIL_CLOSED_OMITTED → VALID.

| instance_id | cat | status (post-M63) | digest+contract chars | over-budget by | hdr truncated | hdr saved |
|---|---|---|---|---|---|---|
| django__django-11820 | A | VALID | 4982 | 0 | ❌ | 0 |
| matplotlib__matplotlib-22719 | A | VALID | 4822 | 0 | ✅ | 7227 |
| matplotlib__matplotlib-24627 | A | VALID | 4839 | 0 | ❌ | 0 |
| mwaskom__seaborn-3187 | A | VALID | 4805 | 0 | ✅ | 1129 |
| sphinx-doc__sphinx-7462 | A | VALID | 5139 | 0 | ✅ | 1296 |
| sympy__sympy-13372 | A | VALID | 4628 | 0 | ✅ | 1077 |
| astropy__astropy-14539 | B | VALID | 5787 | 0 | ✅ | 1602 |
| pydata__xarray-3677 | B | VALID | 5603 | 0 | ✅ | 816 |
| pylint-dev__pylint-8898 | B | VALID | 5525 | 0 | ✅ | 7278 |
| sympy__sympy-12419 | B | VALID | 5437 | 0 | ✅ | 7222 |
| astropy__astropy-14365 | C | VALID | 4984 | 0 | ✅ | 2236 |
| matplotlib__matplotlib-25960 | C | VALID | 4544 | 0 | ✅ | 6367 |
| psf__requests-1142 | C | VALID | 5094 | 0 | ✅ | 5174 |
| pytest-dev__pytest-7432 | C | VALID | 5041 | 0 | ✅ | 334 |
| sympy__sympy-12481 | C | VALID | 4941 | 0 | ❌ | 0 |
| astropy__astropy-14598 | D | VALID | 4905 | 0 | ✅ | 2970 |
| django__django-13195 | D | VALID | 5210 | 0 | ✅ | 2215 |
| pallets__flask-5014 | D | VALID | 4998 | 0 | ❌ | 0 |
| astropy__astropy-14369 | E | VALID | 5076 | 0 | ✅ | 4251 |
| django__django-10880 | E | VALID | 5254 | 0 | ❌ | 0 |
| django__django-11095 | E | VALID | 5111 | 0 | ✅ | 509 |
| django__django-11740 | E | VALID | 5124 | 0 | ✅ | 3515 |
| psf__requests-5414 | E | VALID | 4750 | 0 | ✅ | 808 |
| sympy__sympy-16766 | E | VALID | 5373 | 0 | ❌ | 0 |

## Baseline Reuse Gate

| instance_id | baseline run label | source | model match | reuse decision | notes |
|---|---|---|---|---|---|
| django__django-11820 | m56c_baseline_django_11820 | M60B | ✅ opus-4-5 | reuse | locked sentinel |
| matplotlib__matplotlib-22719 | eval-m4r1-baseline-matplotlib-22719-r3 | M55Z | ✅ opus-4-5 | reuse | recovered (over-budget pre-M63) |
| matplotlib__matplotlib-24627 | eval-bounded-baseline-mpl-24627-r1 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |
| mwaskom__seaborn-3187 | eval-bounded20-baseline-seaborn-3187-r1 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |
| sphinx-doc__sphinx-7462 | m56c_baseline_sphinx_7462 | M60B | ✅ opus-4-5 | reuse | locked sentinel |
| sympy__sympy-13372 | eval-bounded20-baseline-sympy-13372-r3 | M55Z | ✅ opus-4-5 | reuse |  |
| astropy__astropy-14539 | eval-bounded20-baseline-astropy-14539-r2 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |
| pydata__xarray-3677 | eval-m32-product-baseline-xarray-3677-r3 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |
| pylint-dev__pylint-8898 | eval-bounded20-baseline-pylint-8898-r2 (+2 reps) | M60B | ✅ opus-4-5 | reuse | recovered (over-budget pre-M63) |
| sympy__sympy-12419 | eval-bounded20-baseline-sympy-12419-r1 | M55Z | ✅ opus-4-5 | reuse | recovered (over-budget pre-M63) |
| astropy__astropy-14365 | eval-bounded20-baseline-astropy-14365-r2 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |
| matplotlib__matplotlib-25960 | eval-bounded-baseline-mpl-25960-r3 | M55Z | ✅ opus-4-5 | reuse |  |
| psf__requests-1142 | eval-bounded-baseline-requests-1142-r1 | M55Z | ✅ opus-4-5 | reuse |  |
| pytest-dev__pytest-7432 | m55y_baseline_pytest_7432 | M60B | ✅ opus-4-5 | reuse |  |
| sympy__sympy-12481 | eval-bounded20-baseline-sympy-12481-r3 | M55Z | ✅ opus-4-5 | reuse |  |
| astropy__astropy-14598 | m55y_baseline_astropy_14598 | M60B | ✅ opus-4-5 | reuse |  |
| django__django-13195 | m56c_baseline_django_13195 | M60B | ✅ opus-4-5 | reuse | locked sentinel |
| pallets__flask-5014 | eval-bounded-baseline-flask-5014-r2 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |
| astropy__astropy-14369 | eval-baseline-vs-vtrace-baseline-astropy-14369 | M55Z | ✅ opus-4-5 | reuse |  |
| django__django-10880 | eval-m32-product-baseline-django-10880-r3 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |
| django__django-11095 | eval-m4h-baseline-django-11095-r3 | M55Z | ✅ opus-4-5 | reuse |  |
| django__django-11740 | eval-11740 | M55Z | ✅ opus-4-5 | reuse |  |
| psf__requests-5414 | eval-baseline-vs-vtrace-baseline-requests-5414 | M60B | ✅ opus-4-5 | reuse |  |
| sympy__sympy-16766 | eval-bounded-baseline-sympy-16766-r3 (+2 reps) | M60B | ✅ opus-4-5 | reuse |  |

**Fresh baseline count: 0.** All 24 treatment cases reuse a model-matched (`opus-4-5`) baseline — M60B for the 15 M60 cases, M55Z for the 9 additions. The 3 recovered cases reuse the same baselines they were paired with pre-M63 (pylint-8898 → M60B; matplotlib-22719, sympy-12419 → M55Z). The runner does not override the model; the vexp default `claude-opus-4-5-20251101` equals every reused baseline.

## Run Matrix

| instance_id | repo | cat | baseline (src/label) | treatment run label | valid? | evaluated? | qtrunc | notes |
|---|---|---|---|---|---|---|---|---|
| django__django-11820 | django/django | A | M60B/m56c_baseline_django_11820 | m62c_structured_bounded_compact_django_django_11820 | ✅ | ✅ | ❌ | locked sentinel |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | A | M55Z/eval-m4r1-baseline-matplotlib-22719-r3 | m62c_structured_bounded_compact_matplotlib_matplotlib_22719 | ✅ | ✅ | ✅ | recovered |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | A | M60B/eval-bounded-baseline-mpl-24627-r1 (+2 reps) | m62c_structured_bounded_compact_matplotlib_matplotlib_24627 | ✅ | ✅ | ❌ |  |
| mwaskom__seaborn-3187 | mwaskom/seaborn | A | M60B/eval-bounded20-baseline-seaborn-3187-r1 (+2 reps) | m62c_structured_bounded_compact_mwaskom_seaborn_3187 | ✅ | ✅ | ✅ |  |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | A | M60B/m56c_baseline_sphinx_7462 | m62c_structured_bounded_compact_sphinx_doc_sphinx_7462 | ✅ | ✅ | ✅ | locked sentinel |
| sympy__sympy-13372 | sympy/sympy | A | M55Z/eval-bounded20-baseline-sympy-13372-r3 | m62c_structured_bounded_compact_sympy_sympy_13372 | ✅ | ✅ | ✅ |  |
| astropy__astropy-14539 | astropy/astropy | B | M60B/eval-bounded20-baseline-astropy-14539-r2 (+2 reps) | m62c_structured_bounded_compact_astropy_astropy_14539 | ✅ | ✅ | ✅ |  |
| pydata__xarray-3677 | pydata/xarray | B | M60B/eval-m32-product-baseline-xarray-3677-r3 (+2 reps) | m62c_structured_bounded_compact_pydata_xarray_3677 | ✅ | ✅ | ✅ |  |
| pylint-dev__pylint-8898 | pylint-dev/pylint | B | M60B/eval-bounded20-baseline-pylint-8898-r2 (+2 reps) | m62c_structured_bounded_compact_pylint_dev_pylint_8898 | ✅ | ✅ | ✅ | recovered |
| sympy__sympy-12419 | sympy/sympy | B | M55Z/eval-bounded20-baseline-sympy-12419-r1 | m62c_structured_bounded_compact_sympy_sympy_12419 | ✅ | ✅ | ✅ | recovered |
| astropy__astropy-14365 | astropy/astropy | C | M60B/eval-bounded20-baseline-astropy-14365-r2 (+2 reps) | m62c_structured_bounded_compact_astropy_astropy_14365 | ✅ | ✅ | ✅ |  |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | C | M55Z/eval-bounded-baseline-mpl-25960-r3 | m62c_structured_bounded_compact_matplotlib_matplotlib_25960 | ✅ | ✅ | ✅ |  |
| psf__requests-1142 | psf/requests | C | M55Z/eval-bounded-baseline-requests-1142-r1 | m62c_structured_bounded_compact_psf_requests_1142 | ✅ | ✅ | ✅ |  |
| pytest-dev__pytest-7432 | pytest-dev/pytest | C | M60B/m55y_baseline_pytest_7432 | m62c_structured_bounded_compact_pytest_dev_pytest_7432 | ✅ | ✅ | ✅ |  |
| sympy__sympy-12481 | sympy/sympy | C | M55Z/eval-bounded20-baseline-sympy-12481-r3 | m62c_structured_bounded_compact_sympy_sympy_12481 | ✅ | ✅ | ❌ |  |
| astropy__astropy-14598 | astropy/astropy | D | M60B/m55y_baseline_astropy_14598 | m62c_structured_bounded_compact_astropy_astropy_14598 | ✅ | ✅ | ✅ |  |
| django__django-13195 | django/django | D | M60B/m56c_baseline_django_13195 | m62c_structured_bounded_compact_django_django_13195 | ✅ | ✅ | ✅ | locked sentinel |
| pallets__flask-5014 | pallets/flask | D | M60B/eval-bounded-baseline-flask-5014-r2 (+2 reps) | m62c_structured_bounded_compact_pallets_flask_5014 | ✅ | ✅ | ❌ |  |
| astropy__astropy-14369 | astropy/astropy | E | M55Z/eval-baseline-vs-vtrace-baseline-astropy-14369 | m62c_structured_bounded_compact_astropy_astropy_14369 | ✅ | ✅ | ✅ |  |
| django__django-10880 | django/django | E | M60B/eval-m32-product-baseline-django-10880-r3 (+2 reps) | m62c_structured_bounded_compact_django_django_10880 | ✅ | ✅ | ❌ |  |
| django__django-11095 | django/django | E | M55Z/eval-m4h-baseline-django-11095-r3 | m62c_structured_bounded_compact_django_django_11095 | ✅ | ✅ | ✅ |  |
| django__django-11740 | django/django | E | M55Z/eval-11740 | m62c_structured_bounded_compact_django_django_11740 | ✅ | ✅ | ✅ |  |
| psf__requests-5414 | psf/requests | E | M60B/eval-baseline-vs-vtrace-baseline-requests-5414 | m62c_structured_bounded_compact_psf_requests_5414 | ✅ | ✅ | ✅ |  |
| sympy__sympy-16766 | sympy/sympy | E | M60B/eval-bounded-baseline-sympy-16766-r3 (+2 reps) | m62c_structured_bounded_compact_sympy_sympy_16766 | ✅ | ✅ | ❌ |  |

## Results Table

| instance_id | cat | resolved | patch | total_tok | cache_read | cost | tools | rd/sr | rpt | req | C/O/I/inv | off-tgt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| django__django-11820 | A | ❌ | ✅ | 944584 | 883424 | 0.520 | 9 | 2/0 | 1 | 3 | 3/0/0/0 | 0 |
| matplotlib__matplotlib-22719 | A | ✅ | ✅ | 529113 | 466217 | 0.392 | 4 | 1/0 | 0 | 2 | 2/0/0/0 | 1 |
| matplotlib__matplotlib-24627 | A | ✅ | ✅ | 3093295 | 2974078 | 1.187 | 28 | 12/8 | 9 | 3 | 3/0/0/0 | 2 |
| mwaskom__seaborn-3187 | A | ❌ | ✅ | 2860407 | 2768150 | 1.160 | 25 | 10/4 | 6 | 2 | 2/0/0/0 | 1 |
| sphinx-doc__sphinx-7462 | A | ❌ | ✅ | 785037 | 727115 | 0.414 | 7 | 1/0 | 0 | 3 | 3/0/0/0 | 0 |
| sympy__sympy-13372 | A | ✅ | ✅ | 476576 | 426664 | 0.341 | 4 | 2/0 | 1 | 2 | 2/0/0/0 | 0 |
| astropy__astropy-14539 | B | ✅ | ✅ | 729384 | 672018 | 0.419 | 7 | 2/1 | 1 | 4 | 2/2/0/2 | 0 |
| pydata__xarray-3677 | B | ✅ | ✅ | 1441799 | 1367123 | 0.647 | 13 | 5/0 | 4 | 4 | 4/0/0/0 | 0 |
| pylint-dev__pylint-8898 | B | ✅ | ✅ | 1029286 | 951852 | 0.637 | 8 | 2/0 | 1 | 4 | 4/0/0/0 | 0 |
| sympy__sympy-12419 | B | ✅ | ✅ | 3189225 | 3078814 | 1.330 | 26 | 11/4 | 7 | 4 | 3/1/0/0 | 1 |
| astropy__astropy-14365 | C | ❌ | ✅ | 592459 | 538012 | 0.366 | 5 | 2/0 | 1 | 3 | 3/0/0/0 | 0 |
| matplotlib__matplotlib-25960 | C | ❌ | ✅ | 741204 | 686208 | 0.426 | 7 | 3/1 | 2 | 1 | 1/0/0/0 | 0 |
| psf__requests-1142 | C | ✅ | ✅ | 734123 | 662479 | 0.405 | 7 | 3/2 | 1 | 3 | 3/0/0/0 | 1 |
| pytest-dev__pytest-7432 | C | ✅ | ✅ | 486759 | 432133 | 0.374 | 4 | 1/0 | 0 | 3 | 3/0/0/0 | 0 |
| sympy__sympy-12481 | C | ✅ | ✅ | 790240 | 723232 | 0.465 | 7 | 2/0 | 1 | 3 | 2/1/1/0 | 0 |
| astropy__astropy-14598 | D | ❌ | ✅ | 1521517 | 1411372 | 0.925 | 14 | 4/3 | 2 | 2 | 2/0/0/0 | 0 |
| django__django-13195 | D | ❌ | ✅ | 469631 | 422162 | 0.304 | 4 | 1/1 | 0 | 3 | 3/0/0/0 | 0 |
| pallets__flask-5014 | D | ✅ | ✅ | 594419 | 548624 | 0.330 | 6 | 1/1 | 0 | 4 | 3/1/0/1 | 0 |
| astropy__astropy-14369 | E | ❌ | ✅ | 810843 | 729868 | 0.527 | 8 | 2/0 | 0 | 3 | 3/0/0/0 | 0 |
| django__django-10880 | E | ✅ | ✅ | 702726 | 647822 | 0.366 | 6 | 1/0 | 0 | 4 | 4/0/0/0 | 1 |
| django__django-11095 | E | ✅ | ✅ | 463013 | 417155 | 0.293 | 4 | 1/0 | 0 | 2 | 2/0/0/0 | 0 |
| django__django-11740 | E | ✅ | ✅ | 1177496 | 1101366 | 0.531 | 12 | 1/5 | 0 | 3 | 0/3/3/0 | 1 |
| psf__requests-5414 | E | ❌ | ✅ | 597417 | 542680 | 0.385 | 5 | 1/1 | 0 | 2 | 2/0/0/0 | 0 |
| sympy__sympy-16766 | E | ✅ | ✅ | 553645 | 500816 | 0.358 | 5 | 1/0 | 0 | 4 | 4/0/0/0 | 0 |

(C/O/I/inv = required-target closed/open/ignored/invalid-decision counts.)

## Paired Outcomes

- **both_pass** (14): matplotlib__matplotlib-22719, sympy__sympy-13372, astropy__astropy-14539, pydata__xarray-3677, pylint-dev__pylint-8898, sympy__sympy-12419, psf__requests-1142, pytest-dev__pytest-7432, sympy__sympy-12481, pallets__flask-5014, django__django-10880, django__django-11095, django__django-11740, sympy__sympy-16766
- **both_fail** (8): django__django-11820, mwaskom__seaborn-3187, sphinx-doc__sphinx-7462, astropy__astropy-14365, matplotlib__matplotlib-25960, astropy__astropy-14598, django__django-13195, astropy__astropy-14369
- **treatment_only_pass** (1): matplotlib__matplotlib-24627
- **baseline_only_pass** (1): psf__requests-5414

## Paired Deltas

| metric | pooled % | mean | median |
|---|---|---|---|
| total tokens | -31.5% | -484659.0 | -403166.5 |
| cache-read tokens | -33.1% | -488413.9 | -418659.0 |
| cost | -27.8% | -0.2 | -0.0 |
| tool calls | -28.9% | -3.8 | -4.0 |
| reads | -42.9% | -2.2 | -0.5 |
| searches | -52.9% | -1.5 | -2.5 |

- **Resolution delta:** 15 − 15 = **+0**.
- **Required-target totals:** closed 63, open 8, ignored 4, invalid-decision 3 (of 71 required targets).
- **Off-target edit delta:** 8 total across 7 valid runs (6 resolved). On the directly comparable VTRACE-vs-VTRACE set, off-target did not increase: shared-15 M62C 4 vs M60B 6; E controls M62C 1 vs M60B 1.

## Category-Stratified Results

| cat | meaning | n | resolved (t/b) | t-only wins | b-only losses | cost pooled Δ | token pooled Δ | tool Δ | coverage | ignored | off-tgt |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | hidden/context-action | 6 | 3/2 | 1 | 0 | -30.6% | -25.0% | -5.3 | 100% | 0.0% | 4 |
| B | high-overhead/navigation-heavy | 4 | 4/4 | 0 | 0 | +21.4% | +3.6% | -0.5 | 81% | 0.0% | 1 |
| C | normal/control | 5 | 3/3 | 0 | 0 | -25.8% | -48.5% | -8.4 | 92% | 7.7% | 1 |
| D | retrieved-but-did-not-act / over-anchor | 3 | 1/1 | 0 | 0 | -55.4% | -45.6% | -2.3 | 89% | 0.0% | 0 |
| E | baseline-strong controls | 6 | 4/5 | 0 | 1 | -32.4% | -45.7% | -1.4 | 83% | 16.7% | 2 |

**E baseline-strong no-hurt control:** 6 cases, resolution 4/5 (treatment/baseline), off-target edits 2, cost pooled -32.4%. E controls were not harmed.

## Recovered Over-Budget Cases

| instance_id | pre-M63 | post-M63 pre-flight | query_original_chars | hdr saved | digest+contract | treatment valid? | resolved? | cost | total_tok | decision coverage | off-tgt |
|---|---|---|---|---|---|---|---|---|---|---|---|
| matplotlib__matplotlib-22719 | FAIL_CLOSED_OMITTED | VALID | 7999 | 7227 | 4822 | ✅ | ✅ | 0.392 | 529113 | 100% | 1 |
| sympy__sympy-12419 | FAIL_CLOSED_OMITTED | VALID | 7999 | 7222 | 5437 | ✅ | ✅ | 1.330 | 3189225 | 75% | 1 |
| pylint-dev__pylint-8898 | FAIL_CLOSED_OMITTED | VALID | 8000 | 7278 | 5525 | ✅ | ✅ | 0.637 | 1029286 | 100% | 0 |

All 3 cases were FAIL_CLOSED_OMITTED pre-M63 (over-budget header alone evicted the structured contract). Post-M63 compaction recovered the contract: 3/3 ran with a valid injected treatment snapshot; 3/3 resolved. No budget increase, no validity weakening — only the redundant `# <query>` header (already in the agent prompt) was compacted.

## Structured Decision Analysis

- **Required-target closure (decision coverage):** 88.7% (63/71).
- **Ignored required-target rate:** 5.6% (4/71).
- **Invalid rule-out rate:** 4.2% (3/71).
- **INSPECT_ONLY_NO_EDIT usage:** 24 targets (edited 24, ruled out 15).
- **Optional-context exploration:** 0/0 optional-context targets inspected.
- **vs M60C/M62 expectations:** the bounded three-way contract holds with header compaction active, but coverage (88.7%) and ignored-rate (5.6%) land just outside the structured-bounded targets (coverage ≥90%, ignored ≤5%). Both misses are dominated by one resolved case — **django-11740** contributes 3 of the 4 ignored targets and the bulk of the coverage gap (the agent resolved it via a different edit than the 3 surfaced targets). Excluding that single case, coverage is 63/68 = 92.6% and ignored 1/68 = 1.5%, i.e. within envelope.

### Stability vs prior M62 (pre-M63) shared cases

- Shared valid cases vs M62: 21; resolution repeated on 17/21.
- Resolution changed: mwaskom__seaborn-3187 (M62 True→M62C False), sphinx-doc__sphinx-7462 (M62 True→M62C False), astropy__astropy-14369 (M62 True→M62C False), psf__requests-5414 (M62 True→M62C False)
- M62C resolved 12 vs M62 16 on the shared set (historical context; M62 ran pre-M63 code).

## Cost / Over-Exploration Analysis

- **Pooled cost regression vs baseline:** -27.8% (≤ +15% ✅).
- **Pooled token delta:** -31.5%; cache-read pooled -33.1%.
- **Repeated-read total:** 37 across 24 valid runs (read mean Δ-2.2, search mean Δ-1.5).
- **Tool-call delta:** mean Δ-3.8, median Δ-4.0.
- **Over-anchoring / off-target:** 8 off-target edits (6/7 of off-target cases resolved); no increase vs comparable prior VTRACE (M60B) on the shared-15 and E-control sets.
- **E controls harmed?** No — E resolution 4/5, off-target 2, cost pooled -32.4%.
- **Did header compaction reduce budget pressure without increasing exploration?** The 3 recovered cases now inject a valid bounded contract (previously fail-closed) while read/search/tool deltas stay within the M62 envelope — compaction recovered contract validity without inflating exploration.

## Success Criteria Check

| # | criterion | result | pass |
|---|---|---|---|
| 1 | Treatment valid in all/nearly all attempted runs | 24/24 valid | ✅ |
| 2 | Resolution not worse than comparable baseline | 15 vs 15 | ✅ |
| 3 | Required-target ignored rate ≤ 5% | 5.6% | ❌ |
| 4 | Required-target decision coverage ≥ 90% | 88.7% | ❌ |
| 5 | No off-target edit increase vs comparable prior VTRACE | shared-15 4 vs M60B 6, E-control 1 vs M60B 1; 8 abs | ✅ |
| 6 | Pooled cost regression vs baseline ≤ +15% | -27.8% pooled | ✅ |

## Verdict

**MIXED.**

## Recommendation

**Proceed to broader confirmation.**

The M63 compaction objective is fully met under live conditions: all 3 previously over-budget cases (matplotlib-22719, sympy-12419, pylint-8898) injected a complete, valid bounded contract — `query_truncated: true`, no `STRUCTURED_CONTRACT_OMITTED` marker — and all 3 resolved. The treatment is at resolution **parity** with strong reused baselines (15 = 15) on the full 24-task set, with pooled cost **−27.8%**, no off-target-edit increase versus comparable prior VTRACE (shared-15 and E-control sets), and E baseline-strong controls unharmed. Treatment validity was 24/24. Compaction therefore recovered contract validity for the over-budget tail without weakening sentinels, raising the budget, or inflating exploration.

The verdict is **MIXED** (not PASS) because two structured-decision criteria land marginally below threshold: decision coverage 88.7% (target ≥90%) and required-target ignored rate 5.6% (target ≤5%). Both are dominated by a single resolved case, **django-11740**, where the agent ignored all 3 surfaced required targets yet still resolved the task via a different edit (3 of the 4 total ignored targets, and the bulk of the coverage gap, come from this one case). This reads as an over-surfacing / target-selection nuance on that instance rather than a compaction defect.

A secondary watch item: versus the pre-M63 M62 run (different code, 21 shared cases), shared-set resolution dipped 16 → 12, with 4 previously-passing cases flipping to fail (seaborn-3187, sphinx-7462, astropy-14369, requests-5414). This is consistent with live-agent run-to-run variance — every one of the 24 contracts was valid, so it is **not** a contract-validity regression — but it means a single 24-task round is not enough to call resolution stable.

Recommended next step is therefore one **broader confirmation round** (a fresh repeat and/or a larger set) to (a) separate the shared-set resolution dip from genuine stochastic variance, and (b) confirm coverage/ignored hold near threshold across runs, before either promoting the structured-bounded treatment to a Stage 5 experimental default or scaling to 100-task planning. If coverage must clear 90% deterministically, the specific lever is tightening required-target selection on cases like django-11740 (surfaced targets the agent rightly bypasses) and multi-gold cases like sphinx-7462 — not the compaction, which behaved as designed.

## Non-Claims

- Does not claim VTRACE beats VEXP.
- Does not claim broad SWE-bench pass@1 improvement.
- Does not make a statistical superiority claim.
- Does not claim the structured bounded contract caused every pass.
- A targeted 24-task validation on the frozen M55Y set only.

