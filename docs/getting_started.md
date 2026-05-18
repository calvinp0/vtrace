# Getting Started

This guide assumes you are running `vexb` from a local clone of this repo.

Examples use `./bin/vexb`. If `vexb` is already on your `PATH`, you can use that instead.

Replace `/path/to/your/repo` with the repository you want to inspect.

## 1. Install Dependencies

```bash
bun install
./bin/vexb --help
```

`vexb` requires Bun because the CLI and MCP server run on Bun.

## 2. Set Up a Repo

```bash
./bin/vexb setup /path/to/your/repo
```

`setup` will:

- detect the repo root
- create or refresh repo-local state under `.vexb/`
- build the initial index when needed
- evaluate readiness
- install MCP config for the selected shell agent
- optionally start the background runtime daemon

Repeated setup is safe.

## 3. Check Readiness

Use `status` for the short version:

```bash
./bin/vexb status /path/to/your/repo
```

Use `doctor` when you want more detail:

```bash
./bin/vexb doctor /path/to/your/repo
```

## 4. Choose an Agent

Supported shell agents:

- `claude-code` (default)
- `codex`

Choose Codex explicitly:

```bash
./bin/vexb setup /path/to/your/repo --agent codex
```

The compatibility command name stays `claude-config`, even when you target Codex:

```bash
./bin/vexb claude-config /path/to/your/repo --agent codex --dry-run
```

Config paths:

- Claude Code: `~/.claude.json` local MCP scope
- Codex: `.codex/config.toml`

## 5. Understand Repo-Local Files

`vexb` stores repo-local state in `.vexb/`:

- `.vexb/config.json`
- `.vexb/state.json`
- `.vexb/index.sqlite`

That SQLite file is the local structural index used by the CLI and MCP server.

## 6. Start Using the Index

Direct shell examples:

```bash
./bin/vexb skeleton /path/to/your/repo src/controller.ts
./bin/vexb impact-graph /path/to/your/repo "src/session.ts::SessionManager.createSession"
./bin/vexb intent /path/to/your/repo "trace how sessions are created"
./bin/vexb capsule /path/to/your/repo "smallest safe edit surface for session creation"
```

For MCP-first workflows, start with `run_pipeline`. The practical guide is in [MCP Tool Cheat Sheet](./mcp_tool_cheat_sheet.md).

## 7. Optional Daemon

The daemon is optional. Most users can rely on on-demand launch through Claude Code or Codex.

If you want an explicit background runtime:

```bash
./bin/vexb daemon start /path/to/your/repo
./bin/vexb daemon status /path/to/your/repo
./bin/vexb daemon logs /path/to/your/repo
./bin/vexb daemon stop /path/to/your/repo
```

## 8. Manual MCP Server

The stable repo-bound MCP entrypoint is:

```bash
./bin/vexb mcp-serve --repo /path/to/your/repo
```

You usually do not need to run this manually after setup.

## 9. When to Re-Run Setup or Re-Index

Run setup again when:

- agent config changed
- readiness looks wrong
- you want to switch between Claude Code and Codex

Run a fresh index when:

- the repo changed substantially
- `status` or `doctor` says the index may be stale
- you want fresh structural outputs immediately

```bash
./bin/vexb index /path/to/your/repo
```
