# MCP Tools

The visible `vexb` MCP surface is intentionally small and stable.

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

VEXB auto-captures compact `tool_call` observations for meaningful visible MCP tool calls. Current capture covers successful, useful calls to `run_pipeline`, `get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`, `search_memory`, `get_session_context`, and resolved `expand_vexp_ref` expansions.

Captured observations are deterministic and compact. They store tool name, exact query/task/symbol/file inputs where available, a short summary, and bounded metadata such as counts or selected profiles. They do not store full raw tool outputs.

When the tool input or output already exposes exact graph evidence, captured observations may link to repo-relative files, symbol ids, and symbol FQNs. VEXB does not fuzzy guess links or run extra retrieval just to enrich a passive observation. If a session id is present, the observation is associated with that session.

The following visible tools are intentionally excluded from passive capture:

- `index_status`
- `workspace_setup`
- `save_observation`

`index_status` and `workspace_setup` are often status/setup plumbing. `save_observation` already writes exactly what the caller asked to save and is not recursively captured.

This is a passive-memory substrate, not full VEXP parity. It does not add embeddings, semantic similarity, learned ranking, passive file watching, anti-pattern detection, semantic consolidation, project-rule generation, or claims that every agent decision is understood.

## Session Lifecycle Compression

VEXB can compress inactive sessions into compact structural summaries through an explicit lifecycle service. There is no background scheduler or passive file watcher requirement.

The default compression threshold is two hours of inactivity. Compression records a deterministic summary with observation counts, tool-call counts by tool, unique linked files, unique linked symbol ids and FQNs, key lexical terms, first/last activity times, compression time, preserved durable count, and pruned ephemeral tool-call count.

Compression physically prunes only ephemeral `mcp_auto` `tool_call` observations after their structural aggregate data has been summarized. Durable observations remain preserved, including manual notes and non-ephemeral insights, decisions, warnings, and dead-end observations. Manual observations are not removed by compression.

Compressed sessions remain inspectable through session context: `get_session_context` reports the compression summary and returns preserved observations without flooding the response with pruned passive tool calls. The summary is also persisted as a compact searchable observation, so `search_memory`, `run_pipeline.memory`, and capsule memory surfacing can find it through deterministic lexical and structural signals such as key terms, tool names, file paths, and symbol FQNs.

The default retention threshold is 90 days. This milestone reports deterministic cleanup candidates for old compressed sessions; physical deletion of compressed summaries and durable data is intentionally deferred.

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

### `workspace_setup`

MCP-facing setup shell.

It supports:

- inspect mode
- apply mode

Use it when you want setup/readiness behavior through MCP instead of the CLI.
When `.vexb/workspace.json` exists, inspect output also includes the configured workspace repos and their readiness.

## Advanced Tool

### `expand_vexp_ref`

Advanced compressed-reference expansion.

`run_pipeline` reports deferred items with explicit `expandable` metadata. Only items marked `expandable: true` should be sent to `expand_vexp_ref`. VEXB does not claim a special compressed format or token-savings percentage.

## Notes

- `workspace_setup` and `index_status` are available before repo init
- the visible surface is product-facing and intentionally conservative
- structural tools expose indexed repository structure, not runtime truth
- `search_logic_flow` is best when both endpoints are exact FQNs

## Related Shell Commands

- `vexb setup`
- `vexb status`
- `vexb doctor`
- `vexb claude-config`
- `vexb claude-config --agent codex`
- `vexb daemon start|stop|status|logs`
- `vexb mcp-serve --repo <repo>`
