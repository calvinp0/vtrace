# M189 — outstanding defects and out-of-scope observations

Recorded, not fixed. §39 forbids incidental repair, and none of these was in M189's scope.

## Out of scope, found during M189

**1. The benchmark test environment degraded between 2026-06 and 2026-07 and has not
recovered.** Runner starts fall from 206 of 857 arms (June) to 0 of 97 (July) to 10 of 339
(August), on an identical model. M187 diagnosed the mechanism and built probes proving the
environment is repairable; nothing has repaired it in the default live path. Any milestone
that wants to observe validation behaviour must fix this first, and any milestone that reports
"agents do not test" without fixing it is measuring its own installation.

**2. `getImpactGraph`'s `nodes`/`edges` are documented as a legacy reverse view and silently
ignore the `direction` parameter.** `direction: "upstream" | "downstream" | "both"` produces
byte-identical `nodes`/`edges`; only `directRelations` carries the direction. This is
documented behaviour, not a bug, but it is a trap: M189's first derivation consumed
`nodes`/`edges`, was blind to everything the change depends on, and returned a false negative
across 255 decision points before the pilot caught it. A consumer reading the field names
alone would make the same mistake.

**3. The exact-test entrypoint set is empty at depth 1 and explosive at depth 2.** For the
symbols agents actually change, `getImpactGraph(depth: 1).tests` is empty at 706 of 992 failing
decision points; at depth 2 it reaches 233 test files. There is no usable middle. This is an
observation about the shape of the test graph in these repositories, not a defect claim about
the product, and M189 did not attempt to find a better relation — §16 forbids inventing one.

**4. `bun src/cli/index.ts impact-graph <repo> <fqn>` rejects arguments the parser appears to
accept.** M189 could not get the CLI form to run and used the `getImpactGraph` engine API
directly. Not investigated; the engine path is the one the MCP tool uses and was sufficient.

## Limitations of M189's own analysis

**5. `DEPENDENCIES` is not out-of-sample.** Added after a pilot over 78 of the eventual 866
arms, and it is the arm carrying the milestone's only positive signal. Disclosed in the report
§4 and §7; it is a reason the I5 result is PARTIAL and authorizes nothing.

**6. Specimen repetition is unbalanced.** 59 of 62 `I5_EDIT_SET_MISS` arms are one sphinx task.
Task-level counting neutralises this for the verdict but cannot manufacture repetition.

**7. Reachability is a property of the edit, not the task.** The post-hoc diagnostic gives
different answers across arms of `django-16263` because each arm changed different symbols.
Correct behaviour; a future milestone reasoning about task-level reachability must not reuse
these per-arm numbers.

**8. Symbol attribution and derivation are depth-1 and Python-shaped.** Depth 2 was measured
and rejected on boundedness, not recall. Non-Python repositories in the corpus contribute
`contains`/`imports` evidence only, per the index's own coverage notes.
