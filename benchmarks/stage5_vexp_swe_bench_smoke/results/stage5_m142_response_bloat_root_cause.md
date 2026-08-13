# M142 — Product response overhead: root cause

Measured against the exact producer — the real MCP server, `run_pipeline` →
`compactProductResponse` — on a small repository (~250 files) and a large one
(~2 800 files). No agent, no Docker, no network.

## The headline figure does not reproduce, and saying so matters

The reported `~63 kB response` does **not** appear at default budgets. Real
external responses measure **20–24 kB** on both a small and a large repository.
The response does reach 46 kB at `max_tokens=24000`, and would pass 63 kB at a
larger budget — but there the growth is the **answer**, not overhead.

A 63 kB response is not by itself evidence of bloat. The 63 kB figure corresponds
to an internal `CapsuleV2Result` shape rather than the external envelope; the
behavioural probe's own byte counts for ARC queries land at 64–78 kB, which is
where that number is likely to have come from.

The **ratio** complaint does reproduce: at the default budget only 34.4% of the
response is answer-bearing. And overhead is worst exactly where responses are
smallest, because most non-content fields are fixed size — content share climbs
to 43.4% at 8 000 tokens and 49.1% at 24 000.

## Defect 1 — the detail contract was inert

| detail | bytes (large repo, default budget) |
|---|---|
| compact | 18 351 |
| default | 20 302 |
| debug | **20 303** |

`debug` returned **one byte** more than the default.

The cause is that the standard/debug boundary was drawn at **array size** rather
than at **audience**. A diagnostics array was collapsed only once it exceeded
`MAX_INLINE_DIAGNOSTIC_ENTRIES` (12), and `debug` then restored a sample of
`MAX_DEBUG_SAMPLE` (12). On a real request nothing crossed that threshold, so
there was nothing for debug to restore. The 3.48 kB of diagnostics in the default
response is not one big matrix — it is a dozen small always-present sections.

Consequence: every ordinary caller paid for internals they never asked for, and a
caller who explicitly asked for internals got nothing extra.

## Defect 2 — the selection was serialized five times

Not three. Measured field by field at `max_tokens=8000`:

| # | Field | Bytes | What it is |
|---|---|---|---|
| 1 | `productContext.items` | 6 253 | the structured selection (authoritative) |
| 2 | `productContext.modelVisibleContext` | 4 828 | the same selection rendered as the answer |
| 3 | `capsuleResult.pivots` + `support` | 2 630 | the same selection again as a manifest |
| 4 | `capsuleResult.digest` | 1 291 | the same selection rendered again as markdown |
| 5 | `productContext.diagnostics.{selected,support,required}Files` | 459 | the same file list again |

The duplication is provable rather than asserted: **6 of 6** `roleReason` strings
in the manifest are character-identical to entries in
`productContext.items[].selectionReasons`, and `digest` renders those same
strings a third time. `capsuleResult` also scales *with* the payload
(5 451 → 8 739 bytes as `productContext` goes 14 312 → 22 575), which is what a
duplicate representation looks like — it tracks the answer instead of being a
fixed header.

Diagnostics appear three times as well: `diagnostics` (3 479), 
`productContext.diagnostics` (1 007), `capsuleResult.diagnostics` (283).

## What was fixed

Two of the five copies became references, and the detail contract now means
something:

- `capsuleResult.{pivots,support}[].roleReason` — cleared by default, kept at
  `debug`. Identity and `contextItemId` remain, so the manifest still resolves.
- `productContext.diagnostics.{selected,support,required}Files` — counts by
  default, full lists at `debug`.

`debug` now differs from the default by 969 bytes at 8 000 tokens and 224 at the
default budget, instead of 3 and 1.

## What was deliberately not fixed

- **`modelVisibleContext` and `productContext.items`** are the answer and the
  authoritative selection. §53.
- **`capsuleResult.digest`** looked like the obvious third cut. It is an
  *injectable context payload* (`--inject-capsule-digest`, with the M57 digest
  decision contract built on top), so in some configurations it **is** the
  answer. §53 protects it.
- **`diagnostics.freshness`** looked like a duplicate of `indexFreshness`, and
  the code's own comment says freshness is reported three times. But its
  `autoReindex.state` and `observedFileChanges.changedFiles` are asserted at
  *default* detail by the staleness tests — a capability callers act on.
- **`diagnostics.retrieval.search`** is already correct: counts by default,
  bounded samples at debug.
- **The three budget blocks** are not redundant. `responseBudget` accounts for
  the whole serialized envelope, `productContext.accounting` reports compression
  against a full-source baseline, `capsuleResult.budget` reports capsule usage.

## Why the default is only 1.1–2.9% smaller

An attempt to move whole diagnostics sections behind `debug` failed nine tests,
including declared-schema conformance. Those sections and their required fields
are part of the **published response schema**; reshaping them needs a schema
change, and §31 rules that out for a partial solution.

What remains at default is the answer plus fields the schema declares and callers
branch on. The reduction is honest rather than material, and that is reported as
such rather than dressed up.

## Reduction metric semantics (§45)

Audited; **no change needed**. The metric is already stated as compression against
a named baseline everywhere it appears:

- `baseline`: *"full source contents of every unique selected source file before
  compression; duplicates and generated response metadata excluded"*
- `claimBoundary`: *"Compression relative to uniquely selected full files; not the
  repository, provider-billed tokens, or exact tokenizer usage."*
- schema: *"Percent reduction vs. the naive full-file baseline"*
- digest line: `saved≈{n}t vs full-file`

Nothing presents it as retrieval quality, answer correctness, or gold coverage.
