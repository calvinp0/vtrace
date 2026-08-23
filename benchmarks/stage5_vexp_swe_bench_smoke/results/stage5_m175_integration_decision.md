# M175-C/D — integration decision

## What was decided

The default model-facing response projects the caller's own question instead of
restating it. `IDENTITY_ONLY`, frozen before any Broad100 evaluation of the repair.

```text
before                                after
request.query  <the whole question>   request.query  "@request.task"
request.task   <the whole question>   request.task   "@omitted: supplied by the
                                                      caller; returned verbatim
                                                      at detail=debug"
request.maxResults          6         unchanged
request.maxBudgetCharacters 2000      unchanged
request.includeTests        true      unchanged
…                                     unchanged
```

`detail=debug` is not routed through the projection and returns the request whole.

## Why this and not the others

The M175-A authority audit is what makes any of this admissible. It found:

- `request.task` is assigned `orchestration.request.query` at
  `formatRunPipelineOutput.ts:211` — the same string under a second key, and
  **identical in 199 of 199 captured responses**.
- **Zero** product consumers read the shipped block. Its only readers anywhere are
  two assertions in `mcp.test.ts`, both at `detail="debug"`, and a benchmark
  analyzer that counts it *as* duplication.
- Every consumer of the request TEXT reads the pipeline's INPUT record server-side —
  retrieval, routing, capsule and memory hashing, intent derivation. None of them
  reads the response.

| policy | median tokens (A/B) | verdict |
|---|---|---|
| `CURRENT` | 644 / 878 | the defect |
| `TASK_ONLY` | 348 / 464 | rejected — halves the echo, leaves the rest unreducible |
| `QUERY_ONLY` | 348 / 465 | rejected — same, and inverts the codebase's own canonical direction |
| **`IDENTITY_ONLY`** | **65 / 65** | **frozen** |
| `NO_REQUEST_DISCLOSURE` | 1 / 1 | rejected — removes a published block, and silently |

`TASK_ONLY` and `QUERY_ONLY` fix the case that was measured rather than the defect
that produced it: a long enough question still outbids the evidence. `QUERY_ONLY`
additionally points the wrong way — the envelope's existing deduplication tier and
`productContext.task` both already reference `@request.task` as canonical.

`NO_REQUEST_DISCLOSURE` is one token cheaper than the frozen policy and costs a
published block to get there, which §56 asks to avoid where a shortening will do.
It also makes the omission silent, and a silently absent field is exactly the
false-absence failure the projection rules exist to prevent.

**The property that decided it.** `IDENTITY_ONLY` is a constant 65 tokens whatever
is asked. Every other policy that keeps prose is unbounded in the caller's own
input — 12,923 tokens on the longest Broad100-B question. The defect was never
that the block was big; it was that its size was a function of something the
response has no business re-transmitting.

## Where it lives, and why there

`projectRequestDisclosure()` in `src/mcp/responseEnvelope.ts`, called as step 0 of
`compactProductResponse` — before every measurement, so the budget it frees is
available to the evidence rather than only to the accounting.

The envelope is the right layer because it already **is** the model-facing
projection of the authoritative result: it already owns the `detail` gate, already
deduplicates repeated task text into `@request.task`, and already declares the
exemption this milestone revises. `PipelineRequest` is untouched (§33) — the fix is
a rendering decision, and making it anywhere upstream would put internal authority
at risk to save tokens.

**Unconditional, not another ladder rung.** A rung would fire only under budget
pressure, which would leave the echo present on every response that happens to fit
and make the evidence's survival depend on ladder ordering. "Reference the request,
do not restate it" is the default contract, not an emergency measure.

## What it is not

- Not a retrieval, ranking, or projector change. `orientationProjection.ts` and
  `orientationDecline.ts` are untouched.
- Not a schema version. One authoritative `run_pipeline`; no `V2` anything (§57).
- Not a refill. Freed budget restores previously selected evidence and attracts
  nothing new — checked by a dedicated control and by a superset gate over every
  delivered packet.
- Not a live claim. No agents were run; `$0.00`.

## Tests

Six in `src/mcp/responseEnvelope.test.ts`. Four of them fail without the repair —
verified by disabling it and re-running — so they are regression tests rather than
descriptions:

- the default references the request instead of restating it
- `detail=debug` still returns it verbatim
- the request block's cost is **constant** in the length of the question
- a long question no longer evicts the evidence it was asked about
- projecting the request changes nothing about the evidence selected
- a response with no request block is untouched
