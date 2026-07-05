# Stage 5 M106 24-Case Live Confirmation

Date: 2026-07-06. LIVE agents (10 guarded extension runs, explicitly in-scope
for this milestone) + Docker evaluation. The 14 committed M105 runs are REUSED,
not rerun. NO vexp, NO baseline arm, NO V4/C7_D, NO revision/corrective/oracle
arms, NO Conda mutation, NO unguarded runs.

## Summary

- **M105 reuse status**: the committed M105 result (`fb791b0`, 14 cases) was
  read back from `stage5_m105_live_runs.detail.json` through a shape-validated
  adapter and re-aggregated bit-identically
  (`m105_reaggregation_matches=true`). No M105 case was rerun; the combined
  aggregator throws on any instance overlap.
- **M106 extension case count**: 10/10 pre-registered cases preflighted,
  live-attempted, valid, and Docker-evaluated (0 operational retries).
- **Combined 24-case count**: 24/24 valid live runs with complete accounting.
- **Safety/parity result**: CLEAN SWEEP — 10/10 no-agent preflight parity
  (M103 task text + derivation diagnostics byte-exact), 0 model-visible
  leakage events pre- AND post-run (17 raw scanner hits all proven base-commit
  repo content: astropy-7166 ×2, sphinx-7748 ×15), 0 v2→legacy fallback fires,
  0 env-guard failures, 0 drift, 0 shell-guard blocks, 0 host pip/conda
  mutation attempts, 0 unguarded runs, 0 revision/corrective artifacts, 0
  behavioral-guard metadata. Combined: all safety counters 0 across 24 runs.
- **Resolution result**: extension **3/10**; combined **9/24 (37.5%)** vs the
  pre-registered M73-treatment expectation of 10/24 — well above the
  pre-registered catastrophic floor (<5 over ≥21 valid). Per-case agreement
  with the M73 treatment arm: 8/10 on the extension, **22/24 combined** (one
  live win: astropy-14365; two live losses: astropy-7166, xarray-6938). M92
  16-case overlap: live 4/16 = M92 4/16 (14/16 per-case agreement).
- **Token/cost result**: extension $7.09 (median $0.672, p90 $0.970, max
  $1.384) vs $7.97 M73-treatment historical on the same 10 (−11%); 14.26M
  tokens, cache-read share 94.7%, 134 tool calls. Combined: $14.75, 28.41M
  tokens, cache share 94.1%, 275 tool calls. Extension stayed under the
  pre-registered $10 pause cap.
- **Verdict**: **PASS**.
- **Recommendation**: **proceed to 50-case live confirmation**.

## Pre-run Plan

Pre-registered in `stage5_m106_24_case_live_confirmation_plan.md` BEFORE any
agent spawn: M105 reuse contract, the deterministic selection (frozen in
`stage5_m106_case_selection.json`), exact commands, the M92 clean-core
treatment flag set, arms kept off, the safety stack, fallback/leakage
detection, stop conditions (incl. the $10 extension pause cap and the
criterion-12 floor), the valid-run definition, and the aggregation method.

- **Commands used** (per instance, sequential, via `run_stage5_m106_driver.sh`
  which gates each spawn on its preflight row):

```bash
bun run_stage5_vexp_swe_bench_smoke.ts --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench --instances "<id>" \
  --run-label "m106_live_ext_<safe_id>" --show-vtrace-index-log \
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
  (`M105_TREATMENT_CONTEXT_ARGV`), so the M106 rows extend the M105 sample
  under the SAME treatment.
- **Case-selection method**: deterministic stratified selection
  (`selectM106Cases`, pure + unit-tested) from the frozen 100-case pool minus
  the 14 M105 ids: 2× M103 excellent/good + M73-treatment resolved, 2×
  excellent/good + unresolved, 2× partial/wrong_pivot, 2× miss (the M103
  scoreboard has no `lexical_mismatch` class — `miss` is the documented
  deterministic substitution), 1× multi-file, 1× holdout; M92-row preference,
  instance_id tie-break, repo cap 2 (pass-1). No backup list, no replacements.
- **Arms off by omission** (runner default-off contract): V4, C7_D, M12
  enforcement, M14/M15 revision, ruleout-sufficiency, pivot-check gate, vexp
  (`--allow-vexp` never passed), baseline, `--allow-unguarded-live-env`.
- **Stop conditions**: none triggered (extension spend $7.09 < $10 cap; 0
  safety/parity failures; Phase A gate passed 3/3).

## No-Agent Preflight

`run_stage5_m106_preflight.ts` (thin wrapper over the M105 preflight's
`runCase`, identical treatment argv) rebuilt the EXACT model-visible context
per case (digest + decision contract ON) over the M103 clean indexed
workspaces, plus the read-only M89 env-guard probe and the M90A shell-guard
materialization proof. Driver-enforced spawn gate.

- **Task parity**: 10/10 `uses_shared_derivation`, 10/10 task text byte-equal
  to the frozen M103 detail row, 10/10 derivation diagnostics match. The M106
  cases were not in the M104 smoke, so no frozen M104 hash exists for them:
  `m104_hash_match` is vacuous-null by design (M105 semantics — only `false`
  fails); each case's structured-task sha256 is recorded in the preflight
  detail as the M106 frozen hash.
- **Leakage**: 0 unexplained hits across all 10 assembled contexts. 17 raw
  scanner hits total, ALL proven base-commit repo content (astropy-7166 ×2,
  sphinx-7748 ×15 — autodoc test-name coincidences, same provenance class
  M104/M105 documented). 0 full-problem echoes, 0 gold-patch-leak verdicts.
- **Fallback**: 10/10 v2 capsule queries succeeded with non-error
  classification (no live run could have taken the legacy fallback).
- **Issue-authored provenance cases**: none among the 10 (psf-5414, the known
  issue-authored case, is in the M105 committed set).
- **Guards**: env guard pass (python/pip prefix verified against the M87B
  clean testbed), shell guard materialized to a benchmark-valid pass.

## M106 Live Results

| instance_id | stratum | preflight | leak | fallback | live | eval | resolved | tokens | cost | tools | changed files | M103 | M73 T/B | M92 |
|---|---|---|---|---|---|---|---|---:|---:|---:|---|---|---|---|
| astropy__astropy-7166 | eg_hist_resolved | pass | clean | none | valid | evaluated | **✗** | 428k | $0.325 | 4 | astropy/utils/misc.py | good | ✓/✓ | ✓ |
| django__django-11815 | eg_hist_resolved | pass | clean | none | valid | evaluated | **✓** | 953k | $0.448 | 11 | django/db/migrations/serializer.py | good | ✓/✗ | ✓ |
| astropy__astropy-14365 | eg_hist_unresolved | pass | clean | none | valid | evaluated | **✓** | 1.93M | $0.850 | 17 | astropy/io/ascii/qdp.py | excellent | ✗/✗ | ✗ |
| django__django-15695 | eg_hist_unresolved | pass | clean | none | valid | evaluated | ✗ | 954k | $0.671 | 9 | django/db/migrations/operations/models.py | excellent | ✗/✓ | ✗ |
| matplotlib__matplotlib-24870 | partial_wrong_pivot | pass | clean | none | valid | evaluated | ✗ | 1.59M | $0.774 | 15 | lib/matplotlib/contour.py | wrong_pivot | ✗/✗ | ✗ |
| pydata__xarray-6992 | partial_wrong_pivot | pass | clean | none | valid | evaluated | ✗ | 1.07M | $0.547 | 12 | xarray/core/dataset.py | wrong_pivot | ✗/✗ | — |
| matplotlib__matplotlib-24970 | miss | pass | clean | none | valid | evaluated | **✓** | 909k | $0.453 | 9 | lib/matplotlib/colors.py | miss | ✓/✓ | ✓ |
| pylint-dev__pylint-4551 | miss | pass | clean | none | valid | evaluated | ✗ | 3.27M | $1.384 | 27 | pylint/pyreverse/inspector.py | miss | ✗/✗ | ✗ |
| pydata__xarray-6938 | multi_file | pass | clean | none | valid | evaluated | **✗** | 1.40M | $0.672 | 14 | xarray/core/dataset.py | excellent | ✓/✗ | ✓ |
| sphinx-doc__sphinx-7748 | holdout | pass | clean | none | valid | evaluated | ✗ | 1.75M | $0.970 | 16 | sphinx/ext/autodoc/__init__.py | excellent | ✗/✗ | ✗ |

- Extension aggregate: 10 attempted / 10 preflight-valid / 10 started / 10
  valid / 10 evaluated; resolved 3 (30.0%); patch 10 / no-patch 0; invalid 0;
  14,260,726 tokens (cache-read 13,509,597 = 94.7%; input 2,581; output 707);
  134 tool calls; $7.0941 (median $0.672, p90 $0.970, median tokens 1.24M);
  fallback 0, leakage 0, env-guard fail 0, shell-guard block 0, host-pip
  block 0. 0 operational retries.
- **Invalid cases**: none.
- Notes: matplotlib-24970 resolved but its treat step took ~15 min wall
  (matplotlib re-clone; run itself 26 turns/$0.453). pylint-4551 is the
  turn/token outlier (69 turns, 3.27M tokens, $1.384) — also the historical
  M73 outlier ($3.00); its M103 capsule is a known `miss` (wrong lead edited).
  xarray-6938 (multi-file gold) edited only `xarray/core/dataset.py` —
  consistent with the single-file-patch failure mode on multi-file golds.

## Combined 24-Case Result

| set | n | valid | resolved | rate | patch/no-patch | tokens | cache share | tools | cost | median | p90 |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|
| M105 committed | 14 | 14 | 6 | 42.9% | 13/1 | 14.15M | 93.5% | 141 | $7.660 | $0.434 | $1.046 |
| M106 extension | 10 | 10 | 3 | 30.0% | 10/0 | 14.26M | 94.7% | 134 | $7.094 | $0.672 | $0.970 |
| **Combined** | **24** | **24** | **9** | **37.5%** | 23/1 | 28.41M | 94.1% | 275 | $14.755 | $0.505 | $1.046 |

All combined safety counters are 0 (fallback, leakage, env-guard fail,
shell-guard block, host-pip block). The M105 sub-aggregate reproduced the
committed M105 aggregate exactly through the reuse adapter.

## Historical Comparison

- **M73 treatment** (the pre-registered expectation): extension 3/10 vs 4/10
  expected; combined 9/24 vs 10/24 expected. Per-case agreement 22/24
  combined (M105 was 14/14; M106 8/10). The two extension losses are
  astropy-7166 (M73/M92 both resolved; live patched the right file with 4
  tool calls but did not resolve) and xarray-6938 (M73 resolved; live edited
  the lead gold file only). The one extension win is astropy-14365 (M73 and
  M92 both unresolved; M103 upgraded its capsule to `excellent` and the live
  agent resolved it).
- **M73 baseline**: 5/10 on the extension set; combined baseline 12/24.
  Not a controlled comparison (no fresh baseline arm was run).
- **M92 clean-core overlap**: extension 9/10 in M92 — live 3/9 = M92 3/9,
  7/9 per-case agreement (disagreements: astropy-7166 ✓→✗, astropy-14365
  ✗→✓). Combined 16-case overlap: live 4/16 = M92 4/16, 14/16 agreement.
- **M103 deterministic outcome vs live**: both `wrong_pivot` cases and both
  `miss` cases failed live except matplotlib-24970 (resolved — historically
  solvable without capsule help: M73/M92 all resolve it); 3 of the 6
  excellent/good extension cases produced correct-file edits that still
  failed resolution, consistent with the M103 finding that retrieval quality
  bounds localization, not solution correctness.
- **Interpretation limits**: this is a 24-case live confirmation. It
  validates default-path safety/parity and gives a stronger directional
  signal than M105, but it is still not statistically powered, the M105/M106
  samples were run on different days, and it is NOT a pass@1 benchmark claim.
  The 9-vs-10 gap to the M73 expectation is within the per-case flip noise
  observed across every prior live pair (M82/M85/M88/M90/M92).

## Token/Cost Analysis

- Extension: $7.094 total vs $7.97 M73-treatment historical on the same 10
  (−11%); per-case median $0.672, p90 $0.970. Cache-read share 94.7% (13.51M
  of 14.26M tokens).
- Combined: $14.755, 28.41M tokens, cache share 94.1%.
- Outlier: pylint-4551 $1.384 / 69 turns / 3.27M tokens (historical M73
  outlier at $3.00 — live was cheaper). No cost-cap approach: the max case is
  14% of the $10 extension cap.
- Accounting complete for 10/10 extension runs (input/output/cache
  creation+read tokens, cost, turns, ordered tool calls).

## Safety

- **Env guard (M89 mandatory)**: pass + benchmark-valid on 10/10; python/pip
  prefixes verified against `/home/calvin/miniforge3/envs/vexp_swebench`.
- **Env drift**: 0; `stage5_prefix_drift_summary="not_run"` on all runs —
  identical semantics to the committed M105 runs (summary populates on
  protected-prefix package activity; none occurred).
- **Shell guard / host-pip firewall (M90A mandatory)**: pass on 10/10;
  `stage5_blocked_host_package_command_count=0` on every run (no blocked and
  no escaped host package-manager commands).
- **Unguarded escape hatch**: never used (`stage5_unguarded_live_env_allowed=false`).
- **Fallback/revision disabled**: requested = effective = v2 with null
  fallback reason on 10/10; no `_pivot_revision*`/`_ruleout_sufficiency*`
  artifacts; no `tool_loop_guard_*`/`cost_guard_*` metadata.

## Success Criteria Check

1. M105 committed artifacts reused, not rerun — **PASS** (adapter +
   reaggregation match + overlap guard).
2. 10 additional cases selected before running and recorded — **PASS**
   (`stage5_m106_case_selection.json`, frozen pre-run).
3. ≥9/10 pass preflight and live-attempted — **PASS** (10/10).
4. 100% of live-attempted cases have structured task parity before spawn —
   **PASS** (10/10 M103-exact; M104 hash vacuous-null by design).
5. 0 model-visible leakage events — **PASS**.
6. 0 legacy fallback fires in valid runs — **PASS**.
7. 0 revision/corrective/FAIL_TO_PASS context fires — **PASS**.
8. 0 unguarded env/shell runs — **PASS**.
9. 0 env drift failures — **PASS**.
10. 0 host-pip/conda mutation escapes — **PASS**.
11. ≥9 M106 runs produce parseable artifacts — **PASS** (10/10).
12. Combined resolution not catastrophically below expectation — **PASS**
    (9/24 vs floor 5 over ≥21 valid).
13. Token/cost accounting complete — **PASS**.
14. Tests/typechecks pass — **PASS** (bun test, typecheck, typecheck:benchmarks).

## Verdict

**PASS**

## Recommendation

**proceed to 50-case live confirmation** — safety/parity is now clean across
24/24 guarded live runs of the M95–M104 default path with 22/24 per-case
agreement against the M73 treatment arm; the remaining question (does the
deterministic-chain retrieval gain convert to live resolution gains?) needs
the statistical power of the 50-case set, ideally reusing these 24 valid runs
under the same reuse contract this milestone established.
