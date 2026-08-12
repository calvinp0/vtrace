# M140-A — rerankGraph calibration attribution

Answers M140 §19–§26: now that the import graph is truthful, is `rerankGraph`
still calibrated, and what actually moved?

Measured on the frozen 50 (Django expanded 20 + cross_repo_30 30), each side
running its own declared implementation against its own independently prepared
index. Provenance valid and authoritative on both suites.

---

## 1. The weights, confirmed rather than assumed

`src/retrieval/rerankGraph.ts:22-33`:

```
inDegreePerEdge 2 / inDegreeMax 6
outDegreePerEdge 1 / outDegreeMax 4
containsNeighbor 8 / containsNeighborMax 16
importsNeighbor 6 / importsNeighborMax 12
connectedMatchedCandidate 3 / connectedMatchedCandidateMax 6
```

§19's "weight 6, cap 12" is correct for `importsNeighbor`.

---

## 2. `imports_neighborhood` is structurally unreachable

`buildCandidateGraphStats` gates every *neighbourhood* signal on BOTH endpoints
being lexical candidates (`rerankGraph.ts:89-94`):

```ts
if (!srcIsCandidate || !dstIsCandidate) continue;
```

M140-A made `<module>` the sole source of every import edge — verified, not
assumed, on a repo outside the original evidence:

| import-edge source kinds, sympy-12419 | |
|---|---|
| M139 | `class` 551, `module_alias` 162, `function` 162, `module_variable` 113 |
| M140-A | `module` 9,603 (100%) |

A `module` can never be a lexical candidate, so `srcIsCandidate` is always false
for an import edge and `ImportsNeighborhood` can never fire. **`importsNeighbor: 6`
and `importsNeighborMax: 12` are now dead constants.**

Measured across the frozen 50:

| signal | M139 | M140-A1 | M140-A6 |
|---|---|---|---|
| in_degree | 908 cands / score 3424 / 10,387 edges | 911 / 3506 / 11,579 | — |
| out_degree | 738 / 2090 / 4,946 | 738 / 2089 / 4,885 | — |
| contains_neighborhood | 522 / 5160 / 1,137 | 517 / 5120 / 1,125 | — |
| connected_matched | 757 / 3612 / 2,223 | 751 / 3588 / 2,183 | — |
| **imports_neighborhood** | **12 cands / score 78 / 5 cases** | **1 cand / score 6 / 1 case** | **absent** |

The single M140-A1 survivor (astropy-14539) was not a counter-example to the
mechanism — it was the module-leak defect below: the module had reached candidate
status, so both endpoints were candidates again. Once that leak was closed the
signal is gone entirely.

**This is the opposite of the §21 pathology that was anticipated.** The weight did
not start dominating; it stopped firing.

Per §20 the weights were NOT retuned. Per the user's direction, if module-import
fan-in later proves useful for ranking it belongs in an explicit separate feature
rather than being smuggled back through false ownership or a revived neighbourhood
term.

---

## 3. Target-side fan-in is absorbed by the in-degree cap

Import fan-in still reaches ranking through `in_degree`, which counts edges whose
destination is a candidate regardless of source. Across the frozen 50 that grew
10,387 → 11,579 edges (+11.5%) but only 3424 → 3506 in score (+2.4%), because
`inDegreePerEdge: 2` saturates at `inDegreeMax: 6` after three edges.

So §21's "target-side import degree acts as popularity bias" does **not** hold
inside `rerankGraph` — the cap already absorbs it.

---

## 4. Where the popularity bias was real: the dependents count

It was not `rerankGraph`. `computeInDegreeCentrality` (`graphExpansion.ts:257`)
is edge-type blind and edge-source blind, and `assignCandidateRoles` renders it to
the model as `"N indexed symbol(s) depend on this"` while using it to order pivots.

Measured on the frozen 50 at M140-A1: of 23 pivot symbols present on both sides,
**20 gained dependents and 0 lost any** (max +29). Monotone inflation, distributed
by public-API popularity rather than task relevance.

`pytest-7432` is the clean case:

| symbol | M139 | M140-A1 |
|---|---|---|
| `src/_pytest/outcomes.py::skip` (public API) | 24 | **30** |
| `src/_pytest/skipping.py::evaluate_skip_marks` (gold, internal) | 10 | 11 |

The widely-imported public helper took the lead from the internal function the
task actually needed. This meets §21 ("low-semantic-strength import relation
receives call-like influence") and collides with §67 (no mixed "dependent"
semantics), so per §26 Case C it was corrected before Workstream B:
structural sources no longer contribute to that count. Every import edge stays in
the graph and remains available to every other consumer; no edge-kind weight was
introduced.

After the correction the same measurement reads **0 increased / 5 decreased / 18
unchanged** — the 5 decreases being M139's bogus symbol-owned import edges
correctly leaving a symbol-dependent count.

---

## 5. Changed-case attribution — 24 cases, 0 unexplained

Against the final WS-A state (M140-A6):

| | count |
|---|---|
| changed cases | 24 / 50 |
| IMPROVEMENT | 0 |
| NEUTRAL | 23 |
| REGRESSION | 1 |
| lead changes | 1 |
| unexplained | **0** |

Subreason distribution: `target_fanin_added` 15, `candidate_score_changed` 8,
`secondary_effect` 9, `source_signal_removed` 3.

Every case carries cause `import_attribution_fix`. Causality was read from
measured signal deltas and per-case pivot diagnostics, never from the tag alone —
§18. Two hypotheses were discarded that way: a test→implementation bridge theory
for pytest-7432 (the new import edges pointed at the GOLD file, contradicting it)
and a graph-search ranking theory (its top-10 was byte-identical across sides).

### The one regression is truthful — §22

`sympy-12419`, gold `sympy/matrices/expressions/matexpr.py`. `ZeroMatrix` fell
from pivot to support (gold rank 2 → 4) after losing exactly one dependent, 25 → 24.

Incoming edges to `matexpr.py::ZeroMatrix`:

| | |
|---|---|
| M139 | 25 total: 20 `calls`/function, 2 `calls`/method, 2 `references`/method, **1 `imports` owned by a CLASS** (`matpow.py::MatPow`) |
| M140-A6 | 24 real symbol dependents + 13 truthful `<module>` importers (not counted) |

`matpow.py` contained exactly one top-level symbol, so under M139's rule `MatPow`
falsely owned that file's import of `ZeroMatrix` and was counted as a dependent of
it. The lost dependent IS the invalid edge. The historical top-3 placement
benefited from invalid graph attribution; it is reported, not restored.

---

## 6. Decision gate — §26 Case B

Aggregate movement is small, every changed case is attributable, the one
regression is caused by removal of invalid historical signal, and no unresolved
ranking pathology remains: the one systematic mechanism found (dependents-count
inflation) was corrected on evidence, not tuned to gold.

Keep the graph. Document the regression. Proceed to Workstream B.
