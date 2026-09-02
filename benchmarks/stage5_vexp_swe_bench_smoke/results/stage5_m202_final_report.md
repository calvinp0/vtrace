# Stage 5 — M202: frozen A1 language-family breadth

`A1_PARITY_CLOSED`

## What A1 asks

`30 programming languages supported out of the box` — VEXP lists 30 names under one README heading (four of them slash-joined pairs counted once); VTRACE counts `Language` enum members with a parser in `createDefaultParserRegistry`. **>= 30 parser-backed families**, EXCEED at > 30.

Measured: 30 parser-backed families (bash, c, clojure, cpp, csharp, css, cython, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, objective_c, ocaml, php, python, r, ruby, rust, scala, sql, swift, typescript, yaml, zig); 28 extension-detected; 31 enum members

Verdict: **MATCHES** (pre-change count 3, post 30). Under VEXP's own row convention VTRACE covers 27/30 names (blocked: F#, HCL/Terraform, Dockerfile); families registered outside VEXP's list: cython.

## Families

| family | tier | counted | symbols | members | imports | calls | refs | documents | incremental | exported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | DEEP_GRAPH | yes | yes | yes | yes | partial | partial | no | yes | yes |
| Python | DEEP_GRAPH | yes | yes | yes | yes | yes | yes | no | yes | yes |
| Cython | DEEP_GRAPH | yes | yes | yes | yes | partial | partial | no | yes | yes |
| JavaScript | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | partial |
| Go | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | partial |
| Rust | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | partial |
| Java | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | partial |
| C# | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | partial |
| C | STRUCTURAL | yes | yes | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| C++ | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Ruby | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Kotlin | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Scala | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Swift | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Dart | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Elixir | STRUCTURAL | yes | yes | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Haskell | STRUCTURAL | yes | yes | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| OCaml | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Lua | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| R | STRUCTURAL | yes | yes | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| PHP | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | partial |
| Zig | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | partial |
| Objective-C | STRUCTURAL | yes | yes | yes | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Bash/Shell | STRUCTURAL | yes | yes | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| SQL | STRUCTURAL | yes | yes | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| Clojure | STRUCTURAL | yes | yes | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| HTML | PARSED_NO_STRUCTURE | yes | no | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| CSS | PARSED_NO_STRUCTURE | yes | no | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| JSON | PARSED_NO_STRUCTURE | yes | no | no | no | no | no | no | partial (full rebuild, closure_uncertain) | no (false) |
| YAML | DOCUMENT | yes | no | no | no | no | no | yes | partial (full rebuild, closure_uncertain) | no (false) |
| TOML | DOCUMENT | no | no | no | no | no | no | yes | yes (document path) | no (false) |

Health: `M202_FAMILY_HEALTH_PASS` (27 healthy, unhealthy 0); controls F1–F12 all pass. Mixed corpus: `M202_MIXED_CORPUS_PASS`, 31/31 families, 25 grammar objects invoked, exclusions leaked 0, cold determinism identical; incremental modes: noop=noop, modify=full_rebuild, add=full_rebuild, delete=full_rebuild, rename=full_rebuild.

## Dependencies

28 grammar packages pinned exactly (25 prebuilt, 3 compiled at install), 815.7 MiB unpacked, all ABI-compatible with tree-sitter 0.21.1 (ABI 13–14); licences {"MIT":26,"Apache-2.0":1,"CC0-1.0":1}.

## Performance

Registry creation 1.2 ms with 0 grammars loaded (lazy); first parse per family median 5.2 ms, max 8.48 ms; RSS 66.6 → 142 MiB with every grammar loaded; mixed corpus 1183.6 files/s.

| corpus | M201 cold files/s | M202 cold files/s |
| --- | ---: | ---: |
| C-SMALL | 235.02 | 242.11 |
| C-MED | 65.02 | 62.5 |
| C-LARGE | 33.14 | 33.39 |

## Frozen query outputs (§53)

15/15 queries semantically equal, 15 byte-equal, against the M201 immutable snapshot (`M201_OUTPUT_EQUIVALENT`).
- C-SMALL: {"id":"C-SMALL","corpusIdentical":true,"compared":5,"semanticEqual":5,"byteEqual":5,"tokenEqual":5,"selectionEqual":5,"boundednessEqual":5,"p90Before":44.34,"p90After":45.46,"medianBefore":37.79,"medianAfter":39.67}
- C-MED: {"id":"C-MED","corpusIdentical":true,"compared":5,"semanticEqual":5,"byteEqual":5,"tokenEqual":5,"selectionEqual":5,"boundednessEqual":5,"p90Before":194,"p90After":207.58,"medianBefore":152.61,"medianAfter":157.86}
- C-LARGE: {"id":"C-LARGE","corpusIdentical":true,"compared":5,"semanticEqual":5,"byteEqual":5,"tokenEqual":5,"selectionEqual":5,"boundednessEqual":5,"p90Before":336.05,"p90After":349.78,"medianBefore":317.21,"medianAfter":330.34}

## Retrieval no-change proof

expanded: pass=false, changed cases 2; cross_repo_30: pass=false, changed cases 3.

## Protected claims

| ID | M201 | M202 | measurement (M202) |
| --- | --- | --- | --- |
| A2 | EXCEEDS | EXCEEDS | C-MED 62.5 files/s, C-LARGE 33.39 files/s (median of 3 cold builds) |
| A3 | MATCHES | MATCHES | C-LARGE k=1 ratio 0.058, k=3 ratio 0.135; reparsed 372 of the 372 files the indexer holds for a ONE-file change (the eli |
| A4 | EXCEEDS | EXCEEDS | no-op median 0.006 / 0.075 / 0.160 s (C-SMALL / C-MED / C-LARGE), 0 files reparsed |
| A5 | MATCHES | MATCHES | get_code_context warm p90 53.48 / 207.01 / 350.56 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 34.21 / 1 |
| A6 | EXCEEDS | EXCEEDS | get_impact_graph depth 3 warm p90 155.93 ms on C-LARGE (10 exact-FQN targets x 5) |
| A7 | EXCEEDS | EXCEEDS | search_logic_flow warm p90 16.76 ms on C-LARGE; path edge counts {"1":10} |
| A8 | EXCEEDS | EXCEEDS | C-SMALL 100%, C-MED 100%, C-LARGE 100%; unexplained missing 0/0/0 |
| A9 | MATCHES | MATCHES | median rendered reduction C-MED 92.76%, C-LARGE 87.21% over 445 + 250 structurally valid files; 22 C-MED files excluded  |
| A10 | MATCHES | MATCHES | signature retention C-MED 99.48%, C-LARGE 100% (verbatim, token-aligned, bracket-closed slices of source); member retent |

## Frozen matrix

| ID | M201 | M202 | |
| --- | --- | --- | --- |
| A1 | BELOW | MATCHES | moved: M202 product change (27 families registered) |
| A2 | EXCEEDS | EXCEEDS |  |
| A3 | MATCHES | MATCHES |  |
| A4 | EXCEEDS | EXCEEDS |  |
| A5 | MATCHES | MATCHES |  |
| A6 | EXCEEDS | EXCEEDS |  |
| A7 | EXCEEDS | EXCEEDS |  |
| A8 | EXCEEDS | EXCEEDS |  |
| A9 | MATCHES | MATCHES |  |
| A10 | MATCHES | MATCHES |  |
| A11 | BELOW | BELOW |  |
| A12 | BELOW | BELOW |  |
| A13 | BELOW | BELOW |  |
| A14 | BELOW | BELOW |  |
| A15 | BELOW | BELOW |  |

M201 9/15 → M202 10/15; target 15/15. Regressions: none. Still BELOW: A11, A12, A13, A14, A15.
Frozen aggregate: `VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET` (match-or-exceed 10, A8 minimum 100%, structural violations 0).

## Boundary

`ENGINE QUALITY != CODING-AGENT UTILITY`
`NO_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_AUTHORIZED`
`NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED`
`NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED`
`I5_REMAINS_CLOSED`
`I6_VALIDATION_SELECTION_REMAINS_CLOSED`

live-agent runs: 0; live model spend: $0.
