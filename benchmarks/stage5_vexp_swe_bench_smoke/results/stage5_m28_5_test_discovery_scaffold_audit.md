# Stage 5 — M28.5 strengthened fair test-discovery scaffold (revision prompt)

**Date:** 2026-06-17
**Follows:** M28.4 (`7d299bd`, "Allow discovered hidden-match tests"), which made the
*provenance policy* capable of rating a discovered hidden-FAIL_TO_PASS test fair, but left
the *agent behavior gap* open: in the M28.3 live run (`sphinx-7462`) the agent did only a
broad `grep` over `tests/`, never read the test file, and ran a redirected/piped command
(`python -m pytest … -xvs 2>&1`) — so nothing was planner-eligible. M28.5 strengthens the
opt-in fair-policy revision prompt so the agent is more likely to actually produce the
eligible chain: **repo-test search/list → read the test file → canonical un-piped pytest.**

No gate was loosened. This is a prompt-scaffold change plus tests; the provenance/planner
gates from M28/M28.4 are unchanged.

## What changed

`src/capsuleV2/pivotRevisionPass.ts` — `FAIR_VERIFICATION_BLOCK` (rendered only under
`--revision-verification-policy agent-discovered-tests` ⇒ `verificationPolicy: "agent_discovered"`)
was hardened from the M28 "discovery protocol" hint into explicit, hard-to-miss requirements:

- **Numbered requirements** ("For a test command to count as fair verification, you must:")
  1. Search or list repository test files related to the touched module/function.
  2. Read/open the relevant test file **before** running the test.
  3. Run a canonical focused test command with **no pipes, no redirection, no head/tail truncation**.
- **Explicit disqualifiers**: "A grep/search result alone is not enough." / "A guessed test
  name from a function name is not enough." / "A piped/truncated command is not
  fair-verification eligible."
- **Concrete good/bad examples** — a `Good (fair-verification eligible):` pair and a
  `Not fair-verification eligible:` pair showing `… 2>&1 | head -60` and `… 2>&1`.
- **Visible checklist** (`Fair test discovery checklist:`) with four `- [ ]` items
  (searched/listed, read/opened, canonical unpiped command, no benchmark labels).
- **Optional `FAIR_TEST_DISCOVERY:` telemetry marker** (searched / read / command / result).
  Explicitly best-effort — "it does not replace the diff, and adoption does not depend on it."

The pre-M28.5 lines that other tests pin (the generic discovery protocol, "never a piped or
truncated one", "python -m pytest <discovered test node>", "Do not guess a test name from the
edited function name alone", "labels are withheld under the fair verification policy", "Do not
claim the patch is verified unless the command output shows the test actually passed") are all
retained.

### Deliberate deviation from the brief's literal example

The brief's "Good" example was `python -m pytest tests/test_domain_py.py::test_parse_annotation`
and the "Not eligible" examples reused the same node. **That node is the real `sphinx-7462`
hidden FAIL_TO_PASS.** The block is *static* — it renders into every fair-policy prompt — so
hardcoding it would (a) leak a withheld evaluator label unconditionally and (b) immediately
trip the M28.2 `assertNoWithheldTestLabels` guard, throwing on every fair-policy build. The
brief itself also says "Do not include literal benchmark/evaluator test labels." To honor both,
the examples use **neutral placeholders** (`<discovered test node>`,
`tests/test_<module>.py::test_<behavior>`) which convey the canonical shape without leaking. The
guard is exercised in the audit below and confirms no leak.

## Rendered fair-policy block (verbatim excerpt)

```
For a test command to count as fair verification, you must:

  1. Search or list repository test files related to the touched module/function.
  2. Read/open the relevant test file before running the test.
  3. Run a canonical focused test command with no pipes, no redirection, no head/tail truncation.

A grep/search result alone is not enough.
A guessed test name from a function name is not enough.
A piped/truncated command is not fair-verification eligible.
...
Good (fair-verification eligible):
  python -m pytest <discovered test node>
  pytest tests/test_<module>.py::test_<behavior>

Not fair-verification eligible:
  python -m pytest <discovered test node> 2>&1 | head -60
  python -m pytest <discovered test node> 2>&1
...
Fair test discovery checklist:
  - [ ] I searched/listed repository test files.
  - [ ] I read/opened the relevant test file.
  - [ ] I ran a canonical unpiped test command.
  - [ ] I did not use benchmark/evaluator labels.

After verifying, include this telemetry marker in your response (best-effort; it does not
replace the diff, and adoption does not depend on it):
  FAIR_TEST_DISCOVERY:
    searched: <command or none>
    read: <file or none>
    command: <test command or none>
    result: <passed/failed/env-error/not-run>
```

## Offline audit

Run against the actually-rendered prompt plus the real provenance pipeline
(`computeDiscoveryEvidence` → `classifyTestProvenance`); no live agent, no Docker, no command
execution.

| # | Audit check | Result |
| --- | --- | --- |
| 1 | default/no-policy prompt unchanged | **PASS** — `none` ≡ omitted-policy; no fair scaffold (`For a test command…`, `FAIR_TEST_DISCOVERY:` absent); `FAIL_TO_PASS:` still present |
| 2 | fair prompt includes explicit search/list + read + canonical command requirements | **PASS** — all three numbered requirements present; read precedes run |
| 3 | fair prompt says grep-only is insufficient | **PASS** — "A grep/search result alone is not enough." |
| 4 | fair prompt forbids pipes/redirection/head/tail | **PASS** — "no pipes, no redirection, no head/tail truncation" + concrete `2>&1 | head -60` / `2>&1` bad examples |
| 5 | fair prompt still suppresses hidden evaluator labels | **PASS** — no `test_parse_annotation`, no `FAIL_TO_PASS` token; `assertNoWithheldTestLabels` does not throw |
| 6 | synthetic search+read+canonical hidden-match remains planner-eligible | **PASS** — `agent_discovered_hidden_match` (allowed) via real `computeDiscoveryEvidence` |
| 7 | synthetic grep-only remains ineligible | **PASS** — `ambiguous` (broad grep, no read ⇒ not `agent_discovered*`) |
| 8 | synthetic redirected command remains ineligible | **PASS** — command safety is independent of provenance; a `2>&1 | head` command stays `diagnosticOnly`/ineligible (pinned in `agentTestCommandPlanner.test.ts`, green in suite) |

## Tests

`src/capsuleV2/pivotRevisionPass.test.ts` — 8 new M28.5 tests:

1. default/no-policy revision prompt byte-identical (no M28.5 scaffold).
2. fair prompt requires search/list + read/open **before** running (ordering asserted).
3. fair prompt says grep/search alone (and a guessed name) is not enough.
4. fair prompt forbids pipes/redirection/head/tail with concrete bad examples.
5. fair prompt gives a canonical pytest example using **neutral placeholders only** (asserts
   the real `test_parse_annotation` node is absent).
6. fair prompt includes the four-item visible checklist.
7. optional `FAIR_TEST_DISCOVERY:` marker renders ONLY under the fair policy.
8. strengthened scaffold still suppresses withheld labels and passes `assertNoWithheldTestLabels`.

Provenance/planner expectations (brief test items 7–10: grep-only ⇒ ambiguous/disallowed,
search+read hidden-match ⇒ allowed, canonical command ⇒ eligible, redirected/piped ⇒
ineligible) are unchanged by M28.5 and remain covered green by the M28/M28.4 tests in
`src/capsule/toolOutputCapture.test.ts` and `src/capsule/agentTestCommandPlanner.test.ts`.

## Verification

- `bun run typecheck` — clean.
- `bun run typecheck:benchmarks` — clean.
- `bun test` — **2828 pass, 0 fail** (170 files; +8 vs M28.4's 2820).
- `git diff --check` — clean.
- Retrieval no-change proof — `stage5_retrieval_eval_expanded.csv` and
  `stage5_retrieval_eval_cross_repo_30.csv` **byte-identical** to the committed baselines.

## Scope

No live agents, no Docker, no verifier/command execution, no 30-/100-case sweeps. The revision
pass stays off by default; the `FAIR_TEST_DISCOVERY` marker is telemetry only and adoption does
not depend on it; no retrieval/ranking/scoring/candidate-generation or Capsule v2 pivot
selection was touched. Prompt-only behavior change, gated entirely behind the existing opt-in
`agent-discovered-tests` policy.
