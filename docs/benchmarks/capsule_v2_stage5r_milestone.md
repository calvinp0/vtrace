# Capsule v2 — Stage 5R Retrieval Milestone

**Status:** documentation/reporting only. No retrieval, scoring, candidate
generation, role logic, or evaluator code was changed to produce this report.

**Sources:** the deterministic Stage 5R artifacts under
`benchmarks/stage5_vexp_swe_bench_smoke/results/`:

- `stage5_retrieval_eval_cross_repo_30.{md,json}` — the 30-instance cross-repo set.
- `stage5_retrieval_eval_expanded.{md,json}` — the 20-instance Django set.
- the miss-audit chain: `…_miss_audit.md` → `…_post_nonsource_audit.md` →
  `…_post_title_symbol_audit.md` → `…_post_literal_anchor_audit.md`.

The earlier **live force-inject Django result** is from a separate, stochastic
benchmark and is reported (and clearly fenced off) in §2 and §7; its source is
`docs/benchmarks/stage5_capsule_v2_milestone.md` /
`benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_capsule_v2_validation.md`.

---

## 1. Executive summary

vtrace indexes a repository into a **graph**: files, classes, functions, and methods
are nodes; `imports`, `calls`, `references`, and `contains` are edges. On top of that
graph it builds **Capsule v2** — given only a task description, an intent, and a token
budget, it assembles a compact "edit-context capsule": the likely edit target(s) as
_pivots_, related context as _support_, and an explicit per-item evidence trail for
why each file was chosen (and why misleading candidates were suppressed).

**Stage 5R measures retrieval quality only.** For each benchmark instance it asks one
deterministic question: _does the capsule point at the file the gold patch actually
changed?_ It runs no Claude, no Docker, no agent, and makes no API calls. The gold
`expected_files` / `expected_symbols` labels are used **only** to score the capsule —
they are never fed into retrieval, which receives only `(task, intent, budget)`.

This milestone covers a full retrieval-improvement loop: five retrieval-behaviour
changes (plus one fixture/task-prose fix) landed on top of an expanded evaluation
set, each gated against the Django set to avoid regressions. The headline outcome is that **Django retrieval is strong and
stable (95% top-3, 0% missing), the harder cross-repo set recovered most of the drop
that came from tripling its size, and every change was either a net improvement or
provably regression-free.**

---

## 2. Current metrics

Deterministic Stage 5R, latest run:

```text
Django expanded (20 instances):
  top-1:   80.0%
  top-3:   95.0%
  pivot:   85.0%
  missing:  0.0%

Cross-repo 30 (30 instances):
  top-1:   60.0%
  top-3:   76.7%
  pivot:   73.3%
  missing: 13.3%
```

- `top-1` = the gold file is the #1 pivot.
- `top-3` = the gold file is among the top-3 ranked files (pivots, then support).
- `pivot` = the gold file was surfaced as a likely edit target (not merely support).
- `missing` = the gold file never entered the capsule at all.

Cross-repo run health:

```text
30/30 evaluated
0 workspace errors
11 repositories represented
no repository contributes more than 5 instances
```

The per-repo spread (from `stage5_retrieval_eval_cross_repo_30.md`) shows where the
remaining difficulty lives: sympy, pytest, xarray, scikit-learn, seaborn, flask are at
100% top-3; astropy is at 75%; matplotlib, sphinx, requests, and the single pylint
instance carry essentially all of the cross-repo misses.

> **Live force-inject Django (separate, NOT Stage 5R):** an earlier live-agent run with
> Capsule v2 always injected resolved **5/5** curated Django instances with a **61.70%
> pooled token reduction** vs. a no-context baseline. That is a stochastic agent-execution
> result, not a deterministic retrieval measurement — see §7.

---

## 3. Improvement timeline

Each row is the cross-repo headline _after_ the change landed (deterministic Stage 5R).
The 16→30 expansion is the only step that lowered the numbers — by design, because it
tripled the set with harder, more diverse repos. Every subsequent change recovered
ground or was neutral-and-safe; none regressed Django.

| #   | Change                                     | cross-repo top-1 | top-3 | pivot | missing | Note                                            |
| --- | ------------------------------------------ | ---------------- | ----- | ----- | ------- | ----------------------------------------------- |
| 0   | Baseline cross-repo (16)                   | 62.5%            | 87.5% | 81.3% | 6.3%    | original small set                              |
| 1   | Expanded cross-repo (30)                   | 53.3%            | 66.7% | 63.3% | 23.3%   | harder/larger set; exposes real gaps            |
| 2   | Fixture abbreviation / task-truncation fix | —                | —     | —     | —       | recovered requests-5414 (thin-prose no_context) |
| 3   | Non-source / doc-data pivot demotion       | 56.7%            | 70.0% | 66.7% | 20.0%   | stops doc-data files being wrong pivots         |
| 4   | Title-symbol anchoring                     | 60.0%            | 73.3% | 70.0% | 16.7%   | recovered sympy-16766; Django 90→95 top-3       |
| 5   | Generic lexical-decoy suppression          | 60.0%            | 73.3% | 70.0% | 16.7%   | neutral on cross-repo; no regression            |
| 6   | Literal / option / acronym anchoring       | 60.0%            | 76.7% | 73.3% | 13.3%   | recovered astropy-14369 (CDS anchor)            |
| 7   | Bounded graph-neighbour expansion          | 60.0%            | 76.7% | 73.3% | 13.3%   | safe/additive-only; neutral on this set         |

Steps 2–3 are grouped in the post-nonsource audit; their combined effect lifted the raw
30-instance numbers from row 1 to row 3. Steps 4–7 each have a dedicated audit refresh.

---

## 4. What worked

- **Title-symbol anchoring** (step 4): seeds the class/type/symbol named in the problem
  _title_ into the pool. Recovered **sympy-16766** (`missing → top-1 pivot`,
  `PythonCodePrinter` now beats the body decoy `lambdify`) and, on the Django set,
  lifted **django-13112** (`hit_discarded → top-1 pivot` via `ForeignKey`), pushing
  Django top-3 from 90% to 95% with no regression.
- **Literal / option / acronym anchoring** (step 6): resolves high-signal tokens that
  are not normal symbol shapes — ALL-CAPS formats (`CDS`, `FITS`), dunders, `--options`,
  backticked config names — by path-segment and exact-case symbol match. Recovered
  **astropy-14369** (`missing → top-3`): the `CDS` acronym surfaced the gold unit-grammar
  `units/format/cds.py`, dissolving a name-collision the prior audit had filed as a hard
  wrong-subsystem case. An over-eager first version regressed Django (SQL keywords like
  `COUNT`/`WHEN` matching common methods); restricting acronyms to path-segment / exact-case
  matches removed the regression while keeping the win.
- **Task-truncation fix** (step 2): recovered **requests-5414**, which had previously
  collapsed to `no_context` on thin/abbreviated task prose; it is now a top-1 pivot.
- **Non-source / doc-data demotion** (step 3): made **pylint-8898** _honest_. Before, the
  capsule confidently named a shipped example file (`doc/data/messages/**/bad.py`) as the
  #1 pivot; after, those are demoted to support and the capsule returns `no_context` —
  the correct outcome, since the real gold transformer files were never in the pool.
- **Generic lexical-decoy suppression** (step 5): down-weights an infrastructure module
  whose _name_ matches a task keyword (`deprecation.py`, a `*Dict*` helper) when it lacks
  direct evidence. It fires safely (visible in diagnostics, e.g. matplotlib-24970) and is
  guarded so a high-in-degree real dependency is never suppressed — it produced **no
  regression** on either set.
- **Bounded graph-neighbour expansion** (step 7): recovers production files that are not
  named lexically but sit one hop from a high-confidence seed. It is deliberately
  **additive-only** — neighbours are support-strength, kept out of the role pipeline, and
  rendered only into leftover support budget, so they can never evict a file vtrace
  already found. On this set it is **safe and non-evicting but not a recall mover** (the
  existing retrieval-layer expansion already recovers most in-pool 1-hop neighbours); it
  ships as a bounded safety net with full diagnostics rather than a metric mover. An
  earlier pool-merging version regressed Django (django-11206) and was reworked to the
  additive-only design before landing.

---

## 5. Remaining misses

Seven of 30 cross-repo instances miss top-3. Per the latest
(`…_post_literal_anchor_audit.md`) audit they fall into four buckets:

| bucket                          | count | instances                                  | shape                                                                                                                    |
| ------------------------------- | ----- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| candidate-generation gaps       | 3     | matplotlib-24970, sphinx-9230, pylint-8898 | gold file never enters the pool (protected infra, a `dict` decoy, or a 3-file multi-target none of which were retrieved) |
| ranking near-misses             | 2     | requests-1724, astropy-14598               | gold file _is_ present but one or two slots past top-3 / the support budget                                              |
| wrong-subsystem / hard-semantic | 1     | sphinx-7910                                | lexically-obvious sibling package (`ext/autodoc`) chosen; gold is the parallel `ext/napoleon` hook                       |
| actionability gate              | 1     | matplotlib-25960                           | gold symbol is surfaced but the gate classifies it "no actionable edit target" → `no_context`                            |

These are individually hard and no longer share a single cheap fix: the candidate-gen
gaps need new generation (not more suppression, which has been exhausted as a lever),
the ranking near-misses are Django-risky budget/tie-break decisions, and the last two are
semantic/gate questions. The audit's standing guidance is to **not** apply a global rule
off any single miss without gating it against both baselines.

---

## 6. Product interpretation

The point of this work is **not** that vtrace makes the context smaller — it is that
vtrace makes the context _better_. A Capsule v2 capsule is a structured, evidence-backed
answer to "what should the agent look at to fix this?", not a blob of nearby text:

- **Likely edit target** — the pivot(s), ranked by direct evidence, not raw lexical overlap.
- **Support files** — related context (callers, helpers, siblings) at signature strength.
- **Traps / diagnostics** — body-literal and error-code matches that pin the exact symbol.
- **Suppressed misleading pivots** — generic infra decoys and doc-data examples are
  recorded as down-ranked, not silently kept, so a wrong-but-plausible target can't anchor.
- **Explicit selection evidence** — every item carries _why_ it was chosen ("title mentions
  `X`", "near high-confidence seed via import edge", "task literal appears in body"), which
  is what makes the capsule auditable and the misses diagnosable.

Strong, stable Django retrieval plus a recovering cross-repo set is the evidence that this
structure generalizes beyond a single project — and the diagnostics are what let each
improvement be attributed to a specific, gated change rather than to luck.

---

## 7. Non-claims

To keep this honest:

- **This is not a public SWE-bench score.** Stage 5R is a private, deterministic
  retrieval measurement on a fixed local fixture, not the SWE-bench resolution benchmark.
- **This is not autonomous agent performance.** Stage 5R does not run an agent, write a
  patch, or run tests. It only checks whether the gold file is surfaced.
- **Stage 5R is retrieval-only and deterministic.** Same inputs → same outputs; no model,
  no network, no Docker.
- **The cross-repo set is still small.** 30 instances across 11 repos, none above 5
  instances — enough to expose failure shapes, not enough to claim a stable rate.
- **The live-agent results are separate and stochastic.** The 5/5 / 61.70% pooled
  token-reduction figure is from live force-inject runs (`stage5_capsule_v2_validation.md`)
  and varies run to run; it is reported alongside, never merged into, the deterministic
  numbers.
- **No claim that vtrace "solves" arbitrary repositories.** The remaining misses (§5) are
  real and the next gains require more data and harder, semantic work.

---

## 8. Follow-up: targeted live validation on recovered cases

Next-step #4 (below) has now been run as a **targeted** live-agent sanity check —
not a benchmark. Three instances that recent retrieval/input fixes _recovered_ in
the deterministic cross-repo set were run live with **Capsule v2 force-inject**
(`--protocol vtrace-indexed --capsule-engine v2 --capsule-intent debug
--capsule-budget 8000 --context-policy force-inject`), then evaluated with the
real SWE-bench Docker suite. One condition only; no baseline, no vexp, no
auto-policy. Source:
[`stage5_capsule_v2_recovered_live_validation.md`](../../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_capsule_v2_recovered_live_validation.md).

Headline: **2 / 3 resolved under Docker**, and in **all 3** the agent edited the
exact file/symbol Capsule v2 surfaced as the **lead pivot** — so retrieval steered
the agent correctly on every case, including the one that did not pass.

| Instance      | Stage 5R (deterministic) | Live lead pivot                               | Docker `resolved` | Interpretation                                                                                                                                                   |
| ------------- | ------------------------ | --------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| requests-5414 | top-1 pivot              | `requests/models.py::prepare_url`             | **false**         | retrieval correct; agent made too broad a patch (unconditional IDNA encoding instead of the minimal `startswith((u'*', u'.'))` guard), regressing `PASS_TO_PASS` |
| sympy-16766   | top-1 pivot              | `sympy/printing/pycode.py::PythonCodePrinter` | **true**          | title-symbol anchoring translated to live success (`_print_Indexed` added to the right class)                                                                    |
| astropy-14369 | top-3, rank 2            | `astropy/units/format/cds.py::CDS`            | **true**          | literal/`CDS` anchoring translated to live success (gold grammar fix + cached parser-table regeneration)                                                         |

> **Live vs deterministic are different query constructions.** The Stage 5R
> column is the deterministic cross-repo-30 ranking; the live lead pivot is the
> Capsule v2 `debug`-intent query actually injected at run time. For
> astropy-14369 they disagree in the agent's favour: the live query promoted the
> correct `units/format/cds.py` to the lead pivot, ahead of the wrong-subsystem
> `io/ascii/cds.py` that topped the deterministic eval.

**Non-claims (live):** this is **not** a public SWE-bench score, **not** a broad
live benchmark (three instances, one condition), and **not** evidence that every
retrieval win becomes a correct patch — requests-5414 is the standing example of
correct retrieval with an incorrect edit shape. Live patch synthesis is
stochastic; these numbers are kept separate from the deterministic Stage 5R
measurement and from the earlier live force-inject Django result (§2/§7).

**Artifacts.** The curated report
(`stage5_capsule_v2_recovered_live_validation.md`) is tracked; the raw per-run
artifacts (run JSONLs, `_run.meta.json` capsule audit, `_eval.meta.json` Docker
evidence, injected-context snapshots) remain under
`benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-capsulev2-recovered-live-*/`
and are **not** tracked by default.

---

## 9. Recommended next steps

1. **Freeze retrieval heuristics for now.** Title-symbol, literal-anchor,
   decoy-suppression, non-source demotion, and graph-neighbour expansion have each landed
   and been gated; the cheap, broadly-applicable levers are exhausted. Further per-miss
   tuning on 30 instances risks overfitting.
2. **Expand the deterministic cross-repo set beyond 30 before tuning again.** A larger,
   more balanced set is the prerequisite for trusting any future heuristic change and for
   turning "failure shapes" into a credible rate.
3. **Repo-hygiene: type-check the benchmark scripts.** `tsconfig.json` includes only
   `src/**`, so the Stage 5R scripts under `benchmarks/` are not seen by `tsc` (their type
   errors surface only at runtime under `bun test`). Add a separate tsconfig or extend the
   include in a dedicated task — it is not a drive-by change, as it may surface latent
   issues in the benchmark code.
4. **Run a small live-agent validation on the recovered cases.** ✅ _Done for
   sympy-16766, astropy-14369, requests-5414 — see §8._ It confirmed the recoveries
   reach the agent end-to-end (all three edited the lead pivot; 2/3 resolved),
   separating "retrieval found it" from "the agent used it". django-13112 remains
   to be validated live.
5. **Later, revisit the actionability gate and the ranking near-misses with more data.**
   matplotlib-25960 (gate) and requests-1724 / astropy-14598 (rank 6) are the most
   tractable remaining cases, but each is Django-risky and should be tackled only once the
   eval set is large enough to detect a regression reliably.
6. **Close the context-to-action gap in the agent loop, not the render.** A live test
   showed Capsule v2 can surface and explicitly flag a hidden, non-traceback pivot
   (`sphinx-7462` → `pycode/ast.py::unparse`) and the agent still edits only the
   traceback-named file. Render-only multi-pivot guidance was added and did **not**
   convert on that run, so the next lever is agent-orchestration (force pivot
   inspection / rule-out, gate finalization on uninspected pivots, diff-vs-pivots
   check) rather than more retrieval or wording. See
   [`capsule_v2_context_to_action_gap.md`](./capsule_v2_context_to_action_gap.md).
