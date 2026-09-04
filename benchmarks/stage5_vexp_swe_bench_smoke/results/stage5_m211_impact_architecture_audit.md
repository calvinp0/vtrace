# M211 — impact architecture audit and counterfactual

`M211_IMPACT_ARCHITECTURE_AUDITED`
`M211_ARCHITECTURE_REDUCTION_PROVEN`

Product tree `575287d1651a8bea525d4dfcd1c198e26b3ba06d`. No production behaviour
changed by this phase: `git diff HEAD -- src` is empty. 0 live-agent runs, $0
model spend, 0 Docker runs.

## Frozen parity boundary

M210's historical result stands unchanged and is not reopened by this milestone:

```
match-or-exceed 14 / 15     A15 BELOW
A15_DELIVERY_ARITHMETICALLY_UNREACHABLE under the frozen default-response predicate
```

M211 is post-parity product work. Nothing below is a parity claim, the frozen
A15 scorer is untouched, and the frozen population is not re-derived. The
metrics in §3 are M211 **product** metrics and are labelled as such everywhere.

## 1. Existing impact architecture

```
GetImpactGraphInput { symbolFqn, depth, direction, relations,
                      maxPaths=3, maxEdges=64, maxTokens=1200, ... }
        |
        v
getImpactGraph()                                    src/impact/getImpactGraph.ts
  |
  +-- discoverImpactSymbols() ---------> distanceById / symbolsById  (node budget = maxEdges)
  +-- buildImpactEdges().slice(maxEdges) --> edges
  +-- buildRichImpact()
  |     |
  |     +-- listEdgesForSymbol(root)  ------> directCandidates   (COMPLETE, unbounded)
  |     +-- listCallSitesForEdges(all)
  |     +-- buildStaticRelationEvidence(EVERY candidate)   <-- reads source per candidate
  |     +-- .sort(compareStaticRelations)  --> allDirectRelations  (the universe)
  |     +-- .slice(0, maxEdges)            --> directRelations     (the projection)
  |     +-- traverseRelations()            --> paths / affectedFiles / transitive counts
  |
  +-- countConsumers(rich.directRelations)  --> summary.consumers   <-- COUNTS THE SLICE
        |
        v
compactImpactProductResponse()                 src/impact/impactResponseEnvelope.ts
  canonical selection (maxEdges over edgeIds + synthetic ids)
  ladder: paths -> affectedFiles/entrypoints/tests -> diagnostics.limitations
          -> coverage.notes -> accounting -> transitive compat edges
          -> potentialCallers[].compactProjection
          -> directRelations[].compactProjection   (ALL relations at once)
          -> trim directRelations tail to 1
          -> bounded_degradation -> trim edges to 1
        |
        v
ImpactProductResponse { requested resolvedSymbol coverage summary dependentFiles
                        nodes edges view directRelations paths affectedFiles
                        entrypoints tests richSummary limits timing diagnostics
                        callerCoverage potentialCallers accounting responseBudget }
```

### Surfaces

| surface | entry | bounds applied | notes |
|---|---|---|---|
| MCP `get_impact_graph` | `src/mcp/tools.ts` | depth<=8, max_paths<=16, max_edges<=2000, max_tokens<=20000 | passes `repoRoot`, `measureTiming`, then envelope, then observation capture |
| CLI `impact-graph` | `src/cli/commands/impactGraphCommand.ts` | depth arg only (default 2) | `@ts-nocheck`; never sets max_edges/max_tokens; same engine + envelope |
| `run_pipeline` impact section | `maybeBuildRunPipelineImpactSummary` | own compact summary | consumes `resolvedSymbol` + `summary` + top `nodes`; emits `impactRef` |
| deferred ref | `expand_vexp_ref` | category `impact_graph` already exists | **snapshot** store: "stored truth, never a recomputation" |

### The two budget authorities (unchanged by M211, and the reason a naive model is wrong)

`impactResponseEnvelope.ts` measures two different things, and conflating them
produces a counterfactual that "proves" whatever its author wants:

- `impactResponseMeetsEvidenceBudget` — the five model-visible keys
  (`edges`, `nodes`, `view`, `directRelations`, `paths`) against `max_tokens`.
  A **compaction target**, not a delivery gate.
- `impactResponseFitsEnvelope` — the **complete** serialized response against
  `max_tokens + max(800, 15%)`. The only delivery gate.

At the default `max_tokens: 1200` those are 4 800 and 8 000 characters.

## 2. The M210 pathology, reproduced

16 probes over three real indexed corpora, taken at the §28 fanout ladder
(0, 1, 8, 32, 64, 128, 500, 1000+) by asking each graph for the symbol whose
`calls` fan-in is closest to each bucket. Full data:
`results/stage5_m211_audit_pre.json`.

`arc/species/species.py::ARCSpecies` (C-LARGE), default response:

| quantity | value |
|---|---|
| truthful direct relations | **999** (2 exact callers + 867 resolved callers + 40 importers + 36 referrers + …) |
| `summary.consumers.exactCallerCount` | **64** |
| delivered relations | **1** |
| delivered relations carrying a source line | **0** |
| `nodes` + `edges` + `view` + `paths` | 3 167 chars (42.8 %), carrying 5 nodes and 3 edges |
| `directRelations` | 921 chars (12.6 %) |
| fixed metadata | 3 236 chars (44.2 %) |
| total | 7 324 chars |

Across all 16 probes:

- **census is false in 4 / 16** — precisely the four whose universe exceeds
  `max_edges: 64`. Claimed 64 against truth 65, 108, 531 and 869.
- **graph restatement exceeds source evidence in 15 / 16.**
- **the response collapses to <=1 relation in 10 / 16** probes whose truth holds
  more than one.
- **zero source-backed relations in 11 / 16** probes that have persisted call
  sites to render.
- response size is nearly flat in fanout — 7 003 chars at fan-in 1, 7 324 chars
  at fan-in 869 — so the response carries almost no signal about scale.

The `Molecule` probe returns **531** truthful direct relations, which is M210's
own high-fanout figure recovered independently by this instrument.

### Where the false count comes from

```ts
// src/impact/getImpactGraph.ts
const directRelations = allDirectRelations.slice(0, maxEdges);   // the projection
...
const consumers = countConsumers(rich.directRelations, nodes.length);
```

`countConsumers` filters the **sliced** array, so
`summary.consumers.exactCallerCount` *is* the rendered length whenever the
universe exceeds the slice — the exact pattern §9 forbids.
`richSummary.directIncoming`, `countsByRelation` and `countsByStrength` share
the defect; they are at least honestly labelled `canonical_retained` by M139's
`fieldDomains`. The universe size is not recoverable from the response either:
`richSummary.omittedEdges` mixes direct omissions with traversal omissions and
then has `canonicalEdgesOmitted` added on top.

The count is *sometimes* right — C-MED's 131- and 127-relation probes report a
truthful 31 and 58 because their caller counts happen to fall inside the slice.
A count that is right until it silently is not is worse than one that is always
wrong, because nothing in the response marks the transition.

### Counting requires rendering (§48 violated)

`buildStaticRelationEvidence` calls `buildSymbolSourceExcerpt` for **every**
direct candidate, before the slice. Measured on C-LARGE:

| target | hydrated | structural only |
|---|---|---|
| `ARCSpecies` (1 042 direct edges) | 190.3 ms | 20.8 ms |
| `ARCReaction` (445 direct edges) | 90.7 ms | 9.9 ms |

Hydration is ~90 % of impact latency, and 869 of `ARCSpecies`'s 1 042 edges are
`calls`, whose classification never reads the excerpt. The product renders ~999
source excerpts to deliver one.

**A constraint any repair must respect:** `classifyRelation` reads the excerpt
for `imports` (re-export and alias detection) and `references`
(`inherits`/`implements`/`decorates`), so those kinds cannot be classified
lazily without changing `kind`/`strength` — and therefore ordering. Only
`calls` and `contains` are provably excerpt-independent.

## 3. Frozen M211 product metrics

Defined before any functional change; recorded verbatim in
`stage5_m211_audit_pre.json` under `frozenMetrics` and in
`m211ImpactArchitecture.ts`.

| id | metric | bar |
|---|---|---|
| P1 | CENSUS_TRUTH | delivered census == census over the complete universe. Zero disagreements. |
| P2 | CENSUS_INDEPENDENT_OF_EVIDENCE_BUDGET | census byte-identical across max_tokens {400,1200,4000,20000} x max_edges {1,8,64,2000}. |
| P3 | PROJECTION_IS_A_SUBSET | every rendered id in the census universe; no id twice. |
| P4 | SOURCE_ANCHORED | every rendered sourceText is the file's own line at the recorded span (M209 guard). |
| P5 | CLASS_PRESERVED | rendered exact/resolved and direct/transitive labels equal the universe's. |
| P6 | EVIDENCE_YIELD | source-backed rendered relations must not fall anywhere, and must rise where universe >= 64. |
| P7 | RESTATEMENT_SHARE | restatement/total must fall on every probe with >= 8 direct relations. |
| P8 | BOUNDEDNESS | inside the shipped envelope at every fanout; never above the 80 000-char ceiling. |
| P9 | RECONCILIATION | rendered + remaining == census total; remaining >= 0. |
| P10 | CONTINUATION_COVERAGE | pages concatenate to the canonical prefix; no dupes, no gaps, stable across processes. |
| P11 | CENSUS_LATENCY_NO_REGRESSION | p90 default latency does not regress against the pre-change measurement. |
| P12 | COUNTING_DOES_NOT_RENDER | excerpt builds are O(delivered + classification-bound kinds), not O(universe). |

## 4. Counterfactual and reduction verdict

The counterfactual is a **size model**, labelled as one, built from the
product's own relation objects. It is not run through
`compactImpactProductResponse`, because the envelope rebuilds `nodes` and `view`
from whatever relations survive, so a pre-transform that removes the restatement
is undone downstream — M210 measured exactly that in its arm E1.

Three conservatisms, so a proven reduction is not an artefact of a flattering
model:

1. `fixedCharacters` is lifted verbatim from the real response, including
   `richSummary` and `summary`, which the census makes redundant but which the
   output schema still requires.
2. the restatement is **not** set to zero: `nodes`/`edges`/`view` stay required
   fields and are charged at the shipped response's own per-unit serialization
   cost, sized to the projected relations rather than to the retained edges.
3. the census is charged against the **stricter** model-visible budget, so it
   competes with the evidence rather than hiding in the metadata allowance.

Measured effect at the shipped default budget:

| corpus | probes with universe >= 64 | source-backed relations (median) | restatement share (median) |
|---|---|---|---|
| C-MED | 2 | **0 -> 2** | 0.463 -> 0.305 |
| C-LARGE | 4 | **0 -> 2** | 0.438 -> 0.330 |

with the census carrying 503–522 characters and reporting 869 where the shipped
response reports 64.

```
M211_ARCHITECTURE_REDUCTION_PROVEN
  evidenceImproves   true   (never falls; rises on every high-fanout probe)
  restatementFalls   true   (falls on every high-fanout probe)
  censusIsFalseToday true   (4 / 16 probes)
  boundedStill       true   (no modelled response above the 80 000-char ceiling)
```

The dominant win is not evidence volume — 1 relation becomes 2 — it is that the
question *"how much impact exists?"* stops being answered with the size of the
render. A per-relation restatement overhead of ~795 characters against a
~880-character relation record is what caps the evidence gain, and it is an
observation for a later milestone, not something M211 may fix by deleting
required schema fields.

## 5. Continuation infrastructure

`expand_vexp_ref` exists, already declares an `impact_graph` category, and
survives a process restart via `deferredVexpRefsRepository` in `session.sqlite`.
It is a **snapshot** store — its own contract is "the exact payload snapshotted
at run_pipeline time so expansion returns stored truth, never a recomputation".
Snapshotting a 999-relation hydrated universe to serve page 2 is precisely what
§48/§49 forbid, so impact continuation cannot reuse it as-is.

`index_runs.id` is available synchronously from the same `db` handle the impact
path already holds, and `getLatestIndexRun` is already called on this path by
`captureImpactGraphObservationBestEffort`. It is the cheap index-revision
identity a continuation ref needs in order to fail closed rather than paginate a
different graph.

## 6. What this phase does not claim

- It does not change, reinterpret or reopen the frozen 14/15 parity result.
- It does not show that any of this helps a coding agent.
  `ENGINE QUALITY != CODING-AGENT UTILITY` still governs.
- The counterfactual is a size model over real truth, not a product measurement.
  Post-change numbers must come from the product itself.
