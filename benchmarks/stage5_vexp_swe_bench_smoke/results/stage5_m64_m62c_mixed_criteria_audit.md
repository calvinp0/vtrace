# Stage 5 M64 M62C Mixed-Criteria Audit

Offline audit of the M62C MIXED verdict. No live agents, no Docker, no API spend, no retrieval/scoring/ranking changes. All numbers recomputed from the committed M62C JSON and the captured per-target analyzer artifact (`/tmp/m62c_analysis.json`, the un-stripped source the committed JSON was derived from); selector behavior read from `src/capsuleV2/digestDecisionContract.ts`.

## Summary

- **M62C status:** 24/24 valid treatment runs, 0 fail-closed, all 3 recovered over-budget cases valid + resolved; resolution 15 = 15 vs baseline; pooled cost −27.8%. Verdict **MIXED**.
- **Which criteria failed:** c3 (required-target ignored ≤5%) at **5.6%**, and c4 (decision coverage ≥90%) at **88.7%**. The other four criteria passed.
- **Main driver cases:** django-11740 (3 ignored targets), astropy-14539 (2 invalid rule-outs), flask-5014 (1 invalid), sympy-12481 (1 ignored), sympy-12419 (1 inspected-only), all of which **resolved**.
- **Primary diagnosis:** **A — the required-target selector force-required non-actionable impact representatives** (test files and callers/wrappers). 4 of the 8 problem targets are required impact reps that should not have been closure-scored; 3 are a retrieval mislocalization (django-11740); 1 is a minor classifier-strictness nuance. The misses are **deterministic** (the selector always force-requires the first cross-file impact rep), so they are not variance and a no-code repeat would reproduce them. The decisive invariant: **impact representatives were edited 0 times across all 24 runs.**
- **Recommendation:** **A — implement a narrow general required-target demotion rule** (demote impact representatives from required to optional/FYI; never force-require test files or non-dependent callers; keep lead + hidden pivot required). It is the only candidate that clears both failed criteria, is backed by the impact-edited=0/24 invariant plus 4 independent cases, harms no treatment-only win, and cannot increase over-edit risk. Do **not** implement in this milestone.

## Metric Recheck

Recomputed independently from `stage5_m62c_structured_bounded_24_live_validation.json` (cases array), not the prose:

| metric | recomputed | report | match |
|---|---|---|---|
| valid treatment runs | 24/24 | 24/24 | ✅ |
| resolution treatment vs baseline | 15 vs 15 (Δ0) | 15 vs 15 | ✅ |
| paired (bp/bf/t-only/b-only) | 14 / 8 / 1 / 1 | 14 / 8 / 1 / 1 | ✅ |
| pooled token delta | −31.5% | −31.5% | ✅ |
| pooled cache-read delta | −33.1% | −33.1% | ✅ |
| pooled cost delta | −27.8% | −27.8% | ✅ |
| mean tool-call delta | −3.8 | −3.8 | ✅ |
| decision coverage | 63/71 = 88.7% | 88.7% | ✅ |
| ignored rate | 4/71 = 5.6% | 5.6% | ✅ |
| invalid rule-out rate | 3/71 = 4.2% | 4.2% | ✅ |
| off-target edit total | 8 | 8 | ✅ |

**No discrepancy.** The M62C report is internally consistent. Required-target accounting reconciles exactly: 71 total = 63 closed + 8 open; open(8) = ignored(4) + invalid(3) + 1 inspected-only.

**Decisive invariant (new):** across all 24 runs, **required impact representatives were EDITED 0 times** (24 edited decisions, all PIVOT targets). Impact reps closed as RULED_OUT (6), INSPECT_ONLY_NO_EDIT (13), IGNORED (2), INVALID_RULE_OUT (3). Requiring an impact representative therefore added **zero** resolution value on this set while producing 5 of the 8 problem targets. Separately, 6 of the 15 resolved cases edited **no** required target at all (agent oriented from the digest, patched elsewhere — e.g. django-10880 → `aggregates.py`, matplotlib-22719 → `category.py`).

## Structured-Decision Failure Table

All 8 open/ignored/invalid targets. Every one is in a **resolved** case.

| instance | cat | resolved | target | type | status | edited (actual) | gold/action relevance | diagnosis |
|---|---|---|---|---|---|---|---|---|
| django-11740 | E | ✅ | gis/gdal/feature.py::Feature | PIVOT (lead) | IGNORED | db/migrations/autodetector.py | not gold-related; wrong subsystem (GIS vs migrations) | retrieval mislocalization → acceptable_resolution_elsewhere |
| django-11740 | E | ✅ | gis/gdal/feature.py::Feature.fid | PIVOT | IGNORED | (same) | not gold-related | retrieval mislocalization |
| django-11740 | E | ✅ | gis/gdal/layer.py::Layer | IMPACT | IGNORED | (same) | not gold-related | retrieval mislocalization |
| astropy-14539 | B | ✅ | io/fits/convenience.py::printdiff | IMPACT | INVALID_RULE_OUT | io/fits/diff.py | caller/wrapper of the pivot; thin rule-out reason | selector_issue (non-actionable impact) + minor classifier strictness |
| astropy-14539 | B | ✅ | io/fits/tests/test_core.py::test_fits_file_bytes_object | IMPACT (**test file**) | INVALID_RULE_OUT | io/fits/diff.py | a **test**, not a patch site | selector_issue (test-file impact) |
| flask-5014 | D | ✅ | tests/test_async.py::_async_app | IMPACT (**test file**) | INVALID_RULE_OUT | src/flask/blueprints.py | a **test**, not a patch site | selector_issue (test-file impact) |
| sympy-12481 | C | ✅ | combinatorics/generators.py::alternating | IMPACT | IGNORED | combinatorics/permutations.py | helper/generator; not needed for fix | selector_issue (non-actionable impact) |
| sympy-12419 | B | ✅ | piecewise.py::Piecewise._sort_expr_cond | PIVOT | INSPECTED_ONLY | matrices/expressions/matexpr.py | inspected; agent gave a non-bounded keyword | classifier_issue (minor) |

Conservative labels: no target is marked "wrong" merely because the agent did not edit it. `selector_issue` is used only where the target is a test file or a non-co-edit caller/helper that the impact-edited=0 invariant shows is never an actual edit site.

**By diagnosis:** selector_issue (impact) **4** · retrieval mislocalization (django-11740) **3** · classifier strictness **1**. Not a single case is `agent_ignore` of a *good* target or a `real_treatment_gap`.

## django-11740 Deep Dive

- **Required targets (3):** `gis/gdal/feature.py::Feature` (lead pivot), `gis/gdal/feature.py::Feature.fid` (pivot), `gis/gdal/layer.py::Layer` (impact). All three are in Django's **GIS/GDAL** subsystem.
- **Actual edit:** `django/db/migrations/autodetector.py` — Django's **migrations** subsystem, an entirely different area.
- **Why it resolved:** the issue is a migrations-autodetector bug; the agent localized and fixed it directly and resolved. The baseline also resolved (both_pass).
- **Were the required targets related to the fix?** No. The lead pivot itself is mislocalized — this is a **retrieval/localization miss**, not a target-type mistake. The agent **correctly ignored** the three surfaced GIS targets.
- **Selector diagnosis:** no required-target *selection* rule fixes this, because the whole pivot set (lead + pivot + impact) is in the wrong subsystem. The fix would have to come from retrieval/ranking, which is **out of scope** for this milestone and explicitly off-limits. The contract here did the right thing operationally (the agent ignored the noise and resolved) but the *scoring* counts three ignored required targets against a successful run.
- **Generalizable rule candidate or no-rule conclusion:** **no target-type rule.** Demoting impact reps (see Candidate Rules) removes 1 of django-11740's 3 problem targets (the `layer` impact); the 2 mislocalized pivots remain, but under that rule the ignored rate still lands at 4.3% (≤5%) because the denominator no longer carries the unused impact reps. Do **not** tune for django-11740; treat it as a retrieval-localization data point.

## sphinx-7462 Deep Dive

- **Required targets:** the sphinx-7462 contract surfaced `domains/python.py` pivots; the case is a **known multi-gold** task whose gold spans `domains/python.py` **and** `pycode/ast.py` (a python.py-only patch can never resolve — recorded prior knowledge).
- **Invalid/open decision:** sphinx-7462 had **no** open/ignored/invalid required target in M62C (it is not in the failure table). Its relevance here is **resolution**, not structured-decision: it was resolved in M60B/M60C/M62 but **not** in M62C (patch was python.py-only).
- **Classifier/selector diagnosis:** not a classifier or selector defect. The required targets were closed; the case simply produced a single-file patch that does not satisfy the two-file gold. This is the known multi-gold fragility, consistent with a python.py-only patch being the modal failure mode.
- **Why not relaxing the classifier:** the M62C invalid rule-outs (astropy, flask) were on *other* cases and were thin-reason test/wrapper rule-outs; the contract already accepts a one-line behavioral reason ("wrapper only; no independent logic to patch"). Relaxing the classifier to credit bare "not needed" rule-outs would let genuinely unjustified rule-outs pass and is **unsafe**. The fix is to stop *requiring* test/wrapper impact reps, not to weaken the reason check.
- **Why not sphinx-tuning:** sphinx-7462's miss is a multi-gold coverage gap in the *patch*, unrelated to target selection; no sphinx-specific change is warranted.

## Required-Target Selector Findings

From `src/capsuleV2/digestDecisionContract.ts` (`selectBoundedDigestDecisionTargets`, the M58 path used by the M62C `--bounded-digest-decisions` treatment):

- **Lead pivot:** `pivots[0]` — always required (PIVOT).
- **Hidden/non-traceback co-pivot:** first later pivot with `pivotIsHidden(roleReason)` — required if distinct (PIVOT).
- **Impact representatives (the weak spot):** the **first** cross-file `impact.representative` is promoted to **required unconditionally** (`requiredImpact === 0`), with **no actionability, role, or test-file filter**. A **second** impact rep is required only when `role === "dependent"`; further reps fall to `optional` (`requiredReason: "optional context only"`, max 2).
- **Optional demotion:** only applies *after* the first impact rep is already force-required; the first rep can never be demoted.
- **Cap:** `MAX_DIGEST_DECISION_TARGETS` (= lead + hidden + 2 impact); enforced by length checks.
- **target_id stabilization:** `target_id` rendered as `T1..Tn` in order; identity de-duped via `seenIdentity`/`seenPath` on `path::symbol`.

**Observed weakness:** the unconditional promotion of the first cross-file impact representative is the direct source of all 4 selector-issue problem targets. It promoted a **test file** (`tests/test_core.py`, `tests/test_async.py`) and a **convenience wrapper** (`printdiff`) to "cross-file co-edit candidate" required status, even though the impact-edited=0/24 invariant shows impact reps are never the patch site. The role gate that already exists for the *second* impact rep (`role === "dependent"`, "never a mere caller/importer/reference") is simply **not applied to the first** — and even that gate does not exclude test files.

## Candidate Rule Evaluation

Simulated by recomputing coverage/ignored over the 24-case per-target set with the demoted targets removed from the **required** set (they remain visible as optional/FYI context). Baseline: required 71, coverage 88.7%, ignored 5.6%, invalid 4.2% — **both criteria fail**.

| rule | required | coverage | ignored | invalid | fixes c3+c4? | risk to t-only wins | over-edit risk | recommendation |
|---|---|---|---|---|---|---|---|---|
| **A. demote test-file impact reps** | 63 | 90.5% ✅ | **6.3% ❌** | 1.6% | **No** (c3 still fails) | none (matplotlib-24627 impact was a test, INSPECT_ONLY) | none | insufficient alone — shrinks denominator, django pivot-ignores push the rate up |
| **B. demote caller/wrapper impact reps** | ~64–66 | ~90–91% | ~5–6% | ~1% | partial / role-data dependent | none | none | helps but not robust; subset of D |
| **C. stronger evidence before requiring an impact rep** | ~ | ~ | ~ | ~ | partial | none | none | vague; effectively B |
| **D. impact reps optional by default (keep lead+hidden pivot required)** | 47 | **93.6% ✅** | **4.3% ✅** | 0.0% ✅ | **Yes** | **none** (impact edited 0/24; matplotlib-24627 win unaffected) | **reduces** | **recommended** — only rule that clears both |
| **E. keep all rules; treat as variance** | 71 | 88.7% ❌ | 5.6% ❌ | 4.2% | No | — | — | rejected — misses are deterministic, not variance |
| **F. separate FYI bucket, never closure-scored** | 47 | 93.6% ✅ | 4.3% ✅ | 0.0% ✅ | **Yes** | none | reduces | equivalent to D, safer framing (keeps reps visible as context) |

- **Would it close django-11740?** Partially — D/F removes the `layer` impact target; the 2 mislocalized pivots remain but the ignored rate still passes (4.3%). No rule should chase the 2 pivots (retrieval issue).
- **Would it affect sphinx-7462?** No — sphinx-7462 had no problem target; its miss is multi-gold resolution, untouched by selection rules.
- **Would it remove useful targets from treatment-only wins?** No — the lone treatment-only win (matplotlib-24627, stable T,T,T,T) edited `_base.py`+`figure.py` and left all 3 required targets INSPECT_ONLY; its impact rep was a test file. Impact reps were edited 0/24 overall.
- **Would it risk over-editing?** No — it removes required-edit pressure (the same pressure the M58 comment blames for the M57B over-anchor blow-up); it can only reduce over-edit.
- **Would it change M60C/M62C success criteria?** It can only raise coverage / lower ignored (fewer non-actionable required targets); resolution is unaffected (impact never edited).

## Live Variance / Stability

Resolution history for the cases that moved between runs (T = resolved, F = not):

| instance | M60B | M60C | M62 | M62C | classification |
|---|---|---|---|---|---|
| matplotlib-24627 (t-only win) | T | T | T | T | **stable treatment win** |
| django-11740 | – | – | T | T | stable (but targets mislocalized) |
| requests-5414 | F | F | T | F | **regression-to-mode** — M62 T was the outlier; F is modal (baseline-only "loss" is not a real loss) |
| sphinx-7462 | T | T | T | F | known multi-gold fragility (python.py-only patch ⇒ expected F) |
| seaborn-3187 | T | T | T | F | **stable-win flip, mechanism unclear** — the one genuinely concerning flip |
| astropy-14369 | – | – | T | F | insufficient history (2 runs) |

- **Evidence for variance:** of the 4 M62→M62C resolution flips, requests-5414 is regression-to-mode (M62 was the lucky outlier across F,F,T,F) and sphinx-7462 is known multi-gold fragility. These two are **not** real losses.
- **Evidence against pure variance:** seaborn-3187 (T,T,T,F) is a 3-run-stable win that flipped under post-M63 code; astropy-14369 (T→F) has too little history. These are the residual watch items — at most ~1–2 genuinely uncertain flips, not 4.
- **Implications for another live round:** the *resolution* dip (shared 16→12) is largely explained as variance/known-fragility, with seaborn-3187 the one item worth confirming. Crucially, the **failed criteria (c3/c4) are deterministic**, not variance — a bare no-code repeat would reproduce them. So a repeat alone cannot resolve the MIXED verdict; the selector rule is the lever, and the next live round should validate the rule **and** re-check seaborn-3187 stability.

## Recommendation

**A — implement a narrow general required-target demotion rule.**

Specifically (to be implemented in a *follow-up* milestone, not here): in `selectBoundedDigestDecisionTargets`, stop force-requiring the first cross-file impact representative — demote impact representatives to **optional/FYI context** (option D/F), keeping them visible for orientation but **not closure-scored**; never promote a test file or a non-`dependent` caller to required. Keep the lead pivot and hidden/non-traceback co-pivot required.

Why A and not B/C/D/E:
- **Fixes the failed criteria deterministically:** coverage 88.7% → 93.6%, ignored 5.6% → 4.3%, invalid 4.2% → 0.0% — both c3 and c4 pass. It is the *only* simulated rule that clears both (Rule A alone leaves c3 failing at 6.3%).
- **Supported by more than one case and a clear invariant:** impact reps edited **0/24**; 4 independent cases (astropy-14539, flask-5014, sympy-12481, plus matplotlib-24627 showing impact reps are never load-bearing even in a win).
- **No harm to treatment-only wins** and **reduces** over-edit risk (the M58 over-anchor pressure).
- **Stays in scope:** it changes required-vs-optional *selection/scoring* of already-retrieved targets, not retrieval/ranking/candidate generation.

This is **not** a recommendation to make the treatment a default or to start 100-task planning: the c3/c4 misses are explained but a product change plus a confirmation round is the responsible sequence. The next live round (after the rule lands) should re-measure c3/c4 and confirm seaborn-3187's resolution stability. django-11740 should be left alone as a retrieval-localization data point, and the classifier's reason-strictness should **not** be relaxed.

## Non-Claims

- Does not claim VTRACE beats VEXP or improves SWE-bench pass@1.
- Does not make a statistical superiority claim.
- Does not implement any code change; this is an offline audit only.
- The rule simulations are recomputations over the frozen 24-case M62C artifacts, not new runs.
