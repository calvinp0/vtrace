# vexb

`vexb` is a repo-bound, local-first code indexing and MCP tool for structural code exploration.

It builds a deterministic index for a repository, exposes a small stable MCP surface, and gives you practical shell commands for setup, status, context packaging, skeleton views, impact graphs, and other bounded structural analysis.

## What vexb is for

Use `vexb` when you want:

- a repo-local index instead of a remote service
- deterministic structural outputs you can inspect
- a stable MCP server for Claude Code or Codex
- compact context assembly for coding tasks
- conservative answers about file structure, symbol impact, and symbol-to-symbol paths

`vexb` is intentionally structural. It does not pretend to do runtime tracing, semantic dataflow, or fuzzy architectural guessing.

## Requirements

- [Bun](https://bun.sh/) installed locally
- a local repository to index
- Claude Code or Codex only if you want MCP config installed automatically

## Install

Clone the repo and install dependencies:

```bash
git clone <repo-url> vexb
cd vexb
bun install
```

Run the local wrapper directly from the repo:

```bash
./bin/vexb --help
```

If you put `vexb` on your `PATH`, you can drop the `./bin/` prefix in the examples below.

Replace `/path/to/your/repo` with the repository you want to inspect.

## Quick Start

Set up a repo for `vexb`:

```bash
./bin/vexb setup /path/to/your/repo
./bin/vexb status /path/to/your/repo
```

Inspect structure directly from the shell:

```bash
./bin/vexb skeleton /path/to/your/repo src/controller.ts
./bin/vexb impact-graph /path/to/your/repo "src/session.ts::SessionManager.createSession"
```

Launch the repo-bound MCP server manually when needed:

```bash
./bin/vexb mcp-serve --repo /path/to/your/repo
```

In normal use you usually do not run `mcp-serve` yourself after setup. Claude Code and Codex launch it through the installed MCP config.

## Shell Workflow

The main user-facing shell commands are:

- `setup`: initialize the repo, build or refresh the index, install agent config, optionally start the daemon
- `status`: compact readiness/freshness view
- `doctor`: more detailed readiness and runtime inspection
- `claude-config`: install or preview Claude Code or Codex MCP config
- `daemon`: optional background runtime lifecycle
- `mcp-serve`: repo-bound MCP server entrypoint

There are also direct inspection commands for manual flows:

- `index`
- `intent`
- `capsule`
- `skeleton`
- `impact-graph`
- `handoff`
- `runs`
- `check-capsule`

## MCP Workflow

The default MCP tool is `run_pipeline`.

Use the specialized tools when the question becomes narrower:

- `get_context_capsule`: compact task context only
- `get_skeleton`: cheap file shape
- `get_impact_graph`: structural blast radius
- `search_logic_flow`: bounded path between two exact symbol FQNs
- `search_memory` / `get_session_context`: continuity
- `index_status` / `workspace_setup`: health and setup
- `save_observation`: durable memory

For the practical tool-by-tool guide, see [MCP Tool Cheat Sheet](./docs/mcp_tool_cheat_sheet.md).

## Repo-Local State

`vexb` keeps repo-local state under `.vexb/`:

- `.vexb/config.json`: repo-local config and resolved paths
- `.vexb/state.json`: readiness, latest run, and freshness metadata
- `.vexb/index.sqlite`: the repo-local SQLite index

Repeated `setup` is safe. If the repo is already ready, `vexb` reuses the current state conservatively.

## Release and Distribution

`vexb` is currently distributed as a local-source install. The supported install path today is cloning this repository, running `bun install`, and using the repo-local `./bin/vexb` launcher.

The VS Code extension is private/local packaging only. It can be packaged locally with:

```bash
bun run package:vscode
```

npm and VS Marketplace publication are planned release options, but they are not part of the current RC1 release path.

## Agent Setup

`setup` installs MCP config for the selected shell agent.

Supported agents:

- `claude-code` (default)
- `codex`

Examples:

```bash
./bin/vexb setup /path/to/your/repo --agent codex
./bin/vexb claude-config /path/to/your/repo --agent codex --dry-run
```

The command name stays `claude-config` for compatibility even when you target Codex.

## Recommended Reading

- [Getting Started](./docs/getting_started.md)
- [CLI Usage](./docs/cli_usage.md)
- [MCP Tools Reference](./docs/mcp_tools.md)
- [MCP Tool Cheat Sheet](./docs/mcp_tool_cheat_sheet.md)
- [Troubleshooting](./docs/troubleshooting.md)

## Current Boundaries

`vexb` is conservative by design:

- structural outputs are based on indexed repository data
- `search_logic_flow` requires exact start and end FQNs
- impact and flow tools are not runtime execution proofs
- the optional daemon is inspectable, but not required
