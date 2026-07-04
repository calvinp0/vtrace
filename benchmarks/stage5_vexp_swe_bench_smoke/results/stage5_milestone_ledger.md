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
| M100 | 49577bc | MIXED (lean positive) | file-evidence deep-pool rescue (`fileEvidenceRescue.ts`): support-only recovery of an organically-reached deep-rank (≤100 of 400) source file whose raw text carries an exact derived-task term at repo ambiguity ≤3; ≤2/case, ≤5 resulting files, 15% token ceiling, M98 displacement contract | all-gold 71.7%→72.7%, multi-file all-gold 46.7%→53.3%, hidden-coedit 0.589→0.622 (django-13195 recovered `contrib/sessions/middleware.py`, partial→excellent); 666 considered → 2 added (1 gold); holdout metrics byte-flat; mean files +0.020; overpacked 14→14 | task-derivation milestone OR ranking/pivot improvement |
| M101 | 48379f1 | PASS | anchored-target pivot guard (`m101_anchored_target_guard`): tier-2 anchor ids (title-symbol ∪ literal-anchor ∪ strong-direct; never weak/support-only lanes) threaded into `refineDebugRoles` — (a) dispatcher demotion never takes an anchored actionable pivot, (b) max ONE anchored anchor-actionable non-test pivot survives the `maxPivots` cap by converting a support slot, ordered LAST (required target, never lead) | wrong_pivot 11→8, lead=src-gold 51.5%→54.5%, gold-in-required 60.6%→64.6%, excellent 27→29, r@1 .503→.529; r@5/any/all/hidden/multi-file-all-gold/overpacked byte-flat; holdout gold metrics byte-identical (guard fired on 7 holdout capsules, gold-neutral); 3 leads flipped TO gold (11206, xarray-6599, xarray-6938), none lost; retrieval evals improved (expanded top-1 80→85%, pivot 95→100%; cross-repo pivot 73.3→76.7%) via stash A/B proof | task-derivation audit |
| M102 | a5ec283 | PASS | task-derivation evidence-loss audit — benchmark-only variants (`stage5_m102_task_variants.ts`), NO product change: V0 parity exact; V1_720/V2_1200/V4_full/V6_first-last/V7_token-dump all net-NEGATIVE (prose pollution; hidden-coedit 0.622→0.26–0.39, multi-file all-gold 53.3%→20–33%); V5_title_plus_errors (V0 + exceptions + failing tests + capped traceback frames, p90 392 chars) is the only net-positive: +4 net cases, holdout r@1 +5.1pts / r@5 +3.8 / any-gold +5.2 / lead +5.1, miss 24→21, wrong_pivot 8→7, capsules smaller (files 3.98→3.88, med tok 1178→1094), hidden/multi-file/overpacked byte-flat | evidence loss: 50/100 cases (17/32 miss-class) hold gold evidence beyond the 360-char prose-biased derivation, half of it in code blocks/tracebacks the derivation structurally skips | M103: implement V5-shaped structured task derivation as a full re-baselining milestone (leakage-guard policy for issue-authored paths incl. psf-5414; watch django-13513 lead drift) |
| M103 | 199769f | PASS | structured task derivation shipped as the DEFAULT Stage 5 derivation (`stage5_task_derivation.ts`: V0 base + exceptions ≤6 + failing tests ≤6 + traceback frames ≤8, 1200-char total cap — byte-identical to M102 V5, unit-tested + scoreboard parity 0 mismatches) + provenance-based leakage policy (`assessGoldLeakage`: issue-authored gold paths scored w/ diagnostic, gold-patch-derived paths still block); fixture builder + new M103 scoreboard switched; frozen M94–M102 runners keep V0 via re-export; both retrieval fixtures regenerated | comparable-99 = exact V5 reproduction (r@1 .529→.564, r@5 .730→.745, any 75.8→78.8%, lead 54.5→58.6%, wp 8→7, miss 24→21, op 14 flat, files 3.98→3.88, med tok 1178→1094; holdout r@5 +3.8 / lead +5.1 / any +5.2); NEW 100-case set: psf-5414 scored `good` (issue-authored path), 8 issue-authored diagnostics, 0 leak blocks; retrieval evals improved (expanded top-1 85→90%; cross-repo top-1 66.7→73.3%, pivot 76.7→80%, missing 13.3→10%; 1 traded row = matplotlib-22719 top1→top3, the known guard case); losses accepted: django-13513 excellent→good (lead → `views/generic/__init__.py`), matplotlib-22719/xarray-4695 shifts inside pre-existing overpacked capsules | small live confirmation (deterministic chain M95–M103 unvalidated live since M92); alternative: parser/language coverage |

## Standing findings (still true unless a later row says otherwise)

- **Longer raw task text is net-harmful; structured error evidence is not**
  (M102): every prefix/full-text variant lost more than it gained (prose
  pollutes lexical ranking AND re-deriving task terms breaks the co-edit /
  file-evidence lanes tuned on short tasks). Only V5 (V0 + exceptions +
  failing tests + capped traceback frames) was net-positive, improving holdout
  while SHRINKING capsules. Do not lengthen the prose window in M103; augment
  with extracted error/test/traceback evidence only.
- ~~The M94 leakage guard conflates issue-authored paths with contamination~~
  (M102, RESOLVED in M103): `assessGoldLeakage` now scores issue-authored gold
  paths with an `issue_authored_gold_path` diagnostic (8 cases incl. psf-5414,
  now scored `good`) while a gold path the issue never contained still blocks
  (`gold_patch_leak`, 0 fired). The 100-case set is the new-policy scoreboard
  basis; the 99-id M101-scored set remains the cross-milestone comparable set.
- **The three M103 derivation losses are pinned regression guards**
  (M103): django-13513 (holdout lead → `views/generic/__init__.py` facade —
  the first facade-lead case; revisit facade lead-demotion only if more
  appear), matplotlib-22719 and xarray-4695 (rank shifts inside capsules that
  were ALREADY overpacked at M101 — the lever is overpacking, not
  derivation). Diff `regression_guard_cases` in the M103 scoreboard JSON in
  any milestone touching retrieval/ranking.
- **The role layer and pivot ordering now share the tier-2 anchor precedence**
  (M101): before, a title-symbol/literal-anchor/strong-direct target could be
  cap-evicted or dispatcher-demoted by structural inference despite being the
  ordering's top tier — the cause of 5 of the 11 M100 wrong_pivots. The
  remaining 8 wrong_pivots are weak-direct-lane golds (deliberate M96
  conservatism — do not promote without a separately-gated design) or
  plain-lexical twins not separable gold-blind.
- **Wrong-lead failures are never tests/docs/facades** (M101 audit): all 24
  source-gold-in-capsule/non-gold-lead cases lead with a *wrong source file*;
  test/docs/facade lead-demotion rules have zero addressable coverage on this
  benchmark.

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
- ~~Task-derivation truncation is the next recall ceiling~~ (M100 audit,
  ADDRESSED in M103: structured error/test/traceback evidence shipped; the
  remaining loss classes — file stems/symbols in prose the base sentence
  skips — were measured net-harmful to add in M102 V3/V7 form): 13
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
