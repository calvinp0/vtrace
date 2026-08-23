# M173 pairwise outcomes

**12 graded pairs. Baseline 7, compact VTRACE 7.**

| Task | A solve | B solve | A cost | B cost | Δ cost | Orientation tokens | Economic class |
| --- | :---: | :---: | ---: | ---: | ---: | ---: | --- |
| astropy__astropy-14369 | no | no | $1.4959 | $2.2105 | $0.7146 | 754 | PIPELINE_ECONOMIC_WIN |
| django__django-13658 | yes | yes | $0.1878 | $0.2649 | $0.0770 | 628 | PIPELINE_ECONOMIC_WIN |
| matplotlib__matplotlib-22719 | yes | yes | $0.3738 | $0.4029 | $0.0292 | 541 | PIPELINE_ECONOMIC_LOSS |
| mwaskom__seaborn-3187 | no | no | $1.0545 | $0.9905 | $-0.0640 | 571 | PIPELINE_ECONOMIC_LOSS |
| pallets__flask-5014 | yes | yes | $0.2487 | $0.2143 | $-0.0344 | 1011 | PIPELINE_ECONOMIC_WIN |
| psf__requests-1724 | no | no | $0.2357 | $0.7287 | $0.4930 | 658 | PIPELINE_ECONOMIC_LOSS |
| pydata__xarray-6599 | yes | yes | $0.8565 | $1.5866 | $0.7301 | 629 | PIPELINE_ECONOMIC_WIN |
| pylint-dev__pylint-4551 | no | no | — | $1.4388 | — | 537 | NOT_MEASURABLE |
| pytest-dev__pytest-7432 | yes | yes | $0.3698 | $0.3856 | $0.0158 | 607 | PIPELINE_ECONOMIC_LOSS |
| scikit-learn__scikit-learn-10844 | yes | yes | $0.2510 | $0.2672 | $0.0162 | 665 | PIPELINE_ECONOMIC_LOSS |
| sphinx-doc__sphinx-7462 | no | no | $0.2681 | $0.3244 | $0.0563 | 476 | PIPELINE_ECONOMIC_LOSS |
| sympy__sympy-13480 | yes | yes | $0.2459 | $0.4132 | $0.1673 | 753 | PIPELINE_ECONOMIC_LOSS |

## Solve-rate classification (§39)

```text
shared success        7
baseline unique win   0   —
VTRACE unique win     0   —
shared failure        5
```

## Paired distributions (§41, §42)

| Metric | n | median | mean | p10 | p90 | min | max | worse on |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| deltaCostUsd | 11 | 0.0563 | 0.200103 | -0.034424 | 0.714641 | -0.064009 | 0.730128 | 9/11 |
| deltaTotalTrafficTokens | 11 | 62671 | 202685.545455 | -57280 | 487380 | -192469 | 1086180 | 9/11 |
| deltaPreEditInputSideCostUsd | 11 | 0.064702 | -0.004184 | -0.194715 | 0.078949 | -0.437445 | 0.191867 | 7/11 |
| deltaInvestigationCostUsdPreEdit | 11 | 0.00119 | -0.01094 | -0.049928 | 0.021208 | -0.077087 | 0.024756 | 6/11 |
| deltaInvestigationCostUsdAll | 11 | -0.004062 | -0.011091 | -0.031833 | 0.008577 | -0.074847 | 0.046998 | 4/11 |
| deltaRequests | 11 | 2 | 3.818182 | -2 | 12 | -4 | 16 | 9/11 |
| deltaSearches | 11 | -1 | -1.363636 | -3 | 0 | -5 | 0 | 0/11 |
| deltaReads | 11 | 0 | 1.181818 | 0 | 2 | -2 | 8 | 5/11 |
| deltaFirstEditRequest | 11 | 1 | 0.181818 | -3 | 1 | -6 | 4 | 8/11 |
| orientationAttributableCostUsd | 11 | 0.011134 | 0.010638 | 0.007536 | 0.015096 | 0.006188 | 0.01885 | 11/11 |
| orientationCharacters | 11 | 1955 | 2059.909091 | 1682 | 2344 | 1478 | 3141 | 11/11 |
| orientationPayloadTokens | 11 | 629 | 663 | 541 | 754 | 476 | 1011 | 11/11 |

## The M169 diagnostic, recomputed (§26, §83)

```text
                                    M169 (rich)      M173 (compact)
orientation attributable cost       $0.0985 / task    $0.0106 / task
investigation displaced             $0.0026 / task    $0.0109 / task
whole-run investigation net         $-0.007          $0.1220
aggregate economic ratio            38x               1x
```

## Offline projection vs live actual (§82)

```text
M172 projected orientation cost   $0.0084
M173 actual median                $0.0111
ratio                             1.33x
```

M172's projection priced the packet's own tokens. The live figure also carries amplification — every later request re-reads the packet as cache — so a ratio above one is expected and its SIZE is the interesting number, not its sign.

## Treatment delivery (§49)

```text
delivered as the compact orientation   12
fell back to the authoritative result  0
no pipeline call at all                0
```
