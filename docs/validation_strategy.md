# Validation Strategy

Date: 2026-05-19

This document defines how `vtrace` should be validated for RC and future retrieval/indexing work without overfitting to one stress-test repository.

## Core Principle

ARC is a real-repo stress test, not the product target.

Validate against ARC because it is complex, realistic, and capable of exposing indexing, retrieval, capsule-shaping, and workflow gaps. Do not turn ARC into the destination. Production code must not contain ARC-specific heuristics, constants, ranking shortcuts, or special cases.

`vtrace` is validated as deterministic lexical/structural local tooling. RC validation should preserve that product truth and should not imply full VEXP parity, semantic memory, automatic reindexing, or learned ranking. Persistent V-REFs are repo-local stored-truth records with bounded retention, not semantic reconstruction or permanent global references.

## Anti-Overfit Rules

- Do not add ARC-specific constants or special cases to retrieval, ranking, indexing, capsule, memory, or rule-selection code.
- ARC-specific terms may appear only in benchmark/query fixtures, validation reports, or docs that explicitly identify ARC as a benchmark.
- Every ARC-motivated implementation change must be justified as a general-purpose improvement that applies to other repositories.
- Prefer synthetic fixtures for unit tests, especially for exact symbol lookup, stale state, V-REF behavior, and project-rule behavior.
- Use ARC for real-repo validation, not as the only test.
- Preserve TypeScript and generic Python behavior when improving ARC outcomes.
- Do not tune ranking solely to one repo's filenames, symbol names, package layout, or domain vocabulary.
- Classify ARC failures before implementing fixes; not every ARC miss is an RC blocker.
- Keep accepted RC limitations explicit instead of masking them with benchmark-specific behavior.

## Benchmark Categories

Validation should cover these categories:

- TypeScript product repo
- Python package repo
- mixed Python/Cython repo
- exact-symbol lookup fixture
- broad workflow-query fixture
- file/symbol diff and stale-memory fixture
- V-REF/deferred expansion fixture
- project-rules fixture

Each category should have at least one expected behavior that is independent of ARC. ARC can supplement these categories as a realistic stress case, but it should not replace smaller fixtures.

## Query Categories

Validate queries across these categories:

- exact symbol/API lookup
- workflow tracing
- concept/domain lookup
- file/module discovery
- Python/Cython boundary lookup
- ambiguous/stress queries
- impact graph queries
- memory/rule queries

For each query category, record whether the expected behavior depends on parser/frontend support, retrieval/reranking, capsule shaping, memory/rule evidence, or an accepted limitation.

## Success Criteria

General success criteria:

- Results are deterministic across repeated runs with the same repo state and query.
- Relevant candidates appear near the top for exact and structurally supported queries.
- Source-backed capsule pivots are useful when the index can provide relevant evidence.
- Failures are classified as parser/frontend, retrieval/reranking, capsule shaping, or accepted limitation.
- Improvements do not regress non-target fixtures.
- Production code contains no codebase-specific heuristics.
- Validation reports distinguish evidence-backed behavior from aspirational future behavior.

RC success does not require every broad or ambiguous query to produce perfect results. It requires honest deterministic behavior, useful source-backed pivots where possible, stable schemas, clear limitations, and no benchmark-specific product logic.

## ARC Usage Policy

Use ARC to validate real-world complexity:

- ARC can expose gaps in parsing, symbol discovery, retrieval, capsule shaping, and workflow-query handling.
- ARC validation reports should classify gaps before code changes are proposed.
- ARC findings should not automatically trigger implementation work.
- ARC-motivated work must be restated as a general-purpose improvement and validated outside ARC.
- ARC readiness can remain "ready with known limitations."

Acceptable ARC outcomes include documented misses caused by known RC limitations, unsupported parser behavior, missing semantic retrieval, or intentionally bounded structural behavior. Do not hide those misses behind ARC-specific constants or ranking rules.

## Post-RC VEXP Alignment Without ARC Overfitting

The following are possible post-RC, general-purpose milestones. They are not required before RC:

- persistent V-REF store (implemented for single-repo stored-truth expansion with bounded repo-local retention)
- optional auto-reindex mode
- module-level symbol indexing (implemented for conservative Python top-level assignments)
- Python references extraction
- Python member/attribute resolution
- inherited-member and `super()` resolution
- broader generic retrieval/reranking benchmarks
- VS Code panel polish

Each future milestone should ship with generic fixtures and at least one non-ARC validation target. ARC may remain a stress test for the milestone, but it should not define product behavior by itself.
