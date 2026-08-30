# M189 — minimum evidence acquisition, if either gap is ever taken up

**Nothing here is authorized and nothing here was run.** M189 spent $0 on live agents. This
document exists because §24 requires that a milestone which finds a corpus gap say precisely
what would close it, rather than gesturing at "more runs".

Two gaps are real. They are very different sizes, and only one of them needs an agent.

---

## Gap A — I5 repetition. Offline, no live spend, no new agent.

`I5_EDIT_SET_MISS` has witnessed specimens in **2 tasks across 2 repositories** against §21's
bar of three and three. The obvious next evidence is not new runs — it is the derivation
applied to arms this repository already holds and M189 did not reach.

```text
I5-usable arms M189 analysed                            866   (69 instances)
I5-usable arms M189 did NOT analyse                     314   (71 further tasks, 9 repositories)
reason not analysed                                     no indexed base tree was built for the instance
```

M189 indexed 70 instances because that was the union of its two starting strata. The 71
remaining instances are the same kind of evidence and cost the same kind of work:

```bash
git -C <bench-repo> archive <base_commit> | tar -x -C <scratch>/<instance_id>
bun src/cli/index.ts index <scratch>/<instance_id> --quiet --json
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m189_mechanism.ts
```

Roughly 2 further hours of background indexing on this machine, ~10 GB of scratch outside the
repository, and no agent. It is the cheapest evidence available to Phase 2B and it directly
decides whether the mechanism repeats or belongs to sphinx.

**What it cannot settle.** Precision. Those 314 arms will add specimens *and* false positives,
and the 60% false-positive rate on clean successes is a property of the derivation rather than
of the sample. Reducing it is intervention design, which is not licensed.

---

## Gap B — the validation → repair loop. Observational, needs an agent, needs the environment.

### Why the existing evidence cannot answer it

```text
arms in the corpus                                     1293
  validation attempted                                  472
  runner observed to START                              216
  pass/fail result observed                             178
  result observed AND a subsequent edit                  30   <- the whole observable population
  of those, in the frozen default path                    0
  of those, outside the 2026-06 environment era           0
```

Thirty arms is not a corpus, and all thirty are from an environment era that no longer exists.
M189's own I6 findings — 65% of failing arms and 58% of succeeding arms already ran the
reference test module — answer the *selection* question and say nothing about what an agent
does with a validation result it dislikes. That is the only I6 sub-question still open, and the
corpus genuinely cannot witness it.

### What the corpus must contain

The purpose is **observation of natural coding decisions**, so that offline analysis can then
ask what deterministic VTRACE evidence existed at each moment. It is not a VTRACE-versus-
baseline benchmark and must not be reported as one.

```text
agent            the same strong coding agent, normal unrestricted tools
treatment        NONE. no VTRACE context, no mandate, no tool denial, no hooks
environment      M187's repaired per-task dependency environment, verified by the
                 executability probes BEFORE any task is spawned
tasks            selected BEFORE any outcome is seen, from repositories that run under the
                 repaired harness, >= 4 repositories, favouring tasks whose reference patch
                 spans more than one file
strata           existing M183/M189 failures may be included ONLY as a separately labelled
                 diagnostic stratum, never as the discovery corpus (§25)
```

### What must be captured

```text
task text and base revision
every file/symbol inspection, in order
every edit, with its payload, in order
the reconstructed diff after each edit
the changed symbols at each point
every test command issued
whether the runner STARTED          <- the field M183 could not answer and M187 had to add
the test output and its verdict
every edit issued AFTER a validation result
the final patch
the official evaluator result
tokens, cost, turns
```

The one field that makes or breaks it is *runner started*. M185 keyed execution on
`exitCode === 0`, every M183 Bash call carried `exitCode: null`, and the metric silently
returned zero for everything. `validationExecution.ts` exists because of that and should be the
capture-time authority, not a post-hoc reinterpretation.

### What must NOT be forced (§26)

```text
no instruction to make multiple edits
no instruction to inspect dependents
no instruction to use VTRACE
no instruction to run particular tests
no completion gate, no verification mandate
```

The environment guarantees only that **if the agent chooses to validate, validation works**.
Any instruction beyond that converts mechanism discovery into the workflow-mandate experiment
M188 found harmful on four independent lines.

### What would make it worth running

A minimum of roughly 60–80 arms with an observed validation result, which at M183-era
validation rates means several hundred spawned arms — a real cost, for a question whose prior
is not obviously favourable. M189's recommendation is to close **Gap A first**, because it is
free, and to treat Gap B as contingent on Gap A finding that the I5 mechanism repeats. If I5
does not repeat across a third and fourth repository, the agent-utility direction has no live
hypothesis worth paying for, and the correct action is the one M185 and M188 already reached.
