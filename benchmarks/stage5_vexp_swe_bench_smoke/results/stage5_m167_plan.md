# M167 — MCP Result Transport and Single-Representation Audit: plan as executed

Starting point: M166 (`749434ee`), which proved the composed first-call result is
expensive and that repository evidence is not the dominant part of that cost. M166
noticed, but did not price, that `content[0].text` and `structuredContent` are both
returned on every call. M167 prices it.

## The question, and the trap in it

> Is VTRACE paying model-visible cost for multiple representations of the same
> semantic pipeline result?

The trap is that "paying" is ambiguous across four boundaries, and the M166 invariant
already says so: `GENERATED != TRANSMITTED != MODEL_VISIBLE != BILLED`, extended by
`SERIALIZED TOKENS != MODEL-CONTEXT TOKENS until directly measured`. A second copy on
the wire is a real cost at the wire and possibly no cost at all at the model. So every
width is measured three times over and never summed:

| boundary | what it is |
| --- | --- |
| INTERNAL | the authoritative semantic output the pipeline assembled |
| WIRE | the JSON-RPC line, carrying **both** channels |
| MODEL_VISIBLE | the one channel the client hands to the model |

## Workstreams

- **A — transport and consumer authority.** Trace producer to consumer with a source
  anchor for every claim, re-verified on each run so the artifact cannot go stale.
  Establish what the advertised protocol revision actually permits, identify the single
  semantic authority, and classify every consumer the repository claims or exercises.
  A consumer whose behaviour is neither observed nor pinned by code is UNKNOWN, and
  UNKNOWN constrains what may be removed.
- **B — byte and token attribution.** Capture all twelve reference tasks through a real
  `mcp-serve` child process, keeping the raw wire line. Decompose with M166's unchanged
  classifier, at M166's calibrated 3.15 chars/token, never `chars/4`. Separate
  restatement ACROSS channels from restatement WITHIN the delivered channel.
- **C — candidate simulation.** Price CURRENT, STRUCTURED_ONLY, TEXT_ONLY and
  STRUCTURED_PLUS_SUMMARY at the wire and at the model — once per client read rule,
  because a candidate priced against one client is not a saving. Re-derive, rather than
  cite, which channel the agent client actually delivers.
- **D — repair, only if justified.** Materiality gate: 20% median model-visible
  reduction. `D NOT RUN` is a legitimate outcome and is not to be avoided.
- **E — preservation and closure.**

## Constraints carried in

Not a retrieval milestone; not a routing milestone. No paid agents, no Docker, no live
spend. No V2 result schema. Do not shrink evidence to make the number look better —
M166 already found the packer suppressing legitimate evidence under envelope pressure,
and "solving" transport overhead by evicting evidence again would be the same mistake
wearing a different label. Do not remove restatements on the strength of a shared
string: M166 established that two components can legitimately carry the identical skip
reason, and that short enumerated labels are per-item semantics.
