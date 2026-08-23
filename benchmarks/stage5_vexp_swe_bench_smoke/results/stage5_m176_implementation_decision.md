# M176-D — what changed, and what was deliberately not changed

## The diff

Two throw sites in `src/mcp/responseEnvelope.ts` become one construction.

```text
before                                    after
─────────────────────────────────────────────────────────────────────────────
:420  throw product_response_             build a bounded terminal record,
      envelope_unreachable                measure it, return it
:517  (same, on the re-measure path)      (same)
```

The construction is `buildBoundedEnvelopeDecline`, placed beside
`degradeOversizedProductResponse` — the rung above it, whose output it consumes.
One additional captured value, `indexReady`, is threaded from the top of each
function.

Net: one new function, two returns where there were two throws, one boolean
captured at entry, and ten new tests.

## Why this seam

`compactProductResponse` is the only place that knows the response did not fit,
and the last place that still holds every fact needed to say so truthfully. Three
alternatives were considered and rejected:

**Fix the inversion.** The envelope is enforced on the *authoritative* result at
`tools.ts:9252`, and the ~600-token compact orientation the model actually
receives is projected from it afterwards at `tools.ts:9282`. So the payload
measured against the ceiling is not the payload delivered, and a request whose
answer would occupy a few hundred tokens can still fail. Projecting first and
bounding the projection would be the deeper repair — and it would change the
default packet's construction order, which §34 forbids and M172/M173 froze. The
architectural note is recorded; the milestone does not act on it.

**A new decline object returned from the envelope.** `compactProductResponse`
would return `T | BoundedDecline`, and every caller would need to route it. More
type surface, more call sites, and no gain: the decline projector already reads
`productContext` and already owns the vocabulary.

**Another proxy cap.** Add a `maxWorkspaceRoutingCharacters`, a `maxWarnings`, a
`maxFreshnessReason`. M172 already demonstrated where that ends — a bound nobody
wired, buying nothing, hiding the real ceiling. §37 forbids it, and it would only
move the threshold rather than remove the unhandled state.

## What was not changed

```text
the token ceiling                     unchanged  (§36 — a larger ceiling evades)
retrieval, ranking, candidate gen     untouched
pivot and support selection           untouched
orientation projection ordering       untouched
related-evidence policy               untouched
LAST_RESORT_OPTIONAL_SECTIONS         untouched
decideDecline's precedence            untouched  (§33)
public decline vocabulary             unchanged  (no new agent-facing state)
get_impact_graph                      recorded, not repaired  (§34)
```

## One thing the ladder was already losing

The `diagnostics.indexFreshness` rung deletes every object-valued key under
`diagnostics.freshness`. `readiness` is one of them, and `readDeclineEvidence`
defaults a missing readiness record to *ready*. So under budget pressure the
readiness fact was already destroyed before any decline could read it.

This is why `indexReady` is captured at the top of `compactProductResponse` rather
than looked up at the end. It is the smallest change that satisfies §22 without
touching what a surviving response contains: responses that fit are byte-identical
either way, because the captured boolean is only ever read by the terminal record.

## Where the fallback can be reached from

Exactly one place: a **failed measurement**.

```ts
if (!accounting.within_envelope) {
  const bounded = buildBoundedEnvelopeDecline(draft, compactedFields, omitted, indexReady);
  ...
}
```

Never from a `catch`. That is the whole of §23: a genuine implementation fault
propagates to the server's catch-all and is still reported as `handler_failed`,
and the control that proves it — a throwing getter on `productContext.items` —
still throws after the repair.

## Verification of the seam itself

`compacted_fields` is a bounded audit list: sorted, deduplicated and capped at ten
entries. It is therefore **not** a reliable signal that a step ran, and the first
draft of the tests wrongly used it as one. The authoritative signal is the
internal marker, `productContext.diagnostics.envelopeDecline`, which is the field
telemetry should read as well.
