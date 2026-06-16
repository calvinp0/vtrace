# Stage 5 — M15 Revision Prompt Evidence: Offline Audit

Audit of the improved pivot-revision prompt + first-pass decision observability
over the captured M14.1 runs. No live agents, no Docker, no model calls. It shows
what the NEW code path renders and how first-pass PIVOT_DECISION markers would
change the trigger — it does not re-run the agents.

## What changed (rendering, verified here)

1. **First-pass assistant text** is now persisted (`_pivot_first_pass_assistant.txt`)
   before the revision phase, and its PIVOT_DECISION markers feed the BEFORE verdict.
2. **Enforcement block** now requests machine-readable `PIVOT_DECISION` markers
   (gated to `--pivot-inspection-enforcement`; absent from baseline/advisory paths).
3. **Revision prompt** now carries a `## Test expectation` section (FAIL_TO_PASS,
   else a problem-statement excerpt) plus bounded source excerpts, and asks for a
   non-empty diff only when evidence requires it (else a PIVOT_DECISION rule-out).

> The captured M14.1 runs PREDATE marker instructions, so none carries a first-pass
> marker. New-trigger columns therefore show what the NEXT live run will observe,
> demonstrated by recomputing the M13 checker with a grounded marker; they are not
> claims about the old runs.

## Per-run audit

| case | label | 1st-pass text? | 1st-pass markers? | FAIL_TO_PASS avail? | old prompt had test-exp? | new prompt has test-exp? | old trigger | new trigger (w/ grounded marker) | false trigger suppressed? |
|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | sphinx-7462-r1 | no | no | instance_metadata (2 tests) | no | yes | fires (1 outstanding) | fires → 2nd pass should EDIT (test expectation now provided) | no — pivot is gold-required (edit it, do not rule it out) |
| sphinx-7462 | sphinx-7462-r2 | no | no | instance_metadata (2 tests) | no | yes | fires (1 outstanding) | fires → 2nd pass should EDIT (test expectation now provided) | no — pivot is gold-required (edit it, do not rule it out) |
| sphinx-7462 | sphinx-7462-r3 | no | no | instance_metadata (2 tests) | no | yes | fires (1 outstanding) | fires → 2nd pass should EDIT (test expectation now provided) | no — pivot is gold-required (edit it, do not rule it out) |
| seaborn-3187 | seaborn-3187-r1 | no | no | instance_metadata (2 tests) | no | yes | fires (1 outstanding) | suppressed (0 outstanding) | yes |
| seaborn-3187 | seaborn-3187-r2 | no | no | instance_metadata (2 tests) | no | yes | fires (1 outstanding) | suppressed (0 outstanding) | yes |
| seaborn-3187 | seaborn-3187-r3 | no | no | instance_metadata (2 tests) | no | yes | fires (1 outstanding) | suppressed (0 outstanding) | yes |
| django-13195 | django-13195-r1 | no | no | instance_metadata (5 tests) | no | yes | no fire (patch already compliant) | no fire (patch already compliant) | n/a |

## Expected live effect / risk

| case | expected live effect | risk |
|---|---|---|
| sphinx-7462 | second pass now sees the failing-test expectation → should EDIT the gold-required pivot instead of ruling it out | low — bounded excerpts; conservative replacement keeps a no-op safe |
| seaborn-3187 | first pass can emit a grounded rule-out → false trigger suppressed; no wasted second pass | low — suppression only on source-grounded marker; generic stays unclear |
| django-13195 | compliant first pass → revision still does not trigger | low — suppression only on source-grounded marker; generic stays unclear |

## Interpretation

- **sphinx-7462** (`ast.py::unparse` IS gold-required): the new prompt now feeds the
  FAIL_TO_PASS test `test_pycode_ast.py::test_unparse[()-()]`, which expects the
  output `()` for an empty tuple. This directly contradicts the M14.1 wrong rule-out
  ("join is empty-safe") — the second pass should now EDIT ast.py rather than rule it
  out. A grounded RULED_OUT marker here would be wrong, so the trigger is NOT
  suppressed; the lever is the test expectation, not marker suppression.
- **seaborn-3187** (`relational.py::scatterplot` is NOT gold-required): the first pass
  can now emit a grounded `PIVOT_DECISION: RULED_OUT` for scatterplot, which the M13
  checker credits as `ruledOut` — recomputed here, the outstanding count drops to 0
  and the false trigger is SUPPRESSED, avoiding a wasted second pass on a resolved run.
- **django-13195** (compliant): the first pass edits all required candidates, so the
  revision pass does not trigger; the test expectation / marker changes do not apply.

## Bounds / safety (unchanged)

- Source excerpts bounded: ≤3 candidates, ≤12 lines, ≤2 bullets (never whole files).
- Replacement stays conservative (revised must strictly reduce outstanding + be a real
  diff). Marker suppression only credits a `ruledOut` when evidence is source-grounded;
  a generic "not needed" stays `unclear`. Opt-in only; not default; no canonical wiring.
