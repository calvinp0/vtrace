# Stage 5 M61B M60 Budget Replay

## Summary

- **selected cases replayed:** 15 / 15 (every M60-preregistered task; all had a persisted index)
- **valid cases:** 14
- **fail-closed omitted cases:** 1 (`pylint-dev__pylint-8898`)
- **invalid partial sentinel cases:** 0
- **over-budget cases:** 1 (`pylint-dev__pylint-8898`, digest+contract = 12,803 > 12,000, over by **803**)
- **near-budget cases (≥ 10,800):** 0 (next-largest after pylint is `astropy-14598` at **7,875** — a 4,928-char gap)
- **headline recommendation:** **A. Proceed to M60C live repeat**, accepting `pylint-8898`
  as the single known fail-closed outlier (invalid by design at the 12k budget). The M61
  atomic fix holds across the whole breadth set: the digest survives in all 15, the
  contract in 14, and there is **not one partial/dangling sentinel** anywhere. pylint's
  overflow is a genuine content-budget overrun (its verbatim issue-description header alone
  is ~8k chars), not a truncation-ordering bug, and it is the sole outlier — so a global
  compaction is not warranted to unblock M60C. A cheap, optional pylint-only digest-header
  cap (overshoot is only 803 chars) can recover it later without blocking the breadth run.

## Fixture Validation

- **fixture path:** `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m60_structured_bounded_breadth_preregistration.json`
- **task count:** 15 ✓ (matches `target_count`/`selected_count`)
- **repos (11):** sphinx-doc/sphinx, django/django, matplotlib/matplotlib, mwaskom/seaborn,
  pydata/xarray, astropy/astropy, pylint-dev/pylint, pallets/flask, psf/requests,
  sympy/sympy, pytest-dev/pytest ✓
- **category counts:** A=4, B=3, D=3, E=3, C=2 ✓
- **locked sentinels present?** yes — `sphinx-doc__sphinx-7462`, `django__django-11820`,
  `django__django-13195` all present and flagged `locked_sentinel: true` ✓

Fixture is consistent with the M61B contract; replay proceeded.

## Replay Method

- **helper/script used:** `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m61b_budget_replay.ts`
  (new, report-only driver). It reuses the exported Stage 5 functions
  (`buildCapsuleV2Task`, `buildVtraceQueryCommand`, `classifyCapsuleOutput`,
  `buildStage5DigestEnrichmentsBestEffort`, `STAGE5_ATOMIC_SENTINEL_BLOCKS`) and the same
  `truncateContextByPriority` + `parseDigestDecisionContract` path the M61 single-case
  pre-flight (`run_stage5_m60_preflight.ts`) uses — extended to loop the full M60 set and
  emit the M61B size accounting. No production retrieval/scoring/ranking code was changed.
- **persisted indexes used?** yes — the persisted M60 workspaces under
  `results/workspaces/m60_structured_bounded_<safe>/<instance_id>/.vtrace/index.sqlite`.
  All 15 had a usable index (no rebuild, no clone).
- **live agents ran?** no.
- **Docker / patch evaluation ran?** no.

For each case the driver runs the local `vtrace query` capsule CLI against the persisted
index, builds the EXACT M60 structured-bounded treatment context
(`--inject-capsule-digest --digest-decision-contract --bounded-digest-decisions
--compact-digest-injection`), applies the harness's 12,000-char
`truncateContextByPriority` step **with the M61 atomic sentinel blocks**, then validates the
four sentinels + structured grammar + impact on the **post-truncation** context (what the
agent would actually receive).

## Results Table

| instance_id | repo | category | status | digest_chars | contract_chars | digest+contract | budget | over_by | required_targets | impact_reps | omission_marker | partial_sentinel |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| django__django-11820 | django/django | A | VALID | 2457 | 2525 | 4982 | 12000 | 0 | 3 | 3 | no | no |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | A | VALID | 2272 | 2567 | 4839 | 12000 | 0 | 3 | 3 | no | no |
| mwaskom__seaborn-3187 | mwaskom/seaborn | A | VALID | 3659 | 2275 | 5934 | 12000 | 0 | 2 | 3 | no | no |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | A | VALID | 3882 | 2553 | 6435 | 12000 | 0 | 3 | 3 | no | no |
| astropy__astropy-14539 | astropy/astropy | B | VALID | 4458 | 2931 | 7389 | 12000 | 0 | 4 | 3 | no | no |
| pydata__xarray-3677 | pydata/xarray | B | VALID | 3506 | 2913 | 6419 | 12000 | 0 | 4 | 3 | no | no |
| pylint-dev__pylint-8898 | pylint-dev/pylint | B | **FAIL_CLOSED_OMITTED** | 9937 | 2866 | **12803** | 12000 | **803** | 4 | 3 | **yes** | no |
| astropy__astropy-14598 | astropy/astropy | D | VALID | 5602 | 2273 | 7875 | 12000 | 0 | 2 | 3 | no | no |
| django__django-13195 | django/django | D | VALID | 4878 | 2547 | 7425 | 12000 | 0 | 3 | 3 | no | no |
| pallets__flask-5014 | pallets/flask | D | VALID | 2169 | 2829 | 4998 | 12000 | 0 | 4 | 3 | no | no |
| django__django-10880 | django/django | E | VALID | 2399 | 2855 | 5254 | 12000 | 0 | 4 | 3 | no | no |
| psf__requests-5414 | psf/requests | E | VALID | 3296 | 2262 | 5558 | 12000 | 0 | 2 | 3 | no | no |
| sympy__sympy-16766 | sympy/sympy | E | VALID | 2542 | 2831 | 5373 | 12000 | 0 | 4 | 3 | no | no |
| astropy__astropy-14365 | astropy/astropy | C | VALID | 4703 | 2517 | 7220 | 12000 | 0 | 3 | 3 | no | no |
| pytest-dev__pytest-7432 | pytest-dev/pytest | C | VALID | 2858 | 2517 | 5375 | 12000 | 0 | 3 | 3 | no | no |

Cross-cutting facts (all 15 cases): every raw context exceeds the budget (range
**12,048 – 30,772** chars) so truncation is active for **all** cases; `post_digest_ok` =
true for **all 15**; `post_contract_ok` = true for **14** (only pylint omitted);
`required_target_count` ∈ [2, 4] (always > 0 and ≤ 4); impact section present and
non-warning in all 15; compact mode applied in all 15; `optional_context_target_count` = 0
in all 15 (compact mode drops the inspect-first optional-context list, as expected).

Truncation-mode distribution: `atomic_legacy_slice` ×11, `atomic_section_priority` ×3
(`django-10880`, `sympy-16766`, `pytest-7432`), `atomic_omitted` ×1 (`pylint-8898`). In
every non-pylint mode the digest **and** contract atomic blocks were preserved whole.

## Over-budget / Near-budget Analysis

There are **no near-budget cases** (none reaches the 10,800 threshold; the largest valid
combined size is 7,875). Only one over-budget case:

### pylint-dev__pylint-8898 — FAIL_CLOSED_OMITTED (over by 803)

Approximate component breakdown of the untruncated treatment build:

| component | chars |
|---|---:|
| digest: header / query / issue-description | **8,036** |
| digest: pivot lines (2 pivots) | 360 |
| digest: support/skeleton lines (4) | 866 |
| digest: impact section (3 reps) | 544 |
| digest: budget/warnings | 132 |
| contract: decision instructions + reason rules | 1,057 |
| contract: required-target table (4 targets) | 1,302 |
| contract: anti-over-edit rules | 508 |
| **digest total** | **9,937** |
| **contract total** | **2,866** |
| **combined** | **12,803** |

- **likely size driver:** the digest **header** (8,036 chars) — i.e. the verbatim
  issue title + description + hints echoed into the digest. The retrieval enrichment that
  M56–M59 actually contributes (pivots 360 + support 866 + impact 544 = ~1.8k) is *small*;
  the bloat is the raw issue text, not the structured contract or the ranked targets. The
  contract block (2,866) is in the same band as every other case (2,262–2,931).
- **proposed compaction lever:** cap / summarise the verbatim issue-description text carried
  in the digest header (e.g. a per-section char budget for the echoed issue body). The
  overshoot is only **803 chars**, so a modest header cap recovers pylint without touching
  pivots, support, impact, or the decision contract. This is a digest-header concern, not a
  contract concern — contract compaction would not help here.
- **failure behavior today:** correct and explicit. `truncationMode = atomic_omitted`,
  `atomicBlocksPreserved = ["capsule_v2_digest"]`,
  `atomicBlocksOmitted = ["digest_decision_contract"]`, the explicit
  `VTRACE_STRUCTURED_CONTRACT_OMITTED_DUE_TO_BUDGET (digest_decision_contract)` marker is
  present, and there is **no partial sentinel**. The M60B silent-corruption mode is gone.

## Sentinel Integrity

- **digest START/END mismatches:** none — all 15 cases have exactly one digest START and
  one digest END post-truncation.
- **contract START/END mismatches:** none — 14 cases have exactly one contract START and
  one contract END; pylint-8898 has **zero of each** (cleanly omitted, not split).
- **partial sentinel failures:** **0** across the full set. No dangling START-without-END or
  END-without-START in any case. This directly answers the M61 open question: the atomic fix
  prevents the M60B partial-sentinel corruption on every M60 case, including the over-budget
  one.
- **fail-closed behavior:** exercised exactly once (pylint-8898) and behaving to spec — the
  digest is preserved whole, the contract is omitted as a unit with an explicit marker, and
  the over-budget condition is detectable via `atomicBlocksOmitted` rather than silently
  corrupting the run.

## Key Questions

1. **Is pylint-8898 the only case whose essential digest+contract exceeds 12,000?** Yes.
   It is the sole over-budget case (12,803), and by a wide margin — the next-largest combined
   size is 7,875 (`astropy-14598`), a 4,928-char headroom.
2. **Any remaining partial sentinel failures after M61?** No — zero across all 15 cases.
3. **Any case where contract/digest is omitted despite fitting the budget?** No — the only
   omission (pylint contract) is on the only case that does not fit; all 14 fitting cases
   keep both blocks.
4. **Which components dominate size in over/near-budget cases?** Only pylint qualifies; its
   driver is the digest **issue-description header** (~8k of its 9.9k digest). No near-budget
   cases exist.
5. **Smallest safe follow-up:** none is required to start M60C. The single outlier already
   fails closed cleanly. If/when pylint-8898 must be a *valid* treatment run, the cheapest
   safe lever is a pylint-style digest-header cap (recovers 803 chars) — out of scope here.

## Recommendation

**A. Proceed to M60C live repeat.**

Justification: 14/15 cases are fully valid post-truncation; the single non-valid case
(`pylint-8898`) is the known content-overflow outlier that now fails **closed** — digest
preserved whole, contract omitted as a unit with an explicit marker, **no partial
sentinel** — so it is invalid *by design* at the 12k budget, not silently corrupted. No case
is near budget, and the overflow does not recur across the breadth set, so neither a global
digest/contract compaction (B) nor a treatment-wide budget bump (C) is justified to unblock
M60C, and there is no remaining truncation bug to fix (D). Run M60C live over the breadth
set, excluding/invalidating `pylint-8898` as the accepted fail-closed outlier (or land the
small, scoped digest-header cap first if a valid pylint datapoint is wanted — but that
should not gate the breadth run).
