# M172-E — the integration decision

## The rule that had to be satisfied first

Integration was licensed by one condition, set before the holdout ran: the frozen
policy passes the M171 preservation and economic gates on **Broad100-B**, the
corpus that was never consulted during design and is disjoint from development.

It does.

```text
median tokens          621   gate <= 2000
p90 tokens             865   gate <= 2500
projected cost      $0.0084  gate <= $0.026219
pivot identity        98/98   gate 100%
gold file            0.00pp   gate >= -2pp
gold symbol          0.00pp   gate >= -2pp
soundness                 0   gate 0
```

Broad100-A agrees on every gate and is reported for continuity only. It contains
all twelve development cases, and M171 published which three of its cases failed
its gold-symbol gate and at what authoritative positions — so A could not have
licensed anything, whatever it showed.

## What was changed

```text
src/runPipeline/orientationProjection.ts    new; the projector, pure
src/runPipeline/orientationProjection.test.ts  new; the disclosure contract
src/mcp/tools.ts                            the disclosure decision, the
                                            get_code_context delegation guard,
                                            and the declared output schema
```

The decision itself is three lines, placed after the authoritative result is
complete:

```ts
const orientation = detailRequested === McpResponseDetail.Debug
  ? null
  : projectRunPipelineOrientation(authoritativeResult);
return { ok: true, output: orientation ?? authoritativeResult };
```

## What was deliberately not changed

- **retrieval, ranking, candidate generation, scoring, selection** — the projector
  takes the authoritative order and admits a prefix of it. It computes nothing
  about the repository and can surface no source the response did not carry.
- **the authoritative result** — `detail=debug` returns exactly what the default
  returned before. The expression producing it is untouched; the projection is a
  step after it.
- **failure and readiness semantics** — the projector declines on every state it
  is not defined over, so those envelopes keep their reason, readiness and
  `nextTool` in full.
- **transport compatibility** — both `content[0].text` and `structuredContent`
  survive and now carry the same compact packet, because the former is
  `JSON.stringify` of the latter's payload.
- **`detail=debug` richness** — it is not compact and was not made compact.

## Why not a second tool

A `run_pipeline_v2` or an `orientation_pipeline` would have avoided every
consumer break in this diff. It would also have meant two authoritative paths,
two things to keep true, and a default that stayed expensive for anyone who did
not know to switch. The authoritative path was evolved instead.

## The consumer cost, stated plainly

Roughly 80 pre-existing assertions across nine test files now pass
`detail: "debug"`. That is not incidental bookkeeping — it is the honest
consequence of the change, and it is worth naming what it means: **every one of
those tests was reading the authoritative result through the default channel.**
They test what the pipeline resolved, not what it discloses, so asking for the
authoritative result explicitly is what they always meant. Their passing is also
the debug-preservation evidence.

Any external consumer doing the same will need the same edit. The declared
`outputSchema` documents both shapes and the `schemaVersion` string says which
one arrived, so the change is discoverable rather than silent.

## Two proofs that the qualification transfers

A benchmark module was measured; a different file ships. That gap is where a
qualification usually leaks away, so it was closed twice:

- **shipped equals qualified** — `stage5_m172_product_identity.json`: 210 captures
  across all three corpora, 209 identical projections, 1 both-declined, 0
  mismatches. The one permitted divergence is that the product declines on
  non-resolved states where the benchmark emitted a `problem` packet — strictly
  more conservative, and no measured number depends on it.
- **shipped dominates M171** — 209/209 packets are supersets of M171's R2000
  packets with an identical focus, so M171's 7/7 first-action support transfers
  by construction.

## Verdict

```text
DEFAULT_ORIENTATION_REDESIGN_SHIPPED
```

with `LIVE_REQUALIFICATION_LICENSED` — licensed, not requested, not run. $0.00
was spent. A live comparison costs real money and needs explicit authorization
before it happens.
