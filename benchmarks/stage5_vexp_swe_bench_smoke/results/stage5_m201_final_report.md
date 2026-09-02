# Stage 5 — M201: frozen A5 query latency

`A5_PARITY_CLOSED`

## What A5 asks

`query time is reported per capsule call in milliseconds`, scored as **p90 <= 500 ms** (EXCEED at p90 <= 200 ms),
banded by `band()` over the p90 of C-SMALL, C-MED and C-LARGE — every corpus must clear.

Measured: get_code_context warm p90 41.49 / 197.62 / 336.53 ms (C-SMALL / C-MED / C-LARGE), 5 repetitions; best observed 32.49 / 140.66 / 286.21 ms

Verdict: **MATCHES**

## Did M200's BELOW reproduce?

No. `M200_A5_BELOW_NOT_REPRODUCED_ON_AN_UNCHANGED_TREE`

| run | load (1m) | C-SMALL | C-MED | C-LARGE | classification |
| --- | ---: | ---: | ---: | ---: | --- |
| M200 | 16.73 | 111.08 | 439.18 | 627.3 | BELOW |
| pre1 | 12.89 | 46.68 | 200.16 | 431.71 | MATCHES |
| pre2 | 7.78 | 42.69 | 206.82 | 332.48 | MATCHES |
| pre3 | 5.5 | 47.75 | 198.77 | 331.62 | MATCHES |
| pre_a | 0.78 | 44.53 | 196.45 | 332.6 | MATCHES |
| pre_b | 1.05 | 40.75 | 200.12 | 325.87 | MATCHES |
| pre_c | 1.21 | 43.31 | 193.66 | 330.42 | MATCHES |
| base | 1.35 | 44.34 | 194 | 336.05 | MATCHES |
| base2 | 1.78 | 42.59 | 200.06 | 330.08 | MATCHES |

0 files under `src/` changed between the commit M200 measured and this one, and 0 are dirty. The product is the same; the machine was not.

## Where a C-LARGE query spends its time

| stage | ms/query | % of samples |
| --- | ---: | ---: |
| `runPipelineOrchestrator` | 289.52 | 44.45 |
| `buildAuthoritativeProductRetrieval` | 286.8 | 44.04 |
| `buildCapsuleV2` | 286.61 | 44.01 |
| `hybridRetrieve` | 268.91 | 41.29 |
| `lexicalCandidates` | 129.73 | 19.92 |
| `searchSymbolsPlainSql` | 102.88 | 15.8 |
| `conceptOwnerCandidates` | 91.83 | 14.1 |
| `retrieveConceptOwners` | 91.8 | 14.1 |
| `queryBroadCandidates` | 86.61 | 13.3 |
| `assemble` | 27.12 | 4.16 |
| `listAllSymbols` | 25.7 | 3.95 |
| `assembleProductContext` | 23.92 | 3.67 |
| `addImpactEvidence` | 19.06 | 2.93 |
| `getImpactGraph` | 18.97 | 2.91 |
| `upstreamRescueCandidates` | 1.74 | 0.27 |
| `buildPivotNeighborhoods` | 1.46 | 0.22 |
| `addMemoryAndRules` | 0.47 | 0.07 |
| `projectAuthoritativeCapsule` | 0.17 | 0.03 |
| `retrieveIndexedDocuments` | 0.02 | 0 |

Whole-table scans per request, by layer — one at every layer, so there is no second pass:

| layer | scans |
| --- | ---: |
| `buildAuthoritativeProductRetrieval` | 1 |
| `runReliableContextRetrieval` | 1 |
| whole `get_code_context` request | 1 |

## Operation counts on the frozen corpora

| corpus | symbols | whole-table scans/query | SQL executions/query | worst statement repeat |
| --- | ---: | ---: | ---: | ---: |
| C-SMALL | 98 | 2 | 153 | 62 |
| C-MED | 4642 | 2 | 340 | 241 |
| C-LARGE | 10309 | 1 | 449 | 625 |

## Frozen matrix

| ID | M200 | M201 | |
| --- | --- | --- | --- |
| A1 | BELOW | BELOW |  |
| A2 | MATCHES | EXCEEDS | moved |
| A3 | MATCHES | MATCHES |  |
| A4 | EXCEEDS | EXCEEDS |  |
| A5 | BELOW | MATCHES | moved |
| A6 | MATCHES | EXCEEDS | moved |
| A7 | EXCEEDS | EXCEEDS |  |
| A8 | EXCEEDS | EXCEEDS |  |
| A9 | MATCHES | MATCHES |  |
| A10 | MATCHES | MATCHES |  |
| A11 | BELOW | BELOW |  |
| A12 | BELOW | BELOW |  |
| A13 | BELOW | BELOW |  |
| A14 | BELOW | BELOW |  |
| A15 | BELOW | BELOW |  |

M200 8/15 → M201 9/15; target 15/15.
Regressions: none.
Still BELOW: A1, A11, A12, A13, A14, A15.

## The candidate that was rejected

The first profile said the whole-symbol-table scan ran twice per request, and a repair was written for it: split the query-independent scan and lowercasing out of the query-keyed broad-candidate memo. Measured p90 with the change 41.18 / 202.97 / 327.08 ms against 44.53 / 196.45 / 332.6 ms without it, and SQL executions per query identical on every one of the fifteen frozen queries.

A real duplicate removed is not free, so the flat result was the first evidence that the duplicate was an artefact: `Database.prototype.query` is implemented on top of `Database.prototype.prepare`, and an instrument patching both counted every execution twice. rejected; no measured effect, and the duplication it removed did not exist.

## Falsification

Reversing the order in which orientation admits related candidates is caught on 14 of 15 queries (`M201_OUTPUT_DIFFERS`). Token counts stayed equal on every corpus, so the gate caught it on the semantic and selection hashes, not on size — which is why size alone is not the comparator.

Two independent captures of the unperturbed path are equal on all 15 queries, semantically and byte for byte (`M201_OUTPUT_EQUIVALENT`).

## Boundary

`ENGINE QUALITY != CODING-AGENT UTILITY`
`NO_CONTEXT_COMPILER_PRODUCT_RESTRUCTURE_AUTHORIZED`
`NO_VALIDATION_SCAFFOLD_IMPLEMENTATION_AUTHORIZED`
`NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED`
`I5_REMAINS_CLOSED`
`I6_VALIDATION_SELECTION_REMAINS_CLOSED`

live-agent runs: 0; live model spend: $0.
