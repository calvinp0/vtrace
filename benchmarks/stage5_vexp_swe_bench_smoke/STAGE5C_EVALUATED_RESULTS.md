# Stage 5C preliminary evaluated SWE-bench smoke result

Three external SWE-bench tasks were run and **Docker-evaluated** (real pass/fail),
comparing a `--no-vexp` baseline against `--no-vexp` + vtrace indexed-context
injection. **This is a preliminary evaluated smoke result, not a benchmark
claim.**

## 1. Scope

Stage 5C measures a **tiny evaluated external SWE-bench smoke run**: three Django
instances, with vexp disabled in **both** conditions, and patches evaluated
through real Docker pass/fail.

It explicitly does **not** claim:

- public SWE-bench pass@1
- statistical significance
- full 100-task performance
- that vtrace beats vexp
- general coding-agent superiority

With only three tasks, all from Django, this is a preliminary evaluated smoke
result rather than a benchmark measurement.

## 2. Protocol

- **baseline**: `vexp-swe-bench` run with `--no-vexp`.
- **vtrace**: `vexp-swe-bench` run with `--no-vexp` **plus** vtrace
  indexed-context injection (the local prompt patch injects a context file built
  from real `vtrace index` + `vtrace capsule` retrieval against the task checkout
  at its base commit).
- **evaluation**: Docker evaluation through `vexp-swe-bench evaluate`
  (`--mode docker`), which runs the real SWE-bench test suite so each patch gets
  a genuine pass/fail `resolved`.

This is **not** a vexp-enabled comparison. vexp is disabled in both the baseline
and vtrace conditions.

The vtrace treatment is considered **valid** only when indexed context was
generated, local prompt injection was observed, and the run metadata records
`vtrace_treatment_valid=true`. The `django__django-11490` evaluation report
confirms that Docker evaluation ran for both conditions, both resolved, vtrace
indexed context was enabled, injection was observed, and the treatment was valid.

## 3. Summary table

| Metric | Value |
| --- | ---: |
| Evaluated paired tasks | 3 |
| Baseline resolved | 3/3 |
| Vtrace resolved | 3/3 |
| Mean token reduction | 27.37% |
| Mean cost reduction | 26.77% |
| Mean duration reduction | 15.60% |
| Invalid vtrace treatments | 0 |

## 4. Per-instance table

| Instance | Baseline resolved | Vtrace resolved | Baseline tokens | Vtrace tokens | Token reduction | Cost reduction | Duration reduction |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| django__django-11728 | true | true | 1,716,132 | 1,194,127 | 30.42% | 19.36% | -13.34% |
| django__django-11740 | true | true | 2,387,415 | 1,849,882 | 22.52% | 27.39% | 16.64% |
| django__django-11490 | true | true | 4,661,640 | 3,301,462 | 29.18% | 33.55% | 43.49% |

A negative duration reduction means the vtrace condition was **slower** on that
instance (django__django-11728).

## 5. Treatment validity

All three vtrace runs used a real, observed indexed-context treatment:

| Field | django__django-11728 | django__django-11740 | django__django-11490 |
| --- | --- | --- | --- |
| vtrace_method | indexed-context | indexed-context | indexed-context |
| vtrace_indexed_context | true | true | true |
| vtrace_injection_observed | true | true | true |
| vtrace_treatment_valid | true | true | true |

Invalid or skipped treatments are excluded from performance claims. Because all
three treatments were valid (real context generated and runtime injection
observed), the token/cost/duration deltas describe genuine vtrace effort, not a
no-op run.

## 6. Interpretation

Across this three-task evaluated smoke subset, vtrace indexed-context preserved
resolution while reducing total token usage and cost. This is the first evaluated
external evidence that vtrace-indexed context can reduce SWE-bench-style agent
effort without reducing correctness on these tasks.

The result is limited: all three tasks are Django tasks, the sample size is tiny,
and vexp-enabled runs were not included.

## 7. Relationship to Stage 5A and Stage 5B

- **Stage 5A** generic instruction injection was not a useful performance signal
  and sometimes added overhead.
- **Stage 5B** introduced real indexed-context injection and produced positive
  patch-generation evidence.
- **Stage 5C** adds Docker evaluation, turning patch-generation evidence into
  evaluated resolved/not-resolved evidence.

## 8. Relationship to vexp public numbers

These results should not be compared directly to vexp's advertised averages. vexp
reports on a larger benchmark subset and includes a vexp-enabled condition. This
Stage 5C result compares baseline `--no-vexp` against vtrace indexed-context
`--no-vexp` on three evaluated Django tasks.

## 9. Caveats

- sample size is only 3
- all tasks are Django
- no vexp-enabled condition was run
- no statistical significance
- results may vary by model/cache/session state
- duration was mixed, with one task slower under vtrace
- generated benchmark artifacts are local and untracked unless explicitly
  committed

## 10. Next step

Next, expand to a 5-task evaluated smoke before considering a larger run.

Suggested next instances:

- `django__django-10880`
- `django__django-11095`

or another non-Django instance if the goal is codebase diversity.
</content>
</invoke>
