# Stage 5 M60B Structured Bounded Digest Breadth Live Validation

Live execution of the M60 pre-registration (`1b487e6`): **15 structured-bounded
treatment runs + 15 reused baselines**, all Docker-evaluated. Treatment =
`vtrace-indexed · force-inject · v2 · debug · 8000 · inject-capsule-digest ·
digest-decision-contract · bounded-digest-decisions · compact-digest-injection`. Model
`claude-opus-4-5-20251101` (vexp default; runner does not override; matches all reused
baselines). Full per-instance data in
`stage5_m60b_structured_bounded_breadth_live_validation.json`. Not a benchmark; not a
pass-rate claim.

## Summary

- **Selected tasks:** 15 (exactly the pre-registered set; none added/removed).
- **New live runs performed:** **15** (15 treatment, 0 fresh baselines) — well under the
  24-run cap; all exit 0, all Docker-evaluated.
- **Reused baselines:** 15 (all model-matched `opus-4-5`; Gate 2 passed for all). **Fresh
  baselines:** 0.
- **Valid / invalid treatment runs:** **14 valid / 1 invalid.** 14/15 carried all four
  sentinels + structured grammar + bounded three-way + compact + required-target count
  ≤ 4. **pylint-8898 is INVALID** (`m60_decision_contract_not_present`): `legacy_slice`
  context truncation (`maxChars=12000`, `essentialSectionsEvicted=true`) evicted the
  contract **END** sentinel — a harness budget issue, not contract logic. Excluded from
  treatment deltas.
- **Headline resolution:** treatment **9/15** vs baseline **8/15** (full set, +1). On the
  **14 valid** runs: treatment **9** vs baseline **7** (**+2**). Paired (valid): 6
  both-pass, 4 both-fail, **3 treatment-only** (sphinx-7462, matplotlib-24627,
  seaborn-3187), **1 baseline-only** (requests-5414 — documented variance, reproduces
  the M55Z 1→0).
- **Headline structured-decision compliance:** across the **44** required targets on the
  14 valid runs, **43 closed / 1 open / 0 ignored / 1 invalid** → decision coverage
  **97.7%**, ignored rate **0.0%**. The lone open/invalid is django-13195's terse caller
  rule-out — identical to M59B r1.
- **Headline token/cost/tool-turn:** pooled (valid) total tokens **−8.0%**, cache-read
  **−8.8%**, cost **−9.1%** ($10.49 vs $11.53). Median per-case cost **+$0.11** (the M55Z
  pattern: cheaper in aggregate on heavy cases, slightly pricier on light cases).
- **Verdict: PASS (with one validity caveat).** **Recommendation: proceed to broader
  confirmation, gated on first fixing the legacy_slice contract-eviction truncation;
  do not promote to a Stage 5 default yet.**

## Preregistration Compliance

- **Fixture used:** `stage5_m60_structured_bounded_breadth_preregistration.json` (source
  of truth).
- **Task count matches?** Yes — 15 selected, all run.
- **Repos / category counts match?** Yes — 11 repos; A=4, B=3, D=3, E=3, C=2, exactly as
  registered. All 3 locked sentinels present (sphinx-7462, django-11820, django-13195).
- **Cases added/removed?** None.
- **Run count matches?** Yes — 15 treatment + 0 fresh baselines = 15 (≤ 24 cap); 15
  reused baselines, no extra replicates, no exploratory cases, no corrective/revision
  arms.
- **Deviations:** None in selection or run matrix. One run (pylint-8898) was
  **invalidated post-hoc** by the pre-registered validity rule (missing contract END
  sentinel via truncation) — handled exactly as the preregistration's INVALID handling
  prescribes (excluded from deltas, reported honestly).

## Pre-flight

- **Method:** non-agent offline `run_stage5_m60_preflight.ts` — re-renders the EXACT
  injected context (`classifyCapsuleOutput` with `digestDecisionContract:true,
  boundedDigestDecisions:true, compactDigestInjection:true`) against the persisted M55Z
  digest workspace indexes (`results/workspaces/m55y_vtrace_digest_<safe>/…/.vtrace/index.sqlite`).
  The index build is deterministic from repo source (unchanged by M56–M59), so the
  enrichment is identical to a fresh run's. No agent, no Docker, no spend.
- **15 cases checked, before any live agent. All 15 PASS.**
- **Digest sentinel:** present exactly once each.
- **Decision-contract sentinel:** present exactly once each (in pre-flight).
- **Impact:** real non-warning `→ impact` each.
- **Structured grammar:** `target_id` / `target` / `decision` / `reason` /
  `files_touched` each; bounded three-way `EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT` each.
- **Required-target counts:** 2–4 each (all ≤ 4): sphinx 3, django-11820 3, mpl 3,
  seaborn 2, xarray 4, astropy-14539 4, pylint 4, django-13195 3, flask 4,
  astropy-14598 2, django-10880 4, requests 2, sympy 4, astropy-14365 3, pytest 3.
- **Compact mode:** `## VTRACE inspect-first` absent each.
- **memory/rules warnings:** present and honest (no DB data) each.
- **Any live run before pre-flight?** No — pre-flight ran first; all 15 PASSed, then the
  15 live runs launched sequentially.

> Caveat surfaced by the live run, not by pre-flight: pre-flight renders the contract
> **before** the live context-budget truncation step. For pylint-8898 the live
> `prepareIndexedContext` then applied a `legacy_slice` truncation at 12 000 chars that
> evicted the contract tail (incl. the END sentinel). Pre-flight passed; the live
> snapshot did not. This is the source of the single invalid run.

## Baseline Reuse Gate

All baselines recorded `claude-opus-4-5-20251101`; the most-recent M59B runs use the
same model, and the runner does not override the model — so a fresh M60 treatment run
uses the same model as every reused baseline. **Model-match: pass for all 15 → 0 fresh
baselines.**

| instance | baseline_run_label | source | model_match | reuse_decision | fresh? |
|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | `m56c_baseline_sphinx_7462` | reused | pass | reuse | no |
| django__django-11820 | `m56c_baseline_django_11820` | reused | pass | reuse | no |
| matplotlib__matplotlib-24627 | `eval-bounded-baseline-mpl-24627-r{1..3}` | reused | pass | reuse (median) | no |
| mwaskom__seaborn-3187 | `eval-bounded20-baseline-seaborn-3187-r{1..3}` | reused | pass | reuse (median) | no |
| pydata__xarray-3677 | `eval-m32-product-baseline-xarray-3677-r{1..3}` | reused | pass | reuse (median) | no |
| astropy__astropy-14539 | `eval-bounded20-baseline-astropy-14539-r{1..3}` | reused | pass | reuse (median) | no |
| pylint-dev__pylint-8898 | `eval-bounded20-baseline-pylint-8898-r{1..3}` | reused | pass | reuse (median) | no |
| django__django-13195 | `m56c_baseline_django_13195` | reused | pass | reuse | no |
| pallets__flask-5014 | `eval-bounded-baseline-flask-5014-r{1..3}` | reused | pass | reuse (median) | no |
| astropy__astropy-14598 | `m55y_baseline_astropy_14598` | reused | pass | reuse | no |
| django__django-10880 | `eval-m32-product-baseline-django-10880-r{1..3}` | reused | pass | reuse (median) | no |
| psf__requests-5414 | `eval-baseline-vs-vtrace-baseline-requests-5414` | reused | pass | reuse | no |
| sympy__sympy-16766 | `eval-bounded-baseline-sympy-16766-r{1..3}` | reused | pass | reuse (median) | no |
| astropy__astropy-14365 | `eval-bounded20-baseline-astropy-14365-r{1..3}` | reused | pass | reuse (median) | no |
| pytest-dev__pytest-7432 | `m55y_baseline_pytest_7432` | reused | pass | reuse | no |

(Reused baseline metrics = **median** across evaluated replicates; resolution = **any**
replicate resolved.)

## Run Matrix

| instance | repo | cat | baseline (source) | treatment label | valid | evaluated |
|---|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | sphinx | A | reused (m56c) | m60_structured_bounded_sphinx_7462 | yes | yes |
| django__django-11820 | django | A | reused (m56c) | m60_structured_bounded_django_11820 | yes | yes |
| matplotlib__matplotlib-24627 | matplotlib | A | reused | m60_structured_bounded_matplotlib_24627 | yes | yes |
| mwaskom__seaborn-3187 | seaborn | A | reused | m60_structured_bounded_seaborn_3187 | yes | yes |
| pydata__xarray-3677 | xarray | B | reused | m60_structured_bounded_xarray_3677 | yes | yes |
| astropy__astropy-14539 | astropy | B | reused | m60_structured_bounded_astropy_14539 | yes | yes |
| pylint-dev__pylint-8898 | pylint | B | reused | m60_structured_bounded_pylint_8898 | **INVALID (truncation)** | yes |
| django__django-13195 | django | D | reused (m56c) | m60_structured_bounded_django_13195 | yes | yes |
| pallets__flask-5014 | flask | D | reused | m60_structured_bounded_flask_5014 | yes | yes |
| astropy__astropy-14598 | astropy | D | reused | m60_structured_bounded_astropy_14598 | yes | yes |
| django__django-10880 | django | E | reused | m60_structured_bounded_django_10880 | yes | yes |
| psf__requests-5414 | requests | E | reused | m60_structured_bounded_requests_5414 | yes | yes |
| sympy__sympy-16766 | sympy | E | reused | m60_structured_bounded_sympy_16766 | yes | yes |
| astropy__astropy-14365 | astropy | C | reused | m60_structured_bounded_astropy_14365 | yes | yes |
| pytest-dev__pytest-7432 | pytest | C | reused | m60_structured_bounded_pytest_7432 | yes | yes |

## Results Table

Treatment per-run; `resolved b` = baseline any-replicate resolved (frac). `off` =
edits outside required targets. `clo/opn/ign/inv` = closed/open/ignored/invalid required
targets.

| instance | cat | resolved | resolved b | total_tok | cache_rd | cost | tools | reads | srch | rpt | req | clo | opn | ign | inv | off | valid |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | A | ✓ | ✗ (0/1) | 927,207 | 855,336 | $0.470 | 10 | 4 | 1 | 2 | 3 | 3 | 0 | 0 | 0 | 0 | valid |
| django-11820 | A | ✗ | ✗ (0/1) | 1,029,278 | 967,880 | $0.548 | 10 | 1 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | valid |
| matplotlib-24627 | A | ✓ | ✗ (0/3) | 2,163,517 | 2,065,279 | $0.929 | 21 | 4 | 5 | 1 | 3 | 3 | 0 | 0 | 0 | 2† | valid |
| seaborn-3187 | A | ✓ | ✗ (0/3) | 2,279,388 | 2,191,319 | $1.045 | 21 | 5 | 7 | 2 | 2 | 2 | 0 | 0 | 0 | 1† | valid |
| xarray-3677 | B | ✓ | ✓ (3/3) | 1,383,121 | 1,316,090 | $0.635 | 13 | 4 | 0 | 3 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| astropy-14539 | B | ✓ | ✓ (3/3) | 610,785 | 561,839 | $0.358 | 6 | 2 | 0 | 1 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| pylint-8898 | B | ✗ | ✓ (2/3) | 1,004,967 | 932,600 | $0.530 | 8 | 1 | 0 | 0 | — | — | — | — | — | 0 | **INVALID** |
| django-13195 | D | ✗ | ✗ (0/1) | 1,716,421 | 1,642,978 | $0.718 | 19 | 3 | 5 | 0 | 3 | 2 | 1 | 0 | 1 | 2 | valid |
| flask-5014 | D | ✓ | ✓ (3/3) | 650,655 | 601,710 | $0.338 | 6 | 2 | 0 | 1 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| astropy-14598 | D | ✗ | ✗ (0/1) | 4,122,987 | 3,947,363 | $3.074 | 26 | 9 | 8 | 7 | 2 | 2 | 0 | 0 | 0 | 0 | valid |
| django-10880 | E | ✓ | ✓ (3/3) | 1,051,692 | 994,114 | $0.510 | 11 | 1 | 0 | 0 | 4 | 4 | 0 | 0 | 0 | 1† | valid |
| requests-5414 | E | ✗ | ✓ (1/1) | 598,806 | 541,500 | $0.429 | 5 | 1 | 1 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | valid |
| sympy-16766 | E | ✓ | ✓ (3/3) | 1,109,474 | 1,046,296 | $0.545 | 10 | 2 | 0 | 1 | 4 | 4 | 0 | 0 | 0 | 0 | valid |
| astropy-14365 | C | ✗ | ✗ (0/3) | 556,580 | 503,570 | $0.350 | 5 | 1 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | valid |
| pytest-7432 | C | ✓ | ✓ (1/1) | 1,006,170 | 945,473 | $0.537 | 11 | 2 | 0 | 1 | 3 | 3 | 0 | 0 | 0 | 0 | valid |

† The `off` (outside-required-targets) edits are **correct gold edits not named in the
contract's required-target list**, not over-edits: mpl-24627 `axes/_base.py`+`figure.py`
(the gold fix; the digest pivots were off-target per M55Z) and seaborn `utils.py` (the
2nd gold file) are on **resolved** runs; django-10880 `aggregates.py` **is** the gold
file (its required-target path differed by spelling). django-13195's 2 `off` edits
(`cookie.py`,`middleware.py`) are the M59B persistent multi-gold co-edit
(pivot-expansion, not optional-context). See Structured Decision Analysis.

## Paired Outcomes

On the 14 valid runs (treatment vs the reused comparator):

- **both_pass:** 6 (xarray-3677, astropy-14539, flask-5014, django-10880, sympy-16766, pytest-7432)
- **both_fail:** 4 (django-11820, django-13195, astropy-14598, astropy-14365)
- **treatment_only_pass:** 3 (sphinx-7462, matplotlib-24627, seaborn-3187)
- **baseline_only_pass:** 1 (requests-5414)

Net **+2** for the treatment on the valid set (full set incl. the invalid pylint row:
9 vs 8, +1). sphinx-7462 is the clean digest-attributable win (lead+hidden pivot both
edited; baseline edited only `python.py`). matplotlib-24627 and seaborn-3187 are
treatment-only over **best-of-3 failing baselines** — favorable but partly variance
(mpl edits the same gold files as its failing baseline; seaborn now reaches both golds).
requests-5414 is the one loss: correct localization (`models.py`, edited fewer files
than the prior digest), patch-quality variance — reproduces the M55Z 1→0.

## Paired Deltas

(valid set; baseline = median across reused replicates)

| metric | mean per-case | median per-case | pooled (Σt/Σb) |
|---|---|---|---|
| total_tokens | −119,800 | +101,078 | **−8.0%** |
| cache_read_tokens | — | — | **−8.8%** |
| cost (USD) | −0.075 | **+0.112** | **−9.1%** ($10.49 vs $11.53) |
| resolution | treatment 9 vs baseline 7 (+2) | — | — |
| closed required targets | — | — | **43/44** |
| open required targets | — | — | 1/44 |
| ignored required targets | — | — | **0/44** |
| off-target edits vs prior digest | — | — | no systematic increase (see below) |

The pooled-vs-median split repeats the M55Z efficiency signature: **pooled** cost/tokens
fall (heavy cases — mpl-24627, astropy-14539, astropy-14365 — drop a lot), while the
**median** case is slightly pricier (+$0.11) from the digest's own injected text.

## Category-Stratified Results

| cat | n (valid) | resolved b→t | treatment-only | baseline-only | coverage | pooled cost% | interpretation |
|---|---|---|---|---|---|---|---|
| A hidden-pivot | 4 | 0→3 | sphinx, mpl, seaborn | – | 11/11 | **−40.6%** | **Best stratum: +3 resolution and cheaper.** sphinx is digest-attributable; mpl/seaborn resolve over failing best-of-3 baselines (partly variance). |
| B nav-heavy | 2 | 2→2 | – | – | 8/8 | −0.5% | Resolution held; full coverage. (pylint-8898 excluded — invalid-truncated.) |
| D over-anchor | 3 | 1→1 | – | – | 8/9 | +18.2% | flask both-pass; django-13195 1 open + persistent 2-file co-edit; astropy-14598 both-fail & heavy. **No over-anchoring** to non-gold required targets. |
| E baseline-strong | 3 | 3→2 | – | requests-5414 | 10/10 | +42.1% | One variance loss (requests-5414, reproduces M55Z). Cost up on **cheap** E baselines (light-case digest overhead, small absolute $), **not** over-exploration; no over-edit (requests edited fewer files than prior digest; django-10880 edited only the gold). |
| C normal | 2 | 1→1 | – | – | 6/6 | −8.0% | Neutral controls; coverage full. |

## Structured Decision Analysis

- **Required-target closure:** 43/44 closed (97.7%); 0 ignored. On all 14 valid runs the
  agent issued a credited decision for nearly every required target, including terse
  table rule-outs — the M58B `INVALID_RULE_OUT` artifact stays gone live, matching M59B.
- **Ignored required-target rate:** 0.0% (0/44).
- **Invalid rule-out / open:** 1/44 — django-13195's terse caller rule-out (the same
  target M59B r1 left uncredited). Bounded and case-specific.
- **INSPECT_ONLY_NO_EDIT usage:** present and credited where the agent inspected a
  required target but patched elsewhere (the bounded three-way is exercised, not just
  EDIT/RULE_OUT).
- **Optional-context exploration:** none of the valid cases rendered a separate optional
  list (each surfaced a single impact representative), so optional context drove no extra
  exploration — consistent with M59B.
- **Off-target / over-edit vs prior M55Z digest:** edit counts are ≈ the plain digest on
  12/14 valid cases; only seaborn (4 vs 3, a legitimate 2nd gold edit, resolved) and
  astropy-14598 (2 vs 1, both-fail) edited one more. mpl-24627 and requests-5414 edited
  **fewer**. **No over-edit increase on the E controls.** The raw "outside-required"
  count (6 across the set) is dominated by correct gold edits not named in the contract
  list, not over-editing.
- **vs M59B behavior:** sphinx resolves (matches M59B 3/3 stability); django-11820
  localize-but-fail with all targets closed (matches); django-13195 fails this single
  draw with the same 2-file co-edit and 1 uncredited rule-out (sits inside the M59B 1/3
  spread).

## Cost / Over-Exploration Analysis

- **Pooled cost regression vs baseline:** **−9.1%** (a reduction, not a regression).
  **≤ +15%? Yes** (it improved).
- **Repeated reads:** low across the set (0–3 on most cases; astropy-14598 the heavy
  outlier at 7, a 4M-token both-fail case in both arms). No repeated-read blow-up.
- **Tool-call / read deltas:** heavy cases fall sharply (astropy-14539 6 tools,
  astropy-14365 5); light cases roughly flat. Aggregate tool/read down on the heavy
  stratum, consistent with M55Z.
- **Over-anchoring / off-target edits:** no increase; the D over-anchor stratum never
  edited a non-gold required target, and the E controls show no over-edit.
- **Were E controls harmed?** Resolution: requests-5414 lost on patch-quality variance
  (correct localization, baseline itself resolves only 1/1 here / 1/4 in the broader
  M55Z replicate pool); django-10880 and sympy-16766 held (both-pass). No over-anchoring,
  no over-edit. The E cost +42% is light-case digest overhead on cheap baselines (small
  absolute dollars), captured by the pooled −9.1%.

## Success Criteria Check

Applying the pre-registered M60 PASS criteria to the **14 valid** runs:

1. **Treatment valid in all or nearly all selected runs** — **PASS (nearly all):** 14/15
   valid; 1 invalid (pylint-8898) from `legacy_slice` context truncation evicting the
   contract END sentinel (harness budget issue, not contract logic).
2. **Resolution not worse than comparable baseline** — **PASS:** valid 9 vs 7 (+2); full
   9 vs 8 (+1).
3. **Required-target ignored rate ≤ 5%** — **PASS:** 0.0% (0/44).
4. **Required-target decision coverage ≥ 90%** — **PASS:** 97.7% (43/44).
5. **No increase in off-target edits vs comparable prior VTRACE artifacts** — **PASS:**
   edit counts ≈ the M55Z plain digest; only 2 cases up by 1 (one a legit 2nd-gold on a
   resolved run, one a both-fail); E controls flat/down; no over-anchoring.
6. **Pooled cost regression vs baseline ≤ +15%** — **PASS:** −9.1% (a reduction).

All six met. Under a **strict** reading where criterion 1 demands *all* runs valid, this
would downgrade to **MIXED**; the pre-registration's "all or nearly all" language carries
PASS, with the truncation flagged below.

## Verdict

**PASS (with one validity caveat).**

On the 14 valid runs the structured bounded contract: was valid 14/15; closed 43/44
required targets with **0 ignored** (97.7% coverage); **did not regress resolution**
(+2 valid / +1 full, one variance loss on requests-5414); **reduced pooled cost −9.1%**,
cache-read −8.8%, tokens −8.0%; showed **no over-anchoring** and **no over-edit increase**
on the D and E control strata; and improved hidden-pivot action to **5/14** (vs M55Z
plain-digest 2/13). The A stratum is the standout (+3 resolution, −41% cost).

The caveat is real and must gate the next step: **1/15 runs (pylint-8898) was invalidated
because the `legacy_slice` context-budget truncation (12 000 chars) silently evicted the
decision-contract block — including its END sentinel — on a large-context, retrieval-weak
case.** Pre-flight (which renders the contract before truncation) did not catch it. At a
24- or 100-task scale this will recur on every large-context case, so it is a
generalization-limiting harness bug, not a contract-design failure.

## Recommendation

**Proceed to broader confirmation — gated on first fixing the `legacy_slice`
contract-eviction truncation** (raise or section-prioritize the capsule context budget so
the `<VTRACE_DIGEST_DECISION_CONTRACT_*>` block is never evicted; this is the same
section-priority truncation family as M45's `vtraceContextBudget`). **Do not promote the
structured bounded treatment to a Stage 5 default yet.** The django-13195 multi-gold
co-edit persists (pivot-expansion, not optional-context) and remains the secondary lever
for a later milestone. After the truncation fix, a 24-task repeat (with the same
preregistration discipline, and ideally 2–3 replicates on the A+E strata to absorb the
requests-5414-style variance) is the natural next step before any 100-task planning.

## Interpretation rules / non-claims

- **Acceptable claims supported here:** the M60 treatment was valid in 14/15 runs;
  improved resolution by +2 tasks on this pre-registered set (valid subset) against a
  best-of-replicates baseline; changed pooled cost by −9.1%; achieved 97.7% required-
  target decision coverage and a 0.0% ignored rate; did not over-anchor or over-edit on
  the control strata.
- **Not claimed:** VTRACE beats VEXP; VTRACE improves SWE-bench pass@1 generally;
  statistical superiority (single treatment run per case vs reused/best-of-N baselines);
  that the contract *caused* every pass (only sphinx-7462 is mechanistically
  attributable; mpl/seaborn are favorable-but-variance).
- **Method caveats:** baseline resolution is best-of-up-to-3 replicates vs a single
  treatment run (conservative for resolution, noisy per-case); reused baselines span
  milestone families on the same model/harness; no retrieval/scoring/ranking/candidate
  code was changed — differences come from the injected product output and agent
  behavior. Gold labels were read only after runs, for scoring. The pylint-8898 row is
  reported but excluded from all treatment deltas as INVALID.

---

### Provenance

- Gate 1 pre-flight: `run_stage5_m60_preflight.ts` (offline re-render against persisted
  M55Z workspace indexes).
- Live runs: `run-protocol --protocol vtrace-indexed --context-policy force-inject
  --capsule-engine v2 --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest
  --digest-decision-contract --bounded-digest-decisions --compact-digest-injection` →
  labels `m60_structured_bounded_<safe>`. Docker evaluate per label.
- Metrics + decision classification: `run_stage5_m58b_analyze.ts` (the M59B analyzer;
  current `classifyDigestDecisionContract` structured-table parser + closed/open
  partition) over `_m60b_logs/spec.json`. Baseline comparator: median across the reused
  evaluated replicates.
- Compact JSON summary: `stage5_m60b_structured_bounded_breadth_live_validation.json`.
