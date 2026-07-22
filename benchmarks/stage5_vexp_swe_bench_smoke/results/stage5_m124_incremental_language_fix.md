# M124 Incremental Indexing Unsupported-Language Compatibility

## Summary

- Incident: `frontend/eslint.config.js` was detected as indexable JavaScript, but the default registry had no JavaScript parser. M118 made that pre-existing tolerated result fatal whenever a previous snapshot was supplied.
- Root cause: detection/registry capability drift, indexed-only file snapshots, and a blanket fatality check keyed to `previousSnapshot` rather than file outcome.
- Language-support decision: Decision B. JavaScript and JSX are recognized source-like languages but unsupported parser capabilities. They are skipped honestly; VTRACE does not claim to index them.
- Implementation: snapshot schema v3 stores indexed and tolerated-skip outcomes; registry capability is fingerprinted; full and incremental modes share one fatality policy; full is an independent graph rebuild; CLI/MCP retain path-rich diagnostics.
- Verdict: **MIXED** because compatibility is fixed and verified, but JavaScript/JSX remain explicitly unsupported.
- Recommendation: **promote incremental compatibility fix**. Add a real JavaScript parser separately only with a distinct adapter, dependency, extraction contract, and JS/JSX tests.

## Pre-change Audit

### Language detection

Detection recognized `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.pyx`, `.pxd`, and `.pxi`. The default registry registered TypeScript, Python, and Cython. JavaScript/JSX was the only mismatch; Go and Rust exist in the domain enum but are not detected.

The TypeScript adapter rejects `Language.JavaScript`, selects the TypeScript grammar for non-`.tsx` input, and selects TSX only for `.tsx`. It has no JavaScript module/CommonJS/JSX-mode contract. `tree-sitter-javascript` exists only as a transitive lockfile dependency and no VTRACE adapter uses it.

### Parser registry

The registry now exposes its sorted registered-language capability. A consistency test proves every advertised indexable language is registered and proves JavaScript is not advertised as indexable. Detected-but-unsupported JavaScript remains discoverable so it can be snapshotted and diagnosed.

### Full-index policy

Before M118, full indexing recorded unregistered, unsupported, parse, read, and per-file persistence outcomes and continued. This was overly broad. M124 narrows tolerated outcomes to unavailable optional capability only. A parser that claims support but rejects a file is fatal, as are read failures.

### Incremental policy

M118 aborted whenever `previousSnapshot` existed and any current file was unreadable or had any result other than `indexed`. That made `unregistered_language` fatal and also affected explicit full mode.

### Snapshot behavior

Snapshot schema v2 recorded only successfully indexed files. Unsupported files were scanned but absent, so they appeared newly added on every compatible comparison and could not be carried forward. Registry composition was not explicit, and `languageDetection.ts` was absent from configuration hashing.

### Diagnostic loss

`ParserError` and `IndexedFileSummary` already retained path, language, status, and message. The blanket abort replaced those records with a generic message before CLI/MCP formatting.

## Language-Support Decision

- JavaScript: recognized, parser unavailable, tolerated skip, no indexing-support claim.
- JSX: recognized, parser unavailable, tolerated skip, no JSX-support claim.
- Parser capability: default registered languages are TypeScript, Python, and Cython.
- Honest limitations: the TypeScript parser was not reused; a transitive JavaScript grammar was not treated as a supported product dependency; no `javascript -> typescript` alias was added.

## File Outcome Model

- Indexed: parser capability exists and parse/persistence succeeds. The file is present in the graph and snapshot.
- Skipped: `unregistered_language` and `unsupported_language` are nonfatal, absent from the graph, and present in the snapshot with an explicit diagnostic.
- Failed: `read_failed` and `parse_failed` are fatal before graph mutation. Paths, languages, statuses, and diagnostics remain available.
- Always fatal: persistence/transaction, manifest write, schema/compatibility invariants, graph validation, repository/worktree mismatch, and internal invariant failures.

Tree-sitter syntax diagnostics returned with a successful parse remain attached to an indexed file. They are not relabeled as unsupported. Ignored/generated-directory/unrecognized-binary paths remain outside the discovered source-candidate snapshot.

## Manifest and Compatibility

File snapshot schema v3 records every detected source candidate. Indexed entries retain content identity, language, parser ID/version/config, binding context, and parse-cache key. Skipped entries retain content identity, language, `indexOutcome=skipped`, `parserCapability`, and diagnostic category/message.

The snapshot stores a deterministic registry-capability fingerprint. A capability change makes the previous snapshot incompatible and forces a safe full rebuild. `src/fs/languageDetection.ts` now contributes to the configuration fingerprint. Index manifest format is 4. Legacy v2 file snapshots are not guessed or partially migrated; they trigger a complete rebuild.

Reconsideration occurs on registry capability, language-detection/config, parser implementation/config, extension/language, or relevant content identity changes.

## Full Mode

`mode=full` always selects `full_rebuild`, reparses/evaluates every current candidate, and transactionally rewrites files, symbols, edges, both FTS tables, and run state. `previousGraphSnapshotUsedForMutation=false` is explicit in diagnostics. A supplied prior snapshot cannot activate incremental-only fatality or unchanged-file carry-forward.

Full mode may reuse compatible immutable parse-cache entries, but always rebuilds every graph/FTS row transactionally. Fixture tests prove cached parse reuse does not turn full into delta mutation. Unsupported files are re-evaluated rather than carried from snapshot state.

## Incremental Mode

- Known unchanged unsupported file: outcome is carried forward without parse or failure.
- Newly added unsupported file: evaluated under the same policy as a clean full index, snapshotted as skipped, and does not abort.
- Support becomes available: registry fingerprint changes, forcing re-evaluation; the regression adapter test proves the previously skipped `.js` file becomes indexed.
- Deletion/rename: old skipped entries disappear and renamed/new paths receive the current outcome.
- Supported edit: only the changed supported file is parsed when semantic closure remains safe; skipped outcomes are carried.

## Diagnostics

### CLI

Successful indexing prints skipped paths with language, status, and parser diagnostic. Fatal file failures print a bounded list (20 entries, then omitted count) with the same fields. JSON success output retains every structured file record.

### MCP/JSON

`index_repo` now returns `fileOutcomes` containing structured indexed/skipped records. Parser failures return `reason=file_index_failed` with complete structured failure records. Aggregate state counters remain available.

### Successful warnings

TCKDB-shaped output includes:

```text
done: 959 parsed, 1 skipped, 0 failed
- frontend/eslint.config.js — javascript/unregistered_language — No parser registered for language: javascript
```

### Fatal errors

Parse, read, persistence, transaction, and graph validation errors are not converted to skips. Persistence and validation injection tests prove transaction rollback preserves the previous graph.

## Full/Incremental Equivalence

The M124 smoke fixture contains `src/app.py`, `src/helper.ts`, and `frontend/eslint.config.js`. It performs clean full, incremental no-op, one supported edit, clean full comparison, and explicit full with a previous snapshot.

The following comparisons are equal:

- file snapshot entries and skipped outcomes;
- graph files and symbols;
- edges;
- symbol-search FTS and body-literal FTS rows;
- normalized graph hash;
- retrieval-index hash;
- representative `helper` retrieval result.

Fixture normalized graph hash: `2e1319d94eded7ed3c20122ec08a3fc0f0b8adc8d4ed181aec66e287870c775d`.

Fixture retrieval-index hash: `6240f1867c40f44102959235b7ba2d1cd9ccfa8daf6e28fbc027592569fb4610`.

Measured fixture runs:

| Run | Parsed | Carried unsupported | Cache hits/misses | Total latency |
| --- | ---: | ---: | ---: | ---: |
| Clean full | 3 | 0 | 0/3 | 28.56 ms |
| Incremental supported edit | 1 | 1 | 1/1 | 6.31 ms |
| Incremental no-op | 0 | 1 | 0/0 | 1.93 ms |
| Explicit full with prior snapshot | 1 | 0 | 2/1 | 4.83 ms |

These are smoke measurements, not a performance claim.

## Real TCKDB Acceptance

- Source worktree: `<home>/code/TCKDB_v2` at `70ff50381f42551a825d75874ea2d70f6dbe08ec` on `main`.
- Pre-existing source dirt: untracked `paper/` only.
- Previous index: manifest format 2, run 12, indexed HEAD `3ecc25df3bd0e770facacd9fcb3fed22b48bb7b0`.
- Safety: a complete `.vtrace` archive was captured before acceptance. The managed environment denied mutation of original TCKDB `.vtrace` under the read-only constraint, so acceptance used a local clone with a byte-for-byte copy of run-12 state. The original before/after archive SHA-256 is identical: `6f163628c7723bda093fa6e53f5a65ce4fc640f778f387017a19284ef28b9326`.
- Incremental result: requested incremental advanced copied run 12 to 13. Compatibility correctly selected `full_rebuild` because parser/manifest capabilities changed. It discovered 960, indexed 959, skipped 1, and had zero parse/read/persistence failures. Validation passed.
- Incremental no-op: run 14 parsed 0 and carried 1 unsupported outcome.
- Full result: run 16 selected `full_rebuild`, reused 959 compatible immutable parse-cache entries, parsed/re-evaluated the one unsupported candidate, indexed 959, skipped 1, rebuilt every graph/FTS row, validated the graph, and reported `previousGraphSnapshotUsedForMutation=false`.
- JavaScript: `frontend/eslint.config.js` is absent from the graph and present in snapshot schema v3 as `skipped`, `unregistered`, with its Git blob/content identity and diagnostic.
- Full graph: 959 files, 23,096 symbols, 47,780 edges, 23,096 symbol-search FTS rows.
- Full snapshot hash: `cd5768bfd599029b90014f8066fe84e34b6729fd93c41532bfeb2f55c0f2a420`.
- Full normalized graph hash: `b3c25b26fab8bf5586b8f376bef551f7cfda167e29c1daaddbbb8f2508c4c673`.
- Full retrieval-index hash: `c9e6ca0721eab637f8fd5fa7217e205b974d1b9875c8178d6edfb8312cc561bc`.
- Product retrieval: the exact M123 query executed with Capsule v2 and `productContext.resolved=true` against run 15 (the same snapshot/graph later rebuilt as run 16). Relevant support included `PublicRefMixin.public_ref`, `_reproducibility_summary`, and `ReproducibilityAssessmentSummary`. Lead-pivot quality remains a separate M125 concern.

The compatibility blocker is removed. The original TCKDB state intentionally remains at run 12 because original-state mutation was denied; the run chain advanced in isolated copied state only.

## Limitations and Deferred Work

- JavaScript and JSX parsing remain unsupported. Adding a real adapter requires a direct dependency, distinct parser identity, JS module/CommonJS extraction tests, and separate JSX proof.
- The exact TCKDB retrieval executed, but its lead-pivot quality and 66-second context latency are deferred to M125 TCKDB retrieval/latency acceptance.
- Cross-repository intelligence remains M126.
- Explicit full currently reparses all candidates rather than reusing immutable parse cache entries. This is correct but leaves a safe optimization opportunity.

## Success Criteria Check

1. PASS — mismatch is proven.
2. PASS — JavaScript/JSX status is honest.
3. PASS — one file-outcome policy applies to full and incremental modes.
4. PASS — known unsupported file does not fail refresh.
5. PASS — newly added unsupported file follows full policy.
6. PASS — storage/transaction/validation failures remain fatal.
7. PASS — skipped source candidates are persisted with content/capability/diagnostic state.
8. PASS — registry capability changes force re-evaluation.
9. PASS — full performs complete graph rebuild.
10. PASS — full reports no previous-snapshot graph mutation.
11. PASS — CLI errors include paths and diagnostics.
12. PASS — successful skips are reported.
13. PASS — fixture full/incremental graphs, FTS, snapshots, and retrieval are equal.
14. QUALIFIED PASS — copied TCKDB run 12 advanced to 13/14/15/16; original state remains run 12 by read-only policy/environment denial.
15. PASS — original run 12 and its exact archive checksum remain intact; rollback tests pass.
16. PASS — exact product retrieval executes and resolves against refreshed copied state.
17. PASS — `bun run typecheck`, `bun run typecheck:benchmarks`, 3,752 tests across 222 files, smoke, and `git diff --check` pass.
18. PASS — no live agents, APIs, Docker, VEXP, paid benchmarks, or TCKDB source changes occurred.

## Verdict

**MIXED**

The compatibility failure is fixed, full/incremental semantics are consistent, and real TCKDB-shaped indexing/retrieval is unblocked. JavaScript and JSX remain explicitly unsupported, and original TCKDB state could not be advanced under the enforced read-only constraint.

## Recommendation

**promote incremental compatibility fix**

Do not claim JavaScript support. Consider a separately scoped real JavaScript parser only after the adapter and JSX distinction are proven.
