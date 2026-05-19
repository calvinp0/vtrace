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
./bin/vtrace watch [repo] [--auto-reindex] [--debounce-ms <n>] [--poll-ms <n>] [--json]
./bin/vtrace workspace <init|add|list|status> ...
./bin/vtrace mcp-serve --repo <repo>
```

What they are for:

- `setup`: initialize the repo-local state and index
- `status`: compact readiness and freshness
- `doctor`: more detailed inspection
- `claude-config`: install or preview Claude Code / Codex config
- `daemon`: optional background runtime control
- `watch`: optional source file watcher; mark-stale-only by default, auto-reindex only with `--auto-reindex`
- `workspace`: create, update, list, and inspect `.vtrace/workspace.json`
- `mcp-serve`: repo-bound MCP server

## Canonical RC Flow

Recommended onboarding path:

```bash
./bin/vtrace setup <repo> --agent codex
./bin/vtrace status <repo>
./bin/vtrace index <repo>
./bin/vtrace watch <repo>
```

`setup` is the recommended onboarding command. It initializes repo-local state, builds the initial index when needed, evaluates readiness, and installs agent config. Use an explicit `index` when you want to refresh the structural snapshot after setup or after source changes.

`watch` is optional and mark-stale-only by default. It records pending source changes in `.vtrace/state.json`; it does not auto-reindex unless you pass `--auto-reindex`. A successful explicit `index` clears pending watcher stale state and records the new structural snapshot.

Lower-level manual path:

```bash
./bin/vtrace init <repo>
./bin/vtrace index <repo>
./bin/vtrace status <repo>
```

Use this when you want repo-local initialization and indexing without the full setup/config flow.

## Direct Inspection Commands

These are useful when you want manual control instead of the full MCP shell flow:

```bash
./bin/vtrace init <repo>
./bin/vtrace index <repo>
./bin/vtrace intent <repo> <query>
./bin/vtrace capsule <repo> <query>
./bin/vtrace run-pipeline <repo> <query> [--intent <auto|explore|debug|modify|refactor>] [--session-id ID] [--max-budget-characters N] [--include-memory]
./bin/vtrace expand-vexp-ref <repo> <hash> [--query <query>] [--session-id ID] [--intent <auto|explore|debug|modify|refactor>] [--max-budget-characters N] [--include-memory]
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

Opt into debounced automatic reindexing:

```bash
./bin/vtrace watch <repo> --auto-reindex
```

Auto-reindex is never enabled by setup or by default. It still records visible watcher/freshness state, prevents overlapping index runs for the same watcher process, and leaves stale/failure metadata visible if indexing fails. Explicit `vtrace index <repo>` remains available and authoritative.

Run the compact orchestration pipeline from the CLI:

```bash
./bin/vtrace run-pipeline <repo> "how does indexing work?"
./bin/vtrace run-pipeline <repo> "rename createSession safely" --intent refactor --max-budget-characters 8000
```

`run-pipeline` emits the same compact orchestration shape used by the VS Code shell: intent, task summary, context, impact, memory, diagnostics, deferred references, and rules when relevant. The direct command emits JSON; it does not currently need or accept `--json`.

Expand a V-REF from the CLI:

```bash
./bin/vtrace expand-vexp-ref <repo> a1b2c3d4e5f6
```

The CLI first checks the process-local hot cache and retained repo-local `.vtrace` SQLite store, so a V-REF emitted by a previous `run-pipeline` invocation can resolve without `--query` while it is still retained.

If a retained record is missing, pass the original query as a fallback/debug path so the command can republish the same deferred refs before resolving the hash:

```bash
./bin/vtrace run-pipeline . "how does run_pipeline build deferred refs?"

./bin/vtrace expand-vexp-ref . a1b2c3d4e5f6 \
  --query "how does run_pipeline build deferred refs?"
```

If the original run used relevant options such as `--intent`, `--session-id`, `--max-budget-characters`, or `--include-memory`, pass the same options to `expand-vexp-ref` with `--query` when using the fallback republish path.

## V-REF Expansion: MCP vs CLI

MCP `expand_vexp_ref` remains the primary expansion path for agents because it can use the current MCP server process-local hot cache and can also resolve retained repo-local persistent records after restart. It resolves exact 12-character lowercase hex V-REF hashes emitted by `run_pipeline`.

CLI `expand-vexp-ref` can resolve retained persistent refs without `--query`. Each CLI invocation still starts a separate process, so `--query` remains useful as a fallback/debug path when a ref was not retained or was removed by cleanup.

V-REF persistence is repo-local and bounded, not permanent. The current policy keeps up to 1000 persisted V-REF records per repo-local database and bounded tombstones for cleanup. Expansion is exact hash lookup only; it is not fuzzy, does not semantically reconstruct missing content, and does not reread changed source files as stored truth. Multi-repo deferred expansion remains limited.

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

Several direct inspection commands, including `run-pipeline` and `expand-vexp-ref`, already emit JSON directly and do not currently accept a separate `--json` flag.

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
