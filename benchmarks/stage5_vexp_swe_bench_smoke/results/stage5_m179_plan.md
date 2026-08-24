# M179 — plan of record

**Question.** For one fixed authoritative object and fixed ranking/order state,
why can giving VTRACE more delivery budget make previously deliverable evidence
disappear, and can the packer be made budget-monotone without changing retrieval,
ranking, semantics, or the compact-orientation philosophy?

**Method.** Freeze the authoritative object once, then vary only the delivery
budget. M178 recorded the trap: varying a request's `max_tokens` moves the engine's
spend as well as the envelope's, so a ladder built by re-running the product at
each budget measures upstream state and calls it packing.

| Workstream | Deliverable | Outcome |
| --- | --- | --- |
| A | packer architecture, state machine, budget decisions, hidden bounds | PASS |
| B | frozen-authority corpus + detector/identity/fixture controls | PASS |
| C | first divergence, dominance, counterfactual, invariant | PASS |
| D | candidate simulation before any code change | PASS |
| E | minimal product repair | PASS |
| F | broad qualification on two corpora, verification, closure | PASS |

**Frozen dimensions.** repository, source revision, index revision, task,
authoritative retrieval result, pivot, candidate supply, candidate ordering,
relationship ordering, support ordering, truthfulness state, component state,
rendering implementation. Only the delivery budget varies.

**Corpora.** Broad100-A (88 frozen objects) for development; Broad100-B (81) for
confirmation. Captured at `detail=debug`, `max_tokens` 120,000 and
`include_item_content` — the third is not optional, see `stage5_m179_root_cause.md` §6.

**Out of scope, and untouched.** Retrieval, FTS, query routing, pivot selection,
support scoring, graph computation, impact-graph semantics, fit-contract
redefinition, response ceiling increases, agent instructions, live agents, VEXP,
SWE-bench outcomes.

**Live spend.** $0.00. No agent, no Docker, no paid API.
