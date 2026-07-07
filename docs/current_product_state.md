# Current VTRACE Product State

_Last reconciled: 2026-07-07 (milestone M109; benchmark-interpretation and
next-milestones sections only — capability sections below were last
re-verified against `src/` on 2026-07-01 at M93A). This document is the
single plain-truth surface for "what VTRACE can and cannot do today." It
supersedes the stale claims in `VTRACE_TOOLING_AUDIT.md` (2026-06-04)
wherever the code has since moved._

## What VTRACE is

- A **deterministic, repo-local structural context engine**. It reads a codebase
  once, builds a SQLite index of symbols and their relationships, and for a task
  description hands back the smallest useful slice of code instead of whole files
  or broad grep dumps.
- **Strongest path: Python-heavy repositories.** Python has the deepest static
  analysis (calls, references, member/`self`/`super()` resolution, cross-file
  inheritance).
- **Core pipeline:** `index → retrieval → capsule → run_pipeline` (with impact,
  logic-flow, memory, and rules as conditional sections). Same repo + same query
  ⇒ byte-identical answer.
- **Local-first:** the whole index lives in `.vtrace/index.sqlite` inside the
  repo; nothing is sent to a remote indexing service.

## What VTRACE is not

- **Not a semantic oracle.** Retrieval is heuristic lexical (SQLite FTS5) plus a
  shallow graph rerank. There are **no embeddings** anywhere.
- **Not a dynamic call graph.** All edges are static, from the parsed AST. No
  runtime tracing, no dataflow, no dynamic-dispatch truth.
- **Not a multi-language complete blast-radius engine.** Call/reference coverage
  is real for Python, conservative for TypeScript and Cython, and absent for
  everything else (see the language matrix).
- **Not equivalent to the Stage 5 harness.** Stage 5 is an integrated,
  downstream agent-in-the-loop SWE-bench validation. It is not the deterministic
  core, and its numbers are not a public SWE-bench pass@1 claim.

## Core implemented surfaces

All are real, engine-backed, and tested. Thin CLI/MCP adapters sit over shared,
tested engines (legitimate thinness, not hidden emptiness).

| Surface | Reality |
| --- | --- |
| **CLI** (`src/cli/index.ts`) | 24 commands; product-shell (setup/status/doctor/watch/daemon/workspace) + direct inspection (index/intent/capsule/run-pipeline/skeleton/impact-graph/handoff/check-capsule/compress-sessions/…). |
| **MCP server** (`src/mcp/`) | Visible tools: `get_code_context`, `run_pipeline`, `get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`, `index_status`, `workspace_setup`, `get_session_context`, `search_memory`, `save_observation`, `expand_vexp_ref`. Hidden-but-callable legacy/internal tools include `check_capsule_staleness`, `search_symbols`, `list_sessions`, `read_session`. |
| **run_pipeline** | Real orchestrator (`runPipelineOrchestrator.ts:316`): retrieval + impact (conditional) + flow + memory + rules + deferred V-REFs; compact output, honest per-section skip reasons. |
| **get_context_capsule** | Real source-backed capsule with SHA-256 freshness gating before emitting `Full` source. |
| **get_impact_graph** | Reverse-dependent, exact-FQN, depth-bounded BFS over `contains/imports/calls/references`. Conservative static evidence — **not** runtime reachability or dynamic dispatch. Its own coverage block says so. |
| **search_logic_flow** | Bounded static path(s) between two exact FQNs over `contains`, `imports`, and statically-resolved `calls` edges (`SUPPORTED_EDGE_TYPES` includes `Calls`). Reports `callFlowEvidenceAvailable`; when false the result is containment/import-only. **Not** a runtime/semantic call-path tracer. |
| **get_skeleton** | AST outline of a file at a chosen detail level. |
| **Indexing** | `scanRepo → parser dispatch → persist`. Honors `.gitignore`/`.ignore`/`.vtraceignore`; prunes deleted files' symbols/edges on reindex; freshness fingerprint includes a hash of the parser code + git HEAD. |
| **Memory** | Observations (`save_observation`/`search_memory`/`get_session_context`), staleness flagging, capsule-memory surfacing, and project rules. Session compression + passive consolidation **are** invoked in production (below). |

### Capsule-manifest staleness — now wired (was audit blocker B1)

`get_context_capsule` and `run_pipeline` persist a deterministic capsule manifest
on every non-empty capsule build over an indexed repo, and surface its id
(`get_context_capsule` → top-level `capsuleManifestId`; `run_pipeline` →
`context.capsuleManifestId`). That id resolves through the `check_capsule_staleness`
MCP tool / `vtrace check-capsule`. The audit's "store production never writes"
finding is **no longer true** (`persistCapsuleManifestBestEffort`,
`runPipelineOrchestrator.ts:368`, `tools.ts:8093`; round-trip tests
`mcp.test.ts:854, 1156, 1609, 1665`).

### Session compression / passive consolidation — now wired (was audit blocker B-dead)

Both run in production through **bounded, deterministic triggers** — there is **no
always-on daemon or scheduler**:

- **Explicit CLI command:** `vtrace compress-sessions <repo> [--idle-hours N]
  [--limit N] [--dry-run] [--json]` (`compressSessionsCommand.ts`).
- **Bounded reindex sweep:** every successful reindex compresses up to the first
  20 inactive-past-threshold sessions (`reindexRepo.ts:131` →
  `compressInactiveSessions`).

Passive consolidation is intentionally narrow: it merges repeated `mcp_auto`
`tool_call` observations that share a deterministic lexical/structural signature
(default threshold ≥ 3). It uses **no** embeddings, semantic similarity, LLM
merging, or cross-session merging. Durable observations are never consolidated.

## Known limitations

### Language / edge coverage matrix (verified 2026-07-01)

| Language | Parser | `contains` | `imports` | `calls` | `references` | Status |
| --- | --- | :-: | :-: | :-: | :-: | --- |
| **Python** | CPython `ast` (subprocess) | ✓ | ✓ | ✓ | ✓ | Strongest — deepest call/ref/member/inheritance evidence. |
| **TypeScript** | tree-sitter | ✓ | ✓ | ✓ (conservative) | ✓ | Same-file / exactly-imported callables, `this.method`, same-file `ClassName.method`; arbitrary object receivers skipped. |
| **Cython** | tokenizer (subprocess) | ✓ | ✓ | ✓ (conservative) | ✓ | Top-level `cdef class` + `def/cdef/cpdef` methods; conservative calls/refs. Narrow. |
| **JavaScript** | none registered | ✗ | ✗ | ✗ | ✗ | Detected by extension (`.js`/`.jsx`) but **no registered parser** → `unregisteredLanguage`; scanned, not parsed. |
| **Go** | none | — | — | — | — | Dead enum value; never implemented. |
| **Rust** | none | — | — | — | — | Dead enum value; never implemented. |

Note: TS/Cython **do** now emit `calls` edges (`typescriptParser.ts:634`,
`cythonParser.ts:1482`) — the older audit's "Python-only calls" claim is stale.

### Other accepted limitations

- **Character-based budgeting, not token-based.** The only capsule budget model is
  `CapsuleBudgetModel.CharacterCount`. Reported "tokens" are a `chars / 4`
  approximation (`capsuleV2/tokens.ts`), **not** a model-specific tokenizer. The
  README's benchmarked "fewer tokens" figures describe measured agent-side token
  savings from delivering less code; they are not a claim of tokenizer-accurate
  internal budgeting.
- **Impact/retrieval are Python-biased and structural-only** — already stated in
  each tool's own coverage block.
- **`@ts-nocheck` debt.** A set of core files (incl. `mcp/tools.ts`, parsers, the
  indexer, capsule builder) still carry `@ts-nocheck`; `tsc` is green partly by
  exclusion. Scheduled debt, deferred (see M-series follow-ups); not a correctness
  claim regression.
- **`edges.confidence` is effectively a constant** (`1`) across parsers.
- **Handoff has no file export** — `vtrace handoff` prints JSON to stdout only.
- **Protocol adapters** are experimental scaffolding — not CLI/MCP-exposed, and
  intentionally undocumented as a product feature.
- **V-REFs / deferred payloads** are bounded, exact-lookup only; multi-repo
  `run_pipeline` emits no deferred items.

## Benchmark interpretation

- **M92 core VTRACE token-reduction confirmation (50/50 valid):** resolution
  preserved vs baseline (20/50 vs 20/50); cost **−25.0%**, tokens **−26.7%**, tool
  calls **−30.2%**; safety clean; V4/C7_D disabled. This is the headline
  core-reduction evidence.
- **Stage 5 is integrated downstream validation, not the deterministic-core
  scoreboard.** It runs a real agent turn loop; its resolution counts are subject
  to live variance and are **not** a public SWE-bench pass@1 claim.
- **V4 (tool-loop guard) and C7_D (cost guard) are default-off diagnostics.**
  Across M82/M85/M88/M90/M91 they were harmless but showed **no** resolution
  benefit (V4 fires reactively; C7_D fires neutral-late on cap targets). They are
  **not** part of the core token-reduction path.
- **Env guard + agent shell guard are mandatory Stage 5 live safety.** The M89 env
  guard fails closed unless the agent uses a disposable testbed interpreter; the
  M90A shell guard / host-pip firewall blocks host/base Python mutation. Both are
  mandatory fail-closed safety infrastructure, not behavioral experiments.
- **M94→M103 deterministic scoreboard (gold-blind, pre-agent, no live runs):**
  the M95–M103 chain improved the pre-agent scoreboard from M94 to M103,
  including higher recall (recall@5 .637→.748), capsule coverage (all-gold
  60.6%→75.0%), lead-pivot quality (source-gold lead 45.5%→59.0%), multi-file
  all-gold coverage (6.7%→53.3%), and structured task evidence handling — at
  flat median capsule size. Accepted cost: overpacked capsules 7→14. See
  `benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m109_final_internal_summary.md`.
- **M105–M108 live confirmation (internal, integrated, guarded):** on the
  frozen internal 100-case Stage 5 pool, the current default VTRACE path
  produced 97 valid guarded live runs, with 55 resolved patches (56.7% of
  valid live runs). Three cases were pre-registered no-context exclusions
  under the parity contract. Across the 97 valid runs the path was
  leak-clean: zero model-visible FAIL_TO_PASS/PASS_TO_PASS/gold-patch
  leakage, zero fallback-context fires, zero unguarded env/shell runs, zero
  host-pip mutation escapes. **This is an internal live confirmation, not a
  public SWE-bench pass@1 claim and not a VEXP parity claim.**

## Next product milestones

- **Default path frozen at M109** (M95–M104 chain + structured task
  derivation + live-path parity). No further live benchmark spend until the
  captured-artifact analysis questions are exhausted (hard-stratum
  agent-variance losses, multi-file patch-shape levers).
- Deterministic residue work only if evidence grows: no-context cases (3/100),
  miss-class pool recall (mined-out per M100), overpacking (packing lever).
- Token-attribution optimization (and, longer term, tokenizer-accurate budgeting).
- Incremental removal of `@ts-nocheck`; TypeScript call/reference graph depth;
  `.gitignore` refinements. All deferred beyond M93A.
