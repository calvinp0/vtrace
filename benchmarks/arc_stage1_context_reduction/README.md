# ARC Stage 1 Context Reduction Benchmark

This benchmark compares naive ARC context gathering against existing vtrace/vexb capsule or handoff output for a fixed ARC query set.

It is not a task-solving benchmark. It measures context size reduction, file/item counts, source-backed pivots, expected ARC area surfacing, and deterministic repeatability signals for the same ARC repository state.

## Run

```bash
bun benchmarks/arc_stage1_context_reduction/run_arc_stage1_context_reduction.ts \
  --repo /home/calvin/code/ARC \
  --queries benchmarks/arc_stage1_context_reduction/queries.arc.stage1.json \
  --expected benchmarks/arc_stage1_context_reduction/expected.arc.stage1.json \
  --out benchmarks/arc_stage1_context_reduction/results \
  --baseline-max-files 5 \
  --baseline-mode all
```

Optional flags:

```text
--tool-command capsule|handoff
--max-budget-characters <n>
--baseline-mode full-file|snippet|capped-full-file|all
--snippet-context-lines <n>
--max-snippets-per-file <n>
--baseline-max-chars-per-file <n>
--expected <path>
--dry-run
--verbose
```

`handoff` is the default because it exposes routing, capsule profile, trust, budget, and items in one JSON payload. `--max-budget-characters` is recorded in metadata and notes, but the current CLI capsule/handoff commands use their built-in budget unless the engine CLI grows a budget flag.

## Outputs

The runner writes:

```text
benchmarks/arc_stage1_context_reduction/results/
  arc_stage1_context_reduction.csv
  arc_stage1_context_reduction.json
  arc_stage1_context_reduction.md
```

## Stage 1 result

The final Stage 1 closeout is recorded in [STAGE1_RESULTS.md](./STAGE1_RESULTS.md). It reports the clean quality-labeled ARC run, repeatability check, and careful interpretation of the context-reduction claim.

The baseline uses `rg` against the ARC repo, excludes common irrelevant directories and build artifacts, and takes up to `--baseline-max-files` unique files per query. Token estimates are `Math.ceil(chars / 4)`.

Baseline modes:

- `full-file`: current naive behavior, reading whole matching files.
- `snippet`: counts deterministic, de-duplicated context snippets around matching lines. Defaults: `--snippet-context-lines 40`, `--max-snippets-per-file 3`.
- `capped-full-file`: reads top matching files but caps counted content per file. Default: `--baseline-max-chars-per-file 40000`.
- `all`: computes all three baselines for each query and reports separate reductions.

The vtrace measurement invokes the local `bin/vtrace` CLI for each query and parses the JSON output. It records capsule/handoff item counts, pivot/support counts, source-backed pivot count, selected intent/profile metadata, top result, and budget-reported context characters where available.

The runner also detects vtrace result paths from excluded or stale worktree locations such as `.claude/worktrees/`, `.git/`, `__pycache__/`, `.pytest_cache/`, `node_modules/`, `dist/`, and `build/`. If any are present, the summary sets `benchmarkAcceptableForReductionClaim` to `false` and the Markdown report prints a warning that the run should not be used for context-reduction claims until the target repo is reindexed cleanly.

Quality labels are driven by `expected.arc.stage1.json`. Each query can define `expected_paths`, `expected_symbols`, and `notes`. Rows are labeled `strong` when the top vtrace result matches an expected path or symbol, `acceptable` when a non-top item matches, `weak` when context is returned without an expected match, `missing` when no vtrace context is returned, and `unchecked` when no expectation exists.

## Determinism

Query order is preserved from `queries.arc.stage1.json`. Baseline search terms and file order are deterministic, CSV rows match query order, and JSON keys are emitted in a stable construction order. Repeated runs on the same indexed ARC repo should be comparable, except for timestamp metadata.

## Limitations

The benchmark estimates tokens from character counts and does not claim model-token exactness. The naive baseline intentionally reads full matching files, so it measures a simple worst-case context gathering strategy rather than a tuned baseline. Expected ARC area hits are lightweight path/name heuristics for inspection, not a correctness oracle.
