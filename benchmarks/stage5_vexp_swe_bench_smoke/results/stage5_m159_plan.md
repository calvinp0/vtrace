# M159 plan — retrieval loss localization and candidate-depth audit

**Audit-first.** M159 does not begin with a proposed fix, and may legitimately end
with no product change.

## The question

For every remaining broad100 gold failure, what is the **earliest** product stage
at which useful evidence becomes unavailable to the downstream model — and does a
large enough cross-repository population share that first divergence to justify a
generic change?

## Why this shape

M157 and M158 each spent a milestone on a defect that was real, visible, correctly
diagnosed — and not the causal bottleneck. M158 in particular found nine cases
losing gold to a bounded support cap, simulated seven packing rules over the
product's own ordering, and recovered **zero**. The lesson is now a protocol: a
mechanism that explains a failure is not yet evidence that fixing it helps, and
only a simulation over the complete affected population can tell those apart.

So M159 traces before it theorises, and simulates before it writes code.

## Workstreams

| | scope | may be skipped |
| --- | --- | --- |
| A | reconstruct the residual population mechanically; verify ground truth; freeze a hashed manifest | no |
| B | trace every residual case to a first divergence; separate bound eviction from generation coverage | no |
| C | aggregate by causal mechanism; simulate every plausible intervention with recovery **and** harm; decide | no |
| D | functional candidate | **yes — only if C finds a generic population** |
| E | preservation, verification, closure | no |

## Method commitments

- **Recompute, never inherit.** M157 and M158 both had to correct an inherited
  count. Every number is re-derived from the product's own build.
- **Controls before conclusions.** The path matcher, the pre-cap detector and the
  reach probe each carry a positive control, because a plausible zero is the
  failure mode that nearly inverted M157-A.
- **First divergence means earliest causal loss.** A symbol missing from the index
  is an index finding regardless of how badly it would also have ranked.
- **No bound derived from a gold rank.** `gold at position 28` is not an argument
  for `maxResults = 28`.
- **Widened pools are diagnostics, never proposals.** Any unbounded probe is
  offline, instrumentation-only, and labelled as such.
- **No product code changes before the C decision.**

## Stage model traced

```
index representation -> query shaping -> hybrid generation (all lanes)
  -> CANDIDATE_POOL_SIZE cap -> post-hybrid lane injection -> role assignment
  -> bounded pivot/support packing -> delivery
```

## Success

M159 succeeds if the residual population is localized with zero unexplained cases,
whether or not any functional work follows. Fabricating a product change to make
workstream D execute would be a failure, not a pass.
