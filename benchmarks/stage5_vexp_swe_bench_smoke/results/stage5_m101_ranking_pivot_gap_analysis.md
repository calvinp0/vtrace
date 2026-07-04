# Stage 5 M101 — Ranking / Lead-Pivot Gap Analysis (pre-change audit)

_Deterministic, offline, read-only: rebuilds every scored capsule on the exact
M100 generation path (`buildCapsuleV2`, debug intent, 8000-token budget) and
compares the lead pivot's evidence against the best-placed gold file's evidence.
Gold labels are applied scoring-side only. Data:
`stage5_m101_ranking_pivot_gap_audit.json` (script
`run_stage5_m101_ranking_pivot_gap_audit.ts`). No live agents, no Docker, no API
spend._

## Headline

- 99 scored; `lead_pivot_is_source_gold` = 51/99 (51.5%), `source_gold_in_capsule` = 75/99 (75.8%).
- **Addressable set** (source gold already in the capsule but a non-gold lead): **24 cases** — 17 dev, 7 holdout.
- Of the 24: gold is the **second pivot** in 9 (already required; label "good"), and
  **support-only** in 15 (11 of these are the M100 `wrong_pivot` cases).

## Answers to the required questions

### 1. How many M100 cases are wrong_pivot?

**11** (8 dev: astropy-14369, astropy-7166, django-10880, django-15731,
django-16256, matplotlib-24870, xarray-6599, xarray-6992; 3 holdout:
django-13512, django-15503, sympy-13372). The rebuild reproduces all 11
byte-identically.

### 2. Where is source gold in the wrong_pivot cases?

| location | count |
| --- | --- |
| top 5 (capsule read order) | 11/11 |
| top 10 | 11/11 |
| capsule | 11/11 |
| optional targets (support) | 11/11 |
| required targets | 0/11 (by construction of the label) |

Every wrong_pivot case already **holds** the gold source file — as support.
This is a role/required-target failure, not a recall failure.

### 3. What file type won the lead instead?

**`wrong_source` in 24/24 addressable cases.** Zero test leads, zero
docs/example leads, zero `__init__` facade leads, zero generic-infrastructure
leads, zero generated-file leads. (Facade leads do exist repo-wide —
pytest-6197, sphinx-7910 — but in those cases the gold file is *not in the
capsule at all*: they are recall misses, out of scope for a lead rule.)
Family B (test/docs lead preference) and Family C (facade demotion) therefore
have **zero addressable coverage** and are rejected.

### 4. What evidence made the wrong pivot win?

Lead evidence classes over the 24 addressable cases: symbol-name scorecard
match 12, plain lexical only 9, title-symbol lane 3, literal-anchor lane 4,
strong direct evidence 1, weak-direct boost 3 (overlapping classes). The wrong
leads are legitimately-evidenced source candidates — mostly a *different*
plausible function whose name/lexical profile matched the issue prose slightly
better (`annotation_select` vs `Count`, `has_key` vs `KeyTransform*`,
`false_alarm_probability` vs `InheritDocstrings`).

### 5. What evidence did the gold file have?

Gold-best evidence classes: plain lexical only 10, symbol+weak-direct 6,
**tier-2 anchored (title-symbol / literal-anchor / strong-direct) 5**,
path+strong-direct 1, others 2. The decisive discovery is the **demotion
reason** on the 20 gold-in-support cases:

| gold demotion mechanism | count | of which tier-2 anchored |
| --- | --- | --- |
| pivot-cap eviction (`strong target beyond the pivot budget`, maxPivots=2) | 12 | 3 (astropy-14369, astropy-7166, xarray-6992) |
| dispatcher demotion (`entry point/caller delegating to local helpers`) | 3 | 2 (django-11206 strong-direct, xarray-6599 title+literal) |
| other (support from the base gate) | 5 | 0 |

### 6. Ranking errors versus unavoidable ambiguity?

- **Mechanical coherence errors — 5 cases** (astropy-14369, astropy-7166,
  xarray-6992, xarray-6599, django-11206; all dev): the candidate carries
  tier-2 anchor evidence that `buildCapsuleV2`'s pivot ORDERING treats as
  top-precedence (`evidenceTier` 2, above every plain-lexical pivot), but the
  ROLE layer (`refineDebugRoles`) never sees the anchor id sets — so the same
  candidate the orderer would rank first is cap-evicted by `final` score or
  demoted as a "dispatcher" before ordering ever runs. The issue author *named*
  these symbols/files (`InheritDocstrings` in the title, `polyval` in the
  title, `utils.numberformat.format` as a dotted path, `CDS` as a format
  literal, `_coord_names` as a body literal).
- **Deliberate M96 conservatism — 5 cases** (astropy-14598, django-10880,
  django-15037, matplotlib-24870, sympy-13372): gold entered via the WEAK
  direct-evidence lane (file stem / class word), which is ordered by organic
  final (0 for injections) precisely so a circumstantial mention can never
  steal a slot. Changing that would broaden `directEvidenceAnchoring` —
  explicitly out of scope for M101.
- **Genuine context ambiguity — 14 cases**: 9 twin-pivot cases where gold is
  already pivot#1 with a near-tied score (|final gap| ≤ 0.25 in 7 of 9; four
  are literally same-named functions in two files, e.g.
  `_collect_factor_and_dimension` in `quantities.py` vs `unitsystem.py`,
  `hermite_normal_form` twice), plus 5 support cases with plain-lexical gold
  evidence indistinguishable from the lead's. No gold-blind rule separates
  these without guessing.

### 7. Are tests or docs/examples overweighted as lead?

No. 0/24 addressable leads are tests or docs/examples (the M95 generic-infra
work, the non-source down-rank, and pivotRankingV2's non-impl-path penalty
already hold this line).

### 8. Are facade files overweighted as lead?

No addressable case. The two facade leads in the full set (pytest-6197
`assertion/__init__.py`, sphinx-7910 `autodoc/__init__.py`) are recall misses
(gold absent from capsule) — a facade-demotion lead rule could not fix them.

### 9. Are wrapper/dispatcher files overweighted as lead?

No — the **inverse** failure exists: the dispatcher demotion removes the
*gold* target from the pivot role in 3 cases, 2 of which the issue names
outright (tier-2 anchors). A function the author explicitly names is the edit
target even when it delegates.

### 10. Are generic infrastructure files still winning lead despite M95?

No. 0 addressable leads carry `is_generic_infrastructure`.

### 11. Does weak/support-only evidence ever influence lead when it should be support-only?

No lead is *produced* by a support-only lane: co-edit, file-evidence-rescue and
graph-neighbour entries are support-only by construction (the 56 path-level
"lane touches lead file" matches in the audit JSON are same-file organic pool
candidates, not lane injections). Weak-direct boosts appear on 3 leads, but
ordering uses the pre-boost organic final, so the boost did not decide the
lead. The invariant holds; M101 must add regression tests that keep it held.

### 12. Narrowest rule likely to improve lead source-gold without hurting recall

**Anchored-target guard** — thread the tier-2 anchor id set (title-symbol ∪
literal-anchor ∪ strong direct evidence; explicitly NOT weak-direct, NOT any
support-only lane) into `refineDebugRoles`:

1. **Dispatcher-demotion exemption**: a non-test, actionable candidate whose
   role was pivot is not demoted to support as "entry point/caller" when it is
   tier-2 anchored — the issue names it directly (mirrors the existing
   line-anchor override one confidence notch down).
2. **Bounded pivot-cap exemption**: at standard/full tiers, at most ONE
   tier-2-anchored, non-test, anchor-actionable-kind pivot that the
   `maxPivots` cap would evict keeps the pivot role as an extra slot — and is
   ordered LAST among pivots, so it can become a required target but can
   never steal the lead.

Predicted from the audit: wrong_pivot 11 → 7 (astropy-14369, astropy-7166,
xarray-6992 via the cap exemption; xarray-6599 via the dispatcher exemption),
satisfying the "all-scored wrong_pivot −3" arm of the M101 pass gate; lead
flips on the dispatcher-exempt cases (xarray-6599, django-11206) and possibly
astropy-7166 stay dev-side; holdout is expected flat (all five mechanical
cases are dev — the three holdout wrong_pivots are weak-direct (sympy-13372)
or plain-lexical (django-13512, django-15503) golds, deliberately out of
scope).

## Seam decision

Implement the anchored-target guard (Family A lead-eligibility + Family E
required-target refinement in one coherence fix); reject Families B/C (zero
coverage) and defer Family D (evidence-vector rescoring — the twin-pivot
ambiguity it targets is not separable gold-blind at this budget).
