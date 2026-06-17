# Stage 5 — M30.1: Diagnostic Verifier Python Interpreter Resolution

Scope: make the non-oracle diagnostic verifier seam (`--mode verify-agent-test-command
--allow-docker-verify`) resolve its Python interpreter from the vexp-swe-bench virtualenv
when available, instead of always shelling bare `python`. Interpreter resolution only — no
change to command construction, ranking, scoring, retrieval, or the oracle boundary.

## 1. Executive verdict

**Fixed.** The verifier now prefers `<vexp-swe-bench-dir>/.venv/bin/python` (or the Windows
`.venv/Scripts/python.exe`) when it exists, and falls back to bare `python` otherwise. The
resolution outcome is recorded in the verify artifact as `pythonCommand` +
`pythonCommandResolvedFrom`, so a future seam failure is explainable from the artifact
alone. Typecheck (src + benchmarks), the full test suite (2857 pass / 0 fail, including 8
new resolution tests), and both deterministic retrieval evals (byte-identical) are green.
Docker was **not** run — the new code is fully covered by a pure unit-tested resolver plus
typechecked wiring, and M30 already proved the live Docker path works with the venv
interpreter.

## 2. Root cause

In M30, the first revised-patch verification failed with:

```
ModuleNotFoundError: No module named 'docker'
```

The runner's default container runner shelled the seam script
(`verify_agent_test_command.py`) with a **hardcoded** interpreter:

```ts
pythonCommand: "python",
```

`python` resolves via `PATH`, which can point at a system interpreter without the `docker`
SDK. The SDK is installed in the vexp-swe-bench virtualenv
(`/home/calvin/code/vexp-swe-bench/.venv/bin/python`, `docker 7.1.0`). The M30 workaround
was to prepend that venv's `bin` to `PATH`; this fix makes the resolution automatic and
explicit.

## 3. Fix

Pure resolver added to `src/capsule/agentTestCommandVerifier.ts` (the module performs no
I/O — existence is supplied by the caller, keeping it unit-testable without Docker or a
real filesystem):

```ts
export function resolveVerifierPythonCommand(input: {
  vexpSweBenchDir: string | null;
  candidateExists: (absPath: string) => boolean;
}): ResolvedVerifierPython
```

Resolution order:

1. `<vexp-swe-bench-dir>/.venv/bin/python`  (POSIX — preferred)
2. `<vexp-swe-bench-dir>/.venv/Scripts/python.exe`  (Windows convenience)
3. `"python"`  (fallback — current behavior)

`pythonCommandResolvedFrom` is `"vexp_venv"` for (1)/(2) and `"fallback_python"` for (3).
When `vexpSweBenchDir` is `null`/empty, the resolver returns the fallback **without**
probing existence.

Runner wiring (`run_stage5_vexp_swe_bench_smoke.ts`, inside the authorized-Docker branch of
`runVerifyAgentTestCommand`): the interpreter is resolved with the real
`existsSync` predicate and threaded both into the seam invocation and the artifact builder:

```ts
const python = resolveVerifierPythonCommand({
  vexpSweBenchDir: config.vexpSweBenchDir,
  candidateExists: existsSync,
});
const execution = await runner({ /* … */ pythonCommand: python.pythonCommand });
const verification = buildAgentCommandVerification({ /* … */ python });
```

Only the interpreter changed: the seam args, the canonical safe command, patch handling,
and every other field of the verification record are untouched (asserted by test 4).

## 4. Metadata added

`AgentCommandVerification` (the `_agent_test_command_verify.meta.json` artifact) now carries:

| Field | Type | Meaning |
| --- | --- | --- |
| `pythonCommand` | `string` | The interpreter that actually shelled the seam |
| `pythonCommandResolvedFrom` | `"vexp_venv" \| "fallback_python"` | How it was chosen |

`buildAgentCommandVerification` accepts an optional `python` argument; when omitted it
defaults to `{ pythonCommand: "python", pythonCommandResolvedFrom: "fallback_python" }`, so
existing pure callers/tests are unaffected. (Skip artifacts — produced before the Docker
gate — do not carry these fields, since no interpreter is selected when no seam runs.)

## 5. Non-oracle boundary check

Unchanged. This work touches interpreter selection only — it imports no SWE-bench grading
module and calls none of `get_eval_report`, `get_resolution_status`, `resolved` scoring,
`FAIL_TO_PASS`, or `PASS_TO_PASS`. The seam script's import set is untouched. A serialized
verification record (including the new interpreter fields) is asserted to contain none of
the forbidden oracle/grading tokens (test 5; the existing token-exclusion test 7 also still
passes — the field name `pythonCommandResolvedFrom` does not introduce a lowercase
`resolved` substring).

## 6. Tests / verification

New `describe("verifier — Python interpreter resolution (M30.1)")` block in
`src/capsule/agentTestCommandVerifier.test.ts`:

1. resolves `<vexp-dir>/.venv/bin/python` when it exists (`vexp_venv`).
2. falls back to bare `python` when no venv interpreter exists (`fallback_python`).
   - 2b. falls back for `null`/empty vexp dir **without probing** existence.
   - 1b. Windows layout resolves; POSIX is preferred when both exist.
3. the artifact records `pythonCommand` + `pythonCommandResolvedFrom` (and defaults to the
   fallback when the caller resolves nothing).
4. command construction is unchanged except the two interpreter fields (artifacts compared
   field-by-field after stripping them).
5. no oracle/grading token is introduced via the interpreter fields.

Results:

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean |
| `bun run typecheck:benchmarks` | clean |
| `bun test` | 2857 pass / 0 fail (170 files); verifier file 24 pass / 0 fail |
| `git diff --check` | clean |
| retrieval eval — expanded | **byte-identical** to committed baseline |
| retrieval eval — cross_repo_30 | **byte-identical** to working copy (pre-existing dirty) |
| Docker run | avoided |

On the optional no-Docker smoke: the resolver call lives **after** the
`--allow-docker-verify` gate, so a no-Docker invocation never exercises it. The new path is
instead validated by the pure unit tests above plus typechecked wiring; M30 already
demonstrated the end-to-end Docker seam succeeds with the venv interpreter. Hence
`--allow-docker-verify` was not needed and was not run.

## 7. Next recommendation

Return to broader VTRACE context/actionability benchmarking unless a more discriminative
command/label is intentionally selected. The diagnostic command-level verifier seam is now
operationally robust (interpreter auto-resolved + recorded); it remains diagnostic-only and
is not wired into canonical evaluation, and the pivot-revision pass stays off by default.
