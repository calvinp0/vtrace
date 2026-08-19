# M162-B/C — callable MCP wiring, live-path qualification, and tool telemetry

**M162-B: PASS OFFLINE / LIVE CONTROL PENDING. M162-C: PASS.**

Predecessor: `1962ccb0ba406309dddac6303b0afd77dc11c944` (M162-A).

M162-A proved that possessing two tools is not enough — tool 1 produced
identifiers tool 2 could not consume. B/C prove the same thing one level up, and
the chain has five separate links, none of which implies the next:

```
implemented  →  discoverable  →  allowed  →  correctly routed  →  composable  →  observable
```

Every link below the live-runtime boundary is now proved. The one link that
cannot be proved without spawning an agent is isolated into a single gated
control, so if that control fails we will know it is the runtime and not the
server, the routing, the identity contract, or the result semantics.

## What was actually broken

Three independent defects, any one of which would have silently produced a
CALLABLE arm with no callable tools:

| Defect | Consequence had it shipped |
| --- | --- |
| The MCP server exposed all 14 tools | ~5,518 schema tokens carried per turn — reproducing the prompt-prefix tax M162 exists to test, while claiming to remove it |
| The harness launches every agent with `--strict-mcp-config` against `{"mcpServers":{}}` | No VTRACE tool would ever have been present. This is why M155's agents never had them |
| The orchestrator's `--allowedTools` names no MCP tool | A correctly configured server would still have handed the agent two tools it was forbidden to call |

`mcp-serve` now takes `--tools`, restricting the model-visible surface at the
source with unlisted tools hidden rather than unregistered — the state
`search_symbols` already occupies. The adapter patch sets the adapter's *own*
`mcpConfigPath` and extends its *own* `allowedTools` before argument assembly,
so the harness keeps owning `--mcp-config`/`--strict-mcp-config`/`--allowedTools`
and there remains one authoritative live path. Both env vars fail closed:
unset, baseline and static commands are byte-identical to their pre-M162 form.

## The control that matters

Everything else is inference; this is observation. The argv control copies the
real external adapter, patches it with the real patcher, and runs it against a
fake `claude` that records its command line.

| Arm | `--mcp-config` contents | MCP tools in `--allowedTools` |
| --- | --- | --- |
| BASELINE / STATIC | `{"mcpServers":{}}` | none |
| CALLABLE | the VTRACE server, exactly one `--mcp-config` flag | exactly `mcp__vtrace__get_code_context`, `mcp__vtrace__get_impact_graph` |

A missing callable config logs a loud marker rather than silently degrading —
an untooled CALLABLE run is a treatment failure, never a zero-adoption data
point.

## Offline B gates

| Gate | Result |
| --- | --- |
| `--data` propagation | PASS — already present since M161; the gap was a missing control, not a missing flag. Two distinguishable data files produce distinguishable commands; absent when unset; identical across arms |
| MCP config generation | PASS |
| Exact two-tool exposure | PASS — served `tools/list` equals the frozen set exactly, not a superset |
| `--allowedTools` wiring | PASS — narrow, no wildcard; arm parity proved with negative controls for a leaked tool, an ordinary-tool asymmetry, a visible-but-unusable tool, and a thirteenth tool |
| Suite-policy delivery | PARTIAL — served exactly once on `initialize`, matching the authoritative constant; that the Claude runtime *surfaces* server instructions is a live assertion |
| Historical-policy exclusion | PASS — all five blocks rejected, detector proven on known positives |
| Baseline / static contamination | PASS |
| Worktree routing | PASS — two simultaneously existing, deliberately disjoint workspaces; no cross-contamination |
| Session isolation | PASS — `sessionIsolationValid: true`; one server process per session, bound at startup, torn down with it |
| Index read-only | PASS — **0 index writes** across retrieval and impact calls |
| Result-state semantics | PASS — all four states demonstrated and distinct |
| Boundedness | PASS |
| Direct-MCP composition | PASS |
| Compacted composition | PASS — compaction confirmed triggered |
| Schema token accounting | PASS |

### Result states

| State | How it was produced | Outcome |
| --- | --- | --- |
| `VALID_NONEMPTY` | ordinary hit | evidence returned |
| `VALID_EMPTY` | a task with no plausible match | **successful call**, `isError:false`, 0 items |
| `DEGRADED_VALID` | fault-injected `file_index_failures` row | `coverageComplete:false`, `absenceClaim:not_observed` preserved, call still succeeds |
| `TOOL_ERROR` | local-name-only and doubly-prefixed identifiers | refused as invalid input, never reported as empty |

The degraded state needed fault injection, and that is itself a finding: no
ordinary malformed source produced a recorded failure. Tree-sitter yields an
ERROR-node tree rather than failing, and invalid UTF-8 is decoded lossily. Both
files indexed and answered, so *"one bad file is not repo-fatal"* is proved by
observation; the *consumer* path was then proved by injecting the row.

### Boundedness

| Call | Tokens |
| --- | --- |
| `get_impact_graph` defaults | 1,239 |
| `get_impact_graph` at documented maxima, 40-caller fan-out | 14,421 |
| `get_impact_graph` beyond bounds | **refused** at 59 tokens |
| `get_code_context` with no `max_tokens` | **5,337** |

Bounds are the tool's own (`depth<=8, max_paths<=16, max_edges<=2000,
max_tokens<=20000`); no benchmark-specific limit was invented. An over-limit
request is refused cheaply rather than served — no M133-style regression.

## The economics finding

```
CALLABLE turn-0 fixed overhead   2,065 tokens   (1,937 schema + 128 policy)
Full 14-tool counterfactual      5,518 tokens   (3,581 declined)
One default get_code_context     5,337 tokens
M161 STATIC injected capsule    ~3,062 tokens   (12,249 bytes)
```

**A single unbounded `get_code_context` call costs more than M161's entire
static capsule** — about 1.7×. CALLABLE is not cheaper by construction; it is
cheaper only if the agent calls sparingly and with bounded budgets. That is now
a measurable hypothesis rather than an assumption, and it is the reason fixed
and dynamic tokens are accounted separately.

## M162-C — telemetry

Built on the seam the harness already uses: the injected adapter patch stays
dumb and dumps the authoritative stream; all interpretation happens in ordinary
benchmark code that can be tested and revised without touching a live run.

Ordered per-call telemetry captures sequence, turn, tool, arguments and hash,
result state, item count, response chars/tokens/hash, latency, returned paths
and canonical identities, position relative to first edit, and a post-hoc
purpose label. Derived from those: adoption state, first-call timing,
composition, result utilization, redundant lookups, navigation components, and
token accounting.

Three distinctions the schema refuses to collapse:

- **`TOOLS_AVAILABLE_NOT_USED` vs `TOOLS_UNAVAILABLE`.** Availability comes from
  the arm's configuration, never inferred from whether a call appears. An agent
  that declined the tools is a finding; a run where they never loaded is a
  treatment failure.
- **Agent error vs infrastructure error.** A model-issued invalid request is
  behaviour and stays in the data; an MCP transport failure is rerunnable.
- **Payload exposure vs provider cache billing.** A result carried through the
  conversation is re-read every turn even when it bills as a cache hit — which
  is precisely the mechanism that cancelled M161's efficiency gains.

**First-call timing precedence is frozen before execution** so an ambiguous
transcript cannot later be resolved in whichever direction flatters the result.

The redundant-lookup detector is deliberately conservative and has both
polarities controlled: it fires when the agent greps for the exact symbol or
path it was just handed, and does **not** fire on reading the returned
implementation, on a broader search that merely mentions the term, or on a
search after an empty result. Reading an implementation after orientation is
expected and useful; counting it would manufacture evidence that VTRACE fails to
substitute for investigation.

27 telemetry controls pass, with known positives *and* negatives for every
detector.

## A detector gap the known-positive control caught

The historical-policy scanner initially passed the suite policy and every tool
description — and also failed to reject `PIVOT_CHECK`, whose wording is *"do not
rediscover with grep what VTRACE already named"*. It contains no "do not use
grep", so every pattern missed it. Without the known-positive probe the clean
result would have looked like proof. The scanner now matches the concept, and
the five blocks are locked into the test suite.

## Pilot corpus

Recovered mechanically from M161's extension manifest, which was frozen **before
any paired30 outcome was observed**:

```
manifest cases            100
consumed by M161 paired30  30   (verified strict prefix)
M161 graded ids            30
untouched pool             70   (0 overlap with graded)
selected                   12   across 8 repositories, max share 16.7%
```

Selection is round-robin across repositories in first-appearance order, taking
each repository's lowest frozen `order`. It reads `order`, `repo`, and
`difficulty` only — no retrieval, capsule, Top-1, candidate-count, or
gold-reachability field is consulted.

```
manifestHash  8c8b2ad8e1fe8a972c34dd36bdc1170f6daa3d1e4c367d4f6d36f7a4bdc159bf
scheduleHash  ad1ed3f5fbd6ea9171739bd0157e46eb80663e25e6e852a7f10e21381a3956a5
toolSetSha256 b5c871e92e9ed51fd1a38cd4430c6e973df2a872d2995b8c6eebb2983a240db3
```

Arm order rotates with task position; each arm leads exactly four of the twelve.

## Cost

| Item | Estimate |
| --- | --- |
| Real-spawn known-positive control | ~$0.70 |
| 12 tasks × 3 arms = 36 live arms | **$24.64** (range $17.25–$36.96) |
| Total API | **~$25.33** |
| Local index build | ~17 min (24 arms need one; BASELINE needs none) |
| Wall clock | ~1.9 h, sequential |

Basis: M161 actuals — 60 live arms, $41.07, ~3h07m, same agent, model, and turn
caps. The range is wide on the high side because CALLABLE's cost is the open
question: tool results add context the agent would otherwise have gathered
itself, and whether that nets out cheaper is exactly what the pilot measures.

## Preservation and verification

```
bun test                     5045 pass / 49 skip / 0 fail  (326 files)
bun run typecheck            clean
bun run typecheck:benchmarks clean
git diff --check             clean
```

Retrieval preservation: the evaluator was rerun and compared against the
**pre-M162 predecessor tree**. All 50 case rows and all four comparison
artifacts are identical after timing normalization — A, B, and C together change
no retrieval behaviour.

```
behavioral routing            OFF
module deliveries             0
duplicate support regression  none
index writes during tool use  0
.vtrace staged                0
tracked ignore changes        0
global git config mutations   0
pre-existing worktrees        14, unchanged
stage5_outcome_ledger.*       preserved unstaged
```

Temporary fixtures are created under `$TMPDIR` and removed; no benchmark
workspace, raw index, or transcript is staged.

## What remains unproven

One thing, deliberately isolated:

- **A live Claude runtime discovering and calling the tools.** The
  `mcp__vtrace__*` names are Claude Code's documented namespace transformation
  applied to the frozen server name, and the suite policy is served on
  `initialize` — but whether the runtime surfaces server instructions to the
  model, and whether the model-visible names are exactly as expected, cannot be
  established without spawning an agent. Telemetry must not key on those names
  until confirmed.

This is the entire content of the gated known-positive control, whose plan and
assertions are frozen in `stage5_m162_real_spawn_control_plan.json`. It is
infrastructure qualification only: its outcome never enters capability counts,
token comparisons, unique win/loss analysis, or the pilot.
