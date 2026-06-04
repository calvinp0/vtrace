# ARC Python/Cython parity validation queries

This file is consumed by `runRealRepoValidation` (see
`src/validation/runRealRepoValidation.ts`). Only the `## Query Set` section is
parsed; `### ` headings select the query category and `- ` bullets are queries.

## Query Set

### Exact symbol / API lookup

- run_arc
- species_to_dict
- Graph
- VF2
- kekulize
- is_isomorphic
- AromaticRing
- get_all_edges

### Python/Cython boundary queries

- cython
- cimport
- compiled helper
- python wrapper around cython
- numerical kernel
- parser kernel
- low level utility
- fast parser
- extension module

### ARC workflow tracing

- where is the ESS output parsed
- how does ARC generate TS guesses
- how are transition state jobs validated
- transition state generation

### Scientific domain concept queries

- conformer filtering
- kinetics calculation
- reaction family matching

## Structural probes

The `who calls <symbol>` and `flow from <wrapper> to <kernel>` requirements are
exercised through the impact-graph and logic-flow probes configured in
`run_arc_python_cython_parity.ts`, not as free-text queries.
