# Stage 5 M67 M66 Pivot Localization Audit

Offline audit of the M66 optional-impact 24-task live validation. **No live agents, no
Docker, no API spend, no retrieval/scoring/ranking/candidate-generation changes.** Gold
files were read only for offline diagnosis (extracted from `swe-bench-100.jsonl` patches);
no past run was altered.

## Summary
- **M66 verdict:** MIXED (8/10 success criteria). The two failed criteria are both
  structured-decision metrics: **C4 coverage 85.1% (< 90% bar)** and **C5 invalid
  rule-out 8.5% (> M62C's 4.2%)**.
- **Resolution is at parity** (M66 15/24 = baseline 15/24 = M62C 15/24) and the
  optional-impact invariant held perfectly (0 required IMPACT, 30 optional surfaced, 1
  inspected, 0 edited, ignored rate fell 5.6% → 2.1%). The optional-impact rule is **not**
  the cause of any failed criterion.
- **Primary root cause (failed criteria):** **wrong required-PIVOT localization.**
  6 of 24 cases surfaced a lead pivot that is **not** the gold edit location, driven by
  lexical / symbol-name over-match onto an unrelated subsystem. The agent correctly
  ignores / rules these out (producing the IGNORED + INVALID_RULE_OUT misses) and
  self-rescues by searching for the real gold — so **every one of these 6 wrong-pivot
  cases still RESOLVED.** The wrong pivots cost structured-decision metrics, not resolution.
- **Secondary root cause (the 9 resolution failures), three disjoint buckets:**
  - **Missing second/multi-gold via retrieval (4):** seaborn-3187, django-13195,
    pylint-8898, astropy-14369 — a second/third gold file is never surfaced as an
    actionable pivot (or only as a low-priority `skel`/`support` entry for the wrong symbol).
  - **Second gold surfaced but not acted on (1):** sphinx-7462 — `pycode/ast.py::unparse`
    **is** a required pivot, but the agent ruled it out and edited only `python.py`. This is
    a **context-to-action** gap, **not** a retrieval miss.
  - **Correct single-gold localization, non-resolving patch (4):** django-11820,
    matplotlib-25960, astropy-14598, requests-5414 — the lead pivot is the gold file, the
    agent edited it, the patch just doesn't pass. This is **patch quality / live variance**,
    out of scope for localization.
- **Main driver cases:** django-11740 (wrong lead pivot → invalid rule-out), matplotlib-24627
  (wrong lead pivot → ignored, but the M66-only win), seaborn-3187 (missing second gold),
  sphinx-7462 (surfaced second gold not acted on), requests-5414 (correct pivot, variance loss).
- **Recommendation:** **Primary next step = B — a lead/required-pivot confidence-demotion
  gate.** Demote a required pivot to optional/FYI when its only evidence is lexical /
  symbol-name match (no traceback anchor, no failing-test exercise, no import/call edge to
  the lead) or it sits in an unrelated subsystem / is a facade/wrapper/test file. This
  directly attacks both failed criteria, is fully measurable offline against captured M66
  transcripts, cannot harm the matplotlib-24627 win (the agent already self-rescues off the
  surfaced pivots), reduces over-edit risk, and needs **no** retrieval/scoring/ranking
  change (it is a contract-render gate over already-computed evidence flags). **Live runs
  are not recommended next** — validate offline first.

## Metric Recheck
Recomputed from `stage5_m66_optional_impact_24_live_validation.json` and `.detail.json`
(not from Markdown prose). All headline numbers reproduce.

| metric | report | recomputed | match |
| --- | --- | --- | --- |
| valid treatment | 24/24 | 24/24 | ✅ |
| resolution M66 / baseline / M62C | 15 / 15 / 15 | 15 / 15 / 15 | ✅ |
| required targets | 47 | 47 (sum of per_target) | ✅ |
| closed / open | 40 / 7 | EDIT 24 + RULE_OUT 8 + INSPECT_ONLY 8 = 40; open 7 | ✅ |
| coverage | 85.1% | 40/47 = 85.106% | ✅ |
| ignored rate | 2.13% | 1/47 = 2.127% | ✅ |
| invalid rule-out | 8.51% | 4/47 = 8.511% | ✅ |
| optional surfaced / inspected / edited | 30 / 1 / 0 | 30 / 1 / 0 | ✅ |
| off-target edits | 8 | 8 | ✅ |
| pooled token / cache / cost delta | -6.8% / -7.8% / +12.3% | -6.76% / -7.83% / +12.31% | ✅ |
| tool-call mean delta | -0.4 | -0.44 | ✅ |

**Paired-outcome discrepancy (reporting only — the M66 report itself is internally
consistent).** The M67 prompt's compressed recap ("both_pass 14, both_fail 8, M66-only 1:
matplotlib-24627, baseline-only 1: requests-5414") **conflates the two comparisons**: the
14/8/1/1 counts are the **M62C-vs-M66** split, while matplotlib-24627 and requests-5414 are
named from the **baseline-vs-M66** split. The authoritative splits are:
- **Baseline vs M66:** both_pass 13, both_fail 7, M66-only 2 (matplotlib-24627, astropy-14365),
  baseline-only 2 (pylint-8898, requests-5414). Sum 24. ✅
- **M62C vs M66:** both_pass 14, both_fail 8, M66-only 1 (astropy-14365), M62C-only 1
  (pylint-8898). Sum 24. ✅

No discrepancy in the M66 artifacts; the recap line is just a lossy merge.

## Required-Pivot Quality Summary
47 required targets across 24 runs. **25 land in a gold file; 22 do not.**

Decision distribution: EDITED 24 · RULED_OUT 8 · INSPECT_ONLY_NO_EDIT 8 · INVALID_RULE_OUT 4
· INSPECTED_ONLY 2 · IGNORED 1.

Per-case lead-pivot landing:

| lead-pivot status | count | cases |
| --- | --- | --- |
| **lead pivot ∈ gold** | 18 | (resolved 12 / unresolved 6) |
| **lead pivot ∉ gold (wrong)** | 6 | django-10880, django-11740, matplotlib-22719, matplotlib-24627, requests-1142, sympy-12419 — **all 6 RESOLVED** via agent self-rescue |

Classification of the 47 (collapsed to per-target):

| classification | count | meaning |
| --- | --- | --- |
| correct_required_target (in gold, edited or validly closed) | 25 | retrieval correct |
| plausible_but_unused (in gold, INSPECT_ONLY) | (subset) | correct file, no edit needed |
| wrong_required_target (∉ gold, ruled out / ignored / inspected) | 22 | wrong subsystem or facade/wrapper |
| missing_hidden_gold (gold file absent from required set) | 6 cases | see resolution-failure buckets below |

Structured-decision misses (the failed-criteria drivers), every one a **wrong required
pivot the agent declined to formally close**:
- **INVALID_RULE_OUT (4):** django-11740 (gis/gdal/feature.py ×2), requests-1142
  (sessions.py), astropy-14369 (vounit.py).
- **IGNORED (1):** matplotlib-24627 (pyplot.py).
- **open (7):** the above plus sympy-12419 (piecewise.py ×2, INSPECTED_ONLY but unclosed).

## Problem Case Deep Dives

### django-11740 — wrong lead pivot, agent self-rescue (RESOLVED)
- **VTRACE required:** `django/contrib/gis/gdal/feature.py::Feature` + `::Feature.fid`
  (both INVALID_RULE_OUT). Optional O1/O2 = `gis/gdal/layer.py` (dependents of feature.py).
- **Why GIS/GDAL became required:** the capsule ranking annotates the lead as
  *"symbol-name match; strong lexical match."* The issue concerns `AlterField` migration
  dependencies; the unrelated GDAL `Feature`/`fid` symbols win on raw lexical/symbol-name
  overlap. **Pure pivot-selection/scoring miss** — wrong subsystem entirely.
- **Was the gold present?** `db/migrations/autodetector.py` appears **0 times** anywhere in
  the injected capsule (body, pivots, or optional impact).
- **How the agent found it:** entirely via its own search — `grep "AlterField.*dependencies"`
  then `def generate_altered_fields` in `django/db/migrations`, read autodetector.py, edited
  it, tests passed. The GDAL pivots were never inspected; they only produced 2 invalid
  rule-outs (and burned 5 searches / 2 repeated reads of budget).
- **Would a general rule demote the GDAL pivot?** Yes — it has no traceback anchor, no
  failing-test exercise, and only lexical evidence; a confidence-demotion gate (rule B/E)
  would render it optional/FYI, removing both invalid rule-outs. **Risk to other cases:**
  low — demotion only changes required-vs-optional rendering, not retrieval; the gold
  files in correctly-localized cases all carry stronger evidence (traceback/issue-anchor).
- **Type:** retrieval **pivot-selection** issue (lexical over-match), not query
  interpretation or ranking-math. Do **not** tune only for this case.

### seaborn-3187 — missing second gold (STABLE FAIL)
- **VTRACE required:** `seaborn/_core/scales.py::ContinuousBase._setup` (lead, **correct**,
  edited) + `seaborn/relational.py::scatterplot` (RULED_OUT, **wrong** second).
- **Was utils.py present?** Only as low-priority context: `skel seaborn/utils.py::load_dataset`
  and `support … load_dataset (utils.py:538-543) [truncated]`. The gold edit in utils.py is a
  **different symbol**, never surfaced; `load_dataset` is irrelevant. So the second gold file
  appears as a name but **its actionable region is missing**, and the surfaced second pivot
  (relational.py) is wrong.
- **Impact-graph path scales.py → utils.py?** Not surfaced as a required/optional pivot —
  the dependency edge that would promote the correct utils.py symbol is absent from the
  decision contract.
- **Did the agent reach utils.py?** No — 1 search, 2 reads; it edited scales.py and stopped.
- **Type:** multi-gold expansion / dependency-edge miss (retrieval). A call/reference
  expansion from the edited lead pivot *to the right utils.py symbol* could surface it — but
  only if it picks the gold symbol, not `load_dataset`. Do **not** tune only for seaborn.

### requests-5414 — correct pivot, non-resolving patch (baseline-only loss = VARIANCE)
- **VTRACE required:** `requests/models.py::PreparedRequest.prepare_url` (lead, **correct** —
  models.py is the sole gold, prepare_url is the right region) + `requests/api.py::get`
  (INSPECT_ONLY).
- **Why baseline passes, M66 fails:** **not over-anchoring on a wrong pivot** — the pivot is
  exactly right and the agent edited models.py. The patch simply did not pass FAIL_TO_PASS.
- **Was the correct file present and acted on?** Yes — surfaced as lead and edited.
- **Prior observation:** M62C also failed it (paired_vs_m62c → both_fail); only the single
  baseline run (1/1) passed. Both VTRACE treatments fail; baseline n=1.
- **Stable or variance:** treat as **live/patch variance** (single-sample baseline, correct
  localization). **No localization rule addresses this**; a no-code variance repeat (option D)
  is the only honest probe, and it is a secondary check, not the milestone driver.

### sphinx-7462 — second gold surfaced but NOT acted on (STABLE FAIL, context-to-action)
- **VTRACE required:** `sphinx/domains/python.py::_parse_annotation` (lead, EDITED) +
  `sphinx/pycode/ast.py::unparse` (**RULED_OUT**). Gold = python.py **and** pycode/ast.py.
- **Was ast.py surfaced?** **Yes — as a required pivot**, mentioned 43× in the capsule, with
  ranking evidence *"exercised by a failing test; symbol-name match; lexical match."*
  Retrieval is essentially **perfect** here: both gold files are required pivots.
- **Did the agent edit both?** No — it edited only python.py (1 read, 0 searches) and ruled
  out ast.py without inspecting it.
- **Type:** **context-to-action multi-gold gap**, **not** a retrieval miss. The known
  sentinel failure: surfacing the second gold is necessary but insufficient; the agent must
  be compelled to act. Multi-gold *expansion* (rule A/C) would not help — the target is
  already required. A stricter "do not rule out a test-exercised required pivot without
  inspecting it" contract/classifier nudge is the relevant lever.

### matplotlib-24627 — no-hurt check (M66-only WIN)
- **VTRACE required:** `lib/matplotlib/pyplot.py::plot` (RULED_OUT) + `::subplots` (IGNORED).
  Gold = `lib/matplotlib/axes/_base.py`. **Both required pivots are wrong** (pyplot facade);
  `_base.py` appears **0 times** in the capsule.
- **Why M66 passed:** pure agent **self-rescue** — 17 searches, 13 reads, $3.02 (a heavy
  thrash run) located `_base.py` + `figure.py` and edited them. Baseline never passed (0/3);
  M62C and M65C passing shape match (same off-pivot self-rescue mechanism).
- **Optional reps ignored safely?** Yes — 2 optional impact reps (test files), 0 inspected,
  0 edited.
- **Risk from candidate fixes:** **low.** The win does not depend on the surfaced pivots, so
  demoting the wrong pyplot pivots (rule B) cannot remove the agent's search-based rescue; it
  only removes the IGNORED metric penalty. Multi-gold expansion that surfaces `_base.py`
  would *help*. The only thing that could hurt is a rule that *suppresses* broad agent search —
  none of the recommended candidates do that.

## Candidate Rule Evaluation

Estimated offline from M66 artifacts. "helps" = would fix that case's failed criterion or
resolution; "risk" = could disturb a current win or add over-edit.

| rule | helps cases | risks cases | expected metric effect | impl scope | recommend |
| --- | --- | --- | --- | --- | --- |
| **A. Hidden-pivot / multi-gold expansion** | seaborn-3187 (if right symbol); django-13195, pylint-8898, astropy-14369 *maybe* | matplotlib-24627 low; **over-edit ↑**; adds wrong seconds (already see relational.py, vounit.py) | resolution +0..3; **invalid rule-out ↑** (more wrong seconds); coverage neutral | retrieval/candidate-gen change (out of this lane) | **defer** — resolution-facing follow-up, higher risk |
| **B. Lead/required-pivot confidence-demotion gate** | django-11740 (−2 invalid), requests-1142 (−1 invalid), astropy-14369 (−1 invalid), matplotlib-24627 (−1 ignored), sympy-12419 (open) | matplotlib-24627 **none** (self-rescue intact) | **coverage ↑, invalid rule-out ↓, ignored ↓**; resolution neutral; over-edit ↓ | contract-render gate over existing evidence flags — **no retrieval change** | **PRIMARY** |
| **C. Dependency co-pivot promotion** | seaborn-3187 *if* scales→utils edge exists | promotes wrong seconds; **over-edit ↑** | resolution +0..1; invalid rule-out ↑ risk | retrieval/graph change (out of lane) | **defer** |
| **D. Lead-pivot confidence gate → broaden search** | overlaps B for django-11740/mpl-24627 | could ↑ cost | coverage ↑; **cost ↑** | runner/prompt change | fold into B |
| **E. Required-pivot demotion (test/wrapper/unrelated → optional)** | same set as B (gdal/feature.py, pyplot.py, sessions.py, api.py, vounit.py) | none observed | coverage ↑, invalid ↓ | **subset of B** | **adopt as part of B** |
| **F. Classifier: credit terse rule-outs** | lifts coverage for django-11740 cheaply | **metric-gaming** — pivots are genuinely wrong; crediting their rule-out hides the localization defect | coverage ↑ (cosmetic); invalid ↓ (cosmetic) | classifier change | **reject as primary** (masks root cause) |
| **G. No product change / treat as variance** | the 4 patch-quality fails are variance | leaves failed criteria unaddressed | none | none | insufficient alone |

Conservative reading: only **B/E** move the **actually-failed criteria** (coverage, invalid
rule-out) without changing retrieval scoring and without over-edit risk, and they are fully
measurable offline by replaying captured M66 transcripts. A/C target resolution, which is
already at parity, and carry over-edit / wrong-second-pivot risk. F is cosmetic. The 4
single-gold patch-quality failures (django-11820, matplotlib-25960, astropy-14598,
requests-5414) are **not localization problems** and no candidate rule addresses them.

## Next-Step Recommendation

**Selected next step: B — implement a narrow lead/required-pivot confidence-demotion gate
(absorbing E).**

**Why:**
- The only two **failed** M66 criteria are structured-decision metrics (coverage 85.1%,
  invalid rule-out 8.5%), and the audit traces **every** open/ignored/invalid required
  target to a **wrong required pivot** surfaced by lexical/symbol-name over-match. B removes
  those wrong pivots from the required set, which is the direct, mechanistic fix.
- It is **conservative and offline-measurable**: replay the 24 captured M66 transcripts,
  re-render the decision contract with the gate, recompute coverage/ignored/invalid. No live
  agent, no Docker, no scoring/ranking/candidate-generation change (gate operates on existing
  evidence flags: traceback-anchor, failing-test-exercise, import/call-edge-to-lead,
  subsystem match).
- It **cannot harm** the matplotlib-24627 win (self-rescue is independent of surfaced pivots)
  and reduces over-edit risk by narrowing the required set.

**Non-goals for the next milestone:**
- Do **not** change retrieval scoring, ranking, candidate generation, or Capsule v2 ranking.
- Do **not** add multi-gold/hidden-pivot expansion (rule A/C) yet — resolution is at parity
  and expansion adds wrong-second-pivot / over-edit risk; sequence it after B proves out.
- Do **not** attempt to fix the 4 patch-quality/variance failures via localization.
- Do **not** game coverage via classifier leniency (rule F).
- Do **not** plan a 100-task sweep — the remaining failures are a mix of a real structural
  defect (wrong pivots) and 4 plausibly-variance patch-quality losses, not clearly-harmless
  variance.

**Suggested validation gate after implementing B (all offline):**
1. Replay M66 transcripts: coverage ≥ 90% **and** invalid rule-out ≤ 4.2% (M62C bar).
2. Required set shrinks only by demoting evidence-weak pivots; **no** gold-in-required pivot
   is demoted (check against the 18 lead-pivot-∈-gold cases).
3. matplotlib-24627 win mechanism unchanged (edited files still `_base.py`/`figure.py`).
4. Retrieval no-change proof byte-identical (gate must not touch retrieval).
5. Only **then** consider a small live confirmation slice (e.g. the 5 driver cases), with
   explicit approval.

## Live-run recommendation
**No.** Validate B offline against captured transcripts and the retrieval no-change proof
first. A live slice is warranted only after the offline gate above passes, and only with
explicit approval.

### Artifacts
- This report: `stage5_m67_m66_pivot_localization_audit.md`
- JSON summary: `stage5_m67_m66_pivot_localization_audit.json`
- Inputs: M66 `.json` / `.detail.json`; gold from `swe-bench-100.jsonl` (read-only);
  raw capsule/tool-call artifacts under `results/runs/m66_optional_impact_24_*` (untracked,
  inspected only).
