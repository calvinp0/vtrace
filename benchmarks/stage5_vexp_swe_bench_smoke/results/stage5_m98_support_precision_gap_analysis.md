# Stage 5 M98 Support Precision Gap Analysis (pre-change audit)

_Deterministic, offline: computed from the frozen M96/M97 scoreboard detail rows
(`stage5_m9{6,7}_deterministic_scoreboard.detail.json`) and the M95 dev/holdout
split. No live agents, no Docker, no API spend. Gold labels the analysis only._

## Headline

M97's co-edit lane added 107 support candidates across 69 fired cases; **83
rendered into capsules, of which only 5 are gold** (78 non-gold rendered files
across 57 cases ≈ 1 extra non-gold file per fired case). That single extra file
is the direct cause of the M96→M97 label bleed: mean capsule files 3.63→4.32,
excellent 32→18, overpacked 11→18. Token budgets are untouched (median/p90
flat), so this is a *file-count/selectivity* problem, not a token problem.

## Q1 — Which M97 cases became overpacked relative to M96?

All 26 outcome flips vs M96 are in co-edit-fired cases. 8 flips land on
`overpacked` (all reach exactly 6 files / 1 gold, ratio 6.0 — the
`OVERPACK_MIN_FILES=6` + ratio>3 boundary):

| case | flip | cohort |
| --- | --- | --- |
| django-11820 | good → overpacked | dev |
| matplotlib-22719 | good → overpacked | dev |
| pallets-flask-5014 | good → overpacked | dev |
| sympy-12419 | good → overpacked | holdout |
| sympy-23413 | good → overpacked | holdout |
| sympy-24213 | good → overpacked | holdout |
| django-15037 | wrong_pivot → overpacked | dev |
| django-15503 | wrong_pivot → overpacked | holdout |

M97 overpacked total 18: 14 co-edit-fired + 4 pre-existing (django-11206,
django-11749, django-12325, sympy-24562 — not co-edit-caused; all 18 sit at
exactly 6 files/1 gold).

## Q2 — Which cases lost excellent/good labels to extra non-gold support?

15 excellent→good flips (the +1 non-gold co-edit file pushes a 3-file/1-gold
capsule to 4 files, ratio 4 > the excellent cutoff 3): astropy-14539,
django-10973, django-12774, django-13363, django-15695, django-16877,
psf-requests-1142, pydata-xarray-2905, pydata-xarray-3677, pytest-10051,
pytest-7432, scikit-learn-11578, sphinx-7748, sympy-12481, sympy-18189.
Plus the 6 good→overpacked above. Against that, 3 improvements:
seaborn-3187 overpacked→excellent, xarray-6938 + sphinx-7462 partial→good.

## Q3 — Support-file composition in co-edit-fired cases (69 cases)

Optional (support) files in fired cases: 229 total —

| category | count | gold |
| --- | --- | --- |
| ordinary source | 200 | 17 |
| `__init__.py` package facades | 22 | 0 |
| generic-infra-named (`utils.py`, …) | 6 | 0 |
| docs/examples | 1 | 0 |
| tests | 0 | 0 |

Duplicate-file support symbols (2nd symbol of a file already present) do NOT
inflate `capsule_file_count` — they are counted once at file level — and the
M97 displacement rule already reclaims their slots. **Docs/examples/tests are a
non-problem** (the existing non-source downrank + test exclusion already work).
The bloat is ordinary-source-looking co-edit files plus `__init__` facades.

Of the co-edit candidates themselves (107 = 58 rescued + 49 injected, 6 gold):

- **13 injected `__init__.py` facades, 0 gold** — package re-export surfaces
  reached by import edges (`db/models/functions/__init__.py`,
  `urls/__init__.py`, `db/migrations/operations/__init__.py`, …). They pass
  `isGenericInfraFile` because `init` is not a generic-infra token.
- **20 injections with no call edge** (edge types imports-only,
  references-only, imports+references), **0 gold**. Every gold injection has a
  call edge (sphinx-7462 `edge_calls`, matplotlib-24870 + sphinx-9698
  `edge_calls_references`) or is the generated pair (astropy-14369).
- **23 single-relation-type rescues** (calls-only 15, references-only 8),
  **0 gold**. Both gold rescues (seaborn-3187 `_core/scales.py` 26 edges,
  xarray-6938 `variable.py` 15 edges) have **calls AND references** —
  bidirectional coupling is the actual co-edit signature.
- Same-directory-only (proximity without meaningful affinity) does not exist as
  a standalone bucket — the M97 injection gate already requires affinity or
  stem-share; volume-only neighbours were already rejected (883 ambiguous).

## Q4 — Which mechanism contributes most non-gold files?

| mechanism | candidates | gold | non-gold |
| --- | --- | --- | --- |
| rescue | 58 | 2 | 56 |
| injection (edge) | 47 | 3 | 44 |
| injection (generated pair) | 2 | 1 | 1 |

Rescue is the largest contributor by volume; within injection, the
imports/references-only and `__init__`-facade subsets are pure noise (0/33
gold). The generated-pair non-gold (`cds_lextab.py`) is a genuinely paired
artifact and harmless.

## Q5 — Harmless token-flat support, or crowding out better files?

Mostly *additive on top of already-full capsules*, not crowding: fired-case
file-count delta vs M96 is +1 mean (33 cases +1, 18 cases +2, 18 cases +0),
displacements (82) hit only duplicate-file symbols / generic-infra / docs by
construction, and median/p90 tokens are flat. The damage is therefore purely to
the files-per-gold precision ratio the outcome classifier keys on — i.e. the
capsule points the agent at ~1 extra plausible-but-wrong file per fired case.
No evidence of a better file being evicted (the displacement rule protects
new-file support winners).

## Q6 — Did any M97 recovery depend on a low-confidence rule?

No. Under the confidence partition above, every recovered gold is
high-confidence: generated pair (astropy-14369), call-edge + task-affinity
injection (sphinx-7462 `_parse_annotation`↔"annotation"; matplotlib-24870;
holdout near-miss sphinx-9698), calls+references rescue with dense coupling
(seaborn-3187 26 edges, xarray-6938 15 edges). The low-confidence buckets
(single-relation rescues, no-call-edge injections, `__init__` facades — 56
candidates) contain **zero** gold.

## Q7 — File-level-first support selection?

Not as an overpacking fix. Duplicate-file symbols are already invisible to
`capsule_file_count` and are the cheapest thing in the capsule; selecting
support at file level first would hand their slots to *additional distinct
files*, increasing the file count and worsening the ratio. The co-edit
displacement rule already reclaims duplicate slots when a relation-backed
sibling exists. Finding recorded; no change planned (Family A rejected).

## Q8 — Low-confidence co-edits only into spare support budget?

Yes — this is the right placement for the *medium* band: candidates with a real
relation but weaker corroboration (call-edge injection gated only by stem-share
without task-token affinity; calls+references rescue with sparse coupling)
should render only into genuinely spare support slots and never displace
anything. Simulated on M97 rows (medium ≈ spare-slot-only, approximated by
`displaced_count == 0`), this contributes roughly −0.14 further mean files and
1–2 additional label recoveries on top of the low-confidence drop.

## Q9 — Rank co-edit below strong non-coedit support unless ≥2 relation signals?

Effectively yes, via the confidence tiers: high-confidence (≥2 independent
relation signals — bidirectional edge types, call edge + task affinity, exact
generated pair) keeps M97's displacement rights over duplicate/generic/docs
slots only; medium drops to spare-slot-only (behind every base winner); low is
excluded from selection. Strong non-coedit source support was already protected
by the M97 displacement rule; the tiering closes the remaining gap.

## Q10 — Narrowest change that reduces overpacking without losing the 5 recoveries

**Co-edit confidence tiers (Family B) + facade junk filter (Family D) +
spare-slot-only placement for medium (Family C refinement):**

- **LOW → diagnostics-only, never rendered**: injected `__init__.py` facades;
  injections without a call edge (and not generated pairs); single-relation-type
  rescues. 46/107 candidates, 0 gold.
- **MEDIUM → spare slots only, never displaces**: call-edge injections whose
  affinity gate was stem-share-only; calls+references rescues with
  edge_count < 8 (below both observed gold rescues at 15/26; threshold chosen
  at 4× MIN_RESCUE_EDGES with margin — any value ≤ 15 preserves the gold, so 8
  is not tuned to the boundary).
- **HIGH → unchanged M97 behaviour**: generated pairs; call-edge + task-token
  affinity injections; dense (≥8 edges) calls+references rescues.

Simulated against the M97 detail rows this yields: mean capsule files
4.32 → ~3.83 (M96 3.63), overpacked 18 → ~13, excellent 18 → ~26, with all 6
gold candidates retained (the 5 recovered cases keep `all_gold_in_capsule`;
hidden-coedit recall and multi-file all-gold are untouched at 0.589 / 40 %
because pruning only removes non-gold files). Support caps, token budgets,
pivot selection, and initial retrieval are untouched.
