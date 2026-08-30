# M190 — frozen I5 out-of-sample replication

**M190 — PASS, and the hypothesis it tested is falsified.** The frozen M189 I5 derivation was
applied, unmodified, to the **314 arms in 71 tasks across 9 repositories** that M189 certified
I5-usable but never analysed. All 314 were indexed, replayed and scored: **649 decision points,
zero unfaithful replays, zero technical exclusions**. The `DEPENDENCIES` arm — the one that
produced *every* M189 specimen — still fires normally, emitting at least one candidate on **73
of 126** held-out failing arms, and it named a reference file the agent never fixed at **0 of
649** decision points, in **0 of 126** failing arms, in **0 of 71** tasks. `I5_EDIT_SET_MISS`,
the class carrying M189's entire positive signal, has **no held-out specimen at all**, so §17's
success-witness question cannot even be posed. What *did* replicate, almost exactly, is the
false-positive pressure: **96 of 181** clean successes would have received a `DEPENDENCIES`
obligation they did not need, against M189's 262 of 435 — 53% versus 60%. Pooled, M190 adds
nothing whatever to the mechanism: `I5_EDIT_SET_MISS` remains 62 arms, 4 tasks, 4 repositories,
2 witnessed, exactly as M189 left it.

---

## 1. Executive verdict

```text
M190 — PASS

I5_OUT_OF_SAMPLE_NOT_REPLICATED

NO_NEW_INTERVENTION_AUTHORIZED
```

M189 reported a real, gold-blind, bounded mechanism with a genuine success witness, and
disclosed that the derivation arm producing it had been added after a pilot and was therefore
not out-of-sample. M190 supplied the missing control. On 71 tasks the derivation had never
seen, the mechanism does not appear once, while the cost of the derivation — an unnecessary
obligation on more than half of the runs that needed nothing — reproduces at full strength.
The single most legible way to say it: **the positive signal did not transfer and the false
positives did.** PASS is the milestone verdict because the replication was executed cleanly and
answered its question; the answer is negative, and §40 is explicit that a clean falsification
passes.

---

## 2. Frozen experiment definition

The freeze was performed and committed **before the first held-out arm was indexed**, and it is
re-verified mechanically at the top of every replication run — if any load-bearing blob has
moved, the script exits rather than continue.

```text
M189 functional SHA   12a1056e8f5e2e3319440d6c884eaf1c616c678e
M189 evidence SHA     dc66a9afe17fbcec4f4ebd65ebbc5aa17dcd901f

git blob ids at the evidence SHA
  149e5e65ac128b04b96ff0fbbef6adde0dd14f05  m189Evidence.ts
  ff04588274291d7ab76520eec8870a35d340e752  m189Evidence.test.ts
  9b4db963539a432b64a6ca80b1d11e8d5265d126  run_stage5_m189_corpus.ts
  9cb1db8ed48bc2db0d3b5871e927986da8ee9aa3  run_stage5_m189_mechanism.ts
  54cccf03a46f4f04c23d05cb96a0c52e6528237f  run_stage5_m189_specimens.ts
  95a9a408191f2398e5bcf9d849a03581637bf118  run_stage5_m189_controls.ts
  31fe4d88efe739fba479a14a0a10cc55d22b5d2a  stage5_task_derivation.ts
  eb6d9fc5d2b5538c187c567fc6e988eea062ce14  validationExecution.ts
  c3c6485dd4d4e9353e5321c758f629788e77041a  src/impact/getImpactGraph.ts
blobset sha256        6916b9f4cbce93d27019a224b3e685f0bf43ecb7fc1625dc1bda798f39a498ac

held-out manifest hash f6f5a2ed297c3d11f1b77752b664ee38dbb0ab0e1b44a5024ca981f20dd83855
held-out arms          314
held-out tasks          71   (every one unseen by M189)
held-out repositories    9   (7 of them never WITNESSED by M189)
```

Freeze ordering, by commit:

```text
3859259f  manifest frozen and committed        <- before any indexing
f7124abd  analysis scripts committed           <- before any held-out outcome was read
          held-out indexing (71 instances)
          replication run, blind run, report
```

**Did any derivation semantic change after exposure?**

```text
none
```

M190 contains no derivation. It spawns `run_stage5_m189_mechanism.ts`,
`run_stage5_m189_specimens.ts` and `run_stage5_m189_controls.ts` as executables at the blob ids
above, and confines itself to driving them, partitioning their output by the frozen manifest,
and computing the two generalisation gates M189 had no need for. Re-implementing "the same"
derivation in a new file is how a replication quietly ends up measuring the reimplementation;
the price of avoiding it is that M190 borrows M189's hard-coded input path and restores it from
git afterwards, which the script verifies before exiting.

### How held-out membership was decided

An arm is held out when M189-A certified it I5-usable and it does not appear in M189-B's
committed decision-point file. Membership is derived from **artifacts, never the filesystem**:
the M189 driver's own stratum predicate asks whether an instance is indexed *right now*, and
M190's entire job was to index the instances that predicate excluded. Deriving membership from
it would have let the held-out set dissolve the moment the milestone did its work.

§8's fourth condition — not used to tune the `DEPENDENCIES` arm — follows from the third: M189
§4 records that the pilot motivating that arm ran over the first 78 arms of the M183-plus-I6
stratum, every one of which sits inside the 866.

Instance-disjointness is asserted rather than assumed, and holds: **0** instances appear in both
strata. That is what lets §17's success-witness search run inside the held-out set without
reaching back into arms M189 had already seen.

---

## 3. Held-out corpus execution

```text
eligible arms (frozen manifest)          314
  successfully indexed                   314    (71/71 instances)
  successfully replayed                  314
  excluded                                 0
decision points                          649
  faithful replays                       649
  unfaithful / dropped                     0
repositories                               9
failures / successes                 126 / 188
```

Every §9 exclusion category is empty:

```text
INDEX_UNAVAILABLE                 0
SOURCE_REVISION_UNAVAILABLE       0
DIFF_REPLAY_FAILED                0
DECISION_POINT_REPLAY_FAILED      0
OTHER_TECHNICAL_EXCLUSION         0
```

Indexing was performed in-session, not deferred: 66 instances built from scratch and 5 already
present, **89.9 CPU-minutes**, every tree materialised with `git archive` at the trace's own
`base_commit` so the bench repositories stayed read-only and no trace was scored against a
revision it never ran on.

```text
repository                 arms  tasks  failures
django/django                67     20        18
astropy/astropy              51      5        39
sympy/sympy                  47     11        19
sphinx-doc/sphinx            41     11        22
scikit-learn/scikit-learn    30      7         8
matplotlib/matplotlib        23      7        11
psf/requests                 22      2         6
pytest-dev/pytest            18      4         0
pydata/xarray                15      4         3
```

**A structural fact about this stratum, stated before the results.** All 71 tasks are new; none
of the 9 repositories is. §19's gate is nonetheless answerable, because it turns on repositories
M189 *witnessed* — sphinx and xarray — and seven of these nine were never witnessed. A new
witnessed task in django, astropy, sympy, scikit-learn, matplotlib, requests or pytest would
have cleared it.

---

## 4. Blind / evidence controls

Every control was executed on the held-out set rather than cited from M189.

```text
gold-hidden             649 held-out decision points recomputed with the gold patch erased
outcome-hidden          the same run also erases the reference test patch and grader verdict
  fingerprints compared 649
  differing               0
  verdict               DERIVATION_IS_GOLD_AND_OUTCOME_BLIND

future-action-hidden    DecisionPointEvidence is built by TRUNCATING the trace at atIndex;
                        a file the agent opens later is unrepresentable, not merely disallowed
                        verdict STRUCTURALLY_ENFORCED

replay integrity        0 of 649 decision points dropped a mutation during reconstruction

candidate boundedness   measured in §5 below, with the shipped 64-edge impact cap lifted
success false-positive  measured in §8 below, using M189-C's frozen clean-success rule
```

And one control M189 could not run, because it had nothing to reproduce against:

```text
discovery-stratum reproduction
  M189's committed sighted fingerprints        2182 decision points
  re-derived by this pipeline                  2182 decision points
  sha256                ebef9303ccec75d25f1cb50a87d0ca11d399639b959d26b782292ae9650d6f4e
                        ebef9303ccec75d25f1cb50a87d0ca11d399639b959d26b782292ae9650d6f4e
  verdict               DISCOVERY_STRATUM_REPRODUCED
```

The pipeline that produced M190's negative result re-derives M189's 866 discovery arms **byte
for byte**. A held-out result computed by a pipeline that could not reproduce its own discovery
stratum would not be worth reading, and this one can.

---

## 5. Primary held-out I5 findings

Held-out stratum only. No M189 discovery count appears in this section.

```text
[I5] MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE    93 arms  20 tasks  7 repos
[I5] I5_NO_REPOSITORY_DERIVABLE_OBLIGATION            14 arms   4 tasks  4 repos
[I5] OTHER (final patch touched no reference file)     8 arms   4 tasks  3 repos
[I5] I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION          6 arms   2 tasks  2 repos
[I5] I5_AFFECTED_CONSUMER_MISS                         5 arms   2 tasks  2 repos
[I5] I5_EDIT_SET_MISS                                  0 arms   0 tasks  0 repos
```

```text
I5_EDIT_SET_MISS arms                    0
I5_EDIT_SET_MISS tasks                   0
I5_EDIT_SET_MISS repositories            0
success-witnessed tasks                  0
success-witnessed repositories           0
refuted tasks                            0
failure-only tasks                       0
```

Zero witnessed, zero refuted and zero failure-only are all consequences of the same fact: the
class produced no specimen, so there was no task on which to ask the witness question.

### The derivation did not fall silent — it fired and was wrong

The distinction §33 turns on, computed identically on both strata:

```text                                   discovery      held-out
failing arms                                 390           126
failing tasks                                 41            30
decision points on failing arms              992           273

DEPENDENCIES emitted >= 1 candidate      268 arms       73 arms
DEPENDENTS   emitted >= 1 candidate      118 arms       31 arms

DEPENDENCIES named an unaddressed
  reference file                          62 arms        0 arms
                                         114 DPs         0 DPs
DEPENDENTS named an unaddressed
  reference file                           0 arms        5 arms
```

**The two arms trade places between strata.** In the discovery stratum `DEPENDENTS` — the
*preregistered* arm — named an unaddressed reference file on zero of 390 failing arms, and
`DEPENDENCIES` — the arm added after the pilot — named one on 62. In the held-out stratum the
pattern inverts exactly: `DEPENDENCIES` scores zero, and the five hits come from `DEPENDENTS`.

An arm that hits only on the stratum where the other arm missed is the signature of a
stratum-specific coincidence, not of a mechanism. Had `DEPENDENCIES` merely produced *fewer*
held-out hits, the honest reading would be a weak but real effect. Producing none, while the
arm it was introduced to supplement produces the only hits there are, is the reading M189 §7
warned about when it disclosed that `DEPENDENCIES` was not out-of-sample.

### §16A — candidate generation, before any analyst filtering

```text
held-out decision points                    649

DEPENDENCIES     0 candidates  306    1: 133    2-3: 160    >3: 50
                 median 1   p90 3   max 8
DEPENDENTS       0 candidates  476    1: 113    2-3:  36    >3: 24
                 median 0   p90 1   max 37
DEPENDENTS_TASK_RELEVANT
                 0 candidates  583    1:  44    2-3:   5    >3: 17
                 median 0   p90 1   max 37
```

Boundedness replicates cleanly — median 0–1, p90 at most 3, `DEPENDENCIES` never above 8. This
is the one §21 criterion the mechanism passed in M189, and it passes again. It is also the
criterion that matters least here: a small candidate set that never contains the answer is not
better than a large one.

### §16B — reference-relevant missed candidates

```text
decision points where the frozen derivation names a reference file
the failing agent never fixes                             8 of 649
  arms                                                    6  (5 failing, 1 resolved)
  tasks                                                   3  matplotlib-24149, matplotlib-24870,
                                                             sympy-13091
  repositories                                            2  matplotlib, sympy
  ...of which produced by DEPENDENCIES                     0
```

---

## 6. New witnesses

```text
none
```

There is no independently witnessed held-out task. §17's seven conditions fail at the first for
every task in the stratum: no failing arm reaches a post-edit decision point at which the frozen
`DEPENDENCIES` derivation identifies a reference-relevant candidate obligation.

### The two closest held-out cases, reported as supplementary

`I5_AFFECTED_CONSUMER_MISS` is a different frozen class — the preregistered consumer arm, not
the one M189 witnessed — so it cannot constitute replication of M189's mechanism. §16C asks for
a witness on every held-out task producing a serious I5 specimen, so both are examined here
under M189's own witness rule, and both fail it.

```text
matplotlib__matplotlib-24870                              FAILURE_ONLY_NO_SUCCESS_WITNESS
  pre-decision derivation   DEPENDENTS names lib/matplotlib/tri/_tricontour.py after the
                            agent edits lib/matplotlib/contour.py
  post-hoc score            reference patch spans contour.py AND tri/_tricontour.py;
                            3 failing arms patched contour.py only
  successful arms           0 in the held-out set, and 0 anywhere in the 1,293-arm corpus
                            (all 7 preserved arms of this task failed)
  verdict                   derivable, correct, and unwitnessable — no success exists to
                            show that editing the named file is what winning looks like

sympy__sympy-13091                                        FAILURE_ONLY_NO_SUCCESS_WITNESS
  pre-decision derivation   DEPENDENTS names sympy/core/numbers.py and
                            sympy/geometry/entity.py
  post-hoc score            the reference patch spans 21 files; the failing arms patched 2
                            and missed 20. The derivation names 2 of those 20.
  successful arms           0 held-out, 0 in the corpus (both preserved arms failed)
  verdict                   naming a tenth of a twenty-file refactor is not a bounded
                            obligation that would have changed the outcome, and §38's
                            "candidate relevance is not evidence-set necessity" applies
                            directly
```

Neither is a witness, and reporting them as near-misses would be exactly the post-hoc
promotion §17 forbids.

---

## 7. Counterexamples and refutations

The held-out set's evidence *against* I5, stated at the level §25 asks for.

```text
successful arms where the derivation fired and they resolved anyway   101 of 188
successful arms that later OPENED a file the derivation had named       5 of 188
successful arms that later EDITED a file the derivation had named       0 of 188
```

Zero. On 188 successful held-out arms, across 9 repositories, not one agent ever went on to edit
a file the frozen derivation had named at a decision point — while 101 of them received a
candidate and resolved the task without it. This is §25's first and strongest category, and it
is unanimous.

```text
failing arms that edited EVERY reference file and still failed              93 of 126
failing arms where every missed reference file was ALREADY OPEN              8 of 126
failing arms with no repository-derivable obligation at all                 14 of 126
failing arms where the missed file was reachable but never named             6 of 126
```

**Seventy-four per cent of held-out failures had nothing for a repository obligation to point
at.** They edited every file the reference patch touches and failed anyway. M189 measured this
class at 235 arms in 36 tasks across 11 repositories and called it the mechanism that actually
repeats; the held-out stratum reproduces it at a higher rate still — 93 arms, 20 tasks, 7
repositories — which is M185's conclusion arriving for the third time on data that has never
been used to argue it.

A further eight failures had missed reference files the agent had already opened. Telling an
agent to look at a file it has open is not an intervention; §20's `django-13195` lesson holds
out of sample.

---

## 8. False-positive pressure

Measured with M189-C's frozen clean-success rule — a resolved arm whose final patch already
covered every reference file — applied unchanged to a different population. Nothing was tuned,
and §22 forbids tuning it.

```text                                   M189 discovery        M190 held-out
clean-success arms                              435                  181
arms receiving ANY I5 obligation           314 (72.2%)          121 (66.9%)
  from DEPENDENTS                          122 (28.0%)           59 (32.6%)
  from DEPENDENTS_TASK_RELEVANT             26 ( 6.0%)           16 ( 8.8%)
  from DEPENDENCIES                        262 (60.2%)           96 (53.0%)
total unnecessary I5 candidates                2119                  818
  from DEPENDENCIES                            1168                  472
```

Descriptively: the false-positive rate replicates. `DEPENDENCIES` interrupts 53% of held-out
runs that needed nothing against 60% in discovery, and the union of arms interrupts 67% against
72%. Whatever failed to transfer between these two strata, it was not the derivation's
willingness to speak.

### §23 — enrichment, at task level

§13 and §24 forbid treating 18 stochastic arms of one task as 18 observations, and this stratum
would reward that error handsomely: its arms-per-task runs from 1 to 18. The task is the unit.

```text
failing tasks                                              30
  with a witnessed I5 signal                                0     0.0%
clean-success tasks                                        44
  receiving an unnecessary DEPENDENCIES obligation          23    52.3%

difference                                              -52.3 percentage points
risk ratio                                                0.0
```

The mechanism is not merely unenriched among failures — it is **anti-enriched**. On this
stratum the frozen derivation speaks to half of the tasks that needed nothing and to none of
the tasks that needed something.

### Was the held-out set simply too small?

Raw counts first, model second, with the unit and assumption stated.

```text
M189 specimen-task rate            4 / 69   = 0.058
held-out specimen tasks            0 / 71
P(0 | discovery task rate)                  = 0.014

M189 specimen-arm rate            62 / 390  = 0.159
held-out specimen failing arms     0 / 126
P(0 | discovery arm rate)                   = 3.4e-10
```

The arm-level figure is reported for completeness and should not be read as a p-value: 59 of
M189's 62 specimen arms are one sphinx task, so arms are nowhere near independent and the true
surprise is far smaller than 3.4e-10. The task-level figure is the one to read, and it treats
tasks as independent draws — an assumption that is generous to the hypothesis under test, not
to M190's conclusion. At 1.4%, the held-out stratum was large enough to have found this
mechanism if it existed at the rate M189 observed.

---

## 9. Out-of-sample verdict

```text
I5_OUT_OF_SAMPLE_NOT_REPLICATED
```

Read at the levels §13 requires:

```text
repository level   0 of 9 held-out repositories produced a witnessed task.
                   7 of those 9 were repositories M189 had never witnessed, so the
                   opportunity existed and was taken up nowhere.  §19: CROSS_REPOSITORY
                   REPLICATION FAILS.

task level         0 of 71 previously unseen tasks produced an I5_EDIT_SET_MISS specimen,
                   against a discovery rate that predicts about four.  §20: NO NEW
                   WITNESSED TASKS.

arm level          0 of 126 failing arms; the derivation nonetheless emitted candidates on
                   73 of them, so the zero is a failure to be RIGHT, not a failure to RUN.

decision point     0 of 649; 0 of the 273 on failing arms.
```

`I5_OUT_OF_SAMPLE_NOT_EVALUABLE` is explicitly not available here, and §28 is right to guard it:
every arm was indexed, every replay was faithful, every control passed, and no exclusion was
taken. This stratum answered the question it was chosen to answer.

The most economical account of the combined evidence is the one M189 §7 anticipated. The
`DEPENDENCIES` arm was introduced after a pilot showed the preregistered arm returning nothing,
and it was introduced on exactly the stratum whose specimens it then produced. Applied where it
had not been fitted, it produces none, while the preregistered arm — which produced nothing in
discovery — produces the only held-out hits. That is what a stratum-specific artifact looks
like from the outside.

---

## 10. Secondary pooled interpretation

Reported only after the held-out result above was frozen, and clearly secondary.

```text
[I5] MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE   328 arms  56 tasks  12 repos
[I5] I5_NO_REPOSITORY_DERIVABLE_OBLIGATION            79 arms  10 tasks   7 repos
[I5] I5_EDIT_SET_MISS                                 62 arms   4 tasks   4 repos
[I5] OTHER                                            23 arms   9 tasks   5 repos
[I5] I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION         19 arms   5 tasks   3 repos
[I5] I5_AFFECTED_CONSUMER_MISS                         5 arms   2 tasks   2 repos
```

```text
pooled arms                                   1180   (12 repositories, 140 tasks)
pooled I5_EDIT_SET_MISS                62 arms / 4 tasks / 4 repositories
  witnessed tasks                        2   sphinx-7462, xarray-6938
  witnessed repositories                 2   sphinx-doc/sphinx, pydata/xarray
  refuted by their own successes         1   django-12325
  no successful arm anywhere             1   pylint-4551
mechanism concentration       59 of 62 specimen arms remain one sphinx task
false-positive pressure       358 of 616 clean successes receive a DEPENDENCIES
                              obligation (58.1%), 1640 unnecessary candidates
```

**Is §21's breadth threshold now satisfied?**

```text
NO — and M190 moved it by exactly zero.

>= 3 witnessed specimen tasks           NO   2, unchanged from M189
>= 3 witnessed repositories             NO   2, unchanged from M189
success witness exists                  YES  unchanged
derivable without gold                  YES  reconfirmed on 649 new decision points
available at the decision point         YES
bounded output                          YES  reconfirmed: median 0-1, p90 <= 3, max 8
false-positive pressure acceptable      NO   58.1% pooled
not merely "more context"               YES

FULL_THRESHOLD_NOT_MET
```

Adding 314 arms, 71 tasks and 649 decision points to the corpus changed the mechanism's
specimen count, task count, repository count and witness count by nothing at all. That is a
more informative pooled result than a small increase would have been.

---

## 11. Product / experiment authorization

```text
NO_NEW_INTERVENTION_AUTHORIZED
```

§30 warns against licensing a causal experiment merely because a third repository appears. No
third repository appeared. The mechanism did not replicate, the false positives did, and §33's
question — is the mechanism real but unidentifiable, or is it common graph connectivity
correlated with gold — is answered on this evidence in favour of the second:

- the derivation fires on 53% of held-out clean successes and 0% of held-out witnessed failures;
- 101 of 188 successful arms received a candidate and resolved without it, and **not one** of
  188 ever edited a named file;
- the arm carrying the signal in discovery carries none out of sample, while the arm carrying
  none in discovery carries all five out-of-sample hits.

No pre-decision evidence in this corpus separates a necessary candidate from a harmless one.
§33 says that is itself the architectural conclusion, and it is the one M190 reaches.

Per §42, the default next decision applies: **stop I5 development.** Not tune it. The held-out
stratum existed precisely to tell us whether the discovered mechanism generalises, it says no,
and §32 forbids opening a second tuning cycle in response. `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED`
stands and M190 does not lift it.

---

## 12. Verification

```bash
# primary
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_manifest.ts
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_prepare.ts --jobs 7
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_replication.ts

# blind control, then fold it into the report
M190_BLIND=1 bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_replication.ts
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m190_replication.ts --analyze-only
```

The replication script spawns M189-B, M189-C and M189-D internally, so the M189 control commands
are executed by M190 rather than merely cited. Trees are built by the prepare phase with
`git archive <base_commit>` into `/home/calvin/.cache/m189_trees/<instance_id>`, outside git.

```text
decision points                     649 held-out  (2831 across the full analysed set)
faithful replays                    649
blind fingerprints compared         649
blind fingerprint differences         0
held-out arms successfully analysed 314 of 314
technical exclusions                  0

typecheck                  PASS
typecheck:benchmarks       PASS
bun test                   5658 pass / 49 skip / 0 fail (5707 tests, 360 files)
git diff --check           clean

live agent runs            0
live spend                 $0
Docker / live grader       not run
bench repositories         read only; git archive, no checkout, fetch or worktree
```

---

## 13. Repository state

```text
branch                 main
starting SHA           dc66a9afe17fbcec4f4ebd65ebbc5aa17dcd901f
freeze commit          3859259f9506c1e5cc375a1c3a4651d5678fe56f  (manifest, pre-indexing)
pre-registration       f7124abdd69d8e5504a4d677bd66833fb4ab892e  (scripts, pre-results)
evidence commit        5540a92421d39b876ed2c595d537e2fdbe9650af  (results, report, ledger)
final SHA              recorded by the follow-up commit that adds this line
ahead / behind         0 ahead, 142 behind origin/main
pre-existing dirt      PRESERVED — stage5_outcome_ledger.{json,md} remain modified exactly
                       as found; AGENTS.md, VTRACE_TOOLING_AUDIT.md and the untracked
                       results/_m*/ working set were not touched
M189 artifacts         restored byte-identically after every borrowed-path run; the
                       replication script exits non-zero if git reports them dirty
pushed                 no
```

M189 reported 0 ahead / 140 behind. The observed relation is now **0 ahead / 142 behind**,
consistent with M189's own two commits and with nothing having been fetched. Nothing was pulled,
merged, rebased, reset or pushed.

---

## 14. Remaining issues

Genuine evidence limitations only.

- **The held-out stratum contains no repository M189 had not already indexed.** All 71 tasks
  are new and 7 of the 9 repositories were never witnessed, so §19's gate was answerable; but a
  reader who wants I5 tested against genuinely unfamiliar *codebases* — as opposed to unfamiliar
  tasks in familiar codebases — should know that this corpus cannot supply that, and no
  preserved corpus in this repository can.

- **Two held-out tasks produced a correct pre-decision candidate that no success could witness.**
  `matplotlib-24870` and `sympy-13091` have zero successful arms anywhere in the 1,293-arm
  corpus. Both come from the preregistered `DEPENDENTS` arm rather than the replicated one, and
  neither is evidence for I5; they are recorded because §25 requires the strongest held-out
  cases to be shown alongside the counterexamples, not because they soften the verdict.

- **`I5_EDIT_SET_MISS` and `I5_AFFECTED_CONSUMER_MISS` are decided by which arm names the file
  first**, so an arm that hits in only one stratum moves specimens between classes rather than
  creating them. This is M189's frozen taxonomy behaving exactly as specified, and it is why §5
  reports both arms' raw hit counts rather than only the class labels.

- **74% of held-out failures had nothing to point at.** 93 of 126 edited every reference file and
  failed anyway. This is the fourth independent reproduction of M185's finding, now on data
  never used to argue it, and it is not a retrieval or context problem.

- **The pooled false-positive figure is not a rate over independent trials.** 616 clean-success
  arms across 140 tasks with up to 18 arms each; the task-level figures in §8 are the ones to
  quote.

- **I6 was not touched**, as §6 requires. The held-out stratum contributes 124 arms of
  `INSUFFICIENT_TRACE` and 2 of `I6_VALIDATION_SELECTED_BUT_NOT_EXECUTED`, which is the July
  2026 environment collapse restated on new arms and is not evidence about I6 either way. The
  validation → repair loop remains under-observed and unlicensed.

```text
No VTRACE product behavior was changed.
No live VTRACE utility benchmark was run.
The held-out M190 stratum was used only to test the frozen M189 I5 hypothesis.
M190 does not authorize broad change-intelligence implementation.
```
