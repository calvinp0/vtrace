# M183 — Current-Product Live SWE-bench Requalification (final report)

```text
M183 overall              see workstreams
A  protocol freeze        PASS
B  sample and treatment   30/30 treatments delivered
C  paired live execution  30 valid pairs
D  grading and outcomes   30 graded pairs
E  economics attribution  30 token pairs / 30 cost pairs
F  closure                this document

sample                    30 planned pairs, 30 valid pairs
live spend                $38.33   (authorised cap $80.00)
baseline resolved         19 / 30
VTRACE   resolved         19 / 30
both solved               17
VTRACE-only wins          2
baseline-only wins        2
neither solved            9

resolution verdict        OBSERVED_RESOLUTION_PARITY
statistical resolution    RESOLUTION_DIFFERENCE_NOT_STATISTICALLY_RESOLVED
whole-run token verdict   WHOLE_RUN_TOKEN_USAGE_NEUTRAL
whole-run cost verdict    WHOLE_RUN_COST_EFFECT_MIXED
product verdict           CURRENT_PRODUCT_UTILITY_NEUTRAL
  quality axis            PARITY_NOT_RESOLVED  (observed: OBSERVED_RESOLUTION_PARITY)
  cost axis               NEUTRAL
VTRACE-causality verdict  NO_CLEAR_VTRACE_CAUSAL_UTILITY_EVIDENCE
economics mechanism       TAILS_DOMINATE_ECONOMIC_EFFECT
VEXP-class verdict        VEXP_CLASS_VALUE_PROPOSITION_NOT_YET_SUPPORTED

baseline median tokens    1,112,528
VTRACE   median tokens    1,031,587
paired median delta       -4,302
pooled token reduction    5.26%
baseline median cost      $0.5097
VTRACE   median cost      $0.4998
paired median cost delta  $-0.0367
aggregate cost reduction  -0.21%

orientation median tokens 579.5
orientation p90 tokens    822.5000000000001
orientation max tokens    941

gold-file diagnostic      21/30 orientations name a gold file
gold-symbol diagnostic    2/30
focus-use diagnostic      17/30 treatment runs edited the focus file

product changed           NO
retrieval changed         NO
ranking changed           NO
fit contract changed      NO
ownership contract        NO
live work                 RUN
product HEAD              166d07a7d4856ea9c15f7c63601b553a2430b972
protocol hash             960e8f414e0625ee5183e66b4094d3e725b794c0e020e32f77ac217ffa7bb3fc
pushed                    NO
```

## Required paired outcome table (§158)

| Task | Repo | Order | Baseline resolved | VTRACE resolved | Δ tokens | Δ cost | Orientation used? |
|---|---|---|---|---|---|---|---|
| astropy__astropy-14369 | astropy | A→B | no | yes | 728,837 | n/a | no |
| astropy__astropy-14539 | astropy | B→A | yes | yes | -1,131,428 | -0.3006 | yes |
| django__django-13658 | django | A→B | yes | yes | -186,357 | n/a | yes |
| django__django-11133 | django | B→A | yes | yes | 127,807 | n/a | yes |
| matplotlib__matplotlib-22719 | matplotlib | A→B | yes | yes | 415,545 | 0.1579 | no |
| django__django-11820 | django | B→A | no | no | -655,993 | n/a | yes |
| mwaskom__seaborn-3187 | seaborn | A→B | no | no | -875,405 | -0.3097 | no |
| django__django-12273 | django | B→A | no | no | -840,318 | -0.4369 | no |
| pallets__flask-5014 | flask | A→B | yes | yes | 61,420 | n/a | yes |
| django__django-12325 | django | B→A | no | yes | -1,567,919 | -0.4186 | no |
| psf__requests-1724 | requests | A→B | yes | yes | 41,961 | n/a | no |
| django__django-13195 | django | B→A | no | no | -685,747 | n/a | yes |
| pydata__xarray-6599 | xarray | A→B | yes | yes | 204,832 | n/a | yes |
| django__django-13513 | django | B→A | no | no | -130,660 | n/a | no |
| pylint-dev__pylint-4551 | pylint | A→B | no | no | 1,466,280 | 1.4175 | no |
| django__django-13820 | django | B→A | yes | yes | -856,209 | -0.2746 | yes |
| pytest-dev__pytest-7432 | pytest | A→B | yes | yes | -381,648 | n/a | yes |
| django__django-16569 | django | B→A | yes | yes | 13,387 | n/a | yes |
| scikit-learn__scikit-learn-10844 | scikit-learn | A→B | yes | yes | -121,222 | n/a | yes |
| django__django-17084 | django | B→A | yes | yes | 1,634,203 | 0.6265 | no |
| sphinx-doc__sphinx-7462 | sphinx | A→B | no | no | -21,991 | n/a | yes |
| matplotlib__matplotlib-26466 | matplotlib | B→A | no | no | 232,613 | n/a | no |
| sympy__sympy-13480 | sympy | A→B | yes | yes | 338,189 | n/a | yes |
| psf__requests-5414 | requests | B→A | yes | no | -645,123 | n/a | yes |
| pydata__xarray-4695 | xarray | A→B | yes | yes | 298,619 | n/a | no |
| pytest-dev__pytest-6197 | pytest | B→A | yes | no | 105,046 | 0.1831 | no |
| sphinx-doc__sphinx-9320 | sphinx | A→B | yes | yes | -219,018 | n/a | yes |
| sympy__sympy-12419 | sympy | B→A | yes | yes | 505,117 | 0.1398 | no |
| sympy__sympy-13372 | sympy | A→B | yes | yes | 319,641 | n/a | yes |
| sympy__sympy-13974 | sympy | B→A | no | no | -265,708 | n/a | yes |

## Required economics table (§159)

| Metric | Baseline | VTRACE | Paired / aggregate change |
|---|---|---|---|
| Resolved | 19 / 30 | 19 / 30 | 0 tasks |
| Median input tokens | 300 | 267 | -8 |
| Median output tokens | 75 | 70 | -1 |
| Median cache-read tokens | 1,063,269 | 970,357 | -5,476 |
| Median cache-write tokens | 51,334 | 50,977 | -2,569 |
| Median total tokens | 1,112,528 | 1,031,587 | -4,302 |
| Aggregate total tokens | 39,726,648 | 37,635,399 | 5.26% |
| Median cost | $0.5097 | $0.4998 | $-0.0367 |
| Aggregate cost | $19.1447 | $19.1856 | -0.21% |
| Median turns | 37 | 33 | -1 |
| Cost per solved task | $1.0076 | $1.0098 | — |

## Required discordant-pair table (§160)

| Task | Winner | Focus correct? | Orientation used? | Causal classification | Short mechanism |
|---|---|---|---|---|---|
| astropy__astropy-14369 | VTRACE | no | no | NOT_DETERMINABLE | the treatment arm won without a traceable evidence advantage |
| django__django-12325 | VTRACE | no | no | NOT_DETERMINABLE | the treatment arm won without a traceable evidence advantage |
| psf__requests-5414 | BASELINE | yes | yes | REPAIR_STRATEGY_DIFFERENCE | the orientation named the gold file and the treatment arm edited it; the repair, not the localization, failed |
| pytest-dev__pytest-6197 | BASELINE | no | no | NOT_DETERMINABLE | the baseline won without a traceable orientation defect |

## Required cost-tail table (§161)

| Task | Outcome | Baseline | VTRACE | Δ cost | Δ tokens |
|---|---|---|---|---|---|
| pylint-dev__pylint-4551 | NEITHER_SOLVED | $1.6097 | $3.0272 | $1.4175 | 1,466,280 |
| django__django-17084 | BOTH_SOLVED | $0.8418 | $1.4683 | $0.6265 | 1,634,203 |
| pytest-dev__pytest-6197 | BASELINE_ONLY_WIN | $0.9764 | $1.1595 | $0.1831 | 105,046 |
| matplotlib__matplotlib-22719 | BOTH_SOLVED | $0.3477 | $0.5056 | $0.1579 | 415,545 |
| sympy__sympy-12419 | BOTH_SOLVED | $1.3220 | $1.4618 | $0.1398 | 505,117 |
| django__django-12273 | NEITHER_SOLVED | $1.2392 | $0.8022 | $-0.4369 | -840,318 |
| django__django-12325 | TREATMENT_ONLY_WIN | $1.1870 | $0.7684 | $-0.4186 | -1,567,919 |
| mwaskom__seaborn-3187 | NEITHER_SOLVED | $1.1324 | $0.8227 | $-0.3097 | -875,405 |
| astropy__astropy-14539 | BOTH_SOLVED | $0.9635 | $0.6629 | $-0.3006 | -1,131,428 |
| django__django-13820 | BOTH_SOLVED | $0.5056 | $0.2310 | $-0.2746 | -856,209 |

## Required context-vs-whole-run table (§162)

| Reduction concept | Baseline denominator | VTRACE numerator | Reduction |
|---|---|---|---|
| Repository context / orientation | NOT MEASURABLE | 580 | NOT MEASURABLE |
| Complete agent tokens | 39,726,648 | 37,635,399 | 5.26% pooled / -0.30% median paired |
| Complete agent cost | 19 | 19 | -0.21% pooled / 10.42% median paired |

## Repository breakdown (§128)

| Repository | Pairs | Baseline resolved | VTRACE resolved | Baseline cost | VTRACE cost |
|---|---|---|---|---|---|
| astropy/astropy | 2 | 1 | 2 | $1.8999 | $1.6907 |
| django/django | 10 | 5 | 6 | $6.1005 | $5.2167 |
| matplotlib/matplotlib | 2 | 1 | 1 | $0.7473 | $1.0079 |
| mwaskom/seaborn | 1 | 0 | 0 | $1.1324 | $0.8227 |
| pallets/flask | 1 | 1 | 1 | $0.2445 | $0.1766 |
| psf/requests | 2 | 2 | 1 | $1.0280 | $0.7605 |
| pydata/xarray | 2 | 2 | 2 | $0.9577 | $1.1406 |
| pylint-dev/pylint | 1 | 0 | 0 | $1.6097 | $3.0272 |
| pytest-dev/pytest | 2 | 2 | 1 | $1.6042 | $1.5952 |
| scikit-learn/scikit-learn | 1 | 1 | 1 | $0.2129 | $0.1383 |
| sphinx-doc/sphinx | 2 | 1 | 1 | $0.8560 | $0.6513 |
| sympy/sympy | 4 | 3 | 3 | $2.7516 | $2.9579 |
