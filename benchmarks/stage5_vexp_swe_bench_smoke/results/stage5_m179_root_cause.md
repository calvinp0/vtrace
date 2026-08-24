# M179-C — why more budget produced less answer

## 1. The known positive, from one frozen authoritative object

`django__django-10880`, captured once and re-packed at each budget. Nothing
upstream of the envelope runs between rungs, so no difference here can be engine
state.

| max_tokens | packer rung | affordable evidence | deliverable | terminal state |
| ---: | ---: | ---: | :---: | --- |
| 400 | 212 | 313 | yes | orientation |
| 600 | 212 | 357 | yes | orientation |
| 800 | 212 | 557 | yes | orientation |
| 1,000 | **947** | **837** | **no** | **delivery_failure** |
| 1,600 | **1,512** | **1,458** | **no** | **delivery_failure** |
| 2,000 | **1,951** | **1,858** | **no** | **delivery_failure** |
| 3,200 | 2,863 | 2,931 | yes | orientation |
| 6,400 | 2,863 | 3,019 | yes | orientation |
| 8,000 | 2,863 | 3,010 | yes | orientation |

`deliverable` is `rung <= affordable`, and it predicts the terminal state on every
row. Nothing else is needed to explain the sequence.

**Boundary search.** The last good budget is **946** and the first bad one is
**947** — exactly the size of the rung the packer switches to. Recovery: last bad
**2,124**, first recovered **2,125**. These are not soft thresholds; they are the
step function crossing a line.

## 2. The first divergence, named

```text
budgetDelivery.ts:142     const fits = () => estimateTokens(render(product, items)) <= budget;
```

The packer publishes the first rung whose rendered evidence fits `max_tokens`.
That is the MODEL_VISIBLE_BUDGET, and enforcing it is correct. But the constraint
that decides whether the response ships is

```text
responseEnvelope.ts:78    responseTokenCeiling(B) = B + max(1000, ceil(0.15 * B))
```

applied to the **complete** response. Real metadata on this corpus costs
1,087-1,269 tokens against a 1,000-token allowance, so affordable evidence is
`B - ~221`, and any rung between `B - 221` and `B` is selected and then cannot be
sent.

The divergence is not that a larger budget makes a worse *choice*. Both choices
are correct for the bound each component enforces. The divergence is that **the
slack `B - rung(B)` is not monotone**: rung sizes are a step function, so a small
budget can land on a tiny rung with generous slack while a larger one lands on a
rung that consumes everything the ceiling grew by and more.

And once that happens the only remaining move is:

```text
responseEnvelope.ts:432   degradeOversizedProductResponse(...)  ->  items = [], delivery_failure
```

The two escalations before it reduce **metadata**; neither can shrink
`modelVisibleContext`. So the envelope's ladder has no rung between the packet the
packer chose and nothing at all — even though the packer's own ladder has eight.

## 3. The declines were dominated, all of them

For every ordered pair where a smaller budget delivered an orientation and a
larger one declined, the smaller budget's packet was replayed against the larger
budget's contracts:

- Broad100-A: **580 / 580 dominated**
- Broad100-B: **508 / 508 dominated**

Django, explicitly (§66/§98): the packet delivered at **800** satisfies the
evidence budget and the total-response ceiling at **1,000**, **1,600** and
**2,000** — `true, true, true`. Its 212 evidence tokens are inside every one of
those budgets and its 1,455-token total is inside every one of those ceilings.

> **At the budgets where Django declined, a packet already proven valid at a
> smaller budget satisfied every M178 fit contract. The decline was not necessary.
> It was dominated.**

The arithmetic also shows how far from necessary: at `max_tokens` 1,000 the
degraded response occupies 1,210 tokens of a 2,000-token ceiling. The product
discarded the evidence and then shipped 790 tokens of unused headroom.

## 4. Root-cause class

```text
PACKER_FALLBACK_NON_MONOTONICITY
```

Not `RUNG_TRANSITION_REBUILDS_SELECTION`: the ladder never rebuilds or reorders.
Not `BUDGET_DEPENDENT_CANDIDATE_GENERATION`: candidate supply and order are
identical at every budget, pinned by hash. Not `PRIORITY_INVERSION`: zero
measured, before or after. Not a fit-contract ambiguity: M178 settled that, and
this path has no disagreement window at all.

It is a **fallback** defect. A valid smaller packet is known to exist — the packer
built it on the way past — and the terminal discards it instead of falling back to
it. `CARDINALITY_BUDGET_INTERACTION` is the contributing condition (a flat
allowance that under-grants against real metadata) but not the defect: if the
fallback descended the ladder, the same allowance would produce a monotone result.

## 5. The invariant (§100)

> For one fixed authoritative object, fixed candidate supply and fixed order, and
> budgets `B2 > B1`: every semantic evidence item delivered at `B1` must be
> represented at `B2`, and a normal response at `B1` must remain a normal response
> at `B2`.
>
> **Representation substitution counts as preservation** when it names the same
> item and adds detail — a signature replaced by a longer head, a name joined by
> an excerpt. A longer *string* is not automatically stronger: a body carrying the
> renderer's closing sentence is not more of the symbol. And a shorter body is a
> downgrade however it is labelled, while a longer body carrying an honest
> `codeTruncated` qualifier is not.
>
> The converse is not required. `B2` need not say more than `B1`. Once the compact
> orientation is sufficient, stopping is correct — what is forbidden is taking
> something back.

## 6. Two instrument errors, both caught before they became findings

**The corpus was a response, not the packer's input.** `compactProductResponse`
removes `productContext.items[].content` unconditionally as a duplicate of
`modelVisibleContext`. Captures taken through the ordinary tool path — including
M176's own snapshots — therefore carry items with no bodies, and re-packing them
renders body-free sections and measures rungs made of headers. Captured instead
with `include_item_content`, the Django window moves from 800-1,000 to
1,000-2,000: the same defect, at budgets the old fixture could not have named.
Both corpora are kept, the stripped one as a standing control (88/88 carry bodies;
the control corpus 0/84).

**`codeTruncated` is not a downgrade signal.** A first cut of the detector treated
a newly truncated focus as a representation regression and reported 815 of them.
477 were a body growing from 221 characters to 1,799 with an honest truncation
note — an eight-fold *increase* scored as a loss, because a skeleton is not marked
truncated while a longer head is. Measuring the code actually delivered took that
class to **0 before and 0 after**.

A third was found and normalized rather than fixed: `parseRenderedBodies` assigns
everything after an item's metadata lines to that item's body, and the renderer
appends one closing sentence after the **last** section — so the final item's
`code` ends with a sentence that is not source. It contaminates **268 of 582**
orientation packets on Broad100-A, and which item is last depends on the budget,
so it reads as a representation change. Normalized out of every measurement here
and recorded as an outstanding defect: repairing it is a rendering change, not a
packing one.
