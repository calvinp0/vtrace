# M205 — representation-class expansion and frozen A12

`A12_PARITY_CLOSED` — frozen A12 MATCHES (3 classes: FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY); parity 11/15 -> 12/15 (VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET); gates 22/22; falsification M205_FALSIFICATION_CONTROLS_PASS.

## What A12 asks

`pivots are delivered as full content, supporting files as skeletons` (V-C6, vexp-core binary). Representation: FOCUS:<form> when focus.code; RELATED_WITH_CODE when related.code is a string; RELATIONSHIP_ONLY otherwise; distinct over C-MED responses at the frozen budgets; MATCHES >= 3, EXCEEDS >= 5 (engine + report, verbatim). MATCH: >= 3 distinct classes; EXCEED: 5. VEXP classes observed that count: 3.

| | classes | count | verdict |
| --- | --- | ---: | --- |
| M204 committed engine | FOCUS:focused_source, RELATIONSHIP_ONLY | 2 | BELOW |
| pre-change reproduction (predecessor worktree) | FOCUS:focused_source, RELATIONSHIP_ONLY | 2 | BELOW |
| post-change reproduction | FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY | 3 | MATCHES |
| M205 frozen engine rerun | FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY | 3 | MATCHES |

## VEXP representation inventory

| class | evidence | counts toward A12 |
| --- | --- | --- |
| pivot_full_content | OBSERVED | true |
| pivot_skeleton | OBSERVED | true |
| supporting_skeleton | OBSERVED | true |
| supporting_dropped | OBSERVED | false |
| get_skeleton_file_structure | OBSERVED | false |

## VTRACE representation classes (projection)

Pre: focus: FOCUS:<form>; related: RELATIONSHIP_ONLY.

Post: focus: FOCUS:<form>; related: RELATIONSHIP_ONLY; related: upstream form delivered (focused_source / skeleton / signature / excerpt / document_excerpt).

Root cause: related entries carried no code: the projector delivered every admitted related entry as a relationship claim only, although the authoritative rendering it reads already carried a body for most of them (co-pivot focused source, index skeleton, parser signature); under the frozen rule only the focus form and RELATIONSHIP_ONLY were therefore present on C-MED.

## Health matrix (C-MED, post)

| class | counted by A12 | delivered (frozen budgets) | fixture | source-backed | bounded | accounted | deterministic | fallback tested | status |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| focused_source | RELATED_WITH_CODE (when delivered) | 277 (139) | frozen corpus | true | true | true | true | true | HEALTHY |
| full_source | RELATED_WITH_CODE (when delivered) | 0 (0) | none | null | null | null | true | false | IN_TABLE_NOT_EXERCISED_ON_FROZEN_CORPUS |
| excerpt | RELATED_WITH_CODE (when delivered) | 1 (0) | frozen corpus | true | true | true | true | false | HEALTHY |
| skeleton | RELATED_WITH_CODE (when delivered) | 816 (421) | frozen corpus | true | true | true | true | false | HEALTHY |
| signature | RELATED_WITH_CODE (when delivered) | 69 (35) | frozen corpus | true | true | true | true | false | HEALTHY |
| document_excerpt | RELATED_WITH_CODE (when delivered) | 0 (0) | none | null | null | null | true | false | IN_TABLE_NOT_EXERCISED_ON_FROZEN_CORPUS |
| relationship_only | RELATIONSHIP_ONLY | 540 (307) | frozen corpus | not_applicable | not_applicable | true | true | true | HEALTHY |

Source truth on C-MED: {"focused_source":{"ANCHORED_IN_SPAN":457},"signature":{"PARSER_SIGNATURE":69},"skeleton":{"SKELETON_MATCHES_INDEX":802,"SKELETON_HEAD_OF_INDEX":14},"excerpt":{"ANCHORED_IN_SPAN":1}}. Class distinction: [{"pair":"skeleton|signature","comparable":1075,"distinct":308,"coincident":767,"distinctOnSomeItem":true},{"pair":"focused_source|skeleton","comparable":1075,"distinct":1064,"coincident":11,"distinctOnSomeItem":true},{"pair":"focused_source|signature","comparable":1075,"distinct":1064,"coincident":11,"distinctOnSomeItem":true}].

## Routing by budget (C-MED medians)

| budget | ceiling | related | with code | available | reasons (totals) | classes | evidence tokens | util |
| ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 1000 | 1270 | 2 | 1 | 1 | {"upstream_form_delivered":20,"form_not_code_bearing":34} | {"signature":1,"relationship_only":34,"skeleton":19} | 577 | 46.55% |
| 1500 | 1904 | 8 | 5 | 5 | {"upstream_form_delivered":92,"no_rendered_body":1,"form_not_code_bearing":56} | {"focused_source":19,"skeleton":64,"relationship_only":57,"signature":8,"excerpt":1} | 1225.5 | 65.94% |
| 2000 | 2539 | 8 | 5 | 5 | {"upstream_form_delivered":99,"no_rendered_body":1,"form_not_code_bearing":56} | {"focused_source":20,"skeleton":71,"relationship_only":57,"signature":8} | 1252.5 | 50.77% |
| 3000 | 3809 | 8 | 5 | 5 | {"upstream_form_delivered":99,"no_rendered_body":1,"form_not_code_bearing":56} | {"focused_source":20,"skeleton":71,"relationship_only":57,"signature":8} | 1252.5 | 33.85% |
| 4000 | 5078 | 8 | 5 | 5 | {"upstream_form_delivered":99,"no_rendered_body":1,"form_not_code_bearing":56} | {"focused_source":20,"skeleton":71,"relationship_only":57,"signature":8} | 1252.5 | 25.38% |
| 6000 | 7618 | 8 | 5 | 5 | {"upstream_form_delivered":99,"no_rendered_body":1,"form_not_code_bearing":56} | {"focused_source":20,"skeleton":71,"relationship_only":57,"signature":8} | 1252.5 | 16.93% |
| 8000 | 10157 | 9.5 | 5 | 5 | {"upstream_form_delivered":99,"no_rendered_body":1,"form_not_code_bearing":56,"neighbour_text_not_carried":37} | {"focused_source":20,"skeleton":71,"relationship_only":94,"signature":8} | 1293.5 | 13.17% |
| 12000 | 15235 | 16.5 | 14 | 14 | {"upstream_form_delivered":278,"no_rendered_body":1,"form_not_code_bearing":50,"neighbour_text_not_carried":11} | {"focused_source":79,"signature":10,"skeleton":189,"relationship_only":62} | 2703 | 18.28% |
| 16000 | 20314 | 17 | 14 | 14 | {"upstream_form_delivered":278,"no_rendered_body":1,"form_not_code_bearing":50,"neighbour_text_not_carried":14} | {"focused_source":79,"signature":10,"skeleton":189,"relationship_only":65} | 2726.5 | 13.81% |

## Mixed representation

Task `where are import edges extracted from typescript` at 16000: related classes focused_source, signature, skeleton, relationship_only; 16 items, tokens sum 2437, order by ordinal true, all gates true.

| ordinal | slot | at | representation | reason | code chars | tokens | truth |
| ---: | --- | --- | --- | --- | ---: | ---: | --- |
| 0 | focus | parsers/typescriptParser.ts::ExtractImportEdgesInput | focused_source | focus_slot | 159 | 135 | ANCHORED_IN_SPAN |
| 1 | related | parsers/typescriptParser.ts::extractImportEdges | focused_source | upstream_form_delivered | 562 | 267 | ANCHORED_IN_SPAN |
| 2 | related | parsers/typescriptParser.ts::extractCallAndReferenceEdges | focused_source | upstream_form_delivered | 577 | 271 | ANCHORED_IN_SPAN |
| 3 | related | parsers/cythonParser.ts::extractImportEdges | focused_source | upstream_form_delivered | 589 | 271 | ANCHORED_IN_SPAN |
| 4 | related | parsers/pythonParser.ts::extractImportEdges | focused_source | upstream_form_delivered | 599 | 274 | ANCHORED_IN_SPAN |
| 5 | related | offsetsFor | signature | upstream_form_delivered | 54 | 78 | PARSER_SIGNATURE |
| 6 | related | withCallSite | signature | upstream_form_delivered | 71 | 83 | PARSER_SIGNATURE |
| 7 | related | domain/types.ts::ImportResolutionStatus | skeleton | upstream_form_delivered | 266 | 177 | SKELETON_MATCHES_INDEX |
| 8 | related | parsers/cythonParser.ts::ExtractImportEdgesInput | skeleton | upstream_form_delivered | 33 | 105 | SKELETON_MATCHES_INDEX |
| 9 | related | parsers/pythonParser.ts::ExtractImportEdgesInput | relationship_only | no_rendered_body | 0 | 79 | NOT_APPLICABLE |
| 10 | related | parsers/typescriptParser.ts::CallReferenceResolution | skeleton | upstream_form_delivered | 33 | 113 | SKELETON_MATCHES_INDEX |
| 11 | related | parsers/typescriptParser.ts::TypeScriptParserContext | skeleton | upstream_form_delivered | 33 | 112 | SKELETON_MATCHES_INDEX |
| 12 | related | parsers/typescriptParser.ts::collectBoundNames | skeleton | upstream_form_delivered | 58 | 115 | SKELETON_MATCHES_INDEX |
| 13 | related | parsers/typescriptParser.ts::ExtractedSymbols | skeleton | upstream_form_delivered | 26 | 103 | SKELETON_MATCHES_INDEX |
| 14 | related | parsers/cythonParser.ts::extractCythonCallAndReferenceEdges | skeleton | upstream_form_delivered | 285 | 190 | SKELETON_MATCHES_INDEX |
| 15 | related | parsers/typescriptParser.ts::parseTypeScriptWithContext | relationship_only | form_not_code_bearing | 0 | 64 | NOT_APPLICABLE |

## Accounting by class (C-MED)

| slot:class | items | accounted | tokens total | tokens median | code chars median |
| --- | ---: | ---: | ---: | ---: | ---: |
| focus:focused_source | 180 | 180 | 44087 | 217 | 405 |
| related:excerpt | 1 | 1 | 202 | 202 | 378 |
| related:focused_source | 277 | 277 | 56949 | 225 | 425 |
| related:relationship_only | 540 | 540 | 33622 | 63 | 0 |
| related:signature | 69 | 69 | 6632 | 95 | 97 |
| related:skeleton | 816 | 816 | 126570 | 145 | 148.5 |

Frozen A14: 1004/1004 (MATCHES).

## Falsification

| id | pass | statement |
| --- | --- | --- |
| F1 | pass | a label without a construction is not a class: relabelling fails the source authority, counts nothing, and identical classes collapse |
| F2 | pass | an excerpt whose bytes do not exist at the claimed source fails; the real one is anchored in its span |
| F3 | pass | a signature differing from the parser's fails; the parser's passes |
| F4 | pass | a body over the bound is deterministically truncated on a line boundary and says so; a forced oversized code fails |
| F5 | pass | an item whose evidence supports no richer form falls back to relationship-only with the reason recorded; a forced form on a non-source body fails |
| F6 | pass | a rich packet reconciles exactly under M203 and every item is A14-accounted; the relationship-only cost reported for an excerpt fails |
| F7 | pass | the same items, budget and source state select the same representations across repeats |
| F8 | pass | at a tight budget the richer form is refused where it does not fit and the compact entry survives, byte-identical to the predecessor's |
| F9 | pass | at a large budget a genuine production-path related item carries its richer form, source-anchored; the class is not on paper |
| F10 | pass | one candidate delivered twice to exhibit two classes fails; the product delivers a second proposal of one identity once |
| F11 | pass | every source-backed entry maps to an authoritative supply item; a severed source id or a file outside the corpus fails |
| F12 | pass | a hard-coded class count without delivered classes fails the analyzer, and the frozen rule counts only what the packet carries |

## Determinism

3 repeats: {"C-SMALL":{"packets":true,"ledgers":true},"C-MED":{"packets":true,"ledgers":true},"C-LARGE":{"packets":true,"ledgers":true}}; F7 true.

## Equivalence

Repaired product on the pre-change corpus copy: 180 responses; focus same 180; related set same 180; compact projection byte-identical 180; whole packet byte-identical 0; differing [].

Moving corpus: {"responses":180,"focusSame":180,"relatedSetSame":180,"compactProjectionByteIdentical":180}. Frozen fifteen-query: {"verdict":"M203_EVIDENCE_NOT_EQUIVALENT","compared":15,"selectionEqual":0,"orderEqual":15,"strippedByteEqual":0,"deliveredByteEqual":0}.

## Performance

A5 p90 before {"C-SMALL":46.37,"C-MED":205.9,"C-LARGE":357.16} (MATCHES); after {"C-SMALL":43.45,"C-MED":197.52,"C-LARGE":334.87} (MATCHES); frozen A5 MATCHES. Largest packet 6420 -> 11594 bytes; largest item count 21 -> 21; peak RSS 2190 -> 633 MB. no DB table, no schema change, no new persisted metadata; the tool output schema gained three optional related-item properties (form, code, codeTruncated).

| budget | p90 before | p90 after |
| ---: | ---: | ---: |
| 1000 | 188.69 | 275.28 |
| 1500 | 205.61 | 258.34 |
| 2000 | 193.49 | 264.1 |
| 3000 | 188.31 | 259.31 |
| 4000 | 184.49 | 271.95 |
| 6000 | 182.62 | 269.5 |
| 8000 | 200.39 | 264.77 |
| 12000 | 207.21 | 278.14 |
| 16000 | 202.61 | 289.09 |

## A11, observed

| budget | proposed/admitted before | proposed/admitted after | representable related tokens before | after | delivered related tokens before | after | evidence tokens before | after | util before | util after |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 3/3 | 3/3 | 164 | 250.5 | 165 | 250.5 | 500.5 | 577 | 40.55% | 46.55% |
| 1500 (non-frozen) | 9/9 | 9/9 | 547.5 | 921 | 550 | 921 | 833.5 | 1225.5 | 45.5% | 65.94% |
| 2000 | 9/9 | 9/9 | 547.5 | 970.5 | 550 | 970.5 | 833.5 | 1252.5 | 34.13% | 50.77% |
| 3000 (non-frozen) | 9/9 | 9/9 | 547.5 | 970.5 | 550 | 970.5 | 833.5 | 1252.5 | 22.75% | 33.85% |
| 4000 | 9/9 | 9/9 | 547.5 | 970.5 | 550 | 970.5 | 833.5 | 1252.5 | 17.06% | 25.38% |
| 6000 (non-frozen) | 9/9 | 9/9 | 547.5 | 970.5 | 550 | 970.5 | 833.5 | 1252.5 | 11.38% | 16.93% |
| 8000 | 16.5/10.5 | 16.5/10.5 | 639.5 | 1068 | 642 | 1068 | 904.5 | 1293.5 | 9.3% | 13.17% |
| 12000 (non-frozen) | 25/17.5 | 25/17.5 | 1201 | 2498 | 1204 | 2498 | 1439.5 | 2703 | 9.88% | 18.28% |
| 16000 | 25/18 | 25/18 | 1201 | 2516 | 1204 | 2516 | 1460.5 | 2726.5 | 7.54% | 13.81% |

Frozen A11: M204 {"1000":40.55,"2000":34.05,"4000":17.02,"8000":9.34,"16000":7.54} (BELOW); M205 {"1000":46.55,"2000":50.2,"4000":25.1,"8000":13.17,"16000":13.74} (BELOW). A11 was measured, not optimized.

## A13, observed

M204 committed: 3 size violations, 5 focus swaps (BELOW). Pre: 3 / 5, order relations {"subsequence":17,"prefix":42,"neither":21}. Post: 3 / 5, order relations {"subsequence":17,"prefix":42,"neither":21}, representation regressions across budgets 0. Frozen rerun: 3 / 5 (BELOW). A13 was measured, not optimized.

## Protected claims

| id | M204 | M205 | held |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | true |
| A2 | EXCEEDS | EXCEEDS | true |
| A3 | MATCHES | MATCHES | true |
| A4 | EXCEEDS | EXCEEDS | true |
| A5 | MATCHES | MATCHES | true |
| A6 | EXCEEDS | EXCEEDS | true |
| A7 | EXCEEDS | EXCEEDS | true |
| A8 | EXCEEDS | EXCEEDS | true |
| A9 | MATCHES | MATCHES | true |
| A10 | MATCHES | MATCHES | true |
| A14 | MATCHES | MATCHES | true |

## Full matrix

| id | M204 | M205 | measurement |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | 30 parser-backed families (bash, c, clojure, cpp, csharp, css, cython, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, |
| A2 | EXCEEDS | EXCEEDS | C-MED 65.82 files/s, C-LARGE 34.96 files/s (median of 3 cold builds) |
| A3 | MATCHES | MATCHES | C-LARGE k=1 ratio 0.055, k=3 ratio 0.14; reparsed 372 of the 372 files the indexer holds for a ONE-file change (the eligible .py denominator |
| A4 | EXCEEDS | EXCEEDS | no-op median 0.007 / 0.081 / 0.154 s (C-SMALL / C-MED / C-LARGE), 0 files reparsed |
| A5 | MATCHES | MATCHES | get_code_context warm p90 46.14 / 201.55 / 324.21 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 34.31 / 147.47 / 284.92 ms |
| A6 | EXCEEDS | EXCEEDS | get_impact_graph depth 3 warm p90 147.24 ms on C-LARGE (10 exact-FQN targets x 5) |
| A7 | EXCEEDS | EXCEEDS | search_logic_flow warm p90 15.94 ms on C-LARGE; path edge counts {"1":10} |
| A8 | EXCEEDS | EXCEEDS | C-SMALL 100%, C-MED 100%, C-LARGE 100%; unexplained missing 0/0/0 |
| A9 | MATCHES | MATCHES | median rendered reduction C-MED 92.82%, C-LARGE 87.21% over 449 + 250 structurally valid files; 22 C-MED files excluded as malformed (F4) |
| A10 | MATCHES | MATCHES | signature retention C-MED 99.48%, C-LARGE 100% (verbatim, token-aligned, bracket-closed slices of source); member retention C-MED 100%, C-LA |
| A11 | BELOW | BELOW | C-MED whole-response utilisation by budget: 1000=46.55%, 2000=50.2%, 4000=25.1%, 8000=13.17%, 16000=13.74% over 20 tasks |
| A12 | BELOW | MATCHES | C-MED default response carries 3 distinct representation classes (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY); C-LARGE carri |
| A13 | BELOW | BELOW | 3 of 20 tasks lose focus content as the budget grows, and 5 swap the delivered focus symbol, over 5 budgets |
| A14 | MATCHES | MATCHES | 1004 of 1004 delivered items carry token accounting; no accounting block appears in the default response at all (present at detail=debug onl |
| A15 | BELOW | BELOW | C-LARGE, 50 eligible call edges: the impact surface renders 0% as source expressions, the logic-flow surface 100%. On C-MED the flow surface |

M204 11/15, M205 12/15, target 15/15.

Frozen control F6: FAIL; without the stale conjunct it passes (a14PerItem 1004). the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so the failure is the stale control and not an A14 regression; not modified.

## Gates

| gate | pass | statement |
| --- | --- | --- |
| G1 | pass | frozen A12 definition recovered unchanged |
| G2 | pass | A12 BELOW reproduced pre-change, equal to the committed M204 classes |
| G3 | pass | VEXP representation inventory classified OBSERVED/CLAIMED/UNKNOWN |
| G4 | pass | VTRACE representation inventory recovered and symbol-verified |
| G5 | pass | one unversioned representation authority (orientationRepresentation.ts; focus and related share one shape) |
| G6 | pass | new classes semantically distinct: no relabel-only class (F1); class distinction over the corpus |
| G7 | pass | source truth: every source-backed representation on C-MED anchored, parser-signature or index-skeleton (F2, F3) |
| G8 | pass | boundedness: every related code within the declared bound (F4) |
| G9 | pass | routing deterministic and general (F7; arbitrary budgets swept; 0 integrity failures on C-MED) |
| G10 | pass | progressive fallback: unavailable or oversized rich representation falls back truthfully (F4, F5, F8) |
| G11 | pass | A14 accounting: every delivered item accounted, M203 analyzer passes on every C-MED packet (F6) |
| G12 | pass | no duplicate-item inflation (F10) |
| G13 | pass | performance: A5 at least MATCHES |
| G14 | pass | A1/A2/A3 protected |
| G15 | pass | A4/A6/A7/A8/A9/A10 protected |
| G16 | pass | A11 measured only; tier caps untouched |
| G17 | pass | A13 measured only; baseline captured |
| G18 | pass | A15 untouched (impact rendering unchanged; verdict carried) |
| G19 | pass | frozen A12 verdict from the unmodified scorer |
| G20 | pass | full A1-A15 rerun by the unmodified analyzer |
| G21 | pass | standard verification (recorded by the ledger row; not computed here) |
| G22 | pass | zero model spend: offline instruments only |

## Authority

Replay at the M204 count: `M197A_AUTHORITY_MISMATCH` failing only ["corpus_C-MED"] (504 files vs 502). Post: `M197A_AUTHORITY_VERIFIED` at 504 (expected 504). C-MED is this repository's src/; M205 added src/runPipeline/orientationRepresentation.ts and its test, so the self-referential count advanced 502 -> 504; claim definitions, thresholds, scorer and corpus root unchanged.

## Boundary

- ENGINE QUALITY != CODING-AGENT UTILITY
- NO_A11_TIER_CAP_REPAIR_AUTHORIZED
- NO_A13_MONOTONICITY_REPAIR_AUTHORIZED
- NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED
- NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
- NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
- I5_REMAINS_CLOSED
- I6_VALIDATION_SELECTION_REMAINS_CLOSED
