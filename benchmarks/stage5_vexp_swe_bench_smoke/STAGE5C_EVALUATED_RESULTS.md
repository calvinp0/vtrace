# Stage 5C preliminary evaluated SWE-bench smoke result

First **evaluated** Stage 5C signal. Two external SWE-bench tasks were run and
**Docker-evaluated** (real pass/fail), comparing `--no-vexp` baseline against
`--no-vexp` + vtrace indexed-context injection. This is a **tiny evaluated smoke
result**, not a public benchmark claim.

## 1. Scope

This compares two conditions on two Django instances, with vexp disabled in
**both** conditions and patches evaluated through real Docker pass/fail.

It explicitly does **not** claim:

- full SWE-bench pass@1
- statistical significance
- that vtrace beats vexp
- full 100-task performance
- general coding-agent superiority

With only two tasks, both from Django, this is a smoke result rather than a
benchmark measurement.

## 2. Protocol

- **baseline**: `vexp-swe-bench` run with `--no-vexp`.
- **vtrace**: `vexp-swe-bench` run with `--no-vexp` **plus** vtrace
  indexed-context injection (the local prompt patch injects a context file built
  from real `vtrace index` + `vtrace capsule` retrieval against the task checkout
  at its base commit).
- **evaluation**: Docker evaluation through `vexp-swe-bench evaluate`
  (`--mode docker`), which runs the real SWE-bench test suite so each patch gets
  a genuine pass/fail `resolved`.
- **model/agent**: whatever is recorded in the raw JSONL / evaluation report for
  these runs; no model or agent value is asserted here beyond what those
  artifacts record.

The local prompt patch was installed and its runtime injection was observed for
both vtrace runs (see [§5](#5-treatment-validity)).

## 3. Result summary

| Metric | Value |
| --- | ---: |
| Evaluated paired tasks | 2 |
| Baseline resolved | 2/2 |
| Vtrace resolved | 2/2 |
| Mean token reduction | 26.47% |
| Mean cost reduction | 23.38% |
| Mean duration reduction | mixed |
| Invalid vtrace treatments | 0 |

Duration is **mixed**: one task was slower under vtrace and one was faster, so no
single mean duration reduction is reported.

## 4. Per-instance results

| Instance | Baseline resolved | Vtrace resolved | Token reduction | Cost reduction | Duration reduction |
| --- | --- | --- | ---: | ---: | ---: |
| django__django-11728 | true | true | 30.42% | 19.36% | -13.34% |
| django__django-11740 | true | true | 22.52% | 27.39% | 16.64% |

Raw paired figures:

| Instance | Baseline tokens | Vtrace tokens |
| --- | ---: | ---: |
| django__django-11728 | 1,716,132 | 1,194,127 |
| django__django-11740 | 2,387,415 | 1,849,882 |

A negative duration reduction means the vtrace condition was **slower** on that
instance (django__django-11728).

## 5. Treatment validity

Both vtrace runs used a real, observed indexed-context treatment:

| Field | django__django-11728 | django__django-11740 |
| --- | --- | --- |
| vtrace_method | indexed-context | indexed-context |
| vtrace_indexed_context | true | true |
| vtrace_injection_observed | true | true |
| vtrace_treatment_valid | true | true |

Because both treatments were valid (real context generated and runtime injection
observed), the token/cost deltas describe genuine vtrace effort, not a no-op run.

## 6. Interpretation

This is the first external evaluated signal that vtrace indexed-context can
preserve resolution while reducing total token usage and cost on
SWE-bench-style tasks. The sample is only two tasks, both from Django, so it is a
smoke result rather than a benchmark claim.

## 7. Relationship to vexp numbers

These numbers should not be compared directly to vexp's advertised averages yet.
vexp reports across a larger benchmark subset and includes a vexp-enabled
condition; this smoke result only compares baseline `--no-vexp` against vtrace
indexed-context `--no-vexp` on two tasks.

## 8. Next step

Run one more evaluated task, `django__django-11490`, then decide whether to
expand to a 5-task evaluated smoke.
