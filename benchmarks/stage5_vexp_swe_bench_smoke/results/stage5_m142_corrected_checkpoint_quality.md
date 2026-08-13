# M142 §8–§10 — the corrected checkpoint, measured against M141

**Gate satisfied. Provenance valid, three gold-visibility movements, zero
unexplained.**

This is the authoritative comparison the milestone was blocked on. It replaces
every earlier extrapolation from staged or exploratory numbers.

## Provenance

```
predecessor   m141-562cff6           commit 562cff6a…  tree 0f9acb37…
candidate     m142-corrected         commit 237eb42c…  tree 3434f38f…
provenanceValid                      true
```

Corpora were re-prepared at the candidate commit. Reusing the earlier corpora
would have failed closed, correctly, because provenance binds the implementation.

The run stamped `HEAD` (237eb42) rather than the functional commit 9f08e33.
`git diff 9f08e33..237eb42 -- src/` is empty — everything in between is
evidence-only — so the retrieval implementation measured is exactly 9f08e33.

## Frozen 50

| metric | M141 | corrected M142 | Δ |
|---|---|---|---|
| top-1 gold file | 39 | 38 | **−1** |
| top-3 gold file | 44 | 44 | — |
| gold file anywhere | 47 | **48** | **+1** |
| gold symbol anywhere | 31 | 30 | **−1** |
| missing gold | 3 | **2** | **−1** |
| mean pivots / support | 2.10 / 3.88 | 2.10 / 3.88 | — |
| mean estimated tokens | 1806.4 | 1848.6 | +42.1 (+2.3%) |

Per suite:

| | M141 | corrected |
|---|---|---|
| django top-1 | 0.90 | 0.85 |
| django top-3 recall | 1.00 | 1.00 |
| django symbol-as-pivot | 0.60 | **0.65** |
| django mean tokens | 1225 | 1342 |

Thirty-three of fifty rows differ in *some* field — token counts, diagnostics,
discarded counts. **Three** move a gold-visibility metric, and each one accounts
for exactly one aggregate delta. There is no residue.

## The three movements

### 1. `django-11740` — REGRESSION, known debt (top-1 −1)

Lead moves from `autodetector.py::_get_dependencies_for_foreign_key` to
`db/models/fields/related.py::ForeignKey`.

First causal stage A+B, persisting through the redesigned B. `ForeignKey` has
188 dependents and zero symbol identifying evidence; B correctly stops
manufacturing relevance from centrality and drops it from the capped pool, and
an adjacent title-symbol lane reads that absence as "never retrieved" and
re-injects it with a **synthesized** score of ≈2.5, above the gold lead's
organic score. The defect is the synthetic score, not the lane's presence.

Carried per §11/§76. Both attempted fixes measured worse in aggregate.

This case alone contributes **1657 of the 2334-token django increase (71%)**.
Across the other nineteen django cases the movement is about +36 tokens each.

### 2. `sphinx-7462` — REGRESSION, newly root-caused (gold symbol −1)

The lead is unchanged and still gold. What is lost is the *other* gold file.

M141 generated `sphinx/pycode/ast.py::unparse` from the **symbol** source at
rank 4 (final 1.9) and delivered it as support. In the corrected checkpoint it
is **absent from a pool of 31** — not discarded, never generated.

The task's only mention of the name is inside a traceback frame:

```
Traceback: File "…\sphinx\domains\python.py", line 112, in unparse | IndexError: pop from empty list
```

Workstream A routed broad lexical local-name matching through the single typed
prose-vs-identifier decision. That grammar does not treat `in <name>` inside a
traceback frame as identifier context, so the token no longer seeds symbol
generation. Identifier signals themselves are byte-identical on both sides
(verified directly), so the producer at fault is the broad-lexical one, not the
identifier-signal one.

**This corrects the prior ledger**, which recorded the case as NEUTRAL and
stated that `pycode/ast.py` "was never retrieved on either side". M141 retrieved
*and delivered* it. Since this instance cannot resolve without an `ast.py` edit,
losing the only visibility of that file is a regression.

A minimal, principled fix exists — recognise a traceback frame's `in <name>` as
explicit identifier context, which *adds* typed structure rather than loosening
prose handling and so cannot reintroduce the grammatical-`which` failure. It is
**not implemented**: §12 freezes Workstream A and the immediate sequence does
not include reopening it. It is recorded as the highest-value follow-up.

### 3. `sphinx-7910` — IMPROVEMENT (gold file anywhere +1, missing gold −1)

`sphinx/ext/napoleon/__init__.py` enters the candidate pool where M141 never
reached it (`discarded_count` 26 → 32; miss category `wrong_subsystem` →
`present_but_discarded`). First causal stage A+B+C — concept-owner generation.

Bounded honesty: the file becomes **reachable**, not delivered. It improves
`goldFileAnywhere` and `missingGold`; the model still does not see it. The prior
ledger also named the wrong file here — `autodoc/__init__.py` is the lead, not
the gold.

## Reading the aggregate

The checkpoint trades one top-1 and one gold symbol for one previously
unreachable gold file, at +2.3% tokens. Both losses are regressions with named
mechanisms; one is long-standing debt and the other is newly mechanised here.

That is not a quality win on the frozen 50. It is a defensible position for a
checkpoint whose purpose was to stop centrality manufacturing relevance and stop
prose being read as identifier intent — both of which are correctness properties
the benchmark does not directly score — while the concept-owner capability the
milestone exists for shows its first measured gain (`sphinx-7910`).

§10 is satisfied and the sequence may proceed to objective hygiene.
