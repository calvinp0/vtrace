# vtrace — Local Deterministic Code Indexer
## Presentation Outline

---

### 1. The Problem

- AI coding assistants lack structural understanding of codebases
- Naive search (grep, file matching) misses relationships between symbols
- Context windows are finite — you can't dump an entire repo into a prompt
- Without intent awareness, the same query returns the same results regardless of task

---

### 2. What is vtrace?

- A local, deterministic code indexer that builds **structural intelligence**
- Parses source code with Tree-sitter into symbols and edges (contains, imports)
- Classifies user intent to shape what context gets surfaced
- Assembles budget-aware "capsules" of the most relevant code
- Exposes everything via an MCP server for AI tool integration

**Key principles:** deterministic, inspectable, structural, budget-aware, intent-driven

---

### 3. Architecture Overview — The 9 Layers

```
User Query
  → Layer 4: Intent Classification
  → Layer 2: Symbol Search (lexical + FTS)
  → Layer 2: Graph Reranking
  → Layer 5: Capsule Profile Selection
  → Layer 1: Capsule Building (pivots + support)
  → Layer 8/9: Observation Memory Surfacing
  → Layer 6: Agent Handoff Payload
  → MCP Server Response
```

---

### 4. Layer 1 — Indexing

- Tree-sitter parses TypeScript, Python, Cython into ASTs
- Extracts symbols: functions, classes, methods, interfaces, type aliases
- Builds edges: `Contains` (structural nesting) and `Imports` (module dependencies)
- Content-addressed IDs via SHA256 — same code always produces same identity
- SQLite storage with FTS5 for full-text search

**Tech:** Bun runtime, tree-sitter, bun:sqlite

---

### 5. Layer 2 — Retrieval & Ranking

- Two search backends: plain SQL (precise) and FTS5 (fuzzy)
- Ranking signals: boundary boosts, broad query boosts, test-aware downweighting
- Graph-based reranking: in-degree, out-degree, neighborhood connectivity
- Symbols connected to already-matched candidates get boosted

**Key insight:** Structure-aware ranking surfaces the *right* symbols, not just matching ones

---

### 6. Layer 3 — Memory & Staleness

- Tracks file and symbol diffs across index runs
- Detects additions, removals, modifications
- Capsule staleness detection: has the code a capsule references changed?
- Enables incremental re-indexing — only process what changed

---

### 7. Layer 4 — Intent Classification

- Rule-based classifier: **Debug**, **Refactor**, **Explain**, **Feature**
- Each intent selects a different routing profile
- Profiles control: search backend, candidate pool size, graph reranking weights
- Same query, different intent → different results

**Example:**
- "handleAuth" as Debug → tight focus, error paths
- "handleAuth" as Refactor → broad structural context

---

### 8. Layer 5 — Capsule Profiles

Four profiles tuned to intent:

| Profile | Focus | Compression | Support |
|---------|-------|-------------|---------|
| DebugTight | Minimal, focused | High | Narrow |
| RefactorStructural | Broad structure | Balanced | Wide |
| ExplainStable | Full content | Low | Minimal |
| FeatureBalanced | Extension-aware | Balanced | Medium |

---

### 9. Capsule Assembly

- **Pivots**: Primary search results (the code you asked about)
- **Support**: Structural dependencies, related symbols
- Content modes: Full, SignatureOnly, Summary, Stub
- Character budget enforcement with compression fallbacks
- Every inclusion carries a reason (why this code was selected)

---

### 10. Layers 8-9 — Observation Memory

- Stores decisions, insights, warnings, dead ends from sessions
- Observation kinds: `decision`, `insight`, `warning`, `dead_end`, `tool_call`
- Links observations to specific files, symbols, and FQ names
- Surfaces relevant observations inside capsules
- Staleness tracking: observations can expire when code changes

---

### 11. Layer 6 — Agent Handoff

- Packages capsule into a deterministic `HandoffPayload`
- Includes: query, intent, capsule items, metadata, provenance, trust info
- Designed for passing context to downstream AI agents/tools
- Protocol adapters (Layer 7) handle serialization formats

---

### 12. MCP Server Interface

Exposed tools:
- `index_repo` — Index a repository
- `search_symbols` — Search code symbols
- `route_query` — Classify and route a query
- `build_capsule` — Assemble context capsule
- `build_handoff` — Package for agent handoff
- `check_capsule_staleness` — Detect stale context
- `save_observation` / `search_memory` — Observation CRUD

---

### 13. Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun |
| Language | TypeScript |
| Parsing | Tree-sitter |
| Database | SQLite (bun:sqlite) + FTS5 |
| Protocol | MCP (Model Context Protocol) |
| Supported langs | TypeScript, Python, Cython |

Zero external service dependencies — fully local, fully deterministic

---

### 14. Design Decisions Worth Highlighting

- **Content-addressed IDs**: SHA256 hashing means identical code always maps to the same identity — enables diffing, caching, deduplication
- **Budget-aware assembly**: Character budgets prevent context overflow; compression degrades gracefully (full → signature → summary → stub)
- **Explainability throughout**: Every search result has match explanations, every capsule item has inclusion reasons, every classification has matched rules
- **No ML in the loop**: Rule-based intent classification — fast, predictable, testable, no model dependency in the indexing path

---

### 15. What's Next

- Additional language support (Go, Rust parsers — enums defined, not yet implemented)
- Tree-sitter grammar expansion
- Cross-repository graph analysis
- Richer observation memory and session continuity

---

### Appendix: Data Flow Diagram

```
  [Source Files]
       |
  Tree-sitter Parse
       |
  [Symbols + Edges]
       |
  SQLite + FTS5
       |
  ┌────┴────┐
  │  Query  │
  └────┬────┘
       |
  Intent Classify ──→ Routing Profile
       |
  Symbol Search (SQL/FTS)
       |
  Graph Rerank
       |
  Capsule Profile ──→ Budget + Compression
       |
  Capsule Assembly (Pivots + Support)
       |
  Observation Surfacing
       |
  Handoff Payload
       |
  MCP Response
```
