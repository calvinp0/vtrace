# Stage 5 M105 Small Live Confirmation — Pre-run Plan

Date: 2026-07-05. Written BEFORE any live agent run. This plan pre-registers the
commands, flags, case set, validity rules, stop conditions, and the historical
floor for success criterion 10.

Scope reminder: this is a small uncontrolled live confirmation of the current
default VTRACE path after M95–M104. It is NOT a benchmark, NOT VEXP parity, NOT
a baseline rerun, NOT a guard experiment.

## 1. Exact runner command(s)

One sequential guarded live run per instance (first pass writes the SHARED
`results/_agent_stream.jsonl`, so runs are strictly sequential), driven by
`run_stage5_m105_driver.sh` (new; modeled on the M92 driver):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances "<instance_id>" \
  --run-label "m105_small_live_<safe_instance_id>" \
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

Docker evaluation (separate phase, after live runs; per label):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --eval-dataset /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl \
  --run-label "m105_small_live_<safe_instance_id>" \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## 2. Flags that guarantee the current default VTRACE treatment

`--protocol vtrace-indexed --capsule-engine v2 --capsule-intent debug
--capsule-budget 8000 --context-policy force-inject --inject-capsule-digest
--digest-decision-contract --bounded-digest-decisions
--compact-digest-injection --pivot-confidence-gate` — byte-for-byte the M92
clean-core treatment flag set (see `run_stage5_m92_driver.sh`), which is the
M92+ chain default the prompt requires ("inject capsule digest: enabled if
current clean-core protocol uses it"). Structured task derivation is the M103
default at HEAD (`buildCapsuleV2Task` delegates to
`deriveStructuredTaskFromProblemStatement`, M104 commit `4ca4948`); no flag
needed. PIVOT_CHECK stays at its default `strict_risk_gated` policy exactly as
in M92 (no `--disable-pivot-check`, matching the last live validation).

## 3. Flags that keep V4 / C7_D / revision / corrective arms off

By OMISSION, which is the runner's default-off contract: no `--tool-loop-guard*`
(V4), no `--cost-guard*` (C7_D), no `--pivot-inspection-enforcement`, no
`--pivot-revision-pass` (M14/M15), no `--ruleout-sufficiency-*`, no
`--pivot-check-gate`. An unflagged run runs no guard and emits no `*_guard_*`
metadata; the revision pass hard-requires `--pivot-inspection-enforcement`.
Post-run assertion: `_run.meta.json` contains no `tool_loop_guard_*` /
`cost_guard_*` fire metadata and no `_pivot_revision*` /
`_ruleout_sufficiency*` artifacts exist under the run's raw dir.

## 4. Flags that guarantee env/shell guard safety

`--stage5-env-guard --stage5-env-drift-check --expected-testbed-prefix
/home/calvin/miniforge3/envs/vexp_swebench` (M89 mandatory: the run fails
closed before agent spawn without them) plus `--stage5-agent-shell-guard
--stage5-host-pip-firewall` (M90A mandatory, default-on, passed explicitly).
`--allow-unguarded-live-env` is NEVER passed; if any run metadata shows
`stage5_unguarded_live_env_allowed=true` the run is invalid and the milestone
stops.

## 5. Flags that ensure no VEXP or fresh baseline arm runs

`--protocol vtrace-indexed` runs only the vtrace arm; `--allow-vexp` is never
passed (vexp is impossible without it); `--protocol baseline|all` is never
used; `--mode run-baseline` is never used. The driver hard-codes the protocol.

## 6. Fallback-section detection

- Preflight (no-agent): the v2 capsule CLI must exit 0 with a v2-parseable,
  non-error classification for every case (a would-be `EngineQueryError` =
  preflight failure for that case).
- Post-run (authoritative): `_run.meta.json` must show
  `vtraceRequestedCapsuleEngine == "v2" == vtraceEffectiveCapsuleEngine` and
  `vtraceCapsuleEngineFallbackReason == null`. Any v2→legacy fallback fire
  makes the run **parity-invalid** (M104 residual: the legacy fallback query
  still packs FAIL_TO_PASS into retrieval). Fallback fires are counted in
  `fallback_fire_count` and the affected case is excluded from valid results.

## 7. Model-visible leakage check before each live run

`run_stage5_m105_preflight.ts` (new, no-agent, reuses the M104 smoke
primitives) rebuilds, per case, the EXACT model-visible context of the M105
command: the runner's own `buildCapsuleV2Task` → `buildVtraceQueryCommand`
(intent debug, budget 8000) over the pre-existing M103 clean indexed workspace
→ `classifyCapsuleOutput` with the M105 digest/contract/bounded/compact/
confidence-gate options and the DB-backed digest-enrichment provider (mirroring
the live `runEngineQuery` wiring) → cost-aware v2 gate + `force-inject`
override → `buildVtraceContextMarkdown` with the live options (pivot-check
`strict_risk_gated`, edit-guard/patch-verify/token-discipline on). The
assembled markdown is scanned with the M104 leak scanner (FAIL_TO_PASS ids,
PASS_TO_PASS ids, gold-patch literal + non-trivial gold added lines, forbidden
markers, full-problem echo) with base-commit provenance annotation; any
UNEXPLAINED hit fails preflight for that case and the agent is not spawned.
Post-run, the actually-injected `_capsule_v2_context.md` in the run's raw dir
is re-scanned with the same scanner as a belt-and-braces check.

## 8. Parity check with M103/M104 structured task derivation

Per case, preflight asserts ALL of:
- `buildCapsuleV2Task(instance)` equals
  `deriveStructuredTaskFromProblemStatement(problemStatement).taskText`;
- its sha256 equals the FROZEN M104 hash
  (`stage5_m104_live_context_smoke.detail.json` → `structured_task_hash`);
- its text equals the FROZEN M103 detail row
  (`stage5_m103_deterministic_scoreboard.detail.json` →
  `derivation.task_text`);
- derivation diagnostics (chars / exceptions / failing tests / traceback
  frames) match the M103 row.
Any mismatch = preflight failure for that case, no agent spawn.

## 9. Case set and rationale

The 14 M104 smoke cases exactly (`SMOKE_CASE_IDS` in
`run_stage5_m104_live_context_smoke.ts`) — they already have frozen
task-parity/leakage expectations. One ID substitution vs the prompt (reported):
the prompt's `xarray__xarray-4695` is canonically **`pydata__xarray-4695`** in
the dataset and all M103/M104 artifacts.

psf__requests-5414 (issue-authored provenance policy), django__django-13513 /
matplotlib__matplotlib-22719 / pydata__xarray-4695 (M103 regression guards),
psf__requests-1724, sympy__sympy-13372, sympy__sympy-13480,
django__django-16938 (M103 wins/lateral incl. holdout), django__django-13810
(unchanged holdout miss), astropy__astropy-14369 (multi-file co-edit recovery),
django__django-16256 (import-reexport recovery), django__django-13195
(file-evidence rescue), mwaskom__seaborn-3187, sphinx-doc__sphinx-7462
(cross-repo / long-chain). All 14 have M103 clean indexed workspaces on disk.

**No replacements**: there is NO backup list. A case that cannot run for
infrastructure reasons is marked invalid with the reason and NOT replaced.
Operational retries (provider/infra aborts only, M92 abort-regex, never after a
result row exists): max 4 across the whole milestone.

## 10. Stop conditions

STOP the milestone (no further agent spawns) and write the report if ANY of:
- any preflight task-parity or leakage failure on a case scheduled to run;
- any UNEXPLAINED model-visible leakage hit (pre- or post-run);
- any v2→legacy fallback fire (that case is invalid; >1 fire = stop);
- env guard fail / env drift detected / shell guard unavailable / any use of
  `--allow-unguarded-live-env`;
- any host pip/conda mutation ESCAPE (a blocked attempt is recorded; the case
  is invalid unless the block is proven harmless and no patch was produced);
- Phase A checks fail (see below);
- cumulative live cost exceeds $20 (≈3× the $6.70 M73-treatment historical
  cost on this exact set) — pause, report "pause due cost/token concern".
Normal agent failure (bad patch, no patch, unresolved) does NOT stop the run.

Phase A = psf__requests-5414, django__django-13513, django__django-16256,
sphinx-doc__sphinx-7462. Gate to Phase B: 4/4 preflight parity clean, 4/4
env+shell guard clean, 0 fallback fires, 0 leakage fires, 0 host-mutation
attempts, artifacts parse, valid patch or valid no-patch outcomes.

## 11. Valid live run definition

A live-attempted case is VALID iff ALL of:
- preflight parity + leakage passed for the case before spawn;
- `swebench-*.jsonl` result row exists and parses (modelPatch may be empty —
  a no-patch outcome is valid);
- `_run.meta.json` parses with `vtraceContextInjected=true`, requested =
  effective = v2, `vtraceCapsuleEngineFallbackReason=null`;
- `stage5_env_guard_status=pass`, `stage5_agent_shell_guard_status=pass`,
  `stage5_unguarded_live_env_allowed=false`, no drift detected,
  `stage5_blocked_host_package_command_count=0` (nonzero → invalid unless
  proven harmless AND no patch produced);
- no `tool_loop_guard_*`/`cost_guard_*` fire metadata, no revision/corrective
  artifacts;
- post-run leak re-scan of `_capsule_v2_context.md` has 0 unexplained hits.

## 12. Historical comparison rows

- M73 per-case treatment/baseline (`stage5_m73_final_100_paired.detail.json`):
  all 14 present; M73 treatment resolved **6/14** (matplotlib-22719,
  xarray-4695, requests-1724, sympy-13372, sympy-13480, django-13810), M73
  baseline 7/14.
- M92 clean-core (`stage5_m92_core_reduction50_validation.md` run matrix):
  7/14 overlap (requests-5414 ✗, requests-1724 ✓, django-16938 ✗,
  astropy-14369 ✗, django-16256 ✗, seaborn-3187 ✗, sphinx-7462 ✗) = 1/7.
- M103 deterministic outcomes + M104 preflight rows for all 14.

**Pre-registered criterion-10 floor** (defined NOW, before any run):
resolution is "catastrophically below historical expectation" iff resolved
count < 3 over ≥12 valid evaluated runs (historical M73-treatment expectation
on this exact set = 6/14 ≈ 43%; M92-observed live variance justifies a
half-expectation floor of 3/14 ≈ 21%). If fewer than 12 runs are valid, the
prorated floor is `ceil(valid_count * 0.2)`.

## Budget

Historical M73 treatment cost on this set: $6.70 total (max single case
$1.25). Expected M105 spend: $7–14 live + Docker eval (no API cost). Hard
pause at $20 cumulative live cost. No per-instance cost-cap flag exists on the
runner (the external vexp harness owns the per-task cap); caps are NOT raised.

## Outputs

- `stage5_m105_live_preflight.detail.json` (compact preflight diagnostics)
- `stage5_m105_live_runs.detail.json` (per-run validity/metrics join)
- `stage5_m105_small_live_confirmation.{md,json,csv}`
- New helper scripts + unit tests for the pure parsing/validity logic only
  (no brittle tests over raw live output).
