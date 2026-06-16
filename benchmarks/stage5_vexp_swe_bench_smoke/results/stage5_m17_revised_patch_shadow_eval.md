# Stage 5 — M17 read-only shadow evaluation of pivot-revision revised patches

M17 adds a safe, **read-only** way to answer the question M16.1 left open: *would the
revised patch (`_pivot_revision_revised.patch`) pass Docker evaluation if it were evaluated
on its own?* The revised patch is **never** wired into canonical evaluation (canonical Docker
still evaluates the original first-pass `modelPatch`); the shadow path evaluates a **copy** of
the canonical row with the model patch swapped, and proves it left canonical artifacts
untouched.

## What was added

- **Mode** `--mode evaluate-revised-patch` (with `--eval-mode docker`). Exact command:
  ```
  bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
    --mode evaluate-revised-patch --eval-mode docker \
    --vexp-swe-bench-dir "$VEXP" --run-label "<label>" --out "$OUT"
  ```
- **Pure core** `benchmarks/stage5_vexp_swe_bench_smoke/revisedPatchShadowEval.ts`
  (`prepareRevisedShadowEval` / `classifyShadowEval` / `skipReasonToClassification`,
  imports only `node:crypto`). Decides whether a revised patch is worth a shadow run and
  builds the eval-source JSONL (canonical row, model patch swapped to the revised patch,
  `resolved` reset). Refuses empty / identical / missing revised patches.
- **Orchestrator** `runEvaluateRevisedPatch` in the runner: writes a distinctly-named shadow
  JSONL (`_pivot_revision_shadow.jsonl`, which deliberately does **not** match
  `swebench-*.jsonl`), runs the external evaluator on THAT copy, reads back `resolved`, and
  persists `_pivot_revision_shadow_eval.meta.json`. It hashes the canonical artifacts
  (canonical JSONL, `_eval.meta.json`, `_pivot_revision.json`, `_pivot_revision_original.patch`,
  `_pivot_revision_revised.patch`) **before and after** and records `canonicalArtifactsUntouched`.

## How canonical artifacts are protected

1. The evaluator is pointed at the shadow JSONL copy, never the canonical `swebench-*.jsonl`.
2. The shadow file names cannot be mistaken for canonical results by ingest/report.
3. A before/after SHA-256 over the canonical artifact set asserts byte-identity; verified
   `true` for all three runs (and re-confirmed on disk: canonical rows and `_eval.meta.json`
   resolvedCount unchanged — sphinx r1=False/0, sphinx r2=False/0, seaborn r2=True/1).

## Executive verdict

**`revision_shadow_eval_partial`** — the shadow-eval capability works end-to-end and yields a
concrete, important finding: **sphinx r2's revised patch RESOLVES** in Docker where the
original first-pass patch did not (`shadow_resolution_success`). sphinx r1's revised patch
does not resolve (`shadow_no_effect`); seaborn r2 is correctly skipped (revised == original).
No harm in any case.

## Per-run results

| source label | original canonical resolved | original patch files / hash | revised patch files / hash | shadow revised resolved | shadow status | canonical untouched? | classification |
|---|---|---|---|---|---|---|---|
| eval-m16-ruleout-guard-current-sphinx-7462-r1 | False | sphinx/domains/python.py / `ec96de0e3a8ae856` | sphinx/domains/python.py, **sphinx/pycode/ast.py** / `b4032c35647c3b62` | **False** | evaluated (docker) | ✅ true | `shadow_no_effect` |
| eval-m16-ruleout-guard-current-sphinx-7462-r2 | False | sphinx/domains/python.py / `6aca9946519543a6` | sphinx/domains/python.py, **sphinx/pycode/ast.py** / `f2362cbd9bc4b33d` | **True** | evaluated (docker) | ✅ true | **`shadow_resolution_success`** |
| eval-m16-ruleout-guard-current-seaborn-3187-r2 | True | seaborn/_core/scales.py, seaborn/utils.py / `a526566d3e197286` | (identical) / `a526566d3e197286` | n/a | skipped (`identical_revised_patch`) | ✅ true | `shadow_skipped_empty_or_identical` |

(`failToPassResult` / `passToPassResult` are `unknown` for the evaluated runs: the external
evaluator records `resolved` in-place in the JSONL but writes per-bucket `tests_status` only
to its own report.json, not the row — `resolved` is the authoritative signal here.)

## Behavior analysis

- **Did the revised patch resolve sphinx?** **Yes for r2** — the revised patch that the M16
  guardrail forced (adding the gold `sphinx/pycode/ast.py::unparse` empty-`ast.Tuple` → `"()"`
  hunk) **resolves** the instance under Docker, while the original first-pass patch
  (python.py only) does not. This is the first measured resolution gain from the whole
  M14→M15→M16 revision chain. **No for r1** — r1's revised patch (same two files, reached via
  the `unclear` path) does not resolve, so the revision is not yet uniformly correct.
- **Any harm / over-edit?** None. seaborn (originally resolved) was correctly skipped because
  its revised patch was byte-identical to the original, so there was no risk of regressing a
  passing instance. No canonical artifact was modified in any run.
- **Shadow resolution effect** — sphinx r2: original unresolved → revised **resolved** (a real
  gain, measured in a read-only shadow run, NOT wired into canonical resolution).

## Next recommendation

The revised patch can genuinely flip an unresolved instance to resolved (sphinx r2), but not
reliably yet (sphinx r1 no-effect). Before considering wiring revision into canonical
evaluation, gather a slightly larger read-only shadow sample (the existing M14/M15/M16 labels
with non-empty, non-identical revised patches) to estimate the resolution-gain vs. no-effect
rate. Do not change scoring/ranking/retrieval, and keep the revision pass opt-in and shadow
eval read-only until that rate is understood. No 30/100 sweep warranted yet.

---

*Method note: shadow evaluation is read-only by construction (separate eval-source copy +
before/after canonical hash check). The revised patch is **not** wired into canonical
evaluation; canonical first-pass resolution figures are unchanged (sphinx r1=0, sphinx r2=0,
seaborn r2=1). The resolution figures in the per-run table for the revised patches come from
the **shadow** Docker run only.*
