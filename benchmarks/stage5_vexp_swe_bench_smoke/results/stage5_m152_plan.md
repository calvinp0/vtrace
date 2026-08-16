# M152 — Separate repository evidence from mutable product/session state

## The defect M151 left open

M151 proved workspace routing is wired into the real product surfaces and that
product reads do not accidentally mutate repository-derived evidence. What it
could not prove was the gate it set out to: `index.sqlite` byte-identical after a
read. The premise was wrong, not the code. The file held two things:

- evidence `index_repo` derives from source, and
- mutable state three supported features persist on purpose — observation
  auto-capture, capsule manifests, deferred VEXP references.

So a changed hash was equally consistent with "retrieval corrupted the index"
and "`search_memory` recorded a lookup", and those have opposite consequences.
The boundary could only be stated per table and taken on trust.

## What M152 does

Gives the two state classes distinct physical ownership, distinct lifecycles and
distinct write authority, without suppressing any product behaviour.

```
index.sqlite     repository identity, files, symbols, edges, FTS,
                 mechanism facts, run states, derivation metadata

session.sqlite   observations + links, sessions, compression summaries,
                 capsule manifests + items, project rules,
                 deferred refs + tombstones, session_meta
```

## Workstreams

| | Scope | Verdict |
| --- | --- | --- |
| A | Persistence ownership + scope audit | PASS |
| B | Session store + legacy migration | PASS |
| C | Rewire observations / manifests / deferred refs | PASS |
| D | Provenance, reindex + staleness lifecycle | PASS |
| E | Real repo migration, preservation, paired benchmark | see final report |

## Decisions taken, and the evidence behind them

**Scope: one store per repository-local `.vtrace`.** `search_memory` has never
filtered by `repo_root` — physical separation *is* the current scoping rule, so
a per-repo store reproduces existing semantics exactly and a
workspace/global store would silently change them. See
`stage5_m152_session_store_scope_decision.md`.

**Path derived from the index, not the repo root.** A benchmark or test pointed
at a temporary index automatically gets a temporary session store rather than
the developer's live one; an in-memory index gets an in-memory store.

**Migration trigger: the `index_repo` lifecycle, and nowhere else.** It already
holds the worktree lock and the only writable index handle. Removing the session
DDL moves `schema_version`, so every pre-M152 index must be reindexed anyway —
the upgrade and the migration coincide rather than compete.

**Authority carried by the type.** `SessionDatabase` / `WritableSessionDatabase`
are branded, so `persistObservation` cannot be handed the index connection and a
retrieval path cannot be handed a writable session connection. This is also how
every call path in the change was found rather than guessed.

**Session repositories moved out of `src/db`.** That directory is content-hashed
into `indexer_fingerprint`. While they lived there, changing how vtrace remembers
a tool call invalidated every stored index in existence — a lifecycle coupling
that would have survived the physical split.

## Deliberate index-layout change

`schema_version` moves once, because `src/db/schema.ts` is hashed into it and the
session DDL left. Consequences, all documented rather than absorbed:

- a pre-M152 index reports `schema_incompatible` and is fully re-derived;
- that reindex is also what drains its session rows;
- derivation SEMANTICS are unchanged — no ranking, scoring, candidate generation
  or retrieval behaviour is touched.

Measured cost: ARC (325 files, 9,014 symbols) 36 s. TCKDB_v2 (1,252 files,
31,366 symbols) recorded in the final report.

## What M152 explicitly does not do

- No cross-repository behavioural routing, dependency edges, or ownership
  inference — that is M153, and the reason it comes second is that composition
  writing manifests and observations for several repositories is much harder to
  reason about while they still share a file with the evidence.
- No change to mechanism weights, subject alignment, `operationRole`,
  `mechanism_support`, statement slices, or `directEvidenceAnchoring`.
- No optimisation of the known `index_status` 1000-member latency ceiling.
