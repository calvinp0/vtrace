# M142 §30/§33/§42 — NMD concept-evidence audit

**Finding: NMD was never a representation failure. The lane already elects
`arc/checks/nmd.py`; a bounded-allocation defect starves it of every candidate
slot.**

This corrects `stage5_m142_body_evidence_audit.md`, which classified NMD as a
vocabulary gap that body indexing would "partially reach". The first half is
right and the second half is wrong.

Measured against `arc-m141.sqlite` (ARC @`2f3fd462`, 9,009 symbols, 325 files),
read-only.

## The query and its objectives

> *"How does ARC verify that a saddle point actually connects the intended
> reactants and products by looking at how the atoms move in the imaginary
> vibration?"*

Twelve objectives after project-name exclusion: `verify, saddle, point, connect,
intended, reactant, product, look, atom, move, imaginary, vibration`.

## Where each objective's evidence lives

| evidence class | objectives | count |
|---|---|---|
| **indexed today** (path / symbol name / signature / docstring) | `point, reactant, product, atom, move, imaginary` | **6** |
| recoverable from body identifiers | — | **0** |
| recoverable only from developer comments | — | **0** |
| **absent from the file entirely** | `verify, saddle, connect, intended, look, vibration` | **6** |

Two things follow immediately.

**A body index changes nothing here.** Not one objective is recoverable from
body identifiers or comments. The earlier audit claimed body indexing would
surface `reactant` (18 occurrences) and `product` (12) — but both are *already
indexed for this file*, because they occur in symbol names and docstrings such
as `is_nmd_correct_for_any_mapping` and `check_bond_directionality`. The
occurrence counts were real; the conclusion drawn from them was not.

**The other six are a vocabulary gap that no representation closes.** `saddle`,
`connect`, `intended` and `vibration` appear nowhere in the file — not in a
name, not in a body, not in a comment. The request says *saddle point* and
*imaginary vibration*; the code says *ts* and *normal mode*. Indexing more of a
file cannot add a word the file does not contain.

## But six objectives are enough

The lane elects the file anyway:

```
0.6950  arc/species/converter.py                        [saddle, intended, look, connect, product, reactant, point, atom]
0.6613  arc/job/adapters/ts/linear_utils/addition.py    [verify, move, connect, product, reactant, point, atom]
0.6220  arc/checks/nmd.py                               [imaginary, move, product, reactant, point, atom]   <-- elected
```

`arc/checks/nmd.py` is owner #3, comfortably above the 0.35 floor, and
`maxConceptOwnerFiles` is 3 — so it **is** a selected owner.

It contributes **zero** candidates.

## The allocation defect

The lane's bounds are `maxConceptOwnerFiles: 3`, `maxDefinitionsPerConceptOwner:
3`, `maxConceptOwnerCandidates: 6`. Admission walks the owners **in order**,
taking up to three definitions from each until the overall cap of six is reached:

```
owner 1 (converter.py)  -> 3 candidates   [running total 3]
owner 2 (addition.py)   -> 3 candidates   [running total 6 — cap reached]
owner 3 (nmd.py)        -> 0 candidates
```

Because 3 × 3 = 9 exceeds the cap of 6, **the third owner slot is dead by
construction** whenever the first two owners each have three admissible
definitions. It is not that nmd.py scored too low; it is that nothing was left
by the time its turn came. This is generic — it has nothing to do with ARC or
with this query.

### Measured under round-robin allocation

Same bounds, same total of six, same owner scores — only the order of admission
changes (one definition per owner per pass, strongest first, instead of
draining each owner in turn):

```
0.4595  arc/job/adapters/ts/linear_utils/addition.py::migrate_verified_atoms
0.4461  arc/species/converter.py::cluster_confs_by_rmsd
0.3925  arc/checks/nmd.py::find_equivalent_atoms            <-- recovered
0.4515  arc/job/adapters/ts/linear_utils/addition.py::stretch_core_from_large
0.3816  arc/species/converter.py::kabsch
0.3604  arc/checks/nmd.py::get_displaced_xyzs                <-- recovered
```

`arc/checks/nmd.py` now contributes two definitions, one of which
(`get_displaced_xyzs`) is squarely answer-bearing for "how the atoms move".

No safety bound was weakened: still three owner files, still at most three
definitions per owner, still six candidates total. §26 is respected — the caps
are unchanged; only the starvation is removed.

## What is still not reached

`analyze_ts_normal_mode_displacement` — arguably the single best answer — carries
only `point` and `atom` of the twelve objectives, so it ranks low *within* its
own file. Reaching it specifically would require the query's vocabulary to meet
the code's, which is the vocabulary gap above. Round-robin surfaces the right
**file** and two genuinely relevant definitions from it; it does not surface the
best one.

That residual is recorded rather than papered over, and it is a bounded,
honest statement of the remaining ceiling.

## Verdict

| question | answer |
|---|---|
| does NMD need a new index representation? | **no** |
| does NMD need body/comment indexing? | **no — measured zero recovery** |
| is there a real remaining semantic gap? | yes — six of twelve objectives are absent from the file, unreachable by any lexical means |
| is the lane's failure explained? | yes — bounded-allocation starvation of the third owner |
