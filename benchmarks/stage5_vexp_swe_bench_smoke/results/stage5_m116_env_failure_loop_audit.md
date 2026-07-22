# Stage 5 M116 Environment-Failure-Loop Diagnostic

## Summary

- Cases replayed: **97/97**; ordered tool-output coverage 97/97.
- Split: development M105+M106 **24**, validation M107 **26**, holdout M108 **47**.
- Frozen rule: E1-v1 fires on the second equivalent same-family environment-failed verification without progress, or the third related-family failure in one no-progress episode; relevant edits and successful verification reset the episode.
- Decision: **C**. Verdict: **MIXED**. Recommendation: **redesign environment-loop detection**.

## Motivation

M113 found environment limitations in all repository-test attempts and 47 broad command loops, split almost evenly by final outcome. A loop is therefore a cost/tooling and verification-risk signal, not a prediction that the patch fails. E1 asks only whether repeated environment-failed verification proceeds without observed material progress.

## Method

The replay joins the four committed M105–M108 detail files to each run's read-only ordered `_tool_calls_with_outputs.json`. Verification commands, distinct environment families, assertion failures, successful checks, edits, normalized equivalence, and turn indexes are machine-derived. New-hypothesis relevance and whether a fire is useful/premature/late remain explicit analyst fields in `stage5_m116_env_failure_loop_analyst_review.json`.

The detector receives no resolution, eval, gold-file, or gold-patch field. `live_resolved` is joined only after replay for descriptive evaluation.

## Rule Calibration

Development used M105+M106 (24) and froze E1-v1 before M107. Validation used M107 (26) without threshold tuning. M108 (47) was opened once for the decision evaluation after the parser and thresholds were frozen. The unchanged frozen replay was subsequently rerun only to package the required combined 97-row artifacts after a reporting-only minimum-percentile display fix. No post-freeze detector or threshold changes were made; this packaging rerun is disclosed rather than treated as independent holdout evidence.

## Replay Results

- State distribution: AMBIGUOUS=19, ENV_FAILURE_LOOP=26, ISOLATED_ENV_FAILURE=12, NONE=8, RECOVERED_AFTER_ENV_FAILURE=29, REPEATED_ENV_FAILURE=3.
- Environment failure prevalence: 89/97; repeated failures: 64/97; E1 fires: 26/97.
- Fires by outcome: resolved 11, unresolved 15. A resolved fire is not a false positive.
- First-fire turns: min 4, median 6, p90 14, max 31.
- Mean cost fire/no-fire: $0.75/$0.524; mean tool calls fire/no-fire: 13.423/9.282.

## Positive and Negative Controls

- django-16263: {"instance_id":"django__django-16263","state":"ENV_FAILURE_LOOP","would_fire":true,"first_fire_turn":31}.
- pylint-4551: {"instance_id":"pylint-dev__pylint-4551","state":"ENV_FAILURE_LOOP","would_fire":true,"first_fire_turn":14}.
- Five resolved-loop controls: [{"instance_id":"django__django-11749","state":"AMBIGUOUS","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-13012","state":"RECOVERED_AFTER_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-13810","state":"AMBIGUOUS","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-13820","state":"RECOVERED_AFTER_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-14608","state":"REPEATED_ENV_FAILURE","would_fire":false,"first_fire_turn":null}].
- Recovered controls: [{"instance_id":"astropy__astropy-14365","state":"RECOVERED_AFTER_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-11133","state":"ISOLATED_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-11206","state":"RECOVERED_AFTER_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-11728","state":"RECOVERED_AFTER_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-11815","state":"RECOVERED_AFTER_ENV_FAILURE","would_fire":false,"first_fire_turn":null}].
- Single-attempt controls: [{"instance_id":"astropy__astropy-14539","state":"ISOLATED_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-10880","state":"ISOLATED_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-12050","state":"ISOLATED_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-13658","state":"ISOLATED_ENV_FAILURE","would_fire":false,"first_fire_turn":null},{"instance_id":"django__django-16877","state":"ISOLATED_ENV_FAILURE","would_fire":false,"first_fire_turn":null}].
- Required hard-loss and strong-oracle controls are recorded in the audit JSON and analyst table.

## Productive Recovery

Fires after a successful recovery: **1**. Fires in runs with any later successful local oracle: **2**. `sphinx-doc__sphinx-9230` is the operational false positive: E1 fired after recovery. `sympy__sympy-24562` fired one turn before a strong local oracle, making it a premature productive-recovery control failure. These are why decision C is selected even though both positive controls fired.

## V4/C7_D Comparison

Among E1 fires, V4 overlap is 0, C7_D overlap is 2, and E1-only coverage is 24. V4 timing (earlier/equal/later) is 0/0/0; C7_D timing is 1/0/1. Existing pure detectors were replayed only; neither arm was enabled. Both remain default-off.

## Runtime Integration

No runtime observe mode was implemented. The offline result did not satisfy every decision-A protection/timing gate, so there is no flag, prompt/context mutation, or runtime telemetry change.

## Limitations

Command output can establish signatures but not semantic relevance. Different command targets are conservatively marked ambiguous. Successful syntax/import checks are recovery evidence but not necessarily strong behavioral oracles. Cost/turn totals are available only after a captured run; C7_D comparison is post hoc. M116 provides no live-effect claim.

## Next-Action Queue

The no-spend-first queue is in `stage5_m116_next_action_queue.json`. Live study remains deferred and would require separate approval and preregistration.

## Success Criteria Check

1. No prohibited live/spend/environment path: **PASS**.
2. All valid runs replayed or missing explicit: **PASS**.
3. Chronological 24/26/47 split and freeze: **PASS**.
4. Gold/outcome excluded from detector: **PASS**.
5. Assertion failures distinguished from environment failures: **PASS**.
6. Progress/recovery represented: **PASS**.
7. Single attempts cannot fire: **PASS**.
8. Positive, resolved-loop, recovery, hard-loss, and strong-oracle controls: **PASS**.
9. Holdout without threshold retuning: **PASS**.
10. V4/C7_D overlap measured offline: **PASS**.
11. A/B/C/D explicit: **PASS (C)**.
12. Runtime behavior unchanged: **PASS (no runtime integration)**.

## Verdict

**MIXED**.

## Recommendation

**redesign environment-loop detection**. Preserve the useful offline event extractor and redesign episode recovery so a successful oracle suppresses later unrelated environment retries; require stronger equivalence before an early three-family fire.
