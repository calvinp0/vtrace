# Stage 5 M104 — Live-Path Structured Task Parity: Pre-Change Audit Plan

Date: 2026-07-05. Offline audit only — NO live agents, NO Docker, NO API spend.

Pre-existing dirty files (recorded, untouched): `results/stage5_outcome_ledger.{json,md}`
(modified pre-M104), plus the large untracked raw-artifact set (`results/runs/`,
`results/_m*_logs/`, `results/raw/`, `AGENTS.md`, `VTRACE_TOOLING_AUDIT.md`,
`package-lock.json`, …). None are staged or edited by M104 except the milestone
ledger (intentional append) and `VTRACE_TOOLING_AUDIT.md` if a claim changes.

## 1. Which live runner path currently constructs the task text?

`run_stage5_vexp_swe_bench_smoke.ts` → `capsuleQueryTextFor(config, instance)`
(line ~5195) → engine v2 (the default) calls **`buildCapsuleV2Task(instance)`**
(line ~5182). Legacy (fallback-only) calls `buildInstanceQuery` →
`shapeSweQuery` (packed retrieval query).

`buildCapsuleV2Task` today composes:

```
instance: <instance_id>
repo: <repo>

<FULL problem_statement>

failing tests: <FAIL_TO_PASS.join(", ")>     ← hidden-label leak into retrieval

hints: <hints_text>                           ← issue-thread hints (often fix-adjacent)
```

capped at `MAX_VTRACE_QUERY_CHARS` = 8000. It does NOT use
`stage5_task_derivation.ts`.

## 2. What exactly does the live runner currently pass to buildCapsuleV2?

The live runner never calls `buildCapsuleV2` in-process. It shells out:

`bun src/cli/index.ts capsule <workspace> <task> --intent auto --budget 8000
--pivot-neighborhood --json` (via `buildVtraceQueryCommand`), where `<task>` is
the full-problem composite above. The same composite is passed to the
`run-pipeline` product-accounting probe (`--capture-product-v2-accounting`).
So live retrieval runs on **full problem text + FAIL_TO_PASS + hints**, while
the M103 deterministic measurement ran on
`deriveStructuredTaskFromProblemStatement(problem_statement).taskText`
(≤1200 chars, issue-only). Live evidence ≠ measured evidence.

## 3. Does model-visible live context currently include full problem text?

Mostly no, with one opt-in exception:

- `_vtrace_instructions.md` (the injected file) deliberately does NOT repeat
  the problem statement (`buildVtraceContextMarkdown`, comment at ~6417); it
  injects instance header (id/repo/base_commit) + retrieved capsule render +
  guard blocks only.
- The agent sees the problem statement anyway from the EXTERNAL vexp harness
  prompt — benchmark-native, identical in both arms, out of vtrace's scope.
- **Exception**: with `--inject-capsule-digest` (default OFF, not in the
  canonical protocol command) the digest header echoes the capsule query —
  short queries verbatim, long ones as a head(600)/tail(200) excerpt
  (`renderDigestQueryHeader`, `src/capsuleV2/productAdapter.ts`). The current
  task composite puts `failing tests:`/`hints:` at the TAIL, i.e. digest runs
  would surface FAIL_TO_PASS into model-visible context.

## 4. Does model-visible live context currently include FAIL_TO_PASS, PASS_TO_PASS, gold patch data, or hidden-test metadata?

- **FAIL_TO_PASS**: not on the default first-pass injection path; YES
  potentially under opt-in `--inject-capsule-digest` (tail echo, see #3); YES
  by design in the opt-in M14/M15 pivot-revision second-pass prompt
  (default-off, explicitly labeled oracle-assisted arm, never replaces the
  canonical patch; M23 `--revision-verification-policy agent-discovered-tests`
  exists to suppress the literal names). Additionally FAIL_TO_PASS reaches
  retrieval (non-model-visible but evidence-contaminating) via the task text —
  the M104 defect. Retrieved capsule content is base-commit repo code, so an
  injected FAIL_TO_PASS name can also surface indirectly if evidence
  reasons/test-lane hints quote task terms; after the fix, all task terms are
  issue-authored.
- **PASS_TO_PASS**: never loaded into `SweBenchInstance` (`toSweBenchInstance`
  reads only repo/id/base_commit/problem_statement/hints/FAIL_TO_PASS); used
  only in `--mode evaluate` result parsing. Clean.
- **Gold patch**: never read on the run-protocol path (only `extractGold` in
  offline scoreboards and the evaluate step). Clean.
- **Hidden-test metadata**: FAIL_TO_PASS count also feeds the cost-aware
  injection gate + capsule mode recommendation (`deriveContextPolicySignals` →
  `shapeSweQuery`) — decision metadata, never injected. Pre-existing; noted,
  not model-visible, out of M104 scope.

## 5. Which fields are evaluation metadata only versus model-visible prompt/context?

Model-visible (vtrace side) = `_vtrace_instructions.md` content only:
instance_id / repo / base_commit header, capsule v2 render (digest/contract
blocks only under opt-in flags, inspect-first, focused source, neighborhood),
PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / STAGE5_TOKEN_DISCIPLINE blocks — plus
the capsule QUERY string (indirect: it drives retrieval, and echoes under
opt-in digest injection).

Metadata-only (never injected): `failToPass` (gate signals, evaluate parsing,
revision-pass DISALLOW evidence), PASS_TO_PASS / gold patch / resolution
labels (evaluate mode only), run condition/labels, cost/turn accounting.

## 6. What change is needed to route live task derivation through stage5_task_derivation.ts?

Rewrite `buildCapsuleV2Task` to return
`deriveStructuredTaskFromProblemStatement(instance.problemStatement).taskText`
— dropping the `instance:`/`repo:` header, the full problem statement, the
`failing tests:` line, and the `hints:` line. The 8000-char safety cap becomes
inert (structured cap is 1200). `capsuleQueryTextFor` and the product-v2 probe
pick this up automatically. The legacy engine's `buildInstanceQuery` is
UNCHANGED (fallback-only; its query is never model-visible; changing it would
alter legacy-engine behavior — documented residual, v2 is the default and the
smoke asserts the v2 path).

## 7. How can deterministic M103 and live no-agent smoke prove byte/parity consistency?

No-agent smoke (`run_stage5_m104_live_context_smoke.ts`): for each smoke case,
load the dataset record through the RUNNER's own `toSweBenchInstance`, compute
the live task via the RUNNER's `buildCapsuleV2Task`, compute the deterministic
task via the SHARED `deriveStructuredTaskFromProblemStatement`, and require
byte equality + sha256 equality + matching diagnostics; also require equality
with the M103 detail-row `derivation.task_text` (frozen artifact). Then build
the exact model-visible context the live runner would inject: the same
`vtrace capsule` CLI invocation (`buildVtraceQueryCommand`) against the M103
clean indexed workspaces (`results/workspaces/{expanded,cross_repo}`), the same
`classifyCapsuleOutput` options, the same cost-aware gate, and the same
`buildVtraceContextMarkdown` limits as the canonical protocol command
(`--disable-pivot-check`, token discipline on, edit-guard/patch-verify on,
digest off) — then scan that markdown. Deterministic M103 stays unchanged
because the shared module, fixtures, and `src/` are untouched (proof: git diff
scope + the unchanged-file check; no retrieval eval needed unless `src/`
moves).

## 8. What leakage assertions are needed?

Per case, over the live task AND the assembled model-visible markdown:
- no FAIL_TO_PASS entry (each test id, substring, from the raw record);
- no PASS_TO_PASS entry (ditto);
- gold patch literal absent; count of non-trivial gold ADDED lines appearing
  verbatim (expected 0; added lines are post-fix code);
- marker strings absent: `FAIL_TO_PASS`, `PASS_TO_PASS`, `failing tests:`,
  `hints:`, `gold_patch`, `issue_authored_gold_path` (scoring diagnostics);
- task is NOT the full problem statement (and problem statement is not a
  substring of the injected markdown);
- `assessGoldLeakage(liveTask, problem_statement, gold)` verdict is `clean` or
  `issue_authored_gold_path` — never `gold_patch_leak` (psf-5414 must be
  issue-authored-allowed).

## 9. Which small case set should be used for smoke tests?

14 cases (canonical ids from the M103 detail JSON):

| case | why |
|---|---|
| psf__requests-5414 | leakage-policy case (issue-authored gold path) |
| django__django-13513 | regression guard (holdout facade-lead loss) |
| matplotlib__matplotlib-22719 | regression guard (overpacked shift) |
| pydata__xarray-4695 | regression guard (overpacked shift) |
| psf__requests-1724 | M103 win (miss→excellent); "requests-1724" canonical id |
| sympy__sympy-13372 | M103 holdout win (wrong_pivot→excellent) |
| sympy__sympy-13480 | M103 holdout win (miss→good) |
| django__django-16938 | M103 holdout lateral (miss→partial) |
| django__django-13810 | unchanged holdout miss |
| astropy__astropy-14369 | multi-file co-edit recovered (all-gold) |
| django__django-16256 | import-reexport recovered case |
| django__django-13195 | multi-file file-evidence rescue case (M100) |
| mwaskom__seaborn-3187 | cross-repo multi-file all-gold |
| sphinx-doc__sphinx-7462 | M103 win (good→excellent), cross-repo |

## 10. What must be true before M105 can spend money on live agents?

1. `buildCapsuleV2Task` provably delegates to the shared M103 helper (unit
   test + smoke byte-parity on all 14 cases, including vs the frozen M103
   detail rows).
2. Assembled live model-visible context passes every leakage assertion in #8
   on all 14 cases; psf-5414 allowed under issue-authored provenance.
3. Deterministic M103 scoreboard/fixtures/`src/` byte-untouched (no retrieval
   re-baseline needed).
4. `bun test`, both typechecks, `git diff --check` pass.
5. Known live-config divergences documented (intent auto vs scoreboard's fixed
   Debug; live CLI subprocess vs in-process buildCapsuleV2) so M105 deltas are
   attributable.
6. Residuals documented: legacy-fallback query still packs FAIL_TO_PASS
   (retrieval-only, fallback-only), revision-pass oracle arm stays opt-in.
