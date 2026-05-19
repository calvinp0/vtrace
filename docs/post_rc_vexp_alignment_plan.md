# Post-RC VEXP Alignment Plan Without ARC Overfitting

Date: 2026-05-19

This is a planning document only. It does not change product behavior, CLI behavior, MCP schemas, ranking, indexing, or VS Code panel behavior.

## Executive Summary

VTrace is RC-ready as deterministic lexical/structural repo-local tooling with CLI, MCP, memory/session, watcher freshness, V-REF, and project-rule surfaces.

VTrace is not full VEXP parity. The current product truth remains explicit: V-REFs are exact and repo-local with bounded stored-truth persistence, the watcher is mark-stale-only by default with optional visible auto-reindex, memory and rules are deterministic rather than semantic, and graph behavior is bounded structural analysis rather than runtime or dataflow truth.

The next phase should improve general-purpose graph intelligence, continuity, and product feel. Persistent stored-truth V-REFs and optional auto-reindexing are implemented as continuity milestones; the remaining highest-leverage work is richer static symbol/reference extraction, broader generic retrieval benchmarks, and panel polish.

ARC may be used as one real-repo benchmark, but it must not define product behavior. ARC is a stress test, not the destination.

## Current VEXP-Alignment Status

| Area                      | Current VTrace behavior                                                                        | VEXP-like target                                                      | Alignment status      | Main gap                                                         | Recommended post-RC action                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `run_pipeline`            | Deterministic orchestration with intent, capsule, impact, memory, freshness, rules, and V-REFs | Broad task entrypoint that feels continuous and context-aware         | Aligned enough for RC | Continuity is bounded by V-REF retention and retrieval limits    | Improve graph intelligence and benchmarks                       |
| V-REF expansion           | Exact 12-hex stored payload expansion with process hot cache and repo-local persistence        | Stable deferred expansion across sessions and product surfaces        | Improved              | Bounded retention; no multi-repo deferred expansion parity       | Monitor usage before expanding retention or multi-repo support  |
| Watcher/freshness         | Optional polling watcher marks stale by default; `--auto-reindex` opts into visible reindexing | Optional live freshness loop with visible state and safe recovery     | Improved              | No always-on daemon; bounded polling behavior                    | Monitor before adding config/daemon-driven policies             |
| Session lifecycle         | Explicit compression/consolidation services and searchable summaries                           | Durable continuity across work sessions                               | Partially aligned     | No scheduler; session binding is input-dependent                 | Keep explicit; revisit scheduling only after persistence work   |
| Memory search             | Deterministic lexical/structural observation search                                            | Useful durable memory retrieval across related work                   | Aligned enough for RC | No semantic recall or learned ranking                            | Validate with memory/rule query benchmarks before tuning        |
| Anti-pattern detection    | Conservative structural detectors for file thrashing and adjacent symbol add/remove            | Useful recognition of repeated dead ends and workflow loops           | Partially aligned     | Narrow detector set; no semantic stuck detection                 | Extend only with deterministic evidence-backed detectors        |
| Project rules             | Explicit candidate generation, manual promotion, active guidance capped and deterministic      | Project conventions become visible guidance without unsafe automation | Aligned enough for RC | No auto-promotion, no cross-repo rules                           | Keep manual promotion; improve visibility before automation     |
| Impact graph              | Exact-FQN bounded structural reverse dependencies                                              | Useful static impact view across modules and class/member boundaries  | Partially aligned     | Python references, members, inheritance, and modules are limited | Add module, reference, member, and inheritance graph extraction |
| Broad retrieval/reranking | Lexical/FTS plus graph reranking and capsule shaping                                           | General-purpose high-quality retrieval across repo types              | Partially aligned     | Benchmark coverage is narrower than future tuning needs          | Build broader generic benchmarks before retrieval tuning        |
| VS Code panel             | Existing shell/panel flow around setup, status, pipeline, and V-REFs                           | Clear product-feel surface for freshness, refs, rules, and setup      | Partially aligned     | UX clarity and visibility gaps                                   | Polish existing panel without panel-only hidden behavior        |
| Setup / agent config      | `setup`, `status`, `workspace_setup`, Codex/Claude Code config compatibility                   | Clear onboarding for supported local coding agents                    | Aligned enough for RC | `claudeCode` compatibility field remains in schema               | Rename only in future schema version, not as roadmap blocker    |

## Anti-Overfit Policy

ARC is a real-repo stress test, not the product target.

The anti-overfit rules from [`docs/validation_strategy.md`](./validation_strategy.md) remain binding for post-RC work:

- No ARC-specific constants or special cases in retrieval, ranking, indexing, capsule, memory, or rule code.
- ARC-specific terms may appear only in benchmark fixtures, validation reports, or docs identifying ARC as a benchmark.
- Every ARC-motivated implementation change must be restated as a general-purpose improvement.
- Future milestones must use synthetic fixtures and at least one non-ARC validation target where practical.
- ARC can expose gaps, but ARC findings should be classified before code changes are proposed.
- Do not tune ranking solely to one repo's names, package layout, or domain vocabulary.
- Keep RC limitations visible instead of hiding them behind benchmark-specific behavior.

## Recommended Milestone Sequence

1. Persistent V-REF Store — implemented for single-repo stored-truth expansion with bounded repo-local retention.
2. Optional Auto-Reindex Mode — implemented as explicit `watch --auto-reindex`.
3. Module-Level Constants, Variables, and Aliases
4. Python References Extraction
5. Python Member/Attribute Resolution
6. Inherited-Member and `super()` Resolution
7. Broader Generic Retrieval/Reranking Benchmarks
8. VS Code Panel Polish

This order first closes visible product-feel gaps without changing retrieval ranking, then improves static graph intelligence, then creates broader benchmark coverage before additional retrieval tuning, and finally polishes the user-facing panel once the underlying behavior is clearer.

## Milestone 1 — Persistent V-REF Store

### Purpose

Persist deferred V-REF payloads as stored truth across MCP server restarts and CLI invocations, while preserving exact lookup semantics.

Implementation status: completed for single-repo deferred V-REFs. Payloads are stored in repo-local SQLite tables under `.vtrace`, with a process-local hot cache retained for same-server expansion.

### Why This Improves VEXP Alignment

Current V-REFs are exact, bounded, and repo-local. Persistent storage makes deferred expansion feel continuous across agent sessions, editor actions, and CLI debugging without requiring `--query` republish while a ref is retained.

### General-Purpose Value

This closes a product continuity gap without changing retrieval/ranking behavior or introducing ARC-specific tuning. Any repository benefits from stable stored expansions when an agent or user wants to inspect deferred context later.

### Scope

- Preserve current exact 12-hex hash behavior.
- Store the actual emitted payload, category, stable id, repo identity, created time, last accessed time, and expiration metadata.
- Store payloads in repo-local SQLite tables near the existing `.vtrace/index.sqlite` schema and repositories.
- Associate V-REFs with run/session ids when available.
- Define expiration and cleanup policy by capacity.
- Keep stored-truth expansion: resolve the stored payload as emitted, even if source files later changed.
- Keep structured failure modes for malformed, unknown, expired, and unsupported refs.

Likely files/modules to inspect:

- `src/runPipeline/deferredVexpStore.ts`
- `src/runPipeline/formatRunPipelineOutput.ts`
- `src/runPipeline/runPipelineOrchestrator.ts`
- `src/mcp/tools.ts`
- `src/mcp/expandVexpRef.test.ts`
- `src/cli/commands/expandVexpRefCommand.ts`
- `src/db/schema.ts`
- `src/db/sqlite.ts`
- `src/db/repositories/*`
- `src/setup/repoState.ts`

### Non-Goals

- No fuzzy lookup.
- No semantic reconstruction.
- No hidden recomputation pretending to be stored truth.
- No ranking changes.
- No full VEXP parity claim.
- No requirement that V-REFs live forever.

### Validation Requirements

- Synthetic V-REF fixture proving stored payload expands after a new process/server instance.
- Test that expansion after source edits returns the originally stored payload.
- Expiration/cleanup tests for old or capacity-evicted refs.
- CLI test proving `expand-vexp-ref` can resolve a persisted ref without `--query` once persistence exists.
- MCP test proving same-process behavior remains compatible.
- Non-ARC repo fixture; ARC may be an optional smoke test only.

### Anti-Overfit Guardrails

- Hashing and storage keys must not include repo-specific name heuristics.
- Payload persistence must be based on emitted deferred items, not special handling for one benchmark.
- Do not recompute missing refs from queries, filenames, or symbols unless explicitly labeled as a new non-stored mode in a future milestone.

### Exit Criteria

- V-REF expansion remains exact and deterministic.
- Process-local behavior still works.
- Persisted refs survive restart within documented retention limits.
- Expired refs fail honestly.
- Docs clearly distinguish persisted stored truth from semantic reconstruction.

Implemented retention policy: keep up to 1000 persisted V-REF records per repo-local database, plus bounded tombstones so cleaned retained refs can fail as `expired` while tombstones remain. This is not permanent storage. Multi-repo deferred expansion remains intentionally limited.

### Suggested Implementation Prompt Title

Persistent V-REF Store with Stored-Truth Expansion

## Milestone 2 — Optional Auto-Reindex Mode

### Purpose

Add an opt-in mode where the watcher can trigger safe automatic reindexing after source changes.

Implementation status: completed as explicit `vtrace watch [repo] --auto-reindex`. Default watcher behavior remains mark-stale-only.

### Why This Improves VEXP Alignment

VEXP-like product feel includes continuity as files change. `watch` remains mark-stale-only by default. Optional auto-reindex reduces manual refresh work when explicitly enabled while preserving the safe default and visible stale/failure state.

### General-Purpose Value

Every repo benefits from fresher structural context when the user opts in. This is independent of ARC and does not change ranking or parser behavior.

### Scope

- Keep watcher mark-stale-only by default.
- Add explicit opt-in auto-reindex mode through `--auto-reindex`.
- Prevent overlapping index runs.
- Keep failed reindex visible as stale or failed freshness state.
- Surface indexing/reindex state in status and MCP freshness diagnostics.
- Preserve explicit user control through `index`.

Likely files/modules to inspect:

- `src/runtime/fileWatcher.ts`
- `src/runtime/indexFreshness.ts`
- `src/runtime/status.ts`
- `src/runtime/daemon.ts`
- `src/cli/commands/watchCommand.ts`
- `src/cli/commands/indexCommand.ts`
- `src/indexer/indexProject.ts`
- `src/setup/repoState.ts`
- `src/mcp/tools.ts`

### Non-Goals

- No mandatory auto-reindex.
- No always-on daemon by default.
- No hidden background indexing without visible status.
- No semantic rename detection.
- No runtime/dataflow freshness claims.

### Validation Requirements

- Watcher fixture showing default remains mark-stale-only.
- Opt-in fixture showing one reindex starts after a debounced source change.
- Concurrency test proving overlapping index runs are prevented.
- Failure test proving stale/failed state remains visible.
- Status/MCP output tests showing indexing or failed reindex state.
- Non-ARC source fixture; ARC may be optional manual validation.

### Anti-Overfit Guardrails

- Trigger rules must depend on generic source-file freshness, not specific repo paths.
- Debounce and concurrency behavior must be language/repo neutral.
- Do not tune polling or debounce values for one benchmark.

### Exit Criteria

- Current default behavior is unchanged.
- Users can opt into auto-reindex explicitly.
- Reindex status is inspectable.
- Failed reindex does not hide stale state.
- Manual `index` remains authoritative.

Implemented behavior: auto-reindex is a watcher CLI flag only, prevents overlapping watcher-triggered index runs, leaves compact failure metadata visible, and lets explicit `index` remain authoritative.

### Suggested Implementation Prompt Title

Optional Auto-Reindex Mode with Visible Freshness State

## Milestone 3 — Module-Level Constants, Variables, and Aliases

### Purpose

Index conservative top-level assigned symbols, including module-level constants, variables/shared objects, aliases, and annotated assignments.

### Why This Improves VEXP Alignment

Many codebase questions depend on module-level values rather than only functions or classes. Indexing top-level assigned symbols makes constants, shared objects, aliases, and exported values available to references, imports, impact graph, retrieval, and capsule pivots without relying on runtime inference.

### General-Purpose Value

TypeScript, Python, and mixed repos all benefit from being able to find and trace module-level assigned values. This is especially useful for configuration constants, exported aliases, singleton/shared objects, and typed top-level declarations.

### Scope

- Index top-level constants.
- Index top-level variables and shared objects.
- Index top-level aliases.
- Index annotated top-level assignments.
- Include exported module-level values where the parser can identify exports conservatively.
- Allow these symbols to participate in imports, references, impact graph, retrieval, and capsule selection when static evidence exists.
- Keep extraction top-level-only.
- Preserve deterministic symbol IDs and diff behavior.
- Ensure skeleton and capsule surfaces remain clear.

Likely files/modules to inspect:

- `src/parsers/types.ts`
- `src/parsers/typescriptParser.ts`
- `src/parsers/pythonParser.ts`
- `src/parsers/cythonParser.ts`
- `src/indexer/indexProject.ts`
- `src/db/schema.ts`
- `src/db/repositories/symbolsRepository.ts`
- `src/db/repositories/edgesRepository.ts`
- `src/retrieval/*`
- `src/impact/getImpactGraph.ts`
- `src/skeleton/getSkeleton.ts`

### Non-Goals

- No module/package node milestone in this scope.
- No local-variable indexing.
- No runtime assignment tracking.
- No dataflow inference.
- No dynamic import or dynamic export resolution.
- No semantic/dataflow overclaims.

### Validation Requirements

- Synthetic TypeScript fixture with top-level constants, variables, aliases, annotated declarations where supported, and exported values.
- Synthetic Python fixture with top-level simple assignments, annotated assignments, aliases, shared objects, and local variables that must not be indexed.
- Mixed Python/Cython fixture.
- Diff/staleness tests proving module-level assigned symbols are added, modified, removed, and marked stale deterministically.
- Reference/import and impact graph tests proving dependents can surface when static evidence exists.
- Retrieval tests for module-level value discovery queries.

### Anti-Overfit Guardrails

- Extraction rules must be language-general within each parser, not benchmark-path specific.
- Only top-level assigned symbols should be indexed; local variables and dynamic assignments stay out of scope.
- Avoid scoring boosts tied to one repo's naming conventions.
- Keep unsupported dynamic cases classified as limitations.

### Exit Criteria

- Top-level constants, variables/shared objects, aliases, and annotated assignments are indexed deterministically.
- Local variables are not indexed as module-level symbols.
- Module-level value queries find useful symbol/file pivots.
- Imports/references and impact graph can include module-level assigned symbols when static evidence exists.
- Existing function/class symbol behavior does not regress.

### Suggested Implementation Prompt Title

Module-Level Constants, Variables, and Aliases

## Milestone 4 — Python References Extraction

### Purpose

Extract conservative Python reference edges from imports, calls, annotations, and direct symbol mentions when statically resolvable.

### Why This Improves VEXP Alignment

Impact and workflow tracing become more useful when Python references are represented as graph edges rather than only declarations and lexical matches.

### General-Purpose Value

Python package repos and mixed Python/Cython repos gain better structural context. This is a broad frontend improvement, not an ARC fix.

### Scope

- Extract import references.
- Extract direct calls to locally resolvable functions/classes.
- Extract annotation references where names can be resolved conservatively.
- Persist reference edges using existing edge infrastructure where possible.
- Keep unresolved/dynamic references out of the graph or explicitly classified.

Likely files/modules to inspect:

- `src/parsers/pythonParser.ts`
- `src/parsers/pythonParser.test.ts`
- `src/parsers/cythonParser.ts`
- `src/indexer/indexProject.ts`
- `src/db/repositories/edgesRepository.ts`
- `src/retrieval/searchSymbolsGraph.ts`
- `src/retrieval/rerankGraph.ts`
- `src/impact/getImpactGraph.ts`
- `src/logicFlow/searchLogicFlow.ts`

### Non-Goals

- No runtime tracing.
- No dynamic dispatch truth.
- No whole-program type inference.
- No semantic/dataflow claims.
- No resolving arbitrary monkeypatching or dynamic imports.

### Validation Requirements

- Synthetic Python package fixture with imports, direct calls, and annotations.
- Negative tests for dynamic/unresolved references.
- Impact graph tests proving direct dependents appear.
- Retrieval/capsule tests proving graph-backed pivots improve without ranking hacks.
- Mixed Python/Cython fixture where Python references Cython-exposed names conservatively.

### Anti-Overfit Guardrails

- Reference extraction must be syntax and symbol-table based, not name-list based.
- Do not add special handling for benchmark package names.
- Unsupported dynamic cases must remain explicit limitations.

### Exit Criteria

- Direct static Python references create deterministic graph edges.
- Existing TypeScript reference behavior does not regress.
- Impact graph usefulness improves on generic Python fixtures.
- Failure modes are classified rather than guessed.

### Suggested Implementation Prompt Title

Conservative Python Reference Edge Extraction

## Milestone 5 — Python Member/Attribute Resolution

### Purpose

Resolve conservative Python member and attribute references when the receiver can be statically tied to a known class or module.

### Why This Improves VEXP Alignment

Many Python workflows depend on methods and attributes rather than only top-level functions. Conservative member resolution improves impact graph and capsule relevance for object-oriented Python.

### General-Purpose Value

This benefits common Python repos with classes, services, clients, models, and module attributes. It is not tied to ARC vocabulary or layout.

### Scope

- Resolve `module.member` when `module` is a statically known import/module alias.
- Resolve `self.member` inside class methods for members declared on the same class.
- Resolve simple classmethod/staticmethod references where syntax is unambiguous.
- Link references to indexed class methods/attributes when present.

Likely files/modules to inspect:

- `src/parsers/pythonParser.ts`
- `src/parsers/types.ts`
- `src/indexer/types.ts`
- `src/db/schema.ts`
- `src/db/repositories/symbolsRepository.ts`
- `src/db/repositories/edgesRepository.ts`
- `src/impact/getImpactGraph.ts`
- `src/capsule/buildCapsuleImpl.ts`

### Non-Goals

- No dynamic attribute inference.
- No runtime object tracking.
- No broad type inference.
- No claims that all attribute access is resolved.
- No semantic/dataflow overclaims.

### Validation Requirements

- Synthetic Python class fixture with `self.method`, `self.attribute`, module aliases, and unresolved dynamic attributes.
- Tests proving only conservative cases create edges.
- Impact graph tests for method dependents.
- Staleness tests for member additions/removals.

### Anti-Overfit Guardrails

- Resolution rules must be structural and syntax-driven.
- Do not boost or special-case domain terms from one repo.
- Prefer explicit unresolved classification over risky inference.

### Exit Criteria

- Conservative member references are indexed deterministically.
- Unresolved dynamic attributes are not fabricated.
- Impact graph and retrieval improve on generic class-based Python fixtures.
- Existing parser behavior remains stable.

### Suggested Implementation Prompt Title

Conservative Python Member and Attribute Resolution

## Milestone 6 — Inherited-Member and `super()` Resolution

### Purpose

Resolve conservative inheritance relationships, inherited member references, and simple `super()` calls in Python where class hierarchy is statically known.

### Why This Improves VEXP Alignment

Impact analysis is more useful when method overrides and parent method calls are visible. This moves VTrace closer to VEXP-like structural intelligence while staying deterministic.

### General-Purpose Value

Python frameworks and applications often rely on inheritance. Conservative inheritance edges help many repos and are independent of ARC.

### Scope

- Index base-class relationships when bases resolve to known classes.
- Link overrides to overridden methods where names and base classes are statically known.
- Resolve simple `super().method(...)` calls to known base methods.
- Surface inherited-member relationships in impact graph where useful.

Likely files/modules to inspect:

- `src/parsers/pythonParser.ts`
- `src/parsers/types.ts`
- `src/indexer/indexProject.ts`
- `src/db/repositories/edgesRepository.ts`
- `src/impact/getImpactGraph.ts`
- `src/logicFlow/searchLogicFlow.ts`
- `src/retrieval/rerankGraph.ts`

### Non-Goals

- No dynamic MRO simulation beyond conservative static class bases.
- No metaclass behavior.
- No runtime dispatch truth.
- No framework-specific inheritance rules.
- No semantic/dataflow overclaims.

### Validation Requirements

- Synthetic Python inheritance fixture with single inheritance, simple multiple inheritance, overrides, and `super()`.
- Negative tests for dynamic bases and unresolved parents.
- Impact graph tests for base-to-override and override-to-base relationships.
- Non-ARC repo or fixture validation.

### Anti-Overfit Guardrails

- Inheritance rules must be Python-static and fixture-driven, not framework-name driven.
- Do not add special cases for one repo's base classes.
- Keep unsupported dynamic MRO cases explicit.

### Exit Criteria

- Known base classes and simple `super()` calls create deterministic graph edges.
- Impact graph can show conservative inheritance relationships.
- Dynamic or unresolved inheritance remains unclaimed.
- Existing direct reference behavior does not regress.

### Suggested Implementation Prompt Title

Conservative Python Inheritance and `super()` Graph Edges

## Milestone 7 — Broader Generic Retrieval/Reranking Benchmarks

### Purpose

Build broader generic retrieval and reranking benchmarks before further tuning retrieval behavior.

### Why This Improves VEXP Alignment

VEXP-like product feel depends on consistently useful retrieval for exact, broad, ambiguous, graph, memory, and workflow questions. Benchmarks should define broad expectations before scoring changes.

### General-Purpose Value

The benchmark suite protects TypeScript, Python, mixed Python/Cython, memory, rules, and graph behavior from regressions. It also prevents overfitting to ARC by making non-ARC success visible.

### Scope

Cover query categories from [`docs/validation_strategy.md`](./validation_strategy.md):

- exact symbol/API lookup
- broad workflow tracing
- concept/domain lookup
- file/module discovery
- Python/Cython boundary lookup
- ambiguous/stress queries
- impact graph queries
- memory/rule queries

Use:

- synthetic fixtures
- at least one TypeScript repo/fixture
- at least one Python repo/fixture
- mixed Python/Cython fixture
- ARC as optional real-repo stress test

Likely files/modules to inspect:

- `src/validation/*`
- `src/retrieval/*`
- `src/capsule/*`
- `src/runPipeline/*`
- `src/testing/mixedPyCythonFixture.ts`
- `src/parsers/*`
- `src/impact/*`
- `src/projectRules/*`
- `src/observations/*`

### Non-Goals

- No ARC-specific heuristics.
- No tuning solely to ARC names.
- No embeddings unless a future explicit milestone chooses that product direction.
- No benchmark-only product behavior.
- No token-savings marketing claims without measurement.

### Validation Requirements

- Add expected-result fixtures with deterministic assertions.
- Classify failures as parser/frontend, retrieval/reranking, capsule shaping, memory/rule behavior, or accepted limitation.
- Include regression checks for non-target fixtures before any scoring changes.
- Treat ARC results as optional validation reports, not pass/fail product truth by themselves.

### Anti-Overfit Guardrails

- Benchmark data must include non-ARC repos/fixtures.
- Scoring changes must improve or preserve generic categories.
- Any ARC-motivated tuning must be rewritten as a general-purpose hypothesis before implementation.

### Exit Criteria

- Benchmark suite covers all query categories above.
- Reports classify misses rather than implying every miss needs a code change.
- Retrieval tuning has a generic evidence base.
- ARC is represented only as a stress test.

### Suggested Implementation Prompt Title

Generic Retrieval/Reranking Benchmark Suite Before Tuning

## Milestone 8 — VS Code Panel Polish

### Purpose

Improve product feel and clarity in the existing VS Code panel without introducing panel-only behavior.

### Why This Improves VEXP Alignment

A VEXP-like product should make setup, freshness, V-REF expansion, rules, and pipeline output legible from the editor. Panel polish can reduce user confusion without changing core schemas or hidden behavior.

### General-Purpose Value

Clearer status and actions benefit every repo and agent workflow. This is product UX work, not ARC retrieval work.

### Scope

Possible improvements:

- clearer freshness/watch status
- rule candidate and active-rule visibility
- V-REF expansion UX
- setup/reindex feedback
- remove redundant actions
- consistent `vtrace` naming
- clearer error/empty states for existing commands

Likely files/modules to inspect:

- `vscode-extension/resultPanel.js`
- `vscode-extension/shell.js`
- `vscode-extension/extension-main.js`
- `vscode-extension/cli.js`
- `vscode-extension/*.test.ts`
- `src/cli/commands/runPipelineCommand.ts`
- `src/cli/commands/expandVexpRefCommand.ts`
- `src/runtime/status.ts`

### Non-Goals

- No panel-only product behavior.
- No MCP schema changes.
- No hidden auto-actions unless explicitly exposed.
- No retrieval tuning.
- No feature redesign under the name of polish.

### Validation Requirements

- Panel tests for status, setup/reindex, run-pipeline, V-REF expansion, and rule visibility where existing surfaces support them.
- Manual smoke test that panel opens and existing actions still work.
- Naming review for public `vtrace` consistency.
- No requirement to validate ARC.

### Anti-Overfit Guardrails

- UI copy must describe generic VTrace behavior, not ARC outcomes.
- Do not add panel actions that secretly run benchmark-specific flows.
- Keep all core behavior delegated to CLI/MCP surfaces.

### Exit Criteria

- Freshness/setup/pipeline/ref/rule states are clearer.
- Existing actions remain reproducible through CLI/MCP.
- Public UI naming is consistently `vtrace` except intentional historical compatibility.
- No schema or hidden behavior changes are introduced.

### Suggested Implementation Prompt Title

VS Code Panel Polish for Freshness, Rules, and V-REF UX

## What Not To Do Post-RC Yet

Avoid these until there is a clear product reason, validation plan, and explicit milestone:

- full semantic memory
- embeddings/vector search
- auto-promoting project rules
- always-on background daemon by default
- ARC-specific retrieval rules
- persistent hidden agent state without inspection surfaces
- claiming full VEXP parity
- token-savings marketing claims without measurement
- hidden recomputation of expired or unknown V-REFs
- schema renames that break compatibility without versioning

## Recommended Next Post-RC Prompt

Recommended next implementation prompt:

```text
Module-Level Constants, Variables, and Aliases
```

Persistent V-REF Store was the first post-RC continuity milestone and is now implemented for exact stored-payload expansion with bounded repo-local retention. It improves continuity for MCP, CLI, and editor flows while preserving the central truth requirement: V-REF expansion returns stored payloads exactly, not fuzzy lookup or semantic reconstruction.

Optional Auto-Reindex Mode is now implemented. The next recommended milestone is Module-Level Constants, Variables, and Aliases because it improves static structural coverage without changing retrieval/ranking behavior or adding semantic claims.

## Deliverable Summary

Recommended milestone order:

1. Persistent V-REF Store — implemented
2. Optional Auto-Reindex Mode — implemented
3. Module-Level Constants, Variables, and Aliases
4. Python References Extraction
5. Python Member/Attribute Resolution
6. Inherited-Member and `super()` Resolution
7. Broader Generic Retrieval/Reranking Benchmarks
8. VS Code Panel Polish

Completed continuity implementation prompt titles:

```text
Persistent V-REF Store with Stored-Truth Expansion
Optional Auto-Reindex Mode with Visible Freshness State
```

Validation fixtures needed before or during remaining implementation work:

- auto-reindex stale/failure/concurrency fixture
- TypeScript module-level assignment fixture
- Python package reference fixture
- mixed Python/Cython boundary fixture
- Python class/member fixture
- Python inheritance and `super()` fixture
- generic retrieval/reranking query set covering exact, broad, ambiguous, graph, memory, and rule queries

Known risks:

- Persistent V-REFs could accidentally become recomputation if stored-truth rules are weakened in future work.
- Future auto-reindex changes could hide freshness failures if status does not continue to expose in-progress and failed states.
- Python graph intelligence could overclaim dynamic behavior if conservative boundaries are not enforced.
- Retrieval tuning before broader benchmarks could overfit to ARC or another single repo.
- Panel polish could create hidden product behavior if it bypasses CLI/MCP surfaces.

Decision points for the user:

- Decide whether future auto-reindex policy should remain CLI-only or gain repo config / daemon integration.
- Decide when a future schema version should rename compatibility fields such as `claudeCode`.
- Decide whether embeddings/semantic memory remain out of scope or become a separate explicit product direction later.
