# M184 — outstanding defects and historical corrections

## Status table

| Finding | Status | Reproduced? | Product consequence | Blocks failure-stage audit? |
|---|---|---:|---|---|
| silent missing-materialization no-op | **repaired in M184** | yes, 7 states, generically | `vtrace index` could exit 0 reporting `status: indexed` over an empty database; the next query answered `Repo not indexed` | no |
| M183 utility neutral | closed evidence | yes | none — M183's conclusion stands unmodified | no |
| M182 1,229 default-size measurement error | historical correction | yes | none — labelling only, no code change | no |
| stale `VTRACE_TOOLING_AUDIT.md` | debt (unowned, untracked) | yes | docs only | no |
| `modelVisibleEstimatedTokens` naming/accounting | debt (inherited) | not re-measured in M184 | misleading field name; token authority is the harness result row | no |
| `edge_call_sites` orphans survive an out-of-band graph wipe | observation, not repaired | yes (synthetic) | a database whose `edges` were deleted with `PRAGMA foreign_keys=OFF` fails the next index with a UNIQUE violation — exit 1 and a truthful message, never false success | no |
| M183 failure-stage mechanism | not started | n/a | n/a | **next** |

## 1. Silent missing-materialization no-op — REPAIRED

M183 recorded this as debt needing "a milestone that can afford the retrieval
no-change proof". M184 is that milestone. Two things M183 did not have:

- **The manifest path is defective too.** With `.vtrace/index.meta.json` intact
  and only `index.sqlite` deleted, the durable registry is never consulted and the
  local manifest alone certifies an empty database as current. The defect was
  never confined to `.git/vtrace`.
- **A never-indexed sibling worktree.** The registry is keyed by `repositoryId`,
  shared by every worktree. A brand-new worktree's *first* `vtrace index` adopted
  a sibling's snapshot and produced an empty index. `vtrace init` was already safe
  — it passes `hasExistingGraph: false`, the one option the dead guard tested —
  which is exactly why the defect hid: the guard existed and no CLI path reached it.

Repaired by `evaluateMaterializedGraph` gating no-op eligibility. See
`stage5_m184_index_authority_map.md` and `stage5_m184_final_report.md`.

## 2. `index.meta.json` `vtrace_commit` tracks git HEAD, not product identity

Inherited from M183 §2 and **not** repaired here. Unchanged: `indexer_fingerprint`,
`parser_fingerprint` and `config_hash` are the product-derived fields, and they are
what `resolveDerivationRebuildReason` actually compares.

M184 encountered the consequence directly: reverting product source to build the
predecessor arm moved `indexer_fingerprint`, which correctly invalidated an index
built by the other arm. Any future paired product comparison must give each arm its
own index over the same immutable corpus, or it measures freshness rather than the
change under test.

## 3. HISTORICAL_MEASUREMENT_CORRECTION — M182's "current default orientation size"

M182's standing finding records the current default orientation size as **1,229
median / 1,527 p90 / 1,576 max** model-facing tokens. M183 measured the actual
default call on all thirty of its manifest cases at **579.5 / 814 / 941**.

The 1,229 figure is the `atDefaultBudget` slice of M181's budget **ladder** — the
rung where `max_tokens` was passed explicitly as 8,000. `defaultBudget` there names
a configured budget CONSTANT, not the behaviour of a default call. Re-running the
8,000 rung on M183's different sample reproduced it (1,245.5 vs 1,229); the default
call did not, because it is a different operating point.

Recorded as `HISTORICAL_MEASUREMENT_CORRECTION`. **M182's history is not
rewritten**, and **no product code changed because of it**. The correct neighbour
for a live default median is M182's own all-delivering-budgets median of 542.

## 4. Inherited documentation debt — UNOWNED

`VTRACE_TOOLING_AUDIT.md` remains untracked, pre-existing and stale (known stale
claims: the M179-fixed django orientation→delivery_failure defect described as
open; the M172-removed five-entry orientation cap described as current). M184 does
not edit or stage it (§55). Taking ownership of an untracked working document is
not this milestone's job.

## 5. `edge_call_sites` orphan observation — NOT a repair target

The persist transaction's wholesale invalidation deletes `edges` and relies on
`ON DELETE CASCADE` to clear `edge_call_sites`. That is correct under the product's
own writes, which always run with foreign keys enforced. A database whose `edges`
were emptied out-of-band with `PRAGMA foreign_keys=OFF` retains orphan call sites
and the next index fails with `UNIQUE constraint failed: edge_call_sites.edge_id,
edge_call_sites.ordinal`.

This surfaced only because an M184 fixture used the `sqlite3` CLI, whose default is
`foreign_keys=OFF`. It is out of scope, and the behaviour it produces — exit 1 with
a truthful message — is on the correct side of §24. Recorded so it is not
rediscovered as a regression.
