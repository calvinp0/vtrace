# MCP Tools

The visible `vtrace` MCP surface is intentionally small and stable.

If you are unsure where to start, use `run_pipeline`.

For the more tactical version of this guide, see [MCP Tool Cheat Sheet](./mcp_tool_cheat_sheet.md).

## Visible Tool Surface

The current visible tool names are:

- `run_pipeline`
- `get_context_capsule`
- `get_impact_graph`
- `search_logic_flow`
- `get_skeleton`
- `index_status`
- `workspace_setup`
- `get_session_context`
- `search_memory`
- `save_observation`
- `expand_vexp_ref`

Most of those are directly useful today. `expand_vexp_ref` is the advanced exception.

## Passive Tool-Call Observations

`vtrace` auto-captures compact `tool_call` observations for meaningful visible MCP tool calls. Current capture covers successful, useful calls to `run_pipeline`, `get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`, `search_memory`, `get_session_context`, and resolved `expand_vexp_ref` expansions.

Captured observations are deterministic and compact. They store tool name, exact query/task/symbol/file inputs where available, a short summary, and bounded metadata such as counts or selected profiles. They do not store full raw tool outputs.

When the tool input or output already exposes exact graph evidence, captured observations may link to repo-relative files, symbol ids, and symbol FQNs. `vtrace` does not fuzzy guess links or run extra retrieval just to enrich a passive observation. If a session id is present, the observation is associated with that session.

The following visible tools are intentionally excluded from passive capture:

- `index_status`
- `workspace_setup`
- `save_observation`

`index_status` and `workspace_setup` are often status/setup plumbing. `save_observation` already writes exactly what the caller asked to save and is not recursively captured.

This is a passive-memory substrate, not full VEXP parity. It does not add embeddings, semantic similarity, learned ranking, semantic consolidation, automatic rule promotion, or claims that every agent decision is understood.

## Conservative Passive Consolidation

`vtrace` can consolidate repeated passive observations within a single session. The first implementation is intentionally narrow: it targets repeated `mcp_auto` `tool_call` observations with the same deterministic lexical/structural signature. The signature uses exact fields such as tool name, normalized query text, intent, selected compact result-shape fields, sorted linked files, and sorted linked symbol FQNs. It does not use embeddings, semantic similarity, LLM merging, learned ranking, or cross-session memory merging.

Consolidated passive groups are stored as compact auto-generated `insight` observations from `consolidate_passive_observations`. Their body includes explicit metadata such as `consolidated=true`, `source_kind=tool_call`, source observation count, tool counts, first/last observed timestamps, source run ids, session id, deterministic signature, and preserved structural links. The consolidated observation keeps exact linked files, symbol ids, and symbol FQNs so it remains searchable and participates in existing stale-memory checks when those files or symbols later change.

Consolidation is thresholded. By default, at least three eligible passive observations with the same signature are required. Below that threshold, passive observations are left alone by consolidation. When a group is consolidated, only the grouped passive source observations are physically pruned. Manual observations, decisions, insights, warnings, anti-pattern/dead-end observations, and anything authored through `save_observation` are never consolidated or removed by this mechanism.

This is not semantic memory consolidation or automatic rule promotion.

## Session Lifecycle Compression

`vtrace` can compress inactive sessions into compact structural summaries through an explicit lifecycle service. There is no background scheduler or passive file watcher requirement.

The default compression threshold is two hours of inactivity. Compression records a deterministic summary with observation counts, tool-call counts by tool, unique linked files, unique linked symbol ids and FQNs, key lexical terms, first/last activity times, compression time, preserved durable count, and repeated passive tool-call source rows pruned through consolidation.

Compression also triggers conservative passive consolidation for the inactive session. Repeated passive groups become narrower consolidated summaries, while the broad compression summary remains the session-level aggregate. Durable observations remain preserved, including manual notes and non-ephemeral insights, decisions, warnings, and dead-end observations. Manual observations are not removed by compression.

Compressed sessions remain inspectable through session context: `get_session_context` reports the compression summary and returns preserved observations, including durable observations and compact consolidated passive summaries where present, without flooding the response with pruned repeated tool calls. Compression summaries and consolidated summaries are searchable, so `search_memory`, `run_pipeline.memory`, and capsule memory surfacing can find them through deterministic lexical and structural signals such as key terms, tool names, file paths, and symbol FQNs.

The default retention threshold is 90 days. This milestone reports deterministic cleanup candidates for old compressed sessions; physical deletion of compressed summaries and durable data is intentionally deferred.

## Optional Passive File Awareness

File watching is opt-in. `vtrace watch [repo]` runs a lightweight polling watcher that uses the same indexed-source scan rules as the indexer. It observes created, modified, and deleted source files, debounces bursts, and records a compact pending stale state in `.vtrace/state.json`.

The watcher is mark-stale-only by default. `vtrace watch [repo] --auto-reindex` explicitly opts into debounced automatic reindexing; setup never enables it implicitly. Auto-reindex prevents overlapping watcher-triggered index runs in the watcher process. If auto-reindex fails, stale state and compact failure metadata stay visible, and normal MCP tools remain usable.

`index_status` reports watcher support, whether watcher mode has been used for the repo, auto-reindex state, pending changed file count, a bounded sorted changed-file list, and freshness metadata. `run_pipeline.diagnostics.freshness` also reports stale and auto-reindex metadata when available.

A successful explicit reindex through the normal indexing path clears pending watcher-observed stale state and auto-reindex failure state. Reindexing continues to use the existing structural file and symbol diff machinery. Linked observations, passive `tool_call` observations, consolidated passive summaries, compressed session summary observations, and linked project rules become stale through conservative structural checks when their linked files or symbols are modified or removed.

This is not semantic rename detection, runtime dataflow, or full VEXP passive behavior.

## Conservative Anti-Pattern Observations

`vtrace` can detect a small set of conservative anti-patterns from passive observations and watcher/index signals. These are stored as durable `dead_end` observations with explicit anti-pattern metadata so they can be inspected through `get_session_context`, found through `search_memory`, and preserved during session compression.

The initial detectors are intentionally structural:

- `file_thrashing`: source-file watcher events show one file changed repeatedly within a short time window.
- `symbol_added_then_removed`: existing structural diffs show a symbol was added in one index run and removed in the next.

Detection is deterministic and deduped by evidence signature. Anti-pattern observations include a short summary, severity, exact linked files or symbol FQNs where available, and compact evidence such as change counts or index run ids. Linked anti-pattern observations participate in the existing stale-memory behavior when their files or symbols later change.

This is not semantic understanding of developer intent, progressive nudging, learned classification, semantic consolidation, or policy enforcement. `vtrace` does not block normal MCP behavior when an anti-pattern observation exists.

## Progressive Observation Nudges

`run_pipeline.diagnostics.nudge` may include a compact structural nudge when an active session has meaningful passive tool-call activity but no durable observation yet. Nudges are metadata in the tool result, not forced chat messages, retrieved context, or persisted observations.

The current schedule is deterministic:

- first full nudge after 3 passive `tool_call` observations in the session
- later brief nudges at most once every 5 additional passive tool calls
- no nudge once a durable observation exists

Durable observations include manual saves and durable kinds such as decisions, insights, warnings, and dead-end/anti-pattern observations. `index_status`, `workspace_setup`, and `save_observation` are excluded from nudging, and `save_observation` itself self-disables future nudges for that session by creating durable memory.

Nudges never block tool execution and do not write their own observations. They are not project rules, semantic judgment, learned behavior, or memory consolidation.

## Project Rule Candidates

`vtrace` can generate deterministic project-rule candidates from repeated evidence in one repo. Candidate generation is explicit through `vtrace rules generate-candidates <repo>` (`generate` remains an alias) and uses exact structural or lexical overlap only. The first threshold is three matching evidence observations in the same deterministic scope.

Eligible evidence is intentionally narrow:

- manual durable `decision` and `insight` observations
- consolidated passive summaries created by `consolidate_passive_observations`
- repeated anti-pattern observations such as `file_thrashing` or `symbol_added_then_removed`

Raw one-off passive `tool_call` observations do not generate rule candidates. Candidate generation never mutates or consumes the source observations.

Rule summaries are template-based and evidence-limited. They use cautious wording such as “Repeated durable evidence is linked to…” and “Consider…”. `vtrace` does not use embeddings, LLM synthesis, semantic project understanding, hidden-intent inference, or cross-repo rule learning for this feature.

Candidates are not active by default. A rule must be explicitly promoted before it can be injected into future context:

```bash
vtrace rules list <repo>
vtrace rules generate-candidates <repo>
vtrace rules add-active <repo> --summary "When changing run_pipeline output, update MCP docs and tests." --file src/mcp/tools.ts --term run_pipeline
vtrace rules promote <repo> <rule-id>
vtrace rules dismiss <repo> <rule-id>
vtrace rules disable <repo> <rule-id>
```

The command also accepts `vtrace rules <repo> list` style ordering.

Active rules are injected into `run_pipeline.rules` and `get_context_capsule.capsule.rules.active` only when they match the current task by deterministic signals such as linked file overlap, linked symbol FQN overlap, path-prefix overlap, query-term overlap, or selected intent. Injection is capped at three active rules. Candidate previews may appear in `run_pipeline.rules.candidates`, but they are explicitly labeled as candidates and are not active instructions. Capsules do not include candidate previews; active rules are kept separate from memory observations.

Rules are linked to files, symbol FQNs, lexical terms, tool names, intents, and anti-pattern types where that evidence exists. Candidate generation deduplicates by deterministic signature, updates matching candidates with new evidence, preserves dismissed candidates instead of recreating them, and may update evidence metadata on a matching active rule rather than creating a duplicate candidate. When explicit reindexing detects linked file or symbol changes, candidate and active rules become `stale`. Candidate, stale, disabled, and dismissed rules are not injected as active guidance. This milestone does not implement automatic promotion, semantic rule generation, embeddings, semantic similarity, cross-repo rules, policy enforcement, or tool blocking.

## Default Orchestration

### `run_pipeline`

Default task entrypoint.

Use it for:

- new coding tasks
- debugging orientation
- finding likely edit surfaces
- getting one structured orchestration result with intent, compact context, impact decision, memory/session evidence, diagnostics, and deferred metadata

Preferred input fields:

- `task`: natural-language task description
- `preset`: `auto`, `explore`, `debug`, `modify`, or `refactor`
- `max_tokens`: product-facing budget, mapped to the current character-budgeted capsule engine
- `include_tests`: caller preference; defaults on for debug and off otherwise
- `include_file_content`: caller preference; `run_pipeline` still returns compact representation metadata rather than raw full-file payloads
- `observation`: durable observation text to save with the run
- `repos`: optional workspace repo aliases

Backward-compatible aliases are still accepted:

- `query` for `task`
- `intent` for `preset`
- `maxBudgetCharacters` for `max_tokens`

`run_pipeline` does not make itself mandatory before code edits. It is the broad-task entrypoint; exact tools remain better when the caller already has exact inputs.

### `get_context_capsule`

Return the compact context package directly, without the fuller orchestration role of `run_pipeline`.

Use it when you want:

- the capsule only
- a smaller manual retrieval flow
- a compact structural/task package without extra orchestration

## Structural Tools

### `get_skeleton`

Return a compact structural view of one or more indexed files without function or method bodies.

Use it for:

- orienting in large files
- comparing candidate modules
- seeing imports, exports, declarations, classes, and methods cheaply

### `get_impact_graph`

Return a bounded structural dependent view for an exact indexed symbol.

Use it before:

- renames
- refactors
- public API changes
- interface changes that could affect callers or dependents

Prefer this specialist tool over `run_pipeline` when you already know the exact symbol FQN.

### `search_logic_flow`

Return bounded structural paths between two exact indexed symbol FQNs.

Use it when:

- you know the exact start symbol
- you know the exact end symbol
- you want the conservative structural path between them

Important limits:

- exact FQN resolution only
- bounded deterministic structural paths only
- not runtime tracing
- not semantic dataflow

Prefer this specialist tool over `run_pipeline` when you already know the exact start and end FQNs.

## Memory and Session Tools

### `save_observation`

Persist a durable observation worth remembering later.

### `search_memory`

Search saved observations and durable memory.

### `get_session_context`

Return recent/current session context so you can resume a workstream quickly.

## Setup and Health Tools

### `index_status`

Compact repo MCP status. Use it to check whether the repo is initialized, indexed, and ready.

It also reports optional watcher/freshness metadata, including pending watcher-observed file changes and auto-reindex state when `vtrace watch` has been used.

### `workspace_setup`

MCP-facing setup shell.

It supports:

- inspect mode
- apply mode

Use it when you want setup/readiness behavior through MCP instead of the CLI.
When `.vtrace/workspace.json` exists, inspect output also includes the configured workspace repos and their readiness.

`workspace_setup.status.claudeCode` is retained as a compatibility field name for generated local-agent config status. Public setup should be understood as setup for supported local coding agents, including Codex when selected; the field name does not imply that Codex setup is unsupported.

## Advanced Tool

### `expand_vexp_ref`

Advanced compressed-reference expansion.

`run_pipeline` may report deferred items with explicit `expandable` metadata. Only items marked `expandable: true` should be sent to `expand_vexp_ref`.

`expand_vexp_ref` accepts one exact public V-REF hash:

- exactly 12 characters
- lowercase hexadecimal
- no fuzzy lookup
- no prefix lookup
- no uppercase normalization

Expansion returns the stored deferred payload captured when `run_pipeline` emitted the V-REF. It does not recompute from disk or reconstruct content semantically. Source file changes after emission do not alter the stored expansion payload.

V-REF payloads are stored in the repo-local `.vtrace` SQLite state while retained. The process-local store remains a hot cache for same-server expansion, and repo-local persistence lets a repo-bound MCP server resolve retained hashes after restart. Persistence is bounded by retention policy, not permanent unlimited storage.

Current retention keeps up to 1000 persisted V-REF records per repo-local database and keeps bounded tombstones for deterministic cleanup. Capacity-evicted or expired records return `expired` while their tombstone is retained; never-seen well-formed hashes return `unknown_hash`.

Malformed, unknown, expired, and unsupported-category references return explicit structured failures. `vtrace` does not claim unlimited persistence, a special compressed format, or token-savings percentages.

## Notes

- `workspace_setup` and `index_status` are available before repo init
- the visible surface is product-facing and intentionally conservative
- structural tools expose indexed repository structure, not runtime truth
- `search_logic_flow` is best when both endpoints are exact FQNs

## Related Shell Commands

- `vtrace setup`
- `vtrace status`
- `vtrace doctor`
- `vtrace claude-config`
- `vtrace claude-config --agent codex`
- `vtrace daemon start|stop|status|logs`
- `vtrace watch`
- `vtrace mcp-serve --repo <repo>`
