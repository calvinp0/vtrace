# M189 — diff-derived change / validation witness feasibility

**M189 — PASS.** The corpus can witness I5, can partly witness I6, and neither hypothesis
clears §21. Across **1,293 preserved live-agent arms**, **1,180** carry a replayable edit
chronology against a resolvable base revision; **866** of them — every I5-usable arm whose
instance could be indexed, 12 repositories, **2,182 reconstructed decision points, zero
unfaithful replays** — were run through a gold-blind derivation asking, at each post-edit
moment, what the product's own impact graph would have said. It named a reference file the
agent never fixed at **172 of 2,182** decision points. The mechanism that produces those hits
is real and, for the first time in Phase 2B, has a **success-side witness**: on
`sphinx-doc__sphinx-7462` all **9** successful arms edited the file the **59** failing arms
skipped, and on `pydata__xarray-6938` all **3** did. It still does not clear the threshold —
the witnessed specimens are **2 tasks in 2 repositories** against a bar of three and three, one
of the four specimen tasks is refuted by its own successes, and the derivation that produced
them fires on **262 of 435** successful arms that needed nothing. The class that does repeat
across the corpus is **235 arms in 36 tasks across 11 repositories where the agent edited every
reference file and still failed** — M185's finding at fifteen times the scale, and not
something repository intelligence can address.

---

## 1. Executive verdict

```text
M189 — PASS

I5_CORPUS_ADEQUATE                  I6_CORPUS_PARTIAL
I5_INTERVENTION_MECHANISM_PARTIAL   I6_NO_INTERVENTION_MECHANISM_WITNESSED

NO_NEW_INTERVENTION_AUTHORIZED
```

M189 asked whether evidence already in this repository can support or falsify a post-edit
hypothesis of the form *current diff + repository authority + observed validation state →
decision support*. For **I5** it can, and the answer is a qualified negative: the mechanism
exists, is deterministic, is derivable before the outcome is known, is small, and has real
success witnesses — in two repositories, with false-positive pressure at 60%. For **I6** the
corpus is adequate for the selection question and thin for the repair-loop question, and the
selection question returns the milestone's flattest negative: `I6_RELEVANT_VALIDATION_NOT_SELECTED`
has **zero** specimens, because agents that *could* validate had mostly already run the
reference test module — **41 of 63** failing arms and **56 of 96** succeeding ones.

---

## 2. Corpus adequacy

Population rule: every `results/runs/<label>/raw/<condition>/` carrying `_tool_calls.json` and
a `swebench-*.jsonl` row whose `instanceId` is in SWE-bench Verified.

```text
candidate arms                                   1293    (12 repositories, 143 tasks)
  with an ordered tool trace                     1293
  with >= 1 recorded mutation                    1277
  with a replayable diff against the base tree   1187
I5-usable arms                                   1180    (12 repositories)
  I5-usable FAILURES                              516    (12 repositories)
  I5-usable successes                             664

validation attempted                              472
  test runner observed to START                   216
  pass/fail result observed                       178
  result observed AND a later edit                 30
I6-usable arms                                    159    (8 repositories, 54 tasks)
  I6-usable failures                               63    (18 tasks)
```

I5 usability requires an ordered trace, at least one replayable mutation, a resolvable base
revision, a clean replay of every mutation, and a final patch. I6 usability adds M187's
**attributability condition** — an observed runner start. An arm whose every test command was
refused by the environment cannot tell us whether a repository-derived validation obligation
would have changed a decision, because the decision the agent actually faced was "the runner
does not work here".

### Why arms were excluded

```text
NO_EDIT                        16    the trace records no mutation at all
DIFF_NOT_REPLAYABLE            90    a recorded old_string is absent or ambiguous at the base tree
NO_FINAL_PATCH                 26    the result row carries no modelPatch
NO_VALIDATION_ATTEMPT         821    (I6) no test command was ever issued
NO_RUNNER_START               256    (I6) commands were issued; no runner ever started
NO_VALIDATION_RESULT           38    (I6) a runner started but produced no readable pass/fail
I5_UNUSABLE                   113    (I6) the arm fails an I5 precondition, so no validation
                                     question can be asked of a diff that cannot be rebuilt
```

### The finding that decides the I6 verdict: this corpus has two environment eras

Same model on every one of the 1,293 arms — `claude-opus-4-5-20251101`. What changes is
whether the benchmark repositories had a working dependency environment.

```text
month      arms   I5-usable   validation attempted   RUNNER STARTED   I6-usable
2026-06     857         769                    402              206         151
2026-07      97          93                     26                0           0
2026-08     339         318                     44               10           8
```

M187 established that M183's five runner starts in sixty arms was an environment fact rather
than an agent fact. M189 dates it: the capability was present at scale in June 2026 and had
collapsed by July. This is why the frozen default-path corpus contributes **4** I6-usable arms
while older milestones contribute **151** — and why a Phase-2B analysis restricted to M183, as
§8's priority ordering naively suggests, would have reported "no validation mechanism" for a
reason with nothing to do with whether the mechanism exists.

```text
I5_CORPUS_ADEQUATE
   1,180 usable arms, 516 usable failures, 12 repositories; 866 analysed end to end with
   2,182 decision points reconstructed and 0 unfaithful partial replays.

I6_CORPUS_PARTIAL
   159 usable arms across 8 repositories answer the SELECTION question. Only 30 arms in
   1,293 show a validation result followed by a further edit, and none is in the frozen
   default path, so the validation -> repair loop remains materially under-observed.
```

---

## 3. Evidence boundary

Gold, outcome and the agent's future were excluded three ways, in increasing order of how much
a reviewer should trust them.

**Structurally.** `DecisionPointEvidence` — the entire input surface of the derivation — has no
gold-patch field, no reference-test field, no `resolved` field, and no tool call with an ordinal
at or after the decision point. The evidence is built by *truncating* the trace, so "the agent
opened that file later" is not merely disallowed, it is unrepresentable. This is M185's
`classifyStage` construction applied one level harder, because M189 must derive the thing an
agent supposedly should have been told, and the temptation to derive it from the answer is
correspondingly larger.

**By separation of functions.** `deriveI5Candidates` / `deriveI6Candidates` freeze a candidate
set; `scoreCandidates` is a different function taking a different record and is the only place
the gold patch is opened. The post-decision fields that exist —
`broadCandidatesLaterInspected`, `broadCandidatesLaterEdited`, `novelFilesAfterFirstEdit` — are
computed after the set is frozen, and exist because §17's success witness needs them.

**By reproduction.** `M189_BLIND=1` erases the gold patch, the reference test patch and the
grader verdict before the dataset is parsed; the run emits only candidate fingerprints.

```text
compared decision points   2182
differing fingerprints        0
verdict                    DERIVATION_IS_GOLD_AND_OUTCOME_BLIND
```

A structural argument that a type has no gold field is worth having. A reproduction showing the
output does not move when the field is removed is worth more, and it is one environment
variable away for anyone who disbelieves this report.

---

## 4. I5 findings — diff-derived change / edit-set intelligence

### Derivation

At each decision point the reconstructed tree is diffed against the base tree with
`git diff --no-index -U0`; base-side hunks are attributed to indexed symbols; and the product's
own `getImpactGraph` is asked — with its shipped 64-edge cap lifted, so §35 measures real
fan-out — what relates to those symbols. A candidate is a related symbol in a file the agent has
neither changed nor opened before this moment.

Three arms, reported separately and never merged:

```text
DEPENDENTS                    incoming edges — things that depend on the change
DEPENDENTS_TASK_RELEVANT      the same, narrowed to symbols sharing a term with the derived task
DEPENDENCIES                  outgoing edges — things the change depends on
```

**Rule revision, disclosed (§19).** `DEPENDENTS` and `DEPENDENTS_TASK_RELEVANT` were
preregistered, because I5 as stated is about affected consumers. `DEPENDENCIES` was **added
after a pilot** over the first 78 arms returned an unaddressed-gold hit at 0 of 255 decision
points, and the post-hoc reachability diagnostic showed that the few reachable missed files
were reachable as things the change *depends on*. The derivation was blind to half the graph.
The arm was added for edge-direction coverage, tuned in no other way, applied uniformly — and
it produced every specimen in this milestone.

**Stratum revision, disclosed.** The analysis began on M183 plus the I6-usable arms (213 arms)
and was widened to every I5-usable arm with an indexed base tree (866 arms). The boundary had
to move because §17's success witness is a search over *successes of the same task*, and the
first specimen found — `sphinx-7462` — has nine resolved arms in milestones the narrow stratum
excluded. A success-witness search that cannot see the successes is not one. Widening changed
the I5 verdict; it is reported here rather than presented as the original design.

### Specimens

Counted in **distinct tasks**, not arms: fifty-nine arms of one sphinx task across many
milestones are one specimen observed fifty-nine times, and counting them separately is exactly
how a repeated mechanism gets manufactured from a small corpus.

```text
[I5] MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE   235 arms  36 tasks  11 repos
[I5] I5_NO_REPOSITORY_DERIVABLE_OBLIGATION            65 arms   6 tasks   4 repos
[I5] I5_EDIT_SET_MISS                                 62 arms   4 tasks   4 repos
[I5] OTHER (final patch touched no reference file)    15 arms   5 tasks   3 repos
[I5] I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION         13 arms   3 tasks   2 repos
```

**Taxonomy revision, disclosed (§19).** `I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION` was added
after the pilot because the preregistered taxonomy had no bucket for a state the data contains:
the index *does* connect the changed symbol to the missed file, but only at a depth the bounded
derivation does not search, so no obligation was ever emitted. It **reduces** the specimen count
rather than raising it — folding those arms into `I5_AFFECTED_CONSUMER_MISS` would have credited
a candidate that nothing produced.

### The success witness — asked the way §17 poses it

Not "do successful agents ever follow a named candidate anywhere", but "on *this repair*, is
doing the named thing what winning looks like".

```text
task                       file the failures missed          successes  edited it  resolved without it
sphinx-doc__sphinx-7462    sphinx/pycode/ast.py                      9          9                    0
pydata__xarray-6938        xarray/core/variable.py                   3          3                    0
django__django-12325       django/db/models/options.py               4          0                    4
pylint-dev__pylint-4551    pyreverse/{diagrams,utils,writer}.py       0          0                    0
```

Two tasks give a clean witness: **every** successful arm edited the file the failing arms
skipped, and no successful arm resolved without it. One task is **refuted by its own
successes** — four arms resolved `django-12325` without touching `options.py`, so skipping it
is not what caused the failure. One task has no successful arm anywhere and therefore supplies
no witness.

The corpus-wide witness is much weaker, and both numbers are true at once:

```text
successful arms                                              476
  where the derivation named at least one candidate          339
  where the agent LATER OPENED a named file                   19
  where the agent LATER EDITED a named file                    1

base rate, so those numbers are readable:
  successful arms that opened a NEW file after their first edit   116 / 476  (24%)
  failing arms that opened a NEW file after their first edit      166 / 390  (43%)
```

Post-edit exploration is common — 116 successful arms opened 211 files they had not opened
before. The generic witness is near-zero not because agents never look at anything new after
editing, but because the files they look at are almost never the ones the impact graph names.
The per-task witness above is the one that counts, and it exists for two tasks.

The base rate carries a second finding: failing arms explore *more* after their first edit than
successful ones (43% against 24%), which is M185's "winning runs read LESS" reproduced on a
corpus fourteen times larger, on the post-edit side specifically.

### False-positive pressure and boundedness (§18, §35)

```text
clean successes (final patch already covered every reference file)      435 arms
  arms that would receive at least one I5 obligation (any arm)          314
  arms that would receive one from DEPENDENTS                           122   (951 candidates)
  arms that would receive one from DEPENDENTS_TASK_RELEVANT              26   (112 candidates)
  arms that would receive one from DEPENDENCIES                         262  (1168 candidates)

candidate counts per decision point, BEFORE any analyst filtering:
  DEPENDENTS      failures  median 0  p90 1  max  5     successes  median 0  p90 1  max 40
  DEPENDENCIES    failures  median 1  p90 4  max  6     successes  median 1  p90 3  max  6
```

The output is genuinely small — median 0 to 1, p90 at most 4, never more than 6 — which is the
boundedness criterion §21 asks for, and it passes. What fails is precision: the `DEPENDENCIES`
arm, the one that produced every specimen, would interrupt **262 of 435** runs that needed
nothing.

### §21 applied in full

```text
mechanism                                 I5_EDIT_SET_MISS
specimen arms / tasks / repositories      62 / 4 / 4
  refuted by their own successes          django__django-12325
  no successful arm exists anywhere       pylint-dev__pylint-4551
witnessed tasks / repositories            2 / 2   (sphinx-7462, xarray-6938)

>= 3 specimen tasks (witnessed)           NO
>= 3 repositories (witnessed)             NO
success witness exists                    YES
derivable without gold                    YES
available at the decision point           YES
bounded output                            YES
false-positive pressure acceptable        NO
not merely "more context"                 YES

FULL_THRESHOLD_NOT_MET
```

### I5 verdict

```text
I5_INTERVENTION_MECHANISM_PARTIAL
```

Not `NO_..._WITNESSED`: a genuine mechanism with a genuine success witness exists and is
described in §6. Not `WITNESSED`: the witnessed specimens span two repositories against a bar
of three, one of four specimen tasks is refuted by its own successes, and the derivation fires
on 60% of runs that needed nothing.

---

## 5. I6 findings — diff-derived validation intelligence

### Derivation

For each changed symbol, the exact test entrypoints `getImpactGraph` relates to it, minus the
targets the agent has demonstrably run (runner observed to start). No "test file in the same
directory" rule and no generic "run pytest" recommendation — §16 forbids both, and every
candidate carries the indexed edge that produced it.

Run targets and reference test files are compared through a normalised module key, because this
corpus states test identity three ways: pytest paths, django's dotted `module.Class.test`
labels, and bare sympy function names. The reference test set is taken from the gold
`test_patch`'s files rather than from `FAIL_TO_PASS`, because only the former is uniform across
repositories.

### Specimens

```text
[I6] INSUFFICIENT_TRACE                             313 arms  40 tasks  11 repos
[I6] I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED     41 arms  14 tasks   5 repos
[I6] I6_NO_REPOSITORY_DERIVABLE_VALIDATION           22 arms  10 tasks   4 repos
[I6] I6_VALIDATION_SELECTED_BUT_NOT_EXECUTED         14 arms   8 tasks   6 repos
[I6] I6_RELEVANT_VALIDATION_NOT_SELECTED              0 arms   0 tasks   0 repos
```

**`I6_RELEVANT_VALIDATION_NOT_SELECTED` is empty.** That is the class I6 exists to find, and
across 63 I6-usable failing arms in four repositories the corpus contains none of it.

```text
I6-usable FAILING arms that ran a reference test module     41 / 63   (65%)
I6-usable SUCCEEDING arms that ran a reference test module  56 / 96   (58%)
```

Agents that could validate mostly already validated against the module the grader uses, at
essentially the same rate whether they went on to pass or fail. An obligation naming that
module would have been telling them to do what they had done. The largest I6 class,
`INSUFFICIENT_TRACE` at 313 arms, is the environment era of §2 restated per-arm: those arms
cannot witness the hypothesis either way, and M189 records that rather than scoring it as
evidence of absence.

### Boundedness — the depth trap (§18)

```text
index-derived exact test files per decision point (failures):
  depth 1   median 0  p90 1   max   3      706 of 992 decision points emit NOTHING
  depth 2   median 1  p90 9   max 233

names a reference test file:      depth 1   12 of 159 arms
                                  depth 2   62 of 159 arms

unnecessary I6 candidates across the 435 clean successes:
  depth 1      724
  depth 2   15,099
```

The test-obligation lane is either empty or explosive. §18 is explicit that an intervention
saying "inspect these 19 connected files" has not solved the problem. At depth 2 this one says
up to 233.

### I6 verdict

```text
I6_NO_INTERVENTION_MECHANISM_WITNESSED
```

---

## 6. Strongest specimens, and the counterexamples that matter

### The strongest specimen: `sphinx-doc__sphinx-7462`

```text
decision point        AFTER_FIRST_EDIT — tool ordinal 3 in the M183 baseline arm, 1 mutation
current diff          sphinx/domains/python.py :: _parse_annotation
repository fact       DEPENDENCIES arm, depth 1, 2 candidates total, one of which is
                      sphinx/pycode/ast.py — the changed symbol calls into it
agent action after    never opened sphinx/pycode/ast.py; the second edit stayed in python.py
outcome evidence      the reference patch spans python.py AND pycode/ast.py; the arm failed
pre-gold availability YES — the candidate fingerprint is byte-identical under M189_BLIND
success witness       9 successful arms of this task are in the analysed set and ALL NINE
                      edited sphinx/pycode/ast.py; none resolved without it. (The corpus
                      holds 11 resolved arms; 2 lack a replayable diff and are excluded.)
repetition            59 failing arms across many milestones, all with the same shape —
                      one task observed 59 times, not 59 specimens
```

This is exactly the shape I5 predicted: a small, correct, deterministic, pre-decision obligation
naming the one file the agent needed and never opened, with successful agents demonstrably doing
the named thing. It is the strongest evidence Phase 2B has produced, and it is one task in one
repository.

### The second witness: `pydata__xarray-6938`

```text
current diff          xarray/core/dataset.py :: Dataset.swap_dims
repository fact       DEPENDENCIES arm names xarray/core/variable.py — a reference file
success witness       3 successful arms, all 3 edited xarray/core/variable.py
counterevidence       in the failing arm the agent OPENED xarray/core/variable.py of its own
                      accord after the first edit and still did not edit it. The obligation
                      was derivable and correct, and would have named a file the agent
                      reached anyway. DERIVABLE = yes, UTILITY WITNESS = partial.
```

### The counterexample that refutes its own specimen: `django__django-12325`

Reference patch spans `db/models/base.py` and `db/models/options.py`; the failing arm edited only
`base.py`, and `options.py` is a depth-1 dependency. But **four successful arms of the same task
resolved it without touching `options.py`**, and in the failing arm `options.py` was **tool call
3** — read before the first edit. An obligation here would have been both unnecessary and
vacuous. This is the case §20 exists for: derivability and utility come apart.

### The counterexample that shows the graph cannot always reach: `django__django-13195`

Reference patch spans `http/response.py`, `contrib/messages/storage/cookie.py` and
`contrib/sessions/middleware.py`. Two arms edited `response.py` only, and neither missed file is
reachable from the changed symbol over indexed edges within depth 3 in either direction —
`I5_NO_REPOSITORY_DERIVABLE_OBLIGATION`. Five further arms of the same task edited **all three**
reference files and still failed. M185 called this the evidence-visible case; M189 adds the
derivability half and the count.

### The mechanism that actually repeats

```text
MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE   235 arms, 36 tasks, 11 repositories
```

Two hundred and thirty-five failing arms edited **every** reference file and still failed. This
is by far the largest class in the milestone, it clears every count bar §21 sets, and no
repository-derived obligation addresses it — there is nothing to point at that the agent did not
already have open. It is M185's conclusion, ContextBench's conclusion and Khatri's conclusion,
reproduced here on 866 arms across 12 repositories with a gold-blind derivation.

---

## 7. Anti-post-hoc controls

```text
gold-hidden          2182 decision points recomputed with the gold patch erased
                     0 differing candidate fingerprints                  PASS
outcome-hidden       the same run also erases the grader verdict
                     0 differing candidate fingerprints                  PASS
future-action        DecisionPointEvidence is built from calls with index < atIndex;
                     a later-opened file is unrepresentable              STRUCTURALLY ENFORCED
success false-pos    314 of 435 clean successes would receive an I5 obligation
                     (DEPENDENCIES alone: 262 of 435, 1168 candidates);
                     724 unnecessary I6 candidates at depth 1, 15,099 at depth 2
boundedness          I5 median 0-1, p90 1-4, max 6 (small)
                     I6 depth-1 median 0, depth-2 max 233 (empty or explosive)
replay integrity     0 of 2182 decision points dropped a mutation during reconstruction
```

Two controls M189 could **not** run, both disclosed rather than buried:

- **There is no held-out derivation.** The `DEPENDENCIES` arm was added after a pilot on 78 of
  the 866 arms, so its specimens are not fully out-of-sample. Since it is also the arm carrying
  the milestone's only positive signal, this is a real limitation on the positive half — it is
  precisely why the result is reported as PARTIAL and authorizes nothing.
- **Specimen repetition is unbalanced.** 59 of the 62 `I5_EDIT_SET_MISS` arms are one sphinx
  task. Task-level counting neutralises the inflation for the verdict, but it means the
  mechanism's evidence rests on two tasks and cannot be strengthened by re-running the corpus.

---

## 8. Product authorization

```text
NO_NEW_INTERVENTION_AUTHORIZED
```

§21 requires all of its criteria, and `I5_EDIT_SET_MISS` fails three: witnessed specimens span
two tasks in two repositories rather than three and three, and false-positive pressure is 60%
of runs that needed nothing. I6 fails at the first criterion — its defining class is empty, and
the behaviour it would correct is already performed at the same rate by agents that fail and
agents that succeed. `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED` stands.

What M189 does change is the standing of the I5 class. Before this milestone the class was a
hypothesis motivated by a competitor's changelog (M188 §5). It is now a measured mechanism with
a deterministic derivation, a demonstrated pre-gold derivation boundary, a bounded output, and
twelve successful arms across two repositories doing exactly what it names. It is two
repositories short and one precision problem away from being testable. That is a materially
different position from "no evidence", and it is not authorization.

---

## 9. Evidence-acquisition recommendation

**A new corpus is not required to answer I5 or the I6 selection question**; both were answered
on evidence already here. Two narrower gaps are real, and `stage5_m189_evidence_acquisition.md`
specifies the smallest observational corpus that would close them:

- **I5 repetition.** The mechanism needs witnessed specimens in a third and fourth repository.
  This does not need new live runs first — it needs the derivation applied to the remaining
  I5-usable arms whose instances M189 did not index (314 arms, 71 further tasks, 9
  repositories), which is offline work.
- **The validation → repair loop.** 30 arms in 1,293, none in the frozen default path, all in
  the June 2026 environment era. Closing this *does* need new observation, under M187's repaired
  environment, baseline-only, with no forced lifecycle.

Both are observational mechanism discovery, not a VTRACE-versus-baseline benchmark, and M189
runs neither.

---

## 10. Verification

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_corpus.ts
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_mechanism.ts
M189_BLIND=1 bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_mechanism.ts
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_specimens.ts
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_controls.ts
bun test ./benchmarks/stage5_vexp_swe_bench_smoke/m189Evidence.test.ts
```

`run_stage5_m189_mechanism.ts` needs per-instance base trees indexed by the product indexer.
They are built outside the repository and outside git, and the bench-repo checkouts are only
ever read:

```bash
git -C <bench-repo> archive <base_commit> | tar -x -C /home/calvin/.cache/m189_trees/<instance_id>
bun src/cli/index.ts index /home/calvin/.cache/m189_trees/<instance_id> --quiet --json
```

```text
typecheck                  PASS
typecheck:benchmarks       PASS
bun test                   5658 pass / 49 skip / 0 fail (5707 tests, 360 files)
git diff --check           clean

live agent runs   0
live spend        $0
docker            not used
bench repos       read only; no checkout, no fetch, no worktree
```

---

## 10b. Repository state

```text
branch            main
starting SHA      08ba50e95185b0d18f3e1b3e39af314ef09f7f19
functional SHA    12a1056e8f5e2e3319440d6c884eaf1c616c678e
ahead / behind    0 ahead, 140 behind origin/main (unchanged; nothing pushed)
pre-existing dirt PRESERVED — stage5_outcome_ledger.{json,md} remain modified exactly as
                  found, and AGENTS.md, VTRACE_TOOLING_AUDIT.md and the untracked
                  results/_m*/ working-artifact set were not touched
pushed            no
```

---

## 11. Remaining issues

Genuine Phase-2B evidence limitations only.

- **The I5 mechanism is two repositories short**, and its 62 specimen arms are 59 from one task.
  Extending the derivation to the 314 I5-usable arms whose instances were not indexed is the
  cheapest way to find out whether it repeats; it is offline and costs no live spend.
- **`DEPENDENCIES` is not out-of-sample.** Added after a 78-arm pilot, and it is the arm that
  carries the positive signal. See §7.
- **False-positive pressure has not been reduced, only measured.** 262 of 435 clean successes.
  No filtering rule was tried, deliberately: §15 forbids inventing relevance bonuses, and any
  precision work belongs to a milestone that is authorized to design an intervention.
- **The validation → repair loop is under-observed** — 30 arms in 1,293, none in the frozen
  default path. The only question in M189's scope the corpus cannot answer well.
- **The I6-usable corpus is one environment era.** 151 of 159 usable arms are from June 2026.
  The model is identical across eras, so era is not a confound for the agent, but the I6
  negative rests on runs whose treatment was capsule injection rather than the frozen default
  path.
- **Symbol attribution is depth-1 and Python-shaped.** Depth 2 was measured and rejected on
  boundedness, not on recall.
- **Out of scope, recorded not fixed:** the reachability diagnostic and the derivation disagree
  across arms of the same task (`django-16263`) because each arm edited different symbols. That
  is correct behaviour, but it means "is this file reachable" is a property of the edit, not of
  the task, and a future milestone reasoning about task-level reachability must not reuse these
  numbers.

```text
No VTRACE product behavior was changed.
No live VTRACE utility benchmark was run.
M189 does not itself authorize implementation of a new agent-facing intervention.
```
