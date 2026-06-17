# Stage 5 — M24 audit: fair in-loop test environment handling

Audited run: `eval-m23-fair-test-policy-current-sphinx-7462-r1` · instance
`sphinx-doc__sphinx-7462`. No live agents, no Docker, no 30/100. Source change made:
an explicit environment-classification layer in `src/capsule/toolOutputCapture.ts`
(`classifyTestEnvironmentOutcome`) + `environmentClassification` on the fair-verification
assessment. Retrieval/ranking/scoring/candidate generation unchanged (retrieval evals
byte-identical).

## 1. Executive conclusion

**The current in-loop Bash environment cannot support fair test verification for this
instance, and `conda run -n vexp_swebench` does NOT fix it.**

- The agent's in-loop `python -m pytest` ran against the **host base miniforge** interpreter
  (`/home/calvin/miniforge3/lib/python3.12/...`), whose `jinja2==3.1.6` is incompatible with
  the old Sphinx 3.x checkout. Pytest's plugin import chain (`sphinx.testing.fixtures`) broke
  with `ImportError: cannot import name 'environmentfilter' from 'jinja2'` **before any test
  was collected**. Zero test signal was produced — on both the first pass and the revision pass.
- **`conda run -n vexp_swebench` is not sufficient.** That env *also* has `jinja2==3.1.6`
  (verified: `'environmentfilter' in dir(jinja2)` → `False`), so the identical `ImportError`
  would occur. It would make the env *deterministic* (removing the "whatever is on host PATH"
  non-determinism) but would still fail this instance, because the failure is a **per-instance
  dependency-pin mismatch**, not a host-vs-conda mismatch.
- The only environment that runs these tests is the **SWE-bench Docker `testbed`** image, which
  does a per-instance `conda activate testbed` + `pip install -e .[test]` and thereby installs
  the instance-pinned old `jinja2` (`<3.1`). There is no single shared conda env (base or
  `vexp_swebench`) that can satisfy every instance's pins. **Deeper, per-instance isolation is
  required**, not a fixed shared env.

Therefore M24 lands as **environment classification only** (Path E1): make environment failures
explicit so fair verification rejects them cleanly, and keep fair verification disabled.

## 2. M23.1 traceback / root-cause summary

Captured pytest output (both passes, identical signature):

```
Traceback (most recent call last):
  File "/home/calvin/miniforge3/lib/python3.12/site-packages/_pytest/config/__init__.py", line 879, in import_plugin
    __import__(importspec)
  ...
  File ".../sphinx-doc__sphinx/sphinx/testing/fixtures.py", line 21, in <module>
    from sphinx.testing import util
  ...
  File ".../sphinx-doc__sphinx/sphinx/util/rst.py", line 22, in <module>
    from jinja2 import environmentfilter
ImportError: cannot import name 'environmentfilter' from 'jinja2'
        (/home/calvin/miniforge3/lib/python3.12/site-packages/jinja2/__init__.py)
```

Root cause chain:
1. pytest auto-loads the `sphinx.testing.fixtures` plugin (registered by the repo).
2. That import transitively reaches `sphinx/util/rst.py`, which does `from jinja2 import
   environmentfilter` — an API removed in **Jinja2 3.1**.
3. The interpreter on the agent's PATH is **base miniforge** with `jinja2 3.1.6`, so the symbol
   is missing → `ImportError`, raised inside pytest's plugin loader, **before collection**.
4. The `... 2>&1 | head` pipeline returned exit 0 (head succeeded), masking the failure as
   `is_error=false`; output-text parsing (M22) correctly overrode this to `error`.

Why the harness lets this happen (confirmed by reading `/home/calvin/code/vexp-swe-bench`): the
agent (`claude` CLI) is spawned with `env: { ...process.env }` and `cwd` = the plain host git
clone (`.bench-repos/<repo>`). There is **no conda activation, no per-instance venv, no Docker**
around in-loop Bash. The agent inherits whatever Python/PATH launched `node dist/cli.js run`.
Per-instance pinned deps exist **only** inside the Docker `testbed` image used for grading
(`src/evaluate/evaluator.ts` → upstream `swebench.harness.run_evaluation`; generated `eval.sh`
does `conda activate testbed` + `pip install -e .[test]`).

## 3. Environment comparison

| environment | purpose | used by | dependency state known? | can run target tests? | fair verification usable? | notes |
| ----------- | ------- | ------- | ----------------------- | --------------------- | ------------------------- | ----- |
| agent in-loop Bash (host PATH) | agent self-tests during the turn loop | the in-loop agent (M23.1) | **no** — inherits whatever launched the harness; in M23.1 it was base miniforge | **no** — `jinja2 3.1.6` breaks old Sphinx plugin import | **no** | actual M23.1 failure; non-deterministic across hosts |
| agent in-loop Bash via `conda run -n vexp_swebench` | make in-loop env deterministic | (proposed) | **partly** — fixed env, but still one shared env | **no** for sphinx-7462 — `vexp_swebench` also has `jinja2 3.1.6` (`environmentfilter` absent) | **no** | removes host non-determinism but NOT the per-instance pin mismatch |
| SWE-bench Docker evaluator (`testbed`) | official resolution grading | `--mode evaluate` / upstream `swebench` | **yes** — per-instance `pip install -e .[test]` installs pinned `jinja2<3.1` | **yes** | n/a (grading, not in-loop) | the only env that runs these tests; not available to the in-loop agent |
| local host probe (this audit) | inspect interpreters/versions | M24 auditor (non-agent) | yes (measured below) | n/a | n/a | probe only; classified as local environment probe, not a benchmark result |
| per-instance isolated in-loop runner | give the in-loop agent the pinned env | (E3, not built) | would be **yes** | would be **yes** | potentially | large; essentially replicating testbed setup for the loop |

### Local environment probes (non-agent; not benchmark results)

```
$ python -c "import sys; print(sys.executable)"        -> /home/calvin/miniforge3/envs/vexp_swebench/bin/python  (current shell)
$ python -c "import jinja2; print(jinja2.__version__)"  -> 3.1.6
$ python -m pytest --version                            -> pytest 9.0.3
$ /home/calvin/miniforge3/bin/python -c "import jinja2; print(jinja2.__version__)"  -> 3.1.6   (base; this is what M23.1 used)
$ conda run -n vexp_swebench python -c "import jinja2; print('environmentfilter' in dir(jinja2))"  -> False
```

Note the asymmetry: my interactive shell resolves `python` to `envs/vexp_swebench`, but the
M23.1 traceback used `miniforge3/lib/...` (= **base**). So the in-loop env was not even the
`vexp_swebench` env — it was base miniforge. Either way, both carry `jinja2 3.1.6`.

## 4. Classification proposal / result

New pure layer `classifyTestEnvironmentOutcome` (in `toolOutputCapture.ts`) maps `parsedOutcome`
+ raw output to one of six labels, keyed on **whether the selected target test was provably
collected/executed** (`collected N items`, per-node result lines, a `FAILURES` header):

| classification | rule |
| -------------- | ---- |
| `test_passed` | parsed `passed` |
| `test_failed` | parsed `failed` (assertion / FAILURES) — the test ran |
| `test_error_target` | parsed `error` **and** target test was collected/executed first |
| `test_error_environment` | parsed `error` **and** target test was **not** executed (import/plugin/dep failure before collection) |
| `test_not_run` | collected 0 items / no tests ran |
| `unknown` | no recognizable pytest runner evidence |

The raw `parsedOutcome` is kept separate and never rewritten. Re-running the layer over the
captured M23.1 artifact (`buildFairVerificationReport`) yields:

| phase | command | parsedOutcome | environmentClassification | target test executed? | fairVerificationUsable | blockers |
| ----- | ------- | ------------- | ------------------------- | --------------------- | ---------------------- | -------- |
| first_pass | `python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 \| head -80` | `error` | **`test_error_environment`** | **no** | n/a (first pass) | — |
| pivot_revision | `python -m pytest tests/test_domain_py.py::test_parse_annotation -xvs 2>&1 \| head -50` | `error` | **`test_error_environment`** | **no** | **false** | provenance `injected_metadata` not allowed · outcome `error` (not passed) · patch-state `revision_phase_state` can't verify final · environment/import failure markers present (ImportError, Traceback) |

So the explicit classification now states *why* there is no signal: the target test never ran.

## 5. Recommendation

**A — Add environment classification only; keep fair verification disabled.**

Rationale: the blocker is the environment, and the environment problem is structural
(per-instance dependency pinning), not a flag we can flip. Standardizing in-loop test commands
on `conda run -n vexp_swebench` does **not** address the observed failure mode — that env shares
the same `jinja2 3.1.6` and would reproduce the exact `ImportError`. It would only buy
*determinism* (worth doing if/when we want reproducible in-loop runs), not *correctness* for
old-dep instances. The honest fair-verification signal for these instances requires the
per-instance pinned environment, which today exists only inside the Docker `testbed` image.

Sequencing:
- **Now (this change):** classification layer (E1) so env-failed test results are rejected
  cleanly and labelled `test_error_environment`. Done; fair verification stays disabled.
- **Next, design-only (E3):** an isolated in-loop runner that reuses the per-instance pinned
  environment (e.g. run the agent-selected test inside the instance's `testbed` image / a
  per-instance venv built like `pip install -e .[test]`). Do not implement yet; do not run
  30/100.
- **Optional, orthogonal:** if we ever want deterministic in-loop runs regardless of host,
  wrap agent test commands in `conda run -n vexp_swebench` (Path E2 guidance) — but only with
  the clear caveat that it does not make old-dep instances runnable, and the prompt must still
  require reporting environment failure rather than claiming verification.

## 6. Scope / safety

Report + additive pure code (`classifyTestEnvironmentOutcome`, `environmentClassification`
field, 8 new unit tests). No retrieval/ranking/scoring/candidate-generation or Capsule-v2 pivot
change (retrieval evals byte-identical). No revised patch wired into canonical evaluation;
revision pass and fair-verification policy remain off by default. No live agents, no Docker, no
30/100. Raw run artifacts under `runs/` not staged.
