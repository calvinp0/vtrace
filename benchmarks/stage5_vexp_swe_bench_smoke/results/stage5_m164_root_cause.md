# M164-A/B — why an indexed repository was unreadable, and what changed

M163 forced twelve agents to call VTRACE and all fourteen calls came back refused.
The refusals were not retrieval failures. They were `repo_not_ready`, returned
beside diagnostics that read `fresh`, `coverageComplete: true`, and an indexed
worktree identical to the requested one down to the head commit. M164-A found
which authority was wrong; M164-B repaired it and proved delivery through the
sweep's own preparation path.

## What "ready" meant before

Two different things, depending on which surface was asked.

The **CLI** asked the repository. `resolveRepoCommandPaths` reads repo-local
config if it is there, falls back to repo-local default paths if it is not, and
proceeds either way. That is why `vtrace capsule` has served workspaces built by
`vtrace index` alone since long before Stage 5 existed, and why every
deterministic retrieval eval in this benchmark has worked.

The **MCP server** asked two files. `resolveReadyRepoBinding` required
`config.initialized === true`, `state.initialized === true`, and
`state.readiness.status === "ready"` — all three read out of `.vtrace/config.json`
and `.vtrace/state.json`.

## Why MCP rejected indexed workspaces

`vtrace index` on a repository that was never initialized deliberately writes no
lifecycle files. The guard is explicit in `refreshRepoLocalStateAfterIndex`:

```
input.usesDbPathOverride || (!input.configPresent && !input.statePresent) -> return null
```

It is a do-not-litter rule — indexing a repository that has no vtrace workspace
should not conjure one — and it dates to `5ef21df4`, long before any of this.
It is not a bug. It is simply the other lifecycle.

The Stage 5 runner prepares every workspace with `bun src/cli/index.ts index
<workspace>` and never `init`. So each of the twelve trigger-arm workspaces held
`index.sqlite`, `index.meta.json` and `session.sqlite`, and no `config.json` or
`state.json`. The MCP gate read that absence as a statement about the index and
refused.

## Which authority was wrong

The server's. Three findings decide it, and none of them is an argument from
tidiness:

**The read path does not consume what it was gating on.** Traced by consumer
across `src/mcp/tools.ts`: after the gate, `binding.config` is never read again
at all, and `binding.state` is read at exactly two sites, both passing optional
fields into `inspectIndexFreshness` — whose own signature marks all three
optional. Repo-local config supplies a database-path override; repo-local state
supplies watcher-derived signals that *refine* a freshness verdict. Neither
establishes readiness.

**A live verdict was already in hand and was discarded.** `get_code_context`
calls `evaluateIndexReadiness` — M141's single evaluator — before it calls the
gate. That evaluator answers from the index and its manifest: repository
identity, worktree identity, schema and derivation compatibility, required
capabilities, source freshness. It never reads a lifecycle file. It said `ready`.
The gate then said `repo_not_ready` on the strength of two absent files. The
thing it deferred to instead, `state.readiness`, is a snapshot written at index
time and cannot see anything that happened afterwards.

**The product contradicted itself inside one response.** `index_status` on an
index-only workspace returns `readiness: null` (from `state.json`) beside
`indexReadiness: ready` (from the live evaluator). Both fields, same call.

Measured on one source tree built two ways, with file/symbol/edge counts and
indexer, parser, schema and config fingerprints all identical:

| Surface | init + index | index only |
| --- | --- | --- |
| `evaluateIndexReadiness` | ready | **ready** |
| CLI `vtrace capsule` | serves | **serves** |
| MCP `get_code_context` | serves | **repo_not_ready** |
| MCP `index_status.readiness` | ready | **null** |
| MCP `index_status.indexReadiness` | ready | **ready** |

A user reaches this state without a benchmark anywhere near it: run `vtrace index
~/some/repo`, point an MCP client at it, and every engine-backed tool refuses
permanently. The documented escape — `agentGuidance` says a `repo_not_ready` is
fixed by calling `index_repo`, and `index_repo` genuinely does call `initRepo`
when the lifecycle files are missing — was unreachable in M163, because the sweep
exposed exactly two tools and `index_repo` was not one of them.

**Classification: `SERVER_READINESS_DEFECT`.**

## What now establishes read-only repository readiness

A repository that **recorded a lifecycle** keeps the pre-M164 gate exactly. Its
`config.json` and `state.json` exist, so the state they persist is the thing to
check, and a workspace whose own record says it is not ready is still refused on
that record. Nothing about the initialized path changed.

A repository that was **only ever indexed** has no such record to consult, and its
authority is now the index itself, evaluated live by `evaluateIndexReadiness` —
the same evaluator `index_status` and the CLI already use. Two conditions bound
it:

- If an index is **absent entirely**, the refusal is unchanged, message and
  details included. "Not initialized" is the accurate and actionable thing to say
  about a repository that has nothing at all, and M164 deliberately changes only
  what happens to repositories that *do* carry an index.
- If the context was bound to a **different database** than the repo-local one,
  the refusal stands. The evaluator's verdict describes the repo-local index, so
  it cannot be spent licensing a read of some other file.

## What still requires init

Everything init was actually for. Repo-local configuration including a database
path override, the persisted readiness record, watcher and auto-reindex state,
and the `.vtrace` gitignore entry. Read-only retrieval never needed any of it;
`init` remains the way to get a configured, watchable, recorded workspace.

## What still refuses

Every negative state, verified on index-only workspaces where there is no
lifecycle record to fall back on:

| State | Result | Reason returned |
| --- | --- | --- |
| valid index, no lifecycle files | **serves** | — |
| no index | refuses | `missing_index` |
| stale index (source moved) | refuses | `repo_not_ready` |
| wrong revision (committed past the index) | refuses | `repo_not_ready` |
| wrong worktree (index built elsewhere) | refuses | `repo_not_ready` |
| incompatible schema version | refuses | `repo_not_ready` |
| stale derivation fingerprint | refuses | `repo_not_ready` |
| corrupt / unreadable index | refuses | — |
| missing manifest | refuses | `repo_not_ready` |
| database-path override, no lifecycle record | refuses | `db_path_override_without_init` |
| degraded but usable (a file failed to parse) | **serves** | — |

The last row is M156 and it is a negative-of-the-negative: coverage is reported
beside the readiness verdict rather than folded into it, so one unparseable file
does not take a repository offline. Zero index writes occurred during any read.

## Before and after

| Workspace state | Before M164 | After M164 |
| --- | --- | --- |
| no index | refuses (`not initialized`) | refuses (`not initialized`, unchanged) |
| valid index only | **refuses** | **serves** |
| init + valid index | serves | serves (unchanged) |
| stale index | refuses | refuses |
| wrong repo/worktree index | refuses | refuses |
| degraded valid index | serves | serves |

## Delivery, proved through the sweep's own path

The permanent M163 lesson is that a control which passes on a differently
prepared specimen validates the wrong path. M163's gates passed on `init` +
`index` fixtures while its sweep used `index` alone, so they could not have caught
this.

So the M164 control uses the subject workspaces themselves. The twelve trees the
M163 trigger arm actually ran against are still on disk. Each was restored to its
base commit, re-prepared with the runner's own index step, asserted to carry an
index and no lifecycle files, and then asked through a real `mcp-serve` child
process started from the sweep's own `buildVtraceMcpConfig` arguments:

```text
                       M163        M164
VALID_NONEMPTY          0/12       12/12
REPO_NOT_READY         12/12        0/12
index-only shape       12/12       12/12
tools visible            2           2
index writes on read     0           0
```

Every case returned named source paths — between 1 and 53 distinct files, median
4.5. What this does **not** prove is the agent half: whether an agent complies
with the trigger, and whether it uses what comes back, are live questions and are
not claimed here. What it proves is that the product now answers a sweep-shaped
workspace with repository evidence, which is exactly what M163 could not do.

## Scope of the change

One function, `resolveReadyRepoBinding` in `src/mcp/tools.ts`, plus making
`ReadyRepoBinding.config` and `.state` optional and the two freshness-signal
consumers optional-safe. No retrieval, ranking, candidate generation, query
shaping, support packing, pivot logic, tool schema, tool description or
behavioural routing was touched. The runner was not changed, deliberately: the
sweep must keep preparing workspaces the way it did, or the control stops testing
the subject.
