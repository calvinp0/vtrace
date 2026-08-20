# M164-C rerun policy — frozen before the sweep

An experiment that reruns the results it dislikes measures the experimenter. This
policy is fixed before the first spawn and is not revisited during execution.

## Retries fire only for infrastructure

A retry is permitted when the run failed for a reason that carries no information
about the treatment:

- network / API / provider failure (rate limit, overload, quota, 429, 529, 5xx,
  authentication, connection reset, socket hang up, timeout at the transport)
- agent process crash unrelated to its own behaviour
- workspace corruption
- grader infrastructure failure
- the MCP server failing to initialize for infrastructure reasons

These are matched mechanically by `ABORT_RE` in the driver. Retries are capped at
four attempts and every attempt is recorded in `_m164_driver_ledger.jsonl`.

## Never rerun

Each of the following is a RESULT. It is recorded and analysed, never repeated:

- a bad patch, or no patch
- `repo_not_ready` arising from product behaviour
- weak, wrong or misleading VTRACE evidence
- a trigger the agent ignored (`TRIGGER_NOT_COMPLIED` is an outcome the arm
  exists to be able to produce)
- a malformed tool query the agent itself constructed
- a timeout caused by the agent's own strategy
- an unwelcome grader outcome

The third and fourth items deserve emphasis. M164 exists because M163 could not
observe what a returned VTRACE answer does to an agent. A poor answer is now part
of the measurement, not a fault to be papered over — arguably the more valuable
half of it.

## No selective reruns

Reruns are never applied to one arm of a pair, and never chosen after seeing an
outcome. Where a permitted infrastructure rerun occurs, the original run record is
preserved alongside the retry and both appear in the ledger.

## Stop conditions

- If the repaired readiness seam systematically fails again across live runs —
  multiple TRIGGER arms returning `repo_not_ready` from the same seam — stop and
  report rather than interpreting utility.
- If projected spend would breach the $22 live-agent cap, stop and report. The cap
  is enforced before each spawn against actual recorded `costUsd`; it is never
  raised to finish the sweep.

A single case with a distinct, legitimate state issue is recorded and its pair
assessed for validity. Denominators are never quietly shrunk.
