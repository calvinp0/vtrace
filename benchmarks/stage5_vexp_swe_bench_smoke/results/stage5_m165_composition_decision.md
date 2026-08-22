# M165-A — Composition decision

**Verdict: `COMPOSITION_ALREADY_EXISTS`.**

## The seven possibilities (§3)

| Possibility | Holds? | Evidence |
| --- | --- | --- |
| A. already a true composed investigation | **YES** | `runPipelineOrchestrator` composes context, impact, flow, memory, rules, pivot-neighborhood, inspect-first, deferred refs and accounting from internal producers |
| B. internal but not MCP-exposed | no | registered and default-visible |
| C. exposed but excluded from the live suite | partly | `--tools` restricted M164 to 2 of 14; `run_pipeline` was not among them — but `get_code_context` was, and it *is* the pipeline |
| D. thin alias around `get_code_context` | **inverted** | `get_code_context` is the thin wrapper around `run_pipeline`, not the reverse |
| E. benchmark-only wrapper | no | CLI, MCP and benchmark all reach the same orchestrator |
| F. legacy / dead | no | all 21 registered tools are `wired`/`engine_delegate`; zero placeholders |
| G. absent | no | `src/runPipeline/`, 1,803-line orchestrator |

## Authority

One authoritative path. `get_code_context` (`src/mcp/tools.ts:9266`) parses input,
runs an index-freshness gate, delegates to `RUN_PIPELINE_TOOL_DEFINITION.handler`
(`:9373`), and overwrites only `freshness`, `timing` and `indexMode`. Its metadata
is a spread of `run_pipeline`'s. CLI `vtrace run-pipeline` calls the same
`runPipelineOrchestrator` with a different renderer.

No competing implementation exists, so §4's one-unversioned-`run_pipeline` policy
needed no enforcement action.

## Stage trace (§11)

```text
input                    YES
query parsing            YES   intent/routeQuery + normalizedIntent
retrieval                YES   capsuleV2/authoritativeProductRetrieval
pivot selection          YES
support selection        YES
impact                   YES   two lanes; section CONDITIONAL (intent-gated), productContext lane ungated
flow                     CONDITIONAL   requires resolvable endpoints
skeletons                YES   productContext renderStructuralSkeleton
memory/session context   CONDITIONAL   session needs sessionId; durable is intent-weighted
output rendering         YES   modelVisibleContext + formatRunPipelineOutput (CLI)
token accounting         YES   accounting + responseBudget
```

Nothing is `DEAD`. Nothing is `WRAPPER` except `get_code_context` itself.

## Consequence

§43's Case A applies: **product change NONE.** The follow-on question — does the
composed investigation add utility beyond localization — was already asked and
answered by M164, which forced `get_code_context` and therefore forced the
pipeline. See `stage5_m165_final_report.md`.
