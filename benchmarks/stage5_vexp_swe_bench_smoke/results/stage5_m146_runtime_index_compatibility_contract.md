# M146-A — Runtime ↔ index compatibility contract

The contract VTRACE now honours between a running binary and an index some
earlier binary wrote.

## 1. Four independent questions

An index is usable only when all four are answered favourably. They are separate
truths and the implementation keeps them separate — none short-circuits another,
which is what makes a state like "the source is current but the derivation is
obsolete" expressible at all.

| Question | Dimension | Fails when |
| --- | --- | --- |
| Is this the same repository/worktree? | `repositoryCompatible`, `worktreeCompatible` | path ids or M145 instance evidence disagree |
| Does the index describe current contents? | `sourceFresh` | head, dirty fingerprint, or scope config moved |
| Can this runtime read the representation? | `schemaCompatible` (format / `schema_version`) | table shape or meta shape moved |
| Were the contents derived by semantics this runtime agrees with? | `schemaCompatible` (fingerprints) | `indexer_fingerprint` or `parser_fingerprint` moved |
| Does the index carry required optional capabilities? | `capabilityCompatible` | `edge_call_sites` / `document_chunks` absent |

Identity is checked first and is never masked by the weaker causes: a checkout
replaced at the same path reports `repository_mismatch`, not `source_stale`.

## 2. What invalidates, and what must not

Invalidation is **semantic**. A VTRACE commit does not invalidate anything by
existing; `vtrace_commit` is recorded for provenance and is explicitly excluded
from the freshness fields.

Invalidates (index-deriving):

```
src/parsers/**                  -> parser_fingerprint
src/indexer/**, src/db/**       -> indexer_fingerprint
src/domain/types.ts             -> indexer_fingerprint   (stored ids, FQNs, enums)
src/domain/guards.ts            -> indexer_fingerprint   (what is parsed at all)
src/fs/hashFile.ts              -> indexer_fingerprint   (content hashing)
src/fs/git.ts                   -> indexer_fingerprint   (change detection, snapshot)
src/db/schema.ts                -> schema_version
scanRepo / ignoreRules / languageDetection / worktreeExclusions,
documentPolicy / documentChunks -> config_hash
```

Does **not** invalidate (query-only):

```
src/retrieval/**      ranking, scoring, match explanation
src/capsuleV2/**      selection policy, budget allocation
src/capsule/**        rendering
src/mcp/**            response envelope
```

The rule that keeps these two lists honest: a module belongs on the first list
if changing it can change the bytes an index run persists. Not "is it about
search", not "which directory is it in".

## 3. The reuse decision is one authority

Two questions must agree and are both answered from the fingerprints:

- *May this index be used?* — `evaluateIndexReadiness`
- *May a refresh reuse what is stored?* — `resolveDerivationRebuildReason`

Before M146-A the second lived as a separate ladder in `reindexRepo` that
compared a subset of the fields, which let a refusal be "resolved" by a rebuild
that regenerated nothing and then relabelled the stale content as current. Any
new fingerprint field must be classified in `DERIVATION_REBUILD_REASONS` or
listed in `NON_DERIVATION_FINGERPRINT_FIELDS`.

## 4. Reported causes

| Reason | Meaning | Remediation |
| --- | --- | --- |
| `head_changed` / `dirty_fingerprint_changed` / `source_changed` | repository contents moved | `incremental_refresh` |
| `schema_changed` | stored representation shape moved | `full_rebuild` |
| `derivation_changed` | representation readable, contents produced under obsolete semantics | `full_rebuild` |
| `schema_unsupported` | index newer than this runtime can read | `unsupported_runtime_upgrade` |
| `wrong_repository` / `wrong_worktree` | index belongs to another checkout | `inspect_index` |
| `capability_missing` | required optional table absent | `full_rebuild` |

`derivation_changed` exists because `index_status` renders the reason to the
user verbatim ("Vtrace cannot use the stored index: …"). Reporting
`schema_changed` after a parser edit sends someone to look at the database.
The state stays `schema_incompatible` and every readiness boolean keeps its M141
meaning — the distinction is carried entirely by the reason, which is the
smallest change that makes the sentence true.

## 5. When compatibility is checked

At readiness evaluation — index open or product request — not at MCP startup.
Workspace members are not eagerly opened or revalidated on reconnect, so startup
cost does not scale with member count. Validation is lazy and fails closed: no
retrieval path reaches an index without a readiness verdict.

Reconnecting an MCP server does not make an index fresh. The new runtime
recomputes the fingerprints from its own source and must prove the stored index
matches. Proven in a real subprocess in both directions: an index-affecting
change is refused with `derivation_changed`, and a query-only change stays
`ready` with no rebuild.

## 6. Cost

Fingerprints are content hashes over roughly 46 source files, computed once per
request and reusable across members via `EvaluateIndexReadinessOptions.expected`.
Manifest-probe readiness opens no database and scans no repository content; the
`full` probe additionally opens the index read-only to confirm it parses and to
read optional capabilities. No Git subprocess and no filesystem scan happens per
candidate during scoring — validation is at index/workspace load, not in the
scoring loop.

## 7. Granularity

All index-affecting changes trigger a full rebuild. Partial invalidation
(rebuilding only Python-derived state when only the Python parser moved) is not
implemented and was not attempted: §28 puts correctness first, and the dependency
boundaries required to prove full/partial equivalence do not exist yet. This is
recorded as performance debt, not a safety gap.
