# Stage 5 Milestone Ledger

Cumulative, append-only record of the deterministic-improvement milestone chain
so any new session can see what has been done, what it changed, and what comes
next without re-deriving it from git history. **Append one row (and any
standing findings) per milestone, in the same commit as the milestone.** Full
evidence lives in each milestone's `stage5_m<NN>_*.md/json` reports beside this
file; live-run outcome history is separate (`stage5_outcome_ledger.md`).

## Milestones

| # | commit | verdict | change | key deltas (all-scored unless noted) | recommendation issued |
| --- | --- | --- | --- | --- | --- |
| M94 | 8d52a78 | baseline | Deterministic VTRACE scoreboard (gold-blind capsule scoring over 100 base-commit workspaces; dev/holdout split basis) | established r@5 / any-gold / all-gold / outcome-label metric set | fix strong-lexical demotion |
| M95 | 978458b | MIXED | genericInfra strong-lexical fix (func/method only) | holdout r@1 +2.5pts (short of +5 gate); token-neutral | direct-evidence anchoring |
| M96 | ca3d87a | MIXED, keep | direct-evidence anchoring (issue-text mention lanes) | dev r@5 +8.9pts, holdout flat | hidden co-edit expansion |
| M97 | 81902d2 | MIXED, keep | bounded hidden co-edit expansion (rescue + injection lanes) | multi-file all-gold 6.7%→40.0%, hidden-coedit recall 0.256→0.589; cost: 94% non-gold candidates, mean files 3.63→4.32, overpacked 11→18 | support precision |
| M98 | 8157a72 | PASS | co-edit confidence tiers (high/medium/low; subtractive pruning) | recall byte-preserved; mean files 4.32→3.92, overpacked 18→14, excellent 18→26; 46 pruned, 0 gold lost | import-edge extraction |
| M99 | 29c65ca | MIXED (lean positive) | exact file-level import scan (`pythonFileImports.ts`) + `import_reexport_rescue` co-edit lane (facade re-export + affinity + fan/size gates, max 1, HIGH tier, M98-unused capacity only) | all-gold 70.7%→71.7%, multi-file all-gold 40.0%→46.7% (django-16256 recovered); 51 considered → 1 kept (the gold one); holdout + all outcome labels + tokens byte-identical | candidate recall improvement |
| M100 | (this commit) | MIXED (lean positive) | file-evidence deep-pool rescue (`fileEvidenceRescue.ts`): support-only recovery of an organically-reached deep-rank (≤100 of 400) source file whose raw text carries an exact derived-task term at repo ambiguity ≤3; ≤2/case, ≤5 resulting files, 15% token ceiling, M98 displacement contract | all-gold 71.7%→72.7%, multi-file all-gold 46.7%→53.3%, hidden-coedit 0.589→0.622 (django-13195 recovered `contrib/sessions/middleware.py`, partial→excellent); 666 considered → 2 added (1 gold); holdout metrics byte-flat; mean files +0.020; overpacked 14→14 | task-derivation milestone OR ranking/pivot improvement |

## Standing findings (still true unless a later row says otherwise)

- **The candidate pool cap counts SYMBOLS, not files** (M100 audit): 25
  symbols ≈ 9 distinct files; 20/31 absent gold files ARE reached by the
  organic generators at deeper rank (13–365) — the failure is file
  aggregation/ranking, not text coverage (only 6/97 exact evidence hits sit
  outside indexed symbol bodies, so a file-content FTS index would not change
  the reachable set).
- **Pool recall is mined out at current precision standards** (M100): the
  audited addressable slice (organic rank ≤100 ∧ exact derived-task term at
  repo ambiguity ≤3) is shipped; a PURE file-evidence lane measured 3–8% gold
  and a rank-only rescue ≤1% — do not widen either without new evidence.
- **Task-derivation truncation is the next recall ceiling** (M100 audit): 13
  absent gold files carry exact evidence ONLY in the full problem statement
  (e.g. django-13195's `SESSION_COOKIE_*`, matplotlib-24970's `plt.get_cmap`),
  cut by the 360-char derived task. Extending derivation re-baselines every
  lane and needs its own milestone.
- ~~Candidate recall is the binding constraint~~ (M99 audit, superseded by the
  three findings above): 31/42 remaining hidden gold files never enter the
  retrieval pool at all; no relation-evidence lane can recover them. 22/42
  have no import relation whatsoever.
- **Import edges are structurally absent from the index** (M99): symbol-level
  `imports` edges only exist for single-top-level-symbol files (~3% of files,
  mostly `__init__` facades), and package-rooted workspace checkouts (the
  django set) cannot resolve their own absolute imports. The M99 fix reads
  import relations at capsule-build time instead; the index/schema were left
  untouched deliberately (reindex + graph-scoring perturbation risk).
- **Injection-shaped import lanes are noise** (M99 audit): 0 gold in every
  gated slice; plain name-import rescues 65/67 non-gold. Do not widen the
  import lane without new evidence.
- **Retrieval no-change proof requires fresh baselines** (found in M99): the
  committed baselines had been stale since `aa62cc4` (pre-M95), silently
  invalidating the byte-diff proof. Baselines refreshed at `29c65ca` with a
  freshness record (`stage5_retrieval_eval_baselines.meta.json`); check it
  before trusting the diff, use the stash A/B proof when in doubt, refresh in
  the same commit as any intentional retrieval/capsule change.
- **django-13195 is not an import case** (M99): its hidden gold
  (`contrib/sessions/middleware.py`) has no static import relation to any
  capsule file (dynamic call through an argument; settings-string wiring).
- **3 genuine live-run regressions remain open** from the M7.x line:
  sympy-12419, astropy-14539, pylint-8898 (see memory/M7.3 notes; live-run
  work, separate from this deterministic chain).
