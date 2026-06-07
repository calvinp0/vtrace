# Stage 5R — Expanded Retrieval Miss Audit

Diagnostic audit of the four retrieval misses in the 20-instance expanded Stage 5R
evaluation. **This is analysis only — no retrieval logic was changed.** The audit's
first job was to rule out an evaluator/fixture bug; none was found (gold labels
verified against the SWE-bench reference patches, eval classification correct), so
per the task no Capsule v2 tuning was applied.

Source artifacts:
- `results/stage5_retrieval_eval_expanded.json`
- `results/stage5_retrieval_eval_expanded.md`
- per-miss `vtrace capsule --json` re-runs (for the diagnostics the eval row does
  not persist: `subsystem_root`, `likely_files`/`likely_symbols`, backfill flags).

## Executive summary

- **0 evaluator bugs, 0 fixture bugs.** All four expected (gold) files and symbols
  are correct: `_check_ordering` (×2), `ModelBase.__new__` + `Options._prepare`,
  and `ForeignKey.deconstruct`. The eval scored every miss correctly.
- The four misses reduce to **three root causes**, none of which is Capsule v2
  failing on a clean signal:
  1. **Model system-check framework is under-retrieved** (11820, 12858). Both are
     `Model._check_ordering` raising `models.E015`. The file is reachable, but the
     `_check_*` validation method is never ranked; lexical relevance diffuses into
     `db/models/fields/*` and `db/models/lookups.py` ("ordering / lookup / related
     field").
  2. **Lexical over-match on a common English word** (12325). "**multiple** OneToOne
     references" matches `FieldFile.multiple_chunks` in `core/files/*`, dragging
     `subsystem_root` to `core/files` — the wrong subsystem entirely.
  3. **Bug-report noise shaped into `likely_files`/`likely_symbols`** (13112).
     "shows me that error" → `likely_symbols=['error']`; "manage.py migrate" →
     `likely_files=['manage.py']`. Both are red herrings that steer retrieval to
     management commands instead of `ForeignKey.deconstruct`.
- **Cross-cutting finding:** all four misses are auto-derived `gold_patch` tasks
  built from raw bug reports. The gold subset (53% top-1) vs. the curated
  `manual_verified` subset (100%) gap is partly **task-prose noise**, not pure
  retrieval weakness. Capsule v2 retrieves well on clean task signals; it is
  brittle to (a) generic-word lexical matches and (b) noisy bug-report prose.
- **Note on drift from the task brief:** the brief listed `1 present_but_discarded`,
  but the committed artifact (after the task-prose cleanup regeneration) classifies
  12325 as `present_but_support` — `options.py::setup_pk` now surfaces as rank-4
  support rather than being discarded. The underlying miss is the same.

## Miss table

| instance | label | expected file(s) | expected sym | capsule top pivots | subsystem_root | taxonomy | role |
| --- | --- | --- | --- | --- | --- | --- | --- |
| django__django-11820 | gold_patch | db/models/base.py | `_check_ordering` | `fields/related_lookups.py::RelatedLookupMixin`, `fields/reverse_related.py::ForeignObjectRel` | db/models/fields | wrong_subsystem | missing |
| django__django-12858 | gold_patch | db/models/base.py | `_check_ordering` | `db/models/lookups.py::apply_bilateral_transforms`, `…::get_bilateral_transforms` | db/models | missing_from_candidates | missing |
| django__django-12325 | gold_patch | db/models/base.py, db/models/options.py | `__new__`, `_prepare` | `core/files/base.py::multiple_chunks`, `core/files/uploadedfile.py::multiple_chunks` | core/files | present_but_support | support (options.py `setup_pk`) |
| django__django-13112 | gold_patch | db/models/fields/related.py | `deconstruct` | `core/management/base.py::error`, `contrib/admin/utils.py::FieldIsAForeignKeyColumnName` | core/management/commands | wrong_subsystem | missing |

Shared shape for all four: `actual_mode=standard`, `candidate_count=25`,
`pivots=2 / support=4 / discarded=19`, `intent_confidence=high`. No `no_context`,
no `edit_risk_directives`, no `line_anchor`, no `sql_rendering_backfill`, no
`production_backfill`, no `class_method_expansion`. `source_body_call_fallback_used`
fired on 11820 / 12325 / 13112 (not 12858). `likely_files`/`likely_symbols` were
empty except 13112 (`['manage.py']` / `['error']`).

## Per-miss analysis

### django__django-11820 — `models.E015` / `Meta.ordering` of a related field
1. **Picked:** `RelatedLookupMixin` and `ForeignObjectRel` in `db/models/fields/*`.
2. **Expected:** `Model._check_ordering` in `db/models/base.py` (verified: gold hunk
   `def _check_ordering(cls):`).
3. **Status:** absent — base.py is in neither pivots, support, nor discarded
   (`expected_file_role=missing`), even though the file is indexed and
   `_check_ordering` exists at `base.py:1660`.
4. **Which generator should have found it:** a symbol/lexical generator on
   "ordering" — `_check_ordering` literally contains "ordering" — and/or a
   check-framework router keyed on the `models.E015` error code. A targeted query
   (`Model._check_ordering system check …`) surfaced base.py but a *different*
   `_check_*` method, confirming the method is reachable but not ranked.
5. **Likely cause:** **subsystem resolution issue + candidate-ranking gap** in the
   model-validation (system check) area. Not a test-to-impl gap, not graph, not a
   discard rule. Task signal is adequate ("models.E015", "Meta.ordering").

### django__django-12858 — `models.E015` / ordering uses non-transform lookups
1. **Picked:** `apply_bilateral_transforms`, `get_bilateral_transforms` in
   `db/models/lookups.py`.
2. **Expected:** `Model._check_ordering` in `db/models/base.py` (same gold method as
   11820).
3. **Status:** absent (`missing_from_candidates`). Classified differently from 11820
   only because `subsystem_root` resolved to the broader `db/models` (so the
   wrong-subsystem heuristic did not trip).
4. **Which generator should have found it:** same as 11820 — check-framework /
   error-code routing to `_check_ordering`. Here "lookups"/"transforms" pulled
   ranking to `lookups.py`.
5. **Likely cause:** **same root cause as 11820** — system-check methods are
   under-retrieved. The "lookups/transforms" wording makes the lexical diffusion
   worse than 11820.

### django__django-12325 — MTI `pk` setup confused by multiple OneToOne references
1. **Picked:** `FieldFile.multiple_chunks` in `core/files/base.py` and
   `core/files/uploadedfile.py`.
2. **Expected:** `ModelBase.__new__` in `db/models/base.py` and `Options._prepare`
   in `db/models/options.py` (verified gold hunks).
3. **Status:** `options.py` is present as rank-4 **support** (`setup_pk`); base.py
   and both gold symbols are not surfaced (`expected_symbol_role=missing`).
4. **Which generator should have found it:** a lexical/symbol generator weighting
   "parent_link" / "OneToOne" / "MTI" toward `db/models/base.py.__new__`. Instead the
   word "multiple" produced the dominant (and irrelevant) match.
5. **Likely cause:** **lexical over-match on a generic word** ("multiple" →
   `multiple_chunks`) driving `subsystem_root` to `core/files`, compounded by
   **weak task signal** (the abbreviation "MTI" and vague "pk setup" are not
   expanded; the load-bearing token is "parent_link", which was not weighted).

### django__django-13112 — makemigrations crash, FK with mixed-case app name
1. **Picked:** `core/management/base.py::error`, `contrib/admin/utils.py::FieldIsAForeignKeyColumnName`.
2. **Expected:** `ForeignKey.deconstruct` in `db/models/fields/related.py` (verified
   gold hunk `def deconstruct(self):`).
3. **Status:** absent (`wrong_subsystem`); `subsystem_root=core/management/commands`.
4. **Which generator should have found it:** a lexical/symbol generator on
   "ForeignKey" + "deconstruct"/"app label" toward `fields/related.py`. Instead the
   query shaper extracted `likely_symbols=['error']` and `likely_files=['manage.py']`
   from the bug-report prose and steered retrieval to management commands.
5. **Likely cause:** **query-shaping over-extraction** — generic word "error" and the
   runner script "manage.py" became shaped signals; **task-text noise** (a verbatim
   user bug report) dominated the real "ForeignKey / mixed-case app name" signal.

## Root-cause grouping

| root cause | misses | nature |
| --- | --- | --- |
| Model system-check (`_check_*`) framework under-retrieved | 11820, 12858 | candidate-ranking / subsystem resolution |
| Lexical over-match on a common English word ("multiple") | 12325 | lexical false-positive → wrong subsystem |
| Bug-report noise shaped into `likely_files`/`likely_symbols` ("error", "manage.py") | 13112 | query-shaping over-extraction + task-text noise |
| Auto-derived task prose noisier than curated tasks | all 4 | fixture/task-quality (not a bug) |

## Recommended fixes, grouped by priority

> None applied in this task. These are proposals for a follow-up retrieval change,
> to be taken only after the manual reviews below.

**P1 — general robustness, low overfitting risk**
- Down-weight lexical matches on generic, non-domain tokens (e.g. "multiple",
  "error", "issue", "crash", "shows") so a single common word cannot dominate
  `subsystem_root`. Directly addresses 12325; helps 13112 and broad robustness.
- Make query shaping ignore (a) generic English words and (b) runner/entry scripts
  (`manage.py`, `setup.py`, `wsgi.py`) when populating `likely_files`/`likely_symbols`.
  Directly addresses 13112's `['manage.py']` / `['error']` misdirection.

**P2 — targeted capability, moderate overfitting risk**
- Add a candidate generator (or role boost) for the **model system-check framework**:
  when the task cites a check code (`models.EXXX is raised`) or "system check" +
  "Meta.ordering", route toward the `_check_*` methods in `db/models/base.py`.
  Addresses 11820 + 12858. **Narrow and Django-validation-specific — verify it
  generalizes before implementing.**

**P3 — evaluation quality, not retrieval**
- Continue tightening auto-task derivation (strip more bug-report boilerplate), or
  add `manual_verified` task variants for 11820/12858/12325/13112 to separate
  "task-prose noise" from "true retrieval gap" in the headline metric.

## General product improvements vs. possible overfitting

- **General improvements (recommend):** P1 generic-token down-weighting and shaping
  stopword/runner-script exclusion. These fix a class of brittleness (one common
  word or one noisy line hijacking the subsystem) rather than a single instance.
- **Possible overfitting (gate behind review):** P2 error-code → `_check_*` routing.
  It is keyed on Django's validation conventions and risks being a per-pattern
  patch; only worth it if check-framework bugs are a recurring evaluation class.

## Misses to manually review before changing code

- **11820 + 12858 (highest priority for review):** confirm the system-check routing
  generalizes beyond `models.E015`/`_check_ordering` (other `E0xx` codes, other
  frameworks) before writing a generator — otherwise it is overfitting.
- **12325:** review whether down-weighting "multiple" (and similar) regresses any
  passing instance where a generic word is genuinely load-bearing.
- **13112:** review the query shaper's token/file selection — confirm excluding
  `manage.py` and generic words like "error" does not remove signal on tasks where a
  management command IS the edit site.
- All four: re-derive or hand-author cleaner task prose first, then re-measure — some
  of the gap is task noise, and a retrieval change should be evaluated against clean
  tasks so it is not tuned to compensate for fixture noise.
