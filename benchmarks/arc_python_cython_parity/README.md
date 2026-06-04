# ARC Python/Cython parity validation

This benchmark validates the strengthened Python/Cython graph and retrieval
behavior against a real Python/Cython-heavy repository ([ARC](https://github.com/ReactionMechanismGenerator/ARC)).

It drives the typed real-repo validation harness
(`src/validation/runRealRepoValidation.ts`) and emits a deterministic report.

## What it checks

- Exact symbol lookup (`run_arc`, `species_to_dict`, Cython classes/functions).
- Python/Cython boundary queries (`cython`, `cimport`, `fast parser`, ...).
- Cython class/method/function lookup (`Graph`, `VF2`, `is_isomorphic`, `kekulize`).
- Cython call-flow traversal and Python/Cython impact-graph dependents
  (via the impact-graph and logic-flow probes configured in the runner).
- Workflow/concept retrieval for ARC-style tasks.
- Capsule usefulness (source-backed pivots).
- Staleness behavior after a controlled file modification on a temporary copy.
- Edges by type and by language, plus cross-language edges.

The `who calls <symbol>` and `flow from <wrapper> to <kernel>` requirements are
exercised through `ARC_IMPACT_PROBE_SYMBOLS` and `ARC_LOGIC_FLOW_PROBES` in
`run_arc_python_cython_parity.ts`.

## Running

This runner needs a real ARC checkout and is **not** part of `bun test`:

```bash
bun run benchmarks/arc_python_cython_parity/run_arc_python_cython_parity.ts [repoRoot]
```

`repoRoot` defaults to `/home/calvin/code/ARC`. Output is written to
`results/arc_python_cython_parity.{json,md}`.

The pure markdown-rendering helpers are unit-tested in
`run_arc_python_cython_parity.test.ts`, which **does** run under `bun test`.

## Known limitation (documented, not a regression)

Python wrapper -> Cython kernel call edges are not produced: the Python import
resolver re-parses imported modules with the CPython `ast`, which raises
`SyntaxError` on Cython source, so the cross-language export index is empty.
The wrapper-to-kernel logic-flow probe is therefore unreachable and is recorded
as an accepted limitation in the report. See `ARC_PARITY_RESULTS.md`.
