# Product Truth Audit and RC Hardening Plan

Date: 2026-05-19

Scope: current VTrace / VEXB repository implementation, docs, CLI, MCP tool schemas, VS Code shell, package metadata, and tests.

## Post-Audit Closure Status

Date: 2026-05-19

Status: closed for the three RC blockers identified by this audit.

| Blocker                                                                                                                    | Closing commit                                           | Current status                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `run_pipeline` MCP output schema drift, including nested diagnostics rule counts and freshness metadata.                   | `24a0d5d fix(mcp): align run_pipeline output schema`     | Closed; schema parity coverage now validates representative actual MCP outputs.                                      |
| CLI docs omitted `run-pipeline`, `expand-vexp-ref`, canonical setup/status/index/watch flow, and CLI V-REF process caveat. | `62fa384 docs: document CLI pipeline and V-REF commands` | Closed for RC; post-RC docs now describe retained persistent CLI expansion plus optional `--query` fallback.         |
| Minor naming/compatibility drift around `run_pipeline` `preset`/`intent` wording and `workspace_setup.status.claudeCode`.  | `75c07c2 chore(rc): clarify naming compatibility`        | Closed; invalid preset errors say `preset/intent`, and `claudeCode` is documented as a retained compatibility field. |

Post-RC V-REF update: `edb2f1a feat(vref): persist deferred expansion payloads` supersedes the old process-local-only V-REF limitation. V-REFs are now exact, bounded, repo-local persisted stored payloads with process-local hot-cache support. CLI `expand-vexp-ref` can resolve retained persistent refs without `--query`; `--query` remains a fallback/debug republish path when a ref is unavailable or expired.

Post-RC roadmap closeout: the planned continuity, freshness, Python graph, retrieval benchmark, and VS Code panel polish sequence has been completed or verified with regression coverage. Several Python graph milestones verified existing behavior and added focused hardening tests rather than introducing broad new analysis.

Remaining acceptable RC limitations: V-REF persistence is bounded, not permanent; multi-repo `run_pipeline` still does not emit deferred expansion items; auto-reindex is opt-in and not enabled by setup/default watch; `workspace_setup.status.claudeCode` remains the compatibility field name for this schema version; `vtrace` remains deterministic lexical/structural tooling, not full VEXP parity.

## Executive Summary

The current product is best described publicly as `vtrace`: a repo-local, deterministic structural index plus CLI, MCP server, memory/session layer, optional stale-marker watcher, and conservative project-rule system. The current implementation is substantially beyond a pure indexing tool, but it is still not VEXP parity. The memory and workflow-awareness features are deterministic, lexical/structural, and mostly explicit or process-local.

The main docs are generally truthful about the important limits: no embeddings, no semantic reconstruction, no hidden V-REF recomputation in MCP, no automatic reindexing by default, no automatic rule promotion, and no daemon requirement for normal MCP use.

At RC audit time, the largest blocker was schema truth, not feature truth. `run_pipeline` returned several fields that were absent from nested `additionalProperties: false` output schemas, especially `diagnostics.rules.staleTotalCount`, `diagnostics.rules.disabledTotalCount`, and `diagnostics.rules.dismissedTotalCount`. That meant the advertised MCP output schema could reject the actual output. The second RC blocker was CLI/documentation drift around `run-pipeline` and `expand-vexp-ref`. Those RC blockers were closed, and post-RC persistent V-REF work replaced the old CLI republish-only caveat with retained repo-local lookup plus optional `--query` fallback.

Naming is mostly standardized on `vtrace` / `.vtrace`. Historical `VEXB` remains only in prompt/context and is not present in package metadata or main docs. Recommended RC stance: public product and CLI stay `vtrace`; use `VEXB` only as a historical/internal codename if needed, and do not start a global rename.

## Current Product Capability Table

| Area                   | Current behavior                                                                                                                                                               | Truth status     | Evidence                                                                                                                                                                 | Gap                                                                                                                     | Recommended action                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `run_pipeline`         | Default MCP orchestration returns intent, task summary, compact context, impact decision, memory, rules, diagnostics, deferred V-REF metadata, and optional saved observation. | Mostly ready     | `src/mcp/tools.ts`, `src/runPipeline/runPipelineOrchestrator.ts`, `src/runPipeline/formatRunPipelineOutput.ts`, `src/mcp/mcp.test.ts`                                    | Actual output/schema mismatch in nested diagnostics; multi-repo path disables deferred expansion.                       | Fix schema drift before RC; document multi-repo deferred limitation.                                |
| context capsule        | Builds deterministic compact capsule with pivots, support items, surfaced memories, and active rules.                                                                          | Ready            | `src/capsule/*`, `src/mcp/tools.ts`, `src/capsule/*.test.ts`                                                                                                             | Candidate rules are intentionally excluded from capsule guidance.                                                       | Keep documented as active-rule-only guidance.                                                       |
| impact graph           | Exact FQN, bounded reverse structural impact over indexed edges; rejects `cross_repo=true`.                                                                                    | Ready            | `src/impact/getImpactGraph.ts`, `src/mcp/tools.ts`, `src/impact/getImpactGraph.test.ts`                                                                                  | Not runtime proof or semantic blast radius.                                                                             | Keep wording structural and exact.                                                                  |
| search logic flow      | Exact start/end FQNs, bounded deterministic structural paths; rejects `cross_repo=true`.                                                                                       | Ready            | `src/logicFlow/searchLogicFlow.ts`, `src/mcp/tools.ts`, `src/logicFlow/searchLogicFlow.test.ts`                                                                          | No endpoint inference; no runtime/dataflow semantics.                                                                   | Keep as specialist exact-FQN tool.                                                                  |
| skeleton               | File skeletons for indexed source files with detail levels.                                                                                                                    | Ready            | `src/skeleton/getSkeleton.ts`, `src/mcp/tools.ts`, `src/cli/commands/skeletonCommand.ts`                                                                                 | Only indexed/supported source files.                                                                                    | No RC action.                                                                                       |
| V-REF expansion        | Expands exact 12 lowercase hex hashes from process-local hot cache or repo-local persistent store into stored payloads; no recomputation.                                      | Ready            | `src/runPipeline/deferredVexpStore.ts`, `src/runPipeline/expandDeferredVexpRef.ts`, `src/db/repositories/deferredVexpRefsRepository.ts`, `src/mcp/expandVexpRef.test.ts` | Persistence is bounded; multi-repo deferred expansion remains limited.                                                  | Keep wording exact, repo-local, and stored-truth only.                                              |
| passive auto-capture   | Successful useful visible MCP calls write compact `mcp_auto` `tool_call` observations, best effort and deduped.                                                                | Mostly ready     | `src/observations/autoCapture.ts`, `src/mcp/mcp.test.ts`                                                                                                                 | `get_context_capsule` capture does not pass session id; only `run_pipeline` session captures currently bind to session. | Document session binding as input-dependent; consider session support for more visible tools later. |
| session compression    | Explicit service compresses inactive sessions after default 2h; stores summary and consolidates repeated passive groups.                                                       | Ready as service | `src/observations/sessionLifecycle.ts`, `src/observations/observations.test.ts`                                                                                          | No scheduler/daemon automatic sweep.                                                                                    | Keep docs explicit: service exists, automatic scheduling is not RC scope.                           |
| memory consolidation   | Deterministic same-signature passive `tool_call` groups thresholded at 3 are summarized, then grouped source rows are pruned.                                                  | Ready            | `src/observations/consolidation.ts`, `src/observations/observations.test.ts`                                                                                             | Not semantic/cross-session consolidation.                                                                               | No RC action.                                                                                       |
| watcher/freshness      | `vtrace watch` is polling and opt-in; default mode marks stale only, while `--auto-reindex` explicitly enables visible debounced reindexing.                                   | Ready            | `src/runtime/fileWatcher.ts`, `src/runtime/indexFreshness.ts`, `src/runtime/*.test.ts`                                                                                   | No always-on daemon or implicit auto-reindex.                                                                           | Keep docs explicit about default vs opt-in behavior.                                                |
| anti-pattern detection | Detects `file_thrashing` from watcher events and `symbol_added_then_removed` from adjacent index diffs; stores durable `dead_end` observations.                                | Ready            | `src/observations/antiPatterns.ts`, `src/observations/antiPatterns.test.ts`                                                                                              | No repeated-query detector, semantic stuck detection, or correction.                                                    | Add explicit “no repeated-query detector yet” wording if docs need more precision.                  |
| progressive nudges     | `run_pipeline.diagnostics.nudge` appears after 3 passive session tool calls, repeats every 5, self-disables after durable observation.                                         | Ready            | `src/observations/observationNudges.ts`, `src/observations/observationNudges.test.ts`, `src/mcp/mcp.test.ts`                                                             | Only `run_pipeline` diagnostics, not chat-wide reminders.                                                               | No RC action.                                                                                       |
| active rules           | Active project rules are stored in `project_rules`, selected deterministically, capped at 3, and injected into `run_pipeline.rules.active` / `capsule.rules.active`.           | Ready            | `src/projectRules/projectRules.ts`, `src/projectRules/projectRules.test.ts`                                                                                              | Stale active rules are not injected, as intended.                                                                       | No RC action.                                                                                       |
| rule candidates        | Generated explicitly from repeated durable/consolidated/anti-pattern evidence; candidates preview only in `run_pipeline`, never active capsule guidance.                       | Ready            | `src/projectRules/projectRules.ts`, `src/cli/commands/rulesCommand.ts`, tests                                                                                            | No auto-promotion, no LLM writing.                                                                                      | No RC action.                                                                                       |

## VEXP-Like Feature Parity Table

| VEXP-like claim                  | Current truth                                                                                      | Classification  | Evidence                                                                    | RC wording                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Local context engine             | Repo-local structural context engine with CLI/MCP surfaces.                                        | True            | README, `package.json`, `src/mcp/tools.ts`                                  | “Local-first structural context engine.”                                                  |
| Passive MCP observation capture  | Captures compact metadata for meaningful successful MCP calls, excluding setup/status/save.        | Mostly true     | `autoCapture.ts`, `mcp.test.ts`                                             | “Passive compact tool-call memory, best effort.”                                          |
| Memory search                    | Deterministic lexical/structural observation search.                                               | True            | `src/observations/searchMemory.ts`                                          | “Search saved observations by lexical and exact structural links.”                        |
| Semantic memory                  | No embeddings or semantic ranking.                                                                 | Not implemented | Docs explicitly deny; no embedding deps.                                    | “Not semantic memory.”                                                                    |
| Session compression              | Explicit service compresses inactive sessions and preserves durable memory.                        | Mostly true     | `sessionLifecycle.ts`                                                       | “Available through explicit lifecycle service; no scheduler requirement.”                 |
| Deferred expansion               | Real exact hash expansion from process hot cache or repo-local persistent stored payloads.         | Mostly true     | `deferredVexpStore.ts`, `expandDeferredVexpRef.ts`, `expandVexpRef.test.ts` | “Exact stored payload expansion with bounded repo-local persistence.”                     |
| Persistent V-REFs                | Implemented as bounded repo-local SQLite stored payloads plus tombstones and process cache.        | Mostly true     | `deferredVexpRefsRepository.ts`                                             | “V-REFs survive restart only while retained by cleanup policy.”                           |
| Passive file awareness           | Opt-in polling watcher marks stale.                                                                | Mostly true     | `fileWatcher.ts`                                                            | “Opt-in mark-stale watcher.”                                                              |
| Automatic reindex                | Implemented only as explicit `vtrace watch --auto-reindex`; default watch remains mark-stale-only. | Partial         | `watchCommand.ts`, docs                                                     | “Opt-in only; failures remain visible and explicit `vtrace index` remains authoritative.” |
| Anti-pattern detection           | Two conservative detectors only.                                                                   | Partial         | `antiPatterns.ts`                                                           | “Conservative structural anti-pattern observations.”                                      |
| Project convention learning      | Candidate generation from repeated evidence only; no auto-promotion.                               | Partial         | `projectRules.ts`                                                           | “Deterministic candidate generation; explicit promotion required.”                        |
| Rule enforcement                 | Rules are context guidance only.                                                                   | Not implemented | `projectRules.ts`, docs                                                     | “No enforcement or blocking.”                                                             |
| Cross-repo semantic memory/rules | Workspace retrieval exists, but rules are repo-root scoped and structural.                         | Partial         | `workspace/*`, `projectRules.ts`                                            | “Repo-scoped deterministic rules.”                                                        |

## MCP Tool Truth Table

| Tool                                                                                                                                                                    | Classification               | Actual behavior                                                                                              | Schema/docs alignment                                                                     | RC action                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `run_pipeline`                                                                                                                                                          | Mostly ready, schema blocker | Broad orchestration with aliases, memory, freshness, nudge, rules, deferred items, optional save.            | Input docs align. Output schema drifts from formatter in nested diagnostics rules fields. | Fix schema before RC.                                                      |
| `get_context_capsule`                                                                                                                                                   | Ready                        | Thin visible wrapper over capsule pipeline, including active rules and memory surface.                       | Mostly aligned.                                                                           | No action.                                                                 |
| `get_impact_graph`                                                                                                                                                      | Ready                        | Exact FQN bounded structural reverse impact. `cross_repo=true` fails honestly.                               | Aligned.                                                                                  | No action.                                                                 |
| `search_logic_flow`                                                                                                                                                     | Ready                        | Exact FQN endpoint path search. `cross_repo=true` fails honestly.                                            | Aligned.                                                                                  | No action.                                                                 |
| `get_skeleton`                                                                                                                                                          | Ready                        | Structural skeletons for requested indexed files.                                                            | Aligned.                                                                                  | No action.                                                                 |
| `index_status`                                                                                                                                                          | Ready                        | Readiness and freshness inspection, including watcher state and workspace repo status.                       | Aligned.                                                                                  | No action.                                                                 |
| `workspace_setup`                                                                                                                                                       | Mostly ready                 | MCP setup/status shell; `apply` can run setup, `startRuntime` only with apply.                               | Output field still named `claudeCode` even though it can represent Codex agent config.    | Rename only in future schema version or document compatibility field name. |
| `get_session_context`                                                                                                                                                   | Ready                        | Recent/session-specific observations and compressed summaries.                                               | Visible and documented.                                                                   | No action.                                                                 |
| `search_memory`                                                                                                                                                         | Ready                        | Lexical/structural observation search with staleness metadata.                                               | Visible and documented.                                                                   | No action.                                                                 |
| `save_observation`                                                                                                                                                      | Ready                        | Manual durable observation persistence.                                                                      | Visible and documented.                                                                   | No action.                                                                 |
| `expand_vexp_ref`                                                                                                                                                       | Ready                        | Exact 12-hex expansion via process hot cache then repo-local persisted store, structured non-error failures. | MCP and CLI docs describe retained persistent refs and `--query` fallback.                | Keep limitations explicit.                                                 |
| Hidden legacy: `index_repo`, `search_symbols`, `route_query`, `build_capsule`, `build_handoff`, `list_runs`, `check_capsule_staleness`, `list_sessions`, `read_session` | Acceptable hidden legacy     | Registered as hidden or legacy, callable by id but not visible in `tools/list`.                              | Visible docs correctly omit most.                                                         | Keep hidden; avoid promoting in RC docs.                                   |

Visible MCP tool list matches docs: `run_pipeline`, `get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`, `index_status`, `workspace_setup`, `get_session_context`, `search_memory`, `save_observation`, `expand_vexp_ref`.

## `run_pipeline` Truth Audit

| Claim                                                                                                 | Status                   | Evidence                                             | Notes                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Accepts `task` and legacy `query`                                                                     | True                     | `parseRequiredRunPipelineTask`, `mcp.test.ts`        | `task` wins when both are present.                                                                                                  |
| Accepts `preset` and legacy `intent`                                                                  | True                     | `tools.ts`, `selectIntent.test.ts`                   | Error message currently says “intent must be one of” even if invalid field was `preset`; minor wording issue.                       |
| Accepts `max_tokens` and `maxBudgetCharacters`                                                        | True                     | `parseOptionalIntegerAlias`, `mcp.test.ts`           | Maps to character budget, not token budget. Docs say this.                                                                          |
| Accepts `include_tests`                                                                               | True                     | `tools.ts`, tests                                    | Stored in request; actual capsule search does not appear test-specialized beyond preset defaults. Treat as preference.              |
| Accepts `include_file_content`                                                                        | Partial                  | `tools.ts`, formatter                                | Stored as resolved preference; compact output still returns representation metadata, not full files. Docs say this.                 |
| Accepts `observation` and `saveObservation`                                                           | True                     | `tools.ts`, `mcp.test.ts`                            | `observation` creates manual insight; `saveObservation=true` creates compact tool-call observation.                                 |
| Output has `intent`, `taskSummary`, `context`, `impact`, `memory`, `diagnostics`, `deferred`, `rules` | True                     | `formatRunPipelineOutput.ts`, tests                  | Actual output includes all required top-level sections.                                                                             |
| Impact skip reasons are honest                                                                        | True                     | `runPipelineOrchestrator.ts`, `mcp.test.ts`          | Reasons include not refactor-like, no focal symbol, multiple focal symbols, no dependents, impact error.                            |
| Memory distinguishes surfaced capsule memory, session, durable memory                                 | Mostly true              | formatter memory section                             | Consolidated/summary/anti-pattern rows are represented by observation kind/summary, not separate subtypes in `run_pipeline.memory`. |
| Diagnostics expose freshness and nudge state                                                          | True in output           | `tools.ts`, tests                                    | Output schema does not mark these required, but output contains them.                                                               |
| Deferred section only claims expandable refs when real expansion works                                | True for single-repo MCP | `buildDeferredPlaceholders`, `expandVexpRef.test.ts` | Multi-repo path explicitly says no deferred expansion. CLI expansion has different constraints.                                     |
| Active rules and candidates are separated                                                             | True                     | `formatRunPipelineOutput.ts`, project rule tests     | Candidates are explicitly labeled previews.                                                                                         |
| Stale/disabled/dismissed rules are not active guidance                                                | True                     | `selectRelevantProjectRules`, tests                  | Counts are reported in diagnostics/omitted.                                                                                         |

## V-REF / `expand_vexp_ref` Truth Audit

MCP behavior is strict and truthful:

- Hashes are exact 12 lowercase hex strings: `DEFERRED_VEXP_HASH_PATTERN = /^[0-9a-f]{12}$/`.
- Expansion first checks the process-local hot cache, then the repo-local persisted V-REF store.
- Expansion returns stored content emitted by `run_pipeline`, not recomputation.
- Process hot-cache capacity defaults to 256; repo-local persistence keeps up to 1000 records and 1000 tombstones.
- Evicted or cleaned hashes return `expired` while a tombstone is retained.
- Unknown well-formed hashes return `unknown_hash`.
- Malformed hashes return `malformed_hash`.
- Unsupported stored categories return `unsupported_category`.
- No fuzzy lookup, semantic reconstruction, disk recomputation, token-savings percentage, or “ultra-compressed v2” behavior is implemented.

Post-RC CLI behavior: `vtrace expand-vexp-ref` can resolve retained repo-local persistent refs without `--query`. Because persistence is bounded, `--query` remains available as a fallback/debug path that re-runs the orchestrator to republish matching deferred items when the requested hash is not retained.

## Memory / Session Truth Audit

| Behavior                                                       | Status                   | Evidence                                                            | Notes                                                         |
| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Passive MCP `tool_call` capture                                | True                     | `autoCapture.ts`, `mcp.test.ts`                                     | Best effort, post-success only, compact metadata only.        |
| Excludes `index_status`, `workspace_setup`, `save_observation` | True                     | Docs and `observationNudges.ts`; no capture calls in those handlers | Captures are not recursive.                                   |
| Exact file/FQN/symbol linking only                             | True                     | `autoCapture.ts`                                                    | Uses data already present in result; no enrichment retrieval. |
| Session compression after inactivity                           | True as explicit service | `sessionLifecycle.ts`                                               | No scheduler or always-on session daemon.                     |
| Physical pruning of eligible repeated passive rows             | True                     | `consolidation.ts`                                                  | Only grouped eligible `mcp_auto tool_call` rows are deleted.  |
| Durable observation preservation                               | True                     | `sessionLifecycle.ts`, tests                                        | Manual/durable observations are not removed by consolidation. |
| Compressed/consolidated summary persistence/searchability      | True                     | `observations.test.ts`                                              | Summary observations are persisted and searchable.            |
| Passive consolidation                                          | True                     | `consolidation.ts`                                                  | Deterministic lexical/structural signature, threshold 3.      |
| Anti-pattern observations                                      | True                     | `antiPatterns.ts`                                                   | Durable `dead_end` observations.                              |
| Progressive nudges                                             | True                     | `observationNudges.ts`                                              | Diagnostics only; no persisted nudge rows.                    |
| Stale marking                                                  | True                     | `staleness.ts`, tests                                               | File/symbol diff based after reindex.                         |

Overclaims to avoid: semantic memory, embeddings, learned ranking, background/session daemon, automatic understanding of every agent decision, guaranteed capture of every decision, cross-session semantic consolidation.

## Watcher / Freshness Truth Audit

The watcher is opt-in and polling (`DEFAULT_FILE_WATCH_POLL_INTERVAL_MS = 1000`). It observes indexable source paths, debounces, writes pending stale state to `.vtrace/state.json`, and reports freshness through CLI status/doctor, MCP `index_status`, and `run_pipeline.diagnostics.freshness`. By default it does not auto-reindex and does not require the optional daemon. `vtrace watch --auto-reindex` is an explicit opt-in mode that triggers debounced reindexing, prevents overlapping watcher-triggered runs, and leaves stale/failure metadata visible if indexing fails. Successful explicit indexing clears pending watcher-observed stale state, and existing structural diffs drive stale marking after reindex.

Overclaims to avoid: passive watcher always running, real-time daemon behavior, semantic rename detection, automatic reindexing, or fine-grained signature/body/visibility diff semantics beyond current structural file/symbol diffing.

## Anti-Pattern / Nudge Truth Audit

Implemented anti-patterns:

- `file_thrashing`: threshold 5 source-file change events within 10 minutes.
- `symbol_added_then_removed`: symbol added in one index run and removed in the adjacent next run.

Implemented nudges:

- First full nudge after 3 passive session tool calls.
- Brief nudge every 5 additional passive calls.
- Disabled once a durable observation exists.
- Appears only in `run_pipeline.diagnostics.nudge`.
- Does not persist rows and does not block tools.

Not implemented: repeated-query detector, semantic “stuck” detection, automatic correction, chat-level reminders outside pipeline diagnostics.

## Project Rules Truth Audit

Project rules are deterministic and conservative:

- Active/candidate/stale/disabled/dismissed rules live in `project_rules`.
- Candidate generation threshold defaults to 3.
- Eligible evidence: manual durable `decision`/`insight`, consolidated passive summaries, repeated anti-pattern observations.
- Raw one-off passive `tool_call` observations are excluded.
- Dismissed candidates are preserved and not recreated automatically by signature.
- Matching active rules prevent duplicate candidates.
- Candidates are not active instructions and are not injected into capsules.
- Active rules are capped at 3 and ordered deterministically by score/update/id.
- Stale, disabled, dismissed, and candidate rules are not injected as active guidance.
- No auto-promotion, LLM rule writing, embeddings, semantic similarity, cross-repo rule learning, enforcement, or tool blocking.

## CLI / Docs Consistency Findings

| Finding                                                                                                                                                     | Classification                                             | Evidence                                   | Recommended action                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `docs/cli_usage.md` omits `run-pipeline` and `expand-vexp-ref` from direct command list while CLI help exposes both.                                        | Docs-only fix; RC blocker because user flow is incomplete. | `src/cli/index.ts`, `docs/cli_usage.md`    | Add both commands and examples.                                                          |
| `expand-vexp-ref` CLI behavior now checks repo-local persisted V-REFs before optional `--query` republish fallback.                                         | Closed by post-RC persistence work.                        | `src/cli/commands/expandVexpRefCommand.ts` | Keep docs current: retained refs resolve without `--query`; `--query` is fallback/debug. |
| Docs canonical flow starts with `setup`, while prompt suggested `init/index/watch/status`.                                                                  | Acceptable limitation                                      | README/getting started                     | Use `setup` as canonical user flow; mention `init` + `index` as manual lower-level path. |
| CLI command remains `claude-config` for Codex config too.                                                                                                   | Acceptable compatibility naming                            | README, CLI docs, `claudeConfigCommand`    | Keep and document compatibility name.                                                    |
| JSON output stability is strongest for product-shell commands; direct inspection commands often emit raw JSON but docs only promise product-shell `--json`. | Acceptable limitation                                      | CLI docs and commands                      | Keep promise narrow.                                                                     |

Canonical RC flow should be:

```bash
./bin/vtrace setup <repo> --agent codex
./bin/vtrace status <repo>
./bin/vtrace index <repo>
./bin/vtrace watch <repo>
```

Manual lower-level flow remains valid:

```bash
./bin/vtrace init <repo>
./bin/vtrace index <repo>
./bin/vtrace status <repo>
```

MCP flow:

```text
run_pipeline(task="...")
expand_vexp_ref(hash="...")
save_observation(...)
```

Rule flow:

```bash
./bin/vtrace rules generate-candidates <repo>
./bin/vtrace rules promote <repo> <rule-id>
```

## Naming Consistency Findings

| Surface                 | Current naming                                                           | Status                   | Recommendation                                             |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------- |
| `package.json`          | package and binary are `vtrace`                                          | Consistent               | Keep.                                                      |
| CLI                     | `vtrace`, `./bin/vtrace`                                                 | Consistent               | Keep.                                                      |
| Repo-local state        | `.vtrace`                                                                | Consistent               | Keep.                                                      |
| MCP server schema/id    | `vtrace.mcp_server`, `vtrace_rc1_mcp`                                    | Consistent               | Keep.                                                      |
| Docs                    | mostly `vtrace`; historical `VTRACE` only where explicitly contextual    | Acceptable               | Prefer lowercase `vtrace` in prose.                        |
| VS Code extension       | command ids `vtrace.*`, package `vtrace-vscode`, activity title `vtrace` | Consistent               | Keep public UI lowercase.                                  |
| `claude-config` command | name references Claude while supporting Codex                            | Compatibility mismatch   | Keep for RC; consider future alias such as `agent-config`. |
| VEXB                    | Not present in public docs/package surfaces                              | Historical/internal only | Do not reintroduce publicly during RC.                     |

Recommendation: standardize public product language on `vtrace`. Treat `VEXB` as a historical/internal codename. Do not globally rename code in this milestone.

## Release Blocker List

| Blocker                                                                                                                              | Severity | Evidence                                                                                                                                          | Minimal fix                                                                         | Owner/suggested milestone |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| `run_pipeline` MCP output schema omits actual nested diagnostics rule fields while nested schema uses `additionalProperties: false`. | Blocker  | `formatRunPipelineOutput.ts` emits stale/disabled/dismissed counts; `RUN_PIPELINE_ORCHESTRATION_DIAGNOSTICS_SCHEMA.rules` omits those properties. | Add the three fields to schema properties and required list, or stop emitting them. | RC schema hardening.      |
| CLI docs omitted `run-pipeline` and `expand-vexp-ref` commands exposed in help and used by VS Code.                                  | Closed   | `src/cli/index.ts`, `vscode-extension/cli.js`, `docs/cli_usage.md`                                                                                | Keep CLI usage rows and examples current.                                           | RC docs hardening.        |
| CLI `expand-vexp-ref` truth must explain retained persistent lookup plus optional `--query` republish fallback.                      | Closed   | `src/cli/commands/expandVexpRefCommand.ts`                                                                                                        | Keep docs aligned with repo-local persistence.                                      | Post-RC docs truth.       |

## Wording Correction Table

| File                                            | Current wording                                                                         | Why it is risky                                                                       | Suggested wording                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/cli_usage.md`                             | Direct command list omits `run-pipeline` / `expand-vexp-ref`.                           | New users cannot follow the real CLI + VS Code flow; V-REF CLI behavior is invisible. | Add `./bin/vtrace run-pipeline <repo> <query> ...` and `./bin/vtrace expand-vexp-ref <repo> <hash> [--query <query>] ...`.                                             |
| `docs/cli_usage.md`                             | No CLI V-REF caveat.                                                                    | Could imply standalone CLI hashes are permanent.                                      | “CLI `expand-vexp-ref` can resolve retained repo-local persistent refs directly; use `--query` only as fallback/debug republish when a ref is unavailable.”            |
| `docs/mcp_tools.md`                             | “Most of those are directly useful today. `expand_vexp_ref` is the advanced exception.” | Slightly vague; users may not know it is exact stored-payload lookup only.            | “Use `expand_vexp_ref` only for exact hashes emitted by `run_pipeline`; expansion checks hot cache then repo-local persistence and never recomputes missing payloads.” |
| `src/mcp/tools.ts` error text                   | Invalid `preset` reports “run_pipeline intent must be one of...”                        | Confusing because product-facing field is `preset`.                                   | “run_pipeline preset/intent must be one of...”                                                                                                                         |
| `src/mcp/tools.ts` workspace setup output field | Output uses `claudeCode` for generic agent config.                                      | Codex users may think setup only reports Claude config.                               | In future schema: `agentConfig`; for RC docs, note `claudeCode` is a compatibility field.                                                                              |

## Acceptable Limitation Table

| Limitation                                           | Why acceptable for RC                                                | Where documented                    | Future milestone                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| V-REFs are repo-local, exact, and bounded.           | Honest and deterministic; avoids fabricated expansions.              | MCP docs/cheat sheet; code comments | Tune retention or multi-repo behavior only if needed.     |
| CLI `--query` remains fallback/debug republish.      | Retained refs resolve directly; unavailable refs can be republished. | CLI docs                            | Keep fallback explicit; do not imply permanent refs.      |
| Watcher is polling and mark-stale-only by default.   | Clear, safe default with explicit opt-in reindexing.                 | README, getting started, MCP docs   | Keep auto-reindex explicit and failure-visible.           |
| Memory is lexical/structural, not semantic.          | Matches local deterministic design.                                  | MCP docs/cheat sheet                | Embeddings/semantic ranking if product direction changes. |
| Rule candidates require explicit promotion.          | Prevents accidental policy injection.                                | MCP docs/CLI docs                   | Review UI for candidates.                                 |
| `claude-config` name is retained for Codex config.   | Compatibility matters more than naming purity for RC.                | README/getting started              | Add `agent-config` alias later.                           |
| VS Code panel is a thin shell over CLI/MCP behavior. | Avoids hidden panel-only behavior.                                   | Extension package/commands          | Add rule/watch management only through existing surfaces. |
| Cross-repo impact/logic flow unsupported.            | Current indexes are repo-bound; tools fail honestly.                 | Tool schemas/errors                 | Workspace graph model.                                    |

## VS Code / Panel Audit

The extension is a thin local shell over the CLI. It supports setup, setup/reindex, status, doctor, freshness/runtime/setup reports, run-pipeline, context capsule, file skeleton, impact graph at cursor, and V-REF expansion through CLI. It does not expose project-rule management or a watch start/stop control. That is acceptable for RC if docs call CLI/MCP the canonical interfaces for rules and watcher.

Panel public naming now uses lowercase `vtrace` for the package title and result-panel titles. Internal error codes such as `VTRACE_CLI_NOT_FOUND` remain compatibility/internal identifiers.

## CI / Test / Package Audit

| Area              | Status                                          | Evidence                   | Classification                   |
| ----------------- | ----------------------------------------------- | -------------------------- | -------------------------------- |
| Package name/bin  | `vtrace`, binary `./bin/vtrace`                 | `package.json`             | Ready                            |
| Test command      | `bun test`                                      | `package.json`, CI         | Ready                            |
| Typecheck         | `bun run typecheck`                             | `package.json`, CI         | Ready                            |
| Format check      | Prettier over docs/package/config/license files | `package.json`             | Ready                            |
| Lint              | Alias to typecheck                              | `package.json`             | Acceptable limitation            |
| VS Code packaging | `bun run package:vscode`                        | `package.json`, CI         | Ready if `vsce` install succeeds |
| CI                | typecheck, lint, format, test, package VS Code  | `.github/workflows/ci.yml` | Ready                            |
| Lockfile          | `bun.lock` present                              | repo root                  | Ready                            |

## Recommended Hardening Plan

1. Fix MCP schema drift.
   - Add actual `run_pipeline.diagnostics.rules` omitted counts to the schema.
   - Add focused schema/formatter parity test for `run_pipeline`.
   - Review other nested `additionalProperties: false` schemas for conditional/extra fields.

2. Patch CLI docs for real command flow.
   - Keep `run-pipeline` and `expand-vexp-ref` documented in `docs/cli_usage.md`.
   - Keep CLI V-REF wording current: retained persistent refs resolve directly, and `--query` is fallback/debug republish.
   - Add canonical flow using `setup`, `status`, explicit `index`, optional `watch`.

3. Do a tiny MCP wording cleanup.
   - Change invalid preset error wording from “intent” to “preset/intent”.
   - Document `workspace_setup.status.claudeCode` as compatibility naming, or schedule schema rename for next major schema.

## Suggested Next 3 Implementation Prompts

### 1. RC Schema Parity Patch

Audit `src/mcp/tools.ts` output schemas against actual outputs for `run_pipeline`, `get_context_capsule`, and `index_status`. Fix only schema/docs drift, add focused tests that validate actual output keys against schema expectations, and do not change product behavior.

### 2. CLI Truth Docs Patch

Update `docs/cli_usage.md`, `docs/getting_started.md`, and `docs/mcp_tool_cheat_sheet.md` so the canonical setup/index/watch/status, `run-pipeline`, and CLI/MCP V-REF flows are explicit. Keep the wording deterministic, exact, and repo-local. Do not add features.

### 3. RC Naming Compatibility Pass

Audit user-facing names for `claude-config`, `workspace_setup.status.claudeCode`, `VTRACE` vs `vtrace`, and hidden legacy MCP tools. Add compatibility notes or aliases only where tiny and low-risk. Do not rename `.vtrace`, the package, or MCP schema ids.
