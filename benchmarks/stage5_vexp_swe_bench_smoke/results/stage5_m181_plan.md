# M181 — plan

**Selection-Reason Semantic Stability Across Compaction.** From M180 at
`189e190d`, verified before starting: HEAD equals M180's declared SHA-backfill
commit.

## The question

M180 closed with `BUDGET_MONOTONE_SEMANTIC_PRESERVATION_PARTIAL` and 113 residual
budget pairs. 106 are one mechanism: the same evidence item, at two budgets, under
a different displayed reason. M180 named it and did not adjudicate it, correctly —
*the explanation changed* and *the meaning changed* are different claims.

So M181 is a classification milestone first and a repair milestone only if the
classification licenses one. §35 makes `NO_PRODUCT_CHANGE_REQUIRED` a valid PASS,
and §4 forbids starting by making the two selectors agree.

## Method

| | |
| --- | --- |
| corpus | `_m179_authoritative` broad100a + broad100b, 169 valid frozen cases |
| ladder | M179's 12 budgets, 66 ordered pairs per case, 2,028 deliveries |
| detector | M180's `comparePreservation`, **imported not reimplemented**, so the 106 is the same 106 |
| witness | the frozen authoritative object's own `selectionReasons` — `deliver()` clones before compacting, so no budget path can touch it |
| live spend | $0.00 |

The witness matters most. Every reason field on a delivered response is downstream
of the transform under test, so a delivered response cannot testify about what the
authoritative reason was.

## Workstreams

- **A** — trace every producer, consumer and ordering source; enumerate the
  vocabulary from data; audit `compactReasons`. Every source claim re-verified
  against the file and line it cites, so a claim whose evidence moved fails the
  runner instead of becoming folklore.
- **B** — reproduce the 106 under M180's semantics; classify; four controls
  (identity, known-negative, synthetic, permutation).
- **C** — decide whether reasons are semantics or provenance, define the
  equivalence relation, answer the canonical-primary question. **No product code
  changed before this concluded.**
- **D** — simulate only the candidates C admits; freeze before confirmation.
- **E** — minimal repair if licensed.
- **F** — broad qualification, ceiling counterfactual, closure.

## Standing constraints

Do not raise `ORIENTATION_POLICY.ceilingTokens`. Do not widen the metadata
allowance. Do not reopen item rows in the serialized response (M180 measured that:
26 new `orientation → decline` pairs). Do not touch retrieval, ranking, candidate
generation or the fit contract. Do not run live agents. Stop after F.
