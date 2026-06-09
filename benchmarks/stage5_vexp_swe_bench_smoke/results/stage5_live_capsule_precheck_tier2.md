# Stage 5 live Capsule v2 pre-check

_Generated: 2026-06-09T18:52:25.443Z_

_Reporting / validation only. No Claude, no vexp-swe-bench agent, no patching, no Docker. Builds the actual Capsule v2 a force-inject run would inject and checks whether each suspected hidden pivot is real in the live capsule._

## Summary

- Candidates checked: 6
- Promoted (hidden pivot confirmed live): 4
- Demoted (not confirmed / inverted / retrieval miss): 2
- Ambiguous (role or gold overlap undetermined): 0

Capsule build: engine `v2`, intent `debug`, budget `8000`, context-policy `force-inject`.

Source discovery report: `stage5_edit_relevant_hidden_pivot_candidates.json`

## Method

For each candidate, this pre-check builds the SAME Capsule v2 context a live Stage 5 force-inject vtrace run injects — it calls the identical `prepareIndexedContext` orchestration (workspace checkout → vtrace index → `capsule --intent <i> --budget <n>` query) used by `run_stage5_vexp_swe_bench_smoke.ts`, into an isolated `precheck/` workspace+context dir. It then reads the live capsule's selected pivots and their role-reasons and checks whether the suspected edit-relevant gold file appears as a live, non-source-anchored pivot. No agent runs; the build is cheap relative to a full live run.

### Evidence lanes

Each major field comes from exactly one evidence lane, kept explicit so a deterministic suspicion is never confused with live or gold evidence:

- **DETERMINISTIC (discovery):** input_tier, suspected_hidden_file(s) named by the discovery report
- **LIVE CAPSULE v2:** live_pivots, source_anchored_pivots, hidden_or_non_source_pivots, suspected_file_present_as_pivot, suspected_file_hidden_in_live_capsule
- **GOLD-DERIVED:** suspected_hidden_gold_file(s), pivots_overlap_gold_patch (evaluation labels only)
- **CURATED INTERPRETATION:** promotion_decision, reason

A pivot is source-anchored iff its live role-reason names the issue's `source line anchor`; every other pivot is hidden/non-source. A blank role-reason is treated as indeterminate (→ ambiguous), never silently promoted.

## Candidates checked

| instance | tier | built | pivots | suspected present | suspected hidden | gold overlap | decision |
| --- | --- | :---: | ---: | :---: | :---: | :---: | --- |
| astropy__astropy-14369 | tier2 | yes | 2 | yes | yes | yes | promote |
| django__django-11820 | tier2 | yes | 2 | yes | yes | yes | promote |
| sympy__sympy-13372 | tier2 | yes | 2 | yes | yes | yes | promote |
| sympy__sympy-16766 | tier2 | yes | 2 | yes | yes | yes | promote |
| django__django-11740 | tier2 | yes | 2 | no | unknown | no | demote |
| django__django-12858 | tier2 | yes | 0 | no | unknown | no | demote |

## Promoted candidates

### astropy__astropy-14369

- **repo:** astropy/astropy
- **input tier** _(deterministic / discovery)_: tier2
- **suspected hidden gold file(s)** _(gold-derived)_: astropy/units/format/cds.py
- **suspected hidden symbol(s)** _(deterministic)_: CDS, VOUnit
- **live capsule built** _(live)_: yes
- **live pivot count** _(live)_: 2
- **live pivots** _(live)_: astropy/units/format/cds.py, astropy/units/format/vounit.py
- **source-anchored pivots** _(live)_: —
- **hidden / non-source pivots** _(live)_: astropy/units/format/cds.py, astropy/units/format/vounit.py
- **suspected file present as pivot** _(live)_: yes
- **suspected file hidden in live capsule** _(live)_: yes
- **pivots overlap gold patch** _(gold-derived)_: yes
- **promotion decision** _(curated)_: **promote**
- **reason** _(curated)_: suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live
- **recommended run labels:** `eval-pivot-telemetry-vtrace-astropy-14369-no-pivot-check` (before) → `eval-pivot-check-vtrace-astropy-14369` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances astropy__astropy-14369 \
  --run-label eval-pivot-telemetry-vtrace-astropy-14369-no-pivot-check \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-pivot-check \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

```bash
# after: PIVOT_CHECK enabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances astropy__astropy-14369 \
  --run-label eval-pivot-check-vtrace-astropy-14369 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-11820

- **repo:** django/django
- **input tier** _(deterministic / discovery)_: tier2
- **suspected hidden gold file(s)** _(gold-derived)_: django/db/models/base.py
- **suspected hidden symbol(s)** _(deterministic)_: _check_ordering, ChoicesMeta
- **live capsule built** _(live)_: yes
- **live pivot count** _(live)_: 2
- **live pivots** _(live)_: django/db/models/base.py, django/db/models/enums.py
- **source-anchored pivots** _(live)_: —
- **hidden / non-source pivots** _(live)_: django/db/models/base.py, django/db/models/enums.py
- **suspected file present as pivot** _(live)_: yes
- **suspected file hidden in live capsule** _(live)_: yes
- **pivots overlap gold patch** _(gold-derived)_: yes
- **promotion decision** _(curated)_: **promote**
- **reason** _(curated)_: suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-11820-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-11820` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-11820 \
  --run-label eval-pivot-telemetry-vtrace-django-11820-no-pivot-check \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-pivot-check \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

```bash
# after: PIVOT_CHECK enabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-11820 \
  --run-label eval-pivot-check-vtrace-django-11820 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### sympy__sympy-13372

- **repo:** sympy/sympy
- **input tier** _(deterministic / discovery)_: tier2
- **suspected hidden gold file(s)** _(gold-derived)_: sympy/core/evalf.py
- **suspected hidden symbol(s)** _(deterministic)_: add_terms
- **live capsule built** _(live)_: yes
- **live pivot count** _(live)_: 2
- **live pivots** _(live)_: sympy/core/evalf.py
- **source-anchored pivots** _(live)_: —
- **hidden / non-source pivots** _(live)_: sympy/core/evalf.py
- **suspected file present as pivot** _(live)_: yes
- **suspected file hidden in live capsule** _(live)_: yes
- **pivots overlap gold patch** _(gold-derived)_: yes
- **promotion decision** _(curated)_: **promote**
- **reason** _(curated)_: suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live
- **recommended run labels:** `eval-pivot-telemetry-vtrace-sympy-13372-no-pivot-check` (before) → `eval-pivot-check-vtrace-sympy-13372` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-13372 \
  --run-label eval-pivot-telemetry-vtrace-sympy-13372-no-pivot-check \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-pivot-check \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

```bash
# after: PIVOT_CHECK enabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-13372 \
  --run-label eval-pivot-check-vtrace-sympy-13372 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### sympy__sympy-16766

- **repo:** sympy/sympy
- **input tier** _(deterministic / discovery)_: tier2
- **suspected hidden gold file(s)** _(gold-derived)_: sympy/printing/pycode.py
- **suspected hidden symbol(s)** _(deterministic)_: PythonCodePrinter, _print
- **live capsule built** _(live)_: yes
- **live pivot count** _(live)_: 2
- **live pivots** _(live)_: sympy/printing/pycode.py, sympy/printing/printer.py
- **source-anchored pivots** _(live)_: —
- **hidden / non-source pivots** _(live)_: sympy/printing/pycode.py, sympy/printing/printer.py
- **suspected file present as pivot** _(live)_: yes
- **suspected file hidden in live capsule** _(live)_: yes
- **pivots overlap gold patch** _(gold-derived)_: yes
- **promotion decision** _(curated)_: **promote**
- **reason** _(curated)_: suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live
- **recommended run labels:** `eval-pivot-telemetry-vtrace-sympy-16766-no-pivot-check` (before) → `eval-pivot-check-vtrace-sympy-16766` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-pivot-telemetry-vtrace-sympy-16766-no-pivot-check \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --disable-pivot-check \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

```bash
# after: PIVOT_CHECK enabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-16766 \
  --run-label eval-pivot-check-vtrace-sympy-16766 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Demoted candidates

### django__django-11740

- **repo:** django/django
- **input tier** _(deterministic / discovery)_: tier2
- **suspected hidden gold file(s)** _(gold-derived)_: django/db/migrations/autodetector.py
- **suspected hidden symbol(s)** _(deterministic)_: _get_dependencies_for_foreign_key, ForeignKey
- **live capsule built** _(live)_: yes
- **live pivot count** _(live)_: 2
- **live pivots** _(live)_: django/contrib/gis/gdal/feature.py
- **source-anchored pivots** _(live)_: —
- **hidden / non-source pivots** _(live)_: django/contrib/gis/gdal/feature.py
- **suspected file present as pivot** _(live)_: no
- **suspected file hidden in live capsule** _(live)_: unknown
- **pivots overlap gold patch** _(gold-derived)_: no
- **promotion decision** _(curated)_: **demote**
- **reason** _(curated)_: suspected edit-relevant file is absent from the live Capsule v2 pivots — the deterministic suspicion is not confirmed by the live build

### django__django-12858

- **repo:** django/django
- **input tier** _(deterministic / discovery)_: tier2
- **suspected hidden gold file(s)** _(gold-derived)_: django/db/models/base.py
- **suspected hidden symbol(s)** _(deterministic)_: _check_ordering, ForeignKey
- **live capsule built** _(live)_: yes (django__django-12858: vtrace query failed (exit 1): Repo not indexed: /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/precheck/workspaces/django__django-12858)
- **live pivot count** _(live)_: 0
- **live pivots** _(live)_: —
- **source-anchored pivots** _(live)_: —
- **hidden / non-source pivots** _(live)_: —
- **suspected file present as pivot** _(live)_: no
- **suspected file hidden in live capsule** _(live)_: unknown
- **pivots overlap gold patch** _(gold-derived)_: no
- **promotion decision** _(curated)_: **demote**
- **reason** _(curated)_: live capsule produced no pivots — retrieval failure, not a hidden-pivot case

## Ambiguous candidates

_None._

## Recommended next live runs

Run the controlled before/after pair (the exact commands are in each promoted candidate above):

1. **astropy__astropy-14369** — suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live
1. **django__django-11820** — suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live
1. **sympy__sympy-13372** — suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live
1. **sympy__sympy-16766** — suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live

## Non-claims

- This pre-check does not call Claude.
- This pre-check does not run the external vexp-swe-bench agent.
- This pre-check does not patch files or run Docker.
- This pre-check does not prove PIVOT_CHECK improves patch quality — it only confirms whether the suspected hidden pivot is real in the live capsule.
- A promotion means the live capsule confirms the hidden pivot is present; it does not guarantee the agent will edit it.
- Gold overlap is an evaluation label; it means the file is in the gold patch, not that the specific symbol must change.

