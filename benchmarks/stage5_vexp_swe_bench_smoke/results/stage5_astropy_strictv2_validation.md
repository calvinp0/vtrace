# Stage 5 strict-v2 Astropy validation

_Generated: 2026-06-11T16:43:06.226Z_

## Summary

A fresh strict-v2 VTRACE run on `astropy__astropy-14369` (run label `eval-strictv2-vtrace-astropy-14369`) produced a patch and resolved under Docker evaluation. The patch edited the expected CDS parser files (confirmed). Ordered telemetry was available, and anti-loop guidance was injected. The run still triggered the long-Bash-loop and repeated-search heuristics. No Capsule/ranking manifest was persisted in the run directory, so this report does not make a causal pivot-ranking claim.

## Run identity

- Run label: `eval-strictv2-vtrace-astropy-14369`
- Instance: `astropy__astropy-14369`
- Condition: `vtrace`
- Model: claude-opus-4-5-20251101
- Agent: claude-code
- Commit: fa4e8d1cd279acf9b24560813c8652494ccd5922

## Docker evaluation

- Evaluation ran: yes
- Evaluation method: docker
- Docker used: yes
- Evaluation error: null
- Instances evaluated: 1
- Resolved count: 1
- Resolved: True

## Patch summary

- Patch present: yes
- Edited expected CDS parser files: yes
- Grammar change detected (division_of_units reorder): yes

| edited file | expected |
| --- | --- |
| astropy/units/format/cds.py | yes |
| astropy/units/format/cds_parsetab.py | yes |

## Cost and token outcome

- Total tokens: 4,079,593
- Cost (USD): $1.6942299999999997
- Turns: 75
- Duration (ms): 310811

| tool | calls |
| --- | ---: |
| Grep | 6 |
| Glob | 4 |
| Read | 8 |
| Edit | 1 |
| Bash | 12 |

## Ordered telemetry outcome

- Ordered telemetry available: yes
- Total tool calls: 31
- Bash tool calls: 12
- Grep-like tool calls: 10
- File-read tool calls: 8
- File-write tool calls: 1
- Unique files touched by tools: 9
- PIVOT_CHECK checklist emitted: no

### Anti-loop guidance metadata

- Tool-use discipline injected: yes
- Tool-use discipline version: v1
- Tool-use discipline disabled by flag: no
- VTRACE tool log ordered: yes

## Tool-loop finding

- Long Bash loop heuristic: yes
- Repeated search heuristic: yes

Despite the injected anti-loop tool-use discipline, the run still tripped both loop heuristics: it used 31 ordered tool calls including 12 Bash and 10 grep-like calls. Anti-loop guidance was present but did not, on this run, prevent the looping signature.

## Capsule/ranking metadata caveat

- Capsule/ranking manifest present: no
- Candidate manifest filenames probed: _capsule.manifest.json, _capsule_manifest.json, _capsule.v2.json, _pivot_ranking.json, _ranking.json
- Manifest files found: none
- Capsule/ranking meta keys found in `_run.meta.json`: none

No Capsule v2 manifest or pivot-ranking metadata artifact was persisted in this run directory. The live pivot order Capsule v2 produced therefore cannot be reconstructed from the raw artifacts, so this report cannot attribute the resolution to pivot-ranking v2.

## Interpretation

The strict-v2 Astropy run validates that the current strict VTRACE setup can resolve astropy__astropy-14369 under Docker. However, it does not close the loop-efficiency problem: the run still used 31 ordered tool calls, including 12 Bash calls and 10 grep-like calls, triggering both loop heuristics. Because no Capsule/ranking manifest was persisted for this run, the artifact supports a successful fresh strict-v2 run but not a causal claim that pivot-ranking v2 changed the live pivot order.

## Recommended next step

Persist Capsule v2 manifest/ranking metadata into Stage 5 raw run artifacts for future VTRACE runs, so ranking changes can be audited causally from the run directory.

## Non-claims

- This does NOT prove aggregate improvement.
- This does NOT prove pivot-ranking v2 caused the resolution.
- This does NOT prove anti-loop guidance solved looping.
- This is NOT a public SWE-bench score.
- This does NOT compare VTRACE to VEXP.

