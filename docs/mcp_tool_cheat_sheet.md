# MCP Tool Cheat Sheet

Use this as the quick selection guide for the visible `vtrace` MCP tools.

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

`index_status`, `workspace_setup`, and `save_observation` are excluded. Captures are deterministic, compact, and linked only to exact file/symbol evidence already present in the call or result. They are not embeddings, semantic consolidation, or automatic rule promotion.

Repeated passive observations can be consolidated within one session using deterministic lexical/structural signatures. The first version targets repeated `mcp_auto` `tool_call` observations after a threshold of three matching rows. Consolidated summaries preserve tool counts, source counts, first/last timestamps, session/source metadata, and exact file/symbol links, then physically prune only the grouped passive source rows. Manual notes, decisions, insights, warnings, and anti-pattern/dead-end observations are never consolidated.

Inactive sessions can be compressed explicitly after the default two-hour inactivity threshold. Compression summarizes tool-call counts, touched files/symbols, key terms, and durable counts, and triggers conservative consolidation for repeated passive tool calls. Durable/manual observations remain visible, one-off passive observations are not consolidated below threshold, and compressed plus consolidated summaries stay searchable and stale-aware through lexical and structural signals. The default 90-day retention policy currently reports cleanup candidates; it does not silently delete durable data.

Optional passive file awareness is available through `vtrace watch [repo]`. It is mark-stale-only: the watcher detects indexed source file creates/modifies/deletes, debounces bursts, records pending stale state, and leaves reindexing explicit. `index_status` and `run_pipeline.diagnostics.freshness` report this stale state. After a successful reindex, existing file/symbol diffs drive conservative stale marking for linked observations and compressed session summaries.

VTRACE also persists conservative anti-pattern observations when structural evidence is clear. The first detectors are `file_thrashing` from repeated source-file watcher events and `symbol_added_then_removed` from adjacent structural index diffs. These are durable `dead_end` observations with compact evidence, exact file/symbol links where available, deterministic dedupe, and normal memory/session visibility. They are not semantic intent inference, progressive nudges, learned classification, or policy enforcement.

`run_pipeline.diagnostics.nudge` may include a compact observation nudge when an active session has passive tool-call activity but no durable observation yet. The first nudge appears after 3 passive tool calls, then at most every 5 additional calls, and it self-disables after a durable `save_observation` note or other durable observation exists. Nudges are structural metadata only: they do not block calls, do not write observations, and are not project rules, semantic judgment, or memory consolidation.

## Project Rules

`vtrace rules generate-candidates <repo>` can create project-rule candidates from repeated durable decisions/insights, consolidated passive summaries, and repeated anti-pattern observations. `generate` remains an alias. Candidates require at least three matching evidence observations in the same deterministic scope. Raw one-off passive `tool_call` rows are excluded.

Candidates are inspectable with `vtrace rules list <repo>` but are not active by default. Use `vtrace rules promote <repo> <rule-id>` to activate one, `dismiss` to hide a candidate, and `disable` to turn off an active rule. Active rules can appear in `run_pipeline.rules.active` and `capsule.rules.active` only when structurally or lexically relevant; candidate previews may appear in `run_pipeline.rules.candidates` and are not instructions. Capsules do not inject candidates as active guidance.

Rules use template summaries, exact file/FQN/term/tool/intent links, deterministic IDs, confidence labels, and structural stale marking after explicit reindex. Dismissed candidates are not recreated automatically. They do not use embeddings, LLM synthesis, hidden-intent inference, cross-repo learning, automatic promotion, or tool-blocking policy enforcement.

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
- Do not expect `expand_vexp_ref` to search or recompute; it only resolves exact 12-lowercase-hex hashes emitted in the current MCP server process.
- Treat V-REFs as process-local and bounded. Expired, unknown, malformed, and unsupported hashes return structured failures.
- Treat watcher staleness and anti-pattern observations as structural evidence only. They are not semantic rename detection, runtime tracing, intent inference, or project-rule generation.
- Treat observation nudges as optional diagnostics only. They are reminders to save durable memory, not instructions or retrieved context.
- Treat project-rule candidates as reviewable suggestions only. They become context only after explicit promotion and only when relevant.
- Do not claim a special compressed format or token-savings percentage from VTRACE output.
