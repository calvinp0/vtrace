# ARC Stage 1 Context Reduction Report

## Headline summary

Ran 20 fixed queries against /home/calvin/code/ARC with 3 baseline modes. Baseline-specific reductions are shown in the comparison table.

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

## Interpretation

The full-file baseline represents naive grep followed by opening whole files.
The snippet baseline represents grep-like context inspection.
The capped-full-file baseline limits very large files from dominating the measurement.

## Category-level averages

| Category | Queries | Avg baseline tokens | Avg vtrace tokens | Mean reduction % | Median reduction % |
| --- | ---: | ---: | ---: | ---: | ---: |
| boundary | 3 | 280732.67 | 157.00 | 99.85 | 99.82 |
| concept | 5 | 66753.60 | 269.60 | 99.48 | 99.42 |
| exact | 5 | 53293.40 | 262.40 | 99.43 | 99.57 |
| stress | 2 | 51726.50 | 243.00 | 99.49 | 99.49 |
| workflow | 5 | 51540.60 | 250.60 | 99.45 | 99.41 |

## Worst reductions

| Query | Category | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| Scheduler | exact | 23100 | 235 | 98.98 | 2 | unknown | no | arc/scheduler.py |  |
| where are conformers filtered | workflow | 33267 | 295 | 99.11 | 1 | unknown | no | arc/species/conformers.py |  |
| conformer filtering | concept | 36329 | 293 | 99.19 | 1 | unknown | no | arc/species/conformers.py |  |
| parser | stress | 38958 | 254 | 99.35 | 2 | 1 | no | arc/exceptions.py |  |
| ARCReaction | exact | 48220 | 301 | 99.38 | 2 | unknown | no | arc/reaction/reaction.py |  |

## Best reductions

| Query | Category | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| performance critical routine | boundary | 723319 | 224 | 99.97 | 2 | 1 | no | arc/molecule/graph.pyx |  |
| rotor scans | concept | 137776 | 203 | 99.85 | 2 | unknown | no | arc/main.py |  |
| cython | boundary | 64899 | 117 | 99.82 | 2 | 2 | no | arc/molecule/atomtype.pxd |  |
| python wrapper around cython | boundary | 53980 | 130 | 99.76 | 2 | 2 | no | arc/molecule/atomtype.pxd |  |
| where are kinetics jobs scheduled | workflow | 77067 | 201 | 99.74 | 2 | unknown | no | arc/scheduler.py |  |

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
