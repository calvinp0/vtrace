# Stage 5 M74 Self-Harness-lite Audit

> **Audit / preregistration only.** No harness edit was implemented. No live agents, no
> Docker, no API spend. Treatment behavior is unchanged. Retrieval / scoring / ranking /
> candidate generation / prompts / decision contract are untouched. Every causal label for
> a `both_fail` task is a **heuristic** derived from captured run artifacts plus offline gold
> metadata; it is diagnostic, not ground truth.

## Summary

- **M73 recap.** Final paired 100-task benchmark: treatment **66/100**, baseline **64/100**
  (resolution delta **+2**); paired discordant 11 treatment-only vs 9 baseline-only;
  McNemar exact **p = 0.82** (not distinguishable from chance); pooled paired cost
  **−13.16%**; structured-decision coverage 92.57%, invalid rule-out 6.08%, required IMPACT 0.
  Verdict **STRICT PASS**, scoped as an *internal 100-task engineering validation* — **not**
  VEXP parity, broad SWE-bench superiority, or statistical pass-rate superiority.
- **Why Self-Harness is relevant.** VTRACE has already run the Self-Harness loop *manually*
  (M62C failure → M64 audit → M65 fix → M66 failure → M67 audit → M68 gate → M69/M73
  validation). M74 converts that ad-hoc pattern into a **formal, reusable offline
  audit/preregistration layer**: mine traces → cluster failure signatures → propose small
  harness edits → define a validation/acceptance protocol. The useful idea is treating the
  harness as an empirical object, **not** model self-rewriting.
- **Main failure clusters (treatment, 34 unresolved of 100).**
  1. **Cost-cap exhaustion / thrashing** — 6 runs hit the ~\$3 per-run cap, **0/6 resolved**;
     9 runs trip the thrashing signal (repeated reads ≥5 or tool calls ≥25). Largest,
     cleanest, fully offline-detectable cluster.
  2. **Missing second gold file** — 7 `both_fail` tasks have multi-file gold but the agent
     edited only a subset (15 multi-gold tasks total). Corroborated by the known
     `sphinx-7462` case (gold spans `python.py` + `pycode/ast.py`).
  3. **Context-to-action gap** — 6 `both_fail` with full required-target coverage and a
     produced patch that still failed the tests.
  4. **No-patch exhaustion** — 4 runs ended with no usable patch (3 fail-closed + 1 skipped).
  5. **Baseline-only losses** — 9, sympy-heavy (4 of 9), driven by under-use / thrashing /
     patch-quality.
- **Top candidate harness edits (proposals only).** C1 repeated-failure tool-loop guard
  (tool_loop_guard), C7 budget-aware stop-and-commit cost guard (cost_guard), C2 no-patch
  exhaustion recovery prompt (failure_recovery_policy).
- **Recommended M75 step.** **Candidate C1 — repeated-failure / repeated-read tool-loop
  guard**, default-OFF behind a flag, validated on a frozen thrash/cap-hit subset. It is the
  smallest, most general, fully offline-detectable intervention, targets the cluster with the
  clearest signal (0/6 cap-hits resolve, so there is almost no resolution to lose), and its
  changed-behavior evidence is directly measurable on existing traces.
- **Implementation performed in M74: none.**

## Method

### Inputs inspected
- `stage5_m73_final_100_paired_summary.json` — aggregate paired result (authoritative).
- `stage5_m73_final_100_paired.detail.json` — **100 per-task paired rows** (resolved flags,
  cost, tokens, tool/read/search/edit counts, outcome). Primary classification source.
- `stage5_m73_stage_c_fresh_baselines_and_final_100.md` — Stage C narrative + per-task table.
- `stage5_m71_stage_a_50_treatment.detail.json` / `stage5_m72_stage_b_50_treatment.detail.json`
  — **99 treatment rows** with structured-decision fields (required-target decision counts,
  decision coverage, inspect-only/ignored/invalid counts, off-target edits, repeated reads,
  edited files, demoted pivots).
- `stage5_m70b_100_task_execution_matrix.json` — frozen 100-row execution matrix (membership).

### Raw artifacts inspected
None opened beyond the tracked summary/detail JSON above. No `runs/<label>/raw/` streams,
tool-call files, or logs were read or staged.

### Offline / gold evidence
Gold patch file counts and FAIL_TO_PASS counts were derived offline from
`vexp-swe-bench/data/swe-bench-100.jsonl` **only** to compute the `missing_second_gold`
diagnostic (did the agent touch every gold file?). This is labelled **offline diagnostic
evidence** and is *not* treated as information available to the agent at run time. No category
that an automated miner would compute at run time depends on hidden tests.

### Classification approach (deterministic cascade)
The miner joins the three sources by `instance_id` (100 paired × 99 treatment-detail × 100
gold) and assigns one `primary_failure_category` per task via a fixed priority cascade, plus
secondary categories and a `causal_confidence`. Thresholds (documented for reproducibility):

| signal | threshold | basis |
|---|---|---|
| cost outlier | `treatment_cost >= $1.5` | p90 ≈ \$1.12 |
| cost-cap exhaustion | `treatment_cost >= $2.9` | hard per-run cap ≈ \$3.0 |
| thrashing | `repeated_file_reads >= 5` **or** `tool_calls >= 25` | p90 = 3 reads / 19 calls |
| high coverage | `decision_coverage >= 0.9` | structured-decision contract |
| missing second gold | `n_gold_files > 1` and edited < all gold files (offline) | gold metadata |

`both_pass` → `none_resolved` (high confidence). `treatment_only_pass` /
`baseline_only_pass` are recorded as outcome-categories with mechanism secondaries.
`both_fail` mechanism labels are **medium** confidence; outcome/exhaustion labels are **high**.

### Limitations
- Single run per cell (no within-cell variance); small-cell deltas are not individually
  significant (same caveat as M73).
- `agent_self_rescue_*` and `verification_gap` need **turn-level traces** not mined here; they
  are defined in the taxonomy but flagged `auto_mineable: false` and represented by proxies.
- `both_fail` causal attribution is heuristic — a patch can fail for reasons the structural
  signals do not capture.

## Failure Taxonomy

16 categories (full detail incl. detection signals and example cases in
`stage5_m74_failure_taxonomy.json`). Summary:

| category | mineable | harness surface | primary detection signal |
|---|---|---|---|
| wrong_required_pivot | yes | pivot_inspection_policy | invalid required-decision; pivot ∉ gold (offline) |
| missing_second_gold | yes | patch_policy | multi-file gold, subset edited (offline) |
| context_to_action_gap | yes | patch_policy / verification_policy | coverage ≥0.9, patch produced, unresolved |
| agent_self_rescue_success | no | failure_recovery_policy | (turn-level) error → resolved |
| agent_self_rescue_failure | no | failure_recovery_policy | (turn-level) repeated errors → no_patch |
| no_patch_exhaustion | yes | failure_recovery_policy / cost_guard | patch_produced=false / fail_closed / 0 edits |
| patch_quality_failure | yes | verification_policy | patch produced, edits≥1, unresolved |
| tool_loop_or_thrashing | yes | tool_loop_guard | repeated_reads≥5 or tool_calls≥25 |
| verification_gap | no | verification_policy | (turn-level) no test run before submit |
| environment_or_dependency_failure | yes | environment_policy | env/import invalid_reason |
| quota_or_infra_abort | yes | environment_policy | skipped / quota abort |
| over_anchor_on_context | yes | pivot_inspection_policy | off_target_edit_count>0 |
| under_use_of_context | yes | decision_contract_policy | required pivot inspected-only, unresolved |
| cost_explosion | yes | cost_guard | cost ≥\$1.5 (≥\$2.9 = cap) |
| baseline_only_loss | yes | pivot_inspection_policy | outcome = baseline_only_pass |
| treatment_only_win | yes | n/a (positive) | outcome = treatment_only_pass |

## 100-Task Trace Classification

Full per-task rows are in `stage5_m74_self_harness_lite_audit.json` (`per_task_classification`).

### Paired-outcome counts (from M73)
| outcome | count |
|---|---|
| both_pass | 55 |
| both_fail | 21 |
| treatment_only_pass | 11 |
| baseline_only_pass | 9 |
| treatment_invalid_or_skipped | 4 |
| baseline_invalid_or_missing | 0 |

### Primary-category counts (all 100)
| primary_failure_category | count |
|---|---|
| none_resolved (both_pass) | 55 |
| treatment_only_win | 11 |
| baseline_only_loss | 9 |
| missing_second_gold | 7 |
| context_to_action_gap | 6 |
| no_patch_exhaustion | 3 |
| under_use_of_context | 3 |
| tool_loop_or_thrashing | 3 |
| wrong_required_pivot | 2 |
| quota_or_infra_abort | 1 |

(Plus the cross-cutting flags: 9 tasks trip thrashing, 7 trip cost-outlier, 4 no-patch,
15 are multi-gold of which 7 lost a gold file, 31 have ≥1 off-target edit.)

### Repo / difficulty breakdown of treatment failures (34 unresolved)
- **By repo:** django 13, sympy 6, astropy 3, sphinx 3, matplotlib 2, requests 2, xarray 2,
  seaborn 1, pylint 1, pytest 1.
- **By difficulty:** "15 min – 1 hour" 19, "<15 min fix" 9, "1–4 hours" 5, ">4 hours" 1.
  Failures concentrate in the medium-difficulty band, not just the hardest tasks.

### Treatment-only wins (11)
`django-11815, django-12273, django-12325, django-12774, django-13112, django-13590,
matplotlib-24627, matplotlib-25960, requests-1724, xarray-6938, sympy-15875`. Notably
django-13112 (T \$0.87 vs B \$3.02) and matplotlib-24627 (T \$0.75 vs B \$3.03) are wins where
the baseline thrashed to the cap — context kept treatment cheap and correct.

### Baseline-only losses (9)
`django-15572, django-15695, django-16938, requests-5414, xarray-6599, sympy-12419,
sympy-13974, sympy-15599, sympy-24562`. Mechanisms: under-use of context (4), patch-quality
(3), cost/thrash cap-hits (sympy-12419, sympy-15599). 5 of 9 carry ≥1 off-target edit — a
weak over-anchoring signal worth watching but not the dominant driver.

### Both-fail clusters (21)
missing_second_gold 7, context_to_action_gap 6, under_use_of_context 3,
tool_loop_or_thrashing 3, wrong_required_pivot 2.

### No-patch / exhaustion (4)
`astropy-14598` (\$3.00 cap), `django-15503` (\$3.04 cap), `django-13513` (fail-closed),
`django-10973` (skipped/quota). Three of four are budget/loop driven.

### Cost outliers / cap-hits
6 runs at the ~\$3 cap — `django-15503, sympy-15599, django-16263, pylint-4551, sympy-12419,
astropy-14598` — **0 resolved**. 7th outlier `pytest-6197` (\$1.75) actually resolved (genuine
hard task, not a loop). The cap is a near-perfect failure predictor here.

## Recurring Weakness Clusters

### Cluster 1 — Cost-cap exhaustion & tool-loop thrashing  *(top treatment failure)*
- **Cases:** 6 cap-hits (0 resolved) + 9 thrashing (overlapping): `django-15503, django-16263,
  sympy-12419, sympy-15599, pylint-4551, astropy-14598, sphinx-7748, pytest-6197(passed),
  django-13112(baseline side)`.
- **Symptoms:** `repeated_file_reads` up to 10, tool calls up to 44, cost pinned at the cap.
- **Likely cause:** the **agent harness** (turn loop), not VTRACE retrieval — context is
  injected once; the loop is what spins.
- **Harness surface:** `tool_loop_guard` / `cost_guard`.
- **Candidate:** C1 / C7 — detect repeated reads / consecutive failed calls / soft-budget
  fraction and inject a one-line "edit, rule out, or move on" advisory + stop-and-commit.
- **Validation risk:** low — fires only on degenerate runs that resolve at 0% anyway.
- **Offline validation:** yes (signals already captured). **Live:** small frozen subset to
  confirm changed trajectory.

### Cluster 2 — Missing second gold file *(multi-file fixes)*
- **Cases (7):** `astropy-14369, django-13195, django-13512, django-16256, matplotlib-24870,
  seaborn-3187, sphinx-7462, sympy-16597` (sphinx-7462 corroborated by prior analysis: gold
  needs `pycode/ast.py`; a `python.py`-only patch can never resolve).
- **Symptoms:** single-file or subset edit on a multi-file gold task.
- **Likely cause:** **shared** — retrieval may surface only one pivot; the agent also does not
  probe for a coupled second site.
- **Harness surface:** `patch_policy`.
- **Candidate:** C3 multi-gold/second-file advisory.
- **Validation risk:** medium — phrasing must not leak gold; risk of over-editing single-file
  tasks. **Not ready** without an offline phrasing-leak guard.

### Cluster 3 — Context-to-action gap
- **Cases (6):** `astropy-14365, django-11820, django-16667, matplotlib-26466, requests-1921,
  pytest-10051`.
- **Symptoms:** full coverage, patch produced, tests still fail.
- **Likely cause:** **agent** reasoning/precision; context was present and used.
- **Harness surface:** `patch_policy` / `verification_policy`.
- **Candidate:** C4 commit-or-rule-out transition; C8 pre-submit verification.
- **Validation risk:** low-medium; design overlaps existing pivot-inspection contract.

### Cluster 4 — Under-use of context
- **Cases (3 primary + appears as secondary in 4 baseline-only):** `django-14792,
  sphinx-9711, sympy-20428`.
- **Symptoms:** required pivot inspected but neither edited nor ruled out.
- **Harness surface:** `decision_contract_policy`. **Candidate:** C4.

### Cluster 5 — No-patch exhaustion
- **Cases (4):** see above. **Harness surface:** `failure_recovery_policy` / `cost_guard`.
- **Candidate:** C2 recovery prompt / C6 required-artifact-early. Overlaps Cluster 1.

### Cluster 6 — Baseline-only losses (regression watch)
- **Cases (9):** sympy-heavy. **Cause:** mostly the same mechanisms (thrash, under-use,
  patch-quality) rather than a distinct "context misled me" signal; off-target edits present
  in 5/9 but never the sole cause. **Action:** treat as the regression-guard population for
  any candidate, not a standalone fix target.

## Candidate Harness Interventions

Proposals only — none implemented. Full fields in `stage5_m74_candidate_harness_edits.json`.

| id | title | surface | cluster | expected effect | risk | ready? |
|---|---|---|---|---|---|---|
| **C1** | Repeated-failure / repeated-read tool-loop guard | tool_loop_guard | 1 | fewer cap-hits, lower tool calls on degenerate runs | low | **yes** |
| C7 | Budget-aware stop-and-commit cost guard | cost_guard | 1 | caps cost on degenerate runs | low | yes (≈ stop half of C1) |
| C2 | No-patch exhaustion recovery prompt | failure_recovery_policy | 5 | converts empty-exhaustion into a scored diff | low-med | yes |
| C4 | Context-to-action transition (commit-or-rule-out) | decision_contract_policy | 3,4 | fewer inspect-only-then-fail runs | low-med | no (design) |
| C3 | Multi-gold / second-file action prompt | patch_policy | 2 | more complete multi-file patches | medium | no (leak guard) |
| C5 | Exploration→implementation transition rule | failure_recovery_policy | 1 | earlier first edit | medium | no (⊂ C1) |
| C6 | Required-artifact-early policy | artifact_policy | 5 | never empty at exhaustion | low | no (⊂ C2) |
| C8 | Verification failure recovery rule | verification_policy | 3 | converts patch-quality fails | medium | no (cost risk) |

## Self-Harness-lite Validation Protocol

### Splits (frozen before any edit is run)
- **Held-in mining split:** the cluster-specific failing subset the candidate targets (e.g.
  for C1: the 9 thrash + 6 cap-hit instances). Used to confirm the targeted metric improves.
- **Validation / promotion split:** the full frozen 100-task census, paired against the
  existing M73 baselines, used for the no-regression decision.
- **Final untouched audit split:** none reserved today (the census is fully consumed). Until a
  fresh held-out batch exists, promotion is **provisional** and external claims stay barred —
  this is itself a preregistered limitation.
- **Fixed task lists, same model/scaffold class** (`claude-opus-4-5` family, shared stage5
  tool-use discipline), **same cost/turn caps**, **paired comparison**, **cost/token guard**.

### Acceptance rule (all six must hold)
1. Validation resolution does **not** regress (treatment resolved ≥ current on held-out).
2. Held-in targeted failure metric **improves** (e.g. cap-hits / repeated_reads drop).
3. Validation targeted failure metric does **not** regress.
4. Cost does **not** regress beyond the predefined threshold (for a guard: pooled cost must be
   ≤ current; the guard is expected to *reduce* cost).
5. No validity / sentinel / patch-safety invariant fails (no rise in invalid or off-target).
6. **Changed-behavior evidence**: artifacts show the edit actually fired and altered the
   intended mechanism (e.g. the guard triggered and the tool-call trajectory changed).

### Rejection rule
- Resolution drops materially (> 1 net paired loss on held-out).
- Cost explodes.
- Invalid / no-patch cases increase.
- Improvement is only via benchmark-specific leakage (e.g. gold-shaped phrasing).
- Changed-behavior evidence is absent (can't prove the mechanism moved).

### Changed-behavior evidence requirement
Every candidate must emit a deterministic, replayable signal proving it acted — a guard-fired
flag, a pre/post tool-call delta, an injected-marker count — captured in run meta so the
miner can re-verify offline.

## Recommended M75

- **Chosen next step:** **B — implement the repeated-failure / repeated-read tool-loop guard
  (Candidate C1)**, default-**OFF** behind a flag (`VTRACE_ENABLE_TOOL_LOOP_GUARD` /
  equivalent), advisory + stop-condition only.
- **Why:** it is the smallest, most general, fully offline-detectable intervention; it targets
  the largest clean cluster (9 thrash + 6 cap-hits with **0/6 cap-hits resolving**, so there is
  almost no resolution to lose); changed-behavior evidence (repeated-read count, cap-hit count,
  tool-call trajectory) is directly measurable on the existing traces; and it touches **no**
  retrieval / scoring / ranking / candidate generation / prompt-of-substance / decision
  contract, so it cannot contaminate the M73 benchmark claim. It also subsumes candidates C5,
  C6, and the stop half of C7. (Option A — miner-only — is effectively already delivered by
  this M74 audit and its three JSON artifacts; option B is the first *behavioral* step.)
- **Non-goals for M75:** do not change retrieval/scoring/ranking/candidate generation; do not
  promote to default; do not run Stage A/B/C again; do not make external benchmark claims; keep
  the guard default-off until the acceptance rule passes.
- **Validation gate:** preregister the held-in (thrash/cap-hit) and held-out (full 100) splits;
  run the guard only on a small frozen subset first; require all six acceptance criteria,
  including changed-behavior evidence, before even a default-off "confirmed" status — and keep
  external claims barred until a fresh untouched audit split exists.

---

### Appendix — failing-task classification (34 unresolved)

| instance | repo | outcome | primary | secondary | conf | T cost |
|---|---|---|---|---|---|---|
| astropy-14365 | astropy | both_fail | context_to_action_gap | — | medium | $0.34 |
| astropy-14369 | astropy | both_fail | wrong_required_pivot | missing_second_gold | medium | $0.70 |
| astropy-14598 | astropy | invalid/skipped | no_patch_exhaustion | cost_explosion, thrashing | high | $3.00 |
| django-10973 | django | invalid/skipped | quota_or_infra_abort | — | high | $0.00 |
| django-11820 | django | both_fail | context_to_action_gap | — | medium | $0.38 |
| django-13195 | django | both_fail | missing_second_gold | — | medium | $0.32 |
| django-13512 | django | both_fail | wrong_required_pivot | missing_second_gold | medium | $0.26 |
| django-13513 | django | invalid/skipped | no_patch_exhaustion | patch_quality_failure | high | $0.51 |
| django-14792 | django | both_fail | under_use_of_context | over_anchor_on_context | medium | $0.66 |
| django-15503 | django | invalid/skipped | no_patch_exhaustion | cost_explosion, thrashing | high | $3.04 |
| django-15572 | django | baseline_only | baseline_only_loss | under_use_of_context | high | $0.38 |
| django-15695 | django | baseline_only | baseline_only_loss | patch_quality_failure | high | $0.68 |
| django-16256 | django | both_fail | missing_second_gold | — | medium | $0.45 |
| django-16263 | django | both_fail | tool_loop_or_thrashing | cost_explosion, missing_second_gold | medium | $3.02 |
| django-16667 | django | both_fail | context_to_action_gap | — | medium | $0.48 |
| django-16938 | django | baseline_only | baseline_only_loss | missing_second_gold, under_use_of_context | high | $0.57 |
| matplotlib-24870 | matplotlib | both_fail | missing_second_gold | over_anchor_on_context | medium | $0.51 |
| matplotlib-26466 | matplotlib | both_fail | context_to_action_gap | — | medium | $0.40 |
| seaborn-3187 | mwaskom | both_fail | missing_second_gold | — | medium | $0.45 |
| requests-1921 | psf | both_fail | context_to_action_gap | — | medium | $0.69 |
| requests-5414 | psf | baseline_only | baseline_only_loss | under_use_of_context | high | $0.32 |
| xarray-6599 | pydata | baseline_only | baseline_only_loss | under_use_of_context | high | $0.96 |
| xarray-6992 | pydata | both_fail | missing_second_gold | — | medium | $0.32 |
| pylint-4551 | pylint-dev | both_fail | tool_loop_or_thrashing | cost_explosion, missing_second_gold, over_anchor | medium | $3.01 |
| pytest-10051 | pytest-dev | both_fail | context_to_action_gap | — | medium | $0.38 |
| sphinx-7462 | sphinx-doc | both_fail | missing_second_gold | — | medium | $0.37 |
| sphinx-7748 | sphinx-doc | both_fail | tool_loop_or_thrashing | over_anchor_on_context | medium | $0.67 |
| sphinx-9711 | sphinx-doc | both_fail | under_use_of_context | — | medium | $0.38 |
| sympy-12419 | sympy | baseline_only | baseline_only_loss | cost_explosion, thrashing | high | $3.00 |
| sympy-13974 | sympy | baseline_only | baseline_only_loss | patch_quality_failure | high | $0.44 |
| sympy-15599 | sympy | baseline_only | baseline_only_loss | cost_explosion, thrashing | high | $3.02 |
| sympy-16597 | sympy | both_fail | missing_second_gold | over_anchor_on_context | medium | $0.34 |
| sympy-20428 | sympy | both_fail | under_use_of_context | over_anchor_on_context | medium | $0.62 |
| sympy-24562 | sympy | baseline_only | baseline_only_loss | patch_quality_failure | high | $0.65 |
