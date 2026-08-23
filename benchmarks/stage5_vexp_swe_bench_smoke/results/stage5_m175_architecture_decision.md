# M175-F — architecture decision

## The invariant this establishes

> **Task and query text may be retained internally without limit, for retrieval,
> routing and provenance. Information the agent already supplied must not consume
> the default response's evidence budget through model-facing restatement.**

and its corollary:

> **A response field's cost must not be a function of the caller's own input.**
> Compact-orientation budget is for repository information. Request identity is
> represented only to the extent required for interpretation or protocol
> compatibility — which, measured, is 65 tokens.

## Why the second sentence is the load-bearing one

The first is a value judgment and could be argued with. The second is what the
measurements actually showed, and it is falsifiable.

`request` was the only large field in the response with no reduction at any rung of
the compaction ladder, and its size was a linear function of the question. On
Broad100-B it ran to 12,430 tokens against a 9,200-token ceiling — so past a certain
question length the response was not merely evidence-poor but **impossible**:
`compactProductResponse` threw `product_response_envelope_unreachable` and the tool
returned `handler_failed`. Two of Broad100-B's hundred cases were in that state.

A budget-triggered rung would not have fixed this. Anything unbounded in the input
eventually exceeds any fixed ceiling; the only repair is to make the field's cost
constant, which is what the frozen policy does.

## The seam

```text
PipelineRequest            full task, full query, hashes, provenance   UNCHANGED
        │
   internal pipeline       retrieval, routing, capsule + memory        UNCHANGED
   ranking, projection     hashing, intent derivation
        │
   compactProductResponse  ← projectRequestDisclosure() runs here, step 0
        │
   orientation projector   focus + related + boundary                  UNCHANGED
        │
   structuredContent AND content[0].text
```

Internal authority is a different thing from model-facing disclosure (M171). M175
adds no new state, deletes no state, and moves nothing across the seam except the
decision about what the response *says*.

## What generalizes beyond this field

Three properties made `request` the field that broke, and any field with all three
is the next one:

1. **Large** — its size is set by something outside the response's control.
2. **Unreducible** — exempt from the ladder, by an explicit rule.
3. **Unread** — no product consumer, so the exemption protected nothing.

The exemption at `responseEnvelope.ts:1288` was written for a field that had (1) and
was believed to have a consumer. The M175-A audit is the part worth repeating for any
future exemption: **before declaring a field a correctness surface, go and find the
code that reads it.** There were two readers, both tests, both at `detail=debug`.

## What was rejected, and why it stays rejected

- **A ladder rung.** Fires only under pressure, leaves the echo on every response
  that happens to fit, and makes the evidence's survival depend on rung ordering.
- **Deleting the block.** One token cheaper than the frozen policy and costs a
  published field to get there. A silently absent field is also readable as an
  absence, which the projection rules forbid.
- **Halving the echo** (`TASK_ONLY` / `QUERY_ONLY`). Fixes the case that was measured
  rather than the property that produced it.
- **A hash.** `productContext.taskHash` exists and could have been surfaced. The MCP
  envelope already binds a response to its request by `requestId`, so a digest the
  model cannot act on would be pure overhead (§19).

## Scope of the claim

M175 proves **orientation delivery correctness**. It does not prove that agents solve
more tasks, and no live agent was run — `$0.00`. Gold movement here is
`DELIVERY_RECOVERY`: retrieval is byte-identical across the arms, proven three ways
(no import path connects the change to retrieval across a 153-module closure; index
fingerprints unmoved; lead pivot unchanged on all 193 delivered packets).

## What this licenses next

Nothing live. The repair changes 3 responses in 198 from unusable to usable and adds
evidence to 48 more; the other 147 are unchanged. That is correctness work, not a
treatment difference worth requalifying an agent against (§83).

The lead worth following is the one this uncovered rather than fixed:
**`product_response_envelope_unreachable` is a reachable crash on ordinary input.**
M175 removed the largest field that caused it, but the throw is still there and any
sufficiently large irreducible field will still reach it. A response that cannot be
made to fit should degrade, not fail.
