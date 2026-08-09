# M133 impact field-size profile

All token figures use the documented chars/4 estimate.

| field | incident before chars | M133 ARC chars |
| --- | ---: | ---: |
| edges | 743,698 | 1,113 |
| nodes | 418,353 | 930 |
| view | 205,948 | 345 |
| directRelations | 4,018 | 1,790 |
| paths | not captured | 2 |
| diagnostics | not captured | 328 |
| accounting | not captured | 55 |
| responseBudget | absent | 612 |
| complete | 1,385,362 | 6,689 |
| estimated tokens | ~346,341 | 1,673 |

Requested `max_edges=10`; three unique direct/high-value edges were retained and
41 examined/candidate edges were reported omitted. Requested model-facing budget
was 1,200; measured model-facing evidence was 1,059 tokens. The empirically
documented complete ceiling is 2,000 tokens / preferably 8,000 characters; the
result used 6,689 characters.

The intermediate M133 engine object, before the final post-accounting gate, was
26,002 characters. This is already 53x smaller than the incident because the
canonical graph is bounded before rendering; the final gate then removes
duplication and secondary projections as defense in depth.
