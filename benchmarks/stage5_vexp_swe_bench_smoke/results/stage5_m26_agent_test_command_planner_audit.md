# Stage 5 · M26 — Agent test-command dry-run planner audit

**Goal.** Provide a *no-Docker, no-execution* planner for the future isolated agent-command
verifier (designed in M25). The planner resolves and validates everything needed to decide
whether one agent-selected test command *could* be fairly and safely re-run against a chosen
patch in an isolated SWE-bench testbed — **without running an agent, Docker, the test command,
or SWE-bench grading.**

## Mode / flag added

```
--mode plan-agent-test-command
  --run-label <existing source label>
  --patch-source     original_model_patch | pivot_revision_revised        (default: pivot_revision_revised)
  --command-source   first_pass_test_commands | pivot_revision_test_commands (default: pivot_revision_test_commands)
```

It reads **existing captured artifacts only** and writes a single dry-run plan
`_agent_test_command_plan.json` under the source label's `raw/vtrace/` directory (untracked).

## What the planner validates

| Field | Resolution |
|---|---|
| `instanceId` | canonical `swebench-*.jsonl` row (fallback `_run.meta.json`) |
| `patchSource` / `patchPath` / `patchSha256` | `_pivot_revision_revised.patch` or `_pivot_revision_original.patch` / canonical `modelPatch`; SHA-256 of the resolved patch text |
| `commandSource` / `selectedCommand` / `selectedTests` / `commandFramework` | first command from `_test_commands.json` / `_pivot_revision_test_commands.json` (via the M23 enriched tool-call capture) that classifies as a test command |
| `commandSafety` | pure shell-token gate (rejected tokens vs. shell-pipeline `diagnosticOnly`) |
| `fairProvenance` | reuses the M23 `buildFairVerificationReport` verdict (agent_discovered vs. injected_metadata/ambiguous/unknown) |
| `verificationPatchState` | hard-wired `{ canVerifyFinalPatch: false, reason: "dry_run_only" }` |
| `imagePlan` | expected SWE-bench instance image key, derived from the documented `TestSpec` format |
| `eligibleForFutureExecution` / `blockers` | true only when all six gates pass; one honest blocker per failed gate |

### Command-selection rule (conservative)

Select **at most one** command: the first from the requested source that classifies as a test
command. Then apply six gates — (1) is a test command, (2) provenance
`allowedForFairVerification=true`, (3) not injected_metadata/ambiguous/unknown, (4) no rejected
tokens, (5) not a shell pipeline as captured, (6) has `selectedTests` or is a framework that
runs without explicit selectors (tox/npm/bun/cargo/go).

### Command-safety policy

- **Rejected outright** (`allowed=false`, not diagnostic): `rm`, `git reset`, `git clean`,
  `curl`, `wget`, `pip install`, `npm install`, `conda install`, `apt`, `sudo`.
- **Shell pipeline / redirect** (`allowed=false`, `diagnosticOnly=true`): `|`, `&&`, `||`, `;`,
  `>`, `>>`, `<`. A captured `... 2>&1 | head -50` is diagnostic only — it cannot be re-run as
  captured under fair mode.
- **Allowed fair forms**: `pytest` / `python -m pytest` / `python -m unittest <tests>`, `tox`,
  `npm test`, `bun test`, `cargo test`, `go test`.

The planner **never sanitizes or executes** any command — it only classifies the string.

## Docker / commands are never run

The planner imports no SWE-bench Python, spawns no agent, starts no container, and executes no
command. The only side effect is writing the plan JSON; the canonical artifacts are SHA-256
tamper-checked before/after the write (the run aborts if they change).

## M23.1 sphinx plan result

Label `eval-m23-fair-test-policy-current-sphinx-7462-r1`, `--patch-source pivot_revision_revised`:

| command-source | selected command | provenance | safety | eligible |
|---|---|---|---|---|
| `pivot_revision_test_commands` | `python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 \| head -50` | `injected_metadata` (not allowed) | `diagnosticOnly` (pipe) | **false** |
| `first_pass_test_commands` | `python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 \| head -80` | `injected_metadata` (not allowed) | `diagnosticOnly` (pipe) | **false** |

Both plans are **ineligible**, with blockers:

```
provenance "injected_metadata" is not allowed for fair verification
command not fair-executable as captured: shell pipeline/redirect token "|" — not fair-executable as captured
```

**This is the correct, expected outcome.** The selected test
(`tests/test_domain_py.py::test_parse_annotation`) exactly matches an injected FAIL_TO_PASS
label, so its provenance is `injected_metadata` — not provably agent-owned — and it is disallowed
for fair verification. Independently, the captured command is a `... 2>&1 | head` pipeline, so it
is diagnostic-only and cannot be fairly re-executed as captured. Either blocker alone makes the
plan ineligible.

## Image key planning result

Computed **deterministically** from the documented `swebench.harness.test_spec.TestSpec`
formula (verified against the installed harness), not guessed:

```
sweb.eval.<arch>.<instance_id.lower()>:<tag>
→ namespace "swebench" (run_evaluation default, not overridden by vexp) ⇒ remote image, __→_1776_ remap
```

For `sphinx-doc__sphinx-7462`:

```
expectedImageKey: swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest
imageNamespace:   swebench
architecture:     x86_64
testbed:          /testbed
```

When no instance id is resolvable, the planner reports `expectedImageKey: null`,
`derivation: "unavailable_in_ts_dry_run"`, and adds an `image_key_not_computed` blocker — it
never guesses silently.

## Verification

- `bun run typecheck` — pass
- `bun run typecheck:benchmarks` — pass
- `bun test` — 2772 pass / 0 fail (incl. 16 new planner tests)
- `git diff --check` — clean
- Deterministic retrieval evals (`stage5_retrieval_eval_expanded`,
  `stage5_retrieval_eval_cross_repo_30`) — **byte-identical** to the committed baselines
  (no retrieval/ranking/scoring change).

## Scope

Dry-run planner + tests only. No live agents, no Docker, no command execution, no SWE-bench
grading, no adoption, no canonical-evaluation wiring. The revision pass remains non-default.
