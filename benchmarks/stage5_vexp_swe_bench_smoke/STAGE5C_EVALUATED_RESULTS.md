# Stage 5C preliminary evaluated SWE-bench smoke result

Five external SWE-bench tasks were run and **Docker-evaluated** (real pass/fail),
comparing a `--no-vexp` baseline against `--no-vexp` + vtrace indexed-context
injection. **This is a preliminary evaluated smoke result, not a benchmark
claim.**

> **Headline:** resolution is preserved (5/5 both conditions), but the token/cost
> efficiency result is **mixed and aggregation-dependent**. vtrace indexed-context
> *reduced* effort on the three larger tasks and *increased* it on the two
> smaller tasks. The mean per-task token "reduction" is **−9.92%** (vtrace worse
> on the average task); the pooled token reduction is **+18.09%** (vtrace better
> in total, because the largest task dominates the pool). Both numbers are real;
> they answer different questions.

## 1. Scope

Stage 5C measures a **tiny evaluated external SWE-bench smoke run**: five Django
instances, with vexp disabled in **both** conditions, and patches evaluated
through real Docker pass/fail.

It explicitly does **not** claim:

- public SWE-bench pass@1
- statistical significance
- full 100-task performance
- that vtrace beats vexp
- general coding-agent superiority

With only five tasks, all from Django, this is a preliminary evaluated smoke
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
`vtrace_treatment_valid=true`. All five vtrace runs were valid (see
[§5](#5-treatment-validity)).

Each task was run under its own `--run-label`; the figures below are produced by
`--mode aggregate-runs` combining the five labels into `results/aggregate/`:

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode aggregate-runs \
  --run-labels eval-11728,eval-11740,eval-11490,eval-10880,eval-11095 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## 3. Summary table

Two aggregations are reported because they disagree in sign — see
[§6](#6-interpretation) for why.

| Metric | Value |
| --- | ---: |
| Evaluated paired tasks | 5 |
| Baseline resolved | 5/5 |
| Vtrace resolved | 5/5 |
| Tasks where vtrace reduced tokens | 3/5 |
| Tasks where vtrace increased tokens | 2/5 |
| Mean per-task token reduction | −9.92% |
| Mean per-task cost reduction | −0.33% |
| Mean per-task duration reduction | −3.27% |
| Pooled token reduction (ratio of totals) | +18.09% |
| Pooled cost reduction (ratio of means) | +20.47% |
| Pooled duration reduction (ratio of means) | +16.97% |
| Invalid vtrace treatments | 0 |

Pooled totals: baseline 9,733,784 tokens → vtrace 7,973,399 tokens. Per-condition
means: baseline 1,946,757 tokens / $0.7406 / 139,725 ms; vtrace 1,594,680 tokens
/ $0.5890 / 116,014 ms.

## 4. Per-instance table

Sorted by baseline token size to make the task-size interaction visible.

| Instance | Baseline resolved | Vtrace resolved | Baseline tokens | Vtrace tokens | Token reduction | Cost reduction | Duration reduction |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| django__django-11490 | true | true | 4,661,640 | 3,301,462 | +29.18% | +33.55% | +43.49% |
| django__django-11740 | true | true | 2,387,415 | 1,849,882 | +22.52% | +27.39% | +16.64% |
| django__django-11728 | true | true | 1,716,132 | 1,194,127 | +30.42% | +19.36% | −13.34% |
| django__django-11095 | true | true | 535,997 | 999,877 | −86.55% | −59.34% | −45.67% |
| django__django-10880 | true | true | 432,600 | 628,051 | −45.18% | −22.63% | −17.49% |

A negative reduction means the vtrace condition was **worse** (more
tokens/cost/slower) on that instance. The three positive tasks are the three
largest baselines; the two negative tasks are the two smallest.

## 5. Treatment validity

All five vtrace runs used a real, observed indexed-context treatment:

| Field | Value (all five runs) |
| --- | --- |
| vtrace_method | indexed-context |
| vtrace_indexed_context | true |
| vtrace_injection_observed | true |
| vtrace_treatment_valid | true |

The aggregate report records `valid_treatments=5`, `invalid_treatments=0` for the
vtrace condition. Invalid or skipped treatments are excluded from performance
claims; here there were none, so the deltas describe genuine vtrace effort, not a
no-op run. Because all five resolved under both conditions, this is an
**efficiency** result, not a correctness result.

## 6. Interpretation

Across this five-task evaluated smoke subset, vtrace indexed-context **preserved
resolution** (5/5 both conditions) but its effect on effort was **mixed**:

- On the three larger tasks, injecting retrieved context reduced tokens, cost,
  and (mostly) duration — by 22–30% tokens.
- On the two smaller tasks, the injected context was **net overhead**:
  `django-11095` nearly doubled tokens (−86.55%) and `django-10880` rose 45%.

This drives the sign disagreement between the two aggregations:

- The **mean of per-task ratios** (−9.92% tokens) weights every task equally, so
  the two small-task regressions dominate and the average task looks worse.
- The **pooled ratio of totals** (+18.09% tokens) weights by absolute size, so
  the single largest task (`django-11490`, which alone saves ~1.36M tokens)
  dominates and the total looks better.

Neither number is wrong; they answer different questions ("how does vtrace do on
a typical task?" vs. "how many tokens does vtrace save over this whole set?").
The honest reading is a **directional hypothesis**: indexed-context appears to pay
off on larger / navigation-heavy tasks and to cost more than it saves on small
ones.

The result is limited: all five tasks are Django tasks, the sample size is tiny,
the task-size split is a hypothesis from n=5 (not a measured threshold), and
vexp-enabled runs were not included.

## 7. Relationship to Stage 5A and Stage 5B

- **Stage 5A** generic instruction injection was not a useful performance signal
  and sometimes added overhead.
- **Stage 5B** introduced real indexed-context injection and produced positive
  patch-generation evidence (on larger tasks).
- **Stage 5C** adds Docker evaluation, turning patch-generation evidence into
  evaluated resolved/not-resolved evidence — and, at five tasks, surfaces that
  the efficiency benefit is task-size-dependent rather than uniform.

> An earlier three-task subset (`django-11490`, `-11728`, `-11740`) showed a
> uniformly positive ~27% mean token reduction. Those three are all large tasks;
> adding the two smaller tasks (`django-10880`, `-11095`) is what revealed the
> mixed picture. The three-task subset should be read as "favorable subset," not
> as the Stage 5C result.

## 8. Relationship to vexp public numbers

These results should not be compared directly to vexp's advertised averages. vexp
reports on a larger benchmark subset and includes a vexp-enabled condition. This
Stage 5C result compares baseline `--no-vexp` against vtrace indexed-context
`--no-vexp` on five evaluated Django tasks.

## 9. Caveats

- sample size is only 5
- all tasks are Django
- no vexp-enabled condition was run
- no statistical significance
- the token/cost result is **mixed**: 2 of 5 tasks were net-negative, and the
  two aggregations disagree in sign
- the "large tasks benefit, small tasks regress" pattern is a hypothesis from
  n=5, not a measured size threshold
- duration was also mixed (negative on two tasks)
- results may vary by model/cache/session state
- generated benchmark artifacts are local and untracked unless explicitly
  committed

## 10. Next step

Before any larger run, test the task-size hypothesis directly:

- add **non-Django** instances for codebase diversity, and
- deliberately include a mix of **small and large** tasks to see whether the
  small-task regression holds.

Suggested next instances: a non-Django repo (e.g. `sympy`, `scikit-learn`) plus
one more small task, so the size interaction can be confirmed or rejected rather
than assumed.
</content>
