# Stage 5 M65C Optional Impact Variance Replicates

## Summary
- **Selected cases:** `matplotlib__matplotlib-24627`, `mwaskom__seaborn-3187` (both members of the frozen M62 24-task set).
- **Replicate count:** 3 per case (r1, r2, r3).
- **New live runs performed:** 6 (2 cases × 3 replicates), under the hard cap of 6. 0 fresh baselines.
- **Valid / invalid treatment runs:** **6 valid / 0 invalid.**
- **Baseline reuse:** both cases reuse the M60B baseline lineage (model-match `True`, `0/3` resolved). No fresh baselines required; cap respected.
- **Headline resolution:** matplotlib-24627 **2/3 resolved** (r1 fail, r2+r3 pass); seaborn-3187 **0/3 resolved**.
- **Headline structured-decision:** coverage 83.3% (100% excluding matplotlib-24627 r1), ignored 16.7%, invalid 0.0%. No required IMPACT targets; 0 optional impact edits.
- **Verdict:** **PASS** — the M65B resolution dip on matplotlib-24627 was ordinary live variance, not a treatment regression. The optional-impact invariant held in 6/6 runs.

## Pre-flight
Offline non-agent pre-flight (`run_stage5_m65c_preflight.ts`, reuses the validated M65B gate logic) on both selected cases with current post-M65 code:

| Result | Count |
| --- | --- |
| VALID | **2** |
| FAIL_CLOSED_OMITTED | 0 |
| INVALID_PARTIAL_SENTINEL | 0 |

- **No required IMPACT result:** both cases — required targets are pivots only (`T1`,`T2`); 0 required IMPACT. ✔
- **Optional/FYI impact context result:**
  - matplotlib-24627: optional section present (`O1`,`O2` → `test_agg.py` cross-file impact reps), marked **not closure-scored**. ✔
  - seaborn-3187: optional section correctly **absent** — every impact representative is same-file as the pivot (`scales.py`), so no cross-file rep survives (pre-M65 dedup, unchanged). ✔
- **Required/optional ID separation result:** clean — `T`-prefixed required, `O`-prefixed optional, no collision in either case. ✔

## Run Matrix

| instance | rep | baseline | M62C | M65B | M65C | run_label | valid | evaluated | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | r1 | 0/3 | ✅ | ❌ | ❌ | `m65c_optional_impact_variance_matplotlib_24627_r1` | yes | yes | edited both golds, 104-turn thrash, incomplete patch |
| matplotlib-24627 | r2 | 0/3 | ✅ | ❌ | ✅ | `m65c_optional_impact_variance_matplotlib_24627_r2` | yes | yes | edited both golds (passing shape) |
| matplotlib-24627 | r3 | 0/3 | ✅ | ❌ | ✅ | `m65c_optional_impact_variance_matplotlib_24627_r3` | yes | yes | edited both golds, cheapest run |
| seaborn-3187 | r1 | 0/3 | ❌ | ❌ | ❌ | `m65c_optional_impact_variance_seaborn_3187_r1` | yes | yes | edited scales.py only; utils.py never surfaced |
| seaborn-3187 | r2 | 0/3 | ❌ | ❌ | ❌ | `m65c_optional_impact_variance_seaborn_3187_r2` | yes | yes | same mechanism |
| seaborn-3187 | r3 | 0/3 | ❌ | ❌ | ❌ | `m65c_optional_impact_variance_seaborn_3187_r3` | yes | yes | same mechanism |

(Baseline = reused M60B lineage: `eval-bounded-baseline-mpl-24627-r1 (+2 reps)` and `eval-bounded20-baseline-seaborn-3187-r1 (+2 reps)`, both `0/3`, model-match `True`.)

## Replicate Results

| instance | rep | resolved | patch | total_tokens | cost | tool_calls | reads | searches | rep_reads | req_targets | closed | open | ignored | invalid_ruleout | optional | opt_edited | lead_pivot | hidden_pivot | edited_files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matplotlib-24627 | r1 | ❌ | yes | 4,792,892 | $3.007 | 47 | 16 | 9 | 13 | 2 | 0 | 2 | 2 | 0 | 2 | 0 | pyplot.py | pyplot.py | _base.py, figure.py |
| matplotlib-24627 | r2 | ✅ | yes | 4,524,886 | $1.621 | — | 13 | 11 | 11 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | pyplot.py | pyplot.py | _base.py, figure.py |
| matplotlib-24627 | r3 | ✅ | yes | 2,562,726 | $0.874 | — | 5 | 8 | 1 | 2 | 2 | 0 | 0 | 0 | 2 | 0 | pyplot.py | pyplot.py | _base.py, figure.py |
| seaborn-3187 | r1 | ❌ | yes | 1,006,626 | $0.583 | — | 1 | 1 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | scales.py | relational.py | scales.py |
| seaborn-3187 | r2 | ❌ | yes | 1,348,612 | $0.606 | — | 3 | 1 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | scales.py | relational.py | scales.py |
| seaborn-3187 | r3 | ❌ | yes | 1,715,289 | $0.688 | — | 1 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | scales.py | relational.py | scales.py |

## Variance Analysis

### matplotlib-24627
- **Pass count:** 2/3.
- **Prior M62C:** resolved. **Prior M65B:** not resolved.
- **Pivot stability:** stable — all 3 replicates surfaced the same `pyplot.py::plot` / `pyplot.py::subplots` entry-point pivots (the M55X-known *off-localization decoys*), identical to the M65B failing run.
- **Edit-file stability:** stable and *correct* — all 3 replicates edited **both** real gold files `axes/_base.py` + `figure.py` (the M62C passing shape). The agent consistently bypassed the decoy pyplot pivots and located the golds.
- **Agent-thrash indicators:** r1 thrashed (104 turns, 13 repeated reads, $3.01) and produced an incomplete patch; r2 also high-turn (99) but completed; r3 efficient (55 turns, $0.87).
- **Likely diagnosis:** **live variance.** The M65B failure mode (edited `_base.py` *only*, missing `figure.py`) did **not** reproduce — every M65C replicate edited both golds. The demoted optional impact reps (`test_agg.py`) were never edited. r1's failure is incomplete-patch content variance under thrash, not a localization or optional-impact effect.

### seaborn-3187
- **Pass count:** 0/3.
- **Prior M62C:** not resolved. **Prior M65B:** not resolved. **Baseline:** 0/3.
- **Pivot stability:** stable — `scales.py::ContinuousBase._setup` (lead) + `relational.py::scatterplot` (hidden) every replicate.
- **Edit-file stability:** stable — `scales.py` only in all 3 replicates; lead pivot edited, hidden pivot (`relational.py`) ruled out.
- **Agent-thrash indicators:** none — clean, cheap runs (27/34/44 turns, ≤3 reads, 0 repeated reads).
- **Likely diagnosis:** **stable fail / retrieval-localization gap.** This is a two-gold-file case (`scales.py` **+** `utils.py`). The second gold `utils.py` is never surfaced as a pivot (`relational.py` is surfaced in its place), so the agent never edits it. Consistent failure across baseline/M62C/M65B/M65C. Unrelated to the optional-impact rule (no cross-file impact reps surface for this case).

## matplotlib-24627 Deep Dive
- **Replicate outcomes:** r1 ❌, r2 ✅, r3 ✅ → **2/3**.
- **Pivot paths each replicate:** all three: `lib/matplotlib/pyplot.py::plot`, `lib/matplotlib/pyplot.py::subplots`.
- **Edited files each replicate:** all three: `lib/matplotlib/axes/_base.py`, `lib/matplotlib/figure.py`.
- **Comparison to M62C passing shape (`_base.py` / `figure.py`):** **exact match** in all 3 replicates — r2/r3 reproduce the passing shape and resolve.
- **Comparison to M65B failing shape (`pyplot.py` entry points, edited `_base.py` only, 95-turn thrash, incomplete patch):** the *pivot* shape matches (pyplot decoys), but the *edit* shape does **not** reproduce — M65C edited both golds in every replicate, so the M65B "missing figure.py" failure mode appeared 0/3 times.
- **Whether optional-impact demotion plausibly caused failure:** **No.** The optional impact reps are `test_agg.py` test files; they were surfaced as O1/O2 (not closure-scored) and **never edited** in any replicate — exactly as in M62C/M65B. The win mechanism (editing `_base.py`+`figure.py`) is untouched by demotion. r1's failure is incomplete-patch variance under thrash.

## seaborn-3187 Deep Dive
- **Replicate outcomes:** r1 ❌, r2 ❌, r3 ❌ → **0/3**.
- **Pivot paths each replicate:** all three: `seaborn/_core/scales.py::ContinuousBase._setup` (lead), `seaborn/relational.py::scatterplot` (hidden).
- **Edited files each replicate:** all three: `seaborn/_core/scales.py` only.
- **Pass/fail mechanism:** the fix requires `scales.py` **and** `utils.py`. The agent edits `scales.py` (lead pivot) and rules out `relational.py` (the surfaced hidden pivot, which is *not* the second gold). `utils.py` is never surfaced, so the patch is structurally incomplete and `resolved=0`. Structured decisions are clean every run (coverage 2/2, 0 ignored, 0 invalid).
- **Whether instability remains:** the case is *stably* unresolved (not flaky) across baseline/M62C/M65B/M65C — the limitation is retrieval localization of the second gold, not run-to-run instability and not the optional-impact rule.

## Structured Decision Analysis
- **Coverage:** 10/12 closed = **83.3%** (100% excluding matplotlib-24627 r1).
- **Ignored rate:** 2/12 = **16.7%** — both ignored targets are matplotlib-24627 r1's off-localization `pyplot.py` decoy pivots, which the agent correctly bypassed to edit the real golds. This is the M55X over-anchor-watch nuance, not a compliance defect.
- **Invalid rate:** **0.0%** — no invalid rule-outs in any run (the M65 retrospective improvement holds live).
- **Optional impact target inspection/edit behaviour:** matplotlib surfaced 2 optional reps per run (`test_agg.py`); **0 inspected, 0 edited** in all replicates. seaborn surfaced 0 optional reps.
- **Required impact target count:** **0** across all 6 runs — the core M65 invariant (impact reps never required) holds live in 6/6 runs.
- **Whether the M65 invariant holds live:** **Yes** — no required IMPACT target appeared, optional context was marked not-closure-scored, and no optional rep was edited.

## Success Criteria
| # | Criterion | Result |
| --- | --- | --- |
| 1 | All attempted runs valid | ✅ 6/6 valid |
| 2 | No required IMPACT targets | ✅ 0 across 6 runs |
| 3 | Optional impact targets not closure-scored | ✅ marked not-closure-scored; 0 optional edited |
| 4 | matplotlib-24627 resolves ≥2/3 **or** failures clearly unrelated to optional-impact demotion | ✅ 2/3 resolved; r1 failure edits correct golds, unrelated to demotion |
| 5 | seaborn-3187 has a clear stability diagnosis | ✅ stable fail / pre-existing localization gap (`utils.py` never surfaced) |
| 6 | No optional impact target edited in passing runs | ✅ 0 optional edits in r2/r3 (and all runs) |
| 7 | No off-target edit increase attributable to optional-impact demotion | ✅ off-target edits == the correct golds, consistent with M62C; reps never edited |

**All 7 criteria PASS.**

## Verdict
**PASS.**

The M65B resolution dip on matplotlib-24627 was ordinary live (retrieval + agent) variance, not a treatment/regression signal: under the identical post-M65 optional-impact treatment, matplotlib-24627 resolved in 2/3 replicates with all replicates reproducing the M62C passing edit shape, and the demoted optional impact reps were never edited. seaborn-3187 is a *stable* failure driven by a pre-existing second-gold localization gap, independent of the optional-impact rule. The M65 invariant (no required IMPACT targets; optional impact context non-scored and unedited) held in 6/6 runs with 0 invalid rule-outs.

## Recommendation
**Proceed to 24-task live repeat with M65.** The optional-impact demotion is structurally sound and resolution-stable on the two known unstable cases: the matplotlib win is reproducible (2/3) and the seaborn failure is a pre-existing localization limitation, not a demotion-induced regression. No retrieval/pivot fix is required as a precondition, though seaborn's second-gold (`utils.py`) localization gap remains the standing open work for a separate retrieval milestone.

---

### Interpretation guardrails
Acceptable claims only: M65C showed matplotlib-24627 resolved in 2/3 replicates; M65C showed seaborn-3187 resolved in 0/3 replicates; the optional-impact invariant held in 6/6 runs; failures were **not** attributable to optional-impact demotion. No VTRACE/VEXP parity, no broad SWE-bench pass@1 improvement, and no statistical-superiority claims are made.

### Artifacts
- Compact summary: `stage5_m65c_optional_impact_variance_replicates.json`
- Per-replicate detail: `stage5_m65c_optional_impact_variance_replicates.detail.json`
- Pre-flight: `stage5_m65c_preflight.json` (`run_stage5_m65c_preflight.ts`)
- Metrics extractor: `run_stage5_m65c_analyze.ts`
- Raw run artifacts (untracked): `results/runs/m65c_optional_impact_variance_*`
