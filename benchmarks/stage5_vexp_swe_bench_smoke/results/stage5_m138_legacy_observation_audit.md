# M138 legacy ARC observation audit

The real ARC database was inspected read-only. No observation was modified or deleted.

| Observation | Created (Asia/Jerusalem) | Stored result | Stored identity | Provenance state | Root-cause finding |
|---|---:|---:|---|---|---|
| `11eb5007…` | 2026-08-09 16:21:15 | 1327 dependents / 95 files | `/home/calvin/code/ARC`, index run 2, `get_impact_graph`, exact FQN | `PROVENANCE_INCOMPLETE` | Created minutes after the M132 index build and before M133. The exact loaded server/process commit was not stored. Older unbounded impact semantics are the likely source, but cannot be asserted as recorded fact. |
| `de8a260e…` | 2026-08-09 19:11:49 | 10 dependents / 7 files | same absolute root, same run 2, same tool/FQN | `PROVENANCE_INCOMPLETE` | This is the pre-envelope impact working result. For `max_edges:10,max_tokens:1200`, the core graph is 10/7 while the bounded product response is 3/3. Pre-M138 auto-capture ran before response compaction. |
| current tool | 2026-08-09 acceptance | 3 dependents / 3 files | current requested ARC worktree and bounded product response | current authoritative tool evidence | The delivered response is authoritative. M138 moves impact auto-capture after final response compaction, so new memory records the delivered 3/3 result. |

The run-2 `index.meta.json` identifies ARC HEAD `1202705…`, worktree `c85329dd…`, and VTRACE index-build commit `bb65f09…` (M132 evidence). It is a clean M132 worktree-aware index, so neither row is classified as a proven pre-M132 contaminated-index observation. The observation table did not store the index manifest reference or generating implementation, so the process identity remains unknowable.

## Why previous replay was unsafe

The old schema stored absolute `repo_root`, local `source_run_id`, tool/query prose, links, and timestamp. It did not store canonical repository/worktree IDs, HEAD/dirty state, index capability/identity, implementation identity, tool capability, normalized semantic options, or result hash. `searchMemory` used lexical/structural score plus a file/symbol-diff penalty. Missing `source_run_id` was considered fresh; repository/worktree compatibility was never evaluated. `getSessionContext` returned recent rows without even that ranking gate. Automatic run-pipeline/product/capsule memory inherited the same behavior.

Thus provenance was both absent and unenforced. In addition, the 10/7 row revealed a capture seam bug: storage observed an internal result that differed from the final 3/3 tool response.

## Migration decision

Legacy rows remain intact. Additive nullable columns allow mixed old/new stores. No deterministic source exists for the missing implementation/worktree snapshots, so no backfill invents current identity. Legacy technical rows are `PROVENANCE_INCOMPLETE`, suppressed from normal current truth, and available through explicit historical mode with that label.
