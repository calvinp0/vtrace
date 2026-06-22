# Stage 5 M62 Structured Bounded 24-Task Preregistration

Frozen plan for a 24-task live confirmation of the structured bounded digest-decision-contract
treatment (the M56C→M59 stack, validated on the 15-task breadth set in M60B/M60C with the M61
atomic-truncation fix). **Planning/report-only — no live agents, no Docker, no API spend, no
24-task run.** Treatment = `vtrace-indexed · force-inject · v2 · debug · 8000 ·
inject-capsule-digest · digest-decision-contract · bounded-digest-decisions ·
compact-digest-injection`. Model `claude-opus-4-5-20251101` (vexp default; runner does not
override). Fixture: `stage5_m62_structured_bounded_24_preregistration.json`.

## Summary

- **Selected task count:** 24 (the original M55Y preregistered set, verbatim).
- **Repo count:** 11.
- **Category counts:** A=6, B=4, C=5, D=3, E=6.
- **Planned new live runs:** **21 treatment** (the 21 cases that pass the offline pre-flight
  replay) — under the 24-run cap. **0 fresh baselines** by default.
- **Reused baselines:** 24 planned (M60B baselines for the 15 M60 cases; M55Z baselines for
  the 9 additional cases) — all recorded `opus-4-5`, model-match expected (confirm at run time).
- **Known/expected skipped cases:** **3 FAIL_CLOSED_OMITTED** (over-budget at 12k):
  `pylint-dev__pylint-8898` (digest+contract 12,803), `sympy__sympy-12419` (12,659),
  `matplotlib__matplotlib-22719` (12,049). Skipped unless pre-flight becomes VALID.
- **Primary hypothesis:** On a broader 24-task set, the structured bounded treatment remains
  **valid in (nearly) all attempted runs**, **does not regress resolution** vs comparable
  baselines, keeps **decision coverage ≥ 90% / ignored ≤ 5%**, and stays **cost-bounded
  (≤ +15% pooled)** — i.e. M60B/M60C's favorable result generalizes beyond the 15-task set.
- **Non-claims:** does not claim VTRACE beats VEXP; does not claim SWE-bench pass@1
  improvement; makes no statistical claim; only freezes a targeted 24-task validation plan.

## Selection Method

- **Why the M55Y 24-task set is reused:** It was pre-registered (M55Y) **before** the
  structured bounded treatment existed, so it cannot be cherry-picked to favor the treatment.
  It has broad repo/category coverage (11 repos; A/B/C/D/E all represented) and gives direct
  continuity with the M55Z digest baseline and the M60/M60B/M60C lineage (the 15-task set is a
  strict subset of these 24).
- **Anti-cherry-picking rationale:** The 24 = **all 15 M60 tasks** (already validated twice)
  **+ the 9 M55Y tasks not in M60**. The 9 additions were chosen by M55Y, not by M60C
  outcomes, so they are a genuine out-of-(M60)-sample test. No task was added because the
  treatment did well on it; none was dropped because it did poorly.
- **Exclusions or replacements:** None. All 24 M55Y instances are present in the dataset
  (`swe-bench-100.jsonl`) and every one has a persisted workspace index (so the offline
  pre-flight replay could run on all 24). No silent replacement was needed; the
  `cross_repo_30` fallback was not invoked.

## Selected Instances

`in_M60?` = was in the 15-task M60/M60B/M60C set. `prior baseline?` = a reused comparable
baseline exists. `known preflight` = offline post-M61 replay status (this milestone).

| instance_id | repo | category | in_M60? | prior baseline? | known preflight | expected run condition |
|---|---|---|---|---|---|---|
| django__django-11820 | django/django | A | yes | yes | VALID | treatment_live |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | A | yes | yes | VALID | treatment_live |
| mwaskom__seaborn-3187 | mwaskom/seaborn | A | yes | yes | VALID | treatment_live |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | A | yes | yes | VALID | treatment_live |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | A | no | yes | **FAIL_CLOSED_OMITTED** | skip (pending pre-flight) |
| sympy__sympy-13372 | sympy/sympy | A | no | yes | VALID | treatment_live |
| astropy__astropy-14539 | astropy/astropy | B | yes | yes | VALID | treatment_live |
| pydata__xarray-3677 | pydata/xarray | B | yes | yes | VALID | treatment_live |
| pylint-dev__pylint-8898 | pylint-dev/pylint | B | yes | yes | **FAIL_CLOSED_OMITTED** | skip (pending pre-flight) |
| sympy__sympy-12419 | sympy/sympy | B | no | yes | **FAIL_CLOSED_OMITTED** | skip (pending pre-flight) |
| astropy__astropy-14365 | astropy/astropy | C | yes | yes | VALID | treatment_live |
| pytest-dev__pytest-7432 | pytest-dev/pytest | C | yes | yes | VALID | treatment_live |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | C | no | yes | VALID (near-budget) | treatment_live |
| psf__requests-1142 | psf/requests | C | no | yes | VALID | treatment_live |
| sympy__sympy-12481 | sympy/sympy | C | no | yes | VALID | treatment_live |
| astropy__astropy-14598 | astropy/astropy | D | yes | yes | VALID | treatment_live |
| django__django-13195 | django/django | D | yes | yes | VALID | treatment_live |
| pallets__flask-5014 | pallets/flask | D | yes | yes | VALID | treatment_live |
| django__django-10880 | django/django | E | yes | yes | VALID | treatment_live |
| psf__requests-5414 | psf/requests | E | yes | yes | VALID | treatment_live |
| sympy__sympy-16766 | sympy/sympy | E | yes | yes | VALID | treatment_live |
| astropy__astropy-14369 | astropy/astropy | E | no | yes | VALID | treatment_live |
| django__django-11095 | django/django | E | no | yes | VALID | treatment_live |
| django__django-11740 | django/django | E | no | yes | VALID | treatment_live |

Per-case `selection_reason` (verbatim from the M55Y preregistration) is carried in the JSON
fixture's `instances[].selection_reason`.

## Repository Constraints

- **Repo count:** 11 — sphinx-doc/sphinx (1), matplotlib/matplotlib (3), mwaskom/seaborn (1),
  sympy/sympy (4), django/django (5), pydata/xarray (1), astropy/astropy (4),
  pylint-dev/pylint (1), psf/requests (2), pytest-dev/pytest (1), pallets/flask (1).
- **Tasks per repo:** no single repo exceeds 5 (django, 5/24 = 21% — present, not dominant).
- **Category counts:** A=6, B=4, C=5, D=3, E=6.
- **Locked sentinels present:** yes — `sphinx-doc__sphinx-7462`, `django__django-11820`,
  `django__django-13195` (all in-set, all VALID in pre-flight).
- **pylint-8898 included?** **Yes — not silently excluded.** It is retained in the 24-task set
  and explicitly marked a **known fail-closed over-budget outlier at 12k from M61B**
  (digest+contract = 12,803). Its future live treatment must be **skipped unless pre-flight
  becomes VALID**. The same marking applies to the two over-budget cases newly surfaced among
  the 9 additions: `sympy__sympy-12419` (12,659) and `matplotlib__matplotlib-22719` (12,049).

## Planned Run Matrix

| instance_id | baseline | treatment | evaluation | notes |
|---|---|---|---|---|
| django__django-11820 | reused | planned | docker | locked sentinel |
| matplotlib__matplotlib-24627 | reused | planned | docker | |
| mwaskom__seaborn-3187 | reused | planned | docker | |
| sphinx-doc__sphinx-7462 | reused | planned | docker | locked sentinel |
| matplotlib__matplotlib-22719 | reused | **skip (pending pre-flight)** | skipped | over-budget by 49 |
| sympy__sympy-13372 | reused | planned | docker | |
| astropy__astropy-14539 | reused | planned | docker | |
| pydata__xarray-3677 | reused | planned | docker | |
| pylint-dev__pylint-8898 | reused | **skip (pending pre-flight)** | skipped | over-budget by 803 |
| sympy__sympy-12419 | reused | **skip (pending pre-flight)** | skipped | over-budget by 659 |
| astropy__astropy-14365 | reused | planned | docker | |
| pytest-dev__pytest-7432 | reused | planned | docker | |
| matplotlib__matplotlib-25960 | reused | planned | docker | near-budget (10,911 / 12,000) |
| psf__requests-1142 | reused | planned | docker | near-budget (10,268) |
| sympy__sympy-12481 | reused | planned | docker | |
| astropy__astropy-14598 | reused | planned | docker | |
| django__django-13195 | reused | planned | docker | locked sentinel |
| pallets__flask-5014 | reused | planned | docker | |
| django__django-10880 | reused | planned | docker | |
| psf__requests-5414 | reused | planned | docker | |
| sympy__sympy-16766 | reused | planned | docker | |
| astropy__astropy-14369 | reused | planned | docker | |
| django__django-11095 | reused | planned | docker | |
| django__django-11740 | reused | planned | docker | |

Totals: **21 planned treatment runs + 21 Docker evals + 0 fresh baselines = 21 new live
runs** (cap 24). 3 skipped (fail-closed over-budget).

## Command Templates (document; do not execute in this milestone)

**Treatment run (per VALID case):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m62_structured_bounded_<INSTANCE_SAFE> \
  --show-vtrace-index-log \
  --context-policy force-inject --capsule-engine v2 \
  --capsule-intent debug --capsule-budget 8000 \
  --inject-capsule-digest --digest-decision-contract \
  --bounded-digest-decisions --compact-digest-injection \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Fresh baseline (only if a reused baseline fails the reuse gate):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode run-protocol --protocol baseline \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --instances <INSTANCE_ID> \
  --run-label m62_baseline_<INSTANCE_SAFE> \
  --show-vtrace-index-log \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Docker evaluation (per produced patch):**
```bash
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \
  --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir /home/calvin/code/vexp-swe-bench \
  --run-label m62_structured_bounded_<INSTANCE_SAFE> \
  --out benchmarks/stage5_vexp_swe_bench_smoke/results
```

**Artifact paths (per run-label):** `results/runs/<label>/raw/vtrace/swebench-*.jsonl`
(patch/tokens/cost), `…/_eval.meta.json` (resolvedCount), `…/_tool_calls.json`,
`…/_agent_stream.first_pass.jsonl`, and `results/runs/<label>/_vtrace_instructions.snapshot.md`
(injected context for validity).

## Pre-flight Plan (mandatory first gate for the live milestone)

Before any live agent, replay all 24 cases offline (post-M61 atomic truncation), exactly as
this milestone did via `run_stage5_m62_preflight_replay.ts`. For each case check the
**post-12k-truncation** injected context:

- **Sentinel checks:** `<VTRACE_CAPSULE_V2_DIGEST_START/END>` and
  `<VTRACE_DIGEST_DECISION_CONTRACT_START/END>` each present **exactly once**; no
  START-without-END or END-without-START (partial sentinel).
- **Structured grammar checks:** `target_id` / `decision:` / `reason:` / `files_touched`
  present, and the bounded three-way `EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT` present.
- **Impact check:** a real non-warning `→ impact` section (not `impact_not_threaded…` only).
- **Required-target check:** count > 0 and ≤ 4.
- **Compact-mode check:** the `## VTRACE inspect-first` block is absent.
- **Fail-closed skip rule:** a case proceeds to live treatment **only** if status is `VALID`.
  Skip if `FAIL_CLOSED_OMITTED`, `INVALID_PARTIAL_SENTINEL`, `INVALID_STRUCTURED_GRAMMAR`,
  `INVALID_IMPACT`, or `OTHER_INVALID`. **If any `INVALID_PARTIAL_SENTINEL` appears, stop
  (it would mean M61 regressed).**

**Known pre-flight (this milestone, offline replay over persisted indexes):** 21 VALID,
3 FAIL_CLOSED_OMITTED (pylint-8898, sympy-12419, matplotlib-22719), **0
INVALID_PARTIAL_SENTINEL**, 1 near-budget VALID (matplotlib-25960 at 10,911; requests-1142 at
10,268 also approaches the 90% line). The live milestone must **re-run** pre-flight against
its own fresh-clone indexes before running (statuses may shift slightly if an index differs),
but the deterministic index build makes large shifts unlikely for the cases far from budget.

## Baseline Reuse Gate

A reused baseline is comparable for M62 **only if**: same `instance_id`; Stage 5
vexp-swe-bench harness family; patch + Docker `_eval.meta.json` present; token/cost/tool-call
telemetry present where possible; not known-invalid; **and the model recorded in its
`_run.meta.json` / source equals the live M62 treatment model**.

- **15 M60 cases:** reuse the M60B baselines (already model-matched `opus-4-5`, Docker-evaluated).
- **9 additional cases:** reuse the M55Z baselines (recorded `opus-4-5`, same harness family).
- **Model-match requirement:** the runner does not override the model; the vexp default is
  `claude-opus-4-5-20251101`, equal to all reused baselines — so `baseline_model_match` is
  **expected pass**, to be **confirmed at run time** per case.
- **Fallback if a baseline fails the gate:** run at most one fresh baseline
  (`m62_baseline_<safe>`) for that case, provided total new live runs stay ≤ 24. If fresh
  baselines would push the total over 24, the live milestone must **stop and report
  incomplete** rather than exceed the cap.

Per-case `baseline_source` / `baseline_label_hint` / `baseline_model_match` /
`baseline_reuse_decision` are recorded in the JSON fixture.

## Metrics and Scoring

- **Exact metrics to extract** (per case, treatment and baseline): instance_id, repo,
  category, selection_reason, condition, run_label, baseline_source, baseline_model_match,
  preflight_status, valid_run, invalid_reason, patch_produced, resolved, cost, duration_ms,
  input/output/cache_read/cache_write/total tokens, turn_count, tool_call_count, Read count,
  Search/Grep count, Edit/Write count, repeated_file_reads; digest_present, impact_present,
  decision_contract_present, structured_grammar_present, bounded_contract_present,
  compact_mode_applied; required_target_count, required_targets,
  required_target_{edited,ruled_out,inspect_only_no_edit,ignored,invalid_decision,closed,open}_count,
  decision_coverage, ignored_rate; lead_pivot_{path,inspected,edited};
  hidden_or_non_traceback_pivot_{present,inspected,edited};
  impact_representative_{paths,inspected,edited}; optional_context_{targets,inspected,edited};
  edited_files, edited_files_overlap_with_{pivots,impact,required_targets}, off_target_edit_count.
- **Validity rules:** a treatment run is valid only if its injected snapshot carries all four
  sentinels + `→ impact` + structured grammar (target_id/decision/reason/files_touched) +
  bounded three-way + compact + required-target count ≤ 4 (the M60C validity rule; invalid
  reasons `m60c_*`/`m62_*` family). Do not detect sentinels via generic glyphs alone.
- **Decision classifier:** `classifyDigestDecisionContract` (current M59 structured-table
  parser + closed/open partition) via `run_stage5_m58b_analyze.ts` over an `_m62_logs/spec.json`.
- **Paired delta calculations:** treatment vs reused baseline (baseline = median across
  reused replicates; resolution = any-replicate resolved). Report token/cache_read/cost as
  mean per-case, median per-case, and pooled (Σtreatment/Σbaseline); resolution, closed/open/
  ignored target totals, and off-target-edit totals. Also report M62-vs-M60C stability on the
  shared 15 cases.

## Success / Mixed / Fail / Invalid Criteria

**PASS** only if all hold (applied to the valid pre-flight subset):
1. treatment valid in all or nearly all attempted runs;
2. resolution not worse than comparable baseline;
3. required-target ignored rate ≤ 5%;
4. required-target decision coverage ≥ 90%;
5. no increase in off-target edits vs comparable prior VTRACE artifacts;
6. pooled cost regression vs comparable baseline ≤ +15%.

**Thresholds:**
- **INVALID** — sentinel/contract/impact missing, artifact matrix incomplete, or metrics not
  extractable.
- **FAIL** — resolution worse than baseline; OR ignored required-target rate > 10%; OR
  decision coverage < 80%; OR pooled cost regression > 25% without resolution improvement; OR
  over-anchoring/off-target edits increase on E controls.
- **MIXED** — resolution or action improves, but cost/compliance/over-edit behavior remains
  unstable.
- **PASS** — no resolution regression, high decision coverage, low ignored rate, bounded cost,
  no over-anchoring increase.

**Reporting layers (required):** (a) full selected-set result including skipped invalids;
(b) valid-only result; (c) category-stratified result (A/B/C/D/E); (d) baseline-strong (E)
control no-hurt result.

## Stop Conditions (for the live milestone)

Stop and report rather than continue if: fixture missing/inconsistent; M61B/M62 pre-flight
inputs missing/inconsistent; pre-flight produces any `INVALID_PARTIAL_SENTINEL`; pre-flight
leaves fewer valid cases than planned and the matrix can no longer be interpreted; baseline
reuse fails enough cases that fresh baselines would exceed the 24-run cap; runner flags
incompatible; vexp-swe-bench workspace/evaluator unavailable; digest sentinel absent;
decision contract absent; impact section warning-only; raw artifact layout changed enough that
metrics cannot be extracted; or more than 24 new live runs would be required.

## Recommendation

**Ready for explicit authorization to run the M62 live 24-task confirmation.**

The plan is frozen and de-risked: the 24-task set is the pre-existing M55Y set (no
cherry-picking), all 24 are in the dataset with persisted indexes, the offline pre-flight
replay already ran (21 VALID / 3 fail-closed / **0 partial sentinel**), baselines are reusable
and model-matched (expected), and the planned **21 treatment + 0 fresh baseline** runs sit
under the 24 cap. The only open item is the standard re-run of pre-flight against the live
milestone's own fresh indexes (statuses are expected to match). **Authorization is requested
for up to 24 live treatment runs (expected 21) + Docker evals; no fresh baselines by default.**

Advisory (non-blocking): 3/24 cases are over-budget fail-closed and 1–2 more are near-budget,
so the M61B/M60C **digest-header compaction** follow-up (cap the verbatim issue-description
text in the digest header) would recover ~3 cases and is worth landing in parallel — but it
is **not** a gate on this confirmation.

## Non-Claims

- This preregistration does not claim VTRACE beats VEXP.
- This preregistration does not claim SWE-bench pass@1 improvement.
- This preregistration does not make a statistical claim.
- This preregistration only freezes a targeted 24-task validation plan.

---

### Provenance

- Selection: `stage5_m55y_digest_breadth_preregistration.json` (the 24-task set, verbatim).
- M60 membership / locked sentinels: `stage5_m60_structured_bounded_breadth_preregistration.json`.
- Reused baselines: `stage5_m60b_…json` (15 cases) + `stage5_m55z_…json` (9 cases), both `opus-4-5`.
- Offline pre-flight replay: `run_stage5_m62_preflight_replay.ts` →
  `stage5_m62_preflight_replay.json` (post-M61 atomic truncation; no clone/agent/Docker).
- Compact fixture: `stage5_m62_structured_bounded_24_preregistration.json`.
