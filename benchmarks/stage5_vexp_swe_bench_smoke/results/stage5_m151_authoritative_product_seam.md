# M151-A — The authoritative product integration seam

Companion to `stage5_m151_product_call_path_audit.md`. This names the one boundary
M151 wires (§9) and states why the alternatives were rejected.

---

## The constraint that decides it

From the audit, risk **R2**: `run_pipeline` produces two things from one database
binding —

```ts
const orchestration = runPipelineOrchestrator(db, binding.repoRoot, {...});  // tools.ts:8407
const productContext = await assembleProductContext({ db, repoRoot: binding.repoRoot, ... }); // tools.ts:8522
```

— the v1 capsule/impact/memory orchestration, and the authoritative product context.
They share `db`, `binding.repoRoot`, and the persisted observation. Any seam that
redirects only the *product producer* to a routed repository leaves the v1 capsule
answering from the bound repository, and the response then describes two
repositories at once. §42 requires these to agree.

**Therefore routing must happen BEFORE the database binding, not at the product
producer.** The repository is chosen first; everything downstream runs against it
unchanged.

## Rejected: seam at `assembleProductContext`

Swapping `assembleProductContext` for `assembleWorkspaceProductContext` at
`tools.ts:8522` is the smallest diff and is wrong. It splits R2, and it also gives
the workspace layer no way to influence which repository the orchestration,
freshness stamp, observation record and `index_status` agree on.

## Rejected: seam inside `handleGetCodeContextRequest`

`get_code_context` delegates to `run_pipeline` (`tools.ts:8750`). Routing there
would leave `run_pipeline` and `get_context_capsule` workspace-blind, reintroducing
the §135 MIXED case ("MCP uses workspace path but run_pipeline still uses a
divergent path").

## Adopted seam

One new resolver, consumed by the three product/status surfaces:

```
resolveProductWorkspaceRoute(context, toolId, request)
    ├── resolveWorkspaceRegistry      (registry.ts)     — identity, already authoritative
    ├── evaluateWorkspaceReadiness    (readiness.ts)    — per-member readiness
    └── nominateRepositories          (repositoryRelevance.ts) — lane selection, bounded probes
        └── (path lane)  createPathMembershipResolver  (pathMembership.ts)
        └── (symbol lane) proveExactUniqueness         (repositoryPresence.ts)
        └── coverage      composeCoverage              (evidenceClaims.ts)
```

returning a lead member root, a bounded routing summary, and the supporting set.

The product path then becomes:

```
MCP get_code_context
  → handleGetCodeContextRequest        (unchanged wrapper: freshness / auto_refresh)
  → run_pipeline handler
      → resolveProductWorkspaceRoute           ← NEW: replaces the blanket refusal
      → rebindMcpContext(leadRoot)             ← existing function
      → withReadyRepoDb                        ← unchanged
      → runPipelineOrchestrator                ← unchanged
      → assembleProductContext                 ← unchanged
      → [compose supporting repos]             ← assembleWorkspaceProductContext, only when composing
      → compactProductResponse                 ← unchanged
```

### Why the single-member path does not go through `assembleWorkspaceProductContext`

Its own contract already says a one-repository workspace "returns that repository's
own response object — same items, same lead, same accounting". For a single member
it is a pass-through around `assemble`. Calling it anyway would add an index open
and a second readiness pass for a result defined to be identical, which §12 forbids.
The single-member route therefore ends at the existing producer, and parity is a
consequence of running the same code rather than of matching two implementations
(§102 measures this rather than assuming it).

`assembleWorkspaceProductContext` remains the authoritative boundary for the case it
was built for — more than one repository contributing context — so no second
allocator or merger is introduced (§55, R1, R5).

## Where routing is allowed to decide

M132 already fixed the precedence contract for repository resolution:

```
explicit repo_root  >  clientContextRoot (null in practice)  >  server bound root
```

M151 inserts workspace routing **only into the lowest branch** — the case where the
product today silently answers from whichever checkout the server was launched in.

| request | behaviour |
| --- | --- |
| explicit `repo_root` given | unchanged; routing does not run (§73) |
| explicit `repos: [alias]` given | that member; routing does not re-decide |
| no root, no workspace config | unchanged single-repo path; routing does not run (§12) |
| no root, workspace config present | **routed** by `nominateRepositories` |

An explicit selection is a statement by the caller and M151 never overrides it. This
is also what keeps §11 a structural guarantee rather than a measured coincidence:
every request that resolves a repository the old way still reaches the old code by
the old route.

## Surfaces consuming the seam

| surface | consumes route | notes |
| --- | --- | --- |
| `get_code_context` | yes, via `run_pipeline` delegation | primary target (§10) |
| `run_pipeline` | yes, directly | |
| `get_context_capsule` | yes, directly | same resolver, same lead |
| `index_status` | coverage only | readiness stays per member (§18, §81) |
| CLI `run-pipeline` / `capsule` | **no** — documented, not claimed (§146) | they take an explicit repo path; the workspace-blind path is the explicit-selection branch above |

## What this seam deliberately does not add

No cross-repository call graph, symbol resolution, dependency ontology, ownership
inference, repair, semantic merging, or router model (§6). The resolver only decides
*which already-built retrieval to run*, and the composition it may perform is the one
`aggregateCrossRepoContext` already implements.
