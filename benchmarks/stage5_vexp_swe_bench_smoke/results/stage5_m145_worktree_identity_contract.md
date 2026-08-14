# M145 — Worktree Identity Contract

## What a worktree identity is

```
WorktreeIdentity {
  repositoryId        the repository this working tree belongs to
  worktreeRoot        canonical path of the working tree (realpath applied)
  worktreeGitDir      this tree's own git dir: .git, or .git/worktrees/<name>
  worktreeId          sha256("worktree" + gitCommonDir + NUL + worktreeRoot)
  isGitWorktree       false for a plain directory
  instanceFingerprint fs1 fingerprint of worktreeGitDir, or null
}
```

A worktree is the unit of **index authority**. One authoritative index belongs to
exactly one worktree identity, and no other worktree's index may answer for it.

## Repository is not worktree

```
repository ARC
  ├── worktree ~/code/ARC          worktreeId A
  ├── worktree ~/code/ARC-feature  worktreeId B
  └── worktree ~/tmp/ARC-bench     worktreeId C
```

All three share `repositoryId`, `gitCommonDir`, history, objects, and may share a
HEAD. Each has its own working tree, its own dirty state, its own index, its own
readiness, and its own lock. Measured: siblings share
`repository.instanceFingerprint` and differ in `worktree.instanceFingerprint`,
because each linked worktree has its own git dir.

## Identity is not state

`worktreeId` is deliberately independent of HEAD and of dirty content. A checkout
changes what a worktree contains; it does not make it a different worktree.
Measured: after an edit and a commit, `worktreeId` is unchanged while
`dirtyFingerprint` and `headCommit` both move.

This preserves M141's separation. Freshness (`sourceFresh`) is a state question;
compatibility (`repositoryCompatible`, `worktreeCompatible`) is an identity
question; they fail independently and are reported independently.

## Symlinks

`worktreeRoot` is resolved through `realpath`, so `/workspace/repo` and
`/symlink/repo` are **the same worktree**. Registry routing tries both the given
and the canonical spelling, so a symlinked path routes to the one registered
member rather than appearing to be a second one.

## Moves

Measured: moving a worktree directory **changes** `worktreeId` (the root path is
an input) and **preserves** `instanceFingerprint` (the git dir keeps its inode).
Identity is therefore not move-stable, and the index at the old location does not
follow. Recorded as a limitation rather than worked around: making identity
move-stable would mean dropping the path from the id, and a path is what routing,
locking and index location all need.

## Authority rules

1. **Computation may be shared; authority may not.** Same-HEAD sibling bootstrap
   reuse (M142/M144) stays intact: immutable computation crosses worktrees,
   while the resulting index still belongs to the worktree that built it. B's
   index is B's, never a pointer at A's.
2. **An index names its worktree.** The manifest records `worktreeId`, root, git
   dir, and (since M145) instance fingerprint. Readiness compares all of them.
3. **A lock belongs to a worktree.** The lock lives under that worktree's
   `.vtrace`, and its owner record names the worktree. A claim naming a different
   worktree never owned this index and is cleared, with the recovery attributed.
4. **Nested worktrees stay excluded from parent indexing** (M132). Workspace
   registration does not undo this: registering a nested worktree as a member
   does not make its contents parent source.

## Serialisation

```json
{
  "repositoryId": "80f660fb3c1fbc19c5fc16e1",
  "worktreeRoot": "/home/user/code/ARC-feature",
  "worktreeGitDir": "/home/user/code/ARC/.git/worktrees/ARC-feature",
  "worktreeId": "c85329dd70bb66cdabe1f7e0",
  "isGitWorktree": true,
  "instanceFingerprint": "fs1:44:10619093:1786722922269"
}
```
