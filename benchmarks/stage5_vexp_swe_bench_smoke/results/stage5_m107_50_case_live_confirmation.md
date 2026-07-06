# Stage 5 M107 50-Case Live Confirmation

Date: 2026-07-06. LIVE agents (26 guarded extension runs, explicitly in-scope
for this milestone) + Docker evaluation. The 14 committed M105 runs and the 10
committed M106 runs are REUSED, not rerun. NO vexp, NO baseline arm, NO
V4/C7_D, NO revision/corrective/oracle arms, NO Conda mutation, NO unguarded
runs.

This is a 50-case live confirmation of the current default VTRACE path. It
validates safety/parity and gives a stronger directional signal. It is still
not a formal public pass@1 benchmark claim, and it is not a VEXP parity claim.

## Summary

- **M105/M106 reuse status**: both committed results (fb791b0 n=14, 5043a63
  n=10) were read back through the shape-validated `toM105CaseRow` adapter and
  re-aggregated bit-identically (`m105/m106/combined24_reaggregation_matches`
  all true). No committed case was rerun; the 50-case aggregator throws on any
  instance overlap.
- **M107 extension case count**: 26/26 pre-registered cases preflighted,
  live-attempted, valid, and evaluated (0 provider-abort retries; one external
  mid-run kill of django-10880's first launch, relaunched clean).
- **Combined 50-case count**: 50/50 valid live runs with complete accounting.
- **Safety/parity result**: CLEAN SWEEP — 26/26 no-agent preflight parity
  (M103 task text + derivation diagnostics byte-exact), **0 raw leak-scanner
  hits pre-run and 0 unexplained hits post-run** (cleaner than M105/M106,
  which had explained base-commit coincidences), 0 v2→legacy fallback fires,
  0 env-guard failures, 0 drift, 0 shell-guard blocks, 0 host pip/conda
  mutation attempts, 0 unguarded runs, 0 revision/corrective artifacts, 0
  behavioral-guard metadata. Combined: all safety counters 0 across 50 runs.
- **Resolution result**: extension **8/26 (30.8%)**; combined **17/50
  (34.0%)** vs the pre-registered M73-treatment expectation of 23/50 — above
  the pre-registered catastrophic floor (<12 over ≥45 valid) but 6 below the
  point expectation. Per-case agreement with the M73 treatment arm: 17/26 on
  the extension (2 live wins / 7 live losses), **39/50 combined**. M92
  overlap: extension live 5/21 vs M92 9/21 (17/21 agree); combined live 9/37
  vs M92 13/37 (31/37 agree). Notable: **sympy-12419 — one of the three
  standing M7.x live regressions — resolved live** (M73 treatment did not),
  and pylint-8898 (another of the three) also resolved.
- **Token/cost result**: extension $16.66 (median $0.526, p90 $1.013, max
  $3.008) vs $25.09 M73-treatment historical on the same 26 (−34%); 29.2M
  tokens, cache-read share 93.8%, 273 tool calls, 26/26 patches produced.
  Combined: $31.41 vs $39.76 historical (−21%), 57.6M tokens, cache share
  94.0%. Extension stayed under the pre-registered $22 pause cap.
- **Verdict**: **PASS** (all 15 pre-registered criteria; the resolution
  shortfall clears the floor and is the headline item for the next milestone).
- **Recommendation**: **proceed to 100-case live confirmation**, reusing
  these 50 valid runs under the artifact-reuse contract; the larger sample's
  job is to bound whether 17/50-vs-23/50 is live variance or a real gap.

## Pre-run Plan

Pre-registered in `stage5_m107_50_case_live_confirmation_plan.md` BEFORE any
agent spawn: the M105+M106 reuse contract, the deterministic selection (frozen
in `stage5_m107_case_selection.json`), exact commands, the M92 clean-core
treatment flag set, arms kept off, the safety stack, fallback/leakage
detection, phase gates, stop conditions (incl. the $22 extension pause cap and
the criterion-12 floor), the valid-run definition, and the aggregation method.

- **Commands used** (per instance, sequential, via `run_stage5_m107_driver.sh`
  which gates each spawn on its preflight row):

```bash
bun run_stage5_vexp_swe_bench_smoke.ts --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench --instances "<id>" \
  --run-label "m107_live_ext_<safe_id>" --show-vtrace-index-log \
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

- **Treatment**: byte-identical to the M105/M92 clean-core flag set
  (`M105_TREATMENT_CONTEXT_ARGV`), so the M107 rows extend the M105/M106
  sample under the SAME treatment.
- **Case-selection method**: deterministic stratified selection
  (`selectM107Cases`, pure + unit-tested) from the frozen 100-case pool minus
  the 24 committed ids: 5× M103 excellent/good + M73-treatment resolved, 4×
  excellent/good + unresolved, 4× partial, 4× wrong_pivot, 5× miss, 2×
  multi-file, 2× holdout; M92-row preference, instance_id tie-break, repo cap
  6 on pass 1 (pass-2 relaxation fired only where a stratum was exhausted:
  wrong_pivot is all-django in the remaining pool; multi_file had one
  non-django unselected candidate). **Documented substitution**: only 1
  outcome=partial case remained, so the deficit of 3 filled deterministically
  from outcome=overpacked (the one failure class the strata don't otherwise
  cover) under the GLOBAL repo cap, stratum-tagged `partial_sub_overpacked`.
  No backup list, no replacements after live results.
- **Arms off by omission** (runner default-off contract): V4, C7_D, M12
  enforcement, M14/M15 revision, ruleout-sufficiency, pivot-check gate, vexp
  (`--allow-vexp` never passed), baseline, `--allow-unguarded-live-env`.
- **Pre-registered historical expectation**: M73-treatment 13/26 on the
  extension, 6+4+13 = 23/50 combined; M92 overlap 9/21 extension; floor =
  catastrophic iff combined resolved < 12 over ≥45 valid.
- **Stop conditions**: none triggered (extension spend $16.66 < $22 cap; 0
  safety/parity failures; Phase A gate 5/5, Phase B cumulative gate 15/15).

## No-Agent Preflight

`run_stage5_m107_preflight.ts` (thin wrapper over the M105 preflight's
`runCase`, identical treatment argv) rebuilt the EXACT model-visible context
per case (digest + decision contract ON) over the M103 clean indexed
workspaces, plus the read-only M89 env-guard probe and the M90A shell-guard
materialization proof. Driver-enforced spawn gate.

- **Task parity**: 26/26 `uses_shared_derivation`, 26/26 task text byte-equal
  to the frozen M103 detail row, 26/26 derivation diagnostics match. The M107
  cases were not in the M104 smoke, so `m104_hash_match` is vacuous-null by
  design (M105/M106 semantics — only `false` fails); each case's
  structured-task sha256 is recorded in the preflight detail as the M107
  frozen hash.
- **Leakage**: 0 raw scanner hits across all 26 assembled contexts (M105 had
  8 explained hits, M106 had 17 — all base-commit coincidences; M107's
  contexts had none at all). 0 full-problem echoes, 0 gold-patch-leak
  verdicts. Post-run re-scan of every `_vtrace_instructions.snapshot.md`: 0
  unexplained hits.
- **Fallback**: 26/26 v2 capsule queries succeeded with non-error
  classification (no live run could have taken the legacy fallback).
- **Issue-authored provenance cases**: none among the 26 (psf-5414, the known
  issue-authored case, is in the M105 committed set).
- **Guards**: env guard pass (python/pip prefix verified against the M87B
  clean testbed), shell guard materialized to a benchmark-valid pass.

## M107 Live Results

| instance_id | ph | stratum | preflight | leak | fb | live | eval | resolved | cost | turns | tools | files | M103 | M73 T | M92 |
|---|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---|---|---|
| django__django-12273 | A | eg_hist_resolved | pass | clean | none | valid | evaluated | **✗** | $0.511 | 21 | 7 | 1 | good | ✓ | ✓ |
| django__django-12774 | A | eg_hist_resolved | pass | clean | none | valid | evaluated | **✗** | $0.586 | 39 | 13 | 1 | good | ✓ | ✓ |
| django__django-16569 | A | eg_hist_resolved | pass | clean | none | valid | evaluated | **✓** | $0.361 | 19 | 6 | 1 | good | ✓ | ✓ |
| matplotlib__matplotlib-25960 | A | eg_hist_resolved | pass | clean | none | valid | evaluated | **✗** | $0.784 | 50 | 18 | 1 | excellent | ✓ | ✗ |
| pallets__flask-5014 | A | eg_hist_resolved | pass | clean | none | valid | evaluated | **✓** | $0.382 | 22 | 8 | 1 | good | ✓ | ✓ |
| django__django-16667 | B | eg_hist_unresolved | pass | clean | none | valid | evaluated | ✗ | $0.301 | 13 | 4 | 1 | excellent | ✗ | ✗ |
| psf__requests-1921 | B | eg_hist_unresolved | pass | clean | none | valid | evaluated | ✗ | $0.346 | 14 | 4 | 1 | excellent | ✗ | ✗ |
| pydata__xarray-6599 | B | eg_hist_unresolved | pass | clean | none | valid | evaluated | ✗ | $0.556 | 25 | 8 | 1 | excellent | ✗ | ✗ |
| pytest-dev__pytest-10051 | B | eg_hist_unresolved | pass | clean | none | valid | evaluated | ✗ | $0.509 | 29 | 10 | 1 | excellent | ✗ | ✗ |
| django__django-16263 | B | partial | pass | clean | none | valid | evaluated | ✗ | $3.008 | 93 | 38 | 1 | partial | ✗ | ✗ |
| django__django-15503 | B | wrong_pivot | pass | clean | none | valid | evaluated | ✗ | $0.650 | 20 | 7 | 1 | wrong_pivot | ✗ | ✗ |
| django__django-10880 | B | wrong_pivot | pass | clean | none | valid | evaluated | **✓** | $0.189 | 14 | 4 | 1 | wrong_pivot | ✓ | — |
| django__django-13512 | B | wrong_pivot | pass | clean | none | valid | evaluated | ✗ | $0.356 | 20 | 7 | 1 | wrong_pivot | ✗ | — |
| django__django-15731 | B | wrong_pivot | pass | clean | none | valid | evaluated | **✓** | $0.341 | 15 | 5 | 1 | wrong_pivot | ✓ | — |
| matplotlib__matplotlib-26466 | B | miss | pass | clean | none | valid | evaluated | ✗ | $0.456 | 26 | 9 | 1 | miss | ✗ | ✗ |
| pytest-dev__pytest-6197 | C | miss | pass | clean | none | valid | evaluated | **✗** | $0.659 | 33 | 13 | 1 | miss | ✓ | ✗ |
| sphinx-doc__sphinx-9698 | C | miss | pass | clean | none | valid | evaluated | **✓** | $0.409 | 23 | 9 | 1 | miss | ✓ | ✓ |
| sympy__sympy-15875 | C | miss | pass | clean | none | valid | evaluated | **✗** | $1.013 | 37 | 15 | 1 | miss | ✓ | ✗ |
| sympy__sympy-16597 | C | miss | pass | clean | none | valid | evaluated | ✗ | $0.614 | 38 | 16 | 1 | miss | ✗ | ✗ |
| pylint-dev__pylint-8898 | C | multi_file | pass | clean | none | valid | evaluated | **✓** | $0.552 | 23 | 8 | 1 | miss | ✓ | — |
| django__django-12325 | C | multi_file | pass | clean | none | valid | evaluated | **✗** | $0.838 | 43 | 15 | 1 | overpacked | ✓ | ✓ |
| sphinx-doc__sphinx-9711 | C | holdout | pass | clean | none | valid | evaluated | ✗ | $0.349 | 19 | 6 | 1 | good | ✗ | ✗ |
| sympy__sympy-12419 | C | holdout | pass | clean | none | valid | evaluated | **✓ (win)** | $0.526 | 27 | 10 | 1 | overpacked | ✗ | ✓ |
| matplotlib__matplotlib-24627 | C | partial_sub_overpacked | pass | clean | none | valid | evaluated | **✗** | $0.526 | 28 | 12 | 2 | overpacked | ✓ | ✓ |
| sympy__sympy-24562 | C | partial_sub_overpacked | pass | clean | none | valid | evaluated | **✓ (win)** | $0.590 | 24 | 9 | 1 | overpacked | ✗ | ✓ |
| astropy__astropy-14598 | C | partial_sub_overpacked | pass | clean | none | valid | evaluated | ✗ | $1.248 | 32 | 12 | 2 | overpacked | ✗ | — |

- **Aggregate extension metrics** (n=26): attempted 26, preflight-valid 26,
  live-started 26, live-valid 26, eval-completed 26, resolved 8 (30.8%),
  patches 26 / no-patch 0, invalid 0, tokens 29.16M (cache-read 93.8%, input
  5k non-cache, output 2k... see detail JSON for exact fields), tool calls
  273, cost $16.66 (median $0.526, p90 $1.013), fallback 0, leakage 0,
  env-guard fails 0, shell-guard blocks 0, host-pip blocks 0.
- **Invalid cases**: none.
- **Operational events**: django-10880's first launch was killed externally
  mid-agent (~5 min in; no result row, no run meta, cost unrecorded); the
  partial run dir was removed and the case relaunched clean under the same
  label per the resumable-driver contract (ledgered). 0 provider-abort
  retries.

## Combined 50-Case Result

| set | n | valid | resolved | rate | cost | median | p90 | tokens | cache | tools | patches |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| M105 committed | 14 | 14 | 6 | 42.9% | $7.66 | $0.434 | $1.046 | 14.15M | 93.5% | 141 | 13 |
| M106 committed | 10 | 10 | 3 | 30.0% | $7.09 | $0.672 | $0.970 | 14.26M | 94.7% | 134 | 10 |
| M107 extension | 26 | 26 | 8 | 30.8% | $16.66 | $0.526 | $1.013 | 29.16M | 93.8% | 273 | 26 |
| combined 24 | 24 | 24 | 9 | 37.5% | $14.75 | $0.505 | $1.046 | 28.41M | 94.1% | 275 | 23 |
| **combined 50** | **50** | **50** | **17** | **34.0%** | **$31.41** | **$0.526** | **$1.013** | **57.58M** | **94.0%** | **548** | **49** |

## Historical Comparison

- **M73 treatment expectation**: 23/50 pre-registered; live 17/50. Per-case
  agreement 39/50 (M105 14/14, M106 8/10, M107 17/26). Extension wins (2):
  sympy-12419, sympy-24562 — both M103 `overpacked`, both resolved live.
  Extension losses (7): django-12273, django-12774, matplotlib-25960,
  pytest-6197, sympy-15875, django-12325, matplotlib-24627.
- **M73 baseline comparison**: on the 26 extension cases the M73 BASELINE
  (no-VTRACE) resolved 10/26 — live treatment 8/26 sits slightly BELOW the
  historical baseline on this slice by point estimate (M73 treatment was
  13/26 on the same slice). On the full 50 the M73 baseline resolved 20/50 vs
  M73 treatment 23/50; live is 17/50. All three gaps are 2–3 flips wide.
- **M92 overlap comparison**: extension live 5/21 vs M92 9/21 (17/21 agree);
  combined live 9/37 vs M92 13/37 (31/37 agree).
- **M103 deterministic outcome comparison**: live resolution by M103 class —
  excellent/good 3/11 (27%; the four eg_hist_unresolved excellent-capsule
  cases all stayed unresolved, as historically), partial 0/1, wrong_pivot 2/4
  (the two M73-resolved ones — capsule quality did not block them),
  miss 2/6, overpacked 3/6 incl. both live wins. Good capsules are currently
  necessary-ish but clearly not sufficient live; the win cluster inside
  `overpacked` suggests the deterministic overpacking label is not a live
  death sentence either.
- **Interpretation limits**: 50 guarded cases, one arm, no fresh baseline;
  M73 ran in March-April (different model snapshot/provider conditions).
  Losses concentrate in the M73-resolved strata, which is what regression to
  a lower live-day resolution rate looks like — but per-case agreement (39/50)
  and the M92 agreement (31/37) stay high, and the deltas are single-flip
  sized per stratum. The 100-case extension is the instrument for deciding
  variance vs real gap. Not a pass@1 claim; not VEXP parity.

## Token/Cost Analysis

- Extension: $16.66 total, median $0.526, p90 $1.013 — **−34%** vs the M73
  treatment historical $25.09 on the same 26 (driven by django-15503: $0.650
  live vs $3.04 historical). Combined 50: $31.41 vs $39.76 historical
  (−21%). Cache-read share 93.8% extension / 94.0% combined.
- Outlier: django-16263 at $3.008 / 93 turns / 38 tool calls — the known M78
  edit-churn case reproduced its churn signature live (historical M73 cost
  was $0.51; the churn is a live-agent behavior, not a context cost).
  Second-tier: astropy-14598 $1.248, sympy-15875 $1.013.
- The killed first django-10880 attempt has no accounting row (no result
  emitted); its relaunch cost $0.189 and is fully accounted.

## Safety

- **Env guard**: mandatory stack on for all 26 spawns; status pass +
  benchmark-valid 26/26; prefix drift check enabled, 0 drift.
- **Shell guard / host-pip firewall**: pass 26/26; 0 blocked host
  package-manager commands (nothing even attempted); 0 escapes.
- **Unguarded escape hatch**: never used.
- **Fallback/revision disabled**: 0 v2→legacy fallback fires (residual still
  unfixed, still counted parity-invalid if it ever fires); 0
  revision/corrective artifacts; 0 behavioral-guard (V4/C7_D) metadata;
  forbidden-arm check on the PARSED config passed pre-spawn.

## Success Criteria Check

1. M105+M106 reused, not rerun — **PASS** (bit-identical reaggregation).
2. 26 cases pre-registered before running — **PASS**.
3. ≥24/26 preflight-pass + live-attempted — **PASS** (26/26).
4. 100% task parity before spawn — **PASS** (26/26).
5. 0 model-visible leakage — **PASS**.
6. 0 fallback fires in valid runs — **PASS**.
7. 0 revision/corrective/FAIL_TO_PASS context — **PASS**.
8. 0 unguarded runs — **PASS**.
9. 0 drift — **PASS**.
10. 0 host mutation escapes — **PASS**.
11. ≥24 parseable run artifacts — **PASS** (26/26).
12. Combined resolution not catastrophically below expectation — **PASS**
    (17 ≥ floor 12; 6 below the 23/50 point expectation, flagged as the open
    question, floor cleared).
13. Token/cost accounting complete — **PASS**.
14. Spend under the $22 pause cap — **PASS** ($16.66).
15. Tests/typechecks — **PASS** (bun test suite, `typecheck`,
    `typecheck:benchmarks`, `git diff --check` all clean at commit).

## Verdict

**PASS**

## Recommendation

**Proceed to 100-case live confirmation**, reusing these 50 valid runs under
the artifact-reuse contract (M106/M107 adapter + overlap guard). The single
open question the larger sample must answer: is the 17/50-vs-23/50 shortfall
(losses concentrated in M73-resolved strata, agreement still 39/50) live-day
variance or a real live gap of the current default path; a fresh paired
baseline arm on the same day would be the decisive-but-costlier alternative.
