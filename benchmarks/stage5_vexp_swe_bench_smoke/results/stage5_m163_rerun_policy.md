# M163 rerun policy (frozen before execution)

## Allowed

- API or network infrastructure failure
- Agent process crash unrelated to task reasoning
- Corrupted workspace
- Grader infrastructure failure
- MCP server failed to initialize despite a valid harness configuration

## Not allowed

- The agent wrote a bad patch
- VTRACE returned weak or misleading but valid evidence
- The agent ignored the tools
- **The agent violated the trigger.** `TRIGGER_NOT_COMPLIED` is a measurement,
  and it is one of the two outcomes the trigger arm exists to produce. Rerunning
  until an arm complies would convert the adoption rate into a description of
  how many attempts were bought.
- Timeout caused by agent strategy
- An inconvenient outcome

## Record-keeping

Every rerun retains the original run, the failure reason, the replacement run and
the policy clause that permitted it. Nothing is overwritten. There are no
selective reruns: an allowed failure class is applied by rule, not by inspection
of which arm it would help.
