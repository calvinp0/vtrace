# Stage 5 M113 Verification-Oracle Prompt-Policy Audit

_2026-07-22. Plan: `stage5_m113_verification_oracle_audit_plan.md`. Captured-artifact analysis only._

## Summary

- **Cases analyzed:** 97 valid live runs (M105 14, M106 10, M107 26, M108 47); the three recorded-invalid M108 rows were excluded explicitly.
- **Artifact coverage:** 97/97 first-pass transcripts and ordered tool outputs; 96/97 raw eval metadata, with django-13513's committed evaluated detail row as the sole fallback.
- **Main finding:** normal repo verification was almost entirely blacked out by missing dependencies/tooling. Strong oracles occurred only in resolved runs and both wrong oracles were unresolved. Environment-command loops were common in both outcomes and only modestly more frequent among unresolved runs, so they are primarily a cost/tooling signal rather than a sufficient outcome explanation.
- **Decision:** **A — implement small verification wording in this milestone.**
- **Verdict:** **PASS.**
- **Recommendation:** implement/keep compact verification-oracle guidance, then design the env-failure-loop diagnostic offline and default-off.

## Method

- Used committed M105–M108 detail rows, M103 deterministic rows, M111 classifications, and read-only per-run transcripts/tool outputs/patch metadata. No captured artifact is staged.
- No live agents, Claude, Codex, Docker, APIs, VEXP, baselines, V4/C7_D, revision/corrective/oracle arms, environment mutation, or reruns.
- Machine fields: commands, semantic failure outputs, repo-test attempts/results, environment signatures, command loops, changed files, resolution, costs, and capsule fields. Analyst fields: oracle quality, overlapping failure-mode choice, primary cause, next action, and confidence. Every row carries clipped command/output evidence and an analyst summary.
- Gold boundary: M103 gold-file booleans are post-hoc strata only. Gold patch hunks and hidden tests were not read to decide what an agent should have known. Oracle quality is judged from issue-authored behavior, inspected repository logic, and captured commands/output.
- Limitation: a passing isolated script proves only the modeled behavior; medium oracles may omit integration behavior. django-13513 lacks raw eval meta but has committed resolution/eval status. No classification is inferred from unavailable hidden-test contents.

## Overall Verification Behavior

- Verification attempted: **97/97**.
- Repo tests attempted: **25/97**; results: {"failed_environment":25,"not_run":72}.
- Local/static oracle attempted: **97/97**; quality: {"strong":11,"weak":71,"wrong":2,"medium":13}.
- Environment signatures: {"missing_dependency":52,"missing_pip":37,"import_error":1,"none":7}.
- Wrong oracle: **2**. No oracle: **0**. Verification blackout primary cause: **13**. Command loops: **47**.
- Irrelevant-oracle / irrelevant-test classifications: **0 / 0**. Over-trusted partial/passing checks among unresolved runs: **13 / 5**.

| oracle quality | cases | resolved | unresolved | resolved rate |
|---|---:|---:|---:|---:|
| medium | 13 | 6 | 7 | 46.2% |
| strong | 11 | 11 | 0 | 100.0% |
| weak | 71 | 38 | 33 | 53.5% |
| wrong | 2 | 0 | 2 | 0.0% |

## Resolved vs Unresolved

- Resolved: **55**; unresolved: **42**.
- Strong/medium oracle use: resolved **17/55** versus unresolved **7/42**.
- Weak/none/wrong: unresolved **35/42**, versus resolved **38/55**.
- Wrong oracles are exclusively unresolved (2; resolved 0). Command loops are 23/42 unresolved versus 24/55 resolved; the slight rate difference does not support treating loops alone as the resolution cause.
- Deterministic capsule quality did not guarantee oracle quality: among all-gold-in-capsule runs, oracle qualities were {"strong":7,"weak":58,"wrong":1,"medium":9}. This supports M111's separation: localization can succeed while verification remains weak.

## Hard-Loss Subset

- The 13 M111 strict losses: verification attempted **13/13**; repo-test attempted **4/13**; environment failure **13/13**; local/static oracle attempted **13/13**; executable local oracle built **2/13**; wrong oracle **2/13**; command loop **8/13**; finalized explicitly uncertain or after a wrong passing oracle **10/13**.
- **astropy__astropy-7166** — wrong/doctest_or_docstring_check; wrong_oracle; The standalone check asserted fget.__doc__, while the issue-visible behavior concerns property.__doc__; the self-oracle encoded the wrong observable. The wording can address this by requiring the oracle to match the issue's changed observable, not a convenient internal proxy.
- **sympy__sympy-15875** — wrong/property_assertion; wrong_oracle; The venv script explicitly accepted is_zero=None ('should be None or True'), weakening the issue-visible expectation and declaring success on the failing behavior. The wording can address this by requiring exact expected behavior rather than weakening the assertion until it passes.
- **django__django-12774** — weak/property_assertion; command_loop; Only failed runtime attempts, syntax/import checks, or static reasoning were available; this cannot establish behavior. The default `in_bulk()` crash received only syntax/static verification; even one repository-grounded default-call oracle could have exposed it.
- **pydata__xarray-6938** — weak/property_assertion; overtrusted_partial_check; Only failed runtime attempts, syntax/import checks, or static reasoning were available; this cannot establish behavior. Wording may encourage an exact mutation/reuse reproduction, but the missing second-file propagation remains primarily the M112 per-file-action concern.
- **django__django-12325** — weak/property_assertion; command_loop; Only failed runtime attempts, syntax/import checks, or static reasoning were available; this cannot establish behavior. No local substitute followed the distutils failure; verification wording can encourage one, while M112 separately addresses the omitted required file.
- **django__django-16263** — weak/minimal_script; command_loop; Only failed runtime attempts, syntax/import checks, or static reasoning were available; this cannot establish behavior. This is tooling/loop work: a prompt reminder is not a substitute for the proposed default-off env-loop diagnostic.
- **pylint-dev__pylint-4551** — weak/minimal_script; command_loop; Only failed runtime attempts, syntax/import checks, or static reasoning were available; this cannot establish behavior. Likewise dominated by astroid/pip failures and feature-scale scope; defer to diagnostic design rather than claim wording will fix it.
- What wording can address: the two wrong self-oracles, missing exact-input local checks, and unqualified confidence after syntax/static checks. What it cannot address: dependency provisioning, command-loop control, or multi-file implementation scope.

## Strong-Oracle Wins

| instance | oracle | exact issue inputs | structured-task contribution | why strong |
|---|---|:---:|---|---|
| astropy__astropy-14365 | exact_issue_reproduction | yes | yes — the derived task retained the lowercase `read serr 1 2` traceback input | The standalone parser copied the changed repository logic and exercised the issue's exact lowercase command plus data/NO variants. |
| django__django-11133 | exact_issue_reproduction | yes | yes — memoryview content is the issue's exact behavior | A compatible interpreter executed bytes(memoryview(...)) and checked the response-content primitive directly. |
| django__django-11206 | exact_issue_reproduction | yes | yes — Decimal('1e-200') and decimal_pos=2 were retained | The isolated repository logic checked the exact issue input and expected '0.00', with nearby exponent controls. |
| django__django-11728 | exact_issue_reproduction | yes | yes — the trailing named-group pattern was retained | The regex helper was exercised on the exact trailing-group shape and a slash-terminated regression control. |
| django__django-11815 | exact_issue_reproduction | yes | yes — translated Enum values supplied the distinguishing input | The oracle demonstrated call-by-value failure after translation and bracket-by-name stability. |
| matplotlib__matplotlib-25332 | minimal_script | partial | partly — the issue supplied the pickled shared-axis behavior | The repository-shaped mock preserved weakref groups through pickle and checked joined siblings before and after. |
| pylint-dev__pylint-8898 | exact_issue_reproduction | yes | yes — the derived traceback named argument.py and preserved `(foo{1,3})` | The standalone brace-aware parser consumed the exact issue regex and additional nested/comma controls. |
| sphinx-doc__sphinx-7910 | minimal_script | partial | partly — the derived task described decorated external-module methods | The two-module script demonstrated the old globals lookup failing and the new module lookup succeeding. |
| sympy__sympy-16792 | exact_issue_reproduction | yes | yes — MatrixSymbol dimensions and generated C shape were issue-visible | The available project venv generated C and verified a pointer argument rather than a scalar. |
| sympy__sympy-24213 | exact_issue_reproduction | yes | yes — the quantity/dimension case was retained | The project venv ran both the issue reproduction and an incompatible-dimension negative control. |
| sympy__sympy-24562 | exact_issue_reproduction | yes | yes — the Rational string operands were issue-authored | The script reproduced the coercion path for Rational('0.5', '100') and checked the exact 1/200 result. |

These wins support a generic pattern: after normal tests fail, use the issue's exact input and expected changed behavior against the smallest repository-grounded slice possible; include a negative/control case when cheap. The wording should encourage this without demanding invented tests or promising equivalence to the repo suite.

## Prompt-Policy Decision

**A — implement small verification wording in this milestone.** Wrong/no/weak oracles affect 35 unresolved runs; two strict losses used demonstrably wrong self-oracles, while 11 resolved runs used strong standalone checks. The preferred three bullets are generic, compact, gold-blind, explicitly reject treating test unavailability as proof, and permit honest static uncertainty. They do not require tests to pass or ask agents to fabricate a suite. A no-agent render smoke can establish bounded impact, unchanged task/selection/pivots/mode, and zero leakage.

## Implementation

The audit selected A before implementation. The second phase replaced M112's single caution with the preferred compact block inside the existing bounded per-file action contract:

> Verification:
> - If normal tests cannot run, do not treat that as proof of correctness.
> - Build a small repository-grounded oracle from the issue's exact inputs or changed behavior when possible.
> - If only static reasoning is possible, state the uncertainty before finalizing.

- **Files changed:** `src/capsuleV2/digestDecisionContract.ts`, its tests, the classifier wiring in `run_stage5_vexp_swe_bench_smoke.ts`, and the M112 renderer's reusable M113 no-agent mode. `verificationOraclePolicy:false` reproduces M112 wording; default bounded rendering is M113-on. No new live runner flag was added.
- **Gold-blind:** only fixed instruction text was added; no instance IDs, repos, gold files, patches, or test labels enter product logic.
- **No-agent smoke:** 12 cases; 11 rendered plus one honest `no_context` exclusion. M112 wording appeared pre in 11/11; M113 wording appeared post in 11/11.
- **Invariants:** task hashes, normalized capsule output/selected pivot+support files, lead pivot, required targets, and capsule mode all unchanged (**PASS**). Retrieval/ranking/selection code was not touched, so retrieval evals were not run.
- **Leakage:** 0 unexplained model-visible hits.
- **Character impact:** contract +84 chars median / +84 p90 (about 21 tokens). Total capped context median 0, p90 +84, range -356…+84; negative deltas are deterministic tail trimming under the fixed context cap, not removed contract text.

## Next-Action Queue

1. **implement_compact_verification_wording** — offline_default_on_existing_contract; 35 unresolved runs used wrong, absent, or weak oracles; the two strict wrong-oracle losses contrast with 11 resolved strong-oracle runs. Live spend: none.
2. **design_env_failure_loop_diagnostic** — default_off_offline_replay; 47 runs carried the deterministic command-loop classification. Live spend: none.
3. **review_medium_oracle_eval_mismatches** — captured_artifact_human_review; 7 unresolved cases had a passing but only partial local oracle. Live spend: none.
4. **no_retrieval_work_for_this_stratum** — archive; M111's 0/13 binding context-gap result remains unchanged; this audit concerns verification after localization. Live spend: none.
5. **defer_env_provisioning_or_live_confirmation** — requires_separate_approval_and_preregistration; Prompt rendering and captured-artifact analysis can be completed without changing the frozen execution environment. Live spend: not justified in M113.

## Claim Boundary

- Internal captured-artifact analysis only; no public benchmark, pass@1, VEXP-parity, or new-live-result claim.
- Resolution associations are descriptive over these 97 captured runs, not causal estimates.
- No gold patch or hidden-test content informed oracle-quality judgments.

## Success Criteria Check

1. No prohibited live/spend path — **PASS**.
2. M105–M108 committed artifacts reused — **PASS**.
3. All 97 valid runs classified; three invalid rows explicit — **PASS**.
4. Aggregate behavior reported — **PASS**.
5. Resolved/unresolved comparison — **PASS**.
6. All 13 strict losses and required named cases analyzed — **PASS**.
7. Strong-oracle wins analyzed — **PASS**.
8. A/B/C/D decision explicit — **PASS (A)**.
9. Wording smoke proves invariants/leakage safety — **PASS**.
10. No-spend-first queue explicit — **PASS**.
11. Tests/typechecks — **PASS** (focused tests plus full final verification).

## Verdict

**PASS.**

## Recommendation

**Implement/keep verification wording**, then prepare the env-failure-loop diagnostic design offline and default-off.
