# M138 — Observation and Memory Provenance Freshness

## Verdict

**PASS.** Stored technical evidence is now bound to repository, worktree,
source, index, VTRACE implementation, tool semantics, request semantics, and
result identity. Normal replay admits only current/current-compatible evidence;
explicit historical replay retains and labels stale, foreign, superseded, and
legacy-incomplete observations. No observation was purged, retrieval was not
tuned, and workspace aggregation was not extended.

| identity | value |
|---|---|
| starting branch / HEAD | `main` / `44f58d7f98b883f86ceec8187e7d65eda06fa23e` |
| M137 functional predecessor | `68514687df2056d1c3551ea3285503dc6449023f` |
| M138 functional commit | `3c4be01ed73d78d73572602810cfdfbbfa943275` |
| functional tree | `2f3cc82cfecd01dd99336eedf4cbe00b1adf360e` |
| starting ahead / behind | 12 / 0 |
| pushed | no |

The evidence commit containing this report is identified after commit; a commit
cannot truthfully contain its own hash.

## Root cause and real ARC incident

The pre-M138 observation row stored an absolute `repo_root`, local index-run ID,
tool/query prose, links, and timestamp. It did **not** store canonical repository
or worktree IDs, HEAD/dirty identity, index manifest/capabilities, generating
VTRACE implementation, tool capability, normalized semantic options, or a
semantic result hash. Replay compounded the omission:

- `searchMemory` ranked by textual/structural relevance and only applied the old
  file/symbol-diff staleness penalty. It did not gate by repository/worktree.
- a missing source run was treated as fresh by the old staleness service;
- `getSessionContext` returned recent observations without that penalty;
- Capsule, product-context, and run-pipeline memory inherited these unsafe rows.

The two contradictory ARC rows did not have one proven cause. The real database
was audited read-only:

| Observation | Stored result | Created (Asia/Jerusalem) | Provenance state | Normal current mode | Historical mode |
|---|---:|---|---|---|---|
| `11eb5007…` | 1327 / 95 | 2026-08-09 16:21:15 | `provenance_incomplete`; pre-M133/unbounded semantics are likely, but the live process commit was not stored | suppressed | visible, labeled incomplete |
| `de8a260e…` | 10 / 7 | 2026-08-09 19:11:49 | `provenance_incomplete`; captured the pre-envelope working graph | suppressed | visible, labeled incomplete |
| current tool | 3 / 3 | M138 acceptance | current bounded product evidence | authoritative tool result and new current observation | current |

Both old rows point to ARC index run 2. Its manifest records ARC HEAD
`1202705…`, worktree `c85329dd…`, and M132 evidence build `bb65f09…`. It is a
clean M132 worktree-aware index; M138 does **not** invent a pre-M132
contamination label. The 10/7 defect was independently reproduced: the core
graph before response compaction is 10/7, while M133's canonical bounded result
is 3/3. M138 moves auto-capture after final compaction, so stored tool evidence
now equals delivered evidence.

## Schema, scope, and origin

Schema version `1` adds nullable columns without rewriting old rows:

`scope`, `origin`, `provenance_json`, `semantic_key`,
`result_semantic_hash`, and `supersedes_observation_id`.

The provenance record contains:

- canonical repository ID; worktree ID/root; HEAD; branch/detached metadata;
  dirty fingerprint;
- index identity/run, owning worktree/HEAD/dirty snapshot, format/schema,
  indexer/parser/config fingerprints;
- VTRACE commit/tree/dirty fingerprint and memory capability fingerprint;
- tool, normalized query, semantic options, and tool capability fingerprint;
- stable structured result hash and optional typed result summary.

Scopes are deterministic: `global`, `repository`, `worktree`, `source_state`,
and `index_state`. Tool-derived repository facts default to `index_state`;
manual linked/tool facts do likewise; ordinary manual workflow notes default to
`repository`; explicitly global procedural notes remain applicable across source
changes. Origins distinguish `manual`, `tool_derived`, `automatic_capture`,
`benchmark`, and `migration`. Missing legacy scope is unknown, never global.

Technical auto-capture covers Capsule/product tools, impact, flow, skeleton,
memory/session reads, reference expansion, and index-event anti-patterns.
Compression/consolidation inherits common source provenance only when every
input agrees; it never assigns today's provenance to legacy evidence.

## Shared compatibility policy

One pure `classifyObservationCompatibility` evaluator is reused by
`search_memory`, `get_session_context`, Capsule memory selection, product
context, and run-pipeline durable/session injection. Current Git/index state is
resolved once per request using the M132 worktree identity and requested
`repo_root`, not server startup CWD; N observations incur no N×Git calls.

| context relationship | state | current-truth eligible |
|---|---|---:|
| exact repo/worktree/HEAD/dirty/index/implementation | `current` | yes |
| older clean implementation, same memory and tool capability fingerprints | `current_compatible` | yes |
| same repo/worktree, changed HEAD | `stale_repo_state` | no |
| same HEAD, different dirty fingerprint | `stale_dirty_state` | no |
| same canonical repo, different worktree | `stale_worktree` | no |
| different canonical repository | `foreign_repository` | no |
| corrected/different index identity or capability | `stale_index` | no |
| tool/memory capability mismatch or non-exact dirty implementation | `superseded_implementation` | no |
| legacy/unsupported provenance schema | `provenance_incomplete` | no |
| explicit global procedural note | `applicable` | yes |

Repository/worktree/HEAD/dirty and index ownership are hard gates at their
respective scope. Branch name and absolute display path are not freshness
proofs. An older clean VTRACE commit is only a warning-compatible change when
the narrow memory and generating-tool capability fingerprints match. A dirty
implementation mismatch fails closed because an uncommitted semantic change
cannot be proven harmless. Capability bumps replace a milestone blacklist and
cover corrected flow, worktree/index, bounded impact, query, and direct-answer
semantics.

Compatibility is evaluated dynamically, so clean A → dirty B → exact clean A
becomes compatible again. Matching branch names cannot hide HEAD movement;
detached HEAD uses commit and dirty identity.

## Replay behavior, conflicts, and legacy handling

Normal `search_memory` filters incompatible evidence before final ordering and
serialization. Compatibility precedes relevance/recency; textual relevance is
otherwise unchanged. Compact accounting reports current matches and suppressed
stale/foreign/incomplete counts. `includeStale:true` returns bounded historical
evidence with compatibility state, reason codes, observed HEAD/worktree,
implementation, and index identity.

Exact `(semantic context, result hash)` repeats are deduplicated. Two
current-compatible structured observations with the same semantic key and
different result hashes produce `conflicts`; newest is not silently selected.
Old observations remain stored. No destructive migration or backfill ran.

The real ARC normal query returned no current-compatible row before the current
tool call and suppressed both incident rows (six total legacy rows matched the
broad text query). After the isolated 3/3 tool call, normal memory returned only
the provenance-complete 3/3 observation. Historical mode returned 3/3 current,
10/7 incomplete, and 1327/95 incomplete with unambiguous labels.

Legacy schema upgrade, mixed old/new stores, restart round-trip, missing
provenance, same-context replay, changed HEAD/dirty, exact-state restoration,
different worktree/repository, index capability mismatch, implementation
compatibility, global/repository notes, duplicate suppression, and conflicting
current results are all covered deterministically.

## Product-surface safety

- `search_memory`: current-compatible default, explicit bounded historical
  mode, accounting and conflicts.
- `get_session_context`: recent and ranked technical observations pass through
  the same evaluator; stale rows are suppressed by default and labeled only in
  historical mode.
- Capsule/product context/run pipeline: automatic memory injection uses the
  shared evaluator. A strongly matching legacy technical claim was absent from
  model-visible durable memory.
- `expand_vexp_ref` does not replay arbitrary observations; its own automatic
  capture is provenance-complete.
- `workspace_setup` does not inject observation memory.

No result is automatically refreshed and no expensive tool is rerun merely to
answer memory. Current live tool evidence remains authoritative when another
product path already has it.

## Isolation, envelope, and performance

Controlled same-repository worktrees classify each other's technical evidence
as `stale_worktree`; different repositories classify as
`foreign_repository`. The evaluator uses requested worktree identity, preserving
server-CWD A/requested-worktree B routing. Index-state evidence also requires the
manifest to own the observation and current source snapshot.

With 1,000 matching stale rows, normal search returned 0 and suppressed 1,000;
historical search returned the requested maximum 5; session context returned 0.
Measured on this host:

| operation | measurement |
|---|---:|
| pure classification, 1,000 rows | 0.241 ms (0.241 µs/row) |
| current search, 1,000 matches | 10.986 ms |
| historical search, bounded to 5 | 10.510 ms |
| session filtering, 1,000 rows | 14.986 ms |
| one current-context resolution | 16.503 ms |
| provenance build + SQLite persist, 1,000 rows | 65.297 ms (0.065 ms/save) |

Persistent provenance has a `(scope, semantic_key, created_at, id)` index. The
current store size justifies bounded in-memory compatibility after existing
semantic search; it avoids a database redesign. Current context resolves once,
and compatibility performs zero Git calls per observation.

## Preservation evidence

M134's provenance-safe evaluator loaded clean exact M137 `68514687` and M138
`3c4be01e` code against separate, independently generated and retained target
indexes whose fixture and target-corpus hashes match. Indexing/retrieval
semantics did not change in M138.

| suite | cases | selected | lead | roles | modes | context | tokens | metrics |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Django expanded | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cross_repo_30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| frozen 50 aggregate | 50 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Additional acceptance:

- M137 exact ARC query at 3,000 tokens: `get_dihedral` lead, retrieval found,
  visible, within envelope; `in` absent from symbol hypotheses; project name is
  not a symbol hypothesis.
- M133 impact: current `get_dihedral` 3 dependents/3 files, 3 bounded edges,
  `withinEnvelope:true`.
- M131 flow: `reorder_p_label_map → map_two_species`, one exact `calls` edge,
  `edge_site` provenance.
- M132: nested-worktree exclusion, explicit requested-worktree routing, and
  cross-worktree isolation remain green in the full suite.
- TCKDB at unchanged HEAD `6d460d5…`: exact M137/M138 same-index selection,
  lead, roles, and content modes are identical; source remained read-only and
  pre-existing `paper/` stayed untouched.

## Verification and safety

- `bun run typecheck`: PASS
- `bun run typecheck:benchmarks`: PASS
- `bun test`: an earlier normal-filesystem full run passed with 0 failures. The
  final quota-isolated run completed 3,917 pass / 49 skip with three fixed
  5-second performance timeouts on the slower sibling filesystem; each exact
  timed-out test was rerun on normal `/tmp` and passed (350 ms, 4,210 ms, and
  204 ms). No correctness assertion remains failing.
- dedicated M138 provenance suite: 7/7 PASS
- anti-pattern/reindex/watcher focused suite: 21/21 PASS
- structural capture regression: PASS
- M137→M138 paired frozen 50: 0 differences
- deterministic M138 no-agent smoke: PASS
- `git diff --check`: PASS

No `@ts-nocheck` was added. Existing unchecked MCP wrappers remain thin; capture,
classification, filtering, and conflict logic are typed modules. No agents,
Docker, VEXP, live SWE-bench, paid API, network service, or destructive memory
operation ran. ARC/TCKDB source and real historical memory were not modified.

## Completion matrix

| area | verdict |
|---|---|
| provenance capture / typed scope / legacy records | PASS |
| current context / HEAD / dirty freshness | PASS |
| worktree / repository isolation | PASS |
| index / implementation compatibility | PASS |
| stale suppression / historical replay | PASS |
| conflict detection | PASS |
| `search_memory` / `get_session_context` integration | PASS |
| automatic injection safety | PASS |
| response envelope | PASS |
| M137 retrieval / M136 delivery | PASS |
| impact / flow / worktree preservation | PASS |
| paired benchmark provenance / TCKDB | PASS |
| performance / type safety / safety / hygiene | PASS |

## Artifacts

Tracked M138 evidence includes the plan, schema, compatibility matrix, legacy
audit, real ARC current/historical results, worktree/repository/HEAD/dirty
fixtures, conflict and session evidence, scale/envelope measurements,
M137-paired comparison, flow/impact/exact-answer preservation, TCKDB parity,
no-agent smoke, and this report. Full mutable databases, target corpora, raw
paired artifacts, temporary worktrees, logs, and agent streams are not tracked.

## Limitations and recommendation

Legacy rows cannot be safely enriched when the generating process did not store
its identities; they remain available as `provenance_incomplete`. Capability
fingerprints require disciplined bumps when tool semantics change. Compatibility
filtering currently follows existing bounded lexical candidate collection rather
than pushing every gate into SQL. M138 deliberately adds no purge UI, background
refresh, NLP contradiction detection, or multi-repository aggregation.

Proceed to **M139 — Workspace and Repository Identity Foundation**. Each future
registered repository/worktree must remain its own provenance domain; indexes,
observations, and memory must never be flattened without explicit qualification.

Permanent testing principle: **stored evidence must be tested across
source-context changes, not only write/read round-trips.** The missing memory
dimension was context freshness.
