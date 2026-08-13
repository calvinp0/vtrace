# M142 — django-11815 root cause

**Status: root-caused to a line, fixed, and the fix measured over the frozen 50.**

This case was carried out of the previous checkpoint as *"not root-caused to a
line"*, with a recorded hypothesis that turned out to be wrong in both halves.
That hypothesis is corrected below.

## The case

| | |
|---|---|
| instance | `django__django-11815` |
| intent / budget | `debug` / 8000 tokens |
| gold file | `django/db/migrations/serializer.py` |
| gold lead (M141, A, A+B) | `db/migrations/serializer.py::EnumSerializer` |
| lead at `0e4edc7` onward | `contrib/auth/migrations/0009_alter_user_last_name_max_length.py::Migration` |

Task text, verbatim:

```
Migrations uses value of enum object instead of its name. — (last modified by oasl)
Errors: ValueError
Traceback: ValueError: 'Good' is not a valid Status
```

## What the previous checkpoint recorded, and why it was wrong

> *"Bisect places the flip at the C commit (`0e4edc7`), which carried both the
> concept-owner lane and the coeditExpansion structural-symbol filter; the
> concept-owner lane reports no admissions here, so the coedit representative
> change is the likelier producer."*

Both halves are false. The lane admits **six** candidates on this case, and the
coedit filter is **inert** here. The "no admissions" reading came from the
capsule diagnostics, which do not surface the lane; measuring the lane directly
shows otherwise.

## Feature isolation (§12)

Four states, one held-constant index, temporary edits discarded afterwards:

| state | changes | subsystem elected | lead | gold? |
|---|---|---|---|---|
| A+B baseline (`69826d3`) | neither | `db/migrations` | `EnumSerializer` | yes |
| + coedit structural filter **only** | coedit | `db/migrations` | `EnumSerializer` | yes |
| + concept-owner lane **only** | lane | `contrib/auth/migrations` | `Migration` | **no** |
| full `0e4edc7` | both | `contrib/auth/migrations` | `Migration` | **no** |

The coedit structural filter is exonerated and retained. The concept-owner lane
reproduces the regression on its own.

## The causal chain

1. **`conceptOwnerRetrieval.behavioralObjectives`** takes every stemmed token of
   `positiveSearchText` over three characters, minus question-frame words and
   project references. For this task that is fourteen objectives, of which
   `last`, `modified` and `oasl` come from the Trac byline *"(last modified by
   oasl)"* and `error` and `traceback` from the M103 structured-evidence
   **labels** `Errors:` and `Traceback:`. Those tokens are rare across files, so
   they carry high IDF and dominate the ranking that follows.

2. **Owner aggregation** therefore elects `template/defaultfilters.py` (0.6063),
   `core/files/storage.py` (0.5737) and `views/debug.py` (0.5691) — files full of
   short definitions named `last`, `addslashes`, `get_modified_time`,
   `get_accessed_time`. Control measurement: with the byline and the evidence
   labels removed from the task text, the same lane instead elects `enums.py`,
   `base.py` and `migration.py`.

3. **`hybridRetrieval.admitConceptOwnersWithinCap`** admits four of the six into
   a pool already at its cap of 25, **evicting four ranked candidates** to make
   room:

   | evicted | admitted |
   |---|---|
   | `db/migrations/serializer.py::Serializer._registry` | `template/defaultfilters.py::addslashes` (0.4883) |
   | `db/models/base.py::Model.serializable_value` *(a delivered pivot)* | `core/files/storage.py::Storage.get_modified_time` (0.4354) |
   | `db/migrations/exceptions.py::InconsistentMigrationHistory` | `template/defaultfilters.py::last` (0.4184) |
   | `contrib/auth/migrations/0001_initial.py::Migration.operations` | `core/files/storage.py::Storage.get_accessed_time` (0.4056) |

   The admissions score 0.41–0.49 against a delivered pool floor of ~1.40, and
   **none of the four is delivered.**

4. **`debugRoles.resolveLocalSubsystem` (`debugRoles.ts:663-703`)** tallies
   anchored candidates per directory. `pathSegmentOverlap` ties at 1 for both
   contenders — the issue says *"Migrations"* — so the count decides:

   ```
                             A+B    0e4edc7
     db/migrations             8   ->   6
     contrib/auth/migrations   7   ->   6
   ```

   **This is the line.** At 6–6 the tiebreak at **`debugRoles.ts:695`**
   (`dir < best`, lexicographic) elects `contrib/auth/migrations`.

5. **`debugRoles.isGenericInfrastructure` (`debugRoles.ts:499-528`)** now sees
   `EnumSerializer` as out-of-subsystem, with `symbol=0`, `path=0`,
   `testToImpl=0` and `nameOverlap < 2`. The strong-lexical exemption at
   `debugRoles.ts:521-526` would have rescued it, but that exemption is
   deliberately restricted to `ACTIONABLE_FUNCTION_KINDS` and `EnumSerializer` is
   a **class**. It returns `true`.

6. **`debugRoles.ts:279`** — `genericInfra && testToImpl === 0` — demotes it from
   pivot to support, and the support budget (max 4) then discards it outright.

7. `contrib/auth/migrations/0009_*.py::Migration`, unchanged in rank and score, is
   inside the newly elected subsystem, keeps its pivot role, and becomes the lead.

Throughout, **`EnumSerializer`'s own scorecard never moves** (rank 5, final
1.6352 both sides). This is a selection regression that no score-level comparison
could have seen.

## Classification and fix (§14 Case A)

A genuine defect: an unintended interaction between a rescue lane and a
rank-derived inference. Fixed generically in `9f08e33`.

The cap bounds what **ordinary ranking** returns. A lane that exists *because*
ranking cannot see its findings must not compete for ranking's slots — and above
all must not pay for them out of the evidence base that later inferences read.
`admitConceptOwnersBesideCap` admits the recoveries beside the ranking instead of
through it. The pool stays bounded by the lane's own cap of six.

Guarded by two generic fixtures in `src/retrieval/conceptOwnerRetrieval.test.ts`:
whatever ordinary ranking would have returned is still returned once the lane
runs, and the lane never moves the top of the ranking. The first fails on the old
code with the exact eviction message.

### Measured over the frozen 50

| | shipped checkpoint | corrected | M141 |
|---|---|---|---|
| top-1 gold file | 37 | **38** | 39 |
| top-3 gold file | 42 | **44** | 44 |
| gold file anywhere | 48 | 48 | 47 |
| gold symbol anywhere | 28 | **30** | 31 |
| missing gold | 2 | 2 | 3 |
| mean tokens | 1839 | 1849 | 1806 |

Both of C's regressions recover — `django-11815` and `matplotlib-22719` — plus
gold-symbol recoveries on `django-11095` and `pallets/flask-5014`. No case moves
the other way.

## Two fixes measured and not shipped

- **Excluding cap-admitted rescues from the subsystem election.** Principled, and
  inert: the four admissions live in `template/` and `core/files/`, so they never
  voted for either contender. Applied on top of the shipped fix it changed **0 of
  50** cases.
- **Gating the lane off when the request carries direct localization evidence.**
  Inert here — `shapeSweQuery` returns empty `failingTests`, `likelyFiles` and
  `likelySymbols` for this task, so the guard never fires.

## What this leaves open

The objective contamination in step 1 is **real and unfixed**. The lane still
reads `Errors:`/`Traceback:` labels and issue-tracker bylines as behavioural
concepts, and still elects `defaultfilters.py` as the owner of a migrations bug.
It no longer costs anything measurable, because its output can no longer evict
better-evidenced candidates — but it is wasted work and a live precision risk.
Its cost is now bounded by delivery rather than by displacement: over the frozen
50 the lane puts 235 candidates into the pool, of which 16 are delivered and 21
sit in a gold file.

That belongs to **C1/C2**, where the objective-coverage test (§23) and the
representation audit (§29–§39) address it directly. It is recorded here so it is
not mistaken for something this fix resolved.
