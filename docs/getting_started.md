# Getting Started

This guide assumes you are running `vtrace` from a local clone of this repo.

Examples use `./bin/vtrace`. If `vtrace` is already on your `PATH`, you can use that instead.

Replace `/path/to/your/repo` with the repository you want to inspect.

## 1. Install Dependencies

```bash
bun install
./bin/vtrace --help
```

`vtrace` requires Bun because the CLI and MCP server run on Bun.

## 2. Set Up a Repo

```bash
./bin/vtrace setup /path/to/your/repo
```

`setup` will:

- detect the repo root
- create or refresh repo-local state under `.vtrace/`
- build the initial index when needed
- evaluate readiness
- install MCP config for the selected shell agent
- optionally start the background runtime daemon

Repeated setup is safe.

## 3. Check Readiness

Use `status` for the short version:

```bash
./bin/vtrace status /path/to/your/repo
```

Use `doctor` when you want more detail:

```bash
./bin/vtrace doctor /path/to/your/repo
```

## 4. Choose an Agent

Supported shell agents:

- `claude-code` (default)
- `codex`

Choose Codex explicitly:

```bash
./bin/vtrace setup /path/to/your/repo --agent codex
```

The compatibility command name stays `claude-config`, even when you target Codex:

```bash
./bin/vtrace claude-config /path/to/your/repo --agent codex --dry-run
```

Config paths:

- Claude Code: `~/.claude.json` local MCP scope
- Codex: `.codex/config.toml`

## 5. Understand Repo-Local Files

`vtrace` stores repo-local state in `.vtrace/`:

- `.vtrace/config.json`
- `.vtrace/state.json`
- `.vtrace/index.sqlite`

That SQLite file is the local structural index used by the CLI and MCP server.

## 6. Start Using the Index

Direct shell examples:

```bash
./bin/vtrace skeleton /path/to/your/repo src/controller.ts
./bin/vtrace impact-graph /path/to/your/repo "src/session.ts::SessionManager.createSession"
./bin/vtrace intent /path/to/your/repo "trace how sessions are created"
./bin/vtrace capsule /path/to/your/repo "smallest safe edit surface for session creation"
```

For MCP-first workflows, start with `run_pipeline`. The practical guide is in [MCP Tool Cheat Sheet](./mcp_tool_cheat_sheet.md).

## 7. Optional Daemon

The daemon is optional. Most users can rely on on-demand launch through Claude Code or Codex.

If you want an explicit background runtime:

```bash
./bin/vtrace daemon start /path/to/your/repo
./bin/vtrace daemon status /path/to/your/repo
./bin/vtrace daemon logs /path/to/your/repo
./bin/vtrace daemon stop /path/to/your/repo
```

## 8. Manual MCP Server

The stable repo-bound MCP entrypoint is:

```bash
./bin/vtrace mcp-serve --repo /path/to/your/repo
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
./bin/vtrace index /path/to/your/repo
```

If you want `vtrace` to notice source edits passively, start the optional watcher:

```bash
./bin/vtrace watch /path/to/your/repo
```

The default watcher is conservative and mark-stale-only. It detects indexed source file creates, modifications, and deletions using the same source-scan ignore rules as indexing, debounces bursts, and records pending stale state. Run `vtrace index` when you want a fresh structural snapshot without enabling auto-reindex.

If you want the watcher to re-index after debounced source changes, opt in explicitly:

```bash
./bin/vtrace watch /path/to/your/repo --auto-reindex
```

Auto-reindex is not enabled by setup and is not required for normal use. It prevents overlapping watcher-triggered index runs and keeps failure/stale metadata visible in `status`, `doctor`, MCP `index_status`, and `run_pipeline.diagnostics.freshness`. A manual `vtrace index /path/to/your/repo` remains the authoritative refresh path.
