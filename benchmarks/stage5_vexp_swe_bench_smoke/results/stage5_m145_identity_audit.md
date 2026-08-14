# M145-A — Identity Audit

What every value VTRACE uses to answer "which repository does this belong to?"
actually is, measured before any product code was written. The machine-readable
form is `stage5_m145_identity_map.json`; this is the reasoning.

## 1. The audit found a working identity model with one hole in it

M145's brief assumed identity barely existed. It did. M114 built canonical
repository and worktree identities, M132 built fail-closed routing on top of
them, M141 decomposed readiness into dimensions that include
`repositoryCompatible` and `worktreeCompatible`, and M144 added path membership.
The index manifest has persisted repository and worktree identity since M114.

So the audit's job was not to invent a model but to ask what the existing values
are *evidence of*. Three classes came out:

| Class | Question it answers | Examples |
|---|---|---|
| **Identity** | what thing is this? | `repositoryId`, `worktreeId`, `worktreeRoot`, `gitCommonDir` |
| **State** | what does it contain right now? | `headCommit`, `dirtyFingerprint`, `indexer_fingerprint` |
| **Display** | what do humans call it? | alias, basename, branch, `primaryRepoAlias` |

And the hole: **every identity value in the first column is a function of a
path.**

## 2. The measurement that decided the milestone

`resolveWorktreeIdentity` was run over each §125 scenario before any change.

| Scenario | same repository? | same worktree? |
|---|---|---|
| same root repeated | yes | yes |
| symlink to same root | yes | yes |
| sibling Git worktree | yes | no |
| independent clone, same HEAD | no | no |
| same basename, different repo | no | no |
| copied repo directory | no | no |
| same worktree, HEAD advanced | yes | yes |
| **repository replaced at the same path** | **yes** | **yes** |

Every row is correct except the last, and the last is §109's acceptance case.
`repositoryId` is `sha256(gitCommonDir)` and `worktreeId` is
`sha256(gitCommonDir + worktreeRoot)`, so deleting a checkout and putting an
unrelated repository at the same path produces byte-identical ids. Readiness
consequently reported `repositoryCompatible: true, worktreeCompatible: true`
across the swap.

The replacement was still caught downstream, because `repo_head` differs and two
repositories cannot share a commit SHA. But it was caught as **staleness**, and
reported as `source_stale / head_changed / incremental_refresh` — a true
statement about the wrong question. Nothing in the system could say "a different
repository is here".

## 3. What was chosen instead, and what it cost

Three candidate discriminators were considered against §13's list.

**Remote URL** was rejected outright: repositories may have no remote, share
one, or be forks, all of which §13 names.

**Root-commit lineage** (`git rev-list --max-parents=0 HEAD`) is semantically
meaningful, survives moves and restores, and would additionally answer §9's
"same lineage vs same physical repository". It measured at 3 ms on ARC — but
only because ARC has a commit-graph. On a large repository without one it walks
the whole history, and identity resolution sits on the request path. Rejected on
cost, and recorded as available if lineage is ever needed for its own sake.

**Filesystem instance evidence** — `stat` on the git dir, giving device, inode
and creation time — was measured at **0.007 ms** and discriminates every
scenario:

| Case | fingerprint |
|---|---|
| replaced at same path | distinct |
| moved worktree | preserved |
| `cp -r` copy | distinct |
| `git clone` | distinct |
| sibling worktree (common dir) | shared, correctly |

It is machine-local, which is a real limitation and a smaller one than it looks:
the manifest it is compared against already stores absolute paths, so it is no
more portable than the artifact carrying it. It is compared only when **both**
sides carry a fingerprint with a matching algorithm tag; a `null` is silence, and
M132 already settled that silence must not be read as a failing claim.

The measured answer to §24 falls out of this: **moving a worktree preserves its
repository instance and changes its path identity.** Identity is not fully
move-stable, and the honest reason is that `worktreeId` contains the root path.

## 4. Where identity had to be enforced, and where it did not

The instance fingerprint could have been enforced at index-readiness time, at
workspace-registration time, or both. Both were done, but for different reasons.

**Registration** is where §109's fixture lives — it is explicitly about reusing
workspace metadata after a swap — and before M145 a workspace entry had no
identity at all to check. This is the load-bearing half.

**Readiness** gains the check as a strictly additive refutation. It cannot fire
on any index written before M145, because those manifests carry no fingerprint.
Measured on ARC and TCKDB: `repositoryCompatible` and `worktreeCompatible` remain
`true` under M145 code against M144-era indexes. Nothing was falsely refused.

## 5. The cost this milestone accepted

`indexer_fingerprint` content-hashes `src/indexer` and `src/db`. M145 edits
`src/indexer`, so **every index written before M145 is now
`schema_incompatible / schema_changed / full_rebuild`.**

Measured directly, same machine, same checkouts:

| Repository | under M144 | under M145 |
|---|---|---|
| ARC | `source_stale / head_changed / incremental_refresh` | `schema_incompatible / schema_changed / full_rebuild` |
| TCKDB | `schema_incompatible` (already) | `schema_incompatible` |

This is §111's decision, made rather than reflexed: **no index format bump, no
schema bump, no capability bump.** The fingerprint already forces the rebuild, so
a version bump would add a second mechanism for one consequence. And it is
§113's required explicit answer — an M144-era index is *rejected with a clear
compatibility reason*, never silently reinterpreted.

The alternative was to leave the index lock outside `src/indexer` and skip the
manifest fields. That would have preserved existing indexes at the cost of
leaving §69's wrong-worktree lock unfixed, which is a stated M145 requirement.

## 6. Findings that shaped the rest of the milestone

- **A workspace entry was keyed on an alias and a path string, both display
  metadata.** Nothing in the config recorded which repository was registered, so
  no reuse of that metadata could ever be validated.
- **`primaryRepoAlias` silently defaults to the first entry** when the file omits
  it. §75 rules out position as a routing decision, so normalization now records
  whether the file actually named one.
- **The lock owner record carried a `worktreeId` that nothing ever read** (M114
  wrote it). A copied `.vtrace` therefore blocked an unrelated worktree.
- **`inspectWorkspaceRepoStatus` exists twice**, in `src/workspace/status.ts` and
  as a private copy in `src/mcp/tools.ts`. Left unconsolidated and recorded.
- **The retrieval path takes `(db, repoRoot)` and no workspace input.** This is
  why registering a second repository cannot move a routed answer — a structural
  fact, and the reason §88-§93's equivalence is provable rather than hopeful.
