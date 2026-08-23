# M176 — Response Envelope Totality and Truthful Degradation

Start state: `stage5_m176_start_state.json` (HEAD `eec70c3c`, branch `main`, 105 ahead
of `origin/main`, two pre-existing dirty ledger files, 194 untracked entries, 16
worktrees of which exactly one — `/home/calvin/bench/vtrace-m175/pre-repair` — is
milestone-owned).

## The question

> Can every valid `run_pipeline` request terminate in a truthful bounded product
> response, even when no truthful repository orientation fits inside the
> configured model-facing envelope?

## What M176 is not

Not retrieval, ranking, pivot or support work. Not another compression milestone.
Not a larger-envelope experiment. Not a live utility benchmark. The ceiling itself
stays exactly where it is: making the response fit by raising the bound would
evade the defect rather than repair it.

## Workstreams

| ws | question | artifacts |
| --- | --- | --- |
| A | Where does `product_response_envelope_unreachable` come from, what feeds it, and which paths are proven bounded? | `stage5_m176_envelope_failure_trace.json`, `stage5_m176_envelope_contributors.json`, `stage5_m176_response_path_totality.json`, `stage5_m176_state_machine_before.json` |
| B | Can the crash be reproduced, bounded and controlled? | `stage5_m176_known_positive.json`, `stage5_m176_boundary_controls.json`, `stage5_m176_known_negative.json`, `stage5_m176_readiness_controls.json`, `stage5_m176_unexpected_error_control.json` |
| C | What is the smallest truthful terminal response, and where does it sit in the precedence order? | `stage5_m176_decline_contract.md`, `stage5_m176_decline_state_matrix.json`, `stage5_m176_truthfulness_controls.json` |
| D | The smallest product change that removes the unhandled state. | `stage5_m176_implementation_decision.md`, `stage5_m176_pathology_after.json`, `stage5_m176_normal_identity.json`, `stage5_m176_debug_behavior.json`, `stage5_m176_protocol_preservation.json` |
| E | Does totality hold across Broad100-A and Broad100-B? | `stage5_m176_broad100a.json`, `stage5_m176_broad100b.json`, `stage5_m176_totality_results.json`, `stage5_m176_envelope_monotonicity.json` |
| F | Verdicts and closure. | `stage5_m176_regression_checks.json`, `stage5_m176_architecture_decision.md`, `stage5_m176_final_report.md` |

## The instrument, and the two traps it is built around

Every measurement here derives from one observable: the **envelope floor** — the
smallest `requestedContextTokens` at which a given authoritative response still
terminates. Below its floor the tool throws; at or above it, it answers.

**Trap 1 (inherited from M175-B).** Compaction runs before any response is
observable, and raising the ceiling to look inside changes what gets selected —
24 items at 120k, 10 at 8k. So the residue is never read at a *different* budget
from the one under test. It is read at the specimen's own floor, where the whole
ladder has already run and the object is observable without having been given a
different budget in order to be observed.

**Trap 2 (found in M176-A, recorded so it is not walked into again).**
`compactProductResponse` is not idempotent across delivery states.
`applyProgressiveContextBudget` derives retrieval success from
`resolved || items.length > 0` and never consults a `retrievalFound` a previous
pass wrote, so replaying compaction over an already-compacted `delivery_failure`
response reclassifies it as `no_result` — a fabricated absence. The live product
compacts once, so this is not a shipped defect, but it makes M175's 8,000-token
`.debug` captures unusable as specimens here. Every M176 specimen is a
single-pass authoritative capture at 120k.

## Live spend

None. No agents, no Docker, no paid API. Local index reads only.
