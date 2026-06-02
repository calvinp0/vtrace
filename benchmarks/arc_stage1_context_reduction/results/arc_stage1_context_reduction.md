# ARC Stage 1 Context Reduction Report

## Warning

WARNING: This run is contaminated and should not be used for context-reduction claims until the target repo is reindexed cleanly.

Detected 17 contaminated vtrace path(s) across 14 row(s).

## Headline summary

The benchmark executed, but the reduction result is not claimable because contaminated indexed paths were detected.

## Overall reduction

| Metric | Value |
| --- | ---: |
| Total queries | 20 |
| Average baseline estimated tokens | 81535.65 |
| Average vtrace estimated tokens | 230.50 |
| Mean reduction percent | 99.29 |
| Median reduction percent | 99.44 |
| vtrace tokens < baseline tokens | 20 |
| vtrace returned at least one pivot/item | 20 |
| baseline returned no files | 0 |
| rows with contaminated vtrace paths | 14 |
| contaminated vtrace path count | 17 |
| acceptable for reduction claim | no |

## Category-level averages

| Category | Queries | Avg baseline tokens | Avg vtrace tokens | Mean reduction % | Median reduction % |
| --- | ---: | ---: | ---: | ---: | ---: |
| boundary | 3 | 253370.67 | 173.33 | 98.31 | 99.50 |
| concept | 5 | 57881.00 | 241.00 | 99.46 | 99.41 |
| exact | 5 | 46464.80 | 250.80 | 99.39 | 99.46 |
| stress | 2 | 48596.00 | 199.50 | 99.56 | 99.56 |
| workflow | 5 | 50336.00 | 246.40 | 99.49 | 99.43 |

## Worst reductions

| Query | Category | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| python wrapper around cython | boundary | 3904 | 177 | 95.47 | 2 | unknown | yes | .claude/worktrees/agent-a766b90cf0bed7d88/arc/molecule/atomtype.pxd |  |
| run_arc | exact | 27706 | 255 | 99.08 | 2 | unknown | no | arc/main.py |  |
| Scheduler | exact | 23100 | 172 | 99.26 | 2 | unknown | yes | arc/scheduler.py |  |
| reaction family matching | concept | 25788 | 181 | 99.30 | 1 | unknown | no | arc/reaction/reaction.py |  |
| kinetics calculation | concept | 43615 | 294 | 99.33 | 2 | unknown | no | arc/checks/ts.py |  |

## Best reductions

| Query | Category | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| performance critical routine | boundary | 723319 | 179 | 99.98 | 2 | unknown | yes | .claude/worktrees/agent-a766b90cf0bed7d88/arc/molecule/graph.pyx |  |
| rotor scans | concept | 137776 | 253 | 99.82 | 2 | unknown | yes | .claude/worktrees/agent-a766b90cf0bed7d88/arc/scheduler.py |  |
| transition state | stress | 64495 | 220 | 99.66 | 2 | unknown | yes | .claude/worktrees/agent-a766b90cf0bed7d88/arc/species/species.py |  |
| where are kinetics jobs scheduled | workflow | 59861 | 228 | 99.62 | 2 | unknown | yes | arc/scheduler.py |  |
| how does ARC generate TS guesses | workflow | 62830 | 247 | 99.61 | 2 | unknown | yes | arc/species/species.py |  |

## Queries where vtrace returned no useful context

None.

## Queries where baseline returned no files

None.

## Known limitations

- Token counts are estimated as `Math.ceil(chars / 4)`, not tokenizer-exact counts.
- The baseline intentionally reads full matching files and is not a tuned retrieval baseline.
- Expected ARC area hits are lightweight path/name heuristics for inspection.
- vtrace measurements use the existing ARC vtrace index; stale or over-broad indexes can surface stale paths.
- The benchmark records measured context sizes only and does not claim task-solving performance.

## Suggested next measurement step

Run the same fixed query set twice on the same indexed ARC repo state, diff the CSV/JSON excluding timestamp metadata, and classify misses before changing retrieval or capsule behavior.
