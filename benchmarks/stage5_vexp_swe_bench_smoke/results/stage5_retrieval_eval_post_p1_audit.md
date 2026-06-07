# Stage 5R — Post-P1 Retrieval Ranking-Gap Audit

Diagnostic audit of the retrieval failures that remain after the P1 generic
lexical-noise filter. **Analysis only — no retrieval logic was changed in this
task.** The first job was again to rule out an evaluator/fixture bug; none was
found (gold labels match the SWE-bench reference patches and the eval scored every
row correctly), so per the task no Capsule v2 tuning was applied.

Source artifacts:
- `results/stage5_retrieval_eval_expanded.json` (post-P1 rows + diagnostics)
- `results/stage5_generic_noise_filter_report.md` (P1 outcome)
- `results/stage5_retrieval_eval_expanded_miss_audit.md` (pre-P1 audit)
- Per-instance in-process `buildCapsuleV2` re-runs over the indexed workspaces, to
  recover the **full** candidate pool with scorecards (the persisted eval row keeps
  only top-5 discarded). This is what exposes the exact rank/score of each
  expected file and the dead score components.

## Executive summary

- **Aggregate is unchanged from the headline P1 number:** top-1 65.0%, top-3
  80.0%, missing 10.0%, discarded 5.0%. 16/20 are clean top-3 hits. Four instances
  are not top-3: `11820`, `12858` (missing) and `12325`, `13112` (recovered but
  below the cut).
- **By label source the split is stark:** `manual_verified` (n=5) is 100% top-1;
  auto-derived `gold_patch` (n=15) is 53% top-1 / 73% top-3 / 13% missing. **All
  four remaining misses are auto-derived `gold_patch` bug reports.**
- **P1 did exactly what it claimed and nothing more.** It removed one class of
  *active* misdirection — noise tokens (`error`, `manage.py`) steering subsystem
  selection. `13112`'s `subsystem_root` is now correctly `db/models/fields`
  (was `core/management/commands`) and `makemigrations.py` fell from pivot to
  discarded. No instance regressed.
- **The P1 report's framing of the residue as "a budget/ranking concern" is
  incomplete and is corrected here.** Across all four misses the decisive failure
  is **lexical recall / diffusion**, not the support budget:
  - Two misses (`11820`, `12858`) — the **gold file is absent from the 25-candidate
    pool entirely**. No budget or role change can surface a candidate that was
    never generated.
  - Two misses (`12325`, `13112`) — the gold file is present but the **gold symbol
    is not**, and the file's best representative sits far below the top-3 cut
    (overall rank 6 and 12 respectively), out-ranked by lexically-similar decoys.
- **Unifying root cause (post-P1):** these four tasks are verbatim bug reports that
  carry **no failing-test node id** and **do not name the gold edit symbol**
  (`_check_ordering`, `__new__`/`_prepare`, `deconstruct`). With both the
  failing-test→impl generator and the symbol-seed generator contributing nothing
  (`test_to_impl=0`, `symbol=0` on every candidate in all four), retrieval is
  **lexical-only**, and the lexically-dominant terms in these particular reports
  are **decoys** that resolve to the wrong file/subsystem ("ordering"→lookups,
  "multiple"→`multiple_chunks`, "ForeignKey"→FK-named helpers). P1 stopped noise
  from *pushing* the wrong answer up; it cannot *pull* the right answer up.
- **Caveat on the discriminator:** "no failing test" and "gold symbol absent from
  prose" are NOT clean predictors of a miss — many *passing* instances share both
  (e.g. `11490`, `11728`, `11815` all hit top-1 with `symbol=0` and the gold name
  absent from prose). They succeed because their bug-report vocabulary points at
  the right file anyway. The misses are specifically the cases where the
  lexically-dominant vocabulary points at a **wrong but plausible** file.

## Remaining miss table (gold file not in top-3)

| instance | expected file / symbol | current role | gold file in pool? | gold file overall rank | top pivots (file::symbol, final) | P1 filtered |
| --- | --- | --- | --- | --- | --- | --- |
| django__django-11820 | `db/models/base.py` / `_check_ordering` | **missing** | **No** | — (absent) | `fields/related_lookups.py::RelatedLookupMixin` (1.806), `fields/reverse_related.py::ForeignObjectRel` (1.790) | none |
| django__django-12858 | `db/models/base.py` / `_check_ordering` | **missing** | **No** | — (absent) | `db/models/lookups.py::apply_bilateral_transforms` (1.931), `…::get_bilateral_transforms` (1.867) | none |
| django__django-12325 | `db/models/base.py`, `db/models/options.py` / `__new__`, `_prepare` | **support** | options.py: yes / base.py: no | **6** (support #4) | `core/files/base.py::multiple_chunks` (1.594), `core/files/uploadedfile.py::multiple_chunks` (1.578) | none |
| django__django-13112 | `db/models/fields/related.py` / `deconstruct` | **discarded** | yes (via `get_col`) | **12** (discarded #6) | `contrib/admin/utils.py::FieldIsAForeignKeyColumnName` (1.969), `db/migrations/autodetector.py::_get_dependencies_for_foreign_key` (1.897) | `error`, `manage.py` |

Shared shape (all four): `actual_mode=standard`, `candidate_count=25`,
`pivots=2 / support=4 / discarded=19`, `intent_confidence=high`,
`failing_tests=[]`. No `no_context`, no `line_anchor`, no `sql_rendering_backfill`,
no `production_backfill`, no `class_method_expansion`.
`source_body_call_fallback_used` fired on 11820/12325/13112 (not 12858). On every
candidate in all four pools `symbol=0.00` and `test_to_impl=0.00` — the symbol and
failing-test routes are dead; only `lexical`, `actionability`, `centrality`, and
occasional `graph_proximity` carry score.

## Recovered-but-low-ranked table

| instance | expected file | best representative symbol | why it is the representative | final | overall rank | distance to top-3 |
| --- | --- | --- | --- | --- | --- | --- |
| django__django-12325 | `db/models/options.py` | `setup_pk` (support #4, `genInfra=true`) | lexical 0.81 on "pk/setup" vocab; **not** the gold `_prepare` | 1.956 | 6 | behind 2 decoy pivots (`multiple_chunks`) + 3 generic-infra support |
| django__django-13112 | `db/models/fields/related.py` | `get_col` (discarded #6) | `graph_proximity=1.00`, `lexical=0.06` — an incidental graph neighbour, **not** the gold `deconstruct` | 1.152 | 12 | 0.235 below the lowest support; gold symbol never generated |

## Special focus — django__django-13112: target recovered but discarded

Exact mechanism, top to bottom:

1. **P1 worked.** `likely_symbols=['error']` and `likely_files=['manage.py']` are
   now filtered (`filtered_generic_symbols:['error']`,
   `filtered_runner_files:['manage.py']`). `subsystem_root` is now
   `db/models/fields` (was `core/management/commands`), and
   `core/management/commands/makemigrations.py` dropped from the pivots to
   discarded positions #10/#11. The active misdirection is gone.

2. **The gold symbol `ForeignKey.deconstruct` is never generated as a candidate.**
   There is no failing test, the word "deconstruct" does not appear in the bug
   report ("makemigrations crashes for ForeignKey with mixed-case app name"), and
   lexical search on the prose ranks many FK-named symbols
   (`FieldIsAForeignKeyColumnName`, `ForeignKeyName`, `_get_foreign_key`, …) above
   the field-definition method. `deconstruct` is not lexically distinctive in the
   prose, so it never enters the 25-candidate pool.

3. **The file is present only by accident.** `db/models/fields/related.py` appears
   exactly once, as `related.py::get_col` — pulled in purely by
   `graph_proximity=1.00` with `lexical=0.06`. It carries no issue relevance of
   its own; it is a graph neighbour of an anchored candidate.

4. **The discard is rank-based, not rule-based.** `get_col` scores `final=1.152`
   and lands at discarded position #6 = **overall rank 12** (2 pivots + 4 support +
   6). Its `discard_reason` is the generic "beyond standard support budget (max 4)"
   that every candidate past rank 6 receives — there is no special discard rule
   firing on it. The lowest-scored *support* item is `forms/models.py::_get_foreign_key`
   at `final=1.387`; `get_col` is **0.235 below** that and would have to overtake
   ~8 candidates just to reach support, and far more to reach top-3.

5. **Therefore a budget increase does not fix 13112.** Surfacing `get_col` would
   (a) require a large budget bump that admits a lot of FK-named noise, and
   (b) still surface the **wrong symbol** in the right file. The real gap is
   symbol-level recall for the gold `deconstruct`, which is a candidate-generation
   problem, not a budget knob.

## Root-cause grouping (post-P1)

| # | root cause | instances | nature | fixable by budget? |
| --- | --- | --- | --- | --- |
| RC-1 | **Gold file absent from candidate pool** — model system-check methods (`_check_*` in `base.py`) are not generated; lexical "ordering/lookup/transform" diffuses to `fields/*` and `lookups.py` | 11820, 12858 | recall gap (candidate generation) | No |
| RC-2 | **Lexical decoy out-ranks the gold file** — a generic word in the raw prose dominates BM25 as a *pivot* ("multiple"→`multiple_chunks`), pushing the gold file below the cut and keeping `subsystem_root` on the wrong package (`core/files`) via anchored-count | 12325 | scoring (lexical specificity) | No (decoys must be down-weighted first) |
| RC-3 | **Gold symbol never generated; file only via graph neighbour** — no test, gold symbol not in prose, not lexically distinctive | 13112 (and the symbol half of 12325) | recall gap (symbol generation) | No |
| RC-4 | **Auto-derived bug-report prose is decoy-heavy** vs curated tasks (gold_patch 53% top-1 vs manual_verified 100%) | all 4 | fixture / task quality | N/A (evaluation, not retrieval) |

Note: RC-2 is the *residual* of P1. P1 stopped generic tokens from becoming
`likely_symbols` and from driving `subsystem_root` via issue tokens, but — by
design — left them in the raw text for BM25. So "multiple" still wins the lexical
race and `multiple_chunks` is still a pivot. Closing RC-2 means extending the
generic-token down-weighting from query *shaping* into the lexical/domain *scorer*.

## Recommended next implementation (if any)

One change is general and low-overfitting enough to consider next; the rest are
explicitly deferred (see below).

**P1.5 — extend generic-token down-weighting into the lexical/domain scorer
(candidate, not a commitment).** Today the P1 stoplist only governs query shaping
(`likely_symbols`, subsystem issue-tokens). A decoy word like "multiple" still
drives BM25/domain scoring and can make `multiple_chunks` a *pivot* (RC-2). Giving
the same stoplist a reduced weight inside `hybridScoring` (e.g. discount a query
token's lexical/domain contribution when it is in `GENERIC_TOKEN_STOPLIST`) would
let the real anchor compete. This directly targets `12325` and the broad
"one common word hijacks the pivot" failure mode.

- **Scope it tightly and measure both directions.** It MUST be evaluated against
  the 16 current hits for regressions before landing — several hits legitimately
  rely on common-ish words. If it regresses any hit, do not land it.
- It will *not* fix `11820`/`12858` (gold file absent) or fully fix `13112` (gold
  symbol absent); those need recall, not re-weighting.

## Explicit "do not fix yet" items

- **Do NOT change the support/role budget or discard caps.** The evidence is
  decisive: `11820`/`12858` have no gold candidate to surface at any budget, and
  `13112`/`12325` sit at overall rank 12 / 6 behind genuinely higher-scored
  decoys. A budget bump buys noise, not these targets, and would surface the wrong
  symbol for `13112`.
- **Do NOT implement the Django model system-check router (prior P2) yet.** It
  would address `11820`+`12858` by routing `models.E0xx` / "Meta.ordering" toward
  `base.py::_check_*`, but it is keyed on Django validation conventions and risks
  being a per-pattern patch. Confirm it generalizes (other `E0xx` codes, other
  check frameworks, non-Django repos) before writing a generator.
- **Do NOT add a class-name → method-recall generator for `13112` yet.** "name a
  class, seed all its methods" is speculative and high-overfitting; revisit only
  if class-named bug reports are shown to be a recurring evaluation class.
- **Do NOT tune retrieval to compensate for fixture noise.** Three-quarters of the
  gold-vs-manual gap is decoy-heavy auto-derived prose. Prefer re-deriving cleaner
  task prose (or adding `manual_verified` variants for 11820/12858/12325/13112)
  and re-measuring first, so any P1.5 change is evaluated against clean tasks.

## Verification

`bun run typecheck` and `bun test` were run after writing this audit (analysis-only
change; no source modified). Both pass.
