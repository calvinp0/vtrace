# M161 rerun policy — frozen before any live run

**Frozen:** 2026-08-18, before the smoke pair and before the first `paired30` arm.
**Binding on:** M161-B smoke validation, M161-C paired execution, and any authorized
extension run.

This document exists because the decision of *what may be re-run* is the easiest
place in a paired experiment to launder a disappointing outcome into a better one.
Fixing it in advance is the only version of the rule that means anything.

---

## Allowed rerun reasons (§43)

A rerun is permitted **only** when the run failed for a reason that is not the
agent's behaviour on the task:

- network / API / provider infrastructure failure
- agent process crash unrelated to task behaviour
- Docker / grader infrastructure failure
- corrupted workspace
- treatment-invalid harness failure (index missing, wrong workspace, crash before
  the model was reached, injection did not occur when it should have)
- persistent task-environment construction fault

The driver matches provider/infrastructure failures mechanically against a frozen
pattern and retries up to 4 times with a 30 s pause. Anything that does not match
that pattern is **not retried**, and the driver says so.

## Forbidden rerun reasons (§43)

Never a rerun, under any framing:

- the agent made a bad decision
- the patch failed the tests
- the agent timed out through its own strategy
- the VTRACE context was bad or misleading
- the baseline won and it looks like luck
- the outcome is inconvenient

**No selective outcome reruns.** A rerun triggered by having read the result is
forbidden even when the stated reason appears in the allowed list — the deciding
question is whether the failure would have been classified the same way *before*
the outcome was known.

## Recording (§44)

Every rerun is recorded in `stage5_m161_rerun_record.json` with:

```text
instance
arm
original status
rerun reason
whether the frozen policy allows it
replacement run ID
```

The original run record is **never overwritten**. A rerun adds a row; it does not
edit one.

---

## Corpus replacement, which is not a rerun (§21–§22)

Replacement removes a task from the frozen sample before any money is spent on it.
It is governed separately and more strictly.

**Allowed replacement reasons:**

- source revision unavailable
- persistent benchmark corruption
- gold fixture absent from the authoritative checkout
- environment impossible to construct

**Forbidden replacement reasons:**

- VTRACE retrieval looks bad
- the agent is likely to fail
- the repository is slow
- the outcome is inconvenient

**Replacement rule:** the predeclared reserve in
`stage5_m161_extension_manifest.json` supplies the substitute — same repository
first, then reserve rank; a consumed reserve case is never reused. The reserve was
frozen with the sample, before any retrieval or agent execution.

The source-integrity gate ran over all 30 frozen cases plus all 20 reserve cases
and returned **50/50 VALID with 0 retries needed**, so no replacement is expected.
The policy is frozen anyway, because a policy written after the first invalid case
is not a policy.

---

## Why the retry budget exists at all

M160's integrity gate declared 16 instances `CORPUS_INVALID` across 8 unrelated
repositories on its first run. Every one of them fetched on a manual retry seconds
later. Twice now a transient error has nearly become a permanent claim — M159's was
a broken fixture blamed on the product, M160's was a flaky network blamed on the
benchmark.

A probe whose failure mode is indistinguishable from a finding must retry before it
is allowed to conclude. That is why retries are bounded and automatic here, and why
the count of runs that *needed* a retry is reported alongside the outcome rather
than hidden inside it.
