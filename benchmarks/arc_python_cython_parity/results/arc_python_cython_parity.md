# ARC Python/Cython parity validation report

- Repo path: `/home/calvin/code/ARC`
- Source fingerprint (validation run id): `f8d985cb3eebff9ed420a89c4d3e889216b86fafdbbd0df89252b4c04d5387d4`
- Query set source: `/home/calvin/code/vtrace/benchmarks/arc_python_cython_parity/queries.md`
- RC1 readiness: **ready with known limitations**

## Index summary

- Files indexed: 212 (python 196, cython 16)
- Symbols indexed: 5152 (python 4686, cython 466)
- Edges indexed: 10413
- Parser outcomes: 0 parse failures, 0 read failures, 0 persistence failures

## Edges by type

| Edge type | Count |
| --- | --- |
| contains | 3388 |
| imports | 298 |
| calls | 5228 |
| references | 1499 |

## Edges by language

| Language | Edge type | Count |
| --- | --- | --- |
| python | contains | 3052 |
| python | imports | 293 |
| python | calls | 5175 |
| python | references | 1452 |
| cython | contains | 336 |
| cython | imports | 5 |
| cython | calls | 53 |
| cython | references | 47 |

## Cross-language edges

| Source | Destination | Edge type | Count |
| --- | --- | --- | --- |
| cython | python | calls | 3 |
| cython | python | imports | 1 |
| cython | python | references | 1 |

## Queries

| Query | Category | Candidates | Cython hits | Expected surface | First non-test rank | Top result | Source-backed pivots |
| --- | --- | --- | --- | --- | --- | --- | --- |
| run_arc | exact_symbol_api_lookup | 6 | 0 | no | 1 | ARC [class] arc/main.py | 0 |
| species_to_dict | exact_symbol_api_lookup | 6 | 0 | no | 1 | from_dict [method] arc/species/species.py | 0 |
| Graph | exact_symbol_api_lookup | 6 | 4 | yes | 1 | Graph [class] arc/molecule/graph.pxd | 0 |
| VF2 | exact_symbol_api_lookup | 6 | 2 | yes | 1 | VF2 [class] arc/molecule/vf2.pxd | 0 |
| kekulize | exact_symbol_api_lookup | 6 | 3 | yes | 1 | kekulize [method] arc/molecule/molecule.py | 1 |
| is_isomorphic | exact_symbol_api_lookup | 6 | 3 | yes | 1 | is_isomorphic [method] arc/species/species.py | 0 |
| AromaticRing | exact_symbol_api_lookup | 6 | 5 | yes | 1 | AromaticRing [class] arc/molecule/kekulize.pyx | 0 |
| get_all_edges | exact_symbol_api_lookup | 6 | 2 | yes | 1 | get_all_edges [method] arc/molecule/graph.pyx | 2 |
| cython | python_cython_boundary | 6 | 6 | n/a | 1 | Edge [class] arc/molecule/graph.pxd | 1 |
| cimport | python_cython_boundary | 6 | 6 | n/a | 1 | Vertex [class] arc/molecule/graph.pxd | 1 |
| compiled helper | python_cython_boundary | 6 | 5 | n/a | 1 | AromaticRing [class] arc/molecule/kekulize.pyx | 0 |
| python wrapper around cython | python_cython_boundary | 6 | 6 | n/a | 1 | Edge [class] arc/molecule/graph.pxd | 1 |
| numerical kernel | python_cython_boundary | 6 | 6 | n/a | 1 | AromaticRing [class] arc/molecule/kekulize.pyx | 0 |
| parser kernel | python_cython_boundary | 6 | 6 | n/a | 1 | AromaticRing [class] arc/molecule/kekulize.pyx | 0 |
| low level utility | python_cython_boundary | 6 | 2 | n/a | 1 | Edge [class] arc/molecule/graph.pyx | 0 |
| fast parser | python_cython_boundary | 6 | 6 | n/a | 1 | AromaticRing [class] arc/molecule/kekulize.pyx | 0 |
| extension module | python_cython_boundary | 6 | 6 | n/a | 1 | AromaticRing [class] arc/molecule/kekulize.pyx | 0 |
| where is the ESS output parsed | workflow_tracing | 6 | 0 | n/a | 1 | ESSAdapter [class] arc/parser/adapter.py | 0 |
| how does ARC generate TS guesses | workflow_tracing | 6 | 0 | n/a | 1 | TSGuess [class] arc/species/species.py | 0 |
| how are transition state jobs validated | workflow_tracing | 6 | 0 | n/a | 1 | check_valid_transition [function] arc/job/pipe/pipe_state.py | 0 |
| transition state generation | workflow_tracing | 6 | 0 | n/a | 1 | check_valid_transition [function] arc/job/pipe/pipe_state.py | 0 |
| conformer filtering | scientific_domain_concept | 6 | 0 | n/a | 1 | conformers_combinations_by_lowest_conformer [function] arc/species/conformers.py | 0 |
| kinetics calculation | scientific_domain_concept | 6 | 0 | n/a | 1 | check_ts [function] arc/checks/ts.py | 0 |
| reaction family matching | scientific_domain_concept | 6 | 0 | n/a | 1 | ARCReaction [class] arc/reaction/reaction.py | 0 |

## Impact-graph probes (who-calls / dependents)

| Symbol | Resolved | Language | Dependent symbols | Dependent files | Observed edges | Found dependents |
| --- | --- | --- | --- | --- | --- | --- |
| arc/main.py::ARC | yes | python | 20 | 4 | calls, contains, imports | yes |
| arc/molecule/graph.pyx::Graph.get_all_edges | yes | cython | 14 | 1 | calls, contains, references | yes |
| arc/molecule/graph.pyx::Graph.is_isomorphic | yes | cython | 7 | 1 | calls, contains, references | yes |
| arc/molecule/kekulize.pyx::kekulize | yes | cython | 0 | 0 | (none) | no |
| arc/molecule/vf2.pyx::VF2 | yes | cython | 0 | 0 | (none) | no |
| arc/species/species.py::ARCSpecies | yes | python | 418 | 32 | calls, contains, imports, references | yes |

## Logic-flow probes (wrapper-to-kernel)

| Start | End | Reachable | Paths | Call evidence available | Call evidence used |
| --- | --- | --- | --- | --- | --- |
| arc/molecule/molecule.py::Molecule.kekulize | arc/molecule/kekulize.pyx::kekulize | no | 0 | yes | no |
| arc/molecule/vf2.pyx::VF2.find_isomorphism | arc/molecule/vf2.pyx::VF2.isomorphism | yes | 1 | yes | yes |
| arc/molecule/vf2.pyx::VF2.find_isomorphism | arc/molecule/vf2.pyx::VF2.match | yes | 1 | yes | yes |

## Controlled change (staleness)

- Status: pass
- Used temporary copy: yes
- Source repo mutated: no
- File changes: +0 / -0 / ~1 (unchanged 211)
- Capsule trust status after change: stale

## Classified gaps

| Category | Severity | Finding | Query |
| --- | --- | --- | --- |
| accepted limitation | info | limitation.logic_flow_probe_unreachable |  |
| retrieval/reranking gap | warning | retrieval.exact_query_expected_surface_missing | run_arc |
| retrieval/reranking gap | warning | retrieval.exact_query_expected_surface_missing | species_to_dict |

