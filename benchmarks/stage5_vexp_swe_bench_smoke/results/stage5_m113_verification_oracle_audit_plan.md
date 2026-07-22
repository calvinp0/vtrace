# Stage 5 M113 Verification-Oracle Prompt-Policy Audit Plan

_Prepared before the final audit report or any product wording change. This is an offline analysis plan over captured M105–M108 artifacts only._

## Evidence Coverage

1. **Which artifacts cover all 97 valid runs?** The committed M105, M106, M107, and M108 live-run detail JSONs contain 14, 10, 26, and 50 rows respectively. Filtering their recorded `validity.valid` field excludes the three invalid M108 rows and yields 97 valid, disjoint runs. The M103 deterministic scoreboard supplies one deterministic row for each case. The read-only `results/runs/<run_label>/raw/vtrace/` folders exist for all 97 valid rows.
2. **Which artifacts include transcript/tool-output evidence?** All 97 valid run folders contain `_agent_stream.first_pass.jsonl`, `_tool_calls.json`, and `_tool_calls_with_outputs.json`. The first is the captured transcript; the latter two preserve ordered tool use and, where captured, command output.
3. **Which artifacts include commands the agent ran?** `_tool_calls_with_outputs.json` is canonical for Bash command text and output; `_tool_calls.json` is the ordered fallback. Both exist for all 97 valid rows.
4. **Which artifacts include patches and changed files?** Each run's `swebench-*.jsonl` carries `modelPatch`; the committed milestone detail row carries `metrics.changed_files`. Capsule manifests and run metadata provide the generation-side context. Raw files are read-only and will not be staged.
5. **Which artifacts include eval result/final resolution?** The committed milestone detail rows contain `eval_status` and `resolved` for all 97 valid rows. `_eval.meta.json` provides corroboration for 96/97; django-13513 lacks that raw file, so its committed evaluated detail row is the resolution source and the coverage limitation will be explicit.

## Classification Method

6. **What is the schema?** Every row will use the requested M113 fields: identity/milestone/repo; live and M103 outcomes; attempted repo/local verification; repo-test result; local-oracle type and quality; failure mode and environment signature; response to environment failure; finalization confidence; primary cause; next action; confidence; short evidence quotes; and artifact paths.
7. **Which classifications are machine-computed?** Commands and outputs; test-command mentions; command success/failure indicators; dependency, pip, import, collection, service, and unrelated-repo failure signatures; repeated failing-command loops; changed files; live resolution; cost/turn/tool counts; M103 capsule fields; transcript/tool artifact presence; and stable aggregates.
8. **Which require analyst judgment?** Local-oracle quality, verification failure mode where signals overlap, response to environment failure, finalization confidence, primary verification cause, next action, and confidence. Oracle type is machine-suggested but analyst-reviewable because a short Python command can be an exact reproduction, a weak smoke, or irrelevant.
9. **How will judgments cite evidence?** Each row will carry short command/output or transcript excerpts plus structured file references. The explicit analyst override table will state the judgment and its evidence summary; generated outputs remain stable. Quotes will be clipped and raw transcripts will not be copied wholesale.
10. **How will the audit avoid hindsight from gold patches?** Gold patch hunks and FAIL_TO_PASS contents will not be read or used to decide what the agent should have known. M103's gold-file booleans may be joined only as pre-existing post-hoc capsule-quality metrics. Oracle quality will be judged against issue-authored exact inputs/expected behavior, repository code inspected by the agent, and the captured command/output—not the accepted implementation.
11. **How will outcomes be compared?** Aggregates will be stratified by `live_resolved`, oracle quality, verification/repo-test attempt, environment failure/loop, and M103 capsule quality. Rates will always show numerator and denominator; unknowns will remain a distinct category.

## Decision Rule and Outputs

12. **What justifies wording decision A?** Frequent wrong/no/weak-oracle behavior, concentration in unresolved or hard-loss cases, and contrasting resolved runs with faithful issue-grounded oracles; plus a generic compact rule that is gold-blind, does not claim failed tests prove correctness, does not demand fabricated tests, and can be rendered/tested offline with invariant and leakage checks.
13. **What justifies no implementation?** Sparse or low-confidence evidence; no outcome concentration; failures dominated by provisioning/tooling that wording cannot address; the existing M112 caution already expressing the supported policy; excessive context cost; or inability to preserve rendering invariants and leakage safety. In that event the report will choose B, C, or D and may include a proposal only.
14. **What outputs will be produced?** Always: the final Markdown/JSON audit and JSON/CSV 97-case classifications. The deterministic helper, runner, and focused tests will be committed. Optional oracle-quality/next-action tables may be emitted. Only if the completed audit chooses A will the bounded decision-contract wording and a 10–14-case no-agent render smoke (detail JSON + CSV) be added.

## Guardrails

- No live agents, Claude, Codex, Docker evaluation, VEXP, baseline, V4/C7_D, revision/corrective/oracle arm, network/API call, environment mutation, or M105–M108 rerun.
- Raw run folders, streams, logs, workspaces, and package-lock churn remain unstaged.
- Retrieval, ranking, capsule file selection, and structured task derivation are outside scope.
- The final report and any wording implementation begin only after this plan exists; wording begins only after the audit computes and records decision A.
