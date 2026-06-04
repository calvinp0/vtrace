# ARC Python/Cython parity — results and classification

Target: ARC (`/home/calvin/code/ARC`, commit `3600cbe0`). Machine-readable
report: `results/arc_python_cython_parity.{json,md}`. Regenerate with
`bun run benchmarks/arc_python_cython_parity/run_arc_python_cython_parity.ts`.

## Headline

- 212 files indexed (196 Python, 16 Cython), 5152 symbols, 10413 edges,
  **0 parse / read / persistence failures**.
- All four edge types are produced for both languages.
- Exact, dotted, Cython-structural, and concept/workflow retrieval surface the
  correct production symbol at rank 1 (test files demoted below production).
- RC1 readiness: **ready with known limitations**.

## What works on real Cython code

- **Exact symbol lookup** — `Graph`, `VF2`, `kekulize`, `is_isomorphic`,
  `get_all_edges`, `AromaticRing` all rank the Cython definition at #1–2.
- **Cython class / method / function lookup** — classes (`Graph`, `VF2`,
  `AromaticRing`), methods (`is_isomorphic`, `get_all_edges`), and functions
  (`kekulize`) resolve to `graph.pyx` / `vf2.pyx` / `kekulize.pyx`.
- **Cython call-flow traversal** — `VF2.find_isomorphism -> VF2.isomorphism`
  and `-> VF2.match` are reachable with `callFlowEvidenceUsed = true`.
- **Impact-graph dependents** — Cython (`Graph.get_all_edges`: 14 dependents,
  `Graph.is_isomorphic`: 7) and Python (`ARCSpecies`: 418, `ARC`: 20).
- **Concept / workflow retrieval** — `where is the ESS output parsed` ->
  `arc/parser/adapter.py`, `how are transition state jobs validated` ->
  `check_valid_transition`, `reaction family matching` -> `family.py`.
- **Capsule usefulness** — source-backed pivots present for graph-rich queries
  (`kekulize`, `get_all_edges`, `cython`, `cimport`).
- **Staleness** — a controlled modification on a temporary copy leaves the
  source repo unmutated and marks the prior capsule `stale`.

## Classified findings (task taxonomy)

### Parser / frontend gap — FIXED

`cdef <Type> <name> = <expr>()` typed module variables were mis-kinded as
functions because `parse_def_header` grabbed the parenthesis from the
initializer call. On ARC this produced one phantom `VF2` "function" in
`graph.pyx`. Fixed in `src/parsers/cythonParser.ts`: a top-level `=` before the
first parenthesis now marks the statement as a variable declaration, not a
function. Symbol count dropped 5153 -> 5152 (the phantom removed); covered by a
new parser test.

### Accepted limitation — Python wrapper -> Cython kernel call edges

`molecule.py` does `from arc.molecule.kekulize import kekulize` and calls
`kekulize(self)`, but no `python -> cython` call edge is produced, so the
wrapper-to-kernel logic-flow probe is **unreachable** (recorded as
`limitation.logic_flow_probe_unreachable`). Root cause: the Python import
resolver re-parses imported modules with the CPython `ast`, which raises
`SyntaxError` on Cython source, leaving the cross-language export index empty.
Producing these edges requires sharing the Cython parser's extracted symbols
with the Python resolver — a cross-parser change that is out of scope for this
conservative parity milestone. Documented, not fixed.

### Test expectation wrong / outdated — `run_arc`, `species_to_dict`

Both are flagged `retrieval.exact_query_expected_surface_missing`. ARC contains
**no symbol literally named** `run_arc` or `species_to_dict`; the entrypoint is
`ARC` / `ARC.execute` / `main`, and species serialization is `as_dict` /
`from_dict`. The semantically-correct symbol surfaces at **rank 1** in both
cases, so retrieval is behaving correctly — the query strings simply predate
the current ARC API. No general-purpose retrieval change applies (synonym
mapping would be ARC-specific, which the milestone forbids).

### Retrieval / reranking gap — none actionable

No general-purpose retrieval or reranking gap was found. Boundary, exact,
dotted, and concept queries already rank the right production symbol first.
Per the milestone rules, no ARC-specific boosts were added.

### Capsule-shaping gap — none

Capsules built for every query with candidates; source-backed pivots appear
wherever graph evidence exists.
