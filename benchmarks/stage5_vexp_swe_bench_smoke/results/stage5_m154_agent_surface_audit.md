# M154-A — agent-facing surface audit

Every surface a coding agent can read before deciding what to do next. Read from
the registered MCP metadata and the source that produces it, not from
documentation.

## Registered tools

`RESERVED_MCP_TOOL_DEFINITIONS` in `src/mcp/tools.ts`; `search_symbols` remains a
hidden legacy registration and is **not** exposed in `tools/list` (M132).

| Tool | Job | Confidence field | Coverage/completeness field | Source identity |
| --- | --- | --- | --- | --- |
| `get_code_context` | Bounded task-relevant retrieval | `inspectFirst.confidence` | `productContext.coverage` (**added by M154-D**) | `productContext.repository` |
| `run_pipeline` | Same implementation, stable name | same | same | same |
| `get_context_capsule` | Lower-level capsule projection | same | capsule budget/diagnostics | same |
| `get_impact_graph` | Known symbol → callers/dependents | none; `confidence: null` on edges, "no probabilistic confidence is claimed" | `coverage`, `callerCoverage`, `limits`, `richSummary` truncation counts | request-scoped `repo_root` |
| `get_skeleton` | Structure of a known file | none | per-file explanation when unavailable | request-scoped |
| `index_repo` | Refresh the index | none | `indexReadiness`, `outcomes`, `generatedStateExclusion` (**added by M154-B**) | `repoRoot` |
| `index_status` | Inspect readiness without mutating | none | `coverageComplete`, `omittedByBound` | per-member |
| `workspace_setup` | Workspace config | none | member census | per-member |

Memory/session tools (`save_observation`, `search_memory`, `get_session_context`,
`list_sessions`, `read_session`) and `expand_vexp_ref`, `route_query`,
`build_capsule`, `build_handoff`, `list_runs`, `check_capsule_staleness` were
inspected; none makes a coverage or absence claim about repository code.

## Confidence semantics, as found

One numeric-ish confidence reaches an agent for retrieval: `inspectFirst.confidence`
(`high | medium | low`), described as "How specific the lead signal is".

Reading `buildInspectFirst`, that is accurate — it is derived purely from whether
the winning candidate's role-reason carries an edit-site phrase and whether it
carries behaviour vocabulary. It is **not** a statement about task understanding,
evidence sufficiency, or search completeness.

The defect was not the field. It was that nothing else in the response spoke about
completeness, so the only visible quality signal was free to be read as all four.
M154 answers that with structural coverage state rather than a second number.

Other `confidence` fields found are unrelated to retrieval coverage: rule
confidence in project rules, planner `intentConfidence`, local-evidence
`confidence` on impact relations (with `evidenceKind` naming its source), and
impact edges' `confidence: null` — already explicit that no probabilistic claim
is made.

## Where "start here, do not grep" came from

Two producers, both vtrace's own, both **constants** rather than judgements.

**1. `src/runPipeline/inspectFirst.ts` — the response.** `buildInspectFirst`
assigned:

```
const avoidFirst =
  "Broad repository grep/find before inspecting the targets above — start from these symbols first.";
```

unconditionally, at every confidence level, on every response with any candidate.
`renderInspectFirstText` printed it under an `Avoid first:` heading. It reached
`run_pipeline`, `get_code_context` and `get_context_capsule` through
`formatRunPipelineOutput` and the `inspectFirst` schema, and reached the Stage 5
injected context through the same projection.

Measured on the frozen reuse-before-write corpus: **17 of 19** predecessor
responses carried it.

**2. `src/runtime/agentGuidance.ts` — the installed instructions.**
`VTRACE_AGENT_GUIDANCE_BLOCK`, written into the repository's `AGENTS.md` /
`CLAUDE.md`, contained:

```
- Use `get_code_context` before manual grep or opening many files.
```

Neither is model-authored prose. Both are vtrace product output, so both are
M154's to fix (§52). Nothing in `CLAUDE.md`, the MCP server metadata, or the
response serializer contributed additional anti-search language.

## Repository / worktree identity exposure

Already adequate; M154 added nothing. `productContext.repository` carries root,
repositoryId, worktreeId, headCommit, branch, detached, indexRunId, indexMode and
`routingSource` (`explicit_root | client_context | process_default`). Every
retrieval tool takes `repo_root`; MCP transmits no caller cwd (M132 §13), which is
why `repo_root` is the contract. `auto_refresh: if_stale` refreshes only the
requested worktree and never repurposes another's index.

## Coverage vocabulary already present

M154 reused rather than extended:

- `NegativeClaimStrength` — `not_observed | bounded_absence | authoritative_absence`
- `CAPABILITY_SETTLES_MEMBER_ABSENCE` — `RankedRetrieval: false`,
  `SymbolExactLookup: true`, `PathMembership: true`
- `EvidenceCoverage` — considered/answered/refused/omittedByBound/complete
- `coverageComplete` + `omittedByBound` on workspace member census

The gap was not vocabulary. It was that none of it was attached to a
`get_code_context` answer, so the tool that agents actually call was the one tool
that said nothing about what its result settled.

## Audit outcome

- All real agent-facing surfaces inspected from registered metadata — **done**
- Confidence semantics identified and bounded — **done**
- Coverage/absence semantics mapped, three axes separated — **done**
- Source/worktree identity mapped — **done, already sufficient**
- Anti-search guidance source identified — **done, two producers, both vtrace's**
- One authoritative search contract documented — `stage5_m154_search_contract.md`

**M154-A: PASS.**
