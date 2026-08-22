# M165 — Single-Call Investigation Composition and Agent-Facing Pipeline Qualification

**A PASS · B PASS (no new contract) · C PASS (no product change) · D PASS · E NOT FROZEN — the
experiment it would freeze is void as specified.**

```text
A verdict:          COMPOSITION_ALREADY_EXISTS
decision gate:      PIPELINE_ALREADY_RICH_AND_EXPOSED
product changed:    NO
retrieval changed:  NO
new tool created:   NO
live spend:         $0.00   — not requested, and should not be
```

M165 was commissioned to find out whether VTRACE could compose a VEXP-shaped
single-call investigation out of capabilities it already had. It already does,
it already exposes it, and **M164 already measured it**. The milestone's central
question was answered before the milestone began — by the milestone before it.

---

## 1. The tool surface, reconstructed rather than assumed

`stage5_m165_tool_inventory.json`, built from `defaultMcpToolRegistry` at HEAD.

```text
implemented tools:            21
MCP-registered:               21
default-suite visible:        14
registered but hidden:         7
placeholder / dead / stub:     0
M164 live surface:             2   (get_code_context, get_impact_graph)
```

The reported "approximately 14 tools" is **correct for the default-visible
surface and incomplete as a total**. Seven more are registered and resolvable by
exact id but absent from `tools/list`: `search_symbols`, `build_capsule`,
`build_handoff`, `route_query`, `list_runs`, `list_sessions`, `read_session`.

Every one of the 21 is `wired` / `engine_delegate`. There are no placeholders,
no benchmark-only wrappers, and no dead registrations. `--tools` explains the gap
between 14 and M164's 2: it restricts the model-visible surface at the source,
leaving unlisted tools registered but hidden.

---

## 2. `run_pipeline` is not absent, not thin, and not a second implementation

Against §3's seven possibilities the answer is **A — already a true composed
investigation**, with one correction the brief did not anticipate.

`get_code_context` **is** `run_pipeline`. `GET_CODE_CONTEXT_TOOL_DEFINITION`
spreads `RUN_PIPELINE_TOOL_DEFINITION.metadata`, and
`handleGetCodeContextRequest` (`src/mcp/tools.ts:9266`) parses its input, runs an
index-freshness gate, then calls `RUN_PIPELINE_TOOL_DEFINITION.handler` verbatim
(`src/mcp/tools.ts:9373`) and overwrites only `freshness`, `timing`, and
`indexMode`.

§12's thin-wrapper test therefore resolves, but **inverted**: it is not that
`run_pipeline` is a thin alias around `get_code_context`. It is that
`get_code_context` is a thin wrapper around `run_pipeline` — adding a freshness
gate and an `auto_refresh` policy, and nothing else.

There is one authoritative pipeline path, one result model, and no competing
implementation. §4's permanent API policy is already satisfied; nothing needed
consolidating.

---

## 3. What the single call already composes

`runPipelineOrchestrator` composes internal producers directly — never through
the MCP transport, which is what §38 asks for and what the code already did:

| Capability | Producer | Composed via |
| --- | --- | --- |
| primary context / pivots | `capsuleV2/authoritativeProductRetrieval` | orchestrator context section |
| structural skeletons | `skeleton/getSkeleton` | `productContext` `renderStructuralSkeleton` |
| impact / blast radius | `impact/getImpactGraph` | **two lanes** — see below |
| logic flow | `logicFlow/searchLogicFlow` | orchestrator flow section, endpoint-conditional |
| session memory | `observations/getSessionContext` | orchestrator session section |
| durable memory | `observations/searchMemory` | orchestrator durable section |
| project rules | `projectRules/projectRules` | orchestrator rules section |
| query routing | `intent/routeQuery` | orchestrator context section |
| symbol search | `retrieval/searchSymbolsShared` | orchestrator context section |
| deferred expansion | `runPipeline/expandDeferredVexpRef` | pipeline emits the V-REFs |
| token / latency accounting | `metrics/contextAccounting` | `accounting` + `responseBudget` |

Eleven of the twenty-one tools have their producer composed into the first call.
The other ten are lifecycle, write-path, diagnostic, or legacy surfaces
(`index_repo`, `index_status`, `workspace_setup`, `save_observation`,
`check_capsule_staleness`, `build_capsule`, `build_handoff`, `list_runs`,
`list_sessions`, `read_session`) and correctly do not belong in a bounded read.

**Impact runs on two independent lanes, and only one of them is intent-gated.**
The top-level `impact` section requires impact or refactor intent
(`resolveImpactTriggerReason`) and is skipped `not_requested_by_intent` on all
twelve tasks. Meanwhile `productContext`'s `addImpactEvidence` lane runs ungated,
bounded to 2 pivots × 6 edges, ≤10 items, and delivers direct callers, importers
and subtypes with relation kind, evidence strength, traversal depth, test links
and entrypoint links. Reading only the section would have reported "impact:
never delivered" and been wrong on ten of twelve tasks.

---

## 4. Deterministic 12-task qualification (M165-D)

Same twelve M164 tasks, their own preserved workspaces, prepared through the
runner's own index step, spoken to through a real `mcp-serve` process. Structured
truth taken from the JSON-RPC payload, never from agent-visible text (§39/§110).

```text
                                get_code_context vs run_pipeline
same lead pivot                            12/12
same item paths                            12/12
same model-visible context (hash)          12/12
same component statuses                    10/12
index writes                                   0
within response envelope                   12/12
```

The two differing cases (`sphinx-7440`, `sympy-14976`) are explained, not waved
past: `run_pipeline` returns one bounded pivot-neighborhood excerpt that
`get_code_context` drops. `get_code_context`'s extra freshness diagnostics push
its response past a compaction threshold and the excerpt is compacted away. The
difference is order-independent and reproducible across call orders
(`get_code_context` first, `run_pipeline` first, and doubled) — it is a real
property of the two tools, not nondeterminism. The rendered model-visible context
is byte-identical on all twelve regardless.

### What the existing single call already delivered

By the product's own `roleCounts`, not by a classifier over rendered text:

```text
primary context (pivot)      12/12
structural skeleton support  12/12
impact (callers/dependents)  10/12   median 1.5 items, max 6
documentation                 3/12
configuration                 1/12
memory                        0/12   truthfully — isolated checkouts, no prior session
project rules                 0/12
logic flow                    0/12   endpoints never resolvable from a bug report
```

§102's meaningful-composition gate is **met by the tool that already shipped**,
on the population M164 already ran.

### Token economics

```text
median get_code_context response      8,678 tokens
median run_pipeline response          8,480 tokens
median increment (pipeline - context)  -613 tokens
p90 increment                          +362 tokens

median model-visible tokens              996
median metadata tokens                 7,407
metadata share                          85.4%
```

`run_pipeline` is **cheaper** than `get_code_context`, not richer. And both spend
roughly six of every seven tokens on metadata rather than on evidence the model
reads as context — a finding about the response envelope that is independent of
M165's question and worth its own milestone.

Schema tax, for the record: M164's two tools cost ~1,937 tokens; adding
`run_pipeline` would cost ~2,788 (+851, +44%); the full 14-tool surface ~5,521.

---

## 5. Why the proposed live experiment is void

M165-E specifies three arms — NEUTRAL, CONTEXT_TRIGGER, PIPELINE_TRIGGER — over
twelve tasks, 36 arms, to isolate whether composed investigation beats
localization alone.

**Arms B and C are the same treatment.** They call the same handler, resolve the
same lead pivot, return the same item paths, and render byte-identical
model-visible context on 12/12 tasks. The only measured difference is one bounded
neighborhood excerpt on 2/12, in `run_pipeline`'s favour, alongside a ~613-token
saving. Running the sweep would spend roughly $20 to compare a treatment with
itself, and would return "no difference" for reasons that have nothing to do with
the hypothesis.

§101 is explicit about this case, and it applies: do not spend money pretending
it is a VEXP-shaped comparison.

**M164 was already the pipeline experiment.** Its twelve forced
`get_code_context` calls each delivered primary context, structural skeletons,
and — on ten of twelve — bounded impact evidence. Its verdict stands unchanged
and now reads more strongly than it did:

> Twelve agents were handed a bounded composed investigation — the right file
> first on 8/12, with callers and structural API alongside it. Same eight tasks
> solved as the neutral arm. Zero unique wins. Zero voluntary second calls.

The VEXP-shaped composition was not the missing ingredient, because it was never
missing.

---

## 6. §124 — capability existed / pipeline composed it / agent could see it

| Capability | Existed before M165 | Composed into first call | Agent could see it in M164 |
| --- | --- | --- | --- |
| pivot context | yes | yes | yes — 12/12 |
| structural skeleton support | yes | yes | yes — 12/12 |
| impact | yes | yes (ungated lane) | yes — 10/12 |
| token accounting | yes | yes | yes |
| latency | yes | yes | yes |
| memory | yes | yes | truthfully empty — 0/12 |
| project rules | yes | yes | truthfully empty — 0/12 |
| logic flow | yes | yes, endpoint-conditional | never activated — 0/12 |
| multi-repo | yes | yes, workspace-conditional | not applicable — single-repo tasks |

All three columns are "yes" for everything that this population can exercise.
There is no row where a capability existed, was not composed, and would have
mattered.

---

## 7. Verdicts

```text
M165-A   COMPOSITION_ALREADY_EXISTS
M165-B   PASS — the authoritative contract already exists (RunPipelineOrchestration
         + productContext). Creating a second one would have violated §41/§42.
M165-C   PASS — NO PRODUCT CHANGE REQUIRED
M165-D   PASS — parity, determinism, bounds, 0 index writes, added-value measured
M165-E   NOT FROZEN — the three-arm protocol compares a treatment with itself
decision PIPELINE_ALREADY_RICH_AND_EXPOSED
spend    NOT REQUESTED
```

Per §114 this is not VEXP parity and is not claimed as such. It is an audit
finding about VTRACE's own composition.

---

## 8. What this leaves open

The one thing M165 did *not* find is a composition gap, so the recommendation
does not change from M164's: **the untested variable is the task population.**
SWE-bench Verified issues name their own failure sites well enough that a
compressed investigation has little room to pay for itself — and M165 now shows
the investigation was genuinely compressed and genuinely delivered, so that
explanation can no longer be blamed on a thin product surface.

Two smaller findings are worth their own work and neither needs live spend:

1. **85% of the response is metadata.** A first call that spends 7,400 tokens of
   envelope to deliver 1,000 tokens of evidence is a plausible reason a capable
   agent stops reaching for it. This is measurable offline.
2. **The intent-gated impact section is dead on this population** (12/12 skipped)
   while the ungated lane does the real work. The section is redundant with the
   lane, or the gate is wrong. Either way it is currently costing schema and
   response surface for nothing.

Neither is licensed as a retrieval change, and §48's preservation rules were not
touched: no retrieval, ranking, candidate generation, or index schema was
modified in this milestone.
