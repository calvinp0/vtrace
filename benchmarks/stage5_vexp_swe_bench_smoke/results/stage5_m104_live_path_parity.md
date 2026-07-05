# Stage 5 M104 Live-Path Structured Task Parity

Date: 2026-07-05. NO live agents, NO Docker, NO API spend, NO baselines, NO
V4/C7_D, NO Conda mutation. The only subprocess run was the local
`vtrace capsule` CLI over the pre-existing M103 clean indexed workspaces.

## Summary

- **Change made**: the live Stage 5 v2 task builder (`buildCapsuleV2Task` in
  `run_stage5_vexp_swe_bench_smoke.ts`) now returns
  `deriveStructuredTaskFromProblemStatement(problemStatement).taskText` — the
  SHARED M103 module — instead of composing its own full-problem task.
- **Live task path before**: `instance:`/`repo:` header + FULL
  problem_statement + `failing tests: <FAIL_TO_PASS>` + `hints: <hints_text>`,
  capped at 8000 chars. Hidden FAIL_TO_PASS labels contaminated the retrieval
  query, and its tail would echo into model-visible context under opt-in
  `--inject-capsule-digest`.
- **Live task path after**: byte-identical to the deterministic M103
  derivation (V0 base + exceptions ≤6 + failing-test ids ≤6 + traceback frames
  ≤8, 1200-char cap; V5 parity caps preserved by construction — the shared
  module is untouched). No header, no full problem, no FAIL_TO_PASS, no hints.
- **Leakage result**: 0 leaks. Task text: 0 hits on all 14 smoke cases.
  Assembled model-visible context: 7 raw string coincidences, ALL proven
  base-commit repo content (retrieved evidence), 0 unexplained; no
  FAIL_TO_PASS/PASS_TO_PASS ids, no gold-patch text, no scoring markers, no
  full problem statement.
- **Verdict**: **PASS**.
- **Recommendation**: **proceed to M105 small live confirmation**.

## Pre-change Live Path Audit

(Full audit: `stage5_m104_live_path_parity_plan.md`.)

- **buildCapsuleV2Task path**: `capsuleQueryTextFor` → v2 (default) →
  `buildCapsuleV2Task` → the full-problem composite above → passed to
  `vtrace capsule <ws> <task> --intent auto --budget 8000 --pivot-neighborhood
  --json` and to the `run-pipeline` accounting probe. The live runner never
  calls `buildCapsuleV2` in-process.
- **Model-visible vs metadata fields**: model-visible =
  `_vtrace_instructions.md` only (instance id/repo/base_commit header +
  capsule render + guard blocks; the problem statement is deliberately never
  repeated there — the agent receives the issue from the external vexp
  harness, identically in both arms). Metadata-only: FAIL_TO_PASS (cost-gate
  signals, evaluate parsing, revision DISALLOW evidence), PASS_TO_PASS + gold
  patch (evaluate mode only — never loaded into `SweBenchInstance`).
- **FAIL_TO_PASS handling**: leaked into the RETRIEVAL query (always) and into
  the digest-header echo (only under opt-in `--inject-capsule-digest`,
  default-off, not part of the canonical protocol command). Not present in the
  default injected markdown.
- **Risk assessment**: primary defect = live retrieval ran on evidence
  (full problem + hidden test labels + hints) the M103 deterministic
  measurement never saw — any M105 result would have been unattributable and
  test-label-contaminated. Secondary = the conditional digest echo.

## Implementation

- **Files changed**:
  - `run_stage5_vexp_swe_bench_smoke.ts` — `buildCapsuleV2Task` rewritten to
    delegate to the shared helper (+ import). The 8000-char argv cap is kept
    as an inert safety net (structured cap is 1200).
  - `run_stage5_vexp_swe_bench_smoke.test.ts` — the test pinning the old
    composite rewritten to pin the NEW contract; two new tests (full-problem
    never used as task incl. PASS_TO_PASS/patch-bearing records; assembled
    model-visible markdown excludes FAIL_TO_PASS/hints).
  - `run_stage5_m104_live_context_smoke.ts` (NEW) — no-agent smoke helper.
  - `run_stage5_m104_live_context_smoke.test.ts` (NEW) — unit tests for the
    leak-scan/provenance primitives + psf-5414-style provenance fixture.
- **Shared helper routing**: live task = `deriveStructuredTaskFromProblemStatement(...).taskText`,
  the exact function the M103 scoreboard and fixture builder call. No second
  derivation exists on the live path anymore.
- **Sanitization/leakage guard**: FAIL_TO_PASS/hints/full problem no longer
  enter the task, so every downstream echo surface (retrieval, digest header,
  evidence reasons quoting task terms) is issue-authored by construction.
  `SweBenchInstance` still carries `failToPass` for harness metadata (cost
  gate, evaluate parsing) — proven not injected (smoke + unit test).
- **Diagnostics added**: the smoke emits per-case `problem_statement_hash`,
  `structured_task_hash`, `structured_task_chars`/`est_tokens`,
  `exception_count`, `failing_test_count`, `traceback_frame_count`,
  `uses_shared_derivation`, `model_visible_fail_to_pass_present`,
  `model_visible_gold_patch_present`, `model_visible_full_problem_present`,
  `issue_authored_gold_path_count`, `gold_patch_leak_block_count`, gate
  action/reason, lead pivot + M103 agreement.
- **Why deterministic behavior is unchanged**: `stage5_task_derivation.ts`,
  `build_stage5_retrieval_fixture.ts`, both retrieval fixtures, and all of
  `src/` are byte-untouched (`git diff` empty on those paths). The change is
  live-runner-only routing. Baseline freshness: `generated_at_commit` =
  `199769f` = HEAD, `git diff 199769f..HEAD -- src/` empty ⇒ no retrieval
  evals needed.

## No-Agent Smoke

`run_stage5_m104_live_context_smoke.ts` builds, per case, the EXACT
model-visible context of a live default-protocol run: the runner's own
`buildCapsuleV2Task` → the runner's own `buildVtraceQueryCommand` CLI
subprocess over the M103 clean indexed workspace → the runner's own
`classifyCapsuleOutput` (digest off, as on a default run) → the runner's own
cost-aware v2 gate → the runner's own `buildVtraceContextMarkdown` with the
canonical protocol flags (`--disable-pivot-check`, token discipline on,
edit-guard/patch-verify on). No agent, no Docker, no API, no network.

- **Case set** (14): psf__requests-5414 (leakage policy),
  django__django-13513 / matplotlib__matplotlib-22719 / pydata__xarray-4695
  (M103 regression guards), psf__requests-1724 (M103 win; canonical id for
  "requests-1724"), sympy__sympy-13372 + sympy__sympy-13480 +
  django__django-16938 (M103 holdout wins/lateral), django__django-13810
  (unchanged holdout miss), astropy__astropy-14369 (multi-file co-edit
  recovered), django__django-16256 (import-reexport recovered),
  django__django-13195 (file-evidence rescue), mwaskom__seaborn-3187 +
  sphinx-doc__sphinx-7462 (cross-repo). All ids canonical from the M103
  detail JSON; no substitutions needed.
- **Task parity**: `task_text_exact_match` 14/14, hash match 14/14,
  `m103_task_text_exact_match` (vs the FROZEN M103 detail rows) 14/14,
  diagnostics (chars/exceptions/failing-tests/traceback-frames) 14/14. No
  wrapper differences — the live task IS the deterministic task byte-for-byte
  (the old `instance:`/`repo:` wrapper is gone; attribution stays in the
  injected `## Instance` header).
- **Leakage checks**: task 0 hits. Assembled markdown: 0 FAIL_TO_PASS /
  PASS_TO_PASS / gold-patch / marker / full-problem occurrences after
  base-commit provenance classification. The 7 raw coincidences are all
  verbatim base-commit repo content: sympy-13372 `raise NotImplementedError`
  (ubiquitous), django-16256 `return await sync_to_async(self.get_or_create)(`
  ×2 (the gold fix copies the pre-existing QuerySet pattern the capsule
  retrieved), sphinx-7462 three unparse-sibling lines + the
  `tests/test_domain_py.py::test_parse_annotation` caller reference (vtrace's
  own `path::symbol` impact rendering of a test that exists — and fails — at
  the base commit; format-coincident with the pytest node id, derived from the
  index, not from metadata).
- **psf__requests-5414**: task 345 chars, names `requests/models.py` because
  the ISSUE does; `assessGoldLeakage` verdict `issue_authored_gold_path`
  (allowed + diagnosed), 0 `gold_patch_leak`; live lead pivot IS
  `requests/models.py`, matching M103 (`good`). Not blocked.
- **Regression guard cases**: django-13513 lead `views/generic/__init__.py`,
  matplotlib-22719 lead `lib/matplotlib/units.py`, xarray-4695 lead
  `xarray/backends/api.py` — each byte-equal to its M103 row (the known
  facade-lead / overpacked states carry over unchanged; the lever remains
  overpacking, not derivation). All three leak-clean, gate=inject.
- **Bonus capsule-level agreement**: live CLI (`--intent auto`, budget 8000)
  reproduced the M103 scoreboard lead pivot on **14/14** cases despite the
  known config difference (scoreboard pins `intent=Debug` in-process), so
  live/deterministic agreement extends beyond task text on this set.

## Deterministic Parity

- **M103 unchanged proof**: no file that feeds the deterministic path changed
  (`src/`, `stage5_task_derivation.ts`, fixture builder, both retrieval
  fixtures — `git diff` empty); baselines fresh at `199769f`; full test suite
  (3529) incl. the M103 V5-parity tests passes. The M103 scoreboard was
  therefore NOT re-run (nothing it reads changed).
- **Skipped checks and why**: retrieval evals skipped (no deterministic
  product change — the CLAUDE.md condition for skipping); Docker evaluate,
  live agents, baselines: prohibited non-goals.

## Success Criteria Check

1. Live task derivation uses the shared M103 helper — **PASS** (code + unit
   test + 14/14 smoke byte-parity).
2. No live model-visible task/context uses full problem text as task —
   **PASS** (`task_is_full_problem_statement` false ×14;
   `model_visible_full_problem_present` false ×14).
3. No model-visible FAIL_TO_PASS / PASS_TO_PASS / gold patch / gold file list
   / accepted patch / hidden tests / scoring diagnostics — **PASS** (0
   unexplained hits; scoring markers absent).
4. Deterministic M103 task-text parity exact for all smoke cases — **PASS**
   (14/14 vs frozen M103 rows).
5. psf__requests-5414 allowed under issue-authored provenance, gold-patch-leak
   clean — **PASS**.
6. Regression guard cases inspected and reported — **PASS**.
7. No deterministic M103 scoreboard behavior change — **PASS** (inputs
   byte-untouched).
8. No live agents / Docker / API spend / baselines / V4/C7_D / Conda mutation
   — **PASS**.
9. Tests/typechecks pass — **PASS** (`bun test` 3529/0, `tsc` src +
   benchmarks clean, `git diff --check` clean).

## Verdict

**PASS**

## Recommendation

**Proceed to M105 small live confirmation.** The live agent will now see
exactly the structured task evidence measured in M103, with no FAIL_TO_PASS /
gold-derived leakage on the default path. Residuals to carry into M105
planning (all default-off or non-injected, none blocking):

- The legacy-engine FALLBACK query (`buildInstanceQuery`/`shapeSweQuery`)
  still packs FAIL_TO_PASS into its retrieval query. It only runs if the v2
  capsule hard-fails, and is never model-visible; a fallback section in an
  M105 run should be treated as parity-invalid for attribution.
- The opt-in M14/M15 pivot-revision second pass injects FAIL_TO_PASS into its
  corrective prompt BY DESIGN (explicitly-labeled oracle arm, default-off,
  never replaces the canonical patch). Keep it off in M105.
- The cost-aware gate / mode recommender read the FAIL_TO_PASS COUNT as a
  task-shape signal (decision metadata, never injected) — pre-existing,
  unchanged.
- Opt-in `--inject-capsule-digest` now echoes the structured (issue-only)
  task, so the old tail leak is gone even under that flag.

## Artifacts

- Plan: `stage5_m104_live_path_parity_plan.md`
- Summary JSON: `stage5_m104_live_path_parity.json`
- Per-case detail: `stage5_m104_live_context_smoke.detail.json`
- CSV: `stage5_m104_live_context_smoke.csv`
