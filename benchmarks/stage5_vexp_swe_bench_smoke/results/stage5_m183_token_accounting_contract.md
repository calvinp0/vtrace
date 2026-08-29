# M183 — token accounting contract

Frozen before any M183 live run existed. §37 exists because M169 found that the
obvious way to count tokens here is wrong in two independent ways.

## The trap M169 found

Streamed assistant messages repeat. Summing `message.usage` across a stream
double-counts every message the provider re-emits, and M169 measured the
inflation at 23.5% against the harness's own accounting. **Do not sum streamed
usage.** The authoritative per-run figures are the ones the external harness
writes to its result row after deduplicating on `message.id`.

## The second trap: the fields that look small are not the traffic

A real M173 baseline row:

    inputTokens 83   outputTokens 10   cacheReadTokens 279,087   cacheCreationTokens 31,273

`inputTokens` is 0.03% of that run's traffic. A comparison built on
`inputTokens + outputTokens` would compare two rounding errors. Cache reads and
cache writes are where a repository-context intervention actually shows up,
because injected context is exactly the kind of prefix a provider caches.

## The definition, made once

    TOTAL_AGENT_TOKENS := inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens

taken from the result row of a completed run, per arm, for the COMPLETE agent run
through its terminal response or its declared limit (§94). All four components
are also reported separately, because §71 requires cache behaviour to be visible:
a cost reduction with no token reduction is a cache effect, and the two must not
be reported as if they were the same finding.

## What is NOT the primary token metric

- `modelVisibleEstimatedTokens` — misleadingly named, does not represent all
  model-visible content, and is not renamed in M183 (§138).
- The orientation packet's own token count. That is the treatment's OVERHEAD and
  is reported separately (§47), never as the whole-run figure.
- Any pre-edit-only or investigation-only subtotal. Those are mechanism
  diagnostics (§48/§50); whole-run usage is authoritative.

## Orientation overhead

    ORIENTATION_TOKENS := round(len(JSON.stringify(packet)) * 0.3174032272551657)

the product's own calibration from `orientationProjection.ts`, asserted equal to
it in `m183Treatment.test.ts` so a product retune fails the test rather than
silently changing the benchmark's arithmetic. The INJECTED SECTION costs this
plus a constant preamble, and both are recorded.

## Transport duplication

M167 established that `content[0].text` duplicating `structuredContent` does not
imply a second model-token charge. M183 measures which serialization each channel
carries per instance (`transport.contentTextMatchesCompactPacket`) and counts the
payload **once**. §36.
