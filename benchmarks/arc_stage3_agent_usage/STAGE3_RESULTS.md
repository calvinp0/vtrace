# ARC Stage 3 Controlled Claude Usage Results

## Scope

Stage 3 measures controlled Claude Code orientation sessions using `ccusage` local CLI usage data. Each task compares a baseline grep-snippet prompt against a vtrace context prompt for the same ARC repository-orientation question.

Stage 3 does not measure:

- autonomous patch-solving
- pass@1
- SWE-bench performance
- full development-session cost
- final code-edit correctness

## Final Headline

Across 12 controlled ARC orientation tasks, vtrace reduced ccusage-tracked Claude Code total tokens by 46.51% mean / 42.81% median. On quality-preserving pairs, mean actual reduction was 44.46%. vtrace preserved or improved orientation quality on 11/12 tasks, with one diagnostic regression on rotor scans.

## Result Summary

| Metric | Value |
| --- | ---: |
| Completed task/condition runs | 24 |
| Paired tasks | 12 |
| Mean actual total-token reduction | 46.51% |
| Median actual total-token reduction | 42.81% |
| Mean quality-preserving actual reduction | 44.46% |
| Vtrace quality same / better / worse | 3 / 8 / 1 |
| Ambiguous ccusage deltas | 0 |
| Invalid responses | 0 |

## Per-Task Paired Table

| task | baseline tokens | vtrace tokens | actual reduction | baseline quality | vtrace quality | quality preserving | preserving reduction |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: |
| boundary_cython | 40842 | 26753 | 34.50% | acceptable | strong | yes | 34.50% |
| boundary_python_wrapper_cython | 31847 | 26719 | 16.10% | missing | strong | yes | 16.10% |
| concept_kinetics_calculation | 46349 | 27291 | 41.12% | acceptable | strong | yes | 41.12% |
| concept_reaction_family_matching | 66938 | 6447 | 90.37% | weak | strong | yes | 90.37% |
| exact_arc_species | 94966 | 26722 | 71.86% | strong | strong | yes | 71.86% |
| exact_determine_family | 93122 | 27095 | 70.90% | strong | strong | yes | 70.90% |
| exact_scheduler | 33087 | 27263 | 17.60% | strong | strong | yes | 17.60% |
| known_weak_rotor_scans | 88806 | 27476 | 69.06% | strong | acceptable | no |  |
| workflow_arkane_input | 43823 | 28408 | 35.18% | missing | strong | yes | 35.18% |
| workflow_conformer_filtering | 31920 | 27157 | 14.92% | missing | strong | yes | 14.92% |
| workflow_kinetics_jobs | 56687 | 27188 | 52.04% | acceptable | strong | yes | 52.04% |
| workflow_ts_guesses | 49795 | 27632 | 44.51% | missing | acceptable | yes | 44.51% |

## Interpretation

The Stage 3 result is the first actual CLI-usage evidence. It shows that the large static context reductions from Stage 1/2 partly survive real Claude Code session accounting, but the observed savings are smaller because Claude Code includes fixed/session/cache overhead.

The fair claim is controlled-orientation usage reduction, not full agent-cost or patch-success reduction.

## Diagnostic Regression

`known_weak_rotor_scans` regressed from strong to acceptable. This was intentionally included as a broad known-weak diagnostic query. It should remain a retrieval/reranking follow-up candidate, not a blocker for the Stage 3 result.

## Relationship to Earlier Stages

| Stage | What it measured | Current result |
| --- | --- | --- |
| Stage 1 | Static context-size reduction | 97.53% mean reduction vs grep snippets, 18/20 strong |
| Stage 2 | Static orientation parity | 11/12 parity-or-better, 97.89% quality-preserving reduction |
| Stage 3 | Actual Claude Code controlled usage | 12 paired tasks, 46.51% mean actual total-token reduction, 44.46% quality-preserving reduction |

## Methodology Caveat

Stage 3 uses ccusage local CLI usage data. Token accounting includes Claude Code session/system/cache behavior, so reductions are not expected to match prompt-size reductions from Stage 1/2.

Controlled orientation runs should disable Claude tools. Tool use changes the benchmark from controlled orientation into autonomous exploration.

## Next Step

Stage 4 should test autonomous edit tasks on safe ARC worktrees or move to a small vexp-swe-bench smoke run. Stage 4 must measure patch/test success in addition to token usage.
