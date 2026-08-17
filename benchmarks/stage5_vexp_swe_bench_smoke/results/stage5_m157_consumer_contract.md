# M157-D — the delivery contract across product surfaces

M157 §48/§49/§60: if the authoritative delivery state changes, every product
surface must agree about it, and no consumer may quietly require a pivot that
the delivery contract no longer requires.

## The surfaces

`get_code_context`, `get_context_capsule` and `run_pipeline` share one
`productContext` schema (`src/mcp/tools.ts:8246`), so they cannot disagree about
the *shape* of a result. They can, and had to be checked to, disagree about its
*content*.

Asserted in `src/mcp/pivotAuthorityConsumers.test.ts` against a live repository
(via `initRepo` + the real MCP server), on the generic shape that produced the
empty capsule in M157-A — doc-tree candidates outranking real source:

| property | contract | status |
| -------- | -------- | ------ |
| `ok` | identical across all three | asserted |
| `resolved` | identical across all three | asserted |
| `leadPivot` | identical across all three | asserted |
| lead is never a non-source file | holds on all three | asserted |
| irrelevant query → no lead, `resolved: false` | holds on all three | asserted |
| empty result → never `authoritative_absence` | holds on all three | asserted |

The fixture is guarded against a vacuous pass: it asserts a pivot IS delivered,
which happens only because a released slot was reclaimed. Without the M157 fix
the same fixture delivers nothing.

## `resolved` — audited, not removed (§61)

```
assembleProductContext.ts:294
  resolved: product.actualMode !== "no_context" && product.pivots.length > 0
```

§61 asks whether a condition of this shape means *no actionable target* or *no
usable context*, and warns against blindly deleting it. Classified: it means
**no actionable target**, and that is the correct meaning to keep. It is not
changed by M157.

The reason it did not need changing is that M157 did not introduce a
support-only delivery state. Had it done so, `resolved: false` alongside a
non-empty item list would have been the boolean collapse §63 warns about. That
remains true for any future milestone that revisits the support-only lane, and is
recorded here as the open design constraint.

## Absence truthfulness (§37, §38, §66)

- The no-pivot reason string is `no high-confidence edit target recovered`.
  "Recovered" scopes the claim to the bounded evidence; it does not assert that
  no edit target exists in the repository, which is the overclaim §38 forbids.
- `absenceClaim` is documented and asserted as always `not_observed`, the weakest
  rung of the shared evidence scale (`src/mcp/tools.ts:8254`). No no-pivot or
  empty result is serialized as `authoritative_absence`.

## Selective-search and anti-search semantics (§47, §64)

Unchanged. M157 adds no guidance text, no "stop searching" claim, and no coverage
assertion. `coverage` remains `SELECTIVE_TASK_RETRIEVAL_COVERAGE` on every path,
so a delivered capsule still does not imply exhaustive enumeration. A reclaimed
pivot carries ordinary pivot semantics — it is an edit target because it met the
pivot bar, not because a slot happened to be free.

## Serialization survival (§50)

The reclaimed role is an ordinary `pivot`, so it traverses
capsule → `productContext` → MCP serializer with no new state to lose. The two
M157-A observability fields (`support_authority_withheld`, `role_reason`) are
diagnostics on the capsule result and are deliberately not promoted into the
product response: they describe why a candidate was withheld, which is an audit
question, not a model-visible one.

## Injection builder (§51)

Not exercised: M157 runs no live agent. The historical injection path consumes
the same `productContext`, and the state it sees is either a normal pivot capsule
(sphinx-9320, previously empty) or a genuinely empty one (django-11740,
unchanged). No new state is introduced for it to mishandle.
