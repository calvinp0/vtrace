# M139 — `ARCSpecies.copy` consumer ground truth

External static ground truth for the impact acceptance, established with repository
search and then **validated receiver by receiver**. `rg` is used here as an audit
aid for this report only; the product implementation never shells out to it.

Corpus: `/home/calvin/code/ARC`, branch `arcbench`, HEAD `d5ef3dc5777e6c11c8ce018dada3ce7f91ef666e`.

## Why a raw `.copy()` sweep is not the answer

`rg '\.copy\(' arc/` returns **hundreds** of hits, the overwhelming majority of
which are `dict`/`list`/`numpy` copies. ARC additionally defines `copy` on **nine**
classes (`ARCSpecies`, `ARCReaction`, `Level`, `Atom`, `Bond`, `Molecule`,
`GroupAtom`, `GroupBond`, `Group`), and the index holds **21** symbols named
`copy`. Attributing the name to one class would be unsound, which is why M139
reports unresolved sites as *potential* rather than promoting them to edges.

## Verified production consumers

Line numbers are current for the HEAD above. The prompt's figures
(`reaction.py:800/803`, `scheduler.py:4091`, `checks/ts.py:202`) predate this
checkout and one of them was misattributed.

| File:line | Receiver | Receiver provenance | Really `ARCSpecies.copy`? | M139 classification |
| --- | --- | --- | --- | --- |
| `arc/mapping/engine.py:463` | `spc_1`, `spc_2` | parameters annotated `spc_1: ARCSpecies` | yes | **high** (`annotated_parameter`) — delivered |
| `arc/reaction/reaction.py:849` | `r_spc` | `for r_spc in self.r_species`, docstring declares `list[ARCSpecies]` | yes | **medium** (`container_element_in_typed_scope`) — delivered |
| `arc/reaction/reaction.py:852` | `p_spc` | same, product side | yes | medium — discovered |
| `arc/scheduler.py:4547` | `spc` | `spc = self.species_dict.get(label)` | yes | **unresolved** (`name_match_only`) — discovered |
| `arc/mapping/driver.py:202` | `reactant` | `rxn.r_species[0]`, `rxn: ARCReaction` | yes | **not discovered** (see limitation) |
| `arc/mapping/driver.py:225` | `reactant`, `product` | same | yes | not discovered |
| `arc/checks/ts.py:206` | `reaction` | parameter is an `ARCReaction` | **NO — `ARCReaction.copy` (`reaction.py:404`)** | correctly excluded |

Test-side consumers verified and surfaced: `arc/species/species_test.py:1348,1355,1377,3380`,
`arc/mapping/engine_test.py:1573,1585,1597,1879,1898`,
`arc/job/adapters/ts/heuristics_test.py:2295`.

## The `checks/ts.py` misattribution

`rxn_copy = reaction.copy()` calls `ARCReaction.copy`, not `ARCSpecies.copy`.
M139 must **not** surface it for this target, and does not. Any acceptance that
demanded all four originally-listed sites appear would have been demanding a
false positive.

## The `mapping/driver.py` limitation (accepted, scoped)

`driver.py` never imports `ARCSpecies` — not at module level, and not even under
its `if TYPE_CHECKING:` block, which imports only `Molecule` and `ARCReaction`.
It obtains species through `rxn.r_species[0]`. There is therefore **no static
relation of any kind** from that file to `ARCSpecies`, so the index-narrowed
candidate scan cannot reach it. Resolving it would require cross-module attribute
type inference (`ARCReaction.r_species: list[ARCSpecies]`), which M139 explicitly
excludes.

This is reported truthfully rather than hidden: caller coverage for this target is
`incomplete`, so the response never claims the consumer list is exhaustive.
