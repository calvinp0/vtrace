# Stage 5B indexed-context smoke result — `django__django-11728`

First positive Stage 5B indexed-context smoke result. This is **patch-generation
evidence only**, not a pass/fail or benchmark-performance claim.

## 1. Scope

Stage 5B measures **external vexp-swe-bench patch-generation smoke runs** on a tiny
instance subset, comparing two conditions on the identical model/agent/budget:

- **baseline**: `--no-vexp`
- **vtrace**: `--no-vexp` + vtrace **indexed-context** injection (the patched Claude
  Code adapter injects a context file built from real `vtrace index` + `vtrace
  capsule` retrieval on the task checkout).

It explicitly does **not** measure:

- public SWE-bench performance
- pass@1
- full 100-task results
- vexp-vs-vtrace comparison (vexp is disabled in **both** conditions)
- statistically meaningful performance (n = 1 instance)

Resolution was **not evaluated** for either condition, so this is a **paired
patch-generation smoke, not evaluated pass/fail**.

## 2. Result summary

| Field | Value |
| --- | --- |
| Instance | django__django-11728 |
| Repo | django/django |
| vtrace method | indexed-context |
| vtrace treatment valid | true |
| vtrace injection observed | true |
| Result mode | paired patch-generation smoke, not evaluated pass/fail |
| Baseline tokens | 1,147,541 |
| Vtrace tokens | 824,272 |
| Token reduction | 28.17% |
| Cost reduction | 26.83% |
| Duration reduction | 29.68% |
| Baseline resolved | unknown |
| Vtrace resolved | unknown |

Token, cost, and duration deltas describe **effort**, not correctness. They are
only meaningful here because the vtrace treatment was valid (real context was
generated and its runtime injection was observed); they are **not** advertised as
vtrace performance for any invalid/no-op run.

## 3. Indexed-context evidence

| Field | Value |
| --- | --- |
| vtrace_indexed_context | true |
| vtrace_context_chars | 6064 |
| vtrace_context_items | 8 |
| vtrace_context_truncated | true |
| vtrace_treatment_valid | true |

The indexed-context treatment ran real vtrace indexing and retrieval against an
isolated checkout of the task repo at its base commit:

```text
bun src/cli/index.ts index .../results/workspaces/django__django-11728 --quiet
bun src/cli/index.ts capsule .../results/workspaces/django__django-11728 <query>
```

The injected context (6985-byte file; 6064 chars / 8 items after truncation)
pointed at the relevant Django admindocs utility functions and included the task
problem statement, the failing tests, and the hint context — specifically the
expected/hinted diff region around `django/contrib/admindocs/utils.py`,
`replace_named_groups()`, and `replace_unnamed_groups()`.

## 4. Patch comparison

Both conditions generated a patch; **neither patch was evaluated** for
correctness, so the following is a structural description only.

- **Baseline** generated a patch using a `for ... else:` fallback after the loop.
- **vtrace indexed-context** generated a patch that was **structurally closer to
  the provided SWE-bench hint/expected approach**: it moved the balanced-bracket
  check **after** the parenthesis-handling logic **inside** the loop, used
  `idx + 1`, preserved the `break`, and applied the same style of fix to both
  `replace_named_groups()` and `replace_unnamed_groups()` — rather than adding a
  loop-`else` fallback.

This describes structural similarity to the hint, **not** correctness. No
pass/fail claim is made.

## 5. Interpretation

This is the first positive Stage 5B indexed-context signal. It suggests that real
vtrace-indexed context, unlike generic instruction injection, can reduce external
SWE-bench patch-generation effort and produce a patch closer to the
expected/hinted solution. Because resolution was not evaluated, this remains
patch-generation evidence rather than pass/fail evidence.

n = 1 instance, so this is a directional smoke signal, not a measurement.

## 6. Relationship to Stage 5A

Stage 5A generic instruction injection produced no useful signal and sometimes
added overhead. Stage 5B differs because it injects **actual indexed vtrace
context generated from the task checkout** (problem statement + failing tests +
hints + retrieved symbols/regions), not a generic "use vtrace" instruction file.

## 7. Next step

Next, run one more navigation-heavy task, `django__django-11740`, using the same
baseline-vs-indexed-context setup.
