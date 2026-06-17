# Stage 5 — M28.6 live validation of the strengthened fair test-discovery scaffold

**Date:** 2026-06-17
**Label:** `eval-m28-strong-discovery-current-sphinx-7462-r1`
**Instance:** `sphinx-doc__sphinx-7462`
**Follows:** M28.5 (`298a205`, "Strengthen fair test discovery scaffold").
**Mode:** one live `run-protocol` (first pass + pivot-revision second pass under
`--revision-verification-policy agent-discovered-tests`), then offline planner + verifier.
**No Docker. No `--allow-docker-verify`. No adoption.**

## 1. Executive verdict

**The strengthened prompt did its job behaviorally, but the run is still planner-INELIGIBLE —
a near-miss that the M28.6 outcome taxonomy does not contain a clean bucket for.** Under the
fair policy the agent actually *searched* the repo test directory, *read* the relevant test file
(`tests/test_domain_py.py`), and ran a *canonical, unpiped* command
(`python -m pytest tests/test_domain_py.py::test_parse_annotation -v`). The prompt stayed fully
sanitized (no hidden labels). Yet the planner scored provenance **`ambiguous`** and refused fair
verification, because the strict `searched` predicate in `computeDiscoveryEvidence` only credits a
search whose **command/path literally names** the test file/leaf — and here the discriminating
grep pattern was not captured (`command: null`) and the path was just the `tests/` directory; the
file name surfaced only in the grep **output**. So `readEvidence=true`, `outputEvidence=true`, but
`searched=false` ⇒ `strongDiscovery=false` ⇒ `ambiguous` ⇒ ineligible.

The gap is **not** a missing read, **not** a piped command, **not** a prompt leak, and **not**
missing telemetry. It is the discovery gate's *search leg* failing to credit an **output-grounded
search** (a grep whose output pinpointed the file, followed by a read of that file).

## 2. Run validity

| Field | Value |
| --- | --- |
| Stage5 status | `completed_patch`, treatment valid (per run stdout) |
| Capsule engine | `v2` (`vtraceEffectiveCapsuleEngine`) |
| Context injected | `true` |
| Capsule pivots | `sphinx/domains/python.py::_parse_annotation` (edit anchor), `sphinx/pycode/ast.py::unparse` (co-edit candidate, 9 dependents) |
| Revision pass ran | `true` — decision `1 missing/unclear candidate(s)` (missing: `sphinx/pycode/ast.py::unparse`) |
| Revised patch | present (guards both `result.pop()` calls with `if node.elts:`); `revisionCandidate=false` (agent RULED_OUT the co-edit, did not add it) |
| Verification policy | `agent_discovered` |

**Valid run.** First pass produced a patch; the enforcement gate flagged the `unparse` co-edit as
missing; the fair-policy revision pass ran a real second agent that inspected `unparse`, ruled it
out with a `PIVOT_DECISION` (string-join is empty-safe, no `pop()`), and kept the minimal
`_parse_annotation` fix. r2 not needed (run valid, revision ran, test command produced).

## 3. Prompt checks (`_pivot_revision_prompt.md`)

| Check | Result |
| --- | --- |
| Literal FAIL_TO_PASS labels absent | **PASS** (`grep` for `FAIL_TO_PASS` ⇒ none) |
| Literal hidden test node ids absent | **PASS** (no `test_parse_annotation`, no `test_unparse`) |
| Explicit search/list repo-tests requirement | **PASS** ("Search or list repository test files related to the touched module/function.") |
| Explicit read/open test-file requirement | **PASS** ("Read/open the relevant test file before running the test.") |
| grep/search-only is not enough | **PASS** ("A grep/search result alone is not enough.") |
| Canonical unpiped pytest instruction | **PASS** ("Run a canonical focused test command with no pipes…"; `Good (fair-verification eligible)` examples) |
| Pipes/redirection/head/tail forbidden | **PASS** ("no pipes, no redirection, no head/tail truncation"; `Not fair-verification eligible` examples with `2>&1 | head -60`) |
| FAIR_TEST_DISCOVERY marker instruction present | **PASS** (telemetry marker block rendered) |
| Anti-over-edit guardrails present | **PASS** ("Prefer the minimal final diff.", "Do not edit a file merely because it is listed.") |

Prompt is clean and complete — **no `prompt_leak_regression`.**

## 4. Discovery / command telemetry

From `_pivot_revision_tool_calls.json`, `_pivot_revision_test_commands.json`, and the revision
response (`_pivot_revision_response.txt`):

| Agent behavior | Observed? | Evidence |
| --- | --- | --- |
| Repo-test search/list | **YES** | `Grep` (category=search) over `…/tests`, output `Found 1 file\ntests/test_domain_py.py` |
| Test-file read/cat/sed/open | **YES** | `Read tests/test_domain_py.py` (agent reports lines 239–265) |
| Canonical unpiped test command | **YES** | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v` (no pipe/redirect/truncation) |
| Piped/redirected/truncated command | **NO** | only the canonical form + a non-test `python -c` sanity script |
| FAIR_TEST_DISCOVERY marker in response | **YES** | `searched:` grep pattern · `read:` `tests/test_domain_py.py` · `command:` canonical pytest · `result: env-error (jinja2 import incompatibility)` |

Note the command's actual *outcome* was an environment error (jinja2 `environmentfilter`
incompatibility in the bench repo) — reported honestly as `env-error`, not as a pass. That is
orthogonal to eligibility (the planner gates on provenance + command safety, not on the test
having passed).

## 5. Planner / verifier results

**Planner** (`plan-agent-test-command`, `_agent_test_command_plan.json`):

| Field | Value |
| --- | --- |
| `eligibleForFutureExecution` | **`false`** |
| `blockers` | `["provenance \"ambiguous\" is not allowed for fair verification"]` |
| provenance `classification` | **`ambiguous`** |
| `allowedForFairVerification` | `false` |
| discovery evidence | `prior read of the selected test file` ✓ · `prior output surfaced the selected test node` ✓ · **no `prior search command referenced…` line ⇒ `searched=false`** |
| `commandSafety.allowed` | **`true`** ("allowed fair test form (pytest)") |
| `commandSafety.diagnosticOnly` | not flagged (false/absent) — the command is a real focused test form, not diagnostic-only |
| `selectedTests` | `tests/test_domain_py.py::test_parse_annotation` |
| `expectedImageKey` | `swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest` |

**Verifier** (`verify-agent-test-command`, **no `--allow-docker-verify`**):

| Field | Value |
| --- | --- |
| `status` | `skipped` |
| `reason` | **`plan_ineligible`** (Gate 1, before any Docker-authorization gate) |
| `dockerStarted` | `false` |
| `commandExecuted` | `false` |
| `canonicalArtifactsUntouched` | `true` |
| `commandCanonicalized` | `false` (skipped before canonicalization) |

The verifier correctly stopped at the provenance gate — it never reached Docker authorization, so
the no-Docker constraint was honored by construction.

## 6. Interpretation

The M28.5 prompt **successfully changed agent behavior**: compared to M28.3 (broad `grep`, no read,
piped `… 2>&1`), this run shows a real search → **read** → **canonical unpiped** command chain, plus
a populated `FAIR_TEST_DISCOVERY` marker. Three of the four eligibility ingredients are now present:
sanitized prompt ✓, test-file read ✓, canonical command ✓.

The remaining blocker is entirely on the **gate side**, in the `searched` leg of
`computeDiscoveryEvidence`:

- `searched` is true only when a search call's **command or path** contains the test file base
  (`test_domain_py.py`) or leaf (`test_parse_annotation`).
- The agent's `Grep` call recorded `command: null` and `path: …/tests` (the directory). The
  discriminating pattern (`test.*parse_annotation`) was **not captured** into `command`, and even
  if it had been, the regex `test.*parse_annotation` does not literally contain the contiguous leaf
  `test_parse_annotation` or the base `test_domain_py.py`.
- The file name appears only in the grep **output** (`tests/test_domain_py.py`), which the gate
  credits as `outputEvidence` (the read/output leg), **not** as `searched` (the search leg).

So `strongDiscovery = searched && (read || output)` collapses to `false && true = false`, and a
hidden-label match with weak discovery + known-sanitized exposure resolves to `ambiguous`
(by design, since M28.4). The behavior was right; the gate's notion of "a search" is narrower than
"a grep whose output found the file." There is also a contributing **telemetry gap**: the `Grep`
tool's pattern is not recorded in the tool-call `command` field.

**Outcome classification.** None of the six listed buckets fits cleanly:
- `planner_eligible` — **no** (ineligible).
- `discovery_missing_read` — **no**; this requires "search exists but no read." Here the **read is
  present**; it is the *search leg* that is uncredited (the mirror image).
- `command_safety_blocked` — **no**; `commandSafety.allowed=true`, command is canonical/unpiped.
- `prompt_leak_regression` — **no**; prompt fully sanitized.
- `telemetry_failure` — **no**; all artifacts present and populated (though the Grep *pattern* is
  not captured — a minor, contributing gap, not a failure).
- `inconclusive` — **no**; run valid, revision ran, test command produced.

The accurate label is a **new near-miss: `discovery_search_leg_uncredited`** — sanitized prompt,
read present, canonical command present, but provenance `ambiguous` because an *output-grounded*
search (grep output found the file) is not credited as `searched`.

## 7. Next recommendation

**None of the prescribed triggers A–E fires** (A needs eligibility; B needs a *missing read*; C
needs a *piped* command; D needs a leak; E needs missing telemetry — none hold). The honest next
step is the natural extension of **B** (strengthen the discovery-credit path), but applied to the
**gate**, not the prompt:

> **Refine the discovery gate (a future M28.7/M29), not the prompt.** In
> `computeDiscoveryEvidence`, credit the `searched` leg when a search-category call's **output**
> surfaced the selected test node (output-grounded search), in addition to the current
> command/path-name match — optionally requiring a subsequent read of that same file (which this
> run has). Secondarily, capture the `Grep` tool's *pattern* into the tool-call `command` field so
> pattern-based searches are visible to provenance.
>
> This single change would flip *this exact run* from `ambiguous`/ineligible to
> `agent_discovered_hidden_match`/eligible, because the grep output demonstrably found
> `tests/test_domain_py.py` and the agent then read it and ran a canonical command. It must be
> gated and proven no-change on the existing provenance unit tests (the M28/M28.4 strict-gate
> tests pin the current command/path-name behavior, so the new path should be additive: a search is
> credited if command/path names the file **OR** its output surfaced the node).

Do **not** run an M29 Docker verifier (option A) on this label: the run is ineligible, so a Docker
execution would be gated out anyway and would burn a real image pull for no signal.

## Scope

One live `run-protocol` (approved single case), offline planner, offline verifier with **no**
Docker authorization. No Docker started, no command executed, canonical artifacts untouched, no
adoption, revision pass stays off by default. No source changes in this milestone (report-only).
No retrieval/ranking/scoring/candidate-generation or Capsule v2 pivot selection touched.
