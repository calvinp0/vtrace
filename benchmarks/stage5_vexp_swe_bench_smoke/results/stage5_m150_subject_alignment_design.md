# M150 subject alignment — design and evidence

## The question this answers

The `ab8e4f0` checkpoint established that operation compatibility is real
relevance. It also showed that operation compatibility **alone** is not enough:

> A dozen Gaussian result parsers each contain a genuine, result-bearing
> first-item selection. On "How does ARC decide which Gaussian route keywords to
> emit?" every one of them received full selection evidence, the component went
> near-uniform across the pool, and tiny lexical differences reordered the lead.

So the remaining discriminator is:

> When does a selection-shaped statement count as evidence for the particular
> thing the query asks about selecting?

## What was rejected, and why

Two discriminators were implemented and measured during the checkpoint session
and are recorded here so they are not retried blindly:

- **Candidate-level subject matching** (does the candidate's name/path/class
  mention the subject?). Broke the cache and ordering contrast controls without
  repairing the Gaussian case. It is also the wrong shape: path and domain are
  precisely the signals that made the wrong candidates look plausible, so letting
  either satisfy alignment restates the defect (§8).
- **Raising the relevance floor.** Arbitrary, and the floor is a different
  question — "is the request about this code?" rather than "is this statement
  about the subject?".

## The rule

Alignment is decided **as locally as possible**, from the mechanism's own
operand and one hop of provenance. Nothing about the candidate's file, class,
path or domain score participates.

```
operand names the subject            -> direct_operand
else producer of operand names it    -> local_producer
else request names no subject at all -> undecidable
else                                 -> none
```

Only `direct_operand`, `local_producer` and `undecidable` may reach the direct
tier. `none` earns zero.

### Why one hop of provenance is required

Operand names alone would fail the very case M150 exists for. ARC decides a
reaction family here:

```python
product_dicts = get_reaction_family_products(rxn=self, ...)
...
family, family_own_reverse = product_dicts[0]['family'], product_dicts[0]['own_reverse']
```

`product_dicts` encodes neither `reaction` nor `family`. The call that produced
it encodes both. Measured:

| candidate | operand | provenance | alignment | contribution |
| --- | --- | --- | --- | --- |
| `determine_family` | `product_dicts` | `get_reaction_family_products` | **local_producer** | **0.55** |
| `GaussianParser.parse_cartesian_hessian_lower_triangle` | `tokens` | `line.split` | **none** | **0** |
| `GaussianParser.load_scan_pivot_atoms` | `output` | `_load_scan_specs` | **none** | **0** |
| `GaussianAdapter.write_input_file` | `species` | — | **none** | **0** |

That table is the whole argument. Same operation, same fact kind, same
result-bearing property; the only thing that differs is what the statement is
about.

### Why one hop and not two

Measured on the corpus's deliberate two-hop fixture (`twohop.py`), where
`wrapper(config)` hides `matching_backends_for`. One hop does not resolve it and
the case does not pass. That is recorded rather than fixed: extending to two hops
is a data-flow engine growing inside a ranking question (§12, §95), and the
corpus shows one hop already carries the real cases. Extend only when a corpus
case demands it.

### Why three kinds are exempt

`cache_lookup`, `attribute_return` and `priority_lookup` skip both the
result-bearing proof and the alignment proof, for one reason: their statement
form **is** the behaviour, so they cannot occur incidentally — and for the same
reason their operand is the STORE rather than the subject. `if key in CACHE`
names the cache, not "the result", and testing it against "how is the result
cached?" would refuse the only fact that answers the question.

### Collection shape via a plural producer

`xs = matching_backends_for(config)` produced **no fact at all** before this
change: the operand-shape guard that keeps `first_character(name) -> name[0]`
honest could not see past an operand named `xs`. A plural token in the producing
callee now also establishes collection shape. `value = compute(x)` stays out (no
plural token), and the incidental-index control is untouched because its operand
is a parameter that no call produced.

## Measured effect

Three-way, same corpus, same fixture source, same queries, only the
implementation root differing:

| metric | M149 | checkpoint | final |
| --- | --- | --- | --- |
| correct mechanism lead | 7 | 8 | 8 |
| correct definition Top-1 | 7 | 8 | 8 |
| correct definition Top-3 | 10 | 12 | 12 |
| correct anywhere | 12 | 13 | 13 |
| missing mechanism | 3 | 2 | 2 |
| same-operation wrong-subject **lead** | 0 | 0 | 0 |
| same-operation wrong-subject **bonus** | 0 (no capability) | **2** | **0** |
| negative-control bonus | 0 | 0 | 0 |
| decision statement visible | 5/9 | 6/9 | 6/9 |
| ordering helper visible | 1/4 | 1/4 | **1/4** |
| module nodes delivered | 0 | 0 | 0 |

Attribution: `M149 → checkpoint` is operation-compatible mechanism capability;
`checkpoint → final` is subject-alignment discrimination. The discriminator
removed every wrong-subject bonus without costing a single correct lead, Top-3
or coverage point.

On ARC the M142 Gaussian owner-file Top-1 returns to `true`, matching the M149
predecessor, and the family decision keeps its lead at rank 1.

## Weights

Unchanged: direct `0.55`, partial `0.20`, ceiling equal to direct, strongest
single fact rather than a sum. The corpus said the defect was discrimination,
not magnitude, and nothing in the final measurement contradicts that — so the
calibration stays frozen exactly as §34 requires.
