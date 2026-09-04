# M210 causal report — impact caller-enumeration capacity and relation allocation

M210 targets frozen A15 only. It ran no coding agent, spent no model money, and
changed no product source. Everything below is a measurement of the shipped
product at `5c1c2108a465d5b6202f6d750ef56e20123bf58b`.

## 1. Frozen A15 authority, recovered mechanically

The predicate, population, scored surface, thresholds and band function are
unchanged from M209 and were re-read from the committed sources, not from the
predecessor's prose. In words: on **C-LARGE**, for the **first 50 `calls` edges
by edge id that carry an ordinal-0 persisted call site and join distinct
symbols**, the scored item is the `directRelations` entry of the **default
`get_impact_graph` response for the callee at `depth: 3`** whose `source.symbol`
is the caller; it counts when `evidence.sourceText` is non-empty and contains
`evidence.referenceName`. **MATCH ≥ 90 %, EXCEED 100 %.**

## 2. Reproduction of M209

| corpus | M209 committed | M210 rerun | agreement |
| --- | --- | --- | --- |
| C-SMALL impact render | 83.33 % | 83.33 % | exact |
| C-MED impact render | 24 % | 24 % | exact |
| C-LARGE impact render (scored) | 8 % | 8 % | exact |
| C-LARGE flow render | 100 % | 100 % | exact |
| eligible call sites | 36 / 50 / 50 | 36 / 50 / 50 | exact |

The `a15` blocks of `stage5_m209_engine.json` and this run's
`stage5_m197a_engine.json` are byte-identical, including all five misrendered
examples. The full frozen matrix reproduces at **14 / 15**: A1 MATCHES, A2
EXCEEDS, A3 MATCHES, A4 EXCEEDS, A5 MATCHES, A6 EXCEEDS, A7 EXCEEDS, A8 EXCEEDS,
A9 MATCHES, A10 MATCHES, A11 EXCEEDS, A12 MATCHES, A13 EXCEEDS, A14 MATCHES,
**A15 BELOW**.

A2/A3 required rerunning `run_stage5_m197a_indexing.ts`: the committed
`stage5_m197a_indexing.json` is still M197A's own measurement on a contended
machine, and the report reads that path rather than a per-milestone snapshot.
Reading the stale file yields A2 BELOW / A3 BELOW and 12 / 15, which is a fact
about the machine the file was written on. The freshly measured file reproduces
M209's 14 / 15 exactly. Snapshot: `stage5_m210_indexing_pre.json`.

## 3. The enumeration architecture, recovered from code

```
edges(id, src, dst, edge_type)  +  edge_call_sites(edge_id, ordinal, span, precision)
        |
getImpactGraph  (src/impact/getImpactGraph.ts)
        listEdgesForSymbol(root)                    <- the DIRECT candidate set; NOT bounded by max_edges
        + buildStaticRelationEvidence per edge      <- sourceText, referenceName, callSites
        + importSyntaxRelations, documentationRelations
        deduplicateRelations(...).sort(compareStaticRelations)
        directRelations = allDirectRelations.slice(0, maxEdges)      <- bound 1
        traverseRelations(...) -> paths, transitive edges/nodes
        |
compactImpactProductResponse  (src/impact/impactResponseEnvelope.ts)   <- the scored surface
        canonical selection: compactRelation per relation, capped at maxEdges
        rebuildCanonicalNodeAndViewProjections -> nodes, dependentFiles, view
        the degradation ladder (below)
        |
default get_impact_graph MCP response
```

| stage | bound / order | semantics |
| --- | --- | --- |
| direct candidate query | `listEdgesForSymbol(root.id)`, unbounded | every persisted edge incident to the focal symbol |
| relation classification | `kind` (14 values), `strength` (exact→resolved→conservative→lexical→unresolved), `direction` (incoming/outgoing), `evidence.locationKind` | the product's own vocabulary; M210 adds no taxonomy |
| dedupe | `deduplicateRelations` by relation `id` | one relation per (caller, target, kind) |
| relation order | `compareStaticRelations`: incoming → strength → kind (alphabetical) → source path → source symbol → id | **`calls` is alphabetically first of all 14 kinds**, so within a strength band a caller precedes every other kind |
| default relation slice | `DEFAULT_MAX_EDGES = 64` | bound 1 — "maximum unique canonical impact edges delivered across all projections" |
| canonical selection | re-applies `maxEdges` over edges **and** synthetic relation ids | can deliver fewer than the core's 64 |
| per-relation source | `RENDERED_LINE_CAP = 240`, first call site, ≤ 5 sites listed | M209's repaired rendering, unchanged |
| model-visible budget | `DEFAULT_MAX_TOKENS = 1200` over `edges + nodes + view + directRelations + paths` | bound 2 — the **shared** budget |
| whole-response ceiling | `max_tokens + max(800, 15 %)`, clamped to 80 000 chars / 4 | bound 3 — the delivery gate |
| ladder | paths → affectedFiles/entrypoints/tests → diagnostics → coverage → accounting → transitive edges → potentialCallers text → **directRelations text (ALL at once)** → directRelations tail → outgoing → potentialCaller tiers → bounded_degradation → canonical edge tail | `nodes` and `view` have **no rung**; they are only ever rebuilt |
| serialization | `buildBudget` fixed-points the response's own length | `serializedCharacters` equals the measured length (F17) |

Two authorities, deliberately separate, and §19's distinction is real in the
code: **`max_edges` bounds how many relations may be delivered; `max_tokens`
bounds how richly they may be written.** They are measured apart below.

## 4. Instrument validity

Every counterfactual arm is a pure pre-transform of the core output handed to
the product's own unmodified `compactImpactProductResponse`, assembled exactly
as `src/mcp/tools.ts` assembles it. The identity arm is checked against the real
MCP response: **50 / 50 agreement on C-LARGE, 50 / 50 on C-MED, 36 / 36 on
C-SMALL.** The core's default slice is the head of the hard-bound universe in
**136 / 136** cases, so every ordinal below is comparable. All 136 scored
responses are semantically stable across 3 repeats.

## 5. What occupies the relation slice — the decisive measurement

For every frozen item, the slots **ahead of** the scored caller in the core's own
ordered relations, by lane:

| corpus | slots ahead | exact_caller | resolved_caller | referrer | subtype | importer | structural | outgoing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-SMALL | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| C-MED | 112 | 25 | 87 | 0 | 0 | 0 | 0 | 0 |
| C-LARGE | 831 | 192 | 639 | 0 | 0 | 0 | 0 | 0 |

**Every one of the 831 slots ahead of a C-LARGE scored caller is another caller
of the same symbol**, and every one of them carries a persisted call site and a
renderable source line (831 / 831). Not one slot is an importer, a referrer, a
subtype, a structural relation, an outgoing relation, a duplicate, or a relation
without evidence.

This is not an accident of the corpus. `compareStaticRelations` orders incoming
before outgoing, then by resolver strength, then by kind — and `calls` sorts
alphabetically first of all fourteen relation kinds. An exact caller can
therefore only ever be preceded by other exact callers. **F1 proves this on a
fixture whose relation stream deliberately contains six weaker relations: the
exact caller still lands at ordinal 0.**

## 6. Miss attribution

| class | C-SMALL | C-MED | C-LARGE |
| --- | --- | --- | --- |
| SCORED | 30 | 12 | 4 |
| CALLER_INSIDE_SLICE_BUT_EVIDENCE_NOT_AFFORDABLE | 6 | 38 | 38 |
| CALLER_OUTSIDE_GLOBAL_SLICE | 0 | 0 | 8 |
| CALLER_ORDERED_BELOW_WEAKER_RELATIONS | 0 | 0 | **0** |
| CALLER_DEDUPED_INCORRECTLY | 0 | 0 | 0 |
| CALLER_INSIDE_SLICE_RENDERING_FAILURE | 0 | 0 | **0** |
| CALLER_TRUTH_UNAVAILABLE | 0 | 0 | 0 |
| CALLER_STALE | 0 | 0 | 0 |
| OTHER | 0 | 0 | 0 |

**A15_CALLER_CAPACITY_ATTRIBUTION_COMPLETE.**

`CALLER_INSIDE_SLICE_RENDERING_FAILURE` is zero, as it must be after M209: no
delivered relation carries a line the frozen rule rejects.

The 38 C-LARGE affordability misses split into two forms:

| form | what happened | C-SMALL | C-MED | C-LARGE |
| --- | --- | --- | --- | --- |
| `relation_trimmed` | the relation never reached the response | 0 | 18 | **29** |
| `evidence_shed` | the relation was delivered, its source line was not | 6 | 20 | **9** |

`evidence_shed` is the ladder's `directRelations[].compactProjection` rung, which
maps `minimalRelation` over **every** delivered relation at once rather than over
the tail that cannot afford its line — so a head relation that could have carried
its line loses it to save a tail relation that is dropped moments later anyway.
On C-SMALL that single rung accounts for all six misses.

The default response delivers **1 direct relation in 44 of 50 C-LARGE cases and 2
in the other 6**, out of a core slice whose median is 12.5 relations and whose
maximum is 64.

## 7. Caller ordinal distribution

Rank of the scored caller in the complete truthful direct-relation universe:

| corpus | 0 | 1–2 | 3–6 | 7–15 | 16–63 | 64+ | median | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-SMALL | 35 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| C-MED | 29 | 12 | 4 | 3 | 2 | 0 | 0 | 36 |
| C-LARGE | 10 | 9 | 10 | 7 | 6 | 8 | 4 | **816** |

Sorted C-LARGE ranks: `0×10, 1×8, 2, 3×5, 4×3, 5, 6, 7, 9×2, 10×2, 11, 13, 21,
26, 27, 37, 45, 46, 219, 477, 530, 556, 598, 762, 788, 816`.

**To score 45 of 50 (90 %) the default response must reach universe rank 530 —
it must deliver 531 direct relations, each carrying its own rendered source
line.** To score 100 % it must deliver 817.

## 8. Counterfactual A — fixed capacity, caller-aware allocation

Total capacity held at the shipped `max_edges: 64` / `max_tokens: 1200`. Each
arm permutes the relations the product already delivers, or removes the legacy
compatibility edge list before the envelope sees it. No edge truth, strength,
reachability, `sourceText`, call-site evidence or relation count is altered.

| arm | C-SMALL | C-MED | C-LARGE | median relations | median chars |
| --- | --- | --- | --- | --- | --- |
| CONTROL (shipped order) | 83.33 % | 24 % | **8 %** | 1 | 7513 |
| P1 lane authority | 83.33 % | 24 % | **8 %** | 1 | 7513 |
| P2 grounded evidence first | 83.33 % | 24 % | **8 %** | 1 | 7512 |
| P3 lane, then grounded | 83.33 % | 24 % | **8 %** | 1 | 7514 |
| P4 lane round-robin (no lane starves) | 83.33 % | 24 % | **8 %** | 1 | 7494 |
| E1 no compatibility edge list | 83.33 % | 24 % | **8 %** | 1 | 7676 |
| E2 E1 + lane authority | 83.33 % | 24 % | **8 %** | 1 | 7675 |
| E3 E1 + lane, then grounded | 83.33 % | 24 % | **8 %** | 1 | 7676 |

**Every allocation policy scores identically to the shipped order, on every
corpus.** They cannot differ: reordering a stream that is 100 % callers changes
which caller occupies the single delivered slot, and the frozen metric names one
arbitrary caller per query. E1's failure is instructive on its own — the envelope
re-synthesises `edges` from the retained relations, so removing the list upstream
is undone downstream.

## 9. Existing-capacity sufficiency — the arithmetic

Two independent proofs, either sufficient on its own.

**Proof 1 — the enumeration bound.** Only 42 of 50 C-LARGE callers lie inside
the core's own 64-relation slice. The ceiling for anything that delivers at most
64 relations is therefore **84 %**, below the 90 % bar, before any budget is
measured.

**Proof 2 — the representation bound.** Packing the default response by hand, in
the product's own delivered order, at the product's own measured per-item sizes:

| costing of the model-visible budget | C-SMALL | C-MED | C-LARGE | median relations that fit |
| --- | --- | --- | --- | --- |
| A_STATUS_QUO — restatement is a fixed floor | 94.44 % | 18 % | 2 % | 0–1 |
| B_COHERENT_PROJECTIONS — each relation carries its own edge, nodes and view line | 100 % | 74 % | 36 % | 1–2 |
| **C_EVIDENCE_ONLY — the restatement costs NOTHING** | 100 % | 84 % | **46 %** | 1–4 |

C_EVIDENCE_ONLY is not a design; it is the upper bound on any conceivable
reallocation of this budget. **46 % < 90 %.** Even if `nodes`, `edges`, `view`
and `paths` were free and every model-visible character went to call-site
evidence, the 1 200-token default budget carries about four relations and 46 % of
the frozen population has its caller within the first four.

Only the last row is load-bearing, and it is deliberately loose. The first two
rows are **not** predictions of the shipped product and do not calibrate against
it: A_STATUS_QUO reads 94.44 % against a shipped 83.33 % on C-SMALL and 2 %
against a shipped 8 % on C-LARGE, because it charges the *unshed* restatement
floor as a constant while assuming any relation that fits keeps its source line —
the shipped ladder does neither. What makes C_EVIDENCE_ONLY a valid bound is that
it errs only in the generous direction: it charges **zero** for four of the five
model-visible fields, so no allocation policy, however aggressive, can beat it.
A bound that cannot be exceeded is what the gate needs; a calibrated model of the
current ladder is not.

> **A15_EXISTING_CAPACITY_INSUFFICIENT**

## 10. Which authority binds — the §19 decomposition

One authority moved at a time, on the real tool.

**Enumeration capacity alone** (`max_edges` swept, `max_tokens` at the default
1 200):

| corpus | 64 | 96 | 128 | 256 | 2000 |
| --- | --- | --- | --- | --- | --- |
| C-SMALL | 83.33 % | 83.33 % | 83.33 % | 83.33 % | 83.33 % |
| C-MED | 24 % | 24 % | 24 % | 24 % | 24 % |
| C-LARGE | 8 % | 8 % | 8 % | 8 % | 8 % |
| C-LARGE median relations delivered | 1 | 1 | 1 | 1 | 1 |
| C-LARGE p90 latency | 222 ms | 254 ms | 290 ms | 533 ms | **4 425 ms** |

**Widening enumeration capacity 31-fold recovers exactly zero items on every
corpus, and costs 20× the latency on C-LARGE.** The eight
`CALLER_OUTSIDE_GLOBAL_SLICE` misses are not recovered either: a caller admitted
to a wider slice still cannot be written into a budget that has room for one.

**Representation budget alone** (`max_tokens` swept, `max_edges` at the default
64):

| corpus | 1200 | 1600 | 2000 | 2400 | 3200 | 4800 | 20000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-SMALL | 83.33 % | 88.89 % | 97.22 % | 100 % | 100 % | 100 % | 100 % |
| C-MED | 24 % | 42 % | 48 % | 56 % | 70 % | 78 % | 90 % |
| C-LARGE | **8 %** | 14 % | 18 % | 20 % | 30 % | 42 % | **74 %** |
| C-LARGE median relations | 1 | 1 | 1 | 1 | 1 | 3 | 12.5 |
| C-LARGE median chars | 7 514 | 9 281 | 10 697 | 12 463 | 15 649 | 21 709 | **66 346** |

`max_tokens: 20000` is the hard maximum the tool accepts. At it, the C-LARGE
response is **8.8× the size of the default** and still reaches only **74 %**.

> **A15_BROADER_CAPACITY_INSUFFICIENT**

The two sweeps agree with the packing models and with the arms, and no reading
of them puts 90 % inside the tool's accepted bounds.

## 11. Why 90 % is unreachable at any bound — the closing arithmetic

Reaching 90 % on C-LARGE requires delivering universe rank 530: **531 direct
relations, each with a rendered source line naming the callee**. A delivered
relation costs a median of **1 014 characters** as the product writes one today.
Even a maximally compact truthful caller record — the caller's fqName, the span,
and the source line the frozen rule must read — cannot fall below roughly 150
characters.

| representation | 531 records | default model-visible budget (4 800 chars) | tool's hard response ceiling (80 000 chars) |
| --- | --- | --- | --- |
| as delivered today (1 014 ch) | 538 000 ch | **112× over** | 6.7× over |
| hypothetical minimal record (150 ch) | 79 650 ch | **16.6× over** | at the ceiling, with nothing else in the response |

The frozen metric asks a bounded 1 200-token default response to enumerate
essentially the complete caller list of an arbitrary symbol — up to 817 callers
for one C-LARGE item. No representation, no allocation and no capacity the tool
accepts closes that gap.

## 12. Where the budget nonetheless goes — an observation, not a repair

The measurement surfaced a real allocation asymmetry that is worth recording
even though it cannot close A15.

| corpus | model-visible budget | graph restatement at `max_edges: 64`, unshed | share | delivered `directRelations` | delivered relations |
| --- | --- | --- | --- | --- | --- |
| C-SMALL | 4 800 ch | 1 021 ch | 21 % | 939 ch | 1 |
| C-MED | 4 800 ch | 8 313 ch | **173 %** | 883 ch | 1 |
| C-LARGE | 4 800 ch | 36 882 ch | **768 %** | 906 ch | 1 |

`nodes` and `view` have no rung on the degradation ladder at all. The ladder
sheds the evidence projection twice — first every relation's source line at once
(`directRelations[].compactProjection`), then the relation tail — before either
of them yields anything, and the relation-trimming rung does not shrink
`draft.edges`, so `nodes` and `view` keep describing relations that are no longer
delivered. On C-LARGE, 39 of 50 responses run the ladder all the way to
`bounded_degradation` and then trim canonical edges.

Two allocation repairs are visible in this data and neither is made here. A
**coherent-projection** allocation (B above) would take C-MED from 24 % to 74 %
and C-LARGE from 8 % to 36 % inside the identical bound. A **graduated evidence
shed** — shedding the source line from the relation tail rather than from the
whole list — would recover the 9 C-LARGE, 20 C-MED and 6 C-SMALL `evidence_shed`
misses without changing any other field, and is the pattern the ladder already
applies to `potentialCallers` one rung earlier. **Neither is made here.** The
first
changes what the default impact response delivers at every budget, which is a
budget/representation milestone with its own A11/A13/A12 obligations and its own
design question about what a consumer of the legacy `nodes`/`edges`/`view`
compatibility fields is owed. Both are bounded from above by the C_EVIDENCE_ONLY
ceiling of 46 % and so neither can close A15. M209 declined the first for the same
reason, and M210's own gate — existing capacity insufficient, broader capacity
insufficient — licenses no product change at all. They are recorded here as
measured, named work for a successor milestone that owns the budget contract.

## 13. The gate

```
A15_CALLER_CAPACITY_ATTRIBUTION_COMPLETE
A15_EXISTING_CAPACITY_INSUFFICIENT
A15_BROADER_CAPACITY_INSUFFICIENT
```

§15's `A15_CALLER_SUPPLY_INSUFFICIENT` does **not** apply and must not be
reported: the supply is complete. C-LARGE holds 12 421 `calls` edges, 100 % of
them carrying a persisted call site, 19 330 sites in total, and the scored
caller's relation exists in the truthful universe for **50 of 50** items. Nothing
is missing from the index. What is missing is room in a bounded response.

The residual is therefore named precisely, and differs from M209's wording only
in being proven rather than estimated:

> **A15_DELIVERY_ARITHMETICALLY_UNREACHABLE.** Frozen A15 scores whether the
> default `get_impact_graph` response contains one arbitrary caller of the
> callee, chosen by edge id. On C-LARGE that requires enumerating 531 callers
> with a rendered source line each inside 1 200 model-visible tokens. The bound
> is exceeded by one to two orders of magnitude by every truthful representation,
> and no allocation of the budget and no capacity the tool accepts changes it.

Per §28 the preferred repair A is impossible (there is nothing weaker to
displace), repair B is insufficient (74 % at the hard maximum), and repair C's
primitive is not narrowly repairable. **M210 therefore changes no product
behaviour.**

## Boundary

Frozen A15 measures one bounded surface's caller enumeration. It does not
measure retrieval quality, caller correctness, potential-caller quality, or agent
utility. `ENGINE QUALITY != CODING-AGENT UTILITY` governs; nothing here is a
claim about SWE-bench.
