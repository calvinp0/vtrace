# Stage 5 — M9 value-gap audit: inject-without-benefit & multi-file co-edit actionability

Generated 2026-06-16, on `main` HEAD `f2c297f`. **Diagnostic only** — no agents, no Docker, no 30/100-case runs, no policy/retrieval/scoring/ranking/candidate-gen changes. Builds on the corrected bounded-20 picture (`stage5_m7_clean_docker_rebaseline.md`) and the M8 / M8.1 follow-ups (`stage5_m8_regression_failure_shape_audit.md`, `stage5_m8_eval_artifact_followup.md`), which closed out the three former "regressions" (2 patch-synthesis-bound, 1 confirmed eval-artifact; **0** VTRACE-attributable). This task audits the remaining *real* product gaps: non-useful injection and multi-file co-edit / context-to-action failures.

Cases (deduplicated to 5; sphinx-7462 appears in both source lists, audited once):

```
inject-without-benefit seed : sphinx-7462, sympy-16766, requests-5414
actionability / multi-file  : sphinx-7462, seaborn-3187, django-13195
```

Data sources: per-run `_run.meta.json` (policyAction/pivot/support), `_eval.meta.json` + `swebench-*.jsonl` (resolved, tokens, tool calls, model patch), `_capsule_v2_manifest.json` (pivots/support/diagnostics), and gold patches + FAIL_TO_PASS from `vexp-swe-bench/data/swe-bench-100.jsonl`. n=3 per arm. Medians. No artifacts regenerated.

---

## 1. Executive summary

```
inject-without-benefit (primary)        : 2   (sympy-16766, requests-5414)
multi-file co-edit actionability (primary): 2  (seaborn-3187, django-13195)
context-action gap (primary)            : 1   (sphinx-7462 — both gold files surfaced as pivots, agent edited only one)
patch-synthesis-bound (primary)         : 0   (requests-5414 carries it as a secondary)
```

**The dominant, addressable gap is multi-file co-edit actionability.** 3 of the 5 cases have multi-file gold (sphinx-7462: 2 files, seaborn-3187: 2 files, django-13195: 3 files), and in **all three, neither arm ever edited the full gold set in a single patch** — the agent edits the lead pivot file and stops. The root cause is uniform and concrete: **VTRACE emits no co-edit obligation.** Across all three manifests there is no actionability/obligation field and the injected context contains zero "also edit / co-edit / both files" language. The co-edit files are present in the capsule (as a second pivot in sphinx; demoted to *support* in seaborn/django) but nothing tells the agent the fix spans multiple files.

The two pure inject-without-benefit cases are real but lower-value: both are *single-file* gold where the baseline already localizes the one file unaided, and VTRACE injection only adds cost (sympy-16766 +39% cost at flat 3/3; requests-5414 +29% cost at flat 0/3). requests-5414's 0/3 is patch-synthesis-bound (both arms edit the gold file and neither resolves), so no injection policy can move its resolution.

---

## 2. Per-case table

Deltas are VTRACE − baseline (medians). "all gold edited?" = did any single VTRACE run edit every gold file. Actionability hint = any co-edit/obligation hint in capsule or injected context.

| instance | category | base res | vtrace res | policy | gold surfaced? | gold edited? | all gold edited? | actionability hint? | tok Δ | R+G+B Δ | primary label | secondary labels | fix class |
|---|---|:-:|:-:|:-:|---|---|:-:|:-:|:-:|:-:|---|---|:-:|
| sphinx-doc__sphinx-7462 | inject + multi-file | 0/3 | 0/3 | inject | **yes — both gold are pivots** (python.py::_parse_annotation, ast.py::unparse) | python.py only (3/3); ast.py never | **no** | none | +33% | +1 | `context_action_gap` | multi_file_gold, hidden_pivot_ignored, co_edit_missing, actionability_hint_missing, inject_without_benefit (+58% cost) | C (+B) |
| sympy__sympy-16766 | inject-without-benefit | 3/3 | 3/3 | inject | yes (pycode.py pivot) | yes (3/3) | yes (single) | none | −7% | −5 | `inject_without_benefit` | baseline_optimal | A / E |
| psf__requests-5414 | inject-without-benefit | 0/3 | 0/3 | inject | yes (models.py pivot) | yes (3/3) | yes (single) | none | +13% | 0 | `inject_without_benefit` | patch_synthesis_bound, baseline_optimal, benchmark_unsuitable | E (+A) |
| mwaskom__seaborn-3187 | multi-file actionability | 0/3 | 0/3 | inject | partial (scales.py pivot; utils.py only **support**) | one-or-other, never both | **no** | none | −8% | −5 | `multi_file_actionability_gap` | multi_file_gold, gold_hidden, co_edit_missing, actionability_hint_missing | B |
| django__django-13195 | multi-file actionability | 0/3 | 0/3 | inject | partial (response.py 2 pivots; cookie.py + middleware.py only **support**) | response.py only (3/3) | **no** | none | −28% | −3 | `multi_file_actionability_gap` | multi_file_gold, gold_hidden, co_edit_missing, actionability_hint_missing | B |

Note: every VTRACE row is `policyAction=inject`, pivots=2, support=4. No skips fired on any of these.

---

## 3. Detailed case notes

### 3.1 sphinx-7462 — context_action_gap (both gold files surfaced as pivots; agent ignored one)

- **Gold (2 files):** `sphinx/domains/python.py` and `sphinx/pycode/ast.py`. FAIL_TO_PASS = `test_parse_annotation` (python.py) **and** `test_unparse[()-()]` (ast.py `unparse` — empty-tuple unparsing). Both files are required.
- **Baseline:** 0/3 — edited python.py in r1/r2 (+4/−2, +2/−1), r3 empty. Never touched ast.py.
- **VTRACE:** 0/3 — edited python.py in all 3 (r2 also touched a non-gold `autodoc/__init__.py`). Never touched ast.py. Tokens +33%, cost +58%, R+G+B +1 vs baseline.
- **Context injected:** pivots = `python.py::_parse_annotation` **and** `ast.py::unparse` — i.e. **both gold files were surfaced as pivots.** Support = addnodes.py, application.py, python.py.
- **What was missing from the patch:** the `ast.py::unparse` empty-tuple fix. The agent had the exact second gold symbol as a pivot in context and still edited only the first file.
- **Diagnosis:** context-to-action, not retrieval. VTRACE surfaced the right two targets; the agent under-used the second pivot. There is no obligation/checklist telling the agent it must address *every* pivot, so it defaulted to the lead file. (Also inject-without-benefit on cost: +58% with no resolution change — but that's downstream of the same unsolved co-edit.)

### 3.2 sympy-16766 — inject_without_benefit (single-file gold, baseline already optimal)

- **Gold (1 file):** `sympy/printing/pycode.py`. FAIL_TO_PASS = `test_PythonCodePrinter`.
- **Baseline:** 3/3, edits pycode.py, median 1.08M tok, R+G+B 11.
- **VTRACE:** 3/3, edits pycode.py, median 1.01M tok (−7%), R+G+B 6 (≈halved), but **cost +39%**.
- **Context injected:** pivot `pycode.py::PythonCodePrinter` (gold) + `printer.py::_print`.
- **Diagnosis:** resolution is unaffected (both 3/3) and navigation is genuinely reduced (R+G+B 11→6 — a real tool-discipline improvement). But by the bounded-20 mandate (useful = resolution up, or tokens ≥10% down) this fails: tokens only −7% and **cost rose 39%**. So it is a non-useful injection on a case the baseline already solves unaided — the mildest of the set (the only thing "wrong" is cost). Not a resolution or correctness problem.

### 3.3 requests-5414 — inject_without_benefit over a patch-synthesis-bound base

- **Gold (1 file):** `requests/models.py`. FAIL_TO_PASS = `test_invalid_url[InvalidURL-http://.example.com]`.
- **Baseline:** 0/3 — edits models.py (`prepare_url`) in all 3, never resolves.
- **VTRACE:** 0/3 — edits models.py in all 3, never resolves. Tokens +13%, cost +29%.
- **Context injected:** pivot `models.py::prepare_url` (gold) + `api.py::get`.
- **Diagnosis:** both arms localize the single gold file and symbol perfectly; **neither writes a passing patch** → the bottleneck is patch synthesis (the InvalidURL handling for `http://.example.com`), not context. VTRACE injection adds cost without moving resolution → inject-without-benefit, but the case cannot demonstrate injection *value* either way because both arms sit at 0/3 (`benchmark_unsuitable` for inject conclusions). No policy/retrieval/actionability change helps here.

### 3.4 seaborn-3187 — multi_file_actionability_gap (co-edit file demoted to support)

- **Gold (2 files):** `seaborn/_core/scales.py` and `seaborn/utils.py`. FAIL_TO_PASS = two `test_legend_has_no_offset` tests.
- **Baseline:** 0/3 — edited scales.py in all 3 (r1 also non-gold plot.py), never utils.py.
- **VTRACE:** 0/3 — edited scales.py (r1, r3) **or** utils.py (r2), **never both in one run.** Tokens −8%, cost −10%, R+G+B 29→24 (mild efficiency).
- **Context injected:** pivot `scales.py::_setup` (gold 1) + `relational.py::scatterplot` (non-gold). `utils.py` (gold 2) appears only in **support** (signature-level), not as a pivot.
- **What was missing:** a single patch touching both scales.py and utils.py. The agent treated them as alternatives, not co-requisites.
- **Diagnosis:** the second gold file was surfaced but at low prominence (support) and with no co-edit obligation, so the agent never combined them. Multi-file co-edit actionability gap.

### 3.5 django-13195 — multi_file_actionability_gap (3-file co-edit; two golds in support)

- **Gold (3 files):** `django/contrib/messages/storage/cookie.py`, `django/contrib/sessions/middleware.py`, `django/http/response.py`. FAIL_TO_PASS = 5 tests (delete-cookie samesite + session delete-on-end).
- **Baseline:** 0/3 — edited response.py only in all 3.
- **VTRACE:** 0/3 — edited response.py only in all 3. Tokens −28%, cost +1%, R+G+B 6→3 (cheaper, but the rebaseline's "useful (preserved+cheaper)" label is only the literal rule — it is a *failure* preserved more cheaply, not a win).
- **Context injected:** pivots = `response.py::delete_cookie` + `response.py::set_cookie` (both in the one pivot file = gold 1). `cookie.py` and `middleware.py` (gold 2 & 3) appear only in **support**.
- **What was missing:** the cookie.py and middleware.py co-edits. The agent edited the pivot file and stopped.
- **Diagnosis:** identical shape to seaborn — the co-edit files are present but as support, with no obligation to edit them. Multi-file co-edit actionability gap, more acute (2 of 3 gold files left unedited every run).

---

## 4. Fix-class recommendations

**A. policy tuning / skip criteria** — `sympy-16766` (skip would save the +39% cost with no resolution loss, since baseline solves the single gold file unaided), and the cost side of `requests-5414`. Low value: these are cost-only, and a skip rule risks suppressing the genuine navigation/discipline reduction (R+G+B 11→6 on sympy). Defer; not the priority.

**B. multi-file co-edit actionability detector** — `seaborn-3187`, `django-13195` (and `sphinx-7462`). The common defect: the co-edit gold file(s) are surfaced only as low-prominence *support* (seaborn utils.py; django cookie.py + middleware.py), and **no co-edit obligation is ever emitted** (verified: no obligation field in the manifest, no co-edit language in the injected context). A detector that recognises a multi-file fix shape and emits an explicit "edit all of: A, B, C" obligation would directly target the dominant gap. **Highest leverage — 3 of 5 cases.**

**C. pivot-inspection / context-action enforcement** — `sphinx-7462`. Here both gold files are *already* pivots; the agent ignored the second (`ast.py::unparse`). This needs an enforcement/checklist that makes the agent address every surfaced pivot, not just the lead one. Overlaps with B: a co-edit obligation that lists every pivot/co-edit target as a checklist covers this case too.

**D. retrieval / candidate-generation improvement** — none of the 5 is a clean retrieval miss. Every gold file is surfaced (as pivot or support). The seaborn/django co-edit files being *support rather than pivot* is a prominence/role issue better fixed by B (obligation) than by re-ranking — re-ranking risks displacing the legitimate lead pivot. Optional backlog note only.

**E. patch-synthesis-bound / benchmark reclassification** — `requests-5414` (both arms edit the gold file/symbol and neither resolves → patch-bound; cannot support inject-value conclusions). Reclassify as patch-synthesis-bound for value accounting.

---

## 5. Next implementation recommendation

**A. Add a generic multi-file co-edit actionability detector** (the task's option A).

Rationale: 3 of 5 audited cases (sphinx-7462, seaborn-3187, django-13195) are multi-file-gold and **fail purely because the co-edit obligation is never expressed** — confirmed structurally: no obligation field in any manifest, no co-edit language in any injected context, and the agent edits only the lead pivot file in every run. This is the single recurring, addressable product gap, and it is the next layer after the generated-artifact actionability success already shipped (astropy-14369).

The detector should: (1) recognise a multi-file fix shape (e.g. lead pivot + tightly-coupled support symbols that the test set spans), (2) **promote** the coupled co-edit files into an explicit obligation rather than leaving them as passive support, and (3) emit a co-edit **checklist** ("this fix requires edits in: X, Y, Z") in the injected context. Component (3) also covers the sphinx-7462 ignored-pivot case (task option B / fix-class C), so a single detector with a checklist obligation addresses all three multi-file cases — making A strictly more impactful than B alone here.

Do **not** advance to a 30/100-case run: this gap should be implemented and re-measured on the bounded-20 set (specifically these 3 multi-file cases plus astropy-14369 as the positive control) before scaling.

## 6. Non-claims / caveats

- n=3; medians. "all gold edited? = no" is judged against the SWE-bench gold file set; a viable alternative single-file fix is not known to exist for these three (unlike pylint-8898's inline route), so the co-edit appears genuinely required.
- inject-without-benefit here is a *cost* finding (resolution is flat or patch-bound), not a correctness regression. requests-5414's 0/3 is patch-synthesis-bound and not movable by injection policy.
- No code changed; no raw artifacts staged. Capsule snapshots read from existing current-clean runs (current `main`; HEAD `f2c297f` changed nothing in ranking/policy for these cases — all still `inject`).
