# Contributing

`vtrace` is currently maintained as a local-source project.

Before opening a change, run:

```bash
bun install
bun run typecheck
bun run format:check
bun run lint
bun test
bun run package:vscode
```

Keep changes scoped. RC1 work should avoid redesigning indexing, retrieval, MCP behavior, capsules, memory, or `run_pipeline` unless a milestone explicitly asks for it.

## TypeScript Baseline

`tsconfig.json` is intentionally a realistic RC1 baseline. Tests are excluded from project typecheck, and older high-churn implementation files that already have type drift are marked with `@ts-nocheck`. New source files should typecheck cleanly, and follow-up hardening should remove those file-level suppressions incrementally.

`bun run lint` currently aliases the TypeScript baseline check. A full ESLint rule set is deferred until the existing type baseline is tightened.
