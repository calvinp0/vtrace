# Stage 5 PIVOT_CHECK candidate selection

_Analysis / selection only. No live Stage 5 was run, no agents or Docker were
invoked, no retrieval / PIVOT_CHECK / telemetry / benchmark code was changed._

## Summary

PIVOT_CHECK has been validated once, on `sphinx-doc__sphinx-7462`, where it moved
the hidden Capsule v2 pivot `sphinx/pycode/ast.py::unparse` from
**discovered-only / ignored → inspected** — but did **not** change the edited file
set, and cost **+77.9% tokens / +95.0% cost**. The next runs must therefore be
*selective*: chosen where direct inspection of a hidden pivot could plausibly
change **edit planning** (or produce a grounded rule-out), not merely make the
agent read more.

The clean structural pattern that makes sphinx-7462 a good test is:

```
issue anchors the agent to gold file A (named in the traceback / report)
        +
a second gold file B is named NOWHERE in the issue (hidden)
        +
B is surfaced as a Capsule v2 PIVOT in the live injected capsule
        →  does forcing inspection of B change whether B gets edited?
```

**Mining every available deterministic and live artifact, exactly one untested
instance reproduces that pattern cleanly: `mwaskom__seaborn-3187`.** It is the only
Tier 1 recommendation. Two Tier 2 candidates probe weaker / adjacent questions.
The pool is small *by nature* — the same reason the localization-gap audit found
only three gap candidates: SWE-bench problem statements usually pre-localize the
bug, and multi-file gold patches with a genuinely hidden *and retrieved* second
edit site are rare.

### Critical methodological caveat (drives the whole plan)

The **deterministic retrieval eval** (`stage5_retrieval_eval_cross_repo_30`,
`…_expanded`) and the **live injected capsule** do **not** produce the same pivots.
The live force-inject build incorporates a **failing-test signal** (pivot role
reasons such as _"exercised by a failing test"_) that the deterministic eval does
not. Concretely: the deterministic eval for sphinx-7462 surfaced
`application.py` + `domains/python.py` as pivots and did **not** list
`pycode/ast.py` at all — yet the **live** capsule promoted `pycode/ast.py::unparse`
to **pivot #2**. So "the deterministic capsule does not list file B as a pivot" is
**not** disqualifying, and "the deterministic capsule lists file B" is **not**
sufficient. Live pivots must be confirmed from a capsule build, not assumed.

This is why every recommended candidate is **gated on a cheap capsule-only
pre-check** (build the live-style capsule, confirm B is a pivot) *before* spending
on a live agent run. See [Cost-risk note](#cost-risk-note).

## Recommended candidates

### Tier 1 — strong context-to-action candidate

#### `mwaskom__seaborn-3187`

| field | value |
| --- | --- |
| instance_id | `mwaskom__seaborn-3187` |
| repo | `mwaskom/seaborn` |
| tier | cross-repo-30 deterministic set · **Tier 1** |
| current retrieval status | `hit_top1_pivot` (deterministic): `seaborn/utils.py` ranked #1 pivot; `seaborn/_core/properties.py` pivot #2 |
| known live status | **none** — no existing live run for either arm |
| gold patch files | `seaborn/_core/scales.py`, `seaborn/utils.py` (2 files) |
| gold symbols | `get_view_interval` (scales.py), `spacer` (utils.py) |
| source-anchored pivot(s) | `seaborn/_core/scales.py` — the problem statement **links it directly**: `…/seaborn/_core/scales.py#L377-L382` |
| hidden pivot(s) | `seaborn/utils.py` — named **nowhere** in the issue; surfaced as a Capsule v2 pivot |
| hidden pivot in gold patch? | **yes** — `seaborn/utils.py` is a gold edit file |

**Why it is a good PIVOT_CHECK candidate.** This is the cleanest available twin of
sphinx-7462. The issue hands the agent file A (`scales.py`, linked by line number)
and a `ScalarFormatter`-offset diagnosis, so the agent will anchor there. The fix,
however, also adds an **offset-retrieval helper in `seaborn/utils.py`** — a file the
report never mentions. `utils.py` *is* surfaced as a Capsule v2 pivot, so
PIVOT_CHECK has something to enforce. This directly tests the open question: when a
hidden gold file is a pivot, does forced inspection convert
*discovered/ignored → inspected → edited*?

**Why inspection might change edit planning.** A baseline-style agent that fixes
only `scales.py` (where the issue points) produces an incomplete patch; the gold
also touches `utils.py`. If PIVOT_CHECK makes the agent open `utils.py`, it may
recognize the missing helper as a co-edit — the exact "surfacing → editing"
conversion sphinx-7462 did **not** achieve. A positive result here would be the
first evidence PIVOT_CHECK changes the *edit set*, not just inspection.

**Risk / uncertainty.**
- The deterministic capsule surfaces `utils.py` for the **wrong symbol**
  (`move_legend`, a legend helper) — the expected gold symbol is `spacer`. The file
  is right; the symbol/region is a legend-lexical decoy. Forced inspection may land
  the agent in the wrong part of `utils.py` and not help (or mislead).
- The deterministic capsule does **not** surface `scales.py` as a pivot at all
  (the anchored gold file), so localization of A relies on the issue text, not the
  capsule. Acceptable (the issue links A), but worth noting.
- Live pivots may differ (see methodological caveat) — **pre-check required**.
- seaborn is a mid-size repo; clone+index cost is moderate (less than matplotlib).

**Recommended run label:** `eval-pivot-check-vtrace-seaborn-3187`

**Exact command to run later** (after a green pre-check; do **not** run now):

```bash
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances mwaskom__seaborn-3187 \
  --run-label eval-pivot-check-vtrace-seaborn-3187 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

> A clean before/after needs a **before** run too — a vtrace run *without*
> PIVOT_CHECK injection on the same instance (mirroring the
> `eval-pivot-telemetry-vtrace-sphinx-7462-r2` → `eval-pivot-check-vtrace-sphinx-7462`
> pair). If no such before run exists for seaborn-3187, run one first so
> `stage5_pivot_check` comparison has a baseline pair.

### Tier 2 — plausible but less clean

#### `django__django-13195`

| field | value |
| --- | --- |
| instance_id | `django__django-13195` |
| repo | `django/django` |
| tier | expanded deterministic set · **Tier 2** |
| current retrieval status | `hit_top1_pivot` (deterministic): `http/response.py::delete_cookie` #1; hidden pivot `contrib/sessions/backends/signed_cookies.py::delete` #2 |
| known live status | **none** |
| gold patch files | `django/contrib/messages/storage/cookie.py`, `django/contrib/sessions/middleware.py`, `django/http/response.py` (3 files) |
| gold symbols | `delete_cookie`, `process_response`, `set_signed_cookie`, `_store`, `_update_cookie` |
| source-anchored pivot(s) | `django/http/response.py` — the issue names `HttpResponseBase.delete_cookie` |
| hidden pivot(s) | surfaced hidden pivot is `contrib/sessions/backends/signed_cookies.py` (**not** gold); the genuinely hidden *gold* co-edits are `contrib/messages/storage/cookie.py` and `contrib/sessions/middleware.py` |
| hidden pivot in gold patch? | **no for the surfaced one** — the surfaced hidden pivot (`signed_cookies.py`) is not gold; the hidden *gold* files are not surfaced deterministically |

**Why it is a (weaker) candidate.** Strong anchoring structure: the issue names
`delete_cookie` (→ `http/response.py`), and the full gold also edits two caller
files (`messages/storage/cookie.py`, `sessions/middleware.py`) that the issue does
not name — a real multi-file co-edit. It tests whether the live build + PIVOT_CHECK
can surface and inspect those hidden co-edits.

**Why it is only Tier 2.**
- Deterministically the hidden **gold** files are **not** surfaced as pivots; the
  one hidden pivot that *is* surfaced (`signed_cookies.py`) is **not** gold. So as
  it stands PIVOT_CHECK would enforce inspection of a non-gold file — a likely
  *weak* outcome. It only becomes a real test if the live build promotes
  `cookie.py` / `middleware.py` to pivots (must be confirmed by pre-check).
- The core resolving fix is plausibly **`http/response.py` alone** (the caller
  edits may be consistency follow-ons), so there may be **no hard hidden-edit
  requirement** — risking a "the agent read more, outcome unchanged" result.

**Recommended run label:** `eval-pivot-check-vtrace-django-13195`

```bash
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-13195 \
  --run-label eval-pivot-check-vtrace-django-13195 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

#### `psf__requests-5414` — rule-out / overhead probe (negative control)

| field | value |
| --- | --- |
| instance_id | `psf__requests-5414` |
| repo | `psf/requests` |
| tier | cross-repo-30 · **Tier 2 (rule-out control)** |
| current retrieval status | `hit_top1_pivot` (deterministic): `requests/models.py::prepare_url` #1 |
| known live status | **exists** — `eval-capsulev2-recovered-live-requests-5414`: live pivots `models.py::prepare_url` (anchored) + `api.py::get` (**hidden, not gold**); edited `models.py`; **resolved=false** (correct file, wrong patch shape) |
| gold patch files | `requests/models.py` (1 file) |
| source-anchored pivot(s) | `requests/models.py` |
| hidden pivot(s) | `requests/api.py` — hidden, and **not** a gold edit target |
| hidden pivot in gold patch? | **no** |

**Why include it.** It is the clean *negative* of seaborn-3187 and the only case
with **existing live evidence** of a hidden pivot the agent **correctly did not
edit**. It tests the second PIVOT_CHECK behavior — `inspected → grounded rule-out`
— and, crucially, measures **pure overhead**: does forcing inspection of a
non-gold hidden pivot (`api.py`) waste tokens/cost without (and ideally without
harming) the edit? This is the cheapest available control (small repo, prior data)
to bound PIVOT_CHECK's cost when the hidden pivot is *not* edit-relevant.

**Why only Tier 2.** Single gold file; its existing failure is patch-shape, not
pivot-related, so it cannot show an edit-planning *win* — only rule-out behavior
and overhead. Run last, only if Tier 1 motivates measuring the cost of a forced
non-gold inspection.

**Recommended run label:** `eval-pivot-check-vtrace-requests-5414`

```bash
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-pivot-check-vtrace-requests-5414 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Rejected / deferred candidates

| instance | reason rejected / deferred |
| --- | --- |
| `astropy__astropy-14369` | **Reject (precedent).** Multi-file gold (`units/format/cds.py` + `cds_parsetab.py`), and the hidden gold `units/format/cds.py` *is* a pivot — but already live-tested: baseline + recovered both **localized to it correctly** (no inspection gap to close), and the truly hidden second file (`cds_parsetab.py`) is a **generated PLY parser table**, not a reasoned edit target. No context-to-action gap remains. |
| `sympy__sympy-13372` | **Reject.** Deterministic decoy at top-1 (`sympify`), but the traceback prints `File ".../sympy/core/evalf.py", line 1285, in evalf` — the gold file is source-anchored; the agent localizes trivially. No hidden pivot. |
| `matplotlib__matplotlib-24627` | **Reject.** Already live-tested (parity, both failed). Live capsule pivots were `pyplot.py` (repro entry points, **non-gold**); gold `axes/_base.py` not a live pivot. PIVOT_CHECK would force inspection of non-gold pivots. |
| `matplotlib__matplotlib-22719` | **Reject.** Already live-tested (parity, both resolved). Live capsule pivots were `axis.py` (**non-gold**); gold `category.py` only ever *support*. PIVOT_CHECK has no gold pivot to enforce. |
| `django__django-12325` | **Defer.** 2-file gold (`base.py` + `options.py`) but `hit_support`, single non-gold pivot (`core/checks/model_checks.py`); gold surfaced only as support. Retrieval effectively misses the actionable gold as pivots. |
| `pylint-dev__pylint-8898`, `matplotlib__matplotlib-25960` | **Reject.** `skipped_no_context` — capsule returns no high-confidence pivot, so there is nothing for PIVOT_CHECK to act on. |
| `sphinx-doc__sphinx-7910`, `sphinx-doc__sphinx-9230`, `matplotlib__matplotlib-24970` | **Reject.** `missing` / wrong-subsystem — retrieval does not place the gold file anywhere; a retrieval failure, not a context-to-action failure. |
| All `hit_top1_pivot` single-gold cases (≈20: sympy-12419/12481/15599/16766, scikit-10844/11578, pytest-10051/5262/7432, requests-1142, flask-5014, astropy-14365/14539, xarray-2905/3677, seaborn n/a, the 5 Django baseline set, etc.) | **Reject.** Gold file is already the #1 pivot and source-anchored; there is no hidden second edit site to inspect. No gap to test. |
| `sphinx-doc__sphinx-7462` | **Done.** The validated case; not re-recommended (the goal is new high-signal cases). |

## Selection rationale

The report explicitly distinguishes the three outcome classes the criteria call for:

```
Good PIVOT_CHECK validation outcome:
  hidden pivot moves ignored/discovered-only → inspected
  AND the hidden pivot is a gold edit file, so inspection can plausibly
  flip the edit set (discovered → inspected → edited).
    → seaborn-3187 is the only clean untested instance of this.

Weak PIVOT_CHECK validation outcome:
  hidden pivot moves ignored → inspected
  but the hidden pivot was never edit-relevant (not gold).
    → requests-5414 (api.py) tests this as a controlled rule-out / overhead probe.

Bad candidate:
  no hidden pivot, no multi-pivot capsule, or retrieval misses the relevant file.
    → the entire reject table above.
```

The driving constraint is that **PIVOT_CHECK can only enforce inspection of pivots
already in the injected capsule.** Therefore a candidate is only viable if the
hidden gold file is (or, via the failing-test signal, becomes) a **live pivot** —
which the deterministic eval cannot confirm. Hence the mandatory pre-check.

Why the pool is one-deep: a clean case needs *all* of — (1) ≥2 gold files, (2) one
gold file source-anchored so the agent has an "obvious" home, (3) a *second* gold
file **not** named in the issue, and (4) that hidden gold file actually retrieved
as a pivot. Across cross-repo-30 + the 20-instance expanded set + every live run,
only sphinx-7462 (used) and seaborn-3187 (recommended) satisfy all four;
astropy-14369 satisfies the structure but its gap is already disproven and its
second file is generated.

## Suggested live-run order

1. **Pre-check (no agent, no Docker):** for `seaborn-3187`, build the live-style
   Capsule v2 and confirm `seaborn/utils.py` is a pivot. Only proceed if green.
2. **`eval-pivot-check-vtrace-seaborn-3187`** (+ its before/no-PIVOT_CHECK pair) —
   the one strong context-to-action test. **Run this first; it carries the signal.**
3. *(optional, gated on pre-check promoting the hidden gold files)*
   **`eval-pivot-check-vtrace-django-13195`** — multi-file co-edit probe.
4. *(optional, only if measuring overhead)*
   **`eval-pivot-check-vtrace-requests-5414`** — rule-out / cost-of-forced-inspection
   control.

If the seaborn-3187 result is the same as sphinx-7462 (inspection up, edit set
unchanged), that is itself an informative *negative* and there is little value in
spending on 3–4 before pivoting to the agent-integration question.

## Cost-risk note

The first PIVOT_CHECK run on sphinx-7462 increased usage substantially:

```
tokens: +77.9%
cost:   +95.0%
```

with **no change to the edited file set**. The next runs must be selective, not
numerous. Mitigations baked into this plan:

- **Pre-check gate.** Confirm the hidden gold file is a live pivot via a
  capsule-only build *before* paying for an agent run. This converts most of the
  risk (spending ~2× on a case where PIVOT_CHECK has nothing relevant to enforce)
  into a near-zero-cost check.
- **Order by signal, stop early.** Run the single Tier 1 case first; only continue
  to Tier 2 if it justifies the spend. The goal is a few high-signal cases, not
  coverage.
- **Prefer smaller repos for the overhead control.** `requests` is small; if the
  cost of a forced non-gold inspection needs measuring, measure it cheaply there,
  not on matplotlib/django.

## Non-claims

- This report **selects candidates** for targeted live validation. It does **not**
  claim PIVOT_CHECK improves resolution.
- It does **not** claim broad benchmark performance, and is **not** a public
  SWE-bench result.
- It does **not** run any agent, Docker, or live Stage 5, and makes **no** API
  calls.
- It does **not** alter retrieval, PIVOT_CHECK behavior, telemetry, or benchmark
  execution.
- It does **not** prove PIVOT_CHECK is worth its token/cost overhead — the cost
  question is precisely what the recommended (gated, selective) runs would test.
- Deterministic retrieval rankings used here are **not** a guarantee of live
  injected-capsule pivots; every recommendation is contingent on a live capsule
  pre-check.
