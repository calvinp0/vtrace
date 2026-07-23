# M126 Hybrid Optimization Record

The optimized core preserves every frozen and TCKDB semantic output while
reducing exact-TCKDB warm median latency from 7,528.372 ms to 869.280 ms.

Implemented changes:

- one exact broad-symbol scan with per-row term-group memoization;
- request-local reuse of admitted broad rows;
- batched graph symbol materialization and same-directory reuse;
- indexed directional cross-file edge and fan-out queries.

No new index, schema version, persistent cache, ranking rule, score constant,
budget, role rule, pivot rule, decomposition rule, or rescue trigger was added.
An FTS substitution was measured, found non-equivalent, and reverted.

Verdict: **PASS**. Recommendation: **promote optimized hybrid core**.
