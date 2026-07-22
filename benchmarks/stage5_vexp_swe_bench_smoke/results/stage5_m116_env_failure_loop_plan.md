# Stage 5 M116 Environment-Failure-Loop Plan

_Preregistered before detector implementation or replay. Offline captured-artifact work only: no agents, Docker, APIs, VEXP, reruns, baselines, environment changes, or live guard arms._

## Scope and claim boundary

M116 asks whether a deterministic, gold-blind diagnostic can identify repeated verification commands that fail for an unavailable execution environment without observed material progress. E1 is an inefficiency and verification-risk diagnostic, not a correctness, resolution, stopping, dependency-installation, or failure predictor. It is default-off, observe-only, and non-intervening if runtime integration is justified.

## 1. Ordered artifact coverage

For each of the 97 valid M105–M108 cases, the milestone detail file maps `instance_id` to `run_label`. The corresponding read-only `results/runs/<run_label>/raw/vtrace/_tool_calls_with_outputs.json` supplies ordered tool calls, Bash commands, outputs, and indexes; `_agent_stream.first_pass.jsonl` supplies the complete event stream and final text. The four committed `stage5_m10{5,6,7,8}_live_runs.detail.json` files supply milestone, validity, cost, turn/tool totals, changed files, and evaluation outcome. M113 reports 97/97 transcript and ordered-output coverage and a committed-detail fallback for `django__django-13513`; any replay fallback will be explicit per row rather than silently synthesizing events.

## 2. Deterministic event types

The extractor will derive, in source order:

- `verification_command`: repository test, focused reproduction/local oracle, import smoke, or lint/typecheck/syntax verification;
- `environment_failure`: a failed verification with one distinct family;
- `relevant_assertion_failure`: behavioral failure, explicitly not an environment failure;
- `successful_verification`: successful repository test, behavioral local oracle, import smoke, or syntax/lint check, with strength retained;
- `source_edit` and `test_or_oracle_edit` from Edit/Write calls;
- `repository_evidence`: a new read/search target between failed attempts;
- `hypothesis_change`: analyst-reviewable only unless a deterministic different command target/oracle family proves it;
- `progress_reset`, `recovery`, `repeat_equivalent`, and `diagnostic_fire` state-machine events.

Tool-call index is the canonical turn for replay. Commands are normalized only for equivalence: whitespace, harmless shell wrappers/redirections, output truncation pipes, and interpreter spelling are cosmetic; targets, test selectors, script bodies, and asserted behavior remain semantic.

## 3. M113 machine/judgment boundary

M113 machine-derived fields include ordered commands and outputs, repo-test detection/result, coarse environment signature, command-loop heuristic, successful semantic-command evidence, cost/turn/tool totals, changed files, and artifact presence. Analyst-derived fields include strong/wrong oracle maps, oracle quality, exact-issue relevance, failure/cause/next-action judgments, environment response interpretation, confidence, and cited narrative. M116 will not reuse analyst conclusions as detector inputs. They may seed an explicit review/control table and evaluate machine classifications after replay.

## 4. Environment failure

An environment failure is a verification command whose output deterministically matches one of: `missing_dependency`, `missing_pip`, `pip_blocked_by_policy`, `command_not_found`, `module_import_error`, `pytest_collection_failure`, `unavailable_service`, `missing_build_tool`, `unrelated_repository_failure`, `permission_or_execution_environment_failure`, or `unknown_environment_failure`. Precedence will preserve specific families (policy block before missing pip; collection failure before generic import/dependency). A relevant assertion/test failure is never an environment failure. A mere nonzero exit without an environment signature remains a relevant or unknown command failure and cannot advance E1.

## 5. Material progress

Between environment-failed verification attempts, machine-observable material progress is:

- an Edit/Write to relevant source, test, or an oracle subsequently executed;
- a successful behavioral local oracle, focused import, or focused verification;
- a meaningfully different verification target, selector, reproduction body, or asserted behavior;
- evidence that the prior environment problem was resolved;
- new repository evidence tied to a different target/hypothesis (analyst confirmation may be required).

Rerunning an equivalent command, changing only shell syntax/path guesses, retrying pip/install, or rereading/researching the same target is not progress. A source edit resets the pending equivalence streak, so the next test is a fresh reasonable attempt rather than an immediate E1 fire.

## 6. Loop distinctions

- One failed verification produces `ISOLATED_ENV_FAILURE`, never a fire.
- A rerun after a relevant edit begins a new episode and cannot fire on that attempt alone.
- A successful or meaningfully different local oracle produces `RECOVERED_AFTER_ENV_FAILURE` and suppresses the prior episode.
- A different target/selector/script body is a new hypothesis unless it collapses to the same failure before reaching any new behavior; ambiguous cases are marked for review.
- Equivalent same-family failures without progress may fire on the second failure. Related but different families require three failures without progress. The extractor will retain both observed and normalized commands so analyst review can audit equivalence.

## 7. Diagnostic output

Per run E1 emits state, would-fire, first environment-failure turn, first-fire turn, family at fire, repetition count, material-progress events, progress-reset count/reason, successful recovery/local-oracle evidence, analyst-review flag, and a neutral report-only message: “Repeated verification attempts are failing for the same environment reason without observed material progress.” It never emits a predicted outcome or action instruction.

## 8. Possible runtime seam

If decision A is earned, integration belongs beside existing Stage 5 ordered PostToolUse telemetry in the runner/hook layer, fed only completed tool calls and outputs. A proposed `--env-failure-loop-observe` flag defaults false. It may serialize version, enabled/state/timing/family/count/reset/recovery fields, but must not inject text, stop/nudge the agent, mutate prompts/context, or affect retrieval/capsules. Runtime code will not be written until the offline rule is frozen and replayed.

## 9. Gold-blind calibration

Detector inputs exclude `live_resolved`, eval metadata, M103 gold coverage, gold files/patches, analyst oracle quality, and final benchmark outcome. Development examines only commands, outputs, edits, ordered evidence, and predeclared controls. Resolution is joined after states are frozen solely for descriptive reporting. Tests will prove that changing/excluding outcome does not change detector output.

## 10. Split and freeze protocol

- Development: M105+M106, 24 runs.
- Validation: M107, 26 runs.
- Holdout: M108, 47 runs.

Develop extraction and compare candidate thresholds only on development. Freeze a versioned configuration before evaluating M107. After validation, permit parser/signature bugs only, with each fix documented and no threshold changes. Evaluate M108 exactly once after the validated implementation is frozen. If an artifact incompatibility forces a change, stop and record a revised preregistration before opening holdout data.

## 11. Required controls

Positive controls are `django__django-16263`, `pylint-dev__pylint-4551`, plus development cases with repeated equivalent environment failures and no progress. Hard-loss audits include `astropy__astropy-7166`, `sympy__sympy-15875`, `django__django-12774`, `pydata__xarray-6938`, and `django__django-12325`. At least five M113 resolved command-loop cases, five isolated/recovered environment-failure cases, and the strong-oracle wins `astropy__astropy-14365`, `pylint-dev__pylint-8898`, `sympy__sympy-24562`, `django__django-11206`, `matplotlib__matplotlib-25332`, and `sphinx-doc__sphinx-7910` are negative/productive-recovery controls. Control membership and analyst judgments will live in a cited JSON table, not detector code.

## 12. Gate for decision A

Implement default-off observe-only runtime E1 only if both named positive controls fire; no single-attempt control fires; productive recovery and strong-oracle transitions are protected; holdout behavior is stable; first-fire timing precedes avoidable repetition but not recovery; all inputs are gold/outcome blind; runtime/offline turns can match deterministically; and disabled byte parity plus prompt/context/retrieval invariants can be proved without an agent.

## 13. Gate for report-only deferral

Choose B if offline signal is useful but captured/runtime output fidelity cannot support trustworthy first-fire telemetry. Choose C if progress/hypothesis ambiguity frequently flags productive recovery or E1 only duplicates V4/C7_D. Choose D if repeated environment failures cannot be distinguished from reasonable retries. Decisions B–D produce replay/report artifacts only.

## 14. V4/C7_D comparison

Replay existing pure `runToolLoopGuard` V4 and `runCostGuard` C7_D logic over the same captured ordered events where conversion is supported, without enabling either arm. Record would-fire and first-fire turn per case, then calculate E1 intersections, timing deltas, and E1-only coverage. Missing inputs are `unknown`, not false. M116 cannot change the standing default-off policy for V4/C7_D.

## 15. Outputs

Always produce the plan, Markdown audit, aggregate audit JSON, 97-row replay detail JSON and CSV, explicit analyst-review JSON, and next-action queue. The replay rows contain every requested detector, outcome-for-evaluation, overlap, cost/token, and review field. If and only if A is chosen, also produce runtime source/tests and a no-agent runtime-smoke detail JSON proving flag-off byte parity, no context/retrieval effects, determinism, and offline/runtime first-fire parity.

## Frozen candidate family to evaluate

Candidate E1 rules are: (1) fire on a second equivalent same-family environment-failed verification with no intervening progress/reset; or (2) fire on a third verification environment failure across related families in one no-progress episode. Successful verification/local-oracle recovery ends the episode. Relevant edits reset it. Different meaningful verification targets start a fresh episode. Development will choose normalization details and whether rule (2) is supportable; the chosen thresholds and configuration will be versioned before validation/holdout.
