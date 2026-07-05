# Stage 5 M105 Small Live Confirmation

Date: 2026-07-05. LIVE agents (14 guarded runs, explicitly in-scope for this
milestone) + Docker evaluation. NO vexp, NO baseline arm, NO V4/C7_D, NO
revision/corrective/oracle arms, NO Conda mutation, NO unguarded runs.

## Summary

- **Case count**: 14/14 (the M104 smoke set; Phase A pilot 4 + Phase B 10).
  One ID substitution vs the prompt: `xarray__xarray-4695` →
  canonical **`pydata__xarray-4695`**.
- **Safety/parity result**: CLEAN SWEEP — 14/14 no-agent preflight parity
  (M103/M104 task hashes byte-exact), 0 model-visible leakage events (pre- AND
  post-run scans with base-commit provenance), 0 v2→legacy fallback fires,
  0 env-guard failures, 0 drift, 0 shell-guard blocks, 0 host pip/conda
  mutation attempts, 0 unguarded runs, 0 revision/corrective artifacts.
- **Resolution result**: **6/14 resolved (42.9%)** — equal to the historical
  M73-treatment expectation on this exact set (6/14), and **14/14 per-case
  agreement with the M73 treatment arm** (the same six cases resolve, the same
  eight fail). M92 overlap (7 cases): M105 1/7 = M92 1/7, 7/7 per-case
  agreement (requests-1724 the sole resolver in both).
- **Token/cost result**: $7.66 total (median $0.434/case, p90 $1.05, max
  $1.19), 14.15M total tokens, cache-read share 93.5%, 141 tool calls.
  Historical M73-treatment cost on the same set: $6.70 (+14%, within noise for
  n=14 with one 72-turn outlier). Well under the pre-registered $20 pause cap.
- **Verdict**: **PASS**.
- **Recommendation**: **proceed to 24-case live confirmation**.

## Pre-run Plan

Pre-registered in `stage5_m105_small_live_confirmation_plan.md` BEFORE any
agent spawn: exact commands, the M92 clean-core treatment flag set, the arms
kept off, the safety stack, fallback/leakage detection, the fixed no-backup
case set, stop conditions (incl. the $20 cost pause and the criterion-10 floor
of ≥3 resolved), and the valid-run definition.

- **Commands used** (per instance, sequential, via `run_stage5_m105_driver.sh`
  which gates each spawn on its preflight row):

```bash
bun run_stage5_vexp_swe_bench_smoke.ts --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench --instances "<id>" \
  --run-label "m105_small_live_<safe_id>" --show-vtrace-index-log \
  --context-policy force-inject --capsule-engine v2 --capsule-intent debug \
  --capsule-budget 8000 --inject-capsule-digest --digest-decision-contract \
  --bounded-digest-decisions --compact-digest-injection --pivot-confidence-gate \
  --stage5-env-guard --stage5-env-drift-check \
  --expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench \
  --stage5-agent-shell-guard --stage5-host-pip-firewall --out "$OUT"
# then, per label:
bun run_stage5_vexp_swe_bench_smoke.ts --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir "$VEXP" --eval-dataset "$VEXP/data/swe-bench-100.jsonl" \
  --run-label "<label>" --out "$OUT"
```

- **Treatment**: byte-identical to the M92 clean-core flag set (last live
  validation), so the ONLY delta vs M92 is the M95–M104 deterministic chain at
  HEAD — most visibly the M103/M104 structured task derivation now feeding
  live retrieval and the digest echo.
- **Arms off by omission** (runner default-off contract): V4, C7_D, M12
  enforcement, M14/M15 revision, ruleout-sufficiency, pivot-check gate, vexp
  (`--allow-vexp` never passed), baseline, `--allow-unguarded-live-env`.
- **Stop conditions**: none triggered.

## No-Agent Preflight

`run_stage5_m105_preflight.ts` (new; reuses the M104 smoke primitives) rebuilt
the EXACT model-visible context per case under the M105 flags — including the
injected digest + bounded decision contract, which the M104 smoke (digest off)
could not scan — over the M103 clean indexed workspaces, plus a read-only M89
env-guard probe and an M90A shell-guard materialization proof.

- **Task parity**: 14/14 `uses_shared_derivation`, 14/14 sha256 == frozen M104
  `structured_task_hash`, 14/14 text == frozen M103 detail rows, 14/14
  derivation diagnostics match. Gate: a case only spawns if its preflight row
  passed (driver-enforced).
- **Leakage**: 0 unexplained hits across all 14 assembled contexts (digest +
  contract ON). 8 raw scanner hits total, ALL proven base-commit repo content
  (sphinx-7462 ×4, django-16256 ×2, django-13513 ×1, sympy-13372 ×1 — the same
  provenance classes M104 documented). 0 full-problem echoes, 0
  FAIL_TO_PASS/PASS_TO_PASS/gold-patch/marker content, 0 gold-patch-leak
  blocks.
- **Fallback**: v2 capsule succeeded 14/14 (no case would take the
  FAIL_TO_PASS-bearing legacy fallback).
- **psf__requests-5414 provenance**: task names `requests/models.py` because
  the ISSUE does; `assessGoldLeakage` = `issue_authored_gold_path` (allowed +
  diagnosed), 0 blocks; lead pivot = `requests/models.py` matching M103.
- **Bonus**: lead pivot under the live CLI (intent debug) matched the M103
  scoreboard on 14/14; digest + decision-contract sentinels present 14/14.
- Detail: `stage5_m105_live_preflight.detail.json` (summary.gate_pass=true).

## Live Results

Per-case (resolved / M73-treatment / M73-baseline for context; full row data in
`stage5_m105_live_runs.detail.json` + CSV):

| instance_id | M105 | M73_treat | M73_base | tokens | cache_read | cost $ | tools | changed files |
|---|---|---|---|---|---|---|---|---|
| psf__requests-5414 | ✗ | ✗ | ✓ | 932650 | 874441 | 0.550 | 10 | requests/models.py |
| django__django-13513 | ✗ | ✗ | ✗ | 2798505 | 2720696 | 1.187 | 29 | (none) |
| matplotlib__matplotlib-22719 | ✓ | ✓ | ✓ | 603170 | 539841 | 0.405 | 5 | lib/matplotlib/category.py |
| pydata__xarray-4695 | ✓ | ✓ | ✓ | 1504390 | 1414794 | 0.673 | 15 | xarray/core/dataarray.py |
| psf__requests-1724 | ✓ | ✓ | ✗ | 687802 | 636083 | 0.374 | 7 | requests/sessions.py |
| sympy__sympy-13372 | ✓ | ✓ | ✓ | 757636 | 704297 | 0.434 | 8 | sympy/core/evalf.py |
| sympy__sympy-13480 | ✓ | ✓ | ✓ | 490803 | 445458 | 0.301 | 5 | sympy/functions/elementary/hyperbolic.py |
| django__django-16938 | ✗ | ✗ | ✓ | 734160 | 679164 | 0.428 | 7 | django/core/serializers/python.py |
| django__django-13810 | ✓ | ✓ | ✓ | 698819 | 643414 | 0.433 | 7 | django/core/handlers/base.py |
| astropy__astropy-14369 | ✗ | ✗ | ✗ | 1782416 | 1680569 | 1.046 | 15 | astropy/units/format/cds.py |
| django__django-16256 | ✗ | ✗ | ✗ | 869307 | 784041 | 0.462 | 10 | django/db/models/fields/related_descriptors.py |
| django__django-13195 | ✗ | ✗ | ✗ | 695152 | 626970 | 0.399 | 7 | django/http/response.py |
| mwaskom__seaborn-3187 | ✗ | ✗ | ✗ | 903885 | 840170 | 0.551 | 9 | seaborn/_core/scales.py |
| sphinx-doc__sphinx-7462 | ✗ | ✗ | ✗ | 691786 | 638331 | 0.417 | 7 | sphinx/domains/python.py |

- **Aggregates**: attempted 14, preflight-valid 14, live-started 14, live-valid
  14, eval-completed 14 (13 Docker + 1 definitive no-patch counted
  unresolved), resolved 6 (42.9%), patches 13, no-patch 1, invalid 0.
- **Invalid cases**: none. One **operational retry** (1 of the pre-registered
  4): mwaskom__seaborn-3187's first launch died at agent spawn on the provider
  session limit (API 429, 0 tokens, no result row); relaunched after the reset
  window and completed clean. No case replacement occurred.
- django__django-13513 is the sole no-patch outcome (72 turns, $1.19, the cost
  outlier): the agent explored but declined to patch. It is the known M103
  facade-lead regression-guard case (`views/generic/__init__.py`); M73
  treatment also failed it (treatment_invalid_or_skipped).
- django__django-16256 edited the correct gold file
  (`related_descriptors.py`, the M99 import-reexport recovery) but the patch
  did not satisfy all FAIL_TO_PASS — same failure as both M73 arms and M92.

## Historical Comparison

- **M73 treatment (same 14 cases)**: 6/14 resolved — M105 6/14, with
  **14/14 per-case agreement**. The live default path behaves exactly like the
  last full-scale treatment measurement on this set.
- **M92 clean-core (7-case overlap)**: 1/7 (requests-1724) — M105 1/7, 7/7
  per-case agreement.
- **M73 baseline (same 14)**: 7/14; the two baseline-only wins (requests-5414,
  django-16938) remain unresolved under treatment, as in M73/M92.
- **M103 deterministic outcome vs live**: both `overpacked` capsules
  (matplotlib-22719, xarray-4695) still resolved; the `miss` case
  (django-13810) resolved anyway; three `excellent` capsules (13195, 3187,
  7462) did not resolve — on this set, capsule-quality labels are not
  resolution predictors for hard cases, consistent with M103's framing.
- **M104 preflight**: all 14 leak-clean there and here; the digest-on echo
  surface newly scanned in M105 stayed clean.
- **Interpretation limits**: this is a small uncontrolled live confirmation.
  It validates default-path safety/parity and gives a directional signal. It
  is not statistically powered and is NOT a pass@1 benchmark claim; per-case
  agreement with M73 is an observation, not a variance bound.

## Token/Cost Analysis

- Total $7.6604; median $0.4337, p90 $1.0457, max $1.1870.
- Tokens: 14,150,481 total; cache-read 13,228,269 (**93.5% share**);
  cache-creation ≈918.6K; fresh input 2,743; output 899. Median per-case
  tokens 745,898.
- Outliers: django-13513 ($1.19, 2.80M tokens, 29 tools, no patch) and
  astropy-14369 ($1.05, 1.78M, 15 tools, unresolved) — both historically hard;
  neither triggered the cost pause.
- vs M73 treatment on the same set ($6.70): +14% — consistent with normal live
  variance; no systematic cost regression from the M95–M104 chain.

## Safety

- **Env guard (M89)**: enabled + drift check on all 14; status=pass ×14,
  benchmark_valid ×14, prefix `/home/calvin/miniforge3/envs/vexp_swebench`
  (CLI-sourced), python/pip prefix verified ×14, no drift
  (`stage5_prefix_drift_summary` clean ×14).
- **Shell guard / host-pip firewall (M90A)**: enabled ×14, status=pass ×14,
  conda env scrubbed ×14, wrapper-bin pip resolution ×14,
  `stage5_blocked_host_package_command_count=0` ×14 (zero attempts — nothing
  to prove harmless).
- **No escape hatch**: `stage5_unguarded_live_env_allowed=false` ×14;
  `--allow-unguarded-live-env` never passed.
- **Fallback/revision disabled**: requested=effective=v2 with null fallback
  reason ×14; 0 `_pivot_revision*`/`_ruleout_sufficiency*` artifacts; 0
  behavioral `tool_loop_guard_*`/`cost_guard_*` metadata (arms unflagged).
- **Post-run leak re-scan**: `_vtrace_instructions.snapshot.md` of every run
  scanned with base-commit provenance — 0 unexplained hits; the digest
  `query_excerpt` echo is the structured issue-only task (the pre-M104
  `failing tests:`/`hints:` echo is verifiably gone from live artifacts).

## Success Criteria Check

1. ≥12 cases preflight-pass + live-attempted — **PASS** (14/14).
2. 100% task parity before agent start — **PASS** (14/14 hash+text+diag;
   driver-gated).
3. 0 model-visible leakage events — **PASS** (pre- and post-run).
4. 0 legacy fallback fires in valid runs — **PASS** (0/14).
5. 0 revision/corrective/FAIL_TO_PASS context fires — **PASS**.
6. 0 unguarded env/shell runs — **PASS**.
7. 0 env drift failures — **PASS**.
8. 0 host pip/conda mutation escapes — **PASS** (0 attempts).
9. ≥12 parseable run artifacts — **PASS** (14/14).
10. Resolution not catastrophically below historical expectation
    (pre-registered floor: ≥3 of ≥12 valid) — **PASS** (6; equals the
    M73-treatment expectation of 6).
11. Token/cost accounting complete — **PASS** (14/14).
12. Tests/typechecks pass — **PASS** (bun test 3550/0; tsc src + benchmarks
    clean; `git diff --check` clean).

## Verdict

**PASS**

## Recommendation

**Proceed to 24-case live confirmation.** The current default VTRACE treatment
is live-valid under the mandatory safety stack, task-parity-exact with the
M103 deterministic measurement, leak-clean under the digest-on clean-core
protocol, and directionally at historical resolution/cost parity. Residuals to
carry forward: the legacy fallback query still packs FAIL_TO_PASS (never fired
here; keep treating any fire as parity-invalid), and django-13513's
facade-lead no-patch outcome remains the pinned M103 regression-guard case
worth watching in any larger run.

## Artifacts

- Plan: `stage5_m105_small_live_confirmation_plan.md`
- Summary JSON: `stage5_m105_small_live_confirmation.json`
- Preflight detail: `stage5_m105_live_preflight.detail.json`
- Runs detail: `stage5_m105_live_runs.detail.json`
- CSV: `stage5_m105_small_live_confirmation.csv`
- New helpers: `run_stage5_m105_preflight.ts`, `run_stage5_m105_driver.sh`,
  `run_stage5_m105_collect.ts`, `run_stage5_m105_report_lib.ts` (+ 21 unit
  tests in `run_stage5_m105_report_lib.test.ts`)
