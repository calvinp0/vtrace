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
| M104 | 4ca4948 | PASS | live-path structured-task parity + leak-clean no-agent smoke: `buildCapsuleV2Task` (the live v2 task) now RETURNS `deriveStructuredTaskFromProblemStatement(...).taskText` — the shared M103 module — replacing its own `instance:/repo:` header + FULL problem statement + `failing tests: <FAIL_TO_PASS>` + `hints:` composite (which contaminated live retrieval with hidden test labels and would echo them under opt-in `--inject-capsule-digest`); new no-agent smoke `run_stage5_m104_live_context_smoke.ts` builds the EXACT live model-visible context (runner's own task builder → CLI capsule over M103 clean workspaces → classify → cost gate → assembled markdown, canonical protocol flags) with parity + leakage diagnostics; deterministic path byte-untouched (src/, shared module, fixtures — no retrieval evals needed, baselines fresh at 199769f) | 14-case smoke (psf-5414, 3 regression guards, M103 wins incl. holdout, unchanged holdout miss, co-edit/import-reexport/file-evidence recoveries, cross-repo): task parity 14/14 byte-exact vs shared module AND frozen M103 detail rows (hashes + diagnostics); leakage 0 — 0 task hits, 7 context string coincidences ALL proven base-commit repo content (incl. sphinx-7462 `path::symbol` caller rendering format-coincident with a pytest node id), 0 unexplained, 0 gold-patch-leak blocks; psf-5414 `issue_authored_gold_path` + lead `requests/models.py`; BONUS live CLI (intent auto) reproduced the M103 lead pivot 14/14; residuals: legacy-FALLBACK query still packs FAIL_TO_PASS (retrieval-only, fires only on v2 hard-fail — treat fallback sections as parity-invalid in live attribution), M14/M15 revision arm injects FAIL_TO_PASS by design (default-off, keep off) | M105 small live confirmation (deterministic chain M95–M104 unvalidated live since M92; task evidence now provably identical to M103's measurement) |
| M105 | fb791b0 | PASS | small live confirmation of the M95–M104 chain: 14 guarded live runs (the M104 smoke set; `pydata__xarray-4695` canonical for the prompt's xarray id) under the EXACT M92 clean-core treatment flags (force-inject, v2, intent debug, budget 8000, digest+contract+bounded+compact+confidence-gate) + mandatory M89/M90A safety stack; NO V4/C7_D/revision/corrective/vexp/baseline; new per-case spawn gate = `run_stage5_m105_preflight.ts` (M103/M104 task-hash parity + digest-ON leakage rebuild + fallback + guard probes over the M103 clean workspaces) enforced by `run_stage5_m105_driver.sh`; post-run re-scan of every `_vtrace_instructions.snapshot.md` with base-commit provenance; validity/aggregation/historical-join logic pure + unit-tested (`run_stage5_m105_report_lib.ts`, 21 tests); collector `run_stage5_m105_collect.ts` | safety/parity CLEAN SWEEP: preflight parity 14/14 (hashes byte-exact), leakage 0 unexplained pre+post (8 raw hits all base-commit content), fallback fires 0, env guard pass 14/14 + 0 drift, shell guard pass 14/14 + 0 blocked host pkg cmds, unguarded 0, revision artifacts 0; resolution 6/14 (42.9%) = the M73-treatment expectation on this exact set with **14/14 per-case agreement** (same 6 resolve: 22719, 4695, 1724, 13372, 13480, 13810); M92 7-case overlap 1/7 = M92 1/7 (7/7 agreement); cost $7.66 (median $0.434, p90 $1.05) vs M73-treat $6.70 (+14%), cache-read share 93.5%; digest `query_excerpt` echo verified structured-task-only in live artifacts (pre-M104 `failing tests:`/`hints:` echo gone); 1 operational retry (seaborn-3187 spawn-time provider 429, 0 tokens, relaunched clean); outlier = django-13513 facade no-patch ($1.19, 72 turns, also failed in M73) | proceed to 24-case live confirmation |
| M106 | 5043a63 | PASS | 24-case live confirmation = committed M105 (14, REUSED via shape-validated adapter, reaggregation bit-identical, overlap-guarded against rerun) + 10 pre-registered extension cases (`run_stage5_m106_case_selection.ts` deterministic strata over frozen M103/M73/M92/M95-split inputs: 2 eg+M73-resolved, 2 eg+M73-unresolved, 2 partial/wrong_pivot, 2 miss, 1 multi-file, 1 holdout; M92-row preference, id tie-break, repo cap 2, NO backup list) run live under the IDENTICAL M92/M105 clean-core flags + M89/M90A stack; per-case spawn gate = `run_stage5_m106_preflight.ts` (M105 `runCase` reused; M104 hash vacuous-null for non-smoke cases, binding anchor = frozen M103 row); pure selection/reuse/aggregation lib `run_stage5_m106_lib.ts` (9 tests) | safety/parity CLEAN SWEEP on the extension: preflight parity 10/10, leakage 0 unexplained pre+post (17 raw hits all base-commit content: astropy-7166 x2, sphinx-7748 x15), fallback 0, env guard pass 10/10 + 0 drift, shell guard pass 10/10 + 0 host-pkg blocks, unguarded 0, revision/behavioral-guard artifacts 0, retries 0; resolution extension 3/10 (11815, 14365, 24970) vs M73-treat expectation 4/10, per-case agreement 8/10 (win 14365 U->R excellent-capsule; losses 7166 R->U, xarray-6938 R->U single-file-on-multi-file-gold); COMBINED 9/24 (37.5%) vs pre-registered 10/24, 22/24 per-case agreement, floor(5) cleared; M92 16-overlap live 4/16 = M92 4/16 (14/16 agree); cost ext $7.09 < $10 cap (vs M73 $7.97, -11%), combined $14.75 / 28.4M tok / 94.1% cache; outlier pylint-4551 $1.38/69 turns (M73 outlier $3.00) | proceed to 50-case live confirmation (reuse these 24 valid runs under the same reuse contract) |
| M107 | 1dc69b2 | PASS | 50-case live confirmation = committed M105 (14) + committed M106 (10) (both REUSED via the shape-validated adapter, reaggregation bit-identical, triple overlap-guarded against rerun) + 26 pre-registered extension cases (`run_stage5_m107_case_selection.ts` deterministic strata over frozen M103/M73/M92/M95-split inputs: 5 eg+M73-resolved, 4 eg+M73-unresolved, 4 partial [pool held only 1 — deficit filled deterministically from `overpacked` as `partial_sub_overpacked` under the GLOBAL repo cap], 4 wrong_pivot [all-django, forced], 5 miss, 2 multi-file, 2 holdout; M92-preference, id tie-break, repo cap 6) run live in phases A5/B10/C11 under the IDENTICAL M92/M105 clean-core flags + M89/M90A stack; per-case spawn gate = `run_stage5_m107_preflight.ts` (M105 `runCase` reused); pure selection/substitution/50-case-aggregation lib `run_stage5_m107_lib.ts` (11 tests) | safety/parity CLEAN SWEEP on the extension: preflight parity 26/26, leakage 0 raw hits pre-run AND 0 unexplained post-run (cleaner than M105/M106), fallback 0, env guard pass 26/26 + 0 drift, shell guard pass 26/26 + 0 host-pkg blocks, unguarded 0, revision/behavioral-guard artifacts 0, provider retries 0 (one EXTERNAL mid-run kill of django-10880's first launch — partial dir removed, relaunched clean, ledgered); resolution extension 8/26 (16569, flask-5014, 10880, 15731, sphinx-9698, pylint-8898, sympy-12419, sympy-24562) vs M73-treat expectation 13/26, agreement 17/26 (wins sympy-12419 [standing M7.x regression!] + sympy-24562, both M103-overpacked; 7 losses concentrated in M73-resolved strata); COMBINED 17/50 (34.0%) vs pre-registered 23/50 (M73 baseline 20/50), floor(12) cleared, agreement 39/50; M92 37-overlap live 9/37 vs M92 13/37 (31/37 agree); cost ext $16.66 < $22 cap (vs M73 $25.09, −34%), combined $31.41 / 57.6M tok / 94.0% cache; outlier django-16263 $3.01/93 turns (M78 edit-churn signature reproduced live) | proceed to 100-case live confirmation (reuse these 50 valid runs); the open question for the larger sample: is 17/50-vs-23/50 live-day variance or a real gap (per-stratum deltas are 1–3 flips; a same-day paired baseline is the decisive-but-costlier alternative) |
| M108 | a0bc3a6 | PASS | 100-case live confirmation = committed M105 (14) + M106 (10) + M107 (26) (all REUSED via the shape-validated adapter, reaggregation bit-identical to every committed aggregate incl. combined24/combined50, quadruple overlap-guarded) + the 50 REMAINING pool cases selected as the deterministic COMPLEMENT (`run_stage5_m108_case_selection.ts`, no strata/sampling/backup list, M92-row-first + id order, phases A8/B14/C14/D14) run live under the IDENTICAL M92/M105 clean-core flags + M89/M90A stack; per-case spawn gate = `run_stage5_m108_preflight.ts` (M105 `runCase` reused + two pre-registered post-classifications: `expected_no_context` [frozen-M103 `capsule.mode=no_context` parity ⇒ NEVER spawned: injectionless run = baseline-shaped + parity-invalid; django-11740/15572/sphinx-9320] and `issue_authored_task_hits` [sympy-15599 `test_Mod`: FAIL_TO_PASS id verbatim in the problem statement + base-commit content, M103 issue-authored policy]); pure complement/phase/100-aggregation/spend-cap lib `run_stage5_m108_lib.ts` (15 tests) | safety/parity CLEAN SWEEP on the extension: preflight parity 47/47 byte-exact, leakage 0 unexplained pre+post, fallback 0, env guard pass 47/47 + 0 drift, shell guard pass 47/47 + 0 host-pkg blocks, unguarded 0, revision/behavioral-guard artifacts 0, provider retries 0 (two EXTERNAL driver kills during workspace setup — sympy-20428/django-10973 first launches, zero artifacts, partial workspaces removed, relaunched clean, both cases then RESOLVED); resolution extension 38/47 (80.9%) vs M73-treat 41/47 on attempted (agreement 42/46 comparable; 4 losses 11490/13551/16766/23413, 0 wins; 10973 resolved with no valid M73 row); COMBINED **55/97 valid (56.7%)** vs pre-registered 66/100 M73-treat (64/96 comparable, agreement 81/96), floor(36) cleared by 19; deficit localized to the M106/M107 failure-strata extensions — the success-heavy M108 remainder tracks expectation within −3, resolving the M107 open question as "modest hard-stratum deficit + variance, no systemic regression"; M92 12-overlap live 7/12 vs 6/12 (11/12 agree); astropy-14539 resolved live ⇒ with M107's sympy-12419 + pylint-8898 the whole M7.x regression list is now live-recovered; cost ext $25.27 < $45 cap (vs M73 $28.19 on the same 50, −10%), combined $56.69 / 104.6M tok / 93.9% cache; outlier sympy-20428 $1.88/101 turns (miss-class structural ceiling); M103-outcome split on ext: excellent 16/18, good 10/13, miss 7/9 (capsule misses largely agent-recoverable live), overpacked 5/7 | freeze the current default path and prepare the final internal summary; remaining analytical thread = characterize the M106/M107 hard-stratum flips vs M73 from captured artifacts (no new live spend); the 3 frozen no-context cases are the only pool rows the default path cannot inject on — a candidate-recall follow-up if that class ever grows |
| M109 | d9364a9 | PASS | final internal summary + hard-stratum analysis (NO-SPEND: no agents/Docker/API/VEXP/baselines; committed artifacts only): analysis notes (`stage5_m109_final_analysis_notes.md`, 17 questions answered pre-summary), hard-stratum flip classifier (`run_stage5_m109_lib.ts` pure + 12 tests: STRICT M73 `treatment_valid` comparability + documented likely-reason heuristic [no_context > infra > single-file-on-all-gold-multifile > high-cost(≥$1.50/≥25 tools) > context-gap(miss/wp/partial) > agent-variance]) over all 36 M106/M107 cases + named M105/M108 cases → `stage5_m109_hard_stratum_analysis.json`; final summary `stage5_m109_final_internal_summary.{md,json}` with claim-safe/prohibited wording; minimal docs update (`docs/current_product_state.md` benchmark-interpretation + next-milestones; README already claim-safe, untouched) | deterministic core M94→M103: r@5 .637→.748, all-gold 60.6→75.0%, lead-src-gold 45.5→59.0%, hidden-coedit .222→.622, multi-file all-gold 6.7→53.3%, miss 30→21, wp 10→7, overpacked 7→14 (accepted), median tokens flat/p90 −20%; live: 97 valid / 55 resolved (56.7% of valid) / 3 pre-registered no-context exclusions / $56.69 / 93.9% cache-read; STRICT M73 comparability (4 invalid M73 rows: 10973, 14598, 13513, 15503): 93 comparable, expectation 64, live 54, agreement 77/93 (82.8%; loose as-reported framing = 81/96); M73-baseline 61/97 vs live 55/97; M92 overlap 49: live 16 vs 20, agree 41; live-by-M103-class: excellent 19/32, good 14/24, overpacked 9/14, miss 11/18 (agent-recoverable), wp 2/7, partial 0/2; 13 strict losses — 10 had ALL gold in capsule (10 agent_variance, 1 single-file-on-multifile [xarray-6938], 2 context-gap [pytest-6197, sympy-15875]); wins 14365/12419/24562 + 10973 (no row); deficit = hard-stratum agent variance, NOT retrieval regression | freeze recorded; internal package = M109 summary + M108 report + hard-stratum JSON; ranked next: no live spend until captured-artifact questions exhausted → hard-stratum transcript study → no_context only if class grows → VEXP comparison only under a separate preregistered protocol |
| M110 | 2be7a4c | PASS | internal evidence package + frozen default path manifest (documentation-only, NO-SPEND: no agents/Docker/API/VEXP/baselines/retrieval evals; nothing rerun): pre-work plan (`stage5_m110_package_plan.md`, 11 questions answered before any package file), pure builders + wording guards (`run_stage5_m110_lib.ts`, 20 tests: manifest schema, artifact-index raw-path exclusion, claim-matrix completeness, prohibited-claim regex guard with ✗-quoted-listing stripping, denominator-framing guard), generator (`run_stage5_m110_package.ts`: parses all canonical JSONs fail-loudly, cross-checks the frozen 97/55/100 headline + exclusion ids against M109, hashes + tracked-checks all 47 indexed artifacts, runs both wording guards over every generated file before writing) → `stage5_m110_frozen_default_path_manifest.json` (HEAD, M94–M109 commits, clean-core flags, disabled paths, invalid contexts, exclusions, claim boundaries), `stage5_m110_evidence_artifact_index.{md,json}` (47 tracked artifacts in 6 groups, sha256, canonical/supporting), `stage5_m110_claim_matrix.{md,json}` (9 claims incl. 3 boundary claims, allowed wording verbatim from M109, prohibited stronger forms), `stage5_m110_new_chat_handoff.md` (self-contained), `stage5_m110_internal_evidence_package.{md,json}`; docs: `docs/current_product_state.md` confirmed claim-safe unchanged; README one stale-tense fix ("planned M94 scoreboard" → completed M94→M103 scoreboard, no new claims) | package basis commit 9b462cc; 47/47 indexed artifacts tracked + hashed; 9/9 required claims present; wording guards green on all 8 generated files + reused M109 allowed wording; denominator rule enforced (100 pool / 97 valid / 55 resolved / 3 no-context exclusions, never 100-of-100); no raw runs/streams/logs/workspaces indexed, hashed, or staged | freeze and archive; next work follows the ranked M109 list (hard-stratum transcript study from captured artifacts first; VEXP only under a separate preregistered protocol); start any new session from `stage5_m110_new_chat_handoff.md` |

| M111 | f0c2787 | PASS | hard-stratum transcript study from CAPTURED artifacts (NO-SPEND: no agents/Docker/API/VEXP/baselines/V4-C7_D/revision arms; nothing rerun): pre-work plan (`stage5_m111_transcript_study_plan.md`, 10 questions answered first), pure classifier lib (`m111_case_classifier.ts` + 35 tests: edited-gold sets, documented patch-shape rule, tool-loop signature heuristics, test-behavior with with-outputs "None"-string handling, CSV escaping, run-label resolver), runner (`run_stage5_m111_hard_stratum_transcript_study.ts`: fails closed if its loss set diverges from the committed M109 JSON; machine fields computed from artifacts, analyst transcript judgments recorded as an explicit per-case table) over 21 cases = all 13 strict M109 losses + django-16263/pylint-4551 (tool-loop) + 6 contrast wins; artifact coverage 21/21 full (transcript+tool-log+patch+eval+capsule) → `stage5_m111_hard_stratum_transcript_study.{md,json}`, `stage5_m111_case_classifications.{json,csv}`, `stage5_m111_next_action_queue.json` | loss anatomy: **13/13 strict losses produced a patch AND edited ≥1 gold file** (0 wrong-file, 0 no-patch); 10/13 all-gold-in-capsule, 7/13 gold lead; failure split REVISED from M109's 10/1/2 to **11 wrong-logic-at-gold-site + 2 multi-file propagation (xarray-6938, django-12325) + 0 binding deterministic gaps** — both M109 "context-gap" losses (pytest-6197, sympy-15875) ruled out the noise pivots and edited gold in-transcript (gap non-binding); shared mechanism = **verification blackout**: repo test suite ran in 0/13 (numpy/mpmath/distutils/asgiref missing, pip absent — a STANDING protocol property, the captured M73-era astropy-7166 run hit the same wall), so hard cases are one-shot logic bets; the 2 losses that did execute agent-built checks passed WRONG self-oracles (7166 `fget.__doc__` vs the M73 run's faithful `property.__doc__`; 15875 accepted `is_zero=None`); wins are one-shot-correct or faithful-oracle (8898/14365/24562 mirrored the issue's exact inputs; V5 traceback lane directly enabled the 8898 win on an M103 miss); tool-loop cases = env-failure loops + scope underestimation on 4-file golds, NOT read-thrash — V4 would not fire, C7_D fired late+neutral in M85 on 16263 ⇒ both stay default-off; concrete lever evidenced: 6938's optional co-edit gold (variable.py) and 12325's required gold (options.py) never received any decision-contract decision | improve digest/context-action wording (per-file EDIT/RULE_OUT incl. optional co-edit targets; offline re-audit first), then the no-spend verification-oracle audit (CHECK RUN text vs resolution over all 97 captured runs); no retrieval/capsule work for this stratum (0 binding gaps); env-failure-loop diagnostic = design-only; env provisioning deferred (protocol change, needs preregistered paired arm); NO live spend now |
| M112 | 1eeacfe | PASS | digest per-file EDIT/RULE_OUT action contract (deterministic product WORDING only, NO-SPEND: no agents/Docker/API/VEXP/baselines/V4-C7_D/revision arms; nothing rerun): pre-work plan (`stage5_m112_digest_action_contract_plan.md`, 12 questions + pre-capture addendum, written first), `selectDigestActionFiles` + per-file action block in `digestDecisionContract.ts` — one `A#: <path> — <reason>` EDIT-or-RULE_OUT line per high-importance FILE (all pivot files [lead/hidden/required-target labels, M68-gate-independent — the closure-scored T/O selection is UNTOUCHED], lane-marked support files [`co-edit lane)` / `(import-relation lane)` / `(file-evidence rescue)`], ≤2 pivot-cap-evicted strong targets [`strong target beyond the pivot budget` role_reason]; dedup by path, cap 6 + explicit `(+N more)` honesty line), plus "Do not silently ignore any file listed here", a decide-EACH-before-finalizing multi-file clause, a soft support-only note, and the single generic verification caution; DEFAULT ON under `--bounded-digest-decisions` (no runner change needed; `perFileActionContract:false` = pre-M112 bytes); 12 new unit tests; no-agent pre/post render smoke (`run_stage5_m112_render_smoke.ts`, frozen M105–M108 flags over the committed clean workspaces) → `stage5_m112_digest_action_contract.{md,json}`, `stage5_m112_render_smoke.{detail.json,csv}` | smoke 12 cases (6 required M111 cases + 3 contrast wins + excellent + wrong_pivot + no_context): action contract on 11/11 rendered contexts, lead-pivot entry 11/11, per-file action count median 4 (max 5, cap never bound), 0 plain-support files overconstrained; **xarray-6938 now lists gold `variable.py` as `A4 — co-edit candidate`** (its evidence array carries the co-edit rescue marker the digest `why:` line hid) and the gate-demoted lead regains a per-file slot; **django-12325's gold `options.py` = `A2 — hidden pivot`**; no_context (11740) renders nothing pre+post; invariants ALL HOLD via stash A/B + latency-normalized capsule-stdout sha equality (selection/lead/T-O targets/task hash [M103-byte-parity]/mode unchanged; retrieval evals correctly not run — no retrieval code touched); leakage 0 unexplained hits over all 12 full contexts; char impact: contract +1011 median / +1099 p90 chars, TOTAL context only +244 median / +1002 p90 (cap-bound cases absorb the block by trimming tail support-signature bodies — M45 truncation, contract sentinel-atomic); 3664 tests 0 fail, both typechecks clean | proceed to verification-oracle prompt-policy audit (M113, no-spend, all 97 captured runs); action contract stays default-ON under the bounded contract; NO resolution claim without a future separately-approved guarded live confirmation (re-prove parity/leakage first); no live spend now |

| M114 | 95b5a43 | PASS | worktree-aware index ownership + safe opt-in stale refresh (NO-SPEND product milestone): canonical Git common-dir/repository identity and canonical worktree-root/Git-dir identity; v2 ownership manifest with HEAD/branch/detached/dirty fingerprint/run/schema/parser/config; linked-worktree `.git` file root detection; precise freshness taxonomy; worktree-local atomic PID lock with dead-owner recovery; `repo_root` on index/context/status/capsule-staleness MCP surfaces and index/status CLI aliases; normal MCP profile visibly exposes `get_code_context` + `index_repo` + `check_capsule_staleness`; `get_code_context.auto_refresh=never` default and explicit `if_stale` same-worktree refresh only; legacy manifests fail closed until rebuild | no-agent temporary-Git smoke PASS for HEAD drift, dirty drift, linked/detached worktrees, default-off/opt-in refresh, lock isolation, tool exposure, and fresh retrieval/capsule invariants; canonical-checkout manifest byte-unchanged while a new linked worktree is initialized; 3674 tests / 0 fail across 210 files; both typechecks + diff check clean; retrieval evals correctly not run because retrieval/scoring/ranking/packing/task/digest code was untouched and fresh-context parity passed | promote worktree-aware indexing; orphan prune and shared immutable blob cache deferred; no background watcher added |
| M115 | 28f902d | PASS | real-repository TCKDB worktree acceptance (REPORT-ONLY, NO-SPEND): inspected the actual 17-worktree Git common directory; restarted the promoted stdio MCP server and verified the simultaneous `get_code_context` / `index_repo` / `check_capsule_staleness` surface plus `repo_root` / `auto_refresh`; created a detached current-`origin/main` linked worktree; exercised default fail-closed, explicit refresh, canonical isolation, dirty fingerprint, restored-clean fingerprint, detached HEAD, truthful `nextTool`, and a disposable-clone HEAD-advance simulation; ran the motivating `lowest_energy_unavailable` context request without a coding agent | all acceptance scenarios PASS: legacy canonical manifest reported precise `manifest_invalid`; new main root reported `missing_index`; explicit full/incremental refreshes stayed on the requested root; canonical manifest SHA-256 remained byte-identical through every mutation; canonical/main/ESS worktree IDs were distinct under one repository ID; dirty probe produced `working_tree_changed`; commit A→B produced `head_mismatch`; real context resolved to 2 pivots in `backend/app/api/routes/species.py`; all M115 temporary roots/files/indexes/commit/client removed and original TCKDB statuses restored; no VTRACE defect/source change; 3674 tests / 0 fail across 210 files; both typechecks + JSON/path normalization + diff check clean | promote M114 without qualification; no MCP reconnection documentation fix needed |
| M116 | dd18a02 | MIXED | offline E1 environment-failure-loop diagnostic calibration over all 97 valid M105–M108 captured runs (NO-SPEND: no agents/Claude/Codex/Docker/API/VEXP/baselines/live V4-C7_D/revision-oracle arms/environment mutation): pre-work plan written first; pure gold/outcome-blind event classifier + focused tests; chronological development 24 / validation 26 / holdout 47; frozen E1-v1 fires on a second equivalent same-family environment verification failure or third related-family no-progress failure, with edit/successful-verification resets; explicit analyst table; existing V4/C7_D pure replay comparison; required Markdown/JSON/detail/CSV/queue outputs | artifact coverage 97/97 ordered tool outputs; state distribution NONE 8 / ISOLATED 12 / RECOVERED 29 / REPEATED 3 / LOOP 26 / AMBIGUOUS 19; 26 fires = 11 resolved + 15 unresolved (not a failure predictor), first-fire min/median/p90/max 4/6/14/31; both named positives detected (django-16263 @31, pylint-4551 @14), five single-attempt controls protected; V4 overlap 0, C7_D overlap 2, E1-only 24; productive-recovery safety failed on sympy-24562 (fire one turn before strong oracle) and sphinx-9230 (operational false positive after recovery); 3695 tests / 0 fail across 212 files; both typechecks + diff check clean; retrieval evals correctly not run because retrieval/ranking/candidate/packing/task/digest code was untouched | decision C: do NOT implement runtime observe mode; preserve replay classifier, redesign persistent recovery suppression + early related-family equivalence, then recalibrate offline; V4/C7_D remain default-off; no live study justified |
| M117 | 26af4a0 | PASS | strategy-aware E1-v2 offline replay classifier redesign over all 97 valid M105–M108 captured runs (NO-SPEND: no live agents/Docker/API/VEXP/baselines/live V4-C7_D/revision-oracle arms/environment mutation; no runtime hook/flag/prompt/interrupt): required plan written before implementation; pure gold/outcome-blind classifier separates failure roots from verification strategies, normalizes cosmetic command variants while preserving semantic targets, grants one post-edit/new-strategy attempt, persists successful recovery protection, and defers a candidate immediately before an observable standalone oracle; focused tests + deterministic generator produce the required audit/detail/CSV/comparison/analyst/queue artifacts; evaluation is explicitly retrospective with four identical-rule leave-one-milestone-out inspections, not a new holdout | coverage 97/97; E1-v2 fires 30 = 10 resolved + 20 unresolved, first-fire min/median/p90/max 3/6/12/30; django-16263 @30 and pylint-4551 @10 within analyst windows; sphinx-9230 and sympy-24562 protected; 0/5 single-attempt fires, 0 post-recovery, 0 productive-transition, 0 immediately-before-strong-oracle, 0 operational false positives; recovery-protected 29; same-strategy 11 / dependency-install 11 / repo-test-environment 10; M105/M106/M107/M108 fire rates .429/.400/.308/.255 (range .174; zero premature/post-recovery/productive-transition in every cohort); V4 overlap 2, C7_D overlap 2, E1-only 26; 3711 tests / 0 fail across 213 files; both typechecks + diff check clean; retrieval evals correctly not run | decision A: freeze replay-only E1-v2 and wait for future naturally occurring runs for prospective validation; this does NOT authorize runtime integration; V4/C7_D remain default-off |
| M118 | 3b0baa7 | MIXED | repository-scoped immutable content-addressed parse cache + v3 per-file worktree snapshots + deterministic auto/incremental/full refresh planner (NO-SPEND product milestone): parser/config/language/path/binding-aware cache keys; Git blob identities for clean tracked files and cryptographic worktree hashes for dirty/untracked files; atomic validated cache entries; worktree-isolated graphs; zero-parse/no-graph-write no-op; changed-file parse reuse with semantic symbol-ID rebinding; transactional full-worktree relink/persistence and graph validation; precise safe fallbacks; CLI/MCP/status/auto-refresh diagnostics; normalized graph/retrieval equivalence helpers; no snapshot cloning, watcher, or cache pruning | required scenario matrix covered by focused temporary-Git tests and no-agent smoke; linked 1-file/80 refresh reused 79 parses (98.75%) without changing the source index; all measured incremental/full normalized graphs and retrieval rows matched; Python 1/24 improved 558.513 ms→45.423 ms (12.30x), TypeScript 1/120 was timing-neutral (45.174 ms full vs 47.195 ms incremental), no-op parsed 0; measured TypeScript crossover selects full at 20% for repositories ≥20 files; 3723 tests / 0 fail across 215 files; both typechecks + diff check clean; retrieval evaluations correctly not run because scoring/ranking/candidate/packing/task/digest behavior was untouched | promote the shared parse cache; retain conservative full-worktree graph relinking and defer selective graph invalidation until unresolved dependency descriptors support a provable closure |
| M119–M129 | — | — | (rows not appended at the time; see `results/stage5_m1{19..29}_*.md` for each milestone's own report) | product-context assembly, impact/flow integration, product retrieval v1→v2, hybrid core, capsule unification, mixed code+config retrieval, document-aware retrieval | — |
| M130 | f0dc8b1 | PASS | corrective product-trust milestone: flow-correctness fix + complete-response budgeting | **flow**: `searchLogicFlow` pre-sliced the repository edge list to `maxEdges` (default 2000) before building its graph; ARC's 19,404-edge index put the `reorder_p_label_map → map_two_species` call edge at position 6,891, so ~90% of the graph was invisible and the loss was reported as `endpoints_not_connected`. `maxEdges` is now a traversal budget (default 20,000) and exhausting it is reported as `traversal_limit_reached`. `endpoints_not_connected` removed; negative results carry `claimScope: current_index`, `endpointsResolved`, `verificationRecommended`. Call-site excerpts anchor on the located call (`edge_site`) instead of a head window. **response**: a `max_tokens: 6000` request returned 86,989 chars because the selected context was serialized 4× (rendered text, item bodies, capsule item bodies, neighbourhood excerpts) inside unbounded retrieval telemetry; MCP responses are now budgeted end-to-end → 27,877 chars / 6,970 est tokens (ceiling 7,000), 21 duplicated bodies → 0. Frozen 50 byte-identical (0/50 differences); retrieval evals byte-identical (stash A/B) | M131: workspace foundations (registry, multi-repo retrieval, cross-repo edges) |
| M131 | 238000b | PASS | flow scalability + product-path hardening: remove the architectural conditions that made M130's failures possible, rather than only their symptoms | **traversal**: `searchLogicFlow` no longer materialises the graph. New `src/graph/frontierTraversal.ts` expands one frontier level per batched indexed adjacency query (`listOutgoing/IncomingEdgesForSymbols`, chunked 500), hydrating symbols in batches; `maxEdges` is one budget shared across both directions. ARC one-edge flow 82.851 ms → **6.606 ms** (12.5x), **4 of 18,862 edges fetched**, 3 DB queries, 2 frontier batches. Synthetic 2k/20k/100k: edges fetched 2/2/2, DB queries 2/2/2 — explored work flat across 50x graph growth. Order-invariant across 5 insertion orders; budget exhaustion reports `traversal_limit_reached`; genuine no-path reports `no_indexed_path_found` with `budgetExhausted: false`. **provenance**: additive `edge_call_sites` table records every parser-observed occurrence; ARC hop now reports `edge_site` at exactly `engine.py:1724` (`precision: span`) instead of a body scan. Multiple call sites are enumerated with a labelled representative; an index without recorded sites degrades to `caller_span_scan` and never claims `edge_site`. **types**: `@ts-nocheck` removed from `searchLogicFlow.ts` (2 errors, both union narrowing); budget precedence extracted to typed `src/mcp/productResponseOptions.ts`. **envelope**: scale tests across items/source/diagnostics/flow hops/impact/documents found two real gaps M130's single fixture hid (unbounded `productContext.items` metadata; per-hop flow excerpt text) — four new ladder tiers + a compact-accounting fallback; ARC incident 26,587 chars / 6,647 tokens (was 27,726 / 6,932). Frozen 50 identical (0/50, hash `99eab9ab635b15c2`); retrieval evals byte-identical (stash A/B); TCKDB lead + M130-code parity preserved; 3778 tests / 0 fail | M132: workspace and repository identity foundation, inheriting the constraint that workspace operations must not load unrelated repository graphs and must obey the complete-response envelope after aggregation |
| M132 | 9260d37 | PASS | worktree routing + repository-identity integrity: make single-repository / multi-worktree operation trustworthy before any multi-repository work | **nested worktrees**: `scanRepo` descended into linked worktrees nested under the requested root and indexed a second complete copy of the repository; new typed `src/fs/worktreeExclusions.ts` runs `git worktree list --porcelain` ONCE per scan and excludes registered worktree roots that are strict descendants (segment-aware, so `/code/ARC.worktrees/x` is not inside `/code/ARC`). ARC: 37 registered worktrees, **5 nested excluded** (`feature_docker_ux`, 4x `.claude/worktrees/*`), files **615 -> 324**, symbols **15,188 -> 8,635**, index 25.7s -> 19.3s, discovery cost 8.65 ms. Edges **18,862 -> 19,404** — UP, because duplicate modules made import/call resolution ambiguous; the M131 ARC figure was measured on a contaminated index and 19,404 supersedes it. The reported duplicate pair (`arc/species/vectors.py` + `feature_docker_ux/arc/species/vectors.py`) is gone and `excludedPathsInResults=0`. Submodules and unregistered nested repos are deliberately UNCHANGED (absent from `git worktree list`). **routing**: `repo_root` added to `get_context_capsule`, `run_pipeline`, `get_impact_graph`, `search_logic_flow`, `get_skeleton` (one shared `REPO_ROOT_PROPERTY`; previously only `get_code_context`/`index_repo`/`index_status`/`check_capsule_staleness` had it); typed `src/mcp/worktreeRouting.ts` fixes precedence explicit_root > client_context > process_default with server cwd NOT a candidate, and emits `worktree_context_required` / `worktree_missing` / `worktree_mismatch` / `worktree_index_missing`; O(1) fail-closed `detectIndexWorktreeMismatch` on the shared binding path refuses an index whose manifest records a different worktree root; `productContext.repository.routingSource` stamps provenance once per response. Three worktrees of one repository each return their own `src/foo.py` across repeated interleaved queries; `auto_refresh: if_stale` on B leaves A's fingerprint byte-identical and vice versa. **caller context (audited)**: MCP transmits NO caller cwd — `initialize` carries protocol/capabilities/clientInfo only, this server neither declares nor consumes `roots`, and `process.cwd()` is the server's launch dir; explicit `repo_root` is therefore the contract, `clientContextRoot` is the seam and is null today. **contaminated indexes**: `scanRepo.ts` + `worktreeExclusions.ts` are hashed into `config_hash`, so every pre-M132 index reports `configuration_changed` (already auto-refresh-allowed) and the ordinary incremental deletion path removes the stale rows (nested files/symbols 1/1 -> 0/0). No new freshness reason, no schema bump. **project name**: `ARC` was extracted as an ALL-CAPS acronym anchor whose path-segment branch matched EVERY file under `arc/`; new typed `src/capsuleV2/projectNameSignals.ts` drops a term equal to the repository basename BEFORE anchor resolution unless the task shows explicit symbol evidence (`class ARC`, `ARC.`, `ARC(`, `path::ARC`, backticked, `ARC class/symbol/constructor`). Geometry query: `arc/main.py` + `arc/reaction/reaction.py` (ARCReaction) OUT, `linear_utils/addition.py` + `math_zmat.py` IN; the neutral-phrasing control now agrees; `How does the ARC class initialize project-level state?` still leads `arc/main.py`. One generator changed, no weights retuned. **search_symbols**: it EXISTS but is registered hidden, so `tools/list` never showed it — the agent's report was correct and the generated guidance was stale; decision = keep hidden, fix the generator (+ README/docs), and `src/runtime/toolGuidanceConsistency.test.ts` now enforces referenced-tools subset-of-VISIBLE-tools. **impact**: `discoverImpactSymbols` N+1 batched into one `getSymbolsByIds` per frontier level — 112 -> 73 queries for the same 40 dependents, byte-identical output | Frozen 50 identical (0/50 differences); the project-name interaction audit found 0 frozen tasks that can even trigger the repository-name rule, so 0 is structural not lucky; retrieval evals byte-identical (stash A/B) and the stale-since-M103 committed baselines refreshed with explicit M104-M131 attribution; TCKDB lead + M131-code parity preserved; ARC flow `reorder_p_label_map -> map_two_species` still 1 `calls` edge with `edge_site`, 11 of 19,404 edges fetched, 3.4 ms warm; envelope 1,844 est. tokens / 7,375 chars at `max_tokens: 6000`; 3877 tests (3828 pass, 49 skip) / 0 fail | M133: impact graph response boundedness and delivery integrity |
| M133 | a004529 | PASS | bound complete impact product responses and forbid successful false-envelope context returns | ARC `get_dihedral`, `max_edges=10/max_tokens=1200`: **1,385,362 -> 6,689 chars**, ~346k -> 1,673 estimated tokens, complete ceiling 2,000, all six caller sites retained. Canonical edges bound nodes/view/path projections; post-accounting MCP+CLI gate reports retained/omitted counts and has an 80k hard guard. 100k-edge and 10k-fanout tests remain flat. `get_code_context` real 3k request: 3,992/4,000, resolved true, within true. M132->M133 paired frozen 50 byte-identical; ARC flow and TCKDB exact semantics preserved. | M134: retrieval benchmark provenance and historical attribution |

## Standing findings (still true unless a later row says otherwise)

- **Indexes are owned by canonical worktrees, not branches or Git common dirs**
  (M114): each worktree keeps its existing local `.vtrace` database and a v2
  manifest binds it to repository + worktree ids. Context remains fail-closed
  by default; `auto_refresh=if_stale` is explicit, root-resolved, lock-protected,
  and cannot refresh repository/worktree mismatch state. Orphan pruning is
  deferred and never occurs during an unrelated query.

- **Non-T high-importance files now carry an explicit per-file EDIT/RULE_OUT
  obligation** (M112): the bounded contract renders an `A#` action line per
  pivot file, lane-marked co-edit/rescue file, and ≤2 pivot-cap-evicted strong
  targets — closing the M111 silent-omission hole (6938 variable.py, 12325
  options.py). The closure-scored T/O selection, M68 gate, retrieval, and
  capsule selection are byte-untouched; effect on live resolution is
  deliberately unmeasured until a guarded confirmation is approved.
- **The M68 strong-clause vocabulary misses direct task-naming evidence**
  (M112 pre-capture): a lead pivot whose evidence is `task names this symbol
  directly — …` (xarray-6938) is gate-demoted to optional/FYI, leaving one T
  target on a 2-gold-file case. Not fixed in M112 (T-set semantics frozen);
  candidate input to any future gate recalibration milestone.
- **The capsule CLI's only nondeterministic output field is `latencyMs`**
  (M112): back-to-back identical-src runs differ ONLY there; normalize it
  before using stdout hashes as selection invariants.

- **The hard-stratum deficit is wrong-logic-at-the-gold-site, not context**
  (M111): every strict M73-loss edited a gold file; binding deterministic
  context gaps = 0/13. Do not spend retrieval/capsule/packing effort on this
  stratum. The two transcript-evidenced levers are (a) per-file decision
  contract coverage — optional co-edit targets can go entirely undecided
  (xarray-6938 variable.py, django-12325 options.py) — and (b) verification
  oracle fidelity: the live env cannot run repo tests (standing since at
  least M73; host python lacks repo deps, pip absent, host-pip firewalled),
  so PATCH_VERIFY "CHECK RUN" is either skipped honestly (11/13 losses) or
  satisfied by a self-invented oracle that can encode the wrong semantics
  (7166, 15875). Wins under identical constraints built faithful oracles
  from issue-visible expected behavior.

- **The frozen default path and its claim boundaries are machine-recorded**
  (M110): `stage5_m110_frozen_default_path_manifest.json` is the canonical
  freeze record and `stage5_m110_claim_matrix.{md,json}` the canonical claim
  surface — reuse its allowed wording verbatim; anything in its prohibited
  lists must never appear in code, docs, or reports. New sessions start from
  `stage5_m110_new_chat_handoff.md`.

- **The default live path is confirmed live-valid over the FULL frozen
  100-case pool** (M105–M108): 97/97 guarded live runs task-parity-exact and
  leak-clean under the digest-ON clean-core protocol; combined 55/97
  resolved vs 66/100 M73-treatment expectation with 81/96 per-case
  agreement; the deficit sits in the M106/M107 failure-strata extensions
  (wrong_pivot/miss/partial), not in the path itself. The pool's only
  non-injectable rows are the 3 frozen M103 `no_context` cases
  (django-11740, django-15572, sphinx-9320) — the default path has nothing
  to inject there and a live run would be baseline-shaped + parity-invalid,
  so they are preflight-held, never spawned.
- **The M7.x live-regression list is fully recovered live** (M107+M108):
  sympy-12419 + pylint-8898 (M107) and astropy-14539 (M108) all resolved
  under the current default path.
- **Issue-authored FAIL_TO_PASS ids can appear in the derived task** (M108,
  first occurrence sympy-15599 `test_Mod`): the M103 V5 derivation extracts
  issue-mentioned failing tests by design; when such an id doubles as a
  FAIL_TO_PASS label the raw scan flags it. Classify by problem-statement
  verbatim-provenance (M103 issue-authored policy) — a hit NOT in the issue
  text still blocks.
- (superseded scope, M105+M106 original finding) 24/24 guarded runs
  task-parity-exact and leak-clean; per-case outcomes matched the M73
  treatment arm 22/24 (9/24 resolved vs 10/24 expected). M106 established
  the artifact-reuse contract (shape-validated adapter + overlap guard) for
  growing the live sample without reruns.
- (superseded scope, M105 original finding) 14/14
  guarded runs task-parity-exact and leak-clean under the digest-ON clean-core
  protocol; resolution and per-case outcomes matched the M73 treatment arm
  exactly (6/14, same cases). Live-vs-deterministic deltas from here on are
  agent/config-attributable. The legacy FALLBACK residual never fired but is
  still unfixed — keep counting any fire as parity-invalid. django-13513
  (facade lead) remains the standing live failure to watch: 72 turns, no
  patch, the M103 regression-guard case.
- **Live and deterministic Stage 5 tasks are now the SAME function** (M104):
  any live-vs-deterministic delta from M105 on is attributable to the
  agent/config, never to task derivation. Before any live spend, re-prove
  parity + leakage with `run_stage5_m104_live_context_smoke.ts` (no agent, no
  Docker; uses the M103 clean workspaces). Known non-task config differences
  that remain: live intent `auto` vs scoreboard's pinned `Debug`, CLI
  subprocess vs in-process `buildCapsuleV2` (lead pivots agreed 14/14 on the
  smoke set regardless).
- **Leak-scan hits need base-commit provenance classification** (M104): raw
  string scans over injected context false-positive on legitimate repo
  content — gold ADDED lines that copy pre-existing sibling patterns
  (django-16256 `sync_to_async` lanes) and vtrace's `path::symbol` caller
  rendering that is format-identical to a pytest node id (sphinx-7462). The
  smoke classifies a hit as a leak only when it is NOT derivable from the
  base-commit workspace snapshot.

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

- **`maxEdges` on `search_logic_flow` is a TRAVERSAL BUDGET, not a graph filter**
  (M130): before M130 it pre-sliced `listAllEdges` in arbitrary repository order,
  so any repo above the bound silently lost real edges and answered "not
  connected" for relationships it had indexed correctly. The defect scaled with
  repository size and was invisible in small fixtures — every regression test at
  the time used repos under the bound. Any future bound on graph work must bound
  *work*, and report when it bites.
- **VTRACE does not claim two symbols are unconnected** (M130): static analysis
  over one index cannot establish that. `endpoints_not_connected` is gone; the
  vocabulary is `no_indexed_path_found`, `traversal_limit_reached`,
  `start_endpoint_not_found`, `end_endpoint_not_found`, `endpoint_ambiguous`,
  `index_stale`, `unsupported_language`, plus the query-shape reasons. Every
  negative result carries `claimScope: "current_index"`.
- **`max_tokens` bounds the model-visible context; the response envelope is a
  SECOND measurement** (M130): `productContext.modelVisibleContext` is the only
  field carrying rendered source, and the complete serialized result must fit
  `max_tokens + max(1000, 15%)` estimated tokens. Compaction is applied at the
  MCP response boundary only — `formatRunPipelineOrchestrationOutput` is
  unchanged, so the CLI, the VS Code panel and every Stage 5 harness still see
  the full shape. Adding a new source-bearing field to an MCP context response
  reintroduces the incident.
- **The TCKDB acceptance file list drifts with the TCKDB checkout** (M130): the
  M129-recorded list was captured at TCKDB `8f0d84b`; at `1ca3e75` (34 commits
  later, `builders/calculation.py` itself changed) the sixth slot resolves to
  `builders/geometry.py`. The M129 CODE produces the same selection on the
  current checkout, so preserve-checks must compare against an M129-code baseline
  on the SAME checkout, not against the recorded file list.

- **Graph-query cost must track the explored subgraph, not the repository**
  (M131): `searchLogicFlow` now expands one frontier level per batched indexed
  adjacency query and never calls `listAllEdges`/`listAllSymbols`. A one-edge ARC
  answer fetches 4 of 18,862 edges. Any future graph feature that begins with
  "load all edges" reintroduces the M130 defect class at the next scale
  threshold. `src/graph/frontierTraversal.ts` is the shared primitive; it is
  policy-free so flow and impact can reuse mechanics without sharing semantics.
- **`edge_site` now means recorded provenance, and only that** (M131): the
  parser writes every call occurrence to `edge_call_sites` at index time. A
  located-by-scanning occurrence is `caller_span_scan`, never `edge_site`, and
  carries a limitation saying it may not be the occurrence that produced the
  edge. An index written before M131 has no rows and no table — the lookup
  probes `sqlite_master` and degrades, because a read-only consumer cannot
  migrate one into existence.
- **Impact traversal does NOT have the M130 defect** (M131 audit): it already
  batches adjacency per frontier level. Two bounded follow-ups recorded — a
  per-node `getSymbolById` N+1 inside `discoverImpactSymbols`, and missing
  frontier-batch accounting — neither of which justified a rewrite here. M132
  amplifies the N+1, not the architecture.
- **The response envelope was tuned to one payload's shape** (M131): asserting
  it across items / source size / diagnostics / flow hops / impact records /
  document excerpts found two real gaps — `productContext.items` metadata grows
  with the selection and had no tier, and per-hop `sourceExcerpt.text` is source
  serialized outside the one authoritative representation. Any new response
  field that grows with a list needs its own tier, and the scale test is what
  will say so.
- **Test dimensions, not more examples** (M131): M130's defect was invisible
  because every fixture was below the size threshold that triggered it. Scale
  (2k/20k/100k), storage order, budget pressure and whole-response shape are now
  explicit test inputs. Metamorphic properties — "unrelated growth must not
  change the answer", "a bound that bites must be reported as a bound" — catch
  this class; examples only sample it.

- **A repository's own directory tree is not the same thing as its source**
  (M132): a Git linked worktree nested under a checkout is an ordinary directory,
  so enumeration indexed a complete second copy of the same repository. The
  duplicate then read as architecture — two paths for one logical symbol became
  "a fix that crosses file boundaries". Exclusion is Git-registry-based
  (`git worktree list --porcelain`, once per scan), never a directory-name list:
  worktree directories are named by whoever created them, and ARC's five were
  `feature_docker_ux` plus four under `.claude/worktrees/`. Submodules and
  unregistered nested repositories are absent from that registry and are
  therefore untouched by construction, not by a special case.
- **Removing duplicate checkouts INCREASES the edge count** (M132): ARC went
  18,862 → 19,404 edges while losing 43% of its files. Two copies of a package
  make module resolution ambiguous and ambiguous targets are dropped, so the
  duplicates were suppressing real edges. Any ARC graph figure recorded before
  M132 (including M131's 18,862) was measured on a contaminated index.
- **MCP does not transmit caller working directory** (M132 audit): `initialize`
  carries protocol version, capabilities and clientInfo; vtrace neither declares
  nor consumes the client `roots` capability, and `roots` would describe client
  workspace roots rather than a subagent's cwd. `process.cwd()` is the SERVER's
  launch directory and is deliberately excluded from routing. Explicit
  `repo_root` is the product contract; `McpServerContext.clientContextRoot` is
  the seam for a runtime that can supply one and is null today. Do not build a
  feature that assumes caller cwd without re-checking this.
- **Worktree identity existed since M114 but the product path did not use it**
  (M132): `inspectWorktreeIndexFreshness` was wired only into `get_code_context`;
  `get_context_capsule`, `run_pipeline`, `get_impact_graph`, `search_logic_flow`
  and `get_skeleton` had no `repo_root` parameter at all, so they could only ever
  answer from the server-bound checkout. Shipping an identity primitive is not
  the same as routing on it — check the call sites, not the module.
- **The fail-closed wrong-index check must be cheap enough to always run**
  (M132): `detectIndexWorktreeMismatch` compares the manifest's recorded worktree
  root against the routed root — an O(1) string comparison, no `git` subprocess —
  so it runs on every product call. It is deliberately SILENT when the manifest
  records no worktree root: an index written before worktree identity existed
  makes no claim to contradict, and treating "no claim" as "wrong worktree" would
  fail closed on indexes that are merely old.
- **A repository's own name is context, not a symbol pointer** (M132): `ARC`
  reached the acronym branch of literal anchoring, whose path-segment match hits
  every file under `arc/`, so a pure geometry question anchored on the project
  entry-point class. Suppression is scoped to the repository basename, applied
  BEFORE anchor resolution, and yields to explicit symbol evidence (`class ARC`,
  `ARC.`, `ARC(`, `path::ARC`, backticked, `ARC class/symbol/constructor`). Do
  not generalise this into a token blacklist: another repository may legitimately
  contain an important symbol of that name, and the same-token-elsewhere fixture
  exists to keep that honest.
- **A hidden MCP tool is indistinguishable from a missing one** (M132):
  `search_symbols` is registered but lives in `hiddenTools`, and
  `listMetadata()` — which backs `tools/list` — is built from the visible list
  only. Generated guidance had recommended it for a long time, so agents were
  told to call something no client could see. The decision was to keep it hidden
  and fix the generator; `src/runtime/toolGuidanceConsistency.test.ts` now
  requires every tool named in guidance to be VISIBLE, not merely registered.
- **Enumeration changes clean themselves up through the existing refresh path**
  (M132): `src/fs/scanRepo.ts` and `src/fs/worktreeExclusions.ts` are hashed into
  the index `config_hash`, so an enumeration-rule change makes every existing
  index report `configuration_changed` — already in the auto-refresh allow-list —
  and the excluded files then appear as ordinary deletions. No new freshness
  reason, no schema bump, no bespoke cleanup code. Once exclusion is in force,
  adding or removing a nested worktree does not change the parent's source
  fingerprint at all, so there is no residual topology event to report.
- **The retrieval baselines were stale for eight milestones** (M132): the
  committed CSVs were generated at `199769f` (M103) and 108 `src/` files changed
  across M104–M131 without a refresh, so the cheap byte-diff proof had been
  meaningless — the exact failure M99 recorded, recurring. M132 proved its own
  no-change with the stash A/B protocol (byte-identical) and refreshed the
  baselines with an explicit `attribution_note` assigning the accumulated deltas
  to M104–M131. Run the freshness check in the meta file BEFORE trusting a
  committed-baseline diff, every time.

| M139 | (this commit) | MIXED | Impact consumer truthfulness (caller coverage + bounded potential-caller discovery, direction-separated consumer counts, domain-labelled richSummary, reclassified omission accounting) + behavioural-vs-preference contrast semantics | ARCSpecies.copy: exact callers 0 (was unreported), 83 potential discovered / 10 delivered, coverage `incomplete` with 5 reason codes; `canonicalEdgesOmitted` 686 resolved to 686 nodes + 0 edge slots (`node_budget`); ARC serialization query reclassified `preference_exclusion`→`alternative_branches`, adjacency/list penalty removed (was -0.14 live); M135 dihedral `-0.28` preserved | implement bounded upstream graph expansion so serialization orchestration (`from_dict`→`mol_from_xyz`) becomes visible; then M140 index readiness |
| M140 | c793468 | **INCOMPLETE** (WS-A PASS, WS-B not implemented) | WS-A: stabilize module-level import attribution. Root cause = an ownership model with NO stable owner: `getUnambiguousImportSourceSymbol` attributed a file's ENTIRE import edge set to its single top-level symbol and returned nothing when the file had zero or more than one (`pythonParser.ts:2416`, duplicated verbatim at `cythonParser.ts:1181`), so adding one unrelated function deleted a semantically unchanged edge — and the same rule governed the TARGET side, so `import model` resolved only when `model.py` had exactly one definition. Fix = a per-file structural module symbol (`SymbolKind.Module`, `<module>`, `src/parsers/moduleSymbol.ts`) whose span is pinned to byte 0 (because `computeSymbolId` hashes the span, a body-sized span would re-break the owner id and every edge id hanging off it on any length change) and whose name cannot collide with a real definition. Structural symbols are graph-visible / delivery-invisible (`isStructuralSymbolKind`, `EXCLUDE_STRUCTURAL_SYMBOLS_SQL`). NO schema change: `symbols.kind` has no CHECK constraint, so the `index_status` contradiction is untouched and M141 still owns readiness. | Only **49/257 (19.1%)** of ARC Python files could own an import edge before this; ARC `imports` **283 → 2,281 (8.1×)** while `calls`/`contains`/`references` stayed byte-identical (10,759/5,960/2,618) = the §25 evidence that no other edge kind was retargeted. 125 new product-level tests (`importAttributionStability.test.ts`): 6 import forms × 9 unrelated additions × 2 positions, ordering, alias/relative/re-export, shadow+rebind controls, semantic-change controls, full-vs-incremental and no-op equivalence, determinism; run unchanged against M139 `340fd9c` it gives **28 pass / 97 fail**, so it discriminates. Impact gained two improvements: fan-in delivery **32 → 40 of 40** callers (each caller used to burn two of the 64 edge slots on a redundant import+call pair naming the same src/dst) and impact queries for an 80-caller symbol **88 → 9** (batched the direct-relations prefetch — the guarding test is named for a property it did not previously hold). 3,945 pass / 0 fail; both typechecks clean. | **WS-B not implemented and the mandatory paired benchmark (§61) NOT run** — the 32G tmpfs hit its quota copying Django checkouts; it is runnable on the root fs (675G free). Do the paired benchmark FIRST: it is the only thing that can say whether the 8× import expansion helps / is neutral / regresses, and whether `rerankGraph`'s import-neighbour weight (6, cap 12) is still calibrated now that the importer-side signal lands on excluded module symbols (OPEN FINDING, deliberately not tuned). Then implement upstream rescue: the ARC chain `from_dict –calls→ mol_from_xyz –calls→ perceive_molecule_from_xyz` IS present (§114 does not apply), with calls fan-in 62/3/1 sizing the seed rule and per-seed cap. |
| M140 (continuation) | 6a6e922 | **INCOMPLETE** (WS-A PASS after correction; mandatory paired benchmark RUN and attributed; WS-B still not implemented) | Ran the §61 gate that M140-A could not: provenance-safe M139 `340fd9c` → M140-A paired comparison over Django expanded (20) + cross_repo_30 (30), each side loading its declared implementation against its own independently prepared index, on a root-filesystem workspace instead of the 32G tmpfs that killed the first attempt. Attribution then exposed four defects in the INHERITED WS-A commit and each was corrected on evidence with a discriminating test: (A2 `828af6e`) `queryBroadCandidates` rebuilt its SELECT by hand and omitted `EXCLUDE_STRUCTURAL_SYMBOLS_SQL`, so long natural-language tasks — the only ones that route there — admitted `<module>` as a lexical candidate; (A3 `f351716`) `computeInDegreeCentrality` is edge-source blind, so truthful import fan-in inflated a count rendered to the model as "N indexed symbol(s) depend on this" and used to order pivots; (A4 `c995d17`) graph expansion materialised module scopes as deliverable candidates; (A5 `9afecd7` / A6 `6a6e922`) hybrid path admission and the co-edit generated-artifact lane each took a module scope as a file's representative, because its span is pinned to byte 0 so it sorts first. | **Frozen 50, M139 replay → A1 → A6: Top-1 39 → 37 → 39; Top-3 45 → 44 → 44; gold-anywhere 47 flat; missing-gold 3 flat; changed cases 34 → 24, 0 unexplained.** `imports_neighborhood` is structurally DEAD (12 candidates/score 78 at M139 → absent), because every import edge's source is now a `module` that can never be a lexical candidate — the OPPOSITE of the anticipated §21 domination, so `importsNeighbor 6`/`importsNeighborMax 12` were NOT retuned. Target-side fan-in reaches ranking only via `in_degree`, +11.5% edges but +2.4% score because `inDegreeMax 6` saturates after 3 edges. The real popularity bias was the dependents count: 20/23 pivot symbols gained dependents and 0 lost any (max +29) before A3; after it, 0 gained / 5 lost. Module-node delivery went 7 role entries across 6 of the frozen 50 at the inherited A1 → **0 at A6**. WS-A suite 125 → 130 tests, still 28 pass/97 fail against M139. 4,075 pass / 0 fail; both typechecks clean. M136 PASS, M137 PASS (`get_dihedral` lead); M138 FAIL is PRE-EXISTING — it reproduces identically on `340fd9c`. | **WS-B remains unimplemented, so M140 stays INCOMPLETE.** Do WS-B next against the CORRECTED A6 graph, then the A6→final and M139→final comparisons. Confirm the ARC `from_dict → mol_from_xyz → perceive_molecule_from_xyz` chain and its 62/3/1 call fan-ins against a FRESH ARC index before sizing the seed rule (the committed ARC index has been stale twice). Not run: ARCSpecies.copy impact (§66–§69), TCKDB acceptance (§76–§77), standalone M132, per-stage performance (§61). |

## M140 continuation standing findings

- **An invariant enforced by copy-pasted SQL will be broken by the next query
  site** (M140): `EXCLUDE_STRUCTURAL_SYMBOLS_SQL` was correct at three symbol-query
  sites and absent from the fourth, which had been rewritten by hand for
  performance. The same rule was then broken independently by graph expansion,
  hybrid path admission, and the co-edit representative picker — four producers,
  one rule. The suite now carries a capsule-level backstop asserting no delivered
  capsule content names a module scope, because per-producer assertions cannot be
  trusted to stay complete.
- **A unit suite of short queries cannot test a long-query code path** (M140): the
  125-test WS-A suite asserted module invisibility with single tokens
  (`"module"`, `"Thing"`), and every one of them missed the broad-query path that
  real SWE-bench tasks take. The aggregate benchmark found it immediately. This is
  the concrete argument for §61 being a gate rather than a formality.
- **`<module>` sorts first in any file's symbol list** (M140): its span is pinned
  to byte 0 for identity stability (§4), so every `listSymbolsForFile(...)[0]`
  "representative symbol for this file" idiom silently changed meaning. Two lanes
  used that idiom.
- **Correcting a graph can make a metric quieter, not louder** (M140): the
  anticipated risk was that truthful import fan-in would let `rerankGraph`'s
  import weight dominate. What happened instead is that the signal stopped firing
  altogether — the corrected edges all originate at a node that is excluded from
  candidacy by design. Dead configuration, not domination. Measure before tuning.
- **"Dependents" silently became a popularity metric** (M140): `in_degree`
  centrality is edge-source blind, so an import-only, file-level dependency began
  counting toward a number presented as dependent SYMBOLS and used to order
  pivots. It inflated monotonically (20/23 up, 0 down). This is the same class of
  mixed-domain accounting M139 corrected in impact; the fix keeps every import
  edge in the graph and filters only this metric.
- **One benchmark regression was truthful and was kept** (M140): sympy-12419's
  gold `matexpr.py::ZeroMatrix` lost exactly one dependent, 25 → 24, and fell from
  pivot to support. That dependent was `matpow.py::MatPow` falsely owning its
  file's import because it was the file's only top-level symbol. The historical
  top-3 benefited from invalid attribution; it was reported, not restored (§22).
- **The M138 memory smoke fails on M139 too** (M140): `ARC current=4/4;
  suppressed=0` reproduces on the declared predecessor `340fd9c`, so it is
  environment/state drift in real historical memory, not an M140 regression.
  Attribute a failing preservation smoke by running it on the predecessor before
  claiming it.
- **Stage 5 preservation smokes write into the tracked `results/` tree regardless
  of `--out`** (M140): running M131/M136/M137/M138 acceptance overwrote 31
  committed evidence files from those milestones. Check `git status` after running
  them and restore, or a preservation run will quietly rewrite history.

| M140-B | 7093e2d | **MIXED** (WS-B implemented + benchmarked; ARC entry-point acceptance not met) | Workstream B: a bounded upstream orchestration rescue lane (`src/retrieval/upstreamRescue.ts`). Retrieval finds symbols that LOOK like the query; for a "how does X happen?" question the implementation shares the question's vocabulary but the function that DECIDES to call it shares none, so it was never a candidate. New generator: from <=3 strong, query-matching, non-test, function/method seeds (rank <=5, score >=0.75x top), walk INCOMING **exact `calls` edges only** to depth <=2, admitting <=3 callers per node and <=8 per request. Admission is gated on the caller independently matching the ORIGINAL query on its indexed definition (>=2 distinct query terms as an absolute floor, >=0.25 of the best BM25 among that node's callers as a relative one) — calling the seed makes a symbol reachable, never relevant. **Zero source reads**; one batched capped edge query + one batched hydration per level. Activation is decided ONCE from the already-derived intent (a parsed conditional-alternative clause, or a process frame `how does/is`, `what happens/triggers/orchestrates`), suppressed for capability lookups and start-anchored imperative symbol lookups; `who calls X` is deliberately excluded because caller ENUMERATION is impact's job. Rescued symbols are ordinary candidates — same scoring, selection, budget, rendering, no side channel — carrying truthful attribution ("rescued upstream caller (incoming call depth 2) of …; independently matches …") plus the call path. New bounded score component `upstreamRescueScore`, cap 0.95, calibrated against the family it joins (`positiveObjectiveScore` 0.36, `contrastPenalty` 0.75, `directAnswerScore` 0.95), added alongside the other attributable adjustments rather than inside `combineFinalScore`. New DB helpers: `listIncomingEdgesOfTypeForSymbols` (per-target `ROW_NUMBER()` cap applied INSIDE SQLite) and `countIncomingEdgesOfTypeForSymbols` (true fan-in without materialising it). | **Fresh ARC index (`arcbench` d5ef3dc, 324 files / 8,986 symbols / 21,618 edges, imports 2,281) reproduced the remembered 62/3/1 call fan-ins exactly.** A6 failure reproduced: BOTH upstream hops **absent from the candidate pool**, not merely under-ranked. After: `ARCSpecies.mol_from_xyz` **absent -> rank 6 -> DELIVERED**, displacing an unrelated conformer helper; `ARCSpecies.from_dict` rescued and scored (0.975) but rank 93/132 and **not delivered**. The 62-caller seed contributed **3** candidates; of 8 rescued, exactly **1** reached delivered context. **A6 -> final paired benchmark: provenanceValid, 0/50 changed cases, per-suite semantic hashes byte-identical** (Frozen 50 Top-1 39, Top-3 44, gold-anywhere 47, missing 3, mean tokens 1806.44 — all unchanged) because the frozen suites are bug-report tasks the gate never fires on; measured activation 3/8 (37.5%) on a mixed ARC set, 0/5 on capability/explicit/bug-report shapes. Cost 4.4 ms / 6 DB queries / <1% of retrieval; non-activating requests do zero incoming-edge work. 1000-caller fixture: 1,002 -> 3 admitted, DB queries constant vs the 50-caller variant. TCKDB `main` b91f69e 0/4 changed. Module-node backstop 0 leaks; centrality correction intact; M136/M137/M139/M131 preserved. 4,101 pass / 0 fail; both typechecks clean. | **M140 overall MIXED per §99**: §37 met (intermediate orchestration delivered — the direct proof the lane traversed the path), §36 not (entry point recovered as a candidate but not delivered). Do NOT close the gap by raising the rescue weight: a rescued candidate has ~no base score by construction, so reaching delivery from depth 2 would need ~1.0, i.e. two-hop callers routinely outranking exact direct answers — the §70 defect pattern. Next: **M141 — index readiness and indexing-path hygiene** (`index_status` source-fresh vs runtime-ready disagreement, shared readiness evaluator, `index_repo` response bloat, `memoryRulesMs` profiling, and the preservation-smoke result-path hazard). |

| M140-C | 4172a26 + c267816 | **PASS** (M140 overall now PASS) | Workstream C: path-coherent orchestration DELIVERY (`src/capsuleV2/pathCompletion.ts`). M140-B closed discovery and left one acceptance open — the entry point was rescued and scored (0.9749) but ranked 93/132 and never delivered — and correctly refused to close it by raising the rescue weight. C changes NO score. It separates ranking ("how directly does this match?") from selection ("which bounded set answers this coherently?"): retrieval now surfaces every rescued symbol with its TRUTHFUL ordinary rank alongside the output cap (`orchestrationPaths` on `HybridRetrievalResult`), and a pure deterministic selector may convert ONE support slot for the single candidate that completes an exact short call path whose EVERY other node is already selected. Coherence alone is not the rule: it is satisfied by every caller of every delivered function, so eligibility also requires one of two SHAPES — chain head (reaches the seed THROUGH a delivered intermediate) or branch controller (a parsed conditional-alternative request, and the candidate calls >=2 of the DELIVERED alternatives). Floors: relevance >=0.30, >=2 matched query terms, depth <=2, exact `calls` only, non-structural, >=2 support slots. Ordering: chain length completed, then matched query terms, then ordinary score, then name (never Map/SQLite order). Placement CONVERTS a slot rather than growing the capsule — never a pivot, never the lead, displacing only the weakest winner that is not an author-pointed anchor, a body-literal diagnostic, or a node of the path being completed — and the item carries `selection_role`/`selection_reason`/`ordinary_rank` so both readings stay separable. Zero new DB queries, zero new traversals, zero new source reads: it reads what the M140-B lane already produced. | **`ARCSpecies.from_dict` DELIVERED** as `orchestration_support` at an UNCHANGED ordinary rank 93/132 and score 0.9749; selected set changes by exactly one in / one out (an unrelated zmat coordinate helper leaves), lead unchanged, 6 items, 829/6000 tokens. ARC acceptance **28/28**. Generic fixtures: one-chain `deserialize` selected as `orchestration_entry`; conditional-branch `load_state` as `branch_controller`; the same chain with its intermediate undelivered selects nothing. Negative controls **0 selected** across explicit lookup x2, capability lookup, caller enumeration, two broad process questions, bug report, and 1,000 callers of one helper. Selection rate 1/11 mixed ARC requests; max 1 per request; 0.07 ms worst case. Budget ladder 500/1k/3k/6k/12k monotonic, never empty, always within envelope; micro tiers refuse the role (1 support slot). **B->C paired benchmark: provenanceValid, 0/50 changed, per-suite semantic hashes byte-identical** (Top-1 39, Top-3 44, gold-anywhere 47, missing 3, mean tokens 1806.44 — all flat) because `evaluateOrchestrationIntent` is active on **0 of the 50** frozen tasks, measured directly on the fixture text. TCKDB `main` 1896a85 (advanced from b91f69e) 0/4 changed. Module-node backstop 0 leaks; centrality correction intact; M131/M136/M137/M139 preserved; M132 20/21 (the one failing row asserts an improvement that cannot be re-satisfied against a successor baseline); M138 FAIL is PRE-EXISTING — byte-identical verdict artifact at 7093e2d and c267816. 4,120 pass / 0 fail; both typechecks clean; M140-A suite 130/130. | **M140 overall PASS.** Do not generalise depth-1 completion beyond the branch-controller shape without evidence: the only measurement available showed the general rule spending the slot on an ordinary rank-11 caller. Next: **M141 — index readiness and indexing-path hygiene** (`index_status` source-fresh vs runtime-ready disagreement, shared readiness evaluator, `index_repo` response bloat, `memoryRulesMs` profiling, and the preservation-smoke result-path hazard, which bit twice more here). |

| M141 | 8d09848 + b5a7a92 + 86c4cb0 | **PASS** | Index readiness and indexing-path hygiene: five lifecycle defects, no M140 semantics touched. **(A)** `index_status` and the product tools ran two unrelated freshness models — a target-repo source snapshot vs VTRACE's own indexer/parser/schema/config fingerprints — so editing `src/indexer` produced `fresh / no rebuild needed` immediately before `index_schema_changed / rebuild_index`. `evaluateIndexReadiness` (`src/indexer/indexReadiness.ts`) is now the one evaluation: it decomposes readiness into sourceFresh / schemaCompatible / capabilityCompatible / repositoryCompatible / worktreeCompatible and evaluates EVERY dimension instead of returning at the first failure — which is exactly what makes `sourceFresh=true, schemaCompatible=false` expressible. `inspectWorktreeIndexFreshness` became a projection of it with its contract byte-preserved, and `index_status`, product-shell status, workspace repo status, `run_pipeline`, `get_code_context`, and `index_repo` all route through it (M132's lesson: prove routing, not a helper). No schema bump; the config hash is modelled as a SOURCE input because it governs which files are in scope. **(B)** `index_repo` returned ~290 outcomes saying `indexed`; it is now summary-first with exact counts, planner change counts, aggregate skip reasons, and a bounded notable-outcome list that never lets failures be displaced. **(C)** `memoryRulesMs` was not memory classification: `getObservationStaleness` took its comparison run from a DEFAULT PARAMETER, re-querying the latest run and re-walking the whole index-run chain per observation, materializing every run's file+symbol run-state tables each time. Fixed with one request-local (never global) run-diff memo, link-keyed lookups per step, and an early exit for observations that cannot survive scoring. **(D)** A shared runner output/workspace contract (`lib/runnerPaths.ts`): untracked by default, tracked evidence only via `--out`/`--evidence`, scratch root off `/tmp`. **(E)** Preservation assertions now declare their KIND, and a `historical_improvement` claim reads its baseline's provenance by git ancestry before choosing a relation (`lib/preservationRelations.ts`). | **The contradiction, both sides:** predecessor `249f61f` `index_status` fresh/isStale=false while `get_code_context` refuses with `index_schema_changed`; candidate reports `possibly_stale`, `schema_incompatible`/`schema_changed`/`full_rebuild`, `sourceFresh=true schemaCompatible=false`. **Readiness matrix 10/10 states correct; cross-tool parity 10 states x 6 surfaces, 0 disagreements.** `index_repo` 290 files: **26,797 -> 3,023 bytes** (~6,700 -> ~756 tokens), 290 -> 0 listed outcomes, counts and index data identical; scale 10/300/3k/30k files = 446/451/456/**461 bytes** (15 bytes across three orders of magnitude). **memoryRulesMs on the real ARC index (35 observations): median 6,787 -> 337 ms, 1,309 -> 184 DB queries, verdicts byte-identical**; run-chain discovery grows <4 queries per observation (was ~37); the residual ~295 ms is the one-time chain diff and is reported, not optimized away. **M140-C acceptance 28/28 on BOTH sides**, artifact diff = timing + `vtraceHead` only; `from_dict` delivered as orchestration_support at rank **93/132** score **0.9749**; ARC fixture 324/8,986/21,618/2,281 + 273 `<module>`. M139 `ARCSpecies.copy` impact **byte-identical**; M138 memory verdicts **byte-identical over 274,717 bytes**; TCKDB `1896a855` **0/4 changed both sides**; **M132 20/21 -> 21/21**. **Frozen 50 paired comparison (Django expanded 20 + cross_repo_30) against `249f61f`: provenanceValid, 0/50 changed, every quality metric identical and equal to M140-C's — Top-1 39, Top-3 44, gold-anywhere 47, gold-symbol 31, missing 3, mean tokens 1806.44.** No file under `src/retrieval`, `src/capsuleV2`, `src/capsule`, `src/graph`, `src/parsers`, `src/impact`, `src/logicFlow` or `src/db` was touched. Runner audit 201 runners: tracked-by-default **25 -> 2**. 4,170 pass / 0 fail; both typechecks clean. | **M141 PASS; next is M142 — Workspace and Repository Identity Foundation.** The readiness object is already per-repository and already routed through workspace repo status, so that is the aggregation point. Two carried limitations, both pre-existing and both reproduced on `249f61f`: the standalone **M138 smoke crashes** identically on the predecessor, and the standalone **M137 smoke FAILs** identically (`3000=false`) because it drives `get_code_context` with `auto_refresh: "never"` against a `/home/calvin/code/ARC` checkout that has drifted from its index, so the product-context layer correctly fails closed. Both are harness preconditions, not product behavior — extend the M141 assertion model to declare fixture preconditions so they read as `skipped: precondition_unmet` rather than FAIL. Two legacy runners (`m48`/`m49`) still default to tracked results because they READ `results/runs/` as input; retrofitting them needs an input/output split. |

| M142 (partial) | 321f9a3 + 69826d3 + 0e4edc7 | **INCOMPLETE** (A PASS, B PASS, C MIXED, D measured-not-implemented, E not started; paired benchmark launched but NOT read) | Behavioural retrieval robustness. **(A)** An ordinary query word could claim to BE a symbol's name. TWO independent producers made that claim, which is why per-word fixes never held: the broad-term lexical lane awards `broadTermLocalNameExact = 28` for any query term equal to a `local_name`, gated only by a stopword list containing `how`/`where` but not `which`; and `directEvidenceAnchoring.resolveFileStemWord` resolved ANY bare lowercase word >=5 chars to a same-named top-level definition with a synthesized final of **1.9**. The second is what actually made `which` rank 1 -- `likelySymbols` and `symbolHypotheses` were both EMPTY, so the identifier lane was never involved. Both now consult one request-local decision, `exactSymbolEligibleTerms`: a term may assert name identity only when the derived grammar already marked it an identifier (backticks, call syntax, symbol-kind noun, path qualification, explicit lookup, comparison operand) or its shape is unambiguously code (ALL CAPS); project references excluded unless explicitly targeted. Assertion strength, not suppression -- an ineligible term keeps prefix/substring/path/docstring/coverage/domain/graph. File-shaped resolutions are untouched (corroborated by a file that exists, so M96 stem recoveries survive), as are callers passing no grammar. **(B)** The hub penalty fires only when a candidate has NO local evidence, a bar almost nothing clears. Centrality is now scaled by the candidate's share of the pool's best local evidence -- deliberately a share, not a threshold, because a cut-off needs an underivable constant and behaves discontinuously. Scoring runs in two phases (the share is pool-relative); `recomputeWithWeakenedLexical` re-derives the gate from the scorecard rather than reusing a stale share. **(C)** New `src/retrieval/conceptOwnerRetrieval.ts`: per-FILE evidence aggregation over indexed metadata, IDF-weighted by concept rarity across files, name/basename weighted above prose; best definitions of the best owners admitted as ordinary candidates. Caps 3 files / 3 definitions each / 6 total, `minObjectives: 3`, **zero source reads** (reported, not asserted). Also fixed a latent M140-era leak: `coeditExpansion.pickInjectedSymbol` chose a file's representative without excluding module scopes, which since M140 own a file's imports and out-sort real definitions on edge count -- `::<module>` was reaching the capsule. | **Reproduction on a fresh ARC index (`2f3fd462`, 9,009 symbols, 22.5 s -- independently confirming the reported 22-31 s).** The FIRST reconstruction of the four behavioural queries reused the implementations' own vocabulary and three of four passed on the PREDECESSOR; they were rewritten to describe behaviour without naming the implementation before any before-state was recorded. Predecessor: nmd.py **not generated**; `common.py::which` **rank 1, delivered pivot**; `get_reactants_and_products` not generated; `get_single_mapped_product_xyz` not generated. **The reported `arc/main.py::ARC` project-name failure did NOT reproduce** -- `projectReferences: ["ARC"]` already suppresses it at M141, so no fix was written. After: `which` **pivot@1 -> not_generated**, both explicit controls (`which()` lookup, `ARC class` lookup) lead unchanged. Centrality: `ARCSpecies` (746 dependents) took the MAXIMUM contribution on all six queries before, including a `which()` lookup where it carried 21% of the pool's best local evidence and was still delivered; after, it is **dropped from the pool on five of six** (three of which had delivered it) while `ARCReaction` on a reaction question (share 0.86) holds rank 2 and `ARCSpecies` on the ARC-class lookup holds rank 2. Only 9/150 pooled candidates had centrality contribution >0.05, so the gate is narrow. **Workstream D is a correction, not a fix:** the 63-70 kB figures are the INTERNAL `CapsuleV2Result` (candidate_scores 25.9 kB + discarded 21.5 kB), which no MCP tool returns; the **product** response is 18 kB at max_tokens 6000 with **76% content and 4.3 kB diagnostics**, flat across budgets -- the SS112 property holds as measured. A ~63 kB product response is reachable at max_tokens 12000, where it is **91% content** and ~11,990 estimated tokens against a 12,000 budget. The '~28 kB for ~3.3k useful tokens' shape did not reproduce (lowest content share measured anywhere: 58%). 4,245 pass / 0 fail; both typechecks clean; 26 new tests across 3 files. | **INCOMPLETE: the paired benchmark was launched but not read, so no frozen-50/Django/cross_repo numbers and no changed-case attribution exist -- and A, B and C are all capable of moving those cases.** Preservation gates (M131/M132/M136/M137/M138/M139/M140/M141, TCKDB) were also not run. Read the comparison FIRST; it gates everything else. **`arc/job/adapters/gaussian.py` cannot be identified as a concept owner from the current index** -- its route-keyword logic lives inside a ~270-line `write_input_file` body; the file declares 8 methods, its indexed metadata covers 2/5 query concepts, and `route`/`emit` are absent from its body literals (checked directly). By aggregate indexed evidence `arc/job/trsh.py` is the better owner, which is not absurd. That case did not need the lane -- Workstream A alone fixed it -- but closing it generally needs a body index, i.e. a schema change that invalidates every existing index. Of the four ARC acceptances: Gaussian PASS (via A), normal-mode PARTIAL (nmd.py selected as an owner and its definitions admitted to the pool, but the entry point is not among them and the file wins no delivery slot), reactant-index and TS-order FAIL -- and per SS90 two of those misses are **'ranked but not selected'** (`order_xyz_by_atom_map` rank 6), i.e. SELECTION work the lane does not do, not retrieval failure. Do not close that by raising the lane's contribution: recovered definitions score ~0.8 against a pool floor of ~1.4, and tuning the constant to clear it is the SS70/M140-B defect pattern -- they are admitted through the CAP instead, scores left truthful. Workstream E has one datum only (22.5 s full ARC index); no profiling, no parse-cache audit, no bootstrap. |
| M142 (continued) | dce0b15 + bb4d4e1 | **INCOMPLETE** (A PASS, B PASS after redesign, C MIXED, D measured-not-implemented, E not started; checkpoint paired benchmark READ + BISECTED + ATTRIBUTED, preservation suite NOT run) | The checkpoint paired benchmark was read and it charged the checkpoint with frozen-50 Top-1 **39 -> 36**. Rather than reason about which of the three commits did it, each was measured SEPARATELY against the same M141 predecessor over the same corpora: **A 39 (neutral), A+B 36, A+B+C 36** -- B owned the entire loss, and C is net-positive on file recall (missingGold 4 -> 2, anywhere 46 -> 48). Two mechanisms, both from B's POOL-RELATIVE share. `django-11740`: the gate correctly demoted `ForeignKey` (188 dependents, symbol=0.00, lexical=0.22) out of the capped pool, and the title-symbol lane read that ABSENCE as 'never retrieved' and injected a synthesized candidate at `TITLE_SYMBOL_FINAL` 2.5, past the gold lead at 1.90 -- the correction inverted into a promotion by an adjacent lane. `flask-5014`: the gold lead `Blueprint` (exact symbol=1.00) carried 75% of the pool's best local evidence, lost a quarter of its centrality, and lost the lead by **0.004**. **The share does not separate the populations** -- ARCSpecies sits at 0.49-0.51 against gold leads at 0.74-0.75 -- but the evidence KIND does: ARCSpecies carries symbol=0, path=0, testToImpl=0, bodyLiteral=0 on every behavioural query and rides lexical 0.59-0.64 plus domain 0-0.33, while both gold leads carry an exact symbol=1.00. So centrality is now capped at the candidate's own IDENTIFYING evidence (local evidence minus issue-domain affinity, the one component every symbol in a topically relevant package earns): `centralitySupport = weights.centrality * min(centrality, identifyingEvidence)`. **No new constant** (`HUB_WEAK_LEXICAL_MAX` is the existing bar), no pool coupling, the two-phase scoring is gone, and the all-or-nothing hub penalty becomes the zero-evidence end of a continuous rule. `evaluatedById` (never-retrieved vs retrieved-and-ranked-out) is kept on the retrieval result for the C1 selection work. | **provenanceValid=true on every run.** Frozen-50 M141 -> A -> A+B -> A+B+C -> revised: Top-1 **39/39/36/36/37**, Top-3 44/44/43/42/42, anywhere 47/47/46/48/**48**, gold-symbol 31/30/30/28/28, missing 3/3/4/2/**2**, mean tokens 1806/1810/1885/1859/1839; changed cases -/19/46/47/38. Per-suite at the revised checkpoint: Django Top-1 17/20, cross_repo 20/30. **Eight cases move a gold-visibility metric across the five stages and NONE is unexplained.** Both regressions B caused are gone (`flask-5014`, `sympy-16766` back to their M141 leads). ARC with the shipped gate: `ARCSpecies` **dropped from the pool on three queries** (two of which had delivered it) and demoted 11 -> 24 (delivered -> not delivered) on the `which()` lookup; both positive controls are now **byte-identical** to M141 (2.193 and 1.857), where the pool-relative version had moved them. Owner-file top-1 across the four ARC behavioural cases moved **1/4 -> 2/4** (reactant-index gained it) -- a B effect landing on a C acceptance, so the acceptance artifacts were regenerated against the shipped implementation. Two title-lane corrections for `django-11740` were implemented and measured and **both cost more than they save** (Top-1 37 -> 35; skipping ranked-out symbols loses sympy-16766 + django-11095 + django-13112 to buy django-11740 + flask-5014; re-admitting the organic scorecard restores their recall but not their lead) -- so neither shipped. 4,198 pass / 0 fail; both typechecks clean; 28 new tests. **Preservation suite RUN**: M136 (ARC 3000=resolved), **M137 (lead=get_dihedral, 3000=true -- the gate that matters most for A: no prose-token and no project-name poisoning)**, M139 (via the M140-C assertion), **M140-C 28/28**, **M140-B TCKDB main@567ba7f 0/4 changed**, M141 readiness 10/10 states, M141 cross-tool parity 0 disagreements, and **M132 with every worktree assertion holding** (nested exclusion 616 -> 325 files, routing matrix 15 cases / 0 missing, refresh isolation). M131 is MIXED at 19/22 vs 21/22 on the predecessor, and all three deltas are accounted for: `response_within_m130_envelope` fails IDENTICALLY on the predecessor (harness precondition); `frozen_50_semantics_unchanged` is a NO-CHANGE gate that a deliberate retrieval change necessarily trips, and its 200 differences are the same movement already bisected and attributed; and `tckdb_same_checkout_preserved` **preserves the lead and satisfies every SS77 evidence category on both sides** (missingCategories=[]) with 5/6 selected files identical -- one support slot swaps `builders/geometry.py` -> `builders/calculation.py`, bisected to the centrality gate (M141 and A deliver geometry.py, the REJECTED pool-relative gate delivered neither). M138 fails with the identical signature on both sides and its detail artifact is byte-identical. | **Two Top-1 regressions remain against M141, both attributed, neither unexplained.** `django-11740` = `centrality_gate_x_title_injection`: carry it forward as a DESIGN NOTE, not a fix attempt -- an anchor lane must not treat pool-cap absence as evidence of absence, but both measured corrections lose more than they win, which says the title lane's SYNTHESIZED SCORE and not its presence is doing the work. That is a ranking question, not an injection question. `django-11815` = `concept_owner_commit_secondary_selection`: gold `EnumSerializer` falls from lead to rank 3 and loses the single pivot slot to a migration file; the bisect places the flip at `0e4edc7`, which carried BOTH the concept-owner lane and the `coeditExpansion` structural-symbol filter, and the lane reports no admissions on this case -- so the coedit representative change is the likelier producer. **Not root-caused to a line; do that first.** Then split C per SS10 into C1 (selection) and C2 (representation), run the preservation gates (M131/M132/M136/M137/M138/M139/M140/M141 + TCKDB, still NOT run), then D and E. The final paired benchmark (SS80) is deliberately NOT run: the candidate tree is not final while D and E are unimplemented. `src/logicFlow/flowScalability.test.ts` is **flaky on a 5 s wall-clock timeout** -- 3 of 4 sampled runs fail on the M141 PREDECESSOR and 1 of 3 on the current tree; pre-existing harness precondition, not M142. |
| M142 (continued II) | 9f08e33 + b443c24 + 3f4365c | **INCOMPLETE** (A PASS, B PASS, C MIXED — django-11815 now root-caused and fixed; D not implemented, E not started; corrected M141 -> checkpoint paired comparison IN FLIGHT) | **The one case the previous checkpoint could not explain is explained, and the recorded hypothesis was wrong in both halves.** `django-11815` was attributed to the coedit structural filter on the grounds that the concept-owner lane 'reports no admissions on this case'. Measured directly: the lane admits **six**, and the coedit filter is **inert** here. Established by four-state feature isolation over ONE held-constant index rather than by inferring from the commit boundary — A+B baseline and A+B+coedit-filter both lead with gold `EnumSerializer`; A+B+lane and full `0e4edc7` both lead with `contrib/auth/migrations/0009_*.py::Migration`. **The chain, end to end.** `behavioralObjectives` takes every prose token, so this task's objectives include `last`/`modified`/`oasl` from the Trac byline and `error`/`traceback` from the M103 evidence LABELS — all rare, so all high-IDF, so all decisive. The lane elects `template/defaultfilters.py`, `core/files/storage.py` and `views/debug.py` as owners of a migrations bug and admits four definitions (finals 0.41–0.49) into a pool already at its cap of 25, **evicting four ranked candidates** — two from `db/migrations`, one of them a delivered pivot. `resolveLocalSubsystem` ties on `pathSegmentOverlap` (both contenders contain 'migrations'), so the COUNT decides: `db/migrations` 8 -> 6, `contrib/auth/migrations` 7 -> 6. **At 6–6 the tiebreak at `debugRoles.ts:695` (`dir < best`) elects the wrong subsystem.** `EnumSerializer` is then out-of-subsystem with symbol=0/path=0/testToImpl=0, and the strong-lexical exemption that would save it is restricted to ACTIONABLE_FUNCTION_KINDS — it is a CLASS. `isGenericInfrastructure` returns true, `debugRoles.ts:279` demotes it to support, the 4-slot support budget discards it. **Its own scorecard never moves (rank 5, final 1.6352 both sides): a selection regression invisible to any score-level comparison.** Fixed in `9f08e33`: `admitConceptOwnersBesideCap`. The cap bounds what ORDINARY RANKING returns, and a lane that exists because ranking cannot see its findings does not compete for ranking's slots — least of all by paying out of the evidence base that later, rank-derived inferences read. Pool stays bounded by the lane's own cap of six. | **Frozen-50 A/B (shipped checkpoint vs corrected, same prepared corpora, exploratory by construction): Top-1 37 -> 38, Top-3 42 -> 44, gold-symbol 28 -> 30, anywhere 48 (flat), missing 2 (flat), mean tokens 1839 -> 1849.** Four changed cases, **zero regressions**: `django-11815` (top1+top3) and `matplotlib-22719` (top3) are BOTH of C's regressions from the checkpoint ledger, recovered by the same mechanism; `django-11095` and `flask-5014` regain a gold symbol. Two generic fixtures guard it in `conceptOwnerRetrieval.test.ts`; the first fails on the old code with the exact eviction message. 4,200 pass / 0 fail; both typechecks clean. **Two alternative fixes measured and NOT shipped**: excluding cap-admitted rescues from the subsystem election (**0 of 50** changed — the four admissions live in `template/` and `core/files/` and never voted for either contender, so the damage was the eviction, not the votes); and gating the lane off when the request carries direct localization evidence (inert — `shapeSweQuery` returns EMPTY failingTests/likelyFiles/likelySymbols for this task). **C2 audit (§30–§31) done, read from the index.** `write_input_file` is 268 lines / 16 KB and its ENTIRE indexed representation is eleven distinct tokens (`local_name` 'file input write', plus fq_name/signature/docstring/path tokens and one literal row). **But `route` occurs exactly twice in the whole file and BOTH are COMMENTS inside that method** — so a body representation built from identifiers, called names and string literals does not recover it either; only indexing developer prose does. `arc/checks/nmd.py` fails DIFFERENTLY: `saddle`, `connect`, `intended` and `vibration` appear **nowhere in the file at all** — a vocabulary gap no body index closes. **C1 before-state (§26/§27) classified**: exactly the §17 split — `get_bonds` (rank 10, final 1.3836) and `order_xyz_by_atom_map` (rank 6, final **1.5973**) are `budget_dropped`; `get_reactants_and_products` and `get_single_mapped_product_xyz` are `not_generated`. | **The corrected M141 -> checkpoint paired comparison is running and is the gate for C1 (§16).** Corpora are being re-prepared at `9f08e33` because provenance binds the VTRACE commit; the existing `-cand` corpora were prepared at `ce473ab` and would fail closed. **The objective contamination is REAL and UNFIXED.** The lane still reads evidence labels and tracker bylines as behavioural concepts and still elects `defaultfilters.py` as the owner of a migrations bug. It no longer COSTS anything measurable, because its output can no longer evict better-evidenced candidates, but it is wasted work and a live precision risk: over the frozen 50 the lane puts **235 candidates into the pool, of which 16 are delivered and 21 sit in a gold file**. Do not mistake the eviction fix for a precision fix — that is C1/C2 work (§23, §29–§39). **C1 must not be framed as a scoring problem**: `order_xyz_by_atom_map` at 1.5973 is ABOVE the ~1.4 floor the lane's own recoveries were measured against, and its SIBLING `order_mol_by_atom_map` (same file) IS delivered as a pivot — the delivered set explains reordering a MOLECULE while the request asks about reordering the XYZ GEOMETRY. That is the §23 objective-coverage case in its clearest form. Caveat for the reactant-index case: its 'where does the bond list come from' objective is arguably ALREADY covered by the delivered `get_reactive_bonds_from_family`, and a coverage test must be able to reach that conclusion or it will justify a slot that case does not clearly need. **§92 bears on this**: indexing comments is a new evidence class with its own extraction, staleness, precision, sizing and M141 capability/schema consequences — a milestone, not a workstream. |
| M142 (continued III) | 01e4630 + 120853c | **INCOMPLETE** (A PASS, B PASS, C objective-hygiene PASS / concept-evidence NOT PASS / selection NOT NEEDED-AS-SPECIFIED, D root-caused not implemented, E not started; **corrected M141 -> checkpoint paired comparison READ, provenanceValid=true, every movement attributed**) | **The §8 gate is closed.** M141 -> corrected checkpoint, corpora re-prepared at the candidate commit: Top-1 **39 -> 38**, Top-3 44 -> 44, anywhere **47 -> 48**, gold-symbol **31 -> 30**, missing **3 -> 2**, mean tokens 1806 -> 1849 (+2.3%). 33 of 50 rows differ in SOME field; **exactly three move a gold-visibility metric and each accounts for exactly one aggregate delta — no residue.** `django-11740` (Top-1 -1) is the known title-lane synthetic-score debt and contributes **1657 of the 2334-token django increase on its own (71%)**. `sphinx-7910` (anywhere +1, missing -1) is the concept-owner lane's first measured gain, recorded as REACHING THE POOL rather than being delivered. **`sphinx-7462` is reduced from a stage attribution to a mechanism, and its prior classification was wrong.** M141 generated `sphinx/pycode/ast.py::unparse` from the **symbol** source at rank 4 (final 1.9) and DELIVERED it as support; the corrected checkpoint never generates it — absent from a pool of 31. The name occurs only inside a traceback frame (`line 112, in unparse`), and A's typed grammar does not read `in <name>` there as identifier context; identifier signals are byte-identical on both sides, so the producer at fault is A's BROAD-LEXICAL lane, not its identifier lane. The prior ledger called this NEUTRAL and said ast.py 'was never retrieved on either side' — both wrong, and this case cannot resolve without an ast.py edit. **Minimal fix identified, deliberately NOT applied (§12 freezes A).** | **Objective role typing shipped (`01e4630`).** Requests are segmented into typed spans and a token is an objective only if it occurs somewhere behaviour-bearing; eligibility is decided by ROLE, IDF only weights survivors. On django-11815 all three elected owners and all six admissions were driven by byline/label tokens; after, the owners are `db/migrations/loader.py`, `template/base.py`, `db/migrations/migration.py`. **Evidence-section labels occur in 23 of the 50 frozen tasks** (errors 18, traceback 11, failing tests 6), so this is corpus-wide, not one case. Frozen-50 A/B: **all five quality metrics identical, zero gold-visibility movements, tokens 1848.6 -> 1840.2**. §25 controls hold on synthetic AND real corpora — `last`/`modified` elect `core/files/storage.py` at 0.78 when the request is actually about them, which is the file the byline wrongly elected in 11815. **Round-robin owner allocation shipped.** 3 owner files x 3 definitions exceeded the 6-candidate cap, so admission drained owners in order and **the third owner slot was dead by construction** — including `arc/checks/nmd.py`, elected owner #3 and contributing zero. Now 2 contributed definitions; every bound unchanged. Guard test fails on the old code with the exact starvation message. **C2 measured, and the body index is dead.** Per objective, per case, against the real index and real source: an identifier/literal body index recovers **0 objectives on all four ARC cases**; comments recover **2**, both Gaussian. reactant_index has 8/9 objectives already indexed and `get_bonds` carries FIVE; ts_order has 7/11 and `order_xyz_by_atom_map` carries four. **Corrects the prior audit twice**: NMD's `reactant`/`product` are already indexed (not invisible), and `get_reactants_and_products` does make contact with its evidence. **Entity ownership implemented, measured, REJECTED (`120853c`).** Naive basename equality nominates **796 files across 24 requests** (one django request nominates 407 via `model`); gated at <=2 files it is precise (71) and keeps `gaussian`/`reaction`. But on the frozen 50 it moved **no metric at all** at **+29 tokens/case**, and it nominates `arc/parser/adapters/gaussian.py` — the module that READS Gaussian output — not the job adapter that writes the route line. **Acronym->path also rejected: 0 true positives, 2 false positives** on the four real queries, because the NMD query never contains 'normal mode displacement' — that phrase is the spec's description, not the user's words. 4204 pass / 0 fail; both typechecks clean. | **D is root-caused, not fixed.** Driving the REAL MCP producer end to end (not the envelope unit tests): the headline **63 kB does not reproduce at default budgets** — 20.1-23.8 kB on both a small and a large repo — confirming the earlier row's finding that those figures were the internal `CapsuleV2Result`. It reaches 46 kB at max_tokens=24000, where the growth is the ANSWER. **The overhead RATIO does reproduce**: 33 kB for 14.3 kB of productContext at 8000 tokens, ~1.3 bytes of non-content per byte of content. (Content share measured here is 34-49%, counting ONLY productContext; the earlier row's '76% content' counts differently and the two are not directly comparable.) **Two real defects.** `detail=debug` returns **20303 bytes where the default returns 20302** — the detail contract is inert, so every ordinary caller pays for internals they never asked for and an explicit debug caller gains nothing. And the same selection ships **three times** — `productContext.items` (6253 B), `productContext.modelVisibleContext` (4828 B), and `capsuleResult.pivots/support` (2630 B, `source` empty) — alongside **three separate diagnostics blocks** (3479 + 1007 + 283 B). `capsuleResult` scales WITH `productContext` (5451 -> 8739 as productContext goes 14312 -> 22575), which is what a duplicate representation looks like. Diagnostics themselves are **already bounded at ~3.48 kB** across every repo size, query breadth and budget, so §54 holds for that field. **`concept_owner_support` NOT implemented, and the reason is measured**: §44's trigger fires (both candidates remain generated-ranked-omitted after the fix), but **§45 requires the candidate to come from the high-confidence owner lane and BOTH are sourced `lexical`** — so the role as specified could not admit either. Selection is demonstrably not rank-ordered: a `concept_owner` candidate at rank 27 (final 0.7387) is delivered as support while lexical `get_bonds` at rank 10 (1.3836) is not. That is a general support-ORDERING question, not a lane role. **Still outstanding: D's fix, all of E, the preservation suite (§67), and the final M141 -> M142 paired benchmark (§73)** — the last needs corpora re-prepared at the final commit, so it must wait until D and E stop changing the tree. §88's Gaussian acceptance is **NOT met** and should not be reported as partial. |

| M142 (continued IV) | e453366 + 317c078 | **MIXED — closed** (A PASS after repair then frozen, B PASS, C MIXED, D PARTIAL, E PASS on the same-HEAD path) | Reopened A only for the proven `sphinx-7462` traceback-frame regression, closed D and E, ran preservation and the final paired benchmark, and closed the milestone truthfully. **(A)** A's rule that an ordinary word may not claim to BE a symbol name was applied to a bug report as though the reporter had chosen every word in it. `unparse` was printed by CPython in a traceback frame — a plain lowercase word with no backticks, call syntax or declaration phrase — so nothing could admit it and `pycode/ast.py::unparse` stopped being generated. Frames are now recognised structurally (`File "…", line N, in <name>` admits any identifier; a bare `line N, in <name>` tail admits only a qualified or snake_case name), and exactly ONE frame is admitted: the one where execution stopped, gated on the traceback being COMPLETE and the name not being a language-protocol dunder. Both gates exist because measurement demanded them — see the standing findings. Isolated slice vs the checkpoint: gold symbol 30→31, every gold FILE metric unchanged, 2 cases moved, 0 new regressions; `sphinx/pycode/ast.py` delivered at rank 2 for 257 FEWER tokens. **(D)** `detail=debug` returned 20,303 bytes where the default returned 20,302 — the standard/debug boundary was drawn at ARRAY SIZE (collapse past 12 entries, restore a sample of 12) so nothing ever crossed it. The selection was serialized FIVE times, not three, and 6/6 `roleReason` strings are character-identical to `productContext.items[].selectionReasons`. Two copies became references, restored at debug: debug now differs by 969 bytes at 8k instead of 3. Selection, `modelVisibleContext` and `digest` are byte-identical at every level. Default is only 1.1–2.9% smaller — PARTIAL, because moving whole diagnostics sections behind debug fails declared-schema conformance. **(E)** Parsing is 89–90% of every indexing run. A same-HEAD sibling worktree indexes in 6.7s vs 40.6s AND is byte-identical to a clean full index (325 files / 9,012 symbols / 21,693 edges); cache removal changes time and nothing else. A one-file delta gets NO benefit — `fullParseCacheContextCompatible` requires `scannedFiles.every(...)` to match, so 324 unchanged files are re-parsed. Root-caused, deliberately not fixed under §60. Final M141→M142 (provenanceValid=true): Top-1 39→38, Top-3 44→44, anywhere 47→48, symbol 31→31, missing 3→2, tokens +1.6%. 35/50 differ in some field; **exactly 2 move gold visibility (django-11740 REGRESSION, sphinx-7910 IMPROVEMENT) and 0 are unexplained**. `sphinx-7462` is absent from the ledger because it is back to M141 parity. Preservation: 10 gates, 0 failures attributable to M142. Evidence: `stage5_m142_final_report.md`, `stage5_m142_final_paired_comparison.json`, `stage5_m142_final_changed_case_ledger.json`, `stage5_m142_preservation_final.json`, `stage5_m142_traceback_identifier_contract.md`, `stage5_m142_response_bloat_root_cause.md`, `stage5_m142_index_profile.json`. |
| M143-A | 93a34d1 | **MIXED** (title-lane audit complete; fabricated scorecard removed; `django-11740` promotion carried as a measured ceiling; Workstream B not started) | Title-lane semantics. **Two** producers of title ranking authority were found, not one: `TITLE_SYMBOL_FINAL = 2.5` AND an unconditional `evidenceTier = 2`, which the pivot comparator sorts on BEFORE score — so M142's "restore the organic scorecard" experiment could not have worked, and this is why it recovered recall but not the lead. `titleSymbolIds` has six precedence consumers. The injected candidate's scorecard was **fabricated**: `lexical`/`fts`/`tfidf`/`bm25` were all set to 1, the maximum of four MEASURED quantities never measured for a candidate whose premise is that retrieval never produced it; the role gate and decoy classifier read them, and on `django-11740` the capsule told the model "strong lexical match" when there was no lexical measurement at all. Unmeasured components now report 0 (`symbol: 1` retained — exact title name identity is real). `django-11740` measured rather than asserted: `ForeignKey` is NOT "never retrieved", it earns `final 1.343` at rank 14 from the same scorer given room, while the gold `_get_dependencies_for_foreign_key` **already leads organically at 1.760** — the injection is what displaces it, an 1.86x promotion. **Eight** mechanisms measured and rejected (2 from M142 + 6 new): organic score does not discriminate (`11740` 1.343 vs `16766` 1.291), additive-at-symbol-weight costs `13112` by 0.004, the `symbol` channel reproduces the defect at 2.585, "names a competing location" has no signal (every case names some stem), hub in-degree separates only via a threshold fitted between 9 and 188, and the behaviour-ownership promotion gate is CIRCULAR as measured (title term is itself an objective → never fires, misses 11740) and fires BACKWARDS once de-circularised (suppresses 9, **8 of them destroying a correct lead**). Lane fires on 17/50 (21 matches: 16 incumbents, 5 injections); injected promotions are **4 correct : 1 wrong**, so class-wide demotion is net-negative — which is what M142's Attempt 1 measured. | paired `41fb0a9 -> 93a34d1`, provenanceValid=true: Top-1 **38 -> 38**, Top-3 44 -> 44, gold anywhere 48 -> 48, gold symbol anywhere 31 -> 31, missing 2 -> 2; `selectedFiles`/`lead`/`roles`/`contentModes` diffs all **0**; 5 changed cases = exactly the 5 injected-title cases, single cause = the fabricated "strong lexical match" justification withdrawn; mean tokens 1835.72 -> 1835.20; 4223 tests / 0 fail | M143-B: behavioural concept evidence — A's remaining defect is BLOCKED on it, since separating a titled bystander from a titled edit site needs ownership evidence the current signal cannot yet carry |
| M143-B | (evidence only; predecessor `93a34d1` unchanged) | **NOT PASS — measured deterministic capability ceiling** (no functional change; `django-11740` carried, not relabelled) | Behavioural ownership evidence. The question was what deterministic repository relationship shows a candidate OWNS the requested behaviour, independent of its name appearing in the title. **§15's hypothesis is refuted by measurement**: there is **no edge of any type, in either direction, between `db/migrations/autodetector.py` and `db/models/fields/related.py`** (all 45x138 symbol pairs checked); `ForeignKey` has **inDegree 193** and its top referrers are TESTS, not the autodetector. The cause is semantic and general — the autodetector operates on field INSTANCES from model state, so it never names a field class; the more general an implementation is, the less likely it names the entity a task is about, and generality is what makes it the owner. **Three discriminators measured and rejected**: (1) relation-to-the-lead groups `11740` with `13112`+`16766` (all `0/0`) against `11133`+`12276` (rich) — i.e. it groups the case to fix with the two that must not be touched; (2) title-family retrieval support looked categorical at pool 400 but the zero is a POOL-FLOOR ARTIFACT (`11740` floor **0.660** > `16766`'s support **0.638**), and at depth 1500 it is a continuum **0.504 / 0.638 / 0.694** separable only by a constant fitted between `11740` and `16766` (§35 forbids); (3) interface-override ownership is REAL and generic — it separates `GaussianAdapter` (`write_input_file` from `JobAdapter`) from `GaussianParser` (`parse_*` from `ESSAdapter`) and switches by requested action on generic fixtures — but it activates on **0 of the 7 real candidates measured** (5 title candidates + the 2 ARC Gaussian classes) because request vocabulary ("emit route keywords") never meets implementation vocabulary (`write_input_file`); bridging it needs a synonym lexicon (§55 weak heuristic, §41 second verb extractor). Also established: `edges.edge_type` admits only `contains/imports/calls/references`, and the Python parser's `inheritance`/`decorator`/`annotation` reference KINDS are discarded at persistence — inheritance survives only as an undifferentiated `references` edge, from which an override surface is still reconstructible. "Task names a competing location" is now permanently rejected with a counterexample: `11740` names `autodetector` (IS gold) and `16766` names `lambdify` (NOT gold) — identical shape, opposite answers. | paired `93a34d1 -> M143-B` is an **IDENTITY, proven not asserted**: `git diff --name-only 93a34d1 -- src/` yields **0** non-test sources, so Frozen-50 metrics stand as A measured them (Top-1 38, Top-3 44, anywhere 48, symbol 31, missing 2, tokens 1835.20, all diffs 0). **0 changed cases, 0 improvements, 0 regressions, 0 unexplained.** Probe cost: 4 graph queries + ~300 relations per case, **0 source reads**; override probe 3 queries/candidate + 1/base. 4227 tests / 0 fail; both typechecks clean | Carry `django-11740` as a root-caused ceiling. Do NOT re-attack it statically — every rejected mechanism failed for the same reason, that static structure has no subject->owner fact to read. The separating evidence is BEHAVIOURAL (which file the failing test exercises), which is a different input class than the index holds and a milestone of its own, not a title-lane patch |
| M143 (closed) | `93a34d1` (only functional commit) | **MIXED — closed** (A MIXED: truthfulness PASS, ranking NOT PASS; B NOT PASS = measured static capability ceiling) | Final closure. The milestone's central result is scientific, not a feature: **M143 did not fail to find the static subject→owner relation; it established that the relation does not exist.** Across all **45x138** symbol pairs between `db/migrations/autodetector.py` and `db/models/fields/related.py` the index holds **0 relations of any type in either direction**, while `ForeignKey` carries **inDegree 193** whose top referrers are TESTS — because the autodetector operates on field *instances* from model state and never names a concrete field class. Generality is anti-correlated with nameability, so "the owner references the subject" is weakest exactly where ownership matters. **Shipped (A):** the injected title candidate no longer fabricates `lexical/fts/tfidf/bm25 = 1` — four MEASURED quantities never measured for a candidate whose premise is that retrieval never produced it, read downstream by the role gate, decoy classifier and pivot explanation, and surfaced to the model on `django-11740` as "strong lexical match" with no lexical measurement behind it. `symbol: 1` retained (name identity is real). **Unresolved:** `django-11740` — but note the ownership precisely, it is `top1=false` on BOTH sides of the final comparison, i.e. an **M142** regression that M143 root-caused and did not fix. Root cause = TWO authority producers (`TITLE_SYMBOL_FINAL = 2.5` AND an unconditional `evidenceTier = 2` that the pivot comparator sorts on BEFORE score), which is why M142's scorecard-restore recovered recall but not the lead. Unfixable by demotion: promotions are **4 correct : 1 wrong**. **Gaussian hard acceptance NOT MET** — the interface/override signal cleanly separates `GaussianAdapter` (`write_input_file` ← `JobAdapter`) from `GaussianParser` (`parse_*` ← `ESSAdapter`), but the real query's objectives (`arc, decide, gaussian, route, keyword, emit`) overlap **0** with both surfaces, so it abstains; the adapter's correct live lead is LEXICAL via Workstream A, not structural, and must not be counted as the ownership acceptance. No synonym lexicon added. Standing architectural finding: `edges.edge_type` admits only `contains/imports/calls/references` and the parser's `inheritance`/`decorator`/`annotation` kinds are discarded at persistence — a real representational loss that would NOT fix `django-11740`, so not a reason to open a schema milestone. §54 gap closed: the repo-relative vs workspace-relative gold-path comparison that once misscored **three correct leads as wrong** (inverting the demotion conclusion) now has a permanent 5-case guard. | FINAL paired `41fb0a9 -> 93a34d1` **re-executed for closure**, provenanceValid=true, both suites `sameFixtureHash`/`sameTargetCorpusHash`/`isolatedIndexes`/`authoritative`: Top-1 **38 -> 38**, Top-3 44 -> 44, anywhere 48 -> 48, symbol 31 -> 31, missing 2 -> 2, tokens 1835.72 -> **1835.20**, pivots/support flat. **0 gold-visibility movements.** 5 changed cases = exactly the 5 title-injection cases, each changing ONLY `modelVisibleContext` + `tokenAccounting`, with lead and selectedFiles **identical** on both sides — explanation-only, all explained, **0 unexplained**. Preservation: **0 new regressions**; M136/M138 reproduce byte-identically on the predecessor (blameless), M132 MIXED 19/21 is a stale pre-M142 baseline assertion, ARC behavioural **7 cases / 0 semantic differences** field-by-field, `django-11815`/`sphinx-7462`/`sphinx-7910`/TCKDB/M137 `get_dihedral` all unchanged. Closure HEAD is semantically identical to `93a34d1` (0 non-test src diffs, verified). 4232 pass / 49 skip / 0 fail; both typechecks clean; `git diff --check` clean | **M144 — Failure-Evidence Attribution and Behavioural Localization.** The missing signal is NOT more static evidence (title weighting, centrality, body text, graph traversal) but observed failure/localization evidence: failing test name+path, traceback frames, exception location, reproduction command, task-provided file references. Start from evidence ALREADY SUPPLIED to the agent — not vtrace running tests. Use `django-11740` as an acceptance case for the new evidence class, NOT another title-tuning target. This is a HYPOTHESIS: M143 proves static evidence cannot separate the case, not that failure evidence can. Then M145 workspace/repository identity, then M146+ cross-repo |

## M143 closure standing findings

- **"We could not find the relation" and "the relation does not exist" are
  different results, and only measurement separates them** (M143): the whole
  milestone turns on this. Eleven mechanisms were rejected before anyone checked
  whether the target relation was there at all; exhausting all 45x138 symbol
  pairs between the two files settled in one measurement what a year of
  heuristics could not. Check for the fact before building the mechanism that
  reads it.
- **A verdict of NOT PASS on capability is not a verdict on safety** (M143): B's
  generic controls show vtrace ABSTAINS when ownership evidence is absent or
  ambiguous rather than fabricating certainty, which is the designed behaviour.
  Report the capability gap without implying the fallback is unsafe — and score
  gating mechanisms by wrong-SUPPRESS count, since a wrong abstain leaves a known
  defect while a wrong suppress destroys a lead that was already right.
- **Attribute a regression to the milestone that introduced it, not the one that
  measured it** (M143): `django-11740` is `top1=false` on BOTH sides of the final
  M142→M143 comparison. It is an M142 regression that M143 root-caused. Recording
  it as "M143's unresolved defect" without that distinction would misstate both
  milestones.
- **An evidence-only milestone still needs the full closure protocol** (M143):
  the final paired benchmark was re-executed rather than copied from the A
  checkpoint even though the functional candidate was unchanged, and it
  reproduced exactly. The cost was minutes; the alternative was a report whose
  numbers nobody had run.
- **A harness bug that inverts a conclusion deserves a permanent test, not just a
  fix** (M143): the repo-relative vs workspace-relative path comparison silently
  scored three correct leads as wrong and made a net-negative change look
  net-positive. It was corrected in M143-A and still had no guard at closure.
  Evaluation code is not exempt from regression testing merely because it lives
  under `benchmarks/`.

## M143-B standing findings

- **The evidence a mechanism needs can be absent from the SOURCE, not from the
  index** (M143-B): `django-11740`'s behaviour owner and its task subject have
  zero edges between them in either direction, and `ForeignKey`'s 193 in-edges
  contain none from `autodetector.py`. No schema change closes this: the
  autodetector is written against field *instances*, so the fact does not exist
  to be indexed. Before proposing a relation-based mechanism, check that the
  relation exists in the code — not that the index can carry it.
- **Generality is anti-correlated with nameability** (M143-B): the code most
  likely to own a behaviour is the code written generically enough to handle
  every case, and that is exactly the code that never names the specific entity
  a bug report is about. Any "the owner will reference the subject" heuristic is
  therefore weakest precisely where ownership matters most.
- **A categorical zero must be re-measured at a wider bound before it is
  believed** (M143-B): "the title class has no retrieved member" was true at
  pool 400 for `django-11740` and looked like a clean zero-vs-non-zero
  discriminator. Its pool floor is 0.660 — *higher* than the supporting score in
  two cases that DID show support. At depth the signal is a continuum
  (0.504/0.638/0.694). This is the same trap M143-A recorded for "never
  retrieved", hit a second time from the other direction.
- **Inheritance is parsed and then thrown away** (M143-B): `collect_references`
  tags `inheritance`, `decorator` and `annotation`, and `emitReferenceEdges`
  uses the kind only for shadowing before writing an undifferentiated
  `references` edge. Override surfaces are still reconstructible (class-to-class
  `references` ∩ `contains` members), but "X inherits Y" and "X annotates with
  Y" are indistinguishable rows. Locked by
  `src/capsuleV2/behaviorOwnershipEvidence.test.ts`.
- **A mechanism that only fires on the fixtures written to demonstrate it has
  not been validated** (M143-B): interface-override ownership passes every
  generic control — parser-vs-adapter, action switch, title-is-owner,
  caller-vs-helper, ambiguous — and fires on **none** of the 7 real candidates measured,
  because request vocabulary and implementation vocabulary do not meet. Count
  real-corpus activations before shipping, exactly as M140-C's intent-gated lane
  required.
- **An identity checkpoint should be proven, not declared** (M143-B): a
  milestone that ships no functional change can verify the claim directly
  (`git diff --name-only <predecessor> -- src/`, filtered to non-test sources)
  instead of running a paired benchmark whose zero result is guaranteed by
  construction and therefore evidence of nothing.

## M143-A standing findings

- **One conceptual signal, two independent producers — again** (M143-A): title
  ranking authority is produced by `TITLE_SYMBOL_FINAL = 2.5` AND by an
  unconditional `evidenceTier = 2`, and the pivot comparator sorts on the tier
  BEFORE it compares scores. A tier-2 candidate therefore outranks a tier-1
  candidate at ANY score, which is why M142's "restore the organic scorecard"
  experiment recovered recall but not the lead. `titleSymbolIds` additionally
  feeds decoy immunity, graph-neighbour seeding, `namedAnchorIds` (cap and
  dispatcher exemptions) and support-displacement protection — six consumers.
  Changing one constant changes nothing. (Same shape as M142-A's two producers
  of name identity and M140-C's ranking-vs-selection split.)
- **A synthesized candidate must assert only the evidence that produced it**
  (M143-A): the title lane built candidates claiming `lexical`/`fts`/`tfidf`/
  `bm25` = 1 — the maximum of four MEASURED retrieval quantities — for a
  candidate whose whole premise is that retrieval never produced it. The role
  gate and the decoy classifier read those fields, so `django-11740` shipped the
  model the justification "strong lexical match" with no lexical measurement
  behind it. Removing the fabrication moved zero quality metrics, which is the
  point: it was never carrying information, only asserting it.
- **"Never retrieved" was a POOL-membership test, not a retrieval test**
  (M143-A): `ForeignKey` is not unreachable — it earns `final 1.343` at rank 14
  from the same scorer at a wider bound, against a gold competitor that already
  leads organically at 1.760. The lane promoted it 1.86x over what it earns.
  Before calling a symbol unretrievable, widen the pool and look.
- **The title lane's promotions are 4 correct : 1 wrong** (M143-A): measured on
  the frozen 50 (17 active cases, 21 matches, 16 incumbents / 5 injections).
  Any mechanism that demotes injected title candidates as a class is
  net-negative — which is exactly what M142's Attempt 1 measured (37 -> 35).
  Quote this ratio before proposing another blanket demotion.
- **An ownership measure whose objectives include the title term is circular**
  (M143-A): the title term is itself a request token, so it becomes an
  objective and the title symbol's own name covers it. The gate then scores the
  title candidate highest by construction and abstains everywhere — it looks
  safe because it never fires. De-circularised it fires BACKWARDS: 9
  suppressions, **8 of which destroy a correct lead**. Any self-referential
  evidence measure needs the seed excluded before it means anything.
- **Suppress and abstain are not symmetric errors** (M143-A): a wrong abstain
  leaves a known defect in place; a wrong suppress destroys a lead that was
  already right. Score a gating mechanism by its wrong-suppress count, not by
  overall agreement — the circular gate "agrees" 15/17 while being useless.
- **`DEFAULTS.symbolPoolSize = 6` makes seeding an unreliable recovery route**
  (M143-A): seeding `ForeignKey` as a symbol seed did NOT admit the `ForeignKey`
  class, because the seed search is bounded at 6 results and `nameRelated`
  admits same-prefix neighbours first. Widening it rescales `maxCentrality` for
  the whole pool. Recorded so this is not re-measured.
- **Gold paths in the fixtures are repository-relative; workspace paths may not
  be** (M143-A): comparing them literally scored three correct leads as wrong on
  the first audit pass, turning a net-harmful change into an apparently
  net-positive one. Match on a path-suffix boundary in either direction.

## M142 continuation IV standing findings

- **A traceback frame is an identifier the reporter did not choose** (M142-IV):
  the runtime printed it. That makes it the strongest code cue a bug report
  carries and exactly the evidence prose-vs-identifier hygiene exists to protect
  — but a plain lowercase frame name (`unparse`) has no backticks, no call
  syntax and no declaration phrase, so a rule built around author-chosen markers
  silently drops it. Recognise the frame SYNTAX, not the word.
- **Recognising traceback frames is not the same as trusting them, and the
  difference is dosage** (M142-IV): admitting every frame recovered the target
  case and cost two others. Not one admitted term was a prose false positive —
  they were all real frame function names. A deep chain simply names a dozen
  functions, xarray-3677's three all lived in `merge.py` and outvoted the file
  the request was about, and pylint-8898's were CPython's own `sre_parse`. A
  dozen exact-name assertions drown the prose they were meant to support.
- **Even one frame needs identifying before it is trusted** (M142-IV): bounding
  to the last frame still regressed both cases, because `__getattr__` and
  `_parse` are generic enough to match by coincidence — the `which()` failure by
  a new route. Two structural conditions fix it: the traceback must be COMPLETE
  (no exception line means the deepest frame is where the excerpt was CUT, not
  where execution stopped), and the name must not be a language-protocol dunder
  (every class may define `__getattr__`; the runtime entered one, but the bug is
  upstream).
- **Profiling the layer beneath the product measures a path the product never
  takes** (M142-IV): a direct `indexProject` probe reported `parseCacheHits=0`
  for a sibling worktree sharing a warm 9,670-entry cache and looked like M118
  failing outright. Cross-worktree reuse lives in `initRepo`/`reindexRepo`, which
  select a sibling snapshot FIRST. Through the product path the same case is 6.7s
  against 40.6s. Always profile the entry point the product actually calls.
- **The parse cache is keyed from a previous SNAPSHOT, not from current content**
  (M142-IV): `cacheInputFromSnapshot(previous)` means a caller with no
  `previousSnapshot` cannot hit the cache at all, however warm it is.
- **One changed file disables parse reuse for the whole repository** (M142-IV):
  `fullParseCacheContextCompatible` requires the same file COUNT and
  `scannedFiles.every(...)` to match, so a one-line edit re-parses all 325 files
  even though `canReuseFullParseCache` already performs its own per-file check.
  The flag guards binding and is not safe to loosen without rebinding — §60.
- **`IndexPerformanceDiagnostics.timingsMs` is zeroed unless `parserVersion` is
  supplied** (M142-IV): a naive profile reports every phase as 0ms and looks like
  broken instrumentation.
- **A response field that looks like an obvious duplicate may be an injectable
  product surface** (M142-IV): `capsuleResult.digest` is a third rendering of the
  same selection and was the obvious cut — until `--inject-capsule-digest` turned
  out to feed it to agents directly. `diagnostics.freshness` looked like a
  duplicate of `indexFreshness` until its `autoReindex.state` turned out to be
  asserted at DEFAULT detail by the staleness tests. Check consumers before
  deduplicating.
- **A declared response schema bounds how much can be moved behind `debug`**
  (M142-IV): sweeping whole diagnostics sections into debug-only failed nine
  tests including schema conformance. Reducing a published response needs a
  schema change, not a compaction tweak.
- **A no-change preservation gate whose lead is a TEST file is not automatically
  wrong** (M142-IV): M132's TCKDB row prints
  `lead=…/tests/test_computed_reaction_upload_builder.py` and reads like a
  quality collapse. That IS the expected lead; five of six slots match the
  baseline, and the only movement is the support slot already classified neutral.
  Read `expectedLead` before reacting to `leadPivot`.
- **A stale shared fixture index fails a gate identically on both sides**
  (M142-IV): M136 and M137's budget rows fail because `/tmp/vtrace-m135-arc.sqlite`
  was built at ARC `2f3fd462` and ARC moved to `3da32ea0`; with
  `auto_refresh=never` the tool correctly refuses stale context. Run the gate
  against the PREDECESSOR before attributing it — both return identical
  `resolved=false, items=0, stale/head_mismatch`.
- **Corpus-preparation commit can be proven irrelevant instead of assumed**
  (M142-IV): rather than spend hours regenerating a corpus, note that a corpus IS
  an index, confirm no file under `src/indexer|db|fs|documents` changed, and
  compare two independently prepared large repositories row for row — both were
  byte-identical. That is stronger evidence than a fresh prepare, which proves
  nothing about whether reuse would have been safe.

## M141 standing findings

- **Two freshness models is the defect, not a stale threshold** (M141): the
  `index_status` / `get_code_context` contradiction was never a tuning problem.
  `inspectIndexFreshness` compared the TARGET repo's source snapshot;
  `inspectWorktreeIndexFreshness` also compared VTRACE's OWN indexer, parser,
  schema, and config fingerprints. Editing `src/indexer` invalidates every
  stored index without touching any indexed repository, so one model correctly
  saw nothing changed and the other correctly saw everything changed. Any
  future "why does status disagree with the tools?" starts here.
- **A short-circuiting evaluator cannot express a decomposed verdict** (M141):
  the pre-M141 code returned at the first failing check, so in the one case
  that mattered — schema incompatible — source freshness was never evaluated
  and `sourceFresh=true, schemaCompatible=false` was literally unrepresentable.
  Decomposition is not cosmetic; it is what makes the report truthful.
- **`memoryRulesMs` is `getObservationStaleness`, and the cost was a default
  parameter** (M141): `comparisonRunId = getLatestIndexRun(db)?.id` as a default
  argument re-ran that query per observation and then re-walked the entire
  index-run chain per observation, materializing each run's complete file and
  symbol run-state tables every time. 6,787 ms -> 337 ms on ARC with
  byte-identical verdicts. Project-rule selection was 0.1 ms the whole time —
  profile before naming a suspect.
- **The stale penalty is the only negative signal, which licenses an early
  exit** (M141): every other search signal contributes a non-negative score, so
  an observation with no positive signal is discarded whether or not it is
  stale. Resolving staleness first was pure work for a discarded result. The
  equivalence depends on that sign property — adding any negative non-stale
  signal would break it.
- **A readiness report must never grow into the response** (M141): capsule,
  impact, and flow responses are budget-bounded (M136 asserts delivery at
  `max_tokens: 3000`), so the readiness block is emitted only on surfaces with
  no such budget — `index_status`, `index_repo`, workspace/product-shell
  status, `run_pipeline`'s freshness block, and `get_code_context` diagnostics.
  The verdict is still shared; only the payload is withheld.
- **Tools can share one verdict and still apply different policies** (M141):
  `get_impact_graph` and `search_logic_flow` keep M131's older-index contract
  and answer with bounded static evidence where the context tools fail closed.
  That is declared policy, not a second opinion, and the parity matrix asserts
  both halves. Making them fail closed would have altered frozen M140 behavior
  for no correctness gain.
- **The M137 smoke's FAIL is an unstated fixture precondition** (M141): it
  drives `get_code_context` with `auto_refresh: "never"` against
  `/home/calvin/code/ARC` while supplying a COPIED index, so once that checkout
  drifts from its index the product layer correctly fails closed and no budget
  row can resolve. Identical on `249f61f`. This is the same class as the M132
  stale-baseline row — a check whose precondition silently expired — and the
  same remedy applies: declare the precondition.
- **Two prepare runs on one `--out-root` deadlock on a worktree index lock**
  (M141): running the cross_repo target preparation in parallel with a
  sequential loop that would also reach cross_repo left an `index.lock`
  directory under one target's `.vtrace/`, and the surviving process then slept
  forever on it — zero CPU, zero I/O, no child indexer, indistinguishable from
  slow work. `withWorktreeIndexLock` recovers a lock held by a DEAD process, not
  one abandoned mid-operation by a process that exited between acquire and
  release. Diagnose with `/proc/<pid>/io`: unchanging `rchar`/`wchar` means hung,
  not busy. Remove the lock directory and re-run — preparation resumes
  already-indexed targets instantly. This is the §50 parallel-collision hazard
  the M141 inventory flags, observed live during M141's own validation.
- **A benchmark default that writes tracked evidence turns validation into
  mutation** (M141): 25 of 201 runners defaulted to `results/`. Ordinary runs
  now go to an untracked directory and reaching tracked evidence needs `--out`
  or `--evidence`, which retires the archive-and-restore workflow that reverted
  the M140-C acceptance artifact. Auditing the pattern found 19 runners beyond
  the 6 observed misbehaving — fix the contract, not the sightings.

## M140 standing findings

- **Import attribution had no stable owner** (M140): before this, a file's import
  edges existed only while it had exactly one top-level symbol, so **81% of ARC's
  Python files carried none**. Any past reading of the import graph as complete —
  including hub counts, co-edit import evidence, and `rerankGraph`'s
  imports-neighbour signal — was reading a graph missing ~8× its own content.
- **Module symbols are structural: graph-visible, delivery-invisible** (M140).
  They own module-level imports and are excluded from retrieval candidates,
  lexical ranking, and delivered impact nodes/relations. Do not "fix" a test by
  making them retrievable; add the exclusion to any NEW candidate query instead.
- **`rerankGraph` import-neighbour calibration is an OPEN question** (M140): the
  importer-side signal now lands on module symbols, which retrieval excludes, so a
  function no longer inherits its file's imports. The target side still accrues
  them, from ~8× as many importers. Whether weight 6 / cap 12 still fits is
  unmeasured — it needs the aggregate paired benchmark. Do not retune it to
  restore historical metrics without separately evidencing a ranking defect.
- **Import-only dependency has no symbol-level impact representation** (M140):
  a file that imports a symbol and never calls it no longer appears in impact
  (before, it did *if* it happened to contain exactly one definition). Import-only
  dependency is a file-level relation and the impact response is symbol-shaped.
  Candidate M141 work.
- **This ledger's first table jumps M133 → M140**; M134–M139 rows were never
  appended to it, though M139's row and findings exist further down the file.

## M139 standing findings

- **A budget named for edges bounded nodes** (M139): `max_edges` is applied to
  `symbolsById.size` inside `discoverImpactSymbols`, and the resulting shortfall was
  published as `canonicalEdgesOmitted`. On ARC that read `686` while only `3` edges
  were delivered and `max_edges` was `80` — three different domains under one name.
  Delivered-edge count was limited by there being only three `directRelations`, never
  by the edge budget. Read `canonicalDependentsOmitted` / `canonicalEdgeSlotsOmitted`
  / `canonicalOmissionCause` instead.
- **`contains` traversed backwards is not consumption** (M139): reverse-reachability
  from a method reaches its owning class at distance 1 and then every constructor
  caller of that class at distance 2. `dependentSymbolCount` was `80` for
  `ARCSpecies.copy` with **zero** actual callers among them. Direction-blind
  reachability cannot answer "who calls this?"; use `summary.consumers`.
- **Unresolved receivers are structurally invisible** (M139): `edge_call_sites` is
  keyed to `edges.id`, so a call site exists only where an edge already resolved.
  `spc.copy()` therefore leaves no trace at all. M139 recovers these at query time by
  narrowing on indexed relations to the OWNING CLASS and re-reading only those files
  (content-hash validated), with no schema bump — deliberately chosen so the known
  `index_status` readiness defect (M140) is not compounded.
- **Type evidence binds to a name, not to an expression rooted at that name**
  (M139): `spc` being an ARCSpecies says nothing about `spc.mol`; `Thing()` assigned
  through `.mol` yields a Molecule; and an annotated parameter stops describing its
  name after a rebinding. All three produced confident WRONG attributions before the
  bare-identifier + last-write-wins rules were added. Nine ARC classes define `copy`.
- **Import-edge attribution is fragile — new defect, deferred** (M139): a file with
  `from model import Thing` and ONE function yields an `imports` edge; adding a
  second, unrelated function to the same file drops the file to ZERO edges. This
  silently shrinks any import-derived narrowing. Minimal repro in the M139 report.
- **Contrast cues do not carry their own meaning** (M139): `rather than` /
  `instead of` mean "exclude the right side" in a preference request and "explain
  both sides" in a conditional question. The frame decides, and it must be matched
  with clause structure (`when` + auxiliary verb), never the bare keyword — a bare
  `when` match would silently disable M135's exclusion on ordinary requests.
- **A removed penalty is not the same as visibility** (M139): fixing the adjacency
  contrast changed the ARC serialization lead but did NOT surface `from_dict` /
  `mol_from_xyz`. Their indexed docstrings simply do not share vocabulary with the
  query. The rescue path is structural and already present in the index —
  `from_dict -> mol_from_xyz -> perceive_molecule_from_xyz`, whose tail IS retrieved
  — so bounded upstream expansion, not score weights, is the correct next fix.
- **The committed ARC index was stale again** (M139): it recorded
  `ARCSpecies.copy` at line 653 against a tree holding it at 691, and the caller
  scan's freshness gate refused 43 of 70 candidate files. Every M139 acceptance ran
  on freshly generated indexes. Check ARC index freshness before trusting any
  measurement taken against it.
- **Supplied ground truth needs re-validation** (M139): all four prompted
  `ARCSpecies.copy` call-site line numbers were stale, and `checks/ts.py:206` was
  `ARCReaction.copy` — a different class. An acceptance demanding all four appear
  would have demanded a false positive.

## M140-B standing findings

- **A rescued candidate cannot be scored into delivery from depth 2** (M140-B):
  being missed by lexical search is the PREMISE of a rescue, so the rescue
  component is essentially the candidate's whole score. A depth-1 caller topping
  the rescued pool reaches delivery (ARC `mol_from_xyz`: 0 -> 1.821, rank 6); a
  depth-2 caller at 0.55 relative relevance reaches 0.975 against a ~1.78
  delivery threshold. Closing that needs ~1.0 from one bounded component, which
  would put two-hop callers above exact direct answers. Treat "recovered into the
  candidate set" and "delivered" as different outcomes and report both.
- **Per-pool relevance normalisation is not comparable across seeds** (M140-B):
  BM25 normalised within one seed's callers ties the best caller of EVERY seed at
  1.0 however weak it really is, so a weakly-related seed's favourite caller
  displaced the genuine orchestration entry point on the global cap. Rescued
  candidates are re-scored against the query as ONE pool before the global cap —
  the union is exactly the set in contention. The spec's own pipeline separates
  expansion/dedupe from scoring for this reason.
- **A DB-side fan-in cap is a safety ceiling, not a relevance filter** (M140-B):
  the retained prefix is ordered by edge id, which is uncorrelated with
  relevance. Measured: at 1,000 callers a 400 cap discarded BOTH relevant ones.
  Set such caps well above realistic fan-in and report `limitReached`, or a
  truncated walk reads as a complete one.
- **`visited` cannot serve as both "not admissible" and "already expanded"**
  (M140-B): one set for both silently dropped cross-seed corroboration — an
  orchestrator reached from a second seed was discarded as "seen" instead of
  recorded as reached twice. Keep the admission block-list and the
  re-expansion/cycle set separate.
- **A local-name match across classes fabricates visibility** (M140-B):
  `arc/species/species.py` defines BOTH `TSGuess.from_dict` and
  `ARCSpecies.from_dict`, so a name-suffix check reported the absent symbol as
  present at rank 15. Resolve every visibility claim by exact fully-qualified
  name. (Same shape as M139's stale-ground-truth finding.)
- **A synthetic fixture smaller than the lexical pool cannot test a rescue lane**
  (M140-B): the pool holds 100 candidates, so in a ten-symbol repository every
  symbol is already retrieved and there is by definition nothing left to recover
  — and a symbol needs query terms to clear the relevance floor, which is exactly
  what makes it lexically findable at that scale. Structural contract (depth,
  cycles, dedupe, caps) is tested against the lane directly; genuine end-to-end
  recovery needs a real index.
- **`buildCapsuleV2` has no retrieval-feature toggle** (M140-B): re-running it to
  capture a "before" delivery records the AFTER state under a before-state name.
  Capture delivered before-states from an artifact written by the predecessor
  commit, not by re-running the current one.
- **`getImpactGraph` and `searchLogicFlow` return `{ ok, output }`** (M140-B):
  reading fields off the top level yields nulls that look exactly like a
  regression. Two M140-B preservation checks "failed" this way before the
  wrapper was unwrapped.

## M140-C standing findings

- **"Reaches something already delivered" is not a selection criterion**
  (M140-C): it is satisfied by EVERY caller of every selected function, so a
  guaranteed slot handed out on coherence alone goes to whichever ordinary
  caller happens to rank highest. Measured: a broad process question ("how does
  ARC handle linear segments…?") spent it on a rank-11 caller whose only
  qualification was calling something on screen. A bounded selection role needs
  a SHAPE requirement — reached the seed THROUGH a delivered intermediate, or
  calls two delivered alternatives — not merely connectivity to the selected set.
- **Ranking and selection are separable, and separating them is far cheaper
  than fighting the ranking** (M140-C): M140-B measured that delivering a
  depth-2 orchestration entry point by score would need ~1.0 from one bounded
  component, i.e. two-hop callers above exact direct answers. The same symbol
  reaches delivered context through one converted support slot at a cost of
  0.07 ms, zero DB queries and zero score change — and the capsule can still say
  truthfully that it is not one of the strongest direct answers.
- **An intent-gated lane cannot be measured by the frozen suites** (M140-C):
  `evaluateOrchestrationIntent` is active on **0 of the 50** frozen-50 tasks —
  measured directly on the fixture text, not inferred from a zero-changed
  benchmark. Those suites prove regression safety only; capability has to come
  from a real orchestration-shaped corpus. Read "0 changed cases" as "the gate
  never opened", and pair it with an activation summary that shows where it does.
- **The archive-and-restore remedy for the preservation-smoke hazard must
  exclude the current milestone's own artifacts** (M140-C): restoring
  "everything modified under `results/`" after a smoke also reverts the evidence
  the milestone just wrote into the same directory. It silently destroyed the
  M140-C TCKDB acceptance once; it was recovered from the archive only because
  the archive step ran first. Archive before restoring, and filter the restore.
- **A preservation gate that asserts an IMPROVEMENT cannot be re-run as a
  regression check against a successor** (M140-C): M132's
  `impact_hydration_batched` requires a strict query reduction versus its
  baseline. With M140-B as the baseline — which already contains the M132
  batching — `34 -> 34 queries for 40 dependents` is the correct unchanged
  result and the row is unsatisfiable by construction. Read the companion fields
  (`queryReduction: 0`, `semanticEquivalence: identical_dependent_set_size`)
  before recording such a row as a regression.
- **The `/tmp` tmpfs quota breaks smokes that copy large indexes** (M140-C):
  the M137 runner copies a 505 MB TCKDB index into `os.tmpdir()` and dies with
  `EDQUOT`. Point `TMPDIR` at the root filesystem before running it. This is the
  same constraint that killed the first M140-A benchmark attempt, in a second
  place.
