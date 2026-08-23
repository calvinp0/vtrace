# M177-C — the bounded impact decline

What `get_impact_graph` returns when a valid request, answered against a valid
repository, produces a response that cannot be represented inside the configured
impact envelope.

## The condition

```text
valid request
+ repository ready
+ getImpactGraph returned ok
+ every rung of compactImpactProductResponse's ladder applied
+ rebuilt budget still exceeds totalCeiling or the 80,000-character ceiling
```

Before M177 this threw `impact_response_envelope_unreachable`, which the MCP
server's catch-all reported as `handler_failed` with `isError: true`. The caller
received no impact evidence, no counts and no decline — only a transport fault
indistinguishable from a genuine bug.

## Why the ladder could not reach the condition on its own

The ladder's gate and its terminal check do not test the same thing.

| site | expression | conditions |
| --- | --- | --- |
| `impactResponseEnvelope.ts:183` `fits()` | `estimatedTotalTokens <= totalCeiling && serializedCharacters <= 80000 && modelVisibleEstimatedTokens <= requestedMaxTokens` | 3 |
| `impactResponseEnvelope.ts:338` the throw | `estimatedTotalTokens > totalCeiling \|\| serializedCharacters > 80000` | 2 |

Every rung is driven by the model-visible bound, and then the throw fires on the
total. So the ladder sheds evidence to exhaustion and dies on something else:
measured at the floor for `src/_pytest/debugging.py::_enter_pdb`, the delivered
evidence costs **472 tokens** and the metadata no rung touches costs **745** —
**61.2%** of the smallest response the ladder can build.

The ladder also has a floor above zero by construction: `directRelations` stops
at one (line 267 and the `bounded_degradation` rung at 311), `edges` stops at one
(line 325), and nothing reduces `requested`, `resolvedSymbol`, `coverage`,
`summary`, `richSummary`, `limits`, `timing`, `diagnostics` or `callerCoverage`.

The clearest proof that this is not an "too much evidence" problem: **a symbol
with no impact at all also threw**, at `max_tokens=1`, through the real
transport. There was never any evidence to shed.

## What the model receives

The existing response shape, in the existing vocabulary, with every evidence
channel empty and every count intact:

```json
{
  "resolvedSymbol": { "fqName": "src/_pytest/debugging.py::_enter_pdb", "...": "..." },
  "edges": [], "nodes": [], "directRelations": [], "paths": [],
  "view": { "format": "tree", "lines": [] },
  "summary":  { "consumers": { "exactCallerCount": 3, "potentialCallerCount": 4, "...": "..." } },
  "richSummary": { "directIncoming": 5, "truncated": true, "...": "..." },
  "callerCoverage": { "status": "incomplete", "exactCallerCount": 3,
                      "deliveredExactCallerCount": 0, "potentialCallersOmitted": 4 },
  "diagnostics": { "deliveryTruncated": true, "envelopeDecline": true },
  "responseBudget": { "retainedEdges": 0, "omittedEdges": 55,
                      "resultState": "bounded_truncated", "withinEnvelope": true }
}
```

Measured on the known positive through real MCP: **2,575–2,581 characters**,
constant across `max_tokens` 1/50/100/200/400.

## Why no new public state

`resultState: "bounded_truncated"` beside `retainedEdges: 0` and
`omittedEdges: 55` already means exactly what this needs it to mean — *55 edges
exist and you received none of them* — and it was already the state the tool used
one rung above. A genuinely empty impact reports `omittedEdges: 0` and
`resultState: "response_compacted"`, so the two are distinguishable without a new
word.

The distinction a **maintainer** needs is kept internally, as one boolean:

```text
diagnostics.envelopeDecline: true
```

set only where the ladder was exhausted, absent from every response the ladder
could build. Telemetry can separate "degraded gracefully" from "could not build
the degraded form" without the public schema growing a state. This follows M176's
decision for `run_pipeline` exactly.

## What the record may say

Nothing authored. Every value is either carried through from a fact the engine
established before the ladder ran, or a constant owned by this file.

| fact | source | bound |
| --- | --- | --- |
| `resolvedSymbol.fqName` / `filePath` / `localName` | verbatim | 200 chars, else **omitted** |
| `requested.symbolFqn` | verbatim | 200 chars, else **omitted** |
| `summary.consumers.*` | untouched — M139 discovered accounting | integers |
| `richSummary.*` counts | untouched | integers |
| `callerCoverage.exactCallerCount` / `potentialCallerCount` | untouched | integers |
| `callerCoverage.delivered*` | zero, beside the discovered counts | integers |
| `callerCoverage.status` | clamped away from `complete` | enum |
| `responseBudget.omittedEdges` | `max(richSummary.omittedEdges, originalUniqueEdges)` | integer |
| `diagnostics.*` counters | untouched traversal work | integers |
| `diagnostics.envelopeDecline` | this rung, and only this rung | `true` |

Dropped whole: `edges`, `nodes`, `view.lines`, `directRelations`, `paths`,
`dependentFiles`, `affectedFiles`, `entrypoints`, `tests`, `potentialCallers`,
`accounting`, all prose notes and limitations, and the three open-ended maps
`countsByRelation`, `countsByStrength`, `fieldDomains`.

**Omission, not truncation.** `fqName` is the argument a caller feeds straight
back into this tool as `symbol_fqn`. Half a symbol name is an identity that does
not resolve — worse than an explicit refusal to quote it. Over-long identities
are therefore replaced with a constant marker, never cut.

## What it refuses to say

It never reports an absence it did not observe.

- `summary.consumers` and `richSummary` are the **discovered** populations and are
  passed through untouched, so the record cannot read as "there are no consumers".
- `callerCoverage` keeps `exactCallerCount` beside a zeroed
  `deliveredExactCallerCount`, which is the discovered/delivered split M139 built
  for exactly this purpose.
- `status` may only ever get **less** certain: dropping evidence for budget can
  never increase certainty.
- `omittedEdges: 0` is emitted only when the authoritative graph genuinely had
  nothing, so an honest zero stays an honest zero.

The two `@deprecated` mixed-direction fields `summary.dependentSymbolCount` and
`summary.dependentFileCount` do go to zero. That is deliberate and consistent:
`rebuildCanonicalNodeAndViewProjections` maintains them as **delivered**-set
counts everywhere else in this file, so leaving them at their discovered values
would make them mean something different in the decline than in every other
response. The truthful population they used to blur is `summary.consumers`, which
survives.

## Terminal construction

The record is built once and **returned**, never re-measured against a gate that
can reject it. There is therefore no path from the decline back to an unreachable
state — the failure mode §26 prohibits is structurally absent rather than
argued away.

Its size is a constant, not a function of the input: every field it carries is a
frozen constant, a boolean, a non-negative integer, an enum, or one of four
identity strings bounded at 200 characters. Measured across the qualification
corpus the largest decline is **878 provider-billed tokens**; the smallest ceiling
it must fit is `max_tokens=1` → **801 chars/4 tokens**, and the largest measured
decline against that ceiling is **674**. A pathological-identity unit test drives
all four identity strings to 2,800 characters and the terminal still fits.

## Precedence

| ready? | engine | fits? | terminal |
| --- | --- | --- | --- |
| no | — | — | `repo_not_ready` — unchanged |
| yes | invalid symbol / bad bounds | — | `invalid_request` — unchanged |
| yes | ok, empty impact | yes | empty impact, `omittedEdges: 0` |
| yes | ok, empty impact | no | decline, `omittedEdges: 0`, `response_compacted` |
| yes | ok, non-empty | yes | impact response |
| yes | ok, non-empty, ladder succeeded | partial | `bounded_truncated`, `retainedEdges > 0` |
| yes | ok, non-empty, ladder exhausted | no | `bounded_truncated`, `retainedEdges: 0`, `envelopeDecline` |
| yes | unexpected internal fault | — | `handler_failed` — unchanged |

## Where the fallback can be reached from

Exactly one place: the failed final measurement at the end of the ladder in
`compactImpactProductResponse`. It is never reached from a caught exception, so a
genuine implementation fault still propagates and is still reported as
`handler_failed`. The fallback classifies one predictable condition; it is not a
place for bugs to be made presentable.

## Relationship to the M176 construction

Analogous, **not** shared. `run_pipeline`'s decline replaces the response with a
different, loosely-typed record because that tool's schema permits it.
`get_impact_graph` declares eleven required output fields, so its terminal must
remain a valid `ImpactGraphOutput` — it is the same draft with its evidence
emptied and its metadata bounded, not a substitute object. No common abstraction
was extracted: the two differ in the one respect that matters (whether the shape
may change), and unifying them would have to erase that difference to exist.
