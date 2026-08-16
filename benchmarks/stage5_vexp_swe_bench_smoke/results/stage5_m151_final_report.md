# M151 — Wire Workspace Routing into Real Product Surfaces (final report)

**Overall verdict: MIXED.**

A PASS · B PASS · C PASS · D PASS · **E MIXED**

M151's product acceptance is met: a request arriving through the real VTRACE
product surface now uses the M146–M149 workspace router to select the repository
and feeds it through the existing authoritative retrieval/Capsule pipeline, with
single-repository semantics, boundedness and evidence scope preserved.

E is MIXED — not for anything M151 does, but because two mandatory §133 gates
cannot be reported as clean and honestly attributed at the same time. Both are
pre-existing conditions reproduced at the M150 baseline. They are stated in full
in *Limitations* rather than smoothed into PASS (§135).

---

## Commits

| role | commit |
| --- | --- |
| M150 final functional (predecessor) | `2d3010e4e5eb28d5febf78c6014cd394817cb7ec` |
| M150 evidence / M151 base | `6117f5f2dfa49ab0511db904100ed0b05c7b30fe` |
| M151 final functional | `01be7197` (`Route product requests through the workspace router`) |
| M151 evidence | this commit |

`2d3010e4..6117f5f2` touches no `src/` path, so the paired predecessor root is
functionally identical to M150 final.

Branch `main`, 35 ahead of `origin/main`, **nothing pushed**, **no co-author
trailers**. 14 pre-existing worktrees preserved; 1 M151-created worktree
(`/tmp/m151-baseline`) removed at close.

---

## The gap, measured

§8 asked for the M149 finding to be reproduced rather than quoted. It was, and it
was worse than recorded.

`nominateRepositories` and `assembleWorkspaceProductContext` had no product
caller. But the product did not merely ignore the workspace layer — it refused to
serve workspaces at all. `hasMultiRepoRequest` tested whether a workspace
*existed* rather than what the request asked for:

```ts
return selection.isWorkspace || (requestedAliases !== undefined && requestedAliases.length > 0);
```

Measured through `defaultMcpToolRegistry`:

| request | before M151 | after M151 |
| --- | --- | --- |
| no `workspace.json`, `{query}` | ok | ok |
| `workspace.json`, `{query}` | **invalid_request** | ok, routed |
| `workspace.json`, `{query, repos:["alpha"]}` | **invalid_request** | ok, explicit_member |

Both remediations the error advised — "omit repos or select exactly one" — hit the
same gate, so an agent following the message looped.

Reachability of the workspace layer from the product entry points, measured as
transitive import closure (`stage5_m151_workspace_reachability_before_after.json`):

| | before | after |
| --- | --- | --- |
| capabilities reachable | **3 / 9** | **9 / 9** |

---

## Call path

**Before**

```
MCP get_code_context  → handleGetCodeContextRequest (tools.ts:8643)
                      → freshness gate
                      → run_pipeline handler
                          → hasMultiRepoRequest ─── workspace? ──▶ invalid_request
                          → withReadyRepoDb (bound root)
                          → runPipelineOrchestrator
                          → assembleProductContext
workspace router reached?  NO
```

**After**

```
MCP get_code_context  → handleGetCodeContextRequest        (unchanged wrapper)
                      → run_pipeline handler
                          → resolveProductRouteForRequest  ← NEW seam
                              → resolveWorkspaceRegistry
                              → evaluateWorkspaceReadiness
                              → nominateRepositories       (path / indexed-path / exact-symbol lanes)
                          → rebindMcpContext(lead.rootPath)
                          → withReadyRepoDb                (unchanged)
                          → runPipelineOrchestrator        (unchanged)
                          → assembleProductContext         (unchanged)
                          → composeSupportingRepositories  (opt-in → mergeRepositoryContributions)
                          → compactProductResponse         (unchanged)
workspace router reached?  YES
```

Seam: `src/workspace/productRoute.ts` → `resolveProductRoute`, consumed by
`run_pipeline` (and therefore `get_code_context`) and `get_context_capsule`.

Routing sits **before** the database binding, never at the product producer:
`run_pipeline` derives both the v1 orchestration and the product context from one
`db`, so redirecting the producer alone would leave one response describing two
repositories.

## Surfaces

| surface | workspace-aware | note |
| --- | --- | --- |
| `get_code_context` | yes | via `run_pipeline` delegation |
| `run_pipeline` | yes | direct |
| `get_context_capsule` | yes | same resolver, same lead — verified to agree |
| `index_status` | bounded census only | readiness untouched, per repository |
| CLI `run-pipeline` / `capsule` | **no** | documented, not claimed (§146) — they take an explicit repository path, which is the branch routing never overrides |

## Where routing may decide

M132's precedence is unchanged; routing is inserted only into its lowest branch.

| request | behaviour |
| --- | --- |
| explicit `repo_root` | unchanged, routing does not run |
| explicit `repos:[alias]` | that member, routing does not re-decide |
| no root, no workspace | unchanged single-repo path, nothing probed |
| no root, workspace present | **routed** |

---

## Single-repository preservation (§11, §102)

`stage5_m151_single_repo_parity.json` — **semantic hash identical across all three**:

| case | lead | outcome | context semantic hash |
| --- | --- | --- | --- |
| no workspace config | alpha | single_repository | identical |
| one-member workspace | alpha | routed | identical |
| two-member workspace | alpha | routed | identical |

The third row is the hard control you asked for: **a supporting member merely
existing does not change the lead's delivered content.** Asserted directly in
`src/mcp/workspaceProductRouting.test.ts`, not inferred from the design.

---

## Product corpus (§99, §141)

16 cases, all through the real MCP surface (`stage5_m151_workspace_product_corpus.json`).
A refusal is a *result*, not a failure — declining is correct behaviour in four of them.

| case | outcome | lead |
| --- | --- | --- |
| single_member_direct_route | routed | alpha |
| single_member_behavioural_query | configured_member | alpha |
| unique_exact_symbol | routed (exact_symbol) | beta |
| unique_exact_path | routed (indexed_path) | beta |
| absolute_path_containment | routed (path_containment, 0 indexes opened) | beta |
| path_outside_workspace | configured_member | alpha |
| behavioural_route_no_evidence | configured_member | alpha |
| absent_symbol_all_members_checked | configured_member | alpha |
| explicit_member_selection | explicit_member | beta |
| explicit_unknown_member | **declined** | — |
| duplicate_exact_symbol | **declined** (abstain) | — |
| ambiguous_same_relative_path | **declined** (abstain) | — |
| multi_repo_supporting_composition | explicit_member + support | dupa |
| ready_plus_refused_member | sole_evidence_match | alpha |
| symbol_only_in_refused_member | configured_member | alpha |
| all_members_refused | **declined** | — |

## Real repositories (§63–§66, §76, §77)

`stage5_m151_real_repo_acceptance.json`. **M150's headline behaviour survives the
wiring:**

| § | case | routed to | lead pivot |
| --- | --- | --- | --- |
| §63 | ARC family selection | arc | **`determine_family`** |
| §64 | ARC family ordering | arc | **`get_all_families`** |
| §66 | exact symbol, no repo named | arc (routed) | `determine_possible_reaction_products_from_family` |
| §65 | explicit ARC path | arc | `get_reaction_family_products` |
| §76 | TCKDB scoped | tckdb | `PropertyTableConfig` |
| §77 | mixed, ARC identifier | arc (routed) | `determine_family` |
| §77 | mixed, host identifier | host (routed) | `host_marker` |
| §77 | mixed, ambiguous prose | arc (configured_member) | — |
| §74/§75 | prose says "ARC" | arc (configured_member, **not** routed by name) | — |

§63 and §64 reproduce M150's required results exactly: selection leads with
`determine_family`, ordering leads with `get_all_families`.

## Repository identity is not symbol evidence (§74, §75)

The hint extractor refuses bare tokens. A path needs a separator plus an extension
or an absolute root; an identifier needs an underscore, a qualifier, a call, or an
explicit backtick quotation. **A bare all-caps token is inert**, so `ARC` in prose
never becomes symbol evidence — proven both as a unit control and through the real
3-member ARC/TCKDB/host workspace.

---

## Bounds

### Response scale (§143) — flat

| members | routing bytes | total response bytes | examples emitted | selected repos |
| ---: | ---: | ---: | ---: | ---: |
| 11 | 1,568 | 20,338 | 4 | 1 |
| 100 | 1,576 | 20,345 | 4 | 1 |
| 1000 | 1,586 | 20,357 | 4 | 1 |

18 bytes of growth across 989 additional members — wider integers, nothing more.

### `index_status` (§124)

| members | all ready | bytes | `repos` records | `omittedByBound` | `coverageComplete` |
| ---: | :---: | ---: | ---: | ---: | :---: |
| 11 | no | 10,039 | 4 | 7 | false |
| 100 | no | 10,044 | 4 | 96 | false |
| 1000 | no | 10,051 | 4 | 996 | false |
| 11 | **yes** | 11,765 | 4 | 7 | **true** |

The last row is the shape that matters: **`coverageComplete: true` with
`omittedByBound: 7`.** Truth comes from the full census; the list is a bounded
sample. Serialization truncation and epistemic completeness are independent, and
`repos` order follows the config, not the filesystem.

### Index opens (§145)

| members | inspected for route | opened for retrieval | **refused opened** |
| ---: | ---: | ---: | ---: |
| 11 | 1 | 1 | **0** |
| 100 | 1 | 1 | **0** |
| 1000 | 1 | 1 | **0** |

### Latency (§144, §57) — measured, not projected

| scenario | get_code_context | index_status |
| --- | ---: | ---: |
| 2-member fixture (both indexed) | 54.8 ms | — |
| 11-member synthetic | 51.6 ms | 14.4 ms |
| 100-member synthetic | 47.0 ms | 44.8 ms |
| 1000-member synthetic | 57.4 ms | **360.3 ms** |

Product routing does **not** scale with workspace size. `index_status` does — see
Limitations.

---

## Preservation

| gate | result |
| --- | --- |
| Frozen50 (django 20 + cross_repo_30 30) | **0/50 changed**, provenance valid |
| M150 behavioural (ARC selection + ordering) | preserved, verified through the wired path |
| M149 claim truthfulness | preserved — coverage survives MCP serialization; no claim strengthened |
| M148 indexed-path / lifecycle | preserved; read paths add no migration |
| M147 exact-symbol + absent lookup | preserved; `uniquenessProven` carries the proof state |
| M146 derivation compatibility | unchanged |
| M141 readiness | unchanged, and kept separate from routing completeness |
| M142 / M140 / M139 | untouched — no retrieval, ranking or graph edit |
| index schema / derivation fingerprints | **unchanged** (§117) |
| product response schema | additive only, no version bump (§41, §118) |

§113 is respected: the 0/50 result is **structural, not lucky**. These suites call
retrieval through `createHistoricalEvaluator` with one explicit repository root and
never construct an MCP request, so no workspace config is read and the router is
not on their call path. It rules out retrieval moving as a side effect; it is not
evidence the wiring works. The product corpus is that evidence.

## Verification

```
bun test                    4599 pass · 0 fail · 49 skip   (4648 across 285 files)
bun run typecheck           clean
bun run typecheck:benchmarks clean
git diff --check            clean
```

Baseline note: the M150 tree measured **4561 pass / 49 skip** in this same
environment, so M151 adds 38 tests and changes no existing result. M150's report
recorded 4602 pass; that figure was measured in a different environment state and
is not reproducible here — stated rather than quietly adopted.

---

## Limitations

**1. Read paths mutate the lead repository's index. Pre-existing.**

Three consecutive `get_code_context` calls against ARC produced three different
file hashes (size stable after the first). The M150 baseline tree reproduces this
exactly, so it is the long-standing behaviour of `withReadyRepoDb` →
`openIndexerDatabase`, which runs the schema initializer against whichever
repository retrieval binds to.

Every path **M151 adds** is read-only: the routing probe and the supporting-repo
composition open members with `{ readonly: true }`, and a member probed for a
route but not led is byte-identical afterwards (asserted in the test suite). So
§21/§90 hold for M151's additions and do **not** hold for the pre-existing lead
binding. This is why E is MIXED rather than PASS, and it is the first thing M152
should fix.

**2. ARC and TCKDB indexes were rebuilt as authorized setup.**

Both were `possibly_stale / schema_changed`, so `assembleProductContext` failed
closed and delivered 0 items for every real query — identically at the M150
baseline. Rebuilt under explicit user authorization through the supported
`index_repo` write path, with identity, readiness, source HEAD and hashes recorded
before and after (`stage5_m151_index_rebuild_provenance.json`). ARC 29.8 s,
TCKDB 150.9 s; both `ready=true` and correctly bound afterwards. Stale→fresh
differences are **not** attributed to M151, and the paired comparison ran both
functional sides against the same rebuilt state.

**3. `index_status` latency is O(members).** 360 ms at 1000 members, because
`inspectWorkspaceRepoStatus` runs a full readiness probe per member. The
*response* is bounded; the *work* is not. Measured, not redesigned (§58).

**4. No behavioural repository-relevance lane exists.** M146–M149 provide four
tiers: explicit route, path containment, indexed path, exact symbol. A query
naming no path and no identifier carries no routing evidence, so it reaches the
workspace's configured default or abstains. §26 forbade inventing one and §73–§75
forbid routing on repository-name tokens, so this is a reported ceiling, not a
defect. §77's "ARC query → ARC without repository-name hacks" holds only when the
query names an ARC identifier or path.

**5. Three real indexed repositories.** §59 still applies: real controls are 1–3
members; 11/100/1000 are synthetic and labelled as such throughout.

**6. Explicit multi-alias selection is rejected.** `repos: [a, b]` returns
`invalid_request` naming the opt-in flag. Composition is reachable via
`include_supporting_repos` on a routed request.

---

## Recommended M152 scope

M151's own precondition for M152 is met — the workspace layer is product-reachable.
Before richer cross-repository semantics, M152 should:

1. **Remove the read-path write** (limitation 1). It is a correctness invariant the
   whole workspace story now depends on, and it is one binding.
2. **Make `index_status` coverage O(1)-ish** by reading manifest metadata instead of
   probing every member (limitation 3).
3. Then the intended M152 subject: cross-repository dependency and evidence
   composition — implementation in A depending on generated/client behaviour in B,
   one concept split across repositories, ownership vs support, bounded cross-repo
   dependency slices.

## Artifacts

```
stage5_m151_plan.md
stage5_m151_product_call_path_audit.md
stage5_m151_authoritative_product_seam.md
stage5_m151_workspace_reachability_before_after.json
stage5_m151_workspace_product_corpus.json
stage5_m151_single_repo_parity.json
stage5_m151_real_repo_acceptance.json
stage5_m151_response_size_scale.json
stage5_m151_latency_scale.json
stage5_m151_index_open_counts.json
stage5_m151_index_status_workspace_coverage.json
stage5_m151_index_rebuild_provenance.json
stage5_m151_paired_comparison.json
stage5_m151_final_report.md
```

Runners: `run_stage5_m151_{reachability,product_corpus,real_acceptance,index_rebuild,paired_benchmark}.ts`
