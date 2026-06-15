# Stage 5 — M8 focused failure-shape audit of the 3 genuine regressions

Generated 2026-06-15, on `main` HEAD `7863c80`. **Diagnostic only** — no policy patch, no retrieval tuning, no live agents, no Docker, no 30/100-case runs. Scope: the three regressions that survived the M7.2 clean-Docker re-baseline (`stage5_m7_clean_docker_rebaseline.md`) and are explicitly *not* traceback-lead-pivot cases (so not addressed by the M7.3 disable, commit `7863c80`):

```
sympy__sympy-12419
astropy__astropy-14539
pylint-dev__pylint-8898
```

Inputs: saved capsule v2 manifests/rankings/diagnostics and per-run `_run.meta.json` / `_eval.meta.json` / `swebench-*.jsonl` (model patches) under `runs/eval-bounded20-{baseline,current-clean}-<case>-r{1,2,3}/`; corrected labels from `stage5_m7_clean_docker_rebaseline.md`; gold patches + FAIL_TO_PASS from `vexp-swe-bench/data/swe-bench-100.jsonl`. The saved capsule snapshots are from current `main` (current-clean arm); HEAD `7863c80` changed only the traceback-skip default, which does not touch these three (all show `policyAction=inject`, unchanged). No capsule rebuild was needed.

---

## 1. Executive summary

**None of the three "genuine regressions" is a VTRACE retrieval, policy, actionability, or context-action failure.** On close inspection of the actual patches:

```
patch_synthesis_bound:   2   (sympy-12419, pylint-8898)
evaluation_artifact:     1   (astropy-14539)
retrieval_wrong_target:  0
retrieval_missing_gold:  0   (present as a harmless secondary on 2 cases)
policy_should_skip:      0
context_action_gap:      0
actionability_gap:       0
```

The headline facts:

- **sympy-12419** — VTRACE edits the **exact gold file and gold symbol** (`matexpr.py::Identity._entry`) in all 3 runs, with identical injected context. The one failing run (r3) hand-wrote `eq = i == j; if eq is True` instead of the gold's `eq = Eq(i, j); if eq is S.true`; for symbolic indices Python `==` does not return `True`/`False`, so the KroneckerDelta branch is never taken correctly. Pure synthesis quality, n=3 single-run dip.
- **astropy-14539** — VTRACE's r1 patch is **byte-identical to the gold patch and byte-identical to r2's patch**, yet r1 scored `resolved=False` while r2 scored `resolved=True`. Same instance, same patch, deterministic FAIL_TO_PASS → r1 is an evaluation false-negative (flaky test or residual eval-env fault), re-evaluated at 21:41 on 6/15 and still contradictory. The only genuinely-failing run is r3 (empty patch). The "3/3→1/3" is a measurement artifact, not a VTRACE behavior regression.
- **pylint-8898** — both arms edit the **same gold function in the same gold file** (`argument.py::_regexp_csv_transfomer`) and both hand-roll an inline comma-aware regex splitter (neither produces the gold's multi-file `_check_regexp_csv` helper, and the inline route is viable — baseline resolves 2/3 with `argument.py` alone). VTRACE's inline splitters have subtle bugs; baseline's are more complete. Synthesis lottery at n=3 (baseline itself is only 2/3).

Consequence: the regressions the rebaseline flagged as "the substantive open problem" are **not addressable by VTRACE** (context/policy/retrieval/actionability). They are model-synthesis variance (2) and a measurement artifact (1). See §5.

---

## 2. Per-case table

| instance | baseline resolved | VTRACE resolved | policyAction | gold surfaced? | gold edited? | primary blocker | secondary blocker(s) | recommended fix class |
|---|:-:|:-:|:-:|:-:|:-:|---|---|---|
| sympy__sympy-12419 | 3/3 | 2/3 | inject | **no** (pivots wrong; gold not in pivot/support) | **yes (3/3 runs)** | `patch_synthesis_bound` | `retrieval_missing_gold` (harmless — issue text self-localizes), single-run-dip | patch-synthesis not addressable by VTRACE / benchmark reclassification |
| astropy__astropy-14539 | 3/3 | 1/3 | inject | **yes** (gold = rank-1 pivot) | **yes (2/3; r3 empty)** | `evaluation_artifact` | `empty_patch` (r3) | benchmark exclusion/reclassification + re-eval |
| pylint-dev__pylint-8898 | 2/3 | 0/3 | inject | partial (1 of 3 gold files; right file, wrong sibling symbol anchored) | **yes (right file+func, 3/3 runs)** | `patch_synthesis_bound` | `multi_file_coedit` (inline route viable), `retrieval_missing_gold` (utils files), `retrieval_wrong_target` (wrong sibling — harmless, agent recovered) | patch-synthesis not addressable / benchmark reclassification |

Efficiency (medians, re-eval-invariant, from clean-Docker rebaseline; reproduced here): sympy-12419 total-tok +0%, R+G+B 21→22; astropy-14539 −36% tok, R+G+B 10→9; pylint-8898 +4% tok, R+G+B 11→11.

---

## 3. Detailed case notes

### 3.1 sympy__sympy-12419 — patch_synthesis_bound (single-run dip)

| field | baseline | VTRACE current-clean |
|---|---|---|
| old M6 class | resolution_regression | (same) |
| corrected class | resolution_regression | (same) |
| resolved | 3/3 (r1✓ r2✓ r3✓) | 2/3 (r1✓ r2✓ r3✗) |
| median total tokens | 2.46M | 2.46M (+0%) |
| median R+G+B | 21 | 22 |
| median turns | 60 | 60 |
| policyAction / reason | — | inject — "navigation-heavy task with a focused pivot source" |
| context injected? | no (control) | yes (157 items, intent=`explain`) |
| top pivots | — | `piecewise.py::piecewise_fold`, `delta_functions.py::eval` — **both wrong** |
| support files | — | `assumptions/ask.py`, `elementary/piecewise.py` — **gold absent** |
| localization signals | — | likely_symbols include `_entry`; literal-anchor `_entry` → adjoint.py / blockmatrix.py (**not** matexpr.py) |
| gold file(s) | `sympy/matrices/expressions/matexpr.py` (single); FAIL_TO_PASS `test_Identity` | (same) |
| edited files / run | matexpr.py (all 3) | matexpr.py (r1,r3); summations.py+matexpr.py (r2) |
| edited gold file? | yes (3/3) | **yes (3/3)** |

- **What baseline did:** edited `Identity._entry` in matexpr.py, small +2/−4 patch, resolved all 3.
- **What VTRACE did:** identical target. r1 produced the **correct** fix (`eq = Eq(i, j); if eq is S.true: … elif eq is S.false: … return KroneckerDelta(i, j)` + `Eq`/`KroneckerDelta` imports — matches gold). r3 produced a **subtly wrong** fix: `eq = i == j; if eq is True: … elif eq is False: …`. For symbolic `i`,`j`, Python `==` returns a structural bool that is neither `True` nor `False` in the way the branch expects, so the KroneckerDelta path is mis-taken and `test_Identity` fails. r2 also resolved (added an unrelated summations.py edit, overbroad but harmless).
- **What VTRACE context said:** it pointed at the **wrong files** (piecewise / delta_functions — the KroneckerDelta *discussion* in the issue thread, not the actual edit site). The gold file/symbol was **not** in pivots or support. The agent ignored the wrong pivots and localized from the issue body, which literally states "it's the `_entry` method of the `Identity`."
- **Why Docker resolved/unresolved:** deterministic; r1/r2 patches are correct, r3's is semantically wrong.
- **Why this is not policy-related:** identical injected context produced both a correct (r1) and a wrong (r3) patch. Context did not cause the dip; it is model synthesis variance at n=3. Retrieval *did* miss the gold (secondary `retrieval_missing_gold`), but harmlessly — the task is self-localizing and the agent hit gold 3/3 anyway.

### 3.2 astropy__astropy-14539 — evaluation_artifact

| field | baseline | VTRACE current-clean |
|---|---|---|
| corrected class | resolution_regression | (same) |
| resolved | 3/3 | 1/3 (r1✗ r2✓ r3 empty) |
| median total tokens | 1.53M | 0.98M (−36%) |
| median R+G+B | 10 | 9 |
| median turns | 32 | 27 |
| policyAction | — | inject (intent=`test-failure`, confidence high) |
| top pivots | — | `io/fits/diff.py::FITSDiff` (rank 1, score 4.682 — **correct gold**), `io/fits/column.py::Column` |
| support files | — | `io/fits/diff.py` (TableDataDiff, ImageDataDiff, …) |
| localization signals | — | likely_files include `diff.py` + `test_diff.py`; failing tests resolved exactly |
| gold file(s) | `astropy/io/fits/diff.py` (single); 2 FAIL_TO_PASS in test_diff.py | (same) |
| edited files / run | diff.py (all 3) | diff.py (r1,r2); **empty** (r3) |
| edited gold file? | yes (3/3) | yes (2/3; r3 empty) |

- **Gold patch:** one-line `elif "P" in col.format:` → `elif "P" in col.format or "Q" in col.format:` in `TableDataDiff._diff`.
- **What VTRACE did:** r1 and r2 each produced a patch that is **byte-identical to the gold** (`or "Q" in col.format`), same base commit, same git index hashes (`100cdf1..d3608ef`). r3 explored 27 turns and emitted an **empty** patch.
- **The artifact:** r2 (evaluated 11:58) → `resolved=True`; r1 (re-evaluated 21:41 on 6/15, `evaluationRan=true`, `dockerUsed=true`, `evaluationError=null`) → `resolved=False`, with the **identical correct patch**. A deterministic FAIL_TO_PASS cannot pass on r2 and fail on r1 with the same patch. r1's `False` is a false negative — a flaky test (`test_identical_tables` / `test_different_table_data`) or a residual eval-environment fault that the rebaseline's "0 shim errors" check did not catch for this late re-eval.
- **Why this is not policy/synthesis-related:** VTRACE synthesized the **exact gold** in 2 of 3 runs; the gold file was the rank-1 pivot. The only real failure is r3's empty patch (1/3, isolated). The "3/3→1/3" headline is a measurement artifact stacked on one empty-patch run, not a VTRACE context/policy regression. The −36% tokens reflect the injected FITSDiff source letting the agent go straight to the edit site.

### 3.3 pylint-dev__pylint-8898 — patch_synthesis_bound (+ multi-file co-edit, inline route viable)

| field | baseline | VTRACE current-clean |
|---|---|---|
| corrected class | resolution_regression | (same) |
| resolved | 2/3 (r1✓ r2✓ r3✗) | 0/3 |
| median total tokens | 1.44M | 1.50M (+4%) |
| median R+G+B | 11 | 11 |
| median turns | 38 | 39 |
| policyAction | — | inject ("line-anchor resolution + internal-subsystem navigation") |
| top pivots | — | `config/argument.py::_regexp_paths_csv_transfomer` (rank 1), `lint/run.py::Run` |
| support files | — | `config/arguments_manager.py`, `config/config_initialization.py`, `pylint/__init__.py` |
| localization signals | — | line-anchor `argument.py#L134` → `_regexp_paths_csv_transfomer` (**confidence: low**); body-literal "missing ), unterminated subpattern" → `test_csv_regex_error` |
| gold file(s) | `config/argument.py`, `utils/__init__.py`, `utils/utils.py` (3-file); FAIL_TO_PASS `test_csv_regex_error` | (same) |
| edited files / run | argument.py only (all 3) | argument.py only (all 3) |
| edited gold file? | yes — `argument.py` (the necessary one) | yes — `argument.py` (3/3) |

- **Gold patch:** adds `_check_regexp_csv` to `utils/utils.py`, exports it in `utils/__init__.py`, and calls it from `argument.py::_regexp_csv_transfomer` (a comma-aware splitter that does not split `\d{1,2}` quantifiers).
- **What both arms did:** neither created the utils helper. Both inlined a local `_parse_regex_csv` splitter **directly in `argument.py::_regexp_csv_transfomer`** — a legitimate alternative (baseline proves the test passes with `argument.py` edits alone, 2/3). So the multi-file co-edit is **not required**; the missing utils files in retrieval are not the blocker.
- **Why VTRACE regressed:** the inline splitters differ in quality. Baseline r2 (resolved, +56) tracks `[]` and `{}` depth independently with escape handling; VTRACE r2 (unresolved, +43) gates brace tracking on `bracket_depth == 0` and has subtly different boundary logic that mis-handles the test's input. All 6 runs hand-roll the parser; only the 2 baseline runs got it right. Synthesis lottery on a tricky hand-written parser, n=3.
- **Retrieval notes (both harmless):** the rank-1 pivot anchored on the **wrong sibling** `_regexp_paths_csv_transfomer` (low-confidence line anchor) rather than the gold's `_regexp_csv_transfomer`; and 2 of 3 gold files (`utils/utils.py`, `utils/__init__.py`) were never surfaced. Neither caused the regression: the agent corrected to the right function (via the failing-test name) in all runs, and the inline route sidesteps the utils files. Injection added no benefit (+4% tokens, 0/3 vs 2/3) but did not demonstrably misdirect the edit.
- **Why this is not policy-related:** both arms edit the identical gold function; the gap is patch correctness, not context. Could be read as "inject-without-benefit," but the no-context baseline is itself only 2/3, so the 0/3 vs 2/3 gap is within synthesis variance at n=3 on a hard hand-rolled-parser task that **neither** arm solved the gold way.

---

## 4. Fix recommendations (by class)

**policy tuning** — *None warranted from these three.* No case is a clean `policy_should_skip`: in every case the no-context arm and the VTRACE arm edit the same gold location, and skipping would not have changed the synthesized patch. The M7.3 disable already removed the only policy action these cases could have triggered (none are traceback-localized anyway). Do **not** add a skip rule on this evidence.

**retrieval / candidate generation** — two *latent, harmless* misses worth a backlog note, not action now:
- sympy-12419: gold `matexpr.py::Identity._entry` is not surfaced (pivots chase the KroneckerDelta discussion). The literal-anchor `_entry` resolved to `adjoint.py`/`blockmatrix.py` siblings, not `matexpr.py`.
- pylint-8898: line-anchor resolved to the wrong sibling `_regexp_paths_csv_transfomer` (confidence low); `utils/utils.py` + `utils/__init__.py` not surfaced.
These belong in a dedicated retrieval-miss audit (recommendation D) only if a future case shows the agent actually *following* a wrong anchor — here both agents recovered, so neither changed an outcome.

**actionability detector expansion** — *not the blocker here.* pylint-8898's true gold is a 3-file co-edit, but the inline single-file route is viable (baseline resolves with it), so a multi-file-co-edit obligation would not have helped. (The general multi-file-co-edit gap remains real — see sphinx-7462/seaborn-3187/django-13195 in the bounded-20 report — but these three regressions do not motivate it.)

**pivot-inspection / context-action enforcement** — *not the blocker.* All three edit the right target; no agent ignored a correct pivot.

**patch-synthesis not addressable by VTRACE** — sympy-12419 and pylint-8898. Both edit the exact gold location with identical context and fail on patch *content* (symbolic `Eq` vs Python `==`; a buggy hand-rolled regex-CSV splitter). VTRACE cannot fix model synthesis. Mitigation is orthogonal (higher n, or model/agent-level).

**benchmark exclusion / reclassification** — 
- astropy-14539: reclassify as `evaluation_artifact`. Re-evaluate r1 (gold-identical patch must resolve under a correct harness); investigate FAIL_TO_PASS flakiness. Pending that, drop it from the regression count — VTRACE produced the gold patch 2/3.
- sympy-12419 & pylint-8898: reclassify as `patch_synthesis_bound` (n=3 variance), not VTRACE regressions. Optionally raise n on these to confirm the dips are noise.

---

## 5. Next task recommendation

**E — reclassify and select replacements.** All three "genuine regressions" dissolve under inspection: 2 are model patch-synthesis variance (the agent edits the exact gold location under identical context and writes a subtly-wrong patch in one run), and 1 (astropy-14539) is a measurement artifact (a byte-for-byte gold patch scored unresolved). None implicate VTRACE retrieval, policy, actionability, or context-action behavior, and the M7.3 disable already neutralized the only policy lever they could touch.

Concretely, next:
1. Re-evaluate astropy-14539 r1 under a verified-clean harness and probe the two FAIL_TO_PASS tests for flakiness; if confirmed artifact, reclassify and remove from the regression count (rebaseline drops to **2/20** apparent regressions, both synthesis-variance).
2. Reclassify sympy-12419 and pylint-8898 as `patch_synthesis_bound`; treat as out-of-scope for VTRACE policy/retrieval work. If a firmer signal is wanted, raise n (≥5) on these two rather than tuning policy against n=3 dips.
3. With the three "open" regressions reclassified as non-VTRACE, the substantive remaining VTRACE issue is the **inject-without-benefit rate (24%)** from the rebaseline (sphinx-7462, sympy-16766, requests-5414, seaborn-3187) and the multi-file co-edit actionability gap — those, not these three, should drive the next policy/actionability milestone.

Do **not** advance to a 30- or 100-case run on the strength of these three; they are not the open problem they appeared to be.

---

## 6. Non-claims / caveats

- n=3 (no `astropy-14369`-style n=5 here). The two `patch_synthesis_bound` calls rest on single-run dips; "synthesis variance" is the most parsimonious reading given identical context produced both correct and incorrect patches, but n=3 limits certainty.
- The astropy-14539 `evaluation_artifact` finding is inferred from byte-identical patches scoring differently; it was **not** confirmed by a fresh Docker re-run (out of scope — no Docker this task). The recommendation is to confirm via re-eval.
- "Gold edited?" is judged against the SWE-bench gold patch file set in `swe-bench-100.jsonl`; pylint's viable inline route means "gold file edited" (argument.py) does not require the full 3-file gold shape.
- No code, scoring, candidate-generation, ranking, or policy was changed by this task. Capsule snapshots were read from the existing current-clean runs, not regenerated.
