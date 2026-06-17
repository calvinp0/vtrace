# Stage 5 — M29.1: Verifier provenance reconciliation + original-vs-revised command comparison

Two parts: (1) fix the verifier↔planner provenance disagreement from M29, then (2) run one
original-vs-revised diagnostic comparison for the same agent-selected command in the same
per-instance testbed — strictly non-oracle, no canonical mutation.

Label: `eval-m28-strong-discovery-current-sphinx-7462-r1` (sphinx-doc__sphinx-7462)
Command (both sides): `python -m pytest 'tests/test_domain_py.py::test_parse_annotation'`

## 1. Executive verdict

- **Provenance reconciled.** The verifier now **inherits** the M26 planner's `fairProvenance`
  verdict instead of recomputing it from poorer verify-time context. For this label the verifier
  provenance is `agent_discovered_hidden_match` / `allowedForFairVerification=true`, and with the
  command passing under a complete final-patch proof, **`fairVerificationUsable` flipped
  `false → true`** (blockers `[]`).
- **Comparison is degenerate (both pass) — because the two patch sources are byte-identical.**
  `_pivot_revision_revised.patch`, `_pivot_revision_original.patch`, and the canonical `modelPatch`
  all hash to `ec96de0e…90cd`. The revision pass was a **no-op** for this label, so there is no
  revised-vs-original delta for any command to detect; both runs execute the same bytes and both
  pass. → **Next recommendation B** (need a label with a genuine revision delta).
- Non-oracle boundary intact; canonical artifacts untouched in both runs.

## 2. Provenance reconciliation

**Why they disagreed.** Provenance is decided in two places from different inputs:

- **Plan time** (`buildAgentTestCommandPlan` → `selected.provenance`): computed from the FULL
  context — `discoveryEvidence` (structured search→read/output chain) **and**
  `promptExposedTestNames` (whether the withheld label was actually shown). With a strong discovery
  chain and no prompt exposure, a hidden FAIL_TO_PASS coincidence is **upgraded** to
  `agent_discovered_hidden_match` (allowed).
- **Verify time** (`buildAgentCommandVerification` → `assessFairVerification`): pre-M29.1 it
  recomputed provenance from only `injectedTestNames` + `priorCommandText`. Without
  `discoveryEvidence`/`promptExposedTestNames`, `classifyTestProvenance` cannot reach the hidden-
  match upgrade and conservatively returns `ambiguous`. The recompute can only ever **DISALLOW** —
  so it silently downgraded an eligible plan verdict.

**Fix (task option A/C — inherit, don't recompute).** Provenance is a *historical* property of how
the agent reached the test; it does not change at verify time. So:

- `assessFairVerification` gained an optional `inheritedProvenance?: VerificationProvenance`
  parameter. When supplied it is used verbatim instead of recomputing; the genuinely verify-time
  blockers (patch state, environment, parsed outcome) are still computed independently.
- `buildAgentCommandVerification` now passes `plan.fairProvenance` as `inheritedProvenance`,
  carrying the planner's classification + evidence forward and appending an evidence line noting it
  was inherited ("verify-time recompute lacks discovery/prompt-exposure context and can only
  DISALLOW"). Inheritance reuses the verdict verbatim — it never *upgrades* a disallowed plan
  either (covered by a new symmetric test).

Result for this label:

```
verifier provenance        = agent_discovered_hidden_match   (was: ambiguous)
allowedForFairVerification = true                            (was: false)
provenance blocker         = absent                          (was present)
```

This does not weaken the gate: an ineligible plan never reaches `buildAgentCommandVerification`
(it is skipped at `decideVerificationEligibility`), and a disallowed inherited provenance still
produces a provenance blocker.

## 3. Revised-patch verification result (`pivot_revision_revised`)

```
patchSource                       = pivot_revision_revised
patchSha256                       = ec96de0e3a8ae8564c7daf5456e78e26b70210d2bf5fd8f1e7aee1dcc6da90cd
patchApplied                      = true
commandRanAfterPatchApply         = true
executedCommand                   = python -m pytest 'tests/test_domain_py.py::test_parse_annotation'
parsedOutcome.status              = passed   (evidence: "1 passed in summary", high confidence)
environmentClassification         = test_passed
targetTestExecuted                = true
verificationPatchState.classification = final_patch_verified
canVerifyFinalPatch               = true
fairVerificationUsable            = true      ← flipped from false after the provenance fix
fairVerificationBlockers          = []
canonicalArtifactsUntouched       = true
oracleGradingUsed                 = false
```

Testbed stdout tail: `======================== 1 passed, 7 warnings in 0.06s ========================`

## 4. Original-patch verification result (`original_model_patch`)

```
patchSource                       = original_model_patch
patchSha256                       = ec96de0e3a8ae8564c7daf5456e78e26b70210d2bf5fd8f1e7aee1dcc6da90cd
patchApplied                      = true
commandRanAfterPatchApply         = true
executedCommand                   = python -m pytest 'tests/test_domain_py.py::test_parse_annotation'
parsedOutcome.status              = passed   (evidence: "1 passed in summary", high confidence)
environmentClassification         = test_passed
targetTestExecuted                = true
verificationPatchState.classification = final_patch_verified
canVerifyFinalPatch               = true
fairVerificationUsable            = true
fairVerificationBlockers          = []
canonicalArtifactsUntouched       = true
oracleGradingUsed                 = false
```

Testbed stdout tail: `======================== 1 passed, 7 warnings in 0.05s ========================`

`original_model_patch` resolved from the on-disk `_pivot_revision_original.patch` (the documented
preferred source; canonical `modelPatch` is the fallback). Its SHA equals the revised patch's SHA.

## 5. Original vs revised comparison table

| Field | original_model_patch | pivot_revision_revised |
|---|---|---|
| patchSha256 | `ec96de0e…90cd` | `ec96de0e…90cd` (**identical**) |
| patchApplied | true | true |
| commandRanAfterPatchApply | true | true |
| executedCommand | `pytest 'tests/test_domain_py.py::test_parse_annotation'` | same |
| parsedOutcome.status | **passed** | **passed** |
| environmentClassification | test_passed | test_passed |
| targetTestExecuted | true | true |
| verificationPatchState | final_patch_verified | final_patch_verified |
| canVerifyFinalPatch | true | true |
| fairVerificationUsable | true | true |
| fairVerificationBlockers | [] | [] |
| canonicalArtifactsUntouched | true | true |
| oracleGradingUsed | false | false |

**Both pass — and the two patches are byte-identical**, so the comparison carries no
revised-vs-original signal. Cross-check of all three patch representations on disk:

```
_pivot_revision_revised.patch   sha256 = ec96de0e…90cd
_pivot_revision_original.patch  sha256 = ec96de0e…90cd   (diff: IDENTICAL)
canonical row modelPatch        sha256 = ec96de0e…90cd
```

The artifacts were preserved under patch-source-suffixed names to avoid clobbering one side:
`_agent_test_command_verify.pivot_revision_revised.meta.json` and
`_agent_test_command_verify.original_model_patch.meta.json` (both raw/untracked).

## 6. Non-oracle boundary check

For both runs: `oracleGradingUsed=false`. The seam imports only the environment path
(`make_test_spec`, `build_container`(pull), `copy_to_container`, `GIT_APPLY_CMDS`,
`exec_run_with_timeout`, `cleanup_container`) and stops before `eval_script`/grading. No
`get_eval_report`, `get_resolution_status`, `resolved` scoring, or FAIL_TO_PASS/PASS_TO_PASS
consumption. Both subprocess stderrs were empty (0 bytes). No SWE-bench resolution is inferred — the
only claim is whether the agent-selected command passed in the isolated environment.

## 7. Canonical artifact safety

```
canonicalArtifactsUntouched (revised)  = true     (before/after tamper hash equal)
canonicalArtifactsUntouched (original) = true
canonical row resolved                 = null     (unchanged; verifier sets no resolution)
_eval.meta.json                        = absent   (no post-evaluate oracle artifact)
results/runs/ git status               = "??"      (entirely untracked; nothing staged/mutated)
replacementRecommended / canonicalReplaced = false / false (both runs)
```

The only **tracked** files changed by M29.1 are the three source files in §"code changed". The
pre-existing dirty `stage5_outcome_ledger.*` / `stage5_retrieval_eval_cross_repo_30.*` files predate
this work and were not touched.

## 8. Interpretation

- **Provenance plumbing is fixed.** The verifier no longer downgrades a planner-eligible verdict
  for lack of context; it inherits the plan's provenance and only adds blockers from genuinely
  verify-time signals. `fairVerificationUsable=true` now correctly reflects a passing, final-patch-
  verified, agent-discovered-hidden-match command.
- **The comparison cannot discriminate here.** Not because the test is weak, but because the
  revision pass produced a patch identical to the first-pass model patch for this instance — there
  is literally no delta to detect. Any command would show "both pass". This is the "both pass"
  branch, with the root cause being *no revision delta* rather than *non-discriminative command*.
- **No resolution claim.** The single passing test is not a SWE-bench resolution signal (resolution
  needs all FAIL_TO_PASS + PASS_TO_PASS via the oracle, which this seam deliberately never runs).

## 9. Next recommendation

**B. Require a more discriminative case — specifically, a label where the revised patch actually
differs from the original.** For this label `revised == original == modelPatch` (byte-identical), so
the original-vs-revised verifier can never show a delta. The next diagnostic should pick a label
whose revision pass produced a **non-identical** patch (different SHA from `original_model_patch`)
AND has an eligible agent-discovered command, then re-run this exact two-sided comparison. Only then
can the non-oracle verifier demonstrate (or refute) that a revision changed the agent-selected test
outcome. Still no adoption; no canonical evaluation.

### Code changed in this task

- `src/capsule/toolOutputCapture.ts` — `assessFairVerification` gains optional
  `inheritedProvenance?: VerificationProvenance`; used verbatim when supplied (skips the
  conservative verify-time recompute).
- `src/capsule/agentTestCommandVerifier.ts` — `buildAgentCommandVerification` builds an inherited
  provenance from `plan.fairProvenance` (with an inheritance evidence note) and passes it through;
  imports `VerificationProvenance`.
- `src/capsule/agentTestCommandVerifier.test.ts` — two new tests: (13) hidden-match plan provenance
  is inherited so a verify-time-`ambiguous` context still yields `fairVerificationUsable=true`;
  (14) a disallowed plan provenance is inherited verbatim (never upgraded).

Verification: `bun run typecheck` + `bun run typecheck:benchmarks` clean; `bun test` = 2839 pass /
0 fail; `git diff --check` clean. Deterministic retrieval evals (expanded + cross_repo_30) are
**byte-identical** to baselines ⇒ no retrieval/ranking/scoring change. Revision pass remains
non-default; revised patches were **not** wired into canonical evaluation.
