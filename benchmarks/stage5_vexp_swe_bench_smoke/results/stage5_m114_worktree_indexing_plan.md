# Stage 5 M114 Worktree Indexing Pre-change Audit

Date: 2026-07-22. Branch: `main`. Starting tip: `ca55588c` (`1eeacfe5` immediately before it). This audit was written before product-code edits.

## Pre-existing working-tree state

The starting worktree had modified `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_outcome_ledger.{md,json}` plus untracked `AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`, `package-lock.json`, ARC Stage 3/4 result trees, and many Stage 5 raw/generated result paths (`results/raw/`, `results/runs/`, `results/aggregate/`, streams, logs, prompt dumps, guard state, live reports, and related artifacts). Those paths are pre-existing and will not be modified or staged, except that the ledger pair must eventually receive the milestone record by explicit requirement. The new M114 plan/report/smoke files are deliberate outputs.

## 1–4. MCP tool assembly and exposure

1. The tool definitions are assembled in `src/mcp/tools.ts`: `LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN`, `RESERVED_MCP_TOOL_DEFINITIONS_UNFROZEN`, and `defaultMcpToolRegistry`. `src/mcp/registry.ts::createMcpToolRegistry` separates visible `tools` from callable-but-unlisted `hiddenTools`; `src/mcp/server.ts::createMcpServer` uses that registry.
2. `get_code_context` is `GET_CODE_CONTEXT_TOOL_DEFINITION`, the first member of `RESERVED_MCP_TOOL_DEFINITIONS_UNFROZEN`, so the default server always lists it.
3. `index_repo` is defined in `LEGACY_MCP_TOOL_DEFINITIONS_UNFROZEN`. The default registry puts legacy definitions in `hiddenTools` (except three legacy tools promoted separately), so `index_repo` is callable by direct id but absent from `tools/list`.
4. Yes. The default configuration exposes `get_code_context` without exposing `index_repo`. This exactly explains a client session that cannot discover the advertised next tool.

## 5–8. Root and current index identity

5. `src/mcp/tools.ts::resolveReadyRepoBinding` uses the fixed `McpServerContext.repoRoot`; `handleGetCodeContextRequest`/`checkIndexForGetCodeContext` accept no per-call root.
6. The server has a fixed startup root from `src/mcp/startServer.ts::createRepoBoundMcpServer`, derived by `src/setup/repoState.ts::detectRepoRoot`. There is no per-call root today.
7. `src/setup/repoState.ts::resolveRepoLocalPaths` determines storage as `<resolved repo root>/.vtrace/{config.json,state.json,index.sqlite}`; `src/indexer/indexMeta.ts::resolveIndexMetaPath` adds `<root>/.vtrace/index.meta.json`.
8. The mutable index is effectively keyed by the resolved repository-root filesystem path because the database is repo-local. It is not keyed by Git common directory, worktree Git directory, branch, project name, or an explicit logical id. A custom DB override can instead key it by database path. Crucially, `detectRepoRootMarker` only recognizes `.git` when it is a directory, so a linked worktree’s `.git` file is not a marker and nested calls can resolve incorrectly.

## 9–10. Persisted metadata

9. `index.meta.json` (`src/indexer/indexMeta.ts::IndexMeta`) persists index format, schema, VTRACE commit, indexer/parser/config fingerprints, repository HEAD, and creation time. `.vtrace/state.json` (`src/setup/types.ts::RepoLocalState`) persists the selected root/database, readiness, latest run and summary, last-index snapshot, observed file changes, and watcher state.
10. HEAD is `IndexMeta.repo_head` and `LastIndexSnapshot.lastIndexedHead`; index run is `RepoLocalState.latestRunId/latestRun`; dirty state is not explicitly persisted (only a source snapshot and watcher observations); parser/schema/config are `parser_fingerprint`, `schema_version`, `indexer_fingerprint`, and `config_hash` in `IndexMeta`.

## 11–15. Freshness and worktrees

11. Version/config/HEAD reuse is checked in `src/indexer/indexMeta.ts::checkIndexFreshness`. Runtime source drift is checked in `src/runtime/indexFreshness.ts::inspectIndexFreshness`. MCP front-door gating is `src/mcp/tools.ts::checkIndexForGetCodeContext`.
12. `inspectIndexFreshness` exposes only `fresh | possibly_stale | unknown` with low-level snapshot reasons. `formatIndexFreshnessDiagnostic` maps any `isStale` result to `stale_index`, and `checkIndexForGetCodeContext` emits only `missing_index | stale_index | repo_not_ready`. The richer index-meta checker is not used by this front-door gate.
13. Uncommitted changes are indirectly detected by `captureRepoSourceSnapshot`, which walks indexable files and fingerprints path + size + `mtimeNs`; watcher-recorded changes can also mark the state stale. `src/fs/git.ts::listGitStatusEntries` parses staged, unstaged, deleted, renamed, and untracked status but is not part of freshness.
14. Indexing scans the passed root and writes its local `.vtrace`. There is no explicit worktree identity or manifest ownership check. Linked worktree root detection is defective because `.git` is a file there.
15. Git common-dir state does not currently select storage, so it does not intentionally share indexes. However, the absence of explicit ownership plus bad linked-worktree root detection allows the wrong inferred root/database to be selected. M114 should retain per-worktree storage and make the identity explicit rather than introduce common-dir mutable storage.

## 16–18. Locking and indexing service

16. No indexing lock or mutex exists around `initRepo`, `reindexRepoAndRefreshState`, or `indexProject`. SQLite serializes individual writes, but a complete indexing operation and its adjacent manifest/state writes are not protected.
17. `src/indexer/indexProject.ts` reuses unchanged file content by content hash, persists run-to-run file/symbol states and diffs, and avoids reparsing unchanged files. This is existing incremental support inside one database.
18. Indexing can be invoked from `get_code_context` only through the shared service boundary. `src/runtime/reindexRepo.ts::reindexRepoAndRefreshState` is the appropriate shared operation after adding root resolution, initialization support, locking, and manifest writes; duplicating indexing logic in the handler would be unsafe.

## 19–20. Schema and migration surface

19. MCP inputs for `index_repo`, `get_code_context`, and directly freshness-dependent tools need optional `repo_root`; `get_code_context` also needs `auto_refresh: never | if_stale`. Outputs need precise freshness/refresh diagnostics. The existing CLI `index <repo>` and `status [repo]` already take positional roots; aliases such as `--repo-root` can be added without a new CLI architecture. There is no dedicated CLI context command today.
20. `index.meta.json` requires a version bump and worktree-aware manifest fields. `.vtrace/state.json` can remain backward compatible, optionally gaining manifest data if useful. Legacy metadata with no identity must never be accepted for a different linked worktree; safe policy is one explicit rebuild for the selected root, after which the new manifest is written.

## 21. Existing tests

Staleness is covered by `src/runtime/indexFreshness.test.ts`, `src/indexer/indexMeta.test.ts`, runtime status/reindex tests, and MCP tests near `src/mcp/mcp.test.ts` cases “index_status and run_pipeline diagnostics…”, “get_code_context returns fast stale envelope…”, and missing/recovery cases. Tool exposure/listing is covered throughout `src/mcp/mcp.test.ts`, but no invariant currently requires `index_repo` whenever `get_code_context` is visible. Index identity/worktree isolation has no focused test. `src/setup/initRepo.test.ts` covers ordinary root detection/config but not linked-worktree `.git` files.

## 22. Low-risk implementation sequence

1. Add a Git/worktree identity module with canonical paths, Git common/worktree directories, HEAD/branch/detached state, and deterministic dirty fingerprint.
2. Extend `IndexMeta` to a versioned worktree manifest while preserving explicit legacy reads; classify exact freshness reasons.
3. Fix linked-worktree root detection and keep storage under each worktree’s existing `.vtrace`, yielding natural isolation with stable logical ids.
4. Add a recoverable per-worktree lock around the shared indexing service, then make both init/reindex write the manifest under that lock.
5. Add per-call root resolution to MCP bindings, expose the coherent tool trio, and implement default-off auto-refresh using only the shared service and selected worktree.
6. Add focused identity/freshness/locking/MCP tests, then the temporary-repository no-agent smoke and fresh-output parity assertion.
7. Run typechecks/full tests/smoke/diff checks; write M114 report/JSON; commit product milestone; update the pre-existing ledger surgically and commit its milestone record.

## Constraints and documented edge behavior

The dirty fingerprint will cover indexable regular files after VTRACE ignore rules, combining Git status semantics with stable path/content data. Ignored/non-source files do not stale the index. Submodule contents are not recursively indexed by the current scanner; symlink entries are skipped; realpath canonicalization resolves root aliases; path case follows host filesystem semantics; sparse checkouts fingerprint only materialized indexable files. Orphaned-worktree pruning is deferred and must not occur during queries. No shared blob parse cache will be introduced because none exists as a separable compatible facility today.
