# Stage 5 M99 Import-Edge Gap Analysis (pre-change audit)

_Deterministic, offline: computed from the frozen M98 scoreboard detail
(`stage5_m98_deterministic_scoreboard.detail.json`), the M95 dev/holdout split,
and an exact file-level import scan of each instance's base-commit workspace
(`run_stage5_m99_import_edge_gap_audit.ts`, artifact
`stage5_m99_import_edge_gap_audit.json`). Gold labels the analysis only; capsule
rebuilds see just the derived task. No live agents, no Docker, no API spend.
Split discipline: per-case file detail below is dev-only; holdout contributes
aggregate counters._

## Headline

Import edges are **structurally absent from the index**, not merely undervalued:
of the 43 (capsule-file, hidden-gold) pairs connected by a real import or
re-export statement at the base commit, **0 have an `imports` edge in the
index** (30 have call/reference edges). Two independent causes:

1. **Single-symbol source constraint** (`getUnambiguousImportSourceSymbol`):
   symbol-level import edges are only emitted when the importing file has
   exactly ONE top-level symbol — there is no module symbol to hang the edge on
   otherwise. In the django-13195 index only **26/854 files** emit any import
   edge, and they are almost all one-symbol `__init__.py` facades (87 edges from
   `db/models/functions/__init__.py` alone). This is why M97/M98 saw
   "imports-only" evidence exclusively on facade noise (0/33 gold) and tiered it
   LOW.
2. **Package-rooted checkouts**: the django workspaces are materialized as the
   `django/` package subtree, so the canonical module namer produces
   `http.response` while the source says `django.http.response` — absolute
   self-imports cannot resolve at all. (Other repos' workspaces are repo-rooted
   and unaffected; their cross-file edges come from relative imports.)

Even if the edges existed, the co-edit lane would still reject the target
cases: `packageProximity` is null across packages
(`db/models/fields` ↔ `contrib/contenttypes`), and import-only relations are
hard-LOW in the M98 tiers.

## Q1 — Which M98 misses are plausibly import-edge failures?

Of 29 scored cases with hidden gold (42 hidden gold files: 20 dev, 22 holdout),
**20/42 hidden files have an exact import/re-export relation to a capsule
file** at the base commit:

| reachability | dev | holdout |
| --- | --- | --- |
| capsule anchor imports the hidden file | 5 | 8 |
| hidden file imports an anchor, hidden file in retrieval pool | 1 | 1 |
| hidden file imports an anchor, hidden file NOT in pool | 2 | 3 |
| no import relation at all | 12 | 10 |

## Q2 — django-13195 and django-16256

- **django-16256** (dev, wrong_pivot): hidden gold
  `contrib/contenttypes/fields.py` imports the capsule anchor
  `db/models/fields/related.py` twice over — directly
  (`from django.db.models.fields.related import ForeignObject, ForeignObjectRel,
  lazy_related_operation`) and through the `db/models/fields/__init__` facade
  re-export chain (`from_name_import` + `init_reexport`). The file is **in the
  retrieval pool** (discarded "beyond standard support budget (max 4)"), has
  import fan-in 1, edge-fan 0, and task affinity. This is the canonical
  import-only hidden co-edit: exact relation, exact evidence, currently
  invisible.
- **django-13195** (dev, partial): hidden gold `contrib/sessions/middleware.py`
  has **no import relation to any capsule file** (its own imports are settings,
  `sessions.backends.base`, `utils.cache`, `utils.http`; nothing imports it —
  fan-in 0, middleware is wired by the `MIDDLEWARE` settings string, and it
  touches `HttpResponse.delete_cookie` only through a call argument, which no
  exact static import analysis can see). **Seam E for this file** — the M98
  recommendation's suspicion is disproved for 13195 and confirmed for 16256.

## Q3 — Are those import edges present in the VTRACE index?

No. 0/43 import-related pairs have an `imports` edge (see Headline). 30/43 have
call/reference edges instead, emitted from function/method symbols via relative
imports.

## Q4 — If present, why did M97/M98 not use them?

Three independent blockers, all confirmed: (a) the edges are absent (Q3);
(b) `packageProximity` returns null across top-level packages, so rescue
admission fails even with edges (16256's candidate is `contrib/…` vs
`db/models/…`); (c) the M98 confidence tiers deliberately classify import-only
evidence LOW ("no call edge behind injection", "single relation type rescue") —
correctly so, given the only import edges it ever saw were facade noise.

## Q5 — If absent, which parser/resolver failed to emit them?

`extractImportEdges` (pythonParser.ts) bails for any file with ≠1 top-level
symbol; symbol-to-symbol `edges` rows cannot represent a file-level import
without a module symbol. Additionally `getCanonicalModuleName` cannot know a
package-rooted checkout's own top-level package name, so
`resolveAbsoluteModulePath` misses every absolute self-import in the django
workspaces. Fixing either INSIDE the index would require a schema change (a
module symbol per file or a file-level edge table) plus reindexing all 100
workspaces, and would perturb graph retrieval, centrality, and hub counts that
M95–M98 were calibrated on.

## Q6 — Relation types observed (hidden-gold pairs and simulation)

`from_name_import` dominates; `init_reexport` (package facade → implementation)
marks the highest-precision subset; `from_module_import` / `module_import`
appear on utility imports (`import matplotlib.cbook`); relative imports appear
inside cohesive packages (requests); wildcard imports are rare and resolved to
the module file only. "Module import followed by attribute use" (13195's
`response.delete_cookie`) is NOT an import relation and stays out of reach —
by design, since resolving it would be guessing.

## Q7 — Import-only hidden co-edits, dev vs holdout

Import-linked hidden gold: dev 8/20 hidden files (7 cases), holdout 12/22 (9
cases). The phenomenon exists in both cohorts at similar rates.

## Q8 — How many anchor-less misses remain anchor-less even with better import edges?

22/42 hidden files (12 dev, 10 holdout) have no import relation at all. A
further 5 (2 dev, 3 holdout) are only reachable in the reverse direction
(hidden file imports an anchor but is absent from the retrieval pool) — finding
them would require a whole-repo import fan-in scan per capsule, which is not a
reasonable product query. **Effectively 27/42 stay out of reach; the honest
addressable set is 15 files, and only after precision gates a much smaller
subset survives (Q9/Q12).**

## Q9 — Which import relations are precise enough for co-edit expansion?

Gate sweep over simulated candidates (rescue = pooled file with an import
relation to an anchor; injection = anchor imports a non-pooled file):

| gate | dev gold/cand | holdout gold/cand |
| --- | --- | --- |
| ungated | 6/746 | 8/750 |
| task affinity | 2/89 | 1/52 |
| rescue-shape, any | 2/123 | 5/109 |
| rescue + pair call/ref edges + fan-in≤10 | 1/52 | 2/38 |
| rescue + `init_reexport` | 1/19 | 1/22 |
| rescue + `init_reexport` + fan-in≤10 | 1/9 | 1/9 |
| rescue + `init_reexport` + affinity + fan-in≤10 | 1/7 | 0/2 |

Only ONE slice is compatible with the M98 precision regime: **pooled rescue via
an exact package-`__init__` re-export relation, with task affinity and low
fan**. Everything broader re-creates the M97 overpacking problem (the M98 audit
measured ~1 rendered non-gold file per fired case as the direct cause of
excellent 32→18).

## Q10 — Which import relations are too broad or hub-like?

- **Injection-shape (anchor imports candidate)**: 0 gold in every gated slice
  (0/63 with `init_reexport`, 0/43 with affinity+fan-in≤10). An anchor's import
  list is its dependency surface, not its co-edit set. Rejected outright.
- Plain `from_name_import` without facade/affinity corroboration: 65/67
  non-gold under the affinity gate.
- High fan-in modules: `matplotlib/pyplot.py` (fan-in 622), `sympy` core files
  (fan-in 519, 90, 57) — classic import hubs; several are gold in *ungated*
  sims but only alongside dozens of identical-looking non-gold hubs.
- Wildcard imports: module-file resolution only; never name-expanded.

## Q11 — Fan-in/fan-out thresholds for hub protection

Whole-repo import fan-in (audit-only) ≤10 keeps both surviving golds and drops
the hub tail. In product, whole-repo fan-in is not cheaply computable; the
existing edge-based `countCrossFileNeighborFiles ≤ MAX_NEIGHBOR_GLOBAL_FANIN`
(25) plus the facade/affinity gates reproduces the same admissions on this
population (both golds sit at edge-fan 0/25; the hub noise sits at 30–119).
Additionally, render-impact simulation shows one holdout candidate
(django-15503, 5-file capsule) would flip wrong_pivot→overpacked if rendered —
so import-relation candidates must also be barred from capsules that already
hold ≥5 distinct base files (weakest evidence tier gets the strictest bloat
guard; gold-blind rule).

## Q12 — Smallest change that recovers import-only co-edits without overpacking

**Seam decision: C (co-edit evidence/scoring), fed by a new exact file-level
import relation computed at capsule-build time — explicitly NOT a parser/index
schema change (seam A), which the audit shows would be invasive (schema +
100-workspace reindex + uncontrolled perturbation of graph scoring that
M95–M98 calibrations sit on).** Seam A is the true root CAUSE, but its
index-side fix is not the smallest safe intervention; the relation itself can
be derived exactly and deterministically from the same base-commit tree the
index was built from (`src/parsers/pythonFileImports.ts`: top-level statement
scan, alias-aware resolution over the indexed file list, relative imports,
`__init__` re-export following, root-package inference for package-rooted
checkouts, wildcards never expanded).

The single behavioral change this audit licenses:

- **Import-re-export rescue (new, HIGH)**: a pooled, credible-source support
  candidate that imports a capsule anchor through an exact package-`__init__`
  re-export chain (`init_reexport`), with task affinity, edge-fan ≤25, not
  itself an `__init__`/generic/docs/test file, only into capsules with ≤4
  distinct base files, capped at 1 per capsule and only in co-edit selection
  capacity M98 left unused. Predicted effect (render simulation over frozen M98
  rows): recovers django-16256 (`contrib/contenttypes/fields.py`, all-gold flip,
  dev); adds ≤3 non-gold support files in dev (12774, 12858, 3677 — one
  excellent→good flip in 12858, no overpack flips); **zero holdout renders**
  (both holdout candidates blocked by the no-slot/file-cap guards), so holdout
  stays byte-identical.
- Everything else becomes **diagnostics only**: per-case import-relation
  considered/kept/pruned/hub-rejected counters and per-candidate import
  evidence in the scoreboard detail.

Explicitly rejected on this data: any injection-shaped import lane (0 gold),
proximity-gate loosening, support-cap increases, treating an import relation as
a second "relation type" to upgrade M98-pruned single-type rescues (the M98
audit already showed that slice is 0/23 gold, and upgrades would move
unmeasured spare-slot renders in holdout).

## Pool fate of hidden gold (context)

dev: absent_from_pool 16, in_pool_not_capsule 2, not_in_index 2; holdout:
absent_from_pool 15, in_pool_not_capsule 7. Candidate recall (files never
retrieved at all) remains the dominant bottleneck after import evidence —
import edges are a real but SECOND-order gap.
