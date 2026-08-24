# M180 — root cause

## The one-line finding

> `productContext.items` is two things wearing one name: the model-facing per-item
> metadata the response envelope shrinks to fit a ceiling, and the INDEX the
> orientation projector reads to decide what the agent is told. The envelope
> shrank it by DELETING rows and left `modelVisibleContext` alone — so the
> response kept paying to ship evidence the projector could no longer reach, and
> because how many rows survived depended on the budget, a larger budget could
> deliver a smaller answer.

## How it was established

`applyProgressiveContextBudget` sets `product.items` and renders
`product.modelVisibleContext` from the SAME delivered list, and nothing between
there and the wire rewrites that rendering except the last-resort degradation,
which replaces it wholesale and is separately identifiable. So on any delivered
response the rendering is an unforgeable witness of what the evidence layer
delivered:

```text
section ids of modelVisibleContext  = the EVIDENCE layer's supply
ids of productContext.items         = what the PROJECTOR was handed
difference                          = evidence in the payload, unreachable
```

`django__django-11133`, one frozen authoritative object, budget varied alone:

| max_tokens | rendered sections | items | related delivered |
| ---: | ---: | ---: | ---: |
| 800 | 7 | **1** | 0 |
| 1,600 | 10 | **1** | 0 |
| 3,200 | 13 | 3 | 2 |
| 6,400 | 21 | **1** | 0 |
| 8,000 | 21 | 5 | 4 |

The evidence layer is monotone at every one of those budgets — 7, 13, 13, 21, 21
items delivered, items and rendering agreeing row for row. Everything in the
right-hand columns happens afterwards.

**Do not read `responseBudget.compacted_fields` for this.** It is
`[...new Set(fields)].sort().slice(0, reportedFields)` — alphabetically truncated
— so `productContext.items` drops off the report on exactly the responses where
it fired. At budget 800 above, the field is absent and the rung had run.

## The synthetic control (§25)

An object containing nothing but sixteen items, no retrieval, no ranking, no
upstream state to blame:

| max_tokens | evidence layer | projector input | related delivered |
| ---: | ---: | ---: | ---: |
| 800 | 7 | 3 | 2 |
| 1,600 | 16 | 4 | 3 |
| 3,200 | 16 | **3** | **2** |
| 8,000 | 16 | 16 | 15 |

More budget, less answer, with only the metadata ladder in between.

## The two rungs

```text
enforceTotalEnvelope, field "productContext.items"
  items.slice(0, kept), halving to MIN_RETAINED_PRODUCT_ITEMS = 3
  9 of the 83 violations
  its own comment: "the rendered context itself is untouched" — which is the defect

compactMandatoryProductMetadata
  the array becomes [items[0]], rebuilt without lineSpan and without selectionReasons
  63 of the 83 violations
  keeps items[0], which is not necessarily productContext.leadPivot, so it can also
  move the focus; and the survivor it keeps loses its line span and its reason
```

## Not an aliasing bug

`compactProductResponse` opens with `structuredClone(output)`; the caller's object
is never reached. Every rung then mutates the draft's productContext record IN
PLACE, so its object identity is stable across the whole ladder while the array it
holds is replaced repeatedly. Nothing is shared with a caller. This is a LAYERING
defect, not an aliasing one: the projector was handed the serializer's output and
read it as evidence.

## Scale

| | |
| --- | ---: |
| delivering budgets swept (both corpora) | 1,380 |
| budgets where the projector's supply was cut by the metadata layer | **722** |
| frozen cases affected at some budget | **167 of 169** |
| M179 residual violations reproduced | **83 of 83** |
| of which attributed to the metadata layer | **72** |

## Formal verdict

```text
PROJECTOR_READS_MUTABLE_SERIALIZATION_SURFACE
```

`PRODUCT_CONTEXT_ITEM_ROLE_CONFLATION` is why it was possible — one array, two
owners, no type distinguishing their lifetimes. `PROJECTOR_READS_MUTABLE_SERIALIZATION_SURFACE`
is what actually happens, and it is the one a repair can act on: the projector is
downstream of serialization and should not be.
