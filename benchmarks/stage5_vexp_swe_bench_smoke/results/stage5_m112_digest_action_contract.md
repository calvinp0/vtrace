# Stage 5 M112 Digest Per-File Action Contract

_2026-07-10. Deterministic product-wording milestone. **No live agents, no
Claude/Codex spawn, no Docker evaluation, no API spend, no VEXP, no baseline
arm, no V4/C7_D, no revision/corrective arms, no M105–M108 reruns, no Conda
mutation.** The only subprocess run was the local `vtrace capsule` CLI over the
pre-existing committed clean workspaces. Plan (written before implementation):
`stage5_m112_digest_action_contract_plan.md`. Machine outputs:
`stage5_m112_digest_action_contract.json`,
`stage5_m112_render_smoke.detail.json`, `stage5_m112_render_smoke.csv`._

## Summary

- **Change:** the bounded digest decision contract
  (`src/capsuleV2/digestDecisionContract.ts`) now renders a **per-file action
  contract** inside its existing sentinels: one explicit
  `A#: <path> — <reason>` EDIT-or-RULE_OUT line per high-importance FILE
  (every pivot file, co-edit/import-re-export/file-evidence lane files, and up
  to 2 pivot-cap-evicted strong targets), with "Do not silently ignore any
  file listed here", a multi-file EACH-before-finalizing clause, a soft
  support-only note, and the single small verification caution the M112 spec
  allows.
- **Why:** M111's transcript study (next-action #1) showed the decisive
  multi-file loss shape: xarray-6938's gold `variable.py` (a co-edit-lane /
  pivot-cap-evicted support file the agent's own analysis implicated) and
  django-12325's gold `options.py` (a pivot outside the bounded T set) never
  received any decision slot, so they were silently dropped from patches.
- **No-spend confirmation:** no agent, Docker, API call, VEXP, baseline,
  V4/C7_D, or revision arm ran; nothing was rerun; no environment was mutated.
- **Verdict: PASS.**
- **Recommendation: proceed to the verification-oracle prompt-policy audit
  (M113).** The wording change cannot be claimed as a resolution improvement
  without a future guarded live confirmation; no live spend now.

## Pre-change Plan

Written first (`stage5_m112_digest_action_contract_plan.md`, 12 questions +
a pre-capture addendum). Key answers:

- **Current digest code path:** `toCapsuleV2ProductResponse(...).digest`
  (`src/capsuleV2/productAdapter.ts`) → sentinel-wrapped by
  `buildInjectedCapsuleV2DigestBlock` → assembled with the contract, human
  render and neighborhood in `classifyCapsuleV2Output`
  (`run_stage5_vexp_swe_bench_smoke.ts`).
- **Current decision-contract path:** `selectBoundedDigestDecisionTargets` +
  `renderBoundedDigestDecisionContractText` (M58/M65/M68) — required targets =
  lead pivot + first hidden co-pivot only, post-confidence-gate; impact reps
  optional/FYI.
- **Wording that failed xarray-6938:** the bounded T set never lists non-T
  pivots or support files; `variable.py` had no slot anywhere demanding a
  decision. The PRE capture additionally showed the M68 gate demotes 6938's
  LEAD pivot (its evidence phrase "task names this symbol directly" is outside
  the gate's strong-clause vocabulary), leaving ONE T target for a 2-gold-file
  case.
- **Target groups (action wording):** all pivot files (lead/hidden/required
  target labels, gate-independent — the gate still governs the closure-scored
  T set untouched); support files with lane evidence markers (`co-edit lane)`,
  `(import-relation lane)`, `(file-evidence rescue)`); ≤2 pivot-cap-evicted
  strong targets (`strong target beyond the pivot budget` role_reason). Total
  cap 6 with an explicit `(+N more…)` honesty line.
- **Non-target groups:** plain support/skeleton files (soft "consult if
  needed" note only), impact representatives (stay optional/FYI per M64/M65),
  gate-demoted-everything contracts (`NO_HIGH_CONFIDENCE` marker → no action
  list), `no_context` capsules (nothing rendered).

## Implementation

- **Files changed:**
  - `src/capsuleV2/digestDecisionContract.ts` — new `selectDigestActionFiles`
    (pure, gold-blind, keyed on already-selected items' own model-visible
    evidence), `renderPerFileActionLines`, `DigestActionFile*` types/caps;
    `renderBoundedDigestDecisionContractText` gains an `actionFiles` option;
    `buildDigestDecisionContract` gains `perFileActionContract` (DEFAULT ON
    under `bounded: true`; `false` reproduces the pre-M112 render
    byte-for-byte) and returns `actionFiles`.
  - `src/capsuleV2/digestDecisionContract.test.ts` — 12 new M112 tests.
  - `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m112_render_smoke.ts` —
    new no-agent pre/post render smoke (frozen-path flags, M104-style leakage
    scan, invariant checks).
  - No runner/protocol change needed: the live runner already routes
    `buildDigestDecisionContract` with `bounded: true`, so the frozen default
    path picks the wording up automatically on any FUTURE (separately
    approved) live run.
- **Wording added** (inside the contract sentinels, after the T-target list,
  before the anti-over-edit rules; A-ids disjoint from T/O; the line shape
  never matches the T-target parser grammar):

  ```
  Per-file action contract (Required / Pivot / Co-edit files):
  - EDIT the file if the issue requires a change there.
  - Otherwise RULE_OUT the file with one concrete repository-grounded reason
    (code you inspected, a caller/callee relationship, or behavior you verified).
  - Do not silently ignore any file listed here.
  - If several files are listed, make an explicit EDIT / RULE_OUT decision for
    EACH before finalizing the patch — especially co-edit candidates your own
    analysis touches.

  Action required (decide EDIT or RULE_OUT for each file):
  - A1: xarray/core/dataset.py — lead pivot
  - A2: xarray/core/dataarray.py — hidden pivot
  - A3: xarray/core/alignment.py — co-edit candidate
  - A4: xarray/core/variable.py — co-edit candidate

  Support-only files are context: consult if needed; do not treat them as required edits.
  If tests cannot run, that is not evidence of correctness: verify against a
  repository-grounded oracle (existing code paths, docstrings, issue reproduction)
  or state the uncertainty explicitly.
  ```

- **How the list is built:** a pure projection over the SAME
  `CapsuleV2ProductResponse` the digest/contract already use — pivot files in
  pivot order, then lane-marked support files, then ≤2 budget-evicted strong
  targets; dedup by path; cap 6 with honesty line. No retrieval, ranking,
  selection, budget, or T/O-set change.
- **Leakage safety:** inputs are already-selected capsule items + fixed
  instruction strings; gold patch / FAIL_TO_PASS / PASS_TO_PASS / hints /
  scoring diagnostics are never inputs. Verified per case (below).
- **Token/char impact:** contract block +868…+1118 chars (median +1011,
  p90 +1099 ≈ +253t/+275t est.); TOTAL model-visible context grew only
  0…+1028 chars (median +244, p90 +1002, ≈ +61t median) because in cap-bound
  cases the fixed context budget absorbs the addition by trimming tail
  support-signature bodies (M45 section-priority truncation; the contract
  block itself is sentinel-atomic and never clipped).

## No-Agent Render Smoke

- **Method:** `run_stage5_m112_render_smoke.ts` renders the exact frozen
  default-path model-visible context (M105–M108 driver flags: force-inject,
  v2, intent debug, budget 8000, digest + contract + bounded + compact +
  confidence gate, DB-backed enrichment provider, same
  `buildVtraceContextMarkdown` limits) over the committed clean indexed
  workspaces. `--tag pre` was captured at the pre-change src state (first at
  HEAD before any edit, then re-verified via `git stash` A/B of the single
  changed src file), `--tag post` after; `--compare` wrote the committed
  detail/CSV.
- **Case set (12):** pydata__xarray-6938, django__django-12325,
  pytest-dev__pytest-6197, sympy__sympy-15875, django__django-16263,
  pylint-dev__pylint-4551 (all six required M111 cases), contrast wins
  pylint-dev__pylint-8898 + astropy__astropy-14365 + sympy__sympy-12419,
  normal-excellent django__django-10973, wrong_pivot django__django-16256,
  and no_context exclusion django__django-11740.
- **Results:** action contract present **11/11** rendered contexts; lead-pivot
  action entry present **11/11**; per-file action count median 4 (min 1,
  max 5, cap never bound); co-edit lane files with action entries in 5 cases;
  zero plain-support files constrained (overconstrained = 0 everywhere).
- **xarray-6938:** A-list = `dataset.py — lead pivot`, `dataarray.py — hidden
  pivot`, `alignment.py — co-edit candidate`, **`variable.py — co-edit
  candidate`** — the exact file M111 found silently dropped now has an
  explicit decision slot (its full evidence array carries the co-edit rescue
  marker; the digest `why:` line had shown only the role reason). The
  gate-demoted lead also regains a per-file slot.
- **django-12325:** A-list = `db/models/sql/query.py — lead pivot`,
  **`db/models/options.py — hidden pivot`** (the gold pivot that received no
  decision in the M108 transcript), + 2 budget-evicted targets.
- **no_context (django-11740):** no contract, no action list, no bogus
  wording — byte-identical empty treatment pre/post.

## Invariant Checks

All proven per case in `stage5_m112_render_smoke.detail.json`
(`all_invariants_hold: true`), via stash A/B (only
`src/capsuleV2/digestDecisionContract.ts` differs between captures):

- **Selected files unchanged** — capsule CLI stdout sha256 equal pre/post
  after normalizing the CLI's only nondeterministic field (`latencyMs`,
  verified by back-to-back identical-src runs differing ONLY in that field);
  pivot/support file sets byte-equal.
- **Lead pivot unchanged** — 12/12 equal (and matching M103 where recorded).
- **Required/optional targets unchanged** — parsed T-target lists byte-equal;
  optional/FYI section unchanged; the M68 gate verdicts untouched.
- **Task hash unchanged** — 12/12 equal, and task text byte-identical to the
  frozen M103 detail rows (M103/M104 parity holds; derivation untouched).
- **Capsule mode unchanged** — 12/12 equal (incl. the no_context case).
- Full-context hashes changed on the 11 rendered cases — expected: that IS
  the wording change.
- Retrieval evals not run, per the M112 protocol: no retrieval / ranking /
  capsule-selection code was touched (the change is harness-side contract
  rendering), and the capsule-CLI stdout-hash equality above is a stronger
  per-case no-change proof for exactly the surfaces this milestone could have
  perturbed.

## Leakage Checks

M104-policy scan over every post-change full model-visible context
(FAIL_TO_PASS ids, PASS_TO_PASS ids, forbidden markers, gold-patch literal,
gold added lines; hits provenance-annotated against the base-commit
workspace): **0 unexplained hits across all 12 cases** (`leak_unexplained_total: 0`).
0 FAIL_TO_PASS, 0 PASS_TO_PASS, 0 gold patch, 0 accepted-patch file lists,
0 hidden-test/scoring diagnostics; issue-authored evidence remains allowed by
policy (no such hit needed the exemption in this set).

## Remaining Work

- **Verification-oracle prompt-policy audit (M113, next):** CHECK-RUN text vs
  resolution over all 97 captured runs — M111's #2 no-spend action. M112
  deliberately added only the one-sentence generic caution.
- **Env-failure-loop diagnostic (design-only, default-off)** — M111 #3.
- **No live spend recommendation stands:** the action contract's effect on
  resolution is unmeasured by design here; any future guarded live
  confirmation must be separately approved and re-prove parity/leakage first
  (`run_stage5_m104_live_context_smoke.ts` + this smoke).

## Success Criteria Check

1. No live agents / Docker / API / baselines / VEXP / V4-C7_D / revision arms — **PASS** (none run).
2. M111 findings used as motivation — **PASS** (plan §4, xarray-6938/django-12325 mechanism).
3. Action wording added for required/pivot/high-confidence co-edit files — **PASS** (11/11 rendered cases).
4. Optional support files not broadly overconstrained — **PASS** (0 overconstrained files; plain support untouched, soft note only).
5. No-agent smoke shows action wording on the required cases — **PASS** (all six M111-required cases carry A-lists).
6. xarray-6938 gets explicit per-file action wording for the multi-file scope — **PASS** (variable.py = A4 co-edit candidate; both pivots listed).
7. File selection, lead pivot, required/optional targets, task hash, capsule mode unchanged — **PASS** (`all_invariants_hold: true`; stash A/B + normalized stdout hash).
8. Model-visible context leak-clean — **PASS** (0 unexplained hits).
9. Wording/token impact measured — **PASS** (contract +1011 chars median / +1099 p90; total context +244 chars median / +1002 p90 after cap absorption).
10. Tests/typechecks pass — **PASS** (3664 tests 0 fail incl. 12 new M112 tests; `typecheck` + `typecheck:benchmarks` clean; `git diff --check` clean).

## Verdict

**PASS.**

## Recommendation

**Proceed to verification-oracle prompt-policy audit** (M113). Keep the
action contract default-ON under the bounded contract; revisit its wording
only if the M113 audit or a future guarded live confirmation surfaces
over-edit pressure (the anti-over-edit rules and RULE_OUT validity rules are
retained unchanged as the counterweight).
