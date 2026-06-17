# Stage 5 — M28 fair test-discovery scaffold audit

Offline, PURE audit (no live agents, no Docker, no model calls). It exercises the M28
code paths over synthetic inputs and confirms the strengthened discovery scaffold.

**Overall: PASS** — 20/20 checks pass.

## What changed

- The opt-in revision prompt (`--revision-verification-policy agent-discovered-tests`) now
  carries an explicit **discovery protocol**: search/list/read the repository tests, pick the
  smallest test actually discovered, and run it with a canonical (un-piped) command. It also
  forbids guessing a test from the edited function name and copying benchmark/evaluator labels.
- The provenance classifier gained a **strict gate**: `agent_discovered` now requires a prior
  SEARCH over the repository test paths AND a subsequent READ of the test file (or an OUTPUT
  that surfaced the node). A lone grep is only `ambiguous`. An exact injected match still
  disallows. Structured `discoveryEvidence` is attached to each fair-verification report row.
- Default/`none` behavior and the legacy classifier signature are unchanged (backward compatible).

## Checks

| # | Check | Result | Detail |
| - | ----- | ------ | ------ |
| 1 | default == none (default behavior unchanged) | ✅ pass | omitting the policy and passing "none" produce byte-identical prompts |
| 2 | default keeps literal FAIL_TO_PASS names | ✅ pass | default prompt still lists the evaluator labels |
| 3 | default has no fair-verification block | ✅ pass | the discovery block is opt-in only |
| 4 | fair prompt has the discovery protocol | ✅ pass | explicit search/list/read instruction present |
| 5 | fair prompt forbids guessing from the function name | ✅ pass | anti-guess instruction present |
| 6 | fair prompt avoids piped/truncated commands | ✅ pass | canonical-command instruction present |
| 7 | fair prompt prefers canonical pytest | ✅ pass | canonical pytest form suggested |
| 8 | fair prompt suppresses literal FAIL_TO_PASS (incl. static label) | ✅ pass | no FAIL_TO_PASS token in the fair-policy prompt |
| 9 | fair prompt withholds the injected labels | ✅ pass | Option 1 sanitization intact |
| 10 | fair prompt keeps the public problem-statement excerpt | ✅ pass | problem-statement context is legitimate and retained |
| 11 | fair prompt keeps minimal-diff guardrail | ✅ pass | anti-over-edit guardrails preserved |
| 12 | M23.1 provenance is not allowed for fair verification | ✅ pass | classification=injected_metadata |
| 13 | M23.1 has no agent-side discovery chain | ✅ pass | no search→read/output evidence of the test |
| 14 | M23.1 command is planner-ineligible | ✅ pass | blockers: provenance "injected_metadata" is not allowed for fair verification; command not fair-executable as captured: shell pipeline/redirect token "\|" — not fair-executable as captured |
| 15 | M23.1 blocked on provenance AND shell pipeline | ✅ pass | both the injected-provenance and the pipeline gates fire |
| 16 | M27 verifier would skip the M23.1 plan (no Docker) | ✅ pass | decideVerificationEligibility returns eligible=false ⇒ plan_ineligible skip before any container |
| 17 | synthetic discovery classifies as agent_discovered | ✅ pass | search→read chain credited |
| 18 | synthetic agent_discovered command is planner-eligible | ✅ pass | blockers: (none) |
| 19 | synthetic command canonicalizes to a safe pytest invocation | ✅ pass | executed=python -m pytest 'tests/test_z.py::test_w' |
| 20 | shell-piped agent_discovered command is rejected | ✅ pass | blockers: command not fair-executable as captured: shell pipeline/redirect token "\|" — not fair-executable as captured |

## Fair-policy prompt — discovery section (rendered)

```text
## Fair verification (agent-discovered focused test)

If feasible, discover and run the smallest relevant repository test after making the revision.
Do not run a test merely because a hidden benchmark/evaluator label says so.
Do not guess a test name from the edited function name alone.

Discovery protocol (follow it before running any focused test):
  1. Search/list/read the repository test files related to the touched module/function
     (grep/ripgrep/find/ls over the test directories, then read the candidate test file).
  2. Choose the smallest focused test you actually discovered from that exploration.
  3. Run it with a canonical command — never a piped or truncated one.

Prefer:
  python -m pytest <discovered test node>
or:
  pytest <discovered test node>

Avoid:
  - piping or truncating the test command (e.g. "... | head", "2>&1 | head")
  - grep-only evidence without reading the test file
  - test names copied from benchmark/evaluator labels (they are withheld here)

If no focused test is discoverable, state that no fair focused test was discovered.
If the environment fails before the test runs, report it as an environment/import/dependency failure.
Do not claim the patch is verified unless the command output shows the test actually passed.
```

## M23.1 signature — stays ineligible

- Captured command: `python -m pytest tests/test_domain_py.py::test_parse_annotation 2>&1 | head -50`
- Provenance: `injected_metadata` — allowedForFairVerification=`false`
- Planner blockers: `provenance "injected_metadata" is not allowed for fair verification`, `command not fair-executable as captured: shell pipeline/redirect token "|" — not fair-executable as captured`
- M27 verifier eligibility: `false` ⇒ would skip (`plan_ineligible`) before any container.

## Synthetic agent-discovered command — eligible

- Captured command: `python -m pytest tests/test_z.py::test_w` (after `grep` then `cat` of the test file)
- Provenance: `agent_discovered`; planner eligible=`true`.
- Canonicalized command: `python -m pytest 'tests/test_z.py::test_w'`
- Same command shell-piped (`python -m pytest tests/test_z.py::test_w 2>&1 | head -50`) ⇒ eligible=`false` (diagnosticOnly).

