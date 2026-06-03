# ARC Stage 4 Autonomous Edit Benchmark — Results

This document records the completed Stage 4 autonomous edit benchmark result. Wording is intentionally cautious and scoped to what the benchmark actually measured.

## 1. Scope

Stage 4 measures small autonomous edit tasks on isolated ARC copies/worktrees. Each task asks Claude Code to inspect an isolated ARC copy, identify the correct target, and record a concrete answer by editing a single allowed file.

Stage 4 does **not** measure:

- SWE-bench performance
- general pass@1
- arbitrary bug fixing
- production-quality code edits
- large refactors
- full development-session cost

## 2. Final headline

Across 4 small isolated ARC autonomous edit tasks, both baseline and vtrace passed all validators. Among these both-passed pairs, vtrace reduced ccusage-tracked Claude Code total tokens by 36.45% on average and reduced cost by 15.40% on average. No changed-file safety failures, invalid responses, or ambiguous ccusage deltas occurred.

## 3. Result summary

| Metric | Value |
| --- | ---: |
| Completed runs | 8 |
| Paired tasks | 4 |
| Baseline pass count | 4 |
| Vtrace pass count | 4 |
| Both passed | 4 |
| Vtrace only passed | 0 |
| Baseline only passed | 0 |
| Both failed | 0 |
| Mean token reduction for both-passed pairs | 36.45% |
| Mean cost reduction | 15.40% |
| Changed-files safety failures | 0 |
| Protected allowed-file runs | 8 |
| Runs using initial-vs-final snapshot detection | 8 |
| Ambiguous ccusage deltas | 0 |
| Invalid responses | 0 |

All Claude runs completed with `terminal_reason: completed`.

## 4. Per-task result

| Task | Baseline tokens | Vtrace tokens | Token reduction | Baseline cost | Vtrace cost | Cost reduction | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| doc_find_arkane_input | 315210 | 125781 | 60.10% | 0.2957 | 0.1497 | 49.37% | both_passed |
| doc_find_conformer_filtering | 328621 | 219578 | 33.18% | 0.3356 | 0.2923 | 12.91% | both_passed |
| doc_find_cython_boundary | 151464 | 123002 | 18.79% | 0.1639 | 0.1681 | -2.59% | both_passed |
| doc_find_scheduler | 186301 | 123482 | 33.72% | 0.1711 | 0.1678 | 1.92% | both_passed |

## 5. Safety validation

Every run changed only the allowed file:

```text
STAGE4_NOTES.md
```

There were 0 changed-file safety failures across all 8 runs.

The ARC source repo was dirty during this benchmark, but validation used initial-vs-final snapshots taken right after the isolated copy was created. Pre-existing copied dirty files were present in the initial snapshot, so they were not counted as agent edits.

Copied dirty paths (present in the source checkout, carried into the isolated copies, not attributed to the agent):

```text
.vtrace/
docs/gaussian.md
docs/gaussian_imp.md
leng_gauss.md
wang_gauss.md
```

## 6. Methodology notes

Stage 4 used protected allowed-file mode. Claude Code was allowed to perform autonomous inspection/editing, but validation enforced that only allowed files changed.

Token and cost data come from ccusage local Claude Code usage records.

## 7. Interpretation

Stage 4 is the first benchmark in this ladder that measures autonomous editing rather than only context selection or orientation. The result suggests vtrace can reduce actual Claude Code token usage on small ARC edit tasks while preserving task success.

This is still not SWE-bench, not a general pass@1 benchmark, and not proof of broad bug-fixing performance.

## 8. Relationship to earlier stages

| Stage | What it measured | Current result |
| --- | --- | --- |
| Stage 1 | Static context-size reduction | 97.53% mean reduction vs grep snippets, 18/20 strong |
| Stage 2 | Static orientation equivalence | 11/12 parity-or-better, 97.89% quality-preserving static reduction |
| Stage 3 | Actual Claude Code controlled usage | 12 paired tasks, 46.51% mean actual token reduction, 44.46% quality-preserving reduction |
| Stage 4 | Small autonomous ARC edit tasks | 4/4 both-passed pairs, 36.45% mean token reduction |

## 9. Caveats

- The task set is small.
- Tasks are documentation-style safe edits.
- Cost reduction is noisier than token reduction; one task (`doc_find_cython_boundary`) had lower tokens but slightly higher cost (-2.59%).
- The ARC source repo was dirty, but snapshot-based validation handled this.
- Results should be rerun on a clean source repo before public-facing claims if possible.

## 10. Next step

Two options:

```text
Stage 4B: add slightly more realistic edit tasks such as small unit-test additions or docstring/comment updates near real target code.
```

```text
Stage 5: run a small vexp-swe-bench smoke benchmark with 3–5 tasks.
```

Recommendation: do Stage 4B first if staying ARC-focused, then move to a SWE-bench smoke benchmark.
