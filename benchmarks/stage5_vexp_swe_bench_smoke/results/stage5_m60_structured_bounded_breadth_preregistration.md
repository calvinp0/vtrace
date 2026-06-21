# Stage 5 M60 Structured Bounded Digest Breadth Preregistration

**Planning / report-only.** No live agents, no Docker, and no API spend were used to
produce this document, and none are authorized by this milestone. It pre-registers a
**15-task breadth confirmation** of the **structured bounded digest decision contract**
(the M56C → M59B treatment stack) so that the eventual live run cannot be re-scoped to
its own result. The compact machine-readable selection lives in
`stage5_m60_structured_bounded_breadth_preregistration.json`.

The treatment under test is the full structured-bounded condition validated on the
3-case A+D diagnostic set by M59B (`f406290`, verdict PASS):

```
protocol vtrace-indexed · context-policy force-inject · capsule-engine v2 ·
capsule-intent debug · capsule-budget 8000 · inject-capsule-digest ·
digest-decision-contract · bounded-digest-decisions · compact-digest-injection
```

**Main question (frozen):** *Does the structured bounded digest treatment generalize
beyond the 3-case A+D diagnostic set, preserving (a) no resolution regression,
(b) improved or stable context-to-action behavior, (c) low ignored required-target
rate, (d) bounded token/cost behavior, and (e) no over-anchoring increase?*

## Summary

- **Selected tasks:** 15 (preferred target; range 12–18).
- **Repositories:** 11 — django (3), astropy (3), sphinx (1), matplotlib (1),
  seaborn (1), xarray (1), pylint (1), flask (1), requests (1), sympy (1), pytest (1).
  No repo exceeds the 4-task cap; django is present but not dominant (20%).
- **Category counts:** A hidden-pivot/context-to-action = 4 · B
  high-overhead/navigation-heavy = 3 · D retrieved-but-didn't-act/over-anchor = 3 ·
  E baseline-strong control = 3 · C normal control = 2.
- **Locked sentinels:** the 3 M59B diagnostic cases — `sphinx-doc__sphinx-7462` (A),
  `django__django-11820` (A), `django__django-13195` (D) — included as sentinels
  inside the broader set, not as the whole set.
- **Planned new live runs (default):** **15** = 15 treatment runs + **0** fresh
  baselines. Every selected case has a comparable, already-Docker-evaluated baseline
  from M56C (sentinels) or M55Z (the other 12). Well under the 24-run cap.
- **Reused baselines:** 15. **Fresh baselines:** 0 (default), subject to the
  model-match reuse gate (below).
- **Primary hypothesis:** the structured bounded contract generalizes the M59B signal —
  high decision coverage with low ignored rate, no resolution regression vs comparable
  baselines, no off-target-edit increase vs comparable prior VTRACE artifacts, and
  bounded cost.
- **Non-claims:** not a VTRACE-vs-VEXP claim; not a SWE-bench pass@1 claim; not a
  statistical claim; 15 single treatment runs vs reused baselines is a breadth
  **measurability** test, not a powered benchmark. Observed differences come from the
  injected product output + agent behavior, not from any retrieval/scoring/ranking
  change.

## Selection Method

### Candidate sources inspected (read-only)

- `stage5_m55y_digest_breadth_preregistration.{md,json}` — the 24-case category-balanced
  breadth pool, with per-case categories, hidden-pivot flags, and baseline label hints.
- `stage5_m55z_digest_breadth_live_validation.md` — the live execution of that pool: it
  Docker-evaluated a baseline for **all 24** cases (incl. the 3 then-fresh ones) and a
  plain-digest VTRACE run (`m55y_vtrace_digest_*`) per case. This is why every M60
  candidate now has a reusable baseline **and** a comparable prior VTRACE artifact.
- `stage5_m56c_impact_digest_ad_confirmation.md`, `stage5_m57b_…`, `stage5_m58b_…`,
  `stage5_m59b_structured_bounded_decision_live_validation.md` — the treatment lineage
  and the 3 sentinel cases, their M56C baselines (`m56c_baseline_*`), and the structured
  contract's measured behavior (26/27 closed, 0 ignored, bounded cost).
- `stage5_retrieval_eval_cross_repo_30.{md,json}` — deterministic retrieval signal
  (used only to characterize retrieval-weak / retrieval-miss cases; not modified).
- `stage5_outcome_ledger.{md,json}` — per-instance outcome history (read-only).
- `$VEXP/data/swe-bench-100.jsonl` — repo + gold patch files (gold used for
  selection/scoring categorization only, never as agent input).

### Filtering rules (applied in order)

1. **Lock** the 3 M59B cases as fixed sentinel anchors (sphinx-7462, django-11820,
   django-13195).
2. **Require category balance** to the preferred 15-task split (A=4, B=3, D=3, E=3,
   C=2).
3. **Prefer reusable, already-evaluated baselines** to stay far inside the run cap;
   select only from cases that M55Z/M56C already Docker-evaluated, so the default plan
   needs **0** fresh baselines.
4. **Enforce diversity:** ≥7 repos; ≤4 tasks per repo; django present but ≤4; include a
   baseline-strong control for each major high-frequency repo where one exists.
5. **Prefer cases with a comparable prior VTRACE artifact** (`m55y_vtrace_digest_*`,
   plus M57B/M58B/M59B for sentinels) so the off-target-edit no-increase criterion is
   measurable against a like-for-like prior.

### Exclusion rules

- Excluded the remaining 9 M55Y cases (matplotlib-22719, sympy-13372, sympy-12419,
  sympy-12481, requests-1142, matplotlib-25960, django-11095, django-11740,
  astropy-14369): each would have over-filled an already-covered category or pushed
  django/sympy/matplotlib past balance without adding a new repo or a new signal the set
  lacks. (astropy-14369 specifically excluded because its baseline did **not** resolve —
  a weaker E "baseline-strong" anchor than django-10880/sympy-16766/requests-5414.)
- Excluded any corrective / revision / oracle / repair labels entirely (out of scope).
- No case was added that lacks a comparable evaluated baseline (would have forced a
  fresh baseline and risked the cap).

### Anti-cherry-picking safeguards

- The set is **category-balanced, not outcome-balanced.** It deliberately carries cases
  the treatment is *expected to find hard or to show no win on*: django-11820 (localize-
  but-fail, 0/3 historically), pylint-8898 (retrieval misses gold, known regression),
  astropy-14598 (retrieval misses gold), django-13195 (persistent multi-gold over-edit),
  requests-5414 (the single M55Z E-stratum regression), plus 3 baseline-strong E
  no-hurt controls and 2 normal C controls.
- Selection reasons were written from **prior artifacts and deterministic signals only**,
  before any M60 run. No case was chosen for an expected pass.

## Selected Instances

Legend — category: A hidden-pivot/context-to-action · B high-overhead/nav-heavy ·
C normal/control · D retrieved-but-didn't-act/over-anchor · E baseline-strong.
"hidden pivot?": yes = gold-overlapping hidden pivot confirmed; suspected = tier-2 /
rule-out proxy. All baselines reused (see reuse gate); all treatment runs planned;
all evaluations planned (Docker).

| # | instance_id | repo | cat | prior baseline | prior VTRACE/treatment | hidden pivot? | expected condition / selection reason (short) |
|---|---|---|---|---|---|---|---|
| 1 | sphinx-doc__sphinx-7462 | sphinx | A | reused (m56c) | digest+M57/58/59 | yes | **LOCKED**; Tier-1 hidden `ast.py::unparse`; canonical digest-attributable win (M59B 3/3) |
| 2 | django__django-11820 | django | A | reused (m56c) | digest+M57/58/59 | suspected | **LOCKED**; tier-2 `base.py::_check_ordering`; terse rule-outs credited live in M59; localize-but-fail compliance control |
| 3 | matplotlib__matplotlib-24627 | matplotlib | A | reused | digest | yes | Strongest localization gap (no traceback); decoy `figure.py` vs gold `axes/_base.py`; over-anchor/attribution watch |
| 4 | mwaskom__seaborn-3187 | seaborn | A | reused | digest | yes | 2-gold (`scales.py`+`utils.py`); probes M59B multi-gold over-edit question |
| 5 | pydata__xarray-3677 | xarray | B | reused | digest | no | Nav-heavy; the one M55Z case where the agent edited the hidden pivot; redundant-read/cache control |
| 6 | astropy__astropy-14539 | astropy | B | reused | digest | no | Nav-heavy known-regression recovery; baseline resolved → astropy no-hurt anchor; big M55Z efficiency win |
| 7 | pylint-dev__pylint-8898 | pylint | B | reused | digest | no | Retrieval misses gold (vtrace weak) + known regression; over-anchor-when-poor test |
| 8 | django__django-13195 | django | D | reused (m56c) | digest+M57/58/59 | suspected | **LOCKED**; over-anchor multi-gold; persistent 2-file over-edit; M59B variance case |
| 9 | pallets__flask-5014 | flask | D | reused | digest | suspected | Over-anchor rule-out: hidden `app.py` NOT gold (`blueprints.py`) |
| 10 | astropy__astropy-14598 | astropy | D | reused | digest | suspected | Over-anchor rule-out with WRONG retrieval (misses gold `card.py`) |
| 11 | django__django-10880 | django | E | reused | digest | no | Baseline-strong (resolved+localized `aggregates.py`); django no-hurt control |
| 12 | psf__requests-5414 | requests | E | reused | digest | suspected | Baseline-strong (`models.py`) + rule-out (`api.py` NOT gold); the M55Z E-regression no-hurt sentinel |
| 13 | sympy__sympy-16766 | sympy | E | reused | digest | suspected | Baseline-strong (resolved+localized `pycode.py`); sympy no-hurt control |
| 14 | astropy__astropy-14365 | astropy | C | reused | digest | no | Normal localization control; balances the two hard astropy cases |
| 15 | pytest-dev__pytest-7432 | pytest | C | reused | digest | no | Normal control + repo diversity (pytest); baseline resolved |

Full per-instance fields (safe id, exact run labels, baseline label hints, prior-artifact
lists) are in the JSON fixture.

## Planned Run Matrix

Every task gets one **structured-bounded treatment** run; the baseline is **reused** from
an already-evaluated comparable artifact. Both arms are Docker-evaluated; reused baselines
keep their existing eval.

| baseline disposition | count | instances |
|---|---|---|
| reused — M56C comparator (sentinels) | 3 | sphinx-7462, django-11820, django-13195 |
| reused — M55Z evaluated baseline | 12 | the other 12 |
| **fresh (default)** | **0** | — |
| treatment (always new) | 15 | all |

| condition | new live runs | docker evals |
|---|---|---|
| structured-bounded treatment | 15 | 15 |
| reused baseline | 0 | 0 (already evaluated) |
| **total (default)** | **15** | **15** |

Per-instance baseline label hints (from M55Z / M56C):

| instance | reused baseline label hint |
|---|---|
| sphinx-doc__sphinx-7462 | `m56c_baseline_sphinx_7462` |
| django__django-11820 | `m56c_baseline_django_11820` |
| django__django-13195 | `m56c_baseline_django_13195` |
| matplotlib__matplotlib-24627 | `eval-bounded-baseline-mpl-24627-r{1..4}` |
| mwaskom__seaborn-3187 | `eval-bounded20-baseline-seaborn-3187-r{1..6}` |
| pydata__xarray-3677 | `eval-m32-product-baseline-xarray-3677-r{1..5}` |
| astropy__astropy-14539 | `eval-bounded20-baseline-astropy-14539-r{1,2,3}` |
| pylint-dev__pylint-8898 | `eval-bounded20-baseline-pylint-8898-r{1,2,3}` |
| pallets__flask-5014 | `eval-bounded-baseline-flask-5014-r{1,2,3}` |
| astropy__astropy-14598 | `m55y_baseline_astropy_14598` (M55Z fresh, now reusable) |
| django__django-10880 | `eval-m32-product-baseline-django-10880-r{1..5}` |
| psf__requests-5414 | `eval-baseline-vs-vtrace-baseline-requests-5414-r{1..4}` |
| sympy__sympy-16766 | `eval-bounded-baseline-sympy-16766-r{1..4}` |
| astropy__astropy-14365 | `eval-bounded20-baseline-astropy-14365-r{1,2,3}` |
| pytest-dev__pytest-7432 | `m55y_baseline_pytest_7432` (M55Z fresh, now reusable) |

At run time resolve each hint to its most-recent **evaluated** replicate under
`results/runs/`. **Baseline reuse gate:** a hint is only comparable if its
`_run.meta.json` records the **same model** as the live M60 treatment run (the runner
does not override the model, so this checks for vexp-swe-bench default drift since
M55Z/M56C), same harness family, and a present Docker `_eval.meta.json`. If the gate
fails for a non-sentinel case, run a **fresh** baseline `m60_baseline_<SAFE>` for it —
prioritizing A+D cases — keeping total new live runs ≤ 24 (15 treatment + up to 9
fresh); if more than 9 would be needed, **reduce the set** rather than exceed the cap.

## Command Templates

Run sequentially (live runs share `results/_agent_stream.jsonl`; concurrent runs clobber
it). `SAFE` = substring after `__` with `-`→`_` (e.g. `sphinx-doc__sphinx-7462` →
`sphinx_7462`).

**Structured-bounded treatment run:**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m60_structured_bounded_<SAFE> \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --inject-capsule-digest \
  --digest-decision-contract \
  --bounded-digest-decisions \
  --compact-digest-injection \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Fresh baseline run (only if the reuse gate fails for a case):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol baseline \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m60_baseline_<SAFE> \
  --show-vtrace-index-log \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Docker evaluation (per produced patch — existing flow; do not invent a new evaluator):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --run-label <LABEL> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Artifact paths** (per labelled run): `results/runs/<label>/raw/vtrace/` (or
`/raw/baseline/`) holds `swebench-*.jsonl`, `_run.meta.json`, `_tool_calls.json`,
`_tool_calls.summary.json`, `_capsule_v2_context.md`, `_eval.meta.json`; the per-run
injected snapshot is at the **run-dir root**
`results/runs/<label>/_vtrace_instructions.snapshot.md` (NOT the shared
`results/_vtrace_instructions.md`, which is overwritten each run).

## Pre-flight Plan

The live milestone must first perform a **non-agent** pre-flight on **every** selected
treatment case (re-render the case's real injected context with current code into a
throwaway out-dir, as M59B did — no agent, no Docker, no spend), and then additionally
gate each live run on its own emitted snapshot before counting it valid.

Pre-flight must confirm, per case:

- **digest sentinel exactly once** — `<VTRACE_CAPSULE_V2_DIGEST_START>` /
  `<VTRACE_CAPSULE_V2_DIGEST_END>` (START=1, END=1);
- **decision-contract sentinel exactly once** —
  `<VTRACE_DIGEST_DECISION_CONTRACT_START>` /
  `<VTRACE_DIGEST_DECISION_CONTRACT_END>` (START=1, END=1);
- **real, non-warning impact section** (`→ impact` with content, not a warning-only
  placeholder);
- **structured grammar present** — `target_id` / `target` / `decision` / `reason` /
  `files_touched` fields;
- **target_id present and stable** (`T1…Tn`, unique);
- **required-target count > 0 and ≤ 4**;
- **compact mode applied** (`## VTRACE inspect-first` absent);
- **memory/rules warnings honest** — if no DB data exists, the warnings are present and
  not fabricated.

If any pre-flight item fails for a case, that case is **not run** (or is fixed at the
harness level first); the batch does not start on a failing sentinel.

## Metrics and Scoring

### Exact metrics to extract (per run)

```
instance_id, repo, category, selection_reason, condition, run_label,
baseline_source(reused|fresh), valid_run, invalid_reason, patch_produced, resolved,
cost, duration_ms, input_tokens_total, output_tokens_total, cache_read_tokens_total,
cache_write_tokens_total, total_tokens, turn_count, tool_call_count, read_count,
search_count, edit_count, repeated_file_reads,

digest_present, impact_present, decision_contract_present, structured_grammar_present,
bounded_contract_present, compact_mode_applied,

required_target_count, required_targets, required_target_edited_count,
required_target_ruled_out_count, required_target_inspect_only_no_edit_count,
required_target_ignored_count, required_target_invalid_decision_count,
required_target_closed_count, required_target_open_count, decision_coverage,
ignored_rate,

lead_pivot_path, lead_pivot_inspected, lead_pivot_edited,
hidden_or_non_traceback_pivot_present, hidden_or_non_traceback_pivot_inspected,
hidden_or_non_traceback_pivot_edited,
impact_representative_paths, impact_representative_inspected,
impact_representative_edited,
optional_context_targets, optional_context_inspected, optional_context_edited,

edited_files, edited_files_overlap_with_pivots, edited_files_overlap_with_impact,
edited_files_overlap_with_required_targets, off_target_edit_count
```

`total_tokens = input + output + cache_read + cache_creation` (matching
M56C/M57B/M58B/M59B). The M58B/M59B extractor + analyze pattern
(`run_stage5_m58b_analyze.ts` → `run_stage5_m59b_report.py`) already computes these from
`swebench-*.jsonl` + `_tool_calls.json` + the per-run snapshot, and is the intended
basis.

### Validity rule

A treatment run is **valid only if** its per-run `_vtrace_instructions.snapshot.md`
contains **all four** sentinels (digest START+END and decision-contract START+END),
**plus** a real non-warning impact section, the structured grammar, a required-target
count in `[1,4]`, and compact mode applied. Any run missing one is marked with the
specific `invalid_reason` and excluded from treatment deltas.

### Decision classifier

`src/capsuleV2/pivotInspectionCompliance.ts` →
`classifyDigestDecisionContract` (the current/M59 structured-table parser with the
closed/open partition). Each required target is classified
`EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT | IGNORED | INVALID`; **closed** =
edited ∪ ruled-out ∪ inspect-only-no-edit (a credited decision), **open** =
ignored ∪ invalid. `decision_coverage = closed / required_target_count`;
`ignored_rate = ignored / required_target_count`.

### Paired delta calculations

For each instance compute treatment − baseline using the baseline **median across reused
replicates** (range reported), or the single fresh baseline if the reuse gate forced one.
Per metric report `delta` and `pct`. Aggregate across the set as **pooled** (Σ treatment
/ Σ baseline), **mean of per-case deltas**, and **median of per-case deltas** for:
total_tokens, cache_read_tokens, cost, tool_call_count, read_count, search_count,
repeated_file_reads. Resolution is reported as counts (`resolved_count_baseline`,
`resolved_count_treatment`, `both_pass`, `both_fail`, `treatment_only_pass`,
`baseline_only_pass`), not as a delta. Off-target edits are compared against the
**comparable prior VTRACE artifact** (`m55y_vtrace_digest_*`; M57B/M58B/M59B for
sentinels) as well as against the baseline. Stratify all aggregates by category (A–E).

## Success / Mixed / Fail / Invalid Criteria

### Primary success criteria (PASS requires ALL)

1. treatment valid in all or nearly all selected runs;
2. resolution not worse than comparable baseline;
3. required-target **ignored rate ≤ 5%**;
4. required-target **decision coverage ≥ 90%**;
5. **no increase in off-target edits** vs comparable prior VTRACE artifacts;
6. **pooled cost regression vs comparable baseline ≤ +15%**.

A result may still be considered **favorable** if cost regresses slightly but
resolution improves materially **and** the added cost is concentrated in digest-only
resolved cases.

### Secondary criteria (also reported, not gating)

hidden-pivot inspection/edit delta · impact-representative inspection/edit delta ·
repeated-read delta · tool-call delta · cache-read token delta · category-stratified
outcomes · baseline-strong (E) control no-hurt rate.

### Verdict thresholds

- **INVALID** — sentinel/contract/impact missing, artifact matrix incomplete, or metrics
  not extractable.
- **FAIL** — resolution worse than baseline; OR ignored required-target rate > 10%; OR
  decision coverage < 80%; OR pooled cost regression > 25% without resolution
  improvement; OR over-anchoring / off-target edits increase on the E controls.
- **MIXED** — resolution or action improves, but cost / compliance / over-edit behavior
  remains unstable.
- **PASS** — no resolution regression, high decision coverage, low ignored rate, bounded
  cost, and no over-anchoring increase.

### No-claim boundaries

The breadth result may support claims about *this 15-task set* (validity, decision
coverage, ignored rate, off-target-edit non-increase, bounded cost, category-stratified
behavior, and per-case digest-attributable mechanisms). It may **not** support
VTRACE-vs-VEXP, SWE-bench pass@1, or any statistical-superiority claim (single treatment
run per case vs reused/best-of-N baselines).

## Stop Conditions

Abort the batch (and write a status report instead of a results report) if:

- the `vexp-swe-bench` workspace at `/home/calvin/code/vexp-swe-bench` is missing or its
  `data/swe-bench-100.jsonl` is absent;
- completing the matrix would require **> 24 new live runs** (e.g. the reuse gate fails
  widely) — reduce the task set instead;
- the **digest sentinel is absent** in pre-flight or the first treatment run — fix the
  wiring before spending;
- the **decision-contract sentinel is absent** in pre-flight / first run;
- the **impact section is warning-only** (no real impact) for a material fraction of
  cases;
- the **Docker evaluator is unavailable** (`dockerUsed=false` / `evaluationError`) — do
  not substitute the lightweight evaluator for resolution;
- the **raw artifact layout changed** (no `swebench-*.jsonl`, `_tool_calls.json`, or
  run-dir-root snapshot) so the extractor cannot read runs;
- repeated infra errors (API 529 / `api_error_status`) — guard each run and rerun the
  affected label rather than scoring an infra failure as a model result.

## Recommendation

**Ready for explicit authorization to run the M60 live breadth validation**, with the
M59B carry-forward conditions:

1. Run the non-agent pre-flight on all 15 cases first (re-render + four-sentinel +
   structured-grammar + required-target-count + compact checks); start the batch only
   after all 15 pass.
2. Apply the **baseline reuse gate** (model-match) before crediting any reused baseline;
   convert only the failing cases to fresh baselines, prioritizing A+D, and never exceed
   the 24-run cap.
3. Frame the breadth run as confirming **decision compliance + non-harm + bounded cost
   generalization** (the M59B mechanism) with category stratification — **not** a uniform
   resolution-improvement or token-reduction claim, neither of which the diagnostic set
   supported.
4. Do **not** promote the structured bounded contract to a Stage 5 default on the basis
   of this run, and do **not** tune for sphinx.

Two open questions this set is specifically positioned to answer (carried from M59B):
the **persistent multi-gold over-edit** (django-13195, seaborn-3187) and the
**hidden-pivot / second-edit-site action ceiling** (matplotlib-24627, xarray-3677,
django-11820). Neither is in scope to *fix* here; the breadth run measures them so a
later milestone can target the right lever (pivot-inspection enforcement, not more
contract wording).

## Non-claims / provenance

- No live agents, Docker, or API spend in this milestone; no
  retrieval/scoring/ranking/candidate-generation code touched (no retrieval eval
  required).
- Gold patch files were read only for selection/scoring categorization, never as agent
  input. Category labels and selection reasons were fixed before any new run.
- 15 single treatment runs vs reused baselines is a breadth **measurability** test, not a
  powered benchmark; variance is large. Replicates are intentionally omitted to stay
  within budget; if the pooled result is borderline, a targeted replicate pass on the
  A+D strata is the documented follow-up rather than a default.

**This preregistration does not claim VTRACE beats VEXP. It does not claim SWE-bench
pass@1 improvement. It does not make a statistical claim. It only freezes a targeted
validation plan.**
