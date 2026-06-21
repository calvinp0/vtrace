# Stage 5 M57B Digest Decision Contract Live Validation

Targeted A+D confirmation of the M57 digest **decision contract** (`--digest-decision-contract`)
and **compact injection** (`--compact-digest-injection`), reusing the M56C fresh baseline +
impact-digest artifacts. Not a benchmark; not a breadth/pass-rate claim.

Question: *Does the M57 decision contract improve action on surfaced digest/impact targets,
while compact injection bounds the token/cost regression seen in M56C?*

## Summary

- **Cases selected:** 3 (sphinx-doc__sphinx-7462, django__django-11820, django__django-13195) — the M56C A+D set.
- **New live runs performed:** 3 M57 treatment runs (within the 6-run cap; 3 unused).
- **Reused M56C artifacts:** 3 fresh baselines (`raw/baseline/`) + 3 impact-digest runs (`raw/vtrace/`). No fresh baselines needed.
- **Valid / invalid M57 runs:** **3 valid / 0 invalid** (every run's snapshot carried digest ×1, decision-contract ×1, real `→ impact`, 3 required targets ≤4, compact applied).
- **Headline resolution:** baseline **0/3** → M56C impact **1/3** → M57 contract **1/3** (sphinx in both; unchanged, no new pass, no regression).
- **Headline token/cost/tool-turn (M56C impact → M57 contract, pooled):** tokens **+11.5 %**, cache-read **+11.9 %**, cost **+3.4 %**, tool calls +4, reads +3. The pooled regression did **not** shrink — it grew, driven entirely by one over-anchor blow-up (django-13195). On the other 2/3 cases M57 was **cheaper** (sphinx −7.2 %, django-11820 −17.7 % tokens).
- **Headline decision-contract compliance (counterfactual M56C → M57):** ignored required targets **4 → 1 (−75 %)**; targets actioned (edited *or* validly ruled out) **5/9 → 8/9**; invalid rule-outs **0 → 0**. The contract converted previously-ignored django targets into explicit valid RULE_OUTs.
- **Verdict:** **MIXED** — clear action/compliance win and cheaper on 2/3 cases, but cost regression not bounded at the pool level (one over-anchor blow-up) and resolution flat.

## Pre-flight

- **Method:** non-agent injected-context build (`run_stage5_m57b_preflight.ts`) — runs the exact
  `classifyCapsuleOutput` path (capsule v2 subprocess + DB-backed `buildStage5DigestEnrichmentsBestEffort`,
  intent debug, budget 8000, `injectDigest` + `digestDecisionContract` + `compactDigestInjection`) against
  each case's persisted M56C workspace index. No agent, no Docker, no spend. The capsule query is spawned
  once and classified twice (compact off/on) to prove the compaction delta.
- **Cases checked:** all 3 selected M57 treatment cases, **before** any live run.
- **Digest sentinel present?** Yes — exactly once in every case.
- **Decision contract sentinel present?** Yes — exactly once in every case.
- **Impact present (real, non-warning `→ impact`)?** Yes in every case.
- **Required target count:** 3 / 3 / 3 (all ≤ 4).
- **Compact mode applied?** Yes — `## VTRACE inspect-first` present in the non-compact render, absent in the compact render (≈ 700 chars dropped per case).
- **Memory/rules warnings honest?** Yes — `memory_not_threaded` / `rules_not_threaded` warnings present (no DB data to thread).
- **Any live run before pre-flight?** No. Pre-flight ran first; all 3 cases PASSed all 7 requirements, then the 3 live runs were launched.

Required targets surfaced (identical in pre-flight and in every live snapshot):

| case | target 1 (lead PIVOT) | target 2 (hidden/co-PIVOT) | target 3 (IMPACT) |
|---|---|---|---|
| sphinx-7462 | `sphinx/domains/python.py::_parse_annotation` | `sphinx/pycode/ast.py::unparse` | `tests/test_domain_py.py::test_parse_annotation` |
| django-11820 | `django/db/models/base.py::Model._check_ordering` | `django/db/models/enums.py::ChoicesMeta` | `django/contrib/admin/checks.py::_check_inlines_item` |
| django-13195 | `django/http/response.py::HttpResponseBase.delete_cookie` | `django/http/response.py::HttpResponseBase.set_cookie` | `django/contrib/admin/options.py::response_action` |

## Run Matrix

| instance | baseline (A) | M56C impact digest (B) | M57 contract (C) | M57 valid | evaluated |
|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | `m56c_baseline_sphinx_7462` (reused) | `m56c_vtrace_digest_impact_sphinx_7462` (reused) | `m57b_vtrace_digest_contract_sphinx_7462` | yes | docker |
| django__django-11820 | `m56c_baseline_django_11820` (reused) | `m56c_vtrace_digest_impact_django_11820` (reused) | `m57b_vtrace_digest_contract_django_11820` | yes | docker |
| django__django-13195 | `m56c_baseline_django_13195` (reused) | `m56c_vtrace_digest_impact_django_13195` (reused) | `m57b_vtrace_digest_contract_django_13195` | yes | docker |

Configuration delta C vs B: **+`--digest-decision-contract` +`--compact-digest-injection`** only. All else
matched (protocol vtrace-indexed, `force-inject`, engine v2, intent debug, budget 8000,
`--inject-capsule-digest`, pivot-check `strict_risk_gated`).

## Results Table

| instance | condition | resolved | patch | total_tokens | cache_read | cost | tools | reads | repeated_reads | contract? | req_targets | edited | ruled_out | ignored |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | baseline | ✗ | ✓ | 639,072 | 595,524 | 0.323 | 7 | 3 | 2 | no | – | – | – | – |
| sphinx-7462 | M56C impact | ✓ | ✓ | 777,493 | 709,933 | 0.423 | 9 | 3 | 1 | no¹ | 3 | 2 | 0 | 1 |
| sphinx-7462 | **M57 contract** | ✓ | ✓ | 721,566 | 646,891 | 0.424 | 8 | 2 | 0 | yes | 3 | 2 | 0 | 1 |
| django-11820 | baseline | ✗ | ✓ | 708,444 | 652,910 | 0.403 | 7 | 1 | 0 | no | – | – | – | – |
| django-11820 | M56C impact | ✗ | ✓ | 889,199 | 833,890 | 0.471 | 9 | 2 | 1 | no¹ | 3 | 1 | 0 | 2 |
| django-11820 | **M57 contract** | ✗ | ✓ | 731,373 | 679,679 | 0.398 | 7 | 2 | 1 | yes | 3 | 1 | 2 | 0 |
| django-13195 | baseline | ✗ | ✓ | 396,003 | 354,512 | 0.253 | 4 | 2 | 1 | no | – | – | – | – |
| django-13195 | M56C impact | ✗ | ✓ | 1,944,862 | 1,861,916 | 0.874 | 17 | 4 | 1 | no¹ | 3 | 2 | 0 | 1 |
| django-13195 | **M57 contract** | ✗ | ✓ | 2,572,499 | 2,485,001 | 1.006 | 24 | 8 | 4 | yes | 3 | 2 | 1 | 0 |

¹ M56C runs never injected the contract; their `edited/ruled_out/ignored` columns are a **counterfactual**
classification — the same M57 contract targets scored against the M56C run's tool-calls + patch + final text.

## Paired Outcomes

| comparison | both_pass | both_fail | C_only_pass | B_only_pass | baseline_only_pass |
|---|---|---|---|---|---|
| baseline vs M56C impact | 0 | 2 | – | 1 (sphinx) | 0 |
| baseline vs M57 contract | 0 | 2 | 1 (sphinx) | – | 0 |
| M56C impact vs M57 contract | 1 (sphinx) | 2 | 0 | 0 | – |

- M57-only passes: **0**. M56C-only passes: **0**. Baseline-only passes: **0**.
- Resolution is identical across B and C: sphinx passes in both; the two django cases fail in both.

## Paired Deltas (M56C impact digest → M57 contract, pooled over 3 cases)

| metric | M56C | M57 | delta |
|---|---|---|---|
| total tokens | 3,611,554 | 4,025,438 | **+413,884 (+11.5 %)** |
| cache-read tokens | 3,405,739 | 3,811,571 | **+11.9 %** |
| cost (USD) | 1.768 | 1.828 | **+3.4 %** |
| tool calls | 35 | 39 | **+4** |
| reads | 9 | 12 | **+3** |
| searches | 0 | 0 | 0 |
| resolution | 1/3 | 1/3 | **0** |
| ignored required targets | 4 | 1 | **−3 (−75 %)** |

Per-case token delta (B → C): sphinx **−7.2 %**, django-11820 **−17.7 %**, django-13195 **+32.3 %**.
The pooled increase is **entirely** the django-13195 over-anchor blow-up (turns 49→65, tools 17→24, 3 files
edited); the other two cases got *cheaper* under compact + contract.

## Decision Contract Analysis

Per required target (`EDITED` / `RULED_OUT` / `INSPECTED_ONLY` / `IGNORED` / `INVALID_RULE_OUT`),
counterfactual M56C → live M57:

**sphinx-7462** — *no behavior change; resolves in both.*
- python.py (lead): EDITED → EDITED · ast.py (hidden co-pivot): EDITED → EDITED · test_domain_py.py (impact): IGNORED → IGNORED.
- The contract didn't change action here — the agent already edited both gold pivots; the impact test file is correctly left unedited (no behavioral rule-out emitted, so it scores IGNORED in both).

**django-11820** — *contract converted 2 ignored → 2 valid rule-outs; cheaper.*
- base.py (lead): EDITED → EDITED · enums.py (hidden co-pivot): **IGNORED → RULED_OUT** · checks.py (impact): **IGNORED → RULED_OUT**.
- Under the contract the agent explicitly reasoned about and ruled out both non-lead targets (0 ignored), and did so with **fewer** tokens (−17.7 %) and turns (25→21). Cleanest contract win.

**django-13195** — *contract converted 1 ignored → 1 valid rule-out, but over-anchored and blew up.*
- response.py delete_cookie (lead): EDITED → EDITED · response.py set_cookie (co-pivot): EDITED → EDITED · options.py (impact): **IGNORED → RULED_OUT**.
- 0 ignored, no invalid rule-outs — but the agent also edited two files **outside** the required targets
  (`messages/storage/cookie.py`, `sessions/middleware.py`) and churned to 65 turns / 24 tools / 2.57 M tokens.
  This is the multi-gold over-anchor failure mode; n=1 can't separate contract-induced churn from variance
  (13195 was already the M56C outlier at 1.94 M / 49 turns).

Aggregate: ignored **4 → 1**, actioned (edited or valid rule-out) **5/9 → 8/9**, invalid rule-outs **0**.
The contract demonstrably changed behavior on both django cases (ignored → explicit rule-out); it did not
change the already-good sphinx behavior.

## Cost / Compact Mode Analysis

- **Did compact mode reduce prompt/context size vs M56C?** Yes, structurally — the `## VTRACE inspect-first`
  block (present in all 3 M56C snapshots) is absent in all 3 M57 snapshots (≈ 700 chars / case in pre-flight).
  The decision-contract block (~700 chars) is added in its place, so the injected context is roughly size-neutral.
- **Did the total token/cost regression shrink vs M56C?** Not at the pool level — pooled tokens +11.5 %, cost
  +3.4 % vs M56C. Compact + contract reduced runtime tokens on 2/3 cases (sphinx −7.2 %, django-11820 −17.7 %),
  but the django-13195 over-anchor blow-up (+32.3 %) more than erased the savings. vs baseline: M57 +130.9 %
  tokens / +86.8 % cost (M56C was +107.1 % / +80.6 %).
- **Which duplicated section was removed/compacted?** The `## VTRACE inspect-first` block (a re-ranked
  restatement of the digest's lead/related pivots).
- **Did safety blocks remain?** Yes — PIVOT_CHECK, EDIT_GUARD, and PATCH_VERIFY are all present in every M57 snapshot.

## Verdict

**MIXED.** The decision contract produced a clear, real action signal — ignored required targets fell 4 → 1
(−75 %), targets actioned rose to 8/9, with zero invalid rule-outs, and it converted previously-ignored
django targets into explicit valid rule-outs. Compact + contract was also *cheaper* on 2/3 cases. But the
pooled cost/token regression vs M56C was **not** bounded — it grew (+11.5 % tokens, +3.4 % cost), entirely
because of a single multi-gold over-anchor blow-up (django-13195: 65 turns, 3 files edited, +32.3 % tokens).
Resolution was flat (1/3, same case as M56C). Some useful action signal, but cost remains problematic on the
over-anchor case.

## Recommendation

**Proceed to a small replicated A+D confirmation** (e.g. 3× replicates of these same 3 cases).
Rationale: the contract reliably converts ignored targets into valid rule-outs and reduced cost on 2/3 cases,
but n=1 cannot distinguish whether django-13195's over-anchor blow-up is contract-induced or run variance
(13195 was already the M56C cost outlier). A small replicate would confirm the ignored-rate improvement and
isolate the 13195 cost behavior before any broader pre-registered confirmation. Pair it with **tighter
anti-over-edit guidance** for multi-gold cases — the contract's "prefer small edits" rule did not prevent the
two off-target edits on 13195. Do **not** make the decision contract part of Stage 5 treatment yet, and do
**not** jump to a broad confirmation on this evidence.

---

### Provenance

- Pre-flight: `run_stage5_m57b_preflight.ts` (per case, against the M56C workspace index).
- Live runs: `run-protocol --protocol vtrace-indexed --context-policy force-inject --capsule-engine v2
  --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest --digest-decision-contract
  --compact-digest-injection` → labels `m57b_vtrace_digest_contract_*`. Docker evaluate per label.
- Metrics + classification: `run_stage5_m57b_analyze.ts` (reads captured artifacts; reuses
  `classifyDigestDecisionContract`; counterfactual scoring of M56C runs against the M57 contract targets).
- Token convention: `total_tokens = input + output + cache_read + cache_creation` (matches the M56C report;
  reproduces M56C's +107.1 % / +112.5 % / +80.6 % headline byte-consistently).
