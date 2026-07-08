# VTRACE Stage 5 — New-Chat Handoff (M110)

_2026-07-08. Self-contained handoff: paste this into a new chat to continue
VTRACE work without rerunning anything. Everything below is backed by
committed artifacts indexed in `stage5_m110_evidence_artifact_index.md`._

## Project goal

VTRACE is a deterministic, repo-local structural context engine (SQLite
symbol index -> retrieval -> Capsule v2 context capsules) for lower-token
coding agents. Stage 5 is the internal SWE-bench-style validation harness: a
thin wrapper around the external `vexp-swe-bench` runner that injects VTRACE
context into a real agent loop and Docker-evaluates the resulting patches.

## Current default path (FROZEN at M109, packaged at M110)

- Task: `deriveStructuredTaskFromProblemStatement` (M103 V5 shape — V0 base +
  exceptions <=6 + issue-mentioned failing tests <=6 + traceback frames <=8,
  1200-char cap), shared by the deterministic scoreboard AND the live runner
  (M104 parity).
- Retrieval/capsule: Capsule v2 + M95 strong-lexical fix + M96
  direct-evidence lanes + M97/M98 tiered co-edit expansion + M99
  import_reexport_rescue + M100 file-evidence rescue + M101 anchored pivot
  guard.
- Live clean-core flags: `--protocol vtrace-indexed --context-policy
  force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget
  8000 --inject-capsule-digest --digest-decision-contract
  --bounded-digest-decisions --compact-digest-injection
  --pivot-confidence-gate`.
- Mandatory safety (fail-closed): M89 env guard + drift check + pinned
  testbed prefix; M90A agent shell guard + host-pip firewall.
- Default-off / invalid: V4 tool-loop guard, C7_D cost guard, M12
  enforcement, M14/M15 revision + rule-out corrective arms (they inject
  FAIL_TO_PASS -> parity-invalid), M7.3 traceback skip, VEXP, baseline arms,
  the unguarded escape hatch; a legacy-fallback fire makes a run
  parity-invalid (0 fires observed).
- Full machine-readable record: `stage5_m110_frozen_default_path_manifest.json`.

## What changed M95–M103 (deterministic chain)

M94 baseline -> M103 final, gold-blind pre-agent scoreboard: recall@5 .637 ->
.748, all-gold-in-capsule 60.6% -> 75.0%, lead-pivot=source-gold 45.5% ->
59.0%, hidden-coedit recall .222 -> .622, multi-file all-gold 6.7% -> 53.3%,
miss 30 -> 21, wrong_pivot 10 -> 7, at flat median capsule size and p90 -20%.
Accepted cost: overpacked 7 -> 14. Steps: M95 strong-lexical fix, M96
direct-evidence lanes, M97/M98 co-edit expansion + precision tiers, M99
import rescue, M100 file-evidence rescue, M101 anchored pivot guard, M102
derivation audit (report-only), M103 structured task derivation + provenance
leakage policy.

## What M104 proved

Live and deterministic tasks are the SAME function (14/14 byte-exact parity,
leak-clean, no agents). The pre-M104 live composite (full problem statement +
FAIL_TO_PASS labels + hints) is gone. From M105 on, any live-vs-deterministic
delta is agent/config-attributable, never task derivation. Before ANY live
spend, re-prove parity with `run_stage5_m104_live_context_smoke.ts`.

## What M105–M108 proved

Guarded live confirmation over the frozen internal 100-case pool, grown 14 ->
24 -> 50 -> 100 under an artifact-reuse contract (committed runs never
rerun): 97 valid guarded live runs, 55 resolved (56.7% of valid), 3
pre-registered no-context exclusions (django__django-11740,
django__django-15572, sphinx-doc__sphinx-9320 — nothing to inject, never
spawned). Safety clean sweep: 0 unexplained leakage, 0 fallback fires, 0
env/shell-guard failures, 0 drift, 0 host-pip blocks, 0 unguarded runs, 0
revision artifacts. Cost $56.69 / 104.6M tokens / 93.9% cache-read.

## What M109 concluded

- Strict M73-treatment comparison (93 comparable): expectation 64, live 54,
  per-case agreement 77/93 (82.8%). M73-baseline 61/97 vs live 55/97. M92
  overlap 49: live 16 vs 20, agreement 41/49.
- 13 strict live losses; 10 had ALL gold files in the capsule. Reason split:
  10 agent-variance, 1 single-file-patch-on-multifile-gold (xarray-6938), 2
  deterministic context gaps (pytest-6197, sympy-15875). Conclusion: the
  deficit is hard-stratum agent-side variance, NOT a retrieval/context
  regression.
- The whole M7.x live-regression list (sympy-12419, astropy-14539,
  pylint-8898) is live-recovered under the current path.
- Verdict PASS; default path frozen; no more live spend until
  captured-artifact analysis questions are exhausted.

## Claim-safe final wording (reuse verbatim)

> On the frozen internal 100-case Stage 5 pool, the current default VTRACE
> path produced 97 valid guarded live runs, with 55 resolved patches (56.7%
> of valid live runs). Three cases were pre-registered no-context exclusions
> under the parity contract.

> Across the 97 valid runs, the default path was leak-clean: zero
> model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch leakage, zero
> fallback-context fires, zero unguarded env/shell runs, and zero host-pip
> mutation escapes.

> In the one paired same-protocol measurement (M92, 50 tasks, both arms
> valid), VTRACE reduced total agent tokens by 26.7% and cost by 25.0% with
> resolution preserved.

> This is an internal live confirmation, not a public SWE-bench pass@1 claim
> and not a VEXP parity claim.

## What NOT to claim (prohibited forms)

- ✗ "VTRACE achieved 56.7% on SWE-bench" / ✗ "VTRACE pass@1 is 56.7%"
- ✗ "100/100 live cases were run"
- ✗ "VTRACE beats VEXP" (or any VEXP parity/superiority claim)
- ✗ "VTRACE is validated on SWE-bench Verified"
- ✗ "no leakage is possible" (measured-zero on this protocol, not impossible)
- ✗ "token reduction is guaranteed"

Denominator rule: always report all three numbers together — 100 frozen pool
cases, 97 valid live runs, 3 pre-registered no-context exclusions.

## Remaining bottlenecks

1. Agent-variance losses despite complete context (10 of 13 strict losses had
   all gold in the capsule) — patch-shape/convergence levers, not retrieval.
2. Cache-read dominance (93.9% of tokens): turn efficiency is the cost lever,
   not capsule size.
3. Deterministic residue: 21 miss / 14 overpacked / 7 wrong_pivot (mined-out
   or deliberate conservatism per M100/M103/M96).
4. 3 no-context pool cases (3% of pool) — candidate-recall work only if the
   class grows.
5. High-cost tool-loop structural ceiling (django-16263, pylint-4551,
   sympy-20428 signatures); V4/C7_D stay default-off per M78/M83.

## Recommended next milestones (ranked, from M109)

1. No live spend until captured-artifact analysis questions are exhausted.
2. Hard-stratum transcript study: the 9+4 agent-variance losses' tool
   logs/transcripts (cheapest expected gain; captured artifacts only).
3. no_context candidate-recall work only if the class grows beyond 3/100.
4. VEXP comparison ONLY under a separate preregistered paired protocol.

## Key artifact paths

- Package: `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m110_*`
  (manifest, artifact index, claim matrix, this handoff, package summary).
- Final summary: `results/stage5_m109_final_internal_summary.{md,json}`;
  hard-stratum: `results/stage5_m109_hard_stratum_analysis.json`.
- Live: `results/stage5_m108_100_case_live_confirmation.{md,json}` +
  `stage5_m10{5,6,7,8}_live_{runs,preflight}.detail.json`.
- Deterministic: `results/stage5_m94_deterministic_scoreboard.json` ->
  `results/stage5_m103_deterministic_scoreboard.json`.
- History: `results/stage5_m73_final_100_paired_summary.json`,
  `results/stage5_m92_core_reduction50_validation.json`.
- Docs: `docs/current_product_state.md`, `README.md`,
  `results/stage5_milestone_ledger.md` (READ FIRST each milestone).

## Current branch/commit

Branch `main`; M110 packaging basis commit `9b462cc`. Milestone
commits:

| milestone | commit |
| --- | --- |
| M94 | `8d52a78` |
| M95 | `978458b` |
| M96 | `ca3d87a` |
| M97 | `81902d2` |
| M98 | `8157a72` |
| M99 | `29c65ca` |
| M100 | `49577bc` |
| M101 | `48379f1` |
| M102 | `a5ec283` |
| M103 | `199769f` |
| M104 | `4ca4948` |
| M105 | `fb791b0` |
| M106 | `5043a63` |
| M107 | `1dc69b2` |
| M108 | `a0bc3a6` |
| M109 | `d9364a9` |

## Workflow rules (standing)

- Work on `main`; commit locally; do NOT push; no co-author trailers.
- Read `results/stage5_milestone_ledger.md` at milestone start; append the
  milestone row + standing findings in the same commit at the end.
- Never stage raw artifacts (`results/runs/`, `results/raw/`,
  `_agent_*.jsonl`, `_m*_logs/`, prompt dumps, workspaces).
- Do not touch the pre-existing dirty `stage5_outcome_ledger.*`.
- No live agents / Docker / sweeps without explicit approval; live runs are
  sequential and need the mandatory M89/M90A guard flags.
- Any change that could touch retrieval/ranking needs the deterministic
  retrieval no-change proof (baseline-freshness check, or the stash A/B
  proof) — see CLAUDE.md.
