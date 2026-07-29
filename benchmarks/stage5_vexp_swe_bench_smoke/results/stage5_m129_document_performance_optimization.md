# M129 Document Retrieval Optimization

Dominant cause: benchmark_measurement_mismatch.

Implemented:
- optional M128 stage timings and counters
- single batched document-chunk lookup
- request-local normalized path metadata and task tokens
- memoized path-objective affinities
- early mixed-coverage skip without path clues
- profiling-only deterministic document-lane trigger/skip diagnostics

Cache policy: request-local metadata reuse only; no persistent or result cache.

Semantic risk: low; existing scoring constants, ordering rules, bounds, and packing are unchanged.
