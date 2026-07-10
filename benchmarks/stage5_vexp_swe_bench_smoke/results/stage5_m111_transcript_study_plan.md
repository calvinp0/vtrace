# Stage 5 M111 — Hard-Stratum Transcript Study: Pre-Work Plan

_2026-07-10. No-spend captured-artifact analysis milestone. No live agents, no
Docker, no VEXP, no baseline arms, no V4/C7_D, no revision arms. This plan is
written BEFORE the final report, per the M111 protocol._

## 1. Which hard-stratum cases will be analyzed?

**Case universe** = `stage5_m109_hard_stratum_analysis.json` (committed, M109).

**Strict live losses (`flip_type = live_loss_vs_M73`) — all 13:**

| instance_id | milestone | M109 likely_reason |
| --- | --- | --- |
| astropy__astropy-7166 | m106 | agent_variance |
| pydata__xarray-6938 | m106 | single_file_patch_on_multifile_gold |
| django__django-12273 | m107 | agent_variance |
| django__django-12774 | m107 | agent_variance |
| matplotlib__matplotlib-25960 | m107 | agent_variance |
| pytest-dev__pytest-6197 | m107 | deterministic_context_gap |
| sympy__sympy-15875 | m107 | deterministic_context_gap |
| django__django-12325 | m107 | agent_variance |
| matplotlib__matplotlib-24627 | m107 | agent_variance |
| django__django-11490 | m108 | agent_variance |
| django__django-13551 | m108 | agent_variance |
| sympy__sympy-16766 | m108 | agent_variance |
| sympy__sympy-23413 | m108 | agent_variance |

**Tool-loop / high-cost cases (required, both `flip_type = agreement`, both
unresolved in live AND M73):** django__django-16263 (m107),
pylint-dev__pylint-4551 (m106).

**Contrast wins/outliers (required):** django__django-10973 (m108,
`no_M73_row`, live resolved), astropy__astropy-14539 (m108, agreement
resolved — M7.x recovery), sympy__sympy-12419 (m107, live_win — M7.x
recovery), pylint-dev__pylint-8898 (m107, agreement resolved on an M103
`miss` — M7.x recovery), astropy__astropy-14365 (m106, live_win),
sympy__sympy-24562 (m107, live_win).

**Total: 21 cases.** ID mapping note: the M111 prompt's "named losses" list
includes django-10973, astropy-14539, sympy-12419, pylint-8898 — in the
committed M109 JSON these are NOT `live_loss_vs_M73` rows (they are a no-row
resolve and three wins/agreement-resolves). They are covered in the contrast
set; the mapping is documented in the report.

## 2. Which artifacts exist for each case?

Every one of the 21 cases has a complete captured run folder
`results/runs/<label>/raw/vtrace/` (verified 2026-07-10, all 8 artifact kinds
present for all 21):

- `_agent_stream.first_pass.jsonl` — full agent transcript (assistant
  thinking + text + tool_use blocks, user tool_result blocks, result row).
- `_tool_calls.json` / `_tool_calls_with_outputs.json` /
  `_tool_calls.summary.json` — ordered tool calls with args and outputs.
- `swebench-*.jsonl` — canonical result row (`modelPatch`, `resolved`,
  `costUsd`, `numTurns`).
- `_run.meta.json` — engine/injection/guard telemetry.
- `_eval.meta.json` — docker-evaluate evidence (`resolvedCount`,
  `evaluationRan`).
- `_capsule_v2_manifest.json`, `_capsule_v2_ranking.json`,
  `_capsule_v2_context.md` — the exact injected context.
- `_vtrace_instructions.snapshot.md` — the injected instruction block.

## 3. Which artifacts are canonical?

| signal | canonical source |
| --- | --- |
| run detail (validity, resolved, changed_files, cost/turns) | committed `stage5_m10{5,6,7,8}_live_runs.detail.json` |
| preflight | committed `stage5_m108_live_preflight.detail.json` (M108 rows) + per-milestone detail `preflight_status` |
| agent transcript | `runs/<label>/raw/vtrace/_agent_stream.first_pass.jsonl` (untracked, read-only) |
| patch/diff | `modelPatch` in `runs/<label>/raw/vtrace/swebench-*.jsonl` (untracked, read-only) |
| test/eval output | `_eval.meta.json` (resolution) + Bash tool outputs inside `_tool_calls_with_outputs.json` (agent-side test runs) |
| deterministic M103 row (gold files, capsule files, lead pivot, outcome) | committed `stage5_m103_deterministic_scoreboard.detail.json` |
| M73 / M92 historical rows | committed `stage5_m73_final_100_paired_summary.json`, `stage5_m92_core_reduction50_validation.json`, plus the `historical` block in the M10x detail JSONs |
| flip labels + M109 reason heuristic | committed `stage5_m109_hard_stratum_analysis.json` |

Where committed detail JSON and raw artifacts disagree, the committed detail
JSON wins for validity/resolution (it is the evaluated record); the raw
artifacts win for behavior (what the agent actually did).

## 4. Which raw artifacts are read-only and must remain unstaged?

Everything under `results/runs/`, `results/raw/`, `results/_m1*_logs/`,
`results/_m1*_driver_ledger.jsonl`, `results/_agent_*.jsonl`, and any prompt
dumps. The study READS them and stages nothing from them. Staged outputs are
only: this plan, the M111 report md, the 3–5 named `stage5_m111_*.json/csv`
outputs, the analysis script, its tests, and the milestone-ledger append.

## 5. Which cases have complete transcript + patch + eval data?

All 21 / 21 (verified above). No case falls back to summary-only.

## 6. Which cases only have summary JSON?

None. (If a transcript had been missing, the case would have been classified
from the committed detail JSONs and flagged `artifact_coverage: summary_only`
with `unknown` transcript-derived fields.)

## 7. What exact classification schema will be used?

The M111 prompt schema, verbatim — per case:
`instance_id, repo, milestone_source, live_resolved, M73_treatment_resolved,
M92_resolved_if_available, M103_deterministic_outcome, M103_any_gold_in_capsule,
M103_all_gold_in_capsule, M103_lead_source_gold, capsule_mode, changed_files,
gold_files (scoring artifact only), agent_edited_gold_file {yes,no,partial},
agent_edited_non_gold_file {yes,no}, agent_patch_shape {no_patch,
single_file_patch, multi_file_patch, wrong_file_patch,
correct_file_wrong_logic, partial_patch, overbroad_patch, test_only_patch},
tool_loop_signature {none, repeated_read, repeated_search, repeated_test,
edit_churn, cost_cap, no_patch_exhaustion, command_failure_loop, unknown},
test_behavior {no_tests_run, irrelevant_tests_run, relevant_tests_failed,
relevant_tests_passed_but_eval_failed, test_command_failed_infra, unknown},
context_action_failure_type {gold_in_capsule_not_edited,
gold_edited_wrong_logic, hidden_gold_missing, lead_misled_agent,
agent_stopped_after_partial_fix, single_file_patch_on_multifile_gold,
overfitted_to_visible_test, no_context, issue_misread, infra_or_tooling,
unknown}, primary_cause {agent_variance, deterministic_context_gap,
retrieval_gap, ranking_or_lead_gap, capsule_packing_gap, task_derivation_gap,
tool_loop_or_budget, infrastructure, unknown}, confidence {high, medium, low},
evidence_summary, artifact_paths_used`.

Machine-derived fields (edited-file sets, patch shape vs gold file count,
tool-loop heuristics, test-run detection) are computed by
`run_stage5_m111_hard_stratum_transcript_study.ts` from the artifacts.
Judgment fields (`context_action_failure_type`, `primary_cause`,
`confidence`, `evidence_summary`) come from analyst transcript reading and
are recorded in the script as an explicit per-case override table so the
outputs are reproducible from the same artifacts. Any field not determinable
from artifacts is `unknown` — never invented.

Patch-shape decision rule (documented so it is reproducible):
`no_patch` if `modelPatch` empty; `test_only_patch` if all changed files are
test files; `wrong_file_patch` if changed ∩ gold = ∅; `single_file_patch` if
1 changed file on multi-file gold (the required "single-file-patch-on-
multifile-gold" signal); `partial_patch` if some but not all gold files
edited (multi-file gold); `overbroad_patch` if gold fully edited plus ≥2
non-gold source files; `correct_file_wrong_logic` if changed = gold subset,
all gold covered, but eval failed; `multi_file_patch` otherwise for >1 file.

Tool-loop signatures are computed from ordered tool calls:
`repeated_read` (same file Read ≥4× with no intervening edit),
`repeated_search` (≥4 near-identical Grep/Glob queries), `repeated_test`
(same test command Bash-run ≥3×), `edit_churn` (≥3 edits to one file
interleaved with failing checks), `command_failure_loop` (≥3 consecutive
failing Bash commands), `cost_cap` (run-meta cap/limit markers or
turn-budget exhaustion), `no_patch_exhaustion` (turns exhausted with no
Edit/Write). Multiple signatures can fire; the JSON keeps all, the CSV the
primary.

## 8. How will the study avoid gold leakage / hindsight-patch use?

- The agent-behavior narrative (what the agent tried, what it believed, why
  it stopped) is written from the transcript ONLY.
- Gold file lists come from the committed M103 scoring artifact and are used
  ONLY for post-hoc set comparisons (edited ∩ gold, patch shape) — the same
  gold-blind/gold-aware separation the deterministic scoreboard already uses.
- Gold PATCH CONTENT (the actual diff hunks in the dataset) is NOT used to
  judge agent logic; "wrong logic" verdicts cite the docker resolution
  (`resolved=false` with all gold files edited) plus transcript-visible test
  behavior, not a hunk-by-hunk hindsight diff.
- FAIL_TO_PASS ids are not injected anywhere (no revision arms run); they are
  referenced only descriptively when the transcript itself ran tests.

## 9. What counts as agent-side failure vs deterministic context failure?

- **Agent-side failure**: the M103 capsule contained every gold file (or the
  lead pivot was source-gold) AND the transcript shows the agent had the
  relevant file(s) in view, yet the patch is missing / wrong-file /
  wrong-logic / partial. Sub-classified via `context_action_failure_type`.
- **Deterministic context failure**: M103 outcome miss/wrong_pivot/partial
  where gold file(s) were absent from the capsule AND the transcript shows
  the agent following the injected (wrong/incomplete) context without
  independently recovering the gold file. If the agent independently FOUND
  the gold file via search despite the miss and still failed, the case is
  agent-side, not context-side (context gap did not bind).
- Mixed cases keep the binding constraint as `primary_cause` and note the
  secondary in `evidence_summary`.

## 10. What output files will be produced?

- `stage5_m111_transcript_study_plan.md` (this file)
- `stage5_m111_hard_stratum_transcript_study.md` (report)
- `stage5_m111_hard_stratum_transcript_study.json` (machine summary)
- `stage5_m111_case_classifications.json` (per-case schema rows)
- `stage5_m111_case_classifications.csv` (same, flat)
- optional: `stage5_m111_next_action_queue.json` (ranked next actions)
- helper: `run_stage5_m111_hard_stratum_transcript_study.ts` +
  `m111_case_classifier.ts` + tests (classifier logic only; no brittle
  full-transcript fixtures)
