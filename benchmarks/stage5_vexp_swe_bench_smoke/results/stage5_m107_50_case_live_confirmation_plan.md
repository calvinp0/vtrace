# Stage 5 M107 — 50-Case Live Confirmation: Pre-Run Plan

Date: 2026-07-06. Written and committed to disk BEFORE any live agent run,
per the M107 brief. Numbered answers follow the brief's 19 plan questions.

## 1. M105 artifacts exist and will be reused

Confirmed present and committed (fb791b0):
`stage5_m105_small_live_confirmation.{md,json,csv}`,
`stage5_m105_live_preflight.detail.json`, `stage5_m105_live_runs.detail.json`.
The 14 M105 case rows are read back from `stage5_m105_live_runs.detail.json`
through the shape-validated `toM105CaseRow` adapter (M106 reuse contract) and
re-aggregated; the reaggregation must reproduce the committed aggregate
bit-identically. No M105 case is rerun.

## 2. M106 artifacts exist and will be reused

Confirmed present and committed (5043a63):
`stage5_m106_24_case_live_confirmation.{md,json,csv}`,
`stage5_m106_live_preflight.detail.json`, `stage5_m106_live_runs.detail.json`,
`stage5_m106_case_selection.json`. The 10 M106 extension case rows are read
back from `stage5_m106_live_runs.detail.json` through the same adapter, with
the same bit-identical reaggregation check. No M106 case is rerun.

## 3. No M105/M106 case is rerun

Three independent guards: (a) the M107 selection excludes all 24 committed ids
and the selection script throws if the M105/M106 committed sets overlap each
other; (b) the M107 preflight throws if any selected id appears in the
committed exclusion lists; (c) `aggregateCombined50` throws on ANY
instance_id overlap across the three sets, so an accidental rerun can never
aggregate silently. Accidental rerun of a committed case = FAIL.

## 4. The exact 26 additional cases

Frozen pre-run in `stage5_m107_case_selection.json`, in run order
(phase A = 1–5, B = 6–15, C = 16–26):

| # | ph | instance_id | stratum | M103 | M73-T |
|---|----|-------------|---------|------|-------|
| 1 | A | django__django-12273 | eg_hist_resolved | good | ✓ |
| 2 | A | django__django-12774 | eg_hist_resolved | good | ✓ |
| 3 | A | django__django-16569 | eg_hist_resolved | good | ✓ |
| 4 | A | matplotlib__matplotlib-25960 | eg_hist_resolved | excellent | ✓ |
| 5 | A | pallets__flask-5014 | eg_hist_resolved | good | ✓ |
| 6 | B | django__django-16667 | eg_hist_unresolved | excellent | ✗ |
| 7 | B | psf__requests-1921 | eg_hist_unresolved | excellent | ✗ |
| 8 | B | pydata__xarray-6599 | eg_hist_unresolved | excellent | ✗ |
| 9 | B | pytest-dev__pytest-10051 | eg_hist_unresolved | excellent | ✗ |
| 10 | B | django__django-16263 | partial | partial | ✗ |
| 11 | B | django__django-15503 | wrong_pivot | wrong_pivot | ✗ |
| 12 | B | django__django-10880 | wrong_pivot | wrong_pivot | ✓ |
| 13 | B | django__django-13512 | wrong_pivot | wrong_pivot | ✗ |
| 14 | B | django__django-15731 | wrong_pivot | wrong_pivot | ✓ |
| 15 | B | matplotlib__matplotlib-26466 | miss | miss | ✗ |
| 16 | C | pytest-dev__pytest-6197 | miss | miss | ✓ |
| 17 | C | sphinx-doc__sphinx-9698 | miss | miss | ✓ |
| 18 | C | sympy__sympy-15875 | miss | miss | ✓ |
| 19 | C | sympy__sympy-16597 | miss | miss | ✗ |
| 20 | C | pylint-dev__pylint-8898 | multi_file | miss | ✓ |
| 21 | C | django__django-12325 | multi_file | overpacked | ✓ |
| 22 | C | sphinx-doc__sphinx-9711 | holdout | good | ✗ |
| 23 | C | sympy__sympy-12419 | holdout | overpacked | ✗ |
| 24 | C | matplotlib__matplotlib-24627 | partial_sub_overpacked | overpacked | ✓ |
| 25 | C | sympy__sympy-24562 | partial_sub_overpacked | overpacked | ✗ |
| 26 | C | astropy__astropy-14598 | partial_sub_overpacked | overpacked | ✗ |

Notable coverage: sympy-12419 and pylint-8898 are two of the three standing
genuine live regressions from the M7.x line; django-16263 is the M78
edit-churn case.

## 5. Deterministic selection method (before running)

`selectM107Cases` (`run_stage5_m107_lib.ts`, pure + unit-tested; engine =
M106's `selectM106Cases`) over the frozen 100-case pool
(`stage5_m103_deterministic_scoreboard.detail.json`, generation_status=scored)
minus the 24 committed M105+M106 ids → 76 candidates. Strata in order:
5× M103 excellent/good + M73-treatment resolved, 4× excellent/good +
unresolved, 4× partial, 4× wrong_pivot, 5× miss, 2× multi-file not already
selected, 2× holdout not already selected. Ordering within a stratum: cases
with an M92 run-matrix row first, then instance_id ascending. Repo cap 6 on
pass 1; pass 2 relaxes only when a stratum is short (fired for wrong_pivot —
all 4 remaining wrong_pivot cases are django — and for multi_file, where only
1 non-django unselected candidate remained). **Documented deterministic
substitution**: the remaining pool holds only ONE outcome=partial case, so the
partial deficit (3) fills from outcome=overpacked — the single M103 failure
class the strata do not otherwise cover — with the same ordering rules and the
GLOBAL repo cap, stratum-tagged `partial_sub_overpacked`. No backup list; an
infrastructure-blocked case is marked invalid and NOT replaced. No case is
replaced after live results are seen.

## 6. Exact runner commands

Per instance, sequential (shared `_agent_stream.jsonl`), via
`run_stage5_m107_driver.sh` which gates each spawn on its preflight row:

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench --instances "<id>" \
  --run-label "m107_live_ext_<safe_id>" --show-vtrace-index-log \
  --context-policy force-inject --capsule-engine v2 --capsule-intent debug \
  --capsule-budget 8000 --inject-capsule-digest --digest-decision-contract \
  --bounded-digest-decisions --compact-digest-injection --pivot-confidence-gate \
  --stage5-env-guard --stage5-env-drift-check \
  --expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench \
  --stage5-agent-shell-guard --stage5-host-pip-firewall \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
# then, per label with a result row:
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker --vexp-swe-bench-dir "$VEXP" \
  --eval-dataset "$VEXP/data/swe-bench-100.jsonl" --run-label "<label>" --out "$OUT"
```

Operational-retry contract (M105/M106 semantics): a spawn-time provider/infra
abort (rate-limit/auth/network, no result row, no run meta) may be relaunched
as `<label>_retryN`, max 4 globally; agent failures are never retried.

## 7. Flags guaranteeing the current default VTRACE treatment

Byte-identical to `M105_TREATMENT_CONTEXT_ARGV` (the M92/M105/M106 clean-core
set): `--context-policy force-inject --capsule-engine v2 --capsule-intent
debug --capsule-budget 8000 --inject-capsule-digest --digest-decision-contract
--bounded-digest-decisions --compact-digest-injection
--pivot-confidence-gate`. The M95–M104 deterministic chain + M103 structured
task derivation + M104 live-path parity are the shipped defaults on HEAD — no
flag needed and none passed that would alter retrieval/derivation.

## 8. Flags keeping V4/C7_D/revision/corrective off

All are opt-in and OFF BY OMISSION: `--tool-loop-guard` (V4), `--cost-guard`
(C7_D), `--pivot-inspection-enforcement` (M12), `--pivot-revision-pass`
(M14/M15), ruleout-sufficiency — none passed. The preflight re-checks the
PARSED config (`forbiddenArmsOn`) so a flag-plumbing regression fails closed;
run validity re-checks post-hoc (behavioral-guard metadata or
revision/corrective artifacts ⇒ invalid).

## 9. Flags guaranteeing env/shell guard safety

`--stage5-env-guard --stage5-env-drift-check --expected-testbed-prefix
/home/calvin/miniforge3/envs/vexp_swebench --stage5-agent-shell-guard
--stage5-host-pip-firewall`. The M89 runCondition fails closed pre-spawn
without env guard + drift + prefix; `--allow-unguarded-live-env` is never
passed (its use = case invalid + milestone FAIL). The preflight
(`mandatoryGuardsOff`) fails if any mandatory guard is off in the parsed
config.

## 10. Flags ensuring no VEXP / fresh-baseline arm

`--allow-vexp` is never passed (runner refuses vexp without it); no baseline
protocol is invoked — the ONLY protocol used is `vtrace-indexed` under the
treatment flags above. `forbiddenArmsOn` re-checks `allowVexp` pre-spawn.

## 11. Fallback-section detection

Pre-spawn: the preflight rebuilds the exact capsule query and fails the case
if the v2 engine classification is an error (the only path that could take the
legacy FAIL_TO_PASS-packing fallback live). Post-run: `detectFallbackFire`
over `_run.meta.json` (requested ≠ v2, effective ≠ v2, or any fallback
reason) ⇒ the run is parity-INVALID (M104 residual). Any fallback fire in a
would-be-valid run breaches success criterion 6.

## 12. Model-visible leakage check before each live run

`run_stage5_m107_preflight.ts` (M105 `runCase` under the identical treatment
argv) assembles the EXACT model-visible context (digest + decision contract
ON) over the M103 clean indexed workspaces and scans for FAIL_TO_PASS /
PASS_TO_PASS test ids, gold-patch fragments and gold-added lines, hidden-test
/ scoring diagnostics, and full-problem-statement echoes — every raw hit needs
base-commit provenance (derivable from the workspace snapshot) or the case
FAILS preflight and is never spawned. Post-run, the collector re-scans the
actual injected `_vtrace_instructions.snapshot.md` with the same
provenance-classified scanner.

## 13. Parity with M103/M104 structured task derivation

Per case, the preflight requires: `uses_shared_derivation` (the live task
builder returns `deriveStructuredTaskFromProblemStatement(...).taskText`
verbatim), task text byte-equal to the frozen M103 detail row, derivation
diagnostics equal, and the structured-task sha256 recorded as the M107 frozen
hash. The 26 cases were not in the M104 smoke, so `m104_hash_match` is
vacuous-null (M105/M106 semantics — only `false` fails); the binding anchors
are the shared-derivation identity and the frozen M103 row.

## 14. Stop condition on parity/leakage/safety failure

STOP the milestone (no further agent spawns) and write the report if ANY of:
preflight task-parity or leakage failure on a scheduled case; any UNEXPLAINED
model-visible leakage hit (pre- or post-run); any v2→legacy fallback fire
(that case invalid; >1 fire stops the milestone); env guard fail / drift
detected / shell guard unavailable / any `--allow-unguarded-live-env` use; any
host pip/conda mutation ESCAPE (a blocked attempt is recorded and the case is
invalid unless the block is proven harmless and the run did not rely on the
blocked command); Phase A or Phase B cumulative checks fail; extension live
spend exceeds the pause cap (below). Normal agent failure (bad/no patch,
unresolved) does NOT stop.

Phase gates: after Phase A (cases 1–5): 5/5 preflight parity clean, 5/5
env+shell guard clean, 0 fallback, 0 leakage, 0 host-mutation attempts,
artifacts parse. After Phase B (cases 6–15): the same, cumulative 15/15, and
spend under cap or justified. Phase C (cases 16–26) only if both gates pass.

## 15. Valid live run definition

Identical to M105/M106 (`assessRunValidity`): preflight passed before spawn;
`swebench-*.jsonl` row exists and parses (a valid no-patch outcome counts as
definitively unresolved without Docker); `_run.meta.json` parses with
`vtraceContextInjected=true`, requested = effective = v2, fallback reason
null; env guard pass + benchmark-valid, shell guard pass, no unguarded
escape, no drift, 0 blocked host package-manager commands (nonzero → invalid
unless proven harmless AND the run did not rely on the blocked command); no
behavioral-guard metadata; no revision/corrective artifacts; post-run leak
re-scan clean.

## 16. Aggregation of M105 (14) + M106 (10) + M107 (26) into the 50-case result

`run_stage5_m107_collect.ts` collects the 26 M107 runs into case rows exactly
as M105/M106 did (same `extractResultRowMetrics`/`assessRunValidity`), reads
the 14 M105 rows and 10 M106 rows back from the committed detail JSONs via
`toM105CaseRow` (never recomputed; both reaggregations must reproduce the
committed aggregates), and reports FIVE aggregates with the same
`aggregateM105` reducer: M107-extension-only (n=26), M105-committed (n=14),
M106-committed (n=10), combined-24, combined-50. `aggregateCombined50` throws
on any instance_id overlap.

## 17. Historical comparison rows

Per case: M73 treatment + baseline (`stage5_m73_final_100_paired.detail.json`;
all 26 present), M92 clean-core (run-matrix; 21/26 present — 10880, 13512,
15731, pylint-8898, astropy-14598 are not in the M92 50-split), M103
deterministic outcome (all 26), and the committed M105/M106 results for the
combined sets. No fresh baseline arm is run.

## 18. Pre-registered historical expectation on the 50-case combined set

M73-treatment expectation: 13/26 on the M107 extension (the ✓ rows in §4) and
6 + 4 + 13 = **23/50 combined**. M92 overlap expectation: 9/21 on the
extension; combined M92-overlap expectation 4 + 9 = 13/37. **Criterion-12
floor** (same half-expectation rule M105/M106 pre-registered): combined
resolution is "catastrophically below historical expectation" iff combined
resolved count < ceil(0.5 × 23 × valid_evaluated/50) — i.e. **< 12 over ≥45
valid evaluated runs**; if fewer than 45 are valid, the prorated floor is
`ceil(valid_count × 0.23)`.

## 19. M107 extension spend pause cap

**$22** (prompt-set), checked after every case and at both phase gates: STOP
spawning if cumulative M107 extension live cost exceeds $22 before all 26
finish, and report "pause due cost/token concern" with the partial result.
Known tension, registered NOW: the M73-treatment historical cost on this
exact 26-case set is **$25.09** (django-15503 alone $3.04), so a cap-forced
early stop is plausible; M105 ran +14% vs its M73 cost, M106 −11%. The cap is
NOT raised; a cap-forced stop after ≥15 valid cases yields a MIXED partial
result per the brief. No per-instance cost-cap flag exists on the runner (the
external vexp harness owns the per-task turn cap); caps are NOT raised.

## Budget

Historical M73 treatment cost on the 26 selected: $25.09. Expected M107
extension spend: $18–25 live + Docker eval (no API cost). Hard pause at $22.

## Outputs

- `stage5_m107_case_selection.json` (frozen pre-run)
- `stage5_m107_live_preflight.detail.json` (compact preflight diagnostics)
- `stage5_m107_live_runs.detail.json` (per-run validity/metrics + the five aggregates)
- `stage5_m107_50_case_live_confirmation.{md,json,csv}`
- New helper scripts + unit tests for the pure selection/reuse/aggregation
  logic only (no brittle tests over raw live output).
