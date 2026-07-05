# Stage 5 M106 24-Case Live Confirmation — Pre-run Plan

Date: 2026-07-06. Written BEFORE any M106 live agent run. This plan
pre-registers the M105 reuse contract, the 10-case extension selection, the
commands, flags, validity rules, stop conditions, the aggregation method, and
the criterion-12 resolution floor.

Scope reminder: M106 extends the committed M105 small live confirmation (PASS,
`fb791b0`) from 14 to 24 cases. It is NOT a benchmark, NOT VEXP parity, NOT a
baseline rerun, NOT a guard experiment.

## 1. M105 artifacts exist and are REUSED

Confirmed at HEAD (`02e4094`): `stage5_m105_small_live_confirmation.{md,json,csv}`,
`stage5_m105_live_preflight.detail.json`, `stage5_m105_live_runs.detail.json`
are committed (`fb791b0`). The M106 collector reads the committed
`stage5_m105_live_runs.detail.json` case rows back verbatim (validated by
`toM105CaseRow`, which rejects shape drift) and re-aggregates them as-is.
Nothing about the M105 rows is recomputed from raw artifacts and nothing M105
is re-run.

## 2. M105 cases are NOT rerun

The 14 M105 case ids are the hard exclusion set of the selection
(`excluded_m105_cases` in `stage5_m106_case_selection.json`), and
`aggregateCombined` THROWS on any instance_id overlap between the M105 and
M106 row sets, so an accidental rerun cannot aggregate silently. The M106
driver only knows the 10 extension ids.

## 3. The exact 10 additional cases

Selected deterministically (see §4) and frozen in
`stage5_m106_case_selection.json` BEFORE any live run, in run order
(Phase A = first 3):

| # | phase | instance_id | stratum | M103 | M73 treat | M73 base | M92 | holdout | multi-file |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A | astropy__astropy-7166 | eg_hist_resolved | good | ✓ | ✓ | ✓ | no | no |
| 2 | A | django__django-11815 | eg_hist_resolved | good | ✓ | ✗ | ✓ | no | no |
| 3 | A | astropy__astropy-14365 | eg_hist_unresolved | excellent | ✗ | ✗ | ✗(in M92, unresolved) | no | no |
| 4 | B | django__django-15695 | eg_hist_unresolved | excellent | ✗ | ✓ | ✗(in M92, unresolved) | yes | no |
| 5 | B | matplotlib__matplotlib-24870 | partial_wrong_pivot | wrong_pivot | ✗ | ✗ | ✗(in M92, unresolved) | no | yes |
| 6 | B | pydata__xarray-6992 | partial_wrong_pivot | wrong_pivot | ✗ | ✗ | — (not in M92) | no | yes |
| 7 | B | matplotlib__matplotlib-24970 | miss | miss | ✓ | ✓ | ✓ | no | no |
| 8 | B | pylint-dev__pylint-4551 | miss | miss | ✗ | ✗ | ✗(in M92, unresolved) | no | yes |
| 9 | B | pydata__xarray-6938 | multi_file | excellent | ✓ | ✗ | ✓ | no | yes |
| 10 | B | sphinx-doc__sphinx-7748 | holdout | excellent | ✗ | ✗ | ✗(in M92, unresolved) | yes | no |

6 repos; 9/10 have M92 rows; 10/10 have valid M73 treatment rows; 10/10 have
M103 clean indexed workspaces on disk and rows in the swe-bench-100 dataset.

## 4. Deterministic selection method (run before any live result)

`run_stage5_m106_case_selection.ts` over FROZEN committed inputs only:
pool = the 100 `stage5_m103_deterministic_scoreboard.detail.json` rows with
`generation_status=scored`, minus the 14 M105 ids (no other exclusion was
needed — all 86 remaining rows are scored with valid M73 rows and workspaces).
Strata in order: 2× excellent/good + M73-treatment resolved; 2× excellent/good
+ M73-treatment unresolved; 2× partial/wrong_pivot; 2× miss (the M103
scoreboard has NO `lexical_mismatch` class — `miss` is the deterministic
substitution for the prompt's "miss/lexical_mismatch" stratum); 1× multi-file;
1× holdout (M95 dev/holdout split file). Within a stratum: cases with an M92
run-matrix row first, then instance_id ascending; a repo already holding ≥2
M106 selections is skipped where practical (relaxed only on stratum
shortfall; none occurred). Algorithm is the pure `selectM106Cases` in
`run_stage5_m106_lib.ts` (unit-tested). **No replacements**: there is NO
backup list; an infrastructure-blocked case is marked invalid with the reason
and NOT replaced. Operational retries (provider/infra aborts only, M92
abort-regex, never after a result row exists): max 4 across the milestone.

## 5. Exact runner command(s)

One sequential guarded live run per instance (the first pass writes the SHARED
`results/_agent_stream.jsonl`), driven by `run_stage5_m106_driver.sh` (copy of
the M105 driver with the M106 case list/labels; per-case gate on the M106
preflight):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances "<instance_id>" \
  --run-label "m106_live_ext_<safe_instance_id>" \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --inject-capsule-digest \
  --digest-decision-contract \
  --bounded-digest-decisions \
  --compact-digest-injection \
  --pivot-confidence-gate \
  --stage5-env-guard \
  --stage5-env-drift-check \
  --expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench \
  --stage5-agent-shell-guard \
  --stage5-host-pip-firewall \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

Docker evaluation (separate phase, per label):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --eval-dataset /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl \
  --run-label "m106_live_ext_<safe_instance_id>" \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## 6. Flags that guarantee the current default VTRACE treatment

Byte-identical to the M105/M92 clean-core treatment flag set
(`M105_TREATMENT_CONTEXT_ARGV`): `--protocol vtrace-indexed --capsule-engine v2
--capsule-intent debug --capsule-budget 8000 --context-policy force-inject
--inject-capsule-digest --digest-decision-contract --bounded-digest-decisions
--compact-digest-injection --pivot-confidence-gate`. Structured task
derivation is the M103/M104 default at HEAD (no flag). PIVOT_CHECK stays at
its default `strict_risk_gated` policy. CLI `--help` at HEAD confirms the flag
names are unchanged since M105 (HEAD differs from the M105 commit only by the
ledger record `02e4094`).

## 7. Flags that keep V4 / C7_D / revision / corrective arms off

By OMISSION (the runner's default-off contract): no `--tool-loop-guard*` (V4),
no `--cost-guard*` (C7_D), no `--pivot-inspection-enforcement`, no
`--pivot-revision-pass` (M14/M15), no `--ruleout-sufficiency-*`, no
`--pivot-check-gate`. Preflight re-asserts this on the PARSED config
(`forbiddenArmsOn`); post-run validity re-asserts no `tool_loop_guard_*` /
`cost_guard_*` metadata and no `_pivot_revision*` / `_ruleout_sufficiency*`
artifacts (`assessRunValidity`, unchanged from M105).

## 8. Flags that guarantee env/shell guard safety

`--stage5-env-guard --stage5-env-drift-check --expected-testbed-prefix
/home/calvin/miniforge3/envs/vexp_swebench` (M89 mandatory, fails closed
pre-spawn) + `--stage5-agent-shell-guard --stage5-host-pip-firewall` (M90A
mandatory). `--allow-unguarded-live-env` is NEVER passed; any
`stage5_unguarded_live_env_allowed=true` metadata = invalid run + milestone
stop.

## 9. Flags that ensure no VEXP or fresh baseline arm runs

`--protocol vtrace-indexed` only; `--allow-vexp` never passed (vexp is
impossible without it); `--protocol baseline|all` and `--mode run-baseline`
never used. The driver hard-codes the protocol.

## 10. Fallback-section detection

Preflight: the v2 capsule CLI must exit 0 with a v2-parseable non-error
classification (a would-be fallback = preflight failure, no spawn). Post-run
(authoritative): `_run.meta.json` must show requested == effective == "v2" and
`vtraceCapsuleEngineFallbackReason == null` (`detectFallbackFire`). Any
v2→legacy fire makes the run parity-invalid (M104 residual: the legacy
fallback query packs FAIL_TO_PASS); >1 fire stops the milestone.

## 11. Model-visible leakage check before each live run

`run_stage5_m106_preflight.ts` (thin M106 wrapper over the M105 preflight's
`runCase`, same treatment argv) rebuilds per case the EXACT model-visible
context over the M103 clean indexed workspace — runner's own
`buildCapsuleV2Task` → v2 capsule CLI → `classifyCapsuleOutput` with
digest/contract/bounded/compact/confidence-gate + DB-backed digest enrichment
→ cost-aware gate + force-inject → `buildVtraceContextMarkdown` — and scans it
with the M104 leak scanner (FAIL_TO_PASS ids, PASS_TO_PASS ids, gold-patch
literal + non-trivial gold added lines, forbidden markers, full-problem echo)
with base-commit provenance annotation. Any UNEXPLAINED hit fails preflight
for that case; the agent is never spawned. Post-run, the actually-injected
`_vtrace_instructions.snapshot.md` is re-scanned identically (collector).

## 12. Parity check with M103/M104 structured task derivation

Per case, preflight asserts: `buildCapsuleV2Task` equals
`deriveStructuredTaskFromProblemStatement(problemStatement).taskText`; its
text equals the FROZEN M103 detail row and its derivation diagnostics match
the M103 row. The 10 M106 cases were not in the M104 smoke, so there is no
frozen M104 hash for them — the M104-hash check is vacuous-null for these
cases (exactly as the M105 preflight already models it); the binding parity
anchors are the shared-derivation identity and the frozen M103 row. The
structured task sha256 is recorded per case as the M106 frozen hash.

## 13. Stop condition on parity/leakage/safety failure

STOP the milestone (no further agent spawns) and write the report if ANY of:
preflight task-parity or leakage failure on a scheduled case; any UNEXPLAINED
model-visible leakage hit (pre- or post-run); >1 v2→legacy fallback fire (1
fire = that case invalid); env guard fail / drift detected / shell guard
unavailable / any `--allow-unguarded-live-env` use; any host pip/conda
mutation ESCAPE (a blocked attempt is recorded and the case is invalid unless
the block is proven harmless and no patch was produced); Phase A checks fail;
extension live spend exceeds **$10** before all 10 cases finish (prompt-set
pause cap; historical M73-treatment cost on this exact 10-case set is $7.97,
with pylint-4551 a $3.00 outlier) — pause, report "pause due cost/token
concern". Normal agent failure (bad/no patch, unresolved) does NOT stop.

Phase A = astropy__astropy-7166, django__django-11815, astropy__astropy-14365
(the first 3 in pre-registered selection order). Gate to Phase B: 3/3
preflight parity clean, 3/3 env+shell guard clean, 0 fallback fires, 0 leakage
fires, 0 host-mutation attempts, artifacts parse, valid patch or valid
no-patch outcomes.

## 14. Valid live run definition

Identical to M105 (`assessRunValidity`): preflight passed before spawn;
`swebench-*.jsonl` row exists and parses (no-patch outcomes are valid);
`_run.meta.json` parses with `vtraceContextInjected=true`, requested =
effective = v2, fallback reason null; env guard pass + benchmark-valid, shell
guard pass, no unguarded escape, no drift,
`stage5_blocked_host_package_command_count=0` (nonzero → invalid unless proven
harmless AND no patch produced); no behavioral-guard metadata; no
revision/corrective artifacts; post-run leak re-scan clean.

## 15. Aggregation of M105 (14) + M106 (10) into the 24-case result

`run_stage5_m106_collect.ts` collects the 10 M106 runs into case rows exactly
as M105 did (same `extractResultRowMetrics`/`assessRunValidity`), reads the 14
committed M105 case rows back from `stage5_m105_live_runs.detail.json` via
`toM105CaseRow` (shape-validated, never recomputed), and reports THREE
aggregates with the same `aggregateM105` reducer: M106-extension-only (n=10),
M105-committed (n=14, must reproduce the committed aggregate), combined
(n=24). `aggregateCombined` throws on any instance_id overlap.

## 16. Historical comparison rows

Per case: M73 treatment + baseline (`stage5_m73_final_100_paired.detail.json`,
all 10 present), M92 clean-core (run-matrix, 9/10 present — xarray-6992 is not
in the M92 50-split), M103 deterministic outcome (all 10), M105 result for the
combined set. **Pre-registered criterion-12 floor** (defined NOW): historical
M73-treatment expectation is 4/10 on the extension (astropy-7166,
django-11815, matplotlib-24970, xarray-6938) and 6+4 = **10/24 combined**.
Combined resolution is "catastrophically below historical expectation" iff
combined resolved count < 5 over ≥21 valid evaluated runs (the same
half-expectation rule M105 pre-registered). If fewer than 21 runs are valid,
the prorated floor is `ceil(valid_count * 0.2)`.

## Budget

Historical M73 treatment cost on the 10 selected: $7.97. Expected M106
extension spend: $6–10 live + Docker eval (no API cost). Hard pause at $10
extension live cost (prompt-set). No per-instance cost-cap flag exists on the
runner (the external vexp harness owns the per-task cap); caps are NOT raised.

## Outputs

- `stage5_m106_case_selection.json` (this selection, frozen pre-run)
- `stage5_m106_live_preflight.detail.json` (compact preflight diagnostics)
- `stage5_m106_live_runs.detail.json` (per-run validity/metrics + combined aggregates)
- `stage5_m106_24_case_live_confirmation.{md,json,csv}`
- New helper scripts + unit tests for the pure selection/reuse/aggregation
  logic only (no brittle tests over raw live output).
