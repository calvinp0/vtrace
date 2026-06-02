# ARC Stage 1 Context Reduction Report

## Headline summary

Against the grep-snippet baseline, mean measured context reduction was 97.53%, median was 97.97%. Full-file and capped-full-file reductions are shown as secondary baselines.

## Overall reduction

| Baseline mode | Avg baseline tokens | Avg vtrace tokens | Mean reduction | Median reduction |
| --- | ---: | ---: | ---: | ---: |
| full-file | 90179.45 | 243.50 | 99.52 | 99.57 |
| snippet | 18104.10 | 243.50 | 97.53 | 97.97 |
| capped-full-file | 35645.80 | 243.50 | 99.28 | 99.32 |

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

## Interpretation

The full-file baseline represents naive grep followed by opening whole files.
The snippet baseline represents grep-like context inspection.
The capped-full-file baseline limits very large files from dominating the measurement.

## Category-level averages

| Category | Queries | Avg vtrace tokens | mean_full_file_reduction_pct | mean_snippet_reduction_pct | mean_capped_full_file_reduction_pct |
| --- | ---: | ---: | ---: | ---: | ---: |
| boundary | 3 | 157.00 | 99.85 | 97.98 | 99.57 |
| concept | 5 | 269.60 | 99.48 | 97.83 | 99.21 |
| exact | 5 | 262.40 | 99.43 | 98.32 | 99.23 |
| stress | 2 | 243.00 | 99.49 | 94.14 | 99.22 |
| workflow | 5 | 250.60 | 99.45 | 97.51 | 99.23 |

## Worst reductions

| Query | Category | Quality | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| Scheduler | exact | strong | 23100 | 235 | 98.98 | 2 | unknown | no | arc/scheduler.py |  |
| where are conformers filtered | workflow | strong | 33267 | 295 | 99.11 | 1 | unknown | no | arc/species/conformers.py |  |
| conformer filtering | concept | strong | 36329 | 293 | 99.19 | 1 | unknown | no | arc/species/conformers.py |  |
| parser | stress | weak | 38958 | 254 | 99.35 | 2 | 1 | no | arc/exceptions.py |  |
| ARCReaction | exact | strong | 48220 | 301 | 99.38 | 2 | unknown | no | arc/reaction/reaction.py |  |

## Best reductions

| Query | Category | Quality | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| performance critical routine | boundary | strong | 723319 | 224 | 99.97 | 2 | 1 | no | arc/molecule/graph.pyx |  |
| rotor scans | concept | weak | 137776 | 203 | 99.85 | 2 | unknown | no | arc/main.py |  |
| cython | boundary | strong | 64899 | 117 | 99.82 | 2 | 2 | no | arc/molecule/atomtype.pxd |  |
| python wrapper around cython | boundary | strong | 53980 | 130 | 99.76 | 2 | 2 | no | arc/molecule/atomtype.pxd |  |
| where are kinetics jobs scheduled | workflow | strong | 77067 | 201 | 99.74 | 2 | unknown | no | arc/scheduler.py |  |

## Queries where vtrace returned no useful context

None.

## Queries where baseline returned no files

None.

## Known limitations

- Token counts are estimated as `Math.ceil(chars / 4)`, not tokenizer-exact counts.
- The baseline intentionally reads full matching files and is not a tuned retrieval baseline.
- Expected ARC area hits are lightweight path/name heuristics for inspection.
- vtrace measurements use the existing ARC vtrace index; stale or over-broad indexes can surface stale paths.
- Source-backed pivot count `unknown` means the current parsed output did not expose source-backed status for those items; it is not equivalent to zero source-backed pivots.
- The benchmark records measured context sizes only and does not claim task-solving performance.

## Suggested next measurement step

Run the same fixed query set twice on the same indexed ARC repo state, diff the CSV/JSON excluding timestamp metadata, and classify misses before changing retrieval or capsule behavior.
