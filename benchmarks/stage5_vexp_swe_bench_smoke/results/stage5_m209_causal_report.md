# M209 causal report — pre-change

## 1. Frozen A15 authority

Quoted verbatim from the committed scorer sources at report time.

The predicate (m197aScoring.ts):
```ts
export function callSiteIsRendered(evidence: CallSiteEvidence): boolean {
  const text = evidence?.sourceText;
  if (typeof text !== "string" || text.trim().length === 0) return false;
  const callee = evidence.referenceName;
  if (typeof callee !== "string" || callee.length === 0) return false;
  return text.includes(callee);
}
```

The population (m197aFixtures.ts):
```ts
export function deriveCallSiteEdges(db: Database, limit: number): FlowPair[] {
  return (db.query(`
    select ss.fq_name as start, ds.fq_name as end
    from edges e
    join edge_call_sites cs on cs.edge_id = e.id and cs.ordinal = 0
    join symbols ss on ss.id = e.src_symbol_id
    join symbols ds on ds.id = e.dst_symbol_id
    where e.edge_type = 'calls' and ss.fq_name <> ds.fq_name
    order by e.id
    limit ?1`).all(limit) as FlowPair[]);
}
```

The engine's A15 block (run_stage5_m197a_engine.ts):
```ts
  // -------------------------------------------------- A15 + §30 truthfulness
  const callEdges = deriveCallSiteEdges(db, 50);
  let eligible = 0;
  let impactRendersExpression = 0;
  let flowRendersExpression = 0;
  let flowTextNamesCallee = 0;
  let flowTextMatchesDeclaredSpan = 0;
  let declaredSpanNamesCallee = 0;
  const renderExamples: any[] = [];

  for (const pair of callEdges) {
    const flow = await call(server, McpToolId.SearchLogicFlow,
      { repo_root: work, start: pair.start, end: pair.end });
    const step = flow?.paths?.[0]?.steps?.[0];
    const ev = step?.relation?.evidence;
    const site = ev?.callSites?.[0];
    const srcPath = step?.relation?.source?.path;
    if (!ev || !site || !srcPath) continue;
    eligible += 1;

    const lines = linesOf(srcPath);
    const spanText = lines.slice(site.startLine - 1, site.endLine).join("\n");
    const callee: string = ev.referenceName ?? "";
    if (callee && spanText.includes(callee)) declaredSpanNamesCallee += 1;

    if (typeof ev.sourceText === "string" && ev.sourceText.trim().length > 0) {
      flowRendersExpression += 1;
      if (callSiteIsRendered(ev)) flowTextNamesCallee += 1;
      if (ev.sourceText.trim() === spanText.trim()) flowTextMatchesDeclaredSpan += 1;
      else if (renderExamples.length < 5) {
        renderExamples.push({ from: pair.start, to: pair.end, callee,
          declaredSpan: `${srcPath}:${site.startLine}-${site.endLine}`,
          rendered: ev.sourceText.slice(0, 140), actualAtDeclaredSpan: spanText.slice(0, 140) });
      }
    }

    // The impact surface, which is where a caller list is actually consumed.
    const impact = await call(server, McpToolId.GetImpactGraph,
      { repo_root: work, symbol_fqn: pair.end, depth: 3 });
    const relation = (impact?.directRelations ?? []).find((r: any) => r.source?.symbol === pair.start);
    if (relation && callSiteIsRendered(relation.evidence ?? {})) impactRendersExpression += 1;
```

The claim row and band (run_stage5_m197a_report.ts):
```ts
    id: "A15", vexpClaim: "call-site evidence renders the call expression, not just a location",
    vexpSource: "V-B1/V-B2 evidence half", m196Prior: "0% rendered (100% stored) — FAILS",
    reproduction: ReproductionStatus.Reproduced,
    measurement: `C-LARGE, ${eng("C-LARGE")?.a15?.eligibleCallSites} eligible call edges: the impact `
      + `surface renders ${a15Impact}% as source expressions, the logic-flow surface ${a15Flow}%. `
      + `On C-MED the flow surface renders ${eng("C-MED")?.a15?.flowCorrectRenderPercent}%`,
    matchThreshold: ">= 90% of eligible call sites render the expression", exceedThreshold: "100%",
    // Scored on the IMPACT surface: that is the caller-enumeration surface V-B1
    // describes and the surface M196's prior was set against. The flow-surface
    // result is a correction to that prior and is published beside it, with the
    // aggregate's sensitivity to the choice stated below.
    verdict: band([a15Impact], 90, 100, "atLeast"),
    comparabilityCaveat: "scored on get_impact_graph; get_code_context's logic-flow surface DOES "
```
```ts
function band(values: readonly (number | null)[], match: number, exceed: number,
              direction: "atLeast" | "atMost"): ClaimVerdict | null {
  if (values.length === 0 || values.some((v) => v === null || Number.isNaN(v))) return null;
  const nums = values as number[];
  const clears = (bar: number) => direction === "atLeast"
    ? nums.every((v) => v >= bar) : nums.every((v) => v <= bar);
  if (clears(exceed)) return ClaimVerdict.Exceeds;
  if (clears(match)) return ClaimVerdict.Matches;
  return ClaimVerdict.Below;
}
```
```ts
const a15Impact = eng("C-LARGE")?.a15?.impactRenderPercent ?? null;
const a15Flow = eng("C-LARGE")?.a15?.flowCorrectRenderPercent ?? null;
```

Recovered: **A15_FROZEN_AUTHORITY_RECOVERED**.

In words: the claim is `call-site evidence renders the call expression, not just a location`; the corpus is C-LARGE (ARC, Python, 276 files); the population is the first 50 `calls` edges by edge id that carry an ordinal-0 persisted call site and join distinct symbols; the scored surface is the DEFAULT `get_impact_graph` MCP response for the callee at `depth: 3`, and the item is the `directRelations` entry whose `source.symbol` is the caller; the predicate is `evidence.sourceText` non-empty AND containing `evidence.referenceName`; the metric is rendered ÷ eligible; MATCH ≥ 90 %, EXCEED 100 %; the logic-flow surface is published beside it and does not decide. Eligibility is decided on the flow surface (a step with `evidence.callSites[0]` and a source path), so the denominator is what VTRACE actually persisted, not what it declined to render.

## 2. M208 reproduction

| corpus | M208 engine eligible | M208 impact % | M208 flow % | M209 audit eligible | M209 audit impact % |
| --- | --- | --- | --- | --- | --- |
| C-SMALL | 36 | 0 | 100 | 36 | 0 |
| C-MED | 50 | 0 | 100 | 50 | 0 |
| C-LARGE | 50 | 0 | 100 | 50 | 0 |

M208 committed matrix: A1 MATCHES, A2 EXCEEDS, A3 MATCHES, A4 EXCEEDS, A5 MATCHES, A6 EXCEEDS, A7 EXCEEDS, A8 EXCEEDS, A9 MATCHES, A10 MATCHES, A11 EXCEEDS, A12 MATCHES, A13 EXCEEDS, A14 MATCHES, A15 BELOW — 14 / 15.

## 3. Existing impact architecture

```
parser (Python / TypeScript / Cython) --> edges(id, src, dst, edge_type, confidence)
                                      --> edge_call_sites(edge_id, ordinal, start_line, start_column, end_line, end_column, precision)
getImpactGraph (src/impact/getImpactGraph.ts)
  listEdgesForSymbol + getSymbolsByIds + listCallSitesForEdges  (one batched query each)
  buildStaticRelationEvidence (src/impact/staticEvidence.ts)
    persisted sites filtered to the caller's own span, sorted
    buildSymbolSourceExcerpt(anchorLine = first site)  <- loadSymbolSource checks size + sha256 against files(...)
    evidence = { sourceText (first site line, trimmed, <=240), referenceName (callee local name),
                 resolutionMethod, locationKind (edge_site | caller_span_scan | source_symbol_span), callSites[<=5], callSiteCount }
  directRelations  (dedupe by relation id, ordered incoming-first / strength / kind / path / symbol / id)
  paths / nodes / edges / view  (projections of the same retained set)
MCP get_impact_graph handler (src/mcp/tools.ts)
  compactImpactProductResponse (src/impact/impactResponseEnvelope.ts)   <- the scored surface
search_logic_flow (src/logicFlow/searchLogicFlow.ts) -> the same buildStaticRelationEvidence with the edge's sites   (published beside)
get_code_context / run_pipeline consume the CORE relations directly (no envelope): summary lines `CALLS <caller> at <path>:<line> [strength]`
```

## 4. Truth capability matrix

| evidence | indexed? | persisted? | queryable? | core delivers? | default get_impact_graph delivers? (M208) |
| --- | --- | --- | --- | --- | --- |
| exact caller identity (calls edge, src symbol) | yes | edges | listEdgesForSymbol | source.{nodeId,path,symbol,kind} | yes |
| potential caller identity (unresolved receiver) | no (scan per response) | never | callerCoverage scan | potentialCallers[] (separate collection) | yes, separate |
| call-site span (line/column, precision) | yes | edge_call_sites | listCallSitesForEdges | evidence.callSites[], callSiteCount | yes |
| caller source line at the site | no (rebuilt from disk under hash check) | never | buildSymbolSourceExcerpt | evidence.sourceText | NO — stripped |
| callee name used for grounding | yes (symbols.local_name) | symbols | yes | evidence.referenceName | NO — stripped |
| caller enclosing symbol | yes | symbols | yes | source.symbol / nodeId | yes |
| cross-file status | derivable | files via symbols.file_id | join | source.path vs target.path | yes |
| graph distance | no | computed per traversal | traverseRelations | nodes[].distance; paths[].length | yes (nodes), paths compacted first |
| edge provenance / certainty | yes | edge_type; strength derived | yes | kind, strength, resolutionMethod, locationKind | yes |
| multiple sites per edge | yes | edge_call_sites.ordinal | yes | callSites (<=5) + callSiteCount | yes |

| corpus | calls edges | with persisted site | site % | sites | multi-site edges | cross-file calls | sites outside caller span | references edges (with site) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-SMALL | 36 | 36 | 100 | 51 | 8 | 0 | 0 | 14 (0) |
| C-MED | 4468 | 4468 | 100 | 6003 | 760 | 1806 | 0 | 5511 (0) |
| C-LARGE | 12421 | 12421 | 100 | 19330 | 2513 | 7729 | 0 | 3068 (0) |

## 5. Renderability audit

| corpus | eligible | RENDERABLE_FROM_EXISTING_TRUTH | GRAPH_ONLY | AMBIGUOUS | STALE | NO_TRUTH | core faultless | core sourceText | cross-file / same-file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-SMALL | 36 | 36 | 0 | 0 | 0 | 0 | 36 | 36 | 0 / 36 |
| C-MED | 50 | 50 | 0 | 0 | 0 | 0 | 50 | 50 | 14 / 36 |
| C-LARGE | 50 | 42 | 0 | 0 | 0 | 8 | 42 | 42 | 21 / 21 |

Core faults (C-LARGE): none. Core strengths: absent 8; exact 21; resolved 21. Core location kinds: absent 8; edge_site 42.

## 6. Where the evidence is dropped

On the default surface the C-LARGE relations carry exactly these evidence key sets:  37; callSiteCount,callSites,locationKind,resolutionMethod 13; the envelope stamps accounting|affectedFiles/entrypoints/tests|bounded_degradation|canonicalEdges|coverage.notes|diagnostics.limitations|directRelations|directRelations[].compactProjection 39; accounting|affectedFiles/entrypoints/tests|coverage.notes|diagnostics.limitations|directRelations[].evidence|nodes[].sourceExcerpt|paths|transitiveCompatibilityEdges 3; accounting|affectedFiles/entrypoints/tests|coverage.notes|diagnostics.limitations|directRelations|directRelations[].compactProjection|directRelations[].evidence|nodes[].sourceExcerpt 6; accounting|bounded_degradation|canonicalEdges|coverage.notes|diagnostics.limitations|directRelations|directRelations[].compactProjection|directRelations[].evidence 1; accounting|coverage.notes|diagnostics.limitations|directRelations[].evidence|nodes[].sourceExcerpt|paths|transitiveCompatibilityEdges|view 1; result states bounded_truncated 50. The core delivered sourceText for 42 and referenceName for 42 of the scored relations; the default response delivered 0 and 0.

Mechanism (code-level): `compactImpactProductResponse` builds its canonical selection by mapping every direct relation through `compactRelation`, which rebuilds `evidence` from `resolutionMethod`, `locationKind`, `callSites` and `callSiteCount` only — `sourceText`, `referenceName` and `importAlias` are dropped before any budget is measured, on every response, and the marker `directRelations[].evidence` is stamped unconditionally. It is not a rung of the degradation ladder: the ladder's own evidence-shedding rung (`minimalRelation`) runs later and only when the envelope binds. The drop is therefore a projection defect, not a budget decision, and the frozen A15 population sees 0 % rendered on a surface whose upstream produced the line for every item.

## 7. Counterfactual: renderer-only repair

Two bounds apply, and the frozen metric is subject to both. The FIRST is truth: can the index support a rendering for this item at all. The SECOND is delivery: the scorer reads the DEFAULT response, so the caller's relation must also survive into it, at its rank in the core's own ordered relations, inside `max_tokens + max(800, 15 %)`.

| corpus | eligible | renderable from truth | truth % | caller in core order | lost to the core's 64-relation slice | rank 0 / <=2 / <=6 / <=9 / max | achievable at 500 chars per relation | achievable at 200 chars per relation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-SMALL | 36 | 36 | 100 | 36 | 0 | 35 / 36 / 36 / 36 / 1 | 100 % | 100 % |
| C-MED | 50 | 50 | 100 | 50 | 0 | 29 / 42 / 45 / 48 / 36 | 94 % | 98 % |
| C-LARGE | 50 | 42 | 84 | 42 | 8 | 10 / 19 / 29 / 32 / 46 | 60 % | 74 % |

The last two columns are UPPER bounds computed from each response's own fixed metadata and its own ceiling: they assume the three graph restatements (`nodes`, `edges`, `view`) and `paths` cost nothing at all, and that a delivered relation costs 500 — or 200 — characters, below what any truthful record carrying a caller identity, a span and a source line has been observed to cost (median per core relation is in the next table). They are what a renderer-only repair could reach, not what one would reach.

| corpus | median response chars | median fixed metadata | median nodes+edges+view | median directRelations | median per core relation | ceiling chars | delivered relations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-SMALL | 7806.5 | 4335 | 1020.5 | 848.5 | 1131 | 8000 | 1 27; 2 7; 3 2 |
| C-MED | 7664.5 | 3428.5 | 3248 | 842 | 1194.5 | 8000 | 1 33; 2 16; 3 1 |
| C-LARGE | 7472 | 3332.5 | 3205 | 865 | 1264.5 | 8000 | 1 44; 2 6 |

| corpus | responses | all retained keys meet evidence target | all retained keys fit ceiling | max stripped tokens | median stripped tokens |
| --- | --- | --- | --- | --- | --- |
| C-SMALL | 36 | 35 | 28 | 56 | 23 |
| C-MED | 50 | 49 | 38 | 67 | 31 |
| C-LARGE | 50 | 48 | 48 | 77 | 30 |

The last table re-adds the stripped keys for EVERY retained direct relation of each scored response to the product's own `responseBudget`: restoring the evidence costs a median of 30 tokens per response and fits the ceiling almost everywhere. Restoring the evidence is affordable; retaining the caller is not.

## 8. High-fan-in probe

| corpus | symbol | incoming calls | default: chars / relations / with text / inspected / retained / omitted / state | hard bounds (2000 edges, 20000 tokens): chars / relations / with text / retained / omitted / state |
| --- | --- | --- | --- | --- |
| C-SMALL | compare/compare.ts::loadExternalAgent | 2 | 7901 / 2 / 0 / 18 / 4 / 0 / response_compacted | 16910 / 4 / 0 / 4 / 0 / response_compacted |
| C-MED | db/sqlite.ts::openIndexerDatabase | 58 | 7394 / 1 / 0 / 133 / 5 / 170 / bounded_truncated | 79522 / 30 / 0 / 69 / 137 / bounded_truncated |
| C-LARGE | arc/species/species.py::ARCSpecies | 869 | 7367 / 1 / 0 / 1106 / 4 / 2818 / bounded_truncated | 79385 / 1 / 0 / 87 / 2213 / bounded_truncated |

## 9. Examples (real, from the corpora; nothing invented)

- C-LARGE: exact caller (persisted call site) `arc/job/env_run.py::rmg_env_command` -> `arc/job/env_run.py::_pythonpath_lines` at arc/job/env_run.py:288-288: core `return '\n'.join(preamble + _pythonpath_lines(rmg_path) + [`; default response `(absent)`
- C-LARGE: resolved caller (persisted call site) `arc/molecule/symmetry_test.py::TestMoleculeSymmetry.test_atom_symmetry_number_methane` -> `arc/molecule/symmetry.py::calculate_atom_symmetry_number` at arc/molecule/symmetry_test.py:42-42: core `symmetry_number *= calculate_atom_symmetry_number(molecule, atom)`; default response `(absent)`
- C-LARGE: resolved caller (persisted call site) `arc/checks/nmd_test.py::TestNMD.test_analyze_ts_nmd_urea_rad_furazan` -> `arc/species/converter.py::check_xyz_dict` at arc/checks/nmd_test.py:1451-1465: core `rxn.ts_species = ARCSpecies(label='TS_1', is_ts=True, xyz=check_xyz_dict(`; default response `(absent)`
- C-MED: exact caller (persisted call site) `capsule/selectCapsuleMemories.ts::scoreObservation` -> `capsule/selectCapsuleMemories.ts::isEligibleForSurfacing` at capsule/selectCapsuleMemories.ts:140-147: core `if (!isEligibleForSurfacing({`; default response `(absent)`
- C-MED: resolved caller (persisted call site) `retrieval/hybridRetrieval.ts::hybridRetrieve` -> `retrieval/upstreamRescue.ts::inactiveUpstreamRescue` at retrieval/hybridRetrieval.ts:342-342: core `upstreamRescue: inactiveUpstreamRescue("no results requested"),`; default response `(absent)`
- C-MED: resolved caller (persisted call site) `runPipeline/runPipelineOrchestrator.ts::runReliableContextRetrieval` -> `intent/routeQuery.ts::routeQuery` at runPipeline/runPipelineOrchestrator.ts:666-669: core `? routeQuery(db, input.query, {`; default response `(absent)`
- C-SMALL: exact caller (persisted call site) `vexp/enhancer.ts::setupVexpRepo` -> `vexp/enhancer.ts::indexRepo` at vexp/enhancer.ts:23-23: core `await indexRepo(repoPath);`; default response `(absent)`
- C-SMALL: exact caller (persisted call site) `leaderboard/render.ts::renderLeaderboard` -> `leaderboard/render.ts::displayName` at leaderboard/render.ts:14-14: core `const maxNameLen = Math.max(...entries.map((e) => displayName(e).length), 10);`; default response `(absent)`
- C-SMALL: exact caller (persisted call site) `compare/compare.ts::buildCompare` -> `compare/compare.ts::loadExternalAgent` at compare/compare.ts:95-95: core `const agent = loadExternalAgent(name);`; default response `(absent)`

## 10. Pre-change causal gate

**A15_RENDERABLE_SUPPLY_INSUFFICIENT**

The C-LARGE population is 42 / 50 renderable from existing truth (84 %), but only 60 % of it can also be DELIVERED: 8 callers fall outside the core's own 64-relation slice, and of those that remain the scored caller sits at rank 0 in 10 cases and within the first three in 19, while the default envelope's fixed metadata (median 3332.5 of 8000 characters) leaves room for about three relations even if every graph restatement were free. Rendering alone therefore CANNOT reach the 90 % bar. The rendering defect is real and is repaired; the residual is a delivery primitive, named in section 10.


**The missing primitive.** Frozen A15 is scored on whether the default `get_impact_graph` response for a callee contains one ARBITRARY caller of that callee, chosen by edge id. Clearing 90 % therefore requires the default response to enumerate essentially the complete caller list for every symbol — a median of 13 relations on C-LARGE, up to rank 46 — inside a 2 000-token ceiling whose fixed, unshrinkable metadata already spends about 3 300 characters. That is a caller-enumeration capacity primitive (a compact per-caller record and a caller-complete projection), not a rendering one. It is outside what M209 may build: it would change what the default impact response delivers at every budget, which is a budget/representation milestone with its own A11/A13 obligations. M209 repairs the rendering defect it found and reports the primitive rather than manufacturing parity.

## Boundary

Frozen A15 measures the impact surface's rendering of a persisted call site as source text naming the callee. It does not measure caller completeness, potential-caller quality, transitive rendering, or agent utility. `ENGINE QUALITY != CODING-AGENT UTILITY` governs; nothing in this report is a claim about SWE-bench.

