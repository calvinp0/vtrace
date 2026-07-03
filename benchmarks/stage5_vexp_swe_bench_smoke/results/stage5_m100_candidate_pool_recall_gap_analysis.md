# Stage 5 M100 Candidate-Pool Recall Gap Analysis (pre-change audit)

_Deterministic, offline: computed from the frozen M99 scoreboard detail
(`stage5_m99_deterministic_scoreboard.detail.json`), the M95 dev/holdout split,
capsule rebuilds at HEAD, an extended-depth organic retrieval probe
(`hybridRetrieve`, maxResults 400), and an exact file-level evidence scan of
each instance's base-commit workspace
(`run_stage5_m100_candidate_pool_recall_gap_audit.ts`, artifact
`stage5_m100_candidate_pool_recall_gap_audit.json`). Gold labels the analysis
only; capsule rebuilds and every simulation see just the derived task. No live
agents, no Docker, no API spend. Split discipline: per-case file detail below is
dev-only; holdout contributes aggregate counters._

## Headline

The M99 recommendation said pool recall is the binding constraint. This audit
sharpens that in two ways the M100 brief did not anticipate:

1. **The pool cap counts SYMBOLS, not files.** `CANDIDATE_POOL_SIZE = 25`
   admits ~9 distinct files per case (top files contribute many symbols each).
   **20 of the 31 absent-from-pool gold files ARE reached by the existing
   organic generators** at a deeper `maxResults` — 10 dev + 10 holdout, at
   symbol ranks 13–365 (django-11740's `db/migrations/autodetector.py` is the
   **9th distinct file** of the organic ordering and still absent from the
   pool). The dominant seam is therefore **C — retrieval reaches the file,
   file aggregation/pool-cap drops it** — not missing file-level indexing.
2. **The preferred design (a pure file-level evidence lane) is measured noise.**
   Exact derived-task literals resolved against raw repo file text recover at
   most 1 dev + 1 holdout gold at 3–8% precision (gate sweep below). The
   derived task (title + first substantive sentence, ≤360 chars) simply does
   not carry a distinctive literal that lands in the absent gold file at low
   ambiguity for the other cases; the FULL problem statement often does (see
   Q8), but the product never sees it.

The only slice that is precise AND recovers absent gold in both cohorts is the
**combination**: an organically-reached deep-pool source file whose raw source
text carries an exact derived-task evidence term at repo-wide ambiguity ≤ 3
(`rank<=100 source ev<=3`: dev 1/2 gold, holdout 1/4 gold, ≤2 candidates per
fired case, ~5 fired cases in 99). File-level evidence works as the
**selector**; the organic deep pool works as the **candidate source** — neither
alone survives the precision gates.

## Q1 — How many remaining hidden gold files are absent from the candidate pool?

41 hidden gold files across 28 scored cases (dev 19, holdout 22). Pool fate on
rebuild at HEAD (M99 code):

| fate | dev | holdout |
| --- | --- | --- |
| absent_from_pool | 16 | 15 |
| not_in_index | 2 | 0 |
| in_pool_not_capsule (budget-discarded) | 1 | 7 |

The 33 absent/not-indexed files are this milestone's population; the 8
in-pool-not-capsule files are support-budget territory (M97/M98 lanes), not
pool recall.

## Q2 — Source vs tests/docs/generated?

**All 41 hidden gold files are production source files** (classifier over
path shape + vendored/generated markers). No tests, docs, or generated files
are hidden — nothing here licenses the docs/test sub-lanes the M100 brief
sketched, so the caps for those lanes are moot (kept at 0 by simply excluding
non-source candidates).

## Q3/Q4 — Which absent files carry exact issue-text evidence?

Evidence terms (backticked spans, quoted strings, error fragments, exception
names, code tokens, snake/camel/dunder identifiers, dotted paths; ≥4 chars,
stoplisted) matched verbatim against each absent file's raw source text:

| evidence availability (absent files) | dev (18) | holdout (15) |
| --- | --- | --- |
| exact hit from the DERIVED task (product-visible) | 7 | 5 |
| exact hit only in the FULL problem statement | 7 | 6 |
| no exact issue-text hit at all | 4 | 4 |

Of the derived-task hits, only a minority are low-ambiguity: the reachability
routing puts dev 4 / holdout 1 absent files on
`file_evidence_ambiguous_or_path` (evidence exists but ≥6 files match or the
hit is junk like a backticked `None`), and only django-13195's
`contrib/sessions/middleware.py` carries a derived-task term (`delete_cookie`)
at ambiguity ≤ 3 among dev files.

## Q5 — How many are reachable only by semantic/domain knowledge?

Absent-file reachability, best route first:

| route | dev | holdout |
| --- | --- | --- |
| organic generators reach it at deeper rank | 10 | 10 |
| exact file evidence, low ambiguity (≤5) | 0 | 0 (beyond the organic 10) |
| exact evidence but ambiguous / path-only | 4 | 1 |
| evidence only in the full statement | 2 | 2 |
| no lexical evidence (semantic-only) | 2 | 2 |

The pure semantic residue is small (4 files) but there is a larger effective
residue: the 11 rank>100 files (5 dev, 6 holdout) are organically reachable
only in name — rescuing rank-326 candidates is indistinguishable from fuzzy
expansion. The honest addressable set is rank≤100 files with corroborating
evidence.

## Q6 — Which repos dominate absent-pool misses?

django 13, sympy 8, pylint 7, matplotlib 2, sphinx 2, pytest 1. pylint is one
case (pylint-4551: four `pylint/pyreverse/*` files, no lexical route — the
issue discusses UML type-hint rendering in prose; seam E). sympy's absent files
are deep-ranked hub-ish modules in a 1900-file repo.

## Q7 — Are misses caused by symbol-level indexing missing file-level text?

**No.** Of 97 exact evidence hits in hidden files, only 6 lie outside every
indexed symbol's byte range (module-level constants/comments). The matched text
is almost always INSIDE symbol bodies the index already covers; the files lose
on ranking/pool aggregation, not on text coverage. (This also means a
file-content FTS index would not change the reachable set — it would change
only the ranking of already-reachable files.)

## Q8 — Are misses caused by user-facing prose not present in symbol names?

Partially, but the binding form is **task truncation**, not prose mismatch:
7 dev + 6 holdout absent files have exact evidence ONLY in the full problem
statement — e.g. django-13195's `SESSION_COOKIE_*` settings keys (ambiguity
2–5, would nominate `middleware.py` directly) and matplotlib-24970's
`plt.get_cmap` (amb 3) / `self._i_over` (amb 1) pointing at `colors.py` — all
cut away by the 360-char derived task. Extending task derivation to preserve
distinctive literals is the single highest-yield future lever this audit
found, but it changes the input to EVERY lane and re-baselines everything, so
it is out of M100 scope (flagged as a standing finding).

## Q9/Q10 — Generated files / parser tables? Docs/examples/tests excluded?

No. Every hidden gold file is plain production source (Q2); no generated
artifact or docs/test exclusion contributes to this population.

## Q11 — Which exact evidence shapes are precise enough for a file-level lane?

Gate sweep over the PURE file-evidence lane (derived-task terms → files whose
raw text matches exactly, excluding files already in the pool; dedup by file
per case):

| gate | dev gold/cand | holdout gold/cand |
| --- | --- | --- |
| any shape, ambiguity ≤5 | 1/31 | 1/14 |
| any shape, ambiguity ≤3 | 1/13 | 1/10 |
| any shape, ambiguity =1 | 0/3 | 0/0 |
| source-only, ambiguity ≤3 | 1/7 | 1/8 |
| strong shapes (quoted/backtick/error/code/dunder), any gate | **0 gold everywhere** | 0 gold |
| snake identifiers, source, ≤3 | 1/2 | 0/1 |
| camel identifiers, source, ≤3 | 0/1 | 1/4 |

No pure-evidence gate clears even 15% precision, and the "strong" literal
shapes the M100 brief favoured carry ZERO gold — quoted strings and error
fragments in the derived task never land in an absent gold file at low
ambiguity. Identifier shapes (snake/camel) carry the only gold, at 25–50%
precision ONLY after intersecting with the organic deep pool:

| organic-rescue gate (deep-pool files ∉ pool) | dev gold/cand (max/case) | holdout gold/cand (max/case) |
| --- | --- | --- |
| rank ≤25 (evicted organics), source | 1/104 (12) | 0/97 (14) |
| rank ≤50, source | 1/340 (20) | 1/281 (23) |
| rank ≤100, source, evidence amb ≤5 | 1/5 (1) | 1/6 (2) |
| **rank ≤100, source, evidence amb ≤3** | **1/2 (1)** | **1/4 (2)** |
| rank ≤400, source, evidence amb ≤3 | 1/3 (1) | 1/8 (3) |

A DISTINCT-FILE-rank framing was also swept (rank among distinct files of the
organic ordering, the "pool counts symbols" correction): ungated it is the same
broad-noise story (filerank≤10 source: dev 1/119, holdout 2/78), and
intersected with evidence it loses the holdout gold (filerank≤20 source ev≤5:
dev 1/5, holdout 0/3) — the symbol-rank≤100 + ev≤3 slice dominates every
file-rank variant and is the shipped gate.

## Q12 — Which evidence shapes are too noisy (rejected)?

- Backticked generic words (`` `None` ``) and dunders (`__init__`) — ambiguity
  61+ everywhere; the length/stoplist gates alone do not kill them, the
  ambiguity cap does.
- Bare exception names (`ValueError`, `TypeError`) — ambiguity 61+.
- Dotted stdlib idioms (`np.array`, `re.compile`) — high ambiguity; only
  repo-local dotted paths survive the ≤3 cap and those are already M96's lane.
- ANY shape without the organic-pool intersection (Q11: ≤8% precision).
- Rank-only rescue without evidence (Q11: ≤1% precision, up to 23 candidates
  per case — this is the M95-rejected broad-expansion failure mode reborn).

## Q13 — How does this avoid the M95 rejected module-path pollution?

Three structural differences: (a) candidates must ALREADY be organically
retrieved (deep pool) — the lane never synthesizes a path or resolves a guess;
(b) the evidence match is exact raw-text containment in a real indexed file
with a repo-wide ambiguity cap counted over file contents, not name similarity;
(c) admission is support-only, capped (≤2/case), and displacement-safe (only
duplicate-file/generic/docs slots can be reclaimed), so even a wrong candidate
cannot displace organic evidence or steal the lead pivot.

## Q14 — Smallest lane likely to recover absent files without overpacking?

**Seam decision: C (symbol retrieval reaches the file; the symbol-counted
pool cap and file aggregation drop it), with file-level evidence (seam B's
signal, computed at capsule-build time like the M99 import scan) used as the
admission selector.** Seams A (unused existing evidence) and D (pruned before
capsule) are disconfirmed for this population (Q7, Q1); seam E covers the
small residue (4 files, plus the not-in-index pair).

The audited intervention:

- **File-evidence deep-pool rescue (support-only)**: re-run the organic
  retrieval at depth (same query/weights/seeds, maxResults 400); a candidate
  file qualifies when (1) it is absent from the actual pool, (2) its first
  symbol sits at organic rank ≤100, (3) it is credible source (not test /
  docs-example / vendored / generated / generic-infra / `__init__`), (4) its
  raw source text contains an exact derived-task evidence term (identifier /
  literal shapes, ≥6 chars, stoplisted) whose repo-wide file ambiguity is ≤3,
  and (5) caps hold: ≤2 rescued files per capsule, only into capsules whose
  distinct base file count stays ≤5 after rescue (kills every overpack flip by
  construction: the overpacked label needs ≥6 files), rescue token share ≤15%
  of the capsule budget. Placement is the M98 displacement contract
  (`orderSupportWithCoedit`): a rescue may reclaim a duplicate-file /
  generic-infra / docs support slot but never evicts a distinct new-file
  winner, and never touches pivots — lead-pivot theft is impossible.
- Everything else measured here becomes **diagnostics only** (counters for
  considered/kept/ambiguous/generic/size-rejected, per-candidate term + rank +
  ambiguity in the scoreboard detail).

Predicted effect (from the frozen sweep): recovers `contrib/sessions/middleware.py`
for django-13195 (dev all-gold flip, hidden-coedit gain) and 1 holdout gold
file; admits ≤4 non-gold support files across ~5 fired cases (~+0.05 mean
capsule files); zero overpack flips (file-count guard); zero pivot changes.

## Remaining failure modes this lane cannot touch

- 11 absent files at organic rank >100 (or unreachable) without low-ambiguity
  derived-task evidence — most of the full-statement-only evidence set (Q8)
  waits on a task-derivation milestone, not a retrieval lane.
- pylint-4551 (4 files) / anchorless cases — no lexical route at all (seam E).
- django-13590 / 15572 gold files missing from the workspace index entirely
  (index-coverage issue, not retrieval).
- The 8 in-pool-not-capsule files — support-budget territory, already governed
  by the M97/M98 co-edit machinery.
