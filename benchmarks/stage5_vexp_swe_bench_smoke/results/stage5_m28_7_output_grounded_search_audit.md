# Stage 5 — M28.7 credit output-grounded repo-test search evidence

**Date:** 2026-06-17
**Follows:** M28.6 (`d63cb8b`), which found the strengthened fair prompt induced the right behavior
(search → read → canonical unpiped command) but the run was still planner-ineligible: the strict
`searched` predicate only credited a search whose **command/path literally named** the test
file/leaf. The agent's `Grep` recorded `command:null`, `path:"tests"`; the file surfaced only in the
grep **output**, so `searched=false` despite `read=true` and `output=true`.

## What changed

All production changes in `src/capsule/toolOutputCapture.ts` (PURE; no retrieval/ranking/scoring/
candidate-generation or Capsule v2 pivot selection touched):

1. **Output-grounded search leg** (`computeDiscoveryEvidence`): a repo-test SEARCH/list call whose
   **output** surfaced a selected-test file/node, AND a **later** read/open of that same surfaced
   file, now credits the `searched` leg. Tracked with order indices (read must come after the
   search); exposed via a new optional `DiscoveryEvidence.outputGroundedSearches: string[]`.
2. **`searched` predicate** (`classifyTestProvenance`): `searched = namedSearch || outputGroundedSearch`.
   A new evidence line — *"output-grounded search surfaced the test file and a later read opened it"* —
   is emitted when only the output-grounded path applies. No other branch changed: `exposedMatch`
   (Case A) still returns `injected_metadata` first; command safety stays independent.
3. **Grep tool-call capture** (`EnrichedToolCall.query` + `QUERY_KEYS` + `pushToolUse`): non-shell
   search tools (Grep/Glob) now capture their `pattern`/`query`/`glob` into `query` (Bash unchanged,
   `query=null`). The search-command match text now includes `query`, so a pattern that literally
   names the file/leaf is credited via the command path too. Threaded through `PriorCallSignal.query`
   and `buildFairVerificationReport`.

All new fields are optional/additive — existing literal fixtures and call sites compile and behave
identically when they omit them (legacy heuristic preserved).

### Note on Grep pattern extraction
Capturing the pattern does **not by itself** fix M28.6: that pattern was `test.*parse_annotation`,
which does not literally contain the contiguous leaf `test_parse_annotation` or the base
`test_domain_py.py`. The **output-grounded** path is what makes M28.6 eligible — the grep *output*
(`tests/test_domain_py.py`) plus the subsequent read of that file. Pattern capture is the secondary
telemetry improvement; output-grounded discovery is the primary fix.

## Why this does not over-credit
- Broad grep output **with no later read** → no `outputGroundedSearches` entry → `searched=false`
  (audit #3; existing test M28.4-7 unchanged).
- Search whose output names only a SOURCE file (not a selected test) → `filesIn` matches nothing.
- Prompt-exposed hidden label → `exposedMatch` returns `injected_metadata` before the discovery gate.
- Shell-piped/redirected command → rejected by `commandSafety` in the planner, independent of provenance.
- **M28.3** had no test-file read AND a `2>&1` command → ineligible on **both** axes.

## Offline audit

Points 1–2 grounded against the **real existing artifacts** via planner re-runs (no live agent, no
Docker); 3–8 against synthetic fixtures + the unit tests.

| # | Audit check | Result |
| --- | --- | --- |
| 1 | Existing M28.6 artifact becomes planner-eligible | **PASS** — `eligibleForFutureExecution=true`, provenance `agent_discovered_hidden_match`, `allowedForFairVerification=true`, `commandSafety.allowed=true`, evidence includes *"output-grounded search surfaced the test file and a later read opened it"*; `expectedImageKey` unchanged (`…sphinx-doc_1776_sphinx-7462:latest`) |
| 2 | Existing M28.3 artifact remains ineligible | **PASS** — `eligible=false`, provenance `ambiguous`, `commandSafety.allowed=false`; blockers = ambiguous provenance **and** shell pipeline/redirect (no test-file read; piped `2>&1`) |
| 3 | Broad grep output with no read remains ineligible | **PASS** — `outputGroundedSearches=[]` |
| 4 | Search output surfacing test FILE + later read ⇒ `searched=true` | **PASS** — credited, classifies `agent_discovered` |
| 5 | Search output surfacing test NODE + later read ⇒ `searched=true` | **PASS** — credited |
| 6 | Prompt-exposed hidden label still disallowed | **PASS** — `injected_metadata`, disallowed, even with full output-grounded chain |
| 7 | Shell-piped command still rejected independently | **PASS** — `commandSafety.allowed=false`, `diagnosticOnly=true` |
| 8 | Grep pattern/path capture works | **PASS** — `query="test_w"`, `command=null`, `path="tests"` |

**Verifier without Docker** (no `--allow-docker-verify`) on the M28.6 label now skips with reason
**`docker_not_authorized`** (Gate 4), NOT `plan_ineligible` (Gate 1) — confirming the provenance gate
now passes and only Docker authorization is withheld. `dockerStarted=false`, `commandExecuted=false`,
`canonicalArtifactsUntouched=true`.

## Tests

`src/capsule/toolOutputCapture.test.ts` — 9 new M28.7 tests: output-grounded file/node + later read
credits searched (1, 4, 5); without read stays ineligible (2); unrelated output not credited (3);
prompt-exposed stays injected (6); M28.3-style grep-only stays ineligible (7); end-to-end M28.6 trace
through `buildFairVerificationReport` ⇒ `agent_discovered_hidden_match` (8); enriched Grep `query`
capture with Bash regression guard (10). Test #9 (shell-piped + discovered provenance ⇒ planner
ineligible) is already covered green by the existing planner test **M28.4-9** in
`src/capsule/agentTestCommandPlanner.test.ts`.

## Verification

- `bun run typecheck` — clean.
- `bun run typecheck:benchmarks` — clean.
- `bun test` — **2837 pass, 0 fail** (170 files; +9 vs M28.6's 2828).
- `git diff --check` — clean.
- Retrieval no-change proof — `stage5_retrieval_eval_expanded.csv` and
  `stage5_retrieval_eval_cross_repo_30.csv` **byte-identical** to the committed baselines.
- Planner re-run on existing M28.6 artifacts — eligible (above). M28.3 — ineligible (above).

## Scope

No live agents, no Docker, no `--allow-docker-verify`, no command/verifier execution, no sweeps. The
revision pass stays off by default; revised patches are not wired into canonical evaluation. The
change only widens which discovery chains are credited as fair; the disallow paths (exposed labels,
piped commands, no-read grep) are unchanged.
