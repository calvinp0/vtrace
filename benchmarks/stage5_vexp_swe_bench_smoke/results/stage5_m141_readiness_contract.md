# M141 — Index readiness contract

The contract every VTRACE surface now shares for the question *"can this stored
index be used to answer the request in front of me?"*

Before M141 two unrelated models answered it. `index_status` compared the target
repository's source snapshot against the last indexed snapshot. Every product
tool additionally compared VTRACE's own indexer, parser, schema, and config
fingerprints. Editing `src/indexer` invalidates an index without touching the
indexed repository at all, so the first model saw nothing changed and the second
saw everything changed:

```text
index_status:          fresh / isStale:false / "No re-index is recommended right now."
next get_code_context: resolved:false / index_schema_changed / rebuild_index
```

That is a product-contract defect, not a disagreement about facts. Source
freshness never implied runtime usability; only one of the two models knew it.

## The evaluation

`evaluateIndexReadiness(repoRoot, options)` in `src/indexer/indexReadiness.ts`
is the one authoritative evaluation.

```text
ready = sourceFresh
    AND schemaCompatible
    AND capabilityCompatible
    AND repositoryCompatible
    AND worktreeCompatible
```

Every dimension is evaluated. Nothing short-circuits. That is precisely what
makes `sourceFresh=true, schemaCompatible=false` expressible — the pre-M141
code returned at the first failure, so the source question was never asked in
the case that mattered.

| Dimension | Question it answers | Inputs |
| --- | --- | --- |
| `sourceFresh` | Does this index correspond to the requested worktree's current source state? | HEAD, dirty fingerprint, scan-config hash |
| `schemaCompatible` | Can this runtime read and interpret the stored index schema? | index format version, schema version, indexer + parser fingerprints |
| `capabilityCompatible` | Does the index carry every capability the request declared it needs? | presence of optional tables |
| `repositoryCompatible` | Was the index built for this repository? | repository id, git common dir (M132) |
| `worktreeCompatible` | Was the index built for this worktree? | worktree id, root, git dir (M132) |

The scan-config hash is deliberately a **source** input, not a schema one: it
governs *which files are in scope*, so a change to it means the indexed set may
no longer correspond to the requested source state. Its recommended action stays
an incremental refresh, exactly as before M141.

## States, reasons, actions

`state` and `reason` are machine-readable enums; no caller has to parse prose.
`recommendedAction` is deliberately separate from `ready` — knowing an index is
unusable does not say how to fix it.

| State | Reason | Action |
| --- | --- | --- |
| `ready` | `fresh` | `none` |
| `source_stale` | `head_changed` / `dirty_fingerprint_changed` / `source_changed` | `incremental_refresh` |
| `schema_incompatible` | `schema_changed` | `full_rebuild` |
| `schema_incompatible` | `schema_unsupported` | `unsupported_runtime_upgrade` |
| `capability_incompatible` | `capability_missing` | `full_rebuild` |
| `repository_mismatch` | `wrong_repository` | `inspect_index` |
| `worktree_mismatch` | `wrong_worktree` | `inspect_index` |
| `index_missing` | `index_missing` | `full_rebuild` |
| `index_corrupt` | `index_unreadable` | `full_rebuild` |

`schema_unsupported` is the case a rebuild cannot fix: an index written by a
*newer* runtime than the one reading it. Re-indexing with the older binary would
produce a readable index but silently discard whatever the newer one recorded,
so the truthful action is to upgrade the runtime.

`source_stale` never recommends a full rebuild. The incremental planner resolves
it, and telling a caller to rebuild would be both slower and untrue.

## Capabilities

Two optional index capabilities are modelled, both real, both cheaply probeable,
both already optional by existing contract:

- `edge_call_sites` — M131 call-site evidence. M131 deliberately preserved
  support for older indexes that lack it.
- `document_chunks` — document retrieval fields.

`capabilityCompatible` is evaluated **against what the caller declared it
needs**, not against a global list. An index missing `edge_call_sites` is
`capability_incompatible` for a request that requires call-site evidence and
`ready` for one that does not. That difference is explicit and reported, which
is the point: silence about it is what §14 of the milestone forbids.

M140's structural `<module>` symbols are deliberately **not** modelled as a
capability. M140 avoided a schema bump because the DB already allowed
`symbols.kind = module`, so there is no truthful cheap probe distinguishing
"this index predates M140" from "this repository genuinely has no module-scope
imports". Inventing a flag would have meant either a schema bump for cosmetic
reasons or a probe that lies on small repositories.

No index schema version was bumped for M141. Readiness is derived entirely from
metadata that already existed.

## Cost

The default probe reads worktree identity and the manifest: no database open, no
content scan. `probe: "full"` additionally opens the index read-only to confirm
it parses and to read the capability tables — two cheap queries. `index_status`
and post-index verification use `full`; the hot product path does not.

Callers that already hold an open handle pass it in, and callers that already
resolved identity or fingerprints for the request pass those in too, so the
request pays for each once.

## Routing

M132 established the permanent lesson: *a primitive being implemented is not the
same as the product being routed through it.* `inspectWorktreeIndexFreshness`
existed long before every tool used it. So M141's claim is about routing, not
about a helper existing.

| Surface | How it consumes the evaluation |
| --- | --- |
| `index_status` | `evaluateIndexReadiness(probe: "full")`, reconciled into the freshness view it already returned, plus a new `indexReadiness` block |
| `get_code_context` | `evaluateIndexReadiness` + `withRuntimeSignals`; its stale envelope and diagnostics carry the summary |
| `get_context_capsule` | via the shared M119 product-context layer, which fails closed on a non-ready index |
| `run_pipeline` | via the same product-context layer, plus the readiness-reconciled freshness block |
| `index_repo` | post-index verification through the same evaluator — it constructs no independent success verdict |
| workspace repo status | same evaluator per repository |
| product-shell status (`vtrace status`) | same evaluator |
| `get_impact_graph`, `search_logic_flow` | see policy below |

`inspectWorktreeIndexFreshness` is now a projection of the evaluation and keeps
its pre-M141 status/reason/action for every input, so nothing that consumed it
changed behavior.

## One verdict, declared policies

Tools agree on the **verdict**. They differ in the **policy** they apply to it,
and that difference is declared rather than discovered:

- **`fail_closed`** — `index_status`, `get_code_context`, and the shared M119
  product-context layer inside `get_context_capsule` and `run_pipeline`. A
  non-ready index yields `resolved: false` and the shared reason code.
- **`serve_with_warning`** — `get_impact_graph` and `search_logic_flow` answer
  with bounded static evidence. This is M131's older-index contract and M141
  does not change it; changing it would alter frozen M140 behavior for no
  correctness gain.

The cross-tool matrix asserts both halves: fail-closed surfaces refuse exactly
when the evaluator refuses and name the same cause, and serve-with-warning
surfaces still answer. A tool that silently served while reporting readiness
would fail the matrix.

## Evidence

- `stage5_m141_readiness_matrix.json` — all ten states, every dimension.
- `stage5_m141_cross_tool_readiness.json` — per-state agreement across tools.
- `stage5_m141_index_status_before_after.json` — the contradiction, measured on
  the predecessor and on this implementation.
- `src/indexer/indexReadiness.test.ts`, `src/mcp/indexReadinessParity.test.ts`.
