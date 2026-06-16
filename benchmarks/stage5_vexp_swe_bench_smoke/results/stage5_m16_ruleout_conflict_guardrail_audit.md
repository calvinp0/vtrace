# Stage 5 — M16 rule-out conflict guardrail offline audit

Offline recomputation (no agents, no Docker, no retrieval) over the five valid
M15.1 labels. For each first-pass grounded `RULED_OUT`, does the M16 guardrail now
treat it as a test-expectation **conflict** (kept revision-triggering) or still
credit it as `ruledOut` (suppressed)? NEW compliance is derived from the stored
OLD verdict by re-classifying each OLD `ruledOut` through the real exported
`detectRuleOutConflict` — the only branch M16 changes.

| label | candidate | first-pass marker | old result | new result | conflict? | revision would run? | why |
|---|---|---|---|---|---|---|---|
| sphinx-7462-r1 | `sphinx/pycode/ast.py::unparse` | RULED_OUT | ruledOut (suppressed) | unclear_test_conflict | **yes** | yes | symbol "unparse" matches FAIL_TO_PASS test test_unparse[()-()] |
| sphinx-7462-r2 | `sphinx/pycode/ast.py::unparse` | (none) | unclear | unclear | no | yes | inspected/no grounded marker |
| seaborn-3187-r1 | `seaborn/relational.py::scatterplot` | (none) | edited | edited | no | no | file in final patch |
| seaborn-3187-r2 | `seaborn/relational.py::scatterplot` | RULED_OUT | ruledOut (suppressed) | ruledOut (suppressed) | no | no | grounded rule-out, no test-expectation conflict → still suppressed |
| seaborn-3187-r3 | `seaborn/relational.py::scatterplot` | (none) | unclear | unclear | no | yes | inspected/no grounded marker |

Test expectation (FAIL_TO_PASS) per case is shown via the conflict reasoning; the
guardrail matches the candidate symbol / file stem against the FAIL_TO_PASS test's
METHOD leaf only (not the test file path or class).

## Expected vs observed

- **sphinx r1** (`ast.py::unparse`): old = ruledOut (suppressed); new = **unclear_test_conflict**; conflict = true; revision would run = **yes**. Expected: ruledOut→unclear_test_conflict, revision runs. ✓
- **seaborn r2** (`relational.py::scatterplot`): old = ruledOut (suppressed); new = **ruledOut (suppressed)**; conflict = false. Expected: stays ruledOut/suppressed (non-gold; symbol/file absent from the failing method). ✓
- **sphinx r2** / **seaborn r1, r3**: no first-pass grounded rule-out to re-classify; their (edited / unclear) verdicts are unchanged, so revision behavior is identical to M15.1.

Net effect: the guardrail flips exactly the sphinx r1 false suppression to a
revision-triggering conflict, and leaves the correct seaborn r2 suppression — and
every non-rule-out verdict — untouched.
