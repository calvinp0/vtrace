# M177-A — the impact response envelope, and where it becomes unreachable

## The path

```text
tools.ts:10180   withReadyRepoDb              readiness gate           → repo_not_ready
tools.ts:10181   getImpactGraph(db, …)        AUTHORITATIVE COMPUTATION
tools.ts:10199   !result.ok                   → invalid_request
tools.ts:10207   buildContextAccountingBestEffort   additive, never throws
tools.ts:10217   compactImpactProductResponse THE RESPONSE ENVELOPE
                   :183  fits()               three conjunctive conditions
                   :196–329 the ladder        paths → files → limitations → notes →
                                              accounting → transitive edges →
                                              potentialCallers projection →
                                              relations projection → relations tail →
                                              outgoing-yields-to-callers →
                                              potentialCallers by confidence tier →
                                              bounded_degradation → canonical edges
                   :331  rebuild the budget
                   :338  still too large      → throw            ← THE DEFECT
```

The MCP server's catch-all turns the throw into `handler_failed` with
`isError: true`, so a predictable product condition reaches the caller as a
transport fault with no evidence, no counts and no decline.

## Computation succeeded; only delivery failed

At `max_tokens=200`, the budget at which the tool throws, the engine returns:

```text
ok                  true
resolvedSymbol      src/_pytest/debugging.py::_enter_pdb
directRelations     5
edges               5
nodes               6
summary.consumers   exactCallerCount 1, exactReferenceCount 0,
                    potentialCallerCount 0, structuralContainerCount 1, …
```

So the classification is unambiguous: **IMPACT_COMPUTATION_SUCCEEDED +
RESPONSE_COULD_NOT_FIT**, not `IMPACT_COMPUTATION_FAILED`.

## Why line 340 is reachable — two findings

### 1. The ladder's gate and its terminal check test different conditions

| site | expression | conditions |
| --- | --- | --- |
| `:183` `fits()` | `estimatedTotalTokens <= totalCeiling && serializedCharacters <= 80000 && modelVisibleEstimatedTokens <= requestedMaxTokens` | 3 |
| `:338` the throw | `estimatedTotalTokens > totalCeiling \|\| serializedCharacters > 80000` | 2 |

Every rung is driven by the model-visible bound; the throw fires on the total. The
ladder is therefore driven to exhaustion by one condition and killed by another.

### 2. The ladder can only shrink the channel that is not the problem

`fits()`'s model-visible channel is `edges`, `nodes`, `view`, `directRelations`,
`paths`. Nothing in the ladder reduces `requested`, `resolvedSymbol`, `coverage`,
`summary`, `richSummary`, `limits`, `timing`, `diagnostics` or `callerCoverage`.

Read at the floor — the smallest budget at which the pre-repair envelope still
terminates, so every rung has fired and nothing was observed under a budget it was
not selected under:

| key | channel | tokens |
| --- | --- | ---: |
| `directRelations` | model-visible | 202 |
| `richSummary` | metadata | 158 |
| `responseBudget` | metadata | 148 |
| `nodes` | model-visible | 121 |
| `edges` | model-visible | 97 |
| `diagnostics` | metadata | 88 |
| `callerCoverage` | metadata | 87 |
| `summary` | metadata | 65 |
| `resolvedSymbol` | metadata | 52 |
| `view` | model-visible | 51 |
| `coverage` | metadata | 49 |
| `timing` | metadata | 47 |
| `requested` | metadata | 24 |
| `limits` | metadata | 15 |
| `dependentFiles` | metadata | 7 |
| `paths`, `affectedFiles`, `entrypoints`, `tests`, `potentialCallers` | mixed | 1 each |

```text
metadata       745 tokens   61.2%
model-visible  472 tokens   38.8%
```

**The metadata outweighs the evidence at the floor.** No amount of further
evidence-shedding reaches a smaller budget, because the floor is set by fields no
rung touches.

The ladder also has a hard floor above zero: `directRelations` stops at one
(`:267`, and `:311`'s `bounded_degradation` keeps `slice(0, 1)`) and `edges` stops
at one (`:325`). And even a response carrying *no* evidence still serializes its
five model-visible keys — **23 tokens** — so budgets below that can never be
satisfied by dropping evidence at all.

## The decisive control

A symbol with **no impact whatsoever** (`src/_pytest/__init__.py::__all__`, zero
relations, zero edges, zero potential callers) also threw, at `max_tokens=1`,
through the real transport. There was never any evidence to shed. That rules out
"the graph was too big" as the explanation and confirms the metadata floor is the
whole mechanism.

## The measured ladder

`pytest-dev__pytest-10081 :: _enter_pdb`, real MCP stdio, only `max_tokens` varying:

```text
1  50  100  200  400  476  →  impact_response_envelope_unreachable
477  600  800  1000  1200  →  response
```

M176 recorded the threshold as "between 400 and 1200"; M177 locates it at
**476/477**, with about one token of jitter because `timing` carries
full-precision floats whose decimal length varies between runs.

## Current model-facing states

| condition | how the tool expresses it |
| --- | --- |
| valid non-empty impact | populated `edges`/`directRelations`, `resultState` `complete` or `response_compacted` |
| valid empty impact | empty arrays, `omittedEdges: 0`, `resultState` `complete`/`response_compacted` |
| bounded/truncated | `resultState: "bounded_truncated"`, `retainedEdges` < discovered, `omittedEdges > 0` |
| repo not ready | `repo_not_ready` (readiness gate, upstream) |
| invalid request | `invalid_request` (argument validation and symbol resolution) |
| component failure | `handler_failed` (server catch-all) |
| **response-envelope failure** | **`handler_failed` — indistinguishable from a real bug** |

The vocabulary needed for a truthful decline already existed. M139 built the
discovered/delivered separation — `callerCoverage.exactCallerCount` beside
`deliveredExactCallerCount`, `richSummary.fieldDomains` naming the population each
count was measured over — precisely so a reader could tell "we did not deliver it"
from "it does not exist". `bounded_truncated` with `retainedEdges: 0` says exactly
what the decline needs to say.

## The smallest repair seam

One site: the failed final measurement at `:338`. Replace the throw with a
terminal record built from the draft the ladder already exhausted, and return it
unconditionally. Nothing upstream of `:331` changes, and no other caller of
`compactImpactProductResponse` (the MCP tool, `impactGraphCommand.ts`) needs to
know.

## Can the M176 construction be reused?

**No — analogous, not shared.** `run_pipeline`'s decline replaces the response with
a smaller, differently-shaped record, which its loose schema permits.
`get_impact_graph` declares eleven required output fields
(`requested`, `resolvedSymbol`, `coverage`, `summary`, `dependentFiles`, `nodes`,
`edges`, `view`, `responseBudget`, `callerCoverage`, `potentialCallers`), so its
terminal must remain a valid `ImpactGraphOutput`.

The two implementations differ in the one respect that decides the design —
whether the response shape may change — so extracting a common abstraction would
have to erase that difference in order to exist. §12 asked for the smallest
auditable change; duplicating a 40-line terminal is smaller and more auditable
than a generic envelope both tools would then have to be read through.
