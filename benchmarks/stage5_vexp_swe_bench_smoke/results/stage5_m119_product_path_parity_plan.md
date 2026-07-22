# Stage 5 M119 Product Path Parity Plan

Date: 2026-07-22

This is the required pre-change audit. No product source was changed before this
file was created. The audit used the repository paths and symbols named below.

## Product-path mapping

1. The three MCP schemas live in `src/mcp/tools.ts`. `RUN_PIPELINE_TOOL_DEFINITION`
   defines `run_pipeline`; the `get_code_context` definition delegates to
   `handleGetCodeContextRequest`; and the `get_context_capsule` definition is in
   `createMcpToolDefinitions` beside its v1/v2 handler.
2. All three can reach Capsule v2, but only when `capsule_engine=v2` is supplied.
   `get_code_context` delegates to `RUN_PIPELINE_TOOL_DEFINITION.handler`,
   `run_pipeline` delegates v2 construction to `runPipelineOrchestrator` /
   `buildCapsuleV2Section`, and `get_context_capsule` calls `buildCapsuleV2`
   directly.
3. All three default to v1 today. `run_pipeline` and therefore
   `get_code_context` return the broad orchestration format from
   `formatRunPipelineOrchestrationOutput`; `get_context_capsule` returns the
   weaker `formatContextCapsulePipelineOutput` on v1 and a small custom v2
   envelope on v2.
4. Shared helpers are `buildCapsuleV2`, `toCapsuleV2ProductResponse`,
   `buildInspectFirst`, `renderCapsuleV2Human`, the v1 capsule builder, and the
   generic `buildContextAccounting`. There is no shared final product assembler.
5. Capsule v2 paths expose `CapsuleV2ProductResponse.digest`. The run-pipeline v2
   path embeds it under `capsuleV2.digest`; the context-capsule v2 path embeds it
   in its custom `capsuleV2` envelope. v1 paths do not expose this digest.
6. The capsule CLI JSON path returns raw `CapsuleV2Result`; MCP paths expose the
   product projection, not raw builder JSON. `run_pipeline` embeds the projected
   response under `capsuleV2`.
7. Human capsule CLI output uses `renderCapsuleV2Human`. MCP product paths expose
   source fields and/or `digest`, but do not identify a single authoritative
   `modelVisibleContext` string.
8. Task and intent handling are not identical. `run_pipeline` resolves a preset
   plus normalized intent in `resolveNormalizedIntent`; `get_code_context`
   inherits that. `get_context_capsule` parses `capsule_intent` directly and v1
   uses `routeQuery` intent classification.
9. Worktree/freshness handling is not identical. `get_code_context` alone calls
   `inspectWorktreeIndexFreshness` and optionally refreshes. The other two rely on
   ready-repository binding and only the run-pipeline MCP envelope adds legacy
   freshness diagnostics.
10. Stale/no-context/fallback responses are inconsistent. `get_code_context`
    has a dedicated stale envelope; Capsule v2 represents no context through
    `actualMode=no_context`; v1 uses empty capsule sections; v2 build exceptions
    can fall back to v1.

## Current response shape

11. Lead pivots and support are in `capsuleV2.pivots/support` and
    `context.pivots/supports`. Required targets are implicit in M112/M113 digest
    and inspect-first guidance, not normalized items. Skeleton state is only a
    `contentMode`/count. Impact, memory, and rules are first-class run-pipeline
    sections and optional digest seams. Documents are Capsule v2 support marked
    `isNonSourceExample`, not a documentation role. Estimated tokens exist in
    Capsule v2 items/budget and `accounting`; latency exists only as
    `accounting.latencyMs`.
12. Candidate/discard reasoning, likely files/symbols, freshness, retrieval
    fallback, graph availability, and some role-policy data are diagnostics-only.
13. `query`/`task`, `support`/`supports`/`supportingItems`, `estimated_tokens` /
    `estimatedTokens`/`estimatedOutputTokens`, and multiple intent representations
    are duplicated or inconsistently named.
14. `run_pipeline(capsule_engine=v2)` is strongest: it combines v1 context,
    Capsule v2, inspect-first, bounded neighborhoods, impact, memory, rules,
    diagnostics, and accounting.
15. MCP schema tests, `src/cli/commands/runPipelineCommand.ts`, capsule CLI JSON,
    VS Code consumers documented by `formatRunPipelineOrchestrationOutput`, Stage
    5 injection/classification, handoff/manifest persistence, and tests throughout
    `src/mcp`, `src/runPipeline`, and `src/capsuleV2` depend on existing fields.

## Token accounting

16. v1 `max_tokens` currently aliases `maxBudgetCharacters`; Capsule v2
    `capsule_budget_tokens` controls the builder budget in estimated tokens.
17. v1 budgeting is characters. Capsule v2 budgeting is `Math.ceil(chars / 4)`
    through `src/capsuleV2/tokens.ts`. Neither is tokenizer-exact or provider
    reported.
18. Capsule v2 internal accounting sums selected item render estimates. Existing
    `buildContextAccounting` measures JSON serialization of the outer emitted
    value, not a canonical final model-visible render.
19. Existing serialized-response accounting counts repeated bodies when the same
    body occurs in v1, v2, digest, or neighborhood sections.
20. `buildContextAccounting` already implements a unique selected full-file
    baseline, but its wording includes every represented emitted file and its
    numerator is the wrapper JSON rather than final model-visible text.
21. A shared assembler can deterministically construct and then measure one final
    `modelVisibleContext` string.
22. Honest provenance is `character_ratio`, `estimateExact=false`, specifically
    `Math.ceil(renderedCharacters / 4)`; it is not billed-token accounting.

## Rendering and skeletons

23. `buildCapsuleV2` renders pivot source through `renderPivot` /
    `renderWithLadder`: focused symbol source when it fits, then signature, then
    skeleton.
24. Supports use `renderSupport` and prefer signature then skeleton. The product
    projection exposes source/signature but skeleton text is minimal.
25. Parser-backed `getSkeleton` is structural; Capsule v2's existing `skeleton`
    fallback is closer to metadata/name than a complete file skeleton. The
    separate source-excerpt helpers are bounded by symbol spans, not first-N file
    lines.
26. `SymbolRecord` in `src/domain/types.ts` exposes name/FQN, kind, signature,
    docstring, start/end line, decorators, and exported. Return types are carried
    inside parser-produced signatures rather than a separate field.
27. Missing signatures/docstrings yield null/empty data. `getSkeleton` provides
    structural declarations when indexed and explicit `not_indexed` /
    `file_not_found` statuses otherwise.
28. Yes. A file/symbol can be represented in v1 context, Capsule v2, impact,
    neighborhoods, docs, memory links, and digest at once.
29. Domain symbol IDs are content/location-derived SHA-256 IDs. Existing product
    items have no role-prefixed stable display ID. The new layer will hash task,
    snapshot, path, and symbol identity, then assign deterministic role-prefixed
    labels without exposing benchmark labels.

## Impact, memory, and rules

30. `getImpactGraph` is the production static reverse-impact engine; run-pipeline
    gates it through `runImpactSection` and projects it via
    `impactGraphToDigestSeam`.
31. Real bounded fields include resolved symbols, `Calls`/`Imports`/`References`
    edges, graph distance, dependent files/counts, and indexed symbol line spans.
    Indexed edges do not carry exact call-site lines, so symbol spans must be
    labelled as such and never as runtime flow.
32. `getSessionContext` / `searchMemory` and
    `selectRelevantProjectRules` are production-enabled in run-pipeline. Capsule
    v1 also has surfaced memory support.
33. Observation staleness uses `getObservationStaleness` and source-run/file/symbol
    diffs; stale observations are rejected by memory selection. Rules carry active,
    candidate, stale, disabled, and dismissed states.
34. Yes. The shared assembler will consume already-selected Capsule v2 items and
    existing bounded graph/memory/rule results. It will not modify candidate
    generation, scores, pivots, co-edits, or task derivation.
35. `get_context_capsule` currently omits orchestrator impact/memory/rules seams;
    v1 paths omit Capsule v2 role detail; worktree identity is absent from normal
    successful outputs.

## Latency

36. MCP/CLI accounting records one wall-clock `latencyMs`; M118 index performance
    diagnostics record indexing/cache phases when refresh occurs.
37. Monotonic `performance.now()` spans can measure freshness, retrieval/orchestration,
    Capsule v2 build, impact, memory/rules, rendering, index refresh, and total.
    Existing orchestration is synchronous once the DB is open, so stage timings
    can be captured without changing ordering.
38. These measurements are elapsed wall-clock durations, not CPU time.
39. Instrumentation adds a handful of monotonic clock reads plus bounded rendering,
    deduplication, skeleton DB reads, and unique selected-file reads already
    required for accounting. It adds no graph traversal beyond the capped existing
    impact query.

## Compatibility

40. Add `responseVersion: 2` and a shared `productContext` object while preserving
    current envelopes (`context`, `capsuleV2`, `digest`, manifests, diagnostics,
    accounting). The shared object owns authoritative items, model-visible text,
    role counts, accounting, timing, repository, and freshness.
41. Update MCP schema/tests, `runPipelineCommand`, Capsule CLI JSON projection,
    run-pipeline formatter tests, and Stage 5 compile-time consumers. Human output
    gets only a compact summary where it is already human-readable; JSON remains
    JSON-only.
42. Yes: numeric `responseVersion: 2` is needed because consumers must distinguish
    the normalized additive contract from legacy wrapper fields.
43. Existing v1/raw structured fields and `renderCapsuleV2Human` must remain
    unchanged when enrichment is absent. The additive `productContext` is allowed
    to differ because it is new; existing `total`, `tokens`, `files`, and `digest`
    semantics stay intact.
44. Tests will snapshot pre/post Capsule v2 task hash, intent, actual mode, pivot
    order, selected path/symbol identities, required/support classification, and
    selected-file hash. Cross-tool tests will assert these identities and M114
    worktree/freshness equality. No broad retrieval evaluation is needed unless
    one of those invariants moves.

## Implementation plan

1. Add `src/productContext/` with shared types and one assembler. It will consume
   one Capsule v2 result/product projection plus existing orchestration evidence.
2. Normalize role-aware items, merge roles by stable source identity, render each
   content body once, generate parser-backed support skeletons using indexed
   `SymbolRecord`/`getIndexedSkeletonFileResult`, and report fallbacks.
3. Attach bounded static impact and already-selected fresh memory/rules/docs,
   without retrieval or graph-selection changes.
4. Render one deterministic model-visible context, then calculate used tokens from
   that exact text and a naive baseline of full contents of unique selected source
   files. Report deduplication separately.
5. Instrument monotonic stage timings and attach M114 identity/freshness plus M118
   refresh diagnostics. Stale/no-context envelopes will report null savings.
6. Make `get_code_context`, `get_context_capsule`, and `run_pipeline` call the same
   assembly layer with Capsule v2 as their normalized product context while
   preserving legacy fields.
7. Add focused unit/integration/parity/leakage tests and the no-agent smoke script;
   write deterministic detail JSON/CSV and the final Markdown/JSON report.
8. Run the requested typechecks, full tests, smoke, and `git diff --check`. Commit
   only intended source/tests/reports. Because both milestone ledger files are
   pre-existing dirty files, preserve their current content and do not stage them;
   report that constraint rather than folding unrelated dirt into the commit.
