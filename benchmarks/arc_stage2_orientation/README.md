# ARC Stage 2 Orientation Benchmark

Stage 2 measures orientation equivalence, not patch success.

This benchmark asks whether compact vtrace context preserves enough useful orientation to identify the expected ARC file or symbol target compared with a grep-snippet baseline. It builds two local context packages for each fixed ARC task:

1. grep-style snippets around matching lines
2. vtrace capsule/handoff context from the existing CLI

Each package is scored independently against expected ARC paths and symbols.

## Difference from Stage 1

Stage 1 measured initial context-size reduction. Stage 2 adds target-orientation scoring: it checks whether the baseline and vtrace packages point to the expected ARC target, then reports token reduction only when vtrace preserves or improves orientation quality.

## Run

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

Optional flags:

```text
--tool-command capsule|handoff
--max-budget-characters <n>
--include-context
--dry-run
--verbose
```

`handoff` is the default because it exposes routing, capsule profile, trust, budget, and items in one JSON payload. `--max-budget-characters` is recorded in metadata and notes, but the current CLI capsule/handoff commands use their built-in budget unless the engine CLI grows a budget flag.

## Outputs

The runner writes:

```text
benchmarks/arc_stage2_orientation/results/
  arc_stage2_orientation.csv
  arc_stage2_orientation.json
  arc_stage2_orientation.md
```

The JSON output omits snippet bodies by default. Use `--include-context` when an inspection run needs context previews.

## Quality Labels

- `strong`: top result/file/symbol matches an expected path or symbol.
- `acceptable`: a non-top result/file/symbol matches an expected path or symbol.
- `weak`: context exists but no expected target is matched.
- `missing`: no context was returned.
- `unchecked`: no expectation exists.

For the baseline, the top result is the first grep-snippet file. For vtrace, the top result is the first capsule/handoff item.

## Orientation Parity

Quality is ordered as:

```text
missing = 0
weak = 1
acceptable = 2
strong = 3
unchecked = null
```

`vtrace_orientation_parity` is true when the vtrace score is greater than or equal to the baseline score. Quality-preserving token reduction is computed only when parity is true.

## What Not To Claim

This benchmark does not measure:

- patch correctness
- pass@1
- SWE-bench performance
- full agent cost
- whether a model can complete an edit unaided
- total token usage over an entire coding session

The fair Stage 2 claim is about orientation equivalence under a fixed task set, not task-solving performance.
