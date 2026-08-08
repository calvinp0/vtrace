# Stage 5 — M131 type-safety audit

Verdict: **`searchLogicFlow.ts` is type-checked; `tools.ts` remains unchecked and is now thinner in product-critical logic**

## `searchLogicFlow.ts` — `@ts-nocheck` removed

`// @ts-nocheck` is gone. The file compiles under the project's normal
`tsc --noEmit`.

Removing the directive surfaced exactly **two** errors, both the same shape: a
`return resolvedStart` where `resolvedStart` is a readonly discriminated union
that `!x.ok` does not narrow. Fixed by narrowing explicitly:

```ts
if (resolvedStart.ok === false) {
  return { ok: false, error: resolvedStart.error };
}
```

No `any` was introduced and no assertion was widened to make the directive
disappear. The traversal is typed end to end:

| concept | type |
| --- | --- |
| symbol records | `SymbolRecord` (unchanged) |
| edge records | `EdgeRecord`, now with optional `callSites: readonly EdgeCallSite[]` |
| frontier state | `FrontierTraversalInput<TEdge>` / `FrontierTraversalResult<TEdge>` |
| traversal budget | `TraversalBudget` |
| traversal counters | `FrontierTraversalCounters`, `LogicFlowTraversalDiagnostics` |
| edge provenance | `EdgeCallSite`, `EdgeCallSiteEvidence` |
| flow result | `LogicFlowResult` — discriminated on `ok` |
| negative reasons | `RunPipelineFlowSkipReason` (frozen const object + union) |

## Type escapes in new and changed code

| file | `any` | `unknown as` | non-null `!` | `@ts-ignore` / `@ts-expect-error` |
| --- | ---: | ---: | ---: | ---: |
| `src/graph/frontierTraversal.ts` | 0 | 0 | 0 | 0 |
| `src/graph/syntheticGraphFixture.ts` | 0 | 0 | 10 | 0 |
| `src/mcp/productResponseOptions.ts` | 0 | 0 | 0 | 0 |
| `src/parsers/edgeCallSites.ts` | 0 | 0 | 0 | 0 |
| `src/logicFlow/searchLogicFlow.ts` | 0 | 0 | 5 | 0 |

The non-null assertions are indexed access into arrays the surrounding code just
sized (`matches[0]!` after a length check; `symbolsById.get(id)!` inside
comparators whose inputs were hydrated by the expansion that produced them, and
`syntheticGraphFixture`'s modular indexing into arrays it allocated). None is a
new unchecked boundary. Where the invariant is not local, the code uses a real
guard instead: `FlowGraphAccess.requireSymbol` throws with the symbol id rather
than asserting.

No new `@ts-ignore`, `@ts-expect-error` or `as any` anywhere.

## `tools.ts` — why the directive stays, and what moved out

Removing `// @ts-nocheck` from `src/mcp/tools.ts` (9,373 lines) yields **244**
errors. They are not M131's, and they are overwhelmingly one shape:

| category | count | what it is |
| --- | ---: | --- |
| argument-parse union not narrowed | **203** (83%) | `parseOptionalStringField` / `parseOptionalBoolean` / … return `T \| McpToolExecutionResult<never>`; every call site then does `if (x !== undefined && typeof x !== "number") return x;` and TypeScript will not eliminate the object member |
| output-schema property/shape mismatches | 25 | `McpSchemaProperty` used where `McpObjectSchema` is declared; missing `description` on two inline schemas |
| result-shape property access | 10 | `.result` / `.error` / `.performance` read off unions the handler has already discriminated by other means |
| miscellaneous | 6 | arithmetic and assignment on the same parse unions |

The honest fix for the 83% is to change the parse helpers to a discriminated
`{ ok: true, value } | { ok: false, failure }` and update roughly 150 call sites
across every tool. That is a mechanical refactor with a large blast radius, no
behavioural content, and no relationship to flow scalability. Doing it here would
put the M131 acceptance evidence and an unrelated 150-site rewrite in the same
commit — the opposite of what makes a milestone verifiable.

**What M131 did instead: move the product-critical logic out.** The requirement
is not "the file compiles" but "M130/M131 product logic does not depend on
unchecked internals".

| product-critical concern | where it lives now | checked |
| --- | --- | --- |
| `max_tokens` propagation / budget precedence | `src/mcp/productResponseOptions.ts` (new, 77 lines) | yes |
| response-envelope enforcement | `src/mcp/responseEnvelope.ts` (1,602 lines) | yes |
| response accounting | `src/mcp/responseEnvelope.ts` | yes |
| compact compatibility references | `src/mcp/responseEnvelope.ts` | yes |
| productContext construction | `src/capsuleV2/` + `src/productContext/` | yes |
| flow inclusion and negative reasons | `src/runPipeline/runPipelineOrchestrator.ts` (1,789 lines) | yes |
| flow traversal | `src/logicFlow/searchLogicFlow.ts`, `src/graph/frontierTraversal.ts` | yes (new in M131) |

`tools.ts` retains argument validation, JSON-Schema declarations and handler
wiring — orchestration and compatibility glue.

The specific M130 defect this closes: `capsule_budget_tokens ?? max_tokens ??
8000` was written out by hand at three call sites, and one of them was written
differently, so `max_tokens` reached the v1 capsule but never the authoritative
product context. That rule now exists once, is typed, and is covered by
`src/mcp/responseEnvelopeScale.test.ts` ("the budget rule is resolved in exactly
one place"), including its malformed-input behaviour.

## Remaining unchecked scope

- `src/mcp/tools.ts` — 244 errors, 83% one parse-helper pattern. Unchanged by
  M131 except that three budget call sites now delegate to a checked module.
- 16 other files still carry `@ts-nocheck` (parsers, indexer, CLI commands,
  validation). Untouched and out of scope.

Net change in product-critical unchecked code: `searchLogicFlow.ts` (894 lines,
the entire flow engine) moved from unchecked to checked, and the budget rule
moved out of unchecked orchestration into a checked module. `frontierTraversal.ts`
and `syntheticGraphFixture.ts` were born checked.

## Recommended follow-up

Convert the `tools.ts` argument-parse helpers to a discriminated result in a
milestone of their own, with no behavioural change and the MCP schema-conformance
suite as the equivalence proof. That single change is expected to clear ~83% of
the file's errors and make the remaining ~41 individually reviewable.
