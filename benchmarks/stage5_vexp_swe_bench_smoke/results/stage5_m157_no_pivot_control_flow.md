# M157-A — no-pivot control flow: what is candidate-local, what is query-global

Required by M157 §21. Every statement here was produced by executing the real
delivery path against a pinned index (`run_stage5_m157_delivery_trace.ts`), not
by reading function names.

## The path, in execution order

| # | Stage | Site | Scope |
| - | ----- | ---- | ----- |
| 1 | hybrid retrieval | `buildCapsuleV2.ts:244` `hybridRetrieve` | query-global |
| 2 | base role assignment | `assignCandidateRoles` (`src/capsule/assignCandidateRoles.ts`) | **candidate-local** |
| 3 | pivot cap | `maxPivots` — inside `assignCandidateRoles` (passthrough path) or `capPivots` at the end of `refineDebugRoles` | query-global |
| 4 | debug refinement | `refineDebugRoles` (`debugRoles.ts`) | candidate-local |
| 5 | scoped-objective demotion | `buildCapsuleV2.ts:786` | candidate-local, **after the cap** |
| 6 | non-source-example demotion | `buildCapsuleV2.ts:812` | candidate-local, **after the cap** |
| 7 | **no-pivot collapse** | `buildCapsuleV2.ts:985` | **query-global** |
| 8 | budget packing | pivots then support, `maxSupport` | query-global |

## The first condition that prevents any delivery

```
buildCapsuleV2.ts:985
  if (pivotCandidates.length === 0) return noContextResult({ ... })
```

Every candidate the role layer classified as `Support` is rewritten to a discard
carrying the single reason `support-only: no actionable edit target`, and the
capsule returns with `estimated_tokens: 0`.

This is **query-global**. It does not consult the candidate it is discarding.

## Is support impossible without a pivot today?

Yes. There is no path by which `support` items reach the result when
`pivotCandidates.length === 0`; the collapse precedes budget packing entirely.

## Candidate-local vs query-global: the measured answer

`django__django-11740`, reproduced exactly against the M156-indexed corpus:

| | value |
| - | - |
| candidates | 33 |
| pivots | 0 |
| support **delivered** | 0 |
| discarded | 33 |
| estimated tokens | 0 |
| candidates whose own role was `Support` | **33** |
| candidates the role layer denied outright | **0** |

All 33 candidates individually earned support authority. **The collapse is
query-global, not candidate-local.**

`sphinx-doc__sphinx-9320` shows the same shape: 25 candidates, 25 support
authority granted, 0 role-denied.

## Two reporting defects found on this path

1. **`support_count` was a literal `0`.** `noContextResult` accepts a
   `supportCount` argument and never uses it. The published "0 support" was
   therefore not a measurement — it is the same `0` for a query that retrieved
   nothing and for one that withheld 33 relevant candidates. Fixed additively:
   `support_authority_withheld` reports the withheld count and is absent when
   nothing was withheld, so true-empty stays distinguishable.

2. **The global gate erased each candidate's role decision.** `toDiscarded`
   overwrote the candidate-local `roleReason` with the global string, so the
   product could not explain why any individual candidate lacked pivot
   authority. Fixed additively: `role_reason` is preserved whenever it differs
   from the discard reason.

Both are observability only; no delivery outcome changes.

## Delivery consumers (§17, §49)

| Consumer | Site | No-pivot behaviour |
| -------- | ---- | ------------------ |
| Capsule digest | `productAdapter.ts:530` | prints `(no high-confidence pivot recovered)` + reason. Note it already renders a support group, so a support-only capsule is representable in this format. |
| Product warnings | `productAdapter.ts:633` | adds `no_pivot_recovered` |
| `assembleProductContext` | `assembleProductContext.ts:294` | `resolved = actualMode !== "no_context" && pivots.length > 0` — usability is defined as pivot presence |
| `run_pipeline` | `runPipelineOrchestrator.ts:611` | treats a no-pivot capsule as non-failure |
| `get_code_context` / `get_context_capsule` / `run_pipeline` | `src/mcp/tools.ts` | share one `productContext` schema (`tools.ts:8246`) |

`resolved` is the §61 condition: it currently means "an actionable target
exists", and is consumed as "usable context exists". Those are different claims.
