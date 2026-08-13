# M142 §32/§43 — the C2 decision

**Decision: Path A. No new index representation, no schema change.**

§32 reframed C2 as: *determine the minimum deterministic evidence required to
identify concept-owning modules when symbol names and signatures are
insufficient.* The measurement says the evidence is, for three of the four real
cases, **already in the index** — and the failures are in how the lane allocates
and selects, not in what it can see.

Supporting measurement: `stage5_m142_concept_evidence_matrix.json`,
`stage5_m142_nmd_evidence_audit.md`, `stage5_m142_gaussian_evidence_audit.md`,
`stage5_m142_acronym_owner_controls.json`.

## What a body index would actually recover

Measured per objective, per case, against the real index and the real source:

| case | objectives | indexed today | body identifiers | comments only | absent from file |
|---|---|---|---|---|---|
| nmd | 12 | 6 | **0** | **0** | 6 |
| gaussian | 5 | 2 | **0** | 2 | 1 |
| reactant_index | 9 | 8 | **0** | **0** | 1 |
| ts_order | 11 | 7 | **0** | **0** | 4 |

**An identifier/literal body index recovers zero objectives on all four cases.**
The representation the earlier plan proposed — and that §28 instructed me not to
implement reflexively — is now measured to be worth nothing here, rather than
merely doubted.

The only recoverable evidence anywhere is `route` and `emit` in the Gaussian
case, and only from **developer comments**: the evidence class with the worst
precision profile, no precedent in this index, and its own extraction,
staleness, sizing and M141 capability consequences. One case out of four does
not meet §31's bar of "a general capability, not one hard case".

## Why each case actually fails

Once the evidence question is answered, the four cases separate cleanly, and
only one of them was ever about representation.

**NMD — bounded-allocation starvation.** The lane already elects
`arc/checks/nmd.py` as owner #3 (score 0.6220, floor 0.35). It contributes zero
candidates because `maxConceptOwnerFiles: 3` × `maxDefinitionsPerConceptOwner: 3`
= 9 exceeds `maxConceptOwnerCandidates: 6`, and admission drains owners in order.
**The third owner slot is dead by construction.** Round-robin admission recovers
two nmd.py definitions with every safety bound unchanged.

**Gaussian — two independent gaps.** Identifying the file is solvable from
evidence already indexed: the basename *is* the queried entity. Choosing the
right definition inside it is not: `write_input_file` carries zero of the five
objectives, because 268 lines and 16 KB reduce to eleven indexed tokens. Entity
ownership solves the first; nothing short of comment indexing solves the second.

**reactant_index and ts_order — not evidence-limited at all.** 8 of 9 and 7 of
11 objectives are already indexed. `get_bonds` carries **five** objectives;
`order_xyz_by_atom_map` carries four. Both are generated and ranked. They fail
the four-slot support budget. That is C1 selection, exactly as
`stage5_m142_concept_support_arc_before_after.json` recorded for them.

### Correction to the earlier audit

`stage5_m142_body_evidence_audit.md` classified NMD as a vocabulary gap that
body indexing would "still help… `reactant` (18) and `product` (12) are in body
identifiers and currently invisible". They are not invisible: both are already
indexed for that file, via symbol names and docstrings. The occurrence counts
were right; the inference was wrong. That audit's Gaussian half stands.

It also classified `get_reactants_and_products` as "C2 — representation. No lane
reaches it at all; the request's wording makes no contact with its indexed
evidence." Also wrong: it carries `reactant` and `list`. The contact exists.

## Two rejected mechanisms

**Acronym → path (§34/§35): not implemented.** Measured 0 true positives and 2
false positives across the four real queries. The decisive point is that the NMD
query never contains the phrase "normal mode displacement" — that is the
milestone spec's description of the case, not the user's words. An acronym can
only be built from words the query uses, so the mechanism cannot fire for the
case it was proposed for, while it does fire for "connects intended" → `ci.yml`
and "transition state" → `ts.py` (the wrong owner). It works only when the user
already supplies the code's vocabulary — i.e. when they need no help. This is
the accidental exact matcher §35 warns against.

**Naive entity ownership (§36): not implemented in that form.** Nominating any
file whose basename equals a query objective produces **796 nominations across
24 queries, mean 33.2 per query** — one django query nominates 407 files,
because `model` matches `models.py` in every app.

## What was implemented instead

**Round-robin owner allocation.** Shipped. The third owner slot was dead by
construction; admitting one definition per owner per pass recovers
`arc/checks/nmd.py` with every bound unchanged.

**Entity ownership, gated on distinctiveness — MEASURED AND REJECTED.** The signal is only meaningful
when naming a module after the entity was a *decision* rather than a convention.
Requiring the entity to resolve to at most two files makes that measurable and
repository-adaptive, the same way the lane's IDF already adapts:

| cap | nominations / 24 queries | mean per query |
|---|---|---|
| none | 796 | 33.17 |
| ≤ 3 files | 95 | 3.96 |
| **≤ 2 files** | **71** | **2.96** |
| ≤ 1 file | 29 | 1.21 |

At ≤ 2 the generic infrastructure words (`model`, `util`, `field`, `base`,
`app`, `http`) drop out entirely while the cases that matter survive:
`gaussian` → 2 files, both genuinely Gaussian; `reaction` → 1. §37's distinction
is preserved — "Gaussian" nominates the module named after the entity, and is
never treated as a request for a symbol named `Gaussian`. The project name is
already excluded upstream, so ARC can never become entity ARC.

**Why it was rejected.** Measured over the frozen 50 against the corrected
checkpoint on identical corpora, it moved **no quality metric at all** — top-1
38, top-3 44, gold file anywhere 48, gold symbol anywhere 30, missing gold 2 —
and cost **+29 tokens per case**. Its only gains were internal to the lane
(delivery ratio 7.9% → 10.8%, owner candidates in a gold file 11 → 15).

And it does not reach its own acceptance. `gaussian` resolves to *two* files, so
the tiebreak is owner score — and the higher scorer is
`arc/parser/adapters/gaussian.py`, the module that **reads** Gaussian output,
not the job adapter that **writes** the route line. Discriminating between two
modules that own the same entity needs exactly the evidence that is not indexed.

§15 is explicit that architecture follows measurement, so the mechanism is not
shipped. The precision measurement is retained because it is the evidence for
§36/§38, and because it establishes that the naive form (796 nominations across
24 requests) is unusable regardless.

## §43 fork

- **Path A — existing indexed deterministic evidence is sufficient.** Chosen for
  NMD (round-robin allocation recovers it), and confirmed for reactant_index and
  ts_order, which are not evidence-limited at all.
- **Path B — a new persistent evidence class is required.** Rejected: it would
  serve one of four cases, via comments only, and fails §31.
- **Path C — an architectural ceiling remains.** True for Gaussian, and recorded
  rather than hidden. Three independent gaps stand: `write_input_file`'s concept
  is unreachable from any indexed evidence; two modules share the `gaussian`
  entity name and nothing indexed distinguishes them; and six of NMD's twelve
  objectives appear nowhere in their file at all. None can be closed with a
  larger score bonus (§93), and none is faked.

C therefore closes without a schema change. Because §88's Gaussian acceptance is
**not met** and a real deterministic ceiling remains, the concept-evidence half
of C is **not** a PASS — see the final report.
