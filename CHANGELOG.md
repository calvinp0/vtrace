# Changelog

## 0.1.0

- RC release artifact preparation for the local-source `vtrace` CLI, MCP server, and private/local VS Code extension package.
- Persistent repo-local V-REF stored-payload expansion, with exact 12-hex lookup, bounded retention, process-local hot-cache support, and explicit expired/unknown/malformed failure states.
- Optional watcher auto-reindex mode through `watch --auto-reindex`; default watcher behavior remains mark-stale-only.
- Memory/session/project-rule surfaces for deterministic saved observations, session context, conservative passive consolidation, anti-pattern observations, observation nudges, and manually promoted project rules.
- Graph intelligence improvements for Python module-level symbols, references, member/attribute resolution, inherited members, and `super()` edges where static evidence is exact.
- Generic retrieval/reranking benchmark coverage and VS Code panel polish for setup/status, freshness, watcher/auto-reindex state, rules, run-pipeline, and exact V-REF expansion.

Known limitations: V-REFs are exact stored-payload expansion, not fuzzy lookup; persistence is bounded, not permanent; there is no global cross-repo V-REF search, embeddings, semantic memory, runtime tracing, full dynamic Python MRO/dataflow truth, arbitrary `obj.x` type inference, ARC-specific tuning, or full VEXP parity.

## 0.0.1

- RC1 repository hygiene pass: CI, typecheck, format checks, VS Code packaging script, release documentation, and MCP cheat sheet.

Future entries should summarize user-visible CLI, MCP, packaging, and extension changes.
