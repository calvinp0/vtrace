# Stage 5 pivot ranking v2 report

## Summary

- Results dir: `/home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results`
- Default pivot ranking version: **v2**
- Astropy modeled comparison: legacy top `astropy/units/format/vounit.py` → v2 top `astropy/units/format/cds.py` (flipped ✅).
- Controlled strict snapshots scanned: 10; with a broad/large top pivot: 7.

## Ranking rule changes

- Multi-evidence boost: a candidate supported by 2+ independent evidence types gains a small additive boost (capped).
- Specificity boost: function/method gains a small boost; module-level symbols a small penalty; classes stay neutral.
- Broad-snippet penalty: a large snippet OR a broad class/module is penalized ONLY when its support is weak (≤1 evidence type and no strong-exact match).
- Strong-exact shield: a strong symbol/body-literal match earns a boost AND shields a large/broad candidate from the broad penalty.
- Implementation-path preference: docs/tests/config/generated/vendored paths (or pre-classified non-source examples) get a small penalty.

Scoring is additive over the legacy `final` (conservative refinement, not a re-score) and uses ONLY pre-outcome signals (scorecard strengths, kind, path, snippet size). Production re-ordering is gated to the ambiguous multi-pivot, no-strong-anchor case.

## Astropy comparison

Two-candidate case modeled from the committed Stage 5 Astropy diagnostic (broad `vounit.py::VOUnit` class vs specific `cds.py` implementation). Scores from the real `scorePivotLegacy`/`scorePivotV2`:

| candidate | kind | legacy score | v2 score | v2 signals | v2 penalties |
| --- | --- | --- | --- | --- | --- |
| `astropy/units/format/vounit.py` | class | 0.7 | 0.55 | — | broad+weak large-snippet(900t) -0.15 |
| `astropy/units/format/cds.py` | method | 0.6 | 0.88 | multi-evidence(3) +0.2; specific-impl(method) +0.08 | — |

Legacy ranks `astropy/units/format/vounit.py` first; v2 ranks `astropy/units/format/cds.py` first. v2 promotes the specific implementation pivot over the broad class — the intended fix.

## Controlled-set sanity checks

Structural proxy over the committed strict snapshots (kind from the source first-line; snippet size from the source block). Because snapshots carry no scorecards/evidence strengths, a faithful per-task legacy-vs-v2 re-rank is NOT possible from artifacts alone — these are shape indicators, not a re-rank.

| task | pivots | top pivot | top kind | top snippet (tok≈) | looks broad |
| --- | --- | --- | --- | --- | --- |
| astropy-14369 | 2 | astropy/units/format/vounit.py | class | 2191 | yes |
| django-10880 | 2 | django/db/models/query.py | function-or-method | 108 | no |
| django-11095 | 2 | django/contrib/admin/options.py | function-or-method | 299 | no |
| django-11490 | 2 | django/db/models/sql/compiler.py | function-or-method | 739 | yes |
| django-11728 | 2 | django/contrib/admindocs/utils.py | function-or-method | 408 | yes |
| django-11740 | 2 | django/contrib/gis/gdal/feature.py | class | 901 | yes |
| matplotlib-22719 | 2 | lib/matplotlib/axis.py | function-or-method | 156 | no |
| requests-5414 | 2 | requests/models.py | function-or-method | 834 | yes |
| sphinx-7462 | 2 | sphinx/domains/python.py | function-or-method | 577 | yes |
| sympy-16766 | 2 | sympy/printing/pycode.py | class | 95 | yes |

Requested controlled-set metrics, to the extent artifacts permit:

- Number of tasks with changed top pivot: **not computable from artifacts** (no scorecards in snapshots).
- Number where top pivot moves broad→specific: **not computable from artifacts**; structural proxy below.
- Number where implementation path moves upward: **not computable from artifacts**.
- Structural proxy — tasks whose top pivot is a broad class or large snippet (the shape v2 scrutinizes): **7/10**.
- Obvious risky demotions: none introduced — v2 leaves anchored/title/literal/SQL orderings untouched.

## Metadata added

Compact, debug/report-only fields attached to each pivot item (NOT rendered into the prompt):

- `pivot_ranking_version`
- `pivot_rank_score`
- `pivot_rank_signals`
- `pivot_rank_penalties`
- `pivot_rank_reason`

## Risks

- v2 only re-orders pivots in the ambiguous multi-pivot, no-strong-anchor case; anchored/title/literal/SQL cases are untouched, so its blast radius is bounded.
- Better pivot ranking is necessary-but-not-sufficient: the controlled Astropy run already ranked cds.py first yet still failed, so a top-pivot fix alone may not flip outcomes.
- The Astropy comparison uses modeled signal strengths; committed snapshots carry no scorecards, so it is a documented-pattern demonstration, not a live re-derivation.

## Recommended next step

Run one fresh Astropy strict run (and, budget permitting, the strict 10-task set) under pivotRankingVersion=v2 with universal telemetry, then compare top-pivot ordering and resolution against the legacy baseline. Do not claim aggregate improvement before that run.

## Non-claims

- This report does not re-run agents or Docker.
- This report does not use edited files or resolved status as ranking inputs.
- This report does not prove aggregate improvement until fresh agent runs are executed.
- Ranking v2 is not a Capsule budget change.
