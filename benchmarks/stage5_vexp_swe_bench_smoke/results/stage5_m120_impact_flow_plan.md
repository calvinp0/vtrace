# Stage 5 M120 Rich Impact and Static Logic-Flow Plan

_Pre-change audit completed on 2026-07-22 against `main` at authoritative M119 commit `6dbd519` (`Unify VTRACE product context responses`). No implementation preceded this file._

## Scope and invariants

M120 will extend the existing single-repository graph query layer. It will not change Capsule v2 candidate generation, retrieval scoring, lead-pivot choice, selected files, required/support roles, task hashing, capsule mode, M112/M113 wording, M114 worktree routing, or M118 index refresh behavior. It will not create a cross-repository graph, run agents, Docker, VEXP, or live benchmark arms.

The persisted graph remains the M118 graph unless a narrowly tested schema extension proves necessary. Rich relation semantics and source provenance can be normalized at query time from stored edges, indexed symbols, parser metadata, and fresh source. This preserves full/incremental normalized-graph equivalence and avoids selective graph mutation.

## Tool surface (questions 1–7)

1. The current navigation/impact tools are MCP `get_impact_graph` and `search_logic_flow`; CLI `impact-graph`; product paths `get_code_context`, `get_context_capsule`, and `run_pipeline`; internal `getImpactGraph` (`src/impact/getImpactGraph.ts`), `searchLogicFlow` (`src/logicFlow/searchLogicFlow.ts`), graph expansion/reranking helpers under `src/retrieval/`, Capsule v2 graph-neighbor/co-edit helpers, `get_skeleton`, and source excerpt loading.
2. `get_impact_graph` exists. `search_logic_flow` is the existing equivalent of a bounded `trace_path`/`get_logic_flow`. There are no distinct `find_callers`, `find_references`, or `explain_symbol` tools; reverse callers/references are folded into `get_impact_graph`.
3. MCP exposes both `get_impact_graph` and `search_logic_flow` (`src/mcp/types.ts`, definitions in `src/mcp/tools.ts`), plus the three M119 product context tools.
4. `impact-graph` is also CLI-exposed (`src/cli/commands/impactGraphCommand.ts`, `src/cli/index.ts`). Logic flow has no dedicated CLI command.
5. `getImpactGraph`, `searchLogicFlow`, edge repositories, source excerpt builders, graph expansion, Capsule v2 neighbor anchoring, and M119 `addImpactEvidence` are internal helpers.
6. `get_impact_graph` currently provides the strongest impact-specific evidence because it combines persisted reverse edges, exact-FQN target resolution, shortest reverse distance, file counts, deterministic views, and optional bounded dependent-symbol excerpts. `search_logic_flow` is stronger for A-to-B connectivity but scans the whole graph.
7. Preserve the tool ids `get_impact_graph` and `search_logic_flow`, CLI `impact-graph`, their existing required parameters, outer `requested/resolvedSymbol|resolvedStart|resolvedEnd/coverage/summary/nodes|paths` fields, and list/tree/mermaid formats. New inputs and outputs will be additive.

## Graph model (questions 8–20)

8. Symbol nodes are function, class, method, interface, type alias, module constant, module variable, and module alias (`SymbolKind`, `src/domain/types.ts`). Files are separate persisted records but not edge endpoints.
9. Persisted `EdgeType` values are `contains`, `imports`, `calls`, and `references`.
10. All four are persisted in SQLite `edges`; reverse impact distances, shortest-layer edges, primary parents, logic-flow paths, inherited-member observations, and cross-language observations are query-derived.
11. Python, TypeScript/JavaScript, and Cython parsers emit `contains`, `imports`, `calls`, and `references`, with conservative exact resolution documented in their parser modules and tests. Re-exports are followed during import/call/reference resolution but flattened to `imports`/resolved target edges. Python inheritance/decorators and TypeScript extends/implements/decorators are currently flattened into `references`. Cython inheritance is likewise a reference. No first-class route/handler, test-target, or documentation edges exist. Markdown is not a parser language in `Language`.
12. No persisted edge includes a source location. Each source symbol includes a start/end line and byte span, so current excerpts ground the producing symbol, not the exact edge occurrence.
13. Targets have indexed symbol start/end line and byte spans, but those spans are not copied into `EdgeRecord`.
14. Contains and definitions embodied by symbol records are exact. Imports/calls/references are emitted only after the parsers select an unambiguous repository target; confidence is always `1`, but that numeric field has no documented cross-kind calibration and must not be exposed as probabilistic confidence.
15. Parser calls/references are conservative static resolution. Inherited member fallback, token-level Cython resolution, and query-time subtype classification require explicit limitations. Filename-mirrored test association and documentation-name association, if added, are weak/lexical only.
16. Unresolved or ambiguous call/reference/import targets are currently skipped; they are not persisted as dangling edges. Exact-FQN query ambiguity is returned as a structured error with matching ids. M120 can report query ambiguity honestly but cannot reconstruct every skipped parser relation without new parser evidence.
17. Import aliases are parser-local resolution maps. Resolved persisted edges point from the importing/using symbol to the canonical target symbol; alias spelling/provenance is not persisted.
18. Python package `__init__.py` re-exports are followed through exact, cycle-bounded export indexes (`pythonParser.ts`, `pythonFileImports.ts`), but the stored edge points to the defining symbol and loses the intermediate facade. TypeScript supports relative import resolution but does not currently persist a distinct re-export edge.
19. Methods are uniquely represented with `SymbolKind.Method`, class-qualified FQNs, and `parentSymbolId`; they are distinguishable from free functions.
20. IDs are deterministic hashes of path, FQN, kind, and byte span. They are identical between full and incremental indexing for unchanged structure, but can change when edits move byte spans. M118 proves normalized full/incremental graph equivalence for the same snapshot.

## Current impact behavior (questions 21–30)

21. `getImpactGraph` returns an exact-FQN root, structural coverage notes, dependent counts/files, reverse-distance nodes, shortest-layer canonical edges, and list/tree/mermaid views; MCP/CLI may add accounting and bounded dependent-symbol excerpts.
22. It is primarily upstream/reverse dependents over all four persisted edge types: callers, importers, referrers, and containers whose stored edge targets the current frontier.
23. No. Output retains canonical edge direction but only traverses incoming edges. There is no outgoing dependency result or separate incoming/outgoing summary.
24. Nodes have distance and edges join adjacent shortest layers, but direct/transitive counts are not separated.
25. Depth is bounded; node/edge/path/token counts are not independently bounded.
26. Yes. `distanceById` prevents revisiting symbols.
27. Nodes are deduplicated by id. Edges preserve multiple shortest parents. Tree/list pick one deterministic parent. It does not materialize/deduplicate complete paths.
28. Optional MCP/CLI excerpts preserve the dependent source-symbol span, not the exact edge site. Pure internal results have no source evidence.
29. Users see the edge type and endpoint FQNs, but not resolution method, alias, edge-site span, evidence strength, or per-edge limitations.
30. Only broad coverage notes describe conservatism. Individual edges cannot be recognized as exact/resolved/conservative/lexical, and skipped unresolved relationships are invisible.

## Current product integration (questions 31–37)

31. M119 `assembleProductContext` calls `getImpactGraph` at depth 1 for at most two pivots and turns up to six edges per pivot/ten total items into `impact` drafts (`src/productContext/assembleProductContext.ts`).
32. It discards coverage notes, edge ids/endpoints beyond the dependent, observed type counts, dependent-file counts, all transitive data, paths, direction, edge confidence, and source excerpts. Metadata retains only edge type, traversal depth, and `indexed_symbol_span` availability.
33. If an impact symbol is already a pivot/support, identity dedup merges roles and bodies. Impact content itself repeats `edgeType: FQN`; complete source is not duplicated. Rich metadata can reuse the same item/display id after dedup.
34. Current caps are two pivots, six edges per pivot, ten impact items, and 2,400 impact-content characters. The final renderer accounts tokens but does not enforce a dedicated impact token budget against `budgetTokens`.
35. Yes. Enrichment occurs after Capsule v2 selection and can attach metadata/rendered summaries without feeding candidates or selected files back into retrieval.
36. `get_impact_graph` should expose rich evidence by default because it is the dedicated impact tool. `search_logic_flow` should expose edge evidence and hard bounds by default. M119 product paths should expose a compact bounded subset when their existing intent routing includes impact.
37. The normal debug/modify product path should not start unrequested multi-hop impact traversal. Rich multi-hop product rendering remains limited to impact-eligible pivots; direct metadata stays bounded.

## Flow semantics (questions 38–43)

38. A truthful static flow is a bounded directed path through persisted, statically extracted repository relationships. It is a structural/dependency/possible-call path, never proof of runtime execution.
39. There is no persisted entrypoint classification today. Deterministic candidates can be limited to exported symbols and test functions from indexed metadata; main guards, route registrations, and framework callbacks are not represented reliably.
40. Current usable evidence is `SymbolRecord.exported`, symbol kind/signature/decorators, path naming, and incoming-edge absence. Only exported/public and syntactically named test categories are safe without broad framework heuristics; both need explicit limitations.
41. Caller-to-callee paths and importer-to-definition paths are derivable from calls/imports. Inheritance paths are derivable only by syntax-classifying reference edges. Test-to-target paths can be classified when a test symbol directly calls/imports the target. Route-to-handler paths are unsupported absent narrow syntax evidence.
42. Direct calls/imports are strongest for Python and TypeScript, conservative for Cython. Python alias/relative/re-export resolution is already substantial. TypeScript relative ES imports/calls and extends/implements references are supported conservatively. Cython is token-level conservative. Inheritance subtype classification requires fresh source syntax.
43. Runtime ordering, dynamic dispatch, monkey patching, reflection, dependency injection, arbitrary receiver type inference, framework route/task semantics, C-level dispatch, structural protocol satisfaction, and cross-repository paths remain unsupported.

## Performance (questions 44–50)

44. One-hop impact queries exact-FQN by indexed symbol lookup and `listEdgesForSymbols` using both `idx_edges_src_symbol_id` and `idx_edges_dst_symbol_id`; cost is proportional to incident edges plus symbol lookups.
45. Existing reverse traversal repeats bounded indexed frontier queries through requested depth. Existing logic flow loads every symbol and edge and computes whole-graph forward/reverse BFS, so cost is O(V+E) even for a shallow path.
46. Impact adjacency lookup is indexed. Logic flow builds in-memory adjacency from full table scans (`listAllSymbols`, `listAllEdges`).
47. `searchLogicFlow`, normalized-graph comparison, and any repository-wide entrypoint/test scan risk whole-graph scans. Product impact depth-1 queries do not.
48. M120 needs validated defaults and hard caps for depth, paths, inspected edges, returned edges, rendered evidence, and token estimate. Traversal must stop at limits rather than merely truncate rendering.
49. Cache safety would require worktree id, index run/snapshot id, endpoints, direction, relation filter, evidence flags, and every bound. Profiling has not justified caching; M120 will not add it initially.
50. Query-time normalization must be deterministic and read-only. Persisted graph generation stays unchanged unless tests demand a narrow extension. The smoke will compare normalized rich impact/flow from full and incremental indexes at the same snapshot, in addition to existing M118 normalized-graph tests.

## Implementation design

1. Add a shared `staticEvidence` model with distinct semantic relation kinds, categorical strengths (`exact`, `resolved`, `conservative`, `lexical`, `unresolved`), canonical incoming/outgoing direction, symbol-span provenance, deterministic resolution-method strings, limitations, and stable evidence ids. Do not expose the existing numeric `confidence` as a calibrated probability.
2. Normalize persisted edges at query time. Preserve `calls`, `imports`, `contains`, and `references`; syntax-classify only narrow, source-supported `re_exports`, `inherits`, `implements`, and `decorates` cases. Add conservative test/public-entrypoint annotations without inventing graph targets. Documentation evidence will be lexical and explicitly separate from calls/imports.
3. Upgrade `getImpactGraph` additively with direction/relation/depth/path/edge/token bounds, direct incoming/outgoing evidence, separate direct/transitive counts, affected-file summaries, bounded strongest paths, test/entrypoint annotations, truncation/omission metrics, and timing/counters. Preserve legacy nodes/edges/views.
4. Upgrade `searchLogicFlow` additively with relation filters and depth/edge/token bounds, source-grounded evidence on steps, deterministic ranking by minimum strength then length/cross-file count/lexical order, cycle safety, and explicit static-only limitations. Keep the tool name because adding a duplicate path tool would overlap.
5. Extend MCP schemas/descriptions and CLI parsing additively. `repo_root` remains supplied by the worktree-bound MCP/CLI binding; cross-repo remains rejected.
6. Extend M119 impact items with direct typed counts, affected-file count, strongest bounded path summaries, entrypoint/test links where present, evidence strengths, stable context references, and truncation metrics. Preserve one-body dedup and include the compact render in existing accounting.
7. Add focused tests and the required no-agent smoke. The smoke will create disposable repositories under `/tmp`, never raw run artifacts, and emit only the named compact M120 result files.

## Planned bounds and ordering

Initial defaults: depth 3 for rich queries (legacy MCP depth default remains compatible), maximum 3 paths, 64 returned edges, 2,000 inspected edges, and an explicit compact evidence token cap. Hard ceilings will reject unsafe inputs. Ordering is deterministic: direct before transitive for impact summaries; path minimum strength (exact/resolved/conservative/lexical/unresolved), then shorter length, fewer cross-file transitions, then repository-relative FQN/edge-id lexical order. No database insertion order is used.

## Truth boundary

All reports and tool descriptions will use “static flow”, “structural path”, “possible call path”, or “dependency path”. They will explicitly state that dynamic dispatch and runtime execution are not established. Lexical evidence will not contribute to confirmed call counts, unresolved relations will have no fabricated target, and source-symbol spans will never be described as exact call-site spans.
