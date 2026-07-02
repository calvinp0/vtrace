# Stage 5 M95 — Pre-change Failure Analysis

_Deterministic, offline. Driven by the frozen M94 scoreboard
(`stage5_m94_deterministic_scoreboard.*`) plus per-instance pipeline probes
(`buildCapsuleV2` over the clean base-commit index; gold used only to label the
pool, never fed into generation). No live agents, Docker, or API spend._

## Method

For the 30 `miss` + 10 `wrong_pivot` M94 cases I re-ran `buildCapsuleV2` and
recorded, per gold file, whether it was (a) **absent from the whole retrieved
pool**, (b) **retrieved but discarded** past the emit cutoff, or (c) in
**support** only — plus each candidate's scorecard and role reason. This
distinguishes a true lexical-recall gap from a ranking/role/budget gap, which the
M94 classifier cannot (it only sees the *emitted* capsule, so it labels any
non-emitted gold `lexical_mismatch`).

## Q1–Q2. Of the 30 `lexical_mismatch` cases, causes; gold absent vs filtered

The `lexical_mismatch` bucket is **mixed**. Splitting the misses by pool status:

- **Gold retrieved into the pool but not emitted (ranking/role/budget):** roughly
  half. Examples: `django-15037` (gold `inspectdb.py` discarded "beyond standard
  support budget (max 4)"), `django-16333` (`auth/forms.py::UserCreationForm`
  discarded), `matplotlib-26466` (`text.py` discarded), `sympy-13480`
  (`hyperbolic.py`), `sympy-16792` (`codegen.py`), plus the 10 `wrong_pivot` cases
  where gold sits in **support** with a *higher* final score than the emitted
  pivot.
- **Gold truly absent from the 25-candidate pool (real lexical gap):** the other
  half. Examples: `django-10880` (`aggregates.py`), `django-13810`
  (`handlers/base.py`), `django-14792` (`timezone.py`), `matplotlib-24970`
  (`colors.py`), `sympy-15875` (`core/add.py`), `sympy-20801` (`core/numbers.py`).

So the single biggest correctable lever is **ranking/role**, not raw lexical
recall: gold is frequently retrieved and even scored competitively, then demoted
or dropped before emission.

## Q3. Which repositories dominate misses

`django` (10 miss + 6 wrong_pivot), `sympy` (7 miss), `matplotlib` (5 miss +
1 wrong_pivot), `sphinx` (3 miss), `pylint`/`psf` small. `django` + `sympy` +
`matplotlib` are ~85% of the misses.

## Q4. File/path naming patterns missed

Recurring pattern: **the issue names the gold file's stem or its fully-qualified
module path, but the `path` signal never fires.** `path=0.00` on essentially
every gold candidate probed. Causes:

- Query shaping routes dotted module paths (`utils.numberformat.format`,
  `contrib.auth.forms.UserCreationForm`) to `identifiers`, **never to
  `likelyFiles`**, so `pathMatchRaw` cannot use them.
- Bare filename stems in prose (`inspectdb`, `category`) are not file-shaped
  (no extension / slash), so they never become `likelyFiles` either.

## Q5. Issue-text terms that should have matched but did not

- `django-11206`: title *"utils.numberformat.format renders …"* → gold
  `utils/numberformat.py`. The module path is right there.
- `django-16333`: *"…contrib.auth.forms.UserCreationForm…"* → gold
  `contrib/auth/forms.py`.
- `sympy-19637`: *"sympy.core.sympify"* → gold `core/sympify.py` (pool was empty,
  `no_context`).
- `django-13590`: *"django.db.models.sql.query.Query.resolve_lookup_value"* →
  gold `sql/query.py` (but this one is beyond the 360-char derived task).

## Q6. Are test files overweighted?

Not materially in these cases — the test-dominated-pool backfill already handles
that. Misses are production-vs-production ranking problems.

## Q7. Facade/traceback files overweighted?

Yes, in a subset. `matplotlib-22719` and `matplotlib-24970` lead with
`_api/deprecation.py` (a decorator/facade) while gold (`category.py`, `colors.py`)
is demoted. The generic-lexical-decoy suppressor does not catch `deprecation`
here because the word is a genuine query term.

## Q8. Package re-exports / import aliases

Minor. `django-16938` (serializers `python.py`/`xml_serializer.py`) is a hidden
co-edit reached only via the serializer base, not a re-export alias.

## Q9. Multi-file patches failing because co-edit expansion is absent/weak

`hidden_coedit_recall` is 0.222 on multi-file. Several multi-file misses
(`django-16938`, `pylint-4551`, `sympy-16597`) never recover the non-lead
co-edit. This is real but a smaller lever than the single-file ranking gap
(84/99 are single-file), and riskier (co-edit expansion adds files → tokens).

## Q10. Root causes and the chosen general intervention

Two dominant, general, source-backed root causes:

1. **The issue names the gold's module path, but it never reaches the `path`
   signal.** Fix: in query shaping, derive repo-relative `.py` file candidates
   from dotted module paths in the prose and add them to `likelyFiles`, so the
   EXISTING `pathMatchRaw` scores them. General (a Python convention), additive,
   repo-agnostic. Directly targets gate-moving misses where gold is currently
   absent/discarded (`django-16333`, `sympy-19637`, `django-11206`).

2. **`isGenericInfrastructure` demotes a strongly-lexically-matched source file
   to "support only" when a *mis-inferred* subsystem puts it "outside" — even
   though the base pivot gate treats strong lexical as direct evidence.** The
   subsystem is frequently wrong (`examples/units` for a matplotlib bug,
   `contrib/postgres/fields` for a `db/backends/postgresql` bug). Fix: align the
   generic-infrastructure direct-evidence test with the base gate — a strong
   lexical hit (`lexical >= STRONG_DIRECT_LEXICAL`) exempts a source file from
   the generic-infrastructure demotion. Converts `wrong_pivot` → `good/excellent`
   (recall@1 + lead-pivot) at zero token cost.

3. **(secondary) Dispatcher/entry-point demotion buries the gold function
   itself** when it happens to call in-pool helpers that score *lower* than it
   (`django-11206` `format` final 2.00 → support; `pydata-6599` `polyval` 2.25 →
   support). Guard: do not demote an entry point below helpers it outscores.

Chosen interventions: **(1)** as the primary gate-mover, plus **(2)** and **(3)**
as conservative ranking corrections that lift recall@1 / lead-pivot without
adding capsule budget. All three are deterministic, repo-local, source-backed,
and hardcode no instance ids / paths. Measured on a fixed 60/39 dev/holdout split
(`stage5_m95_dev_holdout_split.json`); holdout reserved for final evaluation.
