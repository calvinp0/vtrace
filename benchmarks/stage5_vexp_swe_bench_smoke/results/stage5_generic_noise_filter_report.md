# Stage 5R — Generic lexical-noise filtering outcome

Change: down-weight generic bug-report tokens and runner-script mentions in
Capsule v2 query shaping so they no longer steer retrieval. Implemented in
`src/capsule/sweQueryShaping.ts` (`GENERIC_TOKEN_STOPLIST`, `RUNNER_SCRIPTS`),
with the generic stoplist also applied to subsystem inference
(`collectIssueTokens` in `src/capsuleV2/debugRoles.ts`). New diagnostics
(`filtered_generic_symbols`, `filtered_runner_files`) surface in Capsule v2 JSON
and Stage 5R report rows.

## Metrics (expanded fixture, 20 Django instances)

| metric | baseline | after | target | met |
| --- | --- | --- | --- | --- |
| top-1 file accuracy | 65.0% | 65.0% | ≥70% | no |
| top-3 file recall | 80.0% | 80.0% | ≥85% | no |
| expected file missing | 15.0% | **10.0%** | ≤15% | yes |

No instance regressed. One instance improved:

- `django__django-13112`: `missing → hit_discarded`. The bug report's command
  invocation (`python manage.py …`) and the bare word `error` previously shaped
  `likely_files=["manage.py"]` and `likely_symbols=["error"]`, steering retrieval
  toward management commands. Both are now filtered (see the row's
  `filtered_generic_symbols: error` / `filtered_runner_files: manage.py`), and the
  real edit target `django/db/models/fields/related.py` is recovered into the
  candidate pool — it now lands as a discarded near-miss rather than never being
  surfaced.

## Why top-1 / top-3 did not move

The fix removes false-positive *lexical steering*; it does not change role-gate
or budget policy (intentionally out of scope per the task). The two instances the
audit attributed to generic noise (`12325`, `13112`) are now recovered into the
pool but rank beyond the top-3 / support budget:

- `13112`: expected file recovered but **discarded** — "beyond standard support
  budget (max 4)". A budget/ranking concern, not a lexical-noise one.
- `12325`: expected file is **support** (recovered, but below the top-3 cut).

Moving these into the top-3 would require support-budget or ranking changes (and,
for `13112`, the Django system-check routing the task explicitly deferred), not
further query-shaping noise reduction. The P1 fix did what it set out to do:
eliminate generic-token steering and make the filtering auditable, reducing the
missing rate without overfitting to any instance.
