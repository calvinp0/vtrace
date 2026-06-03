# ARC Stage 1 Results

## Scope

This benchmark measures initial context-selection efficiency on the real ARC repository. It compares vtrace compact context against grep-style baselines for a fixed 20-query ARC query set.

It does not measure:

- task-solving performance
- patch correctness
- pass@1
- full agent token cost
- SWE-bench performance
- whether an agent can complete an edit using only the returned capsule

## Final headline

ARC Stage 1 is complete. On 20 fixed ARC queries, vtrace reduced initial context size by 97.53% mean / 97.97% median relative to a grep-snippet baseline. The run produced strong expected-target matches for 18/20 queries, weak matches for 2/20, no missing results, and no contaminated indexed paths. Repeated runs were deterministic after excluding run-location metadata.

This is a context-selection result. It should not be read as a claim that vtrace reduces full agent cost or provides full task understanding with 97.53% fewer tokens.

## Command used

```bash
bun benchmarks/arc_stage1_context_reduction/run_arc_stage1_context_reduction.ts \
  --repo /home/calvin/code/ARC \
  --queries benchmarks/arc_stage1_context_reduction/queries.arc.stage1.json \
  --out benchmarks/arc_stage1_context_reduction/results \
  --baseline-max-files 5 \
  --baseline-mode all
```

## Baseline definitions

- `full-file`: naive ripgrep followed by opening/counting full matching files.
- `snippet`: ripgrep-style context snippets around matches; this is the primary comparison baseline.
- `capped-full-file`: full-file baseline with per-file character cap to prevent very large files from dominating.
- `vtrace`: compact capsule/handoff context returned by the existing vtrace pipeline.

## Final reduction table

| Baseline mode | Avg baseline tokens | Avg vtrace tokens | Mean reduction | Median reduction |
| --- | ---: | ---: | ---: | ---: |
| full-file | 90179.45 | 243.50 | 99.52 | 99.57 |
| snippet | 18104.10 | 243.50 | 97.53 | 97.97 |
| capped-full-file | 35645.80 | 243.50 | 99.28 | 99.32 |

The snippet baseline is the preferred headline number because it is a more realistic orientation baseline than opening whole files.

## Run status

| Metric | Value |
| --- | ---: |
| Total queries | 20 |
| vtrace returned at least one pivot/item | 20 |
| baseline returned no files | 0 |
| rows with contaminated vtrace paths | 0 |
| contaminated vtrace path count | 0 |
| acceptable for reduction claim | yes |

## Quality labels

| Label | Count |
| --- | ---: |
| strong | 18 |
| acceptable | 0 |
| weak | 2 |
| missing | 0 |
| unchecked | 0 |

Interpretation:

- `strong`: top vtrace result matched an expected ARC path or symbol.
- `acceptable`: a non-top vtrace item matched an expected ARC path or symbol.
- `weak`: vtrace returned context, but did not match the expected target.
- `missing`: vtrace returned no useful context.
- `unchecked`: no expectation was provided.

## Weak cases

| Query | Top vtrace target | Comment |
| --- | --- | --- |
| parser | arc/exceptions.py::ParserError | Broad stress query; result is plausible but likely not the best parser-code landing point. |
| rotor scans | arc/main.py::ARC | Broad concept query; result is plausible as orchestration context but likely not the best rotor-scan implementation target. |

These should be treated as retrieval/reranking follow-up candidates, not Stage 1 blockers.

## Repeatability check

Repeatability was checked by running the fixed query set twice on the same indexed ARC repo state and diffing normalized JSON outputs after removing run-location/timestamp metadata.

Normalization used this shape:

```bash
jq --sort-keys '
  del(
    .metadata.timestamp,
    .timestamp,
    .generatedAt,
    .metadata.outputDirectory,
    .outputDirectory
  )
' /tmp/arc_stage1_repeat_a/arc_stage1_context_reduction.json >| /tmp/a.normalized.json

jq --sort-keys '
  del(
    .metadata.timestamp,
    .timestamp,
    .generatedAt,
    .metadata.outputDirectory,
    .outputDirectory
  )
' /tmp/arc_stage1_repeat_b/arc_stage1_context_reduction.json >| /tmp/b.normalized.json

diff -u /tmp/a.normalized.json /tmp/b.normalized.json
```

No diff was observed.

## Interpretation

This benchmark supports a context-selection claim: vtrace can surface compact ARC-relevant context with far fewer initial tokens than grep-style baselines.

It does not prove task-solving improvement, SWE-bench performance, or total agent cost reduction. Those require later task-level benchmarks.

The fair headline is the snippet-baseline result among quality-checked queries, not the full-file baseline alone.

## Next step

Stage 2 should test whether compact vtrace context helps an agent identify or edit the correct ARC code region with fewer tool calls/tokens.

SWE-bench-style benchmarking should come later after a small smoke run.
