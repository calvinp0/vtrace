# Stage 5 M118 Incremental Worktree Indexing

## Summary

- Previous behavior: every refresh scanned, read, parsed, persisted, and linked every file. Linked worktrees had isolated graphs but could not share parsing work.
- Implementation: manifest v3 adds per-file snapshots and diagnostics; a repository-scoped immutable parse cache is shared through the canonical Git common directory; compatible unchanged parse results are reused; graph/retrieval state remains worktree-local.
- Correctness result: every measured incremental/no-op result had the same normalized graph and retrieval rows as a clean full rebuild. Parse, persistence, and validation failures preserve the prior graph.
- Performance result: Python one-file refresh improved from 558.513 ms to 45.423 ms (12.30x) while parsing 1/24 files. TypeScript is dominated by discovery/cache/full persistence: body-change timings ranged from neutral to 1.19x, no-op was 1.93x, and the linked one-file case reused 79/80 parses but was timing-neutral (0.94x).
- Verdict: **MIXED**.
- Recommendation: **promote parse cache but defer graph incrementality**.

The result is MIXED rather than PASS because parsing is incremental but graph persistence and linking remain deliberately full-worktree. That conservative design is necessary while unresolved imports/references are represented only by omission.

## Pre-change Audit

The detailed 35-question audit is in `stage5_m118_incremental_indexing_plan.md`. The existing phases were scanner discovery/hash, UTF-8 reads, parser-registry construction, per-file parsing/symbol extraction, file-local persistence/FTS, deferred cross-file edge filtering/insertion, and run-history snapshots.

All files passed through scan, read, parse, persistence, and run snapshots. TypeScript uses tree-sitter; Python and Cython launch interpreter helpers per file. Parser output is not byte-only: path-derived file/symbol/FQ/edge IDs and complete-known-file import/module resolution make the current `ParseResult` both path-sensitive and neighbor-sensitive. Python/Cython parsing was the dominant representative cost; the measured Python full parse took 558.513 ms versus 45.423 ms with one miss.

Storage before M118 was worktree-local `.vtrace/index.sqlite` plus manifest/config/state. `files`, `symbols`, `edges`, `symbol_search_fts`, and `symbol_body_literals_fts` hold the live graph/retrieval state. Imports, calls, references, and contains are edge types. There are no persisted unresolved-reference or standalone export tables. File/symbol deletes cascade to edges; FTS deletion is explicit. M114 already supplied per-worktree atomic locks.

## Architecture

### Shared parse cache

Git repositories store immutable entries below the canonical common directory:

```text
<git-common-dir>/vtrace/repositories/<repository-id>/
  parse-cache/<parser-id>/<parser-version>/<prefix>/<cache-key>.json
  snapshots/<worktree-id>.json
```

Non-Git repositories use the equivalent repository namespace below their local `.vtrace`. Cache writes use a same-directory temporary file and atomic rename. Readers validate schema, key inputs, payload hash, path, language, and content hash. Partial/corrupt entries are ignored and regenerated. Concurrent identical writers can only expose complete immutable envelopes.

The cache key includes SHA-256 content hash, Git blob SHA for clean tracked files, content kind, parser ID/fingerprint, parser configuration fingerprint, language, normalized relative path, and the binding-context hash. Dirty/untracked files use the working-tree content hash. Relative path prevents unsafe rename reuse of path-bound symbol IDs.

### Worktree graph isolation

Each worktree retains its own `.vtrace/index.sqlite`, manifest, state, FTS tables, and run history. The shared registry contains immutable snapshot metadata, never a mutable database. M118 does not clone graph snapshots.

### File snapshot and planner

Manifest v3 persists sorted per-file path/language/content identity/parser/config/cache-key/size records plus file count, canonical snapshot hash, binding-context hash, graph schema, and retrieval schema. The planner deterministically classifies add/modify/delete/same-content rename and emits `noop`, `incremental`, or `full_rebuild` before mutation.

The binding-context hash covers file membership and path-bound symbol identity, FQ name, kind, signature, export state, parent identity, plus package entrypoint content. A modified-only refresh first parses changed files and combines them with cached unchanged results. Reuse proceeds only when that combined binding surface equals the prior snapshot.

### Graph invalidation and dependency closure

M118 never appends changed rows to an old graph. Every mutating refresh deletes and rebuilds the complete live files/symbols/edges/FTS set inside one transaction, using cached parse results where safe. This removes old symbols, exports, incoming/outgoing edges, body literals, and retrieval rows without ghost state.

Modified files are the selective parse closure only when IDs/signatures/exports/package surfaces remain stable. Structural change, add/delete/rename, `__init__.py`/index entrypoint change, or uncertain unresolved closure triggers a full parse/relink. Added files therefore reconsider every old unresolved import during fallback; deleted targets leave no incoming ghost edge. This is safe but is not selective cross-file graph invalidation.

### Transaction and rollback

The complete graph replacement, cross-file insertion, graph validation, and run snapshot are inside one SQLite transaction. A changed-file read/parse failure aborts before mutation. Persistence or validation failure rolls back. A validation failure is retried as a clean full rebuild when safe and reports `graph_validation_failed`; another validation failure is surfaced rather than silently accepted.

Validation checks file count, edge endpoints, and retrieval references; normalized equivalence additionally covers sorted files, symbol semantics/spans, edges, symbol FTS, and body-literal FTS.

## Incremental Modes

- `noop`: compatible per-file snapshot unchanged; parses zero files and rewrites zero live graph/retrieval rows. A run-history snapshot is still appended to preserve existing `runs` and capsule-staleness API behavior.
- `incremental`: changed files parse; unchanged compatible entries are read from the repository cache; the complete isolated graph is transactionally reassembled/relinked.
- `full_rebuild`: bypasses prior graph reuse and reparses all current files.

Precise reasons include `schema_incompatible`, `parser_incompatible`, `configuration_incompatible`, `snapshot_missing`, `snapshot_invalid`, `closure_uncertain`, `change_set_too_large`, `graph_validation_failed`, and `repository_mismatch`.

The measured TypeScript-100 crossover was at 20%: 20%, 30%, and 50% full-fallback timings confirmed full was faster. The default policy therefore chooses full at 20% for TypeScript/JavaScript repositories of at least 20 files. Tiny repositories are not gated on noisy ratios. Python/Cython retain a parse-count cost policy because the measured Python parse cost dominated (12.30x at 1/24 changed); all-files-changed always selects full.

## Worktree Reuse

Candidates must share repository identity and compatible parser/config/snapshot schemas. Selection prefers exact HEAD, then maximum shared `(path, content)` entries; it never uses branch name. Exact-commit and detached linked-worktree tests parsed zero files with full cache reuse. A nearby linked worktree with one dirty TypeScript file parsed 1/80 files, hit 79 cache entries (98.75%), produced the same graph as a full rebuild, and left the main manifest/database byte/graph unchanged.

## Correctness and Equivalence

`normalizeGraph` excludes run IDs/timestamps/temporary absolute paths and hashes canonical files, symbols, semantic edges, symbol-search rows, and body-literal rows. All ten timed measurements matched clean full rebuilds and all retrieval row sets matched.

The no-agent smoke matrix covers A–O. Body/no-op/worktree/rollback/cache cases run dedicated integration tests; add/delete/rename/package/parser incompatibility use conservative full fallbacks plus planner/graph tests. Existing deterministic retrieval/capsule tests passed in the full suite, and normalized graph plus retrieval parity means incremental and full feed identical capsule inputs. No retrieval scoring, ranking, candidate generation, task derivation, pivots, packing, or digest wording changed.

## Performance

| repository/scenario | mode | parsed | hits | incremental ms | full ms | speedup |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript-120, one body file | incremental | 1/120 | 119 | 47.195 | 45.174 | 0.96x |
| Python-24, one body file | incremental | 1/24 | 23 | 45.423 | 558.513 | 12.30x |
| TypeScript-100, no change | noop | 0/100 | 0 | 20.970 | 40.509 | 1.93x |
| TypeScript-100, 5% | incremental | 5/100 | 95 | 33.586 | 39.168 | 1.17x |
| TypeScript-100, 10% | incremental | 10/100 | 90 | 36.759 | 39.388 | 1.07x |
| TypeScript-100, 20% | full fallback | 100/100 | 0 | 39.775 | 38.427 | 0.97x |
| linked TypeScript-80, one dirty file | incremental | 1/80 | 79 | 44.180 | 41.687 | 0.94x |

The parse optimization is material for interpreter-backed parsers but graph persistence and duplicate scanning/fingerprinting dominate small TypeScript fixtures. No claim of universal 2x speedup is made. VTRACE itself was not benchmarked in place because that would create repository-shared cache data below the live `.git`; the synthetic fixtures exercise the same product pipeline without violating the generated-cache rule.

## MCP and CLI

`index_repo` accepts `mode: auto | incremental | full` (default `auto`) and returns performance diagnostics. CLI `vtrace index` accepts `--mode` and its JSON includes the additive snapshot/performance fields; human output prints selected mode, hits/misses, parsed files, closure, and fallback. `get_code_context(auto_refresh="if_stale")` attaches the actual selected performance diagnostics. Index status reads them from manifest v3.

Legacy/v2 manifests cannot establish a safe per-file base and receive one full rebuild, after which manifest v3 is incrementally refreshable.

## Concurrency

M114 same-worktree locking remains unchanged. Different worktrees keep different locks and databases while concurrently reading/creating shared immutable entries. Tests cover same-worktree exclusion, different-worktree progress, concurrent identical cache creation, partial/corrupt rejection, detached identity, and source-worktree isolation.

## Deferred Work

- Path-independent syntax IR plus path/module localization.
- Persisted unresolved import/reference descriptors and a truly selective affected graph closure.
- Copy-on-write graph snapshot seeding.
- Reachability/age parse-cache pruning. Immutable orphan entries are safe but consume disk.
- Background watcher (explicitly not implemented by M118).
- Submodule and sparse-checkout-specific discovery/base selection.

## Success Criteria Check

1. PASS — prohibited live/API/Docker/VEXP/environment actions were not run.
2. PASS — repository-scoped immutable parse cache.
3. PASS — worktree-local graph/manifest.
4. PASS — manifest v3 per-file snapshots.
5. PASS — no-op parses zero and rewrites zero live graph rows.
6. PASS — stable body changes parse only changed/cache-miss files.
7. PASS — transactional full graph replacement removes stale rows.
8. PASS for safety — stable binding uses bounded parse closure; uncertainty broadens to full.
9. PASS by full fallback — added files reconsider omitted unresolved imports.
10. PASS — rename/delete leave no ghost state.
11. PASS — linked worktree cache reuse measured at 98.75% for one dirty file.
12. PASS — source manifest and graph unchanged.
13. PASS — all measured normalized graphs equivalent.
14. PASS — retrieval rows equivalent; deterministic capsule suite green.
15. PASS — uncertainty/large change reasons are precise.
16. PASS — same-worktree lock serialized.
17. PASS — cross-worktree immutable sharing/races tested.
18. PASS — legacy format bump forces one rebuild.
19. PASS — MCP/CLI/manifest diagnostics visible.
20. PASS for representative parser-heavy changes; not universal — Python 12.30x, TypeScript body changes were modest/neutral while no-op reached 1.93x.
21. PASS — `bun run typecheck`, `bun run typecheck:benchmarks`, `bun test` (3,723/3,723), and `git diff --check` completed successfully.

## Verdict

**MIXED**

Shared parse-cache reuse is correct and provides meaningful parser-heavy speedup, but selective cross-file graph mutation is intentionally deferred and every mutation still performs a full worktree graph replacement/relink.

## Recommendation

**promote parse cache but defer graph incrementality**

The next increment should persist path-independent local IR and unresolved descriptors, then implement and prove a truly selective cross-file closure before changing the verdict to PASS.
