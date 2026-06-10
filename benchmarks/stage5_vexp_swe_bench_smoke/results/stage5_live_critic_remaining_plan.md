# Stage 5 remaining live critic observation plan

_Generated: 2026-06-10T16:40:54.070Z_

_Planning/reporting only. This document runs no live critic, no agents, and no Docker; it implements no repair and modifies no patch, workspace, or raw artifact. It only reads deterministic verdicts and writes these plan files._

## Summary

Plan for 5 remaining gated, no-repair live critic observation run(s), derived from the deterministic dry-run verdicts (source: deterministic-dry-run). The already-smoked run `eval-patchverify-before-sympy-16766` and all low-risk runs are excluded. The live critic stays disabled by default and bounded by run-label, deterministic-repair-required, a 5-call cap, and a $0.75 cost cap.

| field | value |
| --- | --- |
| included runs | 5 |
| excluded runs | 7 |
| max critic runs | 5 |
| cost cap (USD) | $0.75 |

## Why these runs

These are exactly the runs the cheap deterministic critic flagged `repair_required`, minus the run already covered by the one-call smoke comparison. Low-risk runs (deterministic `repair_required=false`) are excluded. The goal is no-repair live critic OBSERVATION: confirm the live critic agrees with the deterministic critic, identifies the same core defect, and yields concrete repair instructions — before any repair is implemented.

| run | instance | det repair_required | known risk type | reason included |
| --- | --- | --- | --- | --- |
| eval-editguard-before-matplotlib-22719 | matplotlib__matplotlib-22719 | true | matplotlib missing failing behavior / empty-array handling | deterministic critic flagged repair_required (high-risk); included for gated no-repair live critic observation |
| eval-patchverify-after-matplotlib-22719 | matplotlib__matplotlib-22719 | true | matplotlib missing failing behavior / empty-array handling | deterministic critic flagged repair_required (high-risk); included for gated no-repair live critic observation |
| eval-editguard-before-requests-5414 | psf__requests-5414 | true | requests broad rewrite / minimality risk | deterministic critic flagged repair_required (high-risk); included for gated no-repair live critic observation |
| eval-editguard-after-requests-5414 | psf__requests-5414 | true | requests broad rewrite / minimality risk | deterministic critic flagged repair_required (high-risk); included for gated no-repair live critic observation |
| eval-patchverify-before-requests-5414 | psf__requests-5414 | true | requests broad rewrite / minimality risk | deterministic critic flagged repair_required (high-risk); included for gated no-repair live critic observation |

Excluded:

| run | instance | det repair_required | reason excluded |
| --- | --- | --- | --- |
| eval-editguard-before-sympy-16766 | sympy__sympy-16766 | false | low-risk: deterministic critic did not flag repair_required |
| eval-editguard-after-sympy-16766 | sympy__sympy-16766 | false | low-risk: deterministic critic did not flag repair_required |
| eval-patchverify-before-sympy-16766 | sympy__sympy-16766 | true | already-smoked: the one-call live critic comparison already covered this run |
| eval-patchverify-after-sympy-16766 | sympy__sympy-16766 | false | low-risk: deterministic critic did not flag repair_required |
| eval-editguard-after-matplotlib-22719 | matplotlib__matplotlib-22719 | false | low-risk: deterministic critic did not flag repair_required |
| eval-patchverify-before-matplotlib-22719 | matplotlib__matplotlib-22719 | false | low-risk: deterministic critic did not flag repair_required |
| eval-patchverify-after-requests-5414 | psf__requests-5414 | false | low-risk: deterministic critic did not flag repair_required |

## Safety gates

- no repair
- no patch modification
- no Docker
- no agent rerun
- run-label constrained
- deterministic-repair-required only
- max 5 calls
- cost cap $0.75

## Dry-run command

Run this first to confirm the gates select exactly the five runs (no model is called in dry-run):

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_critic_live.ts \
  --results benchmarks/stage5_vexp_swe_bench_smoke/results \
  --enable-patch-critic \
  --dry-run \
  --run-label eval-editguard-before-matplotlib-22719 \
  --run-label eval-patchverify-after-matplotlib-22719 \
  --run-label eval-editguard-before-requests-5414 \
  --run-label eval-editguard-after-requests-5414 \
  --run-label eval-patchverify-before-requests-5414 \
  --max-critic-runs 5 \
  --only-deterministic-repair-required \
  --critic-cost-cap-usd 0.75 \
  --out-name stage5_patch_critic_live_remaining_high_risk_dry_run
```

## Live observation command

```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_critic_live.ts \
  --results benchmarks/stage5_vexp_swe_bench_smoke/results \
  --enable-patch-critic \
  --run-label eval-editguard-before-matplotlib-22719 \
  --run-label eval-patchverify-after-matplotlib-22719 \
  --run-label eval-editguard-before-requests-5414 \
  --run-label eval-editguard-after-requests-5414 \
  --run-label eval-patchverify-before-requests-5414 \
  --max-critic-runs 5 \
  --only-deterministic-repair-required \
  --critic-cost-cap-usd 0.75 \
  --out-name stage5_patch_critic_live_remaining_high_risk
```

## Expected artifacts

Per included run, under `benchmarks/stage5_vexp_swe_bench_smoke/results/runs/<runLabel>/raw/vtrace`:

- _patch_critic.meta.json
- _patch_critic_report.json
- _patch_critic_input.json
- _patch_critic.raw.txt
- _first_patch.diff

Comparison report files (written by the live runner):

- stage5_patch_critic_live_remaining_high_risk.md
- stage5_patch_critic_live_remaining_high_risk.json

Dry-run report files:

- stage5_patch_critic_live_remaining_high_risk_dry_run.md
- stage5_patch_critic_live_remaining_high_risk_dry_run.json

_All per-run artifacts land under `results/runs/...` and remain untracked; do not commit them._

## What to inspect after running

Per-run live critic meta + structured report:

```bash
for LABEL in \
  eval-editguard-before-matplotlib-22719 \
  eval-patchverify-after-matplotlib-22719 \
  eval-editguard-before-requests-5414 \
  eval-editguard-after-requests-5414 \
  eval-patchverify-before-requests-5414
do
  RAW="benchmarks/stage5_vexp_swe_bench_smoke/results/runs/$LABEL/raw/vtrace"
  echo "===== $LABEL ====="
  jq '{enabled, ran, validReport, failedOpen, criticCostUsd, criticInputTokens, criticOutputTokens, deterministicRepairRequired, liveRepairRequired, agreementWithDeterministic}' "$RAW/_patch_critic.meta.json"
  jq '{risk, confidence, repair_required, repair_reason, repair_instructions, evidence_probe_ids}' "$RAW/_patch_critic_report.json"
done
```

Preview the comparison report:

```bash
sed -n '1,260p' benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_patch_critic_live_remaining_high_risk.md
```

After the 5 observations are complete, the next task should add `stage5_live_critic_high_risk_comparison.md/json`, measuring:

- valid report rate
- fail-open rate
- agreement with deterministic critic
- per-field agreement/disagreement
- whether the live critic adds new information beyond deterministic probes
- cost/tokens
- whether repair instructions are concrete enough to justify one-repair-attempt mode

## Non-claims

- This plan runs no live critic, no agents, and no Docker.
- This plan implements no repair and modifies no patch or workspace.
- This plan modifies no raw artifact; it only reads deterministic verdicts and writes its own plan files.
- The live critic remains disabled by default and gated (run-label, deterministic-repair-required, max 5 calls, $0.75 cap).
- `repair_required` is an OBSERVATION (what a critic would request); no repair is performed.
- This plan does not prove the live critic improves SWE-bench resolution.
- This plan does not compare VTRACE against VEXP.
- The $0.75 cap is an upper bound; actual spend depends on per-run tokens and is expected to be lower.

