# Troubleshooting

## Start Here

If something looks off, check repo readiness first:

```bash
./bin/vexb status <repo>
./bin/vexb doctor <repo>
```

Use `status` for the short answer and `doctor` for the detailed one.

## Repo Is Not Initialized or Not Ready

If `status` or `doctor` says setup is missing or readiness is not `ready`:

```bash
./bin/vexb setup <repo>
```

If you are outside the repo:

```bash
./bin/vexb setup /path/to/your/repo
```

Repeated setup is safe.

## Results Look Stale

If the repo changed and you want fresh structural output:

```bash
./bin/vexb index <repo>
./bin/vexb status <repo>
```

Freshness warnings should be taken seriously before you rely on structural results.

## Agent Config Is Missing or Outdated

Refresh the MCP config:

```bash
./bin/vexb claude-config <repo>
./bin/vexb claude-config <repo> --agent codex
```

Preview without writing:

```bash
./bin/vexb claude-config <repo> --dry-run
./bin/vexb claude-config <repo> --agent codex --dry-run
```

Config paths:

- Claude Code: `~/.claude.json` local MCP scope
- Codex: `.codex/config.toml`

## Runtime Is Not Running

The daemon is optional. Claude Code and Codex can still launch `vexb` on demand through MCP config.

If you want the background runtime:

```bash
./bin/vexb daemon start <repo>
./bin/vexb daemon status <repo>
./bin/vexb daemon logs <repo>
./bin/vexb daemon stop <repo>
```

If the log is empty, the daemon may not have started yet or may not have handled traffic yet.

## A Structural Tool Returns No Result

Check these cases:

- `get_impact_graph` works best with exact symbol FQNs
- `search_logic_flow` requires exact `start` and `end` FQNs
- `search_logic_flow` is structural, not semantic or runtime
- if the index is stale, rebuild it before trusting the result

When the question is broad rather than exact, start with `run_pipeline`.

## You Want to Run the MCP Server Manually

The stable repo-bound launcher is:

```bash
./bin/vexb mcp-serve --repo <repo>
```

You usually do not need to run it manually after setup.

## A Visible MCP Tool Is Not Useful for Normal Work

`expand_vexp_ref` is the advanced exception in the visible tool list.

For normal use, start with:

- `run_pipeline`
- `get_context_capsule`
- `get_skeleton`
- `get_impact_graph`
- `search_logic_flow`
- memory/session tools as needed

## Useful Next Commands

- `./bin/vexb setup <repo>`
- `./bin/vexb status <repo>`
- `./bin/vexb doctor <repo>`
- `./bin/vexb index <repo>`
- `./bin/vexb claude-config <repo> --agent codex --dry-run`
- `./bin/vexb daemon status <repo>`
