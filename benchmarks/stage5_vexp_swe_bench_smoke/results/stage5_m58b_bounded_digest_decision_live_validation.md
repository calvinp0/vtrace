# Stage 5 M58B Bounded Digest Decision Live Validation

Targeted A+D confirmation of the M58 **bounded** digest decision contract
(`--bounded-digest-decisions`: three-way EDIT / RULE_OUT / INSPECT_ONLY_NO_EDIT +
anti-over-edit guidance + tighter impact-target selection), reusing the M56C baselines
and the M57B decision-contract runs. Not a benchmark; not a pass-rate claim.

Question: *Does the M58 bounded contract preserve required-target closure while reducing
token/cost/tool-turn regression compared with M57?*

## Summary

- **Cases selected:** 3 (sphinx-doc__sphinx-7462, django__django-11820, django__django-13195) — the M56C/M57B A+D set.
- **New live runs performed:** 3 M58 treatment runs (within the 6-run cap; 3 unused).
- **Reused artifacts:** 3 M56C baselines (`raw/baseline/`) + 3 M57B decision-contract runs (`raw/vtrace/`). No fresh baselines / no fresh M57 runs.
- **Valid / invalid M58 runs:** **3 valid / 0 invalid** (every snapshot carried digest ×1, decision-contract ×1, real `→ impact`, the three-way bounded choices ×3, 3 required targets ≤4, compact applied).
- **Headline resolution:** baseline **0/3** → M57 **1/3** → M58 **1/3** (sphinx in both; unchanged, no new pass, no regression).
- **Headline token/cost/tool-turn (M57 → M58, pooled):** tokens **−14.1 %**, cache-read **−15.0 %**, cost **−7.7 %**, tool calls −3, reads −1, repeated reads −1. The reduction is driven by the M57B blow-up case **django-13195: tokens −36.8 %, cost −23.0 %, turns 65 → 41, tool calls 24 → 16, repeated reads 4 → 1.**
- **Headline bounded-decision compliance:** strict valid-reason **closed** fell 8/9 → 6/9 and **open** rose 1 → 3 — but investigation shows this is a **classifier-vocabulary artifact**, not weaker behavior: M58 agents emitted explicit decisions in terse Markdown tables the prose-tuned reason detector under-credits. By decision-coverage (any explicit EDIT/RULE_OUT/INSPECT_ONLY/attempted-rule-out), M58 **improved**: **9/9 decided vs 8/9**, and **ignored fell 1 → 0**.
- **Verdict:** **MIXED.**

## Pre-flight

- **Method:** non-agent injected-context build (`run_stage5_m58b_preflight.ts`) — the exact
  `classifyCapsuleOutput` path with `injectDigest` + `digestDecisionContract` +
  `boundedDigestDecisions` + `compactDigestInjection` against each case's persisted workspace
  index. Spawns the capsule query once; classifies the M58 bounded context plus the M57
  (non-bounded) context to measure the required-impact-rep tightening. No agent, no Docker, no spend.
- **Cases checked:** all 3, **before** any live run.
- **Digest sentinel present?** Yes — exactly once each.
- **Decision contract sentinel present?** Yes — exactly once each.
- **Real impact present (non-warning `→ impact`)?** Yes each.
- **Bounded choices present?** Yes — `decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT` + anti-over-edit wording each.
- **Required target count:** 3 / 3 / 3 (all ≤ 4).
- **Optional target demotion:** none rendered — all 3 cases surface only **one** impact representative, so there is no second rep to demote. **Consequently the M57 and M58 required-target sets are identical for these cases; M58B isolates the contract *wording / three-way decision* effect, not the target-selection effect** (the selection tightening only bites on cases with ≥ 2 impact reps).
- **Compact mode applied?** Yes — `## VTRACE inspect-first` absent in all 3.
- **memory/rules warnings honest?** Yes (no DB data → warnings present).
- **Any live run before pre-flight?** No. Pre-flight ran first; all 3 PASSed, then the 3 live runs launched.

## Run Matrix

| instance | baseline (A) | M57 contract (B) | M58 bounded (C) | M58 valid | evaluated |
|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | `m56c_baseline_sphinx_7462` (reused) | `m57b_vtrace_digest_contract_sphinx_7462` (reused) | `m58b_vtrace_bounded_contract_sphinx_7462` | yes | docker |
| django__django-11820 | `m56c_baseline_django_11820` (reused) | `m57b_vtrace_digest_contract_django_11820` (reused) | `m58b_vtrace_bounded_contract_django_11820` | yes | docker |
| django__django-13195 | `m56c_baseline_django_13195` (reused) | `m57b_vtrace_digest_contract_django_13195` (reused) | `m58b_vtrace_bounded_contract_django_13195` | yes | docker |

Config delta C vs B: **+`--bounded-digest-decisions`** only. All else matched (vtrace-indexed,
force-inject, v2, debug, 8000, inject-digest, digest-decision-contract, compact-digest-injection,
pivot-check `strict_risk_gated`).

## Results Table

| instance | condition | resolved | patch | total_tokens | cache_read | cost | tools | reads | searches | repeated_reads | req_targets | closed | open | edited | ruled_out | inspect_only | ignored |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | baseline | ✗ | ✓ | 639,072 | 595,524 | 0.323 | 7 | 3 | 0 | 2 | – | – | – | – | – | – | – |
| sphinx-7462 | M57 | ✓ | ✓ | 721,566 | 646,891 | 0.424 | 8 | 2 | 0 | 0 | 3 | 2 | 1 | 2 | 0 | 0 | 1 |
| sphinx-7462 | **M58** | ✓ | ✓ | 1,067,370 | 995,655 | 0.498 | 13 | 5 | 1 | 3 | 3 | 2 | 1 | 2 | 0 | 0 | 0¹ |
| django-11820 | baseline | ✗ | ✓ | 708,444 | 652,910 | 0.403 | 7 | 1 | 0 | 0 | – | – | – | – | – | – | – |
| django-11820 | M57 | ✗ | ✓ | 731,373 | 679,679 | 0.398 | 7 | 2 | 0 | 1 | 3 | 3 | 0 | 1 | 2 | 0 | 0 |
| django-11820 | **M58** | ✗ | ✓ | 765,423 | 711,923 | 0.416 | 7 | 1 | 0 | 0 | 3 | 1 | 2 | 1 | 0¹ | 0 | 0 |
| django-13195 | baseline | ✗ | ✓ | 396,003 | 354,512 | 0.253 | 4 | 2 | 0 | 1 | – | – | – | – | – | – | – |
| django-13195 | M57 | ✗ | ✓ | 2,572,499 | 2,485,001 | 1.006 | 24 | 8 | 7 | 4 | 3 | 3 | 0 | 2 | 1 | 0 | 0 |
| django-13195 | **M58** | ✗ | ✓ | 1,624,745 | 1,533,058 | 0.775 | 16 | 5 | 5 | 1 | 3 | 3 | 0 | 2 | 0 | 1 | 0 |

¹ **Classifier note.** Several M58 non-edit decisions are scored `INVALID_RULE_OUT` (counted as
*open*) because the agent wrote terse table reasons the prose-tuned `BEHAVIORAL_REASON_PATTERN`
doesn't recognize — e.g. django-11820 M58 ruled out both non-lead targets with
*"False positive — handles enum choices, not model ordering"* and *"Just a dependent caller, fix
belongs in core method."* These are genuine, well-reasoned rule-outs. So M58's `ruled_out=0` /
`open=2` on django-11820 understates real compliance; the agent made explicit decisions on **every**
target (decision-coverage 9/9, ignored 0).

## Paired Outcomes

| comparison | both_pass | both_fail | C_only_pass | B_only_pass | baseline_only_pass |
|---|---|---|---|---|---|
| baseline vs M57 | 0 | 2 | – | 1 (sphinx) | 0 |
| baseline vs M58 | 0 | 2 | 1 (sphinx) | – | 0 |
| M57 vs M58 | 1 (sphinx) | 2 | 0 | 0 | – |

- M58-only passes: **0**. M57-only passes: **0**. Baseline-only passes: **0**.
- Resolution identical B↔C: sphinx passes in both; both django cases fail in both.

## Paired Deltas (M57 → M58, pooled over 3 cases)

| metric | M57 | M58 | delta |
|---|---|---|---|
| total tokens | 4,025,438 | 3,457,538 | **−567,900 (−14.1 %)** |
| cache-read tokens | 3,811,571 | 3,240,636 | **−15.0 %** |
| cost (USD) | 1.828 | 1.688 | **−7.7 %** |
| tool calls | 39 | 36 | **−3** |
| reads | 12 | 11 | **−1** |
| searches | 7 | 6 | −1 |
| repeated reads | 5 | 4 | −1 |
| resolution | 1/3 | 1/3 | **0** |
| closed required targets (strict, valid reason) | 8 | 6 | **−2** |
| open required targets | 1 | 3 | **+2** |
| ignored required targets | 1 | 0 | **−1** |
| decision-coverage (any explicit decision) | 8/9 | 9/9 | **+1** |
| edits outside required targets | 2 | 2 | 0 |

Per-case token delta (B → C): django-13195 **−36.8 %**, django-11820 **+4.7 %**, sphinx **+47.9 %**.
The pooled reduction is dominated by django-13195; sphinx *rose* (likely run variance — it still
resolves, and is the explicitly "do-not-tune" case); django-11820 is roughly flat.

## Bounded Contract Analysis

Per required target, M57 → M58 (decisions; the `outside` column is edits to files that are **not**
required targets — the over-edit signal):

**sphinx-7462** (resolves both):
- python.py EDITED→EDITED · ast.py EDITED→EDITED · test_domain_py.py **IGNORED → INVALID_RULE_OUT**.
- M58 made the agent *attempt* a decision on the impact test file (M57 ignored it). Cost rose (+48 % tokens, 20→30 turns, 3 repeated reads) — no optional context here, so this is contract-wording overhead / variance on a case that already passed.

**django-11820** (fails both):
- base.py EDITED→EDITED · enums.py **RULED_OUT → INVALID_RULE_OUT** · checks.py **RULED_OUT → INVALID_RULE_OUT**.
- The agent ruled out both non-lead targets in M58 with sound reasons (table format), but the classifier under-credits the terse reasons. Behaviorally equivalent-or-better; cost ~flat (+4.7 %). No off-target edits.

**django-13195** (fails both; the M57B blow-up case):
- response.py EDITED→EDITED ×2 · options.py **RULED_OUT → INSPECT_ONLY_NO_EDIT**.
- The new `INSPECT_ONLY_NO_EDIT` decision was used and recognized. **Exploration cost collapsed: tokens −36.8 %, cost −23.0 %, turns 65 → 41, tool calls 24 → 16, repeated reads 4 → 1.** Closure preserved (3/3).
- **However the off-target edits persist:** M58 still edited `messages/storage/cookie.py` and `sessions/middleware.py` (2 files outside the required targets), same as M57. The anti-over-edit wording **reduced over-exploration but did not stop the over-edit itself** on this multi-gold case.

Did optional targets cause extra exploration? **N/A** — no optional context was rendered for any
of these cases (single impact rep each), so the selection-tightening lever was not exercised here.

## Cost / Over-Exploration Analysis

- **Did M58 reduce cost vs M57?** Pooled yes (−7.7 % cost, −14.1 % tokens), but unevenly: huge on
  django-13195, ~flat on django-11820, *worse* on sphinx (variance on an already-passing case).
- **Did M58 reduce repeated reads?** Pooled −1 (5 → 4); on the target case django-13195, 4 → 1.
- **Did M58 reduce tool turns?** Pooled −3 (39 → 36); django-13195 24 → 16.
- **Did the django-13195 cost blow-up shrink?** **Yes, substantially** — the headline result: 2.57 M → 1.62 M tokens, $1.006 → $0.775, 65 → 41 turns. This is the exact M57B failure M58 targeted.
- **Did optional-target demotion prevent over-expansion?** Not testable here (no demotions). The off-target edits on django-13195 came from the agent expanding from the *pivots* into cookie/session modules, not from an optional impact rep — so the demotion lever wouldn't have addressed them; only the anti-over-edit wording applied, and it cut exploration but not the edits.
- **Safety blocks:** PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY present in all 3 M58 snapshots.

## Verdict

**MIXED.** M58 delivers a real, large reduction in over-exploration on the precise case it
targeted (django-13195: −37 % tokens, −23 % cost, 65 → 41 turns, repeated reads 4 → 1) and pooled
cost/token/turn all fall vs M57, with resolution unchanged (1/3) and ignored targets eliminated
(1 → 0, decision-coverage 8/9 → 9/9). But (a) the *strict* valid-reason closure metric regressed
(8 → 6) — shown to be a classifier-vocabulary artifact, not weaker behavior, yet it means compliance
cannot be cleanly claimed as preserved on the current metric; (b) the over-edit on the multi-gold
case persists (2 off-target edits, unchanged); and (c) sphinx got *more* expensive (+48 % tokens),
plausibly variance but unexplained at n=1. Useful, on-target improvement; not an unambiguous win.

## Recommendation

**Proceed to a small replicated A+D confirmation** (e.g. 3× replicates of the same 3 cases),
**after first tightening the rule-out grammar** so the classifier credits the structured
decision-table reasons the bounded contract elicits (otherwise compliance will keep being
mis-measured — the present run already shows valid table rule-outs scored `INVALID_RULE_OUT`).
The replicate should confirm whether django-13195's cost drop and sphinx's cost rise are stable or
variance, and measure the over-edit signal (`edited_files_outside_required_targets`) directly. Do
**not** make the bounded contract part of Stage 5 treatment yet, and do **not** jump to a broad
confirmation on n=1.

---

### Provenance

- Pre-flight: `run_stage5_m58b_preflight.ts` (per case, against the persisted workspace index).
- Live runs: `run-protocol --protocol vtrace-indexed --context-policy force-inject --capsule-engine v2
  --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest --digest-decision-contract
  --bounded-digest-decisions --compact-digest-injection` → labels `m58b_vtrace_bounded_contract_*`. Docker evaluate per label.
- Metrics + classification: `run_stage5_m58b_analyze.ts` (reads captured artifacts; reuses the M58
  `classifyDigestDecisionContract` incl. `INSPECT_ONLY_NO_EDIT` + closed/open partition).
- Token convention: `total_tokens = input + output + cache_read + cache_creation` (matches M56C/M57B).
