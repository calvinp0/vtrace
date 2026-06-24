# Stage 5 M70B 100-Task Readiness

Operational readiness pass before authorizing the frozen M70 100-task structured-bounded +
pivot-confidence-gate benchmark. **No live agents, no Docker, no API spend, no fresh
baselines, no 100-task run.** This milestone renders the gated pre-flight for all 100 selected
cases, qualifies on-disk baselines for reuse, and freezes the exact live execution matrix. No
retrieval / scoring / ranking / candidate-generation code was touched; the M70 selected set is
unchanged.

Sources: `stage5_m70_100_task_preregistration.json` (frozen selection),
`stage5_m70b_preflight.json` (pre-flight), `stage5_m70b_baselines.json` (baseline
qualification), `stage5_m70b_100_task_execution_matrix.json` (execution matrix).

## Summary

- **Fixture validation:** PASS — 100 tasks, 12 repos, full census of `swe-bench-100.jsonl`,
  unchanged from M70 (no task added / removed / replaced).
- **Pre-flight result:** **99 / 100 VALID**, **1 invalid** (`django__django-10973`, contract
  absent), **0 pending**. 0 fail-closed, 0 partial-sentinel, **0 required-IMPACT targets**,
  0 near-budget. 49 rendered by reusing a persisted index (read-only), 51 by fresh clone.
- **Baseline reuse:** **27 reused_verified** (model-matched `opus-4-5`, patched,
  Docker-evaluated), **0 incomplete**, **0 invalid**, **73 fresh_required** (no on-disk
  baseline).
- **Expected live-run count:** **173** = 100 treatment + 73 fresh baselines.
- **Recommended execution option:** **Option 3 — staged 50 + 50 treatment + 73 fresh
  baselines** over the same frozen fixture.
- **Recommendation:** **Ready for explicit authorization (Option 3 staged).** The single
  invalid case is isolated, understood, and not a gate/treatment defect; the matrix and cap
  are frozen.

## Fixture Validation

- **Path:** `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m70_100_task_preregistration.json`.
- **Task count:** 100. **Repo count:** 12. **Full census** of `swe-bench-100.jsonl`.
- **Repo distribution:** django 44, sympy 17, matplotlib 7, sphinx 7, xarray 6, astropy 5,
  requests 4, pytest 4, pylint 2, scikit-learn 2, seaborn 1, flask 1.
- **Difficulty distribution:** `<15 min` 38, `15 min–1 h` 53, `1–4 h` 8, `>4 h` 1.
- **Any task changed:** **No.** M70B reads the frozen fixture; it does not modify membership,
  ordering, treatment flags, or selection.

## 100-Task Pre-flight

- **Method / helper:** `run_stage5_m70b_preflight_100.ts` — renders the EXACT M70 treatment
  injected context **including `--pivot-confidence-gate`** and classifies validity with the
  M69 gate-on rules. Two no-agent / no-Docker render paths: **reuse** (read-only render from a
  persisted vtrace index — never mutates the workspace; 49 cases) and **clone** (fresh
  checkout → index → query → render via `prepareIndexedContext`, temp clone deleted per case;
  51 cases, run as 4 parallel workers). The render path is deterministic from repo source, so
  a reuse render equals what the live run produces.
- **Valid / invalid counts:** **99 VALID / 1 invalid / 0 pending.**
- **Fail-closed (over-budget):** **0** — the M63 compact digest header holds across the full
  census; 0 cases near the 12k budget.
- **Partial-sentinel:** **0** — atomic truncation intact (no M61 regression).
- **The one invalid:** `django__django-10973` — `OTHER_INVALID: contract_absent_or_sentinels_not_singular`.
  A **fresh clone** reproduces it (digest renders but the decision contract does **not**), so
  it is a **genuine** per-instance render outcome, **not** a stale-index artifact and **not** a
  gate defect. It is retained in the fixture and skipped at run time unless its live pre-flight
  becomes VALID (treated like the M62 fail-closed precedent).
- **Zero-required count:** **9** cases emit 0 required targets. **8 are VALID** (gate firings,
  each marker-backed by `<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` + a populated demoted
  list); the 9th is `django-10973` (the invalid above — 0 required because the contract is
  absent, not because the gate fired).
- **Demoted pivot count:** **31** low-confidence pivots demoted across the census (the gate's
  intended mechanism, scaled up from M69's 6/24).
- **Required IMPACT count:** **0** across all 100 (`required_impact_any=false`) — impact reps
  remain optional/FYI.
- **Optional/FYI integrity:** 0 valid cases had impact reps without an optional section; every
  optional section is marked "not closure-scored"; no O/T id collisions.
- **Confidence-gate integrity:** the gate was enabled on every render (the 8 marker-backed
  zero-required contracts + 31 demotions are the gate firing); no `INVALID_CONFIDENCE_GATE`.

## Baseline Reuse Qualification

Helper: `run_stage5_m70b_qualify_baselines.ts` (offline scan of `results/runs/*/raw/baseline`).
Reuse gate (all required): same instance + baseline condition + Stage 5 vexp harness family +
model == treatment (`claude-opus-4-5-20251101`) + patch present + `_eval.meta.json` +
resolved result + token/cost metadata + parseable artifacts. **The bar was not lowered to
reduce live runs.**

| status | count |
|---|--:|
| reused_verified | 27 |
| reused_candidate_but_incomplete | 0 |
| invalid_artifact | 0 |
| missing (→ fresh_required) | 73 |
| **fresh_baseline_required (= 100 − reused_verified)** | **73** |

The 27 verified reuses are the 24 M62/M69 baselines **plus** 3 newly qualified
(`django-11490`, `django-11728`, `sphinx-7748`) — model-matched, patched, Docker-evaluated.
No on-disk baseline existed for the other 73 instances, so they require a fresh baseline. (The
102 baseline run dirs on disk cover only these 27 of the 100 selected instances; the rest have
no baseline of any model.)

### Per-repo summary (pre-flight + baseline)

| repo | n | pf VALID | pf INVALID | reuse-rendered | clone-rendered | baseline reused | fresh needed |
|---|--:|--:|--:|--:|--:|--:|--:|
| django/django | 44 | 43 | 1 | 19 | 25 | 7 | 37 |
| sympy/sympy | 17 | 17 | 0 | 5 | 12 | 4 | 13 |
| matplotlib/matplotlib | 7 | 7 | 0 | 4 | 3 | 3 | 4 |
| sphinx-doc/sphinx | 7 | 7 | 0 | 4 | 3 | 2 | 5 |
| pydata/xarray | 6 | 6 | 0 | 2 | 4 | 1 | 5 |
| astropy/astropy | 5 | 5 | 0 | 4 | 1 | 4 | 1 |
| psf/requests | 4 | 4 | 0 | 3 | 1 | 2 | 2 |
| pytest-dev/pytest | 4 | 4 | 0 | 3 | 1 | 1 | 3 |
| pylint-dev/pylint | 2 | 2 | 0 | 1 | 1 | 1 | 1 |
| scikit-learn/scikit-learn | 2 | 2 | 0 | 2 | 0 | 0 | 2 |
| mwaskom/seaborn | 1 | 1 | 0 | 1 | 0 | 1 | 0 |
| pallets/flask | 1 | 1 | 0 | 1 | 0 | 1 | 0 |
| **TOTAL** | **100** | **99** | **1** | **49** | **51** | **27** | **73** |

## Execution Matrix Summary

Frozen per-case matrix: `stage5_m70b_100_task_execution_matrix.json` (fields: `instance_id`,
`repo`, `difficulty`, `m70_selected_index`, `preflight_status`, `planned_treatment_run_label`,
`baseline_reuse_status`, `baseline_run_label`, `fresh_baseline_needed`,
`planned_fresh_baseline_run_label`, `execution_stage`, `notes`).

- **Treatment runs required:** **100** (one per selected case; `django-10973` is gated — run
  only if its live pre-flight clears).
- **Fresh baseline runs required:** **73**.
- **Total expected live runs:** **173**.
- **Stage split (recommended):**
  - **Stage A** — 50 treatment runs (M70 run-queue positions 1–50).
  - **Stage B** — 50 treatment runs (positions 51–100).
  - **Stage C** — 73 fresh baselines (only the instances with no reusable baseline).
  - Stages A/B carry the repo-stratified run queue, so a halt after Stage A leaves a
    repo-balanced half.
- **Run labels:** treatment `m70_structured_bounded_<SAFE>`; fresh baseline `m70_baseline_<SAFE>`.
- **Stop conditions for the next milestone** (re-run pre-flight over fresh-clone indexes
  first; statuses are expected to match this milestone's): stop if pre-flight yields any
  partial sentinel; if fewer than 90 cases are VALID; if any required IMPACT target appears;
  if the confidence gate is missing from a render; if baseline reuse fails enough cases that
  fresh baselines exceed the authorized cap; or if artifact extraction cannot verify treatment
  validity. Live runs must stay **sequential** (shared `_agent_stream.jsonl`).

## Risk Register

| risk | severity | assessment / mitigation |
|---|---|---|
| **Pre-flight validity** | Low | 99/100 VALID with the gate on; 0 partial-sentinel, 0 fail-closed, 0 required-IMPACT. The 1 invalid (`django-10973`) is isolated and gated, not systemic. |
| **Cost** | Medium | 173 live runs is the dominant cost. M69 pooled treatment cost was **−8.8%** vs baseline, but category B was +67% within-category; budget for cost-outlier B/large-repo cases. Reporting guardrail: flag any run > $5. |
| **Django-heavy distribution** | Medium | django is 44% of the census; a single repo can dominate the headline. Mitigation: the report MUST present per-repo and **django-excluded** results, and django carries the lone invalid + the most fresh baselines (37/73). |
| **Baseline incompleteness** | Medium | Only 27/100 have a reusable baseline; 73 need fresh runs. Mitigation: fresh baselines are a frozen, model-matched Stage C; reuse is credited only through the strict gate (no comparability guesses). |
| **Artifact parsing** | Low | All 27 reuse candidates parsed cleanly (model/resolved/patch/tokens present); 0 invalid_artifact. Pre-flight artifact layout matched the M69 extractor. |
| **Live variance** | Medium | Single replicate per case; pre-flight is deterministic but agent runs are not. Mitigation: report Wilson CIs for pass rate and a paired-difference CI; treat per-repo / hard-difficulty-band results (bands 3–4 are thin: 8 + 1) as low-power. |
| **Clone fragility (pre-flight)** | Low (resolved) | The 51 fresh-clone renders all completed (50 VALID + the 1 genuine invalid); 0 clone failures. Temp clones were deleted per case; no raw artifacts staged. |

## Recommendation

**Ready for explicit authorization — Option 3 (staged 50 + 50 treatment + 73 fresh baselines).**

The infrastructure is validated end-to-end with no spend: the frozen fixture is intact, the
gated pre-flight is **99/100 VALID** (0 partial-sentinel, 0 fail-closed, 0 required-IMPACT, 31
demotions, 8 marker-backed zero-required contracts), baseline reuse is qualified at a strict
bar (27 verified, 73 fresh), and the per-case execution matrix + 173-run cap are frozen. The
lone invalid (`django-10973`, genuine contract-absent) is isolated, gated, and not a treatment
or gate defect.

**Suggested authorization:** run **Stage A (50 treatment)** first; gate Stage B on Stage A's
validity/cost staying in band; run **Stage C (73 fresh baselines)** for the paired comparison.
Re-run pre-flight over fresh-clone indexes at the start (expected to match 99/100). **Do not**
promote the gate to default on the basis of this readiness pass — promotion remains a separate
decision after the 100-task result is analyzed.

### Method notes / non-claims

- No live agents, no Docker, no API spend, no fresh baselines, no 100-task run in M70B.
- The pre-flight renders the injected **context** only; it does not predict resolution.
- This pass does not claim VTRACE/VEXP parity, a SWE-bench pass@1 improvement, or statistical
  superiority. It establishes operational readiness for an authorized, staged run.

### Provenance

- Pre-flight: `run_stage5_m70b_preflight_100.ts` → `stage5_m70b_preflight.json`.
- Baseline qualification: `run_stage5_m70b_qualify_baselines.ts` → `stage5_m70b_baselines.json`.
- Matrix + readiness: `run_stage5_m70b_build_matrix.ts` → `stage5_m70b_100_task_execution_matrix.json`,
  `stage5_m70b_100_task_readiness.json`.
- Frozen selection: `stage5_m70_100_task_preregistration.json` (M70).
- Treatment justification: `stage5_m69_pivot_confidence_24_live_validation.{md,json}`.
