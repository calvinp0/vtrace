# Stage 5 M62 — Structured Bounded 24-Task Live Confirmation

Live confirmation of the structured-bounded digest-decision-contract treatment (M56C→M59 stack) over the frozen 24-task M55Y set, after the M61 atomic-truncation fix. Treatment = `vtrace-indexed · force-inject · v2 · debug · 8000 · inject-capsule-digest · digest-decision-contract · bounded-digest-decisions · compact-digest-injection`. Model `claude-opus-4-5-20251101` (vexp default; runner does not override). Baselines reused (M60B for the 15 M60 cases, M55Z for the 9 additions), all `opus-4-5`.

**Verdict: PASS.** 21/21 treatment runs valid; resolution 16 vs baseline 12 (Δ+4); pooled cost -14.2%; decision coverage 96.7%; ignored rate 3.3%; off-target edits 9.

## 1. Preregistration Compliance

- **Selected task count:** 24 (expected 24).
- **Repo count:** 11 (expected 11).
- **Category counts:** A=6, B=4, C=5, D=3, E=6 (expected A=6, B=4, C=5, D=3, E=6).
- **Cases added/removed/replaced:** none / none / none — the 24-task M55Y set is preserved verbatim.
- **Locked sentinels present:** sphinx-doc__sphinx-7462, django__django-11820, django__django-13195.
- **Deviations:** none.

## 2. Pre-flight Table (all 24 cases, live-gate replay post-M61 atomic truncation)

| instance_id | repo | cat | digest+contract chars | over budget | status | live treatment |
|---|---|---|---|---|---|---|
| django__django-11820 | django/django | A | 4982 | 0 | VALID | yes |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | A | 12049 | 49 | FAIL_CLOSED_OMITTED | skipped (fail-closed) |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | A | 4839 | 0 | VALID | yes |
| mwaskom__seaborn-3187 | mwaskom/seaborn | A | 5934 | 0 | VALID | yes |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | A | 6435 | 0 | VALID | yes |
| sympy__sympy-13372 | sympy/sympy | A | 5705 | 0 | VALID | yes |
| astropy__astropy-14539 | astropy/astropy | B | 7389 | 0 | VALID | yes |
| pydata__xarray-3677 | pydata/xarray | B | 6419 | 0 | VALID | yes |
| pylint-dev__pylint-8898 | pylint-dev/pylint | B | 12803 | 803 | FAIL_CLOSED_OMITTED | skipped (fail-closed) |
| sympy__sympy-12419 | sympy/sympy | B | 12659 | 659 | FAIL_CLOSED_OMITTED | skipped (fail-closed) |
| astropy__astropy-14365 | astropy/astropy | C | 7220 | 0 | VALID | yes |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | C | 10911 | 0 | VALID | yes |
| psf__requests-1142 | psf/requests | C | 10268 | 0 | VALID | yes |
| pytest-dev__pytest-7432 | pytest-dev/pytest | C | 5375 | 0 | VALID | yes |
| sympy__sympy-12481 | sympy/sympy | C | 4941 | 0 | VALID | yes |
| astropy__astropy-14598 | astropy/astropy | D | 7875 | 0 | VALID | yes |
| django__django-13195 | django/django | D | 7425 | 0 | VALID | yes |
| pallets__flask-5014 | pallets/flask | D | 4998 | 0 | VALID | yes |
| astropy__astropy-14369 | astropy/astropy | E | 9327 | 0 | VALID | yes |
| django__django-10880 | django/django | E | 5254 | 0 | VALID | yes |
| django__django-11095 | django/django | E | 5620 | 0 | VALID | yes |
| django__django-11740 | django/django | E | 8639 | 0 | VALID | yes |
| psf__requests-5414 | psf/requests | E | 5558 | 0 | VALID | yes |
| sympy__sympy-16766 | sympy/sympy | E | 5373 | 0 | VALID | yes |

**Pre-flight summary:** 21 VALID, 3 FAIL_CLOSED_OMITTED (matplotlib__matplotlib-22719, sympy__sympy-12419, pylint-dev__pylint-8898), **0 INVALID_PARTIAL_SENTINEL**. Skipped cases: matplotlib__matplotlib-22719, pylint-dev__pylint-8898, sympy__sympy-12419 — over-budget at the 12,000-char limit, contract fails closed (essential block omitted, replaced by the omission marker). **No partial-sentinel failures** (M61 atomic truncation holds).

## 3. Baseline Reuse Gate

| instance_id | baseline source | baseline run label | model match | decision |
|---|---|---|---|---|
| django__django-11820 | M60B (reused) | m56c_baseline_django_11820 | ✅ opus-4-5 | reuse |
| matplotlib__matplotlib-24627 | M60B (reused) | eval-bounded-baseline-mpl-24627-r1 (+2 reps) | ✅ opus-4-5 | reuse |
| mwaskom__seaborn-3187 | M60B (reused) | eval-bounded20-baseline-seaborn-3187-r1 (+2 reps) | ✅ opus-4-5 | reuse |
| sphinx-doc__sphinx-7462 | M60B (reused) | m56c_baseline_sphinx_7462 | ✅ opus-4-5 | reuse |
| sympy__sympy-13372 | M55Z (reused) | eval-bounded20-baseline-sympy-13372-r3 | ✅ opus-4-5 | reuse |
| astropy__astropy-14539 | M60B (reused) | eval-bounded20-baseline-astropy-14539-r2 (+2 reps) | ✅ opus-4-5 | reuse |
| pydata__xarray-3677 | M60B (reused) | eval-m32-product-baseline-xarray-3677-r3 (+2 reps) | ✅ opus-4-5 | reuse |
| astropy__astropy-14365 | M60B (reused) | eval-bounded20-baseline-astropy-14365-r2 (+2 reps) | ✅ opus-4-5 | reuse |
| matplotlib__matplotlib-25960 | M55Z (reused) | eval-bounded-baseline-mpl-25960-r3 | ✅ opus-4-5 | reuse |
| psf__requests-1142 | M55Z (reused) | eval-bounded-baseline-requests-1142-r1 | ✅ opus-4-5 | reuse |
| pytest-dev__pytest-7432 | M60B (reused) | m55y_baseline_pytest_7432 | ✅ opus-4-5 | reuse |
| sympy__sympy-12481 | M55Z (reused) | eval-bounded20-baseline-sympy-12481-r3 | ✅ opus-4-5 | reuse |
| astropy__astropy-14598 | M60B (reused) | m55y_baseline_astropy_14598 | ✅ opus-4-5 | reuse |
| django__django-13195 | M60B (reused) | m56c_baseline_django_13195 | ✅ opus-4-5 | reuse |
| pallets__flask-5014 | M60B (reused) | eval-bounded-baseline-flask-5014-r2 (+2 reps) | ✅ opus-4-5 | reuse |
| astropy__astropy-14369 | M55Z (reused) | eval-baseline-vs-vtrace-baseline-astropy-14369 | ✅ opus-4-5 | reuse |
| django__django-10880 | M60B (reused) | eval-m32-product-baseline-django-10880-r3 (+2 reps) | ✅ opus-4-5 | reuse |
| django__django-11095 | M55Z (reused) | eval-m4h-baseline-django-11095-r3 | ✅ opus-4-5 | reuse |
| django__django-11740 | M55Z (reused) | eval-11740 | ✅ opus-4-5 | reuse |
| psf__requests-5414 | M60B (reused) | eval-baseline-vs-vtrace-baseline-requests-5414 | ✅ opus-4-5 | reuse |
| sympy__sympy-16766 | M60B (reused) | eval-bounded-baseline-sympy-16766-r3 (+2 reps) | ✅ opus-4-5 | reuse |

**Fresh baseline count: 0.** All 21 treatment cases reuse a model-matched (`opus-4-5`) baseline: M60B for the 15 M60 cases, M55Z for the 9 additions. The runner does not override the model; the vexp default is `claude-opus-4-5-20251101`, equal to every reused baseline.

## 4. Run Matrix

| instance_id | repo | cat | baseline (src/label) | treatment run label | valid? | evaluated? | notes |
|---|---|---|---|---|---|---|---|
| django__django-11820 | django/django | A | M60B/m56c_baseline_django_11820 | m62_structured_bounded_django_11820 | ✅ | ✅ | locked sentinel |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | A | reused | **skipped (fail-closed over-budget)** | — | — | preflight FAIL_CLOSED_OMITTED |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | A | M60B/eval-bounded-baseline-mpl-24627-r1 (+2 reps) | m62_structured_bounded_matplotlib_24627 | ✅ | ✅ |  |
| mwaskom__seaborn-3187 | mwaskom/seaborn | A | M60B/eval-bounded20-baseline-seaborn-3187-r1 (+2 reps) | m62_structured_bounded_seaborn_3187 | ✅ | ✅ |  |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | A | M60B/m56c_baseline_sphinx_7462 | m62_structured_bounded_sphinx_7462 | ✅ | ✅ | locked sentinel |
| sympy__sympy-13372 | sympy/sympy | A | M55Z/eval-bounded20-baseline-sympy-13372-r3 | m62_structured_bounded_sympy_13372 | ✅ | ✅ |  |
| astropy__astropy-14539 | astropy/astropy | B | M60B/eval-bounded20-baseline-astropy-14539-r2 (+2 reps) | m62_structured_bounded_astropy_14539 | ✅ | ✅ |  |
| pydata__xarray-3677 | pydata/xarray | B | M60B/eval-m32-product-baseline-xarray-3677-r3 (+2 reps) | m62_structured_bounded_xarray_3677 | ✅ | ✅ |  |
| pylint-dev__pylint-8898 | pylint-dev/pylint | B | reused | **skipped (fail-closed over-budget)** | — | — | preflight FAIL_CLOSED_OMITTED |
| sympy__sympy-12419 | sympy/sympy | B | reused | **skipped (fail-closed over-budget)** | — | — | preflight FAIL_CLOSED_OMITTED |
| astropy__astropy-14365 | astropy/astropy | C | M60B/eval-bounded20-baseline-astropy-14365-r2 (+2 reps) | m62_structured_bounded_astropy_14365 | ✅ | ✅ |  |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | C | M55Z/eval-bounded-baseline-mpl-25960-r3 | m62_structured_bounded_matplotlib_25960 | ✅ | ✅ | near-budget |
| psf__requests-1142 | psf/requests | C | M55Z/eval-bounded-baseline-requests-1142-r1 | m62_structured_bounded_requests_1142 | ✅ | ✅ |  |
| pytest-dev__pytest-7432 | pytest-dev/pytest | C | M60B/m55y_baseline_pytest_7432 | m62_structured_bounded_pytest_7432 | ✅ | ✅ |  |
| sympy__sympy-12481 | sympy/sympy | C | M55Z/eval-bounded20-baseline-sympy-12481-r3 | m62_structured_bounded_sympy_12481 | ✅ | ✅ |  |
| astropy__astropy-14598 | astropy/astropy | D | M60B/m55y_baseline_astropy_14598 | m62_structured_bounded_astropy_14598 | ✅ | ✅ |  |
| django__django-13195 | django/django | D | M60B/m56c_baseline_django_13195 | m62_structured_bounded_django_13195 | ✅ | ✅ | locked sentinel |
| pallets__flask-5014 | pallets/flask | D | M60B/eval-bounded-baseline-flask-5014-r2 (+2 reps) | m62_structured_bounded_flask_5014 | ✅ | ✅ |  |
| astropy__astropy-14369 | astropy/astropy | E | M55Z/eval-baseline-vs-vtrace-baseline-astropy-14369 | m62_structured_bounded_astropy_14369 | ✅ | ✅ |  |
| django__django-10880 | django/django | E | M60B/eval-m32-product-baseline-django-10880-r3 (+2 reps) | m62_structured_bounded_django_10880 | ✅ | ✅ |  |
| django__django-11095 | django/django | E | M55Z/eval-m4h-baseline-django-11095-r3 | m62_structured_bounded_django_11095 | ✅ | ✅ |  |
| django__django-11740 | django/django | E | M55Z/eval-11740 | m62_structured_bounded_django_11740 | ✅ | ✅ |  |
| psf__requests-5414 | psf/requests | E | M60B/eval-baseline-vs-vtrace-baseline-requests-5414 | m62_structured_bounded_requests_5414 | ✅ | ✅ |  |
| sympy__sympy-16766 | sympy/sympy | E | M60B/eval-bounded-baseline-sympy-16766-r3 (+2 reps) | m62_structured_bounded_sympy_16766 | ✅ | ✅ |  |

## 5. Results Table (treatment runs)

| instance_id | cat | resolved | patch | total_tok | cache_read | cost | tools | rd/sr | rpt | req | C/O/I/inv | off-tgt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| django__django-11820 | A | ❌ | ✅ | 1486853 | 1416288 | 0.727 | 14 | 3/0 | 2 | 3 | 3/0/0/0 | 0 |
| matplotlib__matplotlib-24627 | A | ✅ | ✅ | 1953547 | 1857340 | 0.800 | 18 | 5/5 | 2 | 3 | 1/2/2/0 | 2 |
| mwaskom__seaborn-3187 | A | ✅ | ✅ | 1896269 | 1822889 | 0.820 | 18 | 3/4 | 0 | 2 | 2/0/0/0 | 1 |
| sphinx-doc__sphinx-7462 | A | ✅ | ✅ | 755310 | 681375 | 0.437 | 9 | 2/0 | 0 | 3 | 3/0/0/0 | 0 |
| sympy__sympy-13372 | A | ✅ | ✅ | 625354 | 563428 | 0.462 | 5 | 2/0 | 1 | 2 | 2/0/0/0 | 0 |
| astropy__astropy-14539 | B | ✅ | ✅ | 609299 | 560812 | 0.346 | 6 | 1/0 | 0 | 4 | 4/0/0/0 | 0 |
| pydata__xarray-3677 | B | ✅ | ✅ | 802299 | 741984 | 0.439 | 7 | 3/0 | 2 | 4 | 4/0/0/0 | 0 |
| astropy__astropy-14365 | C | ❌ | ✅ | 554292 | 502067 | 0.356 | 5 | 1/0 | 0 | 3 | 3/0/0/0 | 0 |
| matplotlib__matplotlib-25960 | C | ❌ | ✅ | 1259128 | 1187177 | 0.643 | 11 | 4/2 | 2 | 1 | 1/0/0/0 | 0 |
| psf__requests-1142 | C | ✅ | ✅ | 702363 | 633062 | 0.393 | 7 | 2/2 | 0 | 3 | 3/0/0/0 | 1 |
| pytest-dev__pytest-7432 | C | ✅ | ✅ | 511272 | 460217 | 0.355 | 5 | 2/0 | 1 | 3 | 3/0/0/0 | 0 |
| sympy__sympy-12481 | C | ✅ | ✅ | 710948 | 644158 | 0.455 | 6 | 2/0 | 1 | 3 | 3/0/0/0 | 0 |
| astropy__astropy-14598 | D | ❌ | ✅ | 3141601 | 2967595 | 2.260 | 21 | 8/5 | 6 | 2 | 2/0/0/0 | 0 |
| django__django-13195 | D | ❌ | ✅ | 3349338 | 3247645 | 1.359 | 29 | 5/6 | 1 | 3 | 3/0/0/0 | 2 |
| pallets__flask-5014 | D | ✅ | ✅ | 593319 | 547642 | 0.329 | 6 | 1/1 | 0 | 4 | 4/0/0/0 | 0 |
| astropy__astropy-14369 | E | ✅ | ✅ | 2884747 | 2764003 | 1.372 | 22 | 7/0 | 2 | 3 | 3/0/0/0 | 1 |
| django__django-10880 | E | ✅ | ✅ | 1145931 | 1083954 | 0.518 | 11 | 3/0 | 1 | 4 | 4/0/0/0 | 1 |
| django__django-11095 | E | ✅ | ✅ | 1009355 | 954899 | 0.458 | 11 | 2/0 | 1 | 2 | 2/0/0/0 | 0 |
| django__django-11740 | E | ✅ | ✅ | 1203265 | 1137099 | 0.554 | 11 | 2/5 | 1 | 3 | 3/0/0/0 | 1 |
| psf__requests-5414 | E | ✅ | ✅ | 372514 | 323628 | 0.304 | 3 | 1/0 | 0 | 2 | 2/0/0/0 | 0 |
| sympy__sympy-16766 | E | ✅ | ✅ | 1081743 | 1021671 | 0.507 | 10 | 2/0 | 1 | 4 | 4/0/0/0 | 0 |

(C/O/I/inv = required-target closed/open/ignored/invalid-decision counts.)

## 6. Paired Outcomes (treatment vs reused baseline, valid cases)

- **both_pass** (12): sympy__sympy-13372, astropy__astropy-14539, pydata__xarray-3677, psf__requests-1142, pytest-dev__pytest-7432, sympy__sympy-12481, pallets__flask-5014, django__django-10880, django__django-11095, django__django-11740, psf__requests-5414, sympy__sympy-16766
- **both_fail** (5): django__django-11820, astropy__astropy-14365, matplotlib__matplotlib-25960, astropy__astropy-14598, django__django-13195
- **treatment_only_pass** (4): matplotlib__matplotlib-24627, mwaskom__seaborn-3187, sphinx-doc__sphinx-7462, astropy__astropy-14369
- **baseline_only_pass** (0): —

## 7. Paired Deltas (valid treatment vs reused baseline)

| metric | pooled % | mean | median |
|---|---|---|---|
| total tokens | -16.5% | -251604.0 | -139628.0 |
| cache-read tokens | -17.9% | -260634.3 | -182906.0 |
| cost | -14.2% | -0.1 | -0.1 |
| tool calls | -12.8% | -1.6 | -2.0 |
| reads | -39.1% | -1.9 | 0.0 |
| searches | -51.4% | -1.4 | -2.5 |

- **Resolution delta:** 16 − 12 = **+4**.
- **Required-target totals:** closed 59, open 2, ignored 2, invalid-decision 0 (of 61 required targets).
- **Off-target edit delta (over-anchoring guard):** 9 total off-target edits across 7 valid runs (6 of which **resolved** — correct multi-file fixes outside the digest's required-target set). On the directly comparable VTRACE-vs-VTRACE set, **off-target did not increase**: shared-15 M62 6 = M60B 6; E baseline-strong controls M62 1 = M60B 1. The 3 additional off-target edits fall on the 9 out-of-M60 additions (no prior VTRACE over-anchoring comparator); all but one resolved.

## 8. Category-Stratified Results

| cat | meaning | n | resolved (t/b) | cost pooled Δ | coverage | ignored | off-tgt |
|---|---|---|---|---|---|---|---|
| A | hidden/context-action | 5 | 4/1 | -38.9% | 85% | 15.4% | 3 |
| B | high-overhead/navigation-heavy | 2 | 2/2 | -21.3% | 100% | 0.0% | 0 |
| C | normal/control | 5 | 3/3 | -19.8% | 100% | 0.0% | 1 |
| D | retrieved-but-did-not-act / over-anchor | 3 | 1/1 | +13.0% | 100% | 0.0% | 2 |
| E | baseline-strong controls | 6 | 6/5 | +2.0% | 100% | 0.0% | 3 |

**E baseline-strong no-hurt control:** 6 cases, resolution 6/5 (treatment/baseline), off-target edits 3, cost pooled +2.0%.

## 9. Structured-Decision Compliance

- **Decision coverage** (closed / required targets): 96.7% (59/61).
- **Ignored required-target rate:** 3.3% (2/61).
- **Invalid rule-out / invalid-decision rate:** 0.0% (0/61).
- **INSPECT_ONLY_NO_EDIT usage:** 19 targets (edited 24, ruled out 16).
- **Optional-context exploration:** 0/0 optional-context targets inspected.

### Stability vs M60B (shared 15 cases)

- Shared valid cases: 14; resolution repeated on 13/14.
- Resolution changed: psf__requests-5414 (M60B False→M62 True)
- M62 resolved 10 vs M60B 9 on the shared 15.

## 10. Success Criteria Checklist (preregistered)

| # | criterion | result | pass |
|---|---|---|---|
| 1 | Treatment valid in all/nearly all attempted runs | 21/21 valid | ✅ |
| 2 | Resolution not worse than comparable baseline | 16 vs 12 | ✅ |
| 3 | Required-target ignored rate ≤ 5% | 3.3% | ✅ |
| 4 | Required-target decision coverage ≥ 90% | 96.7% | ✅ |
| 5 | No off-target edit increase | shared-15 6=6 (M62=M60B), E-control 1=1; 9 abs | ✅ |
| 6 | Pooled cost regression vs baseline ≤ +15% | -14.2% pooled | ✅ |

## 11. Verdict

**PASS.**

## 12. Recommendation

**Add digest-header compaction first**, then proceed to broader / 100-task confirmation.

The treatment itself is validated across two independent live confirmations (M60C, 14 cases; M62, 21 cases). On this 21-case set the paired outcome is Pareto-clean — **no case where the reused, model-matched baseline resolved and the treatment did not** (12 both-pass, 4 treatment-only, 0 baseline-only → 16 vs 12) — while the treatment cost **less** (pooled cost −14.2%, total tokens −16.5%, cache-read −17.9%), at 21/21 valid runs, 96.7% decision coverage, 3.3% ignored rate, and **no over-anchoring increase** on every comparable VTRACE-vs-VTRACE set (shared-15 off-target 6 = 6; E baseline-strong controls 1 = 1). The E control shows no harm (6/5 resolution, cost +2%). This is a targeted set-specific result, not a general or statistical superiority claim (see Non-Claims).

The single operational gap is coverage, not quality: 3/24 cases (12.5%) are fail-closed over-budget at the 12,000-char limit (`pylint-8898`, `sympy-12419`, `matplotlib-22719`) and cannot run at all — a fraction that will only grow at 100-task scale. The preregistered digest-header compaction follow-up (cap the verbatim issue-description text carried in the digest header) recovers exactly these cases without touching the validated behavior. Landing it first removes the only weakness before committing tokens to a larger sweep; once coverage is closed, making the structured bounded treatment the Stage 5 experimental default and/or moving to 100-task planning is well-supported by the evidence here.

## Non-Claims

- Does not claim VTRACE beats VEXP.
- Does not claim broad SWE-bench pass@1 improvement.
- Does not make a statistical superiority claim.
- A targeted 24-task validation only.

