# Stage 5 — localization-gap live comparison

A small controlled baseline-vs-vtrace live run on the three instances the
localization-gap audit nominated as the cases *most* likely to pull an unaided
baseline agent toward a decoy or an ambiguous/hidden edit site. Both arms were run
fresh; all six runs were Docker-evaluated.

**This is not a public SWE-bench score and not a broad benchmark — three
hand-picked, deliberately-hard instances.** Live patching is stochastic.

## Executive summary

- **Resolution: parity, 1/3 each.** Baseline resolved `matplotlib-22719`; vtrace
  resolved `matplotlib-22719`; both failed the other two. Net **baseline 1/3,
  vtrace 1/3** — same instance.
- **No localization-driven win for vtrace.** On all three cases the baseline agent
  localized the primary gold file *on its own* — the audit's central prediction
  held: problem-statement tracebacks/symptoms leak the fix file, so the unaided
  agent reaches it regardless of retrieval.
- **The one genuine localization gap was not closed by an edit.** `sphinx-7462` has
  a second gold file (`pycode/ast.py`) named nowhere in the report. Baseline never
  touched it. vtrace's capsule **did** surface it — `pycode/ast.py::unparse` as
  pivot #2 — but the **agent edited only the traceback-named file**, so vtrace
  failed too. Capsule localized the hidden target; the agent didn't act on it.
- **Capsule localization quality was uneven and sometimes off-target.** It surfaced
  the gold function for `sphinx-7462` (both files) and `matplotlib-22719` (as
  support), but for `matplotlib-24627` it missed the gold entirely (lead pivots were
  `pyplot.py` repro entry-points; the gold `axes/_base.py` was absent) — yet the
  agent still localized correctly by exploring.
- **No efficiency win.** vtrace was cheaper on the case both arms failed (24627),
  pricier on the case both resolved (22719), and ~even on 7462.

Honest headline: **on three cases chosen to favour vtrace's localization value,
vtrace produced no win — 3× parity — and the single real hidden-file gap exposed an
agent-side failure to use a correct non-traceback pivot, not a retrieval failure.**

## Why these cases were selected

From `stage5_localization_gap_candidate_audit.md`: each is a cross-repo-30 instance
where vtrace's deterministic Stage 5R places the gold file in top-3 but a **decoy
sits at top-1**, and the problem statement is *less* likely to hand the agent the
fix site:

- **matplotlib-24627** — no traceback, no file named; `cla()`/`clf()` ambiguity;
  decoy `figure.py::clf`; gold `axes/_base.py::__clear`.
- **matplotlib-22719** — multi-frame traceback whose deepest frame and "deprecation
  warning" framing point at the decoy `_api/deprecation.py`; real fix in
  `category.py::convert` (a buried middle frame).
- **sphinx-7462** — traceback names gold #1 `domains/python.py`; gold #2
  `pycode/ast.py` is named nowhere; decoy `application.py`.

## Protocol setup

Two arms per instance, identical model/harness, differing only in context:

| Arm | Command | Context |
| --- | --- | --- |
| baseline | `run-protocol --protocol baseline` (`run --no-vexp`) | none |
| vtrace | `run-protocol --protocol vtrace-indexed --context-policy force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget 8000` | Capsule v2 always injected |

Model `claude-opus-4-5-20251101`; vexp off; **no auto-policy**; real SWE-bench
Docker evaluation (`dockerUsed=true`, `evaluationError=null`) for all six runs. No
previous runs reused. No retrieval/scoring/prompt/benchmark/evaluator code changed.

## Per-instance baseline vs vtrace

| Instance | Arm | Docker resolved | Edited files | Cost | Duration | Turns | Total tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | baseline | false | `axes/_base.py`, `figure.py` | $3.0240 | 349.0 s | 112 | 4,837,198 |
| matplotlib-24627 | vtrace | false | `axes/_base.py`, `figure.py` | $1.1297 | 256.9 s | 85 | 3,686,556 |
| matplotlib-22719 | baseline | **true** | `category.py` | $0.4638 | 152.2 s | 33 | 1,167,993 |
| matplotlib-22719 | vtrace | **true** | `category.py` | $0.6146 | 170.8 s | 41 | 1,543,461 |
| sphinx-7462 | baseline | false | `domains/python.py` | $0.2651 | 59.7 s | 21 | 627,263 |
| sphinx-7462 | vtrace | false | `domains/python.py` | $0.2493 | 56.9 s | 18 | 572,906 |

## Localization comparison

"Primary gold edited" = the main fix file was edited. "All gold edited" = every gold
file was edited. "Decoy edited" = the audit's top-1 decoy was edited. "Capsule
localized gold" = the gold fix symbol appeared in the injected capsule (pivot or
support).

| Instance | Arm | Primary gold edited | All gold edited | Decoy edited | Capsule localized gold |
| --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | baseline | yes (`axes/_base.py`) | yes (1/1) | **yes** (`figure.py`) | — |
| matplotlib-24627 | vtrace | yes (`axes/_base.py`) | yes (1/1) | **yes** (`figure.py`) | **no** — gold absent; pivots were `pyplot.py::plot/subplots` |
| matplotlib-22719 | baseline | yes (`category.py`) | yes (1/1) | no | — |
| matplotlib-22719 | vtrace | yes (`category.py`) | yes (1/1) | no | partial — `category.py::convert` in **support**; lead pivots `axis.py::convert_units` |
| sphinx-7462 | baseline | yes (`domains/python.py`) | **no** (1/2 — missed `pycode/ast.py`) | no | — |
| sphinx-7462 | vtrace | yes (`domains/python.py`) | **no** (1/2 — missed `pycode/ast.py`) | no | **yes** — `pycode/ast.py::unparse` was **pivot #2** (hidden file surfaced) |

Localization read:

- **Baseline localized the primary gold file on all three** — including the two
  decoy-at-top-1 cases (`24627`, `22719`). The decoys did not capture it: on `22719`
  it ignored `_api/deprecation.py` entirely; on `24627` it edited the gold *and* the
  decoy (broader, not misdirected).
- **vtrace's injected capsule did not improve primary-file localization**, and on
  `24627` it was actively off-target (gold `axes/_base.py` absent; repro entry-points
  as pivots) — yet the agent localized correctly anyway by exploring.
- **The only true hidden-file gap (`sphinx-7462` → `pycode/ast.py`) was localized
  by vtrace's capsule (pivot #2) and by nothing else** — but the agent did not edit
  it, so the localization advantage did not convert to a resolution.

## Patch-shape comparison

- **matplotlib-24627 (both failed).** Both arms edited `axes/_base.py`'s clear path
  to unset children's `.axes`, and both also rewrote `figure.py`. Both **missed
  unsetting `.figure`** on the axes children, which `test_cla_clears_children_axes_and_fig`
  checks — so both produce an incomplete fix. The gold is a tight 3-line change
  inside `__clear` (`chld.axes = chld.figure = None`); both agents wrote broader,
  partial variants. Baseline spent far more doing so (112 turns / $3.02 vs 85 / $1.13).
- **matplotlib-22719 (both resolved).** Both edited only `category.py`. Baseline
  added an early `return` for empty arrays in `convert`; vtrace guarded similarly.
  Both pass `test_no_deprecation_on_empty_data`. Equivalent outcomes; vtrace cost more.
- **sphinx-7462 (both failed).** Both added an `if node.elts:` guard around
  `result.pop()` in `domains/python.py` (prevents the `IndexError`) but **neither
  fixed `pycode/ast.py::unparse`**, so `test_pycode_ast.py::test_unparse[()-()]`
  still fails. The gold edits *both* files; both agents fixed only the one the
  traceback named.

## Token / cost / duration comparison

| Instance | cost Δ (vtrace vs baseline) | duration Δ | turns Δ | tokens Δ | outcome |
| --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | **−63%** ($1.13 vs $3.02) | −26% | −27 | −24% | both failed |
| matplotlib-22719 | **+33%** ($0.61 vs $0.46) | +12% | +8 | +32% | both resolved |
| sphinx-7462 | −6% ($0.25 vs $0.27) | −5% | −3 | −9% | both failed |

No consistent direction. vtrace's only large saving (`24627`) is on a case it
*failed* — cheaper-but-still-wrong. On the case both resolved (`22719`) vtrace cost
**more**. Injected context adds tokens; it bought no resolution here.

## Failure analysis

- **matplotlib-24627 — parity (both failed), shared root cause.** Both localized to
  the gold (and the decoy) but wrote an incomplete `__clear` fix that unsets `.axes`
  but not `.figure` on child artists. Not a localization failure; a patch-completeness
  failure in both arms. vtrace's capsule did not surface the gold file, so context
  neither helped nor explains the outcome.
- **sphinx-7462 — parity (both failed), but the informative case.** The hidden second
  gold file `pycode/ast.py` is the entire gap. Baseline never found it. **vtrace's
  capsule surfaced it as pivot #2 — the correct localization — but the agent edited
  only the traceback-named `domains/python.py`.** The breakdown is agent-side
  (ignored a correct non-traceback pivot), not retrieval-side. This is the clearest
  signal in the set: retrieval *can* localize a hidden target, and converting that
  into an edit is the missing link.
- **No infra/inconclusive runs.** All six are `completed_patch`, no `api_error_status`,
  all Docker-evaluated.

## Interpretation (using the required categories)

| Instance | Category | Justification |
| --- | --- | --- |
| matplotlib-24627 | **parity** | both fail with comparable localization (both edited gold + decoy; both incomplete) |
| matplotlib-22719 | **parity** | both resolve; both localized `category.py`, ignored the decoy |
| sphinx-7462 | **parity** (resolution) | both fail (both miss `pycode/ast.py`); **caveat:** only vtrace's *capsule* localized the hidden file, but it was never edited, so it is not a "vtrace localization win" by the edit definition |

**Tally: 3 parity, 0 vtrace localization wins, 0 vtrace patch wins, 0 baseline
wins, 0 inconclusive.**

## What this does and does not show about vtrace

**Does show:**

- On instances chosen to be *hard to localize*, the baseline agent still localized
  the primary gold file every time — the live agent's traceback-following and code
  exploration are strong, so the deterministic decoy-at-top-1 signal did **not**
  predict a live baseline localization miss. (The audit predicted exactly this risk.)
- vtrace's capsule can surface a genuinely hidden target the report never names
  (`sphinx-7462` → `pycode/ast.py::unparse`, pivot #2) — a real, unique localization
  signal — but **surfacing is not editing**: the agent ignored that pivot.
- Force-injected context is not a cost win here; it added tokens without changing
  outcomes (and its one big saving was on a failed case).

**Does not show:**

- Any localization-driven resolution win for vtrace (there were none in this set).
- That vtrace hurts: it matched baseline resolution (1/3 vs 1/3) and never
  mis-localized; on `24627` it reached the same answer for less.
- Anything broad — three instances, all parity, cannot support a directional claim.

## Non-claims

- **Not a public SWE-bench score.** Internal smoke harness on a fixed local fixture.
- **Not a broad agent benchmark.** Three hand-picked hard cases; no statistical power.
- **Live results are stochastic.** A rerun could shift any individual outcome.
- **Capsule-surfaced ≠ agent-used.** The `sphinx-7462` capsule localized the hidden
  file, but the prompt/agent did not act on it; that is an agent-integration gap, and
  closing it (not changing retrieval) is the indicated next question — explicitly out
  of scope here.

## Artifacts

| Instance | baseline | vtrace |
| --- | --- | --- |
| matplotlib-24627 | `results/runs/eval-localization-gap-baseline-matplotlib-24627/` | `results/runs/eval-localization-gap-vtrace-matplotlib-24627/` |
| matplotlib-22719 | `results/runs/eval-localization-gap-baseline-matplotlib-22719/` | `results/runs/eval-localization-gap-vtrace-matplotlib-22719/` |
| sphinx-7462 | `results/runs/eval-localization-gap-baseline-sphinx-7462/` | `results/runs/eval-localization-gap-vtrace-sphinx-7462/` |

Each dir holds the raw `swebench-*.jsonl`, `_run.meta.json`, and `_eval.meta.json`;
vtrace dirs also hold `_vtrace_instructions.snapshot.md` (the injected capsule).
Curated report tracked; raw per-run artifacts not tracked by default.
