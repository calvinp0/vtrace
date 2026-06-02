# ARC Stage 1 Context Reduction Report

## Headline summary

Ran 20 fixed queries against /home/calvin/code/ARC. Mean measured reduction was 99.27%, median was 99.45%. vtrace used fewer estimated tokens than the naive full-file baseline for 20/20 queries.

## Overall reduction

| Metric | Value |
| --- | ---: |
| Total queries | 20 |
| Average baseline estimated tokens | 81536.75 |
| Average vtrace estimated tokens | 233.10 |
| Mean reduction percent | 99.27 |
| Median reduction percent | 99.45 |
| vtrace tokens < baseline tokens | 20 |
| vtrace returned at least one pivot/item | 20 |
| baseline returned no files | 0 |

## Category-level averages

| Category | Queries | Avg baseline tokens | Avg vtrace tokens | Mean reduction % | Median reduction % |
| --- | ---: | ---: | ---: | ---: | ---: |
| boundary | 3 | 253372.00 | 173.33 | 98.31 | 99.50 |
| concept | 5 | 57884.00 | 241.80 | 99.44 | 99.41 |
| exact | 5 | 46464.80 | 260.60 | 99.35 | 99.46 |
| stress | 2 | 48596.00 | 205.00 | 99.54 | 99.54 |
| workflow | 5 | 50336.60 | 244.00 | 99.50 | 99.52 |

## Worst reductions

| Query | Category | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Top vtrace file | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| python wrapper around cython | boundary | 3904 | 177 | 95.47 | 2 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/molecule/atomtype.pxd |  |
| run_arc | exact | 27706 | 287 | 98.96 | 2 |  | arc/main.py |  |
| reaction family matching | concept | 25788 | 219 | 99.15 | 1 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/reaction/reaction.py |  |
| Scheduler | exact | 23100 | 191 | 99.17 | 2 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/scheduler.py |  |
| where are conformers filtered | workflow | 33270 | 209 | 99.37 | 1 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/species/conformers.py |  |

## Best reductions

| Query | Category | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Top vtrace file | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| performance critical routine | boundary | 723323 | 179 | 99.98 | 2 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/molecule/graph.pyx |  |
| rotor scans | concept | 137788 | 253 | 99.82 | 2 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/scheduler.py |  |
| transition state | stress | 64495 | 220 | 99.66 | 2 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/species/species.py |  |
| determine_family | exact | 70470 | 277 | 99.61 | 2 |  | .claude/worktrees/agent-a766b90cf0bed7d88/arc/reaction/reaction.py |  |
| how does ARC generate TS guesses | workflow | 62830 | 247 | 99.61 | 2 |  | arc/species/species.py |  |

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
