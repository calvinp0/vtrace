# M162-A — callable tool selection and freeze

**Question this workstream answers:** which VTRACE repository-intelligence
primitives should a coding agent be able to call, and what does offering them
actually cost?

Everything below was read out of the live product registry in-process
(`defaultMcpToolRegistry`) and probed over real JSON-RPC against
`vtrace mcp-serve`. Nothing is inferred from filenames.

## Frozen callable set

```text
M162 CALLABLE TOOL SET:
  get_code_context
  get_impact_graph
```

| Tool | Why it is in the set |
| --- | --- |
| `get_code_context` | The authoritative task→ranked-evidence primitive. Wired, product-routed, bounded, and verified `VALID_NONEMPTY` on a known positive. No ordinary agent tool ranks repository evidence against a task description, so this is capability the baseline arm genuinely does not have. |
| `get_impact_graph` | Resolved structural callers/dependants for one exact indexed symbol, bounded by `max_edges`/`max_tokens`. Grep can find a name; it cannot tell you which of those occurrences is a resolved call, import, or inheritance edge. This is the on-demand question a turn-0 capsule cannot anticipate, which makes it the load-bearing tool for the M162 hypothesis. |

## Excluded, with reasons

| Tool | Disposition | Reason |
| --- | --- | --- |
| `run_pipeline` | redundant | The product's own description says `get_code_context` *is* its agent-friendly alias. Identical input schema, identical contract. Exposing both costs ~850 schema tokens and asks the agent to choose between two identical doors. |
| `get_context_capsule` | redundant | A third entry point onto the same routing+capsule pipeline with a narrower input surface. Adds no capability. |
| `search_logic_flow` | deferred capability | Genuinely distinct and verified working, but needs **two** exact indexed FQNs, so it is only invocable once the agent already knows both endpoints. Recorded as a candidate rather than spent on ~536 schema tokens now. |
| `get_skeleton` | deferred capability | Substitutable by the agent's ordinary `Read`. Belongs to the compact/skeleton context direction, which must not be combined with the dynamic-timing change M162 is isolating. |
| `index_repo`, `index_status`, `workspace_setup` | infrastructure | Index maintenance and setup, not repository intelligence. The harness guarantees a ready index per task, so exposing refresh would only let the agent spend turns on upkeep and would confound the navigation-work metrics. |
| `get_session_context`, `search_memory` | session state | Observation memory rather than repository evidence, and cross-task exposure puts session isolation at risk for no capability gain. |
| `save_observation` | session state | A **write** surface. The evidence index stays read-only during tool use, and a benchmark arm must not accumulate state across tasks. |
| `expand_vexp_ref` | redundant | Expands deferred V-REF hashes emitted by `run_pipeline`, which is not in the set. Without its producer it is unreachable. |
| `check_capsule_staleness` | internal authority | Evaluator/provenance surface, not an agent capability. |
| `search_symbols` | hidden | Stays hidden. The exact-lookup gap it might have addressed turned out to be an identifier-contract defect, not a missing tool — see below. No `TOOL_SURFACE_GAP` is filed. |

## Finding 1 — CALLABLE does not start at zero VTRACE tokens

| Surface | Tokens (chars/4) |
| --- | --- |
| All 14 visible tools | **5,521** |
| Frozen 2-tool set | **1,937** |
| Authoritative routing policy | **128** |
| **CALLABLE turn-0 total** | **2,065** |

Tool schemas sit in the prompt prefix and are re-read every turn — the same
mechanism that cancelled M161's efficiency gains, where a shorter run over a
larger prefix came out a wash. Exposing the full surface would have recreated
the static-context tax while claiming to test its removal. This number, not
zero, is what the STATIC capsule must be compared against.

## Finding 2 — the two tools did not compose

`get_impact_graph` resolves the canonical indexed grammar
`path/file.py::Class.method`. Before this milestone, nothing `get_code_context`
put in front of an agent was a valid argument for it:

| What the agent saw | Value | Resolved? |
| --- | --- | --- |
| Item header (the most copyable string) | `pkg/core.py::apply_discount` | ✗ `invalid_request` |
| `leadPivot` | `pkg/core.py::pkg/core.py::PriceEngine.apply_discount` | ✗ malformed, doubly path-prefixed |
| `items[].fqName` | absent (canonical value present, but only nested under `metadata`) | ✗ not at the documented position |
| Incidental `why:` prose | `pkg/core.py::PriceEngine.apply_discount` | ✓ the only valid source |

The defect bites **methods specifically**: for module-level functions and
classes the local name equals the qualified name, so those masked it. Methods
are what SWE-bench tasks edit.

This mattered beyond ergonomics. Had CALLABLE returned NEUTRAL, the result would
have been uninterpretable — "interaction architecture does not help" could not
have been separated from "the agent could not ask the second question."

**Repair (authorized correctness fix, retrieval untouched):** one canonical
identity path from the indexed symbol through `items[].fqName`, `leadPivot`, and
the rendered header, all sourced from the existing `fqName` authority rather
than synthesized at serialization time. `get_impact_graph`'s description now
states the accepted grammar, and `get_code_context`'s states that a non-null
`items[].fqName` is directly usable as its argument.

Proof: `stage5_m162_retrieval_no_change_proof.json` — all 50 evaluator case rows
and every comparison artifact identical after stripping wall-clock timing; only
retrieval latency differs. Composition controls live in
`src/productContext/canonicalIdentityComposition.test.ts` and cover
module-level function, class, and method, plus negatives for local-name-only
and the doubly-prefixed string.

## Finding 3 — routing moved out of an adjective and into one policy

`get_code_context` shipped as *"Vtrace **default first-pass** repo-context
tool"*. Routing semantics hidden in a single tool's adjectives are neither
reviewable nor removable.

Routing now lives in one authoritative agent-facing policy served on
`initialize` (`VTRACE_TOOL_SUITE_POLICY`), stating when each capability applies
and closing with the clause that ordinary repository tools remain available and
should be used whenever useful. Individual descriptions are capability-only,
enforced by a control that rejects usage-priority and coercive language.

The distinction the policy holds: it may say **when a capability applies**, and
may not **constrain the agent's own investigation**. The five historical Stage 5
policy blocks — patch-first, search budgets, do-not-grep — remain excluded, and
the scanner has a known-positive test proving it fires on them.

## Consequence for the pilot

The M155-era workspace index probed during this audit failed closed with
`schema_incompatible` / `full_rebuild`. Indexes do not survive product
evolution, so every pilot task must build a fresh index at the frozen product
SHA. Reusing stored indexes would produce `repo_not_ready` rather than evidence.
