# M161 — benchmark-authored policy blocks, captured known positive

Extracted verbatim from the FIRST M161 smoke run's injected snapshot
(`sphinx-doc__sphinx-9281`, superseded), which ran before the treatment was
narrowed to evidence only. It exists so the harness control's claim that these
blocks are absent under the frozen flags is a **suppression** and not a broken
detector (M161 §122/§123).

All four blocks below are authored in
`benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts` —
the benchmark runner, not `src/`. `EDIT_GUARD` and `PATCH_VERIFY` reference
nothing from the capsule at all.

    full snapshot bytes   14765
    policy block bytes    2516 (17%)
    full snapshot sha256  1a80aa686437d41da247a6359cea9b4a4c775d9543a0e5144651e3dbc82c608a
    policy blocks sha256  548ac3814a799d29d437861074336daa356ec80710639e177d10dd496ba267ff

---

## PIVOT_CHECK

Before editing, directly inspect every pivot path listed below. Direct inspection means Read, open, view, or equivalent file-content access. Search/Grep does NOT count as inspection.

Account for every pivot in the checklist below. You may rule out a pivot only after directly inspecting it. Do not edit every pivot — the smallest correct patch is still preferred.

Some pivots below were not named directly by the traceback/problem path. They were surfaced by VTRACE via symbol, graph, literal, or test evidence. Do not finalize edits until these pivots have been directly inspected or ruled out with source-based reasoning.

| pivot | symbol | inspected | relevant | edit_needed | reason |
|---|---|---:|---:|---:|---|
| sphinx/directives/__init__.py | get_signatures | yes/no | yes/no | yes/no | ... |
| sphinx/ext/autodoc/__init__.py | get_overloaded_signatures | yes/no | yes/no | yes/no | ... |

neighborhood_use: 8 pivot-neighborhood excerpt(s) were provided above. State which you used and which you ruled out; ground each rule-out in source you inspected.

## EDIT_GUARD

Good context is not enough: most failures here are bad edits made after correct retrieval. Before editing any file, write a short edit plan:

- SCOPE: name the exact enclosing class/function/module that will receive the edit; read its boundary before inserting any method/helper.
- FAILING BEHAVIOR: state the concrete failing input, exception, assertion, or behavior from the issue/test that the patch must directly handle.
- MINIMAL FIX: prefer the smallest additive guard/branch/validation; avoid broad control-flow rewrites unless the issue requires them.
- RULED OUT: name one nearby plausible edit you are NOT making, and why.

Then apply the patch and run the narrowest relevant test/check available.

## PATCH_VERIFY

Before finalizing the patch, check:
- SCOPE LANDED: the edit landed in the intended enclosing class/function/module.
- FAILING BEHAVIOR HANDLED: the patch directly handles the concrete failing input/assertion/exception.
- MINIMALITY: the change is additive/minimal unless a broader rewrite is explicitly justified.
- CHECK RUN: a narrow relevant test/reproduction/check was run, or the reason it could not be run is stated.
- RISK: name the remaining risk if the check did not prove the fix.
If any item fails, revise the patch before finalizing.

## Instruction

Use the vtrace context above to orient before broad search. It may be incomplete; verify with local files/tests before editing.

