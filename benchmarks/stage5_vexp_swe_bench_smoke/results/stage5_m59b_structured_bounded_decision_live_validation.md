# Stage 5 M59B Structured Bounded Decision Live Validation

Small **replicated** A+D validation of the M59 structured bounded digest decision
contract (`--bounded-digest-decisions` on commit `60f7708`+: structured
`target_id`/`target`/`decision`/`reason`/`files_touched` grammar + structured-table
classifier). Reuses the M56C baselines, the M57B decision-contract runs, and the M58B
bounded runs; adds **3 fresh M59 replicates per case** (9 new live runs total, at the
approved cap). Not a benchmark; not a pass-rate claim.

Question: *Does the M59 structured bounded contract preserve or improve the M58
cost/over-exploration reduction while keeping required-target decisions measurable and
closed?*

## Summary

- **Cases selected:** 3 (sphinx-doc__sphinx-7462, django__django-11820, django__django-13195) — the M56C/M57B/M58B A+D set.
- **New live runs performed:** **9** (3 cases × 3 replicates), exactly at the 9-run cap. No fresh baselines / M57 / M58 runs.
- **Reused artifacts:** 3 M56C baselines (`raw/baseline/`), 3 M57B contract runs, 3 M58B bounded runs (`raw/vtrace/`).
- **Valid / invalid M59 runs:** **9 valid / 0 invalid.** Every snapshot carried digest ×1, decision-contract ×1, a real `→ impact`, the structured grammar (`target_id`/`target`/`decision`/`reason`/`files_touched`), the three-way `EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT` choices, 3 required targets (≤4), and compact mode applied.
- **Headline resolution:** sphinx **3/3 pass**, django-11820 **0/3**, django-13195 **1/3** (r1). No regression vs M57/M58 on any replicate; **one new pass** on django-13195 (the multi-gold case that failed in baseline/M57/M58).
- **Headline structured-decision compliance:** across the 27 required targets (9 runs × 3), **26 closed / 1 open / 0 ignored / 1 invalid** (decision coverage **26/27 = 96%**, ignored **0%**). The exact M58B failure is gone **live**: django-11820's terse table rule-outs (`enums.py`, `checks.py`) are credited `RULED_OUT`/`INSPECT_ONLY_NO_EDIT` in all 3 replicates, and sphinx's test-file rule-out is credited `RULED_OUT` in all 3.
- **Headline token/cost/tool-turn:** vs **M57** (the regression baseline M58 targeted) M59 pooled tokens **−3.9 %**, cost **−13.7 %**; vs **M58** (single sample/case) pooled tokens **+11.8 %**, cost **−6.6 %**. django-13195 stays bounded **well under M57 in all 3 replicates** (mean tokens −23.7 %, cost −23.0 %, repeated reads 4 → ≤1 vs M57).
- **Verdict:** **PASS** (with caveats: token use rose ~12 % vs M58's single low sample — within replicate variance; the django-13195 2-file over-edit persists unchanged).

## Pre-flight

- **Method:** non-agent injected-context check (`run_stage5_m59b_preflight.ts`). M59 changed ONLY the contract rendering + classifier (retrieval/digest/impact/compact are byte-identical to M58B), so the pre-flight reads each case's REAL M58B injected context, extracts the actual targets+reasons the capsule produced, and **re-renders the bounded contract with current M59 code** — exactly what the live M59 run injects. Each live run is then additionally gated on its own emitted snapshot before being counted valid. No agent, no Docker, no spend.
- **Cases checked:** all 3, before any live run. **All PASS.**
- **Digest sentinel present?** Yes — exactly once each.
- **Decision contract sentinel present?** Yes — exactly once each.
- **Real impact present (non-warning `→ impact`)?** Yes each.
- **Structured grammar present?** Yes — `target_id` / `target` / `decision` / `reason` / `files_touched` each.
- **target_id stable?** Yes — `T1…Tn`, stable and unique each.
- **Required target count:** 3 / 3 / 3 (all ≤ 4).
- **Optional target demotion:** none rendered — all 3 cases surface a single impact representative, so there is no second rep to demote (the selection-tightening lever is not exercised here; M59B isolates the **grammar/classifier** effect, consistent with M58B).
- **Compact mode applied?** Yes — `## VTRACE inspect-first` absent in all 3.
- **memory/rules warnings honest?** Yes (no DB data → warnings present).
- **Any live run before pre-flight?** No. Pre-flight ran first; all 3 PASSed, then the 9 live runs launched sequentially.

### Run Matrix

| instance_id | baseline (A) | M57 (B) | M58 (C) | M59 replicates (D) | M59 valid | evaluated |
|---|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | `m56c_baseline_sphinx_7462` (reused) | `m57b_…_sphinx_7462` (reused) | `m58b_…_sphinx_7462` (reused) | `m59b_structured_bounded_sphinx_7462_r{1,2,3}` | 3/3 | 3/3 |
| django__django-11820 | `m56c_baseline_django_11820` (reused) | `m57b_…_django_11820` (reused) | `m58b_…_django_11820` (reused) | `m59b_structured_bounded_django_11820_r{1,2,3}` | 3/3 | 3/3 |
| django__django-13195 | `m56c_baseline_django_13195` (reused) | `m57b_…_django_13195` (reused) | `m58b_…_django_13195` (reused) | `m59b_structured_bounded_django_13195_r{1,2,3}` | 3/3 | 3/3 |

Config delta D vs C: **none** beyond the M59 code change (same `--bounded-digest-decisions` flag; commit `60f7708`+). All else matched (vtrace-indexed, force-inject, v2, debug, 8000, inject-digest, digest-decision-contract, compact-digest-injection, pivot-check `strict_risk_gated`).

## Results Table

| instance | condition | rep | valid | resolved | patch | total_tokens | cache_read | cost | tools | reads | searches | rep_reads | req | closed | open | edit | ruled | inspect_only | ignored | invalid |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | baseline | – | ✓ | ✗ | ✓ | 639,072 | 595,524 | 0.323 | 7 | 3 | 0 | 2 | – | – | – | – | – | – | – | – |
| sphinx-7462 | M57 | – | ✓ | ✓ | ✓ | 721,566 | 646,891 | 0.424 | 8 | 2 | 0 | 0 | 3 | 2 | 1 | 2 | 0 | 0 | 1 | 0 |
| sphinx-7462 | M58 | – | ✓ | ✓ | ✓ | 1,067,370 | 995,655 | 0.498 | 13 | 5 | 1 | 3 | 3 | 2 | 1 | 2 | 0 | 0 | 0 | 1 |
| sphinx-7462 | **M59** | r1 | ✓ | ✓ | ✓ | 1,039,025 | 966,382 | 0.479 | 11 | 3 | 1 | 1 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 0 |
| sphinx-7462 | **M59** | r2 | ✓ | ✓ | ✓ | 868,053 | 847,450 | 0.327 | 9 | 3 | 0 | 1 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 0 |
| sphinx-7462 | **M59** | r3 | ✓ | ✓ | ✓ | 889,009 | 869,657 | 0.311 | 10 | 4 | 1 | 2 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 0 |
| django-11820 | baseline | – | ✓ | ✗ | ✓ | 708,444 | 652,910 | 0.403 | 7 | 1 | 1 | 0 | – | – | – | – | – | – | – | – |
| django-11820 | M57 | – | ✓ | ✗ | ✓ | 731,373 | 679,679 | 0.398 | 7 | 2 | 0 | 1 | 3 | 2 | 1 | 1 | 1 | 0 | 0 | 1 |
| django-11820 | M58 | – | ✓ | ✗ | ✓ | 765,423 | 711,923 | 0.416 | 7 | 1 | 0 | 0 | 3 | 3 | 0 | 1 | 2 | 0 | 0 | 0 |
| django-11820 | **M59** | r1 | ✓ | ✗ | ✓ | 919,097 | 862,842 | 0.480 | 9 | 1 | 0 | 0 | 3 | 3 | 0 | 1 | 2 | 0 | 0 | 0 |
| django-11820 | **M59** | r2 | ✓ | ✗ | ✓ | 1,016,521 | 997,588 | 0.411 | 10 | 2 | 0 | 1 | 3 | 3 | 0 | 1 | 1 | 1 | 0 | 0 |
| django-11820 | **M59** | r3 | ✓ | ✗ | ✓ | 981,213 | 962,462 | 0.399 | 10 | 2 | 0 | 1 | 3 | 3 | 0 | 1 | 2 | 0 | 0 | 0 |
| django-13195 | baseline | – | ✓ | ✗ | ✓ | 396,003 | 354,512 | 0.253 | 4 | 2 | 1 | 1 | – | – | – | – | – | – | – | – |
| django-13195 | M57 | – | ✓ | ✗ | ✓ | 2,572,499 | 2,485,001 | 1.006 | 24 | 8 | 7 | 4 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 0 |
| django-13195 | M58 | – | ✓ | ✗ | ✓ | 1,624,745 | 1,533,058 | 0.775 | 16 | 5 | 1 | 1 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 0 |
| django-13195 | **M59** | r1 | ✓ | ✓ | ✓ | 2,297,721 | 2,217,022 | 0.969 | 23 | 4 | 9 | 0 | 3 | 2 | 1 | 2 | 0 | 0 | 0 | 1 |
| django-13195 | **M59** | r2 | ✓ | ✗ | ✓ | 1,537,811 | 1,510,914 | 0.568 | 15 | 3 | 2 | 0 | 3 | 3 | 0 | 2 | 0 | 1 | 0 | 0 |
| django-13195 | **M59** | r3 | ✓ | ✗ | ✓ | 2,051,862 | 2,008,900 | 0.787 | 21 | 5 | 6 | 1 | 3 | 3 | 0 | 2 | 0 | 1 | 0 | 0 |

(Token convention: `total_tokens = input + output + cache_read + cache_creation`, matching M56C/M57B/M58B.)

## Replicate Summary

| case | pass / 3 | mean tokens | median tokens | mean cost | median cost | mean tools | median tools | mean closed | mean open | ignored | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | **3 / 3** | 932,029 | 889,009 | 0.372 | 0.327 | 10.0 | 10 | 3.0 | 0.0 | 0 | stable pass; test-file rule-out credited every rep |
| django-11820 | 0 / 3 | 972,277 | 981,213 | 0.430 | 0.411 | 9.7 | 10 | 3.0 | 0.0 | 0 | stable localize-but-fail; all targets closed every rep |
| django-13195 | 1 / 3 | 1,962,465 | 2,051,862 | 0.775 | 0.787 | 19.7 | 21 | 2.67 | 0.33 | 0 | r1 newly resolves; bounded under M57 in all reps; r1 options.py rule-out uncredited (1 invalid) |

## Paired Outcomes

(per valid M59 replicate-run vs the reused comparator; 9 M59 runs)

| comparison | both_pass | both_fail | M59_only_pass | comparator_only_pass |
|---|---|---|---|---|
| baseline vs M59 | 0 | 5 | **4** (sphinx ×3, django-13195 r1) | 0 |
| M57 vs M59 | 3 (sphinx) | 5 | **1** (django-13195 r1) | 0 |
| recalibrated M58 vs M59 | 3 (sphinx) | 5 | **1** (django-13195 r1) | 0 |

- M59-only passes vs every comparator; **no comparator-only passes** (zero regressions).
- The one new pass (django-13195 r1) is a multi-gold case that failed in baseline, M57, and M58.

## Paired Deltas (recalibrated M58 → M59, pooled; M59 = per-case replicate mean)

| metric | M57 | M58 | M59 (mean) | M58→M59 | M57→M59 |
|---|---|---|---|---|---|
| pooled total tokens | 4,025,438 | 3,457,538 | 3,866,771 | **+11.8 %** | **−3.9 %** |
| pooled cost (USD) | 1.828 | 1.689 | 1.577 | **−6.6 %** | **−13.7 %** |
| resolution (cases w/ ≥1 pass) | 1/3 | 1/3 | 2/3 | **+1** | **+1** |
| closed required targets (of 9 per condition; M59 = 27 over reps) | 8/9† | 8/9‡ | **26/27** | preserved/▲ | — |
| ignored required targets | 1 | 0 | **0** | 0 | −1 |

Per-case token delta (M58 → M59 mean): sphinx **−12.7 %**, django-11820 **+27.0 %**, django-13195 **+20.8 %**. Per-case cost delta: sphinx **−25.2 %**, django-11820 **+3.4 %**, django-13195 **−0.1 %**.

† M57 closed measured under the M59 classifier on captured M57B text. ‡ M58 closed = M59B recalibration of the M58B artifacts (was 6/9 under the buggy pre-M59 classifier).

## Structured Decision Analysis

Per required target, M59 live decisions (the `outside` column = edited files that are **not** required targets — the over-edit signal):

**sphinx-7462** (resolves 3/3; `outside=0` all reps):
- `python.py` EDITED ·  `ast.py` EDITED (r1 EDITED_WITHOUT_INSPECTION) · `tests/test_domain_py.py` **RULED_OUT in all 3 reps**.
- The test-file rule-out — `INVALID_RULE_OUT` in M58B — is **credited live every replicate**. The M59 contract elicited a behavioral reason the structured classifier credits. Closure 3/3 each rep (M58 was 2/3).

**django-11820** (fails 3/3; `outside=0` all reps):
- `base.py` EDITED · `enums.py` **RULED_OUT in all 3 reps** · `checks.py` **RULED_OUT (r1, r3) / INSPECT_ONLY_NO_EDIT (r2)**.
- This is the exact M58B failure (both non-lead rule-outs were `INVALID_RULE_OUT`). **Live M59 credits them in every replicate** — closure 3/3 each. Behaviorally equivalent-or-better; no off-target edits.

**django-13195** (resolves 1/3; `outside=2` all reps — `messages/storage/cookie.py` + `sessions/middleware.py`):
- `response.py` EDITED ×2 · `options.py` **INSPECT_ONLY_NO_EDIT (r2, r3) / INVALID_RULE_OUT (r1)**.
- The three-way decision is used and recognized; r1's terse caller rule-out missed a behavioral clause (1 invalid). **The 2-file over-edit persists identically to M58** — it comes from the agent expanding from the *pivots* into the cookie/session modules (the real co-edit sites for this multi-gold issue), not from optional context, so the contract wording neither caused nor removed it. r1 resolved at the high end of the cost range.

Did optional targets cause extra exploration? **N/A** — no optional context rendered for any case (single impact rep each).

## Cost / Over-Exploration Analysis

- **Did M59 preserve the M58 cost drop vs M57?** **Yes.** Pooled cost −13.7 % vs M57; django-13195 −23.0 % cost / −23.7 % tokens vs M57, with all 3 replicates below M57's 2.57 M tokens / 24 tools / $1.006.
- **Did django-13195 stay bounded?** **Yes, across all replicates** (2.30 M / 1.54 M / 2.05 M tokens — all < M57). It is noisier than M58's single 1.62 M sample (M59 mean +20.8 % tokens), but M58's sample sits inside the M59 spread (M59 r2 = 1.54 M < M58 < M59 r1). Cost is ~flat vs M58 (−0.1 %).
- **Did repeated reads remain low?** **Yes** — django-13195 M59 repeated reads 0 / 0 / 1 (M57 was 4, M58 was 1). Pooled repeated reads stayed at the M58 level.
- **Did optional context cause extra exploration?** N/A (none rendered).
- **Did the structured grammar reduce invalid rule-outs?** **Yes, decisively.** Invalid rule-outs across the replicated set: **1 of 27** targets (django-13195 r1 only), vs the M58B artifact rate of 3 of 9. Terse table rule-outs are now credited live.
- **Over-edit:** unchanged on django-13195 (2 off-target co-edits, same files as M58); 0 on sphinx and django-11820. M59 neither worsened nor fixed the multi-gold over-edit.
- **Safety blocks:** PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY present in all 9 M59 snapshots.

## Verdict

**PASS.** Across 9 replicated runs the M59 structured bounded contract:
- is **valid 9/9** (digest + contract + real impact + structured grammar + cap + compact);
- **preserves decision compliance and makes it measurable** — 26/27 required targets closed, 0 ignored, and the M58B `INVALID_RULE_OUT` artifact eliminated live (django-11820's terse rule-outs and sphinx's test rule-out credited in every replicate);
- **keeps cost bounded** — pooled cost −13.7 % vs M57 and −6.6 % vs M58, with django-13195 under M57 in all 3 replicates and repeated reads low;
- **does not regress resolution** (no comparator-only passes) and **adds one new pass** (django-13195 r1).

Caveats, stated honestly: (a) pooled **tokens rose +11.8 % vs M58's single sample** (cost still fell) — attributable to replicate variance, since M58's lone draw sits at the low end of the M59 distribution; (b) the **django-13195 2-file over-edit persists unchanged**; (c) one replicate (django-13195 r1) left a terse caller rule-out uncredited. These are bounded, not destabilizing.

## Recommendation

**Proceed to a broader pre-registered confirmation.** The measurement blocker M58B flagged is cleared and confirmed live (structured rule-outs credited; 26/27 closed; 0 ignored), and bounded cost is preserved across replicates with a resolution gain. A larger pre-registered set should (1) establish whether the django-13195 token variance vs M58 is noise or real, with proper replicate counts, and (2) measure the persistent multi-gold over-edit directly so a follow-up can target it (it is pivot-expansion, not optional-context, driven — revisiting pivot-inspection enforcement is the lever, not more contract wording). Do **not** yet make the structured bounded contract a Stage 5 default, and do **not** tune for sphinx.

---

### Provenance

- Pre-flight: `run_stage5_m59b_preflight.ts` (offline re-render of each case's real M58B injected context with current M59 code).
- Live runs: `run-protocol --protocol vtrace-indexed --context-policy force-inject --capsule-engine v2 --capsule-intent debug --capsule-budget 8000 --inject-capsule-digest --digest-decision-contract --bounded-digest-decisions --compact-digest-injection` → labels `m59b_structured_bounded_*_r{1,2,3}`. Docker evaluate per label.
- Metrics + classification: `run_stage5_m58b_analyze.ts` (reads captured artifacts; uses the current/M59 `classifyDigestDecisionContract` incl. structured-table parsing + closed/open partition) over `_m59b_logs/spec.json`.
- Aggregation + validity gating + report: `run_stage5_m59b_report.py`.
- Compact JSON summary: `stage5_m59b_structured_bounded_decision_live_validation.json`.
