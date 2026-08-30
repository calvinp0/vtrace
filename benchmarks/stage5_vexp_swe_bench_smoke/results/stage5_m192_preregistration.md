# M192 — per-instance SWE-bench validation substrate: preregistration

Frozen before any substantive probe was executed. Nothing in this document was
written after a Docker result was inspected; the commit that introduces it
precedes the commit that introduces any probe output.

## Question

Can SWE-bench's own per-instance Docker environment serve as the authoritative
interactive edit-and-validation substrate — such that an agent can modify the
benchmark checkout and then execute tests against *exactly that modified
checkout*, with truthful telemetry?

M191 established that the shared `.bench-repos` environment cannot: 3/12
repositories were validation-ready, and at least two could execute tests against
an installed copy of the package rather than the source under edit. The second
failure is the dangerous one, because it answers.

## Selection rule (outcome-blind)

For each of the repositories represented in the Stage 5 fixture
(`swe-bench-100.jsonl`), take the **lexicographically first `instance_id`**.
Within an instance, the P-probe is the lexicographically first `PASS_TO_PASS`
id and the F-probe is the lexicographically first `FAIL_TO_PASS` id.

The rule is a total function of the fixture. It cannot see Docker state, image
availability, image size, gold topology, or any probe result. It is implemented
in `m192Substrate.ts:selectPreregisteredInstances` and executed by
`run_stage5_m192_manifest.ts`; the manifest regenerates byte-identically.

Twelve repositories are represented, so twelve instances are probed.

## Breadth gate (§23)

```
>= 8 / 12 repositories REPO_INTERACTIVE_VALIDATION_READY
and zero WRONG_SOURCE among the repositories counted ready
```

Three of twelve is what the shared environment already achieved. The point of
changing substrate is to solve cross-repository provisioning, so the gate is set
above the limitation being escaped, not at it.

## Wrong-source hard rule (§24)

A repository whose validation demonstrably executes an installed copy rather
than the edited checkout **cannot** be counted ready, even if its P-probe passes
and its F-probe fails exactly as the benchmark contract predicts. Apparent
validation success does not override provenance. `STARTED_TESTS_PASSED` and
`EDITED_CHECKOUT_CONFIRMED` are separate truths and are computed by separate
functions that cannot read each other's inputs.

## Probe matrix (V1–V12)

| ID  | Claim                        | Evidence required                                                    |
| --- | ---------------------------- | -------------------------------------------------------------------- |
| V1  | environment starts           | a shell command returns from a created container                      |
| V2  | source readable              | `/testbed` is at the instance's `base_commit`                         |
| V3  | source writable              | a controlled mutation is accepted                                     |
| V4  | mutation persists            | a *separate* command observes the mutation                            |
| V5  | test runner starts           | swebench's own `>>>>> Start Test Output` marker appears               |
| V6  | passing result observable    | the P-probe runs and passes                                           |
| V7  | failing result observable    | the F-probe runs and fails on base + the benchmark's own test patch   |
| V8  | provenance correct           | the package's `__file__` resolves under `/testbed`                    |
| V9  | mutation affects validation  | a sentinel written into the checkout fires *during the test command*  |
| V10 | source restorable            | checkout returns to clean, or the container is destroyed              |
| V11 | telemetry truthful           | start / runner-start / output / exit / timeout separately observable  |
| V12 | no privileged bypass         | every probe uses the same exec path a future agent would have         |

## Source-provenance method (§12)

Two independent witnesses, both required:

1. **Path witness.** `python -c 'import <pkg>; print(<pkg>.__file__)'` executed
   inside the container. The import name is fixed per repository in
   `M192_IMPORT_NAMES`; the *mutation target* is then derived from the observed
   path, never from the table, so the probe cannot mutate a file the runtime is
   not actually loading.
2. **Execution witness.** A deterministic sentinel is appended to that exact
   observed file. The sentinel does not print — output capture would make that
   unreliable — it writes a nonce file to `/tmp`. The benchmark's own test
   command is then run, and the nonce file is checked. If it exists, the test
   process imported the edited checkout.

`classifyProvenance` returns `EDITED_CHECKOUT_CONFIRMED` only when both agree.
A path under `/testbed` whose sentinel never fires is classified
`INSTALLED_COPY_CONFIRMED`, because something other than the edited file ran.

The sentinel does not depend on gold, does not touch benchmark tests, and is
applied only inside a disposable container.

## State construction

Every probe records which state it measured:

- **base** — the image as published, `/testbed` at `base_commit`.
- **base + test patch** — required before the F-probe, because `FAIL_TO_PASS` is
  only guaranteed to fail once the benchmark's own test patch is applied.
- **base + sentinel** — the controlled mutation for V9. Never committed, never
  applied to shared state.

Gold patches are permitted for environment verification only (§10) and must not
leak into any later agent experiment.

## Test-command fidelity (§33)

Test commands are not invented. They are taken from swebench 4.1.0's own
`make_test_spec` / `MAP_REPO_VERSION_TO_SPECS[repo][version]["test_cmd"]`, so
`django`'s `runtests.py`, `sympy`'s `bin/test` and `pytest`-based repositories
each get their prescribed runner. M192 does not fork evaluator semantics (§34);
final resolution remains owned by `swebench.harness.run_evaluation`.

## Constraints

- No coding agents. `live-agent runs: 0`, `live model spend: $0`.
- No VTRACE product change; no VTRACE treatment of any kind (§19).
- No I6 analysis (§21); no runtime-diagnosis implementation (§22).
- Cleanup removes only containers named `m192-*`. Pre-existing user containers
  and images — including swebench evaluation containers from earlier
  milestones — are not M192-owned and are not touched.

## Verdicts to be issued

Milestone: `PASS | MIXED | INCOMPLETE | FAIL`.
Substrate: `VIABLE | PARTIAL | NOT_VIABLE | NOT_EVALUABLE`.
Architecture: `PERSISTENT_AGENT_CONTAINER_PREFERRED | HOST_AGENT_CONTAINER_EXECUTION_PREFERRED | NO_ARCHITECTURE_RECOMMENDATION`.
Corpus: `OBSERVATIONAL_CORPUS_SUBSTRATE_READY | NOT_READY`.

A rigorous falsification passes. Viability is not required for M192 — PASS.
