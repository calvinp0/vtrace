# Stage 5 — M36.1: Rendering-only toggle for the Multi-Pivot Action Plan

No live agents, no Docker, no SWE-bench evaluation, no M36 run. This milestone adds a
single rendering-only env toggle so the M35 Multi-Pivot Action Plan can be suppressed
for the M36 A/B control arm, and proves the suppression changes nothing but the
rendered action-plan text.

## 1. Executive verdict

**Done.** `VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0` (also `false` / `off`, any case,
trimmed) suppresses the `## Multi-Pivot Action Plan` section; unset or any truthy value
preserves the M35 default. The toggle gates exactly one call —
`buildMultiPivotActionPlan(...)` / `renderMultiPivotActionPlanText(...)` in
`renderCapsuleV2Human` — and nothing else. Retrieval/ranking/candidate/pivot/co-edit
outputs are unchanged: the deterministic retrieval eval is byte-identical, and a render
diff shows the only difference between arms is the action-plan section. The M36 live
A/B can now run old-vs-M35 in one binary by flipping this env var.

## 2. Toggle behavior

| `VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN` | action plan |
| --- | --- |
| unset | **renders** (M35 default) |
| `0`, `false`, `off` (case-insensitive, trimmed) | **suppressed** |
| `1`, `true`, `on`, `yes`, any other value, `""` | renders |

Implementation:
- `src/capsuleV2/multiPivotActionPlan.ts` — `multiPivotActionPlanEnabled(env = process.env)`:
  returns `true` unless the env value normalizes to `0`/`false`/`off`. Env is read
  through an injectable map so tests need no `process.env` mutation. Mirrors the style
  of the existing `VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP` toggle, but for rendering and
  default-ON (the traceback toggle is default-OFF).
- `src/capsuleV2/renderHuman.ts` — `renderCapsuleV2Human(result, options?)` gains an
  optional `RenderCapsuleV2HumanOptions { enableMultiPivotActionPlan?: boolean }`. The
  gate is `options?.enableMultiPivotActionPlan ?? multiPivotActionPlanEnabled()`. All
  existing single-arg callers (harness line 4246, CLI, tests) are unchanged and read the
  env by default, so the production Stage-5 path honors the toggle automatically.

## 3. Rendering-only proof

The gate wraps ONLY the action-plan build/render block. It does not touch — and the code
path does not reach — retrieval candidates, ranking, capsule pivots, co-edit hint
computation, logic flow, impact graph, the manifest, or scoring. The pivot list passed to
the renderer is identical; the render does not mutate it.

A render diff over a multi-pivot fixture (test
`toggle: disabling changes ONLY the action plan — pivots/sections are unchanged`):
stripping the leading `## Multi-Pivot Action Plan` block from the enabled output yields a
string **byte-identical** to the disabled output. Both outputs still contain every pivot
block (`● pivot pkg/surface.py`, `● pivot pkg/rootcause.py`) and the other multi-pivot
sections (`## Multiple edit targets`, pivot inspection contract). The result object's
`pivots` array is unchanged across the call (asserted by deep-equal before/after).

Accounting reflects the toggle with no new struct field: when the section is suppressed,
the rendered snapshot carries no `## Multi-Pivot Action Plan` heading, so the M34
`multiPivotActionPlanTokens` component is attributed `0` (a snapshot WITH the section
attributes a positive count). This is the "rendered: false" signal without risking any
existing JSON consumer — `ProductV2Accounting` is unchanged from M35 (additive field
already present). `m34_accounting.test.ts` test "3c" asserts both the present (>0) and
absent (0) cases.

## 4. Tests / verification

New tests (all isolated; env-mutating render tests save/restore via a `withEnv` finally):

- `src/capsuleV2/multiPivotActionPlan.test.ts` — env helper: unset → enabled;
  `0`/`false`/`off`/`FALSE`/`Off`/`  0 `/`OFF` → disabled; `1`/`true`/`on`/`yes`/
  `enabled`/`""` → enabled.
- `src/capsuleV2/renderHuman.test.ts` — render gating: default (unset env) renders;
  option `false` suppresses; env `0`/`false`/`off` suppress; truthy env preserves;
  single-pivot omits regardless of env; disabling changes only the action-plan section
  (pivots/sections unchanged, result not mutated).

Results:
- `bun run typecheck` — clean.
- `bun run typecheck:benchmarks` — clean.
- `bun test` — **2930 pass / 0 fail** (174 files; +9 over the M35 baseline of 2921).
- `git diff --check` — clean.

## 5. Retrieval no-change proof

Deterministic retrieval evals re-run into a temp dir and diffed against the committed
working-copy baselines:

- `stage5_retrieval_eval_expanded.csv` — **BYTE-IDENTICAL**
- `stage5_retrieval_eval_cross_repo_30.csv` — **BYTE-IDENTICAL**

Candidate generation and ranking are untouched, as expected for a rendering-only gate.

## 6. Next recommendation

Run the **M36 live A/B only after explicit approval** (control:
`VTRACE_ENABLE_MULTI_PIVOT_ACTION_PLAN=0` vs treatment: default), per
`stage5_m36_live_ab_plan.md` — sequential protocol runs on `sphinx-doc__sphinx-7462` and
`mwaskom__seaborn-3187`, no revision, no diagnostic verifier, canonical Docker eval only
after the protocol runs. **Do not investigate the seaborn co-edit ranking until after
M36**, unless M36 is cancelled.
