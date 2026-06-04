# ARC Python/Cython parity — results and classification

Target: ARC (`/home/calvin/code/ARC`, commit `3600cbe0`). Machine-readable
report: `results/arc_python_cython_parity.{json,md}`. Regenerate with
`bun run benchmarks/arc_python_cython_parity/run_arc_python_cython_parity.ts`.

## Headline

- 212 files indexed (196 Python, 16 Cython), 5152 symbols, 11023 edges,
  **0 parse / read / persistence failures**.
- All four edge types are produced for both languages.
- **Python -> Cython resolution works**: 130 calls, 6 imports, and 83 references
  cross from Python into indexed Cython symbols. The wrapper-to-kernel limitation
  stays closed.
- **Package/relative/alias/re-export hardening added 391 exact edges** vs. the
  prior run (10632 -> 11023): Python imports 299 -> 336, calls 5305 -> 5594,
  references 1535 -> 1600. These come mainly from `arc/molecule/__init__.py`
  re-exports and package imports (`from arc.molecule import Molecule`, ...) now
  resolving exactly. Impact coverage grew accordingly: `ARCSpecies` dependents
  418 -> 647 (32 -> 60 files), `ARC` 20 -> 22.
- The Python -> Cython count is unchanged because ARC's re-exported `molecule`
  modules (`atomtype`, `element`, `group`, `molecule`) ship `.py` implementations
  that correctly win the `.py > .pyx > .pxd` precedence; the re-exports resolve to
  those Python implementations, not the `.pxd` declarations. This is the intended
  deterministic behavior.
- Exact, dotted, Cython-structural, and concept/workflow retrieval surface the
  correct production symbol at rank 1 (test files demoted below production).
- RC1 readiness: **ready with known limitations** (the only remaining gaps are
  two outdated query strings; see below).

## What works on real Cython code

- **Exact symbol lookup** — `Graph`, `VF2`, `kekulize`, `is_isomorphic`,
  `get_all_edges`, `AromaticRing` all rank the Cython definition at #1–2.
- **Cython class / method / function lookup** — classes (`Graph`, `VF2`,
  `AromaticRing`), methods (`is_isomorphic`, `get_all_edges`), and functions
  (`kekulize`) resolve to `graph.pyx` / `vf2.pyx` / `kekulize.pyx`.
- **Cython call-flow traversal** — `VF2.find_isomorphism -> VF2.isomorphism`
  and `-> VF2.match` are reachable with `callFlowEvidenceUsed = true`.
- **Cross-language call-flow traversal** — `Molecule.kekulize` (Python) ->
  `kekulize` (Cython kernel) is now reachable via a Python -> Cython call edge.
- **Impact-graph dependents** — Cython kernels now surface their Python callers:
  `kekulize` 0 -> 14 dependents (4 files), `Graph.get_all_edges` 14 -> 70,
  `Graph.is_isomorphic` 7 -> 54; Python (`ARCSpecies`: 418, `ARC`: 20).
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

### Previously-accepted limitation — Python wrapper -> Cython kernel — CLOSED

`molecule.py` does `from arc.molecule.kekulize import kekulize` and calls
`kekulize(self)`. Previously no `python -> cython` call edge was produced
because the Python import resolver re-parsed imported modules with the CPython
`ast`, which raises `SyntaxError` on Cython source.

Closed by a cross-parser symbol lookup (`src/parsers/cythonExports.ts`): when
Python imports a `.pyx` / `.pxd` / `.pxi` module, the Python resolver now reuses
the Cython parser's already-indexed symbols (the source of truth) instead of the
CPython `ast`. The Python module index includes Cython files (with `.py` > `.pyx`
> `.pxd` > `.pxi` precedence), and `getPythonExportIndex` builds the export index
from Cython symbols whose ids match the indexed Cython symbols exactly.

Result on ARC: 130 Python -> Cython call edges, 83 references, 6 imports; the
`Molecule.kekulize -> kekulize` logic-flow probe is reachable; the
`limitation.logic_flow_probe_unreachable` finding is no longer raised.
Resolution stays conservative — ambiguous targets, missing modules, dynamic
dispatch, and Cython inheritance are skipped rather than guessed.

### Narrowed remaining limitation — deep dotted package paths

`import pkg.sub.mod; pkg.sub.mod.kernel()` (3+ segment attribute chains) is still
skipped, identically to the pre-existing Python -> Python behavior. The
conservative supported cases are `from mod import name`, `import mod` +
`mod.name`, and exact class constructor / static-method calls.

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
