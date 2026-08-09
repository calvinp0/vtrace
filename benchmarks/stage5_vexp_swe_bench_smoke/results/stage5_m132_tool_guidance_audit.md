# M132 — Tool-surface and guidance audit

## The `search_symbols` finding

The agent reported `mcp__vtrace__search_symbols does not exist` and that
ToolSearch returned nothing. Both observations were **correct**, and the tool
**does** exist. It is registered in `hiddenTools`, and `createMcpToolRegistry`
builds `listMetadata()` — which backs `tools/list` — from the *visible* list
only. A hidden tool is dispatchable by id but invisible to every client. Nothing
an agent can observe distinguishes "hidden" from "absent".

Meanwhile `src/runtime/agentGuidance.ts` emitted, into every generated
`AGENTS.md`/`CLAUDE.md`:

```
- Use `search_symbols` for exact symbol lookup.
```

So the generated guidance instructed agents to call a tool their client could not
see. That is the whole of Problem D.

## Decision

**Keep `search_symbols` hidden. Fix the guidance.** Reasons:

1. `docs/product_truth_audit_rc.md` already recorded the product decision —
   "Keep hidden; avoid promoting in RC docs" — for the whole legacy block
   (`index_repo`-era tools). M132 makes the generator agree with a decision that
   was already made, rather than reversing it by accident.
2. Exact symbol lookup is not a product gap. `get_code_context` resolves a named
   symbol and returns its source with surrounding context, which is strictly more
   useful for the stated purpose ("or when the context result is weak") than a
   bare candidate list. `get_skeleton` covers the known-file case.
3. §34's bar for adding a surface — "do not add it merely for feature-count
   parity" — is not met: nothing an agent needs is unreachable.

## Current tool surface (post-M132)

**Visible in `tools/list` (14):**
`get_code_context`, `run_pipeline`, `index_repo`, `check_capsule_staleness`,
`get_context_capsule`, `get_impact_graph`, `search_logic_flow`, `get_skeleton`,
`index_status`, `workspace_setup`, `get_session_context`, `search_memory`,
`save_observation`, `expand_vexp_ref`.

**Registered but hidden (7):**
`search_symbols`, `build_capsule`, `build_handoff`, `route_query`, `list_runs`,
`list_sessions`, `read_session`.

## Discrepancy classification (§67)

| Reference | Classification | Action taken |
|---|---|---|
| `src/runtime/agentGuidance.ts` (generated guidance) | **tool referenced + not visible** | Fixed. `search_symbols` line replaced with `get_code_context` guidance; a worktree section added. |
| `README.md` | tool referenced + not visible | Stale line removed. |
| `docs/mcp_tool_cheat_sheet.md` | tool referenced + not visible | Stale line removed. |
| `docs/mcp_tools.md` | tool referenced + not visible | Replaced with `get_code_context` guidance plus an explicit note that `search_symbols` is hidden and uncallable. |
| `docs/VTRACE_PRODUCT_OVERVIEW.md` | listed among narrower *visible* tools | Removed from that list. |
| `docs/current_product_state.md` | **accurate** — lists it under "Hidden-but-callable" | Unchanged. |
| `docs/VTRACE_INTERNALS.md` | **accurate** — lists it under "legacy/narrow tools" | Unchanged. |
| `docs/product_truth_audit_rc.md` | **accurate** — records the keep-hidden decision | Unchanged. |
| `stage5_vtrace_vs_vexp_feature_parity_audit.md` | accurate — "Hidden-but-callable (9)" | Unchanged. |
| `presentation-outline.md`, `slides/slides.md` | **stale, out of scope** | Unchanged and reported. Both list a whole pre-`get_code_context` tool set (`index_repo`, `search_symbols`, `route_query`, `build_capsule`, `build_handoff`) under "Exposed tools". The inaccuracy is the visibility claim for the entire legacy block, not `search_symbols` specifically; rewriting presentation material is outside M132's scope. |
| `AGENTS.md` at the vtrace repo root | **untracked, pre-existing** | Not modified. It carries a generated `<!-- vtrace:start -->` block that still names `search_symbols`; it is untracked working-tree dirt that predates this milestone. Re-running `writeVtraceAgentGuidanceBlock` regenerates it correctly. |
| ARC's own `CLAUDE.md` | user-maintained, external | Not modified (§60, §61). Reported to the user instead. |
| `benchmarks/arc_stage4_autonomous_edit/results/.../settings.local.json` | historical run artifacts (`mcp__vexb__search_symbols`) | Unchanged. Captured benchmark state, not guidance. |

## Drift prevention

`src/runtime/toolGuidanceConsistency.test.ts` asserts that every backticked
registered-tool name in `VTRACE_AGENT_GUIDANCE_BLOCK` is present in
`defaultMcpToolRegistry.listMetadata()` — the *visible* surface, not the
registry. It additionally pins the M132 decision itself: `search_symbols` must
stay registered, must stay invisible, and must not appear in guidance. Reversing
the decision now requires editing that assertion, which makes the reversal
deliberate.

The test also reports exposed-but-unmentioned tools without requiring them:
guidance is a recommended workflow, not a catalogue.

## Guidance added for worktrees (§36)

```
- Vtrace queries are scoped to one Git worktree. Pass `repo_root` with the
  worktree you are working in; without it the server answers from the checkout
  it was launched in, reported as `routingSource: process_default`.
- Nested linked worktrees are excluded from their parent's index, so a parent
  query never returns duplicate copies of the same file.
- Use `auto_refresh: if_stale` to refresh the requested worktree. It only ever
  refreshes that worktree; it never repurposes another worktree's index.
```
