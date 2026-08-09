# M132 — Nested-worktree indexing audit

Measured against the real ARC checkout, read-only, with every index built in a
temporary directory. M132 did not write ARC's in-place `.vtrace` state.

## ARC worktree topology (recorded 2026-08-09)

```
requested root : /home/calvin/code/ARC
branch         : arcbench
HEAD           : 1202705be46edf01c84bfb89e3fa94f76f7ae15e
git rev-parse --show-toplevel   : /home/calvin/code/ARC
git rev-parse --git-common-dir  : .git
git rev-parse --absolute-git-dir: /home/calvin/code/ARC/.git
```

`git worktree list --porcelain` reports **37 registered worktrees**. Five are
strict descendants of the requested root and are therefore excluded:

| Nested worktree | Branch | HEAD |
|---|---|---|
| `.claude/worktrees/agent-adf00908e1590c564` | `fix_irc_gated_kinetics` | `723df52` |
| `.claude/worktrees/agent-af3ab1214a47def28` | `worktree-agent-af3ab1214a47def28` | `684967b` |
| `.claude/worktrees/docker_ux_fix` | `fix_docker_aliases_syntax` | `42b5aa6` |
| `.claude/worktrees/pyscf-adapter-test` | `fix_pipe_species_ingestion` | `0e0355b` |
| `feature_docker_ux` | `feature_docker_ux` | `42b5aa6` |

The other 32 live outside the root (`/tmp/...`, `/home/calvin/code/gauss-rebuild`,
`/home/calvin/code/ARC.worktrees/...`) and are untouched. `ARC.worktrees` is the
case that makes segment-aware matching load-bearing: it string-prefixes
`/home/calvin/code/ARC` without being inside it.

## Before / after

| Measure | Before (pre-M132 enumeration) | After (M132) |
|---|---:|---:|
| Files enumerated | 615 | 324 |
| Files excluded as nested worktree | 0 | 291 |
| Symbols indexed | 15,188 | 8,635 |
| Edges indexed | 18,862 | **19,404** |
| Index duration (temp dir, cold) | 25,694 ms | 19,265 ms |
| Worktree discovery cost | — | 8.65 ms, once per index |

**The edge count went UP, and that is the correct direction.** With two complete
copies of the same package present, module resolution for imports and calls is
ambiguous and ambiguous targets are dropped. Removing the duplicate checkout
makes resolution unambiguous, so 542 real edges resolve that previously could
not. The M131 reference figure of "18,862 graph edges" for ARC was measured on a
contaminated index; **19,404 is the clean-index figure and supersedes it.** This
is a change in what was indexed, not a regression in traversal.

## The incident query

`arc/species/vectors.py::get_normal`, the symbol from the original report:

```
before : arc/species/vectors.py
         feature_docker_ux/arc/species/vectors.py     <-- duplicate checkout
after  : arc/species/vectors.py
```

The pre-M132 capsule for the geometry query selected both
`arc/job/adapters/ts/linear.py` and `feature_docker_ux/arc/job/adapters/ts/linear.py`,
and both `arc/main.py` and `feature_docker_ux/arc/main.py`. That pairing is what
"2 pivots were selected across separate modules — a fix that crosses file
boundaries" was inferred from. After M132, `excludedPathsInResults = 0`: no path
under an excluded worktree reaches candidate generation, ranking, selection or
rendering, so the false conclusion has no input to be derived from.

## Policy for other nested repository shapes

| Shape | Behaviour | Why |
|---|---|---|
| Registered linked worktree beneath the root | **Excluded** | Duplicate checkout of the same repository; appears in `git worktree list`. |
| The requested worktree itself | Indexed | It is the subject of the request. |
| Submodule | **Unchanged from pre-M132** | `.git` points into `<super>/.git/modules/…`; never appears in `git worktree list`, so this rule never sees it. Verified by fixture. |
| Unregistered nested Git repository / vendor clone | **Unchanged from pre-M132** | Also absent from `git worktree list`. Excluding these is a separate policy question with its own evidence requirement. |
| Non-Git directory tree | Unchanged | Git unavailable ⇒ empty exclusion set; enumeration degrades to previous behaviour, never fails. |

## Incremental topology handling

- Parent indexed → nested worktree created → refresh: nested files stay out, and
  no parent file is added or removed (`src/indexer/nestedWorktreeIndexing.test.ts`).
- Nested worktree present → removed → refresh: no stale rows remain.
- Pre-existing contaminated index → refresh: 1 nested file / 1 nested symbol → 0
  and 0, via `deletedFiles=1` on the ordinary incremental diff. See
  `stage5_m132_contaminated_index_cleanup.json`.
- Correctness is invariant to nested-worktree count (0, 1, 5 tested) and to
  nested-worktree size (a 200-file duplicate does not change the parent file set).

## Dirty-state interaction

`git status --porcelain --untracked-files=all` reports a nested worktree as a
single untracked **directory** entry (`?? nested/`), never its contents. That
entry fails `isRecognizedRepoSourcePath` (no language), so it never enters
`computeDirtyFingerprint`. A parent worktree therefore does not become dirty
because an agent is editing inside a nested worktree — verified, no code change
was needed.
