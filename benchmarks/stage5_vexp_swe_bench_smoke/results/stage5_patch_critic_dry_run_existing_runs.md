# Stage 5 patch critic dry run over existing runs

_Generated: 2026-06-10T15:30:47.954Z_

_Report-only dry run of a DETERMINISTIC/mock critic over patches that already exist on disk. No agents, no Docker, no model calls, NO repair (the sole subprocess is a local `python3 ast.parse`); no raw-artifact mutation. The critic dimensions are warning signals, not correctness oracles._

## Summary

A deterministic critic consumed the milestone-2 probe outputs for 12 passive-treatment runs (EDIT_GUARD + PATCH_VERIFY, before/after, across sympy / matplotlib / requests). It would have requested a bounded repair on 5 run(s): 3 high-risk, 2 medium-risk. 7 run(s) were low-risk and 0 unknown-risk. The known target defect was likely caught in 5 run(s). Scope stayed indeterminate from the diff in 2 sympy run(s); 10 run(s) showed no named-test evidence.

| metric | value |
| --- | --- |
| runsAnalyzed | 12 |
| repairRequiredCount | 5 |
| highRiskCount | 3 |
| mediumRiskCount | 2 |
| lowRiskCount | 7 |
| unknownRiskCount | 0 |
| scopeUnknownCount | 2 |
| missingTestEvidenceCount | 10 |
| knownDefectLikelyCaughtCount | 5 |

## Method

For each run we ran the deterministic milestone-2 probes over the first patch (`modelPatch`) plus the ordered tool-call / stdout artifacts, then passed the resulting `PatchProbeSummary` — together with bounded run metadata (treatment flags, ordered-tool-log presence) — into `buildDeterministicPatchCriticReport`. The critic maps each probe status onto a structured dimension: a probe `pass` passes the dimension; `fail`/`warn` fails it and (except for test evidence) becomes a repair signal; `unknown`/absent leaves the dimension `null` (NOT a pass) and never forces repair on its own. A high-confidence fail (wrong scope, broad rewrite, syntax error) forces `repair_required` at high confidence; medium signals (missing failing behavior, non-minimal patch) request repair at medium confidence; unknown scope and weak test evidence are recorded but cannot force repair alone. Every report was validated against the contract; all passed.

## Critic input/output contract

**Input** (`PatchCriticInput`, bounded — no full repo, no gold patch, no hidden tests): `instanceId`, `runLabel`, `repo`, optional `issueText`, `firstPatch` (unified diff), `editedFiles`, `patchChars`, `probeSummary` (the deterministic probe output), `treatmentMetadata` (pivotCheck/editGuard/patchVerify injected), and `contextSignals` (hidden-pivot engagement, ordered-tool-log presence).

**Output** (`PatchCriticReport`): four dimensions each with `*_ok | null` + a non-empty `*_evidence` string (`scope`, `failing_behavior`, `minimality`, `test_evidence`); an overall `risk` (`low|medium|high|unknown`); a `repair_required` boolean with `repair_reason` + `repair_instructions`; a `confidence` (`low|medium|high`); and `evidence_probe_ids` listing the probes consumed. Validation rules: evidence strings must be non-empty; `null` is not a pass; high-confidence fail signals must set `repair_required=true`; unknown scope or weak test evidence alone must not.

## Results by run

| run | instance | scope_ok | failing_behavior | minimality_ok | test_evidence_ok | risk | confidence | repair |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-editguard-before-sympy-16766 | sympy__sympy-16766 | true | null | true | false | low | medium | no |
| eval-editguard-after-sympy-16766 | sympy__sympy-16766 | null | null | true | true | low | low | no |
| eval-patchverify-before-sympy-16766 | sympy__sympy-16766 | null | null | true | false | low | low | no |
| eval-patchverify-after-sympy-16766 | sympy__sympy-16766 | true | null | true | false | low | medium | no |
| eval-editguard-before-matplotlib-22719 | matplotlib__matplotlib-22719 | null | false | false | false | medium | medium | yes |
| eval-editguard-after-matplotlib-22719 | matplotlib__matplotlib-22719 | null | true | true | false | low | medium | no |
| eval-patchverify-before-matplotlib-22719 | matplotlib__matplotlib-22719 | null | true | true | false | low | medium | no |
| eval-patchverify-after-matplotlib-22719 | matplotlib__matplotlib-22719 | null | false | false | true | medium | medium | yes |
| eval-editguard-before-requests-5414 | psf__requests-5414 | null | true | false | false | high | high | yes |
| eval-editguard-after-requests-5414 | psf__requests-5414 | null | true | false | false | high | high | yes |
| eval-patchverify-before-requests-5414 | psf__requests-5414 | null | true | false | false | high | high | yes |
| eval-patchverify-after-requests-5414 | psf__requests-5414 | null | true | true | false | low | medium | no |

### eval-editguard-before-sympy-16766

- **Instance**: sympy__sympy-16766; risk: low; confidence: medium.
- **scope_ok**: true — Inserted method(s) _print_Indexed, _print_IndexedBase appear within the expected class PythonCodePrinter per the diff context (diff-window evidence only; full-file scope not independently confirmed).
- **failing_behavior_handled**: null — No failing-behavior pattern configured for this instance; failing-behavior coverage cannot be assessed from the diff.
- **minimality_ok**: true — +7/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python3 -c " from sympy import IndexedBase from sympy.printing.pycode import pycode p = IndexedBase('p') print('p[0]:', …) but no named test suite (pytest/unittest) was detected.
- **repair_required**: no — No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, inserted_method_scope, test_evidence.

### eval-editguard-after-sympy-16766

- **Instance**: sympy__sympy-16766; risk: low; confidence: low.
- **scope_ok**: null — Inserted method(s) _print_Indexed, _print_IndexedBase found, but no enclosing class header is visible in the diff window, so the landing scope cannot be determined from the unified diff alone.
- **failing_behavior_handled**: null — No failing-behavior pattern configured for this instance; failing-behavior coverage cannot be assessed from the diff.
- **minimality_ok**: true — +7/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **test_evidence_ok**: true — A named test command/run is present: python -m pytest sympy/printing/tests/test_pycode.py -v -x 2>&1 | head -80.
- **repair_required**: no — No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, inserted_method_scope, test_evidence.

### eval-patchverify-before-sympy-16766

- **Instance**: sympy__sympy-16766; risk: low; confidence: low.
- **scope_ok**: null — Inserted method(s) _print_Indexed found, but no enclosing class header is visible in the diff window, so the landing scope cannot be determined from the unified diff alone.
- **failing_behavior_handled**: null — No failing-behavior pattern configured for this instance; failing-behavior coverage cannot be assessed from the diff.
- **minimality_ok**: true — +4/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python3 -c " from sympy import * p = IndexedBase('p') print('pycode(p[0]):', pycode(p[0])) print('pycode(p[1, 2]):', pyc…) but no named test suite (pytest/unittest) was detected.
- **repair_required**: no — No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, inserted_method_scope, test_evidence.

### eval-patchverify-after-sympy-16766

- **Instance**: sympy__sympy-16766; risk: low; confidence: medium.
- **scope_ok**: true — Inserted method(s) _print_Indexed appear within the expected class PythonCodePrinter per the diff context (diff-window evidence only; full-file scope not independently confirmed).
- **failing_behavior_handled**: null — No failing-behavior pattern configured for this instance; failing-behavior coverage cannot be assessed from the diff.
- **minimality_ok**: true — +4/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python -c " from sympy import * p = IndexedBase('p') print('Single index:') print(pycode(p[0])) print() print('Multi-ind…) but no named test suite (pytest/unittest) was detected.
- **repair_required**: no — No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, inserted_method_scope, test_evidence.

### eval-editguard-before-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; risk: medium; confidence: medium.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: false — Expected behavior patterns matched in added code: [none]; missing: [values.size == 0, return, empty]. None of the expected failing-behavior patterns appear in the added code.
- **minimality_ok**: false — +1/-1 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 1. Non-minimal indicators: 1 deleted control-flow line.
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python -W error::DeprecationWarning -c " import matplotlib.pyplot as plt f, ax = plt.subplots() ax.xaxis.update_units(['…) but no named test suite (pytest/unittest) was detected.
- **repair_required**: yes — expected failing behavior not handled (no matching added code); non-minimal patch (deleted control-flow / net-negative hunk).
- **repair_instructions**: Add an explicit empty-array handling path in lib/matplotlib/category.py before the code path that assumes non-empty values. Prefer a minimal additive change in lib/matplotlib/category.py instead of deleting/restructuring the existing control flow.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

### eval-editguard-after-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; risk: low; confidence: medium.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: true — Expected behavior patterns matched in added code: [values.size == 0, return]; missing: [empty]. Added code appears to directly handle the expected failing behavior.
- **minimality_ok**: true — +2/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python -W error::DeprecationWarning -c " import matplotlib.pyplot as plt f, ax = plt.subplots() ax.xaxis.update_units(['…) but no named test suite (pytest/unittest) was detected.
- **repair_required**: no — No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

### eval-patchverify-before-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; risk: low; confidence: medium.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: true — Expected behavior patterns matched in added code: [return, empty]; missing: [values.size == 0]. Added code appears to directly handle the expected failing behavior.
- **minimality_ok**: true — +3/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python -W error::DeprecationWarning -c " import matplotlib.pyplot as plt f, ax = plt.subplots() ax.xaxis.update_units(['…) but no named test suite (pytest/unittest) was detected.
- **repair_required**: no — No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

### eval-patchverify-after-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; risk: medium; confidence: medium.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: false — Expected behavior patterns matched in added code: [none]; missing: [values.size == 0, return, empty]. None of the expected failing-behavior patterns appear in the added code.
- **minimality_ok**: false — +1/-1 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 1. Non-minimal indicators: 1 deleted control-flow line.
- **test_evidence_ok**: true — A named test command/run is present: python -m pytest lib/matplotlib/tests/test_category.py -v --tb=short 2>&1 | head -60.
- **repair_required**: yes — expected failing behavior not handled (no matching added code); non-minimal patch (deleted control-flow / net-negative hunk).
- **repair_instructions**: Add an explicit empty-array handling path in lib/matplotlib/category.py before the code path that assumes non-empty values. Prefer a minimal additive change in lib/matplotlib/category.py instead of deleting/restructuring the existing control flow.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

### eval-editguard-before-requests-5414

- **Instance**: psf__requests-5414; risk: high; confidence: high.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: true — Expected behavior patterns matched in added code: [empty, label, idna]; missing: [none]. Added code appears to directly handle the expected failing behavior.
- **minimality_ok**: false — +10/-10 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 5. Broad-rewrite indicators: 10 deletions (>=8); 5 deleted control-flow lines (>=2).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python3 -c " import requests from requests.exceptions import InvalidURL try: requests.get('http://.example.com') print('…) but no named test suite (pytest/unittest) was detected.
- **repair_required**: yes — broad control-flow rewrite where a minimal additive change would suffice (high-confidence).
- **repair_instructions**: Prefer a minimal additive validation for empty/invalid IDNA labels instead of restructuring the existing unicode_is_ascii control flow.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

### eval-editguard-after-requests-5414

- **Instance**: psf__requests-5414; risk: high; confidence: high.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: true — Expected behavior patterns matched in added code: [empty, label, idna]; missing: [none]. Added code appears to directly handle the expected failing behavior.
- **minimality_ok**: false — +6/-10 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 5. Broad-rewrite indicators: 10 deletions (>=8); 5 deleted control-flow lines (>=2).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python3 -c "import requests; requests.get('http://.example.com')" 2>&1 | head -30) but no named test suite (pytest/unittest) was detected.
- **repair_required**: yes — broad control-flow rewrite where a minimal additive change would suffice (high-confidence).
- **repair_instructions**: Prefer a minimal additive validation for empty/invalid IDNA labels instead of restructuring the existing unicode_is_ascii control flow.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

### eval-patchverify-before-requests-5414

- **Instance**: psf__requests-5414; risk: high; confidence: high.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: true — Expected behavior patterns matched in added code: [label, idna]; missing: [empty]. Added code appears to directly handle the expected failing behavior.
- **minimality_ok**: false — +6/-6 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 5. Broad-rewrite indicators: 5 deleted control-flow lines (>=2).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python3 -c " import requests from requests.exceptions import InvalidURL try: requests.get('http://.example.com') except …) but no named test suite (pytest/unittest) was detected.
- **repair_required**: yes — broad control-flow rewrite where a minimal additive change would suffice (high-confidence).
- **repair_instructions**: Prefer a minimal additive validation for empty/invalid IDNA labels instead of restructuring the existing unicode_is_ascii control flow.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

### eval-patchverify-after-requests-5414

- **Instance**: psf__requests-5414; risk: low; confidence: medium.
- **scope_ok**: null — No class-scope probe applies to this instance (no inserted-method pattern configured); scope cannot be assessed from the diff.
- **failing_behavior_handled**: true — Expected behavior patterns matched in added code: [label, idna]; missing: [empty]. Added code appears to directly handle the expected failing behavior.
- **minimality_ok**: true — +5/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **test_evidence_ok**: false — Ad-hoc python check(s) ran (e.g. python -c " import requests try: requests.get('http://.example.com') except requests.exceptions.InvalidURL as e: print('…) but no named test suite (pytest/unittest) was detected.
- **repair_required**: no — No high- or medium-confidence defect signal; deterministic probes are pass/unknown only, so no repair is requested.
- **evidence probes**: edited_files, minimality_rewrite_risk, python_parse, failing_behavior_pattern, test_evidence.

## Results by instance

| instance | known defect | target probe | runs | repair required | defect caught | scope unknown |
| --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | wrong class/function/class-scope placement (methods in AbstractPythonCodePrinter instead of PythonCodePrinter) | `inserted_method_scope` | 4 | 0 | 0 | 2 |
| matplotlib__matplotlib-22719 | patch did not fully handle the failing empty-array behavior (missing early return for empty input) | `failing_behavior_pattern` | 4 | 2 | 2 | 0 |
| psf__requests-5414 | broad control-flow rewrite instead of minimal additive validation | `minimality_rewrite_risk` | 4 | 3 | 3 | 0 |

## Repair-required analysis

The critic would request repair on 5/12 run(s). Each request is backed by a concrete probe fail and carries actionable, patch-modifying instructions:

- **eval-editguard-before-matplotlib-22719** (medium risk, medium confidence): expected failing behavior not handled (no matching added code); non-minimal patch (deleted control-flow / net-negative hunk). → Add an explicit empty-array handling path in lib/matplotlib/category.py before the code path that assumes non-empty values. Prefer a minimal additive change in lib/matplotlib/category.py instead of deleting/restructuring the existing control flow.
- **eval-patchverify-after-matplotlib-22719** (medium risk, medium confidence): expected failing behavior not handled (no matching added code); non-minimal patch (deleted control-flow / net-negative hunk). → Add an explicit empty-array handling path in lib/matplotlib/category.py before the code path that assumes non-empty values. Prefer a minimal additive change in lib/matplotlib/category.py instead of deleting/restructuring the existing control flow.
- **eval-editguard-before-requests-5414** (high risk, high confidence): broad control-flow rewrite where a minimal additive change would suffice (high-confidence). → Prefer a minimal additive validation for empty/invalid IDNA labels instead of restructuring the existing unicode_is_ascii control flow.
- **eval-editguard-after-requests-5414** (high risk, high confidence): broad control-flow rewrite where a minimal additive change would suffice (high-confidence). → Prefer a minimal additive validation for empty/invalid IDNA labels instead of restructuring the existing unicode_is_ascii control flow.
- **eval-patchverify-before-requests-5414** (high risk, high confidence): broad control-flow rewrite where a minimal additive change would suffice (high-confidence). → Prefer a minimal additive validation for empty/invalid IDNA labels instead of restructuring the existing unicode_is_ascii control flow.

Strong (high-confidence) signals that force repair: wrong inserted-method scope, broad control-flow rewrite, and inserted-block syntax errors. Medium signals that request repair: missing/partial failing-behavior handling and non-minimal (control-flow-deleting) patches. Weak test evidence and unknown scope are recorded but never force repair on their own.

## Unknown / insufficient-signal cases

These runs lack enough deterministic signal for the critic to act. They are reported honestly as `null` / `unknown` rather than passed, and would need better probes (full-file reconstruction) or a live critic with wider context to resolve:

- **eval-editguard-after-sympy-16766** (sympy__sympy-16766): inserted-method scope not visible in the diff window. Inserted method(s) _print_Indexed, _print_IndexedBase found, but no enclosing class header is visible in the diff window, so the landing scope cannot be determined from the unified diff alone.
- **eval-patchverify-before-sympy-16766** (sympy__sympy-16766): inserted-method scope not visible in the diff window. Inserted method(s) _print_Indexed found, but no enclosing class header is visible in the diff window, so the landing scope cannot be determined from the unified diff alone.

The sympy wrong-scope defect is the clearest gap: the deterministic `inserted_method_scope` probe can only see the diff window, so when no `class` header is present it returns `unknown` and the critic correctly declines to force a repair. Catching that defect reliably requires full-file reconstruction (apply the patch to a snapshot and AST-resolve the enclosing class), not a cheap diff heuristic.

## Probe limitations exposed

- **Scope is diff-window-only.** The critic inherits `inserted_method_scope`'s blindness: it cannot judge landing scope when the enclosing `class` header is off-screen, so the sympy defect stays `null` and uncaught.
- **failing_behavior is a substring heuristic.** `failing_behavior_handled` is only as good as the per-instance pattern list; textual matches can mask a behaviorally-incomplete patch.
- **minimality is a size/control-flow heuristic.** A legitimately larger fix can read as a broad rewrite, and a subtly-wrong tiny patch reads as minimal.
- **test_evidence proves a command ran, not that it passed.** `test_evidence_ok` never asserts an outcome, which is why it cannot force repair on its own.
- **No first-vs-final ground truth.** This dry run cannot say a requested repair would have resolved the task; only Docker can.

## Recommended next step

B (with an A prerequisite for one dimension). Add a disabled-by-default LIVE critic invocation that writes `_patch_critic_input.json` / `_patch_critic_report.json` but takes NO repair action. The deterministic critic already converts 5 run(s) of real risk (broad-rewrite and missing-failing-behavior signals) into concrete, actionable repair instructions, which is enough deterministic grounding to justify a report-only live critic next. HOWEVER, the sympy wrong-scope defect remains invisible to cheap probes (scope undetermined in 2 run(s), 0 caught), so implement full-file reconstruction for the scope probe (option A) FIRST for that dimension — otherwise the live critic inherits the same blind spot.

## Non-claims

- This is a REPORT-ONLY dry run of a DETERMINISTIC/mock critic; it calls no model, runs no agents, no Docker, and attempts no repair.
- It mutates no raw artifact; it only reads existing run outputs and writes its own report.
- `repair_required = true` here means a critic *would request* one bounded repair — no repair is performed, and the effect on resolution is not measured.
- A critic dimension that passes means a probe found no problem in the diff window — not that the patch is correct. Docker resolution remains the only ground truth.
- `null` (scope/failing-behavior/test) is an honest measurement gap, not a pass, and never forces repair on its own.
- The deterministic critic mirrors the eventual live critic's contract but not its reasoning; it is tuned to three known losses and may not generalize.
- This changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior.

