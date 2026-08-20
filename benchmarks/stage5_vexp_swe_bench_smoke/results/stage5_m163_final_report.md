# M163 — Callable tool adoption policy ablation

**Overall: MIXED.** The policy→adoption question was answered decisively. The
adoption→utility question could not be asked, because every VTRACE call the
experiment finally produced was refused by the product.

```text
architecture verdict:  HARNESS_INVALID   (scope: utility transition only)
adoption verdict:      ADOPTION_CAUSALLY_INCREASED
utility verdict:       UTILITY_NOT_MEASURABLE
extension decision:    DO NOT EXTEND
```

| Workstream | Verdict |
| --- | --- |
| A — policy protocol freeze | PASS |
| B — analyzer controls + live gates | PASS |
| C — 36-arm execution | PASS |
| D — adoption and conditional utility | MIXED |
| E — verdict and next step | PASS |

## The three questions, answered in order

**Did neutral policy make agents spontaneously adopt VTRACE?**
No. 0/12, replicating M162 — and now with a stronger control, since Arm A shows
the same 0/12 with the policy withheld entirely. The policy neither helped nor
was the obstacle.

**Did an explicit task-level orientation trigger make them adopt VTRACE?**
Yes, completely. 12/12 adoption, 12/12 compliance, and in every run the VTRACE
call was the first repository action taken.

**Once agents consumed VTRACE evidence, did it improve success or efficiency?**
Unanswerable. They never consumed any. 14 calls, 0 returning evidence.

## Execution

36/36 arms, 0 failures, 0 infra retries, 0 reruns, 0 protocol changes mid-sweep.
Sweep spend $26.21; gates $1.17; total **$27.38** against a $30 authorization.

Availability was read from each run's own init event: 36/36 show the `vtrace`
server connected with exactly the two frozen tools visible and permitted. The
trigger reached exactly the 12 trigger arms and no others, verified per run from
its own artifacts rather than from driver intent.

## Adoption

| Arm | available | used | adoption | first-call median | voluntary follow-up |
| --- | ---: | ---: | ---: | ---: | ---: |
| TOOLS_ONLY | 12 | 0 | 0% | — | 0 |
| TOOLS_NEUTRAL_POLICY | 12 | 0 | 0% | — | 0 |
| TOOLS_TASK_TRIGGER | 12 | 12 | 100% | 0 | 2 |

The two follow-up calls are **retries after an error**, not perceived utility:
both runs were rejected with `invalid_request` and called again. Counting them as
voluntary reuse would have been a flattering misreading, and it is the reason the
taxonomy separates a required call from a voluntary one and both from a retry.

## Solve

| Arm | resolved | graded runs | not run |
| --- | ---: | ---: | ---: |
| TOOLS_ONLY | 7 | 12 | 0 |
| TOOLS_NEUTRAL_POLICY | 8 | 12 | 0 |
| TOOLS_TASK_TRIGGER | 8 | 12 | 0 |

NEUTRAL ↔ TRIGGER paired: 8 shared success, 4 shared failure, **0 unique wins on
either side** — identical on every task. Under zero evidence exposure that is the
expected outcome and says nothing about repository intelligence.

`matplotlib-24177` produced an empty patch on all three arms after 86–94 turns
and ~$1.8 each; the grader declines to run on an empty patch, so it is scored
unresolved by rule, applied per arm on the same condition. That is why 33 arms
carry Docker grades and 36 carry outcomes.

## Why utility is unmeasurable

Every workspace the runner builds has `index.sqlite` but no `config.json` or
`state.json`, because it prepares them with `vtrace index` and never `vtrace
init`. The MCP server gates engine-backed tools on
`config.initialized && state.initialized`, so all twelve calls returned
`repo_not_ready` — while the same responses reported `ready: true`, `fresh`,
`coverageComplete: true`, and an indexed worktree identical to the requested one.

Isolated offline in `stage5_m163_delivery_defect.json`: index-without-init
refuses, init-then-index passes the gate.

Recorded, not fixed. The frozen protocol forbids product changes mid-milestone.

## Analyzer corrections applied during D

Three read-side defects were found and corrected. None altered treatment or
execution; all raw run data is preserved.

1. **Degenerate reaction labels.** With no returned paths, `IGNORED` and
   `DISAGREED_AND_RECOVERED` are true by construction. They were firing on 12 and
   8 runs respectively and would have been reported as agent behaviour. Now gated
   behind `evidenceDelivered`, and a `NO_EVIDENCE_DELIVERED` state was added.
   *Metrics affected:* `byReaction` (`IGNORED` 12→0, `DISAGREED_AND_RECOVERED`
   8→0), `falseAuthority` (already none, now undefined by construction).
2. **Declined ≠ empty.** A refusal and an empty search are identical in an item
   count. `PRODUCT_DECLINED` is now its own tier. *Metrics affected:* `byTier`
   (`EMPTY` 10→0, `PRODUCT_DECLINED` 0→10).
3. **Query capture.** The harness records MCP inputs in its own `query` field and
   leaves `args` null, so every query scored as empty and therefore misaligned.
   Reading order was also wrong: emptiness was checked before the evidence gate.
   *Metrics affected:* `byQueryClass` (`QUERY_ITSELF_MISALIGNED` 12→0,
   `NOT_APPLICABLE` 0→12). The genuine malformed-argument finding is now taken
   from the product's own `invalid_request` error instead, which is 2 runs.

Five positive controls were added for these, pinning both polarities.

## Token economics

| Arm | schema | policy | dynamic (median) | total |
| --- | ---: | ---: | ---: | ---: |
| TOOLS_ONLY | 1937 | 0 | 0 | 1937 |
| TOOLS_NEUTRAL_POLICY | 1937 | 128 | 0 | 2065 |
| TOOLS_TASK_TRIGGER | 1937 | 128 | 1370 | 3435 |

Median total model traffic per run was 1.25M–1.53M tokens, overwhelmingly cache
reads. Traffic and billed cost are reported separately throughout; neither is
used as a proxy for the other.

## Standing findings

- **A trigger placed in the task prompt causes adoption; the same guidance served
  on the MCP initialize channel does not.** 0/12 against 12/12, on the same tool
  surface, in the same execution window. The neutral policy explicitly names
  `get_code_context` as the initial orientation tool and was read by twelve
  agents who then never called it.

- **A correctly routed tool is not a tool that can answer.** M162 ended with
  "implemented ≠ discoverable ≠ allowed ≠ correctly routed". M163 adds the next
  link and it was the one that broke. Every layer of testing passed while the
  readiness gate and the workspace preparation disagreed about what initialized
  means.

- **A positive control built differently from the thing it qualifies validates
  the wrong path.** Gate 1 and the trigger smoke both passed on fixtures prepared
  with `vtrace init` + `vtrace index`. The sweep used `vtrace index` alone. The
  controls proved the runtime end to end and could not have caught this, because
  they never ran against a workspace shaped like the ones under test.

- **Forcing exposure is measurably safe even when it is useless.** Twelve
  mandated calls at turn zero, all refused, cost a median of 0 extra turns and
  −$0.011, with no unique losses. Whatever the risk of proactive routing is, it
  is not that the interruption itself is damaging.

- **Two milestones have now measured VTRACE without an agent consuming it.** M161
  injected context largely ignored; M162 offered tools never called; M163 forced
  calls the product refused. The utility of callable repository intelligence
  remains untested, and no retrieval work is licensed by any of the three.

## Next step

Repair the readiness seam between the benchmark's workspace preparation and the
MCP server's initialization gate, then re-run NEUTRAL vs TRIGGER with evidence
actually delivered. That is a separate milestone requiring separate
authorization. No product change is made here, and no retrieval, ranking or
candidate-generation work is justified by these results.
