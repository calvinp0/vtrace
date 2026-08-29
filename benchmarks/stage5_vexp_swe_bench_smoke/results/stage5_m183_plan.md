# M183 — Current-Product Live SWE-bench Requalification (plan)

Frozen before the first paid call. Product HEAD `9517ccce` (M182 closure).

## The question

> When the coding agent is actually asked to fix real SWE-bench issues, does
> current VTRACE make it more successful and/or cheaper?

Primary quality outcome: **SWE-bench resolved**, from the official Docker grader.
Primary economic outcomes: **whole-run tokens** and **whole-run cost**, over the
complete agent run. Gold-file and gold-symbol localization are explanatory
diagnostics computed after grading and never substituted for resolution (§147).

## Why M173 cannot answer it

M173 measured 7/12 against 7/12 with the same seven successes — but against a
~629-token orientation delivered by a MANDATE. Since then M175–M182 changed both
halves of that. M180 established that part of the old compactness was evidence
starvation from a real ownership defect; the truthful product now sits at a
median 1,229 model-facing tokens. And §7 now forbids the mandate that carried it.

## The two arms

    A  BASELINE             ordinary agent, ordinary tools, nothing else
    B  VTRACE_ORIENTATION   the same, plus one automatically delivered packet

Both arms issue a **byte-identical** command: same protocol (`baseline`), same
flags, same budgets, same guards, same dataset, same model. The entire treatment
is one environment variable naming a file that contains the bytes a real default
`run_pipeline` reply carries.

### Why arm B is not M173's arm B

M173's arm B carried `M168_MANDATE_TEXT` — "call `run_pipeline` FIRST",
"ALWAYS FIRST" — plus an MCP tool inventory arm A did not have. §7 forbids the
first in six separate clauses; §6 holds the tool environment fixed across arms.
So the mandate is gone and the MCP config is gone.

### Why arm B is not "offer the tool and see"

M164 measured **0 voluntary reuse** across twelve tasks. An uncoerced tool arm
would deliver orientation on approximately no task — which measures adoption, not
utility, and leaves §82's delivery witness unsatisfiable on most of the sample.
That is a legitimate experiment; it is not this one. Recorded, not hidden.

## Where the treatment comes from

For each instance: a clone at the manifest base commit (HEAD **checked**, not
assumed), indexed at the current product HEAD, then one real default MCP
`run_pipeline` call — `initialize` then `tools/call` over Content-Length stdio —
and `structuredContent.result.output` taken as the packet. `saveObservation:
false`, no `detail`, no `max_tokens`: the shipped default IS the treatment.

The orientation workspace is **separate from both live arms**. Neither live arm
creates a Stage 5 workspace or carries a `.vtrace` directory, so §11's isolation
holds by construction. An earlier design indexed the treatment arm's own worktree
and deleted `.vtrace` before spawning; it was abandoned because `git status`
inside a treatment run would have listed it, and "we removed the evidence in
time" is not an isolation argument.

The query is `deriveStructuredTaskFromProblemStatement` over the problem
statement alone. The generator never opens `patch`, `test_patch`, `FAIL_TO_PASS`
or `PASS_TO_PASS` (§61).

## Sample

30 pairs: the 12 M173 tasks verbatim (replication) plus 18 drawn from Broad100-A
minus those 12, stratified by repository and then by difficulty tier, seed
`M183-extension/v1`. Strata are interleaved in execution order so a mid-sweep
provider drift cannot land entirely on one stratum. Frozen and hashed before any
live run; §14 forbids changing it afterwards.

## Spend

Expected $38.31; hard cap $80.00, which is also the maximum possible. The guard
starts a pair only when headroom covers $6 — the harness's enforced $3/instance
ceiling, doubled. It extrapolates nothing, so it cannot repeat M173's stop-after-
one-dear-pair (§25). Evaluated at TASK entry so the cap can never censor a pair.

## Workstreams

    A  protocol freeze and live-readiness qualification
    B  sample/spend design and treatment validation
    C  paired live execution
    D  official grading and primary paired outcomes
    E  token/cost/mechanism attribution
    F  competitive closure and next-work decision

STOP after F.
