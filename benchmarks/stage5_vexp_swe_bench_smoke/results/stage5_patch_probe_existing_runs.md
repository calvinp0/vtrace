# Stage 5 patch probe report over existing runs

_Generated: 2026-06-10T13:21:38.572Z_

_Analysis only. Deterministic probes over patches that already exist on disk. No agents, no Docker, no model calls (the sole subprocess is a local `python3 ast.parse`); no raw-artifact mutation. Probes are cheap warning signals, not correctness oracles._

## Summary

Analyzed 12 passive-treatment runs (EDIT_GUARD + PATCH_VERIFY, before/after, across sympy / matplotlib / requests). The deterministic probes flagged this instance's known target defect in 5 run(s) and rated 3 run(s) high-risk overall. Scope was indeterminate from the diff in 2 sympy run(s); 10 run(s) showed no named-test evidence.

| metric | value |
| --- | --- |
| runsAnalyzed | 12 |
| runsWithHighRisk | 3 |
| runsWithKnownDefectLikelyCaught | 5 |
| runsWithUnknownScope | 2 |
| runsWithNoTestEvidence | 10 |

## Method

For each run we read `modelPatch` from the SWE-bench JSONL, the ordered `_tool_calls.json` (for bash command strings), and `_run.stdout.txt` / `_run.stderr.txt`. We then run six deterministic probes over the patch. Each probe returns `pass | warn | fail | unknown` with a confidence and concrete evidence. Probes never claim a patch is correct: a `pass` only means no problem was visible in the diff window, and `unknown` is returned whenever the artifact is insufficient to decide (e.g. class scope not present in the diff). The `python_parse` probe AST-parses only self-contained inserted blocks (a top-level `def`/`class`); fragment-only additions are reported `unknown` rather than falsely failed.

## Probe definitions

| probe | checks | status meaning |
| --- | --- | --- |
| `edited_files` | Which files the unified diff touches. | pass = >=1 edited file parsed; fail = none (empty/malformed diff). |
| `minimality_rewrite_risk` | Broad-rewrite indicators: deletion volume, deleted control-flow lines, multi-file scope. | fail = strong rewrite signal; warn = moderate; pass = small/additive. |
| `python_parse` | AST-parses self-contained inserted Python blocks (top-level def/class) via local python3. | pass = parsed clean; fail = syntax error; unknown = no isolable block or parser unavailable. |
| `inserted_method_scope` | For inserted `def <pattern>` methods, the enclosing class visible in the diff vs the expected class. | pass = in expected class; fail = wrong class; unknown = scope not visible in the diff. |
| `failing_behavior_pattern` | Whether the added code contains the per-instance expected failing-behavior patterns. | pass = >=2 patterns; warn = 1; fail = none; unknown = no config. |
| `test_evidence` | Whether the agent ran a named test suite or an ad-hoc check (from bash tool calls / stdout). | pass = named test (pytest/unittest); warn = ad-hoc check only; fail = none; unknown = no artifacts. |

## Results by run

| run | instance | edited_files | minimality | python_parse | scope | failing_behavior | test_evidence | overall risk | defect caught |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-editguard-before-sympy-16766 | sympy__sympy-16766 | pass | pass | pass | pass | — | warn | medium | no |
| eval-editguard-after-sympy-16766 | sympy__sympy-16766 | pass | pass | pass | unknown | — | pass | low | unknown |
| eval-patchverify-before-sympy-16766 | sympy__sympy-16766 | pass | pass | pass | unknown | — | warn | medium | unknown |
| eval-patchverify-after-sympy-16766 | sympy__sympy-16766 | pass | pass | pass | pass | — | warn | medium | no |
| eval-editguard-before-matplotlib-22719 | matplotlib__matplotlib-22719 | pass | warn | unknown | — | fail | warn | medium | yes |
| eval-editguard-after-matplotlib-22719 | matplotlib__matplotlib-22719 | pass | pass | unknown | — | pass | warn | medium | no |
| eval-patchverify-before-matplotlib-22719 | matplotlib__matplotlib-22719 | pass | pass | unknown | — | pass | warn | medium | no |
| eval-patchverify-after-matplotlib-22719 | matplotlib__matplotlib-22719 | pass | warn | unknown | — | fail | pass | medium | yes |
| eval-editguard-before-requests-5414 | psf__requests-5414 | pass | fail | unknown | — | pass | warn | high | yes |
| eval-editguard-after-requests-5414 | psf__requests-5414 | pass | fail | unknown | — | pass | warn | high | yes |
| eval-patchverify-before-requests-5414 | psf__requests-5414 | pass | fail | unknown | — | pass | warn | high | yes |
| eval-patchverify-after-requests-5414 | psf__requests-5414 | pass | pass | unknown | — | pass | warn | medium | no |

### eval-editguard-before-sympy-16766

- **Instance**: sympy__sympy-16766; edited files: sympy/printing/pycode.py; patch chars: 697.
- **Overall risk**: medium; known defect likely caught: no.
- **edited_files**: pass (high) — Edited files: sympy/printing/pycode.py.
- **minimality_rewrite_risk**: pass (medium) — +7/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **python_parse**: pass (high) — Parsed 1 inserted Python block(s) with no syntax error.
- **inserted_method_scope**: pass (medium) — Inserted method(s) _print_Indexed, _print_IndexedBase appear within the expected class PythonCodePrinter per the diff context (diff-window evidence only; full-file scope not independently confirmed).
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python3 -c " from sympy import IndexedBase from sympy.printing.pycode import pycode p = IndexedBase('p') print('p[0]:', …) but no named test suite (pytest/unittest) was detected.

### eval-editguard-after-sympy-16766

- **Instance**: sympy__sympy-16766; edited files: sympy/printing/pycode.py; patch chars: 678.
- **Overall risk**: low; known defect likely caught: unknown.
- **edited_files**: pass (high) — Edited files: sympy/printing/pycode.py.
- **minimality_rewrite_risk**: pass (medium) — +7/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **python_parse**: pass (high) — Parsed 1 inserted Python block(s) with no syntax error.
- **inserted_method_scope**: unknown (low) — Inserted method(s) _print_Indexed, _print_IndexedBase found, but no enclosing class header is visible in the diff window, so the landing scope cannot be determined from the unified diff alone.
- **test_evidence**: pass (high) — A named test command/run is present: python -m pytest sympy/printing/tests/test_pycode.py -v -x 2>&1 | head -80.

### eval-patchverify-before-sympy-16766

- **Instance**: sympy__sympy-16766; edited files: sympy/printing/pycode.py; patch chars: 508.
- **Overall risk**: medium; known defect likely caught: unknown.
- **edited_files**: pass (high) — Edited files: sympy/printing/pycode.py.
- **minimality_rewrite_risk**: pass (medium) — +4/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **python_parse**: pass (high) — Parsed 1 inserted Python block(s) with no syntax error.
- **inserted_method_scope**: unknown (low) — Inserted method(s) _print_Indexed found, but no enclosing class header is visible in the diff window, so the landing scope cannot be determined from the unified diff alone.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python3 -c " from sympy import * p = IndexedBase('p') print('pycode(p[0]):', pycode(p[0])) print('pycode(p[1, 2]):', pyc…) but no named test suite (pytest/unittest) was detected.

### eval-patchverify-after-sympy-16766

- **Instance**: sympy__sympy-16766; edited files: sympy/printing/pycode.py; patch chars: 614.
- **Overall risk**: medium; known defect likely caught: no.
- **edited_files**: pass (high) — Edited files: sympy/printing/pycode.py.
- **minimality_rewrite_risk**: pass (medium) — +4/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **python_parse**: pass (high) — Parsed 1 inserted Python block(s) with no syntax error.
- **inserted_method_scope**: pass (medium) — Inserted method(s) _print_Indexed appear within the expected class PythonCodePrinter per the diff context (diff-window evidence only; full-file scope not independently confirmed).
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python -c " from sympy import * p = IndexedBase('p') print('Single index:') print(pycode(p[0])) print() print('Multi-ind…) but no named test suite (pytest/unittest) was detected.

### eval-editguard-before-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; edited files: lib/matplotlib/category.py; patch chars: 677.
- **Overall risk**: medium; known defect likely caught: yes.
- **edited_files**: pass (high) — Edited files: lib/matplotlib/category.py.
- **minimality_rewrite_risk**: warn (medium) — +1/-1 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 1. Non-minimal indicators: 1 deleted control-flow line.
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: fail (medium) — Expected behavior patterns matched in added code: [none]; missing: [values.size == 0, return, empty]. None of the expected failing-behavior patterns appear in the added code.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python -W error::DeprecationWarning -c " import matplotlib.pyplot as plt f, ax = plt.subplots() ax.xaxis.update_units(['…) but no named test suite (pytest/unittest) was detected.

### eval-editguard-after-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; edited files: lib/matplotlib/category.py; patch chars: 690.
- **Overall risk**: medium; known defect likely caught: no.
- **edited_files**: pass (high) — Edited files: lib/matplotlib/category.py.
- **minimality_rewrite_risk**: pass (medium) — +2/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: pass (medium) — Expected behavior patterns matched in added code: [values.size == 0, return]; missing: [empty]. Added code appears to directly handle the expected failing behavior.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python -W error::DeprecationWarning -c " import matplotlib.pyplot as plt f, ax = plt.subplots() ax.xaxis.update_units(['…) but no named test suite (pytest/unittest) was detected.

### eval-patchverify-before-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; edited files: lib/matplotlib/category.py; patch chars: 698.
- **Overall risk**: medium; known defect likely caught: no.
- **edited_files**: pass (high) — Edited files: lib/matplotlib/category.py.
- **minimality_rewrite_risk**: pass (medium) — +3/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: pass (medium) — Expected behavior patterns matched in added code: [return, empty]; missing: [values.size == 0]. Added code appears to directly handle the expected failing behavior.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python -W error::DeprecationWarning -c " import matplotlib.pyplot as plt f, ax = plt.subplots() ax.xaxis.update_units(['…) but no named test suite (pytest/unittest) was detected.

### eval-patchverify-after-matplotlib-22719

- **Instance**: matplotlib__matplotlib-22719; edited files: lib/matplotlib/category.py; patch chars: 691.
- **Overall risk**: medium; known defect likely caught: yes.
- **edited_files**: pass (high) — Edited files: lib/matplotlib/category.py.
- **minimality_rewrite_risk**: warn (medium) — +1/-1 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 1. Non-minimal indicators: 1 deleted control-flow line.
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: fail (medium) — Expected behavior patterns matched in added code: [none]; missing: [values.size == 0, return, empty]. None of the expected failing-behavior patterns appear in the added code.
- **test_evidence**: pass (high) — A named test command/run is present: python -m pytest lib/matplotlib/tests/test_category.py -v --tb=short 2>&1 | head -60.

### eval-editguard-before-requests-5414

- **Instance**: psf__requests-5414; edited files: requests/models.py; patch chars: 1564.
- **Overall risk**: high; known defect likely caught: yes.
- **edited_files**: pass (high) — Edited files: requests/models.py.
- **minimality_rewrite_risk**: fail (high) — +10/-10 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 5. Broad-rewrite indicators: 10 deletions (>=8); 5 deleted control-flow lines (>=2).
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: pass (medium) — Expected behavior patterns matched in added code: [empty, label, idna]; missing: [none]. Added code appears to directly handle the expected failing behavior.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python3 -c " import requests from requests.exceptions import InvalidURL try: requests.get('http://.example.com') print('…) but no named test suite (pytest/unittest) was detected.

### eval-editguard-after-requests-5414

- **Instance**: psf__requests-5414; edited files: requests/models.py; patch chars: 1324.
- **Overall risk**: high; known defect likely caught: yes.
- **edited_files**: pass (high) — Edited files: requests/models.py.
- **minimality_rewrite_risk**: fail (high) — +6/-10 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 5. Broad-rewrite indicators: 10 deletions (>=8); 5 deleted control-flow lines (>=2).
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: pass (medium) — Expected behavior patterns matched in added code: [empty, label, idna]; missing: [none]. Added code appears to directly handle the expected failing behavior.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python3 -c "import requests; requests.get('http://.example.com')" 2>&1 | head -30) but no named test suite (pytest/unittest) was detected.

### eval-patchverify-before-requests-5414

- **Instance**: psf__requests-5414; edited files: requests/models.py; patch chars: 1047.
- **Overall risk**: high; known defect likely caught: yes.
- **edited_files**: pass (high) — Edited files: requests/models.py.
- **minimality_rewrite_risk**: fail (high) — +6/-6 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 5. Broad-rewrite indicators: 5 deleted control-flow lines (>=2).
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: pass (medium) — Expected behavior patterns matched in added code: [label, idna]; missing: [empty]. Added code appears to directly handle the expected failing behavior.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python3 -c " import requests from requests.exceptions import InvalidURL try: requests.get('http://.example.com') except …) but no named test suite (pytest/unittest) was detected.

### eval-patchverify-after-requests-5414

- **Instance**: psf__requests-5414; edited files: requests/models.py; patch chars: 643.
- **Overall risk**: medium; known defect likely caught: no.
- **edited_files**: pass (high) — Edited files: requests/models.py.
- **minimality_rewrite_risk**: pass (medium) — +5/-0 lines across 1 file(s), 1 hunk(s); deleted control-flow lines: 0. Patch appears small/additive (few or no deletions, single file).
- **python_parse**: unknown (low) — No self-contained Python block (top-level def/class) could be isolated from the added lines; fragment-only additions cannot be parsed reliably without full file content.
- **failing_behavior_pattern**: pass (medium) — Expected behavior patterns matched in added code: [label, idna]; missing: [empty]. Added code appears to directly handle the expected failing behavior.
- **test_evidence**: warn (medium) — Ad-hoc python check(s) ran (e.g. python -c " import requests try: requests.get('http://.example.com') except requests.exceptions.InvalidURL as e: print('…) but no named test suite (pytest/unittest) was detected.

## Results by instance

| instance | known defect | target probe | runs | caught | not flagged | unknown |
| --- | --- | --- | --- | --- | --- | --- |
| sympy__sympy-16766 | wrong class/function/class-scope placement (methods in AbstractPythonCodePrinter instead of PythonCodePrinter) | `inserted_method_scope` | 4 | 0 | 2 | 2 |
| matplotlib__matplotlib-22719 | patch did not fully handle the failing empty-array behavior (missing early return for empty input) | `failing_behavior_pattern` | 4 | 2 | 2 | 0 |
| psf__requests-5414 | broad control-flow rewrite instead of minimal additive validation | `minimality_rewrite_risk` | 4 | 3 | 1 | 0 |

## Which known defects were caught

- **sympy__sympy-16766** (target probe `inserted_method_scope`): flagged in 0/4 run(s), not flagged in 2, indeterminate in 2.
- **matplotlib__matplotlib-22719** (target probe `failing_behavior_pattern`): flagged in 2/4 run(s), not flagged in 2, indeterminate in 0.
- **psf__requests-5414** (target probe `minimality_rewrite_risk`): flagged in 3/4 run(s), not flagged in 1, indeterminate in 0.

Read conservatively: a defect is "caught" only for the runs whose patch actually exhibits it. Where a run's patch did not exhibit the signature defect (e.g. a PATCH_VERIFY run that happened to add the empty-array return, or a minimal-additive requests patch), the probe correctly does NOT flag it — that is a true negative, not a miss.

## Probe limitations

- **Scope is diff-window-only.** `inserted_method_scope` can confirm the enclosing class only when a `class` header is visible in the same hunk; otherwise it returns `unknown`. It cannot see the full file, so it cannot catch a wrong-scope insertion whose surrounding class is off-screen.
- **python_parse is partial.** It parses only self-contained inserted blocks. Fragment edits (a changed expression, an `else:` whose `if` is unchanged) are `unknown`, and it never reconstructs/parses the whole file.
- **failing_behavior_pattern is a substring heuristic.** It can be fooled by patterns that appear textually without actually handling the behavior, and it depends on a hand-written per-instance pattern list.
- **minimality is a size/control-flow heuristic.** A legitimately larger fix can look like a broad rewrite, and a subtly-wrong tiny patch looks minimal.
- **test_evidence proves a command ran, not that it passed.** It never asserts a test outcome.

## Recommended next step

Add the critic schema + a report-only dry run that consumes these probe outputs as input — still WITHOUT repair. The deterministic probes already flag real risk on a meaningful subset of runs (broad-rewrite and missing-failing-behavior signals), which is enough deterministic signal to justify a critic dry run.

Reliable enough to feed a critic now: `edited_files`, `minimality_rewrite_risk`, and `failing_behavior_pattern` (with its caveats). Still weak / mostly `unknown`: `inserted_method_scope` (needs full-file reconstruction) and `python_parse` (needs whole-file content). The requests broad-rewrite and matplotlib missing-empty-array signals are the strongest deterministic catches; the sympy scope defect remains largely invisible to cheap probes.

## Non-claims

- These probes are cheap deterministic warning signals, not correctness checks; Docker resolution remains the only ground truth.
- A `pass` means a probe found no problem in the diff window — not that the patch is correct.
- An `unknown` is an honest measurement gap (e.g. scope not visible in the diff), not a pass.
- This does not run agents, Docker, or any model; it only inspects existing artifacts.
- This does not implement the critic or repair loop, and changes no retrieval / Capsule / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior.
- Probe heuristics are tuned against three known losses and may not generalize without further validation.

