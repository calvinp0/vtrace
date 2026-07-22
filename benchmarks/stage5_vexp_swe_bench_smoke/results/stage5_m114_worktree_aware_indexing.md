# Stage 5 M114 Worktree-Aware Indexing

## Summary

- Problem: VTRACE collapsed legitimate index drift into `stale_index`, did not persist Git worktree ownership, failed to recognize linked-worktree `.git` files, and advertised a hidden `index_repo` tool.
- Change made: explicit repository/worktree identities and manifests, deterministic dirty fingerprints, precise freshness reasons, repo-root-aware MCP/CLI inputs, visible indexing tools, explicit default-off refresh, and per-worktree process locks.
- Default auto-refresh behavior: `get_code_context.auto_refresh` defaults to `never` and remains fail-closed.
- Verdict: **PASS**.
- Recommendation: **promote worktree-aware indexing**.

## Pre-change Audit

The complete 22-question audit is in `stage5_m114_worktree_indexing_plan.md`.

- Current index identity: implicit resolved filesystem root.
- Current storage: `<repo-root>/.vtrace/index.sqlite`, `state.json`, `config.json`, and `index.meta.json`.
- Current manifest: flat format/parser/indexer/config/HEAD metadata with no repository or worktree ownership.
- Current staleness behavior: source snapshot state was `fresh | possibly_stale | unknown`; `get_code_context` collapsed drift into `stale_index`.
- MCP exposure mismatch: `get_code_context` was visible while `index_repo` was callable only as a hidden legacy tool.
- Locking behavior: no operation-wide index lock.
- Migration constraints: legacy manifests cannot prove worktree ownership and require one explicit rebuild (or an explicitly permitted auto-refresh of the selected local root).

## Architecture

- Repository identity: canonical Git common directory plus a stable SHA-256-derived `repositoryId`.
- Worktree identity: repository id, canonical absolute worktree root, worktree-specific Git directory, and a stable SHA-256-derived `worktreeId`.
- Index key: existing worktree-local `.vtrace` storage, now guarded by the persisted repository/worktree ids. Linked worktrees therefore have separate databases and manifests by construction.
- Manifest: format v2 persists repository identity, worktree identity, HEAD/branch/detached state, dirty boolean/fingerprint, index run/time, parser fingerprint, schema version, and configuration fingerprint.
- Dirty fingerprint: sorted relevant Git status entries (staged, unstaged, deletes, renames, and untracked source) plus current content hash or a missing marker. Ignored/non-indexable paths, `.git`, `.vtrace`, and built-in generated directories are excluded.
- Locks: atomic `<worktree>/.vtrace/index.lock` directory with PID owner metadata. Same-worktree operations fail with `index_in_progress` (or `lock_timeout` when waiting); dead-process locks are recovered and reported. Different worktrees use different locks.
- Storage layout: the established worktree-local layout is retained, avoiding migration to a global database and ensuring one worktree cannot replace another worktree’s files.

Limitations: root symlinks are canonicalized; source symlink entries remain skipped by the scanner; filesystem case semantics follow the host; sparse checkouts fingerprint materialized files; submodules have no special recursive identity model.

## Implementation

- `src/indexer/worktreeIdentity.ts`: canonical identity, HEAD/branch/detached snapshot, and dirty fingerprint.
- `src/indexer/indexMeta.ts`: v2 manifest and discriminated freshness inspection.
- `src/indexer/worktreeIndexLock.ts`: recoverable per-worktree lock.
- `src/setup/repoState.ts`: recognizes linked-worktree `.git` files and canonicalizes roots.
- `src/setup/initRepo.ts`, `src/runtime/reindexRepo.ts`: shared manifest/lock enforcement.
- `src/mcp/tools.ts`: explicit roots, precise diagnostics, exposure contract, and auto-refresh policy.
- `src/cli/commands/indexCommand.ts`, `statusCommand.ts`: `--repo-root` aliases.
- Tests: `src/indexer/worktreeIdentity.test.ts`, `src/mcp/mcp.test.ts`, and `src/cli/cli.test.ts`.
- Smoke: `run_stage5_m114_worktree_index_smoke.ts` and its detail JSON.

APIs/schemas changed:

- `index_repo`: optional `repo_root`; visible in normal `tools/list`; returns lock diagnostics.
- `get_code_context`: optional `repo_root` and `auto_refresh: "never" | "if_stale"`.
- `check_capsule_staleness` and `index_status`: optional `repo_root`.
- CLI: `vtrace index --repo-root <worktree>` and `vtrace status --repo-root <worktree>`; positional syntax remains compatible. There is no existing CLI `context` command, so no new command architecture was added.

Legacy v1 `index.meta.json` is `manifest_invalid`; it is never accepted as fresh. A rebuild of the selected root writes v2 ownership. Repository/worktree mismatches are blocked from auto-refresh.

## Freshness Reasons

| Reason | Trigger | User-visible action | Automatic action |
| --- | --- | --- | --- |
| `fresh` | identity, schema/config, HEAD, and dirty fingerprint match | build context | none |
| `missing_index` | selected worktree DB/index absent | `call_index_repo` | create selected worktree index |
| `worktree_mismatch` | manifest worktree id/root/Git dir differs | `choose_worktree` | blocked |
| `repository_mismatch` | repository id/common dir differs | `choose_worktree` | blocked |
| `head_mismatch` | selected worktree HEAD advanced/changed | `call_index_repo` | incremental refresh |
| `working_tree_changed` | relevant dirty state/fingerprint differs | `call_index_repo` | incremental refresh |
| `index_schema_changed` | index/manifest/parser/indexer schema differs | `rebuild_index` | blocked for explicit rebuild |
| `configuration_changed` | scanner/index config differs | `call_index_repo` | incremental refresh |
| `manifest_invalid` | absent, legacy, unreadable, or malformed ownership manifest | `rebuild_index` | selected-root migration rebuild allowed |
| `index_in_progress` | same-worktree lock is active | `retry` | no concurrent refresh |
| `unknown` | reserved for an unclassifiable inspection failure | safe manual inspection | none |

## Worktree Isolation

- Main versus feature: same Git common directory produces the same repository id but different worktree ids and different `.vtrace` stores.
- Detached HEAD: accepted; `branch=null`, `detached=true`, and commit identity is persisted.
- Dirty worktrees: a freshly indexed dirty snapshot can be fresh; subsequent relevant changes produce `working_tree_changed`.
- Concurrent agents: one operation per worktree; separate worktrees can index concurrently.
- Orphaned indexes: not deleted during queries. Cleanup/prune is deferred.

## MCP Behavior

- Normal profile visibly exposes `get_code_context`, `index_repo`, and `check_capsule_staleness` together.
- No read-only profile exists in the current server, so no profile can truthfully expose context while hiding indexing.
- `nextTool=index_repo` includes the canonical selected `repo_root` and is emitted only in the normal callable profile.
- Default example: stale `/repo` returns `head_mismatch`, `refreshAttempted=false`, and fails closed.
- Opt-in example: `auto_refresh="if_stale"` refreshes only `/repo`, reports before/after states and run id, then returns context.
- A missing linked worktree index is created under that linked worktree; the canonical checkout manifest remains byte-identical.

## No-Agent Smoke

The smoke created temporary Git repositories and linked/detached worktrees. Results:

- same-root HEAD mismatch: PASS (`head_mismatch`)
- same-root dirty change: PASS (`working_tree_changed`)
- linked worktree missing isolation: PASS (`missing_index`)
- detached worktree identity: PASS
- default refresh disabled: PASS
- HEAD and dirty opt-in refresh: PASS (`fresh` after incremental refresh)
- missing feature worktree refresh: PASS (`fresh` after full initialization)
- same-worktree lock: PASS (`index_in_progress`)
- different-worktree lock concurrency: PASS
- visible tool trio: PASS

Evidence: `stage5_m114_worktree_index_smoke.detail.json`.

Verification completed with `bun run typecheck` (PASS), `bun run typecheck:benchmarks` (PASS), `bun test` (3,674 pass, 0 fail across 210 files), the no-agent smoke (PASS), and `git diff --check` (PASS).

## Fresh-Index Invariants

The smoke ran the same task against the same fresh index before and after a no-source-change reindex. Task hash, selected files, lead pivot, required files, optional files, and capsule mode were identical. Existing MCP parity coverage also confirms `get_code_context` delegates to the same retrieval pipeline modulo the expected freshness diagnostics. Retrieval/scoring/ranking code was not changed, so broad retrieval evaluations were not run.

## Deferred Work

- Orphaned worktree index pruning is deferred; no automatic deletion occurs.
- A shared immutable Git-blob parse cache is deferred because the current architecture has no separable cache facility; correctness uses isolated databases.
- Background file watching was explicitly not added.
- No new CLI context command was invented; MCP is the product-priority context surface.

## Success Criteria Check

1. PASS — no live agents, Docker, APIs, VEXP, baseline arms, V4/C7_D, or revision arms.
2. PASS — repository/worktree identities are distinct and persisted.
3. PASS — linked worktrees have separate logical/local indexes.
4. PASS — manifest ownership prevents cross-worktree freshness reuse.
5. PASS — precise missing/identity/HEAD/dirty/schema/config reasons.
6. PASS — visible/callable MCP exposure contract.
7. PASS — default remains fail-closed.
8. PASS — explicit opt-in refresh targets only the resolved worktree.
9. PASS — another worktree’s files/manifest remain unchanged.
10. PASS — worktree lock and deterministic concurrency tests.
11. PASS — deterministic dirty fingerprint tests.
12. PASS — legacy manifest is explicitly invalid and rebuildable.
13. PASS — fresh context invariant unchanged.
14. PASS — multi-worktree no-agent smoke.
15. PASS — typechecks, full tests, smoke, and diff check.

## Verdict

**PASS**

## Recommendation

**promote worktree-aware indexing**
