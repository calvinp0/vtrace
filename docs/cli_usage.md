# CLI Usage

Examples below use `./bin/vexb`. If you install `vexb` elsewhere, replace that wrapper with your preferred launcher.

Replace `<repo>` with the repository you want to inspect.

## Product-Shell Commands

These are the commands most users should start with:

```bash
./bin/vexb setup [repo] [--start-runtime] [--agent <name>] [--json]
./bin/vexb status [repo] [--agent <name>] [--json]
./bin/vexb doctor [repo] [--agent <name>] [--json]
./bin/vexb claude-config [repo] [--dry-run] [--agent <name>] [--json]
./bin/vexb daemon <start|stop|status|logs> [repo] [--json]
./bin/vexb workspace <init|add|list|status> ...
./bin/vexb mcp-serve --repo <repo>
```

What they are for:

- `setup`: initialize the repo-local state and index
- `status`: compact readiness and freshness
- `doctor`: more detailed inspection
- `claude-config`: install or preview Claude Code / Codex config
- `daemon`: optional background runtime control
- `workspace`: create, update, list, and inspect `.vexb/workspace.json`
- `mcp-serve`: repo-bound MCP server

## Direct Inspection Commands

These are useful when you want manual control instead of the full MCP shell flow:

```bash
./bin/vexb init <repo>
./bin/vexb index <repo>
./bin/vexb intent <repo> <query>
./bin/vexb capsule <repo> <query>
./bin/vexb skeleton <repo> <file> [--detail <minimal|standard|detailed>]
./bin/vexb impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]
./bin/vexb handoff <repo> <query>
./bin/vexb runs <repo>
./bin/vexb check-capsule <repo> <manifest-id> <comparison-run-id>
```

## Common Examples

Set up a repo:

```bash
./bin/vexb setup <repo>
```

Check whether the index is ready or stale:

```bash
./bin/vexb status <repo>
./bin/vexb doctor <repo>
```

Re-index the repo:

```bash
./bin/vexb index <repo>
```

Show the structure of a file:

```bash
./bin/vexb skeleton <repo> src/session.ts --detail standard
```

See what depends on an exact symbol:

```bash
./bin/vexb impact-graph <repo> "src/session.ts::SessionManager.createSession"
```

Preview Codex config without writing it:

```bash
./bin/vexb claude-config <repo> --agent codex --dry-run
```

Create a multi-repo workspace config:

```bash
./bin/vexb workspace init --alias backend
./bin/vexb workspace add frontend ../frontend
./bin/vexb workspace list
./bin/vexb workspace status
```

## JSON Output

The product-shell commands support `--json`:

- `setup`
- `status`
- `doctor`
- `claude-config`
- `daemon`

That is useful for scripts, editors, or wrappers that want structured output.

## Repo-Local State

`vexb` keeps repo-local files under `.vexb/`:

- `.vexb/config.json`
- `.vexb/state.json`
- `.vexb/index.sqlite`
- `.vexb/workspace.json` when a multi-repo workspace is configured

## Notes

- repeated `setup` is safe
- the daemon is optional
- most users should start from `setup`, `status`, and the MCP workflow
- the MCP-side practical guide is in [MCP Tool Cheat Sheet](./mcp_tool_cheat_sheet.md)
