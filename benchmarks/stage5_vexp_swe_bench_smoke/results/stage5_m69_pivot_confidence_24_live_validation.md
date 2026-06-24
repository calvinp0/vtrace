# Stage 5 M69 Pivot Confidence 24-Task Live Validation

Live repeat of the frozen **M62 24-task confirmation set** using the post-M68 structured
bounded treatment **with the pivot-confidence gate enabled** (`--pivot-confidence-gate`,
default OFF, bounded-only). This is a **24-task repeat**, **not** a 100-task benchmark,
**not** a default promotion, and **not** a product change. No retrieval / scoring / ranking
/ candidate-generation code was touched (only an offline pre-flight, an analyze helper, and
this report/JSON were added); the deterministic render path is unchanged.

Main question — *Does the pivot-confidence gate clear the structured-decision failures seen
in M66 while preserving validity, resolution parity, cost bounds, and no-hurt behavior on
the frozen 24-task set?* **Answer: yes, on this set.**

Source of truth (frozen): `stage5_m62_structured_bounded_24_preregistration.json`.
Comparators: `stage5_m66_optional_impact_24_live_validation.json` (+`.detail.json`),
`stage5_m67_m66_pivot_localization_audit.json`,
`stage5_m68_required_pivot_confidence_gate.json`,
`stage5_m68b_pivot_confidence_live_confirmation.json`.

## Summary

- **Selected task count:** 24. **Repos:** 11. **Category counts:** A6 / B4 / C5 / D3 / E6.
- **New live runs performed:** 24 treatment runs + 24 Docker evals. **Fresh baselines: 0.**
  **Reused baselines: 24.** Total live agent runs = 24 (= the approved hard cap).
- **Valid / invalid treatment runs:** **24 VALID / 0 invalid.**
- **Zero-required cases:** 2 (`sympy__sympy-12419`, `django__django-11740`) — both
  marker-backed (`<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>`), **both resolved.**
- **Demoted pivots:** 6 total across 4 cases (sympy-12419 ×2, sympy-12481 ×1,
  astropy-14365 ×1, django-11740 ×2). **0 demoted pivots edited as a demoted target**
  (one within-file demotion in sympy-12481 coincided with editing the kept lead's file).
- **Headline resolution:** M69 **17/24** vs reused baseline **15/24** vs M66 **15/24** on
  this frozen set (+2 vs both comparators).
- **Headline token/cost/tool-turn:** pooled tokens **−16.96%**, pooled cache-read
  **−18.51%**, pooled cost **−8.80%**, mean tool-calls **−2.27** vs reused baseline.
- **Headline structured-decision:** coverage **90.24%**, ignored **2.44%**, invalid
  rule-out **7.32%** (M66 was 85.11% / 2.13% / 8.51%).
- **Verdict: PASS** (all 12 success criteria clear, with an explicit small-N /
  resolution-variance caveat).

## Preregistration Compliance

- **Frozen M62 fixture used:** yes (`stage5_m62_structured_bounded_24_preregistration.json`).
- **Selected task count matches:** yes — 24.
- **Repos / category counts match:** yes — 11 repos; A6 / B4 / C5 / D3 / E6.
- **Locked sentinels present:** yes — `sphinx-doc__sphinx-7462`, `django__django-11820`,
  `django__django-13195`.
- **Cases added / removed / replaced:** none. No extra replicates, no corrective/revision/
  oracle arms, no task substitutions.
- **Deviations:** none. The only difference from the M66 treatment condition is the added
  `--pivot-confidence-gate` flag (verified: M66 used default `strict_risk_gated` pivot-check
  and no `--disable-pivot-check`; the M69 command set is identical except for the gate).

## Post-M68 Pre-flight

Non-agent render-path pre-flight (`run_stage5_m69_preflight.ts`, driving the real
`prepareIndexedContext`: checkout → vtrace index → deterministic `capsule` query → render)
over all 24 cases with the full treatment flag set **including `--pivot-confidence-gate`**.
No agents, no Docker, no spend.

- **24 cases checked → 24 VALID.**
- **FAIL_CLOSED_OMITTED:** 0. **INVALID_PARTIAL_SENTINEL:** 0.
- **Confidence gate enabled?** Yes (`--pivot-confidence-gate` requires
  `--bounded-digest-decisions`; flag wired and exercised on every case).
- **Zero-required marker result:** `sympy-12419` and `django-11740` each emitted exactly 0
  required targets **with** the `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` marker and a
  populated demoted-pivot list.
- **Demotion result:** 6 demoted pivots across 4 cases (see Pivot Confidence Gate Analysis).
- **Required IMPACT target count:** **0** across all 24 (`required_impact_any=false`).
- **Optional/FYI impact context:** present wherever impact reps exist, all marked
  "not closure-scored".
- **O/T ID separation:** no `T`/`O` collisions in any case.

Gate thresholds (≥21 VALID, 0 partial-sentinel, 0 required IMPACT) cleared with margin.
The 5 cases overlapping M68B reproduced M68B's pre-flight exactly.

## Baseline Reuse Gate

All 24 baselines reused from the frozen M60/M55Y lineage recorded in the committed M66
detail artifact; `baseline_model_match=true` for all 24; reused baseline resolution =
15/24 (consistent with M66). **0 fresh baselines required** → total live runs stayed at 24.

| instance_id | baseline_run_label | source | model_match | reuse_decision | notes |
|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | m56c_baseline_sphinx_7462 | reused | pass | reuse | locked sentinel |
| matplotlib__matplotlib-22719 | eval-m4r1-baseline-matplotlib-22719-r3 | reused | pass | reuse | |
| matplotlib__matplotlib-24627 | eval-bounded-baseline-mpl-24627-r1(+2) | reused | pass | reuse | |
| mwaskom__seaborn-3187 | eval-bounded20-baseline-seaborn-3187-r1(+2) | reused | pass | reuse | |
| sympy__sympy-13372 | eval-bounded20-baseline-sympy-13372-r3 | reused | pass | reuse | |
| django__django-11820 | m56c_baseline_django_11820 | reused | pass | reuse | locked sentinel |
| pydata__xarray-3677 | eval-m32-product-baseline-xarray-3677-r3(+2) | reused | pass | reuse | |
| sympy__sympy-12419 | eval-bounded20-baseline-sympy-12419-r1 | reused | pass | reuse | zero-required |
| astropy__astropy-14539 | eval-bounded20-baseline-astropy-14539-r2(+2) | reused | pass | reuse | |
| pylint-dev__pylint-8898 | eval-bounded20-baseline-pylint-8898-r2(+2) | reused | pass | reuse | |
| sympy__sympy-12481 | eval-bounded20-baseline-sympy-12481-r3 | reused | pass | reuse | 1 demotion |
| psf__requests-1142 | eval-bounded-baseline-requests-1142-r1 | reused | pass | reuse | |
| astropy__astropy-14365 | eval-bounded20-baseline-astropy-14365-r2(+2) | reused | pass | reuse | 1 demotion |
| matplotlib__matplotlib-25960 | eval-bounded-baseline-mpl-25960-r3 | reused | pass | reuse | |
| pytest-dev__pytest-7432 | m55y_baseline_pytest_7432 | reused | pass | reuse | |
| pallets__flask-5014 | eval-bounded-baseline-flask-5014-r2(+2) | reused | pass | reuse | |
| django__django-13195 | m56c_baseline_django_13195 | reused | pass | reuse | locked sentinel |
| astropy__astropy-14598 | m55y_baseline_astropy_14598 | reused | pass | reuse | |
| sympy__sympy-16766 | eval-bounded-baseline-sympy-16766-r3(+2) | reused | pass | reuse | |
| astropy__astropy-14369 | eval-baseline-vs-vtrace-baseline-astropy-14369 | reused | pass | reuse | |
| django__django-10880 | eval-m32-product-baseline-django-10880-r3(+2) | reused | pass | reuse | |
| django__django-11095 | eval-m4h-baseline-django-11095-r3 | reused | pass | reuse | |
| psf__requests-5414 | eval-baseline-vs-vtrace-baseline-requests-5414 | reused | pass | reuse | |
| django__django-11740 | eval-11740 | reused | pass | reuse | zero-required |

**No fresh baselines were run.**

## Run Matrix

| instance_id | repo | cat | baseline (reused) | M66 res | M69 run_label | M69 valid | evaluated | zero_req | demoted | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | sphinx | A | reused | 0 | m69_pivot_confidence_24_sphinx_7462 | ✓ | ✓ | – | 0 | both_fail |
| matplotlib-22719 | matplotlib | A | reused | 1 | …_matplotlib_22719 | ✓ | ✓ | – | 0 | |
| matplotlib-24627 | matplotlib | A | reused | 1 | …_matplotlib_24627 | ✓ | ✓ | – | 0 | M69-only win vs base |
| seaborn-3187 | seaborn | A | reused | 0 | …_seaborn_3187 | ✓ | ✓ | – | 0 | both_fail |
| sympy-13372 | sympy | A | reused | 1 | …_sympy_13372 | ✓ | ✓ | – | 0 | |
| django-11820 | django | A | reused | 0 | …_django_11820 | ✓ | ✓ | – | 0 | both_fail (sentinel) |
| xarray-3677 | xarray | B | reused | 1 | …_xarray_3677 | ✓ | ✓ | – | 0 | |
| sympy-12419 | sympy | B | reused | 1 | …_sympy_12419 | ✓ | ✓ | **yes** | 2 | resolved |
| astropy-14539 | astropy | B | reused | 1 | …_astropy_14539 | ✓ | ✓ | – | 0 | 1 invalid rule-out |
| pylint-8898 | pylint | B | reused | 0 | …_pylint_8898 | ✓ | ✓ | – | 0 | M69-only win vs M66 |
| sympy-12481 | sympy | C | reused | 1 | …_sympy_12481 | ✓ | ✓ | – | 1 | demoted-file edited; resolved |
| requests-1142 | requests | C | reused | 1 | …_requests_1142 | ✓ | ✓ | – | 0 | |
| astropy-14365 | astropy | C | reused | 1 | …_astropy_14365 | ✓ | ✓ | – | 1 | M66-only pass (see Stability) |
| matplotlib-25960 | matplotlib | C | reused | 0 | …_matplotlib_25960 | ✓ | ✓ | – | 0 | M69-only win vs base & M66 |
| pytest-7432 | pytest | C | reused | 1 | …_pytest_7432 | ✓ | ✓ | – | 0 | |
| flask-5014 | flask | D | reused | 1 | …_flask_5014 | ✓ | ✓ | – | 0 | 1 invalid rule-out |
| django-13195 | django | D | reused | 0 | …_django_13195 | ✓ | ✓ | – | 0 | both_fail (sentinel) |
| astropy-14598 | astropy | D | reused | 0 | …_astropy_14598 | ✓ | ✓ | – | 0 | both_fail |
| sympy-16766 | sympy | E | reused | 1 | …_sympy_16766 | ✓ | ✓ | – | 0 | |
| astropy-14369 | astropy | E | reused | 0 | …_astropy_14369 | ✓ | ✓ | – | 0 | M69-only win vs base & M66 |
| django-10880 | django | E | reused | 1 | …_django_10880 | ✓ | ✓ | – | 0 | edited gold aggregates.py |
| django-11095 | django | E | reused | 1 | …_django_11095 | ✓ | ✓ | – | 0 | |
| requests-5414 | requests | E | reused | 0 | …_requests_5414 | ✓ | ✓ | – | 0 | baseline-only pass |
| django-11740 | django | E | reused | 1 | …_django_11740 | ✓ | ✓ | **yes** | 2 | resolved |

## Results Table

Tokens in millions; cache-read in millions; cost in USD. `opt`=optional/FYI targets,
`optEd`=optional targets edited, `offT`=edits outside the required+optional target set.

| instance_id | cond | resolved | patch | tot_tok | cache_rd | cost | tools | reads | search | rep_rd | req | demoted | closed | open | ignored | invalid | opt | optEd | offT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | M69 | 0 | ✓ | 0.80 | 0.74 | 0.420 | 7 | 2 | 0 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 1 | 0 | 0 |
| matplotlib-22719 | M69 | 1 | ✓ | 0.96 | 0.88 | 0.501 | 9 | 4 | 1 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 1 |
| matplotlib-24627 | M69 | 1 | ✓ | 2.99 | 2.89 | 1.154 | 27 | 5 | 7 | 2 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 2 |
| seaborn-3187 | M69 | 0 | ✓ | 0.65 | 0.60 | 0.431 | 6 | 2 | 2 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| sympy-13372 | M69 | 1 | ✓ | 0.64 | 0.59 | 0.385 | 6 | 2 | 1 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| django-11820 | M69 | 0 | ✓ | 1.01 | 0.95 | 0.509 | 10 | 2 | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 1 | 0 | 0 |
| xarray-3677 | M69 | 1 | ✓ | 1.34 | 1.27 | 0.657 | 13 | 5 | 0 | 4 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| sympy-12419 | M69 | 1 | ✓ | 3.65 | 3.50 | 1.695 | 24 | 8 | 5 | 5 | 0 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 1 |
| astropy-14539 | M69 | 1 | ✓ | 1.37 | 1.29 | 0.728 | 13 | 5 | 1 | 3 | 2 | 0 | 1 | 1 | 0 | 1 | 2 | 0 | 0 |
| pylint-8898 | M69 | 1 | ✓ | 2.58 | 2.46 | 1.093 | 19 | 4 | 6 | 2 | 2 | 0 | 1 | 1 | 1 | 0 | 2 | 0 | 0 |
| sympy-12481 | M69 | 1 | ✓ | 0.86 | 0.80 | 0.451 | 8 | 4 | 1 | 3 | 1 | 1 | 1 | 0 | 0 | 0 | 3 | 1 | 0 |
| requests-1142 | M69 | 1 | ✓ | 0.82 | 0.74 | 0.487 | 7 | 3 | 0 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 1 |
| astropy-14365 | M69 | 0 | ✓ | 0.47 | 0.41 | 0.324 | 4 | 1 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 2 | 0 | 0 |
| matplotlib-25960 | M69 | 1 | ✓ | 1.79 | 1.70 | 0.928 | 16 | 3 | 7 | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| pytest-7432 | M69 | 1 | ✓ | 1.10 | 1.05 | 0.526 | 13 | 2 | 0 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| flask-5014 | M69 | 1 | ✓ | 0.42 | 0.37 | 0.277 | 4 | 2 | 0 | 1 | 2 | 0 | 1 | 1 | 0 | 1 | 2 | 0 | 0 |
| django-13195 | M69 | 0 | ✓ | 0.45 | 0.41 | 0.316 | 4 | 2 | 0 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 1 | 0 | 0 |
| astropy-14598 | M69 | 0 | ✓ | 3.75 | 3.55 | 3.012 | 24 | 7 | 8 | 4 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| sympy-16766 | M69 | 1 | ✓ | 0.90 | 0.85 | 0.471 | 9 | 3 | 2 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| astropy-14369 | M69 | 1 | ✓ | 1.07 | 1.00 | 0.566 | 9 | 2 | 2 | 1 | 2 | 0 | 1 | 1 | 0 | 1 | 2 | 0 | 2 |
| django-10880 | M69 | 1 | ✓ | 0.72 | 0.67 | 0.394 | 7 | 1 | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 | 1 |
| django-11095 | M69 | 1 | ✓ | 0.60 | 0.55 | 0.371 | 6 | 2 | 0 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| requests-5414 | M69 | 0 | ✓ | 0.64 | 0.59 | 0.371 | 6 | 2 | 1 | 1 | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| django-11740 | M69 | 1 | ✓ | 1.08 | 1.01 | 0.492 | 11 | 4 | 4 | 3 | 0 | 2 | 0 | 0 | 0 | 0 | 4 | 0 | 1 |

## Paired Outcomes

**Baseline vs M69** (reused baseline; n=24):
- both_pass: 14
- both_fail: 6 — sphinx-7462, seaborn-3187, django-11820, astropy-14365, django-13195, astropy-14598
- **M69_only_pass: 3** — matplotlib-24627, matplotlib-25960, astropy-14369
- baseline_only_pass: 1 — requests-5414
- treatment_only_pass_vs_baseline: **+3 / −1 = net +2**

**M66 vs M69** (n=24):
- both_pass: 14
- both_fail: 6 — sphinx-7462, seaborn-3187, django-11820, django-13195, astropy-14598, requests-5414
- **M69_only_pass: 3** — pylint-8898, matplotlib-25960, astropy-14369
- M66_only_pass: 1 — astropy-14365
- net vs M66: **+2**

## Paired Deltas (M69 − reused baseline)

| metric | mean | median | pooled |
|---|---|---|---|
| token_delta | −261,124 | −112,683 | **−16.96%** |
| cache_read_delta | −272,977 | −68,670 | **−18.51%** |
| cost_delta (USD) | −0.0665 | +0.0680 | **−8.80%** |
| tool_call_delta | −2.27 | — | — |
| read_count (abs mean) | 3.21 | — | — |
| search_count (abs mean) | 2.00 | — | — |

- resolution_delta vs baseline: **+2** (17 vs 15)
- closed_target_delta vs M66: 37 vs 40 (fewer required targets overall: 41 vs 47)
- open_target_delta vs M66: 4 vs 7
- ignored_target_delta vs M66: 1 vs 1
- invalid_rule_out_delta vs M66: 3 vs 4
- off_target_edit_delta: M69 total 9 (see Cost / Over-Exploration)

Pooled treatment cost $16.56 vs baseline $18.16; pooled treatment tokens 30.68M vs baseline
36.95M. Cost median is slightly positive (+$0.068) while the pooled and mean are negative —
a few cheap baselines and a few expensive treatment B-cases pull the per-case median up,
but the volume-weighted pooled total favours treatment.

## Category-Stratified Results

| cat | n | base res | M66 res | M69 res | M69-only wins vs base | base-only losses | cost pooled | token pooled | coverage | ignored | invalid | offT |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A hidden/context-action | 6 | 2 | 3 | 3 | matplotlib-24627 | – | −41.2% | −39.1% | 100% | 0% | 0% | 3 |
| B high-overhead/nav-heavy | 4 | 4 | 3 | 4 | – | – | +67.0% | +45.1% | 66.7% | 16.7% | 16.7% | 1 |
| C normal/control | 5 | 3 | 4 | 4 | matplotlib-25960 | – | −1.0% | −22.5% | 100% | 0% | 0% | 1 |
| D retrieved-but-didnt-act | 3 | 1 | 1 | 1 | – | – | +3.2% | −2.8% | 83.3% | 0% | 16.7% | 0 |
| E baseline-strong controls | 6 | 5 | 4 | 5 | astropy-14369 | requests-5414 | −26.8% | −36.8% | 90% | 0% | 10% | 4 |

Interpretation:
- **A (hidden/context-action):** M69 3/6 (up from baseline 2/6, level with M66 3/6); the
  digest-attributable win matplotlib-24627 is preserved. Cheapest category (−41% cost).
- **B (high-overhead/nav-heavy):** all 4 resolved (up from M66 3/4), but the most expensive
  (+67% cost), driven by the deep zero-required sympy-12419 (3.65M tokens) and pylint-8898.
  B carries the only ignored target (pylint-8898) and one invalid rule-out (astropy-14539),
  pulling its coverage to 66.7%.
- **C (normal/control):** 4/5 resolved (up from baseline 3/5); new win matplotlib-25960;
  the one regression vs M66 is astropy-14365 (see Resolution Stability). 100% coverage.
- **D (over-anchor controls):** stable at 1/3; flask-5014 carries one invalid rule-out;
  cost essentially flat (+3.2%); **0 off-target edits** — no over-anchoring damage.
- **E (baseline-strong controls):** 5/6 (level with baseline; up from M66 4/6); new win
  astropy-14369; the one loss requests-5414 is gate-neutral run variance (M66 also failed
  it). Strongly cheaper (−27% cost). No E control was harmed by over-exploration.

## Pivot Confidence Gate Analysis

- **Zero-required cases (2):** `sympy-12419`, `django-11740` — each emitted 0 required
  targets **with** the explicit `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` marker. **Both
  resolved.**
- **Demoted pivot count:** 6 across 4 cases.
  - `sympy-12419`: demoted both `piecewise.py::piecewise_fold` and
    `piecewise.py::Piecewise._sort_expr_cond` (lexical/symbol-name-only evidence on the
    failing operation; no traceback/edit-site/failing-test anchor) → zero-required.
  - `django-11740`: demoted both `gis/gdal/feature.py::Feature` and `Feature.fid`
    (symbol-name/lexical only; GIS feature wrapper, not the migration fix) → zero-required.
  - `sympy-12481`: lead `permutations.py::Permutation` kept required; demoted the within-file
    `Permutation.__new__` (weak co-pivot evidence).
  - `astropy-14365`: lead `qdp.py::_write_table_qdp` kept required; demoted the non-gold
    `fits/scripts/fitsdiff.py::handle_options` (facade/unrelated script).
- **Demotion reasons** (gate vocabulary): all 6 demotions are "weak localization evidence" —
  lexical/symbol-name-only matches, facade/wrapper/script targets, with no strong clause
  (traceback anchor, failing-test exercise, explicit/likely edit site, direct graph edge, or
  issue-specific overlap). No high-confidence pivot was demoted.
- **Were demoted pivots inspected?** No demoted pivot was separately read in the
  zero-required cases (the agents searched and went straight to the real fix). In sympy-12481
  the demoted pivot's file *is* the kept lead's file and was edited as part of the lead fix.
- **Were demoted pivots edited (as demoted targets)?** **No.** The only "demoted-file edited"
  signal (sympy-12481) is the kept-required lead's own file.
- **Was any demoted pivot resolution-critical?** **No.** In sympy-12419 the real fix was
  `matexpr.py`; in django-11740 it was `migrations/autodetector.py`; in both the demoted
  files were genuinely not the fix and the cases resolved anyway. In astropy-14365 the demoted
  `fitsdiff.py` is not the gold file.
- **Was any correct/gold lead wrongly demoted?** **No.** Every gold/lead pivot that mattered
  was *kept* required (qdp.py in astropy-14365; permutations.py in sympy-12481) or, in the
  zero-required cases, the demoted candidates were provably not the fix site.
- **requests-5414 `models.py` remained required:** **yes** — both `models.py::prepare_url`
  and `api.py::get` stayed required (dem=0); the gate did nothing here.
- **matplotlib-24627 mechanism remained safe:** **yes** — dem=0, both pyplot.py pivots kept
  required; the case resolved (digest-attributable win preserved).

## Structured Decision Analysis

| metric | M69 (live) | M66 (live) | M68 retro-replay | M68B slice (non-zero-req) |
|---|---|---|---|---|
| required | 41 | 47 | 41 | — |
| closed | 37 | 40 | — | — |
| open | 4 | 7 | — | — |
| ignored | 1 | 1 | — | — |
| invalid rule-out | 3 | 4 | — | — |
| **coverage** | **90.24%** | 85.11% | 92.7% | 100% |
| **ignored rate** | **2.44%** | 2.13% | 2.4% | 0% |
| **invalid rule-out rate** | **7.32%** | 8.51% | 4.9% | 0% |

- **Required target closure:** 37/41 closed. The required count dropped 47→41 because the
  gate demoted 6 low-confidence pivots out of the required pool — exactly the M68 mechanism.
- **Coverage** rose 85.11% → 90.24%, clearing the ≥90% bar (M68 predicted 92.7% over the M66
  artifacts; the small live shortfall is run variance in agent decisions).
- **Ignored rate** is 2.44% (one ignored target, pylint-8898) — well within ≤5%.
- **Invalid rule-out rate** improved 8.51% → 7.32% (3 invalid rule-outs: astropy-14539,
  flask-5014, astropy-14369 — all on *kept* high-confidence pivots, i.e. agent rule-out
  behavior, not gate artifacts). This is above the M68 retro-replay's 4.9% but **still better
  than M66**, satisfying the "improves or does not worsen vs M66" criterion.
- **Do the failed M66 criteria clear?** Yes: M66's MIXED verdict was driven by coverage
  (85.1% < 90%) and invalid rule-out (8.5%). M69 clears coverage (90.24%) and improves
  invalid rule-out (7.32%), while keeping ignored low.

## Resolution Stability

| case | prior M66 | M68B | M69 | likely diagnosis |
|---|---|---|---|---|
| django-11740 | resolved | resolved | **resolved** | zero-required; agent edits real fix (autodetector.py); gate-safe |
| sympy-12419 | resolved | resolved | **resolved** | zero-required; agent edits real fix (matexpr.py); gate-safe |
| matplotlib-24627 | resolved | resolved | **resolved** | dem=0; pyplot pivots kept; digest-attributable win preserved |
| astropy-14365 | resolved | n/a | **not resolved** | gold lead qdp.py *kept* & edited but patch incomplete (shallow 4-tool run); demoted file (fitsdiff.py) is non-gold → **patch-quality variance, not gate-caused** |
| requests-5414 | not resolved | resolved | **not resolved** | dem=0; gate-neutral; known-unstable case (M66 also failed) → run variance |
| seaborn-3187 | not resolved | n/a | **not resolved** | both_fail; dem=0; unchanged |
| sphinx-7462 | not resolved | n/a | **not resolved** | both_fail; locked sentinel needs ast.py edit not produced; dem=0 |

Net: the only M66→M69 resolution regression is astropy-14365, and it is **not** attributable
to the confidence gate (the gold lead was kept required and edited; only the non-gold
collateral was demoted). New M69 resolutions vs M66: pylint-8898, matplotlib-25960,
astropy-14369.

## Cost / Over-Exploration Analysis

- **Pooled cost delta vs baseline:** **−8.80%** (treatment cheaper than baseline; M66 was
  +12.3%). The gate's demotion of low-confidence pivots reduces over-anchoring pressure.
- **Pooled token delta vs baseline:** **−16.96%**; pooled cache-read **−18.51%**.
- **Tool-call delta:** mean **−2.27** vs baseline; repeated-read counts are modest
  (max 5 in sympy-12419, the deep zero-required case).
- **Off-target / over-anchoring behavior:** 9 off-target edits across 7 cases, but **6 of 7
  resolved** — these are the agent navigating *beyond* the surfaced pivots to the real fix
  (e.g. django-10880 → gold `aggregates.py`; matplotlib-24627 → `_base.py`/`figure.py`;
  astropy-14369 → generated parser tables alongside `cds.py`). They are **not** over-anchor
  damage; the D over-anchor controls had **0** off-target edits.
- **Were E controls harmed?** No — E is 5/6 (level with baseline) and −27% cost.
- **Thrashing cases:** none. The most expensive cases (sympy-12419 $1.70, astropy-14598
  $3.01) are deep but bounded; astropy-14598 is a both_fail unrelated to the gate (dem=0).

## Success Criteria Check

1. **Treatment valid in (nearly) all runs** — **PASS** (24/24 valid).
2. **Confidence gate enabled in all treatment runs** — **PASS** (gate verified against the
   gated pre-flight render on 24/24).
3. **Zero-required contracts valid only with explicit marker** — **PASS** (2/2 marker-backed).
4. **No required IMPACT targets** — **PASS** (`required_impact_any=false`).
5. **Optional/FYI targets not closure-scored** — **PASS** (every optional section marked
   "not closure-scored"; never counted in closure).
6. **Decision coverage ≥ 90%** — **PASS** (90.24%).
7. **Ignored required-target rate ≤ 5%** — **PASS** (2.44%).
8. **Invalid rule-out improves or does not worsen vs M66** — **PASS** (7.32% < 8.51%).
9. **No treatment-only win loses its mechanism** — **PASS** (matplotlib-24627, matplotlib-25960,
   astropy-14369 each edited the real fix file(s) and resolved).
10. **No correct/gold lead wrongly demoted in a way that harms resolution** — **PASS** (all
    gold leads kept required; demotions were non-fix collateral; the one demotion-adjacent
    miss, astropy-14365, edited the kept gold lead and missed on patch quality, not demotion).
11. **Resolution not worse than comparable baseline** — **PASS** (17 vs 15).
12. **Pooled cost regression ≤ +15% vs baseline** — **PASS** (−8.80%).

**12 / 12 criteria pass.**

## Verdict

**PASS** — on this frozen 24-task set the pivot-confidence gate kept all 24 treatment runs
valid, emitted the two zero-required contracts only with the explicit marker, demoted only
low-confidence pivots (no gold lead demoted, no demotion resolution-critical), lifted
structured-decision coverage above 90% while improving the invalid rule-out rate vs M66, and
did so at **lower** pooled cost and tokens than the reused baseline with resolution **+2**.

Caveats: small N (24), single replicate per case; the coverage and invalid-rule-out figures
carry run-to-run variance (live 90.24% / 7.32% vs the M68 retro-replay 92.7% / 4.9%); the one
M66→M69 resolution regression (astropy-14365) is patch-quality variance, not gate-caused;
category B remains the cost outlier (+67% pooled within-category).

## Recommendation

**Proceed to broader confirmation planning (toward a 100-task run).** The 24-task confirmation
clears every success criterion with resolution and cost both moving the right way, so the next
step is to plan a larger confirmation. **Do not** make the gate the Stage 5 experimental
default yet, and **do not** start the 100-task benchmark inside this milestone — fold in the
small-N / B-category-cost caveats and the astropy-14365 patch-quality variance when scoping it.

## Non-claims

This report does **not** claim VTRACE/VEXP parity, a general SWE-bench pass@1 improvement,
statistical superiority, or that the confidence gate is globally proven. Acceptable readings:
M69 treatment was valid in 24/24 runs; coverage was 90.24%; ignored rate 2.44%; invalid
rule-out rate 7.32%; resolution 17/24 vs baseline 15/24 on this frozen set; pooled cost
−8.80% vs baseline on this set; the gate demoted 6 pivots and emitted 2 zero-required
contracts.
