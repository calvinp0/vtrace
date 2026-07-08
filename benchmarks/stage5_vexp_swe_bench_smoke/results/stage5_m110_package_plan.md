# Stage 5 M110 Package Plan — Internal Evidence Package and Frozen Default Path Manifest

_2026-07-08. Pre-work analysis for M110. Documentation / evidence-packaging
milestone only: NO live agents, NO Docker, NO API spend, NO VEXP, NO baseline
arms, NO retrieval/ranking/capsule/task-derivation changes. All numbers below
are read from committed artifacts; nothing is recomputed from live runs._

Pre-existing dirty state recorded at start (untouched by this milestone):
`stage5_outcome_ledger.{md,json}` (modified, predates this work), plus the
large set of untracked raw artifacts (`results/runs/`, `results/raw/`,
`results/_m*_logs/`, `_agent_*.jsonl`, driver ledgers, `package-lock.json`,
`AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`, `benchmarks/arc_stage*/results/`,
assorted untracked `stage5_*.md/json` from pre-ledger milestones). None are
staged or modified here.

## 1. Canonical artifacts for the final deterministic result

- `results/stage5_m94_deterministic_scoreboard.{md,json}` (+ `.detail.json`) —
  the M94 baseline scoreboard (comparable-99 basis).
- `results/stage5_m103_deterministic_scoreboard.{md,json}` (+ `.detail.json`,
  `stage5_m103_deterministic_failure_modes.json`) — the M103 final scoreboard
  (new-policy-100 basis; `regression_guard_cases` live here).
- `results/stage5_m103_structured_task_derivation.{md,json}` — the M103
  milestone report (V5 derivation shipped as default + leakage policy).
- Supporting (per-step evidence): the M95–M102 milestone reports
  `stage5_m95_retrieval_improvement`, `stage5_m96_candidate_pool_recall`,
  `stage5_m97_hidden_coedit_expansion`, `stage5_m98_support_precision`,
  `stage5_m99_import_edge_extraction`, `stage5_m100_candidate_pool_recall`,
  `stage5_m101_ranking_pivot`, `stage5_m102_task_derivation_audit` and their
  per-milestone scoreboards.
- The M94→M103 headline deltas are summarized canonically in
  `stage5_m109_final_internal_summary.{md,json}` (`deterministic_core_result`).

## 2. Canonical artifacts for the final live result

- `results/stage5_m108_100_case_live_confirmation.{md,json}` — the combined
  100-case aggregate (97 valid / 55 resolved / 3 no-context exclusions).
- `results/stage5_m108_live_runs.detail.json` — per-case live rows (M108 ext).
- `results/stage5_m105_small_live_confirmation.{md,json}` +
  `stage5_m105_live_runs.detail.json`,
  `results/stage5_m106_24_case_live_confirmation.{md,json}` +
  `stage5_m106_live_runs.detail.json` + `stage5_m106_case_selection.json`,
  `results/stage5_m107_50_case_live_confirmation.{md,json}` +
  `stage5_m107_live_runs.detail.json` + `stage5_m107_case_selection.json` —
  the reused component sets under the artifact-reuse contract.
- `results/stage5_m109_final_internal_summary.{md,json}` — the canonical
  roll-up (`live_confirmation_result` with the denominator rule).

## 3. Canonical artifacts for safety/leakage evidence

- Preflight details: `stage5_m105_live_preflight.detail.json`,
  `stage5_m106_live_preflight.detail.json`,
  `stage5_m107_live_preflight.detail.json`,
  `stage5_m108_live_preflight.detail.json` (parity hashes, leak scans,
  fallback probes, no-context holds).
- The `safety` blocks in each of
  `stage5_m105_small_live_confirmation.json` /
  `stage5_m106_24_case_live_confirmation.json` /
  `stage5_m107_50_case_live_confirmation.json` /
  `stage5_m108_100_case_live_confirmation.json`.
- `stage5_m109_final_internal_summary.json` `safety` (measured-zero roll-up).
- Supporting parity basis: `stage5_m104_live_path_parity.{md,json}` +
  `stage5_m104_live_context_smoke.detail.json`.

## 4. Canonical artifacts for historical comparison

- `results/stage5_m73_final_100_paired_summary.json` +
  `stage5_m73_final_100_paired.detail.json` +
  `stage5_m73_stage_c_fresh_baselines.{json,detail.json}` — M73
  treatment/baseline expectations.
- `results/stage5_m92_core_reduction50_validation.{md,json}` (+
  `.detail.json`) — the ONLY paired same-protocol token/cost claim
  (−26.7% tokens / −25.0% cost / resolution preserved 20/50).
- `results/stage5_m109_hard_stratum_analysis.json` — strict-comparability
  per-case flip analysis (13 losses, reason split).
- `stage5_m109_final_internal_summary.{md,json}` `historical_comparison`.
- `results/stage5_m109_final_analysis_notes.md` — working derivations.

## 5. Raw/untracked artifacts that must NOT be packaged

- Everything under `results/runs/` and `results/raw/` (cloned workspaces, raw
  result rows, streams, snapshots).
- All `results/_agent_*.jsonl`, `results/_m*_logs/`, `results/_m*_driver_ledger.jsonl`,
  `results/_m*_preflight/`, `results/_*prompt*.md`, `results/_cost_guard_*`,
  `results/_tool_loop_guard_*`, `results/manual_run_logs/`,
  `results/aggregate/`, `results/__pycache__/`.
- Pre-existing dirty tracked files: `stage5_outcome_ledger.{md,json}`.
- Untracked working docs (`AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`,
  `package-lock.json`, `benchmarks/arc_stage*/results/`).
- Rule applied: the artifact index lists tracked, named `stage5_*` reports
  only; nothing under `runs/`, `raw/`, or any `_`-prefixed path is indexed or
  hashed.

## 6. Exact frozen default path

The M95–M104 chain at HEAD (packaging basis commit `9b462cc`):

- Task derivation: `deriveStructuredTaskFromProblemStatement`
  (`stage5_task_derivation.ts`, M103 V5 shape: V0 base + exceptions ≤6 +
  issue-mentioned failing tests ≤6 + traceback frames ≤8, 1200-char cap),
  shared by the deterministic scoreboard AND the live runner since M104.
- Retrieval/capsule: Capsule v2 + M95 strong-lexical fix + M96
  direct-evidence lanes + M97/M98 tiered co-edit expansion + M99
  import_reexport_rescue + M100 file-evidence rescue + M101 anchored pivot
  guard.
- Live protocol: vtrace-indexed, guarded, sequential.

## 7. Flags/settings that define the frozen default path (M92/M105 clean-core)

From `run_stage5_m105_driver.sh` (identical in M106/M107/M108 drivers):
`--protocol vtrace-indexed --context-policy force-inject --capsule-engine v2
--capsule-intent debug --capsule-budget 8000 --inject-capsule-digest
--digest-decision-contract --bounded-digest-decisions
--compact-digest-injection --pivot-confidence-gate` + mandatory safety
`--stage5-env-guard --stage5-env-drift-check --expected-testbed-prefix <pin>
--stage5-agent-shell-guard --stage5-host-pip-firewall`.

## 8. Paths that remain invalid or default-off

- V4 tool-loop guard, C7_D cost guard: default-off diagnostics (M82/M85/M88
  neutral; M78/M83 calibration evidence).
- M12 pivot-inspection enforcement, M14/M15 revision passes, rule-out
  corrective: default-off; revision arms inject FAIL_TO_PASS by design →
  parity-INVALID as benchmark evidence.
- Legacy v2→legacy fallback: packs FAIL_TO_PASS into the retrieval query →
  any fire is parity-invalid (0 fires observed across 97 runs).
- M7.3 traceback-localized skip: default-off.
- VEXP arm, fresh baseline arms, `--allow-unguarded-live-env` escape hatch:
  not valid benchmark paths.
- 3 frozen no-context pool cases (django-11740, django-15572, sphinx-9320):
  never spawnable under the default path (preflight-held).

## 9. Claim-safe wording to reuse

Reuse the M109 `claim_safe_wording.allowed` block verbatim (97-valid/55-resolved
denominator rule, leak-clean wording, M94→M103 deterministic wording, the
internal-only disclaimer, the M92 paired token/cost claim). Prohibited forms:
the M109 `claim_safe_wording.prohibited` list (no public pass@1, no "100/100
live", no VEXP parity/superiority, no SWE-bench Verified, no
"leakage impossible", no "guaranteed token reduction").

## 10. What the internal package contains

Five tracked M110 artifacts beside this plan:
1. `stage5_m110_frozen_default_path_manifest.json` — machine-readable freeze
   record (HEAD, milestone commits M94–M109, default path, disabled paths,
   invalid contexts, no-context exclusions, claim boundaries).
2. `stage5_m110_evidence_artifact_index.{md,json}` — grouped index of the
   canonical + supporting artifacts (path/kind/milestone/purpose/tracked/sha256).
3. `stage5_m110_claim_matrix.{md,json}` — claim → allowed wording →
   supporting artifacts → scope/denominator/caveats → prohibited forms.
4. `stage5_m110_new_chat_handoff.md` — self-contained handoff for a new chat.
5. `stage5_m110_internal_evidence_package.{md,json}` — the package summary
   (verdict + recommendation).
Helper code: `run_stage5_m110_lib.ts` (pure builders + wording guards),
`run_stage5_m110_package.ts` (generator; hashes tracked artifacts only),
`run_stage5_m110_lib.test.ts` (schema + wording-guard tests).

## 11. Docs updates needed

- `docs/current_product_state.md`: already carries the M109 claim-safe
  benchmark-interpretation and freeze note — **no update needed**; the index
  references it as canonical.
- `README.md`: claim-safe (M92 figures properly scoped, explicit "not a
  public SWE-bench pass@1"). One stale-but-safe sentence: "the planned M94
  retrieval/capsule scoreboard … will measure deterministic-core quality
  separately" — M94–M103 have since shipped. Minimal tense fix (no new
  claims, no numbers) to point at the completed scoreboard; nothing else
  touched.
