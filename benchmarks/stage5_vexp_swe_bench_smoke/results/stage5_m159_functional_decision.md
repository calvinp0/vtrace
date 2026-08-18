# M159-C functional decision

> **MULTIPLE_SMALL_POPULATIONS**
>
> **M159-D: NOT RUN — no generic causal population justifies a product change.**

## The decision rule this was measured against

§47 asks a functional population to carry: multiple independent cases, preferably
multiple repositories, the same first divergence, the same structural
explanation, a **safe simulation**, negative controls, and a clear preservation
story. A population missing the simulation is not a smaller version of one that
has it — it is a different kind of object, and M158 is the precedent: a real,
correctly-diagnosed, cross-repository defect that recovered **zero** of the cases
it explained.

## The five populations, and why none of them clears the bar

| population | cases | repos | intervention simulated | recovered | why not |
| --- | ---: | ---: | --- | ---: | --- |
| `LANE_GENERATION_FAILURE` | 8 | 4 | *none constructible* | — | No lane reaches the gold symbol at **32×** the product's generation pool. Nothing short of new behaviour→implementation semantics applies, and §68/§69 forbid building those on this evidence. |
| `CANDIDATE_GENERATION_POOL_BOUND` | 6 | 5 | widen the generation pool | **0** | Gold becomes available at ranks 87, 110, 162, 343, 369, 1058 — all past the measured delivery ceiling of 30. |
| `CANDIDATE_BOUND_EVICTION` | 3 | 3 | pool cap 25→50, 25→100 | **0** | Gold is scored at ranks 40, 51, 74 — all past the ceiling of 30. |
| `INDEX_FILE_MISSING` | 2 | 1 | corpus repair | 2 | Not a product defect. Both workspaces were checked out without the subtree holding their gold file (§102). |
| `INDEX_SYMBOL_MISSING` | 1 | 1 | index nested functions | 1 | One case, one repository. Below §47's generality bar, and §43 prefers no change to a rule fitted to a single instance. |

## The measurement that refutes the whole bound family at once

Every bound intervention shares one unstated assumption: that a candidate
admitted deeper in the pool can still be delivered. That is directly testable, so
it was tested rather than assumed.

```
delivered items across 100 cases      570
deepest ordinary rank EVER delivered   30
p50 / p90 / p99                     4 / 14 / 25
```

The nine bound-population targets become available at ranks **40, 51, 74, 87,
110, 162, 343, 369, 1058**. Not one is inside a range the delivery layer has ever
reached, in 570 opportunities. So the bound really does cut these candidates off,
the diagnosis really is correct — and raising it recovers nothing. §42's rule
("gold position 28 ≠ set `maxResults` to 28") stops being a policy here and
becomes a measurement.

This is M158's finding one layer upstream, which is why it was worth the
simulation before the code.

## Structural patterns tested against a control, including the ones that failed

§39 asks for repeated structural facts, not repeated words. Three candidate
mechanisms were measured on the residual population **and on the 79 cases that
succeeded**, because a pattern that is never shown its control is not evidence.

| discriminator | residual | delivered (control) | verdict |
| --- | --- | --- | --- |
| task never names the gold symbol | 19/20 (95%) | 50/79 (63%) | **ENRICHED_NOT_CAUSAL** |
| gold symbol is private/dunder | 11/20 (55%) | 32/79 (41%) | **ENRICHED_NOT_CAUSAL** |
| derived task body is degenerate | 13/20 (65%) | 32/79 (41%) | **ENRICHED_NOT_CAUSAL** |

The degenerate-body result is the one worth keeping. On inspection it looks like
the obvious cause — thirteen residual tasks collapse to `### Bug summary`,
`**Describe the bug**`, `(last modified by Tim Graham)`. Then the control finds
the identical degeneracy in a third of the cases that **succeeded**. A defect most
of its victims survive is not the mechanism.

The lexical-handle result is the most informative and still not a rule.
Nineteen of twenty residual cases give retrieval no lexical purchase on the
definition that must change — but so do fifty of the seventy-nine that work. It
is **necessary but not sufficient**: it marks the population at risk while
something else (a path clue, a resolvable traceback frame, a file-level lexical
hit) rescues the majority. A rule built on it would fire on 50 healthy cases to
reach 19 sick ones.

What it does establish is where the remaining headroom actually lives: the
behavioural link from a bug *report* to its implementing definition. That is the
M143-B subject→owner ceiling and the M153 result/effect ceiling meeting on one
corpus — and §68 is explicit that sympy-weighted evidence does not license
building it.

## Why MULTIPLE_SMALL_POPULATIONS rather than NO_COMMON_BOTTLENECK

There *is* a dominant mechanism: 8 of 20 residual cases across 4 repositories
share both a first divergence and a structural explanation. Calling that "no
common bottleneck" would understate a real finding. But the residual splits
across five distinct causal classes, and the largest one has **no constructible
intervention** — it is a measured ceiling, not an unfixed defect.

Per §49 the populations are ranked above and **none is selected**. M159 closes as
an audit milestone, nominating separate future milestones rather than combining
unrelated causes into one mega-fix.

## What M159 deliberately did not do

- No candidate bound was changed. §42.
- No score weight was tuned from 20 cases. §43.
- No `search_symbols` was implemented. §69 — the residual population does not
  independently justify it, and this milestone did not select that population.
- No richer result/effect semantics were built. §68 — sympy alone is not enough,
  exactly as sphinx alone was not.
- The two invalid benchmark instances were **recorded, not silently repaired**.
  The M156 corpus is the immutable baseline every M156–M159 comparison rests on;
  re-materialising two workspaces mid-audit would break comparability (§96).
