# Stage 5 — M29.3: Non-degenerate fair-verifier candidate (one fresh live rerun, no Docker)

Goal: from **one** fresh fair-policy live run on `sphinx-doc__sphinx-7462`, determine whether a single
label can carry **both** (1) a planner-eligible fair agent-selected command and (2) a revised patch
whose hash differs from the original model patch — the non-degenerate candidate M29.2 could not find in
existing artifacts. No Docker, no `--allow-docker-verify`, no agent-selected command executed.

Label: `eval-m29-candidate-current-sphinx-7462-r1` (r1 only; r2 not needed — the run was valid, the
revision ran, a test command was produced, and every patch artifact is present).

## 1. Executive verdict

**Classification: `patch_delta_but_ineligible`.** The run produced a **real patch delta**
(revised `07c5bf23…` ≠ original/canonical `6aca9946…`) **and** a fair, prompt-sanitized,
strong-discovery command — but the M26 planner reports `eligibleForFutureExecution = false`.

The single blocker is **command shape, not fairness**: the agent's captured test command ends in a
`2>&1` shell redirect, which the safety gate rejects ("not fair-executable as captured"). Crucially the
provenance gate **passes** this time — the planner classifies the command as
`agent_discovered_hidden_match` with `allowedForFairVerification = true`, unlike every delta-label in
M29.2 (which failed on `ambiguous`/`injected_metadata` provenance). So this run advanced the bottleneck
from *provenance* to *one benign redirect token*. → **Recommendation C.**

## 2. Run validity

Valid. Canonical first-pass row + meta:

| field | value |
|---|---|
| instanceId | `sphinx-doc__sphinx-7462` |
| patched | 1 / 1 (modelPatch 560 bytes, 25 lines) |
| numTurns (first pass) | 26 |
| costUsd (first pass) | $0.447 (run total $0.70 incl. revision pass) |
| vtraceEffectiveCapsuleEngine | `v2` |
| vtraceContextInjected | `true` |
| vtraceCapsuleIntent | `auto` |
| vtraceCapsulePivots | `sphinx/domains/python.py::_parse_annotation` (issue edit-site anchor); `sphinx/pycode/ast.py::unparse` (actionable, 9 dependents) |
| revision pass | ran (`--pivot-revision-pass`, `--pivot-inspection-enforcement`, `--revision-verification-policy agent-discovered-tests`) |

`resolved` is `None` (no Docker evaluation was run — per task constraints).

## 3. Patch delta check

| patch | sha256 (16-hex) |
|---|---|
| original model patch (canonical `modelPatch`) | `6aca9946519543a6` |
| pivot revision original (`_pivot_revision_original.patch`) | `6aca9946519543a6` |
| pivot revision revised (`_pivot_revision_revised.patch`) | `07c5bf238b9fffa0` |

- pivot-revision-original == canonical modelPatch ✓ (original is consistent).
- **revised ≠ original ⇒ YES.** A genuine, non-degenerate patch delta. This is the ingredient M29.1's
  degenerate case and the M28 strong-discovery label lacked.

(Record fields: `ran=true`; `revisionCandidate=false`, `replacementRecommended=false`,
`canonicalReplaced=false` — consistent with the diagnostic-only, no-adoption posture. The delta gate is
hash-based, so `revisionCandidate=false` does not negate the delta.)

## 4. Fair command eligibility

M26 planner (`--mode plan-agent-test-command --patch-source pivot_revision_revised --command-source
pivot_revision_test_commands`, offline, no `--allow-docker-verify`):

| field | value |
|---|---|
| selectedCommand | `python -m pytest tests/test_domain_py.py::test_parse_annotation -v 2>&1` |
| selectedTests | `tests/test_domain_py.py::test_parse_annotation` |
| commandFramework | `pytest` |
| commandSafety.allowed | **false** — `shell pipeline/redirect token ">" — not fair-executable as captured` |
| fairProvenance.classification | `agent_discovered_hidden_match` |
| fairProvenance.allowedForFairVerification | **true** |
| expectedImageKey | `swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest` |
| patchSha256 (planned-over) | `07c5bf238b9fffa0…` (the revised patch) |
| **eligibleForFutureExecution** | **false** |
| blockers | `command not fair-executable as captured: shell pipeline/redirect token ">"` |

So eligibility fails on **exactly one** gate — command safety — driven by the trailing `2>&1`. Every
other gate clears: patch exists, image key derivable, command classifies as pytest, and provenance is
fair (`allowedForFairVerification=true`).

Why eligibility "regressed" vs. a hypothetical ready candidate (Recommendation C focus): it did **not**
regress on provenance — provenance is *stronger* here than on any M29.2 delta-label. It is blocked
solely because the agent appended `2>&1` (merge stderr→stdout) to its captured command, and the safety
gate conservatively rejects any `>`/`|` token rather than parse shell. This is a command-canonicalization
gap, not a fairness failure.

## 5. Prompt / provenance sanity

- **Prompt sanitized: YES.** The selected test name `test_parse_annotation` does **not** appear in
  `_pivot_revision_prompt.md` (0 occurrences); no `FAIL_TO_PASS`/gold/hidden-label leakage. The prompt
  explicitly instructs: *"Do not run a test merely because a hidden benchmark/evaluator label says so."*
- **Search/read/canonical chain observed: YES.** From `_revision_verification_policy.json`
  `discoveryEvidence`:
  - priorSearchCommands: searched `tests/`
  - priorReadCommands: read `tests/test_domain_py.py`
  - priorOutputsWithTestNode: surfaced `tests/test_domain_py.py:239:def test_parse_annotation():` and the
    function body in tool output
  - matchedTestFiles/Names: `tests/test_domain_py.py` / `test_parse_annotation`; `editToolBeforeTest=true`.
- **Two provenance verdicts (expected, not a defect).** The *live* policy artifact recorded
  `classification: "ambiguous"` (computed at revision-phase time, plus `error` outcome / pre-revised
  patch state). The *M26 planner* recomputes it offline as `agent_discovered_hidden_match`,
  `allowedForFairVerification=true` — the hidden label was matched via repo discovery and was never
  exposed in the prompt. The planner verdict is the authoritative eligibility gate; the live `ambiguous`
  reflects the more conservative, in-flight assessment.

## 6. Classification

`patch_delta_but_ineligible`:

- revised ≠ original — **yes** (`07c5bf23…` ≠ `6aca9946…`)
- planner eligible — **no** (`eligibleForFutureExecution=false`; sole blocker = `2>&1` redirect)

Not `ready_for_m30` (command not canonical/safe). Not `eligible_but_no_patch_delta` (planner ineligible,
and a delta exists). Not `invalid_or_missing_artifacts` (run valid, revision ran, command + all patch
artifacts present).

## 7. Next recommendation

**C. Inspect why command eligibility is ineligible.**

Diagnosis (already isolated above): eligibility is blocked by a **single benign token** — the trailing
`2>&1` stderr-merge redirect on an otherwise canonical `python -m pytest <node> -v` command. This is not
a provenance, patch, image-key, or framework failure; all of those gates pass. In particular the
provenance gate now returns `agent_discovered_hidden_match` / `allowedForFairVerification=true`, so the
M29.2 bottleneck (ineligible provenance + shell-piped captures) has been cleared — only command shape
remains.

Suggested follow-up (design, not executed here): teach the command-safety gate to **canonicalize a
benign trailing `2>&1`** (stderr→stdout merge, no injection surface) before the redirect/pipeline check,
or have the verifier capture the bare `python -m pytest <node> -v` form. Either would flip *this exact
label* to `eligibleForFutureExecution=true` while preserving the patch delta — i.e. turn it into the
first true `ready_for_m30` candidate. Until that gate change lands, this label is not eligible for the
M30 diagnostic verifier.

(Per task: r2 was not run — none of the r2 triggers fired. No Docker, no `--allow-docker-verify`, no
canonical SWE-bench evaluation, no agent-selected command executed. Report-only; no source changed.)
