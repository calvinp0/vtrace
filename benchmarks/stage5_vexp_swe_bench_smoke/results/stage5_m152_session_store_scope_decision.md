# M152-A — Session-store scope decision

**Decision: one session store per repository-local `.vtrace` directory, at
`<repo>/.vtrace/session.sqlite`, resolved from the INDEX path rather than the
repo root.**

§91 asks this to be answered from evidence rather than assumed from where the
index happens to live, and §92 asks for it before the path logic is written.

## The question

Is mutable product state conceptually per-repository, per-worktree,
per-workspace, or global to the runtime?

## What the current semantics actually are

The measurement that settles it is what scopes memory **today**:

- `searchMemory` / `searchMemoryDetailed` never filter by `repo_root`. Neither
  does `listObservations`, `getSessionContext`, or capsule memory surfacing.
- `observations.repo_root` exists as a stored **provenance value**. Only
  `project_rules` and session compression filter on it, and both do so within a
  single repository's database.
- Therefore the thing that prevents repository A's observations from surfacing in
  repository B's context is **the file boundary itself**. Physical separation IS
  the scoping rule.

A workspace-level or global store would delete that boundary and require every
memory query to grow a repository filter it has never had — a behavioural change
to memory scoping, dressed as a storage decision. §93 forbids exactly that.

Two further constraints point the same way:

- **Workspace routing binds a repository before storage** (M151). A request
  routed to member A must use A's session state; resolving one store before
  routing is the §51 failure. A per-repo store resolved from the bound index
  cannot express that bug.
- **`check_capsule_staleness` compares against `index_runs`,** which is
  per-repository. A manifest and the run history it is judged against must sit
  either side of one boundary, not many.

## Per repository, or per worktree?

Per **worktree**, because that is what `.vtrace` already means. M132 established
that worktree computation may be reused but worktree authority may not, and each
worktree carries its own `.vtrace/index.sqlite`. Placing the session store beside
it inherits that authority rather than inventing a second, differently-scoped
one. Two worktrees of the same repository therefore keep separate product state —
which is the existing behaviour, since they already keep separate indexes.

## Why the path derives from the index, not the repo root

`resolveSessionDbPathForIndexDb(indexDbPath)` returns the sibling of the index
file, and maps `:memory:` to `:memory:`. Deriving from the repo root would look
equivalent and is not:

- A benchmark or test pointed at a temporary index would resolve the developer's
  **live** session store and read or write real memory into a frozen retrieval
  run (§96, §150).
- An in-memory index would have no in-memory session store, so every unit test
  would need a temporary directory.

Deriving from the index makes isolation the default rather than something each
harness has to remember.

## What this does not decide

Whether a *deferred ref emitted from a multi-repository composition* can be
resolved from the lead's store. Today refs are published per-repository by
`run_pipeline` and expanded against the same binding, so a per-repo store
resolves everything the current product can emit (§95). If M153 makes one
delivery envelope span repositories in a way that outlives the request, that ref
identity question reopens — and it reopens as an identity question, not a
storage-location one.

## Rejected alternatives

| Option | Why not |
| --- | --- |
| Workspace-level store | Would require adding a `repo_root` filter to every memory query, changing memory scoping semantics under cover of a storage change (§93). |
| Global runtime store | All of the above, plus cross-repository leakage becomes the default and isolation the exception — the inverse of §88. |
| Several stores (`memory.sqlite`, `capsules.sqlite`, `refs.sqlite`) | No measured lifecycle difference between the three families: they are written by the same requests, retained by the same reindex cycle, and read within one product call. §11 asks for one store absent such evidence. |
