# CLI Usage

Examples below use `./bin/vtrace`. If you install `vtrace` elsewhere, replace that wrapper with your preferred launcher.

Replace `<repo>` with the repository you want to inspect.

## Product-Shell Commands

These are the commands most users should start with:

```bash
./bin/vtrace setup [repo] [--start-runtime] [--agent <name>] [--json]
./bin/vtrace status [repo] [--agent <name>] [--json]
./bin/vtrace doctor [repo] [--agent <name>] [--json]
./bin/vtrace claude-config [repo] [--dry-run] [--agent <name>] [--json]
./bin/vtrace daemon <start|stop|status|logs> [repo] [--json]
./bin/vtrace watch [repo] [--debounce-ms <n>] [--poll-ms <n>] [--json]
./bin/vtrace workspace <init|add|list|status> ...
./bin/vtrace mcp-serve --repo <repo>
```

What they are for:

- `setup`: initialize the repo-local state and index
- `status`: compact readiness and freshness
- `doctor`: more detailed inspection
- `claude-config`: install or preview Claude Code / Codex config
- `daemon`: optional background runtime control
- `watch`: optional mark-stale-only source file watcher
- `workspace`: create, update, list, and inspect `.vtrace/workspace.json`
- `mcp-serve`: repo-bound MCP server

## Direct Inspection Commands

These are useful when you want manual control instead of the full MCP shell flow:

```bash
./bin/vtrace init <repo>
./bin/vtrace index <repo>
./bin/vtrace intent <repo> <query>
./bin/vtrace capsule <repo> <query>
./bin/vtrace skeleton <repo> <file> [--detail <minimal|standard|detailed>]
./bin/vtrace impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]
./bin/vtrace handoff <repo> <query>
./bin/vtrace runs <repo>
./bin/vtrace rules <list|generate-candidates|generate|add-active|promote|dismiss|disable> <repo> [rule-id|options]
./bin/vtrace check-capsule <repo> <manifest-id> <comparison-run-id>
```

## Common Examples

Set up a repo:

```bash
./bin/vtrace setup <repo>
```

Check whether the index is ready or stale:

```bash
./bin/vtrace status <repo>
./bin/vtrace doctor <repo>
```

Re-index the repo:

```bash
./bin/vtrace index <repo>
```

Generate and manage conservative project-rule candidates:

```bash
./bin/vtrace rules generate-candidates <repo>
./bin/vtrace rules list <repo>
./bin/vtrace rules add-active <repo> --summary "When changing run_pipeline output, update MCP docs and tests." --file src/mcp/tools.ts --term run_pipeline
./bin/vtrace rules promote <repo> <rule-id>
./bin/vtrace rules dismiss <repo> <rule-id>
./bin/vtrace rules disable <repo> <rule-id>
```

Candidates are generated from repeated durable decisions/insights, consolidated passive summaries, or anti-pattern observations and are not active by default. `generate` remains an alias for `generate-candidates`. Candidate summaries are template-based and evidence-grounded; no embeddings, LLM synthesis, semantic similarity, or auto-promotion are used. Dismissed candidates are not recreated automatically. `add-active` is a minimal manual path for creating an already-active rule with explicit lexical or structural scope. Candidate previews can appear in `run_pipeline.rules.candidates`; capsules keep only active-rule guidance under `capsule.rules.active`.

Optionally watch source files and mark the index stale when they change:

```bash
./bin/vtrace watch <repo>
```

The watcher does not auto-reindex. It records pending source changes in `.vtrace/state.json`; `status`, `doctor`, and MCP `index_status` report that stale state until the next successful explicit `index`.

Show the structure of a file:

```bash
./bin/vtrace skeleton <repo> src/session.ts --detail standard
```

See what depends on an exact symbol:

```bash
./bin/vtrace impact-graph <repo> "src/session.ts::SessionManager.createSession"
```

Preview Codex config without writing it:

```bash
./bin/vtrace claude-config <repo> --agent codex --dry-run
```

Create a multi-repo workspace config:

```bash
./bin/vtrace workspace init --alias backend
./bin/vtrace workspace add frontend ../frontend
./bin/vtrace workspace list
./bin/vtrace workspace status
```

## JSON Output

The product-shell commands support `--json`:

- `setup`
- `status`
- `doctor`
- `claude-config`
- `daemon`
- `watch`

That is useful for scripts, editors, or wrappers that want structured output.

## Repo-Local State

`vtrace` keeps repo-local files under `.vtrace/`:

- `.vtrace/config.json`
- `.vtrace/state.json`
- `.vtrace/index.sqlite`
- `.vtrace/workspace.json` when a multi-repo workspace is configured

## Notes

- repeated `setup` is safe
- the daemon is optional
- project-rule candidates require explicit promotion before context injection
- most users should start from `setup`, `status`, and the MCP workflow
- the MCP-side practical guide is in [MCP Tool Cheat Sheet](./mcp_tool_cheat_sheet.md)
