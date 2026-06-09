# Stage 5 edit-relevant hidden-pivot candidate discovery

_Generated: 2026-06-09T17:03:11.144Z_

_Reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry / benchmark changes. Ranks existing artifacts for targeted future validation._

## Summary

- Instances considered: 50
- Tier 1 (strong edit-relevant hidden-pivot): 1
- Tier 2 (plausible, edit relevance uncertain): 6
- Rule-out / control: 16
- Rejected: 27

Source artifacts scanned:

- `stage5_retrieval_eval_cross_repo_30.json`
- `stage5_retrieval_eval_expanded.json`
- `runs/*/raw/vtrace/_run.meta.json (+ modelPatch)`
- `stage5_pivot_check_edit_relevance.json`

## Method

Each instance is assembled from up to three sources: the deterministic Capsule v2 retrieval evaluation (retrieved pivots + gold `expected_files`), any live Stage 5 run metadata (the actual injected `vtraceCapsulePivots` + the run's edited files), and the curated post-inspection edit-relevance file. Live pivots are preferred when present because the live force-inject capsule (with a failing-test signal) is what PIVOT_CHECK actually acts on; the deterministic capsule frequently differs.

### Telemetry-derived vs curated/gold-derived

- **Telemetry / derived:** retrieved pivots, retrieval success, prior run labels, prior edited files. The anchored/hidden split is reliable only from a LIVE capsule role-reason (`source line anchor …`); deterministic-only instances fall back to a rank proxy (top-1 pivot = obvious anchor), labelled `deterministic_rank_proxy` per candidate.
- **Gold-derived:** gold patch files (`expected_files`) and hidden∩gold overlap — EVALUATION labels only, never agent input.
- **Curated:** the post-inspection edit-relevance judgements.

Edit relevance is reported as `unknown` whenever gold metadata is absent — never invented.

## Scoring rubric

Transparent additive score (weights fixed in code, listed here):

| factor | points | note |
| --- | ---: | --- |
| hidden pivot overlaps gold patch file | +3 | a retrieved hidden pivot's file is in the gold patch (gold-derived) |
| hidden pivot is not issue/source anchored | +2 | at least one retrieved pivot is non-source-anchored |
| capsule has >= 2 pivots | +2 | multi-pivot capsule (>= 2 distinct pivot files) |
| obvious source-anchored pivot differs from hidden pivot | +2 | an anchored file and a DISTINCT hidden file both exist (the sphinx-7462 shape) |
| prior live run ignored/discovered-only hidden pivot | +1 | curated/live evidence the hidden pivot was not inspected→edited |
| prior live edited only source-anchored file | +1 | a prior live patch touched the anchored file but not the hidden pivot |
| no gold/edit-relevance evidence | -3 | no gold patch metadata AND no curated edit-relevance |
| hidden pivot is example/test-only or reproduction-only | -3 | the only hidden pivots are tests/examples/docs, or curated as reproduction-only |
| retrieval missing hidden/gold file | -4 | gold is known but was not retrieved anywhere by the deterministic capsule |
| no hidden pivot | -5 | no non-source-anchored pivot at all |

Tiering: **Tier 1** = hidden pivot overlaps gold AND is distinct from the source-anchored file AND the anchored/hidden split is confirmed by a LIVE capsule role-reason. **Tier 2** = multi-pivot + hidden pivot that is gold-overlapping-but-proxy-split or whose edit relevance is unverified. **Rule-out / control** = hidden pivot known NOT edit-relevant (useful for overhead / correct-rule-out). **Reject** = no hidden pivot, single-pivot capsule, or retrieval miss. Deterministic rank-proxy candidates are capped at Tier 2 until a live capsule confirms the split.

## Tier 1 candidates

### sphinx-doc__sphinx-7462

- **repo:** sphinx-doc/sphinx
- **score:** 11  ·  **tier:** tier1
- **classification reason:** hidden pivot is gold-relevant and distinct from the source-anchored file, split confirmed by the live capsule (sphinx-7462 shape)
- **source-anchored file(s)** _(derived: live_role_reason)_: sphinx/domains/python.py
- **hidden pivot file(s)** _(telemetry/live)_: sphinx/pycode/ast.py
- **hidden pivot symbol(s):** unparse
- **gold patch file(s)** _(gold-derived)_: sphinx/domains/python.py, sphinx/pycode/ast.py
- **hidden∩gold overlap** _(gold-derived)_: yes
- **curated edit-relevant** _(curated)_: yes (failed_to_connect_to_edit)
- **prior live status** _(telemetry)_: live run(s): eval-localization-gap-vtrace-sphinx-7462, eval-locgap-multipivot-sphinx-7462, eval-pivot-check-vtrace-sphinx-7462, eval-pivot-telemetry-vtrace-sphinx-7462, eval-pivot-telemetry-vtrace-sphinx-7462-r2
- **prior hidden-pivot engagement:** curated: failed_to_connect_to_edit
- **scoring factors:** hidden pivot overlaps gold patch file (+3); hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2); prior live run ignored/discovered-only hidden pivot (+1); prior live edited only source-anchored file (+1)
- **risk / uncertainty:** —
- **recommended run labels:** `eval-pivot-telemetry-vtrace-sphinx-7462-no-pivot-check` (before) → `eval-pivot-check-vtrace-sphinx-7462` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sphinx-doc__sphinx-7462 \
  --run-label eval-pivot-telemetry-vtrace-sphinx-7462-no-pivot-check \
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
  --instances sphinx-doc__sphinx-7462 \
  --run-label eval-pivot-check-vtrace-sphinx-7462 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Tier 2 candidates

### sympy__sympy-13372

- **repo:** sympy/sympy
- **score:** 9  ·  **tier:** tier2
- **classification reason:** hidden pivot overlaps gold and looks distinct from the anchor, but the split is a deterministic rank proxy — confirm with a live capsule build before promoting
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: sympy/core/sympify.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: sympy/core/evalf.py
- **hidden pivot symbol(s):** add_terms
- **gold patch file(s)** _(gold-derived)_: sympy/core/evalf.py
- **hidden∩gold overlap** _(gold-derived)_: yes
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot overlaps gold patch file (+3); hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots
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

### astropy__astropy-14369

- **repo:** astropy/astropy
- **score:** 7  ·  **tier:** tier2
- **classification reason:** hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
- **source-anchored file(s)** _(derived: live_role_reason)_: —
- **hidden pivot file(s)** _(telemetry/live)_: astropy/units/format/cds.py, astropy/units/format/vounit.py
- **hidden pivot symbol(s):** CDS, VOUnit
- **gold patch file(s)** _(gold-derived)_: astropy/units/format/cds.py, astropy/units/format/cds_parsetab.py
- **hidden∩gold overlap** _(gold-derived)_: yes
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: live run(s): eval-capsulev2-recovered-live-astropy-14369
- **prior hidden-pivot engagement:** prior edited files: astropy/units/format/cds.py
- **scoring factors:** hidden pivot overlaps gold patch file (+3); hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2)
- **risk / uncertainty:** —
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

### django__django-11740

- **repo:** django/django
- **score:** 7  ·  **tier:** tier2
- **classification reason:** hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
- **source-anchored file(s)** _(derived: live_role_reason)_: —
- **hidden pivot file(s)** _(telemetry/live)_: django/db/migrations/autodetector.py, django/db/models/fields/related.py
- **hidden pivot symbol(s):** _get_dependencies_for_foreign_key, ForeignKey
- **gold patch file(s)** _(gold-derived)_: django/db/migrations/autodetector.py
- **hidden∩gold overlap** _(gold-derived)_: yes
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: live run(s): eval-11740, eval-capsulev2-auto-11740, eval-capsulev2-force--11740, eval-capsulev2-risk5-11740, eval-diagnostic-11740, eval-diagnostic-rerun-11740, eval-fixed-11740, eval-pivot-11740, eval-shaped-11740, eval-sized-11740
- **prior hidden-pivot engagement:** prior edited files: django/db/migrations/autodetector.py
- **scoring factors:** hidden pivot overlaps gold patch file (+3); hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2)
- **risk / uncertainty:** —
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-11740-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-11740` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-11740 \
  --run-label eval-pivot-telemetry-vtrace-django-11740-no-pivot-check \
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
  --instances django__django-11740 \
  --run-label eval-pivot-check-vtrace-django-11740 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-11820

- **repo:** django/django
- **score:** 7  ·  **tier:** tier2
- **classification reason:** hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
- **source-anchored file(s)** _(derived: live_role_reason)_: —
- **hidden pivot file(s)** _(telemetry/live)_: django/db/models/base.py, django/db/models/enums.py
- **hidden pivot symbol(s):** _check_ordering, ChoicesMeta
- **gold patch file(s)** _(gold-derived)_: django/db/models/base.py
- **hidden∩gold overlap** _(gold-derived)_: yes
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: live run(s): eval-capsulev2-literal-11820, eval-capsulev2-state-11820, eval-capsulev2-traversal-11820
- **prior hidden-pivot engagement:** prior edited files: django/db/models/base.py
- **scoring factors:** hidden pivot overlaps gold patch file (+3); hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2)
- **risk / uncertainty:** —
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

### django__django-12858

- **repo:** django/django
- **score:** 7  ·  **tier:** tier2
- **classification reason:** hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
- **source-anchored file(s)** _(derived: live_role_reason)_: —
- **hidden pivot file(s)** _(telemetry/live)_: django/db/models/base.py, django/db/models/fields/related.py
- **hidden pivot symbol(s):** _check_ordering, ForeignKey
- **gold patch file(s)** _(gold-derived)_: django/db/models/base.py
- **hidden∩gold overlap** _(gold-derived)_: yes
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: live run(s): eval-capsulev2-literal-12858
- **prior hidden-pivot engagement:** prior edited files: django/db/models/base.py
- **scoring factors:** hidden pivot overlaps gold patch file (+3); hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2)
- **risk / uncertainty:** —
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-12858-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-12858` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-12858 \
  --run-label eval-pivot-telemetry-vtrace-django-12858-no-pivot-check \
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
  --instances django__django-12858 \
  --run-label eval-pivot-check-vtrace-django-12858 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### sympy__sympy-16766

- **repo:** sympy/sympy
- **score:** 7  ·  **tier:** tier2
- **classification reason:** hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
- **source-anchored file(s)** _(derived: live_role_reason)_: —
- **hidden pivot file(s)** _(telemetry/live)_: sympy/printing/pycode.py, sympy/printing/printer.py
- **hidden pivot symbol(s):** PythonCodePrinter, _print
- **gold patch file(s)** _(gold-derived)_: sympy/printing/pycode.py
- **hidden∩gold overlap** _(gold-derived)_: yes
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: live run(s): eval-capsulev2-recovered-live-sympy-16766
- **prior hidden-pivot engagement:** prior edited files: sympy/printing/pycode.py
- **scoring factors:** hidden pivot overlaps gold patch file (+3); hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2)
- **risk / uncertainty:** —
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

## Rule-out / control candidates

### psf__requests-5414

- **repo:** psf/requests
- **score:** 7  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: live_role_reason)_: requests/models.py
- **hidden pivot file(s)** _(telemetry/live)_: requests/api.py
- **hidden pivot symbol(s):** get
- **gold patch file(s)** _(gold-derived)_: requests/models.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: live run(s): eval-capsulev2-recovered-live-requests-5414
- **prior hidden-pivot engagement:** prior edited files: requests/models.py
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2); prior live edited only source-anchored file (+1)
- **risk / uncertainty:** edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-requests-5414-no-pivot-check` (before) → `eval-pivot-check-vtrace-requests-5414` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-5414 \
  --run-label eval-pivot-telemetry-vtrace-requests-5414-no-pivot-check \
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
  --instances psf__requests-5414 \
  --run-label eval-pivot-check-vtrace-requests-5414 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### astropy__astropy-14598

- **repo:** astropy/astropy
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: astropy/io/fits/diff.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: astropy/io/fits/fitsrec.py
- **hidden pivot symbol(s):** FITS_rec
- **gold patch file(s)** _(gold-derived)_: astropy/io/fits/card.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-astropy-14598-no-pivot-check` (before) → `eval-pivot-check-vtrace-astropy-14598` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances astropy__astropy-14598 \
  --run-label eval-pivot-telemetry-vtrace-astropy-14598-no-pivot-check \
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
  --instances astropy__astropy-14598 \
  --run-label eval-pivot-check-vtrace-astropy-14598 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-11206

- **repo:** django/django
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: utils/formats.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: utils/html.py
- **hidden pivot symbol(s):** format_html
- **gold patch file(s)** _(gold-derived)_: django/utils/numberformat.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-11206-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-11206` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-11206 \
  --run-label eval-pivot-telemetry-vtrace-django-11206-no-pivot-check \
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
  --instances django__django-11206 \
  --run-label eval-pivot-check-vtrace-django-11206 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-11815

- **repo:** django/django
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: db/migrations/serializer.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: db/migrations/autodetector.py
- **hidden pivot symbol(s):** deep_deconstruct
- **gold patch file(s)** _(gold-derived)_: django/db/migrations/serializer.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-11815-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-11815` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-11815 \
  --run-label eval-pivot-telemetry-vtrace-django-11815-no-pivot-check \
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
  --instances django__django-11815 \
  --run-label eval-pivot-check-vtrace-django-11815 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-12273

- **repo:** django/django
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: forms/models.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: db/models/base.py
- **hidden pivot symbol(s):** save
- **gold patch file(s)** _(gold-derived)_: django/db/models/base.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-12273-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-12273` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-12273 \
  --run-label eval-pivot-telemetry-vtrace-django-12273-no-pivot-check \
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
  --instances django__django-12273 \
  --run-label eval-pivot-check-vtrace-django-12273 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-13012

- **repo:** django/django
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: db/models/expressions.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: contrib/postgres/aggregates/mixins.py
- **hidden pivot symbol(s):** set_source_expressions
- **gold patch file(s)** _(gold-derived)_: django/db/models/expressions.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-13012-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-13012` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-13012 \
  --run-label eval-pivot-telemetry-vtrace-django-13012-no-pivot-check \
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
  --instances django__django-13012 \
  --run-label eval-pivot-check-vtrace-django-13012 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-13112

- **repo:** django/django
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: db/models/fields/related.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: contrib/admin/utils.py
- **hidden pivot symbol(s):** FieldIsAForeignKeyColumnName
- **gold patch file(s)** _(gold-derived)_: django/db/models/fields/related.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-13112-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-13112` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-13112 \
  --run-label eval-pivot-telemetry-vtrace-django-13112-no-pivot-check \
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
  --instances django__django-13112 \
  --run-label eval-pivot-check-vtrace-django-13112 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-13195

- **repo:** django/django
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: http/response.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: contrib/sessions/backends/signed_cookies.py
- **hidden pivot symbol(s):** delete
- **gold patch file(s)** _(gold-derived)_: django/contrib/messages/storage/cookie.py, django/contrib/sessions/middleware.py, django/http/response.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-13195-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-13195` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-13195 \
  --run-label eval-pivot-telemetry-vtrace-django-13195-no-pivot-check \
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
  --instances django__django-13195 \
  --run-label eval-pivot-check-vtrace-django-13195 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### pallets__flask-5014

- **repo:** pallets/flask
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: src/flask/blueprints.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: src/flask/app.py
- **hidden pivot symbol(s):** name
- **gold patch file(s)** _(gold-derived)_: src/flask/blueprints.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-flask-5014-no-pivot-check` (before) → `eval-pivot-check-vtrace-flask-5014` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances pallets__flask-5014 \
  --run-label eval-pivot-telemetry-vtrace-flask-5014-no-pivot-check \
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
  --instances pallets__flask-5014 \
  --run-label eval-pivot-check-vtrace-flask-5014 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### psf__requests-1724

- **repo:** psf/requests
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: requests/utils.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: requests/packages/urllib3/exceptions.py
- **hidden pivot symbol(s):** DecodeError
- **gold patch file(s)** _(gold-derived)_: requests/sessions.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-requests-1724-no-pivot-check` (before) → `eval-pivot-check-vtrace-requests-1724` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances psf__requests-1724 \
  --run-label eval-pivot-telemetry-vtrace-requests-1724-no-pivot-check \
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
  --instances psf__requests-1724 \
  --run-label eval-pivot-check-vtrace-requests-1724 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### pydata__xarray-3677

- **repo:** pydata/xarray
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: xarray/core/dataset.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: xarray/core/merge.py
- **hidden pivot symbol(s):** merge
- **gold patch file(s)** _(gold-derived)_: xarray/core/dataset.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-xarray-3677-no-pivot-check` (before) → `eval-pivot-check-vtrace-xarray-3677` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances pydata__xarray-3677 \
  --run-label eval-pivot-telemetry-vtrace-xarray-3677-no-pivot-check \
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
  --instances pydata__xarray-3677 \
  --run-label eval-pivot-check-vtrace-xarray-3677 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### scikit-learn__scikit-learn-10844

- **repo:** scikit-learn/scikit-learn
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: sklearn/metrics/cluster/supervised.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: sklearn/exceptions.py
- **hidden pivot symbol(s):** FitFailedWarning
- **gold patch file(s)** _(gold-derived)_: sklearn/metrics/cluster/supervised.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-scikit-learn-10844-no-pivot-check` (before) → `eval-pivot-check-vtrace-scikit-learn-10844` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances scikit-learn__scikit-learn-10844 \
  --run-label eval-pivot-telemetry-vtrace-scikit-learn-10844-no-pivot-check \
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
  --instances scikit-learn__scikit-learn-10844 \
  --run-label eval-pivot-check-vtrace-scikit-learn-10844 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### sympy__sympy-12419

- **repo:** sympy/sympy
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: sympy/matrices/expressions/matexpr.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: sympy/assumptions/handlers/matrices.py
- **hidden pivot symbol(s):** ZeroMatrix
- **gold patch file(s)** _(gold-derived)_: sympy/matrices/expressions/matexpr.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-sympy-12419-no-pivot-check` (before) → `eval-pivot-check-vtrace-sympy-12419` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-12419 \
  --run-label eval-pivot-telemetry-vtrace-sympy-12419-no-pivot-check \
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
  --instances sympy__sympy-12419 \
  --run-label eval-pivot-check-vtrace-sympy-12419 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### sympy__sympy-15599

- **repo:** sympy/sympy
- **score:** 6  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: deterministic_rank_proxy)_: sympy/core/mod.py
- **hidden pivot file(s)** _(telemetry/deterministic)_: sympy/polys/agca/modules.py
- **hidden pivot symbol(s):** Module
- **gold patch file(s)** _(gold-derived)_: sympy/core/mod.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: none
- **prior hidden-pivot engagement:** unknown
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2)
- **risk / uncertainty:** anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build; pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots; edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-sympy-15599-no-pivot-check` (before) → `eval-pivot-check-vtrace-sympy-15599` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances sympy__sympy-15599 \
  --run-label eval-pivot-telemetry-vtrace-sympy-15599-no-pivot-check \
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
  --instances sympy__sympy-15599 \
  --run-label eval-pivot-check-vtrace-sympy-15599 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### django__django-10880

- **repo:** django/django
- **score:** 4  ·  **tier:** ruleout
- **classification reason:** hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion
- **source-anchored file(s)** _(derived: live_role_reason)_: —
- **hidden pivot file(s)** _(telemetry/live)_: django/db/models/query.py, django/db/models/functions/comparison.py
- **hidden pivot symbol(s):** count, Least
- **gold patch file(s)** _(gold-derived)_: django/db/models/aggregates.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: unknown
- **prior live status** _(telemetry)_: live run(s): eval-10880, eval-capsulev2-auto-10880, eval-capsulev2-force--10880, eval-capsulev2-risk5-10880, eval-diagnostic-10880, eval-fixed-10880, eval-shaped-10880, eval-sized-10880
- **prior hidden-pivot engagement:** prior edited files: django/db/models/aggregates.py
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2)
- **risk / uncertainty:** edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior
- **recommended run labels:** `eval-pivot-telemetry-vtrace-django-10880-no-pivot-check` (before) → `eval-pivot-check-vtrace-django-10880` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances django__django-10880 \
  --run-label eval-pivot-telemetry-vtrace-django-10880-no-pivot-check \
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
  --instances django__django-10880 \
  --run-label eval-pivot-check-vtrace-django-10880 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

### mwaskom__seaborn-3187

- **repo:** mwaskom/seaborn
- **score:** 4  ·  **tier:** ruleout
- **classification reason:** curated as not edit-relevant (reproduction/context only) — overhead/rule-out control
- **source-anchored file(s)** _(derived: live_role_reason)_: seaborn/_core/scales.py
- **hidden pivot file(s)** _(telemetry/live)_: seaborn/relational.py
- **hidden pivot symbol(s):** scatterplot
- **gold patch file(s)** _(gold-derived)_: seaborn/_core/scales.py, seaborn/utils.py
- **hidden∩gold overlap** _(gold-derived)_: no
- **curated edit-relevant** _(curated)_: no (not_actually_edit_relevant)
- **prior live status** _(telemetry)_: live run(s): eval-pivot-check-vtrace-seaborn-3187, eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check
- **prior hidden-pivot engagement:** curated: not_actually_edit_relevant
- **scoring factors:** hidden pivot is not issue/source anchored (+2); capsule has >= 2 pivots (+2); obvious source-anchored pivot differs from hidden pivot (+2); prior live edited only source-anchored file (+1); hidden pivot is example/test-only or reproduction-only (-3)
- **risk / uncertainty:** —
- **recommended run labels:** `eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check` (before) → `eval-pivot-check-vtrace-seaborn-3187` (after)

Exact commands to run later (not executed here):

```bash
# before: PIVOT_CHECK disabled
rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl

bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances mwaskom__seaborn-3187 \
  --run-label eval-pivot-telemetry-vtrace-seaborn-3187-no-pivot-check \
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
  --instances mwaskom__seaborn-3187 \
  --run-label eval-pivot-check-vtrace-seaborn-3187 \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

## Rejected candidates

| instance | repo | score | reason |
| --- | --- | ---: | --- |
| django__django-11095 | django/django | 5 | single-pivot capsule (no multi-pivot localization) |
| django__django-11490 | django/django | 5 | single-pivot capsule (no multi-pivot localization) |
| django__django-11728 | django/django | 5 | single-pivot capsule (no multi-pivot localization) |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | 2 | single-pivot capsule (no multi-pivot localization) |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | 2 | single-pivot capsule (no multi-pivot localization) |
| sphinx-doc__sphinx-9230 | sphinx-doc/sphinx | 2 | retrieval failure — gold file not surfaced by the capsule |
| astropy__astropy-14365 | astropy/astropy | -5 | no hidden (non-source-anchored) pivot |
| astropy__astropy-14539 | astropy/astropy | -5 | no hidden (non-source-anchored) pivot |
| django__django-10973 | django/django | -5 | no hidden (non-source-anchored) pivot |
| django__django-11133 | django/django | -5 | no hidden (non-source-anchored) pivot |
| django__django-11749 | django/django | -5 | no hidden (non-source-anchored) pivot |
| django__django-12050 | django/django | -5 | no hidden (non-source-anchored) pivot |
| django__django-12276 | django/django | -5 | no hidden (non-source-anchored) pivot |
| django__django-12325 | django/django | -5 | no hidden (non-source-anchored) pivot |
| django__django-12774 | django/django | -5 | no hidden (non-source-anchored) pivot |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | -5 | no hidden (non-source-anchored) pivot |
| psf__requests-1142 | psf/requests | -5 | no hidden (non-source-anchored) pivot |
| pydata__xarray-2905 | pydata/xarray | -5 | no hidden (non-source-anchored) pivot |
| pytest-dev__pytest-10051 | pytest-dev/pytest | -5 | no hidden (non-source-anchored) pivot |
| pytest-dev__pytest-5262 | pytest-dev/pytest | -5 | no hidden (non-source-anchored) pivot |
| pytest-dev__pytest-7432 | pytest-dev/pytest | -5 | no hidden (non-source-anchored) pivot |
| scikit-learn__scikit-learn-11578 | scikit-learn/scikit-learn | -5 | no hidden (non-source-anchored) pivot |
| sphinx-doc__sphinx-7748 | sphinx-doc/sphinx | -5 | no hidden (non-source-anchored) pivot |
| sympy__sympy-12481 | sympy/sympy | -5 | no hidden (non-source-anchored) pivot |
| matplotlib__matplotlib-24970 | matplotlib/matplotlib | -9 | no hidden (non-source-anchored) pivot |
| pylint-dev__pylint-8898 | pylint-dev/pylint | -9 | no hidden (non-source-anchored) pivot |
| sphinx-doc__sphinx-7910 | sphinx-doc/sphinx | -9 | no hidden (non-source-anchored) pivot |

## Known limitations

- The deterministic retrieval capsule and the live injected capsule differ (the live build uses a failing-test signal). Deterministic-only candidates therefore carry an anchored/hidden RANK PROXY, not a confirmed split — a cheap live capsule build should confirm the hidden pivot before any agent run.
- Gold `expected_files` is an evaluation label; a hidden∩gold overlap means the file is in the gold patch, not that the specific symbol must change.
- Prior-engagement signals are coarse (curated classification or prior edited-file set), not a re-derivation of every prior run's tool log.

## Recommended next live runs

In priority order (Tier 1 first, then by score). Run the before/after pair per candidate:

1. **sphinx-doc__sphinx-7462** (tier1, score 11) — hidden pivot is gold-relevant and distinct from the source-anchored file, split confirmed by the live capsule (sphinx-7462 shape)
1. **sympy__sympy-13372** (tier2, score 9) — hidden pivot overlaps gold and looks distinct from the anchor, but the split is a deterministic rank proxy — confirm with a live capsule build before promoting
1. **astropy__astropy-14369** (tier2, score 7) — hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
1. **django__django-11740** (tier2, score 7) — hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
1. **django__django-11820** (tier2, score 7) — hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
1. **django__django-12858** (tier2, score 7) — hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible
1. **sympy__sympy-16766** (tier2, score 7) — hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible

## Non-claims

- This report does not run agents.
- This report does not evaluate Docker resolution.
- This report does not prove PIVOT_CHECK improves patch quality.
- This report does not claim candidates are guaranteed edit-relevant.
- This report only ranks candidates for targeted future validation.

