# M195 — gold-blind I6 validation-decision mechanism audit

Offline. Zero live spend. The preregistration was committed at `8655851a`,
before any candidate rule was scored against any M194 arm.

## 0. What the frozen gates say, and what they are made of

Three of the four preregistered families — and the union row — pass all nine
gates. Applied mechanically, the preregistration therefore returns:

```text
I6_INTERVENTION_MECHANISM_WITNESSED
```

That result has to be read together with what the passing evidence consists of,
because the decomposition is not what the hypothesis predicted.

Of the 14 union selection-miss specimens, **14 are `NO_VALIDATION`** and **0 is `DIFFERENT_VALIDATION`**. There is not one case in this
corpus of an agent starting a test runner against the wrong target while a
bounded, relevant, repository-derivable target existed. Every miss is an agent
that ran no runner at all inside the credit window, and 13 of 14 are in arms that never started a runner anywhere.

§71 of the milestone forbids merging the two hypotheses, and this is exactly
where that matters. A repository-derived recommendation of *which* test to run
is the I6 hypothesis. "Run a test at all" is a workflow scaffold. The passing
gates are carried entirely by the second.

Three further measurements press on the same point. 11 of the 14 miss tasks **resolved anyway** without ever running the derived test, which pressures
necessity. 14 resolved arms started no test runner at any point. And 6 arms ran a relevant,
trustworthy validation, saw its result, and still failed — the missing
ingredient there was not test selection.

There are 5 success-side witnesses across 5 repositories, all genuine: the agent
naturally selected a candidate the oracle confirms, on a task it resolved. But
**0 of them are strong witnesses** — nowhere in this corpus does a derived
validation fail, visibly drive a revision, and end in resolution. The witnesses
show the mechanism agreeing with agents that were already going to succeed,
which is also what the 54.2% redundant-recommendation rate and the 100%
intervention rate on resolved arms say from the other direction.

## 1. Corpus authority

- verdict: `M195_CORPUS_AUTHORITY_VERIFIED` — 14/14 gates
- raw artefacts hashed: 698 files, 13044348 bytes
- M194's committed accounting reproduces from raw artefacts with **0 field differences**
- base states materialised from the frozen images: 33/33, base-commit identity proven: true

| check | expected | observed | pass |
| ----- | -------- | -------- | ---- |
| 35 arm directories preserved | 35 | 35 | yes |
| exactly 2 ledger arms never launched a model | 2 | 2 | yes |
| 33 paid arms | 33 | 33 | yes |
| 33 valid runs | 33 | 33 | yes |
| 13 I6-usable arms | 13 | 13 | yes |
| 8 I6-usable repositories | 8 | 8 | yes |
| 7 runtime-diagnosis-usable arms | 7 | 7 | yes |
| 5 runtime-diagnosis repositories | 5 | 5 | yes |
| 23 resolved | 23 | 23 | yes |
| 12 repositories represented | 12 | 12 | yes |
| M194's committed accounting reproduces byte-for-byte from raw artefacts | 0 | 0 | yes |
| the M193C manifest still hashes to M194's declared authority | true | true | yes |
| the frozen corpus verdict is unchanged | I6_OBSERVATIONAL_CORPUS_ADEQUATE | I6_OBSERVATIONAL_CORPUS_ADEQUATE | yes |
| the acquisition spend is unchanged | 24.721812 | 24.721812 | yes |

## 2. Blindness

- control: gold patch, reference test patch, official outcome, future events and future validation actions removed
- decision points replayed: 59
- **differing candidate-set fingerprints: 0**
- verdict: `DERIVATION_IS_GOLD_OUTCOME_AND_FUTURE_ACTION_BLIND`
- fingerprint bundle: `7404272d3bfcd484bf908a4ee12d6826e4aa0b75795d260def4841f266da42f0`

## 3. Decision-point population

- arms 33, tasks 33, repositories 12
- decision points 59 (`DP_EDIT` 40, `DP_POST_FAILED_VALIDATION` 19)
- arms contributing at least one decision point: 33
- candidate-producing points (union): 59; empty: 0

## 4. Boundedness and specificity

| family | points | firing | empty | median | p90 | max | pre-cap median | pre-cap max | specificity |
| ------ | -----: | -----: | ----: | -----: | --: | --: | -------------: | ----------: | ----------- |
| I6-A | 59 | 23 | 61% | 0 | 1 | 2 | 0 | 2 | TEST_FILE 24 |
| I6-B | 59 | 50 | 15.3% | 2 | 3 | 3 | 2 | 12 | TEST_FILE 111 |
| I6-C | 59 | 32 | 45.8% | 1 | 3 | 3 | 1 | 8 | TEST_FILE 62 |
| I6-D | 59 | 19 | 67.8% | 0 | 2 | 3 | 0 | 15 | EXACT_TEST 30, TEST_FILE 1 |
| I6-UNION | 59 | 59 | 0% | 3 | 3 | 3 | 3 | 10 | TEST_FILE 139, EXACT_TEST 10 |

## 5. Natural-agent relation

| family | EXACT_MATCH | EQUIVALENT | BROADER_THAN_CANDIDATE | DIFFERENT_VALIDATION | NO_VALIDATION |
| ------ | ---: | ---: | ---: | ---: | ---: |
| I6-A | 12 | 0 | 2 | 1 | 44 |
| I6-B | 24 | 2 | 6 | 5 | 22 |
| I6-C | 15 | 3 | 2 | 0 | 39 |
| I6-D | 11 | 0 | 5 | 1 | 42 |
| I6-UNION | 32 | 0 | 6 | 3 | 18 |

## 6. Failure-side classes

| family | VALIDATION_SELECTION_MISS | RELEVANT_VALIDATION_ALREADY_SELECTED | NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION | VALIDATION_EVIDENCE_UNUSABLE | CANDIDATE_FIRED_NOT_CONFIRMED |
| ------ | ---: | ---: | ---: | ---: | ---: |
| I6-A | 8 | 12 | 36 | 1 | 2 |
| I6-B | 9 | 26 | 9 | 2 | 13 |
| I6-C | 8 | 18 | 27 | 2 | 4 |
| I6-D | 1 | 11 | 40 | 2 | 5 |
| I6-UNION | 14 | 32 | 0 | 2 | 11 |

Arm-level: `I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED` in **6 arms** — `pylint-dev__pylint-4551`, `astropy__astropy-14369`, `matplotlib__matplotlib-24627`, `pylint-dev__pylint-8898`, `sphinx-doc__sphinx-7748`, `matplotlib__matplotlib-24870`

## 7. What the misses actually are

| family | specimens | NO_VALIDATION | DIFFERENT_VALIDATION | miss tasks that resolved anyway | miss tasks unresolved | candidate selected elsewhere in trajectory | misses in arms that never started any runner |
| ------ | --------: | ------------: | -------------------: | ------------------------------: | --------------------: | -----------------------------------------: | -------------------------------------------: |
| I6-A | 8 | 8 | 0 | 8 | 0 | 1 | 7 |
| I6-B | 9 | 9 | 0 | 7 | 2 | 1 | 8 |
| I6-C | 8 | 8 | 0 | 6 | 2 | 1 | 7 |
| I6-D | 1 | 0 | 1 | 0 | 1 | 1 | 0 |
| I6-UNION | 14 | 14 | 0 | 11 | 3 | 1 | 13 |

Every union miss specimen:

| decision point | repository | resolved | relation | relevant candidate |
| -------------- | ---------- | -------- | -------- | ------------------ |
| `m194-01-astropy__astropy-14365#3` | astropy/astropy | yes | NO_VALIDATION | `astropy/io/ascii/tests/test_qdp.py` |
| `m194-05-pallets__flask-5014#1` | pallets/flask | yes | NO_VALIDATION | `tests/test_blueprints.py` |
| `m194-06-psf__requests-1142#1` | psf/requests | yes | NO_VALIDATION | `test_requests.py` |
| `m194-07-pydata__xarray-2905#45` | pydata/xarray | yes | NO_VALIDATION | `xarray/tests/test_variable.py` |
| `m194-10-scikit-learn__scikit-learn-10844#1` | scikit-learn/scikit-learn | yes | NO_VALIDATION | `sklearn/metrics/cluster/tests/test_supervised.py` |
| `m194-11-sphinx-doc__sphinx-7462#1` | sphinx-doc/sphinx | no | NO_VALIDATION | `tests/test_domain_py.py` |
| `m194-14-django__django-10973#1` | django/django | yes | NO_VALIDATION | `tests/dbshell/test_postgresql.py` |
| `m194-17-pydata__xarray-3677#1` | pydata/xarray | yes | NO_VALIDATION | `xarray/tests/test_merge.py` |
| `m194-23-astropy__astropy-14539#5` | astropy/astropy | yes | NO_VALIDATION | `astropy/io/fits/tests/test_diff.py` |
| `m194-26-psf__requests-1921#1` | psf/requests | no | NO_VALIDATION | `test_requests.py` |
| `m194-27-pydata__xarray-4695#1` | pydata/xarray | yes | NO_VALIDATION | `xarray/tests/test_dataarray.py` |
| `m194-29-sphinx-doc__sphinx-7910#1` | sphinx-doc/sphinx | yes | NO_VALIDATION | `tests/test_ext_napoleon.py` |
| `m194-30-sympy__sympy-13372#1` | sympy/sympy | yes | NO_VALIDATION | `sympy/core/tests/test_evalf.py` |
| `m194-34-psf__requests-5414#6` | psf/requests | no | NO_VALIDATION | `tests/test_requests.py` |

## 8. Success-side witnesses

- same-task witnesses: 0 — M194 acquired one arm per instance, so no within-task pairing exists and none was fabricated
- cross-task witnesses: 5 across 5 repositories
- **strong witnesses (validation failed → patch revised → resolved): 0**

| decision point | repository | relation | observed results | candidates |
| -------------- | ---------- | -------- | ---------------- | ---------- |
| `m194-04-mwaskom__seaborn-3187#38` | mwaskom/seaborn | EXACT_MATCH | NO_TESTS_RAN, UNKNOWN, UNKNOWN, PASSED, PASSED, PASSED | `tests/test_utils.py, tests/_core/test_scales.py, tests/_core/test_plot.py` |
| `m194-07-pydata__xarray-2905#6` | pydata/xarray | EXACT_MATCH | UNKNOWN, PASSED, MIXED, FAILED, FAILED | `xarray/tests/test_variable.py` |
| `m194-09-pytest-dev__pytest-10051#1` | pytest-dev/pytest | EXACT_MATCH | UNKNOWN, PASSED, UNKNOWN, UNKNOWN | `testing/logging/test_fixture.py, testing/logging/test_formatter.py, testing/logging/test_reporting.py` |
| `m194-09-pytest-dev__pytest-10051#17` | pytest-dev/pytest | EXACT_MATCH | MIXED, PASSED | `testing/logging/test_fixture.py, testing/logging/test_formatter.py, testing/logging/test_reporting.py` |
| `m194-20-scikit-learn__scikit-learn-11578#1` | scikit-learn/scikit-learn | EXACT_MATCH | PASSED | `sklearn/linear_model/tests/test_logistic.py, sklearn/linear_model/tests/test_sag.py, sklearn/svm/tests/test_bounds.py` |
| `m194-33-matplotlib__matplotlib-24970#3` | matplotlib/matplotlib | EXACT_MATCH | MIXED, PASSED, PASSED | `lib/matplotlib/tests/test_colors.py, lib/matplotlib/tests/test_artist.py, lib/matplotlib/tests/test_axes.py` |
| `m194-33-matplotlib__matplotlib-24970#12` | matplotlib/matplotlib | EXACT_MATCH | PASSED, PASSED | `lib/matplotlib/tests/test_colors.py, lib/matplotlib/tests/test_artist.py, lib/matplotlib/tests/test_axes.py` |

## 9. False-positive, redundancy and burden

| family | intervention rate on resolved arms | unnecessary fire rate (resolved) | redundant recommendation rate | recommendations per arm |
| ------ | --------------------------------: | -------------------------------: | ----------------------------: | ----------------------: |
| I6-A | 58.3% | 19% | 52.2% | 0.7 |
| I6-B | 88.9% | 43.8% | 52% | 1.52 |
| I6-C | 55.6% | 20% | 56.3% | 0.97 |
| I6-D | 25% | 55.6% | 57.9% | 0.58 |
| I6-UNION | 100% | 33.3% | 54.2% | 1.79 |

Resolved arms that never started any test runner at all: **14**.

## 10. Mechanism-family matrix

| family | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | verdict |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- | --- | ------- |
| I6-A | pass (0) | pass (median 0, p90 1) | pass (8) | pass (5) | pass (3 witnesses / 3 repos) | pass (19%) | pass (52.2%) | pass (12.5%) | pass (0.89) | **passes all nine** |
| I6-B | pass (0) | pass (median 2, p90 3) | pass (9) | pass (6) | pass (4 witnesses / 4 repos) | pass (43.8%) | pass (52%) | pass (11.1%) | pass (0.50) | **passes all nine** |
| I6-C | pass (0) | pass (median 1, p90 3) | pass (8) | pass (5) | pass (4 witnesses / 3 repos) | pass (20%) | pass (56.3%) | pass (12.5%) | pass (0.67) | **passes all nine** |
| I6-D | pass (0) | pass (median 0, p90 2) | FAIL (1) | FAIL (1) | FAIL (2 witnesses / 1 repos) | FAIL (55.6%) | pass (57.9%) | FAIL (100%) | FAIL (0.33) | fails |
| I6-UNION | pass (0) | pass (median 3, p90 3) | pass (14) | pass (8) | pass (5 witnesses / 5 repos) | pass (33.3%) | pass (54.2%) | pass (7.1%) | pass (0.67) | **passes all nine** |

## 11. Arm-level ledger — all 33 valid runs

| arm | repo | resolved | I6-usable | DPs | families firing | matched | miss | already selected | reasoning failed | unusable evidence |
| --- | ---- | -------- | --------- | --: | --------------- | ------- | ---- | ---------------- | ---------------- | ----------------- |
| `m194-01-astropy__astropy-14365` | astropy/astropy | yes | no | 1 | I6-A I6-B I6-C | — | yes | — | — | — |
| `m194-02-django__django-10880` | django/django | yes | yes | 1 | I6-B | — | — | — | — | — |
| `m194-04-mwaskom__seaborn-3187` | mwaskom/seaborn | yes | yes | 1 | I6-A I6-B I6-C | yes | — | yes | — | — |
| `m194-05-pallets__flask-5014` | pallets/flask | yes | no | 1 | I6-A | — | yes | — | — | — |
| `m194-06-psf__requests-1142` | psf/requests | yes | no | 1 | I6-C | — | yes | — | — | — |
| `m194-07-pydata__xarray-2905` | pydata/xarray | yes | yes | 4 | I6-A I6-B I6-C I6-D | yes | yes | yes | — | yes |
| `m194-08-pylint-dev__pylint-4551` | pylint-dev/pylint | no | yes | 2 | I6-B I6-C | yes | — | yes | yes | — |
| `m194-09-pytest-dev__pytest-10051` | pytest-dev/pytest | yes | yes | 3 | I6-B I6-D | yes | — | yes | — | — |
| `m194-10-scikit-learn__scikit-learn-10844` | scikit-learn/scikit-learn | yes | no | 1 | I6-A I6-C | — | yes | — | — | — |
| `m194-11-sphinx-doc__sphinx-7462` | sphinx-doc/sphinx | no | no | 1 | I6-B I6-C | — | yes | — | — | — |
| `m194-12-sympy__sympy-12419` | sympy/sympy | yes | no | 1 | I6-A I6-B I6-C | yes | — | yes | — | — |
| `m194-13-astropy__astropy-14369` | astropy/astropy | no | no | 1 | I6-C | yes | — | yes | yes | — |
| `m194-14-django__django-10973` | django/django | yes | no | 1 | I6-B | — | yes | — | — | — |
| `m194-15-matplotlib__matplotlib-24627` | matplotlib/matplotlib | no | yes | 1 | I6-A I6-B I6-C | yes | — | yes | yes | — |
| `m194-16-matplotlib__matplotlib-25332` | matplotlib/matplotlib | yes | yes | 3 | I6-A I6-B I6-C I6-D | yes | — | yes | — | — |
| `m194-17-pydata__xarray-3677` | pydata/xarray | yes | no | 1 | I6-A I6-B I6-C | — | yes | — | — | — |
| `m194-18-pylint-dev__pylint-8898` | pylint-dev/pylint | no | yes | 3 | I6-C I6-D | yes | — | yes | yes | — |
| `m194-19-pytest-dev__pytest-5262` | pytest-dev/pytest | yes | no | 1 | I6-A I6-B I6-C | yes | — | yes | — | — |
| `m194-20-scikit-learn__scikit-learn-11578` | scikit-learn/scikit-learn | yes | yes | 1 | I6-A I6-B I6-C | yes | — | yes | — | — |
| `m194-21-sphinx-doc__sphinx-7748` | sphinx-doc/sphinx | no | yes | 11 | I6-B I6-D | yes | — | yes | yes | yes |
| `m194-22-sympy__sympy-12481` | sympy/sympy | yes | no | 1 | I6-A I6-B | yes | — | yes | — | — |
| `m194-23-astropy__astropy-14539` | astropy/astropy | yes | no | 1 | I6-A I6-B I6-C | — | yes | — | — | — |
| `m194-24-django__django-11095` | django/django | yes | no | 1 | I6-B | — | — | — | — | — |
| `m194-25-matplotlib__matplotlib-24870` | matplotlib/matplotlib | no | yes | 1 | I6-A I6-B I6-C | yes | — | yes | yes | — |
| `m194-26-psf__requests-1921` | psf/requests | no | no | 1 | I6-C | — | yes | — | — | — |
| `m194-27-pydata__xarray-4695` | pydata/xarray | yes | no | 1 | I6-A | — | yes | — | — | — |
| `m194-28-pytest-dev__pytest-6197` | pytest-dev/pytest | yes | yes | 6 | I6-B I6-D | yes | — | yes | — | — |
| `m194-29-sphinx-doc__sphinx-7910` | sphinx-doc/sphinx | yes | no | 1 | I6-B | — | yes | — | — | — |
| `m194-30-sympy__sympy-13372` | sympy/sympy | yes | no | 1 | I6-A I6-B I6-C | — | yes | — | — | — |
| `m194-31-astropy__astropy-14598` | astropy/astropy | no | no | 1 | I6-B I6-C | yes | — | yes | — | — |
| `m194-32-django__django-11133` | django/django | yes | no | 1 | I6-B I6-C | — | — | — | — | — |
| `m194-33-matplotlib__matplotlib-24970` | matplotlib/matplotlib | yes | yes | 2 | I6-A I6-B I6-C I6-D | yes | — | yes | — | — |
| `m194-34-psf__requests-5414` | psf/requests | no | no | 1 | I6-B I6-C | — | yes | — | — | — |

## 12. Held-out inventory (identified, not scored)

- primary: 6 M193 fixture instances the stopping rule never reached, across 6 repositories
- secondary: 59 replacement-reserve instances (concentrated in django/django; breadth must be stratified, not taken in reserve order)
- total never-observed instances: 65

## 13. Counterexample ledger

| pattern | strongest specimen | what it shows |
| ------- | ------------------ | ------------- |
| candidate run, useful failure seen, task still failed | `pylint-dev__pylint-4551`, `astropy__astropy-14369`, `matplotlib__matplotlib-24627`, `pylint-dev__pylint-8898`, `sphinx-doc__sphinx-7748`, `matplotlib__matplotlib-24870` | the bottleneck is downstream of validation selection |
| candidate skipped, task resolved anyway | `m194-01-astropy__astropy-14365#3` (astropy/astropy) — 11 of 14 miss tasks | the derived obligation is not necessary for repair |
| candidate fired unnecessarily on a clean success | I6-D fires and is irrelevant in 55.6% of its firing points on resolved arms | the recommendation has a real cost |
| candidate too broad to be useful | I6-D truncated a pre-cap set of up to 15 targets to 3 | at that width the family samples rather than selects |
| the mechanism only ever agreed | `m194-07-pydata__xarray-2905#6` saw UNKNOWN/PASSED/MIXED/FAILED/FAILED yet is not a strong witness | no observed validation-driven repair |

## 14. Limitations of this audit

- **G2 is close to vacuous as written.** The bound truncates every family to
  3, so a post-cap median can never exceed it. The pre-cap column in §4 is
  the honest boundedness measurement, and it shows one family reaching
  15 targets before truncation. The gate was frozen before this was
  visible and is reported as it computes.
- **The frozen miss class folds `NO_VALIDATION` into selection.** §12 defined a
  miss as a confirmed-relevant candidate the agent did not aim at, whether or
  not it aimed anywhere. That definition is what lets a scaffold result pass a
  selection gate. M196's preregistration must split the two classes before
  scoring, not after.
- **The credit window is forward-only.** §28 fixed it that way, so a decision
  point after a late touch-up edit reads as `NO_VALIDATION` even when the agent
  validated that same file earlier. Measured cost: 1 of 14 union misses.
- **A miss is not conditioned on failure.** G3 counts tasks, not lost tasks, so
  a miss on an arm that resolved counts the same as one on an arm that did not.
- **Static evidence, not the VTRACE index.** Candidate derivation uses exact
  import edges and path inventories over the materialised base commit. A richer
  index could only add candidates, not remove the finding that agents were not
  aiming badly - they were not aiming.

## 15. Verdicts

```text
I6_INTERVENTION_MECHANISM_WITNESSED
```

```text
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
```

live-agent runs: 0
live model spend: $0

---

## Addendum — M195A interpretive correction (2026-09-01)

Nothing above is rewritten. M195's gate computed exactly what its preregistration
told it to compute, and its verdict stands as the answer that preregistration gives.
M195A ([`stage5_m195a_final_report.md`](./stage5_m195a_final_report.md), preregistered
at `45c39d9a`) re-read that result without changing a single rule, and reports:

```text
M195 mechanical gate result:
  I6_INTERVENTION_MECHANISM_WITNESSED

M195A semantic decomposition:
  VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED
  VALIDATION_SCAFFOLD_OPPORTUNITY_OBSERVED
  M195_G2_OUTPUT_BOUND_ONLY
```

- The 14 `I6_VALIDATION_SELECTION_MISS` specimens partition into **13 scaffold
  opportunities, 1 credit-window-only case, and 0 genuine target-selection misses**.
- All 26 success-side witnesses are scaffold-shaped or neither; **0** are selection
  witnesses, and **0** are strong — unchanged from §14 above.
- G2 is shown to be unfalsifiable in its own domain: it reads counts `cap()` has
  already clamped into `{0,1,2,3}`. On the pre-truncation sets it was meant to be
  about, three of the four families and the union are `PRE_TRUNCATION_DERIVATION_BROAD`.

All three artefacts of this milestone reproduce byte-for-byte under M195A's replay,
and `m195Mechanism.ts` / `m195Evaluation.ts` were not edited. The held-out corpus
remains untouched. `HELD_OUT_I6_REPLICATION_LICENSED` above is superseded for the
*selection* hypothesis by `NO_HELD_OUT_I6_SELECTION_REPLICATION_LICENSED` and
`I6_VALIDATION_SELECTION_CLOSE_RECOMMENDED`.
