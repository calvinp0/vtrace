# Stage 5 M108 — 100-Case Live Confirmation: Pre-Run Plan

_Pre-registered 2026-07-07, BEFORE any M108 live agent run._

Goal: complete the 100-case live confirmation of the current default VTRACE
path (M95–M104 deterministic chain + M103/M104 structured task derivation +
M92/M105/M106/M107 clean-core live flag set) by REUSING the 50 committed valid
runs (M105 14 + M106 10 + M107 26) and running the REMAINING 50 preregistered
cases of the frozen 100-case pool. This is a live confirmation — not VEXP
parity, not a fresh-baseline comparison, not a behavioral-guard experiment,
and not a public SWE-bench pass@1 claim.

## The 20 pre-registered answers

1. **M105 artifacts exist and will be reused.** Committed at `fb791b0`:
   `stage5_m105_small_live_confirmation.{md,json}`,
   `stage5_m105_live_preflight.detail.json`,
   `stage5_m105_live_runs.detail.json` (aggregate: 14 valid, 6 resolved,
   $7.66, 0 leakage). Reuse = the M106/M107 contract: shape-validated adapter
   (`toM105CaseRow`), re-aggregation must be bit-identical to the committed
   aggregate, overlap-guarded against rerun.
2. **M106 artifacts exist and will be reused.** Committed at `5043a63`:
   `stage5_m106_24_case_live_confirmation.{md,json}`,
   `stage5_m106_live_preflight.detail.json`,
   `stage5_m106_live_runs.detail.json`, `stage5_m106_case_selection.json`
   (10 extension cases, 3 resolved, $7.09, 0 leakage). Same reuse contract.
3. **M107 artifacts exist and will be reused.** Committed at `1dc69b2`:
   `stage5_m107_50_case_live_confirmation.{md,json}`,
   `stage5_m107_live_preflight.detail.json`,
   `stage5_m107_live_runs.detail.json`, `stage5_m107_case_selection.json`
   (26 extension cases, 8 resolved, $16.66, 0 leakage; combined 17/50).
   Same reuse contract, extended to a triple: the M108 collector re-aggregates
   the committed M105/M106/M107 rows and requires bit-identical matches to
   the committed `m105`/`m106`/`m107`/`combined24`/`combined50` aggregates.
4. **No M105/M106/M107 case is rerun.** Triple protection: (a) the selection
   is the COMPLEMENT of the union of the three committed id sets over the
   frozen pool (overlap impossible by construction, and the selection script
   throws if the committed sets overlap each other); (b) the M108 preflight
   re-checks selection∩(M105∪M106∪M107)=∅ and refuses to emit a gate-pass
   otherwise; (c) `aggregateCombined100` throws on any duplicate instance_id
   across the four row sets.
5. **The exact 50 remaining cases** are frozen in
   `stage5_m108_case_selection.json` (this repo, written before any live
   run). Order 1–50 with phases: A = orders 1–8 (django-11820, django-13112,
   django-13590, django-14792, django-15572, requests-1142, xarray-2905,
   pytest-5262), B = 9–22, C = 23–36, D = 37–50. Full list in the JSON.
6. **Selection method**: deterministic complement, no sampling, no backup
   list — start from the frozen M103 100-case scoreboard
   (`stage5_m103_deterministic_scoreboard.detail.json`, all 100 rows
   `generation_status=scored` with derivation), exclude the 14 M105 + 10 M106
   + 26 M107 committed live ids, select EVERY remaining case. Complement is
   exactly 50 (verified; the script exits non-zero otherwise). Ordering:
   cases with an M92 run-matrix row first, then instance_id ascending (the
   M106/M107 tie-break). All 50 have clean indexed workspaces and
   swe-bench-100.jsonl rows. `django__django-10973` has NO valid M73
   treatment row (treatment skipped in M73 stage B) — it is a fully valid
   live case but carries no M73-treatment expectation.
7. **Runner commands** (identical to M107 except labels/ledger):
   `run_stage5_m108_driver.sh treat A|B|C|D` per phase, which invokes per case
   `bun run_stage5_vexp_swe_bench_smoke.ts --mode run-protocol --protocol
   vtrace-indexed --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench
   --instances <id> --run-label m108_live_ext_<safe_id> ...` with the flag set
   in (8)–(11); then `run_stage5_m108_driver.sh evaluate A|B|C|D` which runs
   `--mode evaluate --eval-mode docker --eval-dataset
   $VEXP/data/swe-bench-100.jsonl`. Runs are sequential (shared
   `_agent_stream.jsonl`).
8. **Default-treatment flags** (the M92/M105/M106/M107 clean-core set,
   byte-identical to `M105_TREATMENT_CONTEXT_ARGV`): `--context-policy
   force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget
   8000 --inject-capsule-digest --digest-decision-contract
   --bounded-digest-decisions --compact-digest-injection
   --pivot-confidence-gate`.
9. **Arms kept off by omission + preflight assertion**: no
   `--pivot-inspection-enforcement`, no `--pivot-revision-pass`, no
   `--ruleout-sufficiency-check`, no `--tool-loop-guard` (V4), no
   `--cost-guard` (C7_D). The preflight parses the exact treatment argv and
   fails if any forbidden arm is on (`forbiddenArmsOn`); the collector
   additionally marks a run invalid if revision artifacts or behavioral-guard
   metadata appear in its raw dir.
10. **Safety flags (mandatory)**: `--stage5-env-guard
    --stage5-env-drift-check --expected-testbed-prefix
    /home/calvin/miniforge3/envs/vexp_swebench --stage5-agent-shell-guard
    --stage5-host-pip-firewall`. No `--allow-unguarded-live-env` anywhere; if
    it appears, the run is invalid and the milestone stops.
11. **No VEXP / no fresh baseline**: no `--allow-vexp`, no baseline
    condition is ever passed (`--protocol vtrace-indexed`, vtrace condition
    only); `forbiddenArmsOn` asserts `allowVexp` off. Docker evaluate touches
    only the produced patches.
12. **Fallback detection**: pre-spawn, the preflight builds the v2 capsule
    with the exact treatment flags and fails the case if the CLI exits
    non-zero or classification errors (`v2_fallback_would_fire`). Post-run,
    `detectFallbackFire` over `_run.meta.json`
    (requested/effective engine + fallback reason) marks any fire
    parity-invalid (the M104 legacy-fallback residual still packs
    FAIL_TO_PASS).
13. **Leakage checks**: pre-spawn, the preflight assembles the EXACT
    model-visible markdown (task + capsule + digest + decision contract) and
    scans for FAIL_TO_PASS / PASS_TO_PASS / gold-patch content / gold added
    lines / full problem statement, classifying hits by base-commit
    provenance against the M103 clean workspace (M104 policy: only
    non-derivable hits fail). Post-run, the collector re-scans the actual
    `_vtrace_instructions.snapshot.md` the same way. Any unexplained hit ⇒
    invalid run + milestone FAIL.
14. **Task parity**: the preflight requires the live task
    (`buildCapsuleV2Task`) to be byte-identical to the shared M103 derivation
    (`uses_shared_derivation`) AND to the frozen M103 detail row text, with
    derivation diagnostics equal to the frozen row. The 50 M108 cases were
    not in the M104 smoke, so `m104_hash_match` is vacuous-null (as in
    M106/M107); the binding anchors are the shared-derivation identity and
    the frozen M103 row. Each case's structured-task sha256 is recorded as
    the M108 frozen hash.
15. **Stop conditions**: any preflight gate failure (parity, leakage,
    fallback, guards, forbidden arms) ⇒ the case is never spawned; if the
    GLOBAL gate fails ⇒ no case is spawned and a preflight-failure report is
    written. Mid-milestone: any unexplained model-visible leakage, any
    fallback fire in a live run, any env-guard/drift/shell-guard failure, any
    unguarded run, or any rerun of a committed case ⇒ STOP, report, do not
    continue phases.
16. **Valid live run** = preflight-passed before spawn AND `_run.meta.json`
    parses with env guard pass + benchmark-valid, shell guard pass, no
    unguarded escape, no drift, no host-pip blocks, no behavioral-guard
    metadata, no revision artifacts, v2 engine effective (no fallback),
    context injected, result row parses, and post-run snapshot leak-scan
    clean. (`assessRunValidity`, unchanged from M105/M106/M107.)
17. **Aggregation**: `run_stage5_m108_collect.ts` reads the committed
    M105/M106/M107 detail rows through the shape-validated adapter, re-checks
    bit-identical re-aggregation, then `aggregateCombined100` produces
    m105/m106/m107/m108/combined50/combined100 aggregates with the rerun
    guard. Per-set and combined metrics land in
    `stage5_m108_live_runs.detail.json` +
    `stage5_m108_100_case_live_confirmation.{md,json,csv}`.
18. **Historical comparison rows**: M73 treatment arm
    (`stage5_m73_final_100_paired.detail.json`), M73 baseline arm (same
    file), M92 clean-core overlap
    (`stage5_m92_core_reduction50_validation.md` run matrix; 13 of the 50
    remaining cases), M103 deterministic outcome, and the committed
    M105+M106+M107 combined-50 result (17/50).
19. **Pre-registered historical expectation**: M73-treatment on the M108
    extension = **43/50** (49 valid M73 treatment rows; django-10973 has
    none); M73-baseline on the extension = **44/50**; M92 overlap on the
    extension = **6/13**. Combined 100-case M73-treatment expectation =
    **66/100** (= the full M73 treatment arm; per-set: 6/14 + 4/10 + 13/26 +
    43/50). Combined M73-baseline = **64/100**. "Not catastrophically below"
    (success criterion 13) is pre-registered as: combined-100 resolved ≥
    floor(0.55 × 66) = **36/100**, mirroring the M106/M107 floor rule;
    NOTE the remaining-50 set is failure-depleted (prior extensions
    deliberately oversampled M103 failure strata), so live-vs-M73 per-case
    agreement and per-stratum deltas carry more meaning than the headline
    rate. The M107 open question (17/50 vs 23/50 = variance or gap?) gets
    its larger sample here.
20. **Pause cap**: M108 extension spend cap = **$45** (pre-registered).
    Historical M73-treatment cost on these exact 50 cases = $28.19, so $45
    covers ~1.6× historical. Checked after every phase (A/B/C/D) via
    `spendCapStatus`; if exceeded before all 50 finish ⇒ stop, report
    partial results, seek approval. Per-instance cap stays the Stage 5
    standard (runner default `--max-cost-usd-per-instance`, NOT raised).

## Phases

- Phase A (pilot, 8): orders 1–8. Gate: 8/8 preflight parity, 8/8 guards, 0
  fallback, 0 leakage, 0 mutation attempts, artifacts parse, spend normal.
- Phase B (14): orders 9–22. Gate: 22/22 cumulative clean + cap check.
- Phase C (14): orders 23–36. Gate: 36/36 cumulative clean + cap check.
- Phase D (14): orders 37–50. Gate: cap check before start; full checks after.

Docker evaluation runs per phase after the treatment runs (evaluate mode
mutates `resolved` in place; it can overlap the NEXT phase's live runs —
different resources — but treatment runs are strictly sequential).

## Preflight addendum (added after the no-agent preflight, BEFORE any live spawn)

The first full 50-case no-agent preflight (0 unexplained leak hits, 0
fallback fires, env+shell guards green) surfaced two case classes the
M105/M106/M107 selections never contained; both classifications below were
fixed BEFORE any live agent was spawned:

1. **Expected deterministic no-context (3 cases: django-11740, django-15572,
   sphinx-9320).** The live preflight reproduces `gate_action=no_context`
   for exactly the cases whose FROZEN M103 scoreboard row records
   `capsule.mode = no_context` (lead_pivot_file null) — this is parity with
   the deterministic path, not a failure. A live run would inject nothing:
   behaviorally a fresh-baseline run (forbidden by the non-goals) and
   parity-invalid under the committed M105 validity contract
   (`vtraceContextInjected !== true`). Decision: these 3 cases are NEVER
   spawned (`preflight_pass=false` holds at the per-case driver gate); they
   are reported as `expected_no_context` and do not block the global gate.
   A `no_context` gate action on any case whose frozen M103 row is NOT
   no_context still blocks all spawning. Live-attempted target becomes 47/50
   with this precise, pre-registered reason.
2. **Issue-authored task hit (1 case: sympy-15599).** The M103 V5 derivation
   deliberately extracts failing tests THE ISSUE MENTIONS; here the issue
   author wrote `test_Mod`, which is also the case's FAIL_TO_PASS id, so the
   raw task scan flags it. The string is verbatim in the problem statement
   (and base-commit repo content — the test exists at the base commit; the
   assembled-context scan already classifies it as such), and the task text
   is byte-identical to the frozen M103 row that the deterministic
   scoreboard scored under the M103 leakage policy
   (`issue_authored_gold_path` precedent). Decision: reclassified
   `issue_authored_task_hits`, case passes preflight; any hit NOT verbatim
   in the problem statement still fails.

## Non-goals (hard)

No M105/M106/M107 reruns, no VEXP, no fresh baseline, no V4, no C7_D, no
revision/corrective/oracle arms, no M14/M15 paths, no legacy-fallback counted
valid, no FAIL_TO_PASS/PASS_TO_PASS/gold-patch/hidden-test/scoring content in
model-visible context, no Conda mutation, no unguarded live agents, no raw
artifacts staged.
