# Stage 5 — M203: frozen A14 per-item context accounting

`A14_PARITY_CLOSED`

## What A14 asks

`per-symbol token_reduction_pct is reported for each skeleton` (V-C3, vexp-cli/mcp/mcp-server.cjs). Unit: focus slot + each related entry of the DEFAULT get_code_context response (1 + related.length per response). Predicate: tokens | tokenReductionPercent | rawTokens | savedTokens !== undefined on the item. Scorer: verdict = itemsWithPerItemAccounting > 0 ? MATCHES : BELOW; EXCEEDS is not reachable. MATCH: present per item and internally consistent; EXCEED: plus an accumulated ledger. Measured on C-MED, 20 A13 tasks x 5 budgets = 100 responses, DEFAULT response only (F6).

| | numerator | denominator | verdict |
| --- | ---: | ---: | --- |
| M202 committed engine | 0 | 1002 | BELOW |
| pre-change reproduction (bf270108206c worktree) | 0 | 1002 | BELOW |
| post-change reproduction | 1002 | 1002 | MATCHES |
| M203 frozen engine rerun | 1002 | 1002 | MATCHES |

Frozen control F6 (`a debug-only field must not satisfy a default-output claim`): FAIL — the committed control conjoins `a14PerItem === 0`, which encodes the M197A observation; it cannot pass once A14 is MATCHES, and was not modified.

## Authority

Pre-refreeze replay: `M197A_AUTHORITY_MISMATCH`, failed on corpus_C-MED only (502 files, expected 500). Post-refreeze: `M197A_AUTHORITY_VERIFIED` at 502. Unchanged: claim wording, thresholds, scorers, corpus root and extensions, query corpus, tokenizer, budgets. Changed: C-MED self-referential identity count 500 -> 502 (two files under src/runPipeline).

## Delivery pipeline

| stage | file | symbols |
| --- | --- | --- |
| candidate creation | `src/capsuleV2/buildCapsuleV2.ts` | `buildCapsuleV2` |
| candidate scoring / ranking | `src/capsuleV2/pivotRankingV2.ts` | `scorePivot`, `comparePivotScoreDesc` |
| capsule budget allocation (tiers, chars/4) | `src/capsuleV2/budgetAllocator.ts` | `allocateBudget` |
| objective attribution (selection reasons, roles) | `src/productContext/assembleProductContext.ts` | `assembleProductContext`, `selectionReasons` |
| deduplication of authoritative items | `src/productContext/assembleProductContext.ts` | `deduplicateDrafts` |
| estimated cost of an item (chars/4, renderItem text) | `src/productContext/assembleProductContext.ts` | `estimateTokens(renderItem(draft))` |
| evidence budget: representation downgrade / drop, supply publication | `src/productContext/budgetDelivery.ts` | `applyProgressiveContextBudget`, `publishSemanticItemSupply`, `materialize`, `compactReasons` |
| authoritative supply (object-keyed, zero bytes) | `src/productContext/semanticItemSupply.ts` | `publishSemanticItemSupply`, `semanticItemSupplyOf`, `estimatedTokens` |
| complete-response envelope (metadata compaction, neighbourhood text stripping) | `src/mcp/responseEnvelope.ts` | `compactProductResponse`, `textCharacters` |
| projection: focus/related selection, admission prefix, ceiling test | `src/runPipeline/orientationProjection.ts` | `projectRunPipelineOrientation`, `headBound`, `ORIENTATION_POLICY`, `orientationTokens` |
| delivery: tokens attached, ledger built and published | `src/runPipeline/orientationProjection.ts` | `withItemTokens`, `ledgerFor`, `publishOrientationAccounting` |
| accounting contract and token rule | `src/runPipeline/orientationAccounting.ts` | `OrientationAccounting`, `OrientationItemAccounting`, `ORIENTATION_TOKENS_PER_CHARACTER`, `orientationAccountingOf` |
| tool boundary: default detail returns the packet | `src/mcp/tools.ts` | `projectRunPipelineOrientation(authoritativeResult)`, `tokens: integerProperty` |

## Contract

Model-facing: `tokens` on every focus and related item of the orientation packet — the item's own serialized cost, packet token rule (chars x 0.3174, nearest), including the field (fixed point). Machine-facing: `orientationAccountingOf(packet)`, WeakMap on the packet object (M180 pattern), zero serialized bytes. Absence: "unavailable" (not observable by the projector) | "not_applicable" (does not apply to the item class); 0 is always a measurement. Ceiling: tested on the evidence packet (items without tokens) exactly as before; the accounting fields ride above it by the reported accountingOverhead; admission unchanged.

Cost authority — estimated: item serialized WITHOUT tokens, as the ceiling test saw it; actual: item serialized WITH tokens (== model-facing field); rule: characters x 0.3174032272551657, rounded to nearest (M166 calibration; the ceiling's own rule); upstream: chars/4 estimates from the evidence budget carried verbatim under their own label, never converted; wrapper: packet characters - sum(item characters): schemaVersion, boundary, notes, keys, punctuation; reconciliation: characters exact; tokens within ceil((items+2)/2) of rounding.

## Representation-class coverage (C-MED, frozen A12 labels)

| representation | eligible | accounted | coverage |
| --- | ---: | ---: | ---: |
| FOCUS:focused_source | 100 | 100 | 100.0% |
| RELATIONSHIP_ONLY | 902 | 902 | 100.0% |
| C-SMALL (not scored) | 33 | 23 | 69.7% — classes FOCUS:focused_source 5/5, RELATIONSHIP_ONLY 18/18 |
| C-LARGE (not scored) | 152 | 152 | 100% — classes FOCUS:focused_source 14/14, RELATIONSHIP_ONLY 137/137, FOCUS:signature 1/1 |

## Budget reconciliation (C-MED, medians per frozen budget)

| max_tokens | responses | eligible | accounted | Σ item tokens | wrapper | packet | accounting overhead | ceiling | unused ceiling | upstream visible (chars/4) | upstream remaining | chars exact | tokens in bound | ceiling-bound |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| 1000 | 20 | 74 | 74 | 438 | 76 | 513.5 | 12 | 2000 | 1499.5 | 663 | null | true | true | 0 |
| 2000 | 20 | 176 | 176 | 786 | 78 | 864 | 34 | 2000 | 1168.5 | 1399.5 | null | true | true | 0 |
| 4000 | 20 | 176 | 176 | 786 | 78 | 864 | 34 | 2000 | 1168.5 | 1399.5 | 2600.5 | true | true | 0 |
| 8000 | 20 | 213 | 213 | 868 | 78.5 | 948 | 40.5 | 2000 | 1092 | 1399.5 | 6600.5 | true | true | 0 |
| 16000 | 20 | 363 | 363 | 1449.5 | 81 | 1530.5 | 68.5 | 2000 | 539.5 | 3040 | 12960 | true | true | 0 |

Overall: {"allCharactersExact":true,"allTokensWithinBound":true,"allEvidenceWithinCeiling":true,"ceilingBoundResponses":0,"overheadTokens":{"median":35,"max":81},"packetTokens":{"median":916.5,"max":2038},"unusedCeilingTokens":{"median":1133.5,"min":43},"deduplicatedProposals":259}; ledger rows 1177 (C-MED 1002).

Budget-growth pair (`where are import edges extracted from typescript`): 3 items / 731 packet tokens at 1000 (upstream visible 660, complete, stages []) vs 16 / 1264 at 16000 (upstream visible 3295, complete); admitted only at the high budget: 13, only at the low: 0.

## Attribution

Reason sources {"selection_reason":951,"roles":0,"neighbor_relation":51}; origins {"item_supply":951,"pivot_neighborhood":51}; items proposed by more than one route 171; deduplicated proposals 259.

## Falsification

- F1: PASS — one eligible delivered item without accounting fails coverage
- F2: PASS — a reported cost that is not the serializer's cost fails integrity
- F3: PASS — one delivered item with two accounting records fails; two routes to one item yield one record
- F4: PASS — a random or clock-derived identity fails; identical states hash identically
- F5: PASS — an admission reason the packet does not make, or a route that did not admit, fails attribution
- F6: PASS — a full-object cost, or a denied truncation, for a head-bounded item fails
- F7: PASS — a result with no delivered items publishes no fabricated accounting item
- F8: PASS — unused budget is visible and nothing was added to consume it
- F9: PASS — a ceiling-exhausted packet reconciles exactly and records the rejection
- F10: PASS — machine-facing accounting did not alter the model-facing evidence
- F11: PASS — an artificially expensive accounting path fails the frozen A5 gate
- F12: PASS — the denominator is derived from delivered responses; a detached count satisfies nothing
- F6-rule: PASS — the frozen default-output rule is satisfied by a field the default response carries

`M203_FALSIFICATION_CONTROLS_PASS`

## Output equivalence

M203 instrument on the M201 snapshot: `M203_EVIDENCE_EQUIVALENT` — 15 queries, selection 15, order 15, item count 15, bytes with tokens removed 15, delivered bytes 0 (15 differ by the tokens field alone). Frozen M201 instrument: `M201_OUTPUT_DIFFERS`, semantic 0/15, byte 0/15 — the frozen instrument hashes the delivered packet, which now carries tokens; its inequality is the A14 field and nothing else, as the stripped comparison shows. On the 100 C-MED A14 results the predecessor projector's packet equals the current packet with tokens removed on 100/100.

## Determinism

A14 reproduction: 100 responses x 3 repeats, packets stable true, ledgers stable true. Frozen engine replay: true.

## Runtime and storage

Projector median 0.06 -> 0.1 ms (accounting construction +0.0409 ms median, +0.09 ms p90) over 2000 samples per side; validation median 0.04 ms. Ledger serialized median 4954.5 B (max 13288); heap delta per packet as measured 0 B (ledgers live in a WeakMap keyed on the packet; they are collected with it, and nothing accumulates across calls). Storage: 0 tables, 0 schema changes — derived at compile time, result-local; nothing is written to index.sqlite or session.sqlite. Whole-call A14 median 194.58 -> 190.45 ms (C-MED, load-sensitive, not a frozen figure).

Frozen A5: before (m202_post) {"C-SMALL":45.46,"C-MED":207.58,"C-LARGE":349.78} MATCHES at load 7.39; after (m203_post) {"C-SMALL":42.49,"C-MED":200.9,"C-LARGE":340.06} MATCHES at load 2.1. Frozen engine p90: C-SMALL 53.48 -> 46.49, C-MED 207.01 -> 208.71, C-LARGE 350.56 -> 334.76.

## Protected claims

| ID | M202 | M203 | measurement (M203) |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | 30 parser-backed families (bash, c, clojure, cpp, csharp, css, cython, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, objective_c, ocaml, |
| A2 | EXCEEDS | EXCEEDS | C-MED 64.06 files/s, C-LARGE 33.8 files/s (median of 3 cold builds) |
| A3 | MATCHES | MATCHES | C-LARGE k=1 ratio 0.054, k=3 ratio 0.136; reparsed 372 of the 372 files the indexer holds for a ONE-file change (the eligible .py denominator is 276; the indexe |
| A4 | EXCEEDS | EXCEEDS | no-op median 0.006 / 0.083 / 0.154 s (C-SMALL / C-MED / C-LARGE), 0 files reparsed |
| A5 | MATCHES | MATCHES | get_code_context warm p90 46.49 / 208.71 / 334.76 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 32.34 / 147.7 / 291.51 ms |
| A6 | EXCEEDS | EXCEEDS | get_impact_graph depth 3 warm p90 149.76 ms on C-LARGE (10 exact-FQN targets x 5) |
| A7 | EXCEEDS | EXCEEDS | search_logic_flow warm p90 15.84 ms on C-LARGE; path edge counts {"1":10} |
| A8 | EXCEEDS | EXCEEDS | C-SMALL 100%, C-MED 100%, C-LARGE 100%; unexplained missing 0/0/0 |
| A9 | MATCHES | MATCHES | median rendered reduction C-MED 92.67%, C-LARGE 87.21% over 447 + 250 structurally valid files; 22 C-MED files excluded as malformed (F4) |
| A10 | MATCHES | MATCHES | signature retention C-MED 99.48%, C-LARGE 100% (verbatim, token-aligned, bracket-closed slices of source); member retention C-MED 100%, C-LARGE 94.82%. Signatur |

## Full A1–A15 matrix

| ID | M202 | M203 | cause/status |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | held |
| A2 | EXCEEDS | EXCEEDS | held |
| A3 | MATCHES | MATCHES | held |
| A4 | EXCEEDS | EXCEEDS | held |
| A5 | MATCHES | MATCHES | held |
| A6 | EXCEEDS | EXCEEDS | held |
| A7 | EXCEEDS | EXCEEDS | held |
| A8 | EXCEEDS | EXCEEDS | held |
| A9 | MATCHES | MATCHES | held |
| A10 | MATCHES | MATCHES | held |
| A11 | BELOW | BELOW | held |
| A12 | BELOW | BELOW | held |
| A13 | BELOW | BELOW | held |
| A14 | BELOW | MATCHES | M203 product change (per-item tokens in the default packet) |
| A15 | BELOW | BELOW | held |

M202 10 / 15 — M203 11 / 15 — target 15 / 15. Frozen aggregate: `VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET`. Regressions: none.

A12: C-MED default response carries 2 distinct representation classes (FOCUS:focused_source, RELATIONSHIP_ONLY); C-LARGE carries 3. A15: C-LARGE, 50 eligible call edges: the impact surface renders 0% as source expressions, the logic-flow surface 100%. On C-MED the flow surface renders 100%.

