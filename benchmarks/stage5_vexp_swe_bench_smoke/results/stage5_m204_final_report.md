# M204 — budget-utilization authority and frozen A11

`A11_PARITY_NOT_CLOSED` — frozen A11 BELOW; parity 11/15 -> 11/15 (VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET); gates 20/20.

## What A11 asks

`run_pipeline takes a whole-output token budget, default 10000` (V-C5, vexp-cli/mcp/mcp-server.cjs). Metric: median over the 20 C-MED A13 tasks of 100 x ceil(chars/4 of the whole default get_code_context output) / max_tokens, per budget. MATCH: >= 60% utilisation at every budget; EXCEED: >= 80%. Cost measured: the whole model-facing output object as the handler returns it: focus, related, boundary, notes, schema version and every per-item tokens field — wrapper and accounting overhead count.

| | 1000 | 2000 | 4000 | 8000 | 16000 | verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| M203 committed engine | 40.55% | 34.05% | 17.02% | 9.34% | 7.54% | BELOW |
| pre-change reproduction (predecessor worktree) | 40.55% | 34.05% | 17.02% | 9.34% | 7.54% | BELOW |
| post-change reproduction | 40.55% | 34.05% | 17.02% | 9.34% | 7.54% | BELOW |
| M204 frozen engine rerun | 40.55% | 34.05% | 17.02% | 9.34% | 7.54% | BELOW |

## Budget stack

    caller max_tokens (chars/4)
    -> capsule retrieval budget: max_tokens x 4 characters -> allocateBudget tier caps (micro/standard/full)
    -> evidence budget: applyProgressiveContextBudget bounds modelVisibleContext to max_tokens (chars/4)
    -> complete-response ceiling: responseTokenCeiling(max_tokens) on the serialized authoritative response
    -> orientation projection: ceiling = orientationCeilingTokens(requested_context_tokens); focus head bound 1800 chars; related = relationship-only
    -> delivered packet (+ per-item tokens fields above the ceiling)

| layer | file | units | default | bound | caller-derived | fixed |
| --- | --- | --- | --- | --- | --- | --- |
| caller max_tokens | `src/mcp/tools.ts` | tokens (caller's own; product reads as chars/4) | 8000 | soft: validated as a non-negative integer; no upper bound on this path | true | false |
| capsule retrieval budget | `src/mcp/tools.ts -> src/productContext/assembleProductContext.ts -> src/capsuleV2/authoritativeProductRetrieval.ts` | characters (x4) then tokens (/4) | 32000 | soft | true | false |
| capsule sizing tier | `src/capsuleV2/budgetAllocator.ts` | item counts per tier | micro < 1500 < standard < 12000 <= full | HARD item-count caps per tier (product policy: precision/coverage lever) | true | true |
| evidence budget (progressive context) | `src/productContext/budgetDelivery.ts` | tokens = ceil(chars/4) of modelVisibleContext | 8000 | HARD on the rendered context: compaction ladder then delivery failure | true | false |
| complete-response ceiling | `src/mcp/responseEnvelope.ts` | tokens = ceil(chars/4) of the serialized authoritative response | 9200 | HARD on the serialized authoritative response; the evidence budget may be lowered up to 3x to fit it | true | false |
| pivot-neighbourhood supply | `src/runPipeline/pivotNeighborhood.ts` | item counts | 2 pivots x 4 excerpts | HARD count cap, fixed | false | true |
| orientation evidence ceiling | `src/runPipeline/orientationProjection.ts` | packet tokens = chars x 0.3174, nearest | 2000 | soft default (2000, M172's R2000 rung) when no budget reached the projector; the caller's budget in the packet's unit otherwise; governs `related` only, never the focus or notes | true | false |
| focus head bound | `src/runPipeline/orientationProjection.ts` | characters, cut on a line boundary | 1800 | HARD, fixed | false | true |
| wrapper | `src/runPipeline/orientationProjection.ts` | packet tokens | measured per packet (ledger.wrapper) | inside the evidence packet the ceiling tests | false | false |
| accounting overhead | `src/runPipeline/orientationAccounting.ts` | packet tokens | measured per packet (ledger.accountingOverhead) | rides ABOVE the ceiling by a stated amount (M203) | false | false |
| tool schema | `src/mcp/tools.ts` | tokens, per session not per call | measured by the frozen engine (toolSchemaTokens) | not part of any response | false | true |

## Before / after, by budget (C-MED medians; frozen rule)

| budget | tier (caps) | ceiling before | ceiling after | consumed before | consumed after | unused before | unused after | util before | util after | items | eligible | rejected before/after | upstream visible | upstream remaining | discarded (cap) | withheld body chars | binding after |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: | --- |
| 1000 | micro (1/1) | 2000 | 1270 | 405.5 | 405.5 | 594.5 | 594.5 | 40.55% | 40.55% | 3 | 3 | 0/0 | 663 | null | 35 (33) | 365 | {"OTHER":18,"UPSTREAM_BUDGET_EXHAUSTED":1,"NO_ELIGIBLE_EVIDENCE":1} |
| 2000 | standard (2/4) | 2000 | 2539 | 681 | 681 | 1319 | 1319 | 34.05% | 34.05% | 9 | 9 | 0/0 | 1399.5 | null | 31 (29) | 1413 | {"OTHER":17,"UPSTREAM_BUDGET_EXHAUSTED":2,"NO_ELIGIBLE_EVIDENCE":1} |
| 4000 | standard (2/4) | 2000 | 5078 | 681 | 681 | 3319 | 3319 | 17.02% | 17.02% | 9 | 9 | 0/0 | 1399.5 | 2600.5 | 31.5 (29) | 1413 | {"OTHER":19,"NO_ELIGIBLE_EVIDENCE":1} |
| 8000 | standard (2/4) | 2000 | 10157 | 747 | 747 | 7253 | 7253 | 9.34% | 9.34% | 10.5 | 10.5 | 0/0 | 1399.5 | 6600.5 | 31.5 (29) | 1842.5 | {"OTHER":20} |
| 16000 | full (5/10) | 2000 | 20314 | 1206 | 1206 | 14794 | 14794 | 7.54% | 7.54% | 18 | 18 | 0/0 | 3040 | 12960 | 23 (20) | 4375.5 | {"OTHER":20} |
| 1575 (non-frozen) | standard (2/4) | 2000 | 2000 | 681 | 681 | 894 | 894 | 43.24% | 43.24% | 9 | 9 | 0/0 | 1291.5 | null | 31 (29) | 1403.5 | {"OTHER":12,"UPSTREAM_BUDGET_EXHAUSTED":5,"PROGRESSIVE_BUDGET_DROP":2,"NO_ELIGIBLE_EVIDENCE":1} |
| 3000 (non-frozen) | standard (2/4) | 2000 | 3809 | 681 | 681 | 2319 | 2319 | 22.7% | 22.7% | 9 | 9 | 0/0 | 1399.5 | 1632.5 | 31.5 (29) | 1413 | {"OTHER":19,"NO_ELIGIBLE_EVIDENCE":1} |
| 6000 (non-frozen) | standard (2/4) | 2000 | 7618 | 681 | 681 | 5319 | 5319 | 11.35% | 11.35% | 9 | 9 | 0/0 | 1399.5 | 4600.5 | 31.5 (29) | 1413 | {"OTHER":20} |
| 12000 (non-frozen) | full (5/10) | 2000 | 15235 | 1185.5 | 1185.5 | 10814.5 | 10814.5 | 9.88% | 9.88% | 17.5 | 17.5 | 0/0 | 3040 | 8960 | 23 (20) | 4375.5 | {"OTHER":20} |

Binding reasons over the 100 frozen responses: before {"OTHER":94,"UPSTREAM_BUDGET_EXHAUSTED":3,"NO_ELIGIBLE_EVIDENCE":3}, after {"OTHER":94,"UPSTREAM_BUDGET_EXHAUSTED":3,"NO_ELIGIBLE_EVIDENCE":3}.

## Output equivalence

| budget | responses | same effective ceiling | byte-identical | requirement met |
| ---: | ---: | ---: | ---: | --- |
| 1000 | 20 | 0 | 20 | true |
| 2000 | 20 | 0 | 19 | true |
| 4000 | 20 | 0 | 19 | true |
| 8000 | 20 | 0 | 19 | true |
| 16000 | 20 | 0 | 19 | true |
| 1575 | 20 | 20 | 20 | true |
| 3000 | 20 | 0 | 19 | true |
| 6000 | 20 | 0 | 19 | true |
| 12000 | 20 | 0 | 19 | true |

Packets that differ pre/post on the moving corpus: 7. Focus changes: 0. Frozen fifteen-query equivalence: {"verdict":"M203_EVIDENCE_EQUIVALENT","compared":15,"selectionEqual":15,"orderEqual":15,"strippedByteEqual":15,"deliveredByteEqual":0}.

Repaired product on the pre-change corpus copy: 180 of 180 byte-identical to the predecessor; differing []; all differences were ceiling-bound under the predecessor: true.

## Tail (ten worst pre-change responses)

| task | budget | util before | util after | binding before | binding after | supply discarded upstream | withheld body chars |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| where are import edges extracted from typescript | 16000 | 6.22% | 6.22% | OTHER | OTHER | 24 | 7160 |
| where is the MCP tool registry assembled | 16000 | 6.31% | 6.31% | OTHER | OTHER | 17 | 4328 |
| how is a symbol's fully qualified name constructed | 16000 | 6.67% | 6.67% | OTHER | OTHER | 24 | 4117 |
| where is the MCP tool registry assembled | 8000 | 6.7% | 6.7% | OTHER | OTHER | 26 | 1448 |
| where does the product context decide which files are pivots | 16000 | 6.76% | 6.76% | OTHER | OTHER | 28 | 3578 |
| where are import edges extracted from typescript | 8000 | 6.78% | 6.78% | OTHER | OTHER | 33 | 2448 |
| how does hybrid scoring combine lexical and graph signals | 16000 | 6.96% | 6.96% | OTHER | OTHER | 22 | 3808 |
| how does the response envelope shed content under budget pressure | 16000 | 7.14% | 7.03% | OTHER | OTHER | 22 | 12006 |
| what deduplicates supporting files in the capsule | 16000 | 7.15% | 7.15% | OTHER | OTHER | 23 | 23004 |
| where are call sites persisted for an edge | 16000 | 7.18% | 7.18% | OTHER | OTHER | 21 | 2939 |

## A13, observed

M203 committed: 3 size violations, 5 focus swaps (BELOW). Pre reproduction: 3 / 5. Post reproduction: 3 / 5. Frozen rerun: 3 / 5 (BELOW). Order relations across adjacent frozen budgets: {"subsequence":17,"prefix":42,"neither":21}. Effective-budget monotonicity violations: 0. A13 was measured, not optimized.

## Falsification

| id | pass | statement |
| --- | --- | --- |
| F1 | pass | a high budget with abundant eligible evidence underutilises under the fixed ceiling and admits more under the caller's |
| F2 | pass | a high budget with exhausted truthful supply keeps its unused budget and admits no filler |
| F3 | pass | re-admitting an already delivered item to raise utilisation fails; the product deduplicates a second proposal |
| F4 | pass | a candidate below the eligibility line is dropped by the projector and rejected by the analyzer if forced |
| F5 | pass | a budget above every bound respects the focus head bound and the supply; the ceiling never exceeds the caller's number |
| F6 | pass | an expanded packet reconciles exactly and every item is A14-accounted; a wrong cost is caught |
| F7 | pass | the same budget gives the same packet and the same ledger across repeats |
| F8 | pass | a non-frozen budget follows the same rule: no special case, monotone admission, prefix order |
| F9 | pass | the historical fixed cap fails the frozen utilisation gate by construction above 1575 tokens, and in measurement |
| F10 | pass | every item admitted by the larger budget maps to a real supply item: identity, file, span, claim and source id |
| F11 | pass | the frozen A5 harness after the repair stays at or above MATCHES (p90 <= 500 ms on every corpus) |
| F12 | pass | a focus swap between budgets stays an A13 violation while both packets pass the utilisation analyzer |

## Accounting integrity

Pre: 0 failures over 180 packets. Post: 0 failures over 180 packets. Determinism: 3 repeats, packets stable true, ledgers stable true. Frozen A14: 1002/1002 (MATCHES).

## Performance

A5 p90 before {"C-SMALL":42.49,"C-MED":200.9,"C-LARGE":340.06} (MATCHES); after {"C-SMALL":46.37,"C-MED":205.9,"C-LARGE":357.16} (MATCHES). Largest packet 6420 bytes, 21 items; peak RSS 784 MB.

| budget | p90 before | p90 after |
| ---: | ---: | ---: |
| 1000 | 322.09 | 257.56 |
| 2000 | 320.16 | 265.61 |
| 4000 | 326.34 | 260.9 |
| 8000 | 311.84 | 260.98 |
| 16000 | 338.58 | 260.51 |
| 1575 | 335.65 | 264.47 |
| 3000 | 322.93 | 257.83 |
| 6000 | 315.16 | 262.78 |
| 12000 | 361.74 | 283.64 |

## Protected claims

| id | M203 | M204 | held |
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

| id | M203 | M204 | measurement |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | 30 parser-backed families (bash, c, clojure, cpp, csharp, css, cython, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, |
| A2 | EXCEEDS | EXCEEDS | C-MED 63.18 files/s, C-LARGE 32.65 files/s (median of 3 cold builds) |
| A3 | MATCHES | MATCHES | C-LARGE k=1 ratio 0.052, k=3 ratio 0.134; reparsed 372 of the 372 files the indexer holds for a ONE-file change (the eligible .py denominato |
| A4 | EXCEEDS | EXCEEDS | no-op median 0.006 / 0.099 / 0.176 s (C-SMALL / C-MED / C-LARGE), 0 files reparsed |
| A5 | MATCHES | MATCHES | get_code_context warm p90 45.14 / 211.06 / 342.79 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 34.1 / 153.64 / 298.55 ms |
| A6 | EXCEEDS | EXCEEDS | get_impact_graph depth 3 warm p90 158.6 ms on C-LARGE (10 exact-FQN targets x 5) |
| A7 | EXCEEDS | EXCEEDS | search_logic_flow warm p90 17.07 ms on C-LARGE; path edge counts {"1":10} |
| A8 | EXCEEDS | EXCEEDS | C-SMALL 100%, C-MED 100%, C-LARGE 100%; unexplained missing 0/0/0 |
| A9 | MATCHES | MATCHES | median rendered reduction C-MED 92.67%, C-LARGE 87.21% over 447 + 250 structurally valid files; 22 C-MED files excluded as malformed (F4) |
| A10 | MATCHES | MATCHES | signature retention C-MED 99.48%, C-LARGE 100% (verbatim, token-aligned, bracket-closed slices of source); member retention C-MED 100%, C-LA |
| A11 | BELOW | BELOW | C-MED whole-response utilisation by budget: 1000=40.55%, 2000=34.05%, 4000=17.02%, 8000=9.34%, 16000=7.54% over 20 tasks |
| A12 | BELOW | BELOW | C-MED default response carries 2 distinct representation classes (FOCUS:focused_source, RELATIONSHIP_ONLY); C-LARGE carries 3 |
| A13 | BELOW | BELOW | 3 of 20 tasks lose focus content as the budget grows, and 5 swap the delivered focus symbol, over 5 budgets |
| A14 | MATCHES | MATCHES | 1002 of 1002 delivered items carry token accounting; no accounting block appears in the default response at all (present at detail=debug onl |
| A15 | BELOW | BELOW | C-LARGE, 50 eligible call edges: the impact surface renders 0% as source expressions, the logic-flow surface 100%. On C-MED the flow surface |

M203 11/15, M204 11/15, target 15/15.

Frozen control F6: FAIL; without the stale conjunct it passes (a14PerItem 1002). the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so the failure is the stale control and not an A14 regression; not modified.

## Gates

| gate | pass | statement |
| --- | --- | --- |
| G1 | pass | frozen A11 definition recovered unchanged |
| G2 | pass | A11 BELOW reproduced pre-change, equal to the committed M203 medians |
| G3 | pass | budget stack traced from code |
| G4 | pass | every underutilised response carries a binding reason |
| G5 | pass | no-supply separated from policy-cap underutilisation |
| G6 | pass | one budget authority: the ledger ceiling equals the product rule on every response |
| G6b | pass | same corpus, same effective outcome: every pre/post difference on the pre-change corpus was ceiling-bound under the predecessor |
| G7 | pass | fixed-ceiling defect repaired: caller budget reaches admission (F1, F8) |
| G8 | pass | no filler (F2, F3, F4; analyzer gates on every response) |
| G9 | pass | hard bounds preserved (F5) |
| G10 | pass | M203 accounting preserved on every packet (F6; integrity 0 failures) |
| G11 | pass | determinism across repeats (F7; sweep repeats) |
| G12 | pass | A5 protected |
| G13 | pass | A1-A10 protected |
| G14 | pass | A14 protected |
| G15 | pass | A13 measured, untouched (F12) |
| G16 | pass | frozen A11 verdict from the unmodified scorer |
| G17 | pass | full A1-A15 rerun by the unmodified analyzer |
| G18 | pass | standard verification (recorded by the ledger row; not computed here) |
| G19 | pass | zero model spend: offline instruments only |

## Authority

`M197A_AUTHORITY_VERIFIED`; C-MED 502 files (expected 502); identity advanced: false.

## Boundary

- ENGINE QUALITY != CODING-AGENT UTILITY
- NO_A13_MONOTONICITY_REPAIR_AUTHORIZED
- NO_NEW_REPRESENTATION_CLASS_AUTHORIZED
- NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED
- NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
- NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
- I5_REMAINS_CLOSED
- I6_VALIDATION_SELECTION_REMAINS_CLOSED
