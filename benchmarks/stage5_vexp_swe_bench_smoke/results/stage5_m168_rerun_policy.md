# M168-E rerun policy (frozen before execution)

A rerun is permitted **only** when the apparatus failed. A run that completed and
produced a disappointing result is a result.

## Permitted — infrastructure only

```text
provider rate limit / overload / quota / 429 / 529 / 503 / 502
authentication failure
network failure: ECONNRESET, fetch failed, socket hang up, ETIMEDOUT
agent process crash unrelated to its own strategy
workspace preparation or clone corruption
MCP server failing to initialise
Docker / grader infrastructure failure
```

Matched by the driver's `ABORT_RE`, up to 4 attempts, logged with
`status=infra_retry` in `_m168_driver_ledger.jsonl`.

## Never permitted

```text
a bad patch
an empty patch
the agent ignoring the mandate
the agent thrashing against a blocked search
a run hitting the turn limit or the cost limit
weak or unhelpful retrieved evidence
an unfavourable grade
an arm losing to another arm
```

These are outcomes of the treatment under test. Rerunning any of them would
select on the dependent variable.

## The guard-degradation case, stated in advance

The strict arm's hook is conditional on `.vtrace/index.sqlite` existing, which
reproduces VEXP's own conditional denial. If the index is missing, the guard
allows the search and the strict arm silently becomes an unguarded arm.

**This is not an infrastructure failure and is not rerun.** Every hook
invocation writes its decision to `_m168_guard_events/<label>.jsonl`, so a run
whose guard never fired is identifiable after the fact and is reported as
`GUARD_INACTIVE` rather than pooled with guarded runs. If a run's index was
genuinely absent — an apparatus fault rather than a policy outcome — the
readiness telemetry says so and the run is rerun under the preparation clause
above, not under a treatment clause.

## Missing arms

`NOT_RUN != 0`. Any pairwise comparison reports its own denominator, and a task
missing an arm is excluded from that pair rather than imputed.
