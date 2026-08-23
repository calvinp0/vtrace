# M176-C — the bounded delivery decline

What `run_pipeline` returns when a valid request, answered against an authoritative
repository, produces a response that cannot be represented inside the configured
model-facing envelope.

## The condition

```text
valid request
+ repository authoritative
+ retrieval ran
+ every rung of the degradation ladder applied
+ response still exceeds responseTokenCeiling(max_tokens)
```

Before M176 this threw `product_response_envelope_unreachable`, which the MCP
server's catch-all reported as `handler_failed` with `isError: true`. The caller
received no evidence, no orientation and no decline — only a transport fault
indistinguishable from a genuine bug.

## What the model receives

The **existing** decline, in the **existing** vocabulary:

```json
{
  "schemaVersion": "run_pipeline.orientation.none/1",
  "state": "evidence_found_but_undelivered",
  "summary": "Relevant evidence was found, but none of it survived the response budget.",
  "boundary": "No focused orientation was selected from the current authoritative repository evidence. This is not an assertion that relevant code does not exist.",
  "nextStep": "Increase max_tokens or narrow the request.",
  "topMatch": "src/_pytest/debugging.py::_enter_pdb"
}
```

Measured on the known positive: **445 characters, ~141 billed tokens**, and
byte-identical to what the same case already returned at a budget that fitted.

## Why no new public state

Ladder exhaustion changes nothing a coding model can infer or act on differently.
In both the graceful case and the exhausted case the facts are the same: relevant
evidence exists, none of it could be delivered inside the bound, and the remedy is
the same. Minting a second state for a distinction only a maintainer can use would
add agent-facing vocabulary that buys the agent nothing and creates a second
surface to keep truthful forever.

The distinction a maintainer *does* need is kept internally, as one boolean:

```text
productContext.diagnostics.envelopeDecline: true
```

set only where the ladder was exhausted, and absent from the graceful degradation
one rung above. Telemetry can therefore separate "degraded gracefully" from "could
not build the degraded form" without the public schema growing a state.

## What the record may say

Nothing here is authored prose about the repository. Every field is either a
frozen phrase owned by `orientationDecline.ts`, or a fact the ladder had already
established, carried in the field name the decline projector already reads.

| fact | source | bound |
| --- | --- | --- |
| `retrievalFound` | read, never assumed | boolean |
| `deliveryFailed` | true only when retrieval found something | boolean |
| `resultState` | `delivery_failure` / `no_result` | frozen |
| `topMatchReference` | verbatim `topMatchReference` or `leadPivot` | 256 chars, else **omitted** |
| `freshness.status` | verbatim | 64 chars, else omitted |
| `freshness.reason` | verbatim | 256 chars, else omitted |
| `modelVisibleContext` | the ladder's own degraded block | 512 chars |
| `diagnostics.freshness.readiness.ready` | captured **before** the ladder ran | boolean |
| `delivery.*` counts | non-negative integers | numeric |

Everything else the ladder still held is dropped, and
`responseBudget.omitted_detail_counts.boundedEnvelopeDeclineCharacters` says how
much. The authoritative payload does not travel inside the record in any form.

**Omission, not truncation.** Every bounded string here is load-bearing for a
claim. `topMatchReference` is a follow-up tool argument, so a truncated symbol
name is an identity that does not resolve; the freshness pair is quoted verbatim
into the decline's own note, so a truncated reason is a re-worded claim. Over-long
values are therefore dropped and marked, never cut.

## What it refuses to say

It never reports an absence it did not observe. `retrievalFound` is read from the
record rather than defaulted, so an empty retrieval remains
`no_relevant_evidence` — retrieval's own finding — and is never dressed up as a
delivery loss. `topMatch` is disclosed only where a real match exists, which is
M174's rule unchanged.

## Precedence

Frozen as `stage5_m176_decline_state_matrix.json`. `decideDecline()` is **not
rewritten**: the new terminal record populates the fields that authority already
reads, so the existing order decides the state.

| ready? | retrieval | fits? | terminal state |
| --- | --- | --- | --- |
| no | any | any | `repository_not_ready` |
| yes | empty | either | `no_relevant_evidence` |
| yes | non-empty | yes | orientation packet |
| yes | non-empty | no, ladder succeeded | `evidence_found_but_undelivered` |
| yes | non-empty | no, ladder exhausted | `evidence_found_but_undelivered` + `envelopeDecline` |
| yes | unexpected internal fault | n/a | `handler_failed` — unchanged |

## One thing the ladder was already losing

The `diagnostics.indexFreshness` rung deletes every object-valued key under
`diagnostics.freshness`, and `readiness` is one of them. Under budget pressure the
readiness record was therefore already gone by the time any decline could read it,
and `readDeclineEvidence` defaults a missing record to *ready*. The terminal record
captures the single boolean it needs **before** the ladder runs, which is why
`indexReady` is threaded in rather than looked up at the end. Responses that fit
are untouched by this.

## Where the fallback can be reached from

Exactly one place: a **failed measurement**, at the end of the ladder in
`compactProductResponse` and in `remeasureResponseBudget`. It is never reached
from a caught exception, so a genuine implementation fault still propagates and is
still reported as `handler_failed`. The fallback classifies one predictable
condition; it is not a place for bugs to be made presentable.
