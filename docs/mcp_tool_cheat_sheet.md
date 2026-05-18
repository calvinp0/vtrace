# MCP Tool Cheat Sheet

Use this as the quick selection guide for the visible `vexb` MCP tools.

## Default Entry Point

Start with `run_pipeline` when the work is broad, unclear, or needs a compact task-oriented orchestration result. It is the best first choice for new coding tasks, debugging orientation, likely edit-surface discovery, impact/memory decisions, and handoff-style summaries.

`run_pipeline` is not mandatory. If you already know the exact workflow you need, call the narrower tool directly.

Prefer product-facing input names for new callers:

- `task`
- `preset`
- `max_tokens`
- `include_tests`
- `include_file_content`
- `observation`
- `repos`

Legacy names (`query`, `intent`, `maxBudgetCharacters`) still work.

## Passive Memory

Meaningful visible MCP calls auto-capture compact `tool_call` observations. This currently includes orchestration/context, structural impact and skeleton tools, logic flow, memory/session lookups, and successful V-REF expansion.

`index_status`, `workspace_setup`, and `save_observation` are excluded. Captures are deterministic, compact, and linked only to exact file/symbol evidence already present in the call or result. They are not embeddings, semantic consolidation, passive file watching, anti-pattern detection, or project-rule generation.

## Direct Tool Choices

- `get_context_capsule`: use when you only need the compact context capsule and do not need orchestration, impact, memory, or task-summary sections.
- `get_skeleton`: use when you know the file path and need imports, declarations, classes, methods, and signatures without bodies.
- `get_impact_graph`: use when you know the exact indexed symbol FQN and need a bounded structural dependent view before a rename, API change, or refactor.
- `search_logic_flow`: use when you know both exact endpoint FQNs and need a conservative structural path between them.
- `index_status`: use when you need readiness, freshness, and index health.
- `workspace_setup`: use when MCP needs to inspect or apply repo setup instead of using the shell CLI.
- `search_memory`: use when you need saved observations relevant to the current work.
- `get_session_context`: use when resuming recent or session-linked work.
- `save_observation`: use when a durable fact should be available to future sessions.
- `expand_vexp_ref`: use only for a `run_pipeline` deferred item that says `expandable: true`.

## Practical Rules

- If the query is vague, start with `run_pipeline`.
- If the input is exact, prefer the exact leaf tool.
- Do not use impact or logic-flow tools as runtime proof; they report indexed structure.
- Do not expect `search_logic_flow` to infer endpoints; provide exact FQNs.
- Do not expect `expand_vexp_ref` to search or recompute; it only resolves known emitted hashes in the current MCP server process.
- Do not claim a special compressed format or token-savings percentage from VEXB output.
