# M177 — plan

**Question.** Does `get_impact_graph` violate the valid-request response-totality
invariant M176 proved for `run_pipeline`, and can the same truthful
bounded-degradation architecture repair it without changing impact computation,
graph semantics, ranking, or normal-budget output?

**Inherited defect.** M176 recorded, measured and deliberately left unrepaired:
`impactResponseEnvelope.ts:340` throws `impact_response_envelope_unreachable` at
`max_tokens` 1/50/200/400 on `pytest-dev__pytest-10081 :: _enter_pdb`, with 1,200
succeeding (`stage5_m176_sibling_defect.json`).

**Invariant to establish.**

> Every valid request over a valid authoritative impact result must produce either
> a valid impact response or a truthful bounded decline. Response-envelope
> exhaustion must never make the handler unreachable.
>
> Evidence that exists but cannot be delivered within the bound must never be
> represented as absent.

## Workstreams

| | what | gate |
| --- | --- | --- |
| A | trace the failure path from source and measurement, not from analogy to `run_pipeline` | line 340's reachability explained; computation separated from delivery; smallest repair seam identified |
| B | reproduce the known positive through the real MCP transport; establish known-negative, empty-impact, invalid-request and readiness controls | reproduction matches M176; every control classified correctly |
| C | derive the decline contract | no fabricated absence possible; terminal construction proven; no new public state unless forced |
| D | minimal product repair | the throw replaced; computation, ranking and the normal path untouched |
| E | budget ladder, identity and truthfulness qualification | valid-request envelope failures 0; fabricated absence 0; normal-budget identity established; monotonicity observed not repaired |
| F | closure | four formal verdicts, outstanding defects listed separately, no scope expansion |

## Deliberately out of scope

`run_pipeline`; retrieval; impact computation, edge generation, ranking, symbol
resolution, path finding, centrality; response-budget monotonicity repair;
`related`-selection instability; live agents; VEXP; Docker.

## Method commitments

- **Both arms in one process.** M176 recorded 11 of 200 false identity differences
  caused by arms running minutes apart under different load. The impact envelope
  is a pure function of an `ImpactGraphOutput`, so the pre-repair implementation
  is imported from a detached worktree and called on the *same in-memory object*
  as the repaired one. Nothing separates the arms.
- **Read the residue at the floor, never above it.** M175 established that raising
  the ceiling to observe a response changes what it selects. The smallest
  `max_tokens` at which a response still terminates does not.
- **Adversarial budgets measure correctness; the default budget measures
  frequency.** The two are reported separately and never summed.

**Licence.** No live agents, no Docker, no VEXP, no paid API. Expected live spend
$0.00.
