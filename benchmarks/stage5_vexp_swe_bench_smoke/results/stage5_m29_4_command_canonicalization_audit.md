# Stage 5 — M29.4: Canonicalize benign trailing stderr-merge for fair verifier commands (offline)

Goal: a fair agent-selected pytest command that is canonical except for a trailing stderr-merge
redirect (`2>&1`) should not be rejected by the planner's command-safety gate. M29.3 produced the
first non-degenerate fair-verifier candidate (`eval-m29-candidate-current-sphinx-7462-r1`: real patch
delta + fair provenance + sanitized prompt) whose **only** blocker was the trailing `2>&1`. This change
strips that one benign token before the safety gate so the candidate becomes planner-eligible — without
loosening any other shell-syntax rule. No Docker, no `--allow-docker-verify`, no command executed.

## What changed (source)

`src/capsule/agentTestCommandPlanner.ts`:

- New PURE `canonicalizeFairCommand(command)` → `{ capturedCommand, canonicalCommand,
  commandCanonicalized, canonicalizationReason }`. It removes **only** a trailing stderr-merge redirect
  matched by `/\s+2\s*>\s*&\s*1\s*$/` (covers `2>&1`, `2> &1`, and whitespace-equivalent variants), and
  is anchored at end-of-string so a `2>&1` followed by a pipe/redirect/chained command is never the
  trailing token and is left byte-identical. Reason string: `removed_trailing_stderr_merge`.
- `buildAgentTestCommandPlan` now canonicalizes the selected command first and runs
  `classifyCommandSafety` on the **canonical** form. `classifyCommandSafety` itself is unchanged — it
  still rejects every pipe/redirect/chaining token; canonicalization just decides what string it sees.
- `AgentTestCommandPlan` gains four reported fields: `capturedCommand` (raw, verbatim for audit),
  `canonicalCommand` (== captured when not rewritten), `commandCanonicalized`, `canonicalizationReason`.
  `selectedCommand` still reports the raw captured command (unchanged semantics).

The M27 verifier needed no change: it already discards the raw shell capture and rebuilds an executed
command from `framework + selectedTests` (`canonicalizeCommand`), and reports `capturedCommand` +
`executedCommand` + `commandCanonicalized` + `canonicalizationReason`. So the verifier still executes a
canonical command (never the raw one), and the raw captured command remains available for audit at both
the plan and verify layers.

## Audit results

All checks below are offline planner runs (`--mode plan-agent-test-command`, no `--allow-docker-verify`)
or pure-function assertions. ✓ = pass.

| # | Check | Result |
|---|---|---|
| 1 | M29.3 label becomes planner-eligible | ✓ `eligibleForFutureExecution=true`, `blockers=[]` |
| 2 | Raw captured command preserved | ✓ `capturedCommand` = `selectedCommand` = `…test_parse_annotation -v 2>&1` |
| 3 | Canonical command strips only trailing `2>&1` | ✓ `canonicalCommand` = `…test_parse_annotation -v` (only the ` 2>&1` removed) |
| 4 | Same selected test node preserved | ✓ `selectedTests = ["tests/test_domain_py.py::test_parse_annotation"]` |
| 5 | Pipes / `head` remain rejected | ✓ `… 2>&1 \| head -60` not canonicalized, blocker `shell pipeline/redirect token "\|"` |
| 6 | Output-file redirects remain rejected | ✓ `… > out.txt` not canonicalized, `commandSafety.allowed=false` |
| 7 | Command chaining remains rejected | ✓ `… 2>&1 && echo ok` / `… 2>&1; echo ok` not canonicalized, rejected |
| 8 | M28.3 piped command remains ineligible | ✓ see below |
| 9 | M29.1 already-clean command stays eligible, not canonicalized | ✓ see below |

### 1–4. M29.3 label (`eval-m29-candidate-current-sphinx-7462-r1`)

Planner output (`--patch-source pivot_revision_revised --command-source pivot_revision_test_commands`):

```
selectedCommand        : python -m pytest tests/test_domain_py.py::test_parse_annotation -v 2>&1
capturedCommand        : python -m pytest tests/test_domain_py.py::test_parse_annotation -v 2>&1
canonicalCommand       : python -m pytest tests/test_domain_py.py::test_parse_annotation -v
commandCanonicalized   : true
canonicalizationReason : removed_trailing_stderr_merge
commandSafety.allowed  : true   (diagnosticOnly absent ⇒ NOT diagnostic-only)
fairProvenance         : agent_discovered_hidden_match, allowedForFairVerification=true
selectedTests          : ["tests/test_domain_py.py::test_parse_annotation"]
expectedImageKey       : swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7462:latest
patchSha256 (revised)  : 07c5bf238b9fffa0…
eligibleForFutureExecution : true
blockers               : []
```

Matches the M29.4 planner expectation exactly. (Note on `commandSafety.diagnosticOnly`: the field is
optional and emitted **only** when a command is diagnostic-only; on the allowed path it is absent, which
is the `false` case — the command is now fairly executable, not diagnostic-only.)

### 5–7. Unsafe shell forms still rejected

These are not the M29.3 label but unit-level assertions of the gate (also covered by tests 5–8 in
`agentTestCommandPlanner.test.ts`):

- `… 2>&1 | head -60` → `commandCanonicalized=false` (the `2>&1` is not the trailing token), blocked on
  the pipe `|`.
- `… > out.txt` → not canonicalized, blocked on `>`.
- `… 2> err.txt` → not canonicalized (only `2>&1` is benign, a file target is not), blocked on `>`.
- `… 2>&1 && echo ok` and `… 2>&1; echo ok` → not canonicalized (chaining follows the `2>&1`), blocked
  on `&&` / `;`.

### 8. M28.3 piped command remains ineligible (`eval-m28-discovery-current-sphinx-7462-r1`)

```
selectedCommand      : python -m pytest tests/test_pycode_ast.py -v 2>&1 | head -60
canonicalCommand     : python -m pytest tests/test_pycode_ast.py -v 2>&1 | head -60   (UNCHANGED)
commandCanonicalized : false
commandSafety.allowed: false
eligible             : false
blockers             : provenance "ambiguous" is not allowed for fair verification;
                       command not fair-executable as captured: shell pipeline/redirect token "|"
```

The trailing token is `| head -60`, not `2>&1`, so nothing is stripped and the pipe blocker stands
(provenance is `ambiguous` here too). Unchanged from M29.2.

### 9. M29.1 already-clean command stays eligible & uncanonicalized (`eval-m28-strong-discovery-current-sphinx-7462-r1`)

```
selectedCommand      : python -m pytest tests/test_domain_py.py::test_parse_annotation -v
canonicalCommand     : python -m pytest tests/test_domain_py.py::test_parse_annotation -v   (UNCHANGED)
commandCanonicalized : false
commandSafety.allowed: true
provenance           : agent_discovered_hidden_match, allowed=true
eligible             : true
```

No trailing `2>&1` ⇒ `commandCanonicalized=false`; still eligible. Canonicalization is a no-op on
already-clean commands.

## Scope & invariants

- Provenance gate untouched (canonicalization is independent — test 9 shows a disallowed-provenance copy
  of the M29.3 command is still blocked despite `commandCanonicalized=true`/`commandSafety.allowed=true`).
- Revision pass remains opt-in; revised patches are not wired into canonical evaluation; no adoption.
- No retrieval/ranking/scoring/candidate-generation change — the deterministic retrieval eval
  (`stage5_retrieval_eval_expanded`, `stage5_retrieval_eval_cross_repo_30`) is **byte-identical**.
- Tests: 11 new M29.4 cases in `agentTestCommandPlanner.test.ts` + the verifier-plan mock updated for the
  four new fields; the former M28.4-9 test was repointed from `-xvs 2>&1` (now canonicalized) to a
  genuine pipe to preserve its "safety independent of provenance" intent. Full suite: 2850 pass / 0 fail.

## Next recommendation

The M29.3 label is now a true `ready_for_m30` candidate: real patch delta (`07c5bf23…` ≠ `6aca9946…`),
fair provenance, sanitized prompt, and a canonical/safe command. The next step would be **one M30
diagnostic original-vs-revised verifier comparison** on this label (still gated behind
`--allow-docker-verify`; **not** run here).

---

Scope: source + tests + this report only. **No Docker, no `--allow-docker-verify`, no SWE-bench
canonical evaluation, no agent-selected command executed, no 30/100-case sweep.** Raw artifacts
(`_agent_test_command_plan.json` written by the offline planner) were not staged.
