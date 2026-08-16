# M153 — `initRepo` non-idempotence: classification

Recorded because it was hit, diagnosed and worked around during M153-A. Kept
deliberately small (§120): this is not an M153 workstream.

## Reproduction

```
initRepo({ repoPath })      # succeeds, builds .vtrace/index.sqlite
initRepo({ repoPath })      # SQLiteError: UNIQUE constraint failed: edges.id
```

Stack (abbreviated):

```
insertEdges              src/db/repositories/edgesRepository.ts:48
persistParseResult       src/db/persistParseResult.ts:58
indexProject             src/indexer/indexProject.ts:369
initRepoUnlocked         src/setup/initRepo.ts:64
```

## Classification: **harness misuse, not a product bug**

`initRepo` is repository *initialisation*. The supported way to refresh an
existing repository is the `index_repo` tool, which is what the product itself
calls and what performs the M152 session-store migration. The M153 harness was
calling `initRepo` unconditionally in a loop that ran once per benchmark arm, so
the second arm re-initialised an already-initialised repository.

Two pieces of evidence support the classification rather than assumption:

1. `index_repo` over an already-indexed repository succeeds and is the path the
   product uses; the corpus is prepared through it on every run.
2. `initRepo` performs a full parse-and-persist rather than a reconciliation, so
   the duplicate-edge failure is what a second full insert into a populated table
   should do. It is not silently corrupting anything — it fails closed.

## What was changed

Only the harness. `prepareRepository` removes `.vtrace` before initialising:

```ts
await rm(path.join(repoRoot, ".vtrace"), { recursive: true, force: true });
await initRepo({ repoPath: repoRoot });
await callTool(contextBoundTo(repoRoot), McpToolId.IndexRepo, {});   // M152 migration
```

That is also the behaviour a paired benchmark wants for its own reasons: each arm
indexes the tree with the code under measurement, so the two sides are comparable
(§55 — no index derivation semantics were changed to make this convenient).

## What was NOT changed

- No change to `initRepo`, `indexProject` or `insertEdges`.
- No clearing or rebuilding of indexes inside the product to make repeated
  initialisation appear to work.
- No change to repository derivation semantics.

## Residual observation, not acted on

The error surfaces as a raw `SQLiteError` rather than a lifecycle message such as
"this repository is already initialised; use `index_repo` to refresh". That is a
diagnostics improvement, not a correctness one, and it is out of M153 scope.
