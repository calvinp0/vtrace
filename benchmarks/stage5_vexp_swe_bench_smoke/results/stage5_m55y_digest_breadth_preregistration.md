# Stage 5 M55Y Capsule v2 Digest Breadth Preregistration

**Planning / report-only.** No live agents, no Docker, no API spend were used to
produce this document, and none are authorized by this milestone. It pre-registers a
24-task breadth run to test whether `--inject-capsule-digest` (the M55 Capsule v2
product digest, wired into Stage 5 by M55W `cbe57f3`) generalizes the
context-to-action / resolution signal observed in the M55X 4-case A/B (`c38e62e`).

The selection, run matrix, metrics, validity rule, and pass/mixed/fail/invalid
criteria below are **fixed in advance** so the eventual run cannot be re-scoped to its
own result. The compact machine-readable selection lives in
`stage5_m55y_digest_breadth_preregistration.json`.

## Summary

- **Selected tasks:** 24 (target was 24; range 20–30).
- **Repositories:** 11 — django (5), sympy (4), astropy (4), matplotlib (3),
  requests (2), sphinx (1), seaborn (1), xarray (1), pylint (1), flask (1),
  pytest (1). No repo exceeds the 5-task cap.
- **Category counts:** A hidden-pivot/context-to-action = 6 · B
  high-overhead/navigation-heavy = 4 · C normal/control = 5 · D
  retrieved-but-didn't-act / over-anchor-risk = 3 · E baseline-strong control = 6.
- **cross_repo_30 tasks:** 19 (requirement ≥ 8).
- **Prior baseline artifacts reusable:** 21 (requirement ≥ 8). **Fresh baselines
  needed:** 3 (`django-11820`, `astropy-14598`, `pytest-7432`).
- **Planned new live runs:** **27** = 24 digest + 3 fresh baselines. **Expected
  Docker evals:** 27. Both well under the 60-run cap; matches the preferred limit
  ("24 digest runs + only missing fresh baselines"). **No replicates planned** (see
  Live-run budget).
- **Primary hypothesis:** injecting the Capsule v2 digest improves
  hidden-pivot/context-to-action outcomes across a broader task set **without
  unacceptable token/cost regression** (defined below).
- **Non-claims:** not a public SWE-bench score; not a VTRACE-vs-VEXP claim; 24 tasks
  with single digest runs vs reused/fresh baselines cannot support a broad pass-rate
  claim; observed differences come from the injected product output + agent behavior,
  not from any retrieval/scoring/ranking change.

## Selection Method

### Candidate sources inspected (read-only)

- `stage5_m55x_capsule_v2_digest_live_ab.{md,json}` — the 4 locked sentinel cases and
  their measured digest behavior.
- `stage5_localization_gap_candidate_audit.md` + `stage5_localization_gap_live_comparison.md`
  — which cases have a genuine localization gap vs. a traceback that pre-localizes the
  gold file; the pre-digest live evidence that the plain capsule surfaced sphinx-7462's
  hidden `ast.py` pivot but the agent did not act on it.
- `stage5_edit_relevant_hidden_pivot_candidates.{md,json}` — tiered hidden-pivot
  candidates (Tier-1/2 gold-overlapping) and rule-out controls (hidden pivot NOT in
  gold — the over-anchor tests).
- `retrieval_eval.cross_repo.30.json` — the 30-instance cross-repo retrieval fixture.
- `results/runs/*/raw/baseline/{swebench-*.jsonl,_eval.meta.json}` — which instances
  have a reusable, Docker-evaluated baseline on the same model/harness.
- `$VEXP/data/swe-bench-100.jsonl` — repo + gold patch files (gold used for
  selection/scoring only, never as agent input).

### Filtering rules (applied in order)

1. **Lock** the 4 M55X cases as fixed sentinel anchors.
2. **Require category balance** across A–E with explicit minimums (≥4 hidden-pivot,
   ≥4 baseline-strong controls, ≥6 cases whose gold is not trivially traceback-named).
3. **Prefer reusable baselines** to stay inside the run budget; only spend a fresh
   baseline where no comparable evaluated artifact exists.
4. **Enforce diversity:** ≥8 repos; ≤5 tasks per repo.
5. **Prefer cross_repo_30 membership** so the deterministic retrieval signal is known
   for most tasks (19/24).

### Exclusion rules

- Excluded `sklearn-10844/11578`, `pytest-10051/5262`, `xarray-2905`, `requests-1724`,
  `mpl-24970`, `sphinx-7910/9230`, `sympy-15599` despite cross_repo membership: each
  would have required a fresh baseline and/or duplicated a category already covered,
  and adding them would have pushed django/astropy/sympy past balance without new
  signal. (pytest-7432 was kept over the other pytest cases purely for the 11th repo.)
- Excluded corrective/revision/oracle-related labels entirely (out of scope).

### Anti-cherry-picking safeguards

- The set is **category-balanced, not outcome-balanced**: it deliberately includes 6
  baseline-strong controls (E) and 3 over-anchor rule-outs (D) where the digest is
  *expected to show no win or a possible regression*, plus 3 known prior regressions
  (sympy-12419, astropy-14539, pylint-8898). Selection reasons were written **before**
  any new run and reference only prior artifacts / deterministic signals.
- No task was chosen for an expected pass. The 3 known-regression cases and the
  retrieval-misses (pylint-8898, astropy-14598) bias the set *against* an easy digest
  win.

## Selected Instances

Legend — category: A hidden-pivot/context-to-action · B high-overhead/nav-heavy ·
C normal/control · D retrieved-but-didn't-act/over-anchor · E baseline-strong.
"hidden pivot?" yes = gold-overlapping hidden pivot confirmed; suspected = tier-2 /
rule-out proxy. CR30 = in cross_repo_30.

| # | instance_id | repo | cat | CR30 | prior baseline | prior vtrace | hidden pivot? | selection reason (short) |
|---|---|---|---|---|---|---|---|---|
| 1 | sphinx-doc__sphinx-7462 | sphinx | A | ✓ | reused | ✓ | yes | LOCKED; Tier-1 hidden `ast.py::unparse`; digest-attributable resolution in M55X |
| 2 | matplotlib__matplotlib-22719 | matplotlib | A | ✓ | reused | ✓ | yes | LOCKED; symptom≠cause deprecation decoy; gold `category.py` is a buried frame |
| 3 | matplotlib__matplotlib-24627 | matplotlib | A | ✓ | reused | ✓ | yes | LOCKED; no-traceback cla/clf ambiguity; over-anchor watch (M55X pivots off-target) |
| 4 | mwaskom__seaborn-3187 | seaborn | A | ✓ | reused | ✓ | yes | LOCKED; 2-gold (scales.py+utils.py); digest edited both, resolved |
| 5 | sympy__sympy-13372 | sympy | A | ✓ | reused | – | suspected | Tier-2 hidden `evalf.py`; traceback may pre-localize → decoy/over-anchor test |
| 6 | django__django-11820 | django | A | – | **fresh** | ✓ | suspected | Tier-2 hidden `base.py::_check_ordering`; non-CR django hidden-pivot |
| 7 | pydata__xarray-3677 | xarray | B | ✓ | reused | ✓ | no | Nav-heavy; tests redundant-read/cache cut (M55X repeated-reads signal) |
| 8 | sympy__sympy-12419 | sympy | B | ✓ | reused | ✓ | no | Nav-heavy; known genuine regression — recovery/worsening control |
| 9 | astropy__astropy-14539 | astropy | B | ✓ | reused | ✓ | no | Nav-heavy; known genuine regression — recovery control |
| 10 | pylint-dev__pylint-8898 | pylint | B | ✓ | reused | ✓ | no | Retrieval misses gold (vtrace weak) + known regression; over-anchor-when-poor test |
| 11 | sympy__sympy-12481 | sympy | C | ✓ | reused | – | no | Normal localization (gold@top1); neutral-on-easy control |
| 12 | psf__requests-1142 | requests | C | ✓ | reused | – | no | Normal localization; small/low-overhead control |
| 13 | astropy__astropy-14365 | astropy | C | ✓ | reused | – | no | Normal localization control |
| 14 | matplotlib__matplotlib-25960 | matplotlib | C | ✓ | reused | – | no | Normal control; 3rd matplotlib within-repo datapoint |
| 15 | pytest-dev__pytest-7432 | pytest | C | ✓ | **fresh** | – | no | Normal control + 11th repo (pytest) |
| 16 | pallets__flask-5014 | flask | D | ✓ | reused | – | suspected | Over-anchor rule-out: hidden `app.py` NOT gold (`blueprints.py`) |
| 17 | django__django-13195 | django | D | – | reused | ✓ | suspected | Over-anchor rule-out: hidden `signed_cookies.py` NOT gold; 3-file gold |
| 18 | astropy__astropy-14598 | astropy | D | ✓ | **fresh** | – | suspected | Over-anchor rule-out: retrieval MISSES gold `card.py` |
| 19 | sympy__sympy-16766 | sympy | E | ✓ | reused | ✓ | suspected | Baseline-strong (resolved+localized `pycode.py`); no-hurt control |
| 20 | astropy__astropy-14369 | astropy | E | ✓ | reused | ✓ | suspected | Baseline localized but patch FAILED; localize-but-fail control |
| 21 | django__django-10880 | django | E | – | reused | ✓ | no | Baseline-strong (resolved+localized `aggregates.py`) |
| 22 | django__django-11095 | django | E | – | reused | ✓ | no | Baseline-strong (resolved+localized `admin/options.py`) |
| 23 | psf__requests-5414 | requests | E | ✓ | reused | ✓ | suspected | Baseline-strong (`models.py`) + rule-out hidden `api.py` — double control |
| 24 | django__django-11740 | django | E | – | reused | ✓ | suspected | Baseline-strong (`autodetector.py`) + tier-2 hidden |

Full per-instance fields (safe id, exact run labels, baseline label hints, gold
context flags) are in the JSON fixture.

## Planned Run Matrix

Every task gets one **digest** run (condition B). Baseline (condition A) is reused
where an evaluated artifact exists, else run fresh. Both conditions are
Docker-evaluated; reused baselines keep their existing eval.

| baseline disposition | count | instances |
|---|---|---|
| reused (evaluated artifact exists) | 21 | all except the three below |
| fresh (no comparable baseline) | 3 | django-11820, astropy-14598, pytest-7432 |
| digest (always new) | 24 | all |

| condition | new live runs | docker evals |
|---|---|---|
| digest (B) | 24 | 24 |
| fresh baseline (A) | 3 | 3 |
| reused baseline (A) | 0 | 0 (already evaluated) |
| **total** | **27** | **27** |

Reused-baseline label hints (per instance) are in the fixture; e.g.
`eval-bounded-baseline-sphinx-7462-r{1,2,3}`,
`eval-m4r1-baseline-matplotlib-22719-r{1,2,3}`,
`eval-bounded20-baseline-sympy-13372-r{1,2,3}`. At run time, resolve each to its
most-recent **evaluated** baseline replicate for that instance under
`results/runs/`; if a hinted label is absent or unevaluated, fall back to another
evaluated replicate or run fresh (and recount against the 60-run cap).

## Command Templates

Run sequentially (live runs share `results/_agent_stream.jsonl`; concurrent runs
clobber it). `SAFE` = substring after `__` with `-`→`_` (e.g.
`sphinx-doc__sphinx-7462` → `sphinx_7462`).

**Digest run (condition B):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m55y_vtrace_digest_<SAFE> \
  --show-vtrace-index-log \
  --context-policy force-inject \
  --capsule-engine v2 \
  --capsule-intent debug \
  --capsule-budget 8000 \
  --inject-capsule-digest \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Fresh baseline run (condition A — only the 3 missing instances):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol \
  --protocol baseline \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m55y_baseline_<SAFE> \
  --show-vtrace-index-log \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Docker evaluation (per produced patch — existing flow, do not invent a new evaluator):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --run-label <LABEL> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```
(`--eval-mode docker` is the only real resolution signal; this is exactly the flow
M55X used and confirmed `dockerUsed=true`.)

**Artifact paths** (per labelled run, as in M55X):
`results/runs/<label>/raw/vtrace/` (or `/raw/baseline/`) holds `swebench-*.jsonl`,
`_run.meta.json`, `_tool_calls.json`, `_tool_calls.summary.json`,
`_capsule_v2_context.md`, `_eval.meta.json`; the per-run injected snapshot is at the
**run-dir root** `results/runs/<label>/_vtrace_instructions.snapshot.md` (NOT the
shared `results/_vtrace_instructions.md`, which is overwritten each run).

## Metrics and Scoring

### Exact metrics to extract (per run)

`instance_id, repo, category, selection_reason, condition, run_label,
baseline_source(reused|fresh), digest_valid, invalid_reason, patch_produced,
resolved, cost, duration_ms, input_tokens_total, output_tokens_total,
cache_read_tokens_total, cache_write_tokens_total, total_tokens, turn_count,
tool_call_count, read_count, search_count, edit_count, repeated_file_reads,
digest_pivot_count, digest_support_count, digest_skeleton_count,
digest_warning_count, lead_pivot_path, lead_pivot_inspected, lead_pivot_edited,
hidden_or_non_traceback_pivot_present, hidden_or_non_traceback_pivot_inspected,
hidden_or_non_traceback_pivot_edited, edited_files,
edited_files_overlap_with_pivots`.

The M55X extractor (`/tmp/m55x_extract.ts` pattern) already computes all of these from
`swebench-*.jsonl` + `_tool_calls.json` + the per-run snapshot and is the intended
basis; the digest-glyph parser must match `●/○` **anywhere on a line** (the first
pivot is glued to the end of the problem-statement paragraph).

### Digest validity rule

A digest run is **valid only if** its per-run
`_vtrace_instructions.snapshot.md` contains **both**
`<VTRACE_CAPSULE_V2_DIGEST_START>` and `<VTRACE_CAPSULE_V2_DIGEST_END>`. Generic
markers (`●`, `○`, `budget:`) are **not** sufficient. A run missing either sentinel
is marked `invalid_reason = m55_digest_not_present` and excluded from digest
deltas. (A cheap pre-flight via `prepareIndexedContext` into a temp out-dir, as in
M55X, should confirm the sentinel for at least one case before the batch.)

### Pivot inspection classification (from ordered tool telemetry)

Per important pivot: `discovered` (appears in digest/search only) → `inspected`
(Read/open of the path) → `edited` (Edit/Write of the path); `edited_without_inspection`
(edit with no prior read), `ruled_out` (explicit rejection after reading),
`ignored` (in digest, never read/edited/rejected). Lead pivot = first `●` pivot;
hidden/non-traceback pivot = a distinct-file `●` pivot after the lead.

### Paired delta calculations

For each instance, compute digest − baseline using the baseline **median across
reused replicates** (range reported) or the single fresh baseline. Report per-metric:
`delta`, `pct`. Aggregate across the set as **pooled** (sum digest / sum baseline),
**mean of per-case deltas**, and **median of per-case deltas** for: total_tokens,
cache_read_tokens, cost, tool_call_count, read_count, search_count,
repeated_file_reads. Resolution is reported as counts, not deltas (see below).

### Predefined outcome aggregates

`resolved_count_baseline, resolved_count_digest, both_pass, both_fail,
digest_only_pass, baseline_only_pass`; pooled/mean/median token, cache-read, and cost
deltas; tool-call delta; read/search delta; lead-pivot inspection-rate delta;
hidden-pivot inspection/edit-rate delta. Stratify all of the above by category (A–E)
— the A and D strata are where the hypothesis lives; E is the no-hurt guard.

## Stop Conditions

Abort the batch (and write a status report instead of a results report) if:

- the `vexp-swe-bench` workspace at `/home/calvin/code/vexp-swe-bench` is missing or
  its `data/swe-bench-100.jsonl` is absent;
- the pre-flight (or first digest run) shows the digest sentinel **absent** — fix the
  wiring before spending the batch;
- completing the matrix would require **> 60 new live runs** (e.g. many hinted
  baselines turn out unevaluated and need fresh runs) — reduce the task set instead;
- the Docker evaluator is unavailable (`dockerUsed=false` / `evaluationError`) — do
  not substitute the lightweight evaluator for resolution;
- the raw artifact layout has changed (no `swebench-*.jsonl`, `_tool_calls.json`, or
  run-dir-root snapshot) so the extractor cannot read runs;
- repeated infra errors (API 529 / `api_error_status`) — guard each run and rerun the
  affected label rather than scoring an infra failure as a model result.

## Interpretation Rules

### Acceptable claims

- "The digest improved hidden-pivot inspection/edit rate on X/Y category-A cases."
- "The digest reduced repeated reads / cache-read tokens by X% (pooled) on the
  navigation-heavy stratum."
- "Resolution moved from baseline N to digest M on this 24-task set" — with the
  single-run-vs-replicate variance caveat stated.
- "On the baseline-strong (E) and over-anchor (D) strata the digest did / did not hurt
  resolution or pull edits to non-gold pivots."
- "Retrieval/scoring/ranking were unchanged; differences are from injected product
  output and agent behavior."

### Unacceptable claims

- "VTRACE beats VEXP." · "VTRACE improves SWE-bench pass@1." · "The digest is
  statistically better." · "The digest *caused* a pass" — unless a per-case
  mechanism (digest-surfaced pivot → inspected → edited → resolved, baseline
  structurally could not) supports it, as only sphinx-7462 did in M55X.

### Acceptable token/cost behavior (defined before running)

Cost is **acceptable** if pooled cost regression ≤ **+15%** at equal-or-better pooled
resolution; **or** any larger cost regression is fully accounted for by
**digest-only-pass** cases (i.e. extra spend bought resolutions the baseline did not
get). Cost regression that is *not* offset by digest-only passes and exceeds +15% is
**unacceptable**.

### Verdict criteria

- **PASS** — digest improves resolution **or** context-to-action (hidden-pivot
  inspection/edit rate, esp. strata A+D) on the set, with acceptable token/cost
  behavior, and no resolution regression on the E stratum.
- **MIXED** — digest improves some resolution/context-to-action cases but causes
  enough token/cost regression or over-anchoring (D-stratum edits pulled to non-gold
  pivots, or E-stratum regressions) to require another product change first.
- **FAIL** — digest does not improve context-to-action and does not improve (or hurts)
  resolution, or causes unacceptable cost regression.
- **INVALID** — digest sentinel missing on a material fraction of runs, baselines
  incomparable, or the run matrix incomplete.

## Recommendation

**Ready for explicit authorization to run the M55Y live breadth validation**, with two
conditions carried from M55X:

1. Run a one-case sentinel pre-flight first (offline `prepareIndexedContext` into a
   temp out-dir) to reconfirm the digest sentinel before spending the 27-run batch.
2. Frame the breadth run as confirming the **resolution / hidden-pivot localization**
   signal (the sphinx-7462 mechanism) with category stratification — **not** a uniform
   token/tool-reduction claim, which M55X did not support.

Parallel (does not block authorization, but is the likely highest-value product
change): every M55X digest carried `impact_not_threaded_into_digest`,
`memory_not_threaded_into_digest`, `rules_not_threaded_into_digest`, and on 2/4 M55X
cases the digest's pivots were off-target. Folding impact/memory/rules into the digest
before — or in a second arm of — the breadth run would directly test whether a richer
digest reduces the over-anchoring seen in the D stratum. This preregistration keeps the
digest pivot-only so the breadth result is comparable to M55X.

## Non-claims / provenance

- No live agents, Docker, or API spend in this milestone; no retrieval/scoring/ranking
  /candidate-generation code touched (no retrieval eval required).
- Gold patch files were read only for selection/scoring categorization, never as agent
  input. Category labels and selection reasons were fixed before any new run.
- 24 single digest runs vs reused/fresh baselines is a breadth **measurability** test,
  not a powered benchmark; variance is large (M55X baselines ranged e.g. seaborn cost
  $0.91–$3.05). Replicates are intentionally omitted to stay within budget; if the
  pooled result is borderline, a targeted replicate pass on the A+D strata is the
  documented follow-up rather than a default.
