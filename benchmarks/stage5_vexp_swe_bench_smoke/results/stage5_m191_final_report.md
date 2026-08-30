# M191 — validation-loop observational readiness and evidence acquisition

**Verdict: PASS**, on §37's branch B *and* branch C. The environment is not ready and no
committed live-spend authorization exists, so Stage B was correctly blocked, twice, for two
independent reasons. Both blockers were established mechanically rather than asserted.

```text
VALIDATION_ENVIRONMENT_NOT_READY
LIVE_SPEND_NOT_AUTHORIZED
I6_OBSERVATIONAL_CORPUS_NOT_ACQUIRED

live agent runs: 0        live spend: $0        Docker evaluations: 0
```

No VTRACE treatment was injected, no product behaviour was changed, no `src/` file was
touched, and I5 was not reopened.

## Starting state

| | |
|---|---|
| branch | `main` |
| starting SHA | `b55b2dc49a375d93cf85cd01f8ac3e3d293add3c` |
| pre-existing dirt | 203 entries, incl. tracked `stage5_outcome_ledger.{json,md}` — left exactly as found |
| external harness | `/home/calvin/code/vexp-swe-bench` at `d658e3457b82b5cb041f586093cc5002008a8cea`, **2758 dirty entries** |

---

## 1 — the external harness, audited from immutable content

The harness working tree is heavily dirty, so per §29 the audit reads `git show HEAD:` for
methodological claims and treats the working tree only as a record of what is *executed here*.

The one dirty file that matters is the agent adapter, `dist/agents/claude-code.js`: +109 lines
against HEAD, all of them VTRACE's own Stage 5 patches (`STAGE5_VTRACE_MCP_PATCH`,
`STAGE5_VTRACE_INSTRUCTIONS_PATCH`, `STAGE5_M163_TASK_TRIGGER_PATCH`,
`STAGE5_TOOL_USE_DISCIPLINE_PATCH`, `STAGE5_VTRACE_DISALLOWED_TOOLS_PATCH`,
`STAGE5_TOOL_LOOP_GUARD_HOOK_PATCH`, `STAGE5_VTRACE_STREAM_PATCH`).

**Every one of them is env-var gated.** With `VTRACE_MCP_CONFIG`,
`VTRACE_AGENT_INSTRUCTIONS_FILE`, `VTRACE_TASK_TRIGGER_FILE`,
`VTRACE_TOOL_USE_DISCIPLINE_FILE`, `VTRACE_AGENT_DISALLOWED_TOOLS` and
`VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS` unset — which is what a baseline-only observational
arm requires — the adapter's prompt and argv are byte-identical to HEAD. That is a useful
readiness fact and it is recorded, not assumed: a baseline arm run through this dirty checkout
would still be a baseline arm. It does not make the checkout an upstream artifact, and no
methodological claim here rests on it.

## 2 — what M187 repaired, and what it did not

§6 asks these to be kept apart. They are genuinely different repairs and only one of them
was landed.

| | landed? | evidence |
|---|---|---|
| **telemetry / classification** — exit status recovered from the `Exit code N` prefix, `validationExecution.ts`, the state model, the refusal taxonomy | **yes** | `c9a477de`, `stage5_m187_validation_reclassification.json` |
| **execution environment — the mechanism** — the guard wrappers no longer materialize into the directory the external harness wipes on start-up | **yes** | `agentShellGuardDir()` in the runner; `m187ShellGuardSurvival.test.ts`; probe `G1` |
| **execution environment — per-task dependency provisioning** | **no** | M187 §10.1 says so in writing; its own probes `A3`/`A4` expect `STARTED_INFRA_FAILURE` |
| **the shared `.bench-repos` venv carrying editable installs of benchmark repositories** | **no** | M187 §10.2, "not repaired here" |

M187 was re-run in this milestone, unchanged, and **reproduces exactly**: 11/11 rows agree,
`G1` still turns django-13820's historical `ModuleNotFoundError` into `Ran 27 tests … OK`, and
the `Z1` control still fails to start. The differences between the stored artifact and the
re-run are object addresses and millisecond timings; M187's committed artifact was restored
byte-identical afterwards so its evidence is untouched.

So: **the mechanism is healthy today.** That is exactly as far as M187's evidence reaches.

## 3 — the "environment era" is the shell guard, per arm

`stage5_m191_environment_eras.json`, from `run_stage5_m191_environment_eras.ts`.

M189 reported the collapse by calendar month (206/857 runner starts in June, 0/97 in July,
10/339 in August) and called it environment-era dependence. A month is not a mechanism. This
milestone re-buckets all 1,293 preserved arms on the exposure variable each arm recorded
**about itself** — `_run.meta.json` → `stage5_agent_shell_guard_enabled` — and cross-checks it
against the wipe signature in each arm's own preserved stdout.

| epoch | arms | attempted validation | reached a runner | observed a result | carries the harness-wipe signature | `pip: command not found` |
|---|---:|---:|---:|---:|---:|---:|
| guard flag absent (all 2026-06, pre-guard telemetry) | 807 | 318 (39.4%) | **204** | 167 | 20 | 5 |
| guard on, unrepaired | 486 | 92 (18.9%) | **12** | 11 | **486 / 486** | 169 |
| guard on, repaired (M187) | **0** | 0 | 0 | 0 | 0 | 0 |

Start-given-attempt: **64.1% unguarded, 13.0% guarded.** Every single one of the 486 guarded
arms carries `Cleaned N file(s) from …/raw/<condition>/` in its own stdout — the wipe M187
traced — and all 12 guarded arms that did reach a runner are wiped arms too, so the residue is
commands that never needed the testbed interpreter, not a surviving firewall.

Two things follow that the calendar framing hid.

- **The collapse is an exposure, not an era.** June contains both populations (70 wiped arms
  and 787 unwiped), and the split tracks the flag rather than the date. The guard cut the
  attempt rate roughly in half and the start-given-attempt rate by a factor of five: agents
  under it both tried less and succeeded far less when they tried.
- **The repaired path has never been run live. Zero arms.** M187 proved its repair by probe
  and by unit test, and that proof reproduces, but no live agent has ever executed under it.
  Any claim about how agents behave in a repaired environment is currently unwitnessed.

## 4 — Stage A: the readiness probes

Design and gate preregistered in `stage5_m191_readiness_prereg.md`, committed at `43d56a44`
**before the first probe ran**. Full evidence: `stage5_m191_readiness_report.md` and
`stage5_m191_readiness_probes.json`, from `run_stage5_m191_readiness.ts`.

The probe pair is the benchmark's own ground truth rather than tests chosen here. For each
repository, its first instance by id (blind to any outcome) is exported read-only with
`git archive`, its own `test_patch` is applied, and two tests are run through the agent's own
path — `bash -c` under the production `materializeAgentShellGuard` environment:

- a **`PASS_TO_PASS`** test, which SWE-bench guarantees passes at the base commit;
- a **`FAIL_TO_PASS`** test, which SWE-bench guarantees fails there.

The F-probe is therefore a *naturally* failing test, with no source altered to manufacture it,
and a repository is credited only when one environment produces both. That pair is what makes
"tests failed" provably distinguishable from "the runner never started".

**3 of 12 repositories are validation-ready.**

| verdict | repositories |
|---|---|
| `REPO_VALIDATION_READY` | django, seaborn, xarray |
| `REPO_RUNNER_ONLY` | matplotlib, flask, requests, pylint, pytest, scikit-learn, sympy |
| `REPO_NOT_RUNNABLE` | astropy, sphinx |

The nine failures are legible, and none of them is the mechanism:

```text
matplotlib     ImportError: cannot import name '_c_internal_utils'   (C extensions unbuilt)
scikit-learn   No module named 'sklearn.__check_build._check_build'  (C extensions unbuilt)
flask          No module named 'flask'
pylint         No module named 'astroid'
sympy          cannot import name 'Mapping' from 'collections'       (3.12 vs an old pin)
requests       collection ImportError in the test module
astropy        setuptools_scm cannot resolve a version               (runner never starts)
sphinx         sphinx.testing import failure                         (runner never starts)
```

### The worse-than-refusal case

`pytest-dev/pytest` returned `STARTED_PASSED` on a test SWE-bench guarantees *fails* at the
base commit. The cause is not the runner. A source-provenance diagnostic — added after that
observation, recorded as post-hoc, and deliberately outside the gate — resolves the imported
module for every repository:

```text
_pytest resolves to  …/vexp_swebench/lib/python3.12/site-packages/_pytest/__init__.py   (pytest 9.0.3)
```

The tests ran against the *installed* pytest, not the repository's `src/_pytest`. Matplotlib
does the same. An agent editing that source and running `python -m pytest` would receive a
truthful, well-classified, entirely irrelevant answer. This is M187 §10.2's unrepaired
editable-install hazard, observed directly.

It could not move the verdict — under the rule committed before any probe ran, a repository
whose F-probe passes is `REPO_RUNNER_ONLY` either way — which is precisely the condition under
which adding a post-hoc measurement is safe. All three ready repositories resolve to their
checked-out source.

### The gate

| id | requirement | observed | result |
|---|---|---|---|
| R1 | >= 3 repositories reach `STARTED_PASSED` on the P-probe | 4 | pass |
| R2 | >= 3 repositories reach `STARTED_FAILED` on the F-probe | 3 | pass |
| R3 | >= 1 repository proves both on the same instance | 3 | pass |
| R4 | the `Z1` control does NOT start a runner | did not start | pass |
| R5 | no probe required a privileged bypass | 0 | pass |
| **R6** | **>= 4 repositories are `REPO_VALIDATION_READY`** | **3** | **FAIL** |

**`VALIDATION_ENVIRONMENT_NOT_READY`.** R1–R5 — the mechanism — pass, and reproduce across
three independent executions of the script with identical verdicts. R6 — breadth — fails by
one repository. §9 names "baseline environments are materially inconsistent" as a NOT_READY
condition, and 3 usable repositories of 12 is materially inconsistent for an acquisition
design whose own text asks for at least four.

## 5 — Stage B: the live-spend authorization gate

`stage5_m191_spend_authorization.json`, from `run_stage5_m191_authorization.ts`. It reads
**committed** content only (`git show HEAD:`), never the working tree, so a document drafted
in this session cannot authorize this session's spending.

No file named `stage5_m189_eer` is tracked. Its committed equivalent was located by content
signature, not by guessing a filename: **`stage5_m189_evidence_acquisition.md`**, §"Gap B — the
validation → repair loop".

Across **2,028 committed documents**, all six elements §10 requires are absent:

| element | present? | what exists instead |
|---|---|---|
| task fixture | **no** | selection *criteria* (">= 4 repositories", "favouring tasks whose reference patch spans more than one file") — no enumerated instance set |
| model | **no** | — |
| turn limit | **no** | — |
| per-run cost limit | **no** | — |
| **total spend cap** | **no** | 98 candidate dollar-ceiling lines, **0** scoped to this acquisition |
| stopping rule | **no** | a size *estimate*, "roughly 60–80 arms with an observed validation result" |

The repository does contain committed dollar caps — `$0.40` for a generated-parser repair,
`$0.75` for the live critic. Neither authorizes an observational corpus, and reading one as if
it did is exactly the inference §10 forbids. They are recorded in the artifact as
`unscopedDollarCapsFound` so the negative is auditable.

### The design's own precondition also fails

Independently of the missing cap, the committed Gap-B design conditions itself:

> "M189's recommendation is to close **Gap A first**, because it is free, and to treat Gap B as
> contingent on Gap A finding that the I5 mechanism repeats. If I5 does not repeat across a
> third and fourth repository, the agent-utility direction has no live hypothesis worth paying
> for."

M190 ran Gap A. `I5_OUT_OF_SAMPLE_NOT_REPLICATED`. The one committed design that describes
this acquisition states the condition under which it should not be bought, and that condition
is met. Stage B is blocked three times over: no environment, no authorization, and a design
whose own precondition resolved against it.

**`LIVE_SPEND_NOT_AUTHORIZED`.** Per §10 and §31 this is not a milestone failure; it is the
gate working.

## 6 — corpus verdict

```text
I6_OBSERVATIONAL_CORPUS_NOT_ACQUIRED
```

§25's `NOT_ACQUIRED` branch, on both of its stated grounds: environment readiness failed and
spend authorization was absent. No lifecycle counts are reported from new data because no new
data was acquired; the historical lifecycle counts in §3 above are re-derivations of preserved
artifacts and are labelled as such.

## 7 — what this licenses

```text
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_I6_MECHANISM_AUDIT_LICENSED
```

M185's `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED` stands. M191 authorizes no validation
planner, no test recommender, no post-edit hook and no current-diff product API. It does not
license an offline I6 mechanism audit, because the corpus that would justify one does not
exist.

## 8 — verification

| gate | result |
|---|---|
| `bun run typecheck` | pass |
| `bun run typecheck:benchmarks` | pass |
| `bun test` | see the ledger row |
| `git diff --check` | clean |
| `run_stage5_m187_probes.ts` (reproduction) | 11/11 agree, control fires, artifact restored byte-identical |
| `run_stage5_m191_readiness.ts` | `VALIDATION_ENVIRONMENT_NOT_READY`, identical across 3 executions |
| `run_stage5_m191_authorization.ts` | `LIVE_SPEND_NOT_AUTHORIZED`, 6/6 elements absent |
| `run_stage5_m191_environment_eras.ts` | 1,293 arms bucketed; 486/486 guarded arms carry the wipe |
| live agents | **0** |
| live spend | **$0** |

## 9 — remaining observational limitations

These are evidence limitations, not product proposals.

1. **Nine of twelve repositories cannot run their own benchmark tests.** The testbed is one
   Python 3.12 environment; the failures are unbuilt C extensions, uninstalled packages and
   version pins. SWE-bench's Docker images are where per-task provisioning belongs, and that
   is infrastructure work, not I6 research.
2. **Two repositories validate against the wrong source.** `pytest` and `matplotlib` import an
   installed copy from the shared venv rather than the checked-out tree. A validation
   environment that answers confidently about code the agent did not edit is more dangerous to
   an observational study than one that refuses, because nothing in the transcript marks it.
3. **The repaired execution path has zero live arms.** Every conclusion about agent validation
   behaviour in this repository — including M185's, M189's and M190's — was drawn from arms
   that ran either before the guard or under the unrepaired guard.
4. **The three ready repositories are one instance each.** `REPO_VALIDATION_READY` is evidence
   that a repository's environment *can* work, not that all its instances do.
5. **Whether an agent would validate more in a working environment is unmeasured**, and §26
   forbids assuming it. The guarded arms both attempted less and started less, so the attempt
   drop is at least partly environmental — but 318 of 807 unguarded arms attempting validation
   is not a high natural rate either, and that is the number a future acquisition would have
   to beat.

---

I5 remains closed after M190. No VTRACE product behaviour was changed. No VTRACE treatment arm
was run. M191 does not authorize implementation of validation intelligence.
