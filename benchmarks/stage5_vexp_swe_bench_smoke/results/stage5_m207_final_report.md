# M207 — retrieval-pool authority, truthful supply expansion and frozen A11

`A11_RETRIEVAL_SUPPLY_SUFFICIENT` — `A11_PARITY_CLOSED` — `A11_RETRIEVAL_POOL_REPAIR_SUFFICIENT`; frozen A11 EXCEEDS; parity 12/15 -> 13/15 (VTRACE_VEXP_ENGINE_PARITY_THRESHOLD_MET); gates 25/25; falsification M207_FALSIFICATION_CONTROLS_PASS.

## What A11 asks

`run_pipeline takes a whole-output token budget, default 10000` (V-C5, vexp-cli/mcp/mcp-server.cjs). Metric: median over the 20 C-MED A13 tasks of 100 x ceil(chars/4 of the whole default get_code_context output) / max_tokens, per budget. Boundary: the whole model-facing output object as the handler returns it: focus, related, boundary, notes, schema version and every per-item tokens field. MATCH: >= 60% utilisation at every budget; EXCEED: >= 80%.

| | 1000 | 2000 | 4000 | 8000 | 16000 | verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| M206 committed engine | 83.55% | 95.47% | 101.23% | 55.48% | 27.84% | BELOW |
| pre-change reproduction (product width 25, this tree) | 85.05% | 95.4% | 101.65% | 55.45% | 27.88% | BELOW |
| post-change reproduction (budget-derived allowance) | 85.05% | 94.78% | 102.05% | 102.5% | 94.72% | EXCEEDS |
| post-change product pinned to 25 (control) | 86.35% | 94.95% | 101.73% | 55.45% | 27.88% | BELOW |
| M207 frozen engine rerun | 84.05% | 94.65% | 102.05% | 102.5% | 94.72% | EXCEEDS |

## Retrieval architecture and every count bound

| stage | bound | kind | applied at |
| --- | --- | --- | --- |
| final retrieval pool | 25 | retrieval-quality heuristic (fixed default) | hybridRetrieve(maxResults) → ranked.slice(0, maxResults) after scoring (admitBoundedLanesBesideCap); then every anchor/backfill merge limit; then the compound-t |
| lexical symbol search (prose query) | 100 | derived from the pool (hidden second bound) | searchSymbols(maxResults = lexicalPoolSize): rankSearchCandidates slices the merged SQL candidate rows after ranking |
| per-seed symbol search | 6 | lane window | searchSymbols(maxResults) per likely symbol / seed |
| body-literal search | 10 | lane window | searchBodyLiterals(db, expr, limit) per literal |
| likely-file path candidates | unbounded per file | no bound | every symbol of every likely edit file enters the raw map |
| failing-test → implementation | unbounded per test | no bound | every routed implementation enters the raw map |
| scoring / ranking (assemble) | no truncation | no bound | every raw candidate is scored and sorted; evaluatedById holds the whole ranking |
| bounded lanes beside the cap | concept-owner cap + operation-fact cap | lane cap (beside the pool) | lane-admitted ids missing from the capped slice are appended and re-sorted |
| graph + same-module expansion | 24 candidates, depth 1, 6 siblings per seed | lane window | expandGraphCandidates over every query-side seed |
| path-signal SQL candidates | 96 | query-size safety | SQL LIMIT on the path-signal candidate query |
| broad admission disjuncts | 96 | query-size safety | number of OR-disjuncts in the broad candidate SQL |
| broad candidate SQL | 1 | observation | 743: LIMIT ? |

Pool provenance: `CANDIDATE_POOL_SIZE = 25` at src/capsuleV2/buildCapsuleV2.ts:186, introduced f099c3b12daf2a3ff248777c969f6f78a31e87e5 2026-06-06 Build capsule v2 product output. Original comment: "The candidate pool retrieval ranks before role assignment. Generous so the failing-test/graph routes can pull in a target lexical search alone missed; the budget allocator and role gate trim it back down.". Classification: {"isSafetyBound":false,"isPerformanceBound":false,"isRetrievalQualityHeuristic":true,"isBenchmarkHeuristic":false,"isHistoricalDefault":true,"isBudgetAware":false,"commentDelegatesTrimmingTo":"the budget allocator and the role gate","note":"The comment describes the pool as generous input to the allocator and role gate, i.e. as a supply the downstream bounds would trim. M206 measured the opposite: after the tier count was removed the pool itself is the binding stage at 8000 and 16000 (39 of 100 frozen responses stop on it), because the downstream token budget is caller-derived and the pool is not."}. Hidden limits: lexical row budget = max(20, 4 × pool) — derived from the pool, so the pool constant also sizes the lexical universe; graph expansion 24 candidates at depth 1 (6 same-module siblings per seed); anchor/backfill merges evict the pool's tail to stay at the pool size; the compound-task rescue re-retrieves at the same pool size; MAX_ORGANIC_RANK (file-evidence deep pass) and MAX_ROUTED_RESCUE_RESULTS are independent 100-row windows. Dependents: backfill lane windows, concept-owner deliverable pool, orchestration withinPool, file-evidence lane arithmetic, test-dominated pool test, co-edit poolFilePaths.

## Pool-width sweep (real product path, C-MED medians)

Seam identity at the product width: C-SMALL 27/27, C-MED 180/180, C-LARGE 27/27. Universe (uncapped median candidates): C-MED 130, C-LARGE 64, C-SMALL 5; largest C-MED pool 136.

| pool | 1k util | 2k util | 4k util | 8k util | 16k util | band | median pool 16k | items 16k | p90 8000 C-MED | p90 8000 C-LARGE | p90 16000 C-MED | p90 16000 C-LARGE |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 25 | 85.05% | 95.4% | 101.65% | 55.45% | 27.88% | BELOW | 31 | 37 | 235.71 | 336.37 | 231.87 | 330.32 |
| 50 | 82.05% | 95.7% | 102.38% | 85.06% | 44.22% | BELOW | 54 | 58 | 299.2 | 361.36 | 270.48 | 349.56 |
| 100 | 85.8% | 97.17% | 102.93% | 103.06% | 73.85% | MATCHES | 102 | 101 | 325.28 | 386.37 | 310.95 | 374.2 |
| 200 | 85.8% | 97.82% | 102.89% | 103.16% | 94.72% | EXCEEDS | 130 | 126.5 | 334.3 | 374.32 | 338.23 | 410.68 |
| uncapped | 85.8% | 97.82% | 102.89% | 103.16% | 94.72% | EXCEEDS | 130 | 126.5 | 387.09 | 378.15 | 333.21 | 411.86 |

| pool | budget | raw pool | ranked stream | eligible | delivered | whole tokens | unused | stops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 25 | 1000 | 31 | 38 | 27 | 8 | 850.5 | 149.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 25 | 2000 | 31 | 38 | 27 | 16.5 | 1908 | 92 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 25 | 4000 | 31 | 38 | 27 | 33 | 4066 | -66 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":19,"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":1} |
| 25 | 8000 | 31 | 38 | 27 | 36 | 4436.5 | 3563.5 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} |
| 25 | 16000 | 31 | 38 | 27 | 37 | 4459.5 | 11540.5 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} |
| 50 | 1000 | 54 | 60 | 49 | 7 | 820.5 | 179.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 50 | 2000 | 54 | 60 | 49 | 16.5 | 1914 | 86 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 50 | 4000 | 54 | 60 | 49 | 36 | 4095 | -95 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 50 | 8000 | 54 | 60 | 49 | 57.5 | 6804.5 | 1195.5 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":8,"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":11,"NO_TRUTHFUL_SUPPLY":1} |
| 50 | 16000 | 54 | 61 | 49 | 58 | 7075.5 | 8924.5 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":19,"NO_TRUTHFUL_SUPPLY":1} |
| 100 | 1000 | 102 | 107 | 95 | 7 | 858 | 142 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 100 | 2000 | 102 | 107 | 95 | 17 | 1943.5 | 56.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 100 | 4000 | 102 | 107 | 95 | 39 | 4117 | -117 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 100 | 8000 | 102 | 107 | 95 | 79 | 8245 | -245 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 100 | 16000 | 102 | 108 | 95 | 101 | 11815.5 | 4184.5 | {"OTHER_EXPLICIT_POLICY:CANDIDATE_POOL_CAP":15,"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":5} |
| 200 | 1000 | 130 | 135 | 121.5 | 7 | 858 | 142 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 200 | 2000 | 130 | 135 | 121.5 | 17 | 1956.5 | 43.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 200 | 4000 | 130 | 135 | 121.5 | 38.5 | 4115.5 | -115.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 200 | 8000 | 130 | 135 | 121.5 | 82 | 8253 | -253 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 200 | 16000 | 130 | 135 | 121.5 | 126.5 | 15154 | 846 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":17,"NO_TRUTHFUL_SUPPLY":3} |
| uncapped | 1000 | 130 | 135 | 121.5 | 7 | 858 | 142 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| uncapped | 2000 | 130 | 135 | 121.5 | 17 | 1956.5 | 43.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| uncapped | 4000 | 130 | 135 | 121.5 | 38.5 | 4115.5 | -115.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| uncapped | 8000 | 130 | 135 | 121.5 | 82 | 8253 | -253 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| uncapped | 16000 | 130 | 135 | 121.5 | 126.5 | 15154 | 846 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":17,"NO_TRUTHFUL_SUPPLY":3} |

## Supply sufficiency

Rule: required_match_tokens(B) = ceil(0.6 x B) whole-packet chars/4 tokens; a width is SUFFICIENT at a budget when the median of its REAL packets reaches it; the verdict is taken on the widest width at every frozen budget. Requirement {"1000":600,"2000":1200,"4000":2400,"8000":4800,"16000":9600}.

| width | budget | required | median tokens | util | pool | stream | items | sufficiency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 25 | 1000 | 600 | 850.5 | 85.05% | 31 | 38 | 8 | SUFFICIENT |
| 25 | 2000 | 1200 | 1908 | 95.4% | 31 | 38 | 16.5 | SUFFICIENT |
| 25 | 4000 | 2400 | 4066 | 101.65% | 31 | 38 | 33 | SUFFICIENT |
| 25 | 8000 | 4800 | 4436.5 | 55.45% | 31 | 38 | 36 | INSUFFICIENT |
| 25 | 16000 | 9600 | 4459.5 | 27.88% | 31 | 38 | 37 | INSUFFICIENT |
| 50 | 1000 | 600 | 820.5 | 82.05% | 54 | 60 | 7 | SUFFICIENT |
| 50 | 2000 | 1200 | 1914 | 95.7% | 54 | 60 | 16.5 | SUFFICIENT |
| 50 | 4000 | 2400 | 4095 | 102.38% | 54 | 60 | 36 | SUFFICIENT |
| 50 | 8000 | 4800 | 6804.5 | 85.06% | 54 | 60 | 57.5 | SUFFICIENT |
| 50 | 16000 | 9600 | 7075.5 | 44.22% | 54 | 61 | 58 | INSUFFICIENT |
| 100 | 1000 | 600 | 858 | 85.8% | 102 | 107 | 7 | SUFFICIENT |
| 100 | 2000 | 1200 | 1943.5 | 97.17% | 102 | 107 | 17 | SUFFICIENT |
| 100 | 4000 | 2400 | 4117 | 102.93% | 102 | 107 | 39 | SUFFICIENT |
| 100 | 8000 | 4800 | 8245 | 103.06% | 102 | 107 | 79 | SUFFICIENT |
| 100 | 16000 | 9600 | 11815.5 | 73.85% | 102 | 108 | 101 | SUFFICIENT |
| 200 | 1000 | 600 | 858 | 85.8% | 130 | 135 | 7 | SUFFICIENT |
| 200 | 2000 | 1200 | 1956.5 | 97.82% | 130 | 135 | 17 | SUFFICIENT |
| 200 | 4000 | 2400 | 4115.5 | 102.89% | 130 | 135 | 38.5 | SUFFICIENT |
| 200 | 8000 | 4800 | 8253 | 103.16% | 130 | 135 | 82 | SUFFICIENT |
| 200 | 16000 | 9600 | 15154 | 94.72% | 130 | 135 | 126.5 | SUFFICIENT |
| uncapped | 1000 | 600 | 858 | 85.8% | 130 | 135 | 7 | SUFFICIENT |
| uncapped | 2000 | 1200 | 1956.5 | 97.82% | 130 | 135 | 17 | SUFFICIENT |
| uncapped | 4000 | 2400 | 4115.5 | 102.89% | 130 | 135 | 38.5 | SUFFICIENT |
| uncapped | 8000 | 4800 | 8253 | 103.16% | 130 | 135 | 82 | SUFFICIENT |
| uncapped | 16000 | 9600 | 15154 | 94.72% | 130 | 135 | 126.5 | SUFFICIENT |

Verdict: `A11_RETRIEVAL_SUPPLY_SUFFICIENT`; narrowest sufficient swept width 100; decided on product b150fcb95f2e before the repair (15fbad8fa434).

## Candidate quality of the newly exposed tail (8000 and 16000)

| width | budget | exposed | delivered | rejected downstream | source-backed | relationship-only | duplicate rate | exposed score min/p10/med/p90/max | pool-25 score min/p10/med/p90/max | fates | provenance |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 50 | 8000 | 473 | 0.9323 | 0.0677 | 0.9955 | 0.0045 | 0 | 0.5185 / 0.8419 / 1.1312 / 1.3499 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":440,"support_discarded":32,"unaccounted":1} | {"lexical":363,"graph_neighbour":82,"concept_owner":18,"same_module":7,"upstream_rescue":3} |
| 50 | 16000 | 473 | 0.9345 | 0.0655 | 0.9932 | 0.0068 | 0 | 0.5185 / 0.8419 / 1.1312 / 1.3499 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":439,"support_discarded":31,"unaccounted":2,"pivot":1} | {"lexical":363,"graph_neighbour":82,"concept_owner":18,"same_module":7,"upstream_rescue":3} |
| 100 | 8000 | 1412 | 0.7436 | 0.2564 | 0.7533 | 0.2467 | 0 | 0.3467 / 0.6048 / 0.9591 / 1.2525 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":1049,"support_discarded":106,"support_packed_not_projected":256,"unaccounted":1} | {"lexical":1152,"graph_neighbour":176,"same_module":34,"concept_owner":40,"symbol_name":5,"upstream_rescue":5} |
| 100 | 16000 | 1412 | 0.9256 | 0.0744 | 0.9923 | 0.0077 | 0 | 0.3467 / 0.6048 / 0.9591 / 1.2525 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":1304,"support_discarded":105,"unaccounted":2,"pivot":1} | {"lexical":1152,"graph_neighbour":176,"same_module":34,"concept_owner":40,"symbol_name":5,"upstream_rescue":5} |
| 200 | 8000 | 1954 | 0.5701 | 0.4299 | 0.7702 | 0.2298 | 0 | 0 / 0.405 / 0.8404 / 1.2108 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":1113,"support_packed_not_projected":691,"support_discarded":149,"unaccounted":1} | {"lexical":1548,"graph_neighbour":277,"same_module":71,"concept_owner":48,"symbol_name":5,"upstream_rescue":5} |
| 200 | 16000 | 1954 | 0.9324 | 0.0676 | 0.972 | 0.028 | 0 | 0 / 0.405 / 0.8404 / 1.2108 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":1818,"support_discarded":132,"unaccounted":3,"pivot":1} | {"lexical":1548,"graph_neighbour":277,"same_module":71,"concept_owner":48,"symbol_name":5,"upstream_rescue":5} |
| uncapped | 8000 | 1954 | 0.5701 | 0.4299 | 0.7702 | 0.2298 | 0 | 0 / 0.405 / 0.8404 / 1.2108 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":1113,"support_packed_not_projected":691,"support_discarded":149,"unaccounted":1} | {"lexical":1548,"graph_neighbour":277,"same_module":71,"concept_owner":48,"symbol_name":5,"upstream_rescue":5} |
| uncapped | 16000 | 1954 | 0.9324 | 0.0676 | 0.972 | 0.028 | 0 | 0 / 0.405 / 0.8404 / 1.2108 / 1.5898 | 0.312 / 0.8738 / 1.3376 / 1.7219 / 2.5179 | {"support_delivered":1818,"support_discarded":132,"unaccounted":3,"pivot":1} | {"lexical":1548,"graph_neighbour":277,"same_module":71,"concept_owner":48,"symbol_name":5,"upstream_rescue":5} |

## Role identity across widths (frozen budgets, vs width 25)

| width | budget | same pivot set | same lead | same focus | starved pivots | support delta (min/med/max) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 50 | 1000 | 20/20 | 20 | 20 | 0 | -1 / 0 / 2 |
| 50 | 2000 | 20/20 | 20 | 20 | 0 | -4 / 2 / 22 |
| 50 | 4000 | 20/20 | 20 | 20 | 0 | 0 / 21 / 26 |
| 50 | 8000 | 20/20 | 20 | 20 | 0 | 0 / 21 / 26 |
| 50 | 16000 | 19/20 | 20 | 20 | 0 | 0 / 21 / 25 |
| 100 | 1000 | 20/20 | 20 | 20 | 0 | -2 / 0 / 2 |
| 100 | 2000 | 20/20 | 20 | 20 | 0 | -4 / 2 / 22 |
| 100 | 4000 | 20/20 | 20 | 20 | 0 | 0 / 41 / 76 |
| 100 | 8000 | 20/20 | 20 | 20 | 0 | 0 / 66 / 76 |
| 100 | 16000 | 19/20 | 20 | 20 | 0 | 0 / 66 / 75 |
| 200 | 1000 | 20/20 | 20 | 20 | 0 | -2 / 0 / 2 |
| 200 | 2000 | 20/20 | 20 | 20 | 0 | -4 / 2 / 22 |
| 200 | 4000 | 20/20 | 20 | 20 | 0 | 0 / 42 / 79 |
| 200 | 8000 | 20/20 | 20 | 20 | 0 | 0 / 90.5 / 101 |
| 200 | 16000 | 19/20 | 20 | 20 | 0 | 0 / 91.5 / 101 |
| uncapped | 1000 | 20/20 | 20 | 20 | 0 | -2 / 0 / 2 |
| uncapped | 2000 | 20/20 | 20 | 20 | 0 | -4 / 2 / 22 |
| uncapped | 4000 | 20/20 | 20 | 20 | 0 | 0 / 42 / 79 |
| uncapped | 8000 | 20/20 | 20 | 20 | 0 | 0 / 90.5 / 101 |
| uncapped | 16000 | 19/20 | 20 | 20 | 0 | 0 / 91.5 / 101 |

## The policy

candidatePool = clamp(ceil(maxTokens / EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE), CANDIDATE_POOL_FLOOR, CANDIDATE_POOL_HARD_MAXIMUM), with EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE = 120, CANDIDATE_POOL_FLOOR = 25, CANDIDATE_POOL_HARD_MAXIMUM = 400 (src/capsuleV2/budgetAllocator.ts). Allowance by budget: {"500":25,"1000":25,"1500":25,"2000":25,"3000":25,"4000":34,"6000":50,"8000":67,"12000":100,"16000":134,"20000":167,"48000":400,"100000":400}. Stated rule agrees with the product true; fixed constant remains false. The lexical row budget stays derived from the floor (100 rows) and the backfill lanes keep their windows; the capsule reports `candidate_pool_size` beside `candidate_count`.

## Candidate supply and utilisation before / after (C-MED medians)

| budget | allowance | pool before -> after | stream | eligible | role discards | capsule selected | delivered items | whole tokens | unused | util before -> after | after min / p10 / p90 / max | stops after | p90 before -> after |
| ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 25 | 31 -> 31 | 38 -> 38 | 27 -> 27 | 2 -> 2 | 18 -> 18 | 8 -> 8 | 850.5 -> 850.5 | 149.5 -> 149.5 | 85.05% -> 85.05% | 75.7 / 77.4 / 101.9 / 102.3 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 203.68 -> 209.44 |
| 1500 (non-frozen) | 25 | 31 -> 31 | 38 -> 38 | 27 -> 27 | 2 -> 2 | 23 -> 23 | 12 -> 12 | 1351 -> 1342 | 149 -> 158 | 90.06% -> 89.47% | 7.2 / 44.87 / 102.8 / 102.93 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 236.21 -> 223.48 |
| 2000 | 25 | 31 -> 31 | 38 -> 38 | 27 -> 27 | 2 -> 2 | 32 -> 32 | 16.5 -> 16.5 | 1908 -> 1895.5 | 92 -> 104.5 | 95.4% -> 94.78% | 55.15 / 69.75 / 102.8 / 103.15 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 231.95 -> 209.56 |
| 3000 (non-frozen) | 25 | 31 -> 31 | 38 -> 38 | 27 -> 27 | 2 -> 2 | 35 -> 35 | 25 -> 25 | 3021.5 -> 3021.5 | -21.5 -> -21.5 | 100.72% -> 100.72% | 74.1 / 85.83 / 102.6 / 103.17 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 233.33 -> 210.8 |
| 4000 | 34 | 31 -> 38 | 38 -> 46 | 27 -> 34.5 | 2 -> 3 | 35 -> 42 | 33 -> 34 | 4066 -> 4082 | -66 -> -82 | 101.65% -> 102.05% | 82.03 / 87.38 / 103 / 103.25 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 242.82 -> 244.87 |
| 6000 (non-frozen) | 50 | 31 -> 54 | 38 -> 60 | 27 -> 49 | 2 -> 4 | 35 -> 56 | 36 -> 52 | 4436.5 -> 6150 | 1563.5 -> -150 | 73.94% -> 102.5% | 85 / 85.83 / 102.77 / 103.03 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 216.34 -> 261.99 |
| 8000 | 67 | 31 -> 71 | 38 -> 78 | 27 -> 65 | 2 -> 5.5 | 35 -> 71 | 36 -> 69.5 | 4436.5 -> 8200 | 3563.5 -> -200 | 55.45% -> 102.5% | 81.54 / 81.99 / 102.85 / 102.92 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 235.71 -> 272.34 |
| 12000 (non-frozen) | 100 | 31 -> 102 | 38 -> 108 | 27 -> 95 | 2 -> 6 | 35 -> 101 | 37 -> 101 | 4459.5 -> 11638.5 | 7540.5 -> 361.5 | 37.16% -> 96.98% | 66.45 / 81.75 / 102.81 / 102.92 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} | 218.42 -> 294.42 |
| 16000 | 134 | 31 -> 130 | 38 -> 135 | 27 -> 121.5 | 2 -> 8 | 35 -> 126 | 37 -> 126.5 | 4459.5 -> 15154 | 11540.5 -> 846 | 27.88% -> 94.72% | 73.86 / 76.02 / 102.61 / 102.66 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":17,"NO_TRUTHFUL_SUPPLY":3} | 231.87 -> 321.95 |

## Sweep-to-product attribution (frozen responses)

100 responses: within the swept bracket around the allowance 99; focus same as pre 100. Pinned-25 control on the moved corpus: same focus 100, same related set 86, frozen A11 {"1000":86.35,"2000":94.95,"4000":101.73,"8000":55.45,"16000":27.88}. the repaired product with its pool pinned to 25 through the instrument, on the moved corpus: the movement that remains is the corpus's (this tree's src changed) and the tight-budget envelope's, not the policy's.

| budget | allowance | within bracket | median actual | stops |
| ---: | ---: | ---: | ---: | --- |
| 1000 | 25 | 20 | 85.05 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 2000 | 25 | 19 | 94.775 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 4000 | 34 | 20 | 102.05 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 8000 | 67 | 20 | 102.5 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":20} |
| 16000 | 134 | 20 | 94.715 | {"OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET":17,"NO_TRUTHFUL_SUPPLY":3} |

## Tail (ten worst post-change frozen responses)

| task | budget | util | items | pool | stream | role discards | selected upstream | dropped | stop | binding |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| how does the response envelope shed content under budget pressure | 2000 | 55.15% | 10 | 31 | 39 | 5 | 21 | 8 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | PROGRESSIVE_BUDGET_DROP |
| what writes the index manifest after a run | 2000 | 69.75% | 8 | 29 | 36 | 1 | 26 | 14 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | PROGRESSIVE_BUDGET_DROP |
| how does cython parsing differ from python parsing | 16000 | 73.86% | 122 | 130 | 138 | 17 | 125 | 0 | NO_TRUTHFUL_SUPPLY | NO_ELIGIBLE_EVIDENCE |
| how does search rank candidate symbols for a task | 1000 | 75.7% | 8 | 30 | 37 | 2 | 25 | 14 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | PROGRESSIVE_BUDGET_DROP |
| budget allocation for capsule items is dropping sections | 16000 | 76.02% | 110 | 127 | 127 | 17 | 114 | 0 | NO_TRUTHFUL_SUPPLY | NO_ELIGIBLE_EVIDENCE |
| what happens when the index schema version is incompatible | 1000 | 77.4% | 9 | 26 | 33 | 1 | 23 | 11 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | PROGRESSIVE_BUDGET_DROP |
| what deduplicates supporting files in the capsule | 16000 | 78.88% | 106 | null | null | 0 | 122 | 11 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | PROGRESSIVE_BUDGET_DROP |
| what determines whether the repository index is considered fresh | 1000 | 81.3% | 6 | 31 | 38 | 1 | 23 | 14 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | PROGRESSIVE_BUDGET_DROP |
| how does cython parsing differ from python parsing | 8000 | 81.54% | 66 | 73 | 81 | 16 | 69 | 0 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | UPSTREAM_BUDGET_EXHAUSTED |
| where are import edges extracted from typescript | 8000 | 81.99% | 64 | 68 | 74 | 11 | 64 | 0 | OTHER_EXPLICIT_POLICY:UPSTREAM_EVIDENCE_BUDGET | UPSTREAM_BUDGET_EXHAUSTED |

Delivery collapses (>= 10 selected, <= 2 delivered) on C-MED: width 25 pre {"1000":[],"2000":[],"4000":[],"8000":[],"16000":[]}; uncapped pre {"1000":["what writes the index manifest after a run","how does cython parsing differ from python parsing"],"2000":[],"4000":["how are skeleton declarations built from indexed symbols"],"8000":["how are skeleton declarations built from indexed symbols"],"16000":[]}; product post {"1000":[],"2000":[],"4000":[],"8000":[],"16000":[]}.

## Same-corpus control

Repaired product on the pre-change corpus copy: 180 responses; focus same as pre 180; packet byte-identical to pre 80; packet byte-identical to the post run on the moved corpus 146, related set same 157. Frozen A11 on the pre corpus {"1000":85.05,"2000":95.4,"4000":102.05,"8000":102.5,"16000":94.72} vs on the post corpus {"1000":85.05,"2000":94.78,"4000":102.05,"8000":102.5,"16000":94.72}. Median items pre 31, post-on-pre 34, post-on-post 34.

## Falsification

| id | pass | statement |
| --- | --- | --- |
| F1 | pass | the historical fixed pool truncates an abundant truthful universe; the budget-derived pool exposes more of the same ranked stream and delivers it |
| F2 | pass | a huge caller budget over a small truthful universe leaves the budget unused: no filler, no relaxed relevance, every delivered identity in the ranked stream |
| F3 | pass | broadening the allowance makes nothing eligible that was not: test symbols stay out at the role gate and symbols with no evidence never enter the pool |
| F4 | pass | one semantic symbol proposed through several routes is one candidate after dedupe, one delivered item and one accounting record |
| F5 | pass | equal-score candidates around the old pool boundary keep one stable order across repeated builds and across widths: the narrow pool is a prefix of the wide pool |
| F6 | pass | a large newly exposed support universe never replaces a required pivot: pivot set, lead and cap identical to the predecessor at every budget |
| F7 | pass | arbitrary caller budgets follow one general policy: allowance = clamp(ceil(budget / expected cost), floor, hard maximum), monotone, no frozen-rung special case, and the capsule's pool follows it |
| F8 | pass | a very large candidate-producing repository stays deterministically bounded: the pool never exceeds the hard maximum, the 16000 pool never exceeds its allowance, and time and memory stay controlled |
| F9 | pass | every newly admitted item reconciles through M203: the expanded packet is fully A14-accounted, and a corrupted or missing cost on a tail item fails the analyzer |
| F10 | pass | a newly admitted tail candidate carries only a representation its source supports: the expanded packet passes M205 and a fabricated tail body fails |
| F11 | pass | broader retrieval can raise supply while a focus swap between budgets stays an A13 violation: the utilisation analyzer passes both packets and the swap is counted separately |
| F12 | pass | A11 moves without any A15 rendering: no impact or call-site entry at either width, and every added entry is an existing representation of a newly exposed candidate |
| F13 | pass | no competitor-derived or benchmark-derived constant governs the pool: no 423, no 'top 12 because VEXP', no frozen-rung case, no A11 threshold in the product change |
| F14 | pass | with the pool pinned to the historical constant the product reproduces the predecessor exactly; only the unpinned pool moves the outcome |
| F15 | pass | the evidence-budget ladder drops ordinary support from the tail until it fits but collapses to one item when every support is answer-bearing: a downstream hazard the pool policy stays clear of, documented and not repaired here |

## Representation and accounting integrity

A12 on the repaired product: 4 classes (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY, FOCUS:excerpt) MATCHES; integrity failures 2/180 (attribution: predecessor product on this corpus 2, current product on the pre corpus 2, identical items true; the failing items, when present, are identical under the predecessor product on this corpus and under the current product on the pre-change copy: the corpus (this tree's src) moved with the seam and the item's authoritative body is skeletonized by the evidence budget at 1500/2000 while the packet carries the source-anchored full body; a consistency question between the compacted authoritative rendering and the projected packet that predates M207 and is independent of the pool); related entries on C-MED 8605 (M206 4521), accounted 8605, valid representation 8603; class totals {"focused_source":441,"signature":66,"skeleton":7625,"relationship_only":635,"excerpt":18}; reasons {"upstream_form_delivered":7970,"form_not_code_bearing":212,"no_rendered_body":47,"ceiling":376}; source truth {"focused_source":{"ANCHORED_IN_SPAN":441},"signature":{"PARSER_SIGNATURE":66},"skeleton":{"SKELETON_MATCHES_INDEX":7273,"SKELETON_HEAD_OF_INDEX":352},"excerpt":{"ANCHORED_IN_SPAN":18}}. Frozen rerun A12 MATCHES (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY, FOCUS:excerpt).

A14 frozen rerun 5055/5055 (MATCHES); M206 2548/2548. Sweep integrity failures pre 0/900, post 0/360.

## Determinism

3 repeats: packets stable true, ledgers stable true; unstable []; F5 true.

## Performance

A5 harness p90 before {"C-SMALL":52.25,"C-MED":207.46,"C-LARGE":346.68} (MATCHES); after {"C-SMALL":51.61,"C-MED":201.04,"C-LARGE":344.91} (MATCHES); frozen A5 MATCHES: get_code_context warm p90 55.17 / 203.6 / 344.88 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 34.64 / 149.26 / 290.78 ms (M206: get_code_context warm p90 56.03 / 223.09 / 355.85 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 35.24 / 150.07 / 296.22 ms). Largest packet 65703 -> 65703 bytes; largest item count 136 -> 135; largest ranked stream 143 -> 141; largest pool 136 -> 134; sweep peak RSS 2243 -> 2230 MB (sweep peak RSS is the audit process retaining every response row, per-candidate ledger and repeated packets; the product's own memory per request is bounded by F8 (a 500-candidate fixture at a million-token budget: +6 MB)). no DB table, no schema change, no new persisted metadata; the capsule diagnostics gain candidate_pool_size beside candidate_count.

| budget | allowance | p90 before | p90 after | C-LARGE p90 before | C-LARGE p90 after | capsule build ms (median, after) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 25 | 203.68 | 209.44 | 305.14 | 318.25 | 113.4 |
| 1500 | 25 | 236.21 | 223.48 | 326.2 | 308.9 | 111.8 |
| 2000 | 25 | 231.95 | 209.56 | 315.19 | 313.54 | 111.7 |
| 3000 | 25 | 233.33 | 210.8 | 357.84 | 331.55 | 116.3 |
| 4000 | 34 | 242.82 | 244.87 | 322.87 | 341.24 | 113.9 |
| 6000 | 50 | 216.34 | 261.99 | 323 | 361.99 | 117.2 |
| 8000 | 67 | 235.71 | 272.34 | 336.37 | 352.24 | 118.3 |
| 12000 | 100 | 218.42 | 294.42 | 349.54 | 404.08 | 122.2 |
| 16000 | 134 | 231.87 | 321.95 | 330.32 | 419.85 | 124.9 |

## A13, observed

M206 committed: 3 size violations, 5 focus swaps (BELOW). Pre by width: 25: 3/5, {"subsequence":30,"prefix":15,"neither":35}, rep 1; 50: 3/5, {"neither":41,"subsequence":36,"prefix":3}, rep 4; 100: 4/5, {"neither":47,"subsequence":30,"prefix":3}, rep 43; 200: 4/5, {"neither":47,"subsequence":27,"prefix":6}, rep 7; uncapped: 4/5, {"neither":47,"subsequence":27,"prefix":6}, rep 7. Post: 3 / 5, order relations {"subsequence":15,"neither":65}, representation regressions 24. Frozen rerun: 3 / 5 (BELOW). A13 was measured, not optimized.

## Protected claims

| id | M206 | M207 | held |
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
| A12 | MATCHES | MATCHES | true |
| A14 | MATCHES | MATCHES | true |

## Full matrix

| id | M206 | M207 | measurement |
| --- | --- | --- | --- |
| A1 | MATCHES | MATCHES | 30 parser-backed families (bash, c, clojure, cpp, csharp, css, cython, dart, elixir, go, haskell, html, java, javascript, json, kotlin, lua, |
| A2 | EXCEEDS | EXCEEDS | C-MED 64.96 files/s, C-LARGE 33.89 files/s (median of 3 cold builds) |
| A3 | MATCHES | MATCHES | C-LARGE k=1 ratio 0.057, k=3 ratio 0.14; reparsed 372 of the 372 files the indexer holds for a ONE-file change (the eligible .py denominator |
| A4 | EXCEEDS | EXCEEDS | no-op median 0.007 / 0.074 / 0.158 s (C-SMALL / C-MED / C-LARGE), 0 files reparsed |
| A5 | MATCHES | MATCHES | get_code_context warm p90 55.17 / 203.6 / 344.88 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 34.64 / 149.26 / 290.78 ms |
| A6 | EXCEEDS | EXCEEDS | get_impact_graph depth 3 warm p90 152.52 ms on C-LARGE (10 exact-FQN targets x 5) |
| A7 | EXCEEDS | EXCEEDS | search_logic_flow warm p90 15.72 ms on C-LARGE; path edge counts {"1":10} |
| A8 | EXCEEDS | EXCEEDS | C-SMALL 100%, C-MED 100%, C-LARGE 100%; unexplained missing 0/0/0 |
| A9 | MATCHES | MATCHES | median rendered reduction C-MED 92.82%, C-LARGE 87.21% over 449 + 250 structurally valid files; 22 C-MED files excluded as malformed (F4) |
| A10 | MATCHES | MATCHES | signature retention C-MED 99.48%, C-LARGE 100% (verbatim, token-aligned, bracket-closed slices of source); member retention C-MED 100%, C-LA |
| A11 | BELOW | EXCEEDS | C-MED whole-response utilisation by budget: 1000=84.05%, 2000=94.65%, 4000=102.05%, 8000=102.5%, 16000=94.72% over 20 tasks |
| A12 | MATCHES | MATCHES | C-MED default response carries 4 distinct representation classes (FOCUS:focused_source, RELATED_WITH_CODE, RELATIONSHIP_ONLY, FOCUS:excerpt) |
| A13 | BELOW | BELOW | 3 of 20 tasks lose focus content as the budget grows, and 5 swap the delivered focus symbol, over 5 budgets |
| A14 | MATCHES | MATCHES | 5055 of 5055 delivered items carry token accounting; no accounting block appears in the default response at all (present at detail=debug onl |
| A15 | BELOW | BELOW | C-LARGE, 50 eligible call edges: the impact surface renders 0% as source expressions, the logic-flow surface 100%. On C-MED the flow surface |

M206 12/15, M207 13/15, target 15/15.

Frozen control F6: FAIL. the committed control conjoins `a14PerItem === 0`, the M197A observation; its other conjuncts pass, so a failure is the stale control and not an A14 regression; not modified (M203 standing finding).

## Gates

| gate | pass | statement |
| --- | --- | --- |
| G1 | pass | frozen A11 definition recovered unchanged |
| G2 | pass | A11 BELOW reproduced pre-change at the product width, within tolerance of the committed M206 figures (the seam edited the corpus) |
| G3 | pass | retrieval-pool authority audited: origin commit, rationale, every use site, every hidden bound |
| G4 | pass | seam identity: instrumented packets byte-identical to the uninstrumented handler at the product width on every corpus |
| G5 | pass | pool-width sweep through the real product path: 0 integrity failures, packets stable |
| G6 | pass | retrieval supply sufficiency decided before the product change, on the frozen rule, at the uncapped width |
| G7 | pass | one retrieval-pool authority: the allocator derives the allowance from the budget; no fixed constant, no parallel retriever (F7, F13) |
| G8 | pass | pool defect repaired: the historical pool truncated abundant truthful retrieval and the allowance exposes it (F1, F14) |
| G9 | pass | role safeguards: pivot caps unchanged, pivot sets identical across widths, no starved pivot (F6; sweep role identity) |
| G10 | pass | no filler, no relevance weakening: small universes leave budget unused, irrelevant tails stay out, duplicates deliver once (F2, F3, F4) |
| G11 | pass | M205 representation truth on every newly admitted item (F10; representation sweep on the repaired product introduces no failure the predecessor does not show on the same corpus) |
| G12 | pass | M203 accounting: every delivered item accounted and reconciled (F9; frozen A14) |
| G13 | pass | determinism: repeats stable on packets and ledgers; tie order stable across widths (F5) |
| G14 | pass | performance: A5 at least MATCHES on the frozen rerun and the A5 harness |
| G15 | pass | A1-A10 protected |
| G16 | pass | A12 protected |
| G17 | pass | A14 protected |
| G18 | pass | A13 measured only; new baseline captured (F11) |
| G19 | pass | A15 untouched (F12; verdict carried) |
| G20 | pass | frozen A11 verdict from the unmodified scorer |
| G21 | pass | full A1-A15 rerun by the unmodified analyzer |
| G22 | pass | the evidence-budget ladder hazard is documented (F15) and the product introduces no new delivery collapse on the frozen corpus |
| G23 | pass | hard resource bound and bounded runtime (F8) |
| G24 | pass | standard verification (recorded by the ledger row; not computed here) |
| G25 | pass | zero model spend: offline instruments only |

## Authority

Replay: `M197A_AUTHORITY_MISMATCH` (failing only branch_is_main: the detached predecessor worktree (the branch-name check cannot pass there)) at 504 files (expected 504) @ b150fcb95f2e. Post: `M197A_AUTHORITY_VERIFIED` at 504 @ 15fbad8fa434. Frozen claim definitions, thresholds, scorers, tokenizer, task sets and corpus roots remain unchanged. C-MED is this repository's src/; M207 edited existing source files and added none, so the self-referential count is unchanged while the revision and the file contents moved; the corpus is therefore not byte-identical to M206's, and the same-corpus control separates that movement from the policy's.

## Boundary

- ENGINE QUALITY != CODING-AGENT UTILITY
- NO_A13_MONOTONICITY_REPAIR_AUTHORIZED
- NO_IMPACT_RENDERING_EXPANSION_AUTHORIZED
- NO_NEW_REPRESENTATION_CLASS_AUTHORIZED
- NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED
- NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
- I5_REMAINS_CLOSED
- I6_VALIDATION_SELECTION_REMAINS_CLOSED
