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
| M144 | `e7c45bd` (only functional commit) | **MIXED** (A PASS inventory/extraction; B PASS attribution; C MIXED — one narrow rule shipped, three measured mechanisms deliberately not shipped; D PASS) | **The evidence class is real, resolves, and is far narrower than the roadmap assumed.** Required early determination first: **`django-11740` contains NO supplied failure evidence** — 106 chars of `manual_verified` prose, zero on every lane. It names the autodetector in PROSE, which is task-ENTITY evidence, not observed-failure evidence (§12 forbids collapsing them), so it is `not_addressable` and becomes M144's negative control instead of its acceptance. Prevalence on the frozen 50: **23/50 any evidence but only 13/50 LOCALIZING** — 18 carry an exception name, which localizes nothing, and 10 carry *nothing else*, so the naive count doubles the apparent reach. **0 pytest node ids** anywhere in 71 inventoried cases; all 8 failing-test mentions are BARE names and `django-12273`'s `test_f_true` does not exist in the repository. Then the §89 cut: **10 of the 13 already reach gold top-1 on the predecessor**, so the true headroom before any work was TWO cases. Resolution: 34 items, 20 resolve, 14 external, **0 ambiguous**, 0 basename-fallback-only; one measured false resolution (`/Users/hwkns/test_requests.py`, the reporter's laptop, shares a full segment with the repo's own file). **Frame depth was refuted by measurement**: deepest-in-repo names gold 4/6, shallowest 3/6, and `xarray-3677`'s deepest in-repo frame is the symptom site `common.py::__getattr__` while gold is the SHALLOWEST project frame — a depth rule would have broken a passing case. **Shipped instead:** before choosing the one frame M142 already admits, ask whether that frame's file belongs to the repository being searched, and choose the deepest that does. `site-packages` cannot decide this (it holds both django-12774's own installed source and foreign deps), so membership is a segment-boundary match against the indexed file list — the M143 §54 path rule, now in ONE shared module. Ordering is load-bearing: completeness is still measured after the DEEPEST frame (or filtering silently re-enables `pylint-8898`'s truncated stack) and the dunder guard still runs after selection (or filtering hands `xarray-3677` the accessor it denies). No resolver = byte-identical selection. **Not shipped, with the measurement attached:** frame→direct-relation to owner is REAL (`pylint-8898`'s gold is one `calls` edge from its deepest in-repo frame; precision 15/24 = 0.625) but needs the M142 completeness guard relaxed AND ranking authority — the §43 architecture M143 condemned; test→production needs node ids the corpus lacks; reproduction-command attribution has 1 genuine instance naming a management command. | FINAL paired `93a34d1 -> e7c45bd`, provenanceValid=true, both suites `sameFixtureHash`/`sameTargetCorpusHash`/`isolatedIndexes`/`authoritative`: Top-1 **38 -> 39 (+1)**, Top-3 44 -> 44, anywhere 48 -> 48, symbol 31 -> 31, missing 2 -> 2, pivots/support flat, tokens 1835.20 -> 1850.14. **Exactly 1 changed case in 50** (django 0/20, cross_repo 1/30): `psf/requests-1724`, `requests/api.py -> requests/sessions.py`, top1 false->true, classified `traceback_attribution` with the full causal chain; **0 unexplained**. Its predecessor identifier was stdlib `httplib._send_output`, a name absent from the index. No-evidence equivalence holds STRUCTURALLY: 44/50 have no traceback, 0 changed, and measured `indexedPathsRead = 0` on all 44 — the new code is unreachable without a frame. Controls **19/19** (11 frame + 8 prose false-positive), **4 discriminate** predecessor from candidate. Cost: **0 additional DB queries** (the path list was already read once per task by the localization detector and is now shared), 0 graph queries, 0 source reads; +747 tokens on the one changed case, 49/50 byte-identical. Preservation: **0 regressions attributable to M144**; 5 title cases byte-identical, `django-11740`/`django-11815`/`sphinx-7462`/`sphinx-7910` unchanged, `get_dihedral` still leads, ARC behavioural **7 cases / 0 semantic differences**, TCKDB `leadChanged=false`; M136 + M138 reproduce identically (blameless), M132 MIXED 19/21 the same stale assertion. 4244 pass / 49 skip / 0 fail; both typechecks clean; `git diff --check` clean | **M145 — Workspace and Repository Identity Foundation** (unchanged). M144 sharpens one input: `repositoryPathMembership.ts` is now the single answer to "does this path belong to this repository", and it answers against a flat path list with no workspace identity behind it. The measured `test_requests.py` collision is exactly the ambiguity M145 exists to make explicit — M145 should take ownership of that predicate rather than leave membership decided by string suffixes. No cross-repository ranking yet |
| M145 | `6fc5e3c`, `0b3ae81`, `4de1a02`, `a4fce8b`, `88de106` (final functional) | **PASS** (A audit PASS; B canonical identity PASS; C path membership PASS; D workspace/routing PASS; E provenance PASS; F readiness PASS; G locking PASS; H MCP/CLI routing **MIXED** — one seam integrated, rest audited and left; I collision safety PASS; J no-semantic-movement PASS) | **The audit found a working identity model with one hole, and the hole is that every identity value is a function of a PATH.** `repositoryId` = sha256(gitCommonDir), `worktreeId` = sha256(gitCommonDir+worktreeRoot), so deleting a checkout and putting an UNRELATED repository at the same path yields byte-identical ids — measured, with readiness reporting `repositoryCompatible=true, worktreeCompatible=true` across the swap. It was still caught downstream (two repositories cannot share a commit SHA) but as `source_stale / head_changed`, a true statement about the wrong question. **Fix: instance evidence** — `stat` on the git dir (device:inode:birthtime) at **0.007 ms**, which discriminates every §125 case: replacement distinct, MOVE PRESERVED, `cp -r` distinct, clone distinct, sibling common dir shared. Root-commit lineage was rejected on cost (3 ms on ARC only because of its commit-graph; unbounded without one); remote URL rejected per §13. It can only REFUTE — a null means the artifact predates the field, and M132 already settled that silence is not a failing claim. **Path membership became a status** (`exact`/`unique_resolved`/`ambiguous`/`external`/`unresolved` + `external_to_selected_repository`), and the collapse to M144's boolean is EXACT not approximate: one scope makes `ambiguous` unreachable and `exact` implies a suffix match, so `exact|unique_resolved` IS M144's `true`. **Acceptance caught a real defect**: an absolute path inside one member became `ambiguous` as soon as a second member indexed the same relative path — `/w/a/src/foo/bar.py` names a LOCATION and a repo merely containing `src/foo/bar.py` does not contain that location, so exact now outranks suffix. **A workspace entry was keyed on an alias and a path string, both display metadata**, so no reuse of that metadata could ever be validated; entries now resolve to canonical identity once at load and record what they vouched for. `primaryRepoAlias` silently defaulted to the FIRST ENTRY — §75 forbids position as a decision, now tracked as `primaryRepoAliasExplicit`. **The lock owner's `worktreeId` was written by M114 and never read**, so a copied `.vtrace` blocked an unrelated worktree; recovery is now on ownership (`dead_owner`/`unreadable_owner`/`foreign_worktree`) and never on age. | FINAL paired `e7c45bd -> 88de106`, provenanceValid=true, both suites `sameFixtureHash`/`sameTargetCorpusHash`/`isolatedIndexes`: **0 changed cases in 50**, Top-1 39->39, Top-3 44->44, anywhere 48->48, symbol 31->31, missing 2->2, tokens **1850.14 -> 1850.14** byte-identical. Expected rather than lucky: retrieval takes `(db, repoRoot)` and NO workspace input reaches it. Workspace acceptance **54/54** (identity 8, membership 7, ambiguous 4, routing 9, collision 3, order invariance 5, readiness 7, lock 6, provenance 4, scaling 1). M144 parity: controls **byte-identical**, localization evidence identical modulo wall-clock, **26/26** path shapes agree, `requests-1724` still flips `_send_output`->`send` with gold lead. Real repos: ARC+TCKDB registered together, **6/6 queries byte-identical** to repo-alone; membership isolation 25/25 ARC-only->ARC, 25/25 TCKDB-only->not-ARC, 2/2 genuinely shared paths ambiguous; both opened read-only, config outside both trees, checkouts unchanged. Locking: contended refusal **9.1 ms** with owner named, unrelated repos parallel, sibling worktree unblocked, no hangs. Provenance envelope **168-171 bytes CONSTANT** at 1/10/100/1000 members; routing **0.001-0.010 ms**. Preservation: all 6 gates compared byte-for-byte against M144's own run — 4 identical (incl. M136/M137/M138's INHERITED failures, unchanged), M140-C differs by one timing line, M140-B differs only because TCKDB's HEAD advanced. 4308 pass / 49 skip / 0 fail; both typechecks and `git diff --check` clean. **Cost accepted:** M145 edits `src/indexer`, so `indexer_fingerprint` moved and every pre-M145 index is now `schema_incompatible -> full_rebuild` (measured: ARC `source_stale` under M144 -> `schema_incompatible` under M145). §111 decision made not reflexed: NO format/schema/capability bump, since the fingerprint already forces it; `repositoryCompatible`/`worktreeCompatible` stay TRUE against old indexes, so identity is not what refuses them. | **M146 — Cross-Repository Intelligence.** The foundation holds: every file/symbol/candidate resolves to a worktree identity, ambiguity fails closed, and `external_to_selected_repository` is already a reportable fact. The first genuinely new question is repository RELEVANCE, which M145 deliberately refuses. Recommended order: measure how far explicit evidence alone disambiguates a real multi-repo workspace (path membership already resolves 25/25 unique paths) BEFORE adding any semantic signal, so fan-out is introduced only where explicit provenance runs out. Do not re-plumb every MCP tool onto the registry selector without a measured need — H was left MIXED for that reason |
| M146-A | `1302a2a`, `00b47bd`, `a3040e1` (final functional) | **PASS** (A1 audit PASS; A2 coverage fix PASS; A3 fixtures 1-8 + MCP reconnect PASS; A4 diagnostic truthfulness PASS). **M146-B NOT STARTED, so M146 overall is INCOMPLETE.** | **The fingerprint model's INTENT was already right and its COVERAGE was not.** Query-time dirs (`src/capsule*`, `src/capsuleV2`, `src/mcp`, `src/retrieval`) are excluded on purpose so ranking edits never invalidate, and `vtrace_commit` is recorded but is not a freshness field — the contract was already semantic, not SHA-based. But coverage was a hand-listed set of directories while the real boundary is the **import closure of the write path**, and three defects sat on the wrong side of it. **(1)** `buildFtsSearchText` lived in `src/retrieval` — excluded BY DESIGN — yet built the stored `symbol_search_fts` rows: measured, all five fingerprints byte-identical, `ready=true`, and `parsejson`/`computetotal` silently gone from a rebuilt derivation. **(2)** `src/domain/types.ts` (`normalizeFilePath`, `buildFQName`, `computeFileId`, `computeSymbolId`, persisted enums) and `guards.ts` (`isLanguage` decides whether a file is parsed AT ALL) were value-reachable from the write path and hashed by nothing. **(3)** the worst, and only visible by following the fix to the user's NEXT ACTION: `reindexRepo` decided snapshot reuse from its own ladder comparing `parser_fingerprint`/`config_hash`/`index_format_version` but **never `indexer_fingerprint` or `schema_version`**, so readiness refused the index, the recommended rebuild reused everything, and the run stamped the NEW fingerprints onto the OLD content — converting a correctly-refused index into a permanently and wrongly ready one. Fixes: tokenizer moved to `src/indexer/searchTextDerivation.ts` with write and query paths sharing one definition; identity/hash/git sources added to the indexer fingerprint; `resolveDerivationRebuildReason` made the single authority for both "may it be used" and "may a refresh reuse it". **Diagnostics split**: `schema_changed` (representation) vs `derivation_changed` (contents produced under obsolete semantics), because `index_status` renders the reason verbatim and was telling users the database schema had changed after a parser edit. | All verdicts measured by mutating REAL source and asking a FRESH process. Query-only reuse **5/5** files, 0 fingerprints moved, ready. Parser **3/3**, graph/module-ownership **3/3**, document **2/2**, schema **1/1**, source-only **PASS** (`sourceFresh=false`, `schemaCompatible=true`, `incremental_refresh`), repo replacement **PASS** (identity, not masked), stable reopen **PASS**. MCP reconnect **both directions PASS**: index-affecting change refused with `derivation_changed` then GENUINELY rebuilt (FTS terms change), query-only change stays ready with no rebuild. Coverage: value-import closure **43 files, 5 exempt with rationale + behavioural control, 0 unclassified**; all-imports closure is 66/29 and the entire difference is type-only chains into capsule/skeleton/projectRules, which is why type edges are ignored. Guard verified **fail-closed**: reintroducing the original defect fails it naming the file and the reaching path. **4334 pass / 49 skip / 0 fail**; both typechecks clean; `git diff --check` clean. Preservation: every M141 readiness boolean, state and action unchanged for every input; legacy freshness reason `index_schema_changed` byte-identical; 3 M141 tests updated because they mutated `parser_fingerprint` while asserting `schema_changed` and their own comments already called it an indexer/parser move. Frozen50 NOT run — no retrieval/ranking/selection code touched and retrieval takes `(db, repoRoot)` with no compatibility input, so movement is structurally impossible, but that is an argument and M146-B must still run the paired comparison. | **M146-B — Cross-Repository Retrieval Foundation** (not started; A's gate is now clear). Entry point unchanged from M145: measure how far EXPLICIT evidence alone disambiguates a real multi-repo workspace before adding any semantic signal. One new constraint from A: a repository whose index is derivation-incompatible must not contribute deep symbol/FTS probe evidence to routing, since that evidence was produced under semantics the runtime has already refused |
| M146-B | `d7687b7`, `11335a1` (checkpoint, not final) | **INCOMPLETE** (routing implemented/gated/measured; aggregation implemented and unit-measured but NOT wired into any product path; paired benchmark, ARC/TCKDB acceptances and the full §50 corpus not run). Not MIXED: this is unfinished scope, not a measured ceiling. | **Repository relevance is tiered, not scored.** Raw retrieval scores are not established as comparable across repositories (M122-M145 calibrated each against its own corpus), and every available tie-break — registration order, path length, alias — is a semantic decision in disguise, which M145 already refused once when `primaryRepoAlias` defaulted to the first entry. So: explicit selection > absolute-path containment > indexed path membership > exact symbol; highest tier producing anything decides; two repositories inside that tier is `ambiguous`. **The split between tiers 1 and 2 is M146-A carried into routing**: tiers 2-3 read indexer-derived state, so a member whose index this runtime refused may not contribute them, or a stale index answers a probe, thereby SELECTS ITSELF, and is then rebuilt and its answer presented as current — circular and self-concealing. The gate is structural: the member pool a lane draws on comes from the same table recording whether it reads derived state, so a new lane cannot omit it. **Tiers 0-1 stay available to a refused member**, which is what makes `not_ready` ("the right repository, repair it first") expressible instead of the misleading `no_match`. Four outcomes kept distinct: selected / ambiguous / no_match / not_ready. Aggregation shares ONE budget, admits in rounds of LOCAL rank so the primary's best candidate leads before any support, and keys identity on (worktreeId, path, symbol) — never any part alone. | Mandatory §12 fixture (alpha ready / beta `derivation_changed` / gamma ready): explicit-alpha **0 indexes opened**; exact beta path → `not_ready`, **beta never opened**; symbol only beta defines → **`no_match`, probed alpha+gamma, never beta**; after repair → `selected` beta on symbol evidence. Controls: unique path PASS, unique symbol PASS, ambiguous symbol/path → no winner, explicit overrides contrary evidence, no-match preserved, alias-prose negative control PASS, same-path/same-FQN keep 2 distinct worktreeIds+repositoryIds, registration order reversed → identical, unrelated repo added → unmoved, identical clones → ambiguous with distinct identities. **Scaling: 1/10/100/1000 registered repos → 0 indexes opened, 0 deep probes, routing 0.065/0.183/0.342/2.042 ms.** Budget: 3 repos offering 1000 tokens against a 300 budget deliver 200; two-repo composition delivers backend lead + client support; a budget fitting one preserves the direct answer and omits weak support. M146-A preservation: closure guard + compatibility suite 25/25, and the new workspace code did NOT enter the index write closure (§62/§64) — no routing state is persisted in any index. 4367 pass / 49 skip / 0 fail; both typechecks and `git diff --check` clean | **Finish M146-B before any closure session**: (1) wire aggregation through the shared productContext seam keeping single-repo output equivalent; (2) run the §83 paired benchmark against `a3040e1`, Frozen50 first — movement is structurally impossible today since no product path calls the new modules, but the brief is explicit that the argument must become a measurement; (3) ARC/TCKDB workspace acceptances + a truthfully named corpus; (4) only then the separate M146 final-closure session |
| M146-B (final) | `d7687b7`, `11335a1`, `f729f3d` + truncation fix (this session) | **MIXED** (scope complete and measured; one genuine capability ceiling). M146 overall still INCOMPLETE — NOT final-closed. | **Product integration composes `assembleProductContext` rather than modifying it**, so repository-local retrieval keeps every M122-M145 semantic by being literally the same call; what is added is choosing which repositories to call it against and merging under one budget. Single-repo preservation is proved twice: STRUCTURALLY (a test walks `src/` and fails if any production file outside `src/workspace` imports the router/aggregator/integration layer, and asserts `assembleProductContext` names no workspace type) and by MEASUREMENT (paired 0/50). **A defect was found and fixed in-session**: the deep-probe cap truncates the pool the indexed lanes see, and a match found in a prefix was reported as unique — measured with ten ready members, cap eight, symbol in the FIRST and LAST, returning `selected(first)` where truth is ambiguous, and reversing registration order would have named the other. So past the cap the router silently chose, and chose BY POSITION, breaking both §110 and §67. Now fails closed: truncated pool -> `ambiguous / uniqueness is unproven`. That fix is also the ceiling that makes B MIXED — symbol evidence can only establish uniqueness when every ready member was probed, so workspaces with >8 ready members abstain on symbol-only queries. Path containment is unaffected (opens no index, still 1000 members at 0 probes). Both real repos were found NOT READY under this runtime (ARC `derivation_changed`, TCKDB_v2 `schema_changed`) — the expected M146-A fingerprint consequence and a real instance of the scenario B was built for; rebuilt via the existing authoritative path (ARC 31 s, TCKDB 123 s) before acceptance. | **Mandatory paired benchmark `a3040e1` -> candidate, `provenanceValid=true`**, M134 framework, separate worktrees per side, each side generating its own index from its own fixture copy: **frozen50 0/50 changed**, django 0/20 and cross_repo_30 0/30 with **byte-identical semantic hashes**; Top-1 38->38, Top-3 44->44, anywhere 48->48, symbol 31->31, missing 2->2, tokens 1832.4->1832.4. (38/1832.4 measured on BOTH sides here; the M145-era 39/1850.14 came from a different predecessor state and was deliberately not copied.) `cross_repo_30` recorded truthfully as a SINGLE-repository preservation suite, not a workspace benchmark. **Real acceptance**: ARC-specific (`get_dihedral`) and TCKDB-specific (`LevelOfTheory`) each `alone == explicit == auto` with correct lead and zero contamination; **explicit-route parity 6/6 byte-identical** (M145's gate re-run post-integration); generic `main` (defined in both) -> `ambiguous`, no context delivered. **Mixed readiness through the PRODUCT path**: stale-only symbol -> `no_match`, stale member never opened; absolute path into stale member -> `not_ready`, still never opened; ready member answers normally beside it. Workspace corpus **18/18 case classes**, named `m146_workspace_routing_corpus`. Composition: backend lead + client support, both contribute, provenance on every item; 3 repos offering 1000 tokens vs 300 budget -> 200 delivered; constrained budget keeps the direct answer and omits support; composition off by default. Scaling 1/10/100/1000 -> 0 indexes opened, 2.042 ms. M146-A closure guard + compatibility suite pass; workspace code did NOT enter the index write closure. **4384 pass / 49 skip / 0 fail**; both typechecks and `git diff --check` clean | **Separate M146 final-closure session**: reconcile M146-A PASS + M146-B MIXED into the milestone verdict with a final preservation/provenance pass across `88de106 -> M146 final`. The truncation ceiling is the first M147 candidate — raise the cap and accept linear probe cost, add a cheap workspace-level symbol digest so uniqueness can be REFUTED without opening every index, or expose "selected, uniqueness unproven" and let the caller decide |
| **M146 (closure)** | final functional `d2a8254`; A `1302a2a`/`00b47bd`/`a3040e1`, B `d7687b7`/`11335a1`/`f729f3d`/`d2a8254` | **MIXED overall** (A **PASS**, B **MIXED**). Not PASS — the >8-ready-repo symbol-uniqueness ceiling is real; not INCOMPLETE — every mandatory step ran; not FAIL — the system abstains rather than answering wrongly. | **A proved the runtime can now refuse an index whose DERIVATION it no longer agrees with**, which is a different question from identity, freshness or schema readability, and three severe defects said it could not: persisted FTS text was generated by `src/retrieval` code the fingerprints skip BY DESIGN (measured: all fingerprints identical, `ready=true`, rebuilt derivation losing `parsejson`/`computetotal`); stored identity derivation (`computeSymbolId`/`computeFileId`/`buildFQName`/`normalizeFilePath`/`isLanguage`) was unfingerprinted; and worst, the RECOMMENDED REBUILD re-certified refused state by reusing the derivation and stamping new fingerprints on it — making remediation less safe than refusal. **B added repository RELEVANCE as tiers, not scores** (explicit > absolute-path containment > indexed path > exact symbol; >1 inside the deciding tier = ambiguous), carried A's invariant into routing so a refused index may not supply the evidence that selects it, and kept tiers 0-1 available to refused members so `not_ready` ("right repo, repair it first") is expressible instead of `no_match`. Integration COMPOSES `assembleProductContext` per selected repo rather than modifying it. **The truncation defect and its fix are the milestone's sharpest lesson**: the probe cap that bounds cost also truncated the search space, and a match in the prefix was reported UNIQUE — 10 ready repos, cap 8, symbol in #1 and #10 gave `selected(#1)`, and reversing registration order named the other. Now fails closed as `ambiguous / uniqueness is unproven`. That fix IS the ceiling: finding a match is cheap, proving uniqueness requires proving every other eligible repo does not match, and a bounded search cannot make that global negative claim. | **Final M145 `88de106` -> M146 `d2a8254` paired, `provenanceValid=true`**, sameFixtureHash/sameTargetCorpusHash/isolatedIndexes/authoritative all true: **0/50 changed**, django 0/20 and cross_repo_30 0/30 with **byte-identical semantic hashes**; Top-1 38->38, Top-3 44->44, anywhere 48->48, symbol 31->31, missing 2->2, tokens 1832.4->1832.4. Staged `a3040e1 -> d2a8254` also 0/50, so M145->A is 0/50 by construction. **Re-executed, not copied** — M145 itself measures 38/1832.4 in this harness, so quoting the M145-era 39/1850.14 would have manufactured a regression. `cross_repo_30` recorded as a SINGLE-repo preservation suite despite its name. **Real acceptance**: both real indexes were REFUSED before it could run (ARC `derivation_changed`, TCKDB_v2 `schema_changed` — the expected A consequence and the first real instance of B's case), rebuilt via the authoritative path (31 s / 123 s); then ARC and TCKDB each `alone == explicit == auto` with correct lead and zero contamination, **explicit-route parity 6/6 byte-identical**, generic `main` -> ambiguous with no context delivered. Workspace corpus **18/18**. Mixed readiness through the PRODUCT path: stale-only symbol -> `no_match` and absolute path -> `not_ready`, with the stale index **never opened** in either. Preservation: A compatibility 25/25, M141 20/20, `src/workspace` 108/108, M132 12/12; anti-drift guard confirms router/aggregator/integration stay OUTSIDE the index write closure. **4384 pass / 49 skip / 0 fail**; both typechecks and `git diff --check` clean | **M147 — Bounded Repository Presence Proof** (investigation, not implementation): can VTRACE cheaply establish that an exact identifier is DEFINITELY ABSENT from unprobed ready repositories, so bounded deep retrieval can still make truthful uniqueness claims? Audit per-repo name summaries, negative-presence/Bloom-style filters (can prove absent; "possibly present" still opens the index), manifest name digests, cached presence maps. Requirements: false uniqueness impossible; routing stays outside index derivation unless a summary is deliberately persisted AND fingerprinted; workspace updates invalidate correctly; multi-repo symbols stay detectable; refused members supply no presence truth. **Explicitly NOT recommended: raising the cap 8->16**, which moves the cliff without addressing the architecture |
| **M147** | final functional `3e30509`; `ec37437` (presence proof), `3e30509` (access-path migration); evidence = this commit | **PASS**. Every M147 gate cleared: mechanisms audited before any code, the shipped mechanism has truthful negative-proof semantics, false negatives are zero by construction AND by measurement, refused repositories cannot supply absence truth, >8-ready-member unique symbols resolve safely while duplicates stay ambiguous, a truncated scan fails closed, registration order is irrelevant, single-repository behaviour is byte-identical, and the full M146 corpus is preserved. | **The bound that made uniqueness unprovable was a missing access path, not an inherent cost.** M146 capped deep probes at eight because probing was expensive; measurement located the expense precisely — `symbols` was indexed on `(file_id, start_byte, id)` and on NEITHER name column, so the routing query planned as `SCAN symbols`. A present name exits at the first hit; an ABSENT one must consider every row. Absence — the only direction a uniqueness proof needs — was therefore the expensive direction, and expensive in proportion to the repository (requests 42 us, ARC 1,332 us, TCKDB 4,974 us), while opening SQLite, the suspected cost, is 0.02-0.14 ms even for TCKDB's 539 MB index. **So the presence layer M147 went looking for already existed; it just had no index.** Candidates A/B/C/G were measured on real populations (1.3k-49k routable names per repo). Bloom at 10 bits/name is 1.25 B/name with 0.9% false positives and zero false negatives — correct and compact, and rejected anyway: it is a SECOND persisted artifact with its own staleness contract, inheriting exactly the failure classes M146-A spent a milestone closing, and its positive answer is `maybe`, which forces a deep-probe resolution stage the exact probe makes unnecessary. The exact probe has no invalidation contract of its own (it reads the table readiness already gates), gets incremental correctness free (SQLite maintains the index transactionally with the rows), and needs no full/incremental equivalence proof because there is no second structure to keep in step. **The proof, not the probe, is the milestone.** `present > 1 -> ambiguous; unknown > 0 -> unproven; one present and none unknown -> unique; none present and none unknown -> absent`, read in that order, over ALL ENABLED members rather than the ready ones. That widening is the clause M146 was missing: it filtered refused members out of the pool and then reported uniqueness over the remainder, silently converting `we did not ask them` into `they do not have it`. UNKNOWN IS NOT ABSENT. The one asymmetry — two owners settles the question even with members unchecked — is deliberate and pinned, since no further answer can reduce a count of two. **The access path is a physical capability, not a schema change**, so it must not invalidate anything: `CREATE INDEX` in `src/db/schema.ts` would move `schema_version`, refuse every stored index, and force a full reparse of every repository to gain an access path that changes nothing indexing regenerates. It lives in `src/access/`, outside the fingerprinted dirs and unreached by the index write path, and installs additively into an index that already exists. Its version is read from the SQLite catalogue rather than a stored counter, because a counter can disagree with what the database actually has. | **Frozen50 0/50 changed**, byte-identical CSVs on django 20 and cross_repo_30 30; Top-1 38->38, Top-3 44->44, anywhere 48->48, symbol 31->31, missing 2->2, tokens 1832.4->1832.4. Predecessor executed by stash A/B at HEAD, valid because `d2a8254..HEAD` touches only `src/workspace/*.test.ts` so HEAD's production tree IS `d2a8254`; the committed baselines are stale since `7b29882` and were deliberately not used. **Primary acceptance: 1000 ready members, owner at index 742 — `selected` in 240 ms with the access path (650 ms without), 999 proven absent, 0 unknown**, where M146 probed eight and reported `no_match`. **Real acceptance, 10 ready real repos vs a cap of 8**: ARC `ACTIONS_PATTERN` -> selected(ARC) in 3.19 ms (same query bounded at the M146 cap -> `no_match`); TCKDB `ACTIVE_MACHINE_REVIEW_PROMPT_VERSION` -> selected(TCKDB_v2); `main`/`setup`/`run`/`get`/`parse` -> ambiguous with the present-set equal to an independent SQL census every time; one member broken -> selected->ambiguous->selected after repair; 4 registration permutations -> 1 distinct outcome including every proof field. **Correctness**: 0 false negatives over 65,023 real names on both access paths; 0 false positives on near-miss and SQL-wildcard names; 0 uniqueness claims at bounds 1/4/8/11; incremental add/remove/rename leaves no stale PRESENT and no stale ABSENT; migration leaves derived rows byte-identical and moves no fingerprint (132 ms across 10 real repos, 0.67-3.34% index growth, 39.7 ms for TCKDB's 570 MB). Fallback-vs-indexed under the ROUTER's access pattern: 100 ARC-sized members 11,951 -> 65.7 ms (182x), which is the whole justification for the access path. **4411 pass / 49 skip / 0 fail**; both typechecks and `git diff --check` clean | **M148 — carry the eligibility rule into the `indexed_path` tier.** It still nominates over ready members only, so a refused member cannot refute a path-uniqueness claim; it retains M146's truncation guard so it fails closed on the bound, but not the rule M147 gave the symbol lane. Scoped out here by S16/S45. Then: (a) an invocation surface for the migration — it is a tested operation with no CLI or MCP command in front of it, so a user cannot run it; (b) decide whether fresh indexes should receive the access path at index time, which means an anti-drift exemption plus its behavioural control and should be reviewed rather than added late in a milestone; (c) release probes as the presence lane finishes with them — 1000 members currently means 1000 open connections, bounded and measured but unnecessary |
| **M148** | A `f801792` (access lifecycle), B `cc06012` (indexed-path proof); final functional `cc06012`; evidence = this commit | **PASS** (A **PASS**, B **PASS**). A: the migration is reachable through `vtrace index` / `vtrace init` / MCP `index_repo`, fresh indexes leave optimized, an existing compatible index gains the access path with 0 files parsed and 0 graph/FTS rows rewritten, and idempotency, atomicity, concurrency and lock-boundedness are measured rather than argued. B: the indexed-path eligibility defect was REPRODUCED before any code changed, then fixed with M147's own reducer; every M147 column in the workspace ledger is measured against a predecessor worktree, not inferred. | **A physical access path belongs to the index LIFECYCLE, not to derivation.** The seam is `src/runtime/reindexRepo.ts` + `src/setup/initRepo.ts` — above the indexer, where a writable handle and the worktree lock already exist — so `src/access` never enters M146-A's fingerprint closure and the anti-drift guard passes 8/8 with **no new exemption**. Every derivation fingerprint is byte-identical to `3e30509`, so no index in the field is invalidated. Cost: ARC 8.95 ms and TCKDB_v2 43.5 ms against ~31 s / ~123 s rebuilds; absent-name lookups 1,848 us -> 2.0 us and 8,043 us -> 2.0 us; fresh-index overhead 1.17 ms of 262 ms. **B: `indexed_path` really was making M147's discarded claim.** Measured pre-fix on a three-member workspace where the refused member DID index the path: `selected(a)` on indexed_path evidence — a global negative about a repository never asked. Post-fix it is `unproven` and names `b`, with the stale index still never opened. The population is now every ENABLED member; disabled members stay outside. The old 8-probe prefix disappeared as a separate mechanism — a member past the bound is `beyond_scan_bound`, which composes with the same proof — and the bound moved onto a MEASURED one (`maxPathMembershipScans` 1024): `files` already carries a UNIQUE covering index on `path` (ARC 63 us, TCKDB 308 us for a whole path set), so **this lane needed no migration at all**. Side effect at 11 ready members: M147 abstained on the probe cap, M148 selects the owner with 10 proven absent. Real corpora: ARC ready + TCKDB_v2 `source_stale` **as found** — the correction fires on real data, checked against an independent SQL census. Frozen50 **0/50 changed** (38/44/48/31/2/1832.4 on both sides, predecessor freshly executed, `provenanceValid: true`). Suite 4439 pass / 0 fail / 49 skip in 139.0 s — 25 tests added and FASTER than M147's 147.6 s. | M149 — audit the evidence consumers BELOW routing (supporting-evidence gathering, cross-repo composition) against what they actually claim, before a future change hands one of them an absence claim it has not earned. No live spend. |
| **M149** | functional `2aaac75` (claim scope + bounded coverage), `f155a2a` (evidence runners); final functional `2aaac75`; evidence = this commit | **PASS** (A **PASS**, B **PASS**, C **PASS — no change required**, D **PASS**, E **PASS**). The §136 shape of a good pass: real consumer overclaims corrected, one hypothesised overclaim honestly not reproduced, selected context byte-identical, only metadata and claim wording moved. | **M146-M148 taught the PRODUCERS to tell the truth; M149 makes the CONSUMERS keep it.** The invariant: evidence may be combined, but uncertainty may not disappear in the combining — a consumer may narrow a claim freely and may never widen its SCOPE or strengthen its AUTHORITY. Both axes now live in one module (`src/workspace/evidenceClaims.ts`) so the next lane cannot repeat the M146/M147/M148 pattern of a cost bound quietly becoming a correctness bound. **Headline defect: one sentence for three epistemic states.** `no_match` emitted `No repository carries evidence for this request.` identically when (a) every eligible member was checked and none matched, (b) no lane ran because the request named no path or symbol, and (c) a lane was requested but no probe existed — measured in case (b) with `reposDeepProbed: 0`. A total non-observation was worded as a finding about the workspace. The fix is small because M147 had already built the right sentence and `nominateRepositories` was throwing it away: the deciding lane's proof reason already counts what it checked, so it is now preferred whenever a lane produced one, and a request that checked nothing says so, split by why. **Second defect: coverage grew with the workspace.** The model-visible reason interpolated one alias per unknown member (21,990 chars at 1000 members) beside 999 excluded-member records. Lists now cap at 4 with totals alongside; every verdict is computed from the TOTALS, so truncating the report cannot change what it concludes. **Third: support-scan coverage was invisible** — 21 members index the path, 8 are asked, and a short `supporting` list was indistinguishable from 'nobody else contributes'. Coverage now travels with successes as well as failures. **Claim model**: scope `member_local < scanned_members < enabled_members < workspace` (workspace is strictly wider on purpose — a disabled member was never in the population any lane asked, so no lane may speak for the workspace); negatives `not_observed < bounded_absence < authoritative_absence`. A partial scan earns a REAL negative over the members that answered and is blocked from escalating, rather than collapsing to silence. `refusedWithoutEvidence` and `omittedByBound` weaken identically but stay separate fields, because you repair an index and you raise a bound. Completeness is per capability: exact path/symbol lookups settle member-local absence, ranked retrieval never does however complete the sweep. **Access path is deliberately NOT an authority axis** — `indexed` and `fallback` run the same statement over the same rows. | **Consumer inventory 15 consumers / 5 producers: 4 real overclaims reproduced and fixed, 1 hypothesised overclaim NOT reproduced, 9 already truthful and left alone (§129).** The not-reproduced one is recorded with its structural reason: an outranked member cannot be mislabelled `definitely_absent`, because an `exact` match requires an absolute hint inside a registered root, which IS the tier-1 containment condition, so tier 1 has already decided and the path lane never computes a deciding proof there. **Corpus (§97): 15 scenarios executed against BOTH sides**, the predecessor imported from a detached worktree at `cc06012` — 2 defect_reproduced_and_fixed, 2 already_correct_wording_sharpened, 11 already_correct, **routing identical 15/15**, refused member never opened. **Bounded presentation** (real serializations, not projections): reason 320/2189/21990 -> 211/214/218 chars and member records 20/198/1998 -> 12/12/12 at 11/100/1000 members; routing summary 96,896 -> 990 bytes at 1000. **Provenance/dedupe 5/5 shapes already correct** (same path, same FQN, identical content, divergent content, missing worktreeId) — identity is `(worktreeId ?? alias, path, symbol)` and every component is required. **Ownership: no product surface emits an owner claim at all**; the strongest sentence is `<alias> selected on <tier> evidence`, verified across shared-path, tests-only, config/docs-only and wrapper-registered-first shapes. **Paired benchmark `cc06012` -> `2aaac75`, `provenanceValid=true`, `srcDirty=false`: frozen50 0/50 changed**, django 0/20 and cross_repo_30 0/30 with byte-identical semantic hashes; Top-1 38, Top-3 44, anywhere 48, symbol 31, missing 2, tokens 1832.4 — every figure equal on both sides and to the M148 baseline. **Derivation fingerprints unchanged**, proved behaviourally by mutating each of the 4 touched files and recomputing: `indexer_fingerprint`/`parser_fingerprint`/`schema_version`/`config_hash` byte-identical to M148's recorded values; anti-drift closure guard passes with NO new exemption. **Preservation**: M146 25, M147+M148-B 60, M148-A 20, M141 22, M145 77, M142 862, M140 37, M139 68, M149 new 32 — all 0 fail. **4471 pass / 0 fail / 49 skip / 276 files** (M148 baseline 4439/0/49/274; delta is M149's own controls). Both typechecks and `git diff --check` clean. **Real ARC/TCKDB read-only**: ARC ready, TCKDB_v2 `source_stale (head_changed)`, vtrace `index_corrupt` (all pre-existing); absent queries returned `bounded_absence` naming the 2 unchecked members; the no-hints query opened ZERO indexes; **every real index mtime and size byte-identical before and after**. No read consumer triggered index/init/migration/repair. Zero new DB queries — coverage is composed from observations the lanes already produced. | **Wire the workspace relevance/composition layer into a product surface BEFORE building M150.** The audit's most important finding is not a defect: `rg 'nominateRepositories|assembleWorkspaceProductContext' src/mcp src/cli src/runPipeline` returns nothing — M146-M149's claims are truthful and **nothing in the product consumes them**. Building cross-repository dependency semantics on top would add a second unreachable layer above the first. Recommended: route `get_code_context` through it and surface bounded coverage on `index_status`, so the claim boundaries become load-bearing and the next composition milestone has a real consumer to be truthful to. `M150 — Cross-Repository Evidence Composition and Dependency Semantics` is right AFTER that, not before. Also open, unchanged by design: M147's 11-member REAL control is no longer reconstructible (3 indexed repos remain), so member-scale bounding is synthetic (§103) and latency at scale stays an M148 projection |
| **M150** | functional `09a39e2` (operation semantics), `ee35b05` (mechanism facts), `9a81a1c` (mechanism scoring), `ab8e4f0` (discrimination fixes); final functional `ab8e4f0`; evidence = this commit | **MIXED at checkpoint `ab8e4f0`; still MIXED at final `ebc4fda`** (A **PASS**, B **PASS**, C **PASS**, D **MIXED**, E **MIXED**). The ARC failure is fixed and the generic mechanism vocabulary works; distributed ordering evidence is not delivered and one M142 case regressed. | **A symbol may name the subject without implementing the behaviour.** The ARC lead was a memoisation helper because `reaction`+`family` drove four signals and the requested OPERATION drove none — and `product_dicts[0]` was not merely unranked, it was absent from the index. Fixed in three parts: a typed behavioural operation derived from the existing grammar (`selection|ordering|fallback|caching|storage`, cue STRENGTH modelled so `where is the SELECTED family stored` is a storage question); twelve bounded mechanism-fact kinds derived from definition bodies at index time into an additive `symbol_mechanism_facts` table; and an operation-compatible relevance component gated on declared operation, fact compatibility and identifying subject relevance. `determine_family` 16 -> **1** and becomes the lead pivot with `product_dicts[0]` model-visible; `get_reaction_family` and `ARCReaction.family` hold **exactly 1.9000** — nothing is penalised, the decider gains evidence for a question the others do not answer. Cache/storage/identifier contrast controls all hold. `W_mech` (0.55/0.20, ceiling = direct) was fixed against the generic cases and negative controls BEFORE ARC was re-measured. | **Frozen50 0/50 byte-identical** (django 0/20, cross_repo_30 0/30; 38/44/48/31/2/1832.4 both sides; `provenanceValid=true`, `srcDirty=false`) — but those corpora predate M150 and carry no facts, so it proves no side effect, NOT that the gate holds with evidence present; that was measured separately on the ARC index (2549 facts). **ARC scale**: 7154 callables, 1624 with facts, 2549 facts, only **619 result-bearing**; `first_item_selection` 968 -> 59 result-bearing. Index 21.3s -> 22.4s (+5.1%); query-time source reads **0**. Negative controls clean: `first_character(name) -> name[0]` yields NO fact (singular operand, refused at extraction), sorting for display never reaches the direct tier. 46 focused tests; suite **4517 pass / 0 fail / 49 skip / 279 files**; both typechecks and `git diff --check` clean. `indexer_fingerprint` **intentionally moves** (new `src/indexer` module) so field indexes rebuild rather than being silently invalidated. **Regression: M142 `arc_gaussian_route_keywords` owner top1 true -> false** (top3 still true) — `decide` derives `selection` and a dozen Gaussian parsers each carry genuine result-bearing first-item selections, so the component is near-uniform there. Two candidate fixes measured and REJECTED (subject-match modifier broke the cache/ordering controls; raised floor was arbitrary). NOT done: `mechanism_support` role and statement slice, the dedicated M150 corpus and its metrics, TCKDB acceptance, full/incremental equivalence run. | **Finish M150 before M151.** The reachable retrieval core is not yet trustworthy enough to carry workspace routing, which was the whole argument for doing M150 first. Implement the bounded `mechanism_support` role + statement slice, build the discriminating corpus, and use it to settle the Gaussian regression on evidence: the open question is how mechanism evidence should discriminate WITHIN a topically relevant pool where many definitions genuinely perform the requested operation — ARC's selection query has one, its Gaussian query has a dozen. No live spend. |
| **M150-cont** | functional `ebc4fda` (subject alignment); final functional `ebc4fda`; evidence = this commit | **MIXED** (A/B/C **PASS**, D **MIXED**, E **MIXED**). The discriminator the checkpoint lacked now exists and the Gaussian regression is CLOSED; ordering support and the statement slice are still unimplemented, so D cannot pass. | **Operation compatibility is real relevance but not sufficient relevance.** Mechanism evidence is now tied to what the request asks about, decided from the mechanism's OWN operand and one hop of provenance - `direct_operand` / `local_producer` / `undecidable` reach the direct tier, `none` earns zero. Candidate path, file, class and domain are all excluded, because those are the signals that made the wrong candidates look plausible. The producer hop is load-bearing: `determine_family` reads `product_dicts[0]`, which encodes neither `reaction` nor `family`, while `get_reaction_family_products` encodes both. `cache_lookup`/`attribute_return`/`priority_lookup` are exempt from BOTH proofs for one reason - their statement form IS the behaviour, so their operand is the STORE, and testing a cache membership check against a caching question would refuse the only answer. A plural PRODUCER also now establishes collection shape, because the guard protecting `first_character` was silently refusing a fact at all to `xs = matching_backends_for(...)`. Weights stayed FROZEN at 0.55/0.20 - the corpus said the defect was discrimination, not magnitude. | **Dedicated 15-case corpus over a committed 13-module fixture repo, run through the PRODUCT path against all three roots.** M149 -> checkpoint -> final: correct lead 7/8/8, Top-3 10/12/12, anywhere 12/13/13, **same-operation wrong-subject bonus 0(no capability)/2/0**, negative-control bonus 0/0/0, module nodes 0/0/0 - the discriminator removed every wrong-subject bonus at zero cost. **M142 Gaussian owner Top-1 restored to true** (matching M149); TS-guess `anywhere` false -> **true** (gain); `which()` and ARC-class controls unchanged. ARC family: `determine_family` rank **1** lead pivot mech 0.55, `get_reaction_family` **1.9000 unchanged** mech 0 withheld with reason, `product_dicts[0]` visible. **Frozen50 0/50** byte-identical (`provenanceValid=true`, `srcDirty=false`) - still preservation-only, since those corpora predate mechanism facts. **full == incremental byte-identical** (24->25 facts both sides) and **no-op stable** - the equivalence gate the checkpoint omitted. **TCKDB same-checkout 0/6 leads changed, 1/6 sets** (the ordering query; attributed `decision_point_ranking`, lead stable). Suite **4525 pass / 0 fail / 49 skip**; typechecks and `git diff --check` clean; ARC+TCKDB authoritative indexes byte-identical. **Still absent: `mechanism_support` (so `get_all_families` is `not generated`, not ranked-and-dropped), the statement slice, the ordering query, and the section 106 dedicated preservation runners.** | **Finish M150-D; still not M151.** The causal chain is now known and stored: `determine_family` --provenance--> `get_reaction_family_products` --calls--> `get_all_families`, with the ordering fact at hop 2. Build the bounded two-step support discovery capped at 1 helper, admitted only on an ordering/priority fact the decision consumes, then the statement slice, then the ordering query, then the dedicated preservation runners. All four are now MEASURABLE against the corpus rather than arguable - that is the difference from the checkpoint. No live spend. |
| **M150-D** | functional `650e916` (mechanism support + decision slice); final functional `650e916`; evidence = this commit | **MIXED** (A/B/C **PASS**, D **MIXED**, E **PASS**). Support, slice and the ordering/selection distinction all land; the explicit ARC ordering query still leads on a symbol-name accident, which is the one blocker. | **Ranking found the decider; this retrieves the evidence that explains it.** `get_all_families` was classified FIRST - `not_generated`, not ranked-and-dropped - so it was a discovery problem and the fix is a role, not a score. Bounded causal discovery seeds only from selected pivots carrying mechanism evidence, follows the operand provenance recorded at index time, then ONE exact `calls` edge: determine_family --operand_provenance--> get_reaction_family_products --exact_call--> get_all_families. Two hops because two is the measured ARC chain. `resultBearing` is the negative control that makes it safe: a helper that sorts a list and RETURNS it establishes the order its caller consumes, one that sorts to log it does not, and both contain `sorted(...)`. The helper carries the ordinary score retrieval computed (zeros when it never competed); when support is full the weakest winner is DISPLACED and reported budget-dropped rather than the explanation silently discarded. Decision slices are their own content mode, real source never paraphrase, bounded by structure - and a budget-compressed decider now delivers the slice instead of a bare signature. `mechanism_support` stays a distinct value from `orchestration_support`. | **Four sides re-run on identical fixtures** after two incoherent fixtures were fixed (a decision documented in terms of *entries* whose helper spoke of *candidates* - the fixture was wrong, not the query). M149/ab8e4f0/ebc4fda/final: correct lead 7/9/9/9, Top-3 11/13/13/13, same-operation wrong-subject bonus 0(no cap.)/2/0/0, negative-control delivered 1/0/1/**0**, **ordering helper visible 2/4 -> 2/4 -> 2/4 -> 3/4**, **mechanism support 0/0/0 -> 1 at exactly the cap**, module nodes 0 throughout. Each phase moved only the rows it was built for. ARC: depth 2, **4 causal edges, 4 helpers examined, 1 selected, 0 source reads, 2.98 ms**; decider slice lines 647-650 (deciding line 648, 171 B), ordering slice 765-771 (line 769, 471 B). `determine_family` rank 1 lead; `get_reaction_family` **1.9000 unchanged**; `get_all_families` delivered as `mechanism_support`. §43/§44/§45/§46 PASS, **§47 FAIL**. Preservation: M142 Gaussian owner Top-1 **true**, TS-guess gain held, `which()` unchanged, 0 `<module>` nodes, exact-calls-only so M139 untouched. **Frozen50 0/50** byte-identical; **TCKDB 0/6 leads changed**, 1/6 sets (ordering query, `ordering_precedence_retrieval`, NEUTRAL); derivation fingerprints unchanged (retrieval-only). Suite **4534 pass / 0 fail / 49 skip**; typechecks and `git diff --check` clean; authoritative ARC+TCKDB indexes byte-identical. | **One focused piece closes M150; still not M151.** The ARC ordering query fails upstream of everything built here: `families`/`order` match file stems and hand `_dihedral_angle` symbol=1, while `get_all_families` is not generated at all. The generic `ordering_query` case PASSES and leads with the orderer rather than its consumer, so the operation distinction works - ARC's instance is blocked in candidate generation. Make an ordering-fact-carrying definition generable for an `ordering` request, then run the §81 dedicated preservation runners. No live spend. |
| **M150-E** | functional `ed8db5b` (operation-fact candidate generation); final functional `ed8db5b`; evidence = this commit | **MIXED** (A/B/C **PASS**, D **MIXED**, E **PASS**). The capability lands - a definition now enters the pool BECAUSE of indexed subject-aligned mechanism evidence when its name gives no lexical clue - but it does not yet outrank a lexical accident, so the ordering acceptance still fails. | **The last missing capability was not ranking; it was eligibility to be ranked.** Every other mechanism lane assumed the right definition was already in the pool, and for ARC's precedence question `get_all_families` was `not_generated`. The lane runs the pipeline backwards one step: declared operation -> fact kinds that DIRECTLY implement it (partial kinds may strengthen a candidate, never create one) -> the SAME subject-alignment policy, applied BEFORE admission -> at most 3 ordinary candidates. Admission is not selection, a role, or a score. **No access index was needed**: EXPLAIN QUERY PLAN already reports SEARCH USING idx_symbol_mechanism_facts_kind, 46 of 2566 rows in 0.73 ms, so no capability was invented for symmetry. One artifact fixed: an admitted candidate carried fts=0 and was judged as though its name matched nothing, purely because another lane found it first - now scored by the same `rankSearchCandidates` the lexical lane uses, which is a repair rather than a boost. | **Generation-time negative control is the headline: on the Gaussian route-keyword query the lane examined 64 owners and admitted 0**, refusing every parser; owner Top-1 stays **true**. Ordering query admits exactly 1 (`get_all_families`, rejecting 37 including `dfs`/`visited`, `get_expected_changing_bonds`/`r_label_dict`, `_all_available_years`/`years`). **Scale is flat**: 100/1k/10k facts -> 1.46/0.88/**0.67 ms**, work capped at 400 facts and 64 owners, **0 source reads**; ARC 0.73 ms, TCKDB 0.51 ms. Selection query preserved exactly (determine_family rank 1 lead + slice, get_reaction_family **1.9000 unchanged**, get_all_families still `mechanism_support`); cache/accessor/direct contrasts hold. Corpus across five phases: lead 7/9/9/9/9, Top-3 11/13/13/13/13, wrong-subject bonus 0*/2/0/0/0, **wrong-subject candidates admitted 0**, ordering visible 2/4->3/4, support 0->1, module nodes 0 throughout. **Frozen50 0/50**, **TCKDB 0/6 leads**, derivation fingerprints **unchanged** (retrieval-only), suite **4544 pass / 0 fail**, authoritative indexes byte-identical. | **One precise thing stands between M150 and PASS.** `get_all_families` is generated with correct ordering evidence at rank 24 and loses to `_dihedral_angle` at `lexical=1.0` - a pool maximum earned from the file stem `families.py` on a query saying *families* and *order*. That is an M142-class LEXICAL-DECOY problem, not a mechanism problem: every M150 lane behaved correctly here, and penalising the decoy by name is forbidden. Extend M142's generic-token down-weighting to path-stem-only matches so a candidate explained solely by a directory name cannot hold the pool maximum, then re-run the ordering acceptance and the dedicated preservation runners. Not M151 yet. No live spend. |
| **M150-F** | functional `fe5c220` (path-evidence gate); final functional `fe5c220`; evidence = this commit | **MIXED** (A/B/C **PASS**, D **MIXED**, E **PASS**). The path-only decoy is removed and root-caused generically; the ordering IMPLEMENTATION is still not the primary answer, so D cannot pass. | **A path can tell VTRACE where to look; it cannot prove which symbol answers the question.** Producer named exactly: `directEvidenceAnchoring.ts`, branch (a) of `resolveFileStemWord` - NOT FTS, path scoring, or the domain lane. It resolves a bare prose word to a file basename, picks the first top-level def out of that file, and SYNTHESIZES `lexical: 1 / final: 1.9` by tier. On ARC, `families` resolved to `linear_utils/families.py` and handed `_dihedral_angle` - a geometry helper - the pool's strongest score, above the ordering implementation M150 had correctly generated. M142 had already fixed the sibling branch (b); branch (a) was documented as deliberately left alone, sound reasoning about the FILE that silently extended to a symbol it did not cover. **Evidence-authority conflation, not weight.** The gate: a weak FILE-DERIVED mention may synthesize answer-grade relevance only for a definition with independent relevance (lexical | domain | bodyLiteral | testToImpl | mechanismEvidence). `path` and `symbol` are excluded - `symbol` is what the mention synthesizes, so consulting it would be circular. Predicate is caller-supplied because independence must be judged against a pool the lane cannot see; omitted means unknown and changes nothing. Strong mentions untouched. | **`_dihedral_angle` 1.9000/rank 1 -> out of the lead**, with no constant shaved, no threshold added and no ARC-specific exception. **Frozen50 moved 16/50 and EVERY quality metric is identical** - Top-1 38, Top-3 44, anywhere 48, symbol 31, missing 2 on both sides, tokens 1832.40 -> 1832.48; django 9/20 and cross_repo_30 7/30 the same story. Cause `path_only_relevance_gate`, quality **NEUTRAL** - support-slot composition only. TCKDB 1/6 leads changed (ordering query), NEUTRAL. M142 fully preserved: Gaussian owner Top-1 **true**, `which()`/ARC-class controls unchanged, all four behavioural cases unchanged. Corpus unchanged at lead 9, Top-3 13, wrong-subject 0, ordering visible 3/4, support 1, module nodes 0. Suite **4544 pass / 0 fail**; typechecks and `git diff --check` clean; derivation fingerprints unchanged; authoritative ARC+TCKDB indexes byte-identical. | **One question remains and it is scoring emphasis, not retrieval.** The ordering query now leads with `determine_family` (the selection CONSUMER) at 1.7639 while `get_all_families` - the ordering IMPLEMENTATION, correctly generated via `operation_fact` - sits at rank 22 on 1.0549. The query's vocabulary matches the consumer's name and docstring better than the implementation's. For an explicit ordering request, should a direct `ordering_established` fact outweigh a consumer's lexical advantage? The weights are frozen for good reason, so this needs its own measured phase against the existing corpus rather than a tweak. Not M151 until then. No live spend. |
| **M150-G** | functional `86fed3dd` (answer-role relation + subject-floor waiver); final functional `86fed3dd`; evidence = this commit | **MIXED** (A/B/C **PASS**, D **MIXED**, E **MIXED** — mandatory Frozen50/Django/cross_repo_30 paired comparison NOT run) | **The ARC ordering defect was never a mechanism-weight problem.** Measured on the checkpoint scorecard, `determine_family` carries **mechanism 0** on the ordering query — no compatible ordering fact at all — and led on subject signals alone (lexical 0.8632, domain 1.0000 vs the orderer's 0.2003/0.3333). Four scorecard components measure the SUBJECT and one measures the OPERATION, so a question that is entirely about the operation is still decided by the subject. **A bounded additive component is refuted by measurement, not preference**: ARC needs **+0.709** and the generic `rule_candidate_selector` fixture — the same shape with useless names — needs **+1.83**, which no constant in the bounded family (`positiveObjective` 0.36, `contrastPenalty` 0.75, `directAnswer` 0.95, `mechanismEvidence` 0.55) can supply without dominating every other signal on every behavioural query. So §37 Option B was rejected with numbers and Option C shipped: `operationRole.ts` adds **no magnitude**, only the one thing a per-candidate scorecard cannot express — a RELATION between two candidates. Whichever side implements the REQUESTED operation is placed immediately above the side causally linked to it and no higher (`1e-4` tie-break step, **zero numeric parameters introduced**, nothing chosen from the ARC gap). Symmetry is structural: the same pair reverses between paired queries because promotion follows the requested operation, never the fact kind or call direction. **Two defects the ARC case alone could never have exposed**, both found by the new corpus: (1) the mechanism subject floor read `Math.max(lexical, path, symbol)` — name/path evidence only — so a direct implementer whose author chose an uninformative name could never earn operation evidence even when its own operand named the subject exactly; waived now for `direct_operand` alignment ONLY (never `local_producer`/`undecidable`, which are not independent evidence). (2) The loop kinds record their producer in the fact's `subject` as a call expression with an EMPTY `provenance`, so a provenance-only walk never starts — which is also why `mechanismSupport`'s ordering visibility sits at 3/4. A third finding is a real capability limit: `routes_for` returns `[primary(config), fallback(config)]` where the list order IS the precedence and **no fact kind indexes it**, so `route_ordering` fails for an evidence reason, not a ranking one; adding a kind is a derivation change and was not attempted. | ARC ordering: `get_all_families` **rank 22 -> rank 1**, final 1.0549 -> 1.7640 — exactly `+0.0001` above the consumer, whose 1.7639 is untouched. ARC selection preserved byte-identical (`determine_family` rank 1 / 2.1256 / pivot, `get_all_families` still `mechanism_support`), so the paired reversal holds on ONE index. Gaussian preserved: 64 owners examined, **0 admitted**, `_user_requested_verytight` still leads. New 10-case paired corpus (`m150_operation_emphasis`, product path, deliberately useless names): `directImplementerBeatsConsumer` **2/8 -> 6/8**, paired role reversal **0/4 -> 2/4**, consumer leads 3 -> 2, wrong-subject operation bonus **0**, unknown-ordering overclaim **0**, `<module>` nodes **0**. 15-case corpus (§43): lead 9 -> 9, Top-1 9 -> 9, wrong-subject lead 0, ordering helper 3/4, mechanism support 1 — **Top-3 13 -> 12**, fully attributed: `backend_vs_frequency` IMPROVEMENT (expected answer now leads), `first_success_backend` REGRESSION and `two_hop_producer` REGRESSION (Top-3 only, score unchanged); the latter two are near-duplicate queries over one corpus with different correct answers. Lane cost: **0 source reads**, bounded <=24 consumers x <=4 per hop x depth 2. No schema/index-capability/derivation change. **4544 pass / 0 fail / 49 skip** (identical to the frozen baseline); 9 new focused role tests; both typechecks and `git diff --check` clean | **Do not start M151.** One phase on **answer-role DELIVERY**: ranking is now correct and delivery is not. ARC's ordering query ranks the orderer first but the capsule still delivers `determine_family` as lead pivot and the orderer as `support`; the 2 remaining generic pairs fail because the capsule returns `noContextResult` for subjects appearing only in bodies (`plugin`, `channel`) — a fully populated, correctly ordered pool and an empty capsule. **Pivot eligibility, not ranking, is the binding constraint**, and it reads organic subject evidence. Then re-run this corpus, the 15-case corpus, and the three MANDATORY paired suites (Frozen50/Django/cross_repo_30 against `2aaac750`), which this session did not run and without which no closure is available |
| **M150-H (closure)** | functional `2d3010e4` (answer-role delivery); final functional `2d3010e4`; evidence = this commit | **PASS** — M150 CLOSES (A/B/C/D/E all **PASS**) | **Ranking had been right for a whole phase and the product still shipped the wrong answer.** The audit located it in ONE function, `assignCandidateRoles.classify`, which states a single requirement three times — `directEvidence`, a `localEvidence >= 0.3` floor, `hubPenalty === 0` — and reads all three from NAME and PATH signals only. ARC's orderer arrived at pool rank 1 and was delivered as a `signature` because lexical 0.0466 < 0.5 and it carries a 0.0116 hub penalty for having seven callers; `alpha` and `process` were removed by the even earlier discard gate (`localEvidence <= 0 && !anyProximity`), which is why two generic cases produced a correctly ordered pool and an EMPTY capsule. **§9's order-of-operations hypothesis was refuted by measurement**: `operationRole` runs inside `hybridRetrieve` before nomination, so the pivot set was never built from a stale ranking — the loss was entirely in what the role layer accepts as evidence, the same blind spot M150-G fixed one layer up in the mechanism subject floor, restated downstream. Fix: answer-role evidence (`mechanismEvidence >= 0.55`, the direct tier) is admitted to those three conditions and the discard gate, and **nowhere else**; **no numeric parameter was introduced in this phase** and the `1e-4` relational step was not reinterpreted as magnitude. **Authority is granted to ONE candidate — the best-ranked direct implementer — and that bound is measured, not stylistic**: unbounded, it let `mixed.py::first_backend` lead a question about a different module's indirect choice because it too ends in `backends[0]`. Operand alignment is enough to SCORE a candidate and not enough to make it the answer when something else outranks it. `isLikelyTestCandidate` is evaluated first and was not waived. **A corpus denominator was corrected rather than forced** (§69): `route_ordering` expresses precedence as the order of a LIST LITERAL, which no fact kind indexes — measured, the symbol carries no fact at all — so it became a truthfulness control instead of a delivery failure; adding a kind is a derivation change. | ARC, measured against a `86fed3dd` worktree baseline on one index: **exactly ONE lead changed** — ordering `determine_family` -> **`get_all_families`** (rank 1, organic 1.0549, promoted 1.7640, delivered **pivot/full source**) — while selection, cache, storage, direct-identifier and Gaussian leads are **identical**. Selection still delivers `determine_family` pivot + `get_all_families` as `mechanism_support`/`mechanism_slice`; Gaussian still examines 64 owners and admits **0**. Generic delivery corpus (11 cases, uninformative names, product path): direct-implementer Top-1 **2/9 -> 8/8**, beats-consumer **2/8 -> 7/7**, `capsuleLeadsImplementer` **8/8**, **`pool_vs_capsule_agreement` 7/7**, paired POOL reversal **0/4 -> 3/3**, paired CAPSULE reversal **3/3**, consumer leads **3 -> 0**, **empty capsules despite a deliverable implementer 2 -> 0**, wrong-subject bonus 0, overclaim 0, `<module>` 0. **Frozen50 `2aaac750` -> `2d3010e4`, `provenanceValid=true`, `srcDirty=false`, `authority=authoritative` both sides: 16/50 changed, 0 lead changes, 0 gold-visibility flips, 0 quality-metric changes** (all 16 attributed to `path_only_relevance_gate` from `fe5c220`, NEUTRAL). **Isolation `86fed3dd` -> `2d3010e4`: `pass=true`, 0 changed, semantic hashes byte-identical on BOTH suites** — SWE-bench tasks declare no behavioural operation, so no answer-role authority can exist and this phase contributes zero frozen-suite movement. TCKDB **1/6** leads changed, the explicit ordering query, to a definition carrying `ordering_established` + `priority_lookup` where the old lead carried only `fallback_branch` = **IMPROVEMENT**. 15-case corpus: lead 9 -> 9, Top-1 9 -> 9, **Top-3 13 -> 10**, all safety metrics clean; all three movements have the expected answer at pool **rank 4 before AND after**, so they are pre-existing RANKING limits surfaced (not caused) by delivery now agreeing with ranking (§39). **4602 pass / 0 fail / 49 skip**; 17 new focused tests; both typechecks and `git diff --check` clean; 0 source reads; schema/derivation/index capability unchanged | **M151 — Wire Workspace Routing into Product Surfaces.** The single-repository behavioural chain is closed end to end: subject + operation -> subject-aligned mechanism evidence -> candidate generation -> implementer/consumer relation -> answer ordering -> pivot eligibility -> pivot ordering -> bounded real-source delivery. Three limits are recorded and none blocks M151: two 15-case queries want an answer their POOL ranks 4th (a ranking question about near-duplicate queries, not a delivery one); list-literal precedence has no fact kind; `mechanismSupport` reads only `provenance` while the loop kinds record the producer in `subject`, which is why ordering-helper visibility stays 3/4 — `operationRole` already reads both and is the model for that repair |

| **M151** | functional `01be7197` (route product requests through the workspace router); final functional `01be7197`; evidence = this commit | **MIXED** (A PASS audit; B PASS wiring; C PASS bounded metadata; D PASS product corpus; **E MIXED** — two mandatory §133 gates cannot be reported clean AND honestly attributed) | **The gap was not that the router was unused — it was that a workspace DISABLED the product.** `hasMultiRepoRequest` tested whether a workspace EXISTED rather than what the request asked for, so a `workspace.json` at the bound root turned every `get_code_context`/`run_pipeline`/`get_context_capsule` call into `invalid_request`, and BOTH remediations the message advised ("omit repos or select exactly one") hit the same gate — an agent following it loops. Measured through `defaultMcpToolRegistry`, not read off the source. Transitive reachability of the workspace layer from the product entry points: **3/9 -> 9/9**. **The seam is fixed by one constraint**: `run_pipeline` derives the v1 orchestration AND the product context from ONE `db`, so routing at the product producer would leave a single response describing two repositories. Routing therefore runs BEFORE the binding, and everything downstream is the code M150 froze, unchanged. It is inserted only into M132's lowest precedence branch, so an explicit `repo_root`/`repos` is never overridden. **Two judgements worth naming.** (1) Support composition is opt-in: discovering supporters means running the indexed lanes even when an index-free hint already decided, so the default path would open indexes looking for repositories that merely COULD contribute — off by default keeps a workspace request at one retrieval and makes "another member exists" unable to change the lead's answer, asserted rather than argued. (2) A sole positive match now leads with `uniquenessProven: false`: M147 withholds `selected` when a member could not be checked, which is right for a uniqueness CLAIM and wrong for choosing where to LOOK — otherwise one stale member turns every symbol query in the workspace into a refusal (§88). **Prose cannot route**: a hint needs a separator plus an extension, or an underscore/qualifier/call/backtick — a bare all-caps token is inert, so a member named ARC is never chosen because a sentence said ARC (§74/§75). **`index_status` was the other unbounded surface**: one full record per member plus whole-workspace alias lists. Verdicts now come from the full census and only a bounded sample is serialized; `omittedByBound` counts records not shown and is INDEPENDENT of `coverageComplete`, which stays an epistemic claim. | Product corpus **16/16** through the real MCP surface (§100), 12 answered + 4 correctly declined (unknown alias, duplicate symbol, ambiguous path, all-refused). Real repos: **§63 ARC selection -> `determine_family` lead, §64 ARC ordering -> `get_all_families` lead** — M150's headline results preserved through the wired path; §66 exact symbol routes to ARC by evidence; §76 TCKDB -> `PropertyTableConfig`; §77 mixed 3-member workspace routes ARC-identifier -> arc and host-identifier -> host; §74/§75 prose "ARC" reaches the configured default, NOT a name-route. **Single-repo parity: context semantic hash IDENTICAL across no-workspace / 1-member / 2-member** (§102), the third being the §28 hard control. **Response scale flat**: routing bytes 1568/1576/1586 and total 20338/20345/20357 at 11/100/1000 members — 18 bytes for 989 members. **`index_status` flat**: 10039/10044/10051 bytes, `repos` = 4 always, `omittedByBound` 7/96/996; an all-ready 11-member control shows **`coverageComplete: true` WITH `omittedByBound: 7`**, the shape that proves truncation and completeness are independent. **Index opens: refused indexes opened for retrieval = 0 at every scale**; inspected-for-route = 1. Latency measured not projected: get_code_context **51.6/47.0/57.4 ms** at 11/100/1000 (does not scale with workspace size). **Paired `6117f5f2` (== M150 functional `2d3010e4`, no src/ diff) -> M151: 0/50 changed, provenanceValid=true**, django 0/20 + cross_repo_30 0/30 — and §112-compliant about WHY: these suites call retrieval through `createHistoricalEvaluator` with one explicit root and never build an MCP request, so the router is structurally off their call path; zero movement rules out a side effect and is NOT evidence the wiring works (§113). **4599 pass / 0 fail / 49 skip** (M150 tree measures 4561 in this same environment, so +38 tests, 0 changed results; M150's recorded 4602 is not reproducible here and was not adopted); both typechecks and `git diff --check` clean; index schema and derivation fingerprints unchanged; product schema additive, no version bump | **M152 — Cross-Repository Dependency and Evidence Composition**, but two repairs come first and both are M151 findings. **(1) Read paths mutate the LEAD repository's index**: three consecutive `get_code_context` calls against ARC produced three different file hashes, and the M150 baseline reproduces it exactly — pre-existing `withReadyRepoDb` -> `openIndexerDatabase` schema-initializing whatever retrieval binds to. Everything M151 ADDS is read-only (`{ readonly: true }` probes and supporting composition; a probed non-lead member is byte-identical, asserted in the suite), so §21/§90 hold for the new paths and not for the old binding. This is why E is MIXED and it is the first thing to fix, because the whole workspace story now depends on it. **(2) `index_status` is O(members) in WORK** — 360 ms at 1000 members, because `inspectWorkspaceRepoStatus` runs a full readiness probe per member; the response is bounded, the work is not. **Also standing**: no behavioural repository-relevance lane exists in M146-M149 (four tiers only: explicit route, path containment, indexed path, exact symbol), so a query naming no path and no identifier reaches the configured default or abstains — §26/§73-§75 forbade inventing one, so this is a reported ceiling and §77's "ARC query -> ARC" holds only when the query names an ARC identifier or path. ARC/TCKDB were rebuilt under explicit user authorization (both were `possibly_stale/schema_changed`, identically at the M150 baseline) via the supported `index_repo` path with before/after identity recorded; stale->fresh differences are NOT attributed to M151 |
| **M151 (closure)** | pre-closure functional `01be7197`; final functional `87b3f5a4` (pin what a product read may change); evidence = this commit | **MIXED** — M151 CLOSES (A/B/C/D **PASS**, E **MIXED**) | **The closure gate was wrong, and measuring it is what showed that.** The brief traced the read-path mutation to `withReadyRepoDb -> openIndexerDatabase` and asked for a read-only binding. Decomposed by layer against a fresh index, `openIndexerDatabase` writes **nothing**: bare open, `openIndexerDatabase`, `initializeSchema` alone and a read-only open with SELECTs are all byte-identical, with page count, freelist, object count and `schema_version` static. On a CURRENT index `CREATE ... IF NOT EXISTS` is a genuine no-op; the +110,592 bytes seen on ARC earlier was legacy-index schema completion, once, and does not recur. What actually writes is **three supported features** persisting on purpose: `captureVisibleCapsuleObservationBestEffort` (unconditional, feeds `search_memory`/`get_session_context`), `persistCapsuleManifestBestEffort` (the `capsuleManifestId` IN the response, feeds `check_capsule_staleness`), and `persistDeferredVexpRef` (the ref handed to the caller, feeds `expand_vexp_ref`) — plus one genuine `last_accessed_at_ms` heartbeat. **So `index.sqlite` holds two kinds of state and a file hash cannot tell corrupted evidence from a recorded lookup.** Suppressing the three was rejected: withholding a deferred ref emits an unresolvable reference, and suppressing deferral instead changes delivered content and breaks the frozen M151-D parity gate. Splitting the store was rejected as out of scope: ~31 non-test source files + 19 test files plus migration/lifecycle/concurrency is a storage milestone, not the tail of a wiring one. **The gate was replaced by a per-table one** and pinned in `src/db/indexTableFamilies.ts`, read by both the regression test and the evidence runner so they cannot drift, with an unclassified table failing rather than inheriting a default. | Table-family preservation over **3 repositories (fixture, ARC, TCKDB_v2) x 4 product surfaces x 3 repeated calls**: `classificationComplete` **true**, `repositoryDerivedUnchangedEverywhere` **true** (symbols, edges, FTS, documents, mechanism facts, run states, index_runs), `schemaUnchangedEverywhere` **true**, `objectCountUnchangedEverywhere` **true** (no migration/schema install), `derivationFingerprintUnchangedEverywhere` **true**, `onlyDocumentedFamiliesMutated` **true**; `index_status` writes **nothing** on every repository. 7 focused tests also pin: a read-only handle writes nothing and **rejects DDL structurally**, and a product read against an unindexed repo **does not create an index**. Real-repo gates re-run on the rebuilt indexes and reproduce M150 exactly: **ARC selection -> `determine_family`**, **ARC ordering -> `get_all_families`**, ARC exact-symbol routes by evidence, TCKDB -> `PropertyTableConfig`, mixed 3-member workspace routes ARC-identifier -> arc and host-identifier -> host, prose "ARC" reaches the configured default and is NOT a name-route. **Paired `6117f5f2` (== M150 functional `2d3010e4`, no src/ diff) -> `87b3f5a4`: 0/50 changed, provenanceValid=true, srcDirty=false**; **isolation `01be7197` -> `87b3f5a4`: 0/50, provenanceValid=true, srcDirty=false** (the closure commit is imported by no product path). **4606 pass / 0 fail / 49 skip** (+45 over the M150 tree's 4561 in this environment); both typechecks and `git diff --check` clean; index schema and derivation fingerprints unchanged | **M152 — Separate repository index state from product session state.** `index.sqlite` = repository-derived evidence, immutable under product reads; `session.sqlite` = observations, capsule manifests, deferred refs, sessions, project rules; all three features preserved and delivered content unchanged. This goes BEFORE cross-repository semantics deliberately: once workspace composition writes observations and manifests for several repositories in one request, commingled evidence and runtime state gets materially harder to reason about, so establish the ownership boundary first. **M153 — Cross-Repository Behavioural Routing and Evidence Composition**: behavioural nomination when no path/identifier exists (M146-M149 have four tiers only, so such a query reaches the configured default or abstains — a reported ceiling, not a defect), bounded supporting-repository composition, ownership vs support, cross-repo dependency/evidence chains. The `index_status` O(members) census cost (360 ms at 1000; response bounded, work is not) is a small preparatory performance workstream attachable to either |
| **M152** | functional `e50fac76` (separate product state from the repository index), `72ce221c` (session state outliving its index run); final functional `72ce221c`; evidence = this commit | **PASS** (A ownership/scope audit PASS; B session store + legacy migration PASS; C observations/manifests/refs rewired PASS; D reindex + staleness lifecycle PASS; E real ARC/TCKDB migration + preservation + paired benchmark PASS) | **M151's unprovable gate was unprovable because the premise was false, and the fix is physical, not procedural.** `index.sqlite` held repository evidence AND the state three supported features persist on purpose, so a changed hash meant either "retrieval corrupted the index" or "`search_memory` recorded a lookup" — opposite consequences, one measurement. M152 moved observations, sessions, manifests, project rules and deferred refs into `session.sqlite`, leaving 27 index tables and **0 product/session tables**. **Authority is carried by a branded type** (`SessionDatabase` / `WritableSessionDatabase`), which is also how every call path was FOUND: the compiler enumerated ~50 files rather than a grep, and the one surface it could not protect — `src/mcp/tools.ts`, which carries `@ts-nocheck` — had to be rewired by hand and is the milestone's standing weakness. **The session repositories were moved OUT of `src/db`**, which is content-hashed into `indexer_fingerprint`: while they lived there, changing how vtrace remembers a tool call invalidated every stored index in existence, a lifecycle coupling that would have survived the physical split. **The foreign keys to `index_runs` could not cross a file boundary and are gone**; `source_run_id` survives as the provenance value it always was, validated on write. That deliberately changes one behaviour: a manifest whose source run disappears used to be CASCADE-deleted, collapsing "exists" and "is current" into one event, and is now retained and reported stale. **Validation surfaced a defect the split itself creates**: independent lifecycles make `comparisonRunId < sourceRunId` reachable (rebuild the index from scratch, run ids restart, session rows still name run 11), and both staleness paths THREW on it — previously unreachable because the observations lived in the file being deleted. Throwing would have taken out `search_memory` for a whole repository; both now report `source_run_unavailable` with no invented per-item detail. | **Central invariant, measured on real migrated ARC**: `index.sqlite` byte-identical across `get_code_context`, `run_pipeline`, `get_context_capsule`, `search_memory`, `get_session_context`, `index_status`; `index_status` writes nothing at all. The M151 family classifier now reports **`sessionWrites=0` into the index on all 12 real product calls** across 3 repositories, with `derivationFingerprintUnchangedEverywhere`. **Real migration via the `index_repo` seam**: ARC 4,100 legacy rows / 11 families / 3 ms, TCKDB_v2 851 rows / 2 ms; **exact row parity, 0 duplicates, 0 loss, ids preserved** on both; H0 == Hfinal on both. Migrated manifests resolve and report **stale** after reindex (§145 on real data); migrated deferred refs resolve; **0 unresolvable refs emitted**. Rehearsed on isolated copies of both real indexes first — all gates green before authoritative state was touched. **Paired `87b3f5a4 -> 72ce221c`, provenanceValid=true, srcDirty=false: Frozen50 0/50, Django 0/20, cross_repo_30 0/30**, structurally expected since these suites read only repository-derived tables. M151 product corpus and real acceptance unchanged (`determine_family` / `get_all_families` leads preserved, both indexes unchanged). **4,633 pass / 49 skip / 0 fail**; both typechecks and `git diff --check` clean. Cost accepted: `schema_version` moves once, so every pre-M152 index is `schema_incompatible` — the same `index_repo` run that re-derives it is the one that drains its session rows (ARC 36 s, TCKDB_v2 ~4 min). One PRE-EXISTING failure attributed by measurement, not assumption: `m138_memory_provenance_smoke` hard-codes ARC-generation numbers, and ARC indexed from identical source under M151 and M152 code produces **byte-identical** impact output. | **M153 — Cross-Repository Behavioural Routing and Evidence Composition**: repository nomination without explicit path/symbol hints, ownership vs support, bounded multi-repository evidence composition, cross-repository evidence chains, repository-level operation/subject alignment. M152 came first for a structural reason now discharged — a request composing evidence from several repositories writes manifests, observations and refs whose provenance is far harder to reason about while they share a file with the evidence they describe. Two carried limitations: `src/mcp/tools.ts` is `@ts-nocheck`, so the type-level store authority cannot protect the largest product surface; and `index_status` at 1000 members remains ~360 ms, bounded and deliberately not optimised |
## M144 standing findings

- **Count the LOCALIZING evidence, not the evidence** (M144): 23 of the frozen 50
  carry failure-like text, but only 13 carry text that names a PLACE. The gap is
  almost entirely exception class names — the single most common form, present in
  18 cases and the only evidence in 10 of them — which say what went wrong and
  nothing about where. Any activation number that pools symptom vocabulary with
  localization evidence overstates reach by roughly 2x.
- **Then subtract what already works** (M144): 10 of those 13 already reach gold
  top-1 on the predecessor. A capability's headroom is `localizing evidence` MINUS
  `already solved`, and here that was 2 cases out of 50 before a line was written.
  Measure both numbers before designing, or the design will be sized for the wrong
  problem. (Same shape as M140-C's "0 changed cases means the gate never opened".)
- **Traceback depth does not identify the edit site, and the corpus proves it both
  ways** (M144): the deepest in-repository frame names the gold file in 4 of 6
  cases and the shallowest in 3 of 6. `psf/requests-1724` needs the deepest;
  `pydata/xarray-3677` needs the SHALLOWEST, because its deepest in-repo frame is
  `common.py::AttrAccessMixin.__getattr__` — the symptom site — and it currently
  passes. A depth rule would have traded one case for another. What was safe to act
  on is not depth but MEMBERSHIP: whose code is this?
- **`site-packages` is not a synonym for "someone else's"** (M144): django-12774's
  entire traceback runs through `/app/venv/.../site-packages/django/db/models/query.py`,
  which IS the project's own source and IS the correct localization, while
  `/usr/lib/python3.10/sre_parse.py` at a comparable-looking path is not. No prefix
  rule separates them. Only a match against the indexed file list can, which makes
  repository membership an INDEX question, not a string question.
- **A guard's precondition must be evaluated where it was defined, not where the
  new rule looks** (M144): M142's completeness check asks "was this traceback cut
  off?" and answered it by looking after the frame it selected — which was always
  the deepest. Once M144 could select an EARLIER frame, that same code would have
  started asking "is there an exception line after this middle frame?", which is
  trivially true and would have silently re-enabled `pylint-8898`'s truncated
  stack. The fix is one line — measure completeness after the deepest frame
  regardless of selection — but the failure mode is invisible unless the guard's
  intent is separated from its implementation.
- **Two regexes matching the same text will shadow a filter applied to one of
  them** (M144): a complete frame is matched by BOTH the `File "...", line N, in
  name` shape and the bare `line N, in name` tail, at the same offset, and only
  the first carries a path. The repository filter rejected the stdlib frame and
  the pathless duplicate immediately re-admitted it — the change measured as a
  perfect no-op and looked like a refuted hypothesis. Deduplicate overlapping
  matches by position, preferring the variant that carries the evidence.
- **A deletion probe measures the wrong thing when the deleted text is also
  corpus** (M144): the cheapest test of "what does external-frame noise cost" was
  to delete non-resolving frames from the task and re-run. It reported a gain on
  `requests-1724` and a LOSS on `xarray-3677`, and the loss was an artifact —
  removing the segments also removed lexical tokens the scorer was using. It was
  still worth running (it bounded the effect in minutes) but a text-level probe
  cannot stand in for a signal-level mechanism. Verify a refutation with the real
  mechanism before believing it.
- **A path that resolves is not a path that was meant** (M144):
  `/Users/hwkns/test_requests.py` is a file on the bug reporter's laptop, and it
  resolves cleanly to the repository's own `test_requests.py` because they share a
  full path segment. Segment-boundary anchoring does not prevent this and a
  basename fallback is not the cause (basename-only resolutions: 0). Membership is
  safe for REJECTING foreign frames and unsafe as evidence of authorial intent —
  a distinction M145's workspace identity work should absorb.
- **The committed workspace indexes under `results/workspaces/` have drifted from
  the prepared corpora** (M144): running the retrieval eval against them yields
  Top-1 37/50 where the provenance-valid paired protocol yields 38/50, differing
  on `pallets__flask-5014`. Same source, same code, different index. Exploratory
  probes may use them; no milestone number may. (Third recurrence of M139's stale-
  index finding, from a new direction.)
- **A paired benchmark's corpora need the same SOURCES, not the same preparation
  SHA** (M144): preparing 100 fresh target corpora ran at ~8 minutes each — 13
  hours — for a comparison in which no corpus could differ, because M144 changed
  zero files under `src/indexer`, `src/parsers`, `src/db`, `src/fs` or
  `src/documents`. `sameTargetCorpusHash` is the property that must hold and it is
  checked per suite; M142 §82 already recorded the null control. Check what the
  gate actually verifies before spending a day satisfying its letter.

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

## M145 standing findings

- **An identifier built from a path answers "which location", not "which
  thing"** (M145): `repositoryId` and `worktreeId` are hashes of the git common
  dir and the worktree root, so a repository deleted and replaced by an
  unrelated one at the same path produced byte-identical ids and a readiness
  verdict of `repositoryCompatible=true, worktreeCompatible=true`. The swap was
  still refused downstream because two repositories cannot share a commit SHA —
  but as `source_stale / head_changed`, which is a true answer to a question
  nobody asked. Before trusting an id, ask what it is a hash OF.
- **Filesystem instance evidence is cheap and decisive where path hashes are
  not** (M145): `stat` on the git dir gives device, inode and creation time in
  0.007 ms and separates replacement (distinct), move (preserved), `cp -r`
  (distinct), clone (distinct) and sibling worktrees (common dir shared). The
  semantically prettier alternative — root-commit lineage — measured 3 ms on ARC
  only because ARC has a commit-graph, and walks the whole history without one.
  Measure the pretty option's cost before preferring it.
- **Evidence that can only refute needs a three-valued comparison** (M145): the
  instance check returns `true`, `false`, or `null` for "no claim", because a
  manifest written before the field existed says nothing and two silences are
  not agreement. M132 settled the same policy for worktree roots; the shape
  recurs whenever a new field is added to an existing artifact.
- **A boolean membership predicate hides the case that matters** (M145): "does
  this path belong here" has no honest answer when two registered repositories
  both index `src/foo/bar.py`, and any tiebreak — order, alias, path length — is
  a semantic decision disguised as a lookup. Make ambiguity a status and fail
  closed. The collapse back to one repository is exact: with one scope
  `ambiguous` is unreachable and `exact` implies a suffix match.
- **A named location outranks a matching filename** (M145): acceptance caught an
  absolute path inside one member turning `ambiguous` the moment a second member
  indexed the same relative path. `/w/a/src/foo/bar.py` names a location; a
  repository that merely contains `src/foo/bar.py` does not contain it. Without
  the precedence, adding an unrelated repository moves an answer that was
  previously unambiguous — the exact invariance a workspace must protect.
- **Registration metadata that refreshes itself cannot detect anything** (M145):
  the workspace config records identity at registration and reads it back
  verbatim. Recomputing it during an unrelated rewrite would silently re-bless a
  path whose repository had been swapped, destroying the only evidence of the
  swap.
- **`primaryRepoAlias` defaulted to the first entry** (M145): normalization
  filled it in from `repos[0]` when the file omitted it, which makes iteration
  order a routing decision. The fix is to record WHETHER the file named one, not
  to change the fallback — the field is still needed for display.
- **A written-but-never-read field is a latent bug with a paper trail** (M145):
  M114 wrote `worktreeId` into the index lock owner record and nothing ever
  compared it, so a copied `.vtrace` made an unrelated worktree look permanently
  busy. When auditing identity, grep for who READS each field, not who writes it.
- **`indexer_fingerprint` content-hashes `src/indexer` and `src/db`** (M145): any
  edit there — including one that cannot affect what gets indexed, such as lock
  ownership — invalidates every existing index as `schema_incompatible ->
  full_rebuild`. Measured: ARC went from `source_stale` under M144 to
  `schema_incompatible` under M145. Budget for it, or keep the change out of
  those directories.
- **The benchmark and acceptance runners bypass readiness entirely** (M145):
  they open `index.sqlite` directly, which is why M142-era prepared corpora and
  the ARC/TCKDB indexes still answer under a changed fingerprint. Convenient,
  and a trap: a fingerprint-invalidating change looks free in every measurement
  and is not free in the product.
- **Retrieval takes `(db, repoRoot)` and no workspace input** (M145): this is why
  "adding a repository cannot change a routed answer" is provable rather than
  hopeful, and why 0/50 changed cases was the expected result. State the
  structural reason alongside the measurement — a green benchmark alone would
  not distinguish "cannot happen" from "did not happen this time".
- **The project compiles with `strict: false`, so a literal-boolean `ok` does not
  narrow a union** (M145): `route.ok ? a : b` fails to discriminate and needs an
  explicit `route is Failure` guard. Costs an hour if rediscovered.

## M146-A standing findings

- **A fingerprint list is a claim about an import closure, and only one of them
  is checked by a computer** (M146-A): coverage was a hand-listed set of
  directories; the boundary that matters is what the write path actually
  imports. Two derivation-relevant functions had drifted across it, and neither
  was findable by reading the list. Walk the closure.
- **Type-only imports must be excluded or the guard inverts its own purpose**
  (M146-A): following all imports from the index entry points reaches 66 files,
  29 unfingerprinted — but the extra 23 are type chains through
  `src/memory/types` into `capsule/skeleton/projectRules`. Hashing those would
  make every ranking edit invalidate every index, which is the failure the
  exclusions exist to prevent. Value imports only: 43 files, 5 exempt, 0
  unclassified.
- **`src/retrieval` was excluded as "query-time" and was not entirely
  query-time** (M146-A): `buildFtsSearchText` built the stored FTS rows from
  there. A directory name is not a contract. The honest fix is to MOVE the
  write-time function, not to hash the 1737-line ranking file around it —
  otherwise the exclusion that keeps ranking edits free is lost.
- **Refusing an index is only half a contract; the other half is that the
  recommended rebuild rebuilds** (M146-A): `reindexRepo` compared a different,
  smaller set of fingerprints than readiness did, so a correctly-refused index
  was "fixed" by a no-op that then stamped the new fingerprints onto the old
  content — strictly worse than never refusing it, because the wrong state
  became permanent. When a check gains a field, grep for every OTHER place that
  answers a version of the same question.
- **The bug is at the user's next action, not at the verdict** (M146-A): the
  readiness fix measured clean and looked finished. Following the workflow one
  step further — run the rebuild it recommends — is what exposed the severe
  defect. Test the remedy, not just the diagnosis.
- **`schemaCompatible` bundling derivation is fine; SAYING "schema changed" is
  not** (M146-A): both need a full rebuild, so the boolean can stay joint, but
  `index_status` interpolates the reason into a sentence users act on. The
  smallest truthful fix is a new reason value, not a new field, a new state, or
  a renamed boolean — M141's meanings all survive intact.
- **An exemption needs a behavioural control or it is just a comment**
  (M146-A): each unfingerprinted module in the closure is pinned by a test that
  mutates the real file and asserts that neither the fingerprints nor the
  persisted index moved. A rationale that stops being true then fails there
  instead of silently widening the hole.
- **`config_hash` conflates scope with construction** (M146-A, unfixed):
  it covers `scanRepo`/`ignoreRules` (which files are in scope, genuinely a
  source-correspondence question) and `documentChunks` (how chunks are built,
  genuinely derivation). So a chunking change reports `source_stale /
  incremental_refresh`. It fails closed and the reindex path does a full
  rebuild anyway, so this is a labelling imprecision, not a safety gap — but it
  is the cheapest remaining truthfulness fix.

## M146-B standing findings

- **The index-free evidence column is not empty, and that is the whole design**
  (M146-B): an absolute path inside a registered root is decided by the request,
  the registration and the filesystem — nothing derived. So a repository whose
  index has been refused can still be IDENTIFIED as the right one, which is what
  makes `not_ready` sayable instead of the misleading `no_match`. Before
  building a router, sort every signal by whether reading it requires an index
  the runtime still agrees with.
- **A stale index that can probe will select itself** (M146-B): the failure is
  circular and self-concealing — obsolete semantics answer a symbol probe, the
  repository wins routing on that answer, gets rebuilt, and its result is
  presented as current with nothing recording that the decision was made by
  rules already refused. Gate the evidence, not the result.
- **Assert on which indexes were OPENED, not on which repository won**
  (M146-B): a router that picks correctly while consulting a refused index
  passes every outcome-only test. The probe factory records each member it is
  asked to open, which is what turns "the stale index was never consulted" from
  a claim into a measurement.
- **Tiers beat scores when calibration across sources is unestablished**
  (M146-B): nothing shows A's 1.9 outranks B's 1.8, or that rank 1 in A is worth
  rank 1 in B. A blended score would also have to break ties, and order, path
  length and alias are all semantic decisions in disguise. Highest tier with
  evidence decides; two inside it is ambiguity.
- **Aggregation may consume local rank but not local score** (M146-B): rank is
  meaningful within a repository by construction. Admitting in rounds of rank
  gives the primary's best candidate the lead before any support is considered,
  which satisfies "cross-repo mode must not evict a direct answer" without a
  special case.
- **Routing must stay query-time or ranking tweaks become index invalidation**
  (M146-B): persisting repository relevance inside an index would drag routing
  into the M146-A derivation fingerprint, and every routing edit would rebuild
  every index. The closure guard was re-run to confirm the new workspace code
  did not enter the index write path.

## M146-B (final) standing findings

- **A bound that makes cost independent of scale can silently make an answer
  wrong** (M146-B): `maxDeepProbes` exists so workspace size never sets query
  cost, and it worked — but probing a PREFIX of the ready members cannot
  establish that a match is unique, and the code reported `selected` anyway.
  Measured with ten members, a cap of eight, and a symbol in the first and last.
  Worse, the winner was whichever survived the slice, so the answer depended on
  registration order past the cap. When you cap a search, ask what claim the
  uncapped version was making, and whether the capped one can still make it.
- **Compose the seam, do not modify it** (M146-B): wiring workspace retrieval by
  calling `assembleProductContext` per selected repository meant repository-local
  semantics could not move — it is the same call — and made single-repository
  preservation provable STRUCTURALLY, by asserting no production file outside
  `src/workspace` imports the router. A green benchmark alone would not
  distinguish "cannot happen" from "did not happen this time".
- **Opt-in defaults are load-bearing when they gate cost** (M146-B): collecting
  supporting repositories requires running the indexed lanes even when an
  index-free hint already decided. Enabling composition by default would have
  turned the measured zero-probe decisive path into an index-opening one. The
  default is the measurement.
- **Real repositories were both unusable before the acceptance could run**
  (M146-B): ARC reported `derivation_changed` and TCKDB_v2 `schema_changed` —
  the expected consequence of M146-A's fingerprint change, and the first real
  instance of the scenario B was built for. Budget a rebuild (ARC 31 s, TCKDB
  123 s) into any milestone whose acceptance uses real corpora after an
  index-affecting change.
- **`cross_repo_30` is not a workspace benchmark** (M146-B): every task in it
  targets ONE repository. It is a single-repository preservation suite and is
  recorded as one; the workspace corpus is named separately.
- **Re-execute both sides rather than quoting the historical baseline**
  (M146-B): this harness invocation measured Top-1 38 and 1832.4 mean tokens on
  BOTH sides, where the M145-era row records 39 and 1850.14. Copying the
  historical numbers would have manufactured a regression that did not exist;
  what the gate needs is the two sides agreeing, which they did exactly.

## M147 standing findings

- **When a bound looks inherent, measure what it is bounding** (M147): M146 capped
  deep probes at eight because probing was expensive, and the ceiling that
  followed — global uniqueness unprovable — read as architectural. It was a
  missing index. `symbols` had an access path on `(file_id, start_byte, id)` and
  none on either name column, so every membership question planned as a full
  scan. Before accepting that a cost forces a correctness compromise, look at the
  query plan.
- **Absence is the expensive direction, and benchmarks hide it** (M147): a
  present name exits at the first matching row, an absent one cannot stop until
  it has considered every row. Measured on the same query: ~5 us present vs
  1,332 us absent on ARC, ~9 vs 4,974 on TCKDB. Anything benchmarked only on
  names that exist will look fast and be slow at exactly the job a uniqueness
  proof needs.
- **The cheapest correct structure was the one that had no lifecycle** (M147):
  Bloom at 10 bits/name is smaller and faster per lookup than the direct probe,
  with zero false negatives measured. It lost because it is a second persisted
  artifact — its own staleness contract, its own incremental update, its own
  full/incremental equivalence proof, its own rebuild-cannot-certify-stale-state
  guard, and a `maybe` answer that forces a resolution stage. Count what a
  structure costs to keep TRUE, not what it costs to query.
- **UNKNOWN IS NOT ABSENT, and filtering makes them look alike** (M147): M146
  excluded refused members from the probe pool and then reported uniqueness over
  what remained, which silently reads "we did not ask them" as "they do not have
  it". The fix is not a new check but a wider eligible population — all enabled
  members, with a refused one contributing `unknown` and withholding the claim.
  Any time a filter precedes a global claim, ask what the filtered-out rows would
  have been entitled to say.
- **Two owners settle the question; everything else waits** (M147): the proof
  checks `present > 1` BEFORE consulting unknowns, because no further answer can
  reduce a count of two. Every other verdict is a claim about members that did
  not answer, so one unknown withholds it. Getting this asymmetry wrong in either
  direction is a bug — abstaining on genuine duplicate-symbol ambiguity would
  hide it behind a readiness complaint.
- **A physical access path is not a schema change, and the fingerprint model can
  tell the difference** (M147): `CREATE INDEX` adds no row and changes no derived
  content, but placing it in `src/db/schema.ts` would move `schema_version` and
  force a full reparse of every repository in the field. Placing it outside the
  fingerprinted directories, unreached by the index write path, lets it be
  installed additively into a `ready` index — and M146-A's behavioural-control
  pattern is exactly what proves the claim rather than asserting it: read the
  derived rows out, migrate, read them back, compare.
- **Version it from the catalogue, not from a counter** (M147): the installed
  access-path version is derived by asking SQLite which indexes exist. A stored
  version column can disagree with reality — someone drops an index and the
  counter still claims v1 — and this milestone is specifically about not claiming
  things that were never checked.
- **`no_match` is a global negative too** (M147): a bounded scan that found
  nothing reported "No repository carries evidence for this request" while two
  members had never been asked. The outcome was safe — nothing is selected — but
  the sentence was false. Audit the REASONS a fail-closed path emits, not just
  its status: they are what a user acts on.
- **Let the router be checked by something that is not the router** (M147): every
  real-repository verdict was compared against an independent census computed by
  plain SQL over the same indexes. A routing test that only asserts the expected
  alias passes just as well when both the router and the expectation are wrong.

## M146 closure standing findings

- **Finding a match is cheap; proving uniqueness is a global negative claim**
  (M146): a bounded deep search can establish "this repository defines the
  name" but never "no other eligible repository does". Every routing design that
  reports a unique owner from a truncated search is asserting something it did
  not measure. The general shape recurs anywhere a capped search feeds a
  uniqueness or absence claim.
- **A cost bound can silently become a correctness bound** (M146): `maxDeepProbes`
  existed purely for latency, and it quietly changed what the router was
  entitled to conclude. When capping a search, re-ask what claim the uncapped
  version was making and whether the capped one still supports it.
- **Never mix historical metrics into a paired comparison** (M146): the M145-era
  row records Top-1 39 / 1850.14 tokens, but M145's own tree measures 38 /
  1832.4 in this harness. Quoting the historical numbers against a freshly
  executed candidate would have invented a one-case regression. Re-execute both
  sides; the gate is that the two agree, not that they match a remembered value.
- **Evidence-only commits are not functional predecessors** (M146): `a95e0d4`
  and `2ee3765` touch zero files under `src/`, so the final functional candidate
  is `d2a8254`. Resolve this by inspecting what a commit CHANGED, not by taking
  the branch head.
- **A milestone's own tests can regress suite stability without failing**
  (M146): the new workspace fixtures pushed six unrelated pre-existing tests
  past their 5 s default under load while every one passed standalone. The fix
  was to make the fixtures cheap (cache read-only workspaces; drive the
  truncation invariant with an explicit small cap rather than the default),
  which cut one file from 34 s to 5.7 s and the full suite from 260 s to 137 s —
  and made that test stronger, since the small cap allowed asserting both
  registration orders. Treat "passes alone, times out in the suite" as a cost
  bug in the new tests, not as flakiness to tolerate.
- **The real corpora were already refused before the acceptance could run**
  (M146): ARC reported `derivation_changed` and TCKDB_v2 `schema_changed` — the
  expected consequence of A's fingerprint change and the first real instance of
  the scenario B was built for. Budget a rebuild into any milestone whose
  acceptance uses real corpora after an index-affecting change, and do not
  restore a deliberately stale index afterwards: that would regress readiness.

## M148 standing findings

- **A migration nobody can invoke is not shipped** (M148): M147 proved the access
  migration correct in isolation and stopped there, so no user could reach it and
  no fresh index received it. "Implemented and tested" and "part of the product"
  are different states; the gap is invisible from the unit tests, which construct
  the state they need. Ask which product command performs the new behaviour, and
  if the answer is "none", the milestone is not finished.
- **Put a physical capability above the derivation seam and no exemption is
  needed** (M148): the tempting fix was to call the migration from the indexer and
  add an anti-drift exemption. Integrating one level UP — where the CLI, the MCP
  tool and the watcher already converge on a writable handle inside the worktree
  lock — makes the exemption unnecessary, because the dependency never points into
  the fingerprint closure. An exemption is a promise; an architecture is a proof.
- **A `noop` refresh is the migration path for existing indexes** (M148): no new
  command was needed. `vtrace index` on an unchanged repository plans `noop` (0
  files parsed, 0 graph rows, 0 FTS rows) and still leaves with the access path
  installed. Before adding a lifecycle command, check whether the existing
  lifecycle already passes through the point you need.
- **The same eligibility bug lives in every derived lane until each is checked**
  (M148): M147 fixed the exact-symbol population and the indexed-path lane kept
  the old rule one tier above it, silently, because both drew their pool from the
  same "may this lane read derived state?" table. That table answers a SAFETY
  question; whose answers a PROOF requires is a different question, and conflating
  them is how "not asked" became "absent" twice.
- **Reproduce the defect before fixing it, and measure the predecessor rather
  than reasoning about it** (M148): the indexed-path hole was demonstrated with a
  real three-member workspace first, and every M147 column in the workspace ledger
  was produced by importing the predecessor router from a worktree and running it
  on the same fixtures. That caught two rows where the plausible M147 value was
  wrong: at eleven ready members M147 abstained on the probe cap rather than
  selecting the owner, so M148 is a capability GAIN there, not a tightening.
- **A cost bound became a correctness bound for the second time** (M148): the
  8-probe prefix silently decided what the indexed-path lane could conclude, the
  same shape M146 recorded for `maxDeepProbes`. The fix was not to raise it but to
  make truncation say `beyond_scan_bound` and feed the same proof — and then to
  set the new bound from a measurement (`files` is covered by a UNIQUE index on
  `path`) rather than from caution.
- **Lifecycle changes rewrite what a fixture means** (M148): making fresh indexes
  arrive migrated invalidated the PREMISE of five M147 controls that asserted a
  fresh index carries no access path. They were not wrong and were not deleted —
  each now constructs the pre-migration state deliberately, which is stronger,
  because a control that depends on a side effect of how indexing happens to work
  silently changes meaning when the lifecycle does.

## M149 standing findings

- **One sentence covering three epistemic states is the bug, not the wording**
  (M149): `no_match` said "No repository carries evidence for this request"
  whether every member had been checked and none matched, or no lane had run at
  all. The status was safe in both cases — nothing is selected — so no test could
  see it; only reading the sentence beside `reposDeepProbed: 0` exposes it. Audit
  the REASONS a fail-closed path emits, because they are what a reader acts on,
  and check whether one string is doing duty for several different amounts of
  knowledge.
- **The truthful sentence usually already exists one layer down** (M149): the fix
  was not new prose but preferring the proof's own reason, which had counted what
  it checked since M147. A consumer that substitutes its own summary for a
  producer's carefully-scoped statement is where scope gets lost. Before writing
  a claim, ask whether the producer already made one.
- **Bounded lists and bounded conclusions are different properties, and you need
  both** (M149): the proof's verdict must be computed from TOTALS while its
  report shows at most four names. Cap the list and compute from the count, or
  truncation silently changes the answer — a workspace-scale version of the same
  cost-bound-becomes-correctness-bound error M146, M147 and M148 each hit once.
- **A partial scan still knows something; the fix is to stop it escalating**
  (M149): collapsing an incomplete scan to `not_observed` would discard a real
  answer about the members that DID answer. `bounded_absence` keeps it and
  `canClaimAbsence` refuses it any scope wider than the scanned set. Weakening a
  claim and deleting it are different remedies.
- **Two unknown reasons, one claim effect, two remedies** (M149):
  `refusedWithoutEvidence` and `omittedByBound` weaken a negative identically, so
  it is tempting to sum them. They stay separate because you repair an index and
  you raise a bound, and a consumer that cannot tell them apart sends someone to
  the wrong fix.
- **Access path is a latency fact, not an authority fact** (M149): it is tempting
  to read M148-A's `indexed`/`fallback` as confident/uncertain. There is ONE
  membership statement and both paths consider identical rows, so a fallback
  answer is exactly as true. `CAPABILITY_SETTLES_MEMBER_ABSENCE` is keyed on
  whether the QUERY is exact, never on how it was executed.
- **`workspace` must stay wider than `enabled_members`** (M149): a disabled
  member is outside the population every lane asks, so no lane may make a
  workspace-wide claim. This is the M147 "unknown is not absent" lesson one level
  up — and it is the level a future cross-repository milestone will be tempted to
  flatten.
- **The most important audit finding was that nobody is listening** (M149):
  `nominateRepositories` and `assembleWorkspaceProductContext` have no MCP or CLI
  caller. Four milestones of routing truthfulness are currently reachable only
  from the benchmark harness. Correctness work on an unwired layer is worth doing
  once — it is not worth stacking a fifth milestone on before it has a consumer.
- **A hypothesised defect that does not reproduce is a result** (M149): the
  predicted "outranked member recorded as definitely_absent" is structurally
  unreachable, because the condition for an exact match is the condition tier 1
  already decides on. Recording the structural reason is more useful than the fix
  would have been, and §129 forbids editing correct code for symmetry.

## M150 standing findings (checkpoint + continuation)

- **A signal that fires on almost everything decides nothing** (M150): the first
  mechanism scoring pass gave the direct tier to nearly every candidate in a
  topically relevant pool, so the component became a constant and tiny lexical
  differences reordered the lead. A new relevance signal has to be measured for
  its DISTRIBUTION over a real pool, not only for whether it fires on the case
  that motivated it. On ARC only 619 of 2549 facts are result-bearing, and that
  ratio is the signal.
- **Summing evidence rewarded containing more control flow** (M150): a function
  with four weakly-compatible mechanisms out-earned the one that actually
  decides. Mechanism evidence is the strongest SINGLE fact, never a sum — being
  busier is not being more decisive.
- **`resultBearing` is the property that separates identical syntax** (M150):
  three ARC functions all take element zero of a collection and only one is
  deciding anything. Asking whether the mechanism produces the definition's
  RESULT distinguishes them; the operand's name does not, and neither does the
  function's. Kept to one hop deliberately — chasing assignments transitively
  relinks almost every statement to some return.
- **Domain affinity satisfied a gate it should never satisfy, again** (M150): the
  subject gate first read `max(lexical, domain, path, symbol)` and handed a
  Hessian parser full selection evidence on the strength of the token `gaussian`
  in its path. M142 already excluded domain from the centrality gate for exactly
  this reason. Any new gate asking "is the request about this candidate?" must
  use identifying evidence, and this is now the second component to learn it.
- **A frozen-corpus zero can be true and weak at the same time** (M150): Frozen50
  came back 0/50 byte-identical, but those indexes predate the milestone and
  carry no mechanism facts, so the run proves no side effect rather than proving
  the gate works. The gate had to be measured separately against an index that
  actually has the evidence — where it found a regression the frozen run could
  not have seen.
- **Two rejected fixes are a result** (M150): a subject-match strength modifier
  and a raised relevance floor were both implemented and measured against the
  Gaussian regression; the first broke the cache and ordering contrast controls
  without repairing the case, the second was arbitrary. Recorded rather than
  shipped, because the discriminating corpus that would settle it does not exist
  yet — which is itself the reason M150 closes MIXED.

- **Operation compatibility is real relevance; it is not sufficient relevance**
  (M150 continuation): the checkpoint proved a definition that PERFORMS the
  requested operation deserves ranking evidence, and then a dozen Gaussian result
  parsers each performed a genuine result-bearing first-item selection on a
  request about route keywords. Selecting SOMETHING is not evidence about
  selecting the thing asked about. The missing half is what the mechanism ACTS
  ON, and it has to be asked separately.
- **The operand is the first test and the producer is the one that matters**
  (M150 continuation): operand names alone would have failed the case the
  milestone exists for — ARC decides a reaction family from `product_dicts[0]`,
  and `product_dicts` encodes neither word, while `get_reaction_family_products`
  encodes both. One hop of local provenance, resolved at INDEX time from the same
  body, carries every real case in the corpus. Two hops was measured on a
  deliberate fixture, does not pay for itself yet, and is left unbuilt.
- **Exempt the kinds whose statement form IS the behaviour, from both proofs**
  (M150 continuation): a cache consult names the CACHE and an accessor names the
  private field, so testing either operand against the request's subject refuses
  the only fact that answers it. The same three kinds that cannot occur
  incidentally are the three whose operand is the store rather than the subject —
  one concept, not two, and noticing that kept the contrast controls alive.
- **A guard that protects one control can silently disable a feature** (M150
  continuation): the collection-shape rule that keeps `first_character(name)`
  honest also refused `xs = matching_backends_for(config)` — no fact at all, so
  no amount of scoring could recover it. A plural token in the PRODUCER restores
  it without touching the control, because the control's operand is a parameter
  no call produced. Check what a negative control excludes as well as what it
  admits.
- **Build the discriminating corpus before the discriminator, and it pays
  immediately** (M150 continuation): the checkpoint stopped deliberately for want
  of one. Built first, it named the defect in one run — two cases with identical
  mechanism bonus on the right and the wrong subject — and then proved the fix
  cost nothing, 2 wrong-subject bonuses to 0 with correct lead, Top-3 and
  coverage all unchanged. Both rejected discriminators would have been visible as
  regressions in it.
- **Two flat rows are the honest headline** (M150 continuation): ordering-helper
  visibility stayed 1/4 and mechanism support stayed 0 across all three sides,
  because neither was implemented. A corpus that only reported what improved
  would have read as a PASS.

- **Classify the absence before building the recovery** (M150-D): `get_all_families`
  could have been missing for four different reasons, and only one of them has a
  support-shaped fix. Measuring it as `not_generated` rather than
  ranked-and-dropped is what made the answer a ROLE instead of a score, and a
  scoring fix would have been both wrong and invisible to every existing gate.
- **The same syntax, told apart by what it returns** (M150-D): two helpers each
  call `sorted(...)`; the one that RETURNS the sorted value establishes the order
  its caller consumes, and the one that sorts to log it establishes nothing.
  `resultBearing` carried the whole negative control, reused from the fact
  representation rather than invented for the support lane.
- **Splicing past the cap is the same as not splicing at all** (M150-D): the
  support lane worked in isolation and delivered nothing through the product,
  because the entry was inserted after the slot cut. M140-C had already solved
  this by DISPLACING the weakest winner and reporting it budget-dropped; reading
  the neighbouring lane before writing a new one would have saved the round trip.
- **A corpus can be wrong in the same way the code was** (M150-D): two fixtures
  documented a decision in terms of `entries` while their helper spoke of
  `candidates`, so the subject alignment correctly refused them and the metric
  read as a feature gap. Fixing the FIXTURE and re-running all four sides was the
  honest repair; rewording the query toward the implementation's vocabulary would
  have made the corpus agree with the code by construction.
- **Ordering visibility is 3/4 and the denominator is the interesting part**
  (M150-D): the fourth case has no seed because its PRIMARY is not generated, so
  it is a candidate-generation limit wearing a support-lane costume. Reporting
  3/4 with the reason is worth more than forcing 4/4.

- **The last missing capability was eligibility, not ranking** (M150-E): four
  phases of mechanism work all assumed the right definition was already in the
  pool. When it is not, none of them can fire, and no amount of scoring or support
  reaches it. Classifying `not_generated` early is what turned the final phase
  into a generation lane instead of another round of weight tuning.
- **Apply the gate BEFORE admission, not after** (M150-E): subject alignment as a
  post-filter would have let every Gaussian parser into the pool and relied on
  scoring to bury them. Running it at generation refused 64 of 64 owners on that
  query and admitted nothing, which is a stronger guarantee than any downstream
  correction.
- **Profile before adding an access path** (M150-E): the fact table already had a
  `(kind, symbol_id)` index and the query plan was already a SEARCH. Adding an
  M148-style access capability would have been pure ceremony - a migration, a
  readiness field, and a rebuild for every field index, buying nothing. Recording
  "existing access path sufficient" with the query plan is the result.
- **A lane-order artifact can look exactly like a ranking judgement** (M150-E): an
  admitted candidate carried `fts = 0` and scored as though its name matched
  nothing, because the lexical lane had already returned before it existed.
  Reusing `rankSearchCandidates` on the admitted rows is a repair, not a boost -
  an unrelated definition still scores nothing - but it is worth stating which,
  because the two are indistinguishable from the final number alone.
- **Being generated is necessary and not sufficient** (M150-E): `get_all_families`
  now enters the pool on behavioural evidence alone and still ranks 24, behind a
  candidate holding `lexical = 1.0` from a directory name. The remaining defect is
  in a lane M150 deliberately froze, and naming it as an M142-class lexical decoy
  rather than a mechanism failure is what keeps the next milestone pointed at the
  right code.

- **Name the producer before writing the fix** (M150-F): the defect looked like
  file-stem lexical scoring and was not. It was a SYNTHESIZED scorecard - a tier
  assigning `lexical: 1 / final: 1.9` outright - in a lane three layers away from
  anything called lexical. Every plausible fix aimed at path scoring, FTS or the
  domain lane would have missed it and damaged something real.
- **A correct argument about a FILE can silently extend to a SYMBOL** (M150-F):
  branch (a) was left alone because "a file with that basename genuinely exists",
  which is true and says nothing about which definition inside it answers the
  question. M142 had already fixed the sibling branch for the same underlying
  reason. When a lane resolves at one granularity and emits at another, check the
  claim survives the change of granularity.
- **The independence test must exclude the evidence under scrutiny** (M150-F):
  `symbol` is exactly what a file-derived mention synthesizes, so consulting it
  to decide whether the mention is allowed would have passed every time. Naming
  the excluded signals in the contract is what makes the test non-circular.
- **16 changed cases with 0 changed quality is a result, not a risk** (M150-F):
  Frozen50 moved a third of its cases and every gold-file, gold-symbol and
  coverage figure stayed identical. Those rankings were decided by path-only
  accidental evidence and nothing that measures an answer moved. Tuning the rule
  to restore byte-identity would have preserved the accident.


## M150-G standing findings

- **A defect that survives four phases is usually in a different layer than the
  last four fixes** (M150-G): M150-B through M150-F all improved what mechanism
  evidence could SEE. The ordering defect was never there — `determine_family`
  scores mechanism 0 on that query and wins on subject alone. Reading the
  scorecard before touching the weights is what turned "the orderer needs more
  mechanism credit" into "the orderer needs no credit at all, it needs to be
  compared to the consumer".
- **Refute the additive fix with two numbers, not an argument** (M150-G): the
  brief warned against raising `0.55`. Measuring what raising it would COST —
  +0.709 for ARC, +1.83 for the generic fixture whose consumer holds every
  subject word — converted a stylistic preference into a closed question, and
  named the alternative at the same time. A per-candidate score cannot express a
  relation between two candidates at any magnitude.
- **Build the corpus before the rule and it will find defects the target case
  cannot** (M150-G): ARC's orderer is well named and well placed, so it never
  exposed the subject floor. Fixtures with deliberately useless names did, on the
  first run: 3 of 9 direct implementers scored zero because the floor reads names
  and paths. The corpus also refuted the first version of the rule (one-directional)
  and the second (nearest-linked-node), each within one measurement.
- **The same evidence can be recorded in two columns** (M150-G): the loop kinds
  put their producer in `subject` as a call expression and leave `provenance`
  empty. A walk that reads only `provenance` silently finds nothing for an entire
  fact family — and that is the same reason ordering visibility has been stuck at
  3/4 since M150-D, which had been attributed to candidate generation.
- **A promotion must be the minimum step, and the organic score must survive**
  (M150-G): the orderer is placed `+0.0001` above its consumer and no higher, and
  `organicFinal` stays on the scorecard. Anything larger would have been a weight
  chosen from the gap it had to close, which is the failure §56 exists to prevent
  and which no benchmark would have caught.
- **Ranking correct and delivery wrong are different results** (M150-G): ARC now
  ranks `get_all_families` first and still delivers `determine_family` as the lead
  pivot. Three corpus queries produce a correctly ordered pool and an EMPTY
  capsule. Reporting rank movement as if it were an answer would have claimed a
  capability the product does not have; pivot eligibility is the next constraint
  and it is a different layer.


## M150-H standing findings

- **"Ranking is correct" and "the product is correct" are different claims**
  (M150-H): a whole phase closed with ARC's orderer at pool rank 1 and the capsule
  still leading with the consumer. Nothing in the ranking evidence would ever have
  revealed it. The metric that did — `pool_vs_capsule_agreement` — is worth more
  than any single ranking number, because it is the only one that asks whether the
  answer survived to the model.
- **One requirement stated three times is one defect stated three times**
  (M150-H): `directEvidence`, a `localEvidence` floor and a `hubPenalty` check all
  ask "is this candidate tied to the task by something about itself?", and all
  three answered it from names and paths. Fixing only the first would have left
  ARC's orderer blocked by a 0.0116 penalty earned for having seven callers.
- **Audit before implementing, and expect the taxonomy to be wrong** (M150-H):
  the brief's leading hypothesis was a stale pivot set built before the relational
  reordering. Measurement refuted it in one trace — the relation runs inside
  retrieval, before nomination — and the real cause was one layer further on. The
  brief also cautioned that the wrong-lead and empty-capsule cases might differ;
  they turned out to share a gate, and only a trace could establish that either
  way.
- **A bound is worth more than a threshold, and must be measured too** (M150-H):
  granting pivot authority to every direct implementer looked principled and let
  `mixed.py::first_backend` lead a question about another module. Restricting it
  to the single best-ranked implementer cost nothing on the emphasis corpus (8/8
  and 3/3 both held) and removed the flooding. Operand alignment is enough to
  score a candidate; it is not enough to make it the answer when something else
  outranks it.
- **Byte-identical on the frozen suites is a RESULT when it is explained**
  (M150-H): `86fed3dd -> 2d3010e4` moved nothing on django or cross_repo_30, and
  the reason is structural rather than lucky — SWE-bench tasks declare no
  behavioural operation, so mechanism evidence never reaches the direct tier and
  the new eligibility path is unreachable. Running the isolation comparison is
  what turned that argument into a measurement.
- **A corpus expectation can be wrong in a way that looks like a product failure**
  (M150-H): `route_ordering` expected an orderer for a precedence expressed as the
  order of a list literal. No fact kind indexes that, so the symbol carries no
  fact at all and there was never anything to deliver. Correcting the denominator
  with the reason is honest; forcing 4/4 by rewording the query toward the
  implementation would have made the corpus agree with the code by construction.
- **Delivery agreeing with ranking can LOWER a delivery metric** (M150-H): the
  15-case Top-3 fell 13 -> 10, and in every moved case the expected answer sits at
  pool rank 4 both before and after. The old number depended on delivery
  disagreeing with ranking and promoting a rank-4 candidate the pool had not
  chosen. Attributing that to ranking rather than hiding it under the delivery
  work is what keeps the next milestone pointed at the right code.


## M151 standing findings

- **"Unused" and "refuses to run" are different defects, and only one of them is
  visible from an import graph** (M151-A): M149 recorded that
  `nominateRepositories` had no product caller, which is true and understates it.
  A `workspace.json` at the bound root made every product call return
  `invalid_request`, and the remediation the error named could not be performed —
  the gate tested whether a workspace EXISTED, so "omit repos" and "select exactly
  one" both failed. Calling the real MCP registry found that in one probe; reading
  the source had already produced the weaker finding twice.
- **A reachability measure can be wrong in both directions, and the honest one is
  the import CHAIN** (M151-A): grepping the product roots for the symbol says
  unreachable even after wiring, because M151 routes through one seam on purpose.
  Following imports transitively and asking whether the SYMBOL appears says
  everything is reachable in both states, because a module's own definition counts
  as a reference. Asking whether the DEFINING MODULE is in the closure, and
  recording the shortest chain to it, separates 3/9 from 9/9.
- **The seam is decided by what shares a database handle, not by what looks
  smallest** (M151-B): swapping `assembleProductContext` for the workspace
  assembler is a two-line diff and wrong — `run_pipeline` derives the v1
  orchestration and the product context from ONE `db`, so redirecting the producer
  alone emits a single response describing two repositories. Routing before the
  binding is a larger diff and leaves every M150-frozen path running unchanged.
- **A rule that is right for a CLAIM can be wrong for a CHOICE** (M151-B): M147
  withholds `selected` when a member could not be checked, because "alpha has it"
  does not establish "only alpha has it". Applied to routing unchanged, one stale
  member turns every symbol query in the workspace into a refusal. The repair is
  not to weaken the proof but to separate the two questions: lead on the sole
  positive answer, report `uniquenessProven: false`, and carry the lane's coverage
  so nothing downstream can read it as absence.
- **Default-off is a correctness property here, not a performance one** (M151-B):
  supporter discovery runs the indexed lanes even when an index-free hint already
  decided. Left on, the mere EXISTENCE of a second member would change what the
  lead returns. The control that matters is not "composition works" but
  "composition absent leaves the answer byte-identical", and it is asserted
  directly rather than argued from the design.
- **Truncation and completeness are different facts and must be reported as two
  fields** (M151-C): `coverageComplete: true` with `omittedByBound: 996` is the
  normal shape for a large healthy workspace — every member counted, four shown.
  Folding them into one number would make either a bounded display look like an
  evidence gap, or an evidence gap look like a display bound. Verdicts are computed
  over the full census and only the sample is truncated.
- **Bounding the records is not bounding the response** (M151-C): after the
  per-member status list was capped, `index_status` still grew with member count
  through two whole-workspace alias arrays in the `workspace` block. Measuring
  serialized BYTES at 11/100/1000 found it; capping the obvious list would not have.
- **A read path that mutates is worth measuring even when it is not yours**
  (M151-E): three consecutive `get_code_context` calls against ARC produced three
  different index hashes. The instinct is to attribute it to the new routing code;
  running the identical probe against the M150 baseline showed it reproduces
  exactly, locating it in `withReadyRepoDb` -> `openIndexerDatabase`. Everything
  M151 adds opens members `{ readonly: true }`, proven by a probed non-lead member
  being byte-identical. Reporting "unchanged: false" without that attribution
  would have blamed the wrong layer; suppressing it would have hidden a real
  invariant violation.
- **Zero movement on the frozen suites is only a result once you can say why it is
  structural** (M151-E): the suites call retrieval through
  `createHistoricalEvaluator` with one explicit repository root and never construct
  an MCP request, so no workspace config is read and the router is not on their
  call path. That makes 0/50 a side-effect check rather than evidence the wiring
  works — which §113 anticipated, and which the product corpus exists to supply.
- **A blocked gate is a decision to surface, not a number to work around**
  (M151-E): both real indexes were `possibly_stale / schema_changed`, so every real
  query delivered 0 items and §63/§64 were unprovable. The same failure at the M150
  baseline established it was not a regression; rebuilding was a mutation of the
  user's authoritative state, so it was authorized explicitly, recorded with
  before/after identity, and excluded from attribution rather than quietly folded
  into the result.


## M151 closure standing findings

- **The cheapest way to fail a gate is to inherit its premise** (M151-E): the
  brief named the mutating call — `withReadyRepoDb -> openIndexerDatabase` — and
  asked for a read-only binding. Implementing that would have produced a plausible
  patch, a passing-looking story, and no change in the observed behaviour, because
  `openIndexerDatabase` writes nothing on a current index. Decomposing the call
  into five layers and measuring each cost one probe and moved the investigation
  to a different subsystem entirely.
- **A hash tells you something changed, never what** (M151-E): three consecutive
  reads producing three hashes is compatible with "retrieval corrupted the index"
  and with "`search_memory` recorded a lookup", and those have opposite
  consequences. Diffing per table separated them in one run: repository-derived
  state byte-identical, three named product/session families moved. The gate that
  could be stated honestly was narrower than the one that was asked for and
  strictly more informative.
- **"Pre-existing" is an attribution, not an exemption, and neither is it a
  defect** (M151-E): the previous session correctly established the writes
  predate M151 and then reported them as an unresolved invariant violation. Both
  halves were wrong in the same way — the writes are supported features doing
  their job. What is genuinely unresolved is that evidence and session state share
  a file, which no read-path change can fix.
- **Check what a "harmless" write is load-bearing for before removing it**
  (M151-E): suppressing the three writes satisfies the literal gate and breaks
  `expand_vexp_ref`, `check_capsule_staleness` and memory auto-capture. The
  deferred-ref case is the sharp one: not persisting emits a reference nothing can
  resolve, and not deferring changes delivered content and breaks a gate three
  phases earlier had frozen. A one-line suppression would have traded a documented
  limitation for three silent ones.
- **Scope is a measurement too** (M151-E): "move session state to its own store"
  is one sentence and ~31 non-test source files plus 19 test files plus migration,
  lifecycle and concurrency. Counting them before choosing is what distinguished a
  storage milestone from the tail of a wiring one, and kept M151 from ballooning
  after A-D were already complete.
- **A boundary is only real if something fails when it is crossed** (M151-E): the
  table families live in one module both the regression test and the evidence
  runner read, and an unclassified table fails rather than defaulting. Without
  that, the next table added inherits whichever side it happens to land on and the
  invariant decays silently — the same reason M146-A made its fingerprint coverage
  a closure guard rather than a hand-listed set.
- **Order the next milestones by what gets harder to undo** (M151-E): richer
  cross-repository semantics is the more interesting problem, and doing it first
  would mean composition writing observations and manifests for several
  repositories into commingled state. Establishing the ownership boundary while
  there is exactly one writer per request is cheaper than establishing it after.


## M152 standing findings

- **A gate that cannot be stated is usually measuring two things at once**
  (M152): M151 wanted "the index file is byte-identical after a read" and could
  only get a per-table approximation, because the file held evidence and session
  state together. The fix was not a better assertion but a different physical
  layout — after which the original one-line gate is simply true, and
  `sessionWrites=0` into the index replaces three families of documented
  exceptions.
- **Let the compiler enumerate the call paths** (M152): the change touches ~50
  files, and §45 warns against blind textual replacement. Branding
  `SessionDatabase` / `WritableSessionDatabase` turned "find every caller that
  must be classified" into a typecheck that listed them, file by file, and
  refused the ones that were wrong. The cost of that approach is exactly its
  blind spot: `src/mcp/tools.ts` carries `@ts-nocheck`, so the largest product
  surface got none of the protection and had to be done by hand — and the one
  bug that reached runtime (`evaluateObservationNudge` handed the index handle)
  was in that file.
- **A physical split does not remove a lifecycle coupling** (M152): moving
  session tables out of `index.sqlite` while leaving their repositories in
  `src/db` would have kept every memory change invalidating every stored index,
  because that directory is content-hashed into `indexer_fingerprint`. The
  boundary worth enforcing was the one that decides what forces a rebuild, not
  only the one that decides which file a row lands in.
- **Removing a constraint changes behaviour even when nothing references it**
  (M152): the FK from `capsule_manifests` to `index_runs` was `ON DELETE
  CASCADE`, so rebuilding an index silently destroyed the manifests derived from
  it and made "the manifest is gone" indistinguishable from "the manifest is
  stale" — which is the exact question `check_capsule_staleness` exists to
  answer. Dropping the FK was forced by the file split; noticing that it had
  been hiding a defect was not.
- **Independence creates states that could not previously exist** (M152): with
  one file, `comparisonRunId < sourceRunId` was unreachable, so both staleness
  paths threw on it and were correct to. With two files it is one `rm` away, and
  throwing would have taken out `search_memory` for a whole repository. A
  milestone that grants two things separate lifecycles has to go looking for the
  invariants that were silently held by their being joined.
- **Attribute a real-repository change before explaining it** (M152): ARC's
  memory classification shifted and its impact gate failed, both plausible as
  M152 regressions. Indexing ARC from identical source under M151 and M152 code
  produced byte-identical output, and the same session store returned identical
  accounting against both index generations — so the shift tracks ARC's reindex,
  and the gate has been stale since ARC's source moved. Two runs of a 36-second
  index settled what any amount of reasoning would have left as an opinion.
- **Rehearse a migration on a copy even when the code is tested** (M152): the
  fixture suite covered idempotence, retry after partial copy, and id
  preservation, and the copies still earned their keep — they exposed that the
  evidence runner's own parity digest was column-order-sensitive, which would
  have reported a false content mismatch on the authoritative run.
- **Measure the failure semantics per feature, and write them down** (M152): the
  rule that a deferred ref must persist before it is emitted lived only in the
  shape of one `try`/`catch` and could have been "simplified" away without a
  single test failing. It is now a declaration with an injected-failure test per
  feature, so a future session-backed feature must state its semantics rather
  than inherit whichever handler surrounds it.


## M153 — Cross-Repository Behavioural Nomination and Generalisation Proof

| Field | Value |
| --- | --- |
| Verdict | **INCOMPLETE** (A PASS · B PASS · C NOT PASS · D/E not run) |
| Predecessor | `72ce221c` (M152 final functional) |
| Commits | `5900528b` corpus · `8b10e944` audit+contract · `f700d5b6` baselines · `84dba95d` implementation |
| Verification | typecheck clean · typecheck:benchmarks clean · `bun test` 4646 pass / 0 fail · `git diff --check` clean |
| ARC | not run, not consulted for any decision |

Built a 35-case behavioural corpus over 7 pinned non-ARC repositories, split by
repository (calibration requests/flask/pytest/sphinx, holdout
xarray/astropy/pylint), committed before any algorithm work, with all 81
referenced symbols and every line span mechanically verified against source.
Added the behavioural repository-nomination tier below exact symbol, comparing
repositories by strongest evidence CLASS with no margin and no threshold. Shipped
default-off.

## M153 standing findings

- **A benchmark written after the algorithm measures the algorithm's own
  vocabulary** (M153): committing the corpus before the implementation was the
  only thing that made the result falsifiable. The headline number — 1 of 30
  correct implementations at oracle — would have been indistinguishable from a
  badly-written benchmark if the queries had been authored afterwards by the
  person who then went looking for why they failed.

- **Generalisation failed at the activation cue, not in the machinery** (M153):
  only 15 of 35 queries derive a behavioural operation at all, and the rest fall
  through to lexical matching. M150's own fixture asks which backend WINS and
  derives `selection`; the corpus asks which backend OPENS A GIVEN FILE and
  derives nothing. Everything downstream of that cue — mechanism facts, subject
  alignment, answer-role delivery — was built and tested against phrasings ARC
  and the fixtures happened to use. The discriminations are sound where they run.

- **A router is only as good as what the index recorded** (M153): the adapter
  case routed to flask because `requests` admitted zero candidates — its own
  first-prefix-match loop was never indexed as a selection fact — while flask's
  `url_build_error_handlers` operand coincidentally contained the token `url`.
  Routing rules cannot be evaluated independently of evidence coverage: a
  perfectly correct comparison over sparse evidence still picks the wrong
  repository, and it does so confidently.

- **Volume is the size distractor in disguise** (M153): retaining only each
  repository's single best evidence item removes the §44 large-repository
  advantage without a normalisation constant. Any runner-up margin over a COUNT
  would have put it straight back, which is why the lane has neither a margin nor
  a threshold.

- **Default-off is the honest verdict for a measured-MIXED lane** (M153): the
  lane fired 6 times and was wrong 3 times, and wrong-subject nomination is an
  explicit failure condition. Enabling it would have traded a truthful
  configured-default answer for a confident wrong one. Following M78/M82/M85,
  the capability ships reachable and measured rather than on.

- **Benchmark runs contaminate each other through session state** (M153): with
  the lane enabled, routing to a different repository made THAT repository
  accumulate observations, which perturbed later oracle calls in the same pass.
  M152 made product state mutable and separately owned, which is correct — and it
  means a paired benchmark must start each arm from clean state rather than reuse
  a prepared workspace.

- **`initRepo` is not idempotent** (M153): a second call over an existing index
  fails with `UNIQUE constraint failed: edges.id`.


## M153-C2 continuation (commits 8d8b4195, a0000b69)

Verdict unchanged: **INCOMPLETE** (A PASS · B PASS · C NOT PASS · D/E not run).
Activation 14/33 → 19/33; calibration wrong-subject routes 1 → 0; oracle
correct-implementation Top-1 unchanged at 1/30. Holdout unconsumed, ARC not run.
Verification: typechecks clean, `bun test` 4659 pass / 0 fail, `git diff --check`
clean.

## M153-C2 standing findings

- **Attribute the stage before fixing anything** (M153-C2): the taxonomy was
  built before a line changed, and it earned its keep immediately — REPRESENTATION
  rose from 6 to 9 as ACTIVATION fell from 16 to 11, which reads like a regression
  and is the opposite. Those cases were always broken at representation and could
  not be seen until the query reached that stage. Without the ordered attribution
  the second fix would have looked like a consequence of the first.

- **A taxonomy that never consults the outcome cannot be falsified** (M153-C2):
  the first version attributed the last stage in the chain as a failure by
  default, so `rq_adapter_selection` — the corpus's single oracle success — was
  labelled a delivery failure. An instrument that can only report failure will.

- **Two tables describing the same vocabulary will disagree** (M153-C2):
  `OPERATION_VOCABULARY` declared decide/decides/decided/deciding while the cue
  pattern matched only the first two, so one ordinary English inflection silently
  disabled the entire behavioural chain. The bug was not in either table but in
  their being written twice.

- **A rule about NAMING applied to DESCRIBING** (M153-C2): capability-lookup
  suppression exists for requests that name a definition, and was suppressing
  requests that describe one — which is precisely the request M150 was built to
  answer. The protection it appeared to provide was already supplied elsewhere,
  and more strongly.

- **Punctuation hid a mechanism** (M153-C2): `for (prefix, adapter) in ...` was
  invisible while `for suffix, filetype in ...` was represented, so a textbook
  first-success loop carried no fact at all. The same gap hid the ordinary JS
  destructuring form — in a language absent from the corpus, which is what
  distinguishes a generic defect from a corpus-shaped one.

- **A subject that names the accessor names nothing** (M153-C2):
  `self.adapters.items()` reduced to `items()`, so every fact taken from a Python
  dict loop shared one meaningless subject and the subject discrimination M150
  exists for could never fire on any of them.

- **A correct answer reached by illegitimate evidence should still be removed**
  (M153-C2): barring test files from routing evidence deleted a wrong route AND a
  right one, and the headline workspace number fell from 21.2% to 18.2%. The
  higher number was reached through another repository's test fixtures. Routing is
  a claim about implementation ownership; being right for a reason that does not
  generalise is not being right.

- **Contamination hid a preservation property** (M153-C2): once benchmark arms
  were isolated, the oracle arms became identical with the routing lane on and
  off — the exact property that says routing did not disturb retrieval. Before
  isolation six cases differed, and the noise looked like a real effect.

## M153-C3 continuation (commit 1c02df9f)

Verdict unchanged: **INCOMPLETE** (A PASS · B PASS · C NOT PASS · D/E not run).
Two candidate-admission defects fixed, both of which had let a content hash decide
which definition was considered: `maxOwnersExamined` bounded the cheap alignment
stage over `(kind, symbol_id)` hash order and discarded sphinx's `get_filetype` at
owner 96 of 106 before it could be aligned; and equally-aligned facts tie-broke on
`symbol_id`, so three of four indistinguishable candidates were taken by hash. A
structural exactness class (exact token identity outranks stem approximation) now
decides, with `symbol_id` only as the final deterministic tie-break. Oracle Top-1
unchanged at 1/30. Holdout unconsumed, ARC not run.

## M153-C4 continuation (commits 4b02ea04, <evidence>)

Verdict unchanged: **INCOMPLETE** (A PASS · B PASS · C NOT PASS · D/E not run).
C4 focused verdict **PASS**; M153-C still NOT PASS (§49). One propagation defect
proven by paired trace and fixed: a bounded lane's admissions were being truncated
by ordinary ranking's deliverable cap. `get_filetype` moves from absent to pool
rank 65; `get_adapter` control byte-identical at rank 1. Oracle calibration
unchanged — **0 substantive per-case differences across all 35 cases** — and the
taxonomy is unchanged. Behavioural lane still default-off; workspace routing not
rerun (§24). Verification: typechecks clean, `bun test` 4670 pass / 0 fail,
`git diff --check` clean. Holdout unconsumed, ARC and TCKDB not run.

## M153-C4 standing findings

- **A contract written for a class was applied to an instance** (M153-C4): M142-C
  established that "the cap bounds what ORDINARY RANKING returns, and a lane that
  exists because ranking cannot see its findings does not compete for ranking's
  slots" — then implemented it for the concept-owner lane by name. The
  operation-fact lane satisfies that description in its own header and was still
  routed through the cap. The defect was not in either lane but in the contract
  being bound to a lane identity rather than to the property that defines the
  class.

- **The case that exercised the lane was the case that did not need it**
  (M153-C4): `Session.get_adapter` is the corpus's single operation-fact success
  and it scores `fts = 1` — a full lexical name match, rank 1 of 96 on ordinary
  evidence alone. It would have been delivered with the lane switched off. So the
  lane's containment was invisible for three phases: its only passing case was
  the only case independent of it. When a lane's success set and its purpose set
  do not intersect, the lane is untested however green it looks.

- **Distinguish truncated from out-ranked before touching a score** (M153-C4):
  `get_filetype` was present in `evaluatedById` at rank 202 of 273 and absent
  from a pool capped at 60. Those are different defects with different fixes, and
  only the uncapped evaluated set separates them. Reasoning from the delivered
  output alone would have read as "ranked too low" and licensed exactly the score
  tuning that would have been wrong.

- **Removing a real defect need not move the number** (M153-C4): the fix is
  proven by paired trace and by three controls that fail without it, and oracle
  calibration did not change on a single case. The bottleneck moved from
  candidate propagation to delivery selection. A milestone that only counts
  aggregate movement would have discarded a correct fix and kept looking in the
  stage it had just cleared.

## M153-C5 continuation (commits e3761ab9, <evidence>)

Verdict unchanged: **INCOMPLETE** (A PASS · B PASS · C NOT PASS · D/E not run).
C5 focused verdict **PASS**; M153-C still NOT PASS (§72). One generic delivery
defect fixed — the discard gate read the one-per-query answer-role GRANT where it
should read the answer-role EVIDENCE, deleting every proven direct implementer
after the first under the reason "no relevance to the task". `get_filetype` moves
discard → support; it is then lost to the bounded delivery envelope (support #14
of 17, 4 delivered), which is recorded rather than bypassed. Behavioural unique
recoveries **0**, oracle calibration unchanged on all 35 cases, taxonomy
unchanged. Lane still default-off; workspace routing not rerun (§48).
Verification: typechecks clean, `bun test` 4676 pass / 0 fail, `git diff --check`
clean. Holdout unconsumed, ARC and TCKDB not run.

## M153-C5 standing findings

- **A grant is not evidence** (M153-C5): M150 bounded answer-role authority to one
  candidate per query, which is right, and then wired the DISCARD gate to that
  grant. So the second and third definitions that retrieval had just proven
  implement the requested operation were deleted under the reason "no
  lexical/symbol/path/test/graph relevance to the task" — a statement contradicted
  by a field on the candidate the gate did not read. Bounding who may ACT on
  evidence is a different decision from deciding who HAS it.

- **A fixture with one eligible candidate cannot test a tie-break** (M153-C5): the
  M150 delivery fixture holds exactly one grant-eligible definition, so its grant
  is unopposed and the grant and the evidence can never disagree in it. The defect
  was three phases old and fully covered by passing tests. A bound of "at most
  one" needs a fixture with at least two.

- **The obvious explanation was the wrong one** (M153-C5): the working hypothesis
  was that weak lexical evidence blocked delivery. The M150 control has lexical
  0.000 against `get_filetype`'s 0.028, identical zero localEvidence/domain/graph,
  and is delivered as lead. Three-way controls refuted in one run what a two-way
  comparison would have confirmed.

- **The fact records the mechanism, not the result** (M153-C5): sphinx's three
  competing implementers carry facts identical in every indexed field — same kind,
  operand, provenance and result-bearing flag — differing only in what they
  return (a filetype, a stripped filename, a suffix). `operation_fact` proves
  participation in a selection over the right operand; it does not prove the
  definition's RESULT is what was asked for. That is the honest ceiling, and it
  names the next representation question rather than licensing a promotion.

- **Zero unique recoveries is the metric that mattered** (M153-C5): across 20
  primary implementations in 4 calibration repositories, the lane delivered
  nothing ordinary retrieval could not already reach — and nothing wrong either.
  Aggregate Top-1 had been flat for three phases while the more informative
  question, "does this lane recover anything at all", went unasked.

## M154 — Agent Workflow Safety and Search-Contract Hardening (commits 4975d5b2, 1f13b4f2, 051a7c55, <evidence>)

Verdict **MIXED** (A PASS · B PASS · C MIXED · D PASS · E PASS). Predecessor
e3761ab9 (M153-C5 final functional). Not a retrieval milestone: its job was to
make vtrace safe and truthful enough to put in front of a coding agent before the
M155 broad qualification.

Three defects fixed. `.vtrace/index.sqlite` and `session.sqlite` were untracked
and unignored, so `git add -A` swept vtrace's own state into the user's commit —
reproduced in a plain checkout and a linked worktree, now excluded through the
Git COMMON dir (measured: the worktree-private `info/exclude` is never read),
idempotent, no tracked file and no global config touched, refusing loudly where a
repository versions `.vtrace/` content. `buildInspectFirst` closed every response
with a constant "Avoid first: Broad repository grep/find" — 17 of 19 frozen
reuse-before-write cases, now 0 — and the installed guidance block said the same
in the user's own AGENTS.md. `deriveQueryIntent` classified the project name as a
project reference, refused it as an identifier, then handed it to lexical scoring
as an ordinary content word.

Product responses now carry `coverage: {selective_task_retrieval, not_observed,
enumerationComplete: false}`, reusing the M149 negative-claim vocabulary rather
than a parallel one; exact symbol/path absence keeps its stronger reading.
Deterministic suites 0/50 changed, provenanceValid true, srcDirty false. Full
suite 4698 pass / 0 fail, typechecks and `git diff --check` clean. Behavioural
routing default-OFF, now asserted by test. Holdouts unconsumed; ARC not run.

## M154 standing findings

- **The most dangerous string in the product was a constant** (M154-D): the
  advice not to grep was not a judgement about evidence, coverage or confidence —
  it was a literal assigned on every path, including the low-confidence
  "does this already exist?" lead where following it means writing a second copy
  of code that exists. Anything asserted unconditionally is not a finding about
  the case; it is a property of the code that emits it, and it should be read as
  a claim the system is making about EVERY case before it is believed about one.

- **A field that is only ever true cannot be tested by a passing suite**
  (M154-D): `avoidFirst` was typed `string | null` and was never null. The type
  described a decision nobody made. Three test files asserted the block contained
  "Avoid first:", so the constant was fully covered — coverage of a constant
  proves the constant, not the decision it stands in for.

- **The protection was real and stopped one layer short** (M154-C): the project
  name was correctly identified, correctly refused as an identifier, and then
  passed unchanged into `positiveSearchText`, which BM25, path relevance and
  concept-owner tokenisation all consume. A classification that does not reach
  every consumer of the thing it classifies is a comment, not a rule. The fix was
  not new logic; it was making the lexical bag honour a decision already made.

- **Measure where Git actually reads, not where the path looks right**
  (M154-B): a linked worktree has `$GIT_DIR` at `.git/worktrees/<name>` and
  `$GIT_COMMON_DIR` at `.git`, and only the second is consulted for
  `info/exclude`. An implementation using the obvious `--git-dir` passes every
  single-checkout test and does nothing in exactly the linked-worktree workflow
  that motivated the work. Two `git check-ignore` calls settled it in a minute.

- **A zero can be the instrument reading zero** (M154-E): the first baseline
  reported `unsupportedAntiSearchAdvice: 0` on the predecessor that emitted it
  everywhere. Two independent measurement defects — the guidance block is built
  downstream of `buildCapsuleV2` and was never constructed, and the detector's
  span could not cross the newline between the "Avoid first:" heading and its
  bullet. A zero on a metric that has never been non-zero is evidence about the
  harness until something makes it move.

- **The fixture never let the code under test run** (M154-C): `resolveProjectNameAliases`
  reads the repository root BASENAME, and every existing suite is rooted at a
  SWE-bench instance directory (`psf__requests-1142`). The alias could never equal
  a project name, so project-name handling had never been exercised by any suite
  in the repository. Measuring it required materializing copies named `requests`,
  `flask`, `pytest`, `sphinx` — and the same fact is why the deterministic suites
  are 0/50, which is evidence of containment rather than of inertness.

- **A generic mechanism does not owe you the observed harm** (M154-C): the
  invariant violation reproduced exactly and was fixed structurally, and the
  outcome-level corruption ARC reported did not reproduce on four unrelated
  repositories — zero paired regressions on BOTH sides, one improvement traded
  for one regression. Fixing a proven rule violation is worth doing; claiming it
  explains the original report is not, and C is MIXED for that reason.

## M155 — Broad SWE-bench Regression and Agent-Utility Qualification (commit <evidence>)

Verdict **INCOMPLETE at decision point** (A PASS · B PASS · C PASS · D DEFERRED ·
E NOT RUN). Candidate `051a7c559efcc90848390922b8a42293fb66dba5` (M154 final
functional). An evaluation milestone: no product code changed, behavioural routing
default-OFF, `git status --porcelain src/` empty.

A recovered the historical protocol from repository evidence and found three
defects, two of which would have invalidated the measurement. B/C then rebuilt 500
repository indexes — five architecture-era anchors (M129, M140, M150, M152, M154)
each indexing its own isolated copy of the same immutable 100-case corpus with its
own `bin/vtrace` — and ran four adjacent paired comparisons, all `provenanceValid`
with isolated indexes and identical fixture hashes.

Broad result across five eras: gold **delivered** to the model 79% → 78% (M140
peak 80%), gold symbol anywhere **64.0% at every checkpoint**, File Top-3 73% →
73%, File Top-1 +1pt, median tokens −20, median latency +19% (593 → 708 ms).
Three regressions (all M129→M140, all `path authority`, incl. the known
`sympy__sympy-12419`), zero delivered-gold improvements. M152 store split 0/100
semantic changes; M154 2/100, all outcome-neutral pure discard-bucket movement.
Verification: typechecks clean, `bun test` 4724 pass / 0 fail, `git diff --check`
clean. Holdouts unconsumed; ARC and TCKDB not run; no live agent spend.

## M155 standing findings

- **The regression suite could not observe the work it was policing** (M155-A):
  the committed `expanded`/`cross_repo_30` baselines, labelled authoritative, read
  workspace indexes built once on 2026-06-08 at a commit 491 back. Freshly indexed
  at M154 the same instance yields `document_chunks` 0→6, `symbol_mechanism_facts`
  0→79, `module` symbols 0→69. M129's document lane, M150's mechanism facts and
  M140-A's module import-owner contributed nothing to any measurement taken on
  that corpus. The tables were present but empty — opening a stale index migrates
  its schema without populating it, so the instrument reported a product whose
  newest lanes were structurally inert, and reported it as authoritative.

- **"Found" and "delivered" are different claims** (M155-B): `gold anywhere` rose
  85% → 89% at M140→M150 and every downstream milestone inherited the gain. Over
  the same step `discarded` rose 6% → 11% and gold actually delivered to the model
  FELL 80% → 78%. Five of the eight improvements are cases moving
  `missing → discarded`: gold entered the candidate pool and was still withheld. A
  metric that counts evidence the model never sees will report progress that no
  agent can use.

- **Flat is a finding when the instrument can finally see** (M155-C): across five
  architecture eras on the broad corpus, gold symbol anywhere is 64.0% at every
  single checkpoint and File Top-3 is unchanged. The local wins were real in their
  fixtures and did not accumulate. The reason is visible in the same run:
  Frozen50's delivered-gold is 90% at all five checkpoints, and Frozen50 is ~19
  points easier on Top-1 than the broad corpus. Steering by a suite that is both
  easier and blind to index-side change is how five eras produced a flat result.

- **The same path defect recurred, and the guard existed** (M155-B): the first
  misleading-lead detector compared a repository-relative gold path against a
  workspace-relative lead literally, scoring 26 of 100 correct leads as misleading
  and putting Top-1 (57%) and misleading-lead (67%) at a sum above 100. M143-A hit
  this exact defect — it inverted that milestone's conclusion — and left
  `samePath` plus a permanent guard test behind. New benchmark code did not reach
  for it. An arithmetic impossibility in the output caught it; nothing else would
  have.

- **A cost with no delivered benefit is still a cost** (M155-C): M150's mechanism
  lane raised median retrieval latency 562 → 717 ms and p90 1249 → 1607 ms, and it
  persists unchanged through M154. Over the same transition delivered gold fell.
  The lane's benefit is real in its own fixtures; on 100 unfamiliar tasks it is
  ~26% median latency for nothing the model receives.

- **VTRACE has never been given to the agent as a tool** (M155-A): the Stage 5
  VTRACE condition injects pre-computed text. `--vtrace-method mcp` parses and is
  never dispatched; the harness spawns the agent with `--strict-mcp-config` and an
  empty `{mcpServers:{}}`. Every question about tool discovery, usage rate, call
  ordering and per-tool utility is therefore UNAVAILABLE rather than zero — and
  the product's tool surface has never been measured in front of an agent at all.

## M155 continuation — B2 re-baselining + paired agent qualification (commits 87c68078, 188983e0, 964ad3e1, 157e2f5e, c529503c, 98c7c4b2, <evidence>)

M155 now **PASS** on execution (A · B · C · B2 · D · E), with product utility
**MIXED**. No product code changed; behavioural routing OFF; `src/` clean.

B2 rebuilt the regression baseline architecture. The committed Frozen50 was 5/50
derivation-valid — 41 indexes at `index_format_version: 1` against a supported set
of `{5}`, 4 with no meta at all — and is now 50/50 on freshly derived evidence
(Top-1 0.60→0.76, delivered 0.80→0.90, both on a collapsed vs complete denominator).
All four capability lanes proven observable. Frozen50 retained as the fast stability
gate, removed as the broad quality authority.

D ran 30 paired tasks (60 arms, ~$28, ~3.5 h). Treatment availability 27/30 (90%):
three cases could not be indexed at all because one unparseable file aborts the
whole repository, and one of those was a baseline PASS. On the 27 valid pairs the
solve rate is exactly flat (19/19, 70.4%, McNemar p=1.00, 2 wins / 2 losses) while
VTRACE spent 41% fewer end-to-end tokens, 40% fewer turns, 25% less money and 75%
fewer greps. Verification: 4784 pass / 0 fail, typechecks and `git diff --check`
clean.

## M155 continuation standing findings

- **The regression suite could not observe the work it was policing** (B2): VTRACE
  owns `resolveDerivationRebuildReason` and `SUPPORTED_INDEX_FORMAT_VERSIONS`, and
  the benchmark never asked them. Opening a stale index migrates its schema and
  leaves the new feature tables EMPTY, so the document lane had no documents,
  mechanism facts did not exist and module import-owners were absent — in the corpus
  used to certify that nothing had changed. The answer was one function call away
  for months.

- **An escape hatch that exists is an escape hatch that gets used** (B2): three
  purity tests failed under the new gate because their helper indexed without
  writing `index.meta.json`. The first fix was an opt-out flag; the better one was
  to make the helper record derivation metadata like a real index. The flag was
  removed rather than left in place unused, so the gate has no bypass at all.

- **A field that is only ever true is a decision nobody made** (D): the harness
  documented that `--context-policy force-inject` "NEVER degrades to a valid skip",
  which turned a clean index plus a truthful empty selection into an abort before
  spawn. force-inject overrides the cost-aware GATE; it cannot manufacture context
  retrieval did not select. Two tests had locked the behaviour in. Distinguishing
  "retrieval selected nothing" from "generation failed" was the whole fix.

- **One bad file can cost the whole repository** (D/E): 3 of 30 paired tasks could
  not receive VTRACE because a single unparseable source file aborts indexing —
  a truncated `\uXXXX` escape, an unparenthesised `except` tuple, a starred
  expression. All three files are among the 16 the deterministic preparer quarantines
  and continues past. The benchmark's ability to work around a product failure had
  been hiding the product failure. One of the three was a baseline PASS.

- **Flat outcomes, much less work** (D): 19/27 both arms, p=1.00, and VTRACE used
  41% fewer end-to-end tokens, 40% fewer turns and 75% fewer greps, reaching gold at
  tool call 0 versus 1. Injected context is 1273 tokens median — the saving is ~160×
  the payload, which is why this is an end-to-end claim rather than a capsule-size
  one.

- **Neither arm's discordance was about finding the code** (E): in all four
  discordant cases the injected lead was EXACTLY the gold file and both arms reached
  gold before their first edit. VTRACE cannot be credited with the wins or blamed
  for the losses on evidence grounds. Of 7 wrong actionable leads, the agent reached
  gold in 7 — false authority caused zero losses. What differs is downstream, in what
  the agent does with evidence both arms already hold.

- **A metric can improve while the agent gets less** (B, restated with live
  evidence): `django__django-11740` retrieved 33 candidates including gold, marked
  every one `support-only: no actionable edit target`, and delivered nothing. The
  broad corpus calls that `gold anywhere`; the agent received an empty treatment.

## M156 — Per-file parse failure containment and index availability (commits 24748cbc, d5a77cd0, 8aa76242, c3fc42d2, cc0fee91, 63036a0a, bfbb70e4, 04ed1e1f, <evidence>)

M156 is **PASS** (A · B · C · D · E). Product code changed; behavioural routing
stays OFF; the M152 store split and M154 Git-state safety are intact.

One unparseable source file made an entire repository unavailable. On the frozen
30 that cost three treatments, **two of them baseline PASSES** — the M155 prose
names one, but `stage5_m155_paired30_outcomes.json` lists two under
`baselinePassWithTreatmentUnavailable`. The seam was a single throw in
`indexProject`, which already parsed every file before opening its persist
transaction and already recorded per-file outcomes correctly. Because the throw
preceded the transaction, the old failure left **zero rows** behind — measured,
not assumed — so containment was a policy change rather than a data repair.

Availability on the same manifest, both sides freshly indexed by their own
binary: **27/30 → 30/30**, zero unavailable, three degraded. Preservation on the
27 the predecessor could already index is **27/27 with zero changed cases** —
identical indexed-file, symbol and edge counts on every one.

Broad preservation at the major checkpoint is **0/100 changed cases** on freshly
prepared corpora indexed by each side's own binary: Top-1 0.57, Top-3 0.73, gold
anywhere 0.89, symbol anywhere 0.64, delivered 0.78, discarded 0.11, missing 0.11
— identical on both sides, compared per instance rather than per rate. The
frozen50 fast gate is 50/50 derivation-valid and byte-identical to M155's
re-baseline (Top-1 0.76, delivered 0.90). All three recovered repositories
retrieve `VALID_NONEMPTY`, and the two that were baseline PASSES deliver the gold
file as their LEAD. `bun test` 4806 pass / 0 fail, typechecks and
`git diff --check` clean.

## M156 standing findings

- **One bad file cost the whole repository, and the benchmark hid it** (A): the
  deterministic preparer "quarantines and continues" by `rename`-ing offending
  files OUT of the tree, indexing, and restoring them afterwards. Its index was
  complete *for a repository that does not exist* and recorded nothing about the
  16 files it dropped — across 4 targets, at every one of five architecture eras,
  since M134. The product's own failure was invisible for as long as the
  instrument was able to route around it. The mechanism was deliberately not
  ported; under M156 the same preparer takes its first branch and quarantines
  nothing.

- **Containment was cheap because the architecture was already right** (B): parse
  completes before the persist transaction opens, and that transaction deletes
  every live graph table before re-inserting only successful results. So a failed
  file contributes zero rows by construction, and a file that REGRESSES to
  unparseable loses its stale symbols in the same commit that records its
  failure. The test that used to prove the graph was byte-identical after such a
  regression was asserting the bug: aborting is what kept `service` answerable
  from source that no longer parses.

- **The second seam was in a consumer, not the indexer** (D): a repo-readiness
  check required zero parse failures and was unreachable only because indexing
  threw first. With the abort removed it refused exactly the repositories M156
  had just made indexable — `run_pipeline` and `get_context_capsule` both — while
  `get_code_context` was fine. Testing one tool and generalising would have
  missed it; the fix was found by asserting the consumers rather than the
  primitive.

- **Freshness and completeness are different questions** (C): coverage is a
  second axis, never a term in `ready`. An index can correspond exactly to the
  current source revision and still be semantically incomplete, and a degraded
  index must stay usable — refusing to serve a repository because one test
  fixture will not parse is the failure being removed, not a safe default.

- **A miss is only as strong as the coverage behind it** (C): a hit is
  self-supporting, because an unparsed file cannot retract a symbol we found. A
  miss is a claim about everything we did not see, so an exact-symbol miss in a
  repository with an unparsed symbol-bearing file is now `unknown /
  coverage_incomplete`. A failed YAML document does NOT weaken it — its parser
  emits no symbols — because weakening every claim whenever anything failed would
  be safe-looking, useless, and quickly ignored.

- **The positive control caught two bad fixtures** (A): `return *[1, 2]` is
  accepted by CPython, so the fixture meant to reproduce pylint's
  starred-expression failure was not failing at all. And malformed TypeScript
  does not fail — tree-sitter recovers and returns a partial tree — so per-file
  containment is exercised by Python and Cython only. Recorded as a named
  limitation rather than forced, because inventing a TypeScript failure would
  test the fixture instead of the product.

- **The workaround is now dead code** (E): under M154 the deterministic preparer
  moved 16 files out of 4 repositories to make the broad corpus indexable; under
  M156 it takes its first branch on all 100 targets and quarantines ZERO. Broad
  retrieval is 0/100 changed cases across that transition — including those four
  targets, where M154 indexed a repository with files DELETED and M156 indexes
  the same repository with those files present and recorded as failures. The
  retrieval result is identical because a failed file contributes no evidence
  either way; the difference is that it is no longer silently missing.

- **A benchmark that measures nothing looks like a catastrophic finding** (A):
  two availability runs were lost, one to a source tree edited while it ran and
  one to a worktree with no dependencies installed. Both reported 27 and then 30
  spurious unavailable repositories and both were indistinguishable from a real
  regression until stderr was read. The probe now records the commit and
  dirtiness of the checkout that produced each side and refuses to write a report
  in which nothing indexed and nothing was reported as failed.

## M157 — Answer delivery and no-pivot recovery (commits f1497fc6, fb509a44, 623fa03b, <evidence>)

M157 is **MIXED** (A PASS · B NOT PASS · C NOT PASS as specified · D PASS ·
E PASS on preservation). Product code changed; behavioural routing stays OFF;
M156 availability, the M152 store split and M154 Git-state safety are intact.

The milestone asked whether VTRACE withholds useful evidence when no candidate
earns pivot authority. The gate is real and exactly where §15 predicted —
`buildCapsuleV2.ts:985`, query-global, before packing — and it is **not
candidate-local**: all 33 `django-11740` candidates had been granted support
authority and **none** was denied it. But the state could not be measured before
this milestone. `support_count` was written as a literal `0` on that path
regardless of how much was withheld, and the global discard reason overwrote each
candidate's own role decision, so "33 candidates, 0 support" meant the same thing
for a query that found nothing and one that withheld 33 relevant candidates.

The decisive number is the population. Classifying the gold file's fate across
all 100 broad cases — a classification that independently reproduces every
published M156 rate — puts **2 cases** in the bucket a delivery-policy change can
move, against **9** lost to the support packing cap and 11 never retrieved. The
no-pivot rate is 2%, the entire offline instance pool is the same 100, and the
two cases disagree about what the right answer is: `sphinx-9320` holds seventeen
candidates that MET the pivot bar, while `django-11740` holds none with direct
evidence of any kind and a top-25 support list that is a lexical explosion on the
word `Errors`. So the §34 contract was **not** implemented — the one case that
would need it does not want it, and the other is where it would do harm.

What the audit did prove is a role-classification defect: **a candidate
disqualified from the pivot role keeps the slot it consumed**. The cap runs
before the scoped-objective and non-source demotions and neither releases the
slot, so on `sphinx-9320` both slots go to `doc/conf.py` candidates the
non-source rule then disqualifies, and seventeen eligible edit targets — three of
them gold symbols — are discarded as "no actionable edit target". The fix records
`budgetDemotedPivot` (priced out, still pivot-worthy) against `pivotIneligible`
(judged unfit, never promotable) and refills genuinely free slots in ranked
order; it cannot lower the bar, invent a target, or promote a candidate any stage
judged unfit.

broad100 M156→M157: **2 changed cases, both pivot-role corrections, 0
unexplained**. `sphinx-9320` goes `skipped_no_context` → `hit_top1_pivot` with the
gold file leading; `xarray-6599` fills one wasted slot with a second gold-file
definition and is neutral. Top-1 0.57→0.58, Top-3 0.73→0.74, delivered
0.78→0.79, discarded 0.11→0.10, empty 0.02→0.01; tokens mean +10.18 with median
(1165) and p90 (3750) unchanged. frozen50 fast gate byte-identical (0 changed).
frozen30 **30/30 usable, 0 unavailable, 3 degraded (identical set)**; clean27
**27/27** structurally identical; all three M156 recovered repositories retrieve
identically. `bun test` 4820 pass / 0 fail on an idle machine, typechecks and
`git diff --check` clean.

## M157 standing findings

- **The no-pivot collapse was unmeasurable, which is why it looked bigger than it
  is** (A): two reporting defects made "0 support" ambiguous between "nothing was
  relevant" and "33 relevant candidates were withheld". M155 read the first
  meaning from a state that was the second. Both are fixed additively —
  `support_authority_withheld` is absent when nothing was withheld, so true-empty
  stays distinguishable from suppression.

- **A disqualified pivot kept its slot** (C): the cap was correct; its ORDERING
  was not. Two demotions that can invalidate a slot-holder run after the cap and
  neither releases the slot, so a candidate that met the pivot bar stays demoted
  behind a budget that is no longer spent. Generic, 2 of 100 cases across two
  unrelated repositories, and the direct cause of one of the two empty capsules.
  `capPivots` inside `refineDebugRoles` shows the correct ordering; the two blocks
  in `buildCapsuleV2` are the exception.

- **The support cap, not authority, is the bigger gold-loss mechanism** (A): 8
  cases lose gold to `beyond standard support budget (max 4)` versus 2 to the
  no-pivot gate. It is a packing question rather than an authority question, so
  it was deliberately left alone — but it has four times the reach and a real
  population (8 cases, 6 repositories) to calibrate against.

- **`django-11740` was never a delivery-policy case** (B): the fixture's gold
  symbol `generate_altered_fields` is **not in the candidate pool at all**, so no
  delivery rule could have delivered the patched definition. Its two gold-file
  candidates rank 29th and 30th of 33 on behaviour-ownership evidence alone — the
  relation M143-B closed as a measured ceiling. The exposing instance is a
  retrieval-recall case wearing a delivery case's clothes, which is exactly why
  §12 forbids it becoming the specification.

- **The no-pivot state is too rare in SWE-bench to design a policy against** (B):
  2% of instances, and reaching the 20–30 cases §25 asks for would need roughly
  1000–1500. Both real cases were consumed diagnostically, so no sealed holdout
  exists either. A support-only lane is not refuted — it is unmeasurable on this
  data, and would need a corpus built for it.

- **A gold matcher that silently reports zero is worse than one that throws**
  (B): the corpora are indexed at the package root, so fixture paths
  (`django/db/...`) never match candidate paths (`db/...`) under naive equality.
  The first audit run reported 0 gold candidates for both no-pivot cases and
  looked entirely plausible. Using the scorer's own boundary-aware `fileMatches`
  recovers 2 and 18. Caught before freezing; it would have inverted M157-A's
  conclusion.

## M158 — Support packing and bounded evidence selection (commits 348be41a, 99d578ad, f51b9609, <evidence>)

M158 is **MIXED** (A · B · C · D · E all PASS, but A passes by *rejecting* the
milestone's own hypothesis). Product code changed; behavioural routing stays OFF;
M156 availability, the M152 store split and M154 Git-state safety are intact.

The milestone asked whether a fixed rank-first `max 4` support cap lets redundant
evidence crowd out independently useful support. **It does not.** Gold that loses
a slot sits at packed positions 6, 9, 9, 11, 22, 22, 24, 26 and 28 — one case
adjacent to the bound, a median of 22. Every conservative packing rule simulated
over the product's own ordered support list recovers **zero** of the nine, and
three of them cause harm (pure score order loses gold in 6 cases). Only the bound
moves anything: 4→5 recovers 0, 4→6 recovers 1, 4→12 recovers 4 — a number read
off the gold ranks, which is the fitting §56 forbids. So no diversity packing, no
role balancing, no token-aware packing and no larger bound was built.

Three inherited numbers were wrong and are corrected: the population is **9 cases
across 5 repositories** (not 8 across 6 — the ninth, `matplotlib-26466`, is a
genuine packing loss whose gold is not useful evidence); the **item count is the
only bound that ever binds** (support was rejected for tokens 0 times in 100
cases, costing 87–156 tokens against 403–7614 of headroom); and 5 repositories
carrying 9 positives cannot support §30's repo-level split, reported before
implementing.

What the audit surfaced instead is unrelated to gold rank. Support renders
signature-only, so two genuinely DISTINCT candidates can deliver byte-identical
text — a method overridden in four classes of one file, a flag assigned in ten.
**10 of 99 cases spend a scarce slot restating evidence the same capsule already
delivered**; `django-16819` spends three of four on the literal text
`def reduce(self, operation, app_label):`. One canonical delivered identity (path
+ content mode + rendered text) may now consume at most one slot, dropped BEFORE
the bound is consumed so the freed slot refills from the existing
support-authorized order. Zero free parameters, so there is nothing to calibrate
and nothing a holdout could catch being overfitted; the split is replaced by a
whole-corpus measurement plus frozen negative controls.

Duplicate slots 12 → **0**; support slots filled **380 → 380** (the capsule did
not shrink); gold delivered **79 → 79**; envelope 100/100. broad100 M157→M158:
Top-1 0.58→0.58, Top-3 0.74→0.74, delivered 0.79→0.79, empty 0.01→0.01, tokens
mean 1658.15→1659.10. **3 scorer-visible changed cases, all
REDUNDANT_SUPPORT_REDUCTION / IMPROVEMENT, 0 unexplained, 0 regressions** — each
gained a distinct file in top-3. Gold fate is byte-identical in every bucket, and
M157's combined `role-denied / support-budget-evicted` bucket is finally split:
`role_denied` is **empty**. frozen50 50/50 derivation-valid and identical on every
rate; frozen30 **30/30 usable, 0 unavailable, 3 degraded (identical set)**;
clean27 **27/27** structurally identical; `sphinx-9320`, `django-11740` and
`xarray-6599` byte-identical; `<module>` deliveries 0; index writes 0. `bun test`
4832 pass / 0 fail on an idle machine, typechecks and `git diff --check` clean.

## M158 standing findings

- **The diagnosed cause and the recoverable cause are not the same thing** (A):
  the §8 taxonomy is real — 3 cases do rank a placeholder-scored lane entry
  (final 0.350) above earned support scoring 1.2–1.5, and 2 do spend slots on
  near-identical evidence. Fixing either recovers nothing, because the gold sits
  at position 9, 11, 22 and 24. A taxonomy that explains a failure is not yet
  evidence that fixing it helps; only the simulation over the product's own
  ordering could tell those apart, and it was worth building before any code.

- **The support-packed-out nine are a ranking population in delivery clothes**
  (A): for every one of them the first stage at which useful evidence stops being
  deliverable is ranking, not packing. `django-15037`'s gold symbol is a nested
  function that never enters the pool; `matplotlib-25332`'s gold class is not in
  the pool at all; `sympy-16792`'s gold file enters only as a 0.300 graph rescue.
  This is the same mistake M157 caught with `django-11740`, one layer down — and
  the reason §152's reclassification rule exists.

- **`sphinx-9698` argues against the fix it looks like it needs** (A): it is the
  only near-cut case, and its gold candidate at position 6 is ITSELF a
  placeholder-scored co-edit entry. Ranking placeholder lanes last — the tidiest
  ordering fix the audit suggested — would push it further out, not closer.

- **Distinct candidates can be identical evidence** (C): candidate dedupe is
  correct and untouched; what repeats is the rendered delivery. Keying on
  `(file, symbol)` instead would have looked identical on all 10 positives and
  silently destroyed 5 controls, including `sympy-16597`, which delivers
  `is_finite` twice because the two say different things. The narrow key is not
  conservatism — it is the only one that is right.

- **The benchmark cannot see its own improvement** (E): the broad100 scorer
  measures the gold file's fate, so it registers 3 of the 10 changed cases. The
  delivery instrument registers all 10. Reporting only the first understates the
  change; reporting only the second overstates its benchmark effect, so both are
  in the ledger with `useful_support_recovery = 0` stated plainly rather than
  dressed up as a retrieval gain.

- **A hardcoded output path is a delayed evidence loss** (D): two checkpoint
  runners wrote one fixed destination, so reusing either for a later milestone
  silently replaced committed evidence with a different comparison. Both now fail
  closed on another milestone's artifact. Found by M157, fixed here, and kept in
  its own commit so benchmark hygiene stays out of product attribution.

## M159 — Retrieval loss localization and candidate-depth audit (commits <audit>, <evidence>)

M159 is **PASS** as an audit milestone. **A · B · C · E PASS; D NOT RUN — correct
stop.** No product code changed; the `src` tree hash is identical at M158's product
commit and the M159 working tree (`60f9ee2b…`), which is a stronger preservation
proof than any re-run.

The milestone asked where the retrieval pipeline first loses the evidence behind
the 20 residual broad100 failures. All 20 localize, **0 unexplained**, and the
answer contradicts both inherited bucket names. `LANE_GENERATION_FAILURE` 8 cases /
4 repos; `CANDIDATE_GENERATION_POOL_BOUND` 6 / 5; `CANDIDATE_BOUND_EVICTION` 3 / 3;
`INDEX_FILE_MISSING` 2 / 1; `INDEX_SYMBOL_MISSING` 1 / 1. Every other §106 class —
query interpretation, lane eligibility, relevance ranking, role authority, the
no-pivot gate, support packing, serialization — is **empty as a first divergence**.

The decisive measurement is the **delivery ceiling**: across 100 cases the product
delivers 570 items and has **never delivered one deeper than ordinary rank 30**
(p50 4, p90 14, p99 25). The nine bound-population targets become available at
ranks 40, 51, 74, 87, 110, 162, 343, 369 and 1058. Every simulated bound
intervention — pool cap 25→50, 25→100, generation-pool widening — therefore
recovers **0**, and the whole family is refuted at once rather than one rung at a
time. §42 stops being a policy and becomes a measurement. Decision:
**MULTIPLE_SMALL_POPULATIONS**, no functional work.

Three structural hypotheses were each shown the delivered cases as a control and
all three were rejected: task-never-names-the-gold-symbol 19/20 vs **50/79**,
private/dunder gold 11/20 vs 32/79, degenerate task body 13/20 vs 32/79. Two
benchmark corrections: `django-13590` and `django-15572` are **invalid instances**
(gold file never checked out; 442/477 indexed files against a peer range of
827–869), recorded and deliberately **not** repaired mid-audit; and the residual
ground truth splits 13 `USEFUL_PRIMARY` / 1 `USEFUL_SUPPORT` / 1
`PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT` / 3 `AMBIGUOUS` / 2 `GROUND_TRUTH_ERROR`.

Preservation measured, not asserted: `sphinx-9320`, `django-11740` and
`xarray-6599` byte-identical; M158 duplicate-support manifest hash `326abc25…`
byte-identical to M158's candidate (0 duplicate slots, 380 support slots, 79 gold);
`<module>` deliveries 0; index writes 0; routing OFF. `bun test` 4832 pass · 49 skip
· 0 fail; typechecks and `git diff --check` clean.

## M159 standing findings

- **The nine "deep-ranked" cases never had the gold symbol in the pool at all**
  (A): `goldSymbolCandidates = 0` in **all 20** residual cases, a number no prior
  milestone printed. The candidate sitting at packed position 22 is a *different
  symbol from the same file*, so recovering that slot would deliver a sibling
  definition rather than the patched one. M158 re-read the nine as "ranking depth";
  they are not a ranking population either. `django-15037` is the clearest case —
  its gold `table2model` is a **nested function** that is not an indexed symbol,
  while its gold-*file* candidate sits at rank 9, comfortably inside every bound.
  That mismatch is how it wore a packing failure's clothes for two milestones.

- **The delivery ceiling refutes bound interventions in one measurement** (C):
  before widening any bound, ask what the delivery layer has ever actually
  reached. 570 delivered items, nothing past rank 30. Any candidate available only
  at rank 40+ is not "slightly too deep" — it is outside the range delivery has
  ever used, so admitting it changes nothing. This generalises past M159: it is the
  cheapest available refutation of any future pool/cap proposal, and it should be
  re-measured rather than re-argued.

- **A hypothesis that never meets its control is the most expensive thing an audit
  can leave behind** (C): the degenerate-task-body theory is compelling on
  inspection — 13 of 20 residual tasks collapse to `### Bug summary` or
  `(last modified by Tim Graham)`. Then the same measurement finds the identical
  degeneracy in **32 of the 79 cases that succeeded**. Same for the sharpest fact
  found, the missing lexical handle: 19/20 residual, and **50/79 delivered**.
  Necessary, not sufficient. A rule built on it fires on 50 healthy cases to reach
  19 sick ones.

- **`UNREACHABLE_BY_GENERATION` means unreachable by HYBRID generation, never by
  the product** (B): the reach detector's positive control failed 42/43 on
  `sympy-13480`, which delivers `cosh.eval` while no hybrid generator scores it —
  the product reaches it through `computeClassMethodExpansion`, a post-hybrid lane,
  exactly as `evaluatedById`'s own contract warns. The hole was measured rather
  than papered over: the footholds that lane needs (`parentScored`,
  `taskNamesGoldSymbol`) were checked on every residual case, and
  `taskNamesGoldSymbol` is **false in all 11** unreachable ones. Real hole, zero
  effect on any residual verdict.

- **Two broad100 instances are not benchmark instances** (A/§102): `django-13590`
  and `django-15572` were checked out without the package subtree holding their
  gold file, and have counted as retrieval failures since M157. The known-positive
  control bounds it — the same on-disk probe finds the gold file present in 98 of
  100. Deliberately **not** repaired: the M156 corpus is the immutable baseline
  every M156–M159 comparison rests on, so the historical 79/100 is reported
  unchanged with the qualified 79/98 stated beside it, never substituted for it.

- **Patch gold and useful evidence diverge often enough to qualify the metric**
  (A/§95): 16 of 20 residual failures are genuine useful-context misses; 2 are
  corpus defects and `sympy-16597`'s gold includes `ask_generated.py`'s
  **machine-generated CNF fact tables**, which no reader would orient by. Broad
  retrieval quality is modestly better than raw gold fate implies — a
  qualification on the metric, never a replacement for it.

- **The remaining headroom is a measured ceiling, not an unfixed defect** (C): the
  largest population (8 cases / 4 repos) fails because the task offers only a
  behavioural description and the link to the implementing definition does not
  exist in the index. That is M143-B's subject→owner ceiling and M153's
  result/effect ceiling meeting on one corpus. It is sympy-weighted exactly as
  M153's evidence was sphinx-weighted, so §68 forbids building on it here. It needs
  a corpus **built to measure it** — that, not another broad100 pass, is the next
  milestone.

## M160 — Independent broad retrieval generalization (commits 227b6fbe, 3c3c14d3)

M160 is **PASS** as a replication milestone. **A · B · C · D · E all PASS.** No
product code changed; `git status --porcelain src/` was empty throughout. A clean
falsification is a PASS (§96), and that is what this is.

The question was whether M159's causal picture describes VTRACE or describes a
hundred tasks that five milestones had read. Reconstructing Broad100-A's identity
mechanically produced the fact the milestone turned on: **Broad100-A is exactly
the vexp harness's `swe-bench-100.jsonl`**, so the unconsumed population it must be
disjoint from is empty in that file. It exists only because Broad100-A is a strict
subset of SWE-bench Verified, leaving 400 instances in the same benchmark family.
**Broad100-B**: 100 cases, 11 repositories, max 11 per repo (against A's 44 django),
sympy at 10%, **0 overlap** asserted mechanically, manifest hash
`68854de5…`, frozen before any retrieval ran.

**The class replicates; the mechanism does not.** `LANE_GENERATION_FAILURE` 8 cases
/ 5 repos (8.0%) against A's 8 / 4 (8.2%); `CANDIDATE_GENERATION_POOL_BOUND` 8 / 6
against 6 / 5; `CANDIDATE_BOUND_EVICTION` 6 / 5 against 3 / 3; **`SUPPORT_PACKING`
4 / 3, a population A did not have**; `INDEX_FILE_MISSING` 0 (A's 2 were the corpus
defects, and B's integrity gate stopped their equivalents entering).
`RELEVANCE_RANKING` and `QUERY_INTERPRETATION` are **zero on both corpora**. 27/27
residuals localized, **0 unexplained**.

But inside the largest class the subtypes invert: A is 6-of-8 subject-owner/
result-effect with **5 of those 6 sympy**; B is 3-of-8 across matplotlib and
scikit-learn with **zero sympy**, and B's dominant subtype is *the query naming no
identifier the index represents* — 5 cases / 4 repos, nothing to bridge **from**.
The simulation settles it: the subject→owner bridge in its most favourable form
(class members plus inherited members, recovery credited at any rank) recovers
**0 of 6 on Broad100-A** — five of those six queries name no class at all — and
1 of 3 on B at 45 injected candidates against a pool of 25. Decision:
**NO_SINGLE_DOMINANT_CEILING**; §69 **NOT REPLICATED — do not build**; recommended
next step is a **fresh paired live agent-utility qualification** on the post-M159
product, which needs authorization and was not started.

Quality: Top-1 0.41 (A 0.58), Top-3 0.64 (0.74), gold anywhere 0.87 (0.89), gold
delivered 0.71 (0.79), empty 0.01, median tokens 1497, median latency 588 ms.
Reweighting B to A's repository mix moves Top-1 only to 0.44 — B is genuinely
harder. Availability 89 usable / 11 usable-degraded / **0 unavailable** with 81
contained parse failures. Preservation measured: `sphinx-9320`, `django-11740`,
`xarray-6599` byte-identical; duplicate support 0 on both with negative controls
6 and 7; `<module>` deliveries 0; index writes 0; routing OFF. Detector controls
14/14. `bun test` 4895 pass · 49 skip · 0 fail; typechecks and `git diff --check`
clean.

Corpus lifecycle: the 100 derived Broad100-B workspaces (**8.9 GB**) were deleted
after closure. The manifest's 100 base commits, integrity records, hashes,
protocol, fixture and all results stay committed, and a post-deletion rebuild of
two cases reproduced their committed index records exactly — so Broad100-B is
reproducible rather than resident.

## M160 standing findings

- **A causal distribution can replicate while its mechanism does not.** All three
  of Broad100-A's largest first-divergence classes reappear on unfamiliar tasks at
  comparable rates and slightly wider repository spread — and the story M159 told
  about the largest of them survives none of it. Class-level replication is cheap
  and reassuring; mechanism-level replication is what a feature actually needs.
  Only subtyping BOTH corpora tells them apart, and the two answers here point in
  opposite directions.

- **The corpus that produced a theory is the worst place to test its cure.** The
  subject→owner bridge recovers **0 of 6** on Broad100-A, because five of those six
  queries name no class the index represents — the bridge has no starting point on
  the cases that inspired it. The theory was built from evidence it structurally
  cannot address, and nothing short of simulating the actual intervention over the
  actual population would have shown that. M158's lesson, one level up.

- **Benchmark preparation is a measurement instrument, and it fails like one.**
  M159 found two Broad100-A instances half-extracted; M160 reproduced the failure
  live — `django-12741` at **1902 of 3381 paths with `tar` exiting 0**, plus 13
  more workspaces lost outright. The cause is a `git fetch` repacking a bench clone
  while a `git archive` streams out of it. An index over a half-tree builds
  perfectly well, so nothing downstream can notice. A per-path check against
  `git ls-tree` costs milliseconds and is the only thing between that and a silent
  "retrieval failure".

- **One attempt is not a measurement.** The integrity gate's first run declared 16
  instances `CORPUS_INVALID` across 8 unrelated repositories; every one fetched on
  a manual retry seconds later. Twice now a transient error has nearly become a
  permanent claim — M159's was a broken fixture blamed on the product, M160's was
  a flaky network blamed on the benchmark. Retries belong in any probe whose
  failure mode is indistinguishable from a finding.

- **Naming a symbol is not naming its owner.** `fit_predict` has **nine** indexed
  definitions in scikit-learn and the class the task names *inherits* it rather
  than defining it. The first subtype classifier treated a mentioned identifier as
  an owner handle and hid a real bridging failure behind it. Any detector — or
  product lane — that makes that assumption will be wrong exactly where
  inheritance does the work.

- **The remaining gap is in delivery, not discovery.** `gold anywhere` barely moves
  between corpora (89% → 87%) while Top-1 falls 58% → 41% and delivery 79% → 71%,
  and repository-mix reweighting explains about 3 of those 17 points. On unfamiliar
  tasks the product finds the right file at nearly the same rate and leads with the
  wrong one far more often — a failure none of the six first-divergence classes
  names, and one that no bound, pool or ranking change in this milestone's
  simulation set addresses.

## M161 — Fresh paired coding-agent utility qualification (commits 3af6057a, 3eb9daa0, 1a47ac75, b6bc98fa)

M161 is **PASS** as an execution milestone. **A · B · C · D · E all PASS.** No
product code changed; `git status --porcelain src/` was empty throughout. The
product utility verdict is **POSITIVE, scoped to orientation efficiency**, the
strategic gate is `UTILITY_POSITIVE`, and the extension decision is
**`DO_NOT_EXTEND`**.

Four milestones improved, ruled out, or failed to replicate a retrieval mechanism
without anyone measuring whether the retrieval helps a coding agent. M161 measured
it. Fresh corpus: SWE-bench Verified minus Broad100-A and Broad100-B, reconstructed
mechanically — **300 eligible, 0 metadata drops**, 120 drawn as a 100-case extension
set plus a 20-case predeclared reserve, `paired30` a strict prefix, **0 overlap**
asserted, 8 repositories at **20.0% max share** against Broad100-A's 44% django.
Integrity gate **50/50 VALID, 0 retries**. 60 live arms, **0 failures, 0 infra
retries, 0 reruns**, $41.07, ~3h07m.

**The headline is a non-result and a result.** Resolution **19/30 in both arms**;
2 discordant pairs; exact two-sided p = **1.0**. But agent work falls reliably:
median tool calls **15 → 10**, searches **4.5 → 3**, turns **38 → 26**, first-edit
position **6 → 4**, gold reached before first edit **29/30 → 30/30**. Tokens and
dollars do **not** follow — 14 pairs cheaper against 16 dearer, median cost delta
**+$0.017** — because the capsule is re-read every turn through the cache. VTRACE
additionally costs a median **42 s** of index build.

**Treatment availability 30/30** (29 `VALID_NONEMPTY` + 1 `VALID_DELIVERY_EMPTY`,
**0 unavailable**) against M155's 27/30: M156's parse-failure containment
generalized to unfamiliar repositories rather than being specific to the corpus it
was built against.

**The §107 answer is clean.** Conditional on a correct lead the agent spent a median
**164k fewer tokens and 4.5 fewer turns** on the same task; conditional on a wrong
lead, ~71k more. Yet `LEAD_GOLD` resolved **9/14 in both arms**. Top-1 is an
efficiency lever and not a solve-rate lever. Lead quality: 14 `LEAD_GOLD`, 7
`LEAD_WRONG_GOLD_ELSEWHERE`, 8 `LEAD_WRONG_NO_GOLD`, 1 `VALID_EMPTY` — Top-1 48%,
between M160's two corpora.

Treatment deliberately **not historical-treatment identical**: five
benchmark-authored policy blocks (`STAGE5_TOKEN_DISCIPLINE`, `PIVOT_CHECK`,
`EDIT_GUARD`, `PATCH_VERIFY`, trailing orientation `Instruction`) were disabled in
both arms, so M161's absolute numbers are **not comparable to M155's paired-30**.
Nothing was deleted; the milestone declined to inject. Three harness defects found
and fixed (D1 undeclared policy blocks, D2 valid-empty misclassified as
unavailable, D3 unpopulated sweep reading as valid-empty); none touched product
behaviour. `bun test` 4943 pass / 49 skip / 0 fail; typechecks and `git diff --check`
clean.

## M161 standing findings

- **A wrong lead is almost entirely harmless, and that is measured rather than
  assumed.** Agents **ignored** the wrong VTRACE lead in **13 of 15** cases and
  edited gold instead; **11 of 15** wrong-lead cases resolved anyway. The 2 that did
  edit the wrong lead were **shared failures** — the baseline failed independently
  on different wrong files. Unique harm from anchoring: **0**. False absence: **0**,
  with the detector shown to fire on a synthetic positive. §146's precondition for a
  lead-selection milestone does not hold, and neither does §147's for abstention.

- **Optimising Top-1 optimises the wrong outcome.** It buys a large, paired,
  within-task efficiency gain and buys **no additional solutions** — `LEAD_GOLD`
  resolved 9/14 in both arms. Five milestones of ranking work were aimed at a metric
  that moves cost, not capability. Anything downstream that treats Top-1 as a proxy
  for utility is measuring the wrong thing.

- **Fewer turns is not fewer tokens.** Turns fell in 18 pairs against 8, yet tokens
  were a coin flip (14 vs 16) and cost median rose $0.017. The injected capsule is
  re-read on every turn through the cache, so a shorter run over a larger prefix
  cancels. Any future efficiency claim must be made on total workflow tokens (§57),
  never on turn counts or on the size of the injected block.

- **Read what the treatment actually delivered, not what the flags say it
  delivered.** The VTRACE arm carried **2516 bytes of agent policy against 12249
  bytes of evidence** — patch-first, do-not-grep, write-an-edit-plan,
  verify-your-patch, orient-before-searching. One block was known; the other four
  were found only by reading the snapshot the first smoke run injected. Two of them
  reference nothing from the capsule at all, so every historical Stage 5 arm
  comparison was measuring evidence *plus* prompt engineering.

- **A signal meaning "nothing was delivered" is not a signal meaning "nothing
  worked."** Two of three harness defects were that same confusion in opposite
  directions: M155 filed a product failure as an empty delivery; M161 initially
  filed the product's own correct refusal to deliver as a product failure. Delivery
  and availability are different questions and the field that answers one does not
  answer the other.

- **Both discordant pairs were agent self-harm, not retrieval.** The one "win" is
  the baseline stashing its own correct fix as its final tool call, on a task where
  VTRACE delivered no gold at all. The one loss is a worse patch written on the
  *identical* two files, with identical search counts. A 1-1 split reads as "a wash"
  and would have been reported as one; only opening both transcripts showed neither
  had anything to do with context.

## M162-A — Callable agent surface audit and composition repair (commit pending)

Verdict **PASS** for workstream A; M162 overall **IN PROGRESS** (B/C/D/E open).

M161 left one question: was the flat pass-rate a limit of VTRACE's repository
intelligence, or of the static-injection architecture that delivered it? M162
tests the second by exposing VTRACE as callable tools. A audits what is
actually callable and freezes the set.

**Frozen set: `get_code_context` + `get_impact_graph`.** Read out of the live
registry in-process and probed over real JSON-RPC against `vtrace mcp-serve` —
14 tools visible, 7 hidden, all `wired`/`engine_delegate`. Every exclusion has a
stated capability reason: `run_pipeline` and `get_context_capsule` are the same
capsule pipeline behind different doors, `search_logic_flow` and `get_skeleton`
are deferred, index/setup tools are infrastructure, session/memory tools are
state (one of them a write surface), and `search_symbols` stays hidden.

**CALLABLE does not start at zero VTRACE tokens.** The full visible surface
costs ~5,521 schema tokens, carried in the prompt prefix every turn — the same
mechanism that cancelled M161's efficiency gains. The frozen set costs 1,937,
plus 128 for the routing policy: **2,065 tokens is CALLABLE's turn-0 cost**, and
the figure STATIC's capsule must be compared against.

**The two tools did not compose, and that was nearly invisible.**
`get_impact_graph` resolves `path/file.py::Class.method`; nothing
`get_code_context` showed an agent was a valid argument. Headers rendered
`path::localName`, `leadPivot` emitted a doubly path-prefixed string that
resolved nowhere, and the canonical value reached the response only nested under
`metadata`. Module-level functions and classes masked it because their local
name equals their qualified name — it bit **methods**, which is what SWE-bench
tasks edit. Repaired under the wiring-defect exception as one canonical identity
path sourced from the existing `fqName` authority, never synthesized at
serialization time. Retrieval proved unchanged: all 50 evaluator case rows and
every comparison artifact byte-identical after stripping wall-clock timing
(`stage5_m162_retrieval_no_change_proof.json`).

**Routing moved out of an adjective into one authoritative policy.**
`get_code_context` shipped as the "default first-pass" tool; routing hidden in a
tool's adjectives is neither reviewable nor removable. `VTRACE_TOOL_SUITE_POLICY`
is now served on `initialize`, hashed into the freeze, and holds one line: it may
say when a capability applies, and may not constrain the agent's own
investigation. The five historical Stage 5 policy blocks stay excluded, and the
scanner has a known-positive test proving it fires on the historical VEXP
scaffold.

`bun test` 5001 pass / 49 skip / 0 fail; both typechecks and `git diff --check`
clean. Frozen `toolSetSha256=b5c871e9…`.

## M162-A standing findings

- **Tool schemas are a static context tax, not free.** Every exposed tool's
  name, description, and schema sits in the prompt prefix and is re-read each
  turn, exactly like an injected capsule. A "callable" arm that exposes a full
  tool surface has not removed the static-context tax M161 identified — it has
  renamed it. Any future efficiency claim must count schema and policy tokens
  alongside tool-result tokens.

- **An identifier that looks valid is worse than one that is obviously
  wrong.** The capsule's most copyable string was a well-formed FQN that
  resolved nowhere, and the failure was confined to nested symbols, so the two
  shapes anyone would test by hand — a module-level function and a class — both
  worked. Composition between tools needs its own control; testing each tool
  alone would never have found this.

- **A defect at a seam can silently make a null result uninterpretable.** Had
  the pilot run against the broken contract and returned NEUTRAL, "interaction
  architecture does not help" would have been indistinguishable from "the agent
  could not ask the second question." Verifying that composition works is a
  precondition for the experiment meaning anything, not a polish step.

- **Routing guidance and investigation constraints are different things and
  must be stored in different places.** The historical scaffolds conflated them,
  which is why every prior Stage 5 arm measured evidence plus prompt
  engineering. Stating when a capability applies is discoverability; telling an
  agent not to grep or to patch first is coercion. Keeping routing in one
  hashed, reviewable policy makes the distinction auditable instead of a
  judgement call spread across fourteen descriptions.

- **Stored indexes do not survive product evolution.** An M155-era workspace
  index failed closed as `schema_incompatible` / `full_rebuild` rather than
  answering. Fail-closed behaved correctly, but it means every pilot task must
  rebuild its index at the frozen product SHA; reusing archived indexes would
  yield `repo_not_ready`, not evidence.

## M162-B/C — Callable MCP wiring, live-path qualification, and telemetry (commits 78ca90b8, pending)

**B: PASS OFFLINE / LIVE CONTROL PENDING. C: PASS.** M162 overall still IN
PROGRESS (D gated, E open). Predecessor `1962ccb0`.

M162-A showed that having two tools is not the same as being able to chain
them. B/C establish the same at the next level up, and the chain has five links
that do not imply each other: implemented, discoverable, allowed, correctly
routed, composable, observable.

**Three independent defects, each individually fatal to the arm.** The MCP
server exposed all 14 tools (~5,518 schema tokens per turn, recreating the tax
M162 exists to test); the external harness launches every agent with
`--strict-mcp-config` against `{"mcpServers":{}}`, which is why M155's agents
never had VTRACE tools at all; and the orchestrator's `--allowedTools` names no
MCP tool, so a correctly configured server would still have been
visible-but-unusable. `mcp-serve --tools` now restricts the served surface at
the source; the adapter patch sets the adapter's OWN `mcpConfigPath` and
`allowedTools` before argument assembly, so the harness keeps owning the flags
and one live path survives. Both env vars fail closed.

**The decisive control asserts on a recorded command line**, not on code shape:
it copies the real adapter, patches it with the real patcher, and runs it
against a fake `claude` that dumps its argv. BASELINE/STATIC get
`{"mcpServers":{}}` and no `mcp__` permission; CALLABLE gets the VTRACE server,
exactly one `--mcp-config`, and exactly the two frozen names.

Direct-MCP controls against real indexed fixtures: served `tools/list` equals
the frozen set **exactly**; two disjoint workspaces show no routing
cross-contamination; all four result states demonstrated and distinct;
composition holds under the tight budget that triggers compaction; impact
responses bounded (1,239 tokens default, 14,421 at documented maxima) and
over-limit requests refused at 59 tokens; **0 index writes**;
`sessionIsolationValid: true`.

**Economics finding:** CALLABLE's turn-0 fixed overhead is **2,065 tokens**
(1,937 schema + 128 policy) against a 5,518-token full-surface counterfactual —
but a single `get_code_context` call with no `max_tokens` returns **5,337
tokens**, about 1.7× M161's entire injected capsule. CALLABLE is not cheaper by
construction.

C builds ordered telemetry on the existing seam (dumb adapter patch, smart
harness parser) covering sequence, args, result state, tokens, latency,
returned paths and identities, composition, utilization, redundant lookups, and
navigation components. 27 controls with known positives AND negatives;
first-call timing precedence frozen before execution.

12-task pilot frozen from M161's untouched pre-frozen population (70 unconsumed
of 100, 0 overlap with graded), 8 repositories, max share 16.7%.
`manifestHash 8c8b2ad8…`, `scheduleHash ad1ed3f5…`. Estimated $25.33 for 36
arms plus one ~$0.70 control, ~17 min index build, ~1.9 h wall clock.

`bun test` 5045 pass / 49 skip / 0 fail; typechecks and `git diff --check`
clean. Retrieval compared against the **pre-M162 predecessor**: all 50 case rows
and all comparison artifacts identical after timing normalization.

## M162-B/C standing findings

- **An empty finding from a detector that has never fired is not evidence.**
  The historical-policy scanner passed the suite policy and all tool
  descriptions — and also silently failed to reject `PIVOT_CHECK`, whose
  wording is "do not rediscover with grep what VTRACE already named" and which
  contains no "do not use grep". Only the known-positive probe exposed it.
  Every detector shipped in B/C therefore carries both polarities.

- **A treatment can be configured correctly and still be inert.** Three
  independent layers had to agree — server visibility, MCP configuration, and
  the tool allow-list — and each was individually capable of producing an arm
  that looked configured, started cleanly, and offered the agent nothing.
  Asserting on the spawned process's argv is the only check that spans all
  three; every earlier layer of testing would have passed.

- **On-demand retrieval is not cheaper by construction.** One default
  `get_code_context` call costs ~1.7× M161's whole injected capsule, and the
  tool schemas themselves are a per-turn prefix cost like the capsule was.
  Callable delivery only wins if the agent calls sparingly with bounded
  budgets. Fixed and dynamic tokens are therefore accounted separately, because
  which of the two dominates IS the hypothesis.

- **The product is hard to degrade on purpose, which is mostly good news and
  one small honesty gap.** Neither a syntactically invalid Python file nor
  invalid UTF-8 produced a recorded index failure — tree-sitter returns an
  ERROR-node tree and bad bytes decode lossily — so both repositories indexed
  and answered. The unparseable file is simply absent from the index while
  coverage reports complete. The response-level epistemic guard holds
  regardless (`absenceClaim: not_observed`), so the agent is never told the
  missing file does not exist.

- **Reading after orientation is not rediscovery.** The redundant-lookup
  detector fires only when a search IS an already-returned identifier or path,
  never when the agent opens the implementation it was pointed at. A looser
  rule would have manufactured evidence that VTRACE fails to substitute for
  investigation, in a milestone whose central question is exactly that.

## M162-D/E — Three-arm callable architecture pilot (commits 865489f0…, pending)

**Gate 1 PASS. D PASS (execution). E verdict: CALLABLE_NEUTRAL, low-adoption branch.**
M162 overall **MIXED**: the architecture was built, proved callable, and measured;
it was then never used by the agent it was built for.

**Gate 1** — one real-agent known-positive, 2 attempts, $0.565. The live runtime
loads the server, exposes exactly `mcp__vtrace__get_code_context` and
`mcp__vtrace__get_impact_graph`, permits both, routes to the task workspace, and
the agent chained context → impact using a canonical method identity copied
byte-for-byte. Index writes 0. Attempt 1's two failures were both evaluator
bugs: the live runtime wraps results in the MCP server envelope (so a correct
composition scored as failed), and server instructions never appear in
stream-json (so scanning the transcript for the policy could not work either
way). The agent quoted the policy verbatim once asked.

**Pilot** — 12 tasks × 3 arms, 36/36 completed, **0 failures, 0 infra retries,
0 reruns**, $23.94, ~80 min agent wall time.

```text
              BASELINE   STATIC   CALLABLE
resolved         7/12     8/12      8/12
median cost     $0.473   $0.557    $0.514
median turns       30      31.5      30.5
median searches   2.5        2       2.5
VTRACE calls        —        —       0/12
```

**Zero adoption, and provably not a broken arm.** 12/12 MCP config markers
fired, 0 missing, 12/12 runs report `vtrace` connected with exactly 2 tools
visible in their own init event, 12/12 permitted, per-task workspaces correctly
bound. Across all twelve runs the agents' visible reasoning contains **zero
mentions** of vtrace or either tool: they did not weigh the tools and decline
them, they never considered them.

The single discordant task (`sympy__sympy-14976`, VTRACE_BOTH_WIN) is variance,
not evidence: CALLABLE made no VTRACE calls and got no capsule, so its treatment
content was identical to BASELINE's. CALLABLE 8/12 vs BASELINE 7/12 is one task
on an identical information diet.

**Economics:** CALLABLE carried a **larger** fixed prefix than STATIC's capsule
(2,065 vs 1,937 tokens) and fetched 0 dynamic tokens with it — schema tax paid,
no evidence bought. STATIC did not reproduce M161's orientation-efficiency
effect on this corpus (turns/searches/tool-calls flat, cost slightly higher).

Three arms produced empty patches on `matplotlib-24177` after 75–81 turns and
~$2 each; the grader declines to run on an empty patch, so the analyzer scores
it unresolved by rule, applied per arm on the same condition.

## M162-D/E standing findings

- **Availability is a measurement, not an assumption, and the pilot proved why
  on its own first arm.** That run was untooled because of a patcher defect and
  was indistinguishable from zero adoption in every results field. Only the
  run's own init event separated them. Any future tool-adoption claim that does
  not carry a per-run availability record is unfalsifiable.

- **A capable agent does not spontaneously reach for an unfamiliar
  repository-intelligence server.** Connected, permitted, described, and
  accompanied by a workflow policy stating when each tool applies, adoption was
  0/12 and the tools were never mentioned in reasoning. The static-versus-
  callable question was never actually put to the test, because the callable
  half never ran.

- **Callable delivery is not automatically cheaper, and on this corpus it was
  strictly worse.** Tool schemas are a per-turn prefix exactly like an injected
  capsule; here the schema plus policy cost MORE than the capsule it replaced
  and returned nothing. The tempting comparison — small fixed prefix beats large
  capsule — was wrong on both its terms.

- **Two milestones have now measured VTRACE without an agent ever consulting it
  on its own initiative.** M161 injected context the agent largely ignored;
  M162 offered tools the agent never called. The unexamined variable in both is
  the same one: whether the agent is told the capability exists at the moment it
  is deciding what to do. That is a prompt-policy question, and it is now the
  only informative next experiment.

- **Do not run a larger callable qualification.** Observing zero adoption more
  precisely buys nothing. §92's precondition for a retrieval milestone — right
  question, wrong evidence — did not occur, because no questions were asked.

## M163 — Callable tool adoption policy ablation (commits b5cd8f59…, pending)

**A PASS · B PASS · C PASS · D MIXED · E PASS. M163 overall MIXED.**
The policy→adoption question was answered decisively; the adoption→utility
question could not be asked, because every call the experiment finally produced
was refused by the product.

```text
architecture verdict:  HARNESS_INVALID   (scope: utility transition only)
adoption verdict:      ADOPTION_CAUSALLY_INCREASED
utility verdict:       UTILITY_NOT_MEASURABLE
extension decision:    DO NOT EXTEND
```

Three arms over M162's exact twelve tasks, holding the callable architecture
fixed and varying only policy: tool schemas alone (`--no-suite-policy`), plus
M162's byte-identical neutral suite policy, plus one required first-action
orientation call. 36/36 arms, **0 failures, 0 infra retries, 0 reruns**, $26.21
sweep + $1.17 gates = **$27.38** against a $30 authorization.

```text
                    TOOLS_ONLY  NEUTRAL  TRIGGER
adoption                 0/12     0/12    12/12
trigger compliance          —        —    12/12
resolved                  7/12     8/12     8/12
median turns              36.5     40.5     39.5
median cost             $0.563   $0.665   $0.637
dynamic VTRACE tokens        0        0     1370  (all refusal text)
evidence delivered           —        —     0/12
```

**Adoption is unambiguous.** Availability was proven 36/36 from each run's own
init event. NEUTRAL ↔ TRIGGER paired: 8 shared success, 4 shared failure, 0
unique wins either way — identical on all twelve, which under zero exposure is
the expected result and carries no information about retrieval.

**Why utility is unmeasurable.** All 14 VTRACE calls were refused. The runner
prepares workspaces with `vtrace index` and never `vtrace init`, so
`config.json`/`state.json` are absent and the MCP server's
`config.initialized && state.initialized` gate returns `repo_not_ready` — while
the same responses report `ready: true`, `fresh`, `coverageComplete: true`, and
an indexed worktree identical to the requested one down to the head commit.
Isolated offline in `stage5_m163_delivery_defect.json`. Recorded, not fixed.

Three read-side analyzer defects were found and corrected during D with five new
positive controls; raw run data preserved and the affected metrics named exactly
in `stage5_m163_final_report.md`.

## M163 standing findings

- **A trigger in the task prompt causes adoption; the same guidance served on the
  MCP initialize channel does not.** 0/12 against 12/12, same tool surface, same
  execution window. The neutral policy names `get_code_context` as the initial
  orientation tool in so many words; twelve agents were served that sentence and
  called it zero times. M162 showed availability is not consideration. M163
  narrows it: the server's instruction channel is close to inert for routing
  decisions, the task prompt is not, and the gap is mechanically closable.

- **A correctly routed tool is not a tool that can answer.** M162 ended at
  "implemented ≠ discoverable ≠ allowed ≠ correctly routed". This is the next
  link and it is the one that broke. The readiness gate and the benchmark's
  workspace preparation disagree about what "initialized" means, and every layer
  of testing between them passed.

- **A positive control built differently from the thing it qualifies validates
  the wrong path.** Gate 1 and the trigger smoke both PASSED on fixtures prepared
  with `init` + `index`; the sweep used `index` alone. They proved the runtime
  end to end and could not have caught this, because they never ran against a
  workspace shaped like the ones under test. A control's SETUP must match the
  subject's setup, not merely its runtime.

- **Degenerate labels are the default failure mode of an empty result set.** With
  no returned paths, "ignored what it returned" and "edited somewhere it did not
  name" are true by construction and fired on 12 and 8 runs. Any classifier over
  tool results needs an explicit evidence-delivered gate, or it will report facts
  about the emptiness as findings about the agent.

- **Forcing exposure is measurably safe even when it is useless.** Twelve
  mandated turn-zero calls, all refused, cost a median of 0 extra turns and
  −$0.011 with no unique losses. Whatever the risk of proactive routing is, the
  interruption itself is not it.

- **Three milestones have now measured VTRACE without an agent consuming it.**
  M161 injected context largely ignored, M162 offered tools never called, M163
  forced calls the product refused. No retrieval, ranking or candidate-generation
  work is licensed by any of them. Next informative step: repair the readiness
  seam, then re-run NEUTRAL vs TRIGGER with evidence actually delivered.

## M164-A/B — Callable readiness repair (commit pending, live half not yet run)

**A PASS · B PASS. C/D/E not started — held for live authorization.**
M163's refusals were traced to their authority, the authority was repaired, and
evidence delivery was proved through the sweep's own preparation path. No live
agent ran and nothing was spent.

```text
root cause:        SERVER_READINESS_DEFECT
answerability:     ANSWERABILITY_REPAIRED (product half; agent half unproven)
utility:           not yet asked
product changed:   YES — src/mcp/tools.ts resolveReadyRepoBinding only
retrieval changed: NO
```

`vtrace index` on a never-initialized repository deliberately writes no
`config.json`/`state.json` (a do-not-litter guard dating to `5ef21df4`), and the
Stage 5 runner prepares every workspace that way. The MCP gate required
`config.initialized && state.initialized && state.readiness.status === "ready"`
and read their absence as a statement about the index.

It was the server that was wrong, and the evidence is by consumer, not by taste:
after the gate, `binding.config` is never read again and `binding.state` is read
at exactly two sites, both passing fields `inspectIndexFreshness` already declares
optional. `get_code_context` had already called `evaluateIndexReadiness` — M141's
single evaluator, which answers from the index and never reads a lifecycle file —
and discarded its `ready` verdict in favour of a snapshot written at index time.
`index_status` carried both answers in one response: `readiness: null` beside
`indexReadiness: ready`. The CLI has served the identical evidence all along,
which is why every retrieval eval in this benchmark works.

The repair is additive. An initialized repository keeps the old gate exactly; a
repository with no lifecycle record takes read authority from the index. An
absent index keeps the old refusal verbatim, and a database-path override with no
lifecycle record still refuses.

```text
                        M163        M164
VALID_NONEMPTY           0/12       12/12
REPO_NOT_READY          12/12        0/12
negative controls         —         10/10 refuse-or-serve as specified
index writes on read      0           0
spend                  $27.38       $0.00
```

The 12/12 was measured on the twelve trees the M163 trigger arm actually ran
against, restored to base commit, re-prepared with the runner's own index step,
asserted to carry an index and no lifecycle files, and asked through a real
`mcp-serve` process started from the sweep's own config builder.

## M164-C/D/E — Paired conditional utility (commits pending)

**C PASS · D PASS · E PASS. M164 overall PASS.**

```text
answerability:      ANSWERABILITY_REPAIRED
utility:            UTILITY_NEUTRAL
architecture:       TRIGGERED_CALLABLE_NEUTRAL
extension decision: DO NOT BUILD PROACTIVE ROUTING
```

24/24 arms, 0 reruns, 0 infrastructure failures, $19.18 of a $22 cap. Neutral
policy and trigger hashes recomputed from live source and preserved; the same
twelve tasks; availability proven per run from its own init event.

```text
                    NEUTRAL   TRIGGER
adoption               0/12     12/12
first-call delivery       —     11/12   (evidence ever delivered 12/12)
REPO_NOT_READY            —      0/12   (was 12/12 in M163)
resolved               8/12      8/12
unique wins               0         0
cost                  $9.42     $9.76
```

Same eight tasks solved, task for task. Gold relation TOP_1 8/12 — three of the
four misses are siblings of gold. Every agent verified independently (12/12);
none over-trusted (false authority 0); **not one made a voluntary second call**.

Localization was not the binding constraint. The eight TOP_1 runs got the gold
file at turn zero and converted it into no advantage; the neutral arm found the
same files itself within a few ordinary searches.

## M164 standing findings

- **The seam was a false coupling, and the product was already contradicting
  itself about it.** One `index_status` response reported a null stored readiness
  beside a live verdict of `ready` for the same index. A contradiction visible
  inside a single response is not a subtle defect; it went unnoticed because no
  consumer compared the two fields until an agent was finally forced to call one.

- **A control must reproduce the subject's PREPARATION, not just its runtime.**
  M163's gates passed on `init` + `index` fixtures while its sweep used `index`
  alone. M164's control uses the subject workspaces themselves and asserts the
  shape (`index.sqlite` present, `config.json`/`state.json` absent) before
  measuring anything, so it fails loudly if it ever drifts back onto the wrong
  specimen. This is now a standing benchmark rule.

- **Repairing readiness is not the same as loosening it.** Ten negative controls
  were written before the repair was trusted: missing, stale, wrong revision,
  wrong worktree, incompatible schema, stale derivation, corrupt, missing
  manifest, and a database-path override — all still refuse, and an M156
  degraded-but-usable index still serves. Coverage stays reported beside the
  verdict rather than folded into it, which is what keeps one unparseable file
  from taking a repository offline.

- **`AVAILABLE ≠ ADOPTED ≠ ABLE TO ANSWER`, and the third link is now closed on
  the product side only.** The product answers a sweep-shaped workspace with
  repository evidence. Whether an agent complies with the trigger and whether the
  evidence helps are live questions, unasked and unclaimed.

- **The documented self-heal was unreachable by construction.** `agentGuidance`
  tells the agent that `repo_not_ready` is fixed by calling `index_repo`, and
  `index_repo` genuinely calls `initRepo` when the lifecycle files are missing. The
  sweep exposed exactly two tools and `index_repo` was not one of them, so the
  only documented escape from the refusal could never be taken. Guidance that
  names a tool the surface does not expose is guidance that cannot be followed.

- **Forced exposure to CORRECT evidence changed nothing.** M163 saw 8/12 on both
  arms with zero unique wins and it meant nothing, because no evidence was
  delivered. M164 reproduces the identical outcome under real exposure, with the
  gold file leading two thirds of the results. For this agent on these tasks,
  being handed the right file early is worth approximately nothing — finding the
  right file was never the expensive part. Four of the eight gold-led runs still
  failed, for reasons downstream of localization.

- **Zero voluntary follow-up calls, 0/12.** Twelve agents were made to call a
  free, already-connected tool; eight got back exactly the file they needed; not
  one asked it anything else for the rest of the task. This is the strongest
  single signal in the milestone and it is about perceived value, not access.

- **A classifier written against a parsed envelope fails OPEN.** The harness
  truncates large tool outputs, so `JSON.parse` fails on nearly every real
  response. Four separate M163 readers each produced a confident uniform wrong
  answer rather than an absent one: empty queries, `gold=ABSENT` 12/12,
  `WRONG_EVIDENCE` 12/12, `NO_EVIDENCE_DELIVERED` 12/12. The gold one would have
  inverted the headline and licensed retrieval work on evidence saying the
  opposite. A uniform label across a whole sweep is a broken classifier, not a
  finding — check it before believing it, in whichever direction it points.

- **§84's licence for retrieval work is still not granted, and now for the
  opposite reason.** M162/M163 could not grant it because no question was ever
  asked or answered. M164 cannot grant it because the questions were right, the
  evidence was delivered, and it led with gold on 8/12 — returned evidence is not
  systematically poor. Neither is result framing implicated: false authority 0,
  independent verification 12/12.

- **The untested variable is the task population, not the product.** SWE-bench
  Verified issues name their failure well enough for grep to find it, so ordinary
  search is cheap and a localization tool has little room to pay for itself.
  Nothing in M161–M164 has tested a corpus where localization is genuinely hard.
  That, not a better tool or a better prompt, is the informative next experiment
  if this line continues.

## M165 — Single-call investigation composition audit (commit pending)

**A PASS · B PASS · C PASS (no product change) · D PASS · E NOT FROZEN.
M165 overall PASS.** No product code changed, no live agent ran, $0.00 spent.

```text
A verdict:        COMPOSITION_ALREADY_EXISTS
decision gate:    PIPELINE_ALREADY_RICH_AND_EXPOSED
product changed:  NO
retrieval changed: NO
live spend:       NOT REQUESTED
```

The milestone asked whether VTRACE could compose a VEXP-shaped single-call
investigation from capabilities it already had. It already does, already exposes
it, and **M164 already measured it**.

```text
implemented tools     21      (registry-reconstructed, not documentation)
MCP-registered        21
default-visible       14      the reported "~14" is right for this layer only
hidden but registered  7
placeholders / dead    0
M164 live surface      2
```

`get_code_context` **is** `run_pipeline`: its metadata is a spread of
`RUN_PIPELINE_TOOL_DEFINITION.metadata`, and its handler runs an index-freshness
gate then calls `RUN_PIPELINE_TOOL_DEFINITION.handler` verbatim, overwriting only
`freshness`/`timing`/`indexMode`. §12's thin-wrapper test resolves inverted:
`get_code_context` is the wrapper, not `run_pipeline`.

Deterministic 12-task comparison over M164's own preserved workspaces, through a
real `mcp-serve` process, structured truth from the JSON-RPC payload:

```text
same lead pivot                 12/12
same item paths                 12/12
same model-visible context      12/12   (hash-identical)
same component statuses         10/12
index writes                        0
within response envelope        12/12

median get_code_context      8,678 tokens
median run_pipeline          8,480 tokens
median increment              -613 tokens   run_pipeline is CHEAPER
```

What the existing single call already delivered, by the product's own
`roleCounts`: primary context 12/12, structural skeletons 12/12, impact 10/12
(median 1.5 items), memory 0/12 (truthfully — isolated checkouts), rules 0/12,
flow 0/12. §102's meaningful-composition gate is met by the tool that shipped.

## M165 standing findings

- **The composition was never missing; only the reading of it was.** Impact runs
  on two independent lanes and only one is intent-gated. The top-level `impact`
  section requires impact/refactor intent and was skipped `not_requested_by_intent`
  12/12, while `productContext`'s ungated `addImpactEvidence` lane delivered
  bounded callers/importers/subtypes on 10/12. An audit that read only the section
  would have reported "impact never delivered" and licensed building a capability
  that already worked.

- **M164 was the pipeline experiment, retroactively.** Its twelve forced
  `get_code_context` calls each carried primary context, structural skeletons and
  (10/12) impact evidence. Its UTILITY_NEUTRAL verdict therefore reads more
  strongly than when it was issued: a bounded composed investigation, delivered at
  turn zero with the gold file leading 8/12, produced zero unique wins and zero
  voluntary second calls. The VEXP-shaped composition is not the missing
  ingredient.

- **The proposed three-arm sweep would have compared a treatment with itself.**
  CONTEXT_TRIGGER and PIPELINE_TRIGGER call the same handler and render
  byte-identical model-visible context 12/12. ~$20 would have bought a guaranteed
  null result attributable to the harness rather than the hypothesis. §101 exists
  for exactly this case and was applied.

- **A tool being cheaper than its own wrapper is a smell worth keeping.**
  `run_pipeline` costs 613 fewer median tokens than `get_code_context` because the
  wrapper's freshness diagnostics push the response past a compaction threshold,
  dropping a bounded pivot-neighborhood excerpt on 2/12. Compaction is silently
  trading evidence for diagnostics.

- **85% of the first-call response is metadata.** Median 7,407 metadata tokens
  against 996 model-visible ones. Before blaming the task population for zero
  adoption, note that an agent paying ~8.7k tokens to receive ~1k tokens of
  evidence is making a defensible economic choice. This is measurable offline and
  is the most actionable finding M165 produced.

- **Recommendation unchanged from M164, and now better supported.** The untested
  variable remains the task population, not the product surface. M165 removes the
  remaining alternative explanation — that the first call was too thin — so a
  hard-localization corpus is the informative next experiment. No retrieval,
  ranking, candidate-generation or index-schema change is licensed by M165.

## M166 — MCP response tax and model-visible compression audit (commit pending)

**A PASS · B PASS · C PASS · D RUN (scoped as directed) · E PASS.
M166 overall PASS.** One product change, no live agent, $0.00 spent.

```text
token-tax verdict:    MODEL_VISIBLE_METADATA_TAX_CONFIRMED
compression verdict:  MODEL_VISIBLE_TAX_DOMINATED_BY_TRANSPORT
                      (secondary: DOMINATED_BY_DUPLICATION)
implementation:       MODEL_RENDERER_COMPACTED
product changed:      YES  machine diagnostics held for detail=debug
retrieval changed:    NO
live extension:       NOT AUTHORIZED, NOT RECOMMENDED
```

M165 observed a median ~7,407 metadata tokens against ~996 evidence tokens and asked
whether those metadata tokens were real. They are. Of the 7,407: **0 internal-only,
6,415 transmitted (twice), 6,415 model-visible, ~8,145 in model request traffic and
billed.** M165's figure was right; its label was a domain term — `responseBudget`'s
"model visible" names the rendered context section, not the set of tokens the model
receives. The model receives all of it, complete and untruncated, 12/12.

```text
model-visible characters      median 28,178   p90 34,519
billed first-call tokens      median  8,944   bounded [8,721 , 8,975]
cache-read amplification      median 120,950  re-read across the run
share of total run traffic    median 21%
VTRACE largest tool result    12/12

cache identity held           358/363 turns
calibration                   3.15 chars/token, R2 0.926, n=363
known-positive control        PASS across four size buckets (79 -> 25,895 chars)
```

Composition of one model-visible response: transport structure 41.9%, duplicate 21.8%,
repository evidence 14.2%, machine diagnostics 11.3%, agent-useful control 7.7%,
provenance 3.9%. Measured non-evidence-to-evidence ratio 6.1 : 1.

The product change holds the machine-facing diagnostics for `detail=debug`. Acceptance
over the same twelve workspaces, paired against a stashed predecessor through a real
`mcp-serve` process: repository evidence never lost 12/12, rendered evidence identical
12/12, control semantics identical 12/12, readiness and absence semantics 12/12,
default diagnostics removed 12/12, debug diagnostics retained 12/12, selection
unchanged 12/12, index writes 0.

```text
median standard tokens     11,067 -> 10,734  (-3.0%)
diagnostics section chars   4,007 ->  1,147  (-71.4%)
evidence tokens             1,900 ->  1,966
neighborhood excerpts           8 ->     28
```

## M166 standing findings

- **The client reads the copy VTRACE did not design as agent-facing.** The server
  returns both `content[0].text` and `structuredContent` with the same payload on
  every call, and `formatListedToolDescriptor` advertises no `outputSchema`. All 12/12
  M164 tool results begin `{"schema":{"name":"vtrace.mcp_server"…` — the
  envelope-wrapped `structuredContent`. `content[0].text` is produced, serialized,
  transmitted and discarded. Any future attempt to deliver a compact agent-facing
  rendering must reckon with this: shrinking `content[0].text` alone buys nothing.

- **The response is envelope-bound, so removing metadata buys evidence, not tokens.**
  `responseTokenCeiling(requested_context_tokens)` caps the response at 9,200
  product-tokens and the progressive packer fills the cap; 6/12 responses sat within
  500 tokens of it, three within 54. The −53.6% the simulation projected did not
  arrive because the simulation modelled a response as a fixed set of fields rather
  than as a budget. What arrived instead was pivot-neighborhood evidence restored on
  5/12 tasks. **Any future compression projection must model the ceiling or it will
  overstate its saving.**

- **Duplicate accounting and duplicate removal are different operations.** Two
  components can legitimately carry the identical skip reason; removing the second as
  a restatement collapses `NO_RELEVANT_EVIDENCE` into `NOT_OBSERVED`. Short enumerated
  labels — role names, statuses, modes — are per-item semantics, not restatements.
  Removal now requires an identity-bearing value; accounting still counts from 12
  characters. Both rules are asserted by test, and both were found by the epistemic
  safety suite firing on the analysis itself, not on the product.

- **`responseBudget` understates its own cost by 1.27x.** Tool-result JSON bills at
  3.15 characters per token against the `chars_div_4` the envelope assumes. Every
  in-product token figure is an estimate at the wrong rate; treat `estimate_method`
  as a disclosure rather than a detail.

- **The shipping `detail` lever did not address the tax.** `compact` saves 1.4% and
  drops pivot-neighborhood excerpts on 2/12 — it trims explanatory prose and spends
  the saving on evidence, while diagnostics, duplication and transport scaffolding
  survive at every level. M165's smell (`run_pipeline` cheaper than its own wrapper by
  613 tokens) is now root-caused: `get_code_context` restored, after compaction, the
  freshness detail the envelope had just held back, twice over.

- **Transport structure is the largest single category, and it is not directly
  removable.** JSON keys and punctuation are 41.9% of the model-visible payload, and
  76% of sections such as `memory` and `workspaceRouting`, whose entire content is a
  few nulls and booleans in long key names. It falls only when the fields it wraps
  fall; a "render as text" variant measured *worse* than pruned JSON.

- **Response tax is eliminated as an explanation for M164's null — mechanism present,
  operation unproven.** The interaction-cost hypothesis (`PLAUSIBLE_BUT_UNPROVEN`) now
  has a measured mechanism but no evidence it operated: no M164 transcript reasons
  about cost. The untested variable remains the task population. No live experiment is
  licensed; §61's threshold fails on materiality, since the shipped change moved the
  median call by ~330 tokens.

## M167 — MCP result transport and single-representation audit (commit pending)

**A PASS · B PASS · C PASS · D NOT RUN (correct stop) · E PASS.
M167 overall PASS.** No product change, no live agent, $0.00 spent.

```text
transport verdict:    TRANSPORT_TAX_REQUIRED_FOR_COMPATIBILITY
compression verdict:  COMPRESSION_NOT_MATERIAL
product changed:      NO
retrieval changed:    NO
live extension:       NOT AUTHORIZED, NOT RECOMMENDED
next milestone:       NONE LICENSED
```

M166 noticed that `content[0].text` and `structuredContent` both carry the payload and
did not price it. M167 priced it. **The duplication is total and it costs the model
nothing.** On 36/36 captured calls the relation is `SUBSET`: the text channel is
byte-identical to `structuredContent.result.output`, and the structured channel adds
only a 157-character envelope wrapper. All eleven semantic categories are in both. And
the agent client delivers the structured channel and discards the text one — re-derived,
not cited: 12/12 M164 model-visible payloads open with a prefix the text channel cannot
produce.

```text
internal semantic output      median 33,005 chars
content[0].text raw           median 33,005 chars   (identical)
content[0].text on the wire   median 35,284 chars   (escaped, +6.9%)
structuredContent             median 33,162 chars
JSON-RPC line                 median 68,459 chars
model-visible                 median 33,162 chars = 10,526 tokens
second channel, to the model                     0 tokens
```

Four contracts simulated, each priced once per client read rule:

```text
                          wire        model    text-only client recovers
CURRENT                 68,459       10,526    12/12
STRUCTURED_ONLY         -51.4%         0.0%     0/12  (empty result, silently)
TEXT_ONLY               -48.3%        -0.5%    12/12  (removes the proven channel)
STRUCTURED+SUMMARY      -51.2%         0.0%     0/12  (53 tokens of plausible counts)
```

D fails two independent bars. **Materiality:** the best candidate saves 0.5% against a
20% gate — a factor of forty. **Contract:** VTRACE advertises protocol `2024-11-05`,
which does not define `structuredContent`, and declares no `outputSchema`; `content[]`
is the only channel a conformant client reads, and Codex is advertised in the README
with its behaviour UNKNOWN.

E controls, all on unchanged code: `src/` byte-identical to `749434ee`; selection
identical to M166's independent capture of the same twelve tasks 12/12; readiness and
served-state present 12/12; both channels returned 12/12; debug diagnostics 10/12 full
and 2/12 disclosed-omitted, 0 silent; index writes 0.

## M167 standing findings

- **A representation the client discards costs the model nothing, and the wire is not
  the model.** VTRACE serializes its result twice on every call and 51.5% of the
  JSON-RPC line is the copy nobody reads. Removing it is a 51% wire saving and a 0%
  model saving. Any future proposal that quotes a payload-size reduction must say which
  boundary it is measuring at, or it is not a token claim. This is the M166 invariant
  `SERIALIZED TOKENS != MODEL-CONTEXT TOKENS until directly measured` meeting its first
  real case.

- **The channel the proven client reads is the unsupported one.** `structuredContent`
  is served under a revision that does not define it and is announced by no
  `outputSchema`; a client that reads it does so by leniency. `content[]` — the channel
  the observed agent discards — is the only one VTRACE may assume any consumer reads.
  The naive reading of the evidence ("the text channel is dead, delete it") is exactly
  backwards. If the revision is ever upgraded the contract bar lifts, but the
  materiality bar does not: the saving was never there.

- **Removing a channel is not a semantics-preserving act for the clients you cannot
  see.** `STRUCTURED_ONLY` hands a conformant client an empty result with no error.
  `STRUCTURED_PLUS_SUMMARY` is worse, because it hands back something that reads like a
  result: "1 primary target, 2 support items, 0 impact edges" is 53 tokens of plausible
  counts where evidence was expected. Preservation was therefore scored per read rule,
  never once per candidate.

- **The model-visible restatement is inside the delivered channel, not across the
  channels.** 114 of 122 repository facts (93.4%) are rendered on more than one surface
  of the same response — prose context, structured item list, capsule digest, legacy
  context — and DUPLICATE is 34.6% of model tokens, now the largest single category.
  Reported, not proposed: it needs the authority-preservation audit, and M166 already
  proved an envelope-bound response converts removals into evidence rather than savings.

- **A classifier must be validated against the milestone it is reinterpreting.** Run
  over M166's own population this classifier returns M166's numbers (41.0 / 22.2 / 13.7
  against a reported 41.9 / 21.8 / 14.2, the residual being median versus mean), so
  M167's different mix is caused by what changed and not by how it is counted. The
  shift decomposes into payload population (M164 real runs versus local replay) and the
  M166-D change; M166's percentages are correct for what they described and are not a
  baseline anything here can be subtracted from.

- **The uniform-label smell fired on the analysis, again.** The first candidate scoring
  returned `0/12` preservation for every candidate including the unchanged status quo,
  which is impossible. Cause was mine — the preservation check was handed the prose
  section where it expects the whole model-facing payload. The M164/M166 rule earned its
  place a third time: a classifier returning one confident label for nearly every case
  is a detector smell until a known-positive discriminates.

- **`detail=debug` is not an unconditional guarantee of full diagnostics.** On 2/12
  reference tasks the debug response exceeds the envelope ceiling and the escalation
  ladder drops the machine diagnostics, disclosing it through
  `diagnostics.sectionDecisionsOmitted`. Pre-existing behaviour, unchanged here — but
  the level a maintainer switches to in order to see everything can still, truthfully,
  hold things back.

## M168 — VEXP benchmark protocol reproduction and differential attribution (commit pending)

**A PASS · B PASS · C MIXED · D BLOCKED · E NOT AUTHORISED.
M168 stopped before spend.** No product change, no live agent, $0.00 spent.

```text
protocol verdict:      PARTIAL_PROTOCOL_REPRODUCTION
accounting verdict:    ACCOUNTING_METRICS_PARTIALLY_EQUIVALENT
                       (ACCOUNTING_DEFINITION_GAP_CONFIRMED inside VEXP's own artifact)
product changed:       NO
retrieval changed:     NO
live extension:        AWAITING A DECISION (three options, section 7 of the report)
```

M165–M167 ruled out the internal explanations for M164's null. M168 turned outward
and froze the competitor's public benchmark: `Vexp-ai/vexp-swe-bench @ d658e345`,
2026-03-22, 100 tasks, Opus 4.5, 250 turns, $3/task, official Docker grading.

**The published 73% is backed by real grading and does not evidence a marginal VEXP
effect.** 98 official `report.json` files are committed and tally 73 resolved. The
same commit's telemetry does not match the same commit's treatment:

```text
timestamps      100 rows on an exact 300s grid, ordered by instance id;
                durations sum to 16,927s across a 29,700s span
vexpMetrics     null 100/100 — never collected
run_pipeline    5/100 rows, under a policy mandating it first on every task
Grep / Glob     79/100 rows, 487 calls, under a hook configured to deny both
tool naming     two spellings in one file, neither matching the harness's own
                MCP config key
eval logs       one directory, 7 distinct evaluation run ids, 1 of 99 files
                citing the directory's own id
```

**The accounting disagrees with itself by 23.5%.** Re-pricing the published token
columns with the published price table gives $0.8298/task against the published
$0.6721. Mechanism confirmed, not guessed: 95 rows report Claude Code's
`total_cost_usd`; the 5 that re-price exactly are exactly the 5 killed at the $3
cost limit, which never emit the `result` event the parser short-circuits on.

**Surfaces differ where it is most expensive.** VTRACE serves 14 tools by default,
VEXP 4 (11 registered, gated behind `VEXP_ALL_TOOLS`). VEXP spends 2,181
description chars on those 4; VTRACE 3,699 on 14. On the shared `run_pipeline`,
VEXP writes 949 chars of primacy and displacement, VTRACE 223 of alias pointer.

**Broad100-A is the VEXP manifest, exactly.** VTRACE's broad retrieval evidence
since M156 was already measured on the competitor's own task set, and Broad100-B
(with the M162/M164 pilot inside it) is disjoint, so a clean holdout already exists.

## M168 standing findings

- **A benchmark result and a benchmark treatment are separate claims, and an
  artifact can carry the first without the second.** The grading logs are real
  SWE-bench Docker output; the run rows beside them show the mandated tool on 5% of
  tasks and the denied tools on 79%. Nothing here says the score is wrong — it says
  the artifact cannot tell you what produced it. Any future milestone that plans to
  reproduce an external protocol must check treatment-compliance telemetry *before*
  budgeting the reproduction, because that check is cheap and it can invalidate the
  whole experiment. Here it cost an afternoon and saved 48 live runs.

- **Stated policy is not enforced policy, and the difference is where the behaviour
  lives.** VEXP's CLAUDE.md forbids grep, glob, Bash, Read and cat; its hook denies
  `Grep` and `Glob`, and only while a daemon socket and a healthy marker both exist.
  Index failure and daemon failure are both caught, warned and continued past. A
  strict arm can therefore degrade into an unguarded arm without anything in the
  result row saying so. Any VTRACE parity scaffold must record enforcement events,
  not policy intent — §55 was right and this is why.

- **Two accountings in one file is the M166 invariant meeting an external case.**
  `SERIALIZED TOKENS != MODEL-CONTEXT TOKENS until directly measured` now has a
  sibling: *a cost column and a token column are two measurements until one is
  derived from the other*. The 23.5% gap is not an error by either party — it is
  the difference between what a provider bills and what a stream sums. The rule
  going forward: a cross-system economic comparison names its boundary or it is not
  a comparison. VEXP's own "tokens saved" is a third boundary again — capsule
  budget consumed, not model tokens, and never against a tool-absent counterfactual
  — which makes it NOT COMPARABLE to anything VTRACE reports, including VTRACE's
  own `vtraceContextBudget`.

- **The contradiction M168 existed to resolve was never a contradiction.** M164's
  neutral marginal utility and the public 73% are not in tension, because the
  public number has no paired no-VEXP baseline. The leaderboard sets a
  caching-heavy Claude Code cost against competitors' own published figures from
  unrelated scaffolds that this harness never runs. `BENCHMARK_SCAFFOLD_GAP` and
  `ACCOUNTING_DEFINITION_GAP` are supported; `RETRIEVAL_QUALITY_GAP` and
  `AGENT_POLICY_GAP` remain untested and no longer have an external result
  demanding that they be true.

- **The competitor is not runnable here, and the runnable version is the wrong
  one.** `@vexp/core-linux-x64` never installed, vexp-cli 2.0.24 hard-gates every
  command behind an upgrade to 2.7.0, and the benchmark path requires a Pro/Team
  licence. Upgrading yields current-default policy, five minor versions past
  anything the March run could have used and past VEXP's own reported policy
  change. Arm B can only ever be
  `FAITHFUL_PROTOCOL_REPRODUCTION_WITH_RUNTIME_DRIFT`, never a reproduction of the
  published claim. The published-versus-current distinction (§13) turned out to be
  the binding constraint, not a bookkeeping nicety.

- **The most valuable remaining experiment does not need the competitor.** A / C / D
  — clean baseline, VTRACE under VEXP-shaped coercion, VTRACE with the pipeline
  offered but native tools free — isolates policy from retrieval, which is the one
  live variable M162 through M167 never manipulated. It needs no licence and no
  competitor install, and `createRestrictedMcpToolRegistry` means the narrow-surface
  arm is a configuration of shipped behaviour rather than a product change.

- **Next-step recommendation:** run the three-arm A/C/D differential on 12 tasks
  drawn from the frozen VEXP manifest (Broad100-A, where VTRACE-side retrieval
  evidence is already in hand), holding Broad100-B clean for extension. Do not
  select the sample until the arm set is fixed. No VTRACE product work is licensed
  by M168 — the gaps it confirmed are in the external benchmark's construction and
  accounting, not in VTRACE.

## M168-E protocol freeze — three-arm VTRACE policy ablation (commit pending)

**Reframed on instruction after M168-A/B/C. Sample and arms frozen; smoke
controls 9 pass / 0 fail / 5 awaiting a live agent. $0.00 spent, no product
change, awaiting authorisation for 36 runs under a $50 cap.**

The live phase no longer attempts to reproduce the historical VEXP result — its
provenance is not recoverable and arm B is blocked on a licence. It asks instead:

> Does the VEXP-published coercive investigation policy change the utility or
> economics of VTRACE's already-qualified `run_pipeline` treatment?

```text
A  BASELINE        no VTRACE at all
B  VTRACE_STRICT   mandate + VEXP prohibition text + Grep|Glob denial hook
C  VTRACE_CLEAN    mandate only

primary    B vs C      secondary   C vs A,  B vs A
```

**B and C differ by 191 characters and one hook.** The isolation invariant is
checked in code and the protocol freeze refuses to write itself if it fails:
identical MCP config hash, identical tool inventory, identical allowed-tools,
and `strict − prohibition == clean` byte-for-byte. Both policies travel the same
channel at the same prompt position (`VTRACE_TASK_TRIGGER_FILE`, last section) —
the channel M163 built and M164 qualified.

Twelve tasks, one per repository, complexity 14–234, seed 42, drawn from the
frozen VEXP manifest **before any arm was materialised**, reading only `repo`,
FAIL_TO_PASS count and gold patch size. The other 88 are untouched holdout.
Proportional allocation was rejected deliberately: at n=12 it spends five slots
on django and leaves seven repositories unrepresented, and the primary
comparison is paired, so task difficulty is already controlled while repository
shape — the thing a search-suppression policy should interact with — is not.

## M168-E standing findings (pre-execution)

- **The guard's conditionality is inherited, not designed, and it is telemetered.**
  VEXP denies only while its own engine artifacts exist and exits 0 otherwise, so
  a dead daemon silently converts the strict arm into an unguarded one. The
  VTRACE analogue conditions on `.vtrace/index.sqlite`, preserving that failure
  mode on purpose — but every hook invocation writes its decision to
  `_m168_guard_events/<label>.jsonl`, so a run whose guard never fired is
  reported `GUARD_INACTIVE` rather than pooled with guarded runs. The rerun
  policy names this case in advance and does not rerun it.

- **Reproducing a policy means reproducing its defects, including where it prints.**
  VEXP's hook writes its denial reason to stdout and exits 2. Whether Claude Code
  surfaces stdout to the model on a PreToolUse denial is UNKNOWN. If it does not,
  arm B's agent learns only that something was blocked and may retry blindly —
  which would change the very economics under measurement. The published
  behaviour is reproduced exactly rather than corrected, and the visibility
  question is a named NOT_RUN control resolved by the first live runs.

- **Stated policy stays broader than enforced policy, on purpose.** B's text
  forbids grep, glob, Bash, Read and cat; the hook denies `Grep` and `Glob`.
  Narrowing the prose to match the hook would test a policy VEXP never shipped.
  Both halves are recorded separately in `M168_POLICY_ENFORCEMENT` and nothing in
  the analysis may read one as evidence of the other.

- **A proven apparatus beat a byte-faithful one, once.** VEXP registers its hook
  through a repository `.claude/settings.json`; M168 registers it through
  `--settings`, the path this harness has actually run hooks through since M76.
  The enforcement semantics are identical and the deviation is recorded. The
  policy *text* channel was chosen the other way round — for isolation between B
  and C rather than fidelity to VEXP — because the primary comparison is internal.

- **Cost estimate is grounded in this harness's own history, not a guess.** M164's
  24 runs: mean $0.7992, median $0.6470, p90 $1.5531. 36 runs projects to $28.77,
  p90-weighted $55.91, theoretical maximum $108. Requested hard cap **$50**,
  enforced before every spawn against recorded cost plus a running-average
  projection, and never raised. Arm B costing *more* than C is a measurement, not
  an overrun.

- **Next step:** awaiting authorisation. Nothing live runs until it is given.

## M168-E — three-arm VTRACE policy ablation, LIVE (commit pending)

**36/36 runs, 36/36 graded, $24.8734 of a $60 cap. Parity 36/36. Guard 5
guarded / 7 unexercised / 0 degraded / 0 fault. `src/` byte-identical to
`de7bfe48` throughout.**

```text
A  BASELINE       7/12       task only
C  VTRACE_CLEAN   8/12       + run_pipeline mandate
B  VTRACE_STRICT  6/12       + VEXP prohibition text + Grep|Glob denial hook

B vs C   VTRACE_STRICT_NEGATIVE          0 unique wins, 2 unique losses
C vs A   VTRACE_CLEAN_INCONCLUSIVE       +1 task, 3 wins / 2 losses, +$0.134
B vs A   VTRACE_STRICT_NEGATIVE          -1 task, more expensive

causal attribution   AGENT_POLICY_GAP — behavioural mechanism CONFIRMED,
                     economic and outcome benefit REFUTED
```

**The finding is in the decomposition, not the totals.** The hook only fires
when the agent reaches for Grep/Glob, so splitting the twelve tasks by whether
it ever denied anything separates a policy that bound from one that merely sat
there:

```text
guard denied a real attempt (n=5)    A 2/5   C 2/5   B 0/5
agent never attempted a search (n=7) A 5/7   C 6/7   B 6/7
```

Where the coercion bound it went 0 for 5; where it never bound it matched the
clean arm exactly. Every task in B's deficit is a task where the hook fired.

## M168-E standing findings

- **A blocked search is not a saved search.** Denial displaced investigation
  into the channels the hook does not cover. On seaborn-3187 the blocked arm did
  2.5× the Bash work, 25% more reads and 32% more turns than the arm allowed to
  search — and still failed where that arm succeeded. This is the
  stated-versus-enforced gap M168-A recorded, now measured: the published policy
  forbids grep, glob, Bash, Read and cat in prose and enforces only Grep and
  Glob. Any claim that search suppression reduces tool calls or tokens must
  measure the substitution, because the agent obeys the wall it can feel and
  walks around it.

- **The mandate does the search reduction; the coercion does not.** B is never
  higher than C on search attempts, but 7 of 12 pairs tie — mostly both at zero,
  because the clean arm already stopped searching without being forbidden.
  Against baseline both VTRACE arms cut searching (B lower on 8/12, higher on
  none). The hook's marginal contribution to the behaviour it exists to produce
  is approximately nil, and its marginal contribution to outcomes is negative.

- **Reduced searching did not reduce cost.** Both VTRACE arms cost more than
  baseline on 10 of 12 tasks, a ~$0.134 median premium for the clean arm and
  ~$0.095 for the strict one, with cache creation up on 11 of 12. The delivered
  context is more expensive than the searching it displaces. Combined with
  M166/M167 this closes a long arc: the payload is envelope-bound, the duplicate
  channel is free, and now the evidence itself is priced against the alternative
  it replaces — and it is not cheaper.

- **Adoption is solved and was never the problem.** `run_pipeline` was the first
  action on 12/12 runs in both treatment arms. M162 and M163 spent themselves on
  getting the tool called; it is called, every time, and the utility still does
  not appear.

- **Two apparatus defects were caught before they billed, both invisible in a
  green log.** The runner injects a shared anti-loop discipline block into every
  arm by default — investigation-policy text in an experiment manipulating
  investigation policy, which would have made arm A a baseline already told not
  to search. And `--protocol baseline` files artifacts under `raw/baseline`
  while the treatment arms use `raw/vtrace`, so every successful baseline run
  would have read as a failure and burned three retries. Neither would have
  surfaced as an error; the first announced itself only in a log line read for
  another reason.

- **Three classifiers of mine failed the M167 rule in one milestone.** The
  parity check scanned the transcript for prompt text the transcript cannot
  carry — two signals that could never fail and one false failure. The guard
  classifier pooled "armed but never needed" with "ran and let searches
  through". Each was caught by a case that looked wrong, not by a test. The rule
  earns its place again: a control that cannot discriminate the unchanged case
  is not a control, and an unobservable must be recorded as unobservable rather
  than scored as an absence.

- **Next-step recommendation: no coercive-policy work is licensed, and no
  retrieval work is licensed by this milestone either.** The one open question
  M168 leaves is the clean arm's cost premium — VTRACE delivers evidence that
  reliably displaces search but costs more than the search it displaces. That is
  a payload-economics question, and M166 already showed the response is
  envelope-bound, so it needs a different lever than compression. `sphinx-7462`
  failed on all three arms exactly as the standing finding predicts, which is a
  useful check that the grader discriminates.

## M169 — pipeline economic break-even and evidence-dose audit (commit pending)

**PASS. Offline audit; $0.00 live; `src/` byte-identical to M167 at tree
`f970e24c` throughout. 11 uncensored economic pairs from M168's 12.**

M168 left one open fact — VTRACE displaces search and costs more anyway — and
two candidate explanations: the payload is too big, or it is invoked on the
wrong tasks. Both turn out to be true and neither turns out to matter, because
the prior question answers them together.

```text
pipeline attributable cost      $0.0985 / task
investigation displaced         $0.0026 / task   (pre-edit, paired)
whole-run investigation         -$0.0070          treatment did MORE
aggregate economic ratio        38x

economic classes   10 LOSS   1 ROUGH_BREAK_EVEN   0 WIN   1 NOT_MEASURABLE
```

```text
economic diagnosis     PIPELINE_ECONOMICS_MULTI_FACTOR
evidence dose          LOWER_EVIDENCE_DOSE_PLAUSIBLE
selective invocation   SELECTIVE_INVOCATION_NOT_SUPPORTED
next lever             NO_FURTHER_PROACTIVE_PIPELINE_WORK
```

## M169 standing findings

- **A skipped search is not a saved search.** M168 showed a *blocked* search
  displaces investigation into Bash and Read. M169 shows the mandate does the
  same thing without any coercion at all: search counts fell, and on six of
  eleven tasks the treatment arm's pre-edit investigation traffic was HIGHER
  than the baseline's — xarray by $0.106, requests by $0.039. Over whole runs
  the treatment arm investigated $0.0070 MORE than the baseline. The
  displacement M168 measured in tool counts does not exist in dollars, and every
  denominator built on it has to be discarded rather than merely discounted.

- **The canonical result row's token counts are arithmetic artifacts, and one of
  them decided a kill.** Claude Code streams one `assistant` event per content
  block, each repeating the whole request's usage; the external harness sums them
  without deduplicating on `message.id`. Cache reads inflate ~2.65x, cache
  creation ~2.9x, and `outputTokens` counts streaming placeholders (43 for a run
  that emitted 17,724). `costUsd` survives for completed runs because it comes
  from `total_cost_usd` — but the ONE run with no `result` event, the censored
  `pylint-4551` baseline, falls back to the harness's own arithmetic at the wrong
  cache-write rate. Its recorded $3.0384 is not a provider endpoint and is not on
  the same basis as the other eleven. Deduplicating on message id reproduces the
  provider exactly, and the billing identity (input $5 / 1h-write $10 / read
  $0.50 / output $25 per Mtok) then reproduces `total_cost_usd` to 1e-16 on
  35/35 uncensored runs — which is what licenses pricing a counterfactual at all.

- **Under a fifth of what the model is billed for is repository evidence.**
  Through M166's frozen rule table, averaged over 12 clean runs: 40.4% transport
  structure, 18.9% repository evidence, 17.4% duplicate, 10.2% agent-useful
  control, 7.9% machine diagnostic, 5.2% provenance. The product's own envelope
  accounting says the same thing out loud — `estimated_model_visible_tokens: 871`
  against `estimated_metadata_tokens: 5372`, `within_envelope: true` — because
  the ceiling is derived from a *context* budget of 8,000 and then spent on
  things that are not context. The shape generalises: evidence is 18.6% of the
  default payload across Broad100-B's 97 cases.

- **The first call is not the tax; the run length is.** Amplification — the
  payload re-read as cache by every later request — is 9% of the payload's cost
  on the shortest run and 56% on the longest. A payload's price is set as much by
  how long the run turns out to be as by its own size, which means a fixed
  payload is a variable cost and cannot be reasoned about per-call.

- **No shipped argument varies the evidence dose while holding retrieval fixed,
  and the one that comes closest is not monotone.** The plan named
  `capsule_budget_tokens`; an identity control rejected it on contact, because at
  8,000 it also raises the v1 capsule's character budget from its own default of
  2,000 to 32,000 — the product ships two different default budgets for one
  response and no argument sets both to their defaults. Re-cut on `max_tokens`,
  the ladder moves the delivered item set too, and not in order: django-13658
  delivers zero pivots at 4,000 and one at 2,640. Every reduced rung also sheds
  `claimBoundary` under compaction, which §28 forbids scoring as an improvement.
  Controls held throughout: the default rung reproduces itself 12/12 on M168 and
  97/97 on Broad100-B, and repeats clean after every rung.

- **Nothing available before invocation predicts where the pipeline pays for
  itself.** Fourteen of fifteen candidate features across the four pre-frozen
  families are NULL against the displaced/not-displaced split. The single
  non-null signal is PRE_DELIVERY — it needs retrieval to have run, which is most
  of the work a router would exist to avoid. The cross-corpus distribution
  confirms the twelve are not a peculiar sample.

- **The dose lever is real and is not an economics fix.** 70% of the payload is
  removable without touching evidence or truthfulness, worth $0.069 of a $0.217
  per-task premium. But on 9 of 11 tasks the MINIMUM useful payload — evidence
  plus every truthfulness field — still costs more than the entire investigation
  it replaced. Shrinking the response is worth doing on its own terms; selling it
  as a route to break-even would be false.

- **A control that certified two identical errors as an identical delivery.**
  M169's repeat control compares the default response before and after the whole
  ladder, to prove the rungs leave no residue. As first written it compared
  fields and found them equal — including when both responses were the same
  `repo_not_ready` error, which is how it reported a clean 100/100 on a corpus
  where 93 of 100 cases delivered nothing. Non-delivery is now `NOT_COMPARABLE`.
  Fourth instance of the same defect shape since M167, and the third caught by a
  number that looked too good rather than by a test.

- **Next-step recommendation: stop making the pipeline mandatory, and do not
  spend live budget looking for a smaller mandatory pipeline.** The
  first-action-on-every-task pipeline is economically inappropriate for this task
  population, where the baseline localises for a median of $0.048. Two pieces of
  work are licensed and neither is an economics bet: the response diet (40%
  transport, 17% restatement) as a product-correctness fix, and reconciling the
  two default budgets. What would change the conclusion is a population where
  baseline localisation is expensive, or an on-demand arm — and no arm from M162
  to M169 has ever measured VTRACE being called when the agent wanted it.

- **Incidental, outside the argument:** the Broad100-A workspaces under
  `results/workspaces/cross_repo/` are `index_corrupt / index_unreadable` to the
  current build — 93 of 100 answer `repo_not_ready`. Evidence that depends on
  re-running against them is not reproducible without a rebuild. M169
  re-materialised both broad corpora under fresh roots and left the originals
  untouched.

## M170 — transparent agent-workflow integration and automatic reduction qualification (commit pending)

**MIXED. Offline audit; $0.00 live; `src/` byte-identical throughout. No product
change made and none licensed.**

M169 closed the proactive architecture. M170 asked the opposite question —
whether VTRACE can sit UNDERNEATH an operation the agent already chose — and
found a seam that costs nothing and an opportunity that is worth nothing.

```text
A PASS   investigation surface priced      B PASS   one zero-cost seam, no new capability
C PASS   counterfactual replayed           D NOT RUN  C did not license it
E PASS   200 fresh-index cases, both corpora, 0 derivation-invalid

automatic integration verdict   TRANSPARENT_MEDIATION_NOT_ECONOMIC
product changed                 NO          selected mediation   NONE
live extension                  NOT AUTHORIZED, NOT REQUESTED
```

```text
investigation share of run cost      12.5%   ($0.611 of $4.876, 11 uncensored)
whole-file reads, share of that      51.8%   10 operations
whole-file reads, share of run        5.9%
oracle whole-run ceiling              4.81%  (future-reading selector)
best implementable whole-run          1.31%
gate G2 preservation >= 95%           FAIL   66.7% observed / 30.6% A / 33.3% B
gate G1, G3, G5                       PASS   46.8% reduction, 0 unsafe, 0 fixed tokens
```

## M170 standing findings

- **`PreToolUse.updatedInput` is the seam, and it is the first architecture here
  with no fixed tax.** It rewrites the parameters of an operation the agent already
  chose; the native tool runs; the model makes no extra decision and reads no extra
  schema. The harness validates the rewrite against the tool's own schema and falls
  back to the agent's input when it is absent, so fail-open is inherited rather than
  built. Enabled and never firing it costs 0 model tokens, against the mandatory
  pipeline's $0.0985 per task. Verified against the shipped binary's own strings.

- **The reachable opportunity is 5.9% of a run and the oracle ceiling is 4.81%.**
  Investigation is 12.5% of whole-run cost; whole-file reads are half of that; ten
  operations carry half of all investigation and the largest single one carries
  12.2%. Operation-local reductions of 47–94% are large fractions of something
  small. §28 earned its place in the plan.

- **Read's one-contiguous-window schema is the binding constraint, not ranking.**
  About half of gold-edited files are edited in two or more places (35/72 A,
  49/103 B) with p90 spreads of 532 and 989 lines. Reduction and gold containment
  trade monotonically across four policies and both corpora with no acceptable
  rung: 94% reduction buys 31% containment, 73% containment costs a 22% fire rate.
  Better retrieval moves a case between rungs; it does not create one.

- **Bounding a Read deletes the harness's own honesty; bounding a Grep does not.**
  `[Truncated: PARTIAL view — …]` is emitted only when `(offset ?? 1) <= 1 &&
  limit === undefined`. Supplying a limit suppresses the banner and
  `truncatedByTokenCap` together. Grep's result mapper, by contrast, appends
  `[Showing results with pagination = limit: N]` whenever a bound applies. The
  safe family and the valuable family are therefore not the same family.

- **The agent already narrows its own searches.** 83% of baseline Greps were
  scoped by `path` or `glob` and 11% carried an explicit `head_limit` — the
  narrowing a search mediation would apply is one the agent applies to itself.
  M169's "a skipped search is not a saved search", arriving from the other side.

- **`searchSymbols` is a name lookup and returns zero results for issue prose.**
  A mediation built on it would have declined on every real task while reporting
  itself as correctly fail-open. Every producer row in
  `stage5_m170_seams_and_producers.json` is verified by importing the module.

- **The captured tool-call artifact truncates outputs at 8,192 characters.**
  django-13658's largest Read is 18,551 characters, not the 8,192 stored. Any
  investigation cost read from `_tool_calls_with_outputs.json` understates the
  largest operations by up to 3x. M170 reads the raw stream.

- **Next-step recommendation: keep the seam, drop the mediation, and change the
  population before changing the design.** Read narrowing has a 4.81% ceiling and
  no safe rung; no further work on it is licensed. What would change the
  conclusion is a population where localization is genuinely expensive — this one
  localizes for a median of $0.052 and half the tasks never issue a whole-file
  read — or a tool contract admitting more than one window, which is a change to
  the harness and not to VTRACE.

## M171 — agent-facing orientation contract redesign (18473b0b)

**MIXED. Offline design and qualification; $0.00 live; `src/` byte-identical
throughout. No product change made and none licensed.**

M169 closed the mandatory pipeline on price and M170 closed transparent mediation
on opportunity. M171 asked whether the price was a property of the product
category or of the disclosure, built the projector that answers it, and found the
answer is the disclosure — then did not ship, because one delivery gate frozen
before the holdout missed by three cases.

```text
A PASS   contract decomposed, cost re-derived   B PASS   40 rules, 0 unclassified
C PASS   5 proofs incl. no-refill               D PASS   96 packets, 0 violations
E MIXED  5 of 6 holdout gates                   F NOT RUN  E did not license it

orientation verdict   COMPACT_ORIENTATION_PLAUSIBLE
economics verdict     PROACTIVE_PIPELINE_ECONOMICS_MATERIALLY_CHANGED (candidate only)
product verdict       DEFAULT_ORIENTATION_REDESIGN_NOT_LICENSED
product changed       NO        retrieval changed   NO
live requalification  NOT LICENSED, NOT REQUESTED
```

```text
current default median model-visible tokens   6,766   ($0.1035 projected)
selected orientation median / p90               582 / 850   ($0.0079)
reduction                                      11.4-11.8x across both corpora
evidence density                              24.4% -> 68.3%, same instrument
pivot identity                          99/99 A, 98/98 B, 12/12 development
action-support preservation                     7/7 at every rung, incl. R1000
gold file delivery                            0.00pp on all three slices
gold symbol delivery                  -3.00pp A full, -3.41pp A remainder, 0.00pp B
unsupported claims / false absence              0 / 0 over 96 audited packets
```

## M171 standing findings

- **The response is 21,318 characters and carries 895 characters of code.**
  Repository source is about 4% of what the model pays for; `pivotNeighborhood`
  excerpt bodies are stripped before emission, so the only source reaching the
  model lives inside `productContext.modelVisibleContext`. The projector cuts its
  excerpt from that same string, which is what keeps M171 a projection: it cannot
  show source the current default does not already show.

- **Repeated identity, not repeated boundaries, is the redundancy.** 89 distinct
  facts across 146 surfaces; the task string on 7 surfaces, the intent on 8, a
  symbol identity on a median of 4 and a maximum of 9 — while every epistemic and
  provenance field is asserted exactly once. §8's hypothesis that repeated
  claim-boundary prose was the cost was measurably wrong.

- **The orientation is right or wrong per case, never partly right.** Across the
  twelve M168 live runs, early-phase support is 0% or 100% with nothing between:
  seven runs had first action, first edit and every early action supported, five
  had none. Median 3 files surfaced, median 75% never opened. A bigger packet
  does not rescue a wrong pivot, and a right pivot does not need a bigger packet.

- **"Enough, then stop" has to be structural or it does not hold.** The projector
  has no notion of remaining space, so a raised ceiling attracts nothing: proven
  by byte-identity when the ceiling rises over a complete packet, and by
  invariance when unrelated internal bytes are freed — the direct answer to
  M166's refill. At a 2,000-token ceiling the median packet is 582 tokens and the
  maximum across 188 holdout cases is 1,007. The ceiling never binds.

- **The packet is bounded twice and the wrong bound binds.** The token ceiling is
  inert; the related cap of five decides every packet. All three gold-symbol
  losses are symbols at authoritative position six or seven in a packet that
  names six locations, in files the packet still delivers. R2500 would recover
  all three and was not adopted, because choosing a parameter after seeing which
  value fixes the holdout is what §70 forbids.

- **The development set understated the regression to zero.** Gold-symbol delta
  is 0.00pp on the twelve development cases and −3.41pp on the 88-case
  non-development remainder. Reporting only "Broad100-A" or only the development
  numbers would have shown a clean pass. The A-remainder split is the reason it
  did not.

- **A frozen phrase table that fails closed is what makes selective disclosure
  truthful.** Every string in a packet is verbatim-authoritative or one of a
  declared set; the relationship enum renders through an exhaustive table, and an
  unmapped token drops the neighbour rather than shipping an opaque or
  over-strong label. `fallback_symbol_window` renders as "in the same file as the
  focus symbol; no indexed relationship to it" — stating an absence rather than
  implying a relation. 96 packets, 0 unsupported claims, 0 false absence.

- **A scanner cannot judge the sentence whose job is to deny the claim.** The
  enumerating-wording detector fired on the boundary line's own "not an
  exhaustive repository listing". The boundary is excluded from the scanner and
  asserted directly instead. Fifth instance since M167 of a classifier that had to
  be told what it was looking at before its verdict counted.

- **Next-step recommendation: settle what "enough" means before touching the cap
  again.** The evidence says a compact orientation preserves everything that
  mattered on this population at one twelfth the price, and that the only thing
  standing between it and a shipped default is a bound chosen for a ceiling that
  never binds. A successor should decide the cap on development evidence, report
  against Broad100-A knowing the three cases and their positions are now known,
  and hold Broad100-B back as the clean check. No live spend is licensed: there
  is no shipped treatment to requalify.

## M172 — the bound that was never wired (b173df2d)

**PASS. Offline design and qualification; $0.00 live. The default disclosure of
`run_pipeline` is now a bounded orientation; the authoritative result is
unchanged and reachable at `detail=debug`. No retrieval change.**

M171 cut the response elevenfold and declined to ship on a three-case gold-symbol
miss, recommending its successor settle the bound on development evidence. M172
took M171's rungs apart, found the bound it had been tuning was not wired at all,
froze the replacement on that defect rather than on any outcome, and shipped.

```text
A PASS   bundle decomposed, defect found      B PASS   frozen pre-holdout on architecture
C PASS   5 controls, measured not asserted    D PASS   every gate, both corpora
E PASS   integrated, 0 mismatches vs qualified

orientation verdict   MINIMUM_SUFFICIENT_ORIENTATION_CONFIRMED (offline gates, not solve rate)
economics verdict     PROACTIVE_PIPELINE_ECONOMICS_MATERIALLY_CHANGED
product verdict       DEFAULT_ORIENTATION_REDESIGN_SHIPPED
product changed       YES (disclosure only)   retrieval changed   NO
live requalification  LICENSED, NOT REQUESTED, NOT RUN
```

```text
current default median model-visible tokens   6,766 dev / 6,884 B
orientation median / p90                        603 / 850 A, 621 / 865 B
projected attributable cost                   $0.0081 A, $0.0084 B (gate $0.0262)
reduction                                     11.0-12.5x across all slices
pivot identity                                99/99 A, 98/98 B, 12/12 dev
gold file delta vs current                    0.00pp on every slice
gold symbol delta vs current                  0.00pp on every slice (M171: -3.00 / -3.41)
related entries M171 withheld, M172 delivers  66 on B, 47 on A, at no measured cost
unsupported claims / false absence            0 / 0 over 234 audited packets
shipped vs qualified projector                210 captures, 0 mismatches
bun test                                      5425 pass, 0 fail (baseline 5405)
```

## M172 standing findings

- **The bound everyone was tuning was never wired.** `Rung.ceilingTokens` is
  declared on the interface, set on all four M171 rungs, and read by nothing;
  `projectOrientation` consults only `focusCodeCharacters` and `relatedCap`.
  M171's "the ceiling is inert" understated it — the ceiling was absent, and the
  packet was bounded once, by an undeclared parameter, while the declared one was
  documentation. Measured post hoc it would not have bound anyway: R1000, the
  smallest rung, leaves at least 459 tokens of headroom on every development case.

- **A cap that saves nothing still costs something.** Delivering the full
  authoritative related supply has the same median, p90 and max token cost as
  capping at five, because the withheld entries are cheap and the median case
  supplies exactly five. The cap withheld 5 development entries, 47 on
  Broad100-A and 66 on Broad100-B while standing proxy for a constraint with over
  a thousand tokens spare. Removing it changed no delivery rate anywhere — which
  is what makes the removal safe rather than clever.

- **Development could not discriminate the candidates, and saying so is the
  finding.** `P_M171_R2000`, `P_SUPPLY` and `P_RELATION` score identically on gold
  file, gold symbol, files delivered and pivot identity over all twelve
  development cases. A policy chosen on those numbers is chosen on noise — the
  same blindness that let M171's development slice read 0.00pp where its 88-case
  remainder read −3.41pp. The freeze was therefore made on a defect visible
  without any delivery metric.

- **The obvious alternative was wrong, and cheap to disprove.** Proximity-only
  entries — *"in the same file as the focus symbol; no indexed relationship to
  it"* — appear 6 times across 3 development cases, always within the first five
  slots, which looks exactly like filler displacing real relationships. It never
  does: 0 cases where a proximity entry precedes a real one. They pad the tail to
  the cap. `P_RELATION` was rejected on that evidence rather than deferred.

- **A promoted bound has to be shown doing something.** Four of the five controls
  would have passed vacuously against M171's projector, because a bound that is
  never applied cannot be caught misbehaving. Written against a synthetic supply
  large enough to reach it, the ceiling binds at supply 46 and delivers 45. The
  real corpora max out at 9, so the packet is supply-bound and the ceiling is
  genuine but idle — which is the honest description, and different from "the
  ceiling works".

- **A contaminated holdout recovering exactly what it lost is not evidence.**
  Broad100-A goes from −3.00pp to 0.00pp, recovering precisely M171's three
  cases. A was contaminated twice — it holds all twelve development cases, and
  M171 published which three failed and at what positions. The evidence is
  Broad100-B, where the same policy delivers 66 previously-withheld entries and
  moves no delivery rate at all.

- **The qualification-to-product gap is where a result usually leaks away.** The
  numbers were measured on a benchmark module; a different file ships. Closed
  twice: 210 captures with 0 mismatches between shipped and qualified projector,
  and 209/209 shipped packets are supersets of M171's with an identical focus,
  which is how M171's 7/7 first-action support transfers by construction instead
  of by assertion.

- **Compacting a default breaks every consumer that was reading the default to
  get the authoritative result.** ~80 assertions across nine test files now pass
  `detail: "debug"`. That is not incidental — it is the measurement of how much
  code treated the disclosure channel as the state channel, and their passing is
  the debug-preservation proof. `get_code_context` was one of them in product
  code: it post-processed the delegated `productContext` and threw when there
  wasn't one.

- **Next-step recommendation: stop tuning the packet and look at the pivot.**
  Packet size is settled — the ceiling is idle, the cap is gone, and cost is a
  twelfth of what M169 condemned. What M171 measured and M172 did not change is
  that orientation is right or wrong per case and never partly right: early-phase
  support was 0% or 100% across the twelve live transcripts, with nothing
  between. A bigger packet does not rescue a wrong pivot. That makes pivot
  correctness the remaining variable, and it is a retrieval question. A live
  requalification is licensed on economics but costs real money and is not
  requested; the cheaper next milestone is offline and aimed at the pivot.

## M173 — cost was not the thing (edd52104)

**MIXED. 24/24 live runs, 12/12 balanced pairs, $17.83 of a $45 cap. `src/`
byte-identical to `9242d879` throughout; no product change. The orientation is
now almost free, almost always right, and directly used — and it changes
nothing.**

M169 condemned the proactive pipeline at $0.0985 a task to displace $0.0026 and
closed on `NO_FURTHER_PROACTIVE_PIPELINE_WORK`. M172 made the same intelligence
fit in a twelfth of the tokens. M173 reran the causal comparison against the
shipped compact default and answered the question those two set up.

```text
A PASS   protocol frozen, accounting discriminates, 12/12 positive control
B PASS   24/24 runs, 12/12 balanced pairs, 119 gates pass / 0 fail / 1 unobservable
C PASS   authoritative grades, M169 diagnostic recomputed
D PASS   use and pivot causality from rules frozen before any run existed
E PASS   verdicts reached

architecture  COMPACT_AUTOMATIC_ORIENTATION_UTILITY_NEUTRAL
economics     ECONOMICALLY_NEUTRAL        utility  UTILITY_NEUTRAL
M169 null     M169_ECONOMIC_NULL_WEAKENED  product  KEEP_COMPACT_ORIENTATION_DEFAULT
pivot work    PIVOT_CORRECTNESS_NOT_LICENSED
extension     ECONOMIC_DIAGNOSIS_REQUIRED
```

```text
                                 M169 (rich)      M173 (compact)
orientation attributable cost    $0.0985 / task   $0.0106 / task    9.3x cheaper
investigation displaced          $0.0026 / task   $0.0109 / task    4.2x more
whole-run investigation net      -$0.0070         +$0.1220          sign reversed
aggregate economic ratio         38x              1.0x
economic classes                 0 win / 10 loss  4 win / 7 loss

baseline resolved 7/12   compact VTRACE resolved 7/12   the SAME seven, task for task
unique wins       0 / 0                  median paired cost delta  +$0.0563
orientation       median 629 tokens (M172 projected 621), $0.0111 median
delivery          COMPACT_ORIENTATION 12/12, fallback 0, detail=debug 0, debug seen 0
pivot             gold on 11/12, DIRECTLY_USED 10/12, 0 causal consequences
```

## M173 standing findings

- **Cost was not the thing preventing automatic orientation from being useful.**
  Every economic quantity M169 condemned moved — the first call is 9.3x cheaper,
  it displaces 4.2x more, the ratio fell from 38 to 1.0, and whole-run
  investigation displacement changed sign — and the solve set did not move at
  all. Not 7 and 7 by coincidence of totals: the same seven tasks, twelve paired
  runs, twelve identical verdicts. The orientation now costs almost exactly what
  it displaces, which is the break-even M169 said no payload size could reach,
  and reaching it bought nothing.

- **The null is not a delivery failure, and this is the first milestone that can
  prove it.** The model received `COMPACT_ORIENTATION` on 12/12 with zero
  fallbacks, the focus file was a gold-patch file on 11/12, and the agent edited
  that focus on 10/12. Zero `detail=debug` requests, zero authoritative payloads,
  zero voluntary follow-up calls, `run_pipeline` first on 11/12. The agent was
  handed the right file at the right symbol for a tenth of the old price and was
  already going to reach it.

- **The premium moved from the packet to the implementation phase.** The
  treatment still costs a $0.0563 median more, and splitting each run at its own
  edits shows why: pre-edit is $0.046 CHEAPER in aggregate, debug/test $0.034
  cheaper, and implementation $1.4622 more expensive — the whole premium and
  more. Its median is $0.0008, so it is a two-case tail rather than a shift, and
  the mean of $0.2001 against that median is why §42 exists.

- **The tail's shape suggests displacement rather than saving, and refuses to
  confirm it.** `Spearman(Δ pre-edit requests, Δ whole-run cost) = -0.682`: the
  further ahead the treatment's first edit, the more the run costs. Both
  earlier-edit cases ran 19 and 13 requests longer and cost ~$0.72 more. But they
  disagree — astropy's pivot was correct and used, xarray's was the one wrong
  pivot and was ignored — so either the packet shortens the approach even when
  rejected, or one case is variance wearing the same shape. n=2 cannot separate
  them, and neither can 11 pairs.

- **Wrong pivots are not the story, and the standing instruction was right to
  demand the check.** One pivot of twelve was wrong (xarray-6599); the agent
  ignored it and solved the task anyway. Zero caused a wrong edit, zero caused
  extra investigation. All five shared failures received a CORRECT gold pivot and
  four of the five edited it — retrieval did its job on every failure and the
  task was lost regardless. `PIVOT_CORRECTNESS_WORK_LICENSED: NO`.

- **Almost none of the agent's verification is waste, so there is almost none to
  recover.** Under rules frozen before the runs existed: 39 TARGETED_CONFIRMATION,
  53 NEW_INFORMATION_SEARCH, and 4 REDUNDANT_REDISCOVERY out of 96
  post-orientation investigation actions. §33's warning held — the packet carries
  a skeleton, not a file, so opening what it pointed at is consumption. Searching
  fell on 8/11 pairs and rose on none, without any coercion.

- **The compact default has an escape hatch, found before the money was spent.**
  `projectRunPipelineOrientation` declines on an empty delivery and
  `orientation ?? authoritativeResult` then hands the model the full 26,075-char
  payload M169 priced. matplotlib-22719 did exactly that under a raw
  problem-statement query on a healthy index; under an agent-shaped query all
  twelve are compact. It never opened in 24 live runs, but it is a real property
  of the shipped product and every run is classified for it.

- **A spend guard's granularity is part of its design, and its estimator is not.**
  Gating at task entry rather than per spawn meant no pair was ever left half-run.
  But the frozen running average, seeded by astropy — complexity 99, the
  second-priciest pair in M168 — projected $44.48 and stopped the sweep at 1/12
  under a $35 cap. The next task cost $0.45 and the projection fell to $24.95. The
  cap was raised once by the owner; the estimator was deliberately NOT reseeded,
  because a guard tuned mid-sweep by the thing it is guarding is not a guard. Final
  spend was $17.83.

- **An infrastructure failure that bills $0.00 still has to be classified.** Four
  baseline arms died with `ENOSPC` on `mkdtemp '/tmp/vexp-swebench-*'`: the
  external harness copies whole repositories into a 32G tmpfs and twenty runs
  exhausted its INODES while free bytes still read healthy. No agent spawned, no
  money billed, `ABORT_RE` did not match, so the driver called it a result. All
  four were the BASELINE arm — leaving them would have compared eight full pairs
  against four treatment-only runs, the censored sample §13 forbids. Rerun under
  §61, recorded in `stage5_m173_rerun_log.json`, grading pointed at disk after.

- **Next-step recommendation: the question is no longer what VTRACE delivers.**
  It delivers the gold file, compactly, and the agent uses it, and the outcome
  does not move. No orientation product fixes that, because on astropy the packet
  was correct and used and the run still ran nineteen requests longer. Do not
  extend to 100 tasks: that buys precision about a null. Do not touch retrieval:
  M173 checked and wrong pivots are not causal. What is worth doing is offline and
  already paid for — twenty-four transcripts that can be read for whether an agent
  told where to look still needs to look, and whether early editing causes the
  implementation-phase tail.

---

# M174 — Post-Orientation Work Displacement and Implementation-Cost Attribution

```text
4d4d8cb4  Stop spending 8,229 tokens to say that nothing fit
3d493b21  The work never moved, and two virtualenvs cost more than the packet ever did
```

M173 closed on `ECONOMIC_DIAGNOSIS_REQUIRED`: the packet is cheap and consumed,
the solve set does not move, and a $0.0563 median premium sits somewhere after
the first edit. M174 read the twenty-four transcripts it had already paid for
and found out where.

```text
A PASS   empty-delivery fallback repaired, 3/3 identity controls, 18 new tests
B PASS   12/12 pairs reconstructed from full streams, 0 problems
C PASS   4/4 classifier controls, WORK_DISPLACEMENT 0/12
D PASS   tail selected mechanically, both cases reconstructed request by request
E PASS   premium reconciled to $0.0003 residual on $2.2011
F PASS   verdicts reached

mechanism   STOCHASTIC_TAIL_DOMINANT
economics   COMPACT_ORIENTATION_ECONOMICALLY_NEUTRAL
product     KEEP_COMPACT_ORIENTATION_UNCHANGED
live        LIVE_WORK_NOT_LICENSED        spend $0.00
```

```text
                                       baseline   compact    delta
pre-edit incl. the orientation call      $2.4791   $2.4481   -$0.0309
implementation                           $1.3091   $2.0544   +$0.7455
verification / test / debug              $1.7995   $3.2862   +$1.4868
total (11 uncensored pairs)              $5.5876   $7.7888   +$2.2011

post-edit premium from the two tail runs           +$2.1365    95.7%
post-edit premium, the other nine pairs            +$0.0958    $0.0106/pair
displacement                        0/12 pairs classified, 8/12 exactly zero
first meaningful edit B-A           median +1, later on 8 of 11
first-edit survival                 A 4 final / B 4 final     rework A 6 / B 3
```

## M174 standing findings

- **The work did not move, and it did not vanish either.** Displacement measured
  across each arm's OWN first meaningful edit is zero on eight of twelve pairs
  and no pair classifies as `WORK_DISPLACEMENT`. The skipped pre-edit reading
  never comes back. But pre-edit cost including the orientation call is flat at
  −$0.0309 over eleven pairs, so almost nothing was saved either. The packet
  substitutes for the investigation it replaces at approximately its own price.

- **M173's $1.06 pre-edit saving was a phase-labelling artifact, and M174 has to
  own the correction.** The treatment's orientation call is its own first
  request, and in the baseline that request is pre-edit investigation. Charged
  where it belongs, the saving is $0.03, not $1.06. The whole +$2.20 premium is
  after the first edit. The reconciliation closes to $0.0003, so there is no
  unattributed remainder for a mechanism to hide in.

- **95.7% of the post-edit premium is two runs, and they do not share a cause.**
  `xarray-6599` wrote the same repair as its baseline (82% line overlap) and then
  spent fourteen requests on `pip: command not found`, nine virtualenv rebuilds
  and clearing `/tmp` — the same tmpfs that killed four M173 baseline arms with
  `ENOSPC`. `astropy-14369` chose a *different* repair (38% overlap: a grammar
  restructure against a rule extension) and spent its premium proving it; its
  implementation phase was $0.16 CHEAPER. One infrastructure, one strategy,
  neither orientation. The other nine pairs carry $0.0106 each.

- **The premature-edit hypothesis fails on three independent measures.** The
  treatment edits LATER (median +1 request, later on 8 of 11), its first edit
  survives at the same rate as the baseline's (4 final / 4 final), and it reworks
  LESS (3 against 6). Whatever the premium buys, it is not bought by editing too
  soon.

- **No omitted-context class survives.** All three §43 candidates fail, and
  `requests-1724` fails instructively: the packet's focus `requests/sessions.py`
  IS the gold file, the baseline edited `models.py` and lost, and the "omitted"
  file would have endorsed the wrong direction. The packet named a patched file
  on 10/12 and was edited on 10/12. `COMPACT_ORIENTATION_OMISSION_CAUSAL` is not
  established anywhere in this corpus.

- **The fallback was not an empty delivery, and what it actually was is worse.**
  Traced live: retrieval SUCCEEDED — ten items, correct lead pivot — and the
  response envelope evicted all ten, because `request.query` and `request.task`
  echo the agent's 10,611-character question twice for 81.6% of the response.
  Metadata 6,435 + evidence 3,731 = 10,166 against a 9,200 ceiling, so the
  envelope kept the echo and dropped the evidence, then advised "increase
  max_tokens". The old path shipped 26,227 characters / 8,229 tokens to deliver
  one 186-character sentence. The decline projector cuts that to 143 tokens
  (57.5x) with compact output byte-identical and `detail=debug` untouched.

- **A detector that tracks the packet is not measuring the agent.** §67's
  uniform-label check caught `TREATMENT_ONLY` correlating with packet size rather
  than behaviour: the split shows genuine extra agent-acquired information is
  ZERO on seven of twelve pairs, with 44 of the remainder in a single pair. The
  first reading would have reported every treatment run doing 11–23 units of
  work it never performed.

- **The eviction is the cause and was deliberately left alone.** An envelope that
  spends 6,435 tokens echoing the question and then reports the evidence would
  not fit is a real defect, but repairing it changes what evidence agents receive
  and is beyond M174's single licensed product change. Recorded, not acted on.

- **Next-step recommendation: this is a harness problem before it is a product
  problem.** Do not redesign the packet — it is correct, consumed, break-even and
  causally inert. Do not touch retrieval — M173 showed wrong pivots are not
  causal and M174 shows correct ones are not either. Twelve pairs cannot resolve
  a $0.0106-per-pair effect when two runs decided by a virtualenv and a grammar
  preference carry 95.7% of the totals. If the economic question is worth
  closing, it needs replication at a sample size where a tail cannot dominate,
  on infrastructure where an agent does not spend fourteen requests looking for
  `pip`. Fix the environment friction first. No live spend until then.

---

# M175 — Orientation Envelope Input-Echo Elimination and Evidence-Budget Correctness

```text
bc6e2ecd  Stop paying for the question twice, and let the answer fit
366883d2  Find out who was reading the field nobody was reading
```

M174 repaired the empty-delivery fallback and recorded, without acting on it, that
the fallback was never the problem: retrieval had succeeded with ten items and a
correct lead pivot, and the agent got none of them because the envelope had spent
itself echoing the question. M175 removed the echo.

```text
A PASS   authority audit; 199/199 captures identical; ZERO product consumers
B PASS   defect confirmed from the envelope's own accounting; 7/7 controls + identity + refill
C PASS   five candidates priced, IDENTITY_ONLY frozen before any holdout was seen
D PASS   one function in the existing envelope; 6 tests, 4 fail without it
E PASS   198 valid cases across two corpora, two checkouts, one index
F PASS   verdicts reached

defect          REQUEST_ECHO_EVICTION_CONFIRMED
repair          MINIMAL_REQUEST_DISCLOSURE_REPAIR_VALIDATED
evidence budget EVIDENCE_BUDGET_REALLOCATED_TO_REPOSITORY_EVIDENCE
product         KEEP_COMPACT_ORIENTATION_WITH_REQUEST_ECHO_FIX
live            LIVE_WORK_NOT_LICENSED        spend $0.00
retrieval       UNCHANGED
```

```text
                              A before  A after   B before  B after
valid cases                        100      100         98       98
request block, median tokens     617.5       65      848.5       65
request block, max tokens        5,133       65     12,430       65
packets delivered                   99      100         94       96
related items delivered            464      514        396      476
gold file delivered                 66       67         53       55
gold symbol delivered               43       45         33       36
delivery failures                    1        0          4        2
focus changed                        —        0          —        0
cases losing evidence                —        0          —        0

known positive  matplotlib-22719   decline → orientation, same correct pivot,
                                   gold file and symbol both recovered
```

## M175 standing findings

- **The exemption protected nothing and cost the product its evidence.** `request`
  was the only large field with no reduction at any rung, exempt because it "echoes
  the caller's own input verbatim and is a correctness surface". Its readers, in
  full: two assertions in `mcp.test.ts`, both at `detail=debug`, and a benchmark
  analyzer that counts it as duplication. `request.task` is assigned
  `orchestration.request.query` at `formatRunPipelineOutput.ts:211` and was
  identical to it in 199 of 199 captures. Before calling a field a correctness
  surface, find the code that reads it — that audit is the transferable part.

- **The fix is that the cost is CONSTANT, not that it is smaller.** 65 tokens
  whatever is asked, against a median of 618/849 and a max of 12,430. Past that max
  the response could not be assembled at all: Broad100-B's two longest questions
  threw `product_response_envelope_unreachable` and returned `handler_failed` with
  no response. Anything unbounded in the caller's input eventually exceeds any fixed
  ceiling, which is why a budget-triggered rung was rejected.

- **The obvious instrument does not work, and the reason should not be rediscovered.**
  Replaying compaction over one snapshot would isolate policies perfectly, but
  compaction runs before any response is observable, so a capture at the product's
  budget is already the wreck — `productContext.items` arrives empty. Capturing above
  the ceiling keeps the evidence, but `max_tokens` feeds `budgetTokens`
  (`tools.ts:9189`) as well as `requestedContextTokens` (`tools.ts:9255`), so a wider
  capture SELECTS DIFFERENTLY: 24 items at 120,000 against 10 at 8,000. Replaced by
  two checkouts answering against one corpus and one index.

- **`detail=debug` is not the default path and must not be used to measure it.** It
  retains machine-facing diagnostics the default drops, so it degrades on cases the
  default delivers — the seaborn control fails delivery at debug and succeeds by
  default. Envelope internals were read at debug; prevalence and delivery only on the
  default path.

- **Evidence yields to the budget; the echo did not.** The most useful control found
  nothing: 144,000 characters of evidence beside a 90-character request delivers
  fine, because the progressive packer shrinks evidence to fit. A large evidence
  supply never evicts itself, which is what made the narrow claim provable instead of
  a plausible story about big responses.

- **M172 had already removed the request from the packet; what remained was that it
  decided whether the packet got evidence.** Request-restatement share of the
  orientation packet was zero before M175 and is zero after. The contested resource
  was the 9,200-token ceiling the packet is projected from, and that is where every
  prevalence figure here is measured.

- **The prevalence is a tail and the milestone should not be sold as more.** The
  request block exceeded 25% of the ceiling on 4/100 (A) and 9/98 (B). Three
  responses in 198 went from unusable to usable, 48 gained evidence, 147 are
  unchanged. Nothing regressed on any measure: focus unchanged on all 193 delivered
  packets, every after-packet a superset of its before-packet, retrieval unreachable
  from the change across a 153-module import closure, index fingerprints unmoved.

- **Next-step recommendation: no live work, and one lead worth taking.** §83's test is
  whether the fix changes normal packets or only rare ones, and 147 of 198 responses
  are byte-identical — requalifying an agent against that buys precision about a
  null, and M174 already showed the packet is causally inert on outcomes. The lead is
  what this uncovered rather than fixed: `product_response_envelope_unreachable` is a
  reachable crash on ordinary input. M175 removed the largest field that reached it;
  the throw remains, and any sufficiently large irreducible field still finds it. A
  response that cannot be made to fit should degrade to a truthful non-answer, not
  fail the call.

---

# M176 — Response Envelope Totality and Truthful Degradation

```text
2ec33aec  Write down where M175's pre-repair arm came from, then delete it
aaab4b81  Answer the question you cannot answer, instead of dropping the call
```

M175 removed the largest field that could exhaust the response envelope and
recorded, without acting on it, that the throw at the end of the ladder remained:
any sufficiently large irreducible field still found it, and a response that could
not be made to fit failed the call instead of degrading to a truthful non-answer.
M176 removed the throw.

```text
A PASS   traced end to end; 11/11 source steps re-verified; 10 unbounded fields measured
B PASS   crash reproduced on ordinary corpus input through the real transport; 14/14 controls
C PASS   no new public state; precedence frozen; every bounded field bound by omission
D PASS   one function, two returns where there were two throws; 9 tests
E PASS   200 valid cases across two corpora, two checkouts, one index, two budgets
F PASS   verdicts reached

defect          ENVELOPE_TOTALITY_DEFECT_CONFIRMED
degradation     TRUTHFUL_BOUNDED_DEGRADATION_VALIDATED
totality        VALID_REQUEST_RESPONSE_TOTALITY_CONFIRMED
product         KEEP_COMPACT_ORIENTATION_WITH_TOTALITY_FIX
live            LIVE_WORK_NOT_LICENSED        spend $0.00
retrieval       UNCHANGED
```

```text
                                        A before  A after   B before  B after
valid requests                               100      100        100      100
default budget
  normal orientations                        100      100         96       96
  empty retrievals                             0        0          2        2
  readiness refusals                           0        0          2        2
  tool errors                                  0        0          0        0
  envelope-induced handler failures            0        0          0        0
pressured budget (max_tokens 150)
  envelope-induced handler failures            9        0         10        0
  recovered                                    —        9          —       10
  fabricated absence                           —        0          —        0
  max model-facing response tokens             —      150          —      152

known positive  pytest-dev__pytest-10081   max_tokens 50/100/150 handler_failed →
                                           evidence_found_but_undelivered, 445 chars,
                                           byte-identical to the same case at a
                                           budget that already fitted
```

## M176 standing findings

- **A fail-closed ladder needs a terminal representation, not just a terminal
  decision.** Refusing to ship `within_envelope:false` was correct. Refusing by
  throwing turned a predictable product condition into an implementation fault at
  the transport boundary, where the server's catch-all cannot tell it from a real
  bug. The transferable rule: when a ladder can run out, decide what the last rung
  RETURNS before deciding that it stops.

- **The envelope is enforced on a payload the model does not receive.**
  `tools.ts:9252` bounds the authoritative result; `tools.ts:9282` then projects
  the compact orientation the agent actually gets. On the known positive the
  model-facing answer is 445 characters and the call died because the authoritative
  payload behind it would not fit under a 1,150-token ceiling. Recorded, not acted
  on: projecting first and bounding the projection would change the default
  packet's construction order that M172/M173 froze.

- **The floor is the instrument, and it dodges M175's trap.** M175 established
  that raising the ceiling to observe a response changes what it selects. The
  smallest `max_tokens` at which a response still terminates does not: at exactly
  that budget the whole ladder has run and the residue is readable on a specimen
  that was never given a different budget in order to be read. The offline floor
  (193 tokens) predicted the live threshold exactly.

- **Ten default model-facing fields grow that floor without limit**, each taking an
  ordinary response past even the DEFAULT ceiling at ~32,000 characters on its own:
  `request.repoRoot`, `productContext.leadPivot`, `productContext.freshness.reason`,
  `productContext.repository.worktreeId`, `workspaceRouting.reason`,
  `workspaceRouting.perRepository[]`, `intent.reason`, `savedObservation`,
  `warnings`, `flow.skipReason`. M175's `request.task` is CONSTANT, as designed.

- **Ladder exhaustion did not earn a new agent-facing state.** It changes nothing a
  coding model can infer or do differently from the graceful case — evidence
  existed, none could be delivered, same remedy. The distinction a maintainer needs
  is one internal boolean, `productContext.diagnostics.envelopeDecline`. §42's
  "do not pool states" is satisfied in the reporting, which is where it matters.

- **Bound by omission, not truncation, wherever a value carries a claim.**
  `topMatch` is a follow-up tool argument, so a truncated symbol name is an
  identity that does not resolve; the freshness pair is quoted verbatim into the
  decline's note, so a truncated reason is a re-worded claim.

- **The ladder was already destroying readiness under pressure.** The
  `diagnostics.indexFreshness` rung deletes every object-valued key under
  `diagnostics.freshness`, `readiness` among them, and `readDeclineEvidence`
  defaults a missing record to READY. The boolean is now captured before the ladder
  runs. Responses that fit are unaffected.

- **`compacted_fields` is a bounded audit report, not a fact about the response.**
  Sorted, deduplicated, capped at ten entries — the first draft of the M176 tests
  used it as a signal that a step had run and six of them failed for that reason.
  Telemetry and tests must read the state itself.

- **Two raw tallies did not survive attribution, and both were re-measured rather
  than explained.** 11 of 200 default responses were not byte-identical between the
  arms; re-run with the checkouts INTERLEAVED, all 11 are byte-identical and both
  arms self-stable — Broad100-A and B had run concurrently, separating the arms by
  minutes and load. And §48 monotonicity does NOT hold on
  this corpus: `django__django-10880` delivers an orientation at 400 and 600, a
  delivery_failure at 800 and 1,000, and an orientation again at 1,600. Both checkouts loaded into
  one process over the same snapshot bytes give byte-identical rank ladders apart
  from the four budgets where `throw` became `decline`. Pre-existing, in the
  progressive delivery packer, unchanged by M176.

- **A second non-idempotence trap, recorded so it is not walked into again.**
  `applyProgressiveContextBudget` derives retrieval success from
  `resolved || items.length > 0` and never consults a `retrievalFound` a previous
  pass wrote, so replaying compaction over an already-compacted `delivery_failure`
  response reclassifies it as `no_result` — a fabricated absence. The live product
  compacts once, so it is not shipped; but M175's 8,000-token `.debug` captures are
  unusable as specimens for delivery-state analysis, and every M176 specimen is a
  single-pass authoritative capture at 120,000 tokens.

- **The invariant is established architecturally, satisfied for `run_pipeline`, and
  has one known outstanding violation.** `get_impact_graph` throws
  `impact_response_envelope_unreachable` at `impactResponseEnvelope.ts:340` —
  reproduced deterministically on a real symbol at `max_tokens` 1/50/200/400, with
  1,200 succeeding. Recorded, NOT repaired: §34 bounds the diff to the measured
  `run_pipeline` envelope, and repairing an envelope this milestone never measured
  would ship a change with no control corpus. M176 does not establish the invariant
  repository-wide.

- **Next-step recommendation: no live work, and no projection work.** Bounded
  declines are rare on ordinary input — 0 of 200 at the default budget, reachable
  only under a deliberately pressured budget or an adversarial field — which closes
  the correctness branch rather than opening a tuning one. Three concretely measured
  defects remain, in order: `get_impact_graph` envelope totality (same defect class,
  same repair shape, deterministic reproduction, narrow milestone); non-monotone
  progressive delivery packing in `budgetDelivery.ts` (a larger budget can deliver
  less, on 2 of 4 specimens); and `related`-selection instability across runs
  separated in time or load (11 of 200 under concurrent load, 0 of 11 interleaved,
  focus never moved, mechanism not investigated). Take only one of these, and only
  because it is measured.

---

# M177 — `get_impact_graph` Response Totality and Truthful Bounded Degradation

```text
bd712492  Answer with what you could not send, instead of dropping the call
this commit  M177 evidence, controls and closure
```

M176 proved the response-totality invariant for `run_pipeline` and recorded, as a
confirmed and deliberately unrepaired instance of the same defect class, that
`get_impact_graph` still threw `impact_response_envelope_unreachable` at
`impactResponseEnvelope.ts:340`. M177 repaired that one instance.

```text
A PASS   path traced from source and measurement; line 340's reachability explained;
         computation separated from delivery; repair seam identified
B PASS   known positive reproduced through real MCP stdio; 6 controls established
C PASS   decline contract derived; terminal construction proven; no new public state
D PASS   one function, one return where there was one throw; 8 new tests
E PASS   300 paired offline requests + 18 real-transport observations
F PASS   verdicts reached

defect          IMPACT_ENVELOPE_TOTALITY_DEFECT_CONFIRMED
degradation     IMPACT_TRUTHFUL_BOUNDED_DEGRADATION_VALIDATED
totality        IMPACT_VALID_REQUEST_RESPONSE_TOTALITY_CONFIRMED
product         KEEP_GET_IMPACT_GRAPH_WITH_TOTALITY_FIX
repository-wide KNOWN_ENVELOPE_TOTALITY_INSTANCES_REPAIRED
live            LIVE_WORK_NOT_LICENSED        spend $0.00
retrieval       UNCHANGED
impact graph    UNCHANGED
```

```text
                                        before   after
valid requests (60 symbols x 5 budgets)    300     300
  envelope-induced handler failures        208       0
  truthful bounded declines                  0     208
  fabricated absences                        0       0
  normal successful responses               92     300
  normal-response identity mismatches        —       0
default budget only
  requests                                  60      60
  bounded declines                           0       0
real MCP transport (18 observations)
  envelope-induced handler failures          7       0
  invalid_request / repo_not_ready         2/2     2/2

known positive  pytest-dev__pytest-10081 :: _enter_pdb
                max_tokens 1/50/100/200/400/476  handler_failed -> bounded decline,
                2,575-2,581 chars, 0 retained / 55 omitted edges;
                478+ byte-identical to the pre-repair response
```

## M177 standing findings

- **A degradation ladder must be gated on the same condition that decides whether
  its output can be returned.** `fits()` at `:183` tests three conditions; the
  throw at `:338` tested two of them. Every rung of compaction was driven by
  `modelVisibleEstimatedTokens <= requestedMaxTokens`, and then the call died on
  `estimatedTotalTokens > totalCeiling`. The ladder spent itself answering one
  question and was killed by another, so its residue was optimised against the
  wrong constraint. The mismatch is still there; only the throw is gone.

- **The floor was 61% metadata, and the ladder could only shrink the other 39%.**
  Read at the envelope floor for `_enter_pdb`: 745 tokens of `richSummary`,
  `diagnostics`, `callerCoverage`, `summary`, `resolvedSymbol`, `coverage`,
  `timing`, `requested` and `limits` that no rung touches, against 472 tokens of
  delivered evidence. The ladder's own floor is above zero too — `directRelations`
  stops at one, `edges` stops at one — and the five model-visible keys serialize to
  23 tokens even when every one of them is empty.

- **The decisive control was the symbol with no impact at all.** `__all__` — zero
  relations, zero edges, zero potential callers — also threw, at `max_tokens=1`,
  through the real transport. That rules out "the graph was too big" as the
  explanation. A defect reproduced on the case with nothing in it is a defect in
  the container, not the contents.

- **The truthful decline vocabulary already existed, and M139 built it.**
  `callerCoverage.exactCallerCount` beside `deliveredExactCallerCount`, and
  `richSummary.fieldDomains` naming the population each count was measured over,
  exist precisely so a reader can tell "we did not deliver it" from "it does not
  exist". `bounded_truncated` with `retainedEdges: 0` and `omittedEdges: 55` says
  what the decline needs to say, and an honest zero still reports
  `omittedEdges: 0`. No new public state; the maintainer's distinction is one
  internal boolean, `diagnostics.envelopeDecline`, exactly as in M176.

- **Analogous is not shared, and the difference is the contract.** `run_pipeline`'s
  terminal replaces the response with a differently-shaped record; `get_impact_graph`
  declares eleven required output fields, so its terminal must remain a valid
  `ImpactGraphOutput` — the same draft with its evidence emptied and its metadata
  bounded. Extracting a common envelope would have to erase the one difference that
  decides each design. The duplication is 40 lines and was chosen deliberately.

- **The terminal is safe because it is never re-gated, not because it is small.**
  It is built once and returned; nothing tests it and can reject it, so §26's
  "decline that cannot itself fit" is structurally absent rather than argued away.
  Its size is a constant: frozen constants, booleans, non-negative integers, enums,
  and four identity strings bounded at 200 characters — **omitted** past the bound,
  never truncated, because `fqName` is the argument a caller feeds back to this same
  tool and half a symbol name is an identity that does not resolve.

- **Both arms in one process is stronger than interleaving, when the code allows
  it.** M176 lost 11 of 200 identity comparisons to arms separated by minutes and
  load. The impact envelope is a pure function of an `ImpactGraphOutput`, so the
  pre-repair implementation was imported from a detached worktree and called on the
  *same in-memory object*. 92 of 92 comparable responses identical, with no
  scheduling difference able to reach the comparison at all.

- **Two instruments were wrong before the product was.** The first residue check
  reported 7 distinct terminal bodies across 7 failing budgets; the difference was
  `limits.maxTokens`, which is the request echoed back, and `responseBudget`, which
  reports it. And the first unit fixture never reached the code under test, because
  `graph()` is evidence-heavy and metadata-light and therefore fits at
  `max_tokens=1` — the exact opposite of the shape that fails. Both were fixed by
  measuring rather than by adjusting the expectation.

- **The envelope floor is not perfectly deterministic, by about one token.**
  `timing` carries full-precision floats whose decimal length varies, so
  `serializedCharacters` moves a few characters between runs: `max_tokens=476`
  answered on one real-transport run and declined on another with no code change.
  Every acceptance number here is a count of states; the threshold is reported as a
  location and never used as a gate.

- **Monotonicity holds on this ladder, and that is an observation, not a result.**
  Zero violations over 20 rungs: `retainedEdges` non-decreasing, no delivered
  response reverting to a decline. One ladder, one specimen. M176's genuine
  non-monotone delivery packer in `budgetDelivery.ts` is a different component and
  is untouched.

- **Next-step recommendation: stop, and do not start the monotonicity repair.**
  §80 is explicit and the measurement supports it — bounded declines are 0 of 60 at
  the default budget, so this closes a correctness branch rather than opening a
  tuning one. Six defects remain measured and unrepaired in
  `stage5_m177_outstanding_defects.md`; the two worth anyone's attention are the
  non-monotone packer (M176, reproduced, explicitly gated on authorization) and the
  `fits()`/terminal-check condition mismatch found here, which cannot be tightened
  without starting to decline responses the product returns today. The
  repository-wide claim is deliberately narrow: **all currently known instances are
  repaired**, not "no other instance exists" — no sweep for further envelope
  implementations was performed.

## M178 — Response Fit Contract Consistency and Budget-Semantics Alignment

```text
commits  a16a1709246113715cebc379cabe5c5938a8dd01   product
         4e38dfc5400525f9ebd2ab40cf640fa99024a219   evidence + ledger
from     ac2284bdaf7dfea818d7971a2cc037e91e57641b   (M177 close)

A PASS   every fit predicate inventoried, decomposed, unit-audited
B PASS   disagreement corpus frozen; all six instrument controls pass
C PASS   contract derived; three hypotheses resolved
D PASS   four candidates simulated; C_EXPLICIT_SPLIT selected before implementation
E PASS   smallest change: two named predicates, output byte-identical
F PASS   verdicts reached

contract          MULTI_SURFACE_FIT_CONTRACT_CONFIRMED
root cause        FIT_CONCEPTS_CONFLATED
alignment         FIT_CONTRACT_ALIGNMENT_VALIDATED
product           KEEP_CURRENT_RESPONSE_CONTRACT_UNCHANGED
totality          RESPONSE_TOTALITY_PRESERVED
monotonicity      NON_MONOTONE_DELIVERY_STILL_CONFIRMED
next work         MONOTONE_DELIVERY_PACKER_WORK_LICENSED  (M179; NOT started)
live              LIVE_WORK_NOT_LICENSED        spend $0.00
retrieval         UNCHANGED
impact graph      UNCHANGED
```

```text
                                             before   after
paired responses (60 symbols x 19 budgets)    1,140   1,140
  byte-identical                                  —   1,140
  normal responses                              644     644
  truthful declines                             496     496
  envelope handler failures                       0       0
  unreachable states                              0       0
default budget only
  disagreements, envelope-isolated                0       0
  disagreements, engine-coupled                   0       0
pressure budgets
  delivered with the compaction target unmet    564     564   (retained deliberately)
run_pipeline (6 snapshots x 16 budgets)
  delivery-contract violations                    0       0
  envelope-contract violations                    0       0
real MCP stdio (18 observations)
  handler failures / unreachable                0/0     0/0

verification   typecheck 0, typecheck:benchmarks 0,
               bun test 5511 pass / 49 skip / 0 fail, git diff --check clean
```

## M178 standing findings

- **`max_tokens` was never one bound, and the tool schema said so all along.**
  `get_impact_graph` publishes "max_tokens bounds model-facing impact content"
  AND "the complete response adds max(800, 15%) metadata tokens and is checked
  after all fields are attached". `run_pipeline` publishes the same pair. Two
  contracts, both real, both public. M177's mismatch was one boolean named
  `fits()` computing both, and neither caller was wrong: the terminal tests the
  only condition that may withhold a response, the ladder pursues a target it is
  permitted to miss. **FIT_CONCEPTS_CONFLATED**, and the repair is two names.

- **The disagreement window is the surplus metadata allowance, exactly.** Below
  its floor the ladder is exhausted, so the draft is a constant; the terminal
  accepts on `B >= mvFloor + metaFloor - allowance` and the target holds on
  `mvFloor <= B`, so a normal response is emitted with the target unmet on a
  window of width `allowance - metaFloor`. Nothing about the evidence enters it.
  On the M177 known positive: 484 + 793 - 800 = 477, window [477, 483], width 7 =
  800 - 793. **60 of 60** corpus symbols confirm the prediction, 0 failures, and
  the measured excess never exceeds the surplus bound (max 41, mean 18.08). The
  overshoot is allowance metadata did not need — not the caller's evidence budget.

- **The structural claim was checked on the implementation it was NOT derived
  from.** `run_pipeline` carries the same two bounds but enforces them in two
  components: `budgetDelivery.ts` sheds to `delivery_failure` rather than
  overshoot, so no surplus is ever available to its evidence channel, and its
  ladder and terminal test the same condition. Predicted no window; measured 0
  violations of either contract over 6 snapshots x 16 budgets. `get_impact_graph`
  needed the two names because one ladder does both jobs there.

- **C2 is dead, and that is a proof rather than a sample.** `totalCeiling` is
  clamped to `IMPACT_HARD_SERIALIZED_CHARACTER_CEILING / 4`, so C1 already bounds
  the response at 80,000 characters — C2's own bound. Zero counterexamples across
  every budget the tool accepts (1..20,000). Kept as an explicit backstop and
  pinned by a test, because the clamp that kills it is three lines away.

- **Two instrument errors, both caught before they became findings.** The M176
  snapshots are wrapped under `.snapshot`, and compacting the wrapper produced a
  flat meaningless ladder. And varying the request budget moves the ENGINE's spend
  of `max_tokens` (`takePathsWithinTokenBudget`) as well as the envelope's, which
  manufactured a "residue constant on 14/60" and 18 false window-prediction
  failures. Holding one authoritative object fixed and varying only
  `limits.maxTokens` took both controls to 60/60. M178 is a milestone about the
  envelope; the engine had to be held still to see it.

- **Never compare envelope outcomes across two runs.** A naive before/after re-run
  reported 20 decision differences across 1,016 shared cases — every one a
  specimen sitting on its envelope floor and tipped by the decimal width of a
  `timing` float, and none of them the change. The M177 technique (both arms
  imported into one process, called on the same in-memory object) returned 1,140
  of 1,140 byte-identical. Expect ~2% boundary noise from any other method.

- **`modelVisibleEstimatedTokens` measures five evidence keys, not what the model
  sees.** M166/M167 established the whole response is model-visible and billed, so
  the quantity matching that name is `estimatedTotalTokens`. The field name
  asserts the opposite of what it measures and is the likeliest cause of a future
  reader re-deriving M177's reading. NOT renamed: it is agent-visible output and a
  rename would break byte-identity for no gain the predicate names do not deliver.
  Recorded as an outstanding defect.

- **Next-step recommendation: M179, the monotone delivery packer, and nothing
  else.** The Django sequence reproduces unchanged (400/600 orientation, 800/1000
  delivery_failure, 1600 orientation; one violation on the grid), and M178 proves
  it is not caused by fit semantics — it sits on the `run_pipeline` path, which has
  no disagreement window at all. M179 inherits a settled definition of "fits at
  budget B" and a packer defect entirely its own. The M178 claim stays narrow:
  **the audited response-fit contract is coherent for the measured model-facing
  envelope paths** — no repository-wide sweep was performed, and `search_logic_flow`
  accepts a `max_tokens` that was not audited.

## M179 — Monotone Delivery Packing and Budget-Preservation Invariant

```text
commits  7381a57414eb0311a8f7e6e655651fcfbc5f719b   product
         d5a39f93ec9b4d701d11f074ff08646f12ffc643   evidence + ledger
from     a4eee924d9559ad1f9e132b008ba2f34eb126426    (M178 close)

A PASS   packer mapped as a state machine; every budget-dependent decision and
         hidden cap named; selection separated from rendering
B PASS   two frozen corpora captured and hashed; detector 15/15, identity 24/24,
         fixture control caught a corpus that was measuring headers
C PASS   first divergence located to the token; 1,088/1,088 declines dominated
D PASS   three candidates simulated before any code change; C_NESTED_RUNG selected
E PASS   one seam, one function; no V2 path, no refactor
F PASS   qualified on Broad100-A and Broad100-B; verdicts reached

root cause        PACKER_FALLBACK_NON_MONOTONICITY
invariant         BUDGET_MONOTONE_DELIVERY_PARTIAL
repair            MONOTONE_PACKER_REPAIR_VALIDATED
product           KEEP_COMPACT_ORIENTATION_WITH_MONOTONE_PACKER
totality          RESPONSE_TOTALITY_PRESERVED
truthfulness      PACKER_TRUTHFULNESS_PRESERVED
economics         COMPACT_ECONOMICS_PRESERVED
next work         PACKER_FOLLOWUP_REQUIRED   (item metadata is evidence; NOT started)
live              LIVE_WORK_NOT_RUN          spend $0.00
retrieval         UNCHANGED
ranking           UNCHANGED
fit contract      UNCHANGED (M178 names preserved)
```

```text
ordered budget pairs, 169 frozen objects x 12 budgets    before   after
  orientation -> decline                                  1,088       0
  semantic item loss                                         40      62
  priority inversion                                          0       0
  representation downgrade                                    0       0
  interpretation-critical qualifier evicted                   0       0
  focus substituted                                           6      21
  decline -> refused (throw)                                  0       0
  total violating pairs                                   1,134      83
  cases with any violation                              156/169  45/169
dominance of the declines (before)
  Broad100-A                                            580/580       —
  Broad100-B                                            508/508       —
gates
  no-refill: budgets that already worked and changed         —       0
  default-budget byte-identical                              —   155/169
  default-budget changes classified UNEXPECTED               —       0
  totality failures / throws                               0/0     0/0
  truthfulness failures                                      —       0
economics on the path that already worked
  Broad100-A median / p90 model-visible tokens          921/5,131  921/5,131
  Broad100-B median / p90 model-visible tokens        1,334/5,360 1,334/5,360

verification   typecheck 0,
               typecheck:benchmarks 1 PRE-EXISTING (M178's deleted worktree path), 0 new,
               bun test 5515 pass / 49 skip / 0 fail (5,564 across 352 files),
               git diff --check clean

               ENVIRONMENTAL, recorded per §105: one full-suite run taken while the
               machine sat at load average 21-27 under unrelated jobs reported
               2 fail / 2 errors and took 478s against a 267s baseline, with bun
               holding ~20% of a core. Re-run under normal load: 0 fail. Targeted
               runs of every subset the repair can reach are clean --
               src/mcp 228/0, src/runPipeline 96/0, benchmarks 2,608/0. No product
               regression is derived from the saturated run.
```

## M179 standing findings

- **The packer was not where the defect lived, and M176's attribution was wrong.**
  `applyProgressiveContextBudget` resolves at *every* budget of the Django ladder
  and its delivered item count rises 1 → 12 → 17 → 22. Its rung sequence does not
  depend on the budget, no rung grows a draft, and the budget selects only where to
  stop — so it is budget-monotone on its own. The decline came from
  `degradeOversizedProductResponse`, two components downstream.

- **The two bounds M178 named grow at different rates, and the packer aims at the
  wrong one.** `max_tokens` bounds the evidence; `B + max(1000, 15%)` bounds the
  complete response. Real metadata costs 1,087–1,269 tokens against a 1,000-token
  allowance, so affordable evidence is `B - ~221` and any rung in that gap is
  selected and then cannot be sent. The fit condition `rung(B) <= ceiling(B) -
  metadata` predicts the terminal state on every row of the ladder.

- **Non-monotone because slack is, not because the ladder is.** Rung sizes are a
  step function, so `B - rung(B)` collapses when the ladder jumps. Boundary search
  puts the Django transition at **946 good / 947 bad** — exactly the rung size —
  and recovery at **2,124 / 2,125**.

- **Every decline was dominated, and the arithmetic shows by how much.**
  1,088/1,088 across both corpora: a packet already proven deliverable at a smaller
  budget satisfied both M178 contracts at the larger one. At `max_tokens` 1,000 the
  degraded Django response occupied 1,210 tokens of a 2,000-token ceiling — the
  product discarded the evidence and shipped 790 tokens of unused headroom.

- **The repair lowers the packer's aim, never the caller's entitlement.** The
  evidence budget may be reduced beneath a fixed ceiling until the chosen rung is
  deliverable. It cannot invent anything: re-running a fixed ladder at a smaller
  budget returns a rung the packer would itself have published for a smaller
  request. Raising the metadata allowance was simulated and rejected on measurement
  rather than principle — it changes *which* budgets fail and leaves 580 violations
  standing.

- **The default path was failing on ordinary tasks.** `run_pipeline`'s default
  `max_tokens` is 8,000, and at that budget **14 of 169** frozen tasks returned a
  47-token delivery-failure notice instead of evidence — `pallets__flask-5014`,
  `pytest-dev__pytest-10051`, `sphinx-doc__sphinx-7748`, `sympy__sympy-13974` and
  ten more on Broad100-B. They now return 6,002–7,876 model-visible tokens. These
  were not edge budgets chosen to provoke the defect; this is the shipping default.

- **"Enough, then stop" survived, and that is measured rather than argued.** Every
  budget that already produced an orientation is byte-identical, on both corpora,
  at every budget. The whole-ladder and default-budget medians rise only because
  334 budgets that used to deliver nothing now deliver evidence; on the path that
  already worked, median and p90 are identical to the token.

- **Three instrument errors, two caught before they became findings.** (1) The
  corpus was a response, not the packer's input: `compactProductResponse` removes
  `items[].content` unconditionally, so captures taken the ordinary way — including
  M176's own snapshots — re-pack into body-free sections and measure rungs made of
  headers. With `include_item_content` the Django window moves from 800–1,000 to
  1,000–2,000. (2) `codeTruncated` is not a downgrade signal: treating it as one
  reported 815 representation regressions, 477 of which were a body growing from
  221 to 1,799 characters with an honest qualifier. Measuring delivered code took
  that class to 0 before and 0 after. (3) Not fixed, only normalized:
  `parseRenderedBodies` serves the renderer's closing sentence as the last item's
  source code, on **268 of 582** and **218 of 464** orientation packets.

- **What the repair exposed is the next milestone.** 83 pairs still lose a related
  entry or move the focus, and all of them trace to one thing:
  `compactMandatoryProductMetadata` collapses `productContext.items` as a *metadata*
  saving, while the orientation projector derives both the focus and the entire
  related list from that array. It also keeps `items[0]` where the packer's own
  rung 8 keeps `sort(compareKeepPriority)[0]` — two different "strongest item"
  rules, so a larger budget can point the agent at a different site. These pairs
  were mostly unmeasurable before, because those budgets declined instead of
  delivering. **PACKER_FOLLOWUP_REQUIRED; not started.**

- **Next-step recommendation: item metadata is evidence.** M180 should make the
  last-resort item collapse aware that the orientation projector reads
  `productContext.items` as its evidence source — not widen the packer, not touch
  retrieval, and not raise any ceiling. The M179 claim stays narrow: **the
  orientation → decline class is eliminated on the measured `run_pipeline` delivery
  path.** `get_impact_graph` has its own envelope and its own ladder and was not
  swept for monotonicity here.

## M180 — `productContext.items` Evidence/Metadata Ownership and Monotone Semantic Preservation

```text
commits  291c9c8dd439cce12114e89d50988434295578b9   benchmark harness hygiene (NON_PRODUCT)
         e62cbe6eb4798ce4ba4be55ed337ce014fbd07ee   product
         cb522c9c1636c34532f104d4915d2d4db8590553   evidence + ledger
from     47058f04ee189c82f49bb3fb64c4079817265957    (M179 close)

A PASS   harness typecheck repaired in its own commit; every producer and consumer
         of productContext.items traced; aliasing established (structuredClone at
         the boundary, in-place mutation after — a layering defect, not aliasing);
         compactor authority and projector input source established
B PASS   83 of 83 reproduced exactly (35 A, 48 B); semantic identity and supply
         hash defined; first divergence located; synthetic, known-negative and
         identity controls pass
C PASS   items classified MIXED_RESPONSIBILITY; compactor NOT authorized;
         projector was reading a serialization surface; three lifetimes named;
         no product code changed before diagnosis
D PASS   three candidates simulated on both corpora before any product change;
         candidate never tuned after measurement; not selected using gold
E PASS   three files, one publication; no V2 path, no schema change, no refactor
F PASS   all ordered budget pairs on both corpora; verdicts reached

root cause        PROJECTOR_READS_MUTABLE_SERIALIZATION_SURFACE
ownership         SEMANTIC_AND_METADATA_OWNERSHIP_SEPARATED
preservation      BUDGET_MONOTONE_SEMANTIC_PRESERVATION_PARTIAL
repair            ITEM_OWNERSHIP_REPAIR_VALIDATED
product           KEEP_COMPACT_ORIENTATION_WITH_ITEM_OWNERSHIP_FIX
totality          RESPONSE_TOTALITY_PRESERVED
truthfulness      ORIENTATION_TRUTHFULNESS_PRESERVED
economics         COMPACT_ECONOMICS_MATERIALLY_CHANGED   (packet +103% at the default budget)
next work         SEMANTIC_PRESERVATION_FOLLOWUP_REQUIRED   (compactReasons; NOT started)
live              LIVE_WORK_NOT_RUN          spend $0.00
retrieval         UNCHANGED
ranking           UNCHANGED
fit contract      UNCHANGED (M178 names preserved)
```

```text
the ownership metric (§60), 169 frozen objects x 12 budgets   before   after
  delivering budgets                                           1,380   1,380
  budgets where the metadata layer changed the semantic
  evidence source the PROJECTOR CONSUMED                          722       0
  budgets where productContext.items was compacted                722     722   (by design)

ordered budget pairs, M180 preservation semantics             before   after
  focus changed                                                    0       0
  related item lost                                               54       8
  related item replaced / semantic role changed                    0     106
  claim downgraded                                                 0       0
  orientation -> decline                                           0       0
  priority inversion / representation downgrade / qualifier        0       0
  total                                                           54     113
  (benign: claim upgraded)                                         8     757
  (benign: focus resolved to the declared lead pivot)             21      21
```

## M180 standing findings

- **The array had two owners and the type said nothing.** `productContext.items` is
  the model-facing per-item metadata `responseEnvelope.ts` shrinks to fit a ceiling
  AND the index `projectRunPipelineOrientation` reads to decide what the agent is
  told. Two rungs shrank it by DELETING rows — `compactMandatoryProductMetadata`
  replaced the array with `[items[0]]` (63 of the 83), the escalation ladder halved
  it to a floor of three (9 of the 83) — while leaving `modelVisibleContext`
  untouched. The response kept paying to ship evidence the projector could no
  longer reach, on **167 of 169** frozen cases at some budget.

- **The rendering is an unforgeable witness, and that is what made attribution
  possible.** `applyProgressiveContextBudget` sets `product.items` and renders
  `modelVisibleContext` from the SAME delivered list, and nothing downstream
  rewrites that rendering except the last-resort degradation. So `section ids minus
  item ids` is exactly the evidence the metadata layer withheld from the projector.
  Do NOT use `responseBudget.compacted_fields` for this: it is
  `[...new Set(f)].sort().slice(0, n)`, alphabetically truncated, so
  `productContext.items` falls off the report on precisely the responses where it
  fired.

- **A synthetic object with nothing in it but items reproduces the defect.**
  Sixteen items, no retrieval, no ranking, no upstream state: three related entries
  at `max_tokens` 1,600 and two at 3,200. There is nothing else to blame.

- **On the default path the compacted response is discarded.** `tools.ts` returns
  `orientation ?? decline ?? authoritativeResult`, so when the projector resolves,
  nothing the envelope produced crosses the wire. The envelope was budgeting a
  payload nobody receives, and the one lasting effect of that budgeting was to cut
  the index of the payload that does.

- **The repair is a publication, not a rewrite.** The component that owns the
  evidence budget publishes what it delivered, frozen, keyed on the productContext
  record's object identity, never serialized; the projector reads that. Zero
  serialized bytes, so it cannot push a response over a ceiling — the response is
  **byte-identical at the default budget on all 169 cases** and metadata medians are
  unchanged to the token. `compactMandatoryProductMetadata` and the ladder are
  untouched and still compact the same 722 budgets.

- **The obvious repair was measured and rejected.** Making the rungs preserve rows
  and reduce each to its index shape fixes the serialized response too — and costs
  **26 new `orientation -> decline` pairs**, the class M179 drove from 1,088 to 0.
  A stripped item row is still 178 characters and fourteen do not fit a 1,000-token
  allowance. §55 admits no regression there, so it lost on totality, not economics.

- **What the repair exposed is the next milestone.** 106 of the 113 residual
  violations are `compactReasons` in `budgetDelivery.ts` selecting a *preferred*
  reason while the uncompacted path leaves `selectionReasons[0]` first — so which of
  a symbol's authoritative claims the agent sees depends on whether the evidence
  layer compacted. Verified, not assumed: of **10,203** claims delivered, **10,185**
  are verbatim authoritative and **18** an authoritative reason under the
  160-character ellipsis; **0 unsupported**, **0** about a symbol outside the supply.
  Nothing is invented and nothing is lost — the *choice* is budget-dependent. The
  remaining 8 are `ORIENTATION_POLICY.ceilingTokens`, a flat 2,000 the packet now
  reaches (M179 outstanding §2).

- **Compactness was partly a defect.** The packet median rises 462/583 → 1,208/1,291
  tokens, and 769 → 1,560 at the default budget. `ENOUGH, THEN STOP` still holds —
  what ends a packet is the authoritative supply running out — but the supply was
  being cut before it got there, so part of M172's measured ~600-token median was
  this bug. Packets below `max_tokens` 800 are unchanged to the token; growth begins
  at 1,600, where the collapse began. The packet is still bounded by the 2,000-token
  orientation ceiling and four to five times cheaper than the full response.

- **Two scorings, and the difference is the instrument.** Under M179's
  `symbol|claim-wording` identity the after-count is 876, because the repaired arm
  delivers **10,203** related entries where the pre-repair arm delivered **2,016**.
  M180's preservation semantics were fixed before any candidate existed and are
  symmetric — a claim decaying to the roles fallback and a focus abandoning the
  declared lead pivot are violations, exactly as their reverses are benign. Measured
  claim downgrades: **0**. Measured focus changes away from the lead: **0**; all 21
  focus moves resolve *toward* it.

- **Next-step recommendation: fix the claim, not the packet.** M181 should make
  which authoritative `selectionReason` reaches the agent independent of whether the
  evidence layer compacted — a `budgetDelivery.ts`/projector question, not a
  retrieval or ranking one. Do not raise the orientation ceiling, do not widen the
  metadata allowance, and do not re-open the item rows in the serialized response:
  that was measured and costs a totality regression. Related-selection instability
  under load has NOT been re-measured since the deterministic mechanism was removed;
  reassess it only after the claim-selection defect is closed. The M180 claim stays
  narrow: **response bookkeeping can no longer alter the semantic evidence supply
  the orientation projector consumes, on the measured `run_pipeline` delivery path.**

## M181 — Selection-Reason Semantic Stability Across Compaction

```text
commits  14a67868672398aae8faa56901e1eb85ae5d3839   product (compactReasons + first test for budgetDelivery.ts)
         83163d2dd7f74ad55a44f763dc9673ae36c4cef8   evidence + ledger
from     189e190ded87b3b1ce952126b4997a8843e44e95    (M180 close)

A PASS   19/19 source claims re-verified against the file and line they cite;
         every producer, consumer and ordering source traced; vocabulary
         enumerated from the corpus (2,908 items, 9 families); compactReasons
         audited and the instrument's mirror regex proved character-identical to
         the product's; reason choice established as explanation-level, not
         selection-level
B PASS   106 / 8 / 757 / 21 reproduced EXACTLY, using M180's comparePreservation
         imported rather than reimplemented; authoritative reason sets frozen from
         the object deliver() clones, so no delivered field testifies about itself;
         identity 0 failures, known-negative 0/2,292, synthetic reproduces the
         defect with no retrieval or ranking present, permutation decisive
C PASS   reasons classified: position 0 is actionable role, the tail is provenance,
         separated BY POSITION at assembly; equivalence relation defined narrowly
         (same claim, not both-true); canonical-primary answered YES from four
         independent source sites; no product code changed before this concluded
D PASS   three of five §31 candidates rejected without simulation on C's grounds;
         two simulated on 169 cases; policy frozen before confirmation; not chosen
         to zero the 106
E PASS   one hunk in budgetDelivery.ts — reduction, not reselection; plus the
         first test file that module has ever had; no V2 path, no schema change
F PASS   15/15 closure gates; ceiling residuals counterfactually characterised

reason contract   PRIMARY_SELECTION_REASON_CANONICAL
root cause        COMPACT_REASON_SELECTION_BREAKS_CANONICALITY
preservation      BUDGET_MONOTONE_AGENT_SEMANTICS_VALIDATED
repair            SELECTION_REASON_REPAIR_VALIDATED
product           KEEP_COMPACT_ORIENTATION_WITH_REASON_FIX
totality          RESPONSE_TOTALITY_PRESERVED
truthfulness      SELECTION_REASON_TRUTHFULNESS_PRESERVED
economics         CURRENT_COMPACT_ECONOMICS_PRESERVED   (packet median 542 -> 542)
ceiling           REMAINING_CEILING_CASES_EXPECTED_BOUNDARY_EFFECTS
next work         CURRENT_PRODUCT_LIVE_REQUALIFICATION_REVIEW_LICENSED
                  (review and planning only; NOT authorised to run)
live              LIVE_WORK_NOT_RUN          spend $0.00
retrieval         UNCHANGED
ranking           UNCHANGED   (0 priority inversions between arms)
fit contract      UNCHANGED (M178 names preserved)
ownership         UNCHANGED (M180 separation preserved)
```

```text
ordered budget pairs, M180 preservation semantics             before   after
  semantic role changed (the reason residual)                    106      12
  related item lost (the ceiling residual)                         8       8
  focus changed / claim downgraded / orientation -> decline         0       0
  priority inversion / representation downgrade / qualifier        0       0
  total                                                          114      20
  (benign: claim upgraded)                                       757     754
  (benign: focus resolved to the declared lead pivot)             21      21

symbol-level reason substitutions                             before   after
  semantically non-equivalent (role claim -> provenance)          277       0
  representation only (160-character ellipsis)                    12      12
  total                                                          289      12

truthfulness, all delivering budgets                          before   after
  claims delivered                                            10,203  10,201
  unsupported by the authoritative reason set                      0       0
  about a symbol outside the supply                                0       0

what must not move                                            before   after
  projector supply cut by metadata (M180 invariant)                0       0
  throws / responses outside the envelope                          0       0
  orientations / declines                                1,380/648  1,380/648
  packet median, delivering budgets / default budget      542/1,225  542/1,229
```

## M181 standing findings

- **The array is a role claim followed by its provenance, and the separation is
  positional.** `assembleProductContext.ts:408` builds
  `unique([roleReason, ...evidence])`, and `productAdapter.ts:48` declares
  `roleReason` to be *"The decisive reason this item landed in its role"*.
  Position 0 answers what part the symbol plays; the tail answers how VTRACE found
  it. So a selector that ignores position cannot help but sometimes replace an
  actionable claim with provenance — which is what it did, **277 times out of
  277, always in that direction**, never the reverse.

- **`compactReasons` was doing two jobs and was only ever authorised to do one.**
  Reducing the array to one entry is its job; deciding WHICH entry was not. Its
  preference was a substring match on
  `/preferred contrast|symbol-name match|direct evidence|exact/iu` — the same four
  substrings `answerBearing` uses twelve lines above to decide which ITEM to keep.
  A keep-priority vocabulary was reused to rank an EXPLANATION. The shared word
  "preferred" made that read like intent.

- **The permutation control is what settled it.** One reason set in six orders:
  the declared decisive reason takes **three** distinct values, `compactReasons`'
  choice takes **one**. A selector that answers identically for orders whose
  decisive reason differs is not implementing a rival contract; it is blind to the
  only contract there is. Without this control the milestone could have concluded
  that two defensible priorities merely disagreed and split the difference.

- **The consumer arrived after the transform, and nothing failed in between.**
  `compactReasons` shipped in M136 (2026-08-09), when reasons were only rendered
  as a list of `why:` lines and reducing five to one had no canonical answer to
  violate. The orientation projector, which gave position 0 the standing of *the
  relationship claim*, shipped in M172. Neither change was wrong when made. The
  contract broke in the gap, silently, because **`budgetDelivery.ts` had no test
  at all**. It has one now, and it tests the contract rather than the behaviour.

- **A delivered response cannot testify about itself.** Every reason field on a
  delivered response is downstream of the transform under test. The witness is the
  frozen authoritative object, which `deliver()` clones before compacting. M180
  needed the same move for items (`modelVisibleContext` as the unforgeable
  witness); this is the reason-shaped version of it, and it is the reusable part.

- **What moved is the byte count, not the ranking — and that was measured.**
  8 of 2,028 (case, budget) points deliver a different evidence set, because a
  reason string has a length, `render()` includes it and `fits()` reads it. All 8
  are a tail entry entering or leaving. **0 priority inversions between arms**:
  the symbols both arms share come back in the same relative order everywhere.
  `compareKeepPriority` is untouched and `answerBearing` is computed from the FULL
  reason array before `compactReasons` runs, so neither could have moved.

- **The 8 ceiling pairs are genuinely bounded, and a sloppy counterfactual said
  otherwise.** Restoring each of the 14 lost entries into the larger budget's
  packet: **13** exceed the 2,000-token ceiling, **1** (`sympy-23824`, `TensAdd`,
  1,988 tokens) would fit but was excluded because admission had already stopped
  at an earlier, larger candidate — the deliberate prefix rule that keeps a
  tighter bound's output a subset of a looser one's. **0 unexplained.** The first
  version of this counterfactual restored a stub entry with no file and no line
  span, understated the cost, and reported 4 apparent extra defects. A
  counterfactual must reconstruct the thing it measures whole.

- **Two preservation metrics, and they still differ.** Raw presentation
  preservation is NOT achieved: 12 reason strings still change with budget, all of
  them the 160-character ellipsis cutting one claim. Agent-relevant semantic
  preservation IS: 0 violations. Reporting only one of them would have made the
  milestone unable to say "the wording moved and the meaning did not" — or to
  notice when that is false.

- **Next-step recommendation: assess load stability before spending anything.**
  `CURRENT_PRODUCT_LIVE_REQUALIFICATION_REVIEW_LICENSED` licenses review and
  planning only. The product IS materially different from the M173 treatment that
  was last qualified live — M180 roughly doubled the packet median, M181 changed
  which claim reaches the agent on 21 of 169 default-budget cases — and the
  deterministic defects that would confound such a run are now closed. But
  related-selection instability under load has not been measured since its
  deterministic mechanism was removed, and it is the one open item that could
  contaminate a live comparison. Measure it first; it is much cheaper. Do not
  raise the orientation ceiling and do not relax prefix admission to recover the
  single `TensAdd` entry: that trades a bounded omission for a monotonicity risk.

## M182 — Related-Selection Stability Under Load and Deterministic Packet Reproducibility

```text
overall           PASS (A/B/C/D/E/F all PASS)
stability         SEMANTIC_PACKET_STABILITY_VALIDATED
root cause        ENVIRONMENTAL_ONLY_FALSE_POSITIVE
repair            NO_PRODUCT_CHANGE_REQUIRED
product           KEEP_COMPACT_ORIENTATION_UNCHANGED
totality          RESPONSE_TOTALITY_PRESERVED
truthfulness      ORIENTATION_TRUTHFULNESS_PRESERVED
economics         CURRENT_COMPACT_ECONOMICS_PRESERVED
live readiness    CURRENT_PRODUCT_LIVE_REQUALIFICATION_LICENSED
live              LIVE_WORK_NOT_RUN          spend $0.00
retrieval         UNCHANGED
ranking           UNCHANGED
fit contract      UNCHANGED
ownership         UNCHANGED
evidence commit   c17329dce00c4af3b879c2d2c447c62d650ce86d
```

```text
frozen-authority stability
  cases                                                        7
  deliveries                                               1,820
  conditions        serial/repeat/CPU/I/O/concurrent/interleaved/process
  focus / membership / order / reason changes          0 / 0 / 0 / 0
  semantic packet variation cases                           0

fixed-index full generation
  cases / calls                                          3 / 48
  conditions                  warm/CPU/concurrent/new-process
  supply/order/rank/item/packet variation rows     0/0/0/0/0
  telemetry-normalized byte variation rows                  0

real default MCP framed stdio
  calls / semantic hashes / byte hashes                  6 / 1 / 1
```

## M182 standing findings

- **Current related selection is a deterministic intervention in the measured
  regime.** The experiment froze authority before projection and separately
  reran fixed-index generation. Both layers stayed stable. M176's 11/200
  cross-time arm differences had no preserved first divergence and disappeared
  when interleaved; with M182's current-product controls they are an
  environmental-only false positive, not a product defect.

- **Debug bytes can move while the agent packet does not.** Every varying leaf
  was in `productContext.timing`, `accounting`, or `responseBudget` fields derived
  from timing/serialized width. Removing those diagnostic blocks made full
  responses identical, and the default MCP orientation was byte-identical without
  normalization. Timing is not retrieval authority.

- **Stable order already exists and remains semantically ranked.** Material
  comparators use primary score/tier/role priority, then repo-relative
  path/FQN/stable symbol ID. Assembly sorts `roleOrder, identity` before
  first-wins dedupe; the packer embeds authoritative index; projection preserves
  the resulting prefix. M182 did not alphabetize or add a second ordering owner.

- **Current default size is 1,229 median / 1,527 p90 / 1,576 max model-facing
  tokens** over 167 Broad default-budget orientations. This is the treatment a
  future live benchmark must qualify, not M173's ~629-token packet.

- **Next-step recommendation: a current-product paired live requalification is
  licensed, but not started.** Prefer a preregistered new stratified sample with a
  small replication stratum, actual default automatic compact orientation, no
  investigation coercion, and whole-run solve/token/cache/cost metrics. The
  deterministic semantic-preservation branch M175–M182 is closed unless new
  evidence appears.

- **The untracked audit remains untouched.** `VTRACE_TOOLING_AUDIT.md` still has
  the stale M171 five-entry-cap and pre-M179 non-monotonicity claims. M182 records
  them in its tracked audit-status artifact but does not take ownership of the
  user's untracked file.

## M183 — Current-Product Live SWE-bench Requalification

```text
overall           MIXED (A/B/C/D/E PASS; F closes on a negative result)
resolution        OBSERVED_RESOLUTION_PARITY            19/30 vs 19/30
statistical       RESOLUTION_DIFFERENCE_NOT_STATISTICALLY_RESOLVED  exact McNemar p=1.000
whole-run tokens  WHOLE_RUN_TOKEN_USAGE_NEUTRAL         5.26% pooled, CI spans zero
whole-run cost    WHOLE_RUN_COST_EFFECT_MIXED           median -$0.037, aggregate +0.21%
product           CURRENT_PRODUCT_UTILITY_NEUTRAL       §110 D / §125
causality         NO_CLEAR_VTRACE_CAUSAL_UTILITY_EVIDENCE
economics mech    TAILS_DOMINATE_ECONOMIC_EFFECT
VEXP class        VEXP_CLASS_VALUE_PROPOSITION_NOT_YET_SUPPORTED
publication       PRODUCT_FOLLOWUP_REQUIRED_BEFORE_SCALE
product changed   NO      retrieval NO   ranking NO   fit NO   ownership NO
live              RUN     60/60 arms, 30/30 valid pairs, spend $38.33 of an $80 cap
evidence commits  7d6245b3  166d07a7  ce44c804
```

```text
paired outcome                    apparatus
  both solved            17         arms completed              60/60
  VTRACE-only wins        2         valid pairs                 30/30
  baseline-only wins      2         orientation delivered       30/30
  neither solved          9         baseline trigger present     0/30
                                    failures / infra retries    0 / 0

orientation (the DEFAULT path)    displacement (paired medians)
  median          579.5 tokens      tool calls before 1st edit   6 -> 4
  p90             814               searches before 1st edit   2.5 -> 1
  max             941               reads before 1st edit        2 -> 2

localization                      economics
  focus is gold file    19/30       baseline median cost   $0.5097
  gold file in packet   21/30       VTRACE  median cost    $0.4998
  edited the focus      17/30       aggregate B / V   $19.14 / $19.19
  orientation ignored    8/30       tail share of aggregate delta   19x
```

## M183 standing findings

- **Exact parity, and the localization was fine.** 19/30 both arms, 4 discordant
  pairs split 2-2, p = 1.000. The orientation named a gold file on 21/30 and its
  focus was a gold file on 19/30, yet **6 tasks had a correct focus and still
  failed** while **6 solved with a focus that was not a gold file**. Knowing where
  to look is not what separated a solve from a failure on this sample. The
  measured bottleneck is repair and validation, not retrieval.

- **The baseline reached the same files anyway.** Baseline touched the
  orientation-named files on 21/30 against the treatment's 22/30. The packet
  arrived sooner — median 0 tool calls to first contact against 1 — but it was not
  carrying information the agent could not get for itself. This is M164's shape
  repeated with a delivered, correct, compact packet instead of an ignored tool.

- **Displacement happened and did not pay.** Pre-edit tool calls fell 6 -> 4 and
  searches 2.5 -> 1. Whole-run cost still came out $19.19 against $19.14. M169
  priced early investigation at fractions of a cent against runs of ~1.1M tokens;
  M183 confirms that removing a search is real and immaterial.

- **`WHOLE_RUN_COST_EFFECT_MIXED` is literal, not a hedge.** The paired median
  favours VTRACE (-$0.0367) and the pooled aggregate favours baseline (+0.21%).
  Both are reported because they answer different questions, and the ten tail
  pairs carry 19x the aggregate delta — a $0.05 difference on $19 is tail noise,
  not an economic effect.

- **M182's "current default orientation size" is the top rung of a budget
  ladder.** Its 1,229/1,527/1,576 is the slice where `max_tokens` was passed
  explicitly as 8,000; a default `run_pipeline` call does not land there.
  Measured on all 30 manifest cases: default 579.5/814/941 against the same
  sample's 8,000 rung at 1,245.5/1,374/1,607 — the rung REPRODUCES M182's number
  on a different sample, which is what makes this a diagnosis. M183 qualifies the
  default path, and the live median's correct neighbour is M182's own all-budgets
  median of 542.

- **A rebuild that does not rebuild, and reports success.** `rm -rf .vtrace` then
  `vtrace index` leaves the reusable-snapshot registry alive inside
  `<gitCommonDir>/vtrace/.../snapshots`, so the differ returns `noop`, parses zero
  files and leaves an EMPTY database while exiting 0 with a manifest whose every
  file says `indexOutcome: "indexed"`. flask-5014: 0 symbols over 91 "unchanged"
  files; clearing both stores gave 1,165. User-reachable and invisible at every
  surface a caller checks. Worked around in the benchmark (clear both stores, gate
  on `full_rebuild && symbols > 0`); NOT repaired — it needs the retrieval
  no-change proof.

- **An empty patch is a determinate unresolved, not an ungraded arm.**
  django-13513 produced no patch on BOTH arms after 51 and 47 turns of real work.
  The grader writes no `_eval.meta.json` for such a run, and keying `graded` on
  that file alone would have silently dropped the pair and shrunk N to 29.

- **Next-step recommendation: no further live spend, and no retrieval work.**
  `PRODUCT_FOLLOWUP_REQUIRED_BEFORE_SCALE`. A larger benchmark buys precision on
  an effect that measured zero. Do not enlarge the packet to chase the 6
  correct-focus failures (§124): the evidence says they are repair failures. If a
  milestone follows, it should look at repair and validation, and it should first
  fix the indexer defect above, which is worth more than another benchmark.

## M184 — Index Materialization Authority and Truthful No-op Semantics

```text
overall           PASS (A/B/C/D/E/F PASS)
root cause        NOOP_PREDICATE_OMITS_MATERIALIZATION_VALIDITY
repair            INDEX_MATERIALIZATION_REPAIR_VALIDATED
no-op             TRUTHFUL_NOOP_SEMANTICS_VALIDATED     7 false-healthy states -> 0
index equivalence REMATERIALIZED_INDEX_SEMANTIC_EQUIVALENCE_VALIDATED  22,105-row dump identical
retrieval         RETRIEVAL_SEMANTICS_PRESERVED         32/32 packets, paired per-arm indexes
M183 validity     M183_INDEX_CONTAMINATION_NOT_OBSERVED 30/30 arms full_rebuild, DB-read symbols
product           KEEP_INDEXER_WITH_MATERIALIZATION_AUTHORITY_FIX
truthfulness      INDEX_STATUS_TRUTHFULNESS_PRESERVED_OR_STRENGTHENED
performance       INDEX_REPAIR_PERFORMANCE_ACCEPTABLE   no-op flat; recovery 1.8s vs 10.6s rebuild
next              M183_FAILURE_STAGE_AUDIT_LICENSED
product changed   YES     retrieval NO   ranking NO   index format NO   lifecycle YES
live              NOT RUN  spend $0.00
evidence commits  7b10dcd0  14194767
```

```text
headline (1,257 scanned / 747 indexable)      no-op control (same repo)
  rm -rf .vtrace && vtrace index                healthy unchanged, vtrace index
  BEFORE  exit 0, "indexed", noop                 BEFORE  noop, 0 parsed, 378-398 ms
          0 files, 0 symbols                      AFTER   noop, 0 parsed, 372-399 ms
          query: "Repo not indexed"               empty repo after rm -rf: still noop
  AFTER   exit 0, incremental
          747 files, 5,128 symbols              recovery cost
          query: pivot delivered                  747 cache hits, 0 reparsed, 1.8 s
                                                  full rebuild it replaces: 10.6 s
adversarial matrix                            tests
  false-healthy states before      7            new tests                14
  false-healthy states after       0            known-positive detectors  5
  already-correct controls         4            controls passing both     9
  unchanged by the repair          4            suite  5574 pass / 49 skip / 0 fail
```

## M184 standing findings

- **The guard existed and was dead.** `indexProject` already degraded a no-op when
  `options.hasExistingGraph === false` — but **only `src/setup/initRepo.ts` ever
  passed that option**. `reindexRepoAndRefreshState`, the path behind `vtrace
  index`, never did. So `vtrace init` was safe in a fresh worktree while `vtrace
  index` was not, which is exactly the shape that lets a defect survive review: the
  correct condition is present in the code and unreachable from the CLI.

- **The defect was broader than reported.** M183 recorded it as the durable
  registry under `<gitCommonDir>/vtrace` surviving `rm -rf .vtrace`. Measured
  generically, **seven** states produced a healthy no-op over an empty graph, and
  two are not registry cases at all: `.vtrace/index.meta.json` intact with only
  `index.sqlite` deleted (the manifest alone certifies an empty database), and a
  **never-indexed sibling worktree** whose first `vtrace index` adopted another
  worktree's snapshot because the registry is keyed by the shared `repositoryId`.

- **`noop` is the only mode that skips the persist transaction.** That transaction
  `DELETE`s `files`/`symbols`/`edges` and every FTS table and re-inserts all parse
  results for `incremental` and `full_rebuild` alike — "incremental" is a *parse*
  optimization, not a partial-graph mutation. This is why no-op eligibility is the
  entire attack surface, and why degrading a false no-op to `incremental` is a full
  re-materialization that still costs only a cache read: 747 hits, 0 reparses.

- **The validity predicate must be structural, never content-count.** `symbolCount
  > 0` would call a legitimately empty repository broken. Comparing the snapshot's
  **indexed subset** against the `files` table by path and content hash is
  coherence between two surfaces the same transaction writes: an empty repository
  matches an empty graph and stays a valid no-op, and a graph attached to the wrong
  source state is caught for free. Validated on a mixed repository where 506
  `failed` and 4 `skipped` entries are correctly excluded and the indexed set
  matches the graph exactly.

- **A paired product comparison must give each arm its own index.** M184's first
  retrieval proof was confounded: reverting product source to build the predecessor
  arm moved `indexer_fingerprint`, so that arm correctly refused an index built by
  the other and reported `capsuleMode: no_context`. That is M141/M146 working, not
  a retrieval change — but it would read as a catastrophic regression to anyone
  comparing a stored baseline. CLAUDE.md's rule that each side generate its own
  index against the same immutable corpus is load-bearing, not ceremony.

- **M183 is not reinterpreted.** All 30 counted treatment arms are authoritatively
  clean, on a witness M183 built for this exact purpose during its own preparation.
  `CURRENT_PRODUCT_UTILITY_NEUTRAL` stands. The index defect was real and
  user-reachable and it did not touch the benchmark.

- **Next-step recommendation: the M183 failure-stage audit, and nothing else yet.**
  `M183_FAILURE_STAGE_AUDIT_LICENSED`. It must begin with no product hypothesis and
  no code changes, and the standing threshold from the M184 prompt applies: continue
  VTRACE coding-agent utility work only if the audit finds a repeated mechanism
  where localization was already correct, failure occurred downstream, a concrete
  repository fact was missing, that fact is derivable from VTRACE authority,
  successful runs recover equivalent evidence, and a narrow counterfactual
  intervention can be specified. Do not continue on "give the model more context
  and hope". No retrieval work and no live spend are licensed by M184.

## M185 — M183 Failure-Stage Audit: Does Repository Intelligence Matter After Correct Localization?

```text
overall           PASS (A/B/C/D/E/F PASS)
bottleneck        DOWNSTREAM_REPOSITORY_INFORMATION_BOTTLENECK_PARTIAL
failure stage     CROSS_FILE_CONTRACT_DOMINANT            4 of 6, across 4 repositories
addressability    CURRENT_VTRACE_AUTHORITY_PARTIALLY_ADDRESSES_FAILURE_MODE   2 of 6
counterfactual    NO_COUNTERFACTUAL_INTERVENTION_LICENSED  0 cases have a success witness
agent utility     VTRACE_AGENT_UTILITY_HYPOTHESIS_WEAKENED
product work      NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED
authority         60/60 arm seals verified, 30/30 gold file sets recomputed from the dataset
cohorts           A 6  B 13  C 6  G 5   D 2  E 2  F 9  both-solved 17   all reconcile with M183
product changed   NO      retrieval NO   ranking NO   orientation NO   index NO
live              NOT RUN  spend $0.00   docker NOT RUN
evidence commits  53445592
```

```text
correct-focus SUCCESSES (13)              correct-focus FAILURES (6)
  median distinct files read   1            first decisive divergence
  read exactly one file       11/13           S3 cross-file contract        4
  opened a test file           1/13           S2 repair synthesis           1
  median tool calls            7              S4 implementation             1
                                            evidence never acquired         4
resolved arms        median calls 11         evidence on screen, misread     2
unresolved arms      median calls 15.5       success witness (OBSERVED_USE)  0

validation across all 60 arms             discordant pairs (4)
  attempted the repo's suite    14           winner had MORE evidence        2
  actually executed it           5           evidence equal on both sides    2
  refused by the environment      9          orientation causal              0
```

## M185 standing findings

- **The successful runs read less, not more.** The thirteen correct-focus
  successes read a median of **one** file; eleven of thirteen read exactly one and
  one of thirteen opened a test file, against a median of 15.5 tool calls for
  unresolved arms. This is the finding that decides M185. A repository fact whose
  absence explains a failure must be a fact some winner used; across sixty arms no
  run recovered any of the four candidate facts. Whatever separates a correct
  repair from an incorrect one in M183, it is not evidence supply.

- **Three cases show the evidence was never the constraint.** In
  `django__django-13195` both arms read `set_cookie(..., samesite=None)` twenty
  lines above their edit and both wrote `samesite='Lax'`, producing byte-identical
  patches. In `sympy__sympy-13974` the treatment had `tensor_product_simp_Mul`'s
  own TODO on screen three times and the baseline never did — and the arm with the
  extra evidence added an `is_Integer` guard that made its patch strictly worse.
  In `psf__requests-5414` the *winning* arm explicitly considered the losing arm's
  exact patch and rejected it because it "might have performance implications".

- **The one real authority-versus-projection gap is in seaborn, and it is a
  localization gap.** `seaborn/utils.py::locator_to_legend_entries` is indexed, sits
  in the **same file as the delivered focus**, carries an incoming call edge and a
  test caller, and comes back as a *pivot* for three queries derivable from the
  issue text — while the delivered default packet spent its same-file slot on
  `seaborn/utils.py::__all__`, annotated "no indexed relationship to it". With
  `sphinx-doc__sphinx-7462` (a second `unparse` in `sphinx/pycode/ast.py` carrying
  the identical defect) that is a `MISSING_PARALLEL_IMPLEMENTATION_SITE` mechanism
  at 2 tasks / 2 repositories — below the 3-task threshold, with no success witness,
  and it is a *second edit site*, which is the localization hypothesis M183 already
  measured at zero. Recorded; not licensed.

- **Presence in the authority is not selectability.** For `psf__requests-5414` the
  decisive test is reverse-reachable from the focus at hop 4 — by which point the
  frontier is 92 symbols — and no shipped tool or issue-derived query returns it
  (`impact-graph --depth 3` misses it; three capsule phrasings miss it). An
  intervention that emits everything four hops out is the "send all callers, all
  tests, all paths" failure mode the audit was told to rule out in advance.

- **`focusIsGoldFile` overstates localization.** `mwaskom__seaborn-3187` counts as a
  correct focus because `seaborn/utils.py` is a gold file — but the focused symbol
  was `move_legend` (relocating a legend) while the task needed
  `locator_to_legend_entries` in the same file. The metric credited a lexical
  coincidence on the word "legend". Quote M183's 2/30 gold-symbol rate beside the
  19/30 file rate, always.

- **Correct focus is neither necessary nor sufficient.** Six tasks were solved
  without one — three with the packet **entirely ignored** — and
  `pytest-dev__pytest-6197` was solved by editing `src/_pytest/main.py`, outside the
  reference patch's file set. Six tasks were lost with one.

- **M183's harness could not run the repositories' own tests, and this blocks a
  whole class of future experiment.** Only **5 of 60** arms executed a test suite;
  14 tried and 9 attempts were refused by the environment (`No module named
  pytest`, `pip: command not found`). Validation behaviour in M183 is a property of
  the harness, not an agent choice, so no validation-stage intervention is
  evaluable on it. Fix this before designing any successor experiment. Related trap:
  `exitCode` is `null` for all 335 captured Bash calls, so any "did it succeed"
  metric keyed on it silently reports zero — the same family as M164's
  truncated-output classifier failing open.

- **The M184 "506 failures" count is not reproducible as parse failures.** Indexing
  `django/django` at base commit `156a2138` (2,687 files, same product HEAD) gives
  `totalParseFailures 0`, `filesFailed 0`, and 35 JavaScript files correctly
  reported as `unregistered_language`/`skipped`. Recorded as
  `INDEX_CLI_FAILURE_COUNT_SEMANTICS_STALE_OR_MISLEADING`; not fixed, and not
  expanded into parser work. What matters for this audit is verified directly:
  every candidate-evidence symbol it depended on was present in the offline index.

- **Next-step recommendation: stop this thesis, and change something structural
  before spending again.** `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED`. Two
  measurements now point the same way — M183 found no effect from supplying the
  right place, M185 finds no repeated fact whose absence explains the failures. Do
  not enlarge the packet, retune ranking, add graph hops, or build a new analyzer
  on the strength of the seaborn observation. If a milestone follows, it should
  change the thesis rather than the retrieval: a different task distribution, a
  working test environment so validation is measurable at all, or a product that
  reasons about candidate repairs rather than supplying facts — which is a
  different kind of system and needs its own authorization.

## M186 — Materialized Index Lifecycle Correctness

```text
overall           PASS (case B: current HEAD already contained the repair)
defect probe      DEFECT_NOT_PRESENT_ON_CURRENT_HEAD
repaired by       7b10dcd0 (M184); probe validated as known-positive at 7b10dcd0~1 (142ad112)
invariant         NOOP_ELIGIBLE = SOURCE_STATE_EQUIVALENT && MATERIALIZATION_READY
state matrix      9 rows x 2 arms   false-healthy no-ops: HEAD 0/9, pre-M184 5/9
discriminating    R2 R3 R5a R5b R7  (the four already-correct controls R1 R4 R6 R8 agree)
runtime proof     REMATERIALIZED_INDEX_CONSUMABLE  (impact, capsule, skeleton, run-pipeline, status)
no-change proof   HEALTHY_SEMANTICS_UNCHANGED  (files/symbols/edges/manifest identical)
residual field    productContext.repository.indexMode full_rebuild -> incremental (truthful provenance)
performance       healthy no-op 162-168ms vs pre-M184 159-169ms; recovery 189ms vs 1134ms cold rebuild
product changed   NO      retrieval NO   ranking NO   index format NO
tests             +3 lifecycle regressions (14 -> 17), all known-positive detectors
gates             typecheck PASS  typecheck:benchmarks PASS  bun test 5595/0 fail  diff --check clean
live              NOT RUN  spend $0.00   docker NOT RUN
evidence commits  beecc7074803d05a836c7befaa9bfecfa1d92eb8
```

```text
M183 sequence, measured on both arms          pre-M184 (142ad112)   HEAD (e9c98c49)
  exit code                                     0                     0
  refresh mode                                  noop                  incremental
  fallback reason                               none                  materialization_missing
  manifest entries claiming indexOutcome        20                    20
  database files / symbols / edges              0 / 0 / 0             20 / 50 / 21
  impact-graph on an indexed symbol             unknown_symbol        resolved
  capsule                                       "Repo not indexed"    pivot delivered
```

## M186 standing findings

- **The invariant holds on the CLI path, and the probe that proves it can fail.**
  `evaluateMaterializedGraph` is consulted for every planned no-op in
  `indexProject` (`src/indexer/indexProject.ts:179`), not only when a caller
  passes `hasExistingGraph`. That is the whole difference: the pre-M184 guard was
  correct and unreachable from `vtrace index`, which is why `vtrace init` was safe
  in a fresh worktree while `vtrace index` was not. Any future audit of this
  invariant should re-run the matrix against `7b10dcd0~1` rather than trusting a
  green suite — five rows only discriminate because the control reproduces them.

- **Source-state equivalence has two producers, not one.** The registry under
  `<gitCommonDir>/vtrace/repositories/<id>/snapshots` is consulted *only* when
  `.vtrace/index.meta.json` is absent (`reindexRepo.ts`, `localSnapshot ??
  reusable?.snapshot`). Deleting `.vtrace` wholesale and deleting only
  `index.sqlite` therefore reach the no-op through different authorities — R2 and
  R3 in the matrix — and a repair covering only the registry path would leave the
  manifest path defective. Both are now covered end-to-end.

- **Manifest truthfulness needed its own assertion.** Every pre-existing lifecycle
  test asserts `mode !== "noop"` and compares graph shape, which catches the
  planner defect but not the user-visible lie: the M183 specimen reported
  `status: indexed` over 20 files whose manifest entries all said
  `indexOutcome: "indexed"` while the database held nothing. The manifest and the
  graph are written by the same transaction, and the no-op path returns the
  manifest *without entering* it — so the added regression binds reported success
  to a graph row per claimed file, whichever mode produced it.

- **Readiness is not `symbolCount > 0`, and the matrix confirms the cost of that
  choice is nil.** The predicate compares the snapshot's indexed subset against the
  `files` table by path and content hash, so a repository with no parsable symbols
  matches an empty graph and stays a legitimate no-op, while a graph attached to a
  different source state (R7) is caught for free — pre-M184 that state produced a
  no-op over a stale graph that was *usable*, and therefore invisible to any
  liveness-based check.

- **The repair is not paid for with rebuilds.** Steady-state healthy no-ops are
  162-168ms on HEAD against 159-169ms pre-M184; the added read is cheaper than the
  `listAllSymbols`/`listAllEdges` that branch already performed. Recovery is a
  re-materialization served from the durable parse cache (189ms, 20 hits, 0
  reparses) rather than a reparse (1134ms cold). A future change that makes the
  healthy path measurably slower, or that recovers by forcing `full_rebuild`, is
  regressing this milestone even if the matrix still passes.

- **Next-step recommendation: none licensed from here.** M186 is lifecycle
  correctness only and closes on the invariant. M185's
  `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED` is unaffected — a working index
  lifecycle was never the thing M183 measured, so this repair is not evidence that
  rerunning it would land differently. Phase 1B, if it happens, is a separate
  milestone with its own authorization.

## M187 — Benchmark Validation Environment Truthfulness and Executability

```text
overall           PASS (Phase 1B benchmark infrastructure only; no product/retrieval work)
M185 reproduction M185_CLASSIFICATION_REPRODUCED   60 arms / 14 attempting / 5 executing / 9 prevented
                  51 attempts, 36 env refusals — and 6 attempts M185 counted but never named
exitCode = null   NOT a parser defect. tool_result carries {tool_use_id,type,content,is_error}
                  and nothing else; MCP 2024-11-05 has no exit-status field. Recovered from the
                  shell tool's own `Exit code N` first line: 144/335 non-zero, 190/335 exit 0,
                  1/335 tool-policy refusal. Bijective with is_error across all 335.
pipeline caveat   190 calls report success=true while the command failed — `cmd | head` returns
                  head's status. readExitStatus returns known:false for a piped success.
root cause        ONE seam. runCondition materialized the M90A firewall into rawConditionDir and
                  passed that same dir to the external harness as --output; the harness opens
                  every run with cleanPreviousRun(outputDir) which rmSyncs it.
                  All 60 arms logged `Cleaned 1 file(s)` — 30 baseline, 30 treatment.
consequence       PATH sanitization survived (env var), wrappers did not (files). Agent got
                  /usr/bin/python 3.14 with no packages; pip existed only in the stripped conda
                  prefix -> 28x exit 127. Firewall fired 0 times in 60 arms; guard still said pass,
                  because readiness is checked pre-spawn and the wipe happens after.
taxonomy (23 prevented attempts across the 9 arms)
                  DEPENDENCY_ENVIRONMENT_UNAVAILABLE 10   TEST_RUNNER_UNAVAILABLE 6
                  COMMAND_OR_TARGET_MISSING 4            undetermined 3
                  ownership: 10 benchmark-owned, 13 uncertain, 0 external-tool-only
repair            agentShellGuardDir() — guard materializes OUTSIDE the harness output dir;
                  post-run wrapper-bin liveness observed; a vanished firewall degrades the
                  recorded status instead of reporting pass
                  stage5_agent_shell_guard_wrapper_bin_survived_run: boolean | null
reclassification  arm states 46 NOT_ATTEMPTED / 9 ATTEMPTED_NOT_STARTED / 3 STARTED_PASSED /
                  1 STARTED_FAILED / 1 STARTED_INFRA_FAILURE / 0 UNKNOWN
                  attempts (47) 34 not-started / 7 passed / 1 failed / 1 infra / 4 unknown
                  arm partition UNCHANGED from M185 (46/9/5); 3 movers, all attempt-count only
                  4 M185 false positives dropped (a heredoc WRITING a test file, a pip install
                  whose cwd was .../pytest-dev__pytest, 2 import probes — \bpytest\b matched the
                  repository PATH); 1 missed attempt recovered (python src/pytest.py)
agreement control 47/47 PASS — every STARTED_* has a runner literal on screen, every
                  ATTEMPTED_NOT_STARTED has none
probes            11/11 agree across 4 independent repos (seaborn, requests, sympy, django),
                  no agent spawned, $0.00. G1: django-13820's own M183 command replayed on the
                  repaired path -> `Ran 27 tests ... OK`. Z1 CONTROL: the M183 layout, wiped by
                  the same cleaner -> ATTEMPTED_NOT_STARTED. E1: firewall blocks again.
                  D2 preregistered expectation REVISED post-run and recorded as revised.
symmetry          VALIDATION_CAPABILITY_EQUIVALENT  30/30 pairs, 0 asymmetric,
                  0 unexpected treatment-only env keys; treatment witness cited so equivalence
                  is not misread as identity
product changed   NO   retrieval NO   ranking NO   orientation NO   prompts NO   index format NO
src/ touched      src/capsule/toolOutputCapture.ts ONLY (owner of the exitCode field; an island
                  unreachable from src/mcp, src/retrieval, src/capsuleV2, src/indexer)
tests             +31 validationExecution, +6 m187ShellGuardSurvival (control must destroy the
                  old layout, and does)
gates             typecheck PASS  typecheck:benchmarks PASS  bun test 5632/0 fail  diff --check clean
live              NOT RUN  spend $0.00  docker NOT RUN
functional commit c9a477de85820678d7e2411488dec10944c72542
```

## M187 standing findings

- **The guard destroyed its own foundation, and its verification could not see it.**
  `evaluateMandatoryAgentShellGuard` consults `wrapperBinReady` before spawn — the one
  moment it is necessarily true — and the external harness deletes the wrapper bin after
  that check and before the agent's first turn. Sixty arms recorded
  `stage5_agent_shell_guard_status: "pass"` for a firewall that was physically absent, and
  the corroborating evidence was sitting in the same directory the whole time:
  `stage5_blocked_host_package_command_count: 0` across every arm of a benchmark whose agents
  attempted `pip install` twenty-eight times. Any future guard whose readiness is established
  before an external process runs needs a liveness observation after it, not a stronger
  pre-check.

- **PATH sanitization and its compensating wrappers have different lifetimes.** The env
  override is a string that survives anything; the wrappers are files that survive only as
  long as their directory. A guard built from both halves degrades asymmetrically — it keeps
  the half that takes capability away and loses the half that gives it back. M183 paid the
  guard's entire cost and received none of its protection. This is worth stating as a shape,
  not an incident: any protection implemented as "remove the dangerous thing from PATH, add a
  safe replacement" fails open on cost and closed on benefit when the replacement goes missing.

- **`exitCode: null` was a true statement, and that is exactly why it was dangerous.**
  Nothing was parsed wrongly: the transport has no exit-status field. The defect was
  downstream, in M185's first detector reading `exitCode === 0` as meaningful, and the field
  was honest enough to be trusted. A field that is *always* null is indistinguishable from a
  field that is *legitimately* null, so `exitCodeSource` now records which surface answered.
  The corollary matters more: even the recovered exit code is untrustworthy alone, because
  190 of 335 calls report success from a pipeline's last stage rather than the command under
  test.

- **Attempt detection is where a validation audit quietly goes wrong.** M185's `\bpytest\b`
  matched the repository *path* — every command run inside `.bench-repos/pytest-dev__pytest`
  looked like a test attempt, including a `pip install` and a heredoc that *wrote* a test
  file. Four of its 51 attempts were not attempts. The correction is small and the arm-level
  partition survives it, but the general point does not: whether an agent tried is a property
  of the command alone, and it must be decided by a parser that knows what a runner is, not by
  a substring that appears in a directory name.

- **The nine refusals are one mechanism, and the taxonomy is still worth keeping split.**
  All 23 prevented attempts descend from the same PATH collapse, so a single repair addresses
  them. But 10 are benchmark-owned outright and 13 remain uncertain, because the residue —
  per-task dependency provisioning — is genuinely a different problem with a different owner.
  The G1/G2 probe pair measures exactly where the line falls: django's own M183 command runs
  27 tests on the repaired path, and the same command without `PYTHONPATH` still does not,
  because that part was always the agent's job.

- **M183 stays a valid comparison and stops being a valid description.** Both arms were
  deprived identically — 30/30 symmetric, same driver, same flag array, same wipe — so the
  paired result is unaffected and M185's conclusion is untouched. What it cannot be called is
  a measurement of an edit→test→revise loop: in 55 of 60 arms no test runner ever started, and
  in 9 of those the agent tried and was prevented. M185's finding that winning runs read less
  should be read against that, not as evidence that validation does not matter.

- **Next-step recommendation: none licensed from here.** M187 closes Phase 1 correctness and
  authorizes no Phase 2 implementation. `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED`
  stands. A repaired validation environment is not a reason to rerun M183 — the repair makes a
  future experiment interpretable, it does not make the previous one wrong. The open
  infrastructure work, if it is ever taken up, is per-task dependency environments (the
  SWE-bench Docker images already exist for this) and the editable installs of benchmark
  repositories accumulating in the external harness's shared `.venv`, which is outside this
  repository's tree.
