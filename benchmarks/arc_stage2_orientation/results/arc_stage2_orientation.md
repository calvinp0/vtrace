# ARC Stage 2 Orientation Report

## Headline summary

Stage 2 tested whether compact vtrace context preserved enough orientation to match grep-snippet targets. vtrace achieved orientation parity or better on 11/12 checked tasks, with mean quality-preserving reduction of 97.89% on parity-preserving tasks.

## Scope and non-goals

This benchmark measures orientation only: whether each context package points to the expected ARC file or symbol target.

It does not measure patch correctness, pass@1, SWE-bench performance, full agent cost, whether a model can complete an edit unaided, or total token usage over an entire coding session.

## Orientation parity summary

- Total tasks: 12
- Checked tasks: 12
- Parity count: 11
- Parity rate: 91.67%
- vtrace better count: 11
- vtrace worse count: 1

## Quality-preserving token reduction summary

- Mean quality-preserving reduction: 97.89%
- Median quality-preserving reduction: 98.47%
- Reduction is reported only when vtrace orientation parity is true.

## Baseline vs vtrace quality

| Label | Baseline | vtrace |
| --- | ---: | ---: |
| strong | 1 | 11 |
| acceptable | 2 | 1 |
| weak | 9 | 0 |
| missing | 0 | 0 |

## Per-task table

| id | category | baseline | vtrace | parity | baseline tokens | vtrace tokens | preserving reduction | baseline top | vtrace top |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| exact_arc_species | exact | weak | strong | yes | 43812 | 220 | 99.50 | arc/checks/nmd_test.py | arc/species/species.py |
| exact_scheduler | exact | weak | strong | yes | 5491 | 235 | 95.72 | arc/__init__.py | arc/scheduler.py |
| exact_determine_family | exact | acceptable | strong | yes | 43214 | 301 | 99.30 | arc/family/family_test.py | arc/reaction/reaction.py |
| workflow_ts_guesses | workflow | weak | strong | yes | 16141 | 247 | 98.47 | arc/common_test.py | arc/species/species.py |
| workflow_conformer_filtering | workflow | weak | strong | yes | 5055 | 295 | 94.16 | arc/common.py | arc/species/conformers.py |
| workflow_arkane_input | workflow | weak | strong | yes | 10591 | 238 | 97.75 | arc/checks/ts_test.py | arc/statmech/arkane.py |
| workflow_kinetics_jobs | workflow | weak | strong | yes | 21369 | 201 | 99.06 | arc/checks/ts_test.py | arc/scheduler.py |
| concept_reaction_family_matching | concept | weak | strong | yes | 39740 | 291 | 99.27 | arc/__init__.py | arc/family/family.py |
| concept_kinetics_calculation | concept | acceptable | strong | yes | 13481 | 294 | 97.82 | arc/statmech/arkane_test.py | arc/checks/ts.py |
| boundary_cython | boundary | weak | strong | yes | 10522 | 117 | 98.89 | arc/constants.py | arc/molecule/atomtype.pxd |
| boundary_python_wrapper_cython | boundary | weak | strong | yes | 4127 | 130 | 96.85 | ARC.py | arc/molecule/atomtype.pxd |
| known_weak_rotor_scans | diagnostic | strong | acceptable | no | 43643 | 203 |  | arc/job/pipe/pipe_planner.py | arc/main.py |

## Weak/regression cases

| id | baseline | vtrace | parity | top vtrace target | comment |
| --- | --- | --- | --- | --- | --- |
| known_weak_rotor_scans | strong | acceptable | no | arc/main.py | Known weak/broad case; keep as diagnostic. |

## Contamination status

- Rows with contaminated vtrace paths: 0
- Contaminated vtrace path count: 0
- Benchmark acceptable for orientation claim: yes
- Repeatability status: not checked in this first implementation; repeated runs should be diffed after excluding timestamp/output-directory metadata.

## Interpretation

This benchmark supports only an orientation claim when vtrace reaches parity with the grep-snippet baseline. It does not prove task-solving improvement, SWE-bench performance, or total agent cost reduction.

Token reduction should be interpreted as quality-preserving only for rows where vtrace_orientation_parity is true.

## Suggested next step

Run a repeatability check for Stage 2, then use a small Stage 3 smoke benchmark to test whether compact vtrace context helps an agent identify or edit the correct ARC code region with fewer tool calls/tokens.

## Metadata

- Repo: /home/calvin/code/ARC
- Tool command: handoff
- Baseline: grep snippets
