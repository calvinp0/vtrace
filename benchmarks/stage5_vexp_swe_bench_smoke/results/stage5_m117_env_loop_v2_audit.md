# Stage 5 M117 Strategy-Aware Environment-Loop Redesign

## Summary

- Cases replayed: **97/97**.
- E1-v1 limitation: failure-root relatedness could collapse productive transitions between repository tests, installation, import checks, and standalone oracles.
- E1-v2 rule: classify failure root and verification strategy separately; fire on repeated equivalent strategy/root failures, equivalent dependency-install loops, or repo-test retries at the same environment boundary; edits and materially new strategies receive one attempt; successful relevant verification is persistently protected.
- Decision: **A**. Verdict: **PASS**. Recommendation: **freeze replay-only E1-v2**.

## Evaluation Constraint

No untouched M105-M108 holdout remains: M108 was evaluated in M116. M117 is a retrospective replay with cross-milestone stability and leave-one-milestone-out analysis. Each fold uses the identical frozen E1-v2 rule and merely inspects the omitted milestone; it is not a true prospective holdout. Prospective validation on future naturally occurring runs is still required.

## Failure Roots and Verification Strategies

Failure roots are dependency, package-manager, test-runner, import-environment, build-tool, service, permission/execution-environment, unrelated-repository, genuine-behavioral, and unknown. Strategies are repository suite, focused repository test, dependency installation, import smoke, syntax/compile, minimal issue reproduction, standalone behavioral oracle, property assertion, lint/typecheck, static reasoning, and unknown.

Normalization collapses interpreter spelling, pytest versus python -m pytest, leading ./, whitespace, redirection, and display-only pipes. It preserves test paths/selectors, script semantics, asserted values, and control inputs. Missing related dependencies therefore do not make a repo test and a standalone oracle equivalent.

## Episode State Machine

States are NONE, ISOLATED_FAILURE, RETRY_SAME_STRATEGY, ADAPTATION_ATTEMPT, RECOVERED, REPEATED_NONPROGRESS, LOOP, and AMBIGUOUS. A relevant source or oracle edit closes the retry chain and grants one new attempt. A materially different strategy starts its own episode. A first failed local oracle is an adaptation, not a repetition. Successful behavioral or static verification records recovery and prevents later post-recovery fire. A potential fire immediately before an observable standalone oracle is deferred and cancelled by that transition.

## Analyst-Justified Timing

The full evidence table is in stage5_m117_env_loop_v2_analyst_review.json. Must-fire observations: [{"instance_id":"django__django-16263","would_fire":true,"first_fire_turn":30,"state":"LOOP","recovery_turn":null,"timing_status":"within_analyst_window"},{"instance_id":"pylint-dev__pylint-4551","would_fire":true,"first_fire_turn":10,"state":"LOOP","recovery_turn":26,"timing_status":"within_analyst_window"}]. sphinx-9230 protects T6/T9 standalone parsing checks; sympy-24562 protects the T5 dependency-free exact-input oracle.

## E1-v1 vs E1-v2

- E1-v1 fires: 26; E1-v2 fires: 30.
- Row changes: unchanged=61, timing_changed=6, v1_fire_protected_by_v2=13, new_v2_fire=17.
- E1-v1 first fire min/median/p90/max: {"min":4,"median":6,"p90":14,"max":31}.
- E1-v2 first fire min/median/p90/max: {"min":3,"median":6,"p90":12,"max":30}.
- E1-v2 resolved/unresolved fires: 10/20.
- Operational false positives: 0; post-recovery 0; single-attempt 0; productive-transition 0; immediately-before-strong-oracle 0.
- Recovery-protected cases: 29; same-strategy loops: 11; dependency-install loops: 11; repo-test environment loops: 10; ambiguous/review-needed: 23.

The row-complete comparison is in stage5_m117_env_loop_v1_v2_comparison.csv.

## Milestone Stability

- M105: 14 cases, 6 fires (rate 0.429), premature 0, post-recovery 0, productive-transition 0, recovery-protected 4.
- M106: 10 cases, 4 fires (rate 0.4), premature 0, post-recovery 0, productive-transition 0, recovery-protected 4.
- M107: 26 cases, 8 fires (rate 0.308), premature 0, post-recovery 0, productive-transition 0, recovery-protected 5.
- M108: 47 cases, 12 fires (rate 0.255), premature 0, post-recovery 0, productive-transition 0, recovery-protected 16.

Fire rates are descriptive cohort differences, not causal or prospective estimates. Their maximum absolute range is 0.174; the preregistered stability interpretation is stable because the range is below 0.20 and every cohort has zero premature, post-recovery, and productive-transition fires. The four leave-one-milestone-out records in the audit JSON prove rule identity and report each omitted cohort separately.

## Positive and Negative Controls

- django-16263 and pylint-4551: 2/2 detected within analyst timing windows.
- sphinx-9230 and sympy-24562: both protected.
- Five single-attempt controls: 0 false fires.
- Strong-oracle wins: [{"instance_id":"astropy__astropy-14365","would_fire":false,"first_fire_turn":null,"state":"RECOVERED","recovery_turn":9,"timing_status":"protected_or_not_applicable"},{"instance_id":"pylint-dev__pylint-8898","would_fire":false,"first_fire_turn":null,"state":"ADAPTATION_ATTEMPT","recovery_turn":null,"timing_status":"protected_or_not_applicable"},{"instance_id":"sympy__sympy-24562","would_fire":false,"first_fire_turn":null,"state":"RECOVERED","recovery_turn":5,"timing_status":"protected_or_not_applicable"},{"instance_id":"django__django-11206","would_fire":false,"first_fire_turn":null,"state":"RECOVERED","recovery_turn":8,"timing_status":"protected_or_not_applicable"},{"instance_id":"matplotlib__matplotlib-25332","would_fire":false,"first_fire_turn":null,"state":"ADAPTATION_ATTEMPT","recovery_turn":null,"timing_status":"protected_or_not_applicable"},{"instance_id":"sphinx-doc__sphinx-7910","would_fire":false,"first_fire_turn":null,"state":"ADAPTATION_ATTEMPT","recovery_turn":null,"timing_status":"protected_or_not_applicable"}].
- Hard-loss cases: [{"instance_id":"astropy__astropy-7166","would_fire":false,"first_fire_turn":null,"state":"RECOVERED","recovery_turn":3,"timing_status":"protected_or_not_applicable"},{"instance_id":"sympy__sympy-15875","would_fire":false,"first_fire_turn":null,"state":"RECOVERED","recovery_turn":7,"timing_status":"missed"},{"instance_id":"django__django-12774","would_fire":true,"first_fire_turn":9,"state":"LOOP","recovery_turn":11,"timing_status":"within_analyst_window"},{"instance_id":"pydata__xarray-6938","would_fire":true,"first_fire_turn":8,"state":"LOOP","recovery_turn":null,"timing_status":"within_analyst_window"},{"instance_id":"django__django-12325","would_fire":true,"first_fire_turn":8,"state":"LOOP","recovery_turn":null,"timing_status":"within_analyst_window"}]. E1 relevance is reported per case and is not forced where wrong-oracle evidence explains the loss.

## V4/C7_D Comparison

Among E1-v2 fires, V4 overlap is 2, C7_D overlap is 2, and E1-only coverage is 26. V4 timing earlier/equal/later is 1/0/1; C7_D timing is 1/0/1. Cost distribution with/without fire is {"fire":{"count":30,"mean":0.717,"min":0.370545,"median":0.5579955000000001,"p90":1.0456985,"max":3.00762},"no_fire":{"count":67,"mean":0.525,"min":0.18856050000000002,"median":0.45944149999999995,"p90":0.8499125000000001,"max":1.8829155}}; tool-call distribution is {"fire":{"count":30,"mean":13.267,"min":6,"median":11,"p90":21,"max":38},"no_fire":{"count":67,"mean":9.104,"min":3,"median":8,"p90":15,"max":44}}. These are retrospective outcome/cost joins and never detector inputs. V4 and C7_D remain default-off.

## Decision

Decision **A**: the named must-fire controls are timely, recovery/single-attempt/strong-oracle protections have zero operational false positives, the rule is identical across cohorts, and execution remains outcome/gold blind. This decision authorizes no runtime integration. Future prospective validation remains required.

## Limitations

This is retrospective analysis over previously inspected runs. Strategy equivalence uses deterministic command semantics and still requires analyst review where shell chains or oracle intent are unclear. Successful static verification proves only that static check, not behavioral correctness. Captured output cannot supply unavailable semantic certainty. No runtime-effect claim is made.

## Success Criteria Check

1. No prohibited live/spend/environment path: **PASS**.
2. All 97 runs replayed: **PASS**.
3. No untouched-holdout claim: **PASS**.
4. Failure root and strategy separated: **PASS**.
5. Productive transitions represented: **PASS**.
6. Single reasonable attempts protected: **PASS**.
7. No fire after successful recovery: **PASS**.
8. Sphinx/SymPy recovery controls protected: **PASS**.
9. Named must-fire controls timely: **PASS**.
10. Gold/outcome-blind detector: **PASS**.
11. Complete 97-row v1/v2 comparison: **PASS**.
12. Per-milestone stability reported: **PASS**.
13. Explicit decision: **PASS (A)**.
14. No runtime integration: **PASS**.
15. Tests/typechecks: **PASS** (3711 tests across 213 files, both typechecks, and diff check).

## Verdict

**PASS**

## Recommendation

**freeze replay-only E1-v2**. Wait for future naturally occurring runs for prospective validation.
