# M191 Stage A — preregistered validation-readiness probe design

**Written and committed BEFORE any probe was executed.** Nothing in this document was
edited after an observation. A row whose observed state disagrees with this design is
reported as a disagreement, not rewritten (M187 §15 discipline, and the one M187
expectation that did move is recorded in its artifact as `expectationRevised`).

No agent is spawned by Stage A and no live budget is spent. Stage A is a capability
measurement, not a behaviour measurement: it asks whether a legitimate repository test
command *can* run if an agent issues one, which is answerable without paying an agent to
ask it.

---

## 1. What is under test

M187 repaired the execution path and proved the repair on 4 repositories with 11
hand-authored probes. It did **not** measure how many SWE-bench repositories actually
have a working dependency environment on the testbed interpreter, and it said so
(`stage5_m187_final_report.md` §10.1: "per-task dependency provisioning remains
unsolved"). Two of its own probes — `A3` (requests) and `A4` (sympy) — are recorded
*expecting* `STARTED_INFRA_FAILURE`, i.e. two of its four repositories were already
known not to run.

M191 Stage B would need a **cross-repository** observational corpus (the M189 Gap-B
design asks for >= 4 repositories). So Stage A must measure repository breadth, not
just mechanism health.

## 2. The probe, and why it is not author-chosen

Each probe uses the benchmark's own ground truth rather than a test this milestone
picked because it passes:

```text
base tree      git archive <base_commit>  from .bench-repos/<repo>   (read-only export)
test patch     the instance's own test_patch, applied to that tree
P-probe        one PASS_TO_PASS test   -> must PASS at base commit, by SWE-bench's definition
F-probe        one FAIL_TO_PASS test   -> must FAIL at base commit, by SWE-bench's definition
```

`FAIL_TO_PASS` failing at the base commit is what makes the instance an instance. So
the F-probe is a **naturally failing test**: §8's "one genuine failing test execution"
is obtained without altering any source to manufacture it.

This is what makes the probe pair decisive. A repository is only credited when the same
environment produces `STARTED_PASSED` on the P-probe *and* `STARTED_FAILED` on the
F-probe. That pair is precisely §8's requirement that

```text
runner executed + tests failed
```

be provably distinguishable from

```text
infrastructure prevented runner start
```

## 3. Instance selection (fixed before any probe ran)

Deterministic, and blind to any outcome:

```text
corpus     $VEXP/data/swe-bench-100.jsonl  (the 100-instance Stage 5 dataset)
per repo   sort instances by instance_id ascending; take the FIRST one that has
           a non-empty FAIL_TO_PASS, a non-empty PASS_TO_PASS, and a test file
           derivable from its test_patch
tests      the FIRST id in each list, in the order the dataset stores it
```

No repository is excluded in advance, including the ones M187 already knew were broken.
All 12 repositories in the dataset are probed.

## 4. The execution path is the agent's path

The environment is built by the production `materializeAgentShellGuard` call — the same
call `runCondition` makes — and every probe runs through `bash -c` with that env, which
is what the agent's Bash tool does. No conda activation, no host PATH, no privileged
interpreter, no bypass. The external harness's `cleanPreviousRun` is applied faithfully
to the harness output directory before probing, so the M187 layout is under test in the
state a live run would leave it.

## 5. The control

`Z1` re-materializes the **pre-M187** arrangement — guard wrappers written into the
directory the external harness wipes on start-up — and re-runs a command the repaired
path passes. It must NOT start a runner. If Z1 starts, this probe suite cannot detect
the defect it claims is fixed and every other row is worthless.

## 6. Preregistered gate

Per-repository verdict:

```text
REPO_VALIDATION_READY     P-probe STARTED_PASSED  AND  F-probe STARTED_FAILED
REPO_RUNNER_ONLY          runner starts on both, but the pair does not discriminate
REPO_NOT_RUNNABLE         either probe fails to start, or the environment breaks first
```

The milestone gate. `VALIDATION_ENVIRONMENT_READY` requires **all six**:

```text
R1  >= 3 repositories reach STARTED_PASSED on the P-probe
R2  >= 3 repositories reach STARTED_FAILED on the F-probe
R3  >= 1 repository proves both on the same instance (REPO_VALIDATION_READY)
R4  the Z1 control does NOT start a runner
R5  no probe required a privileged bypass of the agent-accessible path
R6  >= 4 repositories are REPO_VALIDATION_READY
```

R1–R5 test the **mechanism**. R6 tests **breadth**, and is a gate rather than a remark
because §9 names "baseline environments are materially inconsistent" as a NOT_READY
condition, and because the M189 Gap-B acquisition design this milestone would be
acquiring for requires >= 4 repositories. A mechanism that works on two repositories
cannot supply a cross-repository observational corpus.

Failing any of R1–R6 yields `VALIDATION_ENVIRONMENT_NOT_READY` and Stage B does not run.

## 7. What Stage A deliberately does not establish

- It does not measure whether an agent *chooses* to validate. That is Stage B's
  question and cannot be answered by a probe.
- It does not repair anything. If a repository's dependency environment is absent,
  Stage A records it; provisioning per-task environments is outside M191's scope and
  §9 forbids repairing arbitrary external infrastructure.
- A `REPO_VALIDATION_READY` verdict is about **one instance** of that repository. It is
  evidence the repository's environment can work, not that all of its instances do.
