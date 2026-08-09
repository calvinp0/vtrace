# M132 — Worktree Routing and Repository-Identity Integrity (plan + decisions)

Starting commit: `238000b` (M131, PASS). Branch `main`. No live agents, no Docker,
no VEXP, no paid APIs.

The objective, stated once:

> A VTRACE query must describe the checkout the agent is actually working in,
> index only that checkout, and never infer architecture from duplicated
> worktree content.

## The four problems, and what each turned out to be

| # | Reported as | Actual root cause |
|---|---|---|
| A | "index contains a nested worktree producing duplicate hits" | `scanRepo` descends into any child directory. Nested linked worktrees are ordinary directories, so a full second checkout of the same repository is enumerated as source. The `IGNORED_DIRECTORIES` name list could never have covered it: worktree directories are named by whoever created them (`feature_docker_ux`, `.claude/worktrees/<agent-id>`). |
| B | "index is bound to /home/calvin/code/ARC and does NOT contain PR #944's code" | Only `get_code_context`, `index_repo`, `index_status` and `check_capsule_staleness` accepted `repo_root`. `get_context_capsule`, `run_pipeline`, `get_impact_graph`, `search_logic_flow` and `get_skeleton` had no way to name a worktree at all, so they always used the server-bound root. Nothing in the response said which checkout had answered. |
| C | "task mentions high-signal literal ARC (symbol name)" on a geometry question | `extractLiteralAnchors` classifies `ARC` as an ALL-CAPS acronym anchor. `resolveAnchor`'s acronym branch matches exact-case symbols (the `ARC` class) **and path segments** — and `arc` is a path segment of every file in the package. The repository's own name was acting as a pointer into the repository. |
| D | "`mcp__vtrace__search_symbols` does not exist" | It exists (`src/mcp/tools.ts`) but is registered in `hiddenTools`, so it never appears in `tools/list`. The agent's observation was correct for everything it could see; the generated guidance was the stale part. |

## Decisions taken

**Nested-worktree exclusion is Git-aware, not name-based.** `git worktree list
--porcelain` is run once per index/scan; any registered worktree root that is a
strict descendant of the requested root is excluded. Consequences, deliberately:

- Submodules are untouched. A submodule's `.git` file points into
  `<super>/.git/modules/…` and it never appears in `git worktree list`.
- Unregistered nested Git repositories (a plain clone dropped inside) are
  untouched, for the same reason. Changing that is a separate policy question.
- The requested worktree is never excluded from its own scan.
- Path matching is segment-aware: `/code/ARC.worktrees/x` string-prefixes
  `/code/ARC` but is not a descendant.

**Routing precedence is `explicit_root` > `client_context` > `process_default`,
and the server's cwd is not a candidate.** MCP does not transmit caller cwd —
see the availability finding below — so `repo_root` is the product contract and
every response reports which source supplied the root.

**Contaminated indexes are cleaned by the existing refresh path, not a new one.**
`src/fs/scanRepo.ts` and the new `src/fs/worktreeExclusions.ts` are hashed into
the index `config_hash`, so every pre-M132 index reports `configuration_changed`
— already in the auto-refresh allow-list. On refresh the excluded files are
simply absent from the current file set, `planIncrementalRefresh` classifies them
as deletions, and the ordinary delete path removes their symbol/edge/document/FTS
rows. **No new freshness reason was added** (§44): `configuration_changed`
describes an enumeration-rule change accurately, and once exclusion is in force,
adding or removing a nested worktree no longer changes the parent's source
fingerprint at all — there is no residual topology event left to report.
`head_mismatch` was never involved.

**No schema or manifest version bump** (§45). Capability fingerprinting already
represents the change.

**Repository-name suppression is scoped to one generator.** The term is dropped
before anchor *resolution* in `literalAnchoring`, so it can reach neither the
exact-case-symbol branch nor the path-segment branch. No score weight was
retuned. The alias source is the repository basename only; package-metadata
parsing was not introduced for this fix (§26).

**`search_symbols` stays hidden; the guidance was fixed** (§32). Exact symbol
lookup is served by `get_code_context`. `docs/product_truth_audit_rc.md` had
already recorded "keep hidden; avoid promoting in RC docs" — M132 makes the
generated guidance agree with that decision, and adds a test so it cannot drift
again.

## What MCP actually knows about the caller (§13)

Investigated in `src/mcp/startServer.ts`. The stdio JSON-RPC surface handles
`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
On `initialize` it returns protocol version, a `tools` capability and
`serverInfo`; it neither declares nor consumes the client `roots` capability, and
never issues `roots/list`. There is **no per-call caller working directory in the
protocol**, and `roots` — if implemented — would describe client workspace roots
rather than the cwd of the subagent making a particular call. `process.cwd()` is
the server's launch directory, which is precisely the value that must not win.

Conclusion, recorded honestly rather than worked around: reliable automatic
caller cwd is unavailable today. `McpServerContext.clientContextRoot` exists as
the seam for a runtime that can supply one, and is `null` in practice.

## Scope

Implemented: P0 nested-worktree exclusion, P0 MCP worktree routing, P0
fail-closed wrong-worktree behaviour, P0 same-worktree auto-refresh isolation,
P1 repository-name ranking suppression, P1 `search_symbols`/guidance
reconciliation, P1 impact symbol hydration batching, P1 contaminated-index
cleanup.

Not implemented, moved to M133: workspace registry, multi-repository candidate
aggregation, cross-repository Capsule packing or graph edges, and everything else
listed as out of scope.
