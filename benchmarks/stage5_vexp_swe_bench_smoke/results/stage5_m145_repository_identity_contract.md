# M145 — Repository Identity Contract

## What a repository identity is

```
RepositoryIdentity {
  gitCommonDir        canonical path of the Git object store, or null
  repositoryId        sha256("repository" + gitCommonDir), 24 hex chars
  isGitRepository     false for a plain directory
  instanceFingerprint fs1:<device>:<inode>:<birthtimeMs>, or null
}
```

`repositoryId` identifies a **location**. `instanceFingerprint` identifies the
**physical repository currently at that location**. Both are needed because
neither alone is sufficient: a hash of the path cannot see a replacement, and a
filesystem fingerprint is not portable or serialisable as a name.

## Guarantees

| Property | Holds | Evidence |
|---|---|---|
| Stable across process restart | yes | derived, no stored state |
| Stable across branch rename | yes | branch is not an input |
| Stable across checkout | yes | HEAD is not an input |
| Stable across worktree move | `repositoryId` no, fingerprint yes | measured, §24 |
| Shared by sibling worktrees | yes, by design | one object store |
| Distinct for independent clones | yes | measured |
| Distinct for `cp -r` copies | yes | measured |
| Distinct after replacement at one path | fingerprint only | measured, §109 |

## Rules

1. **A display name is never an identity.** Aliases, directory basenames, remote
   URLs and branches are metadata. Two clones may share all four.
2. **Identity is not state.** HEAD, dirty fingerprint and index fingerprints
   describe what a repository contains, not which repository it is. A checkout
   must never make a repository a different repository.
3. **Instance evidence may only refute.** It is compared when both sides carry a
   fingerprint with the same algorithm tag. A `null` on either side, or a
   different tag, produces no verdict. Two `null`s are not a match.
4. **Non-Git roots have path-only identity.** No object store exists to
   fingerprint, so replacement of a plain directory is undetectable. Recorded as
   a limitation, not papered over with a directory inode.
5. **The fingerprint is machine-local.** It is comparable only against an
   artifact written on the same machine, which is already true of the manifest
   that carries it.

## Serialisation

```json
{
  "gitCommonDir": "/home/user/code/arc/.git",
  "repositoryId": "80f660fb3c1fbc19c5fc16e1",
  "isGitRepository": true,
  "instanceFingerprint": "fs1:44:10618981:1786722922256"
}
```

Human-inspectable, comparable by string equality, and versioned by the `fs1:`
prefix so a future algorithm cannot be silently compared against this one.

## What this contract does NOT provide

- **Lineage.** Two clones of one upstream are distinct identities here; nothing
  records that they share history. `git rev-list --max-parents=0` would supply
  it and was rejected on cost (§13 in the audit). Add it if a milestone needs
  lineage for its own sake.
- **Cross-machine identity.** No persisted UUID is written into the user's
  `.git`, deliberately: it would be copied by `cp -r`, which is exactly the case
  §25 requires to stay distinct.
- **Relevance.** Identity says where something belongs. Whether it matters to a
  task is M146's question.
