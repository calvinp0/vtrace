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
| M131 | (this commit) | PASS | flow scalability + product-path hardening: remove the architectural conditions that made M130's failures possible, rather than only their symptoms | **traversal**: `searchLogicFlow` no longer materialises the graph. New `src/graph/frontierTraversal.ts` expands one frontier level per batched indexed adjacency query (`listOutgoing/IncomingEdgesForSymbols`, chunked 500), hydrating symbols in batches; `maxEdges` is one budget shared across both directions. ARC one-edge flow 82.851 ms → **6.606 ms** (12.5x), **4 of 18,862 edges fetched**, 3 DB queries, 2 frontier batches. Synthetic 2k/20k/100k: edges fetched 2/2/2, DB queries 2/2/2 — explored work flat across 50x graph growth. Order-invariant across 5 insertion orders; budget exhaustion reports `traversal_limit_reached`; genuine no-path reports `no_indexed_path_found` with `budgetExhausted: false`. **provenance**: additive `edge_call_sites` table records every parser-observed occurrence; ARC hop now reports `edge_site` at exactly `engine.py:1724` (`precision: span`) instead of a body scan. Multiple call sites are enumerated with a labelled representative; an index without recorded sites degrades to `caller_span_scan` and never claims `edge_site`. **types**: `@ts-nocheck` removed from `searchLogicFlow.ts` (2 errors, both union narrowing); budget precedence extracted to typed `src/mcp/productResponseOptions.ts`. **envelope**: scale tests across items/source/diagnostics/flow hops/impact/documents found two real gaps M130's single fixture hid (unbounded `productContext.items` metadata; per-hop flow excerpt text) — four new ladder tiers + a compact-accounting fallback; ARC incident 26,587 chars / 6,647 tokens (was 27,726 / 6,932). Frozen 50 identical (0/50, hash `99eab9ab635b15c2`); retrieval evals byte-identical (stash A/B); TCKDB lead + M130-code parity preserved; 3778 tests / 0 fail | M132: workspace and repository identity foundation, inheriting the constraint that workspace operations must not load unrelated repository graphs and must obey the complete-response envelope after aggregation |

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
