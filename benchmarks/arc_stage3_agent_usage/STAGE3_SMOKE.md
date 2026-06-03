# ARC Stage 3 Smoke Result

## Scope

Stage 3 measures controlled Claude Code repository-orientation sessions using `ccusage` local CLI usage data. Each paired task compares a baseline grep-snippet prompt against a vtrace context prompt for the same orientation question.

Stage 3 does not measure:

- autonomous patch-solving
- pass@1
- SWE-bench performance
- full development-session cost
- correctness of final code edits

## Current Smoke Result

| Metric | Value |
| --- | ---: |
| Paired tasks | 4 |
| Mean actual total-token reduction | 34.19% |
| Mean quality-preserving actual reduction | 22.57% |
| Quality-preserving pairs | 3 |
| Non-quality-preserving pairs | 1 |
| Contaminated vtrace paths | 0 |

## Per-Task Results

| Task | Baseline quality | Vtrace quality | Quality-preserving | Actual token reduction |
| --- | --- | --- | --- | ---: |
| workflow_arkane_input | missing | strong | yes | 35.18% |
| exact_scheduler | strong | strong | yes | 17.60% |
| workflow_conformer_filtering | missing | strong | yes | 14.92% |
| known_weak_rotor_scans | strong | acceptable | no | 69.06% |

## Interpretation

The Stage 3 smoke run shows that vtrace can reduce actual Claude Code session usage in controlled orientation tasks, but the observed savings are much smaller than Stage 1/2 static context reductions because Claude Code includes fixed/session/cache overhead.

The result should be interpreted as early actual-usage evidence, not a general agent-cost claim.

The first manual pair, `workflow_arkane_input`, showed why the orientation label matters alongside tokens. The baseline grep-snippet package did not expose enough information for Claude Code to identify where Arkane input is rendered. Claude returned `target_file: null` and explained that the snippets showed Gaussian/Psi4 templates and Arkane adapter usage, but not where Arkane input files were written/rendered.

The vtrace context identified:

```text
arc/statmech/arkane.py::ArkaneAdapter.render_arkane_input_template
```

## Diagnostic Regression

The `known_weak_rotor_scans` task was intentionally included as a known weak/broad diagnostic. The baseline achieved a stronger orientation label than vtrace. This should remain a retrieval/reranking follow-up candidate, not a blocker for the smoke benchmark.

## Relationship to Stage 1 and Stage 2

| Stage | What it measured | Current result |
| --- | --- | --- |
| Stage 1 | Static context-size reduction | 97.53% mean reduction vs grep snippets, 18/20 strong |
| Stage 2 | Static orientation parity | 11/12 parity-or-better, 97.89% quality-preserving reduction |
| Stage 3 | Actual Claude Code controlled usage | 4 paired tasks, 34.19% mean actual total-token reduction |

## Next Step

Next, run the remaining Stage 2 tasks through automated Stage 3. Report all paired tasks together, separating quality-preserving and non-quality-preserving reductions.

Only after the full controlled orientation set is complete should the project move to autonomous edit-task benchmarks or vexp-swe-bench smoke runs.
