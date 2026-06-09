# Stage 5 controlled pilot loss analysis

_Reporting/analysis only. No live agents, no Docker, no retrieval / PIVOT_CHECK / telemetry / benchmark changes. Reads existing run artifacts (read-only). Resolution is taken from existing `docker_eval` artifacts._

Inputs:
`stage5_outcome_ledger.{md,json}`, `stage5_controlled_10_task_plan.{md,json}`, and the per-run artifacts under `results/runs/<label>/raw/<condition>/`. Pilot pairing fixed in commit `31108c3`.

## Summary

On the controlled 10-task pilot, VTRACE recorded **3 losses** (baseline resolved, VTRACE did not):
`sympy__sympy-16766`, `matplotlib__matplotlib-22719`, `psf__requests-5414`.

The dominant finding is unambiguous: **in all 3 losses VTRACE edited the correct file — the same file the resolving baseline edited — and had that file in context. The failure was in the edit/patch, not in retrieval or localization.** All three are classified `patch_mistake_despite_good_context`.

| instance | gold/baseline file | vtrace edited same file? | gold file was a pivot? | classification | confidence |
| --- | --- | :---: | :---: | --- | --- |
| sympy__sympy-16766 | sympy/printing/pycode.py | yes | yes (#1 pivot) | patch_mistake_despite_good_context | high |
| matplotlib__matplotlib-22719 | lib/matplotlib/category.py | yes | no (pivots → axis.py) | patch_mistake_despite_good_context | high |
| psf__requests-5414 | requests/models.py | yes | yes (#1 pivot) | patch_mistake_despite_good_context | high |

Retrieval misses: **0/3**. Ignored-pivot failures: **0/3**. Localization failures: **0/3**.
PIVOT_CHECK was injected in 3/3 and explains the higher mean cost/tokens (see _Cross-case patterns_), but it is **not** the cause of any resolution loss.

## Method

For each loss, baseline and VTRACE artifacts were compared along four independently-recorded signals, kept separate so context quality is not conflated with patch correctness:

1. **Localization** — did baseline and VTRACE edit the same file? Did VTRACE edit a plausible-but-wrong file?
2. **Retrieval** — was the needed file a capsule pivot, and was it inspected (read/searched)?
3. **PIVOT_CHECK** — did it inject, and did it inflate tool calls / tokens?
4. **Patch** — is VTRACE's diff semantically different from the resolving baseline diff, and is the difference plausibly why it failed?

Resolution is read from `_eval.meta.json` (`docker_eval`); the docker outcome is authoritative for pass/fail. Where the file/symbol localization matched the resolving baseline but the patch failed, the cause is attributed to the edit, not the context. "Gold file" is used as a proxy for the file the resolving baseline edited (no dataset gold patch is re-derived here).

## Loss cases

### sympy__sympy-16766 — `patch_mistake_despite_good_context` (confidence: high)

- **baseline_run_label:** `eval-baseline-vs-vtrace-baseline-sympy-16766`
- **vtrace_run_label:** `eval-controlled-vtrace-sympy-16766`
- **baseline_resolved / vtrace_resolved:** true / false
- **baseline_edited_files:** `sympy/printing/pycode.py`
- **vtrace_edited_files:** `sympy/printing/pycode.py` (same file)
- **baseline_tokens / vtrace_tokens:** 1,414,441 / 1,422,447 (Δ +8,006, +0.6%)
- **baseline_cost / vtrace_cost:** $0.5185 / $0.5765 (Δ +$0.0580, +11.2%)
- **vtrace_capsule_pivots:**
  - `sympy/printing/pycode.py` — "actionable class — symbol-name match; lexical match; issue-domain relevance; 9 dependents" (**this is the gold file, ranked #1**)
  - `sympy/printing/printer.py` — "actionable method — symbol-name match; …; 523 dependents"
- **vtrace_hidden_pivot_engagement:** 2 hidden pivots, 2 inspected, 1 edited, 0 ignored
- **vtrace_read_files:** `sympy/printing/pycode.py`, `sympy/printing/ccode.py`, `sympy/printing/printer.py`
- **vtrace_searched_files:** `sympy/printing/ccode.py`, `sympy/printing`
- **evidence:** Both runs add `_print_Indexed` / `_print_IndexedBase`. The resolving baseline hunk is anchored at `def _print_NoneToken` and inserts the methods **into `class PythonCodePrinter`** (after the class declaration). The VTRACE hunk is anchored at `def _print_Stream` and inserts the methods **above the `class PythonCodePrinter` line**, i.e. into the broader `AbstractPythonCodePrinter` scope. Same file, same symbols, correct context — the methods landed in a different class scope and the patch failed docker evaluation. (Classification high; exact failing mechanism inferred — medium.)
- **recommended_fix:** After pivot inspection, confirm the **enclosing class/scope** of the insertion point before writing a new method.

### matplotlib__matplotlib-22719 — `patch_mistake_despite_good_context` (confidence: high; secondary: `wrong_pivot_emphasis`, `pivot_check_overhead_or_noise`)

- **baseline_run_label:** `eval-localization-gap-baseline-matplotlib-22719`
- **vtrace_run_label:** `eval-controlled-vtrace-matplotlib-22719`
- **baseline_resolved / vtrace_resolved:** true / false
- **baseline_edited_files:** `lib/matplotlib/category.py`
- **vtrace_edited_files:** `lib/matplotlib/category.py` (same file)
- **baseline_tokens / vtrace_tokens:** 1,167,993 / 2,718,398 (Δ +1,550,405, +132.7%)
- **baseline_cost / vtrace_cost:** $0.4638 / $0.9627 (Δ +$0.4989, +107.6%)
- **vtrace_tool_call_count:** 30
- **vtrace_capsule_pivots:**
  - `lib/matplotlib/axis.py` — "task diagnostic literal appears in this symbol's body — explicit edit site"
  - `lib/matplotlib/axis.py` — "existing method recovered from Class.method expansion — more actionable than containing class"
  - (**neither pivot is the gold file `category.py`**)
- **vtrace_hidden_pivot_engagement:** 2 hidden pivots, 2 inspected, 0 edited, 0 ignored
- **vtrace_read_files:** `lib/matplotlib/axis.py`, `lib/matplotlib/category.py`, `lib/matplotlib/units.py`, `lib/matplotlib/_api/deprecation.py`
- **vtrace_searched_files:** `lib/matplotlib/axis.py`, `lib/matplotlib/units.py`, `lib/matplotlib/_api/deprecation.py`
- **evidence:** Despite both pivots pointing at `axis.py`, VTRACE read and edited the gold file `category.py` — localization recovered. The patches differ semantically: the resolving baseline adds an **early return for empty arrays** (`if values.size == 0: return np.asarray(values, dtype=float)`), directly handling the empty-data crash; VTRACE only **narrows the deprecation-warning guard** (`if is_numlike` → `if is_numlike and values.size`) and never returns early, so the empty-data path still fails. Correct file, insufficient patch. Secondary signals: capsule emphasized `axis.py` over the gold `category.py` (`wrong_pivot_emphasis`, recovered by the agent); PIVOT_CHECK injected and the run spent 30 tool calls / 2.72M tokens vs 1.17M baseline (`pivot_check_overhead_or_noise` — a **cost** driver, not the resolution cause).
- **recommended_fix:** After pivot inspection, enumerate the reported failing input (empty array) and verify the patch handles **that** case before finalizing.

### psf__requests-5414 — `patch_mistake_despite_good_context` (confidence: high)

- **baseline_run_label:** `eval-baseline-vs-vtrace-baseline-requests-5414`
- **vtrace_run_label:** `eval-controlled-vtrace-requests-5414`
- **baseline_resolved / vtrace_resolved:** true / false
- **baseline_edited_files:** `requests/models.py`
- **vtrace_edited_files:** `requests/models.py` (same file)
- **baseline_tokens / vtrace_tokens:** 736,898 / 956,785 (Δ +219,887, +29.8%)
- **baseline_cost / vtrace_cost:** $0.4726 / $0.4065 (Δ −$0.0660, −14.0% — cheaper, still failed)
- **vtrace_tool_call_count:** 9
- **vtrace_capsule_pivots:**
  - `requests/models.py` — "source line anchor in the issue points at this symbol — explicit edit site" (**gold file, ranked #1**)
  - `requests/api.py` — "actionable function — exercised by a failing test; …; 65 dependents"
- **vtrace_hidden_pivot_engagement:** 1 hidden pivot, 1 inspected, 0 edited, 0 ignored
- **vtrace_read_files:** `requests/models.py`, `requests/api.py`
- **vtrace_searched_files:** `psf__requests`
- **evidence:** Gold file `requests/models.py` was the #1 pivot and was edited (same region as the resolving baseline). Approaches differ: the resolving baseline **adds** an explicit IDNA validation (`host.encode('idna')` raising `InvalidURL` on `UnicodeError`) that catches empty labels like `.example.com`; VTRACE instead **restructures** the existing branch to always call `self._get_idna_encoded_host(host)` (even for ASCII hosts) and drops the original ASCII fast-path. Correct file and region, but the rewritten control flow failed docker evaluation.
- **recommended_fix:** Prefer **additive** validation targeting the reported failing input over restructuring existing control flow.

## Cross-case patterns

- **Localization was correct in 3/3.** VTRACE edited the same file as the resolving baseline in every loss, and had that file in context (read) in every loss.
- **Retrieval was not the bottleneck.** The gold file was the **#1 capsule pivot in 2/3** (sympy, requests). In the third (matplotlib) the pivots pointed at `axis.py`, yet the agent still recovered and edited the gold `category.py`. There were **0 retrieval misses** and **0 ignored-pivot** failures.
- **The failure point is the patch.** Each loss is a different patch defect on the right file: wrong class scope (sympy), insufficient handling of the failing input (matplotlib), and a riskier control-flow rewrite vs an additive fix (requests). In all three the resolving baseline's diff is **simpler / more direct** than VTRACE's.
- **PIVOT_CHECK is a cost story, not a loss story.** It injected in 3/3. It is the main driver of the pilot's higher mean cost/tokens — most visibly matplotlib (+132.7% tokens, 30 tool calls) — but in no case is the extra inspection the reason the patch failed. (requests was actually *cheaper* than baseline and still lost.)

## Likely root causes

1. **Primary (3/3): patch-construction quality despite correct context.** The agent reliably reaches the right file and symbols but then writes a patch that is mis-scoped, under-covers the failing input, or rewrites control flow where an additive fix was safer. This is the dominant, consistent cause of the pilot losses.
2. **Secondary (1/3, cost only): PIVOT_CHECK overhead.** Extra inspection inflates tokens/cost (matplotlib most) without changing the resolution outcome. This is the main contributor to "VTRACE cost more on average," separate from the resolution losses.
3. **Minor (1/3, recovered): pivot emphasis.** matplotlib's pivots favored `axis.py` over the gold `category.py`; the agent recovered, so this did not cause the loss.

## Recommended next engineering work

**One direction: add edit-plan / rule-out guidance after pivot inspection.**

All three losses are *correct localization, wrong patch*. Capsule v2 ranking is **not** the bottleneck (the gold file was edited in 3/3 and was the top pivot in 2/3), so improving retrieval would not have changed these outcomes. A small, targeted edit-planning step — invoked after the agent has inspected pivots and before it writes the diff — directly addresses the observed gap:

- confirm the **enclosing class/scope** of the insertion point (would have caught sympy),
- enumerate the **reported failing input(s)** and check the patch actually handles them (would have flagged matplotlib's empty-array gap),
- prefer **additive, minimal** changes over restructuring working control flow (requests).

**Be conservative:** this is an n=3 opportunistic pilot, so treat the above as a hypothesis to validate on more losses before any broad behavior change. A *secondary, separate* follow-up — making PIVOT_CHECK conditional to cut the cost/token overhead — is worth tracking for the cost story, but it does not affect resolution and is **not** the primary recommendation. We explicitly do **not** recommend a Capsule v2 ranking rewrite on this evidence.

## Non-claims

- This is a 10-task opportunistic pilot, not a statistically powered benchmark.
- This analysis does not prove VTRACE is worse than baseline generally.
- This analysis does not compare against VEXP directly.
- This analysis does not rerun agents or Docker; resolution is taken from existing `docker_eval` artifacts.
- This analysis separates context quality, agent behavior, patch correctness, and evaluation outcome; a patch failure on a correctly-retrieved file is attributed to the edit, not the context.
- "Gold file" means the file the resolving baseline edited; the exact failing mechanism for sympy (class-scope placement) is inferred from the diff, while the pass/fail outcome itself is from docker evaluation.
