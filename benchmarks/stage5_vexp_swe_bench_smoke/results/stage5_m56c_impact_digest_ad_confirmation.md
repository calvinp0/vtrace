# Stage 5 M56C Impact-Enriched Digest A+D Confirmation

Targeted ≤6-live-run paired A+D confirmation of the **impact-enriched** Capsule v2
digest (M56B bridge) as the single treatment variable. Not a broad benchmark, not a
24-task repeat, not a 100-task run.

## Summary

- **Cases selected (3):** `sphinx-doc__sphinx-7462` (A), `django__django-11820` (A),
  `django__django-13195` (D) — all from the pre-registered M55Y pool. Rule satisfied:
  2 A hidden-pivot/context-to-action cases + 1 D over-anchor/retrieved-but-did-not-act
  case; sphinx-7462 included as required.
- **Why:** sphinx-7462 is the canonical digest-attributable hidden pivot
  (`pycode/ast.py::unparse`, gold #2 only partially named by the traceback);
  django-11820 is a hidden-pivot localize-but-fail case (lead pivot is a *non-gold*
  `enums.py`, gold is `base.py`); django-13195 is a 3-file multi-gold co-edit +
  over-anchor case whose impact section surfaces the gold co-edit file
  `http/response.py`.
- **New live runs performed:** 6 (3 baseline + 3 impact-digest), fresh paired
  same-window. **Exactly at the hard cap. No replicates, no extra cases, no
  corrective/revision/oracle arms.**
- **Valid/invalid digest runs:** **3/3 valid** — every digest run's injected snapshot
  carries both sentinels AND a real (non-warning) `→ impact` section.
- **Headline resolution:** baseline **0/3**, impact-digest **1/3**. One
  **digest_only_pass** (sphinx-7462); two both_fail; no baseline_only_pass.
- **Headline token/cost/tool-turn:** impact-digest **regressed** on every pair —
  pooled **tokens +107.1%**, **cost +80.6%**, **cache-read +112.5%** (per-pair token
  deltas +22%, +26%, **+391%**; the django-13195 blow-up dominates but the regression
  is present on all three).
- **Headline impact/context-to-action:** the impact-enriched digest **surfaced** the
  hidden pivot / co-edit gold files in all three cases (incl. all 3 gold for
  django-13195), and the agent **did not over-edit** any non-gold pivot/impact row
  (no over-anchoring). But co-edit **action** materialized only on sphinx (edited the
  hidden pivot `ast.py` → resolved); on django-13195 the agent edited only **1 of 3**
  surfaced gold files.
- **Verdict: MIXED.** **Recommendation: revisit pivot-inspection enforcement.**

## Pre-flight

- **Method:** non-agent injected-context pre-flight
  (`run_stage5_m56c_preflight.ts`) reproducing the exact `run-protocol`
  `runEngineQuery` path — capsule v2 subprocess → `classifyCapsuleOutput` with the
  M56B DB-backed `digestEnrichmentProvider` — against each case's already-built M55Y
  workspace index (the index build is unchanged by M56B, so the enrichment computed
  is identical to a fresh run's). No agent, no Docker, no spend.
- **Instance used:** required on one (`sphinx-doc__sphinx-7462`); proactively run on
  **all three** selected cases to avoid spending a live run on a case where impact
  fails to resolve.
- **Sentinel present?** Yes — `<VTRACE_CAPSULE_V2_DIGEST_START/END>` on all three.
- **Real impact section present?** Yes (non-warning `→ impact`):
  sphinx-7462 `6 dependents, 2 cross-file`; django-11820 `1683 dependents, 257
  cross-file`; django-13195 `8 dependents, 3 cross-file`. memory/rules honestly remain
  `*_not_threaded_into_digest` (no observation/rule store on a fresh SWE-bench index).
- **Any live run before pre-flight?** No. Pre-flight passed on all three *before* any
  live agent ran. The per-run live snapshots were independently re-validated mid-run
  (sentinel + non-warning `→ impact`) before scoring.

## Run Matrix

| instance_id | category | baseline_run_label | digest_run_label | digest_valid | impact_enriched | evaluated |
| --- | --- | --- | --- | --- | --- | --- |
| sphinx-doc__sphinx-7462 | A | m56c_baseline_sphinx_7462 | m56c_vtrace_digest_impact_sphinx_7462 | yes | yes (6 dep / 2 xfile) | docker |
| django__django-11820 | A | m56c_baseline_django_11820 | m56c_vtrace_digest_impact_django_11820 | yes | yes (1683 dep / 257 xfile) | docker |
| django__django-13195 | D | m56c_baseline_django_13195 | m56c_vtrace_digest_impact_django_13195 | yes | yes (8 dep / 3 xfile) | docker |

## Results Table

| instance | condition | resolved | patch | total_tokens | cache_read | cost | tool_calls | reads | searches | repeated_reads | digest | impact | lead_pivot_edited | hidden/co-edit_pivot_edited | impact_rep_edited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | baseline | ✗ | yes | 639,072 | 595,524 | $0.323 | 7 | 3 | 0 | 2 | – | – | – | – | – |
| sphinx-7462 | digest | **✓** | yes | 777,493 | 709,933 | $0.423 | 9 | 3 | 0 | 1 | yes | yes | yes (ast.py) | **yes (ast.py)** | yes (python.py) |
| django-11820 | baseline | ✗ | yes | 708,444 | 652,910 | $0.403 | 7 | 1 | 1 | 0 | – | – | – | – | – |
| django-11820 | digest | ✗ | yes | 889,199 | 833,890 | $0.471 | 9 | 2 | 0 | 1 | yes | yes | no (enums.py ignored) | n/a (gold=base.py edited) | no (checks.py ignored) |
| django-13195 | baseline | ✗ | yes | 396,003 | 354,512 | $0.253 | 4 | 2 | 1 | 1 | – | – | – | – | – |
| django-13195 | digest | ✗ | yes | 1,944,862 | 1,861,916 | $0.874 | 17 | 4 | 2 | 1 | yes | yes | yes (response.py) | partial (1/3 gold) | yes (response.py) |

Note: lead pivot = first `●` in the injected digest. For django-11820 the lead pivot
is the **non-gold** `enums.py` (correctly *ignored* by the agent — no over-anchor);
the gold `base.py` is digest pivot #2 and was edited.

## Paired Outcomes

- both_pass: **0**
- both_fail: **2** (django-11820, django-13195)
- digest_only_pass: **1** (sphinx-7462)
- baseline_only_pass: **0**

Resolution: baseline 0/3 → impact-digest 1/3.

## Paired Deltas

| pair | token_delta | cache_read_delta | cost_delta | tool_call_delta | read_delta | search_delta | resolution_delta |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sphinx-7462 | +22.0% | +19.2% | +30.8% | +2 | 0 | 0 | **+1** |
| django-11820 | +25.5% | +27.7% | +16.9% | +2 | +1 | −1 | 0 |
| django-13195 | +391.1% | +425.2% | +245.9% | +13 | +2 | +1 | 0 |
| **pooled** | **+107.1%** | **+112.5%** | **+80.6%** | — | — | — | **+1** |

## Context-to-Action Analysis

### sphinx-doc__sphinx-7462 (A) — digest_only_pass ✅ supports the hypothesis

- **Digest showed:** lead pivot `sphinx/pycode/ast.py::unparse` (the gold hidden
  pivot the traceback only partially names); `sphinx/domains/python.py` as skel
  (the symptom file); `→ impact 6 dependents, 2 cross-file`.
- **Inspected:** `python.py`, `ast.py` (×2). **Edited:** `python.py` **and**
  `ast.py` — i.e. **both gold files**.
- **Baseline** edited only `python.py` (the symptom) → failed. The digest run edited
  the hidden pivot `ast.py` → **resolved**.
- **Ignored:** the off-target `application.py` skel pivots and the test-file impact
  row — correct restraint.
- **Supports the impact-enriched-digest hypothesis:** surfacing + acting on the hidden
  pivot is exactly the mechanism, and it flipped the outcome.

### django__django-11820 (A) — both_fail, neutral-to-negative

- **Digest showed:** lead pivot `enums.py` (**non-gold**); gold `base.py` as pivot #2;
  `→ impact 1683 dependents, 257 cross-file` (reps `base.py`, `admin/checks.py`).
- **Inspected/edited:** `base.py` only (the single gold) — same file the baseline
  edited. Both patches were wrong → both_fail. **Localization was never the gap here.**
- **Ignored:** the non-gold lead pivot `enums.py` and non-gold impact rep `checks.py`
  — **no over-anchoring** (the digest did not pull the agent onto wrong files).
- **Net:** +25.5% tokens / +16.9% cost for no resolution change — overhead without
  benefit on a localize-but-fail case.

### django__django-13195 (D) — both_fail, surfaced-but-did-not-act + heavy overhead

- **Digest showed (strong localization):** **all three gold files** —
  lead pivot `http/response.py::HttpResponseBase.set_cookie`, skel pivots
  `contrib/sessions/middleware.py` and `contrib/messages/storage/cookie.py`;
  `→ impact 8 dependents, 3 cross-file` (rep `http/response.py`).
- **Acted on:** edited `http/response.py` (1 of 3 gold); **inspected**
  `sessions/middleware.py` (read, not edited); **ignored** `cookie.py`. The non-gold
  impact rep `admin/options.py` was ignored (no over-anchor).
- **Co-edit action did NOT materialize:** despite the digest surfacing every gold
  co-edit target, the agent edited only one. Resolution needs all FAIL_TO_PASS
  (multi-file fix) → fail. Same 1/3-gold edit as baseline.
- **Severe overhead:** +391% tokens, +246% cost, +13 tool calls (9 bash/other) — the
  agent explored heavily but under-edited.

**Cross-case reading:** the impact-enriched digest reliably **surfaces** the hidden
pivot / co-edit gold (3/3 cases) and is **over-anchor-safe** (non-gold rows ignored in
both django cases). It converts surfacing into a *resolved co-edit* only when the
co-edit is small and the hidden pivot is the crux (sphinx). On a genuine multi-file
co-edit (django-13195) the surfaced targets did not become edits, and on a
localize-but-fail case (django-11820) surfacing cannot help. Cost/tokens regressed on
all three fresh same-window pairs.

## Caveats

- **Treatment bundle:** per the milestone's command template (pivot-check not
  disabled), the default `strict_risk_gated` policy fired on all three digest runs, so
  each digest snapshot also carries `## PIVOT_CHECK` + `## EDIT_GUARD` +
  `## PATCH_VERIFY`. The treatment is therefore "impact-enriched digest **within** the
  default vtrace-indexed scaffolding" vs. a bare baseline — not the digest in
  isolation. Identical across all three digest runs.
- **Token sign vs. M55Z:** M55Z reported pooled tokens −15.3%, but 21/24 of its
  baselines were **reused** from older runs. This M56C set used **fresh same-window**
  baselines and shows the vtrace-indexed+digest treatment costs *more* tokens than a
  fresh baseline — suggesting M55Z's reduction was at least partly an artifact of
  stale reused baselines. Same-window comparison is the more trustworthy signal.
- **n=3, single replicate.** No statistical claim is made.

## Verdict

**MIXED.** There is real, mechanism-level signal — the impact-enriched digest is valid
in 3/3 runs, surfaces the hidden pivot / co-edit gold in 3/3, is over-anchor-safe, and
produced one clean digest_only_pass by driving the hidden-pivot edit on sphinx-7462.
But it is **not** enough to justify more breadth or a default change: co-edit *action*
did not materialize on the multi-gold D case (1/3 gold edited despite all 3 surfaced),
and tokens/cost **regressed on every pair** in this fresh same-window comparison
(pooled +107% tokens / +81% cost), unacceptably so on django-13195 (+391%).

## Recommendation

**Revisit pivot-inspection enforcement.** The dominant gap is context-to-**action** on
co-edit: the digest already surfaces the co-edit gold targets, but the agent edits only
a subset. The M12 enforcement block (explicit EDITED / RULED_OUT decision per non-lead
pivot and co-edit candidate, with anti-over-edit guardrails) directly targets that gap
— converting "surfaced" into an explicit per-target edit/rule-out decision — and is the
right next lever before (a) any broader confirmation, (b) implementing exact edge
call-site snippets, or (c) making the impact-enriched digest a Stage 5 default. The
token/cost regression on fresh same-window baselines must also be characterized and
bounded before the digest becomes a default.

## Acceptable-claim ledger

- Impact-enriched digest was valid in **3/3** digest runs.
- It surfaced the hidden pivot / co-edit gold in **3/3** cases and over-edited a
  non-gold row in **0/3** cases.
- It resolved **1** digest-only case (sphinx-7462) in this targeted confirmation by
  driving the hidden-pivot edit.
- It changed tokens by **+107.1%** and cost by **+80.6%** (pooled) on this targeted
  confirmation's fresh same-window pairs.

No claim is made that VTRACE beats VEXP, improves SWE-bench pass@1 generally, is
statistically better, or that impact caused every pass.
