# M185 — M183 Failure-Stage Audit (final report)

```text
M185 overall              PASS

A  evidence authority and cohorts     PASS
B  classifier and timelines           PASS
C  correct-focus comparative audit    PASS
D  repository-fact addressability     PASS
E  counterfactual feasibility         PASS
F  strategic closure                  PASS

primary bottleneck verdict    DOWNSTREAM_REPOSITORY_INFORMATION_BOTTLENECK_PARTIAL
failure-stage verdict         CROSS_FILE_CONTRACT_DOMINANT
VTRACE-addressability verdict CURRENT_VTRACE_AUTHORITY_PARTIALLY_ADDRESSES_FAILURE_MODE
counterfactual verdict        NO_COUNTERFACTUAL_INTERVENTION_LICENSED
coding-agent utility verdict  VTRACE_AGENT_UTILITY_HYPOTHESIS_WEAKENED
product-work verdict          NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED

correct-focus failures        6
correct-focus successes       13
non-gold-focus successes      6
non-gold-focus failures       5
VTRACE-only wins              2
baseline-only wins            2
both-fail pairs               9
both-solved pairs             17

candidate repeated downstream mechanisms        0
candidate currently VTRACE-derivable mechanisms 2 of 6 cases; 0 mechanisms clear the repetition threshold

product changed     NO
retrieval changed   NO
ranking changed     NO
orientation changed NO
live spend          $0.00
live work           NOT RUN
docker grading      NOT RUN
```

## Headline conclusion

After controlling for localization, M183's failures were not consistently
explained by missing repository information. Four of the six correct-focus
failures do carry a concrete, witnessed repository fact the run never acquired,
and two of those are derivable from current VTRACE authority — so the gap is real
and measurable. But **no successful run anywhere in the corpus recovered the
equivalent evidence**, which is the gate that decides whether such a fact is
causal. The thirteen correct-focus successes read a median of one file, eleven of
thirteen read exactly one, and one of thirteen opened a test file; their median
tool-call count is 7 against 15.5 for unresolved arms. Successful runs recovered
*less* repository evidence, not more. The dominant failures were repair synthesis
and coding judgment on evidence the agent already had, or a choice between two
locally-plausible edits decided by intuition. Current VTRACE authority does not
contain a repeated decisive missing fact. **No further coding-agent utility
product work is licensed from this benchmark.**

## M185-A — evidence authority (§57–§60)

Every seal recomputed from the artifacts on disk, not read from M183's summary.

    arms fully verified                60 / 60
    result-row / runMeta / toolCalls / agentStream / evalMeta seals   all match
    arms with tool-call OUTPUTS preserved                             60 / 60
    gold files recomputed from the dataset patch and agreeing         30 / 30
    valid pairs                                                       30 / 30

Cohorts reconstructed from the row data and reconciled against M183's headline:

| Cohort | Reconstructed | M183 |
|---|---:|---:|
| A correct-focus failures | 6 | 6 |
| B correct-focus successes | 13 | 13 |
| C non-gold-focus successes | 6 | 6 |
| G non-gold-focus failures | 5 | 5 |
| D VTRACE-only wins | 2 | 2 |
| E baseline-only wins | 2 | 2 |
| F both-fail | 9 | 9 |
| both solved | 17 | 17 |
| focus is a gold file | 19 | 19 |

"Correct focus" keeps M183's definition and was not redefined (§59). One edge
case exists and is recorded separately: `pytest-dev__pytest-6197`, where the
orientation named a gold *symbol* in a non-gold file.

## M185-B — classifier (§61–§64)

`stage5_m185_classifier_contract.md` was written and committed before any case
transcript was read in detail. `classifyStage` in `m185Audit.ts` takes an evidence
record with **no outcome field**, so a stage cannot be inferred from knowing the
run failed. Ordering is the contract: `S3_CROSS_FILE_CONTRACT` is evaluated before
`S2_REPAIR_HYPOTHESIS` precisely so the mechanism M185 was hunting cannot be
absorbed into a generic bad-repair bucket whenever both descriptions fit.

Every "the run never saw this" claim is a probe recomputed at run time against
M183's preserved tool outputs. All six agree with their label; a disagreement
fails the script.

**Controls, both selected by a mechanical pre-filter over read-set overlap before
either transcript was read.**

*Known-positive* — `pytest-dev__pytest-6197`. `_ALLOW_MARKERS`, the mechanism that
makes package `__init__.py` files collectible, is on screen **twice** for the
treatment and **zero** times for the baseline. The treatment edited
`src/_pytest/python.py`, the file the fact lives in and the reference patch's
file; the baseline edited `src/_pytest/main.py`. Evidence acquisition predicts
behaviour, and the detector finds it. PASS.

*Known-negative* — `django__django-12325`. `field.remote_field.parent_link` is on
screen 6 times for the treatment and 5 for the baseline, and the outcomes still
diverge. The classifier returns `NO_MISSING_REPOSITORY_FACT` rather than inventing
one. PASS.

## M185-C — what separated success from failure

### Post-contact behaviour

| Group | Arms | Median tool calls | Median distinct files read | Read exactly one file | Read a test file | Executed the suite |
|---|---:|---:|---:|---:|---:|---:|
| All arms | 60 | 14 | 1 | 33 | 12 | 5 |
| Resolved | 38 | 11 | 1 | 23 | 7 | 2 |
| Unresolved | 22 | 15.5 | 2 | 10 | 5 | 3 |
| A correct-focus failure | 6 | 10.5 | 1.5 | 3 | 0 | 1 |
| B correct-focus success | 13 | 7 | 1 | 11 | 1 | 0 |
| C non-gold-focus success | 6 | 18.5 | 3.5 | 0 | 3 | 0 |
| G non-gold-focus failure | 5 | 19 | 1 | 3 | 2 | 0 |

The direction is the opposite of the hypothesis. More downstream investigation
tracks failure, not success — and not because investigation causes failure, but
because the tasks that need it are the hard ones. There is no evidence pattern
that successful runs share and failed runs lack.

### Validation

Only **5 of 60** arms ever executed the repository's own test suite. 14 tried;
9 attempts were refused by the environment. Validation is absent from both arms,
so it is not what separates them — and no validation-stage intervention is
evaluable on this harness. See `stage5_m185_outstanding_defects.md`.

### Evidence overlap by outcome

    both solved            median read-set Jaccard   1.00
    both fail                                        0.60
    VTRACE-only wins                                 0.24
    baseline-only wins                               0.26

Discordant pairs differ in what they read — and in two of the four the **losing**
arm read more, including more of the reference patch's own material.

## Required correct-focus table (§94)

| Task | Repo | Resolved? | First downstream divergence | Missing repo fact? | VTRACE derivable? | Counterfactual support |
|---|---|---:|---|---|---|---|
| psf__requests-5414 | requests | no | turns validation into mutation of every ASCII host | yes — `TestPreparingURLs` encodes that ASCII hosts must not change | authority only, at hop 4 of 92 symbols; no tool or query surfaces it | WEAK |
| django__django-11820 | django | no | scopes the defect to the reported `pk` symptom; never asks what follows a non-relational part | yes — `Query.names_to_path` refuses that traversal | no — needs a mirror-implementation relation VTRACE does not model | WEAK |
| django__django-13195 | django | no | picks `samesite='Lax'` and leaves `secure` alone, against a delegate signature on screen | no — the fact was already read | already delivered | NO |
| mwaskom__seaborn-3187 | seaborn | no | scopes every search to `seaborn/_core/` | yes — `locator_to_legend_entries` is the classic API's legend path | **yes, currently** — pivot for three issue-derived queries; default packet chose `__all__` | WEAK |
| sphinx-doc__sphinx-7462 | sphinx | no | patches the one `unparse` it can see, and renders nothing where `()` belongs | yes — a second `unparse` in `sphinx/pycode/ast.py` with the same defect | with composition — read focus body, then look the name up | WEAK |
| sympy__sympy-13974 | sympy | no | guards on `is_Integer`, excluding the symbolic exponent; leaves `tensor_product_simp_Mul` alone | no — that function's own TODO was on screen 3× | already delivered | NO |

## Required failure-stage table (§95)

| Failure stage | Count | Repositories | Repository-addressable? |
|---|---:|---|---|
| cross-file contract (S3) | 4 | requests, django, seaborn, sphinx | PARTIAL — 2 of 4 |
| repair synthesis (S2) | 1 | sympy | NO |
| implementation (S4) | 1 | django | NO |
| behavioural understanding (S1) | 0 | — | — |
| validation (S5/S6/S7) | 0 | — | not evaluable on this harness |
| localization (S0) | 0 | — | — |
| environment (S8) | 0 | — | — |
| stochastic / model (S9) | 0 | — | — |

Evidence-acquisition split: `EVIDENCE_NOT_ACQUIRED` 4, `EVIDENCE_ACQUIRED_BUT_MISUNDERSTOOD` 1,
`EVIDENCE_ACQUIRED_AND_UNDERSTOOD_BUT_BAD_REPAIR` 1.

The S3 count of 4 is the strongest thing in this report and it is why the primary
verdict is PARTIAL rather than a flat negative. It is also why the counterfactual
verdict is still negative: of those four, two are not derivable at all, and none
has a successful-run witness.

## Required candidate-fact table (§96)

| Fact | Failed runs missing it | Successful witness | Current VTRACE can derive | Default orientation exposes | Generic enough? |
|---|---:|---|---|---|---|
| prepare_url must not mutate an ASCII host | 1 | COMPATIBLE_ONLY — the winner never opened the test and rejected the loser's patch on performance grounds | authority at hop 4 only | no | no — 1 task |
| a lookup may not traverse past a non-relational field | 1 | NONE | no — new semantics | no | no — 1 task |
| the classic legend path lives in `locator_to_legend_entries` | 1 | NONE | **yes** | no | 2 tasks with sphinx |
| a second `unparse` carries the same defect | 1 | NONE | with composition | no | 2 tasks with seaborn |
| the wrapper default must match `set_cookie`'s | 1 | n/a — already read | already delivered | yes | n/a |
| `tensor_product_simp_Mul` cannot handle a Pow | 1 | n/a — already read | already delivered | yes | n/a |

## Required answers

**§97 — facts VTRACE already knows but does not project, or facts it does not know at all?**
Both, in a 2:2 split of the four cases with a missing fact. `seaborn-3187` is the
clean "already knows, does not project" case: the symbol is indexed, sits in the
same file as the delivered focus, carries an incoming call edge and a test caller,
and is returned as a *pivot* by three issue-derived queries — while the default
packet spent its same-file slot on `__all__`. `sphinx-7462` is derivable only by
composition, and the trigger (a nested function's name) is not itself indexed.
`requests-5414` is in the authority at hop 4 among 92 symbols, which is presence
without selectability. `django-11820` needs a relation VTRACE does not model at all.

**§98 — what did successful runs recover that failed runs did not?**
Nothing consistent. They recovered less. Eleven of thirteen correct-focus
successes read exactly one file; one of thirteen opened a test.

**§99 — why did the six correct-focus VTRACE runs fail?**
Four on a cross-file contract or a second implementation site; one on a repair
mechanism that could not produce the required behaviour; one on an implementation
choice made against a delegate signature it had already read. Not "reasoning" —
but in two of the six the decisive text was verifiably on the agent's screen when
it chose otherwise, and in a third the arm with *more* evidence wrote the worse
patch.

**§100 — how did six runs solve despite a non-gold focus?**
Three ignored the packet entirely (`touchedAny=false`) and self-localized. Two
touched an orientation file and then left it for a gold file. One had the gold
file in the related list behind a wrong focus. Correct focus is neither necessary
nor sufficient — and `pytest-dev__pytest-6197` was solved by editing
`src/_pytest/main.py`, outside the reference patch's file set entirely.

**§101 — are the four discordant pairs causal or stochastic?**
Stochastic. `astropy-14369`: same diagnosis both sides; the loser had *read a
working left-recursive sibling grammar* and wrote its own three-alternative rule
anyway. `django-12325`: identical decisive evidence, different repair — M185's
known-negative. `requests-5414`: the winner considered and rejected the loser's
patch on performance grounds. `pytest-6197`: the loser held strictly more of the
reference patch's material. In none of the four was the orientation causal.

**§102 — why can VTRACE not address the dominant failure mode?**
Because the dominant mode is choosing between two locally-plausible edits, and the
inputs to that choice were already present. In `django-13195` both arms read
`set_cookie(..., samesite=None)` and both wrote `samesite='Lax'`. In `sympy-13974`
the arm that read the TODO wrote the worse patch. Supplying a fact is VTRACE's
only lever, and these failures were not fact-limited. Addressing them would mean
evaluating candidate repairs against consequences — a different kind of system,
and one the current product is explicitly not (§39).

**§103 — is there still a measured path to a better solve rate?**
Not from this benchmark. Two measurements now point the same way: M183 found no
effect from supplying the right place, and M185 finds no repeated fact whose
absence explains the failures. The one concrete gap M185 did find — the
parallel-implementation-site mechanism — is a *localization* gap at edit-set
granularity, which is the hypothesis M183 already tested and measured at zero.
The demonstrated ceiling of the repository-intelligence intervention, for this
agent and this task distribution, has been reached. A different thesis (a
different agent, a different task distribution, or a product that reasons about
repairs rather than supplying facts) is not ruled out and is not evidenced here.

## Artifacts

    stage5_m185_plan.md                        frozen before any case was read
    stage5_m185_start_state.json
    stage5_m185_classifier_contract.md         frozen before any case was labelled
    stage5_m185_m183_authority.json            60/60 seals, 30/30 gold recomputations
    stage5_m185_cohorts.json                   machine-readable cohort membership
    stage5_m185_post_focus_behavior.json       60 arms, per-arm and per-cohort
    stage5_m185_validation_audit.json          5/60 executed the suite
    stage5_m185_controls.json                  known-positive and known-negative
    stage5_m185_correct_focus_failures.json    the six mandatory case records
    stage5_m185_correct_focus_successes.json   the comparison group
    stage5_m185_wrong_focus_successes.json     how six solved without a gold focus
    stage5_m185_discordant_pairs.json          the two wins on each side
    stage5_m185_failure_stage_counts.json
    stage5_m185_vtrace_addressability.json     offline derivation replay
    stage5_m185_counterfactual_candidates.json breadth, gates, verdict
    stage5_m185_architecture_decision.md
    stage5_m185_outstanding_defects.md

M183's raw transcripts, patches, grader reports and orientation packets are not
duplicated; the records reference them by label, path and recomputed count.

## Verification

    bun run typecheck              PASS
    bun run typecheck:benchmarks   PASS
    bun test                       5592 pass / 49 skip / 0 fail
    git diff --check               clean

    src/ product diff              NONE
