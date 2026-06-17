# Stage 5 · M27 — Diagnostic-only isolated agent-command verifier audit

**Goal.** Implement the actual isolated agent-command verifier behind an explicit diagnostic-only
mode. It can run a planner-approved agent-selected test command inside the correct per-instance
SWE-bench testbed using the M25 **non-oracle seam**, *without* SWE-bench grading — and by default
it never starts Docker at all.

## Mode / flag added

```
--mode verify-agent-test-command
  --run-label <source-label>
  --patch-source     original_model_patch | pivot_revision_revised
  --command-source   first_pass_test_commands | pivot_revision_test_commands
  --allow-docker-verify        explicit opt-in to isolated container execution (default: OFF)
```

The mode **runs the M26 planner first** (`computeAgentTestCommandPlan`, shared with
`--mode plan-agent-test-command`), then gates execution.

## How planner gating is enforced

`decideVerificationEligibility(plan)` re-asserts all three execution gates before any container is
considered:

```
plan.eligibleForFutureExecution === true
plan.commandSafety.allowed === true
plan.fairProvenance.allowedForFairVerification === true
```

Then four sequential gates, each writing a `skipped` artifact and exiting cleanly:

1. **plan_ineligible** — any plan blocker (injected_metadata / ambiguous / unknown provenance,
   shell pipeline/redirect, unsafe tokens, missing test-command classification, missing patch,
   missing instance id / image key).
2. **command_not_canonicalizable** — the parsed framework + selected tests cannot yield a safe
   command (e.g. pytest with no selected tests).
3. **patch_file_unavailable** — no on-disk patch file to copy into the testbed.
4. **docker_not_authorized** — `--allow-docker-verify` not set. **This is the default**, so even
   an *eligible* plan skips without starting Docker.

## Command form (fair execution)

The raw captured shell command (`... 2>&1 | head -50`) is **never executed**. The verifier derives
a canonical safe command from the parsed framework + selected tests, single-quoting each selector
(neutralizing pytest param ids like `test_unparse[()-()]`):

```
python -m pytest 'tests/test_x.py::test_y'      # pytest/unittest: from selected tests
tox | npm test | bun test | cargo test | go test ./...   # selector-free frameworks: base command
```

Recorded fields: `capturedCommand`, `executedCommand`, `commandCanonicalized`,
`canonicalizationReason`. If no safe form exists → skip as `command_not_canonicalizable`.

## M23.1 sphinx result — skips without Docker

```
--run-label eval-m23-fair-test-policy-current-sphinx-7462-r1
--patch-source pivot_revision_revised --command-source pivot_revision_test_commands
```

```json
{
  "mode": "verify-agent-test-command",
  "status": "skipped",
  "reason": "plan_ineligible",
  "blockers": [
    "provenance \"injected_metadata\" is not allowed for fair verification",
    "command not fair-executable as captured: shell pipeline/redirect token \"|\" — not fair-executable as captured"
  ],
  "dockerStarted": false,
  "commandExecuted": false,
  "canonicalArtifactsUntouched": true,
  "capturedCommand": "python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 | head -50",
  "executedCommand": null,
  "commandCanonicalized": false,
  "replacementRecommended": false,
  "canonicalReplaced": false
}
```

**This is correct and expected** — the plan is ineligible (injected_metadata provenance + shell
pipeline), so the verifier never starts Docker.

## Artifacts written

Under the source label's `raw/vtrace/` (all `_`-prefixed, untracked, never staged):

- `_agent_test_command_verify.meta.json` — the verification / skip record.
- `_agent_test_command_verify.stdout.txt` / `.stderr.txt` — bounded command output (only on the
  authorized execution path).
- `_agent_test_command_plan.json` — the M26 plan, persisted for traceability.

## How canonical artifacts are protected

- The mode writes only its own `_agent_test_command_verify.*` (+ the plan json) — disjoint from
  every canonical artifact.
- A SHA-256 tamper check (`hashVerifyProtectedArtifacts`) runs **before and after** every write,
  covering the canonical results JSONL, `_eval.meta.json`, `_pivot_revision.json`,
  `_pivot_revision_original.patch`, `_pivot_revision_revised.patch`, and
  `_pivot_revision_shadow_eval.meta.json`. Any change aborts the run.
- `replacementRecommended` and `canonicalReplaced` are hard-wired `false` literals; the canonical
  `modelPatch` / eval JSONL are never modified.

## Oracle grading is avoided

The verifier — and the `verify_agent_test_command.py` non-oracle seam script — use ONLY:

```
make_test_spec → build_container → copy_to_container → GIT_APPLY_CMDS
→ exec_run_with_timeout (our canonical command) → cleanup_container
```

and STOP BEFORE `grading.py` / `get_eval_report` / `get_resolution_status` / resolved scoring.
No FAIL_TO_PASS/PASS_TO_PASS is consumed for scoring (injected names only ever DISALLOW upstream).
`finalPatchProof` / `final_patch_verified` are emitted only with positive, non-empty evidence
(patch applied + command ran after apply + applied SHA matches the planned patch).

This is **not a benchmark score** — it is a diagnostic patch-state + outcome record.

## Verification

- `bun run typecheck` — pass
- `bun run typecheck:benchmarks` — pass
- `bun test` — 2787 pass / 0 fail (incl. 15 new verifier tests; Docker/SWE-bench fully stubbed)
- `git diff --check` — clean
- Deterministic retrieval evals (`stage5_retrieval_eval_expanded`,
  `stage5_retrieval_eval_cross_repo_30`) — **byte-identical** to the committed baselines.

## Scope

Diagnostic verifier + non-oracle seam script + tests only. No live agents, no Docker (the mode is
off by default and the M23.1 audit skips before Docker), no command execution, no SWE-bench
grading, no adoption, no canonical-evaluation wiring. The revision pass remains non-default.
