# Stage 5 M100 Candidate-Pool Recall via File-Level Evidence

_Deterministic, offline: no live agents, no Docker, no API spend. Pre-change
audit: `stage5_m100_candidate_pool_recall_gap_analysis.md` /
`stage5_m100_candidate_pool_recall_gap_audit.json`. Post-change scoreboard:
`stage5_m100_deterministic_scoreboard.{md,json,detail.json}`._

## Summary

- **Seam decision: C** — symbol retrieval already REACHES most absent gold
  files; the symbol-counted pool cap (25 symbols ≈ 9 distinct files) and file
  aggregation drop them. File-level evidence (the brief's seam-B signal,
  computed at capsule-build time like the M99 import scan) is used as the
  admission SELECTOR, not as a candidate source.
- **Change**: `src/capsuleV2/fileEvidenceRescue.ts` — a support-only
  file-evidence deep-pool rescue lane wired into `buildCapsuleV2`. A file is
  rescued only when (a) the organic generators retrieve it at deep rank ≤100
  (maxResults-400 re-rank of the same signals), AND (b) its raw source text
  contains an exact, non-generic derived-task evidence term whose repo-wide
  file ambiguity is ≤3, AND (c) it passes credible-source and cap guards
  (≤2 rescues/case, resulting distinct files ≤5, rescue tokens ≤15% budget).
- **Why**: the audit measured each signal alone as noise (pure file-evidence
  lane: 3–8% gold; rank-only rescue: ≤1% gold, up to 23 candidates/case); only
  their intersection is precise (dev 1/2, holdout 1/4 in simulation) and
  bounded enough for the M98-era precision regime.
- **M99 → M100 (all scored, n=99)**: recall@5 0.726→0.730, all-gold
  71.7%→72.7%, hidden-coedit 0.589→0.622, multi-file all-gold 46.7%→53.3%,
  excellent 26→27, overpacked 14→14, mean files +0.020, tokens unchanged.
  django-13195 recovered its absent gold (`contrib/sessions/middleware.py`)
  and flipped partial→excellent (dev). Holdout metrics byte-flat.
- **Verdict: MIXED, lean positive** (dev improves with a real absent-file
  recovery; holdout metrics flat with one neutral non-gold support addition).
- **Recommendation**: pause pool-recall tuning; the next deterministic lever is
  the task-derivation truncation (evidence for 13 more absent files exists only
  in the full problem statement), which re-baselines every lane and deserves
  its own milestone. Alternatively proceed to ranking/pivot improvement
  (lead_pivot_is_source_gold 51.5% is now the widest gap).

## Candidate-Pool Recall Gap Analysis

Full analysis in `stage5_m100_candidate_pool_recall_gap_analysis.md`. Key
facts:

- 41 hidden gold files remain (28 cases); 33 are absent from the pool or not
  indexed (dev 18, holdout 15); ALL are production source files (no
  tests/docs/generated — the brief's docs/test sub-lanes are moot).
- 20/31 absent files ARE organically reachable at symbol ranks 13–365; only
  6/97 exact evidence hits sit outside indexed symbol bodies — file-level TEXT
  coverage is not the gap; ranking/aggregation is.
- Derived-task evidence is the binding ceiling: 13 absent files carry exact
  evidence ONLY in the full problem statement (cut by the 360-char task
  derivation); 8 have no lexical evidence at all.
- Noisy shapes rejected: backticked generic words, dunders, bare exception
  names, stdlib dotted idioms, any shape without ambiguity caps, rank-only
  rescue without evidence (the M95 broad-expansion failure mode).
- Chosen intervention: the audited `rank≤100 ∧ source ∧ exact-term ambiguity≤3`
  slice, support-only, displacement-safe.

## Implementation

- **Files changed**: `src/capsuleV2/fileEvidenceRescue.ts` (new lane, pure),
  `src/capsuleV2/fileEvidenceRescue.test.ts` (14 tests),
  `src/capsuleV2/buildCapsuleV2.ts` (wiring + token ceiling + diagnostics),
  `src/capsuleV2/types.ts` (diagnostics fields),
  `benchmarks/.../run_stage5_m100_candidate_pool_recall_gap_audit.ts` (audit),
  `benchmarks/.../run_stage5_m100_deterministic_scoreboard.ts` (scoreboard).
- **Evidence types**: backticked spans, quoted strings, error fragments,
  exception names, distinctive code tokens, snake/camel/dunder identifiers,
  dotted paths — ≥4 chars, ≤160, URL-stripped, stoplisted (query-shaping +
  generic-infra + capsule-generic vocabulary).
- **Ambiguity/generic/size guards**: exact raw-text containment counted over
  the indexed `.py` file list, cap 3 files (early-stopped); generic terms
  rejected at extraction; files >512 KiB never scanned.
- **Caps**: ≤2 rescued files per capsule; lane barred when the capsule already
  holds ≥5 distinct base files, and rescues shrink to keep the result ≤5 (the
  deterministic overpacked label needs ≥6 files, so an overpack flip is
  impossible by construction); rescue token share ≤15% of the capsule budget;
  docs/tests/vendored/generated/`__init__`/generic-infra files excluded
  entirely (0 docs / 0 test candidates by design — all absent gold is source).
- **Ranking/selection**: entries are SUPPORT-only with synthesized sub-anchor
  scores (final 0.35, no direct-evidence fields), kept OUT of role refinement
  (graph-neighbour pattern), placed via the M98 displacement contract
  (`orderSupportWithCoedit`): a rescue may reclaim a duplicate-file /
  generic-infra / docs slot, never evicts a distinct new-file winner, and never
  touches pivots — lead-pivot theft is impossible.
- **Why it is general**: no instance ids, repos, paths, or gold data anywhere;
  the lane re-ranks the product's own retrieval signals and matches
  author-written task literals against the indexed base-commit tree.
- **Why it is not gold leakage**: inputs are the derived task, the index, and
  the workspace tree — the same inputs every other lane reads; gold labels
  exist only in the scoreboard, which the product never imports.
- **Tests**: extraction shapes (quoted/error/exception/identifier/dotted),
  generic + short-token rejection, URL stripping, happy-path rescue,
  determinism, pool-presence exclusion, ambiguity cap, test/`__init__`/docs
  exclusion, per-capsule cap + pruned accounting, distinct-file guard (skip and
  shrink), content size guard, no-evidence no-op.

## Deterministic Scoreboard Delta (M99 → M100)

| cohort | r@5 | all-gold | hidden-coedit | lead=src | mean files | excellent | overpacked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all (99) | 0.726→0.730 | 71.7%→72.7% | 0.589→0.622 | 51.5% (=) | 3.929→3.949 | 26→27 | 14 (=) |
| dev (60) | 0.807→0.813 | 80.0%→81.7% | 0.736→0.778 | 56.7% (=) | 3.950→3.967 | 17→18 | 11 (=) |
| holdout (39) | 0.603 (=) | 59.0% (=) | 0.000 (=) | 43.6% (=) | 3.897→3.923 | 9 (=) | 3 (=) |
| multi-file (15) | 0.528→0.550 | 46.7%→53.3% | 0.589→0.622 | 13.3% (=) | 4.267→4.333 | 1→2 | 1 (=) |
| absent-pool subset (21) | 0.067→0.083 | 0.0%→4.8% | 0.262→0.333 | 4.8% (=) | 3.524→3.571 | 0→1 | 1 (=) |
| source-file absent subset (21) | identical to absent-pool subset (all absent gold is source) | | | | | | |

- recall@1/@3, MRR, any-gold, median/p90 tokens, required targets: unchanged in
  every cohort. All-gold flips: django-13195 gained (dev). Outcome flips:
  django-13195 partial→excellent (dev) — no other outcome moved.
- By repo: only django/django moved (r@5 0.794→0.802, all-gold 75.0%→77.3%,
  mean files 3.68→3.73); every other repo byte-identical
  (`stage5_m100_deterministic_by_repo.csv`).

## File-Level Evidence Analysis

- Fired on 2/99 cases; 666 deep-pool files passed the cheap gates and were
  content-tested; 61 rejected at the ambiguity cap; 2 generic-rejected;
  3 size-rejected; 27 cases lane-skipped by the distinct-file guard; 0 pruned
  by the per-case cap; 0 budget-limited.
- Added 2 candidates, both rendered:
  - django-13195 (dev): `contrib/sessions/middleware.py` via `delete_cookie`
    (snake identifier, ambiguity 3, organic rank 94) — **gold**; flipped the
    case to all-gold/excellent.
  - django-13658 (holdout): `core/management/commands/runserver.py` via
    `ManagementUtility` (camel identifier, ambiguity 3, organic rank 24) —
    non-gold; the case's outcome (good) and all holdout metrics unchanged.
- Realized precision 1/2 (audit simulation predicted 2/6) — the audit's second
  holdout gold was not reachable once real placement guards (pool overlap,
  distinct-file cap) applied.
- False positives: 1 (the runserver.py support signature; ~30 tokens).

## Capsule/Token Impact

- Median tokens 1152 (=), p90 3536 (=) all-scored; holdout med/p90 unchanged.
- Mean capsule files +0.020 all-scored (limit +0.1); median unchanged.
- Overpacked 14→14 (guaranteed by the ≤5-resulting-files guard);
  required targets unchanged; mean optional targets +0.020.
- Rendered rescue cost: two support signatures (django-13195 capsule
  465→468 est tokens in the retrieval eval's identical fixture).

## Retrieval Eval Compatibility

Stash A/B proof (post-change run vs pre-change run with
`src/capsuleV2/buildCapsuleV2.ts` + `types.ts` stashed; the committed baselines
are stale relative to this working tree by design, so the A/B is the valid
proof):

- `retrieval_eval.cross_repo.30`: **byte-identical** pre vs post.
- `retrieval_eval.django.expanded`: one row changed — django-13195 gains the
  rescued middleware support item (est tokens 465→468, capsule items 26→27);
  every hit/pivot metric on the row identical (`hit_top1_pivot` preserved). No
  regression; strictly additive.

## Remaining Failure Modes

- 24 misses remain (top misses: `stage5_m100_deterministic_top_misses.csv`),
  dominated by lexical_mismatch. Pool recall is no longer cheaply improvable:
  the audited addressable slice is now shipped; what remains is (a) 13 absent
  files whose exact evidence lives only in the FULL problem statement — a task
  derivation milestone, not a retrieval lane; (b) 8 files with no lexical
  evidence (semantic-only, e.g. pylint-4551's pyreverse set); (c) 2 gold files
  missing from the workspace index (index-coverage issue); (d) deep-ranked
  files without low-ambiguity evidence (rescuing them is measured noise).
- Ranking/pivot quality is now the widest gap (lead=src 51.5%,
  wrong_pivot=11) and was untouched by design.

## Success Criteria Check

1. ≥1 previously absent source gold recovered — **PASS** (middleware.py,
   django-13195, into pool AND capsule).
2. Holdout recall@1 drop ≤2pts — **PASS** (0.436 → 0.436).
3. Holdout lead_pivot_is_source_gold drop ≤2pts — **PASS** (43.6% → 43.6%).
4. Holdout any_gold_in_capsule not dropped — **PASS** (61.5% → 61.5%).
5. Multi-file all_gold ≥46.7% — **PASS** (53.3%).
6. hidden_coedit_recall ≥0.589 — **PASS** (0.622).
7. Mean capsule files +≤0.1 all-scored — **PASS** (+0.020).
8. Overpacked not increased — **PASS** (14 → 14).
9. Retrieval evals no material regression — **PASS** (cross-repo
   byte-identical; expanded strictly additive on one row).
10. No broad fuzzy expansion — **PASS** (666 considered → 2 added; exact
    containment + ambiguity ≤3 + organic corroboration only).
11. No lead-pivot theft — **PASS** (support-only lane; lead=src unchanged in
    every cohort).
12. No gold leakage — **PASS** (lane inputs: task + index + tree only).
13. Tests/typechecks — **PASS** (3493 tests incl. 14 new; both tsc configs
    clean; `git diff --check` clean).
14. No live agents / Docker / API spend — **PASS**.

## Verdict

**MIXED, lean positive.** Every hard criterion passes and one absent gold file
is genuinely recovered with an outcome flip to excellent, but the improvement
is dev-side; holdout metrics are flat (its one fire was a neutral non-gold
addition), matching the chain's precedent for a MIXED-lean-positive grade
(M96/M99). The lane is precise, additive, and cheap to keep.

## Recommendation

**Pause and reassess deterministic tuning of pool recall; pick the next lever
between (a) a task-derivation milestone** (preserve distinctive literals from
the full problem statement — the audit shows 13 absent files' evidence is
truncated away; this re-baselines every lane and needs its own controlled
comparison) **and (b) ranking/pivot improvement** (lead_pivot_is_source_gold
51.5% / wrong_pivot 11 is now the widest deterministic gap). Import/co-edit
and file-evidence pool lanes are mined out at current precision standards.
