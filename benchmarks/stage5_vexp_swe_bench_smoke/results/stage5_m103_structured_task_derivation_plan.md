# Stage 5 M103 — Structured Task Derivation: Pre-Change Plan

_Written BEFORE implementation, per the M103 protocol. Deterministic, offline:
no live agents, no Docker, no API spend, no Conda mutation._

Goal: make the M102-winning **V5-shaped** derivation (current 360-char base +
extracted exception names + failing-test ids + capped traceback frames) the
default Stage 5 deterministic task derivation, under a full rebaseline with a
provenance-based leakage policy.

## Audit answers

### 1. Where is task derivation duplicated, if anywhere?

The deterministic derivation itself is **not duplicated**: a single
implementation, `deriveTaskFromProblemStatement(ps, maxLen=360)` in
`build_stage5_retrieval_fixture.ts:101`, is imported everywhere it is used.
There IS a **divergent second path** (not a copy): the live runner's
`buildCapsuleV2Task` (`run_stage5_vexp_swe_bench_smoke.ts:5182`) builds its own
capsule task from the FULL problem statement + `failing tests:` (FAIL_TO_PASS)
+ hints, capped at `MAX_VTRACE_QUERY_CHARS`. The M102 extraction logic lives in
a third, benchmark-only module `stage5_m102_task_variants.ts` (explicitly
marked "nothing here is wired into the product").

### 2. Which code paths consume `deriveTaskFromProblemStatement`?

- `build_stage5_retrieval_fixture.ts` → `buildGoldRow` (fixture `task` field).
- Milestone scoreboard runners `run_stage5_m94/95/96/97/98/99/100/101_deterministic_scoreboard.ts`.
- Gap-audit runners `run_stage5_m96/97/99/100/101_*_gap_audit.ts`,
  `run_stage5_m102_task_evidence_audit.ts`.
- `stage5_m102_task_variants.ts` (as the V0 base of every variant).
- Tests: `build_stage5_retrieval_fixture.test.ts`, `stage5_m102_task_variants.test.ts`.

### 3. Which path did M102 variants use?

`run_stage5_m102_task_derivation_variants.ts` → `buildTaskVariant(name, ps)`
(`stage5_m102_task_variants.ts`), which composes V5 as
`composeCapped(V0, [Errors, Failing tests, Traceback], 1200)` with extraction
caps exceptions ≤6, failing tests ≤6, traceback lines ≤8 (head+tail split when
over cap). The variant text was passed directly as `buildCapsuleV2`'s `task`.

### 4. Which path does the deterministic scoreboard use?

Each milestone runner calls `deriveTaskFromProblemStatement(instance.problem_statement)`
and passes the result to `buildCapsuleV2` (e.g. `run_stage5_m101_deterministic_scoreboard.ts:156`).

### 5. Which path does the retrieval eval fixture builder use?

`buildGoldRow` (`build_stage5_retrieval_fixture.ts:250`) — the same function.
The committed fixture rows bake the derived task text in: 15/20 rows of
`retrieval_eval.django.expanded.json` are auto-built (5 are hand-curated and
carried via `--base-fixture retrieval_eval.django.json`); all 30 rows of
`retrieval_eval.cross_repo.30.json` are auto-built.

### 6. Which path does the live runner use?

**Not the shared helper.** `buildCapsuleV2Task` passes the full problem
statement (+FAIL_TO_PASS +hints). M103 leaves the live path untouched (changing
it is live-behavior work needing live validation). Two observations recorded
for the report: (a) the live path already carries strictly more evidence than
V5 adds; (b) it includes FAIL_TO_PASS, which under the new leakage taxonomy is
*benchmark-added* evidence — a pre-existing live-side property, unchanged here.

### 7. What exactly must change to make V5-shaped derivation the default?

- New shared module `stage5_task_derivation.ts`:
  - hosts the (moved, unchanged) base derivation `deriveTaskFromProblemStatement`
    + `splitSentencesSafe`;
  - adds `deriveStructuredTaskFromProblemStatement(ps)` returning
    `{ baseTask, exceptions, failingTests, tracebackFrames, taskText, diagnostics }`
    whose `taskText` is **byte-identical to M102 V5** (same extraction regexes
    and caps), so the M102 measurement transfers exactly.
- `build_stage5_retrieval_fixture.ts`: re-export the base helpers (frozen
  M94–M101 runners keep importing V0 unchanged); `buildGoldRow` switches the
  fixture `task` to the structured `taskText`.
- `stage5_m94_lib.ts`: add provenance-aware `assessGoldLeakage(task, ps, gold)`
  (see Q10); keep `assertNoGoldLeakage` for the frozen runners.
- New `run_stage5_m103_deterministic_scoreboard.ts`: M101-style runner using
  the structured derivation + new leakage policy; compares against frozen M101
  detail rows and frozen M102 V5 variant rows; emits the six required outputs.
- Regenerate the two canonical fixtures + retrieval-eval baselines (separate
  refresh commit, meta-file protocol).

### 8. How will old V0 behavior remain accessible?

`deriveTaskFromProblemStatement` stays exported with byte-identical behavior
(moved + re-exported). Every frozen M94–M102 runner keeps producing V0 tasks,
so historical scoreboards remain reproducible. The structured derivation is a
NEW function; V0 is also its `baseTask` field.

### 9. What leakage guard currently blocks issue-authored gold paths?

`assertNoGoldLeakage(task, gold)` (`stage5_m94_lib.ts:101`): blocks when any
gold file path containing `/` appears in the task (case-insensitive). It cannot
tell WHERE the path came from — psf__requests-5414 is `leakage_blocked` in
M94–M101 because the ISSUE itself names `requests/models.py`.

### 10. How should provenance distinguish evidence classes?

- **issue-authored evidence**: text present verbatim in the instance's
  `problem_statement`. The deterministic derivation reads ONLY the problem
  statement (enforced by signature), so it records
  `provenance: "issue_problem_statement"`. A gold path in the task that also
  occurs in the problem statement ⇒ `issue_authored_gold_path` — a diagnostic,
  scored normally.
- **benchmark-added evidence**: FAIL_TO_PASS / hidden-test metadata / harness
  fields. Never reaches the deterministic derivation (not a parameter). Any
  future derivation taking such inputs must not feed them into scoring-eligible
  task text.
- **gold-patch-derived evidence**: a gold path (or any gold-derived token) in
  the task that does NOT occur in the problem statement ⇒ `gold_patch_leak` —
  the case stays **blocked/unscoreable** (protection not weakened).

`assessGoldLeakage(task, problemStatement, gold)` returns
`clean | issue_authored_gold_path | gold_patch_leak` + the offending paths; the
M103 runner scores `issue_authored_gold_path` cases and blocks `gold_patch_leak`.

### 11. How will psf__requests-5414 be handled after M103?

Its gold path (`requests/models.py`) is named by the issue text itself, so the
new policy classifies it `issue_authored_gold_path` and scores it. The M103
scoreboard reports BOTH the 99-case M101-comparable set and the 100-case
new-policy set. If it still fails to score, the exact `status_detail` will be
reported. (It is also already a row in `retrieval_eval.cross_repo.30.json` —
the retrieval eval never had the blocking guard.)

### 12. What regression guards for django-13513, matplotlib-22719, xarray-4695?

Report-level before/after analysis (not brittle full-output asserts): the M103
runner emits a `regression_guard_cases` block with per-case
M101 outcome / M102-V5 outcome / M103 outcome, lead pivot, all-gold/any-gold,
required-gold and overpacking, and the report states what changed, whether the
loss is acceptable, and future mitigation. Expected from M102: django-13513
excellent→good (holdout lead drift to `views/generic/__init__.py`),
matplotlib-22719 required-gold lost inside an already-overpacked capsule,
xarray-4695 gold leaves top-5 inside an already-overpacked capsule.

## Caps decision (documented deviation from the "suggested" caps)

The M103 spec suggests max 8 exceptions / 8 tests / 8 frames, ≤600 structured
chars, ≤1200 total. M102 V5 used **6 / 6 / 8 and a 1200-char cap on the whole
composed text** (base never trimmed; sections dropped whole from the end).
M103 keeps the exact V5 caps: reproducing the measured winner byte-for-byte is
the point of the milestone, and every V5 cap is within the suggested bounds
(6 ≤ 8; composed-text cap 1200 = the total cap; observed p90 task 392 chars).
Deviating to 8/8 would silently re-open the variant search.

## Evaluation plan

1. Unit tests for the new module (base parity, extraction, dedupe/caps/order,
   formatting, V5 byte-equivalence vs `buildTaskVariant`, leakage provenance).
2. `run_stage5_m103_deterministic_scoreboard.ts` over swe-bench-100 →
   the six `stage5_m103_deterministic_*` outputs; comparisons: M101→M103 and
   M102-V5→M103 on the 99-case comparable set, 100-case new-policy set,
   dev/holdout, evidence-beyond-V0 cohorts, by repo, regression-guard cases.
3. Retrieval evals: (a) old-fixture run must stay byte-identical to committed
   baselines (proves the retrieval ENGINE is untouched — src/ unchanged);
   (b) regenerate both fixtures with the new derivation; (c) run
   `stage5_m103_retrieval_eval_{expanded,cross_repo_30}` to a temp dir and
   report deltas; (d) refresh canonical baselines + meta in a follow-up commit.
4. `bun run typecheck`, `bun run typecheck:benchmarks`, `bun test`,
   `git diff --check`.
