# Stage 5 M97 — Hidden Co-edit Gap Analysis (pre-change)

_Deterministic, offline. Driven by the frozen M96 scoreboard
(`stage5_m96_deterministic_scoreboard.*`) plus a per-case relation probe
(`run_stage5_m97_hidden_coedit_gap_audit.ts` →
`stage5_m97_hidden_coedit_gap_audit.json`). For every scored multi-file case the
probe splits gold into FOUND (in the M96 capsule) and HIDDEN (missing), then
classifies the index relation connecting each (found, hidden) pair and the
hidden file's candidate-pool fate on a capsule rebuild. Gold labels the output
only — generation sees just the derived task. No live agents, no Docker, no API
spend._

_Split discipline: per-case file detail below covers **dev** cases only; holdout
contributes the aggregate relation-class counters the milestone requires._

## Q1. How many M96 scored cases are multi-file gold patches?

**15 of 99** (12 dev / 3 holdout). Single-file: 84.

## Q2. What is M96 all-gold-in-capsule for multi-file cases?

**6.7 % (1/15)** — only pydata-6992 carries every gold file. Single-file
all-gold is 76.2 %, so multi-file collapse is the dominant all-gold gap.

## Q3. What is M96 hidden_coedit_recall on dev and holdout?

Dev **0.319**, holdout **0.000** (3 holdout multi-file cases, all at 0).

## Q4. In multi-file failures, is at least one source gold file already found?

Dev: **10 of 12** multi-file cases already carry ≥1 source gold in the capsule
(the exceptions are pylint-4551 and pylint-8898, full misses with no anchor).
Holdout: **1 of 3** (the other two are full misses). So the co-edit shape —
"one strong edit site found, the sibling hidden" — describes most dev
multi-file failures but only one holdout case.

## Q5. What relation connects the found gold to the hidden gold?

Relation classes over hidden gold files that have ≥1 found anchor
(a hidden file can carry several relations):

| relation | dev | holdout |
| --- | --- | --- |
| same_directory | 4 | 0 |
| parent_child_directory | 4 | 0 |
| sibling_package | 1 | 0 |
| edge_calls (cross-file call edges) | 3 | 0 |
| edge_references | 2 | 0 |
| generated_artifact_pair (`cds.py` ↔ `cds_parsetab.py`) | 1 | 0 |
| no_obvious_relation | 2 | 1 |

Notable per-case (dev): xarray-6938 `variable.py` (same dir + **39** edges to
found `dataset.py`), matplotlib-24870 `tri/_tricontour.py` (parent/child + 3
edges to `contour.py`, connecting symbols `_contour_args` /
`_process_contour_level_args`), sphinx-7462 `pycode/ast.py` (sibling package +
1 call edge, connecting symbol `_parse_annotation` whose word "annotation" is
in the task), seaborn-3187 `_core/scales.py` (26 edges to pivot
`_core/properties.py`), astropy-14369 `cds_parsetab.py` (exact generated-table
pair of in-capsule `units/format/cds.py`). The no-relation cases (django-13195
`sessions/middleware.py`, django-16256 `contrib/contenttypes/fields.py`) are
connected only by Python imports, which this index barely captures (82 import
edges vs 8 190 call edges in the xarray index) — no deterministic relation
signal exists for them today. The single anchored holdout hidden file also
shows **no_obvious_relation**, so the holdout headline is unlikely to move.

## Q6. Are hidden co-edits implementation siblings, public API files, tests, docs, or helpers?

Overwhelmingly **implementation siblings** (`variable.py`, `scales.py`,
`expressions.py`, `ast.py`, `_tricontour.py`, `base.py`, `where.py`), plus one
**generated artifact** (`cds_parsetab.py`) and one cross-package middleware.
Zero tests, zero docs (the scored gold set is source-side). Hub degree matters:
9/18 dev hidden files (and 7/9 holdout) contain a symbol with in-degree ≥ 5 —
exactly the hub bar that makes the existing graph-neighbour lane reject them
(`graph_neighbor_saw_it` is false for **every** hidden file). 3 dev hidden
files are generic-infra-named (`base.py`, `utils.py` twice).

## Q7. Which relation types are precise enough to use without overpacking?

1. **Cross-file call/reference edges to a found anchor, gated by name
   affinity**: every dev hidden file reachable this way connects through
   symbols whose word tokens either appear in the task
   (`_parse_annotation` → "annotation") or share the anchor's file stem
   (`_tricontour` ↔ `contour`). Edge count + affinity gate keeps this to a
   couple of files per anchor.
2. **Generated-artifact pair**: exact stem pairing (`x.py` ↔ `x_parsetab.py`),
   zero ambiguity; the actionability-hint detector already computes it.
3. **In-pool rescue**: 3 dev hidden gold files (`variable.py`, `scales.py`,
   `contenttypes/fields.py`) were ALREADY retrieved and then discarded
   "beyond standard support budget (max 4)". For two of them the budget was
   consumed by *additional symbols of files already in the capsule* — a
   relation-backed, file-diversity-aware support preference recovers them
   without any new candidate generation.

## Q8. Which relation types are too broad/dangerous?

- **Bare same-directory / parent-child expansion without edges** — `db/models/`
  holds ~30 files; picking `expressions.py`/`query_utils.py` out of it with no
  edge or affinity signal is directory flooding (the M95 lesson).
- **High-degree anchors expanded by edge count alone** — `_axes.py` or
  `dataset.py` touch hundreds of files; raw edge count ranks generic
  dependencies (`cm.py`: 8 edges) above the gold sibling (`_tricontour.py`: 3).
  Injection must be affinity/stem-gated, with a per-anchor fan-out reject.
- **Generic-named siblings without independent evidence** — `base.py`
  (django-12325) is generic-infra-named, hub-degree 10, connected only by
  same-directory. Deliberately left out.
- **Import-only relations** — invisible to this index (see Q5); attempting to
  recover them from path heuristics would recreate the M95 `likelyFiles`
  regression.

## Q9. Did M96 support-budget displacement cause any losses that M97 must avoid?

Yes, two shapes:

1. Hidden gold squeezed out: `variable.py` / `scales.py` /
   `contenttypes/fields.py` discarded "beyond standard support budget (max 4)"
   while support slots went to lower-value items (extra symbols of
   already-present files, or `_marks/base.py`-style generic siblings).
2. FOUND gold's additional symbols also flood the discard list (django-13195
   discards `http/response.py` symbols 18×) — meaning support slots are often
   spent on file-duplicate symbols. **M97 must never displace a support item
   that introduces a genuinely new non-generic file** (it may carry gold);
   displacement is safe only against duplicate-file items and generic-infra
   tier items.

## Q10. Narrowest co-edit expansion that can help holdout without increasing p90 tokens?

A bounded **co-edit support lane** with two mechanisms, active only when the
capsule already has a credible source anchor (lead pivot is source, non-test,
non-generic):

- **Rescue** (no new tokens beyond a signature swap): mark ≤2 already-retrieved
  support candidates whose file is new to the capsule and relation-backed
  (≥1 cross-file edge to an anchor file AND same/parent/sibling package) so
  they outrank duplicate-file and generic-infra support items — never
  new-file, non-generic support.
- **Injection** (≤2 files total incl. rescues, ≤1 symbol per file, signatures
  only, combined ≤20 % of budget): edge-connected package-scoped neighbours of
  an anchor gated by task-token affinity on the connecting symbol names or
  anchor-stem sharing, plus the exact generated-artifact pair; per-anchor
  fan-out reject for hub anchors.

Dev cases this predicts recovering: xarray-6938 + seaborn-3187 (rescue),
matplotlib-24870 + sphinx-7462 (edge+affinity injection), astropy-14369
(generated pair) — multi-file all-gold 1/15 → ~6/15 on dev. Honest holdout
expectation: the aggregate relation audit shows the one anchored holdout hidden
file has **no deterministic relation**, so the holdout hidden-coedit headline
is expected to stay flat; the lane is justified as a general mechanism measured
for safety (no regression) on holdout rather than as a holdout win.
