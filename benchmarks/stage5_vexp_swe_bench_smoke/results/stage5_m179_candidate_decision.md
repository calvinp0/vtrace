# M179-D — which repair, and why not the other two

Simulated on frozen authority **before** any product code was changed. A candidate
is a policy over the same pure packing function: a packet is obtained by packing
the frozen object at an evidence budget, and the policy is judged against the
ceiling of the **caller's** budget. No product change was needed to know what each
would do.

## The table (Broad100-A, 88 frozen objects, 12 budgets, all ordered pairs)

| Candidate | Monotonic violations | orientation→decline | Item loss | Priority inversions | Truthfulness errors | Default output changes | Refill | Median token change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C_CURRENT | 603 | 580 | 23 | 0 | 0 | — | — | — |
| **C_NESTED_RUNG** | **28** | **0** | 28 | 0 | 0 | 4 | 0 | 0 |
| C_RAISE_ALLOWANCE | 603 | 580 | 23 | 0 | 0 | 0 | 0 | 0 |

## Why C_NESTED_RUNG

The caller's budget sets the **ceiling**; the evidence budget may be lowered
beneath it until the rung the packer chose is one the envelope can actually ship.

It cannot invent anything. The packer's ladder is a fixed sequence of ever weaker
drafts, identical at every budget, in which the budget selects only where to stop.
Re-running it at a smaller budget therefore returns a rung **the packer would
itself have published for a smaller request** — an existing representation of
existing evidence, never a new claim, and never more evidence than the caller's
own budget already allowed.

It is monotone for a reason rather than by measurement: as `B` grows, `ceiling(B)`
grows and metadata does not, so the set of affordable rungs only grows, and the
largest affordable rung is non-decreasing.

## Why not C_RAISE_ALLOWANCE

Raising the metadata allowance is the fix §14 forbids, and the table says why in
numbers rather than in principle: **it changes nothing**. It moves *which* budgets
fail without making a larger budget behave better than a smaller one. The defect
is not that some budget is too small; it is that more budget can produce less
answer. A ceiling change leaves that intact and leaves the algorithm wrong.

## Why not the others

- **C_BEST_VALID_PREFIX** — needs the packer to know the metadata cost, which is
  not decided until after the compaction that follows it. Not implementable at the
  seam where the decision has to be made.
- **C_MONOTONE_ADMISSION** — rewriting admission to be incremental is a redesign of
  a component that is already monotone. §53: the packer's ladder is not the defect.
- **Deleting the failing rungs** — §15. The budgets are a known positive, not a
  parameter to tune, and the boundary search shows they are not special: the
  transition sits at 947 tokens because that is the rung size, and it moves with
  the case.

## What C_NESTED_RUNG does not fix

28 item-loss pairs survive on Broad100-A. They are **not** the same defect, and
they were mostly invisible before because those budgets declined instead. They
share one root cause:

> `compactMandatoryProductMetadata` collapses `productContext.items` to one entry
> to save **metadata** — but the orientation projector derives both the focus and
> the related list from that array. A metadata compaction is therefore an evidence
> compaction.

Two consequences, both measured: related entries vanish, and the surviving item —
`items[0]`, first in authoritative order — can differ from the item the packer's
own rung 8 keeps, which is `sort(compareKeepPriority)[0]`. Two different
"strongest item" rules, so the focus can change as the budget grows.

Repairing that means changing what item metadata means to the projector, which is
a different component, a different contract, and a wider blast radius than the
fallback defect. It is recorded as the licensed next work, not folded into this
milestone.
