# Stage 5 M63 Digest Header Compaction

## Summary

- **Compaction strategy:** deterministic head/tail excerpting of the Capsule v2 digest `# <query>` header. When the task/query exceeds the cap, the header renders a compact first-line label + `query_excerpt: <first 500 chars> … <last 200 chars>` + `query_truncated: true` + `query_original_chars: <N>`. No model summarization; pure and deterministic (`compactDigestHeader` in `src/capsuleV2/productAdapter.ts`).
- **Header cap:** 800 chars (head 500 / tail 200).
- **Default behavior changed?** Only for queries **> 800 chars**. Queries ≤ 800 render byte-identically to the prior `# <query>` line (boundary inclusive). No flag — the cap is a property of the renderer; the digest is an action map, never a place for a multi-KB issue body.
- **M62 fail-closed cases recovered?** **Yes — all 3.** `pylint-dev__pylint-8898`, `sympy__sympy-12419`, `matplotlib__matplotlib-22719` move FAIL_CLOSED_OMITTED → VALID; header was the sole blocker in every case.
- **24-task replay result:** **24 VALID / 0 FAIL_CLOSED_OMITTED / 0 INVALID_PARTIAL_SENTINEL** (total header chars saved 56,026; max 7,278 on pylint-8898). No near-budget cases remain.
- **Broader / 100-task planning unblocked?** Yes — coverage is no longer gated by header size; every M62 task now renders a valid structured-bounded contract under the 12,000-char atomic budget.

## Problem

M62 (PASS) ran 21/24 structured-bounded treatment cases and **skipped 3 as fail-closed over-budget**: digest + contract exceeded the 12,000-char atomic budget, so the contract failed closed (essential block omitted). M61B isolated the driver: for pylint-8898 the digest+contract was 12,803 chars of which the **verbatim issue-description header was ~8,036 chars** — not impact enrichment, not the decision contract. The digest header echoed the full task/problem statement (`# <query>`, query up to the 8,000-char harness cap).

**Why the header was the size driver:** the digest is an *action map*. Its header field duplicated the entire issue/problem statement, which the agent **already receives** through the harness's own prompt. Under the atomic context budget that duplicate text directly displaces the bounded decision contract — exactly the M62 fail-closed mechanism.

**Why a budget increase was not chosen:** raising the global 12,000-char budget would (a) treat the symptom, not the redundancy; (b) inflate every injected context (cost) for all cases; (c) weaken the very budget discipline the structured-bounded treatment relies on. Compacting the redundant header removes the bloat at its source while leaving the budget, the sentinels, the decision contract, and impact enrichment untouched.

## Implementation

- **Files changed:**
  - `src/capsuleV2/productAdapter.ts` — new exported `compactDigestHeader(rawQuery)` + `MAX_DIGEST_QUERY_CHARS`; `renderCapsuleV2Digest` now emits `compactDigestHeader(input.query).lines`.
  - `src/capsuleV2/productAdapter.test.ts` — unit tests for the helper + rendered digest.
  - `benchmarks/stage5_vexp_swe_bench_smoke/digest_decision_contract_injection.test.ts` — integration tests over the real `classifyCapsuleOutput` + atomic-truncation path.
  - `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m63_compaction_replay.ts` — no-live 24-task replay with header size accounting.
- **Exact rendering behavior (query > cap):**
```
# <first non-empty line, ≤100 chars>
query_excerpt: <head 500> … <tail 200>
query_truncated: true
query_original_chars: <N>
```
- **Deterministic excerpt rule:** `head = collapseWs(query[:500])`, `tail = collapseWs(query[-200:])`, joined with ` … `. Whitespace-collapsed, no clock, no randomness, no model — identical output across calls.
- **Original char count field:** `query_original_chars` carries the trimmed query length verbatim, so the agent (and the accounting) always see how much was elided.
- **Interaction with atomic truncation:** compaction only shrinks the digest *text*; the `<VTRACE_CAPSULE_V2_DIGEST_*>` / `<VTRACE_DIGEST_DECISION_CONTRACT_*>` sentinels and the `truncateContextByPriority(..., {atomicBlocks})` step are unchanged. A smaller digest means the two atomic blocks now fit the 12,000-char budget instead of failing closed. If they still cannot fit, the existing fail-closed path (omission marker, never a partial sentinel) is preserved.

## Replay Results

Offline replay over the frozen M62 24-task preregistration fixture, same post-truncation validity path as M62 pre-flight, post-compaction. No agents, no Docker.

| instance_id | repo | cat | before | after | digest | contract | dig+con | hdr_orig | hdr_comp | hdr_saved | partial | omission |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| django__django-11820 | django/django | A | VALID | VALID | 2457 | 2525 | 4982 | 696 | 696 | 0 | no | no |
| matplotlib__matplotlib-22719 | matplotlib/matplotlib | A | FAIL_CLOSED_OMITTED | VALID | 2573 | 2249 | 4822 | 8001 | 774 | 7227 | no | no |
| matplotlib__matplotlib-24627 | matplotlib/matplotlib | A | VALID | VALID | 2272 | 2567 | 4839 | 552 | 552 | 0 | no | no |
| mwaskom__seaborn-3187 | mwaskom/seaborn | A | VALID | VALID | 2530 | 2275 | 4805 | 1902 | 773 | 1129 | no | no |
| sphinx-doc__sphinx-7462 | sphinx-doc/sphinx | A | VALID | VALID | 2586 | 2553 | 5139 | 2055 | 759 | 1296 | no | no |
| sympy__sympy-13372 | sympy/sympy | A | VALID | VALID | 2425 | 2203 | 4628 | 1848 | 771 | 1077 | no | no |
| astropy__astropy-14539 | astropy/astropy | B | VALID | VALID | 2856 | 2931 | 5787 | 2362 | 760 | 1602 | no | no |
| pydata__xarray-3677 | pydata/xarray | B | VALID | VALID | 2690 | 2913 | 5603 | 1586 | 770 | 816 | no | no |
| pylint-dev__pylint-8898 | pylint-dev/pylint | B | FAIL_CLOSED_OMITTED | VALID | 2659 | 2866 | 5525 | 8002 | 724 | 7278 | no | no |
| sympy__sympy-12419 | sympy/sympy | B | FAIL_CLOSED_OMITTED | VALID | 2633 | 2804 | 5437 | 8001 | 779 | 7222 | no | no |
| astropy__astropy-14365 | astropy/astropy | C | VALID | VALID | 2467 | 2517 | 4984 | 3024 | 788 | 2236 | no | no |
| matplotlib__matplotlib-25960 | matplotlib/matplotlib | C | VALID | VALID | 2586 | 1958 | 4544 | 7152 | 785 | 6367 | no | no |
| psf__requests-1142 | psf/requests | C | VALID | VALID | 2550 | 2544 | 5094 | 5963 | 789 | 5174 | no | no |
| pytest-dev__pytest-7432 | pytest-dev/pytest | C | VALID | VALID | 2524 | 2517 | 5041 | 1113 | 779 | 334 | no | no |
| sympy__sympy-12481 | sympy/sympy | C | VALID | VALID | 2402 | 2539 | 4941 | 482 | 482 | 0 | no | no |
| astropy__astropy-14598 | astropy/astropy | D | VALID | VALID | 2632 | 2273 | 4905 | 3750 | 780 | 2970 | no | no |
| django__django-13195 | django/django | D | VALID | VALID | 2663 | 2547 | 5210 | 3011 | 796 | 2215 | no | no |
| pallets__flask-5014 | pallets/flask | D | VALID | VALID | 2169 | 2829 | 4998 | 317 | 317 | 0 | no | no |
| astropy__astropy-14369 | astropy/astropy | E | VALID | VALID | 2479 | 2597 | 5076 | 5045 | 794 | 4251 | no | no |
| django__django-10880 | django/django | E | VALID | VALID | 2399 | 2855 | 5254 | 564 | 564 | 0 | no | no |
| django__django-11095 | django/django | E | VALID | VALID | 2799 | 2312 | 5111 | 1305 | 796 | 509 | no | no |
| django__django-11740 | django/django | E | VALID | VALID | 2805 | 2319 | 5124 | 4305 | 790 | 3515 | no | no |
| psf__requests-5414 | psf/requests | E | VALID | VALID | 2488 | 2262 | 4750 | 1581 | 773 | 808 | no | no |
| sympy__sympy-16766 | sympy/sympy | E | VALID | VALID | 2542 | 2831 | 5373 | 687 | 687 | 0 | no | no |

**Aggregate:** valid 24, fail-closed 0, partial-sentinel 0; recovered fail-closed→valid: matplotlib__matplotlib-22719, sympy__sympy-12419, pylint-dev__pylint-8898; total header chars saved 56,026; max header chars saved 7,278 (pylint-8898); near-budget cases: none.

## Over-budget / Near-budget Analysis

- **Remaining fail-closed cases:** none. All 24 cases render digest+contract within [4,544 – 5,787] chars — far below the 12,000-char budget.
- **Near-budget cases (≥ 10,800):** none. M62's near-budget cases (matplotlib-25960 at 10,911; requests-1142 at 10,268) drop to 4,544 and 5,094 respectively after header compaction.
- **Size drivers, post-compaction:** with the header bounded, the digest body (pivots + bounded impact enrichment) and the bounded decision contract dominate, each intentionally capped. No case approaches the budget, so there is no residual single driver.

## Tests

- **Added (`productAdapter.test.ts`, 8):** long header compacted deterministically; original char count recorded; bounded head/tail excerpt; short header byte-identical (+ boundary at the cap); blank query → no header line; deterministic across repeated calls; rendered digest uses the compacted header (verbatim issue body never injected).
- **Added (`digest_decision_contract_injection.test.ts`, 4):** multi-KB query compacted in the injected digest (verbatim body absent); **over-budget case becomes VALID under the real 12k atomic budget** (four sentinels + structured parser, no omission, no partial); deterministic injected context; below the atomic floor still fails closed with no partial sentinel pair. Validity is established by sentinels + the structured parser, never by generic glyphs.
- **Verification:** `bun run typecheck` ✓ · `bun run typecheck:benchmarks` ✓ · `bun test` → 3123 pass / 0 fail ✓ · `git diff --check` clean ✓.

## Recommendation

**Proceed to an M62C live 24-task repeat with the recovered valid-N (24).**

Compaction recovered all 3 fail-closed cases (24/24 VALID offline, 0 partial sentinel) and **changed the injected digest header for 13/24 cases** (every task whose query exceeded 800 chars — header savings up to 7,278 chars). Because the injected context changed for those cases, the M62 live results do not transfer verbatim; a single 24-task live repeat (M62C) is the clean gate that confirms (a) the 3 recovered cases run validly live and (b) the smaller header did not regress the 21 already-passing cases — before committing tokens to broader / 100-task scale. No budget increase was needed; the coverage gap is closed at its source.

## Non-Claims

- Does not change retrieval, scoring, ranking, or candidate generation.
- Does not weaken sentinel validity or remove the decision contract / impact enrichment.
- Does not tune for any single issue; the cap is generic and deterministic.
- Offline replay only — no live agents, no Docker, no API spend.

