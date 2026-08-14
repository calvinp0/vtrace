# M145 — Index Lock Ownership Contract

## Scope

A lock belongs to **one authoritative index**, which is one worktree's. It lives
at `<worktreeRoot>/.vtrace/index.lock` and its owner record names the worktree:

```json
{ "pid": 2760912, "startedAt": "2026-08-14T…", "worktreeId": "560e83ab…" }
```

There is no workspace-level lock. Indexing repository A and repository B in one
workspace proceeds in parallel, and so does indexing two sibling worktrees of one
repository — they share an object store but own separate indexes.

## Acquisition

Acquisition is a `mkdir` with `recursive: false`, which is atomic. It **never
waits indefinitely**: `waitMs` defaults to 0, so a contended lock returns
immediately.

| Outcome | Code |
|---|---|
| Acquired | — |
| Contended, no wait requested | `index_in_progress` |
| Contended, wait exhausted | `lock_timeout` |

Both errors carry the blocking claim's `pid` and `worktreeId`, and the `waitedMs`
actually spent. Measured refusal latency: **9.1 ms**, and the MCP `index_repo`
surface returns it as a failure with `action: retry` rather than blocking.

## Recovery

A lock is cleared only on grounds of **ownership**, never age. A long index is not
an abandoned one, and no timeout is consulted.

| Ground | Meaning |
|---|---|
| `dead_owner` | The owning pid is not running. |
| `unreadable_owner` | The owner record is missing or malformed. |
| `foreign_worktree` | The claim names a different worktree. |

Every recovery is attributed in the result (`staleLockRecovered`,
`staleLockKind`), so a silently self-healing lock is not possible.

### Why a foreign claim is cleared regardless of liveness

A claim naming another worktree arrives one way: someone copied a `.vtrace`
directory. Its process — alive or not — writes to *its own* worktree's lock path,
and will remove that one when it finishes. It never owned this index.

§69 requires that a sibling worktree's lock must not imply this worktree is busy.
Honouring the foreign claim would produce exactly that false busy, potentially for
as long as the other index runs. This is not the lock stealing §70 rules out:
stealing is two claims on **one** write target, and this claim was never on this
target.

## Measured behaviour

| Case | Result |
|---|---|
| Same index, two writers | `index_in_progress`, 9.1 ms, owner reported |
| Two different repositories in parallel | both proceed |
| Sibling worktree while main is locked | proceeds |
| Dead owner | recovered as `dead_owner` |
| Foreign worktree claim | recovered as `foreign_worktree` |
| Truncated owner record | recovered as `unreadable_owner` |
| Operation throws | lock released, next acquisition succeeds |

No case hangs.

## Limitations

- **PID reuse.** A dead owner's pid may be reused by an unrelated live process,
  which would make an abandoned lock look held. It would still refuse boundedly
  rather than hang, and the owner pid is reported so a human can check. Not
  solved; recorded.
- **Local process scope only.** No host identity, no boot id, no distributed
  coordination. The product is local, and §67 says not to over-engineer past
  that.
- **Deletion is not coordinated with readers.** The lock guards writers against
  each other; a reader opening the index read-only is unaffected by design.
