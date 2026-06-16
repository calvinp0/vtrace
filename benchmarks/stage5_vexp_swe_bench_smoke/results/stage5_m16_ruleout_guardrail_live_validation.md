# Stage 5 — M16 live validation of the rule-out conflict guardrail

Tiny live validation (real agents + Docker) of the M16 guardrail (commit `ea33382`,
"Guard pivot rule-outs with test expectations"). M16 changed the opt-in pivot revision
path so that a grounded first-pass `PIVOT_DECISION: RULED_OUT` no longer suppresses the
revision when the ruled-out candidate is strongly anchored by the FAIL_TO_PASS / test
expectation:

```
grounded RULED_OUT + no test conflict:    ruledOut          → suppress revision
grounded RULED_OUT + test conflict:       unclear_test_conflict → do NOT suppress; include in corrective prompt
```

Cases / conditions: `sphinx-doc__sphinx-7462` (r1, r2) and `mwaskom__seaborn-3187` (r2),
all under `--protocol vtrace-indexed --capsule-intent auto --capture-product-v2-accounting
--disable-pivot-check --pivot-inspection-enforcement --pivot-revision-pass` (legacy
PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY off — confirmed in artifacts). Predecessor:
M15.1 (`stage5_m15_revision_prompt_live_validation.md`), which surfaced the sphinx false
suppression this guardrail targets.

## 1. Executive verdict

**`m16_guardrail_live_partial`** — M16 **fixed the sphinx false suppression live**, and
**did not break / over-edit seaborn**, but seaborn's marker-suppression path was not
re-exercised live (no rule-out marker emitted this run), so seaborn suppression is
**inconclusive-live** (it remains confirmed offline + by the M15.1 prior live marker).

- **sphinx fix half — live success.** In **sphinx r2** the first pass emitted a grounded
  `PIVOT_DECISION: RULED_OUT` for `sphinx/pycode/ast.py::unparse`. Under M15 that exact
  marker suppressed the revision ("patch already compliant", `ran=False`). Under M16 the
  guardrail **detected the test-expectation conflict** (`symbol "unparse" matches
  FAIL_TO_PASS test test_unparse[()-()]`), reclassified the candidate as
  `unclear_test_conflict`, did **not** suppress, and **ran the revision**, which produced a
  **non-empty revised patch adding `sphinx/pycode/ast.py` — the canonical gold hunk**
  (empty `ast.Tuple` now returns `"()"`). **sphinx r1** independently produced the same
  non-empty `ast.py` revision via the `unclear` path (no marker emitted that run).
- **seaborn preservation half — no harm, suppression inconclusive-live.** In **seaborn r2**
  the first pass did **not** emit a rule-out marker (agent nondeterminism); `scatterplot`
  arrived as `unclear`, so the revision ran via the unclear path. It **did not over-edit**:
  the revised patch was **byte-identical to the original**, the canonical first-pass
  `resolved=True` was preserved, and `ruleOutConflicts` was correctly **empty** (no
  false-positive conflict on the non-gold pivot). The marker-based suppression itself was
  not exercised this run → inconclusive for suppression.

No revised patch was wired into canonical evaluation (canonical Docker evaluated the
**original** model patch in every run — verified by hash). No shadow evaluation was run.
**No shadow resolution effect claimed.**

## 2. Run validity

| label | run-protocol | docker eval | valid? | note |
|---|---|---|---|---|
| eval-m16-ruleout-guard-current-sphinx-7462-r1 | ✅ exit0 | ✅ exit0 (evaluationError null) | ✅ | 32 turns, $0.551 |
| eval-m16-ruleout-guard-current-sphinx-7462-r2 | ✅ exit0 | ✅ exit0 (evaluationError null) | ✅ | 27 turns, $0.389 |
| eval-m16-ruleout-guard-current-seaborn-3187-r2 | ✅ exit0 | ✅ exit0 (evaluationError null) | ✅ | 32 turns, $0.684 |

- No 429 / quota failures; no aborts; no missing JSONL; no Docker infra failure. No reruns
  needed; no roll-forward to r3.
- The sphinx runs print benign `failed to encode ... wrongenc.inc ... iso-8859` git-checkout
  warnings (expected for this repo); run-protocol still exits 0 and produces a model patch.

## 3. Artifact validation

All three valid runs (from `_run.meta.json` / `_pivot_revision.json`):

- `effectiveCapsuleEngine = v2`; `fallbackReason = null`; `contextInjected = yes`.
- Ordered tool telemetry present (`_tool_calls.json`); `capsulePivots` recorded.
- Legacy PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY **absent** (`--disable-pivot-check`).
- Pivot inspection enforcement present; pivot revision pass enabled.

M16-specific:

- `_pivot_first_pass_assistant.txt` exists for all three (3461 / 2862 / 3067 bytes).
- `firstPassPivotDecisions` recorded: sphinx r1 = 0, **sphinx r2 = 1 (RULED_OUT ast.py)**,
  seaborn r2 = 0.
- `testExpectation` recorded for all (source `instance_metadata`, 2 FAIL_TO_PASS each).
- `ruleOutConflicts` recorded: **sphinx r2 = 1** (`test_expectation_conflict`,
  `symbol "unparse" matches FAIL_TO_PASS test test_unparse[()-()]`); sphinx r1 = `[]`;
  seaborn r2 = `[]`.
- `_pivot_revision_prompt.md` includes FAIL_TO_PASS/test expectation, bounded source
  excerpts, and anti-over-edit/minimal-diff guardrails in all three; and includes the
  **conflict section only in sphinx r2** (correctly — the only run with a conflicted rule-out).

Per-run `_pivot_revision.json`:

| field | sphinx r1 | sphinx r2 | seaborn r2 |
|---|---|---|---|
| ran | true | true | true |
| decisionReason | 1 missing/unclear candidate(s) | 1 missing/unclear candidate(s) | 1 missing/unclear candidate(s) |
| firstPassPivotDecisions count | 0 | 1 (RULED_OUT ast.py) | 0 |
| testExpectation source / FTP count | instance_metadata / 2 | instance_metadata / 2 | instance_metadata / 2 |
| ruleOutConflicts count | 0 | **1** | 0 |
| compliance before | unclear=[ast.py::unparse] | unclear=[ast.py::unparse], **conflict=[ast.py::unparse]** | unclear=[relational.py::scatterplot] |
| compliance after | edited=[ast.py::unparse] | edited=[ast.py::unparse] | unclear=[relational.py::scatterplot] |
| replacedFinalPatch (artifact-local) | true | true | false |
| original patch hash | ccaceaf6d253 | b96f2c38d855 | 6424bbc31fed |
| revised patch hash | 89ea31517021 | 703a859ea871 | 6424bbc31fed |
| revised exists / non-empty | yes / yes | yes / yes | yes / yes |
| revised differs from original | yes | yes | **no (identical)** |

Note: `replacedFinalPatch` is internal to the revision pass; the **canonical** Docker
evaluation used the **original** model patch in all three runs (evaluated `modelPatch`
hash == `originalPatch` hash for r1/r2/seaborn). Revised patches are separate artifacts,
never wired into canonical resolution.

## 4. Per-run table

| instance | label | first-pass resolved | marker decision | conflict detected? | revision ran? | revised non-empty? | revised patch files | suppression preserved? | classification |
|---|---|---|---|---|---|---|---|---|---|
| sphinx-7462 | …sphinx-7462-r1 | False | (none emitted; unclear) | n/a (no rule-out) | yes | yes | python.py, **ast.py** | n/a | `m16_sphinx_revision_success` |
| sphinx-7462 | …sphinx-7462-r2 | False | **RULED_OUT ast.py::unparse** | **yes** (test_expectation_conflict) | yes | yes | python.py, **ast.py** | n/a (correctly NOT suppressed) | `m16_guardrail_success` + `m16_sphinx_revision_success` |
| seaborn-3187 | …seaborn-3187-r2 | **True** | (none emitted; unclear) | no (correctly absent) | yes | yes (== original) | scales.py, utils.py | inconclusive-live (no marker); no over-edit | `m16_artifact_success` (inconclusive for suppression) |

## 5. Behavior analysis

- **Did sphinx conflicted rule-out trigger revision?** **Yes, live (sphinx r2).** A grounded
  `RULED_OUT ast.py::unparse` produced a `test_expectation_conflict`, was reclassified
  `unclear_test_conflict`, was **not** suppressed, and the revision ran — the exact M15→M16
  behavior change. (Under M15 the same marker yielded `ran=False`, "patch already
  compliant".)
- **Did sphinx produce a non-empty patch?** **Yes, both runs.** r1 and r2 each produced a
  non-empty revised patch that adds `sphinx/pycode/ast.py::unparse`, and the added hunk is
  the canonical gold fix (empty `ast.Tuple` → `"()"`).
- **Did seaborn suppression remain correct?** **No harm, but inconclusive-live.** No rule-out
  marker was emitted this run, so marker-suppression was not exercised; the revision ran via
  the `unclear` path but **did not over-edit** (revised == original), preserved the canonical
  `resolved=True`, and the conflict detector correctly returned **no conflict** for the
  non-gold `scatterplot` pivot. The suppression-preservation property remains confirmed by
  the M16 offline audit and the M15.1 prior live marker.
- **Did anything over-edit?** **No.** The sphinx revisions add the gold pivot only (desired,
  not noise); seaborn's revision was byte-identical to the original.

## 6. Next recommendation

**A. Implement a safe, read-only shadow evaluation for revised patches.** The guardrail
succeeds live and now reliably produces non-empty revised patches that contain the gold
pivot (sphinx r1/r2 both add the canonical `ast.py::unparse` fix). The open question is
whether these revised patches would actually *resolve* — which only a read-only shadow
evaluation (no wiring into canonical) can answer.

Secondary caveat (not the chosen action): seaborn's marker-based suppression was inconclusive
live; if a future pass wants live re-confirmation, rerun seaborn r2 once only (option C). No
30/100 sweep is warranted yet.

---

*Method note: shadow evaluation was deliberately not performed (no safe zero-code helper
exists in-repo; adding one was out of scope for this task). **No shadow resolution effect is
claimed.** All resolution figures above are first-pass canonical Docker results (sphinx r1=0,
sphinx r2=0, seaborn r2=1), evaluated against the original — not revised — model patch.*
