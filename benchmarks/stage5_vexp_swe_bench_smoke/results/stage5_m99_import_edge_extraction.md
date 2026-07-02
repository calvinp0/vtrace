# Stage 5 M99 Import-Edge Extraction and Import Co-edit Recall

_Deterministic, offline: no live agents, no Docker, no API spend, no Conda
mutation, no gold in generation. Baseline = frozen M98 scoreboard; dev/holdout
split = M95. Pre-change audit: `stage5_m99_import_edge_gap_analysis.md` +
`stage5_m99_import_edge_gap_audit.json`._

## Summary

- **Seam decision**: root cause is **A** (import edges are structurally absent
  from the index: 0/43 import-related hidden-gold pairs have an `imports` edge;
  only single-top-level-symbol files can carry one, and package-rooted django
  workspaces additionally cannot resolve their own absolute imports), but the
  chosen fix seam is **C** — co-edit evidence/scoring fed by a new exact
  build-time file-level import relation (`src/parsers/pythonFileImports.ts`),
  with the index, schema, and all retrieval scoring untouched.
- **Change made**: one narrow mechanism, the **import-re-export rescue**: a
  pooled, credible-source support candidate that imports a capsule anchor
  through an exact package-`__init__` re-export chain, with task affinity,
  edge-fan hub bound (≤25), never itself a facade/generic/docs/test file, only
  into capsules with ≤4 distinct base files, HIGH tier (displaces only
  duplicate/generic/docs slots), capped at 1 per capsule, and only in co-edit
  selection capacity M97/M98 left unused. Everything wider (any
  injection-shaped import lane, plain name-import rescues, proximity-gate
  loosening) was measured as pure noise in the audit and is rejected —
  recorded as diagnostics only.
- **Why**: the audit's gate sweep shows imports are weak evidence in general
  (ungated: 6/746 dev gold) with exactly one precision-compatible slice
  (rescue + `init_reexport` + affinity + low fan). django-16256 is the
  canonical instance; django-13195 is disproved as an import case (no static
  import relation exists — seam E for that file).
- **M98 baseline → M99 result (all scored, n=99)**: all-gold-in-capsule
  **70.7% → 71.7%**, recall@5 **0.721 → 0.726**, mean capsule files
  **3.919 → 3.929** (+0.010), every outcome label unchanged
  (excellent 26, overpacked 14, …), median/p90 tokens unchanged, holdout
  **byte-identical on every metric**. Multi-file all-gold **40.0% → 46.7%**
  (n=15). The only behavioral delta in the whole run is django-16256 gaining
  `contrib/contenttypes/fields.py`.
- **Verdict**: **MIXED** (lean positive) — a real import-linked recovery with
  zero measured cost, but the recall gain is dev-only; holdout is deliberately
  untouched (its two qualifying candidates were correctly blocked as noise by
  the no-slot/file-cap guards). All 14 numbered success criteria hold.
- **Recommendation**: proceed to **candidate recall improvement** — the audit
  shows 31/42 remaining hidden gold files are absent from the retrieval pool
  entirely, which no relation evidence can fix.

## Import-Edge Gap Analysis

(Full pre-change audit: `stage5_m99_import_edge_gap_analysis.md`.)

- **Import-only suspected cases**: 20/42 hidden gold files (dev 8, holdout 12)
  have an exact import/re-export relation to a capsule file at base commit;
  22 have none; 5 of the 20 are only reachable via whole-repo reverse fan-in
  (not a reasonable product query).
- **django-16256**: hidden gold `contrib/contenttypes/fields.py` imports the
  capsule anchor `db/models/fields/related.py` directly AND through the
  `db/models/fields/__init__` facade (`from_name_import` + `init_reexport`),
  sits in the pool (discarded "beyond standard support budget"), fan-in 1 —
  edges missing from the index, relation undervalued by design (proximity null
  across packages, imports tiered LOW). **django-13195**: hidden gold
  `contrib/sessions/middleware.py` has NO import relation to any capsule file
  (dynamic `response.delete_cookie` call through an argument; wired by the
  `MIDDLEWARE` settings string) — not an import-edge failure.
- **Missing vs unused vs undervalued**: missing at the index level (0/43 pairs
  have `imports` edges; two parser-side causes), and — even if present —
  unused/undervalued in the co-edit lane (proximity gate + LOW import tier).
- **Relation types observed**: `from_name_import` dominates;
  `init_reexport` marks the precision subset; module/wildcard imports and
  high-fan-in hubs (pyplot fan-in 622) are noise.
- **Hub/ambiguity analysis**: injection-shaped import candidates are 0-gold in
  every gated slice; audit fan-in ≤10 ≈ product edge-fan ≤25 on this
  population; capsules already at ≥5 base files flip straight to overpacked if
  they take an import candidate (django-15503).
- **Chosen intervention**: the single surviving slice as a HIGH-tier pool
  rescue + full diagnostics; no parser/index change (schema + 100-workspace
  reindex + uncontrolled perturbation of graph scoring rejected as not the
  smallest safe change).

## Implementation

- **Files changed**:
  - `src/parsers/pythonFileImports.ts` (new) — exact top-level import
    statement scanner + module resolver over the indexed file list: relative
    imports, `from pkg import submodule`, alias-aware package-`__init__`
    re-export following (depth-limited, cycle-guarded), root-package inference
    for package-rooted checkouts (only when the full dotted name cannot
    resolve), wildcards resolve to the module file only. Conservative: an
    import that does not resolve to exactly one known file yields no relation.
  - `src/parsers/pythonFileImports.test.ts` (new) — 18 tests.
  - `src/capsuleV2/coeditExpansion.ts` — import-re-export rescue after the
    (byte-identical) M97/M98 competition; new constants
    `IMPORT_REEXPORT_RESCUE_MAX_PER_CAPSULE = 1`,
    `IMPORT_RESCUE_MAX_BASE_FILES = 4`; instrumentation counters; lane
    disabled when `repoRoot` is absent.
  - `src/capsuleV2/buildCapsuleV2.ts` — passes `repoRoot`; emits
    `coedit_import_considered/hub_rejected/ambiguous_rejected` diagnostics.
  - `src/capsuleV2/types.ts` — diagnostic fields + `import_kinds` on co-edit
    candidate diagnostics.
  - `src/capsuleV2/coeditExpansion.test.ts` — 8 new lane tests.
  - `benchmarks/…/run_stage5_m99_import_edge_gap_audit.ts` (new, audit),
    `benchmarks/…/run_stage5_m99_deterministic_scoreboard.ts` (new, eval).
- **Import relation tiering**: `init_reexport` + affinity + fan gates → HIGH
  (duplicate/generic/docs displacement only, never spare-jumping, never lead);
  everything else → rejected with reason (`import_ambiguous_rejected` /
  `import_hub_rejected`), diagnostics only.
- **Caps/hub rejection**: 1 per capsule, inside `MAX_COEDIT_FILES` leftover
  capacity, `countCrossFileNeighborFiles ≤ 25`, candidate must not be
  `__init__`/generic-infra/vendored/test/docs, capsule must hold ≤4 distinct
  base files, co-edit token ceiling unchanged.
- **Why it is general**: gates reference only relation shape, task tokens, fan
  degree, and capsule size — no instance ids, repos, paths, or dataset
  constants; the scanner is ordinary Python import semantics.
- **Why it is not gold leakage**: generation sees only the derived task + the
  base-commit tree the index was built from; gold labels scoring only (the
  scoreboard's `assertNoGoldLeakage` still guards the task text).
- **Tests added/updated**: scanner (18: statement forms, docstring safety,
  module naming, re-export chains, root-package inference + its non-firing
  cases, ambiguity, wildcards, determinism, fan-out); lane (8: 16256-shape
  admission, disabled-without-repoRoot, plain-import rejection, wildcard
  never reaches the anchor, affinity rejection, capsule-size guard, hub
  rejection, determinism + per-capsule cap + support-role/lead-safety
  assertions).

## Deterministic Scoreboard Delta (M98 → M99)

| cohort | metric | M98 | M99 | Δ |
| --- | --- | --- | --- | --- |
| all (99) | recall@5 | 0.721 | 0.726 | +0.005 |
| all | all_gold_in_capsule | 70.7% | 71.7% | +1.0pt |
| all | any_gold / r@1 / lead=src-gold / hidden | — | — | unchanged |
| all | mean capsule files | 3.919 | 3.929 | +0.010 |
| all | median / p90 tokens | 1152 / 3536 | 1152 / 3536 | 0 |
| all | outcomes | exc 26, over 14, … | identical | 0 flips |
| dev (60) | all_gold_in_capsule | 78.3% | 80.0% | +1.7pts |
| holdout (39) | ALL metrics | — | — | **byte-identical** |
| multi-file (15) | all_gold_in_capsule | 40.0% | 46.7% | +6.7pts |
| multi-file | hidden_coedit_recall | 0.589 | 0.589 | 0 |
| import-only suspected (16) | all_gold_in_capsule | 0.0% | 6.25% | +6.25pts |
| anchor-less (13) | ALL metrics | — | — | unchanged |
| by repo | django r@5 | +0.017 | — | only mover |

All-gold flips vs M98: django-16256 **gained** (dev); none lost. Outcome-label
flips: none (16256 stays `wrong_pivot` — its lead pivot is still non-gold,
a ranking problem outside M99 scope; the all-gold/multi-file metrics move).

## Import Relation Analysis

- Considered 51 pooled candidates with an import relation to an anchor
  (dev 33, holdout 18); **kept 1 — gold** (`import_reexport_rescue`,
  kinds `from_name_import`+`init_reexport`); pruned 0; hub-rejected 0;
  ambiguous-rejected 50 (facade/affinity/size gates).
- Gold hits: 1/1 kept (django-16256). Non-gold kept: 0 — the lane shipped
  **zero** noise files, versus the audit's predicted ≤3; the lane's stricter
  anchor set (credible co-edit anchors, not all capsule files) filtered the
  remaining borderline candidates.
- Precision/bloat behavior: +1 rendered file across 99 capsules (+0.010 mean
  files); overpacked count unchanged (14); excellent unchanged (26); no
  displacement of any protected support winner (it reclaimed a duplicate-file
  slot in 16256… net +1 distinct file, ratio 4→2.5 for that case).

## Capsule/Token Impact

- median est tokens 1152 → 1152; p90 3536 → 3536 (all); holdout 1484/6325
  unchanged.
- mean capsule file count 3.919 → 3.929; median unchanged.
- overpacking labels: identical distribution; median overpacking ratio
  unchanged.
- required/optional targets: mean required unchanged; mean optional +0.010
  (the one rescue is support/optional by construction).

## Retrieval Eval Compatibility

Both fixtures re-run pre-change (M99 source diff stashed) and post-change in
the same tree: **byte-identical CSVs** —
`stage5_m99_retrieval_eval_expanded` (20/20, top-1 80.0%, top-3 100.0%, pivot
95.0%) and `stage5_m99_retrieval_eval_cross_repo_30` (30/30, top-1 66.7%,
top-3 80.0%, pivot 73.3%). Note: the committed
`stage5_retrieval_eval_expanded.csv` baseline predates M95–M98 capsule changes
(stale since `aa62cc4`), so the byte-diff-vs-committed proof from CLAUDE.md is
not meaningful against it; the pre/post A/B above is the valid no-change
proof. No regression: identical bytes.

## Remaining Failure Modes

- Top misses are unchanged except 16256's capsule content (see
  `stage5_m99_deterministic_top_misses.csv`).
- **Import-edge extraction is no longer the bottleneck**: of 41 remaining
  hidden gold files, 22 have no import relation at all, 5 are reverse-only
  (product-infeasible), and the rest fail pool membership, not evidence.
- **The dominant bottleneck is candidate recall**: 31/42 hidden gold files
  were absent from the retrieval pool on rebuild (`absent_from_pool`), which
  no relation-evidence lane can recover. Second: lead-pivot ranking
  (16256-style wrong_pivot cases where the gold is now in-capsule but not
  lead).

## Success Criteria Check

1. ≥1 import-only co-edit improves — **PASS** (django-16256 all-gold gained).
2. Holdout recall@1 drop ≤2pts — **PASS** (0.436 → 0.436, byte-identical).
3. Holdout lead_pivot_is_source_gold drop ≤2pts — **PASS** (unchanged).
4. Holdout any_gold_in_capsule does not drop — **PASS** (unchanged).
5. Multi-file all_gold ≥40.0% — **PASS** (46.7%).
6. hidden_coedit_recall ≥0.589 — **PASS** (0.589, unchanged).
7. Mean capsule_file_count increase ≤0.1 — **PASS** (+0.010).
8. Overpacked count does not increase — **PASS** (14 → 14).
9. Retrieval evals do not regress — **PASS** (byte-identical pre/post).
10. No broad/hub import expansion — **PASS** (injection-shaped lane rejected
    by design; 0 hub admissions; 50/51 candidates rejected).
11. No lead-pivot theft — **PASS** (support-only rescue; lead metrics
    unchanged everywhere).
12. No gold leakage — **PASS** (generation gold-blind; leakage assert active).
13. Tests/typechecks — **PASS** (3479 tests, 0 fail; `tsc` + benchmarks tsc
    clean; `git diff --check` clean).
14. No live agents/Docker/API spend — **PASS** (none).

## Verdict

**MIXED** — every numbered criterion passes and the recovery is real,
surgical, and cost-free, but the recall gain lands in dev only ("dev improves
but holdout is flat" is this milestone's MIXED definition; holdout being
byte-identical is by design — its qualifying candidates were noise the guards
correctly blocked).

## Recommendation

**Proceed to candidate recall improvement.** The audit is unambiguous:
31/42 remaining hidden gold files never enter the retrieval pool, and 22/42
have no import relation at all — pool recall, not relation evidence, parser
coverage, or ranking, is the binding constraint. A follow-up import/re-export
refinement (e.g. reverse-direction fan-in queries) is explicitly NOT
recommended: it requires whole-repo scans for a slice the audit measured at
2/38 gold.
