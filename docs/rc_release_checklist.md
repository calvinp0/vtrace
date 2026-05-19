# RC Release Checklist

Date: 2026-05-19

This checklist prepares `vtrace` for an RC release without adding features or changing product behavior.

## Product Truth Status

The RC product truth audit is closed.

- Audit doc: [`docs/product_truth_audit_rc.md`](./product_truth_audit_rc.md)
- Closing commits:
  - `74548fa docs: audit product truth for RC`
  - `24a0d5d fix(mcp): align run_pipeline output schema`
  - `62fa384 docs: document CLI pipeline and V-REF commands`
  - `75c07c2 chore(rc): clarify naming compatibility`
  - `ff90939 docs: close RC product truth audit`

Remaining acceptable RC limitations:

- V-REFs are exact, bounded, and process-local.
- CLI V-REF expansion needs `--query` republish across invocations.
- Multi-repo `run_pipeline` does not emit deferred expansion items.
- `workspace_setup.status.claudeCode` remains a compatibility field for this schema version.
- `vtrace` remains deterministic lexical/structural local tooling, not full VEXP parity.

RC-ready means ready as deterministic lexical/structural repo-local tooling with CLI, MCP, memory/session, watcher freshness, and project-rule surfaces. It does not mean full VEXP parity, semantic memory, persistent V-REFs, automatic reindexing, or codebase-specific retrieval intelligence.

## Required Validation Commands

These commands must pass before cutting the RC:

```bash
bun run typecheck
bun run format:check
bun test
git diff --check
```

CI also packages the VS Code extension. Run the local packaging command when validating CI parity:

```bash
bun run package:vscode
```

## Clean Setup Flow

Canonical RC onboarding flow:

```bash
./bin/vtrace setup <repo> --agent codex
./bin/vtrace status <repo>
./bin/vtrace index <repo>
./bin/vtrace watch <repo>
```

`setup` is the recommended onboarding command. It initializes repo-local state, builds the initial index when needed, evaluates readiness, and installs supported local-agent config for the selected agent.

`watch` is optional. It is mark-stale-only: it records pending source changes in `.vtrace/state.json` and reports freshness through status surfaces, but it does not auto-reindex. A successful explicit `index` clears watcher-observed stale state after the new structural snapshot is written.

## Manual Lower-Level Flow

Manual flow:

```bash
./bin/vtrace init <repo>
./bin/vtrace index <repo>
./bin/vtrace status <repo>
```

Use this path when debugging setup, avoiding agent config changes, or validating the repo-local state and indexer without the full onboarding command.

## MCP Smoke Test

Minimal MCP smoke test:

1. Start the repo-bound MCP server.
2. Verify `tools/list` exposes the 11 visible tools:
   - `run_pipeline`
   - `get_context_capsule`
   - `get_impact_graph`
   - `search_logic_flow`
   - `get_skeleton`
   - `index_status`
   - `workspace_setup`
   - `get_session_context`
   - `search_memory`
   - `save_observation`
   - `expand_vexp_ref`
3. Call `index_status`.
4. Call `run_pipeline`.
5. If the same MCP server process emits a V-REF, call `expand_vexp_ref` for that exact hash in the same process.
6. Call `save_observation`.
7. Call `get_session_context`.
8. Call `search_memory`.

The basic smoke test does not need to demonstrate every visible MCP tool. `expand_vexp_ref` should only be treated as passing when it expands a deferred item emitted by the same MCP server process.

## CLI Smoke Test

Minimal CLI smoke test:

```bash
./bin/vtrace status <repo>
./bin/vtrace run-pipeline <repo> "how does this repo build context?"
./bin/vtrace rules generate-candidates <repo>
./bin/vtrace rules list <repo>
```

Optional CLI V-REF debugging:

```bash
./bin/vtrace expand-vexp-ref <repo> <hash> --query "original run-pipeline query"
```

CLI V-REF expansion starts a separate process. Across invocations, pass the original `--query` and relevant run options so the command can republish matching deferred items before expansion. MCP `expand_vexp_ref` remains the primary process-local expansion path.

## VS Code Panel Smoke Test

If validating the VS Code extension, check only the existing panel behavior:

- panel opens
- setup/status displays
- reindex/setup action works
- run-pipeline action works
- V-REF expansion action is honest about needing republish/query when using the CLI path
- no stale `vexb` naming appears in public UI unless intentionally historical

Do not redesign the panel as part of RC validation.

## Release Blocker Checklist

| Check                           | Command/manual step                                         | Expected result                                              | Status | Notes |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ------ | ----- |
| Typecheck                       | `bun run typecheck`                                         | TypeScript completes without errors                          | TODO   |       |
| Format check                    | `bun run format:check`                                      | Prettier reports all checked files formatted                 | TODO   |       |
| Full tests                      | `bun test`                                                  | Full Bun test suite passes                                   | TODO   |       |
| CI parity                       | `bun run package:vscode`                                    | VS Code extension package command completes locally          | TODO   |       |
| Docs truth                      | Review `docs/product_truth_audit_rc.md` and RC docs         | Known limitations are explicit and no full VEXP parity claim | TODO   |       |
| CLI setup flow                  | `setup`, `status`, `index`, optional `watch`                | Repo reaches ready state; watch only marks stale             | TODO   |       |
| MCP setup flow for Codex        | `workspace_setup` or generated Codex config smoke           | Codex setup path is available and accurately reported        | TODO   |       |
| MCP setup flow for Claude Code  | `workspace_setup` or generated Claude Code config smoke     | Compatibility setup path remains available                   | TODO   |       |
| Watcher freshness               | `watch`, edit indexed source, `status`, `index`, `status`   | Stale state appears after edit and clears after index        | TODO   |       |
| `run_pipeline` schema parity    | MCP smoke or schema parity test                             | Actual output matches declared output schema                 | TODO   |       |
| V-REF process-local caveat      | MCP V-REF expansion and CLI docs review                     | Same-process MCP expansion works; CLI caveat is documented   | TODO   |       |
| Rules candidate/active behavior | `rules generate-candidates`, `rules list`, optional promote | Candidates are previews; only active rules inject guidance   | TODO   |       |
| No known uncommitted changes    | `git status --short`                                        | Working tree is clean before release                         | TODO   |       |

## Known RC Limitations

These are acceptable for RC and must remain visible in release validation:

- V-REFs are process-local, exact 12-character lowercase hex hashes backed by the current process store.
- CLI V-REF expansion requires `--query` republish across separate invocations.
- There is no auto-reindex. `watch` is opt-in and mark-stale-only.
- There are no embeddings or semantic memory.
- Project rules are deterministic guidance only; there is no auto-promotion of rules.
- There are no cross-repo rules.
- Retrieval, memory, rules, and freshness behavior are deterministic lexical/structural behavior.
- ARC is ready with known limitations, not perfect.
