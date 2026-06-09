# Stage 5 — localization-gap candidate audit

**Audit/selection only. No new live-agent jobs were run for this report.** It
mines existing Stage 5 artifacts and deterministic retrieval reports to nominate a
small set of instances where Capsule v2 is *expected* to help **localization** —
i.e. where a no-context baseline agent would plausibly edit the wrong file/symbol
while vtrace surfaces the gold target. It does **not** claim a vtrace advantage;
it identifies where one could be tested.

## Executive summary

The prior baseline-vs-vtrace work produced resolution parity *and identical
localization* — on all 8 instances with an existing baseline live run (5 Django +
3 recovered cross-repo), the baseline agent edited the correct gold file. So those
runs **cannot** demonstrate a localization gap, and none can be reused for that
purpose.

Inspecting the deterministic cross-repo-30 retrieval set surfaces the structural
signal for a gap: instances that are **`hit_top3` with a decoy at top-1** — the
gold file is in vtrace's top-3 but a *different* file is the #1 pivot. There are
five such cases. But a deterministic decoy is **not** a reliable predictor of a
*live* baseline miss, for one concrete reason this audit makes central:

> **Most SWE-bench problem statements leak the gold file in a traceback.** When
> the bug report's traceback names the fix file, a live baseline agent localizes
> trivially regardless of retrieval — which is exactly why baseline localized
> correctly on every prior case, including `astropy-14369`, whose task framing
> points at the *wrong* subsystem yet whose baseline run still edited the right
> file.

So the real candidates are the narrower set where the decoy is at top-1 **and** the
problem statement does **not** hand the gold file to the agent (no traceback naming
it, or a multi-frame traceback whose most-salient frame is the decoy). That
filtering leaves **3 recommended candidates** (2 strong, 1 medium). The pool is
deliberately small; its smallness is itself the finding — clean live localization
gaps are rare in this dataset because tracebacks usually pre-localize the bug.

## Candidate table

All rows are cross-repo-30 instances. "Decoy@top-1" = vtrace's #1 pivot is a file
other than the gold. "Traceback leaks gold?" = the problem statement contains a
traceback/file reference naming the gold file. Class = localization-gap strength.

| Instance | Repo | Gold file(s) · symbol | vtrace Stage 5R | Decoy @ top-1 | Traceback leaks gold? | Framing points at | Class |
| --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | matplotlib | `axes/_base.py` · `__clear` | top-3, **rank 2 (pivot)** | `figure.py::clf` | **no** (no traceback, no file named) | both `cla()`/`clf()` — ambiguous | **strong** |
| matplotlib-22719 | matplotlib | `category.py` · `convert`/`update` | top-3, rank 3 (support) | `_api/deprecation.py::MatplotlibDeprecationWarning` | partial (gold is a *middle* frame; deepest frame is the decoy) | "deprecation warning" → decoy | **strong** |
| sphinx-7462 | sphinx | `domains/python.py` **+** `pycode/ast.py` · `unparse` | top-3, **rank 2 (pivot)** | `application.py::add_object_type` | partial (names gold #1, **not** gold #2 `pycode/ast.py`) | type-annotation `unparse` | medium |
| sympy-13372 | sympy | `core/evalf.py` · `evalf` | top-3, rank 2 (pivot) | `core/sympify.py::sympify` | **yes** — traceback names `sympy/core/evalf.py` + `evalf` | "evalf" (names the target) | reject |
| astropy-14369 | astropy | `units/format/cds.py` (+`cds_parsetab.py`) | top-3, rank 2 (pivot) | `io/ascii/cds.py::Cds` | no — but **already live-tested** | "ascii.cds reader" → decoy subsystem | reject (precedent) |

Other cross-repo-30 instances are excluded up front: `hit_top1_pivot` cases (×20)
have **no decoy** (gold is already #1, so no localization gap to test), and
`missing` / `skipped_no_context` / `hit_discarded` / `hit_support`-rank-6 cases
(`matplotlib-24970`, `sphinx-7910`, `sphinx-9230`, `pylint-8898`,
`matplotlib-25960`, `requests-1724`, `astropy-14598`) **fail criterion 2** — vtrace
does not place the gold file in top-3, so they cannot demonstrate a vtrace
localization *win*.

The 5 Django + 3 recovered instances with existing baseline live runs all have
`baseline_resolved=true` (or a working-file edit) and correct localization, so none
is a gap candidate:

| Instance | baseline live | baseline edited | gold file | localized? |
| --- | --- | --- | --- | --- |
| django-10880 | resolved | `db/models/aggregates.py` | `db/models/aggregates.py` | yes |
| django-11095 | resolved | `contrib/admin/options.py` | `contrib/admin/options.py` | yes |
| django-11490 | resolved | `db/models/sql/query.py` | `db/models/sql/compiler.py` | working sibling (same subsystem) |
| django-11728 | resolved | `contrib/admindocs/utils.py` | `contrib/admindocs/utils.py` | yes |
| django-11740 | resolved | `db/migrations/autodetector.py` | `db/migrations/autodetector.py` | yes |
| requests-5414 | resolved | `requests/models.py::prepare_url` | `requests/models.py` | yes |
| sympy-16766 | resolved | `printing/pycode.py::PythonCodePrinter` | `printing/pycode.py` | yes |
| astropy-14369 | **failed** | `units/format/cds.py` | `units/format/cds.py` | **yes (localized, patch failed)** |

`astropy-14369` is the key datapoint: baseline **failed to resolve** but **localized
correctly** — proof that a deterministic framing gap need not produce a live
localization miss.

## Recommended 3–5 live instances

Recommend **3** new comparison pairs (baseline + vtrace), ordered by gap strength:

1. **matplotlib__matplotlib-24627** (strong)
2. **matplotlib__matplotlib-22719** (strong)
3. **sphinx-doc__sphinx-7462** (medium)

This is the honest viable set. `sympy-13372` and `astropy-14369` are documented
rejects (below), so padding to 5 would mean recommending instances we already
expect *not* to show a gap. Three well-chosen pairs is the right scope for a
targeted localization test.

### Why each selected case tests localization

- **matplotlib-24627 — strongest.** The task ("`cla()`, `clf()` should unset
  `.axes`/`.figure`") names **no file** and carries **no traceback**; it is a
  behavioural description. `clf()` → `figure.py` (the decoy vtrace itself ranks #1)
  and `cla()` → `axes/_base.py` (the gold, via the shared `__clear` it calls). A
  baseline agent must *reason* from the symptom to the right of two plausible
  files; vtrace puts `axes/_base.py::__clear` at rank-2 pivot. Cleanest possible
  localization decision with nothing leaking the answer.

- **matplotlib-22719 — strong (symptom ≠ cause).** A multi-frame traceback whose
  **deepest, most-salient frame is the decoy** (`_api/deprecation.py::warn_deprecated`,
  vtrace's #1 pivot) and whose framing is "confusing **deprecation warning**". The
  real fix is in `category.py::convert` — a *middle* frame that wrongly emits the
  warning. An agent that follows the symptom to the warning machinery mis-localizes;
  vtrace surfaces `category.py` at top-3. Tests whether context redirects the agent
  from symptom-file to cause-file.

- **sphinx-7462 — medium (second-file gap).** The traceback names gold #1
  (`domains/python.py`, where the `IndexError` is raised), so baseline will likely
  find that file. But the actual `unparse` logic that must change also lives in gold
  #2 `pycode/ast.py`, which is **named nowhere** in the report. The decoy
  `application.py` is vtrace's #1 pivot. Tests whether vtrace surfaces the
  *non-obvious second* edit site that the traceback hides.

### Cases rejected and why

- **sympy-13372 — reject.** Despite a deterministic decoy (`sympify` at top-1), the
  problem statement's traceback explicitly prints `File "./sympy/core/evalf.py",
  line 1285, in evalf`. A live baseline agent opens `evalf.py` immediately; there is
  no live gap to find. (Good illustration that a deterministic-ranking decoy is not a
  live-localization predictor.)
- **astropy-14369 — reject (already tested).** Textbook framing gap (task says
  `ascii.cds` reader in `io/ascii`; fix is in `units/format`), but the **completed**
  baseline live run already localized to `units/format/cds.py` correctly (it just
  produced a failing patch). Re-running it would not test localization — that
  question is already answered: no gap manifested.

## Whether existing vtrace/baseline runs can be reused

**No.** For all three recommended instances there is **no existing live run** of
either arm (only the deterministic Stage 5R retrieval result exists, and that is not
a live agent run). And the existing baseline live runs (5 Django + 3 recovered)
cannot stand in, because baseline localized correctly on every one — they contain no
gap to measure. Therefore **both** the baseline and vtrace arms must be run fresh
for each recommended instance. (The deterministic Stage 5R top-3 placement is the
*reason* these were selected, but it is not a substitute for the live vtrace arm.)

## Exact next run commands / labels (only if a live test is approved)

Full instance ids and labels:

| Instance id | baseline label | vtrace label |
| --- | --- | --- |
| `matplotlib__matplotlib-24627` | `eval-localization-gap-baseline-matplotlib-24627` | `eval-localization-gap-vtrace-matplotlib-24627` |
| `matplotlib__matplotlib-22719` | `eval-localization-gap-baseline-matplotlib-22719` | `eval-localization-gap-vtrace-matplotlib-22719` |
| `sphinx-doc__sphinx-7462` | `eval-localization-gap-baseline-sphinx-7462` | `eval-localization-gap-vtrace-sphinx-7462` |

Per instance (identical settings to the prior comparison; vexp off, no auto-policy):

```bash
ROOT=benchmarks/stage5_vexp_swe_bench_smoke
VEXP=/home/calvin/code/vexp-swe-bench
INSTANCE=matplotlib__matplotlib-24627       # repeat for the other two ids
SHORT=matplotlib-24627

# --- baseline arm (no vtrace context) ---
bun "$ROOT/run_stage5_vexp_swe_bench_smoke.ts" \
  --mode run-protocol --protocol baseline \
  --vexp-swe-bench-dir "$VEXP" --instances "$INSTANCE" \
  --run-label "eval-localization-gap-baseline-$SHORT" \
  --out "$ROOT/results"

# --- vtrace arm (Capsule v2 force-inject) ---
bun "$ROOT/run_stage5_vexp_swe_bench_smoke.ts" \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir "$VEXP" --instances "$INSTANCE" \
  --run-label "eval-localization-gap-vtrace-$SHORT" \
  --show-vtrace-index-log --context-policy force-inject \
  --capsule-engine v2 --capsule-intent debug --capsule-budget 8000 \
  --out "$ROOT/results"

# --- evaluate (docker) + ingest, for BOTH labels ---
for label in eval-localization-gap-baseline-$SHORT eval-localization-gap-vtrace-$SHORT; do
  bun "$ROOT/run_stage5_vexp_swe_bench_smoke.ts" --mode evaluate --eval-mode docker \
    --eval-dataset princeton-nlp/SWE-bench_Verified \
    --vexp-swe-bench-dir "$VEXP" --run-label "$label" --out "$ROOT/results"
  bun "$ROOT/run_stage5_vexp_swe_bench_smoke.ts" --mode ingest \
    --run-label "$label" --out "$ROOT/results"
done
```

> Cost/time note: matplotlib and sphinx are large repos; the vtrace arm clones and
> indexes each fresh (comparable to the astropy run, ~5–7 min before the agent). Six
> live agent runs + six Docker evaluations total. Guard each run for
> `api_error_status` (529/infra) before evaluating, as in the prior drivers.

### What to collect per run (for the eventual comparison)

`resolved`, edited files, **whether the gold file was edited**, whether the gold
symbol was edited, `costUsd`, `durationMs`, `numTurns`, token totals, a one-line
patch summary, and — the point of this set — **whether baseline edited the decoy /
wrong file while vtrace edited the gold file**. A localization win requires baseline
to mis-localize *and* vtrace to localize; resolution is secondary to *where* each
arm edited.

## Non-claims

- **This audit alone proves nothing about vtrace.** It is candidate selection from
  deterministic signals; no live localization advantage is demonstrated here.
- **Deterministic decoys are not live-miss guarantees.** `astropy-14369` is the
  standing counter-example — a framing gap that did not produce a live baseline
  mis-localization.
- **Not a benchmark, not a public SWE-bench score.** A hand-picked trio chosen to be
  *unfavourable to easy baseline localization*; even if a gap appears, three
  instances cannot support a broad claim.
- **The candidate pool is small by nature.** Tracebacks in problem statements
  usually pre-localize the bug, so genuinely gold-file-hiding cases are rare; this
  is a property of the dataset, not a tuning target.
