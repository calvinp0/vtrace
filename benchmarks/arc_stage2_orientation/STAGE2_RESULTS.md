# ARC Stage 2 Results

## Scope

Stage 2 measures orientation equivalence: whether compact vtrace context identifies the same expected ARC target as grep-snippet context.

It does not measure:

- patch correctness
- pass@1
- SWE-bench performance
- full agent cost
- complete edit success

## Final headline

ARC Stage 2 is complete. On 12 checked ARC orientation tasks, vtrace achieved orientation parity or better on 11/12 tasks, with 97.89% mean quality-preserving context reduction on parity-preserving tasks. No contaminated vtrace paths were detected. The only diagnostic regression was known_weak_rotor_scans.

## Command used

```bash
bun benchmarks/arc_stage2_orientation/run_arc_stage2_orientation.ts \
  --repo /home/calvin/code/ARC \
  --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json \
  --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json \
  --out benchmarks/arc_stage2_orientation/results \
  --baseline-max-files 5 \
  --snippet-context-lines 40 \
  --max-snippets-per-file 3
```

## Metric definitions

- `baseline quality`: quality label assigned to the grep-snippet context package by checking whether its top or non-top files/symbols match the expected ARC target.
- `vtrace quality`: quality label assigned to the vtrace capsule/handoff context package by checking whether its top or non-top files/symbols match the expected ARC target.
- `orientation parity`: true when the vtrace quality score is greater than or equal to the baseline quality score.
- `quality-preserving reduction`: estimated token reduction reported only for rows where vtrace achieves orientation parity.
- `contaminated path detection`: a guard that flags vtrace paths from suspicious stale or excluded locations such as `.claude/worktrees/`, `.git/`, `__pycache__/`, `.pytest_cache/`, `node_modules/`, `dist/`, or `build/`.

## Result summary

| Metric | Value |
| --- | ---: |
| Checked tasks | 12 |
| Orientation parity or better | 11 |
| Orientation parity rate | 91.67% |
| Mean quality-preserving reduction | 97.89% |
| Contaminated vtrace paths | 0 |
| Diagnostic regressions | 1 |

## Regression

| Task | Status | Note |
| --- | --- | --- |
| known_weak_rotor_scans | regression | Broad diagnostic query. vtrace landed on a weaker target than the grep-snippet baseline. Keep as retrieval/reranking follow-up, not a Stage 2 blocker. |

## Interpretation

Stage 2 strengthens the Stage 1 result by showing that the smaller vtrace context usually preserves target-orientation quality, rather than merely being smaller. It still does not prove patch success or total agent-cost savings.

## Next step

Stage 3 should run a small agent-facing ARC target-identification benchmark. The baseline agent receives grep snippets; the vtrace agent receives capsule/handoff context. The task is to identify the correct file/symbol to inspect or edit, measuring correctness, tokens, tool calls, and extra context requests.
