# M192 — per-instance SWE-bench validation substrate audit

**M192 — PASS.  Substrate verdict: `PER_INSTANCE_SUBSTRATE_VIABLE`.**

SWE-bench's own per-instance Docker environment can serve as the authoritative
interactive edit-and-validate substrate. All twelve preregistered repositories
reach `REPO_INTERACTIVE_VALIDATION_READY` against a gate of 8/12, with zero
confirmed wrong-source executions. The single most useful discovery is that the
interactive shape did not have to be built: swebench 4.1.0's own evaluator
already creates a **persistent** container (`tail -f /dev/null`) and drives it
with a sequence of `exec_run` calls. M192 used the same image, the same
container arguments, the same exec path and the same eval script, and got a
full edit → test → edit → test lifecycle with no wrapper at all.

The environment failure M191 measured is a property of the shared
`.bench-repos` tree, not of SWE-bench. It does not survive the substrate change —
but one repository still carries the mechanism that causes it, and that is
reported below rather than rounded off.

---

## 1. M191 closure

| | |
| --- | --- |
| starting SHA | `bc8d2bc1c3a9634922d5816fe614bc716ef82cbd` |
| branch | `main` |
| `git diff --check` | clean (exit 0) |
| ahead / behind `origin/main` | 152 ahead / 0 behind |
| working-tree dirt | 203 entries: 2 tracked (`stage5_outcome_ledger.{json,md}`, pre-existing) + 201 untracked |

M191's final commit exists, is clean, and its reported numbers reproduce
exactly. The Bash-tool failure it reported was session-local: command execution
works here, so it was neither a repository nor an environment fault. Nothing was
reset, cleaned, pulled, merged, rebased or amended; all pre-existing dirt is
preserved.

## 2. External harness authority

Authority was **not** taken from a working tree. The `vexp-swe-bench` checkout
is at `d658e3457b82b5cb041f586093cc5002008a8cea` with **2758** dirty entries and
carries VTRACE's own agent shim (`dist/agents/claude-code.js`, with a
`.stage5-vtrace-backup` beside it). No M192 claim is derived from it.

The SWE-bench harness is the installed `swebench==4.1.0` wheel that
`run_evaluation` actually imports, so authority is provable directly:
**73 / 73 installed `.py` files match their wheel `RECORD` hashes, 0 modified**,
including all seven files M192's architectural claims are read from. That is a
stronger guarantee than a clean `git status` — it checks the exact bytes the
interpreter loads. Reproduced by `run_stage5_m192_harness_authority.py`.

## 3. Preregistration

Frozen in commit `88d5c0ee16d6bd8f2671d0eb8892b4b47b3dd753`, **before any
container was created**. Selection rule: the lexicographically first
`instance_id` of each of the 12 repositories in `swe-bench-100.jsonl`; P-probe
and F-probe are the lexicographically first `PASS_TO_PASS` / `FAIL_TO_PASS` ids.
Manifest sha256 `b3ce259ba23127f4f977c752323970ff948b837938d5f5fef36ebb0b4a5e828d`.
Breadth gate: **≥ 8/12 READY with zero WRONG_SOURCE among them**. Neither the
instance set nor the gate was touched afterwards.

## 4. How SWE-bench actually builds an environment

Traced from the installed harness, not from prose:

- **Three image layers** — `sweb.base.*` → `sweb.env.*` → `sweb.eval.<instance>`
  (`test_spec.py:84–120`). With the default namespace `swebench`, the
  per-instance image is **pulled, not built** (`docker_build.py:490–503`).
  All twelve exist prebuilt; **0 builds were required**.
- **Source** lives at `/testbed`, cloned at `base_commit` and `chmod -R 777`
  explicitly "so nonroot user can run tests" (`python.py:274`). Writability is a
  designed property, not an accident. HEAD is `base_commit` plus one commit
  titled `SWE-bench` carrying swebench's own provisioning fixups (`setup.py`,
  `tox.ini` pins); `base_commit` is an ancestor in 12/12.
- **Dependencies** come from a conda env `testbed` at `/opt/miniconda3`, baked
  into the env layer. This is the per-task provisioning M191 found unsolved.
- **Validation** is the eval script from `make_eval_script_list_py`: activate
  conda → `cd /testbed` → re-run `specs["install"]` → reset test files → apply
  the benchmark's test patch → run the repo's prescribed `test_cmd`. Commands
  are repo-correct without any invention on our part: `./tests/runtests.py` for
  django, `bin/test` for sympy, `pytest -rA` elsewhere.
- **The container persists.** `build_container` creates it detached with
  `command="tail -f /dev/null"` and `user=root`, then the evaluator issues
  multiple `exec_run` calls against it. **The per-instance environment is
  already interactive**; final grading simply chooses to use it once.
- **Network is available** inside the container.

**Difference from final evaluation:** only the model patch. Official evaluation
copies a patch in and `git apply`s it before running the same eval script; M192
instead edits the checkout in place. Image, container arguments
(`docker_specs == {}` for all twelve, so no `cap_add`/`run_args`), platform,
user, workdir, conda env, test patch and test command are identical. Final
resolution remains owned by `swebench.harness.run_evaluation`; M192 forks
nothing.

## 5. Results

12/12 READY, 0 WRONG_SOURCE, 12/12 `EDITED_CHECKOUT_CONFIRMED`, 12/12 gold
controls closed. Full matrix in `stage5_m192_readiness_ledger.md`.

**Provenance.** For each repository the package's `__file__` was resolved at
runtime and a sentinel was appended to *that observed file* — never to a guessed
`<root>/<name>` path, which would have missed `/testbed/src/flask` and
`/testbed/lib/matplotlib`. The sentinel writes a nonce file rather than printing,
because pytest and django capture stdout and a captured marker is not evidence.
It fired inside the real benchmark test command for all twelve.

**The §10 gold control closed 12/12**: the F-probe fails before the reference
repair and passes after it, in the same interactive container, driven entirely
by `docker exec`. The substrate reproduces SWE-bench's own resolved/unresolved
verdict interactively. Gold was used for environment verification only.

**Cost.** No builds, no pulls on the final run; ~34.6 GB on disk for eleven
newly pulled images (`docker system df` 47.3 → 81.9 GB), 3.6–10.8 GB each.
Container start median **628 ms**, repeat shell command median **22 ms**, a full
benchmark validation median **3 s** (range 2–29 s). Twelve repositories,
three-way parallel, complete in **122 s**. This is comfortably interactive.

## 6. The finding that matters: `psf/requests`

Resolving the package from `/testbed` is not a provenance proof, because `''`
puts the checkout at the head of `sys.path`. Measured again from a neutral
working directory:

- **11/12 are genuine editable installs** — the checkout wins with no cwd
  advantage and cannot be shadowed.
- **`psf/requests` is not.** From `/` it resolves to
  `/opt/miniconda3/envs/testbed/lib/python3.9/site-packages/requests/__init__.py`.

Its validation is correct *today* only because the benchmark's eval script
`cd`s into `/testbed` first. A command run from anywhere else — an agent's own
`pytest` invocation, a test that changes directory, a subprocess — would
silently validate an installed copy. This is exactly M191's failure mode, alive
inside an official image. It is recorded as `CWD_DEPENDENT` rather than rounded
off, and any future harness must pin the working directory rather than trust it.

## 7. Instrument corrections, stated plainly

The first instrument returned **7/12 READY / PARTIAL**; the final one returns
**12/12 / VIABLE**. That is a large move on the strength of my own corrections,
so each is listed with what justifies it. None changed the instance set or the
gate.

1. **V2** compared `HEAD` to `base_commit`. swebench images deliberately add a
   provisioning commit on top, so the test became ancestry plus a recorded delta.
2. **Log capture** demuxed stdout/stderr and concatenated them. swebench's
   `exec_run` captures them *merged and in order*, and `get_logs_eval` depends on
   that: the `>>>>> Start Test Output` markers are `:` no-ops visible only on
   stderr via `set -x`, while results go to stdout. Splitting moved the results
   outside the markers. Now captured exactly as the harness captures it.
3. **V6/V7** used hand-written `=== "PASSED"` / `=== "FAILED"` tests. Replaced
   with swebench's own `test_passed` / `test_failed`, which count `ERROR` — and
   absence — as failing. This is upstream semantics, not a looser rule: django's
   F-probe legitimately reports `ERROR`.
4. **V10** demanded a fully empty `git status`. The frozen prereg text says
   "returns to clean **or** the container is destroyed"; the code implemented
   neither. It now checks that M192's own mutation is gone and the container is
   destroyed, and records swebench's own residue (`?? build/`, a staged test
   file) separately.
5. **V6 with no P-probe.** `pylint-dev__pylint-4551` declares **zero**
   `PASS_TO_PASS` — a FAIL_ONLY instance. V7 already treated an absent probe as
   not-applicable; V6 now does too.

Each is a case where the code failed to implement the frozen prose or upstream
semantics. Still, a sweep that ends 12/12 after its own author corrected it five
times is exactly the result that should not be trusted on assertion — which is
why the next section exists.

## 8. Falsification control

An instrument that only ever confirms is worthless. `run_stage5_m192_wrong_source_control.py`
manufactures M191's failure on purpose. Inside **one** container, with **one**
command text, only the working directory and the presence of a site-packages
copy differ:

| | arm A (`cd /testbed`) | arm B (poisoned, `cd /`) |
| --- | --- | --- |
| `psf/requests` | `/testbed/requests/__init__.py` | site-packages |
| `pallets/flask` | `/testbed/src/flask/__init__.py` | site-packages |
| `sympy/sympy` | `/testbed/sympy/__init__.py` | site-packages |

Classified by the **same** classifier the sweep uses: **3/3 arm A
`EDITED_CHECKOUT_CONFIRMED` → READY, 3/3 arm B `INSTALLED_COPY_CONFIRMED` →
`WRONG_SOURCE`.** The instrument can still say no.

The control also produced a result worth keeping: in 2 of 3 poisoned arms the
**sentinel still fired**, because the copy was made after the edit and carried
it forward. The execution witness alone would have been fooled; the path witness
caught it. That is why `classifyProvenance` requires both, and it is a real
hazard for SWE-bench specifically, whose eval script re-runs `install` before
every test run.

## 9. Telemetry

Distinguishable in all twelve, from deterministic controls rather than assertion:
`exit 0` → 0; `exit 42` → **42** (preserved, not collapsed); stdout and stderr
isolated; a timeout reports `timed_out=true` with `exit_code=None` (**no
invented exit code**); a missing working directory returns exit `127` with
`OCI runtime exec failed` — a runtime failure, distinguishable from a test
failure. Process start, runner start (swebench's own marker), output, exit
status and source provenance are five independent signals.

One trap worth recording: **the eval script's exit code carries no test
semantics.** It ends with `git checkout`, so it exits 0 while the F-probe fails.
Anything reading validation success from the script's exit status would be
wrong on every instance. The truthful signal is the parsed per-test status.

## 10. Runtime observation capability

`RUNTIME_OBSERVATION_CAPABLE`. Tracebacks, the `trace` module, `sys.settrace`,
writable source for instrumentation and outbound network (so `coverage`, which
is absent, is installable) all work. Capability inventory only.

## 11. Architecture

**`HOST_AGENT_CONTAINER_EXECUTION_PREFERRED`** (Architecture B).

Evidence, not aesthetics: the agent's tooling and credentials stay on the host,
the container is entered only for validation, and this is *already* how the
official evaluator uses the image — persistent container, repeated `exec_run` —
so evaluator semantics are preserved by construction rather than re-implemented.
It also needs no agent CLI, model credentials or network policy inside a
benchmark image. Source identity holds (12/12 confirmed), dependency fidelity is
the image's own, state persists across commands, telemetry is truthful, cleanup
is one `docker rm`, isolation is per-instance, and latency is 22 ms/command.
Architecture A would require installing agent tooling into twelve historical
images and would put credentials inside the benchmark environment for no
measured gain.

Baseline/treatment symmetry would be straightforward: both arms take the same
`swebench/sweb.eval.x86_64.<instance>` image, the same container arguments and
the same eval script, leaving the intervention as the only difference. Not
implemented here.

## 12. Limitations

- **One instance per repository.** Breadth over depth, by design. An instance's
  environment is a property of its own image; twelve prebuilt images being
  healthy does not prove the other 88 are.
- **`psf/requests` is cwd-dependent** (§6). Ready under the benchmark's runner,
  fragile outside it.
- **The model-patch path was not exercised** — M192 edits in place instead of
  `git apply`ing a patch. That is the one divergence from final evaluation.
- **No agent has still ever run here.** M192 establishes that the substrate can
  be trusted; it says nothing about what agents do inside it. M191's largest
  evidential gap is unchanged.
- **`pylint-dev__pylint-4551` has no `PASS_TO_PASS`**, so its readiness rests on
  the F-probe and gold control alone.

## 13. Authorizations

```
OBSERVATIONAL_CORPUS_SUBSTRATE_READY
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
```

The substrate is ready; the acquisition is not authorized. A future milestone
must separately preregister a frozen task fixture, model, turn limit, per-run
cost limit, total live-spend cap and stopping rule before any agent call. M192
authorizes no spending.

## 14. Reproduction

```bash
VENV=/home/calvin/code/vexp-swe-bench/.venv/bin/python
B=benchmarks/stage5_vexp_swe_bench_smoke

$VENV $B/run_stage5_m192_harness_authority.py      # harness authority
bun  $B/run_stage5_m192_manifest.ts                # regenerate the frozen manifest
$VENV $B/run_stage5_m192_probes.py --workers 3     # 12 probes -> _m192_probes_raw.json
bun  $B/run_stage5_m192_analyze.ts                 # bounded evidence + readiness ledger
$VENV $B/run_stage5_m192_wrong_source_control.py   # falsification control
bun  $B/run_stage5_m192_control_verify.ts          # control verdict
```

`live-agent runs: 0`, `live model spend: $0`. `src/` unchanged.
