# Stage 5 M110 Evidence Artifact Index

_2026-07-08. Index of the canonical + supporting evidence for the frozen default VTRACE path (packaging basis commit `9b462cc`). Raw run folders, streams, logs, and workspaces are deliberately NOT indexed or hashed — they are untracked working artifacts, never package contents. SHA-256 hashes are over file bytes at the packaging commit._

## Deterministic core (M94–M103)

| path | kind | milestone | role | tracked | sha256 (12) | purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m94_deterministic_scoreboard.md` | report_md | M94 | canonical | tracked | `5d073b5fd2cc` | gold-blind pre-agent baseline scoreboard (comparable-99 basis) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m94_deterministic_scoreboard.json` | report_json | M94 | canonical | tracked | `13656698bc27` | machine-readable M94 baseline metrics (per-case rows in stage5_m94_deterministic_scoreboard.detail.json) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m95_retrieval_improvement.md` | report_md | M95 | supporting | tracked | `befdf4ccc57b` | genericInfra strong-lexical fix |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m96_candidate_pool_recall.md` | report_md | M96 | supporting | tracked | `8edd2b8d3e99` | direct-evidence anchoring (issue-text mention lanes) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m97_hidden_coedit_expansion.md` | report_md | M97 | supporting | tracked | `52df799e2c67` | bounded hidden co-edit expansion (multi-file recall) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m98_support_precision.md` | report_md | M98 | supporting | tracked | `24bbae069476` | co-edit confidence tiers (subtractive pruning) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m99_import_edge_extraction.md` | report_md | M99 | supporting | tracked | `c512a87f891b` | file-level import scan + import_reexport_rescue lane |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m100_candidate_pool_recall.md` | report_md | M100 | supporting | tracked | `f79d157265a0` | file-evidence deep-pool rescue |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m101_ranking_pivot.md` | report_md | M101 | supporting | tracked | `d1a4f714115b` | anchored-target pivot guard |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m102_task_derivation_audit.md` | report_md | M102 | supporting | tracked | `acea54d901f6` | task-derivation variant audit (V5 selected) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m103_structured_task_derivation.md` | report_md | M103 | canonical | tracked | `5b064fb0f769` | structured task derivation shipped as default + provenance leakage policy |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m103_deterministic_scoreboard.md` | report_md | M103 | canonical | tracked | `9743398e1d7b` | final deterministic scoreboard (new-policy-100 basis) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m103_deterministic_scoreboard.json` | report_json | M103 | canonical | tracked | `7d2db04c8077` | machine-readable M103 final metrics incl. regression_guard_cases (per-case rows in stage5_m103_deterministic_scoreboard.detail.json) |

## Live parity/safety basis (M104)

| path | kind | milestone | role | tracked | sha256 (12) | purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m104_live_path_parity.md` | report_md | M104 | canonical | tracked | `e41c9f79f72b` | live task builder = shared M103 derivation; 14/14 byte-exact parity + leak-clean no-agent smoke |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m104_live_path_parity.json` | report_json | M104 | canonical | tracked | `4e626f5dc646` | machine-readable M104 parity/leakage result |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m104_live_context_smoke.detail.json` | detail_json | M104 | supporting | tracked | `81bc28d9d1a8` | per-case smoke rows (task hashes, leak-scan classifications) |

## Live confirmation (M105–M108)

| path | kind | milestone | role | tracked | sha256 (12) | purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m105_small_live_confirmation.md` | report_md | M105 | canonical | tracked | `1aa7f9daec7d` | 14-case live confirmation (6/14 resolved; M73-treatment per-case exact) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m105_small_live_confirmation.json` | report_json | M105 | canonical | tracked | `33d229dcec04` | machine-readable M105 aggregate + safety block |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m105_live_runs.detail.json` | detail_json | M105 | canonical | tracked | `216548cfdaae` | per-case live rows (M105 set) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m105_live_preflight.detail.json` | preflight_json | M105 | canonical | tracked | `385a1289ee5a` | per-case spawn-gate evidence (parity hashes, leak scans, guard probes) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m106_24_case_live_confirmation.md` | report_md | M106 | canonical | tracked | `b0d83a246c74` | 24-case live confirmation (9/24; reuse contract established) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m106_24_case_live_confirmation.json` | report_json | M106 | canonical | tracked | `e1e65dbcd113` | machine-readable M106 aggregate + safety block |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m106_live_runs.detail.json` | detail_json | M106 | canonical | tracked | `74d92f2cb93b` | per-case live rows (M106 extension) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m106_live_preflight.detail.json` | preflight_json | M106 | canonical | tracked | `a116950c237b` | per-case spawn-gate evidence (M106 extension) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m106_case_selection.json` | selection_json | M106 | supporting | tracked | `094865929c8f` | pre-registered deterministic extension-case selection |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m107_50_case_live_confirmation.md` | report_md | M107 | canonical | tracked | `ffa5709859fa` | 50-case live confirmation (17/50; sympy-12419 regression resolved live) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m107_50_case_live_confirmation.json` | report_json | M107 | canonical | tracked | `c040323b4998` | machine-readable M107 aggregate + safety block |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m107_live_runs.detail.json` | detail_json | M107 | canonical | tracked | `b528417770fb` | per-case live rows (M107 extension) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m107_live_preflight.detail.json` | preflight_json | M107 | canonical | tracked | `bbdda0a92d8b` | per-case spawn-gate evidence (M107 extension) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m107_case_selection.json` | selection_json | M107 | supporting | tracked | `f3d9b4d26bf2` | pre-registered deterministic extension-case selection |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_100_case_live_confirmation.md` | report_md | M108 | canonical | tracked | `ec76366e71f3` | combined 100-case live confirmation: 97 valid / 55 resolved / 3 no-context exclusions |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_100_case_live_confirmation.json` | report_json | M108 | canonical | tracked | `cde88ea5878e` | machine-readable combined aggregate + safety clean-sweep block |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_live_runs.detail.json` | detail_json | M108 | canonical | tracked | `d825ee64393d` | per-case live rows (M108 extension) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_live_preflight.detail.json` | preflight_json | M108 | canonical | tracked | `765b9fb8de7c` | per-case spawn-gate evidence incl. the 3 expected_no_context holds |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m108_case_selection.json` | selection_json | M108 | supporting | tracked | `20bfb0a4867a` | deterministic complement selection (remaining 50 pool cases) |

## Final summary (M109)

| path | kind | milestone | role | tracked | sha256 (12) | purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.md` | report_md | M109 | canonical | tracked | `ec5c713ff204` | canonical final roll-up: deterministic + live + safety + claim-safe wording |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.json` | report_json | M109 | canonical | tracked | `3d7c0ddf048c` | machine-readable final summary (denominator rule, allowed/prohibited wording) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_hard_stratum_analysis.json` | detail_json | M109 | canonical | tracked | `34bde0c366d7` | per-case flip analysis vs M73 (strict comparability; loss-reason split) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_analysis_notes.md` | report_md | M109 | supporting | tracked | `95d134cd73b7` | working derivations behind the summary numbers |

## Historical comparison (M73, M92)

| path | kind | milestone | role | tracked | sha256 (12) | purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m73_final_100_paired_summary.json` | report_json | M73 | canonical | tracked | `8bb9dcaa1b9a` | M73 treatment/baseline expectations over the 100-task set |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m73_final_100_paired.detail.json` | detail_json | M73 | supporting | tracked | `2e3bfd64cd28` | per-case M73 rows (treatment_valid comparability source) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m73_stage_c_fresh_baselines_and_final_100.md` | report_md | M73 | supporting | tracked | `718869716d09` | M73 Stage C report (fresh baselines + final 100 analysis) |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m92_core_reduction50_validation.md` | report_md | M92 | canonical | tracked | `ed076a117ad4` | the ONLY paired same-protocol token/cost claim: -26.7% tokens / -25.0% cost, resolution preserved 20/50 |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m92_core_reduction50_validation.json` | report_json | M92 | canonical | tracked | `4e2cea075309` | machine-readable M92 paired result |

## Docs / claim surfaces

| path | kind | milestone | role | tracked | sha256 (12) | purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `README.md` | doc | M93B/M109 | canonical | tracked | `892984093264` | public claim surface (M92 figures scoped; explicit not-a-public-pass@1 disclaimer) |
| `docs/current_product_state.md` | doc | M109 | canonical | tracked | `08b4262943bf` | single plain-truth product surface incl. benchmark interpretation + freeze note |
| `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_milestone_ledger.md` | ledger | M99+ | canonical | tracked | `65814f2a220b` | append-only milestone chain record (what was done, standing findings, next steps) |

## Explicitly out of scope (never package)

- everything under `results/runs/` and `results/raw/` (cloned workspaces, raw result rows, streams, snapshots)
- all `results/_agent_*.jsonl`, `results/_m*_logs/`, `results/_m*_driver_ledger.jsonl`, `results/_m*_preflight/`, prompt dumps, guard state dirs
- the pre-existing dirty `stage5_outcome_ledger.{md,json}` and untracked working docs (`AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`)
