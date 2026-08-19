# M162 — Callable Repository Intelligence Architecture

## Question

M161 established that a clean, static, turn-0 VTRACE capsule changes agent
behaviour substantially — median tool calls 15→10, searches 4.5→3, turns 38→26 —
without moving pass@1 (19/30 both arms, exact paired p = 1.0) and without
reliably reducing end-to-end cost.

M162 asks whether that limitation belongs to **VTRACE's repository intelligence**
or to the **static-injection architecture** that delivered it:

> Does VTRACE create more value when the agent can request targeted repository
> intelligence on demand, after its understanding of the task has evolved?

This is a system-architecture milestone. It does not tune retrieval scores, raise
candidate caps, revive the M160 subject→owner theory, or optimise Top-1 — M161
showed Top-1 buys efficiency, not solutions.

## Arms

| Arm | Static capsule | Callable tools | Historical policy blocks |
| --- | --- | --- | --- |
| **A — BASELINE** | none | none | none |
| **B — STATIC** | clean M161 capsule | none | none |
| **C — CALLABLE** | **none** | frozen VTRACE tool set + routing policy | none |

All three share model, agent version, prompts, budget, turn cap, timeout,
ordinary repository tools, grader, and environment. CALLABLE deliberately
receives zero turn-0 VTRACE *evidence*; its VTRACE context is tool schemas plus
the routing policy, which is measured rather than assumed to be free.

## Protocol refinement recorded before live execution

M162 originally treated natural MCP adoption as a primary claim. That
over-optimised for measuring discoverability rather than for testing the
strongest plausible callable architecture. Competitive scaffolds (including
VEXP's) route specialized tools by workflow stage, so workflow guidance is a
legitimate part of the architecture under test.

```text
naturalAdoptionMeasurement:  no longer a primary claim
callableArchitecture:        VTRACE tools + explicit lightweight routing policy
```

The five historical Stage 5 policy blocks — patch-first, at-most-two-searches,
do-not-rediscover-with-grep — remain **excluded** in all arms. Routing guidance
says when a capability applies; it never constrains the agent's own
investigation. This refinement is recorded here **before** any live run, and is
not a mid-sweep change.

## Workstreams

| | Scope | State |
| --- | --- | --- |
| **A** | Callable-surface audit, minimal set selection, schema/policy freeze | **PASS** |
| **B** | End-to-end MCP wiring, discovery, invocation, routing, isolation | pending |
| **C** | Ordered tool telemetry, utilization reconstruction, offline probes | pending |
| **D** | 12-task three-arm live pilot (paid; requires explicit authorization) | gated |
| **E** | Architecture verdict and roadmap decision | pending |

## A — outcome

Frozen set: `get_code_context`, `get_impact_graph`.
Full detail and per-tool reasons: `stage5_m162_tool_selection.md`.

Three findings shaped the rest of the milestone:

1. **The full 14-tool surface costs ~5,521 schema tokens**, carried per turn like
   M161's capsule. The frozen set costs 1,937, plus 128 for the routing policy —
   **2,065 tokens is CALLABLE's true turn-0 VTRACE cost**, and the number STATIC
   must be compared against.
2. **The two tools did not compose.** `get_impact_graph` needs the canonical
   indexed grammar, and nothing `get_code_context` showed the agent was a valid
   argument — the failure was specific to methods. Repaired under the
   wiring-defect exception, with retrieval proved unchanged.
3. **Routing moved out of a tool adjective into one authoritative policy**, so
   it is reviewable, hashable, and removable.

## Standing constraints

- One authoritative API. No `*_v2` parallel interfaces; the unversioned surface
  evolves in place.
- No hidden behavioural policy in tool descriptions; enforced by a control with
  a known-positive test against the historical VEXP scaffold.
- Retrieval semantics frozen: scores, ranking, candidate generation, caps,
  pivot eligibility, behavioural routing, and index semantics are out of scope
  unless a tool cannot function without a correctness fix — which must be
  reported before scope broadens, as the identity repair was.
- Structural `<module>` symbols stay graph-visible and delivery-invisible;
  target `0` deliveries, asserted by test.
- Indexes must be rebuilt per task at the frozen product SHA: stored indexes
  fail closed as `schema_incompatible` once the product moves.
- No paid live runs without explicit authorization at the D gate.

## What would change the verdict

The strongest possible result is a CALLABLE-only solve that both BASELINE and
STATIC miss, with transcripts showing a targeted VTRACE call contributed
materially. The most likely informative result is a difference in end-to-end
context economics at equal solve rate. Both must be read against 2,065 turn-0
tokens, not against zero, and n=12 supports no significance claim.
