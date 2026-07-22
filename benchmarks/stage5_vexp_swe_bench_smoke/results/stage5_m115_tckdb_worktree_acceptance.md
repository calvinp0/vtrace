# Stage 5 M115 TCKDB Worktree Indexing Acceptance

## Summary

- The actual TCKDB repository had 17 registered worktrees sharing one Git
  common directory. The canonical checkout owned `main`; a separate clean
  linked checkout owned `agent/ess-hessian-extraction`; no clean detached
  current-`origin/main` worktree existed.
- All ten acceptance scenarios completed without a coding agent, API call,
  Docker, VEXP, benchmark arm, environment change, TCKDB source edit, or TCKDB
  push.
- No VTRACE defect was found. M115 made no VTRACE source, test, helper,
  retrieval, ranking, or baseline change.
- **Verdict: PASS.** M114 behaves correctly in the real linked-worktree setup
  that motivated it.
- **Recommendation: promote M114 without qualification.**

Private absolute paths are normalized to `<TCKDB_CANONICAL>`,
`<TCKDB_ESS_WORKTREE>`, `<M115_MAIN_WORKTREE>`, and `<M115_HEAD_CLONE>`.

## Pre-test State

- Canonical checkout: local `main`, HEAD
  `7ad5cb99a6212ceea89e140931c34e67f01c2126`, one commit behind current
  `origin/main`, with a pre-existing untracked `paper/` directory. VTRACE's
  indexable-source fingerprint correctly treated that directory as irrelevant:
  `dirty=false`, fingerprint `null`.
- ESS/Hessian checkout: clean `agent/ess-hessian-extraction`, HEAD
  `60617d404f1395207805a647b6870c2497118b00`. The motivating older `2221d73`
  state was no longer present, so the acceptance recorded the real current
  layout.
- Current `origin/main` after the required fetch:
  `b4d862feb9ae87ffe8167dd1817018da18fc615e`.
- Git common directory: one canonical directory shared by all 17 registered
  worktrees.
- Existing indexes: only `<TCKDB_CANONICAL>/.vtrace` existed. Its legacy v1
  manifest SHA-256 was
  `b605cc36309c7bd7d737f61f84a8517e2090545a025c0178c77012fa5831583d`,
  run 8, indexed HEAD `b4dd9eb01f789924626b3a81327c90e04f8106d5`.
- Fresh MCP stdio restart: protocol `2024-11-05`, 14 visible tools. The same
  session exposed `get_code_context`, `index_repo`, and
  `check_capsule_staleness`. `get_code_context` advertised both `repo_root`
  and `auto_refresh` in its input schema. No stale client schema cache appeared.

## Default Fail-Closed Test

The exact motivating request used explicit `<M115_MAIN_WORKTREE>`,
`auto_refresh:"never"`, `preset:"modify"`, `include_tests:true`, and
`max_tokens:6000`.

- Canonical legacy index: `resolved:false`, precise reason
  `manifest_invalid`, action `rebuild_index`, no refresh attempted.
- New detached main worktree: `resolved:false`, precise reason
  `missing_index`, action `call_index_repo`, no refresh attempted.
- The selected root and requested HEAD were explicit and correct.
- `nextTool` was `index_repo` with that exact worktree root, and `index_repo`
  was present in the same tool list.
- No temporary-main `.vtrace` directory existed afterward. The canonical
  manifest hash was unchanged.

## Explicit Auto-Refresh Test

- Before: `missing_index`.
- Refresh: explicit `auto_refresh:"if_stale"`, full initialization of only
  `<M115_MAIN_WORKTREE>`.
- After: `fresh`, `refreshAttempted:true`, run 1, indexed HEAD
  `b4d862feb9ae87ffe8167dd1817018da18fc615e`.
- Context resolved successfully. The selected/indexed worktree fields both
  named the requested detached main root.
- Manifest v2 recorded `branch:null`, `detached:true`, `dirty:false`.
- Task SHA-256:
  `4bb6e46ded682153b3410a36a941908c6bf71370ebfae85ef8dcaebeb1116f67`.

## Worktree Isolation

| checkout | repository ID | worktree ID | initial/final relevant manifest SHA-256 |
| --- | --- | --- | --- |
| canonical | `c271b8050354bff293434995` | `a38c9cae82f5d8635c8062bc` | `b605cc…5831583d` / identical |
| detached main | `c271b8050354bff293434995` | `f43b314ecc87c1fcdc585c12` | missing / `bce469…a95a94c8` after clean run 3 |
| ESS/Hessian | `c271b8050354bff293434995` | `57a176dfc2b57dd1501d480f` | missing / missing |

The repository ID is correctly shared; all worktree IDs are distinct. Across
main runs 1, 2, and 3, the canonical manifest remained byte-identical, its
recorded HEAD stayed `b4dd9eb…`, and its four-file `.vtrace` inventory and
185,028,608-byte database were neither deleted nor repurposed.

## Dirty-State Test

- Temporary change: untracked, root-level indexable
  `m115_temporary_probe.py`; it contained only a two-line probe function.
- Identity became `dirty:true` with fingerprint
  `99b1246b84ebc268ba5ce88f2ae0c30cae2359a0bd15499fd9750d255bd1c8cf`.
- Default behavior returned precise `working_tree_changed`, run 1 unchanged.
- Explicit refresh updated only the main worktree: incremental run 2, after
  state `fresh`, manifest `dirty:true` with the same fingerprint.
- Removing the exact probe restored clean Git status and fingerprint `null`;
  freshness correctly became `working_tree_changed` relative to dirty run 2.
- A final explicit incremental refresh produced clean run 3 and `fresh`.
- The canonical manifest hash remained unchanged at every transition.

## HEAD-Mismatch Test

A separate disposable shared-object clone (`<M115_HEAD_CLONE>`) avoided adding
any commit to the real TCKDB common directory.

- Commit A: `b4d862feb9ae87ffe8167dd1817018da18fc615e`; full index run 1;
  manifest SHA-256 `2c9dd60e…274f9d654`.
- Commit B: local-only `53644fb943f54624c5b7637b2cf1436db4b51610`, adding one
  two-line probe source file in the disposable clone.
- Before refresh: precise `head_mismatch`, previous HEAD A, current HEAD B,
  `refreshAttempted:false`, run 1 unchanged.
- Explicit refresh: incremental run 2, after state `fresh`, indexed HEAD B,
  clone manifest SHA-256 `a032402f…93ec7d9`.
- The canonical and detached-main manifest hashes remained unchanged through
  both A and B operations.

## Detached-HEAD Test

The real linked acceptance worktree was detached at current `origin/main`.
Identity resolution and every v2 manifest consistently recorded:

- `branch:null`
- `detached:true`
- exact HEAD `b4d862feb9ae87ffe8167dd1817018da18fc615e`
- stable worktree ID `f43b314ecc87c1fcdc585c12`

It remained worktree-scoped across clean, dirty, and restored-clean indexes.

## TCKDB Context Sanity Check

- Task: explicit `lowest_energy_unavailable` API error for all-unusable
  lowest-energy candidates, preserving empty and mixed-set behavior.
- Resolved: yes after explicit refresh.
- Selected files: `backend/app/api/routes/species.py` (one unique file).
- Lead pivot:
  `get_lowest_sp_conformer_observation_for_entry` (full source-backed mode).
- Additional required pivot:
  `_resolve_lowest_sp_conformer_observation` (signature-only compression).
- Optional/support files: none.
- Capsule: default engine `v1`, `feature_balanced` profile, debug routing,
  compressed and truncated within 3,004/6,000 characters on run 1.
- Estimated output: 2,194 tokens. Capsule reference: `ec239553`.
- No coding agent consumed the context and no TCKDB file was edited.

## Defects and Fixes

None. No VTRACE source or regression-test change was warranted.

## Cleanup

- The temporary dirty probe was removed exactly and verified absent.
- `<M115_MAIN_WORKTREE>` was removed with `git worktree remove` only after a
  clean status check.
- `<M115_HEAD_CLONE>`, its local-only commit, generated index, and temporary
  client were removed after exact-path validation.
- The original 17-worktree porcelain inventory was restored.
- Canonical final status matched pre-test: local `main`, one behind
  `origin/main`, pre-existing `paper/` only. ESS/Hessian remained clean.
- No TCKDB source change, branch change, commit, push, or existing-index
  deletion remained.

## Success Criteria Check

All 15 success criteria passed: no prohibited execution/spend; actual layout
inspected; schemas reloaded; distinct identities; fail-closed default; explicit
same-root refresh; byte-identical canonical manifest; dirty and HEAD reasons;
detached identity; truthful next tool; resolved real context; clean restoration;
safe cleanup; and no source/helper change requiring broader validation.

## Verdict

**PASS**

## Recommendation

**promote M114 without qualification**
