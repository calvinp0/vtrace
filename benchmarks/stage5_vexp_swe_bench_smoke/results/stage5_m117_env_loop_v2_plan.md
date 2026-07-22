# Stage 5 M117 Strategy-Aware Environment-Loop Redesign Plan

_Preregistered before E1-v2 implementation. This is offline retrospective replay over the 97 valid M105–M108 captured runs. No live agents, Docker, APIs, VEXP, fresh baselines, environment mutation, or runtime integration are permitted._

## Scope and evaluation boundary

M117 asks whether an environment-loop classifier can distinguish a repeated, non-progressing verification strategy from a productive transition away from an unavailable repository test toward a useful local oracle. Detector inputs are limited to ordered tool calls, command text, command output, edits, and machine-observable success. Resolution and cost are joined only after replay for descriptive reporting. Gold files, gold patches, evaluation metadata, and final resolution cannot affect rule execution.

There is no untouched M105–M108 holdout. M108 was already evaluated in M116. M117 therefore uses retrospective replay, per-milestone stability, and four leave-one-milestone-out inspections. These folds are sensitivity analyses, not prospective or untouched-holdout validation. The frozen E1-v2 rule must be identical in all reported folds, and future naturally occurring runs are still required for prospective validation.

## Case diagnosis before redesign

1. **Why `sphinx-9230` fired after recovery.** After source edits, standalone parsing/property checks succeeded at turns 6 and 9. The agent then tried repository tests at turns 10 and 11 and an import-dependent issue reproduction at turn 12. All three later attempts met related environment boundaries (`pytest`, `pip`, and `docutils`). E1-v1 cleared only its current failure episode on success; it did not preserve a recovered strategy state. Its broad third-related-family rule therefore treated the later attempts as a new loop and fired at 12. E1-v2 must protect the successful standalone behavioral/property strategy and must not convert later, distinct repo-test/import strategies into a post-recovery fire.
2. **Why `sympy-24562` fired before its strong oracle.** Turns 2–4 tried the repository-backed SymPy reproduction, dependency installation, and the same import-dependent reproduction. Their roots were related (`mpmath` unavailable / package manager unavailable), so E1-v1 fired at turn 4 under the third-related-family rule. At turn 5 the agent switched to a dependency-free exact-input standalone logic oracle and proved `1/200`. The observable construction and execution of that materially different strategy should open a recovery opportunity before it runs; E1-v2 must not fire immediately before it.
3. **Why `django-16263` fired only at turn 31.** The agent made relevant source edits through turn 27. The first post-edit verification failed at turn 28 because `asgiref` was unavailable, followed by package-install attempts at turns 29–30 and an equivalent import smoke at 31. Under v1, edits correctly kept earlier history out of the episode, and the loop became visible only in this late verification/install chain. E1-v2 should fire within the analyst-acceptable turns 30–31, not before turn 29.
4. **Why `pylint-4551` fired at turn 14.** After source edits, the exact astroid-backed reproduction failed twice at turns 9–10, install/retry attempts failed at 11–12, and environment inspection at 13 led to another astroid import at 14. V1 fired at 14 because normalization did not collapse the two multiline reproductions reliably and its related-family count accumulated across attempts. The loop was already justified at turn 10 as an equivalent same-strategy/root retry; E1-v2 should fire no later than 14 and not before 10.
5. **Failure families incorrectly treated as equivalent.** V1 over-collapsed missing dependency, missing pip/package-manager, pytest unavailability/collection, and import-environment failures whenever three occurred in one episode. In particular, a repo-test boundary, an installation attempt, and a new standalone oracle were treated as related repetitions even though their strategies differed. E1-v2 separates the failure root from the strategy and permits cross-root accumulation only for repeated installation attempts or repeated repo-test attempts at the same boundary.

## Failure roots and verification strategies

Every verification event receives two independent labels.

Failure roots are `dependency_unavailable`, `package_manager_unavailable`, `test_runner_unavailable`, `import_environment_unavailable`, `build_tool_unavailable`, `service_unavailable`, `permission_or_execution_environment`, `unrelated_repository_failure`, `genuine_behavioral_failure`, or `unknown`.

Verification strategies are `repo_test_suite`, `focused_repo_test`, `dependency_installation`, `import_smoke`, `syntax_or_compile_check`, `minimal_issue_reproduction`, `standalone_behavioral_oracle`, `property_assertion`, `lint_or_typecheck`, `static_repository_reasoning`, or `unknown`.

6. **Productive transitions.** Repository suite to focused changed-behavior test; unavailable repo/focused test to minimal issue reproduction; import-dependent reproduction to dependency-free standalone behavioral oracle; generic reproduction to a new property assertion or nearby control; failed import smoke to a meaningfully different import smoke; and any failed dynamic check to successful relevant syntax, compile, lint, typecheck, or static repository reasoning are productive adaptations. They open a recovery opportunity rather than advancing the old retry count.
7. **New verification strategy.** A new strategy changes the verification mechanism, semantic target, selector, asserted property, control case, or dependency boundary in a way that could produce new evidence about the changed behavior. A newly written script body with issue-specific assertions is distinct from a repo test even if both invoke Python.
8. **Same failed strategy.** Cosmetic interpreter changes, `pytest` versus `python -m pytest`, `./` path spelling, output pipes/redirections, wrapper shells, or an unchanged target/assertion are repetitions. Different focused selectors and genuinely different issue reproductions remain distinct.

## Episode and progress policy

The state machine uses `NONE`, `ISOLATED_FAILURE`, `RETRY_SAME_STRATEGY`, `ADAPTATION_ATTEMPT`, `RECOVERED`, `REPEATED_NONPROGRESS`, `LOOP`, and `AMBIGUOUS`.

An environment failure opens an episode keyed by normalized strategy identity and failure root. A second equivalent strategy/root failure without progress reaches `LOOP`. Repeated dependency-installation attempts across equivalent package-manager roots may reach `LOOP`. Repeated repo-test attempts at the same environment boundary may reach `LOOP`. Three related failures reach `LOOP` only when no strategy transition, relevant edit, new hypothesis, oracle construction, or local-oracle attempt intervened.

A materially different strategy creates `ADAPTATION_ATTEMPT` and receives one attempt. If it fails, that result becomes an isolated failure in its own episode. It may fire only after the new strategy itself repeats without progress. A successful relevant verification or strong observable local oracle reaches `RECOVERED`; later unrelated environment attempts cannot create a post-recovery fire in this replay classifier.

9. **Source edits.** A relevant source edit closes the current retry chain, records material progress, and grants one fresh verification attempt. It does not erase the audit history. A second equivalent failure after that allowance may establish a new loop episode.
10. **Failed local oracle.** A genuinely new local oracle is an adaptation attempt even if its first execution fails because of the environment. Its own first failure cannot fire. An equivalent rerun with the same root and no intervening progress may fire. A behavioral assertion failure is not an environment-loop input.
11. **Successful static verification.** Successful syntax/compile/lint/typecheck is relevant recovery evidence for its strategy and prevents a post-recovery fire, while remaining weaker than a behavioral oracle in the analyst report. It cannot turn an incorrect oracle into a correctness claim.

Test/oracle edits record strategy progress and grant the changed oracle one run. The extractor will recognize Edit/Write calls and shell-built temporary scripts. Observable construction of a new standalone oracle before execution creates a protected transition; this is necessary to avoid firing immediately before a strong oracle.

## Command normalization

Normalize interpreter spelling, `pytest` versus `python -m pytest`, leading `./` on the same test path, whitespace, benign environment prefixes, redirections, and `head`/`tail` display pipes. Preserve focused selectors, distinct test paths, inline script bodies, temporary script contents, asserted values, and control inputs. Package-install commands normalize by manager/action/package, while repo-test attempts normalize by semantic test target and selector.

## Analyst-justified timing preregistration

| Instance | Earliest justified loop turn | Latest acceptable fire | Must not fire before | Reason and supporting tool events |
|---|---:|---:|---:|---|
| `django__django-16263` | 30 | 31 | 29 | T28 first `asgiref`-blocked reproduction; T29–30 repeat package-install/retry strategy; T31 confirms the same unavailable import. |
| `pylint-dev__pylint-4551` | 10 | 14 | 10 | T9 and T10 repeat the same astroid-backed reproduction with the same missing dependency; T11–12 repeat installation/retry; T14 confirms no executable environment. |
| `sphinx-doc__sphinx-9230` | null | null | end | T6 and T9 successful standalone parsing/property checks are the protected recovery; T10 repo test, T11 install, and T12 import-dependent reproduction are different strategies and must not cause a post-recovery fire. |
| `sympy__sympy-24562` | null | null | 5 | T2 import-dependent issue reproduction, T3 installation, T4 import retry; the T5 dependency-free exact-input oracle construction/execution is the protected recovery transition. |
| `astropy__astropy-7166` | null | null | end | T2 import-dependent oracle fails; T3 switches to a dependency-free standalone reproduction and succeeds. The oracle is analyst-rated wrong, so E1 is not relevant to the final loss. |
| `sympy__sympy-15875` | 6 | 9 | 6 | T4 import-dependent issue reproduction, T5 install, T6 equivalent import retry; T8–10 continue environment work. Later T13 oracle is analyst-rated wrong, so E1 may diagnose the earlier loop but not the correctness failure. |
| `django__django-12774` | 9 | 10 | 9 | T7 local reproduction fails, T8 changes to focused pytest, and T9–10 repeat repo-test attempts at the same unavailable Django environment boundary. T11 syntax success must prevent later fire. |
| `pydata__xarray-6938` | 8 | 8 | 8 | T7 and T8 are cosmetically different interpreters running the same issue reproduction with the same missing NumPy root. |
| `django__django-12325` | 8 | 9 | 8 | T7 and T8 repeat the same MTI reproduction through different invocation forms at the same unavailable Django boundary; T9 is a package-manager attempt. The final loss remains an oracle/edit-quality question, not proof that E1 must fire. |

`null` means the transcript does not justify a loop fire. Analyst timing is evaluation metadata, never detector input.

## Retrospective evaluation

12. **Evaluation without a new holdout.** Replay all 97 runs once with the frozen rule; report M105, M106, M107, and M108 separately; and inspect four leave-one-milestone-out folds (design labels M106+M107+M108 / inspect M105, and analogously for M106, M107, M108). The implementation and thresholds remain identical across folds. These are cross-milestone stability checks, not untouched-holdout evidence. Prospective validation remains required.
13. **Operational false positive.** A fire is false when it occurs after successful recovery, during a clearly productive strategy transition, on a single reasonable attempt, or after material progress before the newly allowed attempt has been evaluated. A resolved run that genuinely looped before recovering is not automatically false.
14. **Freeze justification.** Freeze replay-only E1-v2 only if both must-fire controls fire within analyst bounds; single-attempt, post-recovery, productive-transition, and immediately-before-strong-oracle false fires are all zero; all named strong-oracle transitions are protected; milestone behavior is not materially unstable; and code/tests prove deterministic, gold-blind, outcome-blind execution. Freezing does not authorize runtime integration.
15. **Archive justification.** Archive E1 if strategy identity, progress, and oracle construction cannot be extracted consistently enough to protect productive transitions, if operational false positives remain after redesign, or if useful loop coverage disappears and E1 adds no reliable information beyond V4/C7_D.

## Controls and required reporting

Must-fire controls are `django__django-16263` and `pylint-dev__pylint-4551`. Must-protect controls are `sphinx-doc__sphinx-9230` and `sympy__sympy-24562`. Single-attempt controls reuse `astropy__astropy-14539`, `django__django-10880`, `django__django-12050`, `django__django-13658`, and `django__django-16877`. Strong-oracle wins are `astropy__astropy-14365`, `pylint-dev__pylint-8898`, `sympy__sympy-24562`, `django__django-11206`, `matplotlib__matplotlib-25332`, and `sphinx-doc__sphinx-7910`. Hard-loss review covers the five cases in the timing table.

The audit will report all required counts and distributions, row-level E1-v1/v2 changes, milestone cohorts, leave-one-milestone-out integrity, V4/C7_D overlap and timing, and retrospective resolution/cost/tool distributions. V4 and C7_D remain default-off. No runtime flag, hook, prompt injection, interruption, early stopping, retrieval change, or ranking change will be added.

## Decision rule

- **A:** freeze replay-only E1-v2 and await future prospective validation when every protection/timing/stability gate passes.
- **B:** retain E1-v1 analysis-only if v2 protects recovery but loses important loop coverage.
- **C:** redesign again if any operational false positive remains.
- **D:** archive E1 if strategy/progress distinctions are not reliable.

PASS requires all stated success criteria, including 97/97 replay and no runtime effect. MIXED applies if recovery protection improves but loop timing or cross-milestone coverage remains unstable. FAIL applies if productive recovery or a single attempt still fires, outcome/gold enters the detector, or runtime behavior changes.
