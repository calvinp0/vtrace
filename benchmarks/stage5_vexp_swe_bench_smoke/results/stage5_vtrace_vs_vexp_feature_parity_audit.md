# Stage 5 VTRACE vs VEXP feature-parity audit

Generated: 2026-06-12. Read-only audit of `/home/calvin/code/vtrace` on `main`. No benchmarks were rerun; no live agents, Docker, repair, or live critic were executed. Evidence is cited as `file:line` against the current working tree.

## Executive summary

The central VEXP advantage is not just a smaller prompt. It is a productized single-call context system: pivots, skeletons, impact, flow, memory, token accounting, and intent-aware retrieval are exposed as simple deterministic tools. VTRACE has several internal pieces, especially Capsule v2 and Stage 5 telemetry, but some are benchmark-only or not yet exposed as robust product tools. The highest-priority work should turn existing internal capabilities into first-class deterministic tools that reduce agent search turns.

Concretely, VTRACE is further along on product surface than the starting hypothesis assumed: 11 of VEXP's 10 named tools (plus `get_code_context` and `expand_vexp_ref`) exist as registered, tested, documented MCP tools (`src/mcp/tools.ts:7911-7917`, `src/mcp/mcp.test.ts:58-71`). Only `submit_lsp_edges` is fully missing. The deeper gaps are:

1. **Capsule v2 (the token-budgeted, best-ranked capsule engine) is not on the MCP path.** MCP `get_context_capsule`/`run_pipeline` use capsule v1 with a character budget (default 2,000 chars); `buildCapsuleV2` is consumed only by the CLI `capsule` command and Stage 5 artifacts (`src/cli/commands/capsuleCommand.ts:39`, `src/capsuleV2/stage5Artifacts.ts`).
2. **No tokens-saved or latency accounting in any product tool response.** Both exist only in benchmark runners under `benchmarks/`. VEXP prints `tokens used / tokens saved / latency / % saving` on every call.
3. **Logic flow and impact output lack per-hop/per-caller code lines.** VEXP shows "caller routes/user.ts, 12 lines, `router.get(...)`"; VTRACE returns FQN chains and dependent lists without source excerpts (`src/logicFlow/searchLogicFlow.ts`, `src/runPipeline/formatRunPipelineOutput.ts:79-86`), which pushes the agent into follow-up Read turns.
4. **Turn-count amplification, not capsule size, is the measured token problem.** 96% of positive token deltas in the Stage 5 token-path audit were cache-read amplification from extra agent turns (`results/stage5_token_path_audit.md`); measured first-pass reduction is 25.24% vs the "up to 74%" headline (`results/stage5_token_reduction_vs_recovery.md`). Richer single-call output is the direct fix, and it is exactly what VEXP's tool shape provides.
5. **Language and content coverage is narrower than VEXP claims:** TS/Python/Cython only; JS files are detected but unparsed; Go/Rust are enum-only; Markdown is not in the index/FTS (query-time bounded scan only, `src/capsuleV2/docRetrieval.ts:1-12`).
6. **LSP bridge and feedback-loop budget expansion are missing.** Session memory and passive observation exist as real product subsystems, but memory scoring lacks recency and graph-proximity signals, and nothing adapts retrieval to repeated queries.

## VEXP target model

From the product/website capability model used for this audit:

- **Index:** tree-sitter AST; dependency graph with function/class/type nodes and call/import/implementation edges; Markdown indexed by section; local SQLite; manifest in git; 5,000 files in under 15s; node/edge/file counts reported.
- **Traverse:** hybrid search (FTS5 + TF-IDF + graph centrality); intent detection routing to debug / blast-radius / modify modes; no embeddings, no network; P95 query < 500ms.
- **Capsule:** pivots in full; adjacent nodes skeletonized to signatures/docstrings/return types; bounded to a token budget; 70-90% skeleton reduction.
- **Smart features:** LSP bridge (type-resolved edges from VS Code), feedback loop (repeated queries expand budget), session memory (auto-capture, stale flags, consolidation, anti-pattern detection), passive observation (blake3 hashing, AST structural diffs incl. renamed/signature/body/visibility, change↔tool-call correlation, promotion into project rules).
- **Tools:** `get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`, `index_status`, `workspace_setup`, `submit_lsp_edges`, `get_session_context`, `search_memory`, `save_observation` — each returning a compact, deterministic, token-accounted payload (`tokens used / tokens saved / latency`).

## VTRACE current product surface

MCP server: `src/mcp/startServer.ts` → `src/mcp/server.ts:44` → `defaultMcpToolRegistry` (`src/mcp/registry.ts:20`, `src/mcp/tools.ts:7911-7917`).

**Visible MCP tools (12):** `get_code_context` (default first-pass, alias of `run_pipeline` with a freshness gate, `src/mcp/tools.ts:7241`), `run_pipeline` (:6719), `get_context_capsule` (:7256), `get_impact_graph` (:7432), `search_logic_flow` (:7538), `get_skeleton` (:7637), `index_status` (:7706), `workspace_setup` (:7800), `get_session_context` (:6431, promoted :7893), `search_memory` (:6276, promoted :7894), `save_observation` (:6149, promoted :7895), `expand_vexp_ref` (:5291, added :7896).

**Hidden-but-callable (9):** `index_repo`, `search_symbols`, `build_capsule`, `build_handoff`, `route_query`, `list_runs`, `check_capsule_staleness`, `list_sessions`, `read_session`.

**CLI (25 commands):** `setup`, `status`, `doctor`, `daemon`, `watch`, `index`, `intent`, `capsule`, `run-pipeline`, `skeleton`, `impact-graph`, `handoff`, `rules`, `compress-sessions`, etc. (`src/cli/index.ts:25-116`).

**VS Code extension:** a deliberately thin shell over the CLI ("Thin VS Code shell for the vtrace CLI", `vscode-extension/package.json:5`) with ~18 commands; no LSP integration.

**Docs:** per-tool sections in `docs/mcp_tools.md`, selection guidance in `docs/mcp_tool_cheat_sheet.md`, README:135-147.

So the product surface is real, not benchmark scaffolding. The thinness is in *output richness per call*, not tool existence.

## Single-call capsule parity

Can VTRACE produce a VEXP-style single call (pivot full source + skeleton neighbors + impact + memory + tokens saved + latency)? **Partially, split across two pipelines, with no tokens-saved/latency anywhere.**

- `run_pipeline`/`get_code_context` is the closest single-call shape: capsule v1 context + impact section + flow section + memory section + rules + deferred `vexp:` refs (`src/runPipeline/runPipelineOrchestrator.ts:241-311`). But it uses capsule **v1** with a **character** budget (default 2,000), pivots are rendered without full source bodies in the compact MCP output, and the impact/flow sections are heavily gated (impact requires a refactor-like trigger phrase plus exactly one query-mentioned focal symbol, `runPipelineOrchestrator.ts:627-685`).
- `vtrace capsule` (CLI only) uses capsule **v2**: pivots with full source laddered Full→Signature→Skeleton (`src/capsuleV2/buildCapsuleV2.ts:746-768`), signature-only support items, tiered token budgets (micro <1,500 / standard <12,000 / full, `src/capsuleV2/budgetAllocator.ts:37-57`), greedy token fill (`buildCapsuleV2.ts:600-673`), explainable 10-signal ranking (`src/capsuleV2/types.ts:61-89`, `src/capsuleV2/pivotRankingV2.ts`). But v2 output has **no impact, no memory, no deferred refs, no latency**, and is **not exposed over MCP**.
- Token accounting: capsule v2 reports `budget.estimated_tokens`/`used_percent` (chars/4 approximation, `src/capsuleV2/tokens.ts:1-20`) — tokens **used**, never tokens **saved**. Latency: zero `Date.now`/`performance.now` instrumentation in `src/capsule/`, `src/capsuleV2/`, `src/runPipeline/`, or `src/mcp/` product paths.

**Verdict: partial.** All ingredients exist; no single call assembles them, and the headline VEXP affordance (`tokens used / saved / latency / % saving` on every response) is absent from the product.

## Specialized tool parity

### Table 1 — VEXP tool parity

| VEXP tool | Equivalent VTRACE tool/API | Status | Evidence path | Missing behavior | Token impact | Priority |
|---|---|---|---|---|---|---|
| get_context_capsule | MCP `get_context_capsule` (also `get_code_context`/`run_pipeline`) | partial | `src/mcp/tools.ts:7256-7427`; `src/runPipeline/runPipelineOrchestrator.ts:241-311` | Uses capsule v1 (char budget) on MCP; capsule v2 (token budget, full-source pivots, v2 ranking) is CLI-only; no tokens-saved/latency; impact/flow sections gated by narrow trigger conditions | High — richer first call directly reduces follow-up Read/Grep turns, the measured 96% cache-read driver | P0 |
| get_impact_graph | MCP `get_impact_graph` / CLI `impact-graph` | complete | `src/impact/getImpactGraph.ts:207-255` (reverse BFS over Contains/Imports/Calls/References edges, depth-bounded, list/tree/mermaid views, honest coverage notes :404-461); `src/mcp/tools.ts:7432` | No per-caller source excerpts (VEXP shows N-line caller snippets); exact-FQN-only resolution; static-only (documented) | Medium — caller snippets would avoid one Read per dependent the agent inspects | P1 |
| search_logic_flow | MCP `search_logic_flow` | partial | `src/logicFlow/searchLogicFlow.ts:112-116` (Contains+Imports+Calls adjacency), `:319-431` (bidirectional BFS + all-shortest-paths enumeration) | No per-hop code lines/line spans/source snippets (VEXP shows the call chain code per hop); shortest paths only; exact-FQN endpoints only | Medium — agents re-read each hop file to see the actual calls | P1 |
| get_skeleton | MCP `get_skeleton` / CLI `skeleton` | partial | `src/skeleton/getSkeleton.ts:102-228`; `src/mcp/tools.ts:7637` | Assembled on demand from index-time symbol records (functionally close to precomputed; no persisted skeleton artifact); Python/TS/Cython only; no explicit return-type field (only what `signature` text carries) | Medium — skeletons are the main 70-90% reduction lever; coverage gaps make whole file classes fall back to full reads | P1 |
| index_status | MCP `index_status` / CLI `status` | complete | `src/mcp/tools.ts:7706`; `inspectIndexStatus`; counts reported at `src/indexer/indexProject.ts:200-218`, `src/cli/formatters.ts:175-188` | No daemon-uptime/indexing-rate metrics (daemon exists, `src/runtime/daemon.ts:107-157`, but uptime is not surfaced); no P95 query latency | Low | P3 |
| workspace_setup | MCP `workspace_setup` / CLI `setup` | partial | `src/mcp/tools.ts:7800-7890`; `src/runtime/setupFlow` | No git-hook installation; agent detection limited to Claude Code config actions; single-repo registration (multi-repo capsule exists but setup is per-repo) | Low (indirect — onboarding friction, not tokens) | P3 |
| submit_lsp_edges | — | missing | zero hits repo-wide for `submit_lsp_edges`, "language server", "type-resolved" | Entire capability: no LSP client, no external-edge ingestion path, no edge-submission MCP tool; `vscode-extension/` is a thin CLI shell (`vscode-extension/package.json:5`) | Medium for TS-heavy repos (static TS call resolution is conservative); low for the Python-centric benchmark set | P2 |
| get_session_context | MCP `get_session_context` | complete | `src/mcp/tools.ts:6431,7893`; staleness at `src/observations/staleness.ts:22-80` (FileRemoved/FileModified/SymbolRemoved reasons) | Stale reasons computed from index-run diffs, not live; no cross-session focus learning | Low-medium | P2 |
| search_memory | MCP `search_memory` | partial | `src/mcp/tools.ts:6276,7894`; `src/observations/searchMemory.ts:21-34` (fixed-weight signals incl. stalePenalty 30) | Scoring is substring/term-overlap heuristics: no BM25/TF-IDF component, no recency decay, no graph-proximity signal (those exist only in code retrieval, `src/retrieval/hybridScoring.ts:672-744`); scoring breakdown is present but with a weaker model | Low-medium | P2 |
| save_observation | MCP `save_observation` | complete | `src/mcp/tools.ts:6149,7895`; linking (files/symbol ids/fq-names) `:6184-6193`; stale-on-change via `src/observations/staleness.ts`; consolidation `src/observations/consolidation.ts:17`; nudges `src/observations/observationNudges.ts:167-184` | — (anti-pattern detection and rule promotion also present: `src/observations/antiPatterns.ts:19-22`, `src/projectRules/projectRules.ts:37-49`) | Low | P3 |

Supplementary VTRACE-only tools relevant to parity: `expand_vexp_ref` (deferred-ref expansion, `src/mcp/tools.ts:5291`) is a genuine token-saving mechanism VEXP's model does not name; `check_capsule_staleness` works now that `get_context_capsule`/`run_pipeline` persist capsule manifests (`src/mcp/tools.ts:7414-7419`).

## Index and graph parity

- **Storage:** SQLite via `bun:sqlite` at `<repo>/.vtrace/index.sqlite` (`src/db/sqlite.ts:1-10`, `src/setup/types.ts:6-9`), with schema migrations, run history, and two FTS5 virtual tables (`src/db/schema.ts:7-348`). **Not committed to git** — `.gitignore` excludes `/.vtrace/`; the "manifest" concept is in-DB (`capsule_manifests`, `src/db/schema.ts:71-103`), unlike VEXP's manifest-in-git claim.
- **Nodes/edges:** functions, classes, methods, interfaces, type aliases, module constants/variables/aliases; edges exactly `contains|imports|calls|references` with a confidence column (`src/db/schema.ts:309-329`, `src/domain/types.ts:23-27`). **No `implements`/`extends` edge type** — inheritance is folded into `references` kind "inheritance" (`src/parsers/pythonParser.ts:85-92`).
- **Parsers:** TypeScript is genuinely tree-sitter (`src/parsers/typescriptParser.ts:3-4,77`); Python and Cython use a spawned CPython `ast` subprocess (real AST, not regex, but host-Python-dependent and per-file-spawn slow; `src/parsers/pythonParser.ts:173-176,761`). Registry registers only TS/Python/Cython (`src/indexer/indexProject.ts:221-244`); **JS files are detected then fail `unregistered_language`** (`src/fs/languageDetection.ts:5-29`, `LanguageParser.ts:44-50`); Go/Rust are enum-only.
- **Markdown:** not indexed. Query-time bounded scan only (max 50 files / 200KB, `src/capsuleV2/docRetrieval.ts:1-26`) — vs VEXP's "Markdown indexed by section."
- **Counts/progress:** indexing reports files/symbols/relationships and phased progress (`src/indexer/indexProject.ts:42-218`). **No files-per-second or 15s-class throughput instrumentation** anywhere.
- **Daemon/watcher:** detached daemon hosting MCP (`src/runtime/daemon.ts:107-269`) and a 1s-poll, debounced file watcher with optional auto-reindex (`src/runtime/fileWatcher.ts:24-26,321-524`).

**Verdict: complete core (SQLite + 4-type graph + FTS5 + counts + daemon/watcher), partial coverage (3 languages, no Markdown index, no implements edge, no throughput telemetry).**

### Table 2 — Core architecture parity

| Capability | VEXP behavior | VTRACE status | Evidence path | Gap | Why it matters | Priority |
|---|---|---|---|---|---|---|
| AST parser/index | tree-sitter, 5k files <15s | partial | `src/parsers/typescriptParser.ts:3-4` (tree-sitter TS); `src/parsers/pythonParser.ts:173,761` (CPython `ast` subprocess) | Python/Cython via per-file subprocess; no throughput instrumentation; JS/Go/Rust unparsed | Indexing speed and language reach bound where VTRACE can be used | P2 |
| Graph edges: calls/imports/implementations | all three edge classes | partial | `src/db/schema.ts:309-329`; `src/domain/types.ts:23-27` | contains/imports/calls/references exist; no `implements`/`extends` type (folded into references kind) | Blast-radius for interface changes under-reports | P3 |
| Markdown section indexing | indexed by section | missing (query-time only) | `src/capsuleV2/docRetrieval.ts:1-26` | bounded live scan (50 files/200KB), not in SQLite/FTS | Docs-heavy tasks fall back to agent file reads | P2 |
| Local DB / manifest | local SQLite, manifest in git | partial | `src/db/sqlite.ts:1-10`; `src/setup/types.ts:6-9`; `src/db/schema.ts:71-103` | SQLite yes; manifest is in-DB, nothing committed to git | Team-shared index bootstrap not possible | P3 |
| Hybrid FTS + TF-IDF | FTS5 + TF-IDF | complete | `src/db/schema.ts:331-347`; `src/retrieval/hybridScoring.ts:672-744` | BM25 is pool-scoped, not corpus-scoped (acceptable) | — | — |
| Graph centrality | centrality in ranking | partial | `src/retrieval/graphExpansion.ts:254-273`; `hybridScoring.ts:195-255` | in-degree only, weakest weight, hub-penalized (deliberate) | Likely adequate; revisit with data | P3 |
| Intent detection | debug/blast-radius/modify routing | complete (split across two systems) | `src/intent/classifier.ts:34-131`, `src/intent/profile.ts:21-73`; `src/capsuleV2/intent.ts:57-248` | two unmerged systems; MCP impact section additionally gated by trigger phrases | First-call strategy mismatch multiplies turns | P1 |
| Capsule budget enforcement | token-bounded | partial | `src/capsuleV2/budgetAllocator.ts:37-57`, `buildCapsuleV2.ts:600-673` (tokens, CLI); `src/capsule/budget.ts:15-24` (chars, MCP) | MCP path is char-budgeted v1; v2 token budget not on MCP; chars/4 estimator | Budget semantics differ between product and best engine | P0 |
| Skeleton precomputation | precomputed at index time | partial | `src/skeleton/getSkeleton.ts:102-228`; `src/indexer/indexProject.ts:221-244` | raw material indexed; document assembled on demand; no persisted artifact; 3 languages; no return-type field | Skeletons are the main 70-90% reduction lever | P1 |
| Deferred refs | (VEXP: bounded capsule) | complete (VTRACE-specific advantage) | `runPipelineOrchestrator.ts:1133-1354`; `src/mcp/tools.ts:5291` (`expand_vexp_ref`) | absent from capsule v2 result type | Pay-per-expansion context is a real token saver | P2 |
| Session memory | auto-capture, stale flags, consolidation, anti-patterns | partial | `src/observations/autoCapture.ts:24`; `staleness.ts:22-80`; `consolidation.ts:17`; `antiPatterns.ts:19-22` | scoring lacks BM25/recency/graph-proximity; no feedback-loop budget expansion | Memory exists; relevance ranking is the weak half | P2 |
| Passive observation | blake3, AST diffs incl. renamed/sig/body, change↔tool correlation, rule promotion | partial | `src/runtime/fileWatcher.ts:24-32`; `src/memory/computeSymbolDiff.ts:153-168`; `src/projectRules/projectRules.ts:37-49` | sha256 polling (fine); no Renamed type; no sig-vs-body split; correlation limited to anti-patterns | Polish, not a token lever | P3 |
| LSP bridge | type-resolved edges from VS Code | missing | zero hits; `vscode-extension/package.json:5` | entire capability | Conservative TS call graph under-powers impact/flow on TS repos | P2 |
| Token accounting | tokens used/saved per call | partial | `src/capsuleV2/tokens.ts:1-20` (used, estimate); benchmarks only for saved | no tokens-saved in product; chars/4 estimator; nothing in MCP responses except budget fields | Cannot attribute savings or drive discipline without it | P0 |
| Latency measurement | latency per call, P95 <500ms | missing | zero timing instrumentation in `src/mcp/`, `src/runPipeline/`, `src/capsule*/` | entire capability in product path | No latency claims possible; no regression detection | P1 |

## Search/ranking parity

- **FTS5:** real — `symbol_search_fts` and `symbol_body_literals_fts` virtual tables (`src/db/schema.ts:331-347`), queried via MATCH (`src/retrieval/searchSymbolsFts.ts:22-35`).
- **BM25/TF-IDF:** real — hand-rolled Okapi BM25 (k1=1.5, b=0.75) over the candidate pool, blended with FTS at 0.65/0.35 (`src/retrieval/hybridScoring.ts:672-744,129-137`).
- **Centrality:** present but basic — global in-degree only (`src/retrieval/graphExpansion.ts:254-273`), deliberately the weakest weight (0.5) with a hub penalty stripping graph+centrality from high-in-degree symbols lacking local evidence (`hybridScoring.ts:195-255`). No PageRank/betweenness.
- **Full hybrid:** candidate union (lexical FTS, shaped symbol/path, failing-test→impl, body literals, bounded graph expansion, siblings) → 10 normalized signals → weighted sum minus hub/actionability penalties (`src/retrieval/hybridRetrieval.ts:1-17`, `hybridScoring.ts:118-176`). No embeddings, no network calls anywhere in `src/` — matching VEXP's determinism claim.

**Verdict: complete — at or above the VEXP description for code search.** Note the strong ranking lives in retrieval/capsule v2; the MCP capsule path benefits only partially.

## Skeletonization parity

- Generator: `src/skeleton/getSkeleton.ts` — imports summary (from Imports edges, :152-185), exports (:187-196), declarations with signature/docstring/decorators/line-spans and class members, three detail levels, no bodies.
- Precompute: hybrid — the raw material (signatures, docstrings, spans, edges) is extracted once at index time into SQLite; the skeleton document is assembled on demand from DB queries (no re-parse). Capsule v1 has a per-build skeleton cache (`src/capsule/buildCapsuleImpl.ts:857-880`). Functionally equivalent to VEXP's "precomputed at index time" for latency purposes, minus a persisted artifact.
- In capsules: capsule **v1** embeds structured skeletons (`buildCapsuleImpl.ts:499-506`); capsule **v2**'s `Skeleton` content mode is name-only — support items carry signatures but not the structured skeleton (`src/capsuleV2/buildCapsuleV2.ts:770-845`).
- Gaps: Python/TS/Cython only; **no explicit return-type field** (`src/domain/types.ts:57-72` has signature/docstring/decorators; return types appear only if textually inside the signature).

**Verdict: partial — solid tool, but v2 capsules don't use structured skeletons, and language/return-type coverage trails the VEXP claim.**

## Impact graph parity

`src/impact/getImpactGraph.ts` is a genuine traversal, not report metadata: exact-FQN resolution (:117-148), layered reverse BFS over incoming edges up to caller-supplied depth (:207-255), edge filtering to shortest-layer parents (:289-318), output with distances, dependent files, summary counts, three views, and unusually honest coverage notes including member/`super()`/Python↔Cython evidence (:333-461). Wired into `run_pipeline` at depth 2 (`runPipelineOrchestrator.ts:565-569`) and auto-captured into observations.

Gaps vs VEXP's example output: **no per-caller source excerpt** ("caller routes/user.ts — 12 lines — `router.get(...)`"); exact-FQN-only input (no fuzzy symbol resolution); inside `run_pipeline` the impact section fires only for refactor-like queries with exactly one focal symbol (`runPipelineOrchestrator.ts:627-685`), so most first-pass calls skip it.

**Verdict: complete as a traversal engine; partial as a VEXP-style product output.**

## Logic-flow parity

`src/logicFlow/searchLogicFlow.ts`: forward+reverse BFS distance maps over Contains/Imports/**Calls** adjacency (:112-116, :319-358 — note: the older root-level `VTRACE_TOOLING_AUDIT.md:155` claim that call edges are excluded is outdated), then DFS enumeration of all shortest paths with caps and truncation flags (:360-431). Output: per-path node summaries (symbolId, filePath, fqName, kind) and hop-by-hop steps with edge types, plus `callFlowEvidenceAvailable/Used` and coverage notes (:433-531).

Gaps vs VEXP's example: **no per-hop code lines, line numbers, or source snippets** (`LogicFlowSymbolSummary` has no startLine/endLine); shortest paths only; exact-FQN endpoints; the `run_pipeline` compact rendering is thinner still — FQN chains only (`src/runPipeline/formatRunPipelineOutput.ts:79-86`).

**Verdict: partial — real path tracing, but the rendered product output cannot show "encode(payload) → sign(secret) → createSession(token)" per hop without the agent re-reading files.**

## Memory/session parity

A deep product subsystem, not benchmark scaffolding: `src/observations/` + SQLite repositories.

- Auto-capture of tool calls: yes — `src/observations/autoCapture.ts:24`, invoked best-effort from capsule/impact/flow/skeleton/memory MCP handlers (`src/mcp/tools.ts:5446-7687` call sites).
- Stale flags on linked code change: yes — `src/observations/staleness.ts:22-80` from index-run file/symbol diffs; capsule staleness via `src/memory/computeCapsuleStaleness.ts` + `check_capsule_staleness`.
- Consolidation, anti-patterns (file thrashing, symbol added-then-removed), save_observation nudges, session compression: all present (`consolidation.ts:17`, `antiPatterns.ts:19-22`, `observationNudges.ts:167-184`, `sessionLifecycle.ts`).
- Automatic capsule inclusion: yes — `run_pipeline` memory section with `vexp:session:`/`vexp:memory:` refs (`runPipelineOrchestrator.ts:992-1131,1273-1346`); capsule v1 selects up to 3 memories by symbol/file/term/intent overlap (`src/capsule/selectCapsuleMemories.ts:19-28`).
- Scoring breakdown: present but weaker than VEXP's model — fixed-weight substring/term-overlap signals with stalePenalty 30 (`src/observations/searchMemory.ts:21-34`); **no BM25/TF-IDF, no recency decay, no graph-proximity** in memory scoring (those exist only in code retrieval).
- Feedback loop (repeated queries expand budget): **missing** — `repeatedQueryTerms` is tracked in session summaries (`src/observations/types.ts:190`) and repeated-search waste is flagged diagnostically (`src/capsule/toolCallLog.ts:96-153`), but nothing feeds back into pool size, weights, or budget.

**Verdict: partial-to-complete — broader than expected; the gaps are scoring sophistication and retrieval adaptation, not existence.**

## LSP bridge parity

**Missing.** Zero repo-wide hits for `submit_lsp_edges`, "language server", or "type-resolved". The VS Code extension is a thin CLI shell (`vscode-extension/package.json:5`, `extension-main.js:1-50`) with no LSP client. No MCP tool ingests externally computed edges (`src/mcp/types.ts:11-33`). All call edges come from internal static parsing, which the TS parser keeps deliberately conservative.

## Passive observation parity

Exists as product, with mechanical differences from the VEXP description:

- Watcher: 1s stat-polling with 500ms debounce and snapshot diffing, optional auto-reindex (`src/runtime/fileWatcher.ts:24-32,321-524`) — not event-based.
- Hashing: sha256 (`src/indexer/indexMeta.ts:207`), not blake3 — functionally equivalent for change detection.
- Structural diffs: `src/memory/computeFileDiff.ts` / `computeSymbolDiff.ts` — Added/Removed/Modified/Unchanged; "modified" detects signature/exported/parent/line changes (`computeSymbolDiff.ts:153-168`) but **no Renamed type and no signature-changed vs body-changed vs visibility-changed classification**.
- Correlation/promotion: watcher feeds file-thrashing anti-patterns (`antiPatterns.ts:37-56`); recurring observation evidence promotes into project rules at threshold 3 (`src/projectRules/projectRules.ts:37-49`), rules surface in capsules and `run_pipeline`. Direct per-tool-call↔file-change correlation beyond anti-patterns does not exist.

**Verdict: partial — real and wired end-to-end (watch → diff → observation → rule → capsule), missing rename/sig-vs-body classification and event-based watching.**

## Token-reduction implications

The Stage 5 evidence says VTRACE's token problem is **turn count, not prompt size**:

- 96% of summed positive token deltas were cache-read amplification from extra agent turns; injected context maxed at ~3,007 tokens (`results/stage5_token_path_audit.md`). Worst case matplotlib-22719: +132.7% tokens across 30 tool calls despite strong capsule context.
- Measured first-pass reduction after strict gating: **25.24%** tokens / 8.16% cost on the controlled 10-task set (`results/stage5_token_reduction_vs_recovery.md`) — far from the "up to 74%" headline, and the pre-gating first pass was a regression (+1.9% tokens, +17.6% cost).

The parity gaps map directly onto this: VEXP's design suppresses turns by making one call answer the next three questions (full pivot + skeletons + impact callers with code + flow with code + memory, with token/latency feedback). VTRACE's MCP capsule returns less per call (v1, char-budgeted, gated impact/flow, no per-hop/per-caller code), so the agent goes back to Read/Grep/Bash — the exact behavior the token-path audit measured. The highest-leverage token work is therefore: capsule v2 on MCP, per-hop/per-caller excerpts, ungated (but bounded) impact/flow inclusion, and product-path token/latency feedback so agents (and benchmark policies like `STAGE5_TOKEN_DISCIPLINE`) can act on it.

## Resolution-quality implications

- Strict-gated VTRACE resolved 7/10 vs baseline 8/10 (`results/stage5_policy_accounting.md`); the old first pass resolved 5/10. Fewer tokens has not implied better resolution.
- Resolution risk concentrates where context is incomplete or wrong-grained: conservative TS call edges (no LSP bridge), no per-hop flow code (agent reasons over FQN chains), gated impact sections (refactor-like queries only), JS/Go/Rust/Markdown blind spots, and exception-symptom/anchoring heuristics that strict gating already had to patch.
- The single verified resolution recovery (astropy-14369 generated-parser repair, ~$3.00) is benchmark-internal control-loop machinery (`results/stage5_control_loop_status.md`) and should not be counted as product resolution capability.

## Benchmark-readiness implications

Running the 100-task validation now would measure the current MCP surface — capsule v1, no token feedback, gated impact/flow — and would burn a large budget to reconfirm what the 10-task set already showed (turn-count amplification, ~25% reduction). The product changes most likely to move both token reduction and resolution (Milestones 1-4 below) are cheap relative to a 100-task run and each is verifiable on the existing telemetry and on the 4 known overhead cases (matplotlib-22719, astropy-14369, django-10880, django-11095 — the latter two also need ordered telemetry capture, which the token-path audit flagged as missing).

## Thin wrappers vs full implementations

- **Full implementations (product-grade):** impact graph traversal, logic-flow path search (engine, not rendering), hybrid retrieval/ranking (FTS5+BM25+centrality+penalties), capsule v2 builder, skeleton generator, observations/memory subsystem, project rules, watcher/daemon, intent classification (two systems: `src/intent/` routing profiles and `src/capsuleV2/intent.ts` strategy planner).
- **Thin wrappers:** `get_code_context` (freshness gate + delegate to `run_pipeline` — by design); the VS Code extension (CLI shell — by design); capsule v2's `Skeleton` content mode (name-only, no structure).
- **Benchmark-only:** ordered tool telemetry (`src/capsule/toolCallLog.ts:1-15` — "telemetry only"), turn-count waste scorer (`src/capsule/turnCountWaste.ts`), tokens-saved accounting, latency/duration measurement, repair/critic control loop, cost caps. None are in the MCP product path.
- **Missing:** LSP bridge / `submit_lsp_edges`, feedback-loop budget expansion, JS/Go/Rust parsers, Markdown indexing, rename/sig-vs-body structural diff classes, latency instrumentation, tokens-saved in product output, `implements` edge type.

## Top implementation milestones

### Table 3 — Ranked implementation roadmap

| Rank | Milestone | Expected token impact | Expected resolution impact | Files likely touched | Validation method | Why before 100-task benchmark |
|---|---|---|---|---|---|---|
| 1 | Wire capsule v2 into MCP `get_context_capsule`/`run_pipeline`: token-budgeted pivots (full source) + signature supports + structured skeletons in v2 + impact/memory sections in one response | High — richer first call removes follow-up Read/Grep turns, the measured 96% cache-read driver | Positive — better-ranked pivots (v2 ranking) reach the agent | `src/mcp/tools.ts`, `src/runPipeline/runPipelineOrchestrator.ts`, `src/capsuleV2/buildCapsuleV2.ts`, `src/capsuleV2/types.ts` | mcp.test.ts golden outputs; replay the 4 known overhead cases and count tool turns | The 100-task run would otherwise measure the v1 path that the 10-task set already showed regressing |
| 2 | Tokens used / tokens saved / latency in every product tool response (productize benchmark accounting; baseline = naive full-file read cost of the same symbols) | Medium directly; high indirectly — enables turn-discipline policies and honest claims | Neutral | `src/mcp/tools.ts`, `src/capsuleV2/tokens.ts`, new `src/metrics/`; `formatRunPipelineOutput.ts` | Unit tests on accounting math; assert fields present in all visible tool responses | Without per-call accounting, the 100-task run cannot attribute savings to tools vs agent behavior |
| 3 | Per-hop code excerpts in `search_logic_flow` and per-caller excerpts in `get_impact_graph` (line spans + bounded snippets, VEXP-style) | Medium — one avoided Read per hop/caller inspected | Positive — agent sees actual call sites, not FQN chains | `src/logicFlow/searchLogicFlow.ts`, `src/impact/getImpactGraph.ts`, `src/runPipeline/formatRunPipelineOutput.ts` | searchLogicFlow.test.ts / impact tests extended with snippet assertions | Flow/impact answers without code currently trigger the exact re-read loops the token audit measured |
| 4 | Turn-reduction validation on the 4 known overhead cases (matplotlib-22719, astropy-14369, django-10880, django-11095) with milestones 1-3 active + ordered telemetry captured for all runs | Validation, not reduction — confirms the causal story | Validation | `benchmarks/stage5_vexp_swe_bench_smoke/` runner config only | Paired reruns of 4 tasks; compare tool-call counts and cache-read tokens vs `stage5_token_path_audit` rows | Cheapest possible falsification of "richer single call → fewer turns" before paying for 100 tasks |
| 5 | Unify intent routing (merge `src/intent/` profiles with `src/capsuleV2/intent.ts` strategies) so debug/blast-radius/modify modes drive the MCP path end-to-end, incl. ungating impact for refactor intent | Medium — right strategy on first call | Positive — blast-radius mode currently requires magic trigger phrases | `src/intent/`, `src/capsuleV2/intent.ts`, `runPipelineOrchestrator.ts:627-685` | Intent classifier tests + golden run_pipeline outputs per intent | Intent-mismatched first calls are a silent turn multiplier |
| 6 | Register the JS parser (tree-sitter-typescript already parses JS) and index Markdown sections into FTS | Low on the Python-heavy smoke set; medium on real repos | Positive on JS/docs-heavy tasks | `src/indexer/indexProject.ts:221-244`, `src/parsers/`, `src/db/schema.ts`, `src/capsuleV2/docRetrieval.ts` | Parser unit tests; index counts on a JS fixture repo | 100-task sets include non-Python repos; JS files currently fail `unregistered_language` |
| 7 | Memory scoring upgrade: recency decay + graph proximity + reuse of the existing BM25 component | Low-medium | Slightly positive | `src/observations/searchMemory.ts`, `src/retrieval/hybridScoring.ts` | observations.test.ts scoring-breakdown tests | Not blocking; do after 1-5 |

## What to finish before 100-task validation

Recommendations on the ten candidate items:

1. **First-class `get_context_capsule` output shaped like VEXP examples — yes, implement first (Milestone 1).** The tool exists; the gap is v2 wiring, output shape, and single-call completeness.
2. **First-class `get_skeleton` tool — no new work needed.** Already a product tool (`src/mcp/tools.ts:7637`). Fold structured skeletons into capsule v2 supports as part of Milestone 1.
3. **First-class `get_impact_graph` tool — no new tool needed; add caller excerpts (Milestone 3).** The traversal is complete.
4. **Better `search_logic_flow` output — yes (Milestone 3).** Engine is sound; per-hop code lines are the missing product half.
5. **Session memory / `search_memory` / `save_observation` product tools — already exist; do not block on them.** Scoring upgrade (Milestone 7) can come after validation.
6. **LSP bridge ingestion — no, defer.** Highest-cost, lowest-evidence item for the current Python-leaning benchmark population; revisit when TS/JS task share grows.
7. **Passive observation / structural diff — no, defer.** Subsystem exists end-to-end; rename/sig-vs-body classes are polish, not token levers.
8. **Token saved / latency accounting in normal context calls — yes (Milestone 2).** Prerequisite for attributing anything in a 100-task run.
9. **Stronger intent routing — yes, scoped (Milestone 5).** Both systems exist; unify and ungate rather than build new.
10. **Tool-turn reduction validation on known overhead cases — yes, mandatory gate (Milestone 4).** Cheapest falsification step; also fills the django-10880/11095 telemetry hole.

Gate for starting the 100-task run: Milestones 1-4 done, and the 4-case rerun shows tool-turn counts and cache-read tokens moving in the right direction with no resolution loss.

## What not to do yet

- Do not run the 100-task benchmark until the product-surface gaps above are addressed and the 4-case turn-reduction validation passes — it would re-measure the known turn-count amplification at 10x the cost.
- Do not optimize only around the 10-task smoke set; Milestones 1-3 are product changes that generalize, and the 100-task set will include languages the smoke set does not cover.
- Do not make repair/cost controls user-facing; the control loop is single-instance-verified benchmark machinery (`results/stage5_control_loop_status.md`) and `userFacingRepairCostControls=false` should stay false.
- Do not claim VEXP parity from internal benchmark reports alone; Stage 5 explicitly states it is not a VEXP comparison, and the vexp-enabled condition never runs by default.

## Non-claims

- This audit does not claim VTRACE matches or beats VEXP on tokens, latency, or resolution; no head-to-head was run, and the VEXP capability model audited here is taken from product/website descriptions, not from inspecting VEXP's implementation.
- No new benchmark numbers were produced; all quantitative statements are quoted from existing Stage 5 reports (token-path audit, turn-count reduction, token-reduction-vs-recovery, policy accounting, control-loop status).
- Status labels reflect the working tree on 2026-06-12; the root-level `VTRACE_TOOLING_AUDIT.md` is partially outdated (logic flow does traverse call edges; capsule manifests are persisted) and was not relied on where it conflicts with source.
- "Complete" labels are scoped to the audited VEXP behavior list, not to general production-readiness; documented limitations (exact-FQN resolution, static-only edges, chars/4 token estimates) remain.
- No claim is made about VEXP's actual internals (e.g., whether its "tokens saved" baseline methodology is comparable to anything VTRACE could report).

