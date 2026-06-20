# Stage 5 M55Z Capsule v2 Digest Breadth Live Validation

Live execution of the M55Y pre-registration (`4c04e1e`): 24 digest runs + 3 fresh
baselines, 21 reused baselines, all Docker-evaluated. Model
`claude-opus-4-5-20251101` (vexp default). Full per-instance data in
`stage5_m55z_digest_breadth_live_validation.json`.

## Summary

- **Selected tasks:** 24 (exactly the pre-registered set; none added/removed).
- **New live runs performed:** 27 (24 digest + 3 fresh baselines) — at the
  pre-registered cap, all exit 0.
- **Reused baselines:** 21 (median of up to 6 evaluated replicates each).
  **Fresh baselines:** 3 (django-11820, pytest-7432, astropy-14598).
- **Valid / invalid digest runs:** **24 valid / 0 invalid** — every per-run
  `_vtrace_instructions.snapshot.md` carried both
  `<VTRACE_CAPSULE_V2_DIGEST_START>` and `<VTRACE_CAPSULE_V2_DIGEST_END>`.
- **Headline resolution:** digest **17/24** vs baseline **15/24**. Paired: 14
  both-pass, 6 both-fail, **3 digest-only**, **1 baseline-only** → net **+2** for the
  digest. ⚠️ The baseline is **best-of-up-to-6 replicates** vs a **single** digest run
  (handicaps the digest), so net +2 is conservative — but only **1** of the 3
  digest-only passes (sphinx-7462) is mechanistically digest-attributable.
- **Headline token/cost/tool-turn:** **pooled** total_tokens **−15.3%**, cache-read
  **−16.7%**, cost **−12.9%** ($15.92 vs $18.27); mean per-case tool_calls −1.4,
  reads −1.6, repeated_reads −1.6. **But median per-case cost is +$0.11** — the digest
  adds small overhead on cheap cases and saves heavily on navigation-heavy cases,
  which dominate the pool. Net: cheaper in aggregate, slightly pricier on the typical
  small case.
- **Headline hidden-pivot/context-to-action:** lead-pivot inspected **19/24**, edited
  **17/24** (high engagement); but the **distinct hidden pivot was edited in only
  2/13** cases (sphinx-7462, xarray-3677) and inspected in 3/13 — the agent rarely
  acts on the *second* pivot. No over-anchoring: on the D (over-anchor) stratum the
  digest never edited a non-gold pivot, and requests-5414 shows the agent ignoring the
  `api.py` decoy.
- **Verdict: MIXED** (favorable). **Recommendation: fold impact/memory/rules into the
  digest before more runs.**

## Preregistration Compliance

- **Fixture used:** `stage5_m55y_digest_breadth_preregistration.json` (source of truth).
- **Task count matches?** Yes — 24 selected, all run.
- **Run count matches?** Yes — 24 digest + 3 fresh baselines = 27 (≤ 27 cap); 21
  reused baselines, no extra replicates, no added/removed/exploratory cases.
- **Cases added/removed?** None.
- **Deviations:** None. All four M55X sentinel cases present; categories A=6/B=4/C=5/
  D=3/E=6 as registered. Reused baseline label hints resolved to evaluated replicates
  for all 21 (no hinted baseline was missing/unusable, so no extra fresh runs needed).

## Offline Sentinel Pre-flight

- **Method:** non-agent `prepareIndexedContext` build into a throwaway out-dir
  (`/tmp/m55z_preflight_out`), the same orchestration a live force-inject run uses,
  with `--inject-capsule-digest` semantics. No agent, no Docker.
- **Instance:** sphinx-doc__sphinx-7462.
- **Sentinel present?** Yes — both `<VTRACE_CAPSULE_V2_DIGEST_START>` and
  `<VTRACE_CAPSULE_V2_DIGEST_END>` (START=1, END=1); validity keyed on the sentinel,
  not on `●/○/budget:` glyphs.
- **Any live run before pre-flight?** No — the pre-flight ran before any agent spawn.

## Run Matrix

| instance | repo | cat | baseline label | base src | digest label | digest valid | evaluated |
|---|---|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | sphinx | A | 6× eval-m32-product-baseline-sphinx-7462 | reused | m55y_vtrace_digest_sphinx_7462 | yes | yes |
| matplotlib__matplotlib-22719 | matplotlib | A | 5× eval-m4r1-baseline-matplotlib-22719 | reused | m55y_vtrace_digest_matplotlib_22719 | yes | yes |
| matplotlib__matplotlib-24627 | matplotlib | A | 4× eval-bounded-baseline-mpl-24627 | reused | m55y_vtrace_digest_matplotlib_24627 | yes | yes |
| mwaskom__seaborn-3187 | seaborn | A | 6× eval-bounded20-baseline-seaborn-3187 | reused | m55y_vtrace_digest_seaborn_3187 | yes | yes |
| sympy__sympy-13372 | sympy | A | 3× eval-bounded20-baseline-sympy-13372 | reused | m55y_vtrace_digest_sympy_13372 | yes | yes |
| django__django-11820 | django | A | m55y_baseline_django_11820 | fresh | m55y_vtrace_digest_django_11820 | yes | yes |
| pydata__xarray-3677 | xarray | B | 5× eval-m32-product-baseline-xarray-3677 | reused | m55y_vtrace_digest_xarray_3677 | yes | yes |
| sympy__sympy-12419 | sympy | B | 3× eval-bounded20-baseline-sympy-12419 | reused | m55y_vtrace_digest_sympy_12419 | yes | yes |
| astropy__astropy-14539 | astropy | B | 3× eval-bounded20-baseline-astropy-14539 | reused | m55y_vtrace_digest_astropy_14539 | yes | yes |
| pylint-dev__pylint-8898 | pylint | B | 3× eval-bounded20-baseline-pylint-8898 | reused | m55y_vtrace_digest_pylint_8898 | yes | yes |
| sympy__sympy-12481 | sympy | C | 3× eval-bounded20-baseline-sympy-12481 | reused | m55y_vtrace_digest_sympy_12481 | yes | yes |
| psf__requests-1142 | requests | C | 3× eval-bounded-baseline-requests-1142 | reused | m55y_vtrace_digest_requests_1142 | yes | yes |
| astropy__astropy-14365 | astropy | C | 3× eval-bounded20-baseline-astropy-14365 | reused | m55y_vtrace_digest_astropy_14365 | yes | yes |
| matplotlib__matplotlib-25960 | matplotlib | C | 1× eval-bounded-baseline-mpl-25960 | reused | m55y_vtrace_digest_matplotlib_25960 | yes | yes |
| pytest-dev__pytest-7432 | pytest | C | m55y_baseline_pytest_7432 | fresh | m55y_vtrace_digest_pytest_7432 | yes | yes |
| pallets__flask-5014 | flask | D | 3× eval-bounded-baseline-flask-5014 | reused | m55y_vtrace_digest_flask_5014 | yes | yes |
| django__django-13195 | django | D | 6× eval-m32-product-baseline-django-13195 | reused | m55y_vtrace_digest_django_13195 | yes | yes |
| astropy__astropy-14598 | astropy | D | m55y_baseline_astropy_14598 | fresh | m55y_vtrace_digest_astropy_14598 | yes | yes |
| sympy__sympy-16766 | sympy | E | 4× eval-bounded-baseline-sympy-16766 | reused | m55y_vtrace_digest_sympy_16766 | yes | yes |
| astropy__astropy-14369 | astropy | E | 4× eval-baseline-vs-vtrace-baseline-astropy-14369 | reused | m55y_vtrace_digest_astropy_14369 | yes | yes |
| django__django-10880 | django | E | 5× eval-m32-product-baseline-django-10880 | reused | m55y_vtrace_digest_django_10880 | yes | yes |
| django__django-11095 | django | E | 4× eval-m4h-baseline-django-11095 | reused | m55y_vtrace_digest_django_11095 | yes | yes |
| psf__requests-5414 | requests | E | 4× eval-baseline-vs-vtrace-baseline-requests-5414 | reused | m55y_vtrace_digest_requests_5414 | yes | yes |
| django__django-11740 | django | E | 1× eval-11740 | reused | m55y_vtrace_digest_django_11740 | yes | yes |

## Results Table

`b→d` = baseline → digest. Reused baseline = **median** of evaluated replicates
(resolution = **any** replicate resolved). `lead ins/ed` = lead-pivot
inspected/edited; `hid pres/ins/ed` = distinct hidden pivot present/inspected/edited.

| instance | cat | resolved b→d | total_tok b→d | cacheRd b→d | cost b→d | tools b→d | reads b→d | rpt b→d | lead ins/ed | hid pres/ins/ed |
|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | A | 0→1 | 613k→978k | 573k→902k | $0.27→$0.49 | 5.5→10 | 2→3 | 1→1 | Y/Y | Y/Y/Y |
| matplotlib-22719 | A | 1→1 | 1116k→2169k | 1061k→2088k | $0.46→$0.94 | 11→21 | 1→4 | 0→1 | Y/n | n/n/n |
| matplotlib-24627 | A | 0→1 | 4909k→2362k | 4810k→2257k | $3.03→$0.98 | 43→21 | 14→3 | 10.5→0 | n/n | n/n/n |
| seaborn-3187 | A | 0→0 | 2411k→2454k | 2341k→2351k | $0.93→$1.10 | 22→21 | 8→6 | 6→3 | Y/Y | Y/Y/n |
| sympy-13372 | A | 1→1 | 765k→752k | 746k→696k | $0.28→$0.46 | 8→7 | 5→2 | 4→1 | Y/Y | n/n/n |
| django-11820 | A | 0→0 | 1600k→727k | 1542k→666k | $0.71→$0.47 | 19→6 | 2→1 | 1→0 | Y/Y | Y/n/n |
| xarray-3677 | B | 1→1 | 1091k→1730k | 1029k→1652k | $0.43→$0.71 | 12→15 | 6→7 | 5→6 | n/n | Y/Y/Y |
| sympy-12419 | B | 1→1 | 2458k→1798k | 2349k→1730k | $0.95→$0.80 | 23→19 | 10→3 | 6→1 | n/n | n/n/n |
| astropy-14539 | B | 1→1 | 1531k→522k | 1426k→466k | $0.73→$0.36 | 11→5 | 2→1 | 1→0 | Y/Y | Y/n/n |
| pylint-8898 | B | 1→1 | 1440k→1140k | 1399k→1065k | $0.55→$0.57 | 13→9 | 2→2 | 1→0 | Y/Y | Y/n/n |
| sympy-12481 | C | 1→1 | 1397k→765k | 1362k→710k | $0.60→$0.41 | 16→7 | 4→3 | 3→2 | Y/Y | n/n/n |
| requests-1142 | C | 1→1 | 562k→624k | 546k→556k | $0.24→$0.35 | 6→6 | 2→3 | 1→1 | Y/n | Y/n/n |
| astropy-14365 | C | 0→0 | 1036k→594k | 987k→539k | $0.51→$0.36 | 10→5 | 1→1 | 0→0 | Y/Y | Y/n/n |
| matplotlib-25960 | C | 0→1 | 2621k→2696k | 2577k→2600k | $0.95→$1.17 | 29→22 | 17→1 | 15→0 | Y/Y | n/n/n |
| pytest-7432 | C | 1→1 | 883k→876k | 822k→819k | $0.45→$0.47 | 11→9 | 2→3 | 1→2 | Y/Y | n/n/n |
| flask-5014 | D | 1→1 | 313k→542k | 287k→494k | $0.20→$0.31 | 3→5 | 1→2 | 0→1 | Y/Y | Y/n/n |
| django-13195 | D | 0→0 | 908k→2058k | 865k→1960k | $0.39→$0.92 | 10.5→22 | 3.5→6 | 2→3 | Y/Y | n/n/n |
| astropy-14598 | D | 0→0 | 4044k→2667k | 3867k→2532k | $3.04→$1.70 | 24→20 | 10→4 | 8→3 | Y/Y | n/n/n |
| sympy-16766 | E | 1→1 | 1202k→1221k | 1168k→1137k | $0.44→$0.64 | 11→10 | 2.5→1 | 0.5→0 | Y/Y | Y/n/n |
| astropy-14369 | E | 0→0 | 2746k→1899k | 2622k→1812k | $1.44→$0.96 | 19→17 | 5→3 | 1.5→2 | Y/Y | Y/n/n |
| django-10880 | E | 1→1 | 407k→649k | 394k→597k | $0.21→$0.36 | 4→6 | 1→1 | 0→0 | n/n | Y/n/n |
| django-11095 | E | 1→1 | 570k→920k | 549k→865k | $0.24→$0.45 | 6.5→9 | 1.5→3 | 0.5→2 | Y/Y | n/n/n |
| requests-5414 | E | 1→0 | 622k→710k | 538k→653k | $0.30→$0.44 | 5→6 | 1→1 | 0→0 | Y/Y | Y/n/n |
| django-11740 | E | 1→1 | 2387k→1014k | 2263k→955k | $0.91→$0.49 | 0→10 | 0→1 | 0→0 | n/n | n/n/n |

(django-11740's reused baseline `eval-11740` predates tool-call telemetry, so its
baseline tool/read counts read 0 — excluded from tool-delta interpretation for that
row.)

## Paired Outcomes

- **both_pass:** 14
- **both_fail:** 6 (seaborn-3187, django-11820, astropy-14365, django-13195,
  astropy-14598, astropy-14369)
- **digest_only_pass:** 3 (sphinx-7462, matplotlib-24627, matplotlib-25960)
- **baseline_only_pass:** 1 (requests-5414)

## Paired Deltas

Per-pair deltas are in the JSON. Aggregates (digest − baseline):

| metric | pooled (Σd/Σb) | mean per-case | median per-case |
|---|---|---|---|
| total_tokens | **−15.3%** | −240,215 | +6,185 |
| cache_read_tokens | **−16.7%** | −250,988 | −16,710 |
| cost (USD) | **−12.9%** ($15.92 vs $18.27) | −0.10 | **+0.11** |
| tool_calls | — | −1.44 | −1 |
| reads | — | −1.6 | 0 |
| searches | — | −1.27 | 0 |
| repeated_reads | — | −1.63 | 0 |
| resolution | digest 17 vs baseline 15 (+2) | — | — |

The pooled-vs-median split is the key efficiency finding: **pooled** metrics drop
(navigation-heavy cases — mpl-24627 −52%, astropy-14539 −66%, sympy-12481 −45%,
django-11740 −57%, astropy-14598 −34% — fall a lot), while the **median** case is
roughly flat-to-slightly-pricier (+$0.11, +6k tokens) from the digest's own injected
text. The digest pays for itself on heavy cases and costs a little on light ones.

## Category-Stratified Results

| cat | n | resolved b→d | digest_only | baseline_only | pooled cost% | pooled cacheRd% | mean toolΔ | interpretation |
|---|---|---|---|---|---|---|---|---|
| A hidden-pivot | 6 | 2→4 | 2 | 0 | **−21.8%** | −19.1% | −3.8 | Best stratum: +2 resolutions **and** cheaper. sphinx-7462 is the clean digest-attributable win; mpl-24627 edited the same files as its failing baseline (variance). |
| B nav-heavy | 4 | 4→4 | 0 | 0 | −8.6% | **−20.8%** | −2.8 | Resolution held; digest consistently cheaper / fewer reads — the efficiency thesis. |
| C normal | 5 | 3→4 | 1 | 0 | +0.8% | −17.0% | −4.6 | ~Neutral cost; mpl-25960 digest-only pass edited the same file as baseline (variance). |
| D over-anchor | 3 | 1→1 | 0 | 0 | −19.2% | −0.7% | +3.2 | **No over-anchoring**: digest never edited a non-gold pivot; resolution unchanged. |
| E baseline-strong | 6 | 5→4 | 0 | 1 | −5.8% | −20.1% | +2.1 | One regression (requests-5414) — the no-hurt guard's single miss; see below. |

## Context-to-Action Analysis

**Digest-only passes (3):**

- **sphinx-7462 (A) — clean digest-attributable win.** Digest pivots =
  `python.py::_parse_annotation` + `pycode/ast.py::unparse` (both gold). Agent
  inspected **and edited both** (lead + hidden). Baseline edited only `python.py`
  (0/6 replicates) — structurally cannot satisfy both FAIL_TO_PASS. The digest
  surfaced the hidden second edit site and the agent acted on it → resolved. Supports
  the hypothesis.
- **matplotlib-24627 (A) — not digest-attributable.** Digest pivots were off-target
  (`pyplot.py`); lead pivot **not** inspected/edited. Agent edited `axes/_base.py` +
  `figure.py` — the **same files** the baseline edited (0/4). Digest resolved where
  baseline didn't, but on identical edits → single-run variance, not the digest.
  (Notably the digest run was 52% cheaper here.)
- **matplotlib-25960 (C) — weakly attributable.** Digest pivot = `figure.py` (correct,
  lead edited). Baseline also edited `figure.py` (0/1) and failed. Same file → patch
  quality / variance, not a localization effect.

**Baseline-only pass (1):**

- **requests-5414 (E) — variance, not digest harm.** Digest pivots = `models.py`
  (gold, lead) + `api.py` (decoy, **not** gold). Agent edited **`models.py`** (the
  correct file) and **ignored the `api.py` decoy** — i.e. **no over-anchoring**. Its
  single patch was simply wrong; the baseline resolved in only **1 of 4** replicates.
  Both arms localized correctly; the digest lost on patch quality on a case where the
  baseline itself succeeds 25% of the time. This is the one E-stratum regression and
  it is squarely single-run variance.

**Hidden-pivot engagement overall:** of 13 digest runs with a distinct hidden pivot,
the agent **inspected 3** and **edited 2** (sphinx-7462, xarray-3677). The digest
reliably reaches the agent and the agent engages the **lead** pivot (edited 17/24),
but it seldom acts on the **second/hidden** pivot — the same context-to-action ceiling
M55X saw, now confirmed at breadth.

## Cost Acceptance Check

Pre-registered threshold: acceptable if pooled cost regression ≤ +15% at equal/better
resolution, or any larger regression is explained by digest-only passes.

- Pooled cost change = **−12.9%** (a reduction, not a regression).
- Resolution = **better** (17 vs 15).

**Result: PASS on the cost-acceptance threshold** (cost improved at better
resolution). Caveat for product framing: the *median* case costs +$0.11 more; the
aggregate saving is concentrated in navigation-heavy cases.

## Verdict

**MIXED (favorable).**

Strongly positive on efficiency and non-harm: the digest was valid in 24/24 runs,
reduced pooled cost (−12.9%), cache-read (−16.7%) and tokens (−15.3%), cut tool/read
counts on the heavy stratum, never over-anchored to a non-gold pivot (D stratum
clean), and did not reduce net resolution (17 vs a best-of-replicates baseline 15).
The pre-registered cost-acceptance threshold passes.

It falls short of **PASS** for three pre-registered reasons: (1) the E (baseline-strong)
stratum has **one resolution regression** (requests-5414) — the pre-registered PASS
required none, even though this case is demonstrably variance (correct localization,
baseline only 1/4); (2) the net +2 resolution is **mostly not digest-attributable** —
only sphinx-7462 has a mechanism, the other digest-only passes edited the same files
as their failing baselines; (3) **hidden-pivot action stayed rare** (2/13), so the
core context-to-action value proposition is not yet broadly realized. Honoring the
pre-registration rather than re-scoring to the result, this is MIXED.

## Recommendation

**Fold impact/memory/rules into the digest before more runs.**

The digest is cheap-in-aggregate, harmless (no over-anchoring), and always present —
but it is not yet *load-bearing*: the agent engages the lead pivot anyway, acts on the
hidden pivot only 2/13 times, and on several A cases the pivots were off-target yet the
case still resolved. Every run flagged `impact_not_threaded_into_digest`,
`memory_not_threaded_into_digest`, `rules_not_threaded_into_digest`; threading those in
is the most direct lever to convert "present but rarely acted-on" into "acted-on,"
especially for the hidden-pivot / second-edit-site cases (sphinx-7462 is the proof the
mechanism works when the agent does act). `capsule_engine=v2` is already the default,
so that alternative is moot. After a richer digest lands, a confirmation rerun of the
A+D strata (ideally with 2–3 replicates per arm to absorb the variance this run
exposed) is the natural next step before any 100-task planning.

## Interpretation rules / non-claims

- Acceptable claims supported here: digest was present and valid in 24/24 runs; digest
  reduced pooled cost by 12.9% and cache-read tokens by 16.7% on this pre-registered
  set; digest improved resolution on 1 mechanistically-attributable task (sphinx-7462)
  and net +2 against a best-of-replicates baseline; digest did not over-anchor on the
  D stratum.
- **Not claimed:** VTRACE beats VEXP; VTRACE improves SWE-bench pass@1 generally;
  statistical superiority (no uncertainty quantification — single digest run per case
  vs best-of-N baselines); that the digest caused every pass (only sphinx-7462 is
  attributable).
- **Method caveats:** baseline resolution is best-of-up-to-6 replicates vs a single
  digest run (conservative for resolution, noisy per-case); reused baselines span
  milestone families on the same model/harness; no retrieval/scoring/ranking/candidate
  code was changed — differences come from the injected product output and agent
  behavior. Gold labels were read only after runs, for scoring.
