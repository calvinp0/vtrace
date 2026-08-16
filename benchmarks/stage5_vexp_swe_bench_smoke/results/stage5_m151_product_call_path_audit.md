# M151-A — Product call-path and authority audit

Predecessor (M150 final functional): `2d3010e4e5eb28d5febf78c6014cd394817cb7ec`
Audit performed at: `6117f5f2dfa49ab0511db904100ed0b05c7b30fe` (M150 evidence commit, clean tree
for tracked source).

This audit is a precondition of any M151 implementation (§7, §129). Nothing was
edited before it was complete.

---

## 1. Entry points actually present

Naming from earlier milestones was **not** assumed (§7). The live MCP tool surface was
enumerated from `defaultMcpToolRegistry` registrations in `src/mcp/tools.ts`:

```
expand_vexp_ref     index_repo          search_symbols      build_capsule
build_handoff       route_query         list_runs           check_capsule_staleness
save_observation    search_memory       get_session_context list_sessions
read_session        run_pipeline        get_code_context    get_context_capsule
get_impact_graph    search_logic_flow   get_skeleton        index_status
workspace_setup
```

The product-context surfaces are `run_pipeline`, `get_code_context`,
`get_context_capsule`; the status surfaces are `index_status` and `workspace_setup`.

## 2. Traced call paths (BEFORE M151)

### `get_code_context`

| stage | function | file:line |
| --- | --- | --- |
| entry | `handleGetCodeContextRequest` | `src/mcp/tools.ts:8643` |
| repo resolution | `resolveRequestedRepoRoot` → `routeRequestedWorktree` → `resolveWorktreeRouting` | `tools.ts:3938`, `tools.ts:3947`, `src/mcp/worktreeRouting.ts` |
| rebind | `rebindMcpContext` | `tools.ts:3978` |
| freshness gate | `checkIndexForGetCodeContext` | `tools.ts` |
| **delegation** | `RUN_PIPELINE_TOOL_DEFINITION.handler` | `tools.ts:8750` |
| post-process | `remeasureResponseBudget` | `src/mcp/responseEnvelope.ts` |

`get_code_context` owns no retrieval of its own. It is a freshness/auto-refresh
wrapper that delegates the entire request to `run_pipeline`.

### `run_pipeline`

| stage | function | file:line |
| --- | --- | --- |
| entry | registered handler | `tools.ts:8067` |
| **workspace gate** | `resolveWorkspaceRepoSelection` + `hasMultiRepoRequest` | `tools.ts:8384`, `tools.ts:8390` |
| binding | `withReadyRepoDb` → `resolveReadyRepoBinding` → `openIndexerDatabase` | `tools.ts:4122`, `tools.ts:3995` |
| retrieval | `runPipelineOrchestrator` | `src/runPipeline/runPipelineOrchestrator.ts` |
| **product producer** | `assembleProductContext` | `tools.ts:8522` |
| provenance stamp | inline `routingSourceFor` | `tools.ts:8541` |
| serializer | `compactProductResponse` | `src/mcp/responseEnvelope.ts` |

### `get_context_capsule`

| stage | function | file:line |
| --- | --- | --- |
| entry | registered handler | `tools.ts:9029` |
| **workspace gate** | `resolveWorkspaceRepoSelection` + `hasMultiRepoRequest` | `tools.ts:9218`, `tools.ts:9224` |
| binding | `withReadyRepoDb` | `tools.ts:4122` |
| **product producer** | `assembleProductContext` | `tools.ts:9253` |

### CLI

| command | product producer | file:line | workspace-aware |
| --- | --- | --- | --- |
| `run-pipeline` | `assembleProductContext` | `src/cli/commands/runPipelineCommand.ts:86` | **no** |
| `capsule` | `assembleProductContext` | `src/cli/commands/capsuleCommand.ts:160` | **no** |
| `workspace` | `resolveWorkspaceRegistry` + `evaluateWorkspaceReadiness` | `src/cli/commands/workspaceCommand.ts:140,200` | yes (status only) |

### `index_status`

| stage | function | file:line |
| --- | --- | --- |
| entry | registered handler | `tools.ts:9747` |
| workspace enumeration | `resolveWorkspaceRepoSelection` | `tools.ts:9785` |
| workspace branch | raw `statuses.map(formatWorkspaceRepoStatus)` | `tools.ts:9798` |
| single-repo branch | `inspectIndexStatus` | `tools.ts:5874` |

---

## 3. Reachability of the M146–M149 workspace layer

Reproduced from the current M150 final state (§8):

```
rg 'nominateRepositories|assembleWorkspaceProductContext' src/mcp src/cli src/runPipeline
→ (no matches)
```

Full-tree matches for those two symbols outside their own module:
`src/workspace/*.test.ts` and `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m14{8,9}_*.ts`
only.

The finding **still holds for the routing/composition half**, but it must be stated
more precisely than M149 did, because the registry/readiness half is no longer
unreachable:

| workspace capability | module | reachable from a product surface? |
| --- | --- | --- |
| `resolveWorkspaceRegistry` | `registry.ts` | **yes** — `cli/commands/workspaceCommand.ts` (status command only) |
| `evaluateWorkspaceReadiness` | `readiness.ts` | **yes** — same command |
| `nominateRepositories` | `repositoryRelevance.ts` | **no** |
| `assembleWorkspaceProductContext` | `workspaceProductContext.ts` | **no** |
| `createPathMembershipResolver` | `pathMembership.ts` | **no** |
| `proveExactUniqueness` | `repositoryPresence.ts` | **no** |
| `aggregateCrossRepoContext` | `crossRepoAggregation.ts` | **no** |
| `composeCoverage` / claim classifiers | `evidenceClaims.ts` | **no** |

So the accurate M151 gap statement is: **workspace identity and readiness are wired
to a status command; workspace ROUTING, PATH/SYMBOL MEMBERSHIP, EVIDENCE CLAIMS and
CROSS-REPO COMPOSITION are wired to nothing.**

---

## 4. The gap is not passive — measured

`nominateRepositories` being uncalled would be a missed capability. What is actually
there is a refusal. Measured through the real MCP registry (probe: two indexed
repositories, a `workspace.json` registering both, `get_code_context` called via
`defaultMcpToolRegistry`):

| request | result |
| --- | --- |
| no `workspace.json` present, `{query}` | `ok: true` — context returned |
| `workspace.json` present, `{query}` (no `repos`) | `ok: false` — `invalid_request` |
| `workspace.json` present, `{query, repos:["alpha"]}` | `ok: false` — `invalid_request` |

Message in both failing cases:

```
The authoritative capsule is currently single-repo; omit repos or select exactly one.
```

Two consequences, both defects independent of routing:

1. **A configured workspace disables the primary product surface entirely.** Merely
   creating `workspace.json` at the bound root turns every `get_code_context`,
   `run_pipeline` and `get_context_capsule` call into `invalid_request`. There is no
   degraded answer; there is no answer.

2. **The remediation the message names cannot be performed.** The gate is
   `hasMultiRepoRequest` (`tools.ts:4349`):

   ```ts
   return selection.isWorkspace || (requestedAliases !== undefined && requestedAliases.length > 0);
   ```

   `isWorkspace` is `workspaceConfig !== undefined` — true whenever the config file
   exists, whatever `repos` holds. So "omit repos" fails and "select exactly one"
   fails. The advice is unsatisfiable, and an agent following it loops.

## 5. Second measured defect — unbounded member metadata on `index_status`

`index_status` in a workspace returns (`tools.ts:9798`):

```ts
repos: selection.selection.statuses.map(formatWorkspaceRepoStatus)
```

That is one full status record per registered member with no bound — the exact class
of response growth M149 removed from the product layer (§15, §62, §124), still
present on this surface. `formatWorkspaceRepoStatus` emits five absolute paths, a
readiness summary, an index-readiness summary and a freshness record per member.

It also calls `inspectWorkspaceRepoStatus` for every selected member, each of which
runs `evaluateIndexReadiness(..., { probe: "full" })` — a full readiness probe per
member per status call.

---

## 6. Duplicate / parallel retrieval risk register (§129)

| # | risk | where it would appear | status |
| --- | --- | --- | --- |
| R1 | MCP handler loops repositories and merges candidates itself (§43) | `tools.ts` run_pipeline handler | must be avoided; `assembleWorkspaceProductContext` already composes |
| R2 | Two capsules per response — v1 orchestration from bound repo, productContext from a routed repo | `tools.ts:8407` vs `tools.ts:8522` | **live risk**: these read the same `db` today. Any seam that swaps only the product producer splits them across repositories. |
| R3 | `get_code_context` and `run_pipeline` diverge because the wrapper routes and the inner handler does not | `tools.ts:8750` delegation | delegation passes `reboundContext`, so routing must happen at or above the shared entry |
| R4 | CLI `run-pipeline` / `capsule` keep a third, workspace-blind path | `cli/commands/*.ts:86,160` | pre-existing; must be documented, not silently claimed as parity (§146) |
| R5 | A second budget allocator in MCP (§55) | any new merge code | must reuse `aggregateCrossRepoContext` |

R2 is the constraint that decides the seam.

---

## 7. Repo resolution precedence that already exists (M132)

`resolveWorktreeRouting` defines the current contract:

```
explicit repo_root  >  clientContextRoot (null in practice)  >  server bound root
```

MCP transmits no caller cwd, so in practice a request either names a root or is
answered by the bound root. This matters for M151 because it locates where a
workspace router can be inserted **without** overriding anything a caller stated:
the `ProcessDefault` branch — the case where the product today silently answers from
whichever checkout the server was launched in.

---

## 8. Audit conclusions

- `get_code_context` is a wrapper; `run_pipeline` is the real product path, and
  `assembleProductContext` is the single-repository product producer shared by all
  three MCP product tools and both CLI product commands (5 call sites).
- The workspace routing/composition layer has no product caller, and the product
  actively refuses workspaces with unsatisfiable advice.
- The v1 orchestration and the product context are produced from one `db` binding;
  keeping them on one repository is a hard constraint on the seam (R2).
- `index_status` already emits unbounded per-member metadata.
