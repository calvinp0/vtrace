# M142 C2 — what the index actually carries for a behavioural concept owner

§30–§31. Read from the index, not from assumptions about the source. ARC at
`2f3fd462600d23e671afb6e3ea4623c6b51674bf`, 9,009 symbols,
`/home/calvin/bench/vtrace-m142/arc-m141.sqlite`.

## Case 1 — `arc/job/adapters/gaussian.py::GaussianAdapter.write_input_file`

Query: *"How does ARC decide which Gaussian route keywords to emit?"*

The method spans **lines 247–515** — 268 lines, 16,142 bytes of body. This is its
**entire** indexed representation:

```text
local_name     file input write
fq_name        adapter adapters arc file gaussian gaussianadapter input job py write
signature      def file input none self write
docstring      execute file input job on server the to write
file_path      adapters arc gaussian job py
```

plus one `symbol_body_literals_fts` row:

```text
literals   acc2e l506 gaussian03 opt=({', '.join(key for key in keywords)})
           could not determine scan parameters for scan job {self.job_name}
```

Against the query's concepts:

| concept | in the indexed representation? |
| --- | --- |
| gaussian | **yes** — via path and fq_name |
| route | no |
| keyword | no (only inside one literal fragment, `opt=({...keywords})`) |
| emit | no |
| decide | no |

**16 KB of behaviour reduces to eleven distinct tokens, none of which is the
concept being asked about.** The ceiling is real.

### But the fix is not simply "index the body"

§30 warns not to assume the implementation uses the query's words. It does not.
`route` occurs **exactly twice in the whole file** — lines 423 and 469 — and
**both are comments** inside this method:

```text
423   # (no integral= in the route), producing a byte-identical resubmit. Emit the integral=()
469   # troubleshot opt=() clause never carries conflicting Hessian options - the base route
```

`emit` likewise appears only as *"Emit the integral=()"* in that same comment.
Neither word is a symbol name, a signature, a docstring, or a string literal
anywhere in the file.

The method's own vocabulary is different: `trsh` (49), `scf` (14), `integral`
(10), `keywords` (7), `integral_algorithm` (7), `opt=` (6), `ultrafine` (4),
`dispersion` (4), `freq` (3), and the module-level `input_template` that actually
assembles the Gaussian route line.

**Consequence for §32.** This single case discriminates between the candidate
representations, before any of them is built:

| representation | recovers `route`? |
| --- | --- |
| A — bounded per-definition lexical summary from identifiers / called names / attributes / string literals | **no** — the term is in neither |
| B — bounded body-token / chunk FTS **including comments** | **yes** |
| C — bounded per-file aggregate body evidence, identifiers only | **no** |
| D — fuller body FTS including comments | **yes** |

So the minimal-sufficient choice §33 prefers is *not* the cheapest one. Any
representation that indexes only identifiers and literals — the obvious, safe,
precision-friendly choice — **fails this case**. Recovering it requires indexing
prose written by developers *about* the code.

That is a substantive design consequence and it needs its own precision controls,
because comments are exactly where speculative, obsolete and TODO text lives.

## Case 2 — `arc/checks/nmd.py`

Query: *"How does ARC verify that a saddle point actually connects the intended
reactants and products by looking at how the atoms move in the imaginary
vibration?"*

This file is the opposite shape: 22 symbols with **richly behavioural names**,
including `analyze_ts_normal_mode_displacement`, `check_bond_directionality`,
`is_nmd_correct_for_any_mapping`, `get_displaced_xyzs`. The concepts *are* in the
names. Occurrences of each query concept in the file:

| concept | in a name/signature | in a comment | anywhere |
| --- | --- | --- | --- |
| saddle | 0 | 0 | **0** |
| connect | 0 | 0 | **0** |
| intended | 0 | 0 | **0** |
| vibration | 0 | 0 | **0** |
| imaginary | 0 | 0 | 1 |
| reactant | 0 | 1 | 18 |
| product | 0 | 0 | 12 |
| atom | 4 | 2 | 100 |
| move | 0 | 3 | 5 |
| normal / mode / displacement | 1 / 1 / 1 | 0 / 0 / 1 | 24 / 26 / 16 |

**Four of the query's central concepts appear nowhere in the file at all.** The
gap here is not representation, it is **vocabulary**: the request says *saddle
point* and *imaginary vibration*, the code says *ts* and *normal mode*. No amount
of body indexing produces the word `saddle`.

Body indexing would still help this case — `reactant` (18) and `product` (12) are
in body identifiers and currently invisible — but it would close the gap for a
*different reason* than the query's own wording, and it cannot close it fully.

## What this establishes

1. **The representation ceiling is real and measured.** 16 KB of the behaviour a
   request asks about is represented by eleven tokens, none of them the concept.
2. **It is not one ceiling but two.** Gaussian is a *representation* gap — the
   term exists in the file and is not indexed. NMD is a *vocabulary* gap — the
   term does not exist in the file at all.
3. **Body indexing closes the first and only partially reaches the second**, and
   closing the first requires indexing **comments**, which is the option with the
   worst precision profile and no existing precedent in this index.
4. Neither gap can be closed by a larger ranking bonus (§93), which is the
   invariant that sent C2 here in the first place.

This bears directly on §92. Indexing comments is not a bounded addition to an
existing lane: it is a new evidence class, with its own extraction rules,
staleness behaviour, precision controls, size accounting, and schema/capability
consequences under M141's readiness contract. That is a milestone, not a
workstream.

## Status

Audit complete (§30–§31). Representation **not** yet changed; option comparison,
contract, and scale measurements (§32–§43) still outstanding.
