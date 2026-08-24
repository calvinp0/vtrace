# M182 live-requalification readiness

Verdict: `CURRENT_PRODUCT_LIVE_REQUALIFICATION_LICENSED`.

A future paired benchmark can treat current VTRACE's packet as a stable
intervention in the measured regime:

- the treatment materially differs from M173 (current default median/p90/max is
  1,229/1,527/1,576 model-facing tokens on 167 Broad cases, not M173's ~629);
- the M175–M181 deterministic correctness branch remains clean;
- frozen projection and fixed-index upstream generation are semantically stable
  across serial, bounded CPU/I/O load, concurrency, warm/fresh process, and real
  MCP transport;
- no retrieval or ranking policy was tuned against live outcomes in M182.

The scientifically preferable next design is a preregistered paired
baseline-vs-current-default comparison on a new stratified sample, with a small
M173 replication stratum rather than reusing its exact 12 tasks as the only proof.
Measure resolved tasks, unique wins/losses, whole-run input/output/cache tokens,
whole-run cost and paired delta, orientation tokens/cost, pre-edit investigation,
requests to first meaningful edit, and grader outcome. Gold file/symbol is
diagnostic only. Use the actual automatic compact default, with no search ban,
anti-loop discipline, mandatory no-grep rule, or special reminders.

This document licenses the future experiment; M182 ran none of it.
