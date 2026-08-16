# Stage 5 M155-B/C — broad deterministic retrieval qualification

Candidate: **M154**. Corpus: 100 frozen SWE-bench cases.

## Checkpoint trend (§68)

| Checkpoint | Evaluated | File Top-1 | File Top-3 | Gold **delivered** | Gold anywhere | Gold discarded | Symbol anywhere | Missing gold | Misleading lead | Empty | Tokens (median) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M129 | 100/100 | 56.0% | 73.0% | 79.0% | 85.0% | 6.0% | 64.0% | 15.0% | 42.0% | 2.0% | 1185 |
| M140 | 100/100 | 55.0% | 72.0% | 80.0% | 84.0% | 4.0% | 64.0% | 16.0% | 43.0% | 2.0% | 1165 |
| M150 | 100/100 | 57.0% | 73.0% | 78.0% | 89.0% | 11.0% | 64.0% | 11.0% | 41.0% | 2.0% | 1165 |
| M152 | 100/100 | 57.0% | 73.0% | 78.0% | 89.0% | 11.0% | 64.0% | 11.0% | 41.0% | 2.0% | 1165 |
| M154 | 100/100 | 57.0% | 73.0% | 78.0% | 89.0% | 11.0% | 64.0% | 11.0% | 41.0% | 2.0% | 1165 |

`Gold delivered` = gold reached the model as pivot or support. `Gold anywhere`
additionally counts `discarded` — surfaced as a candidate and then withheld — so
the two columns can move in opposite directions. Only `Gold delivered` describes
evidence an agent could act on.

## Adjacent transitions (§67)

| Transition | Changed | Improvement | Regression | Neutral |
| --- | ---: | ---: | ---: | ---: |
| M129->M140 | 47 | 0 | 3 | 44 |
| M140->M150 | 95 | 8 | 0 | 87 |
| M150->M152 | 0 | 0 | 0 | 0 |
| M152->M154 | 6 | 0 | 0 | 6 |

## Change attribution (§26)

| Transition | path authority | symbol authority | delivery | candidate cap | contract-only change | unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| M129->M140 | 3 | 0 | 20 | 1 | 22 | 1 |
| M140->M150 | 2 | 0 | 72 | 7 | 13 | 1 |
| M150->M152 | 0 | 0 | 0 | 0 | 0 | 0 |
| M152->M154 | 0 | 0 | 6 | 0 | 0 | 0 |

