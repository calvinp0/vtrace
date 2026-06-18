# Stage 5 — M48 rule-out sufficiency validator

Offline replay only: captured artifacts and synthetic fixtures; no live agents, Docker, verifier, revision pass, or canonical evaluation.

## 1. Executive verdict

- Can Option B fire fairly on sphinx? **Yes** (6/6 M46 runs).
- Does it stay silent on negatives? **Yes** (4/4).
- Should M49 implement it? **Yes**.
- Recommendation: **A. M49 implement rule-out sufficiency checker, default-off, corrective-prompt-only.**

## 2. Validator design

The pure checker fires only when a semantic-edit hypothesis supplies an operation-like same-name group across files; the first-pass patch edits one member but not its pair; the pair was surfaced/read/mentioned; the agent rules it out using crash/no-exception/safe-empty reasoning; and no concrete repository evidence justifies output preservation. Missing patches produce `insufficient_artifact`; all other incomplete conjunctions produce `no_fire`.

The artifact adapter reconstructs the M39 hypothesis from captured capsule source blocks when the rendered hypothesis section is absent. Evaluation expectations (`shouldFire`) are attached only after the checker decision and are not checker inputs.

## 3. Positive sphinx validation

| label | ast surfaced/read/mentioned | python.py edited | ast.py edited | rule-out shape | fired? | leakage? | corrective prompt safe? |
|---|---:|---:|---:|---|---:|---|---:|
| eval-m46-control-sphinx-7462-r1 | yes | yes | no | crash/safe-empty without output evidence | yes | none | yes |
| eval-m46-control-sphinx-7462-r2 | yes | yes | no | crash/safe-empty without output evidence | yes | none | yes |
| eval-m46-control-sphinx-7462-r3 | yes | yes | no | crash/safe-empty without output evidence | yes | none | yes |
| eval-m46-treatment-sphinx-7462-r1 | yes | yes | no | crash/safe-empty without output evidence | yes | none | yes |
| eval-m46-treatment-sphinx-7462-r2 | yes | yes | no | crash/safe-empty without output evidence | yes | none | yes |
| eval-m46-treatment-sphinx-7462-r3 | yes | yes | no | crash/safe-empty without output evidence | yes | none | yes |

All six M46 runs expose the same fair trigger shape: paired `unparse`, `python.py` edited, `ast.py` unedited but inspected/mentioned, and a `join()`/empty-safe rule-out that does not cite output-preserving repository evidence.

## 4. Negative validation

| instance | label/source | expected no-fire reason | actual decision | leakage? |
|---|---|---|---|---|
| mwaskom__seaborn-3187 | eval-m32-product-vtrace-seaborn-3187-r1 | no paired same-operation crash-shaped rule-out | no_fire: paired same-operation hypothesis group | none |
| django__django-13195 | eval-m32-product-vtrace-django-13195-r1 | synthesis/localization shape, not paired output rule-out | no_fire: paired same-operation hypothesis group | none |
| pydata__xarray-3677 | eval-m32-product-vtrace-xarray-3677-r1 | no paired output-like implementation rule-out | no_fire: paired same-operation hypothesis group | none |
| django__django-10880 | eval-m32-product-vtrace-django-10880-r1 | localized/no-context-safe case | no_fire: paired same-operation hypothesis group | none |

## 5. Synthetic fixture validation

| fixture | expected | actual | reason |
|---|---|---|---|
| crash-shaped paired rule-out | fire | fire | same-operation pair; one edit; safe-empty rule-out; no output evidence |
| accepted output-preserving rule-out | no_fire | no_fire | caller/docstring evidence explicitly supports empty output |

## 6. Leakage audit

Checker inputs used **no** gold files, gold patches, FAIL_TO_PASS, PASS_TO_PASS, hidden test names, benchmark resolved status, or benchmark labels. Those concepts are excluded from the input type and decision function. Instance/label and `shouldFire` are report identity/evaluation fields only; the decision logic does not branch on them.

| prohibited input | used by checker? |
|---|---:|
| gold files / gold patches | no |
| FAIL_TO_PASS | no |
| PASS_TO_PASS | no |
| hidden test names | no |
| benchmark resolved status | no |
| benchmark label as decision input | no |

## 7. Limitations

- The checker cannot prove the hidden expected output; it only detects that a rule-out failed to justify output correctness.
- A corrective prompt may still fail to produce a resolving edit.
- Reliable replay depends on readable first-pass rule-out prose or a `PIVOT_DECISION` marker.
- Legitimate empty-output behavior can false-trigger if the agent omits its concrete repository evidence.
- The validator generates a prompt preview only; it does not execute a corrective pass or auto-adopt a revised patch.

## 8. Recommendation

**A. M49 implement rule-out sufficiency checker, default-off, corrective-prompt-only.**

The validator passes because the trigger fires on 6/6 budget-fixed sphinx artifacts, remains silent on all four captured negatives and the accepted-rule-out fixture, and uses no oracle-derived checker input.
