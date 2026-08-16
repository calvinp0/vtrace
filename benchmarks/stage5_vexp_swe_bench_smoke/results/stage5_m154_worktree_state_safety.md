# M154-B — vtrace generated state and Git staging

## The defect, reproduced generically

Indexing creates `<repo>/.vtrace/` holding `index.sqlite` and `session.sqlite`.
Nothing ignored it, so it sat **untracked and not ignored** — the one state in
which `git add -A` sweeps a file into a commit.

Reproduced outside ARC in both supported layouts, with `git add -n -A`:

```
=== BEFORE any exclude: git add -n -A ===
add '.vtrace/index.sqlite'
add '.vtrace/session.sqlite'
```

An agent that runs `git add -A` before committing — which is the common
instruction — commits vtrace's SQLite state into the user's PR.

## Where the rule has to go: measured, not assumed

A linked worktree splits the Git directory in two, and only one half is consulted
for exclusions. Both were tested directly:

| Location | Path in a linked worktree | Applies? |
| --- | --- | --- |
| `$GIT_DIR/info/exclude` | `.git/worktrees/<name>/info/exclude` | **No.** `git check-ignore` reports nothing; `git add -n -A` still stages the files |
| `$GIT_COMMON_DIR/info/exclude` | `.git/info/exclude` | **Yes.** `check-ignore` resolves it and staging stops |

```
=== TEST 1: worktree-private $GIT_DIR/info/exclude ===
add '.vtrace/index.sqlite'
add '.vtrace/session.sqlite'
(check-ignore: NOT-IGNORED)
=== TEST 2: common-dir info/exclude ===
(check-ignore: .git/info/exclude:1:.vtrace/   .vtrace/index.sqlite)
```

The authority is therefore always `git rev-parse --path-format=absolute
--git-common-dir`. An implementation reaching for the more obvious `--git-dir`
would pass every single-checkout test and do **nothing** in precisely the
linked-worktree case that motivated this milestone.

Because the shared file is read by every linked worktree, the pattern is
root-anchored (`/.vtrace/`), so each worktree's own state directory is covered and
no rule leaks across them.

## Solution class

A local, untracked exclusion. Never the repository's tracked `.gitignore`, never
global Git configuration.

```
explicit initialization / index lifecycle
        ↓
resolve the repository authority that would stage the file
        ↓
refuse if the project versions content under .vtrace/
        ↓
skip if some rule already covers it
        ↓
append one commented, root-anchored line to the local exclude file
        ↓
create/update vtrace state
```

`initRepo` establishes it **before** the state directory is created — the window
in which the files exist unignored is the window in which they can be swept up.
`index_repo` re-asserts it, so repositories initialized before this existed gain it
on their next index.

## Scope of the pattern

`/.vtrace/` — a directory pattern, root-anchored, one line. Not a growing list of
filenames (`index.sqlite`, `session.sqlite`, the parse cache, tomorrow's file),
and not a broad `*.sqlite` / `*.db` that could hide legitimate repository data.
Only vtrace-owned state, at the one location vtrace writes it.

### Repositories that track something under `.vtrace/`

`workspace.json` can live there, and a project may legitimately version it. Git
never un-tracks a file because of an ignore rule, so an ignore would not hide it —
but it would change what `git add` does with new siblings in a directory the
project curates, silently. vtrace therefore **refuses**, names the tracked paths,
and returns a `remediation` string stating plainly that generated state remains
stageable and what to do about it. That is the one row in the matrix where state
is still stageable afterwards, and it is never silent.

## Exclusion matrix

Full data: `stage5_m154_git_exclusion_matrix.json`. Method is `git add -n -A`
(dry run) over throwaway repositories under a temp root — nothing is ever staged
and no real repository is touched.

| Scenario | Leaks before | Status | Leaks after | Idempotent |
| --- | --- | --- | --- | --- |
| normal checkout | yes | `established` | **no** | yes |
| linked worktree | yes | `established` | **no** | yes |
| tracked `.gitignore` already covers | no | `already_ignored` | no | yes |
| local exclude has other content | yes | `established` | **no** | yes |
| local exclude already has `.vtrace` | no | `already_ignored` | no | yes |
| repository tracks `.vtrace` content | yes | `tracked_paths_present` | yes *(refused, with remediation)* | yes |
| nested inner repository | yes | `established` | **no** | yes |
| not a Git repository | n/a | `not_a_git_repository` | n/a | yes |

Invariants, all true:

```
noTrackedFileModified            true
noGlobalGitConfigWritten         true
idempotent                       true   (second call writes nothing, every row)
excludeFileStableOnRepeat        true   (byte-identical after a repeat)
noGitBackedScenarioLeaksAfter    true   (the one exception carries remediation)
```

## Ownership and hygiene

vtrace owns exactly the comment line it inserts and the pattern line beneath it:

```
# vtrace: local index/session state (generated, not part of this project)
/.vtrace/
```

Existing content is preserved byte-for-byte ahead of that block; the only
normalisation is the newline separating it. Duplication is prevented twice —
`git check-ignore` short-circuits before any write, and a standalone matching
pattern line is honoured even if inert. No uninstall feature was added; none was
needed, because repeated indexing appends nothing.

Non-Git directories still index normally and report `not_a_git_repository`; Git is
not made a requirement.

## Verdict

- Generated state cannot be swept into a normal `git add -A` — normal checkout
  **and** linked worktree
- Tracked project files changed: **0**
- Global Git configuration changes: **0**
- Idempotent, byte-wise, across every scenario
- Existing user excludes preserved
- Where it cannot act safely it refuses loudly rather than proceeding

**M154-B: PASS.**
