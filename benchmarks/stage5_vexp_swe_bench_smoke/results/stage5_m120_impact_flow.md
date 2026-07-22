# Stage 5 M120 Rich Impact and Static Logic-Flow Evidence

## Summary

- **Previous impact behavior:** `get_impact_graph` was a reverse-only, exact-FQN traversal over persisted `contains`, `imports`, `calls`, and `references`. It returned shortest-layer nodes/edges and flat dependent files. `search_logic_flow` returned shortest forward paths but had no categorical edge evidence, source/target provenance model, depth/edge/token bounds, or evidence-ranked path order.
- **Implementation:** M120 adds a shared query-time static evidence model, typed incoming/outgoing impact, direct/transitive summaries, affected-file review guidance, bounded strongest paths, entrypoint/test classifications, optional lexical documentation links, and additive MCP query controls. The persisted graph and retrieval pipeline are unchanged.
- **Evidence quality:** Every resolved returned relation has canonical source/target identities and indexed spans. Where fresh bounded source contains the target occurrence, the exact line and source text are attached; otherwise the relation explicitly reports `source_symbol_span`. Alias, relative-import, package re-export, inheritance, implementation, and decorator resolution methods are explicit. Numeric confidence remains `null` because the legacy `confidence=1` field is not calibrated.
- **Product integration:** M119 impact items now carry direct counts, affected-file counts, strongest path summaries, test/entrypoint links, evidence strength, resolution method, limitations, and truncation/omission metadata. Existing `[P#]/[R#]/[S#]/[I#]` identities are reused after deduplication; source bodies are not repeated.
- **Verdict:** **PASS**.
- **Recommendation:** **promote rich impact and static flow**.

## Pre-change Audit

The required 50-question audit is in `stage5_m120_impact_flow_plan.md` and was created before implementation.

### Tools

M119 exposed MCP `get_impact_graph` and `search_logic_flow`, CLI `impact-graph`, and product tools `get_code_context`, `get_context_capsule`, and `run_pipeline`. There were no separate caller/reference/explain tools. M120 keeps those names and extends the two dedicated MCP tools additively rather than adding an overlapping path tool. Logic flow remains MCP/internal-only; impact remains MCP and CLI compatible.

### Graph schema

Persisted nodes remain functions, classes, methods, interfaces, type aliases, module constants, module variables, and module aliases. Persisted edge kinds remain `contains`, `imports`, `calls`, and `references`. Edge rows do not contain occurrence spans, alias spelling, or resolver provenance; endpoints do contain indexed symbol spans. Re-exports and inheritance-like references were previously flattened.

### Language support

Python, TypeScript/JavaScript, and Cython already emitted conservative resolved calls/references. Python already resolved aliases, relative imports, exact package re-exports, same-class members, and narrow inherited-member cases. TypeScript already emitted ES imports/calls and reference edges for extends/implements/decorators. Cython used a conservative token model. Markdown had no persisted parser graph.

### Existing limitations

Reverse impact did not distinguish incoming from outgoing, direct from transitive counts, or edge-level uncertainty. Logic flow loaded the graph into memory and returned only shortest paths. Neither surface explained a resolver per edge. Exact call-site lines were unavailable. Unknown/ambiguous exact-FQN targets failed explicitly, while unresolved parser candidates were skipped.

### Performance

One-hop impact uses indexed `src_symbol_id`/`dst_symbol_id` queries. Rich impact is capped by depth, returned/inspected edges, paths, and approximate path tokens. Logic flow remains a repository graph load followed by bounded adjacency/path processing; caching was not added because profiling did not justify the invalidation complexity. Timings are opt-in for direct MCP calls so deterministic internal/deferred payloads stay stable; product context retains M119 `impactMs` accounting.

## Evidence Model

### Relation kinds

The shared vocabulary includes `contains`, `defines`, `imports`, `re_exports`, `calls`, `references`, `inherits`, `implements`, `decorates`, `registers`, `routes_to`, `tests`, `documents`, and `unknown`. M120 returns the persisted four plus narrowly supported `re_exports`, `inherits`, `implements`, `decorates`, and `documents`. Unsupported route/registration categories are not fabricated. Tests are classified as typed review/path annotations while the underlying call/import relation remains intact.

### Evidence strengths

- `exact`: direct parent/child syntax, same-file/same-class resolved call, or explicit inheritance/implementation syntax.
- `resolved`: imports, aliases, relative imports, package re-exports, and unambiguous cross-file calls.
- `conservative`: narrow cross-class/member resolution or exact-name structural references that do not establish calls.
- `lexical`: documentation/name evidence only; never included in confirmed call counts.
- `unresolved`: reserved and accepted by query controls, but the current persisted graph skips unresolved parser candidates. Unknown/ambiguous query targets remain structured errors instead of fabricated relations.

No probabilistic number is exposed. `confidence` is deliberately `null` with categorical strength and a deterministic `resolutionMethod`.

### Provenance

Each relation includes stable evidence id, persisted edge id when applicable, relation and persisted kinds, canonical source and target, direction relative to the focal symbol, source/target line spans, bounded source text when grounded, alias/reference name, resolution method, location kind, and per-edge limitations. Query-reconstructed import/re-export evidence is accepted only when exact syntax resolves to the canonical target and the source file hash/size still matches the index.

### Ambiguity and unresolved handling

Exact-FQN ambiguity returns matching symbol ids. Unknown targets return `unknown_symbol`/`unknown_start`/`unknown_end`. Dynamic receivers, reflection, monkey patching, dependency injection, wildcard/ambiguous re-exports, and unresolved parser candidates do not acquire targets. Lexical docs evidence has `persistedKind: null`, `edgeId: null`, `strength: lexical`, and an explicit non-call limitation.

## Impact Queries

### Direct impact

`directRelations` contains both incoming and outgoing canonical relations. `richSummary` separates `directIncoming`, `directOutgoing`, relation counts, and strength counts. Calls, imports, re-exports, references, inheritance, implementation, decorators, and docs remain distinct.

### Upstream

Upstream paths answer “what may need review?” through callers, importers/re-export consumers, subclasses, tests, and exported entrypoint-like symbols. `affectedFiles` reports minimum distance, direct/transitive state, relation kinds, strongest evidence, and high-confidence versus uncertain review guidance.

### Downstream

Downstream paths answer “what does this target rely on?” through callees, imports, containers/references, base types, and decorators where the persisted or syntax-backed relation supports it.

### Change impact

The current dedicated query accepts one exact focal symbol. It returns affected files/symbols, tests, entrypoint-like exports, high-confidence relations, uncertainty, and omission metrics. Multi-symbol change-set aggregation remains a caller-side operation; no cross-repository aggregation was added.

### Bounds

Impact accepts direction, relation filters, depth, max paths, max edges, approximate max tokens, lexical/unresolved inclusion, and evidence inclusion. Defaults remain compatible with legacy tool inputs. Output reports every applied limit plus `truncated`, `omittedPaths`, and `omittedEdges`.

## Static Flow Paths

### Path semantics

A path is a bounded route through static repository evidence. Directions include entrypoint-to-target, caller-to-target, target-to-callee, import-to-definition, test-to-target, and inheritance chain. It is not an execution trace.

### Ordering

Paths prefer stronger weakest-edge evidence, then shorter length, fewer file transitions, relation priority, repository-relative symbol order, and edge id as the final stable tie-break. Retrieval scoring is not used or changed.

### Cycle safety

Impact traversal keeps a visited-symbol set. Logic-flow distance maps and shortest-path constraints prevent cyclic enumeration. The cycle smoke visited three nodes and returned the two-edge path without looping.

### Truncation

Depth, inspected/returned edge, path, and approximate token ceilings are explicit. The truncation smoke returned `truncated: true` with six omitted edges and three omitted paths under deliberately tiny limits.

### Runtime-claim boundary

Tool descriptions, diagnostics, relation limitations, path limitations, and product rendering consistently say static/structural evidence and explicitly reject runtime execution truth.

## Language Support

### Python

Covered by focused tests and smoke: direct function calls, aliased symbol import/call, relative import, package `__init__.py` re-export, class inheritance, decorators, same-class and narrow inherited member behavior already supported by the parser, and direct test calls/imports. Arbitrary receiver dispatch and monkey patching remain unsupported.

### TypeScript/JavaScript

Covered: ES imports, aliases, direct calls, `index.ts` re-export syntax, explicit `implements`, existing extends/reference behavior, and decorators where the parser resolves them. No broad type inference was added.

### Cython

Existing conservative import/cimport, definition, direct call/reference, class/method, and Python↔Cython behavior is preserved. M120 changes interpretation/query output, not speculative C-level dispatch.

### Markdown/documentation

Markdown/RST/MDX participate only when lexical evidence is requested. A deterministic bounded worktree-local scan recognizes explicit FQN, repository path, or symbol-name mentions and nearby headings. These are `documents`/`lexical`, never calls/imports, and are not persisted graph nodes.

## Entrypoints, Tests, and Inheritance

- Entrypoints implemented: indexed `exported=true` symbols (`exported_api`) and syntactically named/path-classified tests. Each carries evidence strength and a non-runtime limitation.
- Tests: direct call/import graph paths are surfaced as `test_to_target`. Path/name classification does not claim test-runner collection or execution. Filename mirroring alone does not create an exact target relation.
- Inheritance: explicit Python bases and TypeScript `extends`/`implements` syntax are classified separately when the reference target is already resolved. Structural protocol satisfaction is not inferred.
- Framework routes, task queues, CLI registration, and worker callbacks remain unsupported unless future narrow syntax integrations are added with tests.

## ProductContext Integration

### M119 stable IDs

Impact drafts retain the existing `path::fqName` identity. Dedup merges impact into an existing pivot/required/support item when applicable; after display ids are assigned, metadata records `contextReference` and `pivotContextReference` such as `[I1]` and `[P1]`.

### Compact rendering

Impact-only content is one compact line such as `CALLS path::symbol at path:line [resolved]`. Strongest paths are metadata summaries containing ids, direction, length, minimum strength, and FQNs—not copied bodies. The representative smoke product response emitted one impact item and used 575 estimated total model-visible tokens.

### Deduplication

M119’s one-body-per-path/symbol policy remains authoritative. Rich impact metadata is merged into the owner item; duplicate full source is not rendered. Existing duplicate item/character/token counters remain intact.

### Accounting

The final `modelVisibleContext`, including compact impact lines, feeds the existing M119 character-ratio estimator. `renderedCharacters === modelVisibleContext.length` remained true. Impact assembly remains covered by `impactMs`.

### Cross-tool parity

The existing M119 parity test for `get_code_context`, `get_context_capsule`, and `run_pipeline` passed in the full suite. Task hash, capsule mode, lead pivot, selected files, role classification, estimator, and worktree identity remain shared.

## Worktree and Index Integration

### M114

MCP continues to bind `repoRoot` to one selected worktree database. The smoke created a real linked Git worktree, changed `consumer.ts` only there, indexed each worktree independently, and observed four direct incoming relations in the main worktree versus one in the linked worktree. No path crossed databases.

### M118

No parser edge generation or persisted graph schema changed. Rich semantic subtypes are query-time views. A one-file incremental refresh and a clean full rebuild produced identical normalized graphs and deeply equal rich impact output.

### Graph equivalence

`normalizeGraph(incrementalDb) === normalizeGraph(fullDb)` and rich `getImpactGraph` outputs were deeply equal for the same snapshot. Stable ids remain subject to the existing span-sensitive symbol-id contract.

### Isolation

Import/re-export reconstruction reads only exact related files and target package facades from the selected worktree and validates indexed source hash/size. Documentation scanning is bounded to that worktree.

## No-Agent Smoke

The required smoke script passed 20/20 cases. It ran no agents, Docker, VEXP, benchmark arms, or paid APIs. Cases cover Python call/alias/relative/re-export/inheritance, TypeScript call/import/re-export/implementation, tests, docs, multiple path ordering, cycles, lexical evidence, unknown targets, no path, truncation, linked-worktree isolation, incremental/full equivalence, product-context integration, and stale/no-context behavior.

Representative measured M120 impact timing on the small synthetic target was approximately 3.74 ms total: 0.13 ms target resolution, 1.52 ms direct-neighbor/evidence assembly, and 0.59 ms path traversal. This is a fixture measurement, not a broad performance claim.

## Old vs New Comparison

The comparison artifact uses the same indexed Python target and reports the M119-compatible fields beside M120 fields.

- Legacy view: 4 direct persisted edges, 2 affected files, no materialized impact paths/tests/entrypoints, about 63 rendered-view tokens, and no edge-site provenance percentage or isolated latency seam.
- Rich view: 8 direct relations (including reconstructed imports/re-export and lexical docs), 3 bounded paths, 2 affected files, 1 test, 75% exact edge-site lines and 100% endpoint/symbol-span provenance, 7 resolved direct relations versus 1 lexical direct relation, no truncation.
- The dedicated rich JSON evidence selection was about 2,914 estimated tokens under a 20,000-token test cap. Product context did not render that full payload; its representative compact response was 575 estimated total tokens.
- Improvement is attributed to relationship separation, provenance, limitations, and path explanation—not the higher edge count.

## Limitations

- Static evidence cannot establish runtime ordering, reachability, dynamic dispatch, reflection, monkey patching, dependency injection, or actual test/entrypoint execution.
- Persisted edges still lack exact occurrence spans. Exact line evidence is query-derived only when the target spelling occurs in a fresh bounded source span; otherwise output says `source_symbol_span`.
- The current graph skips unresolved parser candidates, so `includeUnresolved` cannot reconstruct arbitrary skipped edges.
- Logic flow still loads the repository graph before applying path bounds; very large-graph indexed adjacency/storage is deferred.
- Documentation is a bounded lexical scan, not a parsed Markdown graph.
- Entry-point support is intentionally narrow; framework routes, workers, callbacks, and CLI registrations are not generalized.

## Deferred Work

- Cross-repository workspace graph assembly.
- Optional LSP/compiler-backed evidence and exact type resolution.
- Dynamic/runtime traces.
- Advanced framework route/task/callback semantics.
- Persisted exact edge occurrence spans and unresolved candidates.
- Tokenizer-exact accounting.
- Dedicated retrieval timing seam and profiling-driven per-index-run cache.

## Success Criteria Check

1. Existing impact tools mapped before implementation: PASS.
2. Relation kinds semantically distinct: PASS.
3. Resolved edge provenance available: PASS (exact occurrence where grounded; otherwise explicit source-symbol span).
4. Lexical/unresolved not exact: PASS.
5. Incoming/outgoing distinct: PASS.
6. Direct/transitive distinct: PASS.
7. Cycle-safe deterministic bounded paths: PASS.
8. Static-not-runtime wording: PASS.
9. Python alias/relative/re-export: PASS.
10. Syntax-supported inheritance/implementation only: PASS.
11. Entrypoint/test evidence strength: PASS.
12. Stable ids reused/no duplicate bodies: PASS.
13. Token/edge/path caps: PASS.
14. M119 accounting includes rendered impact: PASS.
15. Worktree isolation: PASS.
16. Incremental/full rich graph equivalence: PASS.
17. Retrieval selection/order unchanged: PASS; no retrieval code changed and the full regression suite passed. Broad retrieval eval was not run because selection/ranking did not change.
18. No live agents/API spend/Docker/VEXP: PASS.
19. Tests/typechecks/diff checks: PASS (`3732` tests across `217` files, zero failures).

## Verdict

**PASS**

M120 answers the milestone question affirmatively: VTRACE now returns bounded, source-grounded static impact and path evidence that is materially more useful than a flat dependent list while consistently refusing to claim runtime execution knowledge.

## Recommendation

**promote rich impact and static flow**

Keep framework entrypoints, persisted edge sites/unresolved candidates, and cross-repository traversal as explicit follow-up work rather than broadening this evidence model heuristically.
