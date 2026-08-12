# M140-C plan — path-coherent orchestration delivery

Continuation of M140 from the completed M140-B checkpoint (`7093e2d` functional,
`2902b65` evidence). Workstreams A and B are not reopened: the graph
architecture, import semantics, the `computeInDegreeCentrality` correction, the
A6 benchmark conclusion, and the bounded rescue lane's own limits are frozen
inputs.

## The gap this milestone closes

M140-B left one acceptance criterion unmet, and it is a narrow one:

```
ARCSpecies.from_dict is DISCOVERED (rescued, scored 0.9749)
ARCSpecies.from_dict is not DELIVERED (rank 93 of 132)
```

M140-B deliberately did not close it by raising the rescue weight. A rescued
candidate has essentially no base score — being missed by lexical search is the
premise of a rescue — so the bounded rescue component is its whole score, and
reaching the ~1.78 delivery threshold from 0.975 would require about another
point from one component. That is the same as declaring that two-hop callers
outrank exact direct answers, which is the defect M140-B's own contract warned
against.

So the remaining problem is not ranking strength. It is selection completeness.

## Sequence executed

1. **Reconfirm (§6–§7).** Rebuild an isolated ARC index and re-measure the chain
   and its fan-ins rather than inheriting M140-B's numbers.
2. **Reproduce (§8).** Run the exact behavioural query at `7093e2d` and freeze the
   B-state capsule as an artifact, because the capsule entry point has no
   path-completion toggle and re-running it later would record the after-state.
3. **Implement (§11–§25, §37–§43).** A selection role, not a ranking change:
   surface the rescue lane's findings with their truthful ranks, and add a pure,
   deterministic selector that may convert ONE support slot.
4. **Fixtures and negative controls (§26–§36, §45, §55).**
5. **ARC acceptance and preservation (§46–§51, §56–§58, §67–§79).**
6. **Freeze, then benchmark (§59–§60, §86, §91).**
7. **Report (§85–§94).**

## What was measured before designing

The fresh index reproduced M140-B exactly — 324 files, 8,986 symbols, 21,618
edges, 2,281 imports, ARC `arcbench@d5ef3dc`:

| symbol | incoming `calls` | non-structural |
|---|---:|---:|
| `perceive_molecule_from_xyz` | 62 | 62 |
| `ARCSpecies.mol_from_xyz` | 3 | 3 |
| `ARCSpecies.from_dict` | 1 | 1 |

Both chain links are present as exact `calls` edges. The B-state capsule
delivered six items, two of the three chain symbols among them.

The rescue lane produces **eight** candidates for this query, not one. That is
the fact the design turns on: "complete the path" cannot mean "admit what the
lane found", because seven of the eight are ordinary callers of something already
on screen.

## The design in one sentence

One support slot may go to the single already-discovered candidate that completes
an exact short call path whose **every other node is already selected**, ranked by
how much of the delivered chain it completes and then by how much of the original
request it independently answers.

Everything else follows from keeping that honest: the ordinary rank and score are
reported unchanged beside the role; the item is support, never a pivot or the
lead; it converts an existing slot rather than growing the capsule; and it is
capped at one per request.

## The correction measurement forced

The first implementation required only that the path's downstream nodes be
selected. On the ARC serialization query that is correct, but on a broad process
question ("how does ARC handle linear segments and dummy atoms in Z-matrices?")
it spent the slot on an ordinary rank-11 caller whose only qualification was
calling something already delivered — precisely §31's failure. Every caller of a
selected function passes that test.

The rule was therefore narrowed to two structural shapes, both of which say
something the selected set does not already say:

- **chain completion** — reaches the seed *through* a delivered intermediate, so
  it is the head of a chain rather than a sibling of one (§34/§35);
- **branch control** — the request asked which of two alternatives runs, and the
  candidate calls at least two of the *delivered* alternatives (§24/§27).

This is a stricter eligibility gate, which §69 admits; it is not a repo-specific
exception, a symbol bonus, or a gold-tuned threshold.

## Non-goals

Explicitly not attempted: raising the rescue score, retuning `rerankGraph`,
touching the structural-module architecture or the centrality correction, adding
edge kinds or traversal depth, adding a second upstream retrieval implementation,
M141 readiness work, or workspace/multi-repository work.
