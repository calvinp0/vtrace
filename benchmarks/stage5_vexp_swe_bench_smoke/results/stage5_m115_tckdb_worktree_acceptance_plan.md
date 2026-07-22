# Stage 5 M115 TCKDB Worktree Indexing Acceptance Plan

## Scope and safety

This is a no-agent, no-API, no-Docker, no-VEXP acceptance test of the promoted
M114 implementation against the real TCKDB Git common directory and linked
worktrees. It will not edit TCKDB product source, alter an existing TCKDB
branch, push, delete an existing worktree or index, or overwrite the canonical
checkout's `.vtrace` directory. Raw absolute paths and protocol transcripts
remain local and unstaged; committed reports use the labels `<TCKDB_CANONICAL>`,
`<TCKDB_ESS_WORKTREE>`, `<M115_MAIN_WORKTREE>`, and `<M115_HEAD_CLONE>`.

## Pre-test answers

1. **Actual canonical checkout.** Safe discovery found the canonical checkout
   at `<TCKDB_CANONICAL>` (the raw absolute path is retained only in unstaged
   local diagnostics). It is on local `main`
   at `7ad5cb99a6212ceea89e140931c34e67f01c2126`, currently one commit behind
   `origin/main`, with a pre-existing untracked `paper/` directory.

2. **`git worktree list --porcelain`.** The common directory currently owns 17
   worktrees: the canonical main checkout; the ESS/Hessian worktree under the
   canonical root; and 15 temporary-root topic worktrees. Their raw paths,
   branches, and HEADs were captured in the local pre-test transcript. None
   will be removed or repurposed by M115.

3. **ESS/Hessian checkout.** `<TCKDB_ESS_WORKTREE>` is the clean linked
   worktree on `agent/ess-hessian-extraction`, tracking the corresponding
   origin branch, at `60617d404f1395207805a647b6870c2497118b00`. The earlier
   motivating `2221d73` state is no longer present; the report will describe
   the actual current state rather than rewrite history.

4. **Main checkout.** `<TCKDB_CANONICAL>` owns local `main`; no linked worktree
   currently owns `main` or is detached exactly at current `origin/main`
   (`b4d862feb9ae87ffe8167dd1817018da18fc615e` before the planned fetch).

5. **Suitable existing main worktree.** No. The canonical checkout is behind
   `origin/main` and contains unrelated untracked material. Existing topic
   worktrees must not be repurposed.

6. **Temporary main worktree.** After a narrow `git fetch origin`, create a
   detached linked worktree at `<M115_MAIN_WORKTREE>` from the fetched
   `origin/main`. The path must not already exist. This avoids branch ownership
   changes and keeps its `.vtrace` index physically separate.

7. **Existing index locations.** `<TCKDB_CANONICAL>/.vtrace` is the only
   existing `.vtrace` directory found among all registered roots. Its config,
   state, database, and `index.meta.json` all point to the canonical root. The
   manifest is legacy format v1, SHA-256
   `b605cc36309c7bd7d737f61f84a8517e2090545a025c0178c77012fa5831583d`,
   and records indexed HEAD `b4dd9eb01f789924626b3a81327c90e04f8106d5` and run 8.
   Every linked root currently has no index manifest or configured override.

8. **Manifest hashing.** Before every mutating scenario, enumerate registered
   worktree roots and hash each existing `.vtrace/index.meta.json` with
   `sha256sum`; also record whether `.vtrace/index.sqlite`, `config.json`, and
   `state.json` exist. Repeat after the call. The canonical manifest bytes,
   indexed HEAD, and directory inventory are compared directly. The temporary
   main manifest is separately hashed at each state transition.

9. **MCP refresh/reconnect.** Start a new process from this VTRACE checkout
   using `bin/vtrace mcp-serve --repo <TCKDB_CANONICAL>`, send MCP
   `initialize`, `notifications/initialized`, and `tools/list`, and keep that
   fresh stdio session for the fail-closed/callability checks. Restart the
   process after filesystem-state transitions where a clean reconnection is
   useful. This loads M114 source directly and bypasses any pre-existing client
   schema cache.

10. **Tool inspection.** Inspect the `tools/list` JSON-RPC result in the fresh
    process. Assert that `get_code_context`, `index_repo`, and
    `check_capsule_staleness` are simultaneously present and that
    `get_code_context.inputSchema.properties` contains `repo_root` and
    `auto_refresh`. Preserve only normalized schema evidence in the report.

11. **Exact calls.** Use newline-delimited JSON-RPC to the fresh server:
    `initialize`; `notifications/initialized`; `tools/list`; `tools/call` for
    `index_status` with `{"repo_root":"<root>"}`; and `tools/call` for
    `get_code_context` with the exact motivating task, explicit `repo_root`,
    `auto_refresh` (`never` then `if_stale`), `preset:"modify"`,
    `include_tests:true`, and `max_tokens:6000`. Use `tools/call index_repo`
    with the same explicit `repo_root` only when testing its same-session
    callability independently is necessary. CLI corroboration uses
    `bin/vtrace status <root> --json`; no CLI index call is needed because the
    acceptance target is MCP opt-in auto-refresh.

12. **Isolation proof.** Capture the canonical manifest bytes and SHA-256,
    canonical `.vtrace` file inventory, recorded worktree ID (if present), and
    indexed HEAD before refreshing the temporary main worktree. Compare all of
    them after every main-worktree refresh. Assert that the new main manifest
    names `<M115_MAIN_WORKTREE>`, uses the same repository ID but a distinct
    worktree ID, and lives only below that worktree root.

13. **Temporary modification restoration.** Create only
    `<M115_MAIN_WORKTREE>/m115_temporary_probe.py` with the specified two-line
    function, after confirming the path is absent. Hash/status before creation,
    verify `working_tree_changed`, then remove exactly that file and verify it
    is absent and Git status returns to its pre-probe state. If ignored, select
    another absent root-level `.py` name and document it.

14. **Safe cleanup.** Remove the probe file; use
    `git -C <TCKDB_CANONICAL> worktree remove <M115_MAIN_WORKTREE>`
    only for the M115-created clean worktree; remove the separate disposable
    clone at `<M115_HEAD_CLONE>` only after validating its exact path;
    leave all existing TCKDB worktrees and indexes untouched. A final
    `git worktree list`, status for the canonical and ESS roots, and path
    absence check prove cleanup. Any generated indexes disappear only with the
    M115-created temporary roots.

15. **Fix threshold.** Stop report-only execution if the fresh MCP schema is
    inconsistent, explicit `repo_root` resolves another worktree,
    auto-refresh indexes the startup root, canonical manifest bytes change,
    distinct roots collapse to one worktree ID, an indexable probe does not
    cause `working_tree_changed`, HEAD movement does not cause `head_mismatch`,
    or `nextTool=index_repo` is not callable in the same advertised session.
    Then document the exact failure before making the smallest focused VTRACE
    fix and regression test.

## Scenario sequence

1. Inspect canonical and ESS identities and legacy/missing manifest freshness
   without refreshing either root.
2. Fetch `origin` narrowly and create detached `<M115_MAIN_WORKTREE>` at the
   resulting `origin/main`.
3. Start a fresh MCP stdio process, inspect schemas, and run the default
   `auto_refresh:"never"` request against the temporary main root. Compare all
   manifest hashes to prove zero mutation and call `index_repo` only if needed
   to prove same-session truthfulness.
4. Run the exact request with `auto_refresh:"if_stale"`; record freshness,
   run, worktree identity, context/capsule summary, and canonical isolation.
5. Add the reversible probe, verify dirty freshness, opt in to refresh, remove
   it, verify the clean fingerprint is stale, and refresh the temporary main
   root once more to leave its index clean before removal.
6. Create a separate shared-object disposable clone at
   `<M115_HEAD_CLONE>`, detached at commit A. Index A, create a
   temporary source commit B only inside that disposable clone using per-call
   Git identity, verify `head_mismatch`, then opt in to refresh B. Compare both
   real-worktree manifest hashes throughout. No temporary commit is created in
   the actual TCKDB common directory.
7. Verify detached identity on the temporary main worktree, inspect a stale or
   missing response and its advertised tool truthfulness, then clean up all
   M115-only paths.
8. Write normalized Markdown/JSON/detail JSON reports, run VTRACE verification,
   stage only M115 reports plus the intentional milestone-ledger row, and
   commit locally on `main` without pushing.

## Expected verdict

PASS requires every stated success criterion, including byte-identical
canonical manifest evidence. Schema caching that requires an undocumented
full client reconnect yields MIXED. Wrong-root indexing, cross-worktree
overwrite, or a lying tool contract yields FAIL and triggers the fix threshold.
