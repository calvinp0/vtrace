# M195A — validation-selection vs validation-scaffold, and what M195's bound measured

**Verdict.** `M195A — PASS`

**Spend.** `live-agent runs: 0`  ·  `live model spend: $0`

M195's mechanically positive headline does **not** survive semantic separation. Its
14 `I6_VALIDATION_SELECTION_MISS` specimens partition into **13 scaffold
opportunities and 1 credit-window-only case, and zero genuine target-selection
misses**. Across all four frozen families and 59 decision points there is exactly
**one** row in which an agent started a test runner and aimed at a non-equivalent
target while a bounded relevant candidate existed — and its credit-window evidence
is untrustworthy, so the frozen §5 clauses withhold it. Every one of M195's 26
success-side witnesses is a scaffold-shaped witness or none at all; **zero** are
selection witnesses and **zero** are strong. Separately, M195's G2 boundedness gate
is shown to be structurally incapable of failing: it reads candidate counts that
`cap()` has already clamped into `[0, 3]`, and an exhaustive sweep of that domain
produces no failing input. The honest pre-truncation figures make three of the four
families, and the union, `PRE_TRUNCATION_DERIVATION_BROAD`.

M195 is not rewritten. Its gate computed what it was preregistered to compute; this
milestone corrects only the reading.

## 1. Authority

The frozen M195 audit driver was re-executed unmodified over the preserved M194 tree.

| artefact | bytes | reproduces byte-for-byte |
|---|---:|---|
| `stage5_m195_audit.json` | 58 229 | yes |
| `stage5_m195_candidates.jsonl` | 146 454 | yes |
| `stage5_m195_decision_points.jsonl` | 46 417 | yes |

- 33 paid valid M194 arms · 33 distinct instances · 12 repositories · 59 decision
  points (40 `DP_EDIT`, 19 `DP_POST_FAILED_VALIDATION`).
- Blindness replay reproduced: **0 differing candidate-set fingerprints of 59**,
  `DERIVATION_IS_GOLD_OUTCOME_AND_FUTURE_ACTION_BLIND`.
- Candidate discovery, scoring, rank, the bound of 3, the relevance oracle, the
  equivalence rules, decision-point extraction and the credit window: **unchanged**.
  `m195Mechanism.ts` and `m195Evaluation.ts` were not edited. No fifth family exists.
- Held-out corpus: **not scored, not inspected**.

**The additive probe was not trusted on its own.** M195A needed two per-row facts
M195 published only in aggregate — whether a credit-window attempt is trustworthy,
and whether its runner outcome is observable at all. The probe that recovers them
had to agree with M195 before any verdict used it:

| control | published | probed | agrees |
|---|---:|---:|---|
| `attemptsInCreditWindow` reproduced | 59 / 59 | 59 / 59 | yes |
| unpaired `bash_pre` events | 23 | 23 | yes |
| arms carrying them | 14 | 14 | yes |

## 2. What separated the two hypotheses

No new evidence was required. M195 already recorded the distinction and discarded it
one line later. `relateOne` gates `BROADER_THAN_CANDIDATE` and
`DIFFERENT_VALIDATION` behind `obs.runnerStarted`, so for a firing family:

```
bestRelation === "NO_VALIDATION"        <=>  no runner started in the credit window
bestRelation === "DIFFERENT_VALIDATION" <=>  a runner started and aimed elsewhere
```

`classifyDecisionPoint` then OR'd them into one class. Those two relations answer
different questions — *did the agent aim badly* versus *did the agent aim at all* —
and only the first is evidence about validation-target selection.

## 3. Table A — the 14 original misses

All 14 accounted for; none reclassified out of existence.

| instance | repository | validation attempted in window? | runner started in window? | relation | new class | partition | resolved | credit-window edge |
|---|---|---|---|---|---|---|---|---|
| astropy-14365 | astropy/astropy | yes | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| flask-5014 | pallets/flask | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| requests-1142 | psf/requests | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| xarray-2905 | pydata/xarray | no | no | `NO_VALIDATION` | S4 | **credit-window only** | yes | **yes** |
| scikit-learn-10844 | scikit-learn/scikit-learn | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| sphinx-7462 | sphinx-doc/sphinx | no | no | `NO_VALIDATION` | S4 | scaffold | no | no |
| django-10973 | django/django | yes | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| xarray-3677 | pydata/xarray | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| astropy-14539 | astropy/astropy | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| requests-1921 | psf/requests | no | no | `NO_VALIDATION` | S4 | scaffold | no | no |
| xarray-4695 | pydata/xarray | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| sphinx-7910 | sphinx-doc/sphinx | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| sympy-13372 | sympy/sympy | no | no | `NO_VALIDATION` | S4 | scaffold | yes | no |
| requests-5414 | psf/requests | no | no | `NO_VALIDATION` | S4 | scaffold | no | no |

```
genuine target-selection misses    0
scaffold opportunities            13
credit-window-only cases           1
runner/instrument edge cases       0
other                              0
                            sum = 14
```

Twelve of the fourteen issued **no validation command whatsoever** inside the credit
window. The two that did (`astropy-14365`, `django-10973`) issued commands that
started no runner — the `python -c` reproduction shape M195's own §10 instrument
correction already refuses to score as a different validation. **Zero** of the 14
rest on an unpaired `bash_pre`, so none of this is an instrument artefact.

## 4. Selection-opportunity evidence

```
genuine target-selection misses: 0 rows, 0 arms, 0 tasks, 0 repositories
```

The corpus contains exactly one `S1` row at all:

| specimen | family | raw / delivered | resolved | withheld by |
|---|---|---|---|---|
| `m194-18-pylint-dev__pylint-8898#52` | I6-D | 10 / 3 | no | §5.3 — no trustworthy validation in the credit window |

**The verdict does not depend on that clause.** Admitting the specimen anyway gives
1 task in 1 repository, which fails gates A1 (`>= 3 tasks`) and A2 (`>= 3
repositories`) outright, and there would still be 0 selection witnesses for A3/A4.

## 5. Scaffold-opportunity evidence — reported separately

```
14 rows · 14 arms · 14 tasks · 8 repositories · 11 resolved / 3 unresolved
```

(39 rows across families I6-A, I6-B, I6-C and the union; I6-D contributes none.)

**Opportunity observed is not intervention proven useful.** M195A measured frequency
only, and did not test whether prompting or requiring validation in these states
helps.

## 6. Table D — success-witness partition

| witness set | rows | selection witnesses | scaffold witnesses | neither | strong |
|---|---:|---:|---:|---:|---:|
| I6-A | 4 | 0 | 4 | 0 | 0 |
| I6-B | 5 | 0 | 5 | 0 | 0 |
| I6-C | 7 | 0 | 7 | 0 | 0 |
| I6-D | 3 | 0 | 0 | 3 | 0 |
| I6-UNION | 7 | 0 | 7 | 0 | 0 |
| **total** | **26** | **0** | **23** | **3** | **0** |

The union's witnesses are `seaborn-3187`, `xarray-2905`, `pytest-10051` (×2),
`scikit-learn-11578` and `matplotlib-24970` (×2) — 5 distinct tasks across 5
repositories, all `EXACT_MATCH`, exactly as M195 reported. Their **type** is what
changes. A selection witness must instantiate a contrast about *choice*: the failed
analogue aims elsewhere. In this corpus the failed side never aims elsewhere — it
does not aim — so the only contrast available is workflow-shaped.

A structural limit reinforces this: the 33 arms cover **33 distinct instances**, so
there is no within-task failed/success analogue pair anywhere in the corpus. The
contrast a selection witness needs is not merely absent from the data; it is not
constructible from it. M195's `strong` definition is inherited unchanged and still
returns **0**: nowhere does a derived validation fail, visibly drive a revision, and
resolve.

## 7. Counterexamples — still visible, still unfavourable

| observation | count |
|---|---:|
| candidate skipped, task resolved anyway | 11 of 14 miss tasks |
| candidate run, useful failure seen, task still failed | 6 arms |
| resolved arms that never started any runner | 14 |
| relevant validation already selected, task still failed | 7 tasks |

Both directions of the counterfactual remain unfavourable, for the selection reading
and the scaffold reading alike. A validation accelerator needs the skip to hurt and
the run to help; neither is visible here.

## 8. Table B — pre-truncation selectivity

`OUTPUT_BOUND` is the frozen `<= 3` delivered cap. `PRE_TRUNCATION_SELECTIVITY` is
the raw set the bound was applied to. They are different claims.

| family | points | raw median | raw p90 | raw max | % raw >3 | % raw >5 | % raw >10 | delivered median | delivered max | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| I6-A | 23 | 1 | 1 | 2 | 0 | 0 | 0 | 1 | 2 | **SELECTIVE** |
| I6-B | 50 | 2 | 11 | 12 | 20.0 | 20.0 | 12.0 | 2 | 3 | BROAD |
| I6-C | 32 | 2 | 4 | 8 | 21.9 | 6.3 | 0 | 2 | 3 | BROAD |
| I6-D | 19 | 1 | 4 | 15 | 15.8 | 10.5 | 5.3 | 1 | 3 | BROAD |
| I6-UNION | 59 | 3 | 6 | 10 | 32.2 | 13.6 | 0 | 3 | 3 | BROAD |

Only I6-A — the mirror-path family, which cannot fan out by construction — is
selective. I6-B's p90 of **11** is the sharpest case: at that width the family is
sampling importers, not selecting a validation target.

**Concentration.** Widest raw sets are `pytest-10051` (15), `sympy-12481` (12),
`matplotlib-24970` (12), `matplotlib-25332` (11), `pylint-8898` (10).
matplotlib/matplotlib alone discards 51 candidates. I6-B causes most of the
expansion: 10 points over the bound and 70 candidates discarded, against I6-C's 14
and I6-D's 20; I6-A discards nothing.

**Delivered-rank support (§21).** There is no scalar to report. The frozen mechanism
attaches **no score** to a candidate: `rank` is the index after a coarse tier sort
with an alphabetical or insertion-order tie-break (I6-A tier then path, I6-B tier
then path, I6-C explicit before derived, I6-D regex match order). A gap between rank
1, 2, 3 and the first discarded candidate cannot be expressed. Truncation binds at
**20** points, and at **17 of those 20 every delivered candidate carries the same
derivation rule** — the cut falls inside a single homogeneous tier and is settled
alphabetically.

**Relevance of the discarded tail (§23) is not measurable.** `cap()` is applied
inside each `derive*()` before it returns, so only the *cardinality* of the discarded
set survives, as `preCapCount`. Recovering its contents would mean raising top-k,
which §26 forbids. This is itself a finding: the mechanism does not merely deliver a
bounded set, it destroys the evidence needed to judge whether the bound was
selective.

## 9. Dead-gate falsification

**Could M195's G2 distinguish raw candidate breadth? No.**

| control | raw | delivered | G2 observed | G2 |
|---|---:|---:|---|---|
| real specimen `pytest-10051#20` (I6-D) | 15 | 3 | median 3, p90 3 | **PASS** |
| synthetic §38 F5 | 10 | 3 | median 3, p90 3 | **PASS** |
| same family scored on **raw** counts | 15 | — | median 1, p90 4 | **FAIL** |

The delivered-count domain observed across all 295 rows is exactly `{0, 1, 2, 3}`,
and an exhaustive sweep of that domain finds **no** input on which G2 fails
(`g2CanFail([0,1,2,3]) === false`). G2 is unsatisfiable-to-fail in its own domain.

```
M195_G2_OUTPUT_BOUND_ONLY
```

G2 measured output boundedness. It is not a selectivity test and must not be
described as one. Had it been given the pre-truncation counts it was meant to be
about, I6-D would have failed it.

## 10. Table C — mechanism-family semantic matrix

| family | S1 selection opportunities | of which genuine | S4 scaffold | S2 already selected | S3 broader | S5 unusable | S0 fired-not-confirmed | S6 no target | M195 misses | selectivity |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| I6-A | 0 | 0 | 8 | 12 | 2 | 0 | 1 | 36 | 8 | SELECTIVE |
| I6-B | 0 | 0 | 9 | 26 | 6 | 1 | 8 | 9 | 9 | BROAD |
| I6-C | 0 | 0 | 8 | 18 | 2 | 1 | 3 | 27 | 8 | BROAD |
| I6-D | 1 | 0 | 0 | 11 | 5 | 1 | 1 | 40 | 1 | BROAD |
| I6-UNION | 0 | 0 | 14 | 32 | 6 | 1 | 6 | 0 | 14 | BROAD |

Each row sums to 59. Three families cleared M195's selection threshold on evidence
that is now entirely scaffold-shaped.

## 11. Verdicts

**Axis A — the original I6 validation-selection hypothesis**

```
VALIDATION_SELECTION_MECHANISM_NOT_WITNESSED
```

| gate | requirement | observed | result |
|---|---|---:|---|
| A1 | genuine selection misses span >= 3 tasks | 0 | fail |
| A2 | genuine selection misses span >= 3 repositories | 0 | fail |
| A3 | >= 2 success-side selection witnesses | 0 | fail |
| A4 | those witnesses span >= 2 repositories | 0 | fail |

**Axis B — the separate scaffold opportunity**

```
VALIDATION_SCAFFOLD_OPPORTUNITY_OBSERVED
```

14 episodes over 14 tasks and 8 repositories. **Observational only:**
`opportunity observed != intervention proven useful`.

## 12. Authorizations

```
NO_HELD_OUT_I6_SELECTION_REPLICATION_LICENSED
I6_VALIDATION_SELECTION_CLOSE_RECOMMENDED

NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
```

M196 is not licensed as an I6-selection replication. The held-out corpus — 6 unrun
M193 fixture instances across 6 repositories, plus the 59-instance django-weighted
reserve — remains untouched and available for a future unrelated hypothesis.

This closes the **repository-derived validation-target selection** hypothesis. It
does not claim that testing does not matter, and it does not claim that validation
scaffolds do not work. Those are different claims and this milestone did not test
them.

## 13. The scaffold hypothesis, stated and left alone

The clean corpus contains repeated episodes where a bounded relevant validation
target existed and the agent performed no validation. This exposes a separate
workflow/scaffold hypothesis: whether prompting or requiring validation in such
states improves net coding-agent outcomes.

It is not tested, not implemented, and not authorised here. It would need its own
preregistration, evidence threshold, cost model and treatment experiment, and it
inherits none of M195's I6 authorisation. It must also account for the **M188
caution**: extra lifecycle turns add cost, and forced or TDD-like workflows have
regressed resolution before. `agent did not test` does not imply `agent should be
forced to test` — and in this corpus 14 resolved arms never started a runner at all.

## 14. Runtime boundary

```
runtime-diagnosis evidence: NOT ANALYSED
```

M194's 7 runtime-diagnosis-usable arms across 5 repositories were not inspected.
That remains a separate, unauthorised research programme.

## 15. Reproduction

```bash
cd /home/calvin/code/vtrace                      # bun test needs the repo root
bun test benchmarks/stage5_vexp_swe_bench_smoke/m195aSeparation.test.ts

cd benchmarks/stage5_vexp_swe_bench_smoke
bun run_stage5_m195a_separation.ts \
  --m194 results/m194 --facts results/_m195_repo_facts \
  --dataset /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl \
  --results results --out results
```

The driver re-executes the frozen M195 audit first and halts unless all three of its
artefacts reproduce byte-for-byte, and halts again unless the additive probe agrees
with M195's published attempt and unpaired-`bash_pre` counts. Outputs:
`stage5_m195a_separation.json`, `stage5_m195a_rows.jsonl` (295 rows),
`stage5_m195a_miss_ledger.jsonl` (14 rows). No LLM is involved at any point.

## 16. Remaining interpretive limitations

- **The discarded tail's relevance is unobservable** through the frozen interface.
  Only its cardinality survives. Whether top-3 truncation captures stronger relevance
  than what it drops cannot be answered without raising top-k, which this milestone
  is not permitted to do and does not propose.
- **Absence of `DIFFERENT_VALIDATION` is a property of this corpus.** 33 arms of one
  agent configuration produced no wrong-target validation while a relevant candidate
  existed. That is a strong in-sample fact and a bound on generalisation, not a proof
  that no agent ever mis-aims a test.
- **The one S1 specimen is untestable here.** `pylint-8898#52` is the only wrong-target
  row in the corpus and its credit-window evidence is untrustworthy, so it can neither
  support nor refute the selection mechanism on its own.
- **The credit-window edge case is reported, not resolved.** `xarray-2905#45` ran the
  candidate outside the frozen forward-only window. The window was not changed, and
  one specimen is not grounds to change it.
