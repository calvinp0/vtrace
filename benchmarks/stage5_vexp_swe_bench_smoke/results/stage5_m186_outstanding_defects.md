# M186 — outstanding defects and scope boundaries

## Status table

| Finding | Status | Reproduced in M186? | Product consequence |
|---|---|---|---|
| silent missing-materialization no-op (M183 specimen) | **absent on HEAD**, repaired by `7b10dcd0` | yes, at `7b10dcd0~1` only | none on HEAD |
| no-op over a foreign-schema database | covered end-to-end (new test) | yes, at `7b10dcd0~1` | none on HEAD |
| no-op over a graph attached to the wrong source state | covered end-to-end (new test) | yes, at `7b10dcd0~1` | none on HEAD |
| success reporting indexed files the graph does not hold | covered (new test) | yes, at `7b10dcd0~1` | none on HEAD |
| `edge_call_sites` orphans after an out-of-band graph wipe | inherited from M184, not repaired | not re-measured | fails loudly, exit 1 — never false success |
| stale `VTRACE_TOOLING_AUDIT.md` | inherited debt (untracked) | n/a | docs only; no M186 finding changes what it claims |

## Scope boundaries observed

- **No product code was changed.** Current HEAD already satisfies the invariant,
  so §2 forbids duplicating the repair or refactoring the seam. The only change is
  three lifecycle regressions in the test file that already owns this invariant —
  no second lifecycle authority, no `materializationV2`.
- **One matrix state was deliberately not exercised:** a torn/corrupt database file
  rather than a foreign schema. M184 measured that state as failing loudly with a
  non-zero exit and a truthful message, which is a valid architecture outcome and
  not a false no-op, so re-manufacturing byte corruption would add risk without
  adding coverage.
- **R4 plans `full_rebuild`, not `incremental`,** when a symbol is appended: the
  affected closure is uncertain. This is pre-existing planner behaviour, identical
  in both arms, and was left alone.
- **Nothing here licenses live work.** No live agent, no Docker evaluation and no
  benchmark rerun was performed or is authorized by this milestone.
