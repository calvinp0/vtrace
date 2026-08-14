# M145 — Workspace Contract

## What a workspace is

**An explicitly registered collection of repository/worktree identities used for
one routing context.** It is not "every `.git` under a parent directory", and no
code walks a tree looking for repositories. M132 already showed what physical
duplicate worktrees do to graph resolution when they are picked up implicitly.

```
WorkspaceIdentity          workspace:<canonical config path>
  └── RegisteredRepository alias + displayName + rootPath
        ├── identity       RepositoryIdentity + WorktreeIdentity
        └── registration   unrecorded | verified | mismatch | unavailable
```

## Membership

Membership comes from `.vtrace/workspace.json`. Every entry is resolved to its
canonical identity **once, at registry load** — §117 forbids `git rev-parse` per
candidate or per path, and identity is a property of the workspace, not of a
query.

An entry may record the identity it vouched for at registration time:

```json
{
  "alias": "arc",
  "rootPath": "/home/user/code/ARC",
  "enabled": true,
  "repositoryId": "80f660fb3c1fbc19c5fc16e1",
  "worktreeId": "c85329dd70bb66cdabe1f7e0",
  "repositoryInstance": "fs1:44:10618981:1786722922256",
  "worktreeInstance": "fs1:44:10618981:1786722922256"
}
```

`schemaVersion` stays at `1.0.0`. The fields are additive and optional, so a
config carrying them is still readable by code that predates them, and a config
without them is still valid. §111: the bump was decided, not reflexed.

Recorded identity is read back verbatim and never repaired. Refreshing it during
an unrelated rewrite would destroy the evidence §109 exists to catch.

## Registration states

| State | Meaning | Consequence |
|---|---|---|
| `unrecorded` | The entry records no identity. | Vouches for nothing; is not a failure either. |
| `verified` | Recorded identity matches what is on disk. | Usable. |
| `mismatch` | A different repository now occupies the path. | Fails closed, before the index is consulted. |
| `unavailable` | The path is gone or is not a worktree. | Fails closed. |

A missing directory is `unavailable`, not `mismatch`: identity resolution answers
for any path, so asking it about a deleted registration would report "a different
repository is here" about a path where nothing is.

## Routing

A request addresses exactly one member. Precedence runs most specific to least:

```
worktreeId  >  repositoryId  >  path  >  alias  >  displayName  >  cwd  >  default
```

- **`worktreeId`** is exact.
- **`repositoryId`** is ambiguous when one repository is registered as several
  worktrees — a repository id names a repository, and a request runs against one
  working tree.
- **path / cwd** match the canonical root, then the *deepest* containing root, so
  a cwd inside a sibling or nested worktree routes to that worktree (M132).
- **alias** is unique within a config by validation.
- **displayName** (directory basename) is convenience only. Two clones both
  called `requests` produce `workspace_repository_ambiguous`.
- **default** applies only when the config **named** a primary. A
  `primaryRepoAlias` that normalization filled in from the first entry is not a
  decision (§75).

Nothing in the query text participates. There is no semantic routing.

## Failure modes

| Reason | When |
|---|---|
| `workspace_repository_required` | Several members, nothing selects one, no named default. |
| `workspace_repository_unknown` | The selector names no member. |
| `workspace_repository_ambiguous` | The selector matches several members. |
| `workspace_registration_stale` | The member resolved, but its path no longer holds that repository. |

Every failure carries bounded candidate metadata: who matched, never why one
would win.

## Readiness

Per member, using M141's evaluation unchanged. The workspace answer is a **count**
— `total / ready / stale / missing / mismatched / unavailable` — never a single
boolean, because a request may route to precisely the member a `ready=true`
would hide.

Registration compatibility sits **alongside** M141's dimensions, not inside them.
M141 asks whether the stored index belongs to this worktree; registration asks
whether the repository the workspace registered is still at that path. Both can
fail independently, and registration is checked first: a replaced checkout can
leave behind an index that is entirely valid — for the repository that left.

## Bounds

An explicitly routed response carries one provenance envelope
(`workspaceId`, `repositoryId`, `worktreeId`), not per-candidate repetition.
Measured constant at **168 bytes** across workspaces of 1, 10, 100 and 1000
members. Routing is a map lookup: **0.001–0.010 ms** per lookup at every size.

Workspace **load** is linear in members (≈3.5 ms each, dominated by identity
resolution), so a 1000-member workspace costs ≈3.5 s to load. Recorded as a
limitation: §105 asks for bounded routing, which holds, and says nothing about
load. Caching or lazy per-member resolution is available if a real workspace
approaches that size.

## What a workspace does NOT do in M145

- It does not choose a repository because a query mentions one.
- It does not fan retrieval out across members.
- It does not rank members.
- It does not model `repo A calls repo B`.

M145 knows where something belongs. M146 will ask whether it is relevant.
