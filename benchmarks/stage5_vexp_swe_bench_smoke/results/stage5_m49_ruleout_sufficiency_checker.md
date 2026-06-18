# Stage 5 — M49 rule-out sufficiency checker

Offline replay only. Existing captured artifacts were used; no live agent, Docker, verifier, shadow evaluation, or canonical SWE-bench evaluation ran.

## 1. Executive verdict

- Checker implemented: **yes**.
- Default-off: **yes**.
- Sphinx offline fire rate when enabled: **6/6**.
- Negative silence: **4/4 plus accepted synthetic**.
- Oracle leakage avoided: **yes**.

## 2. Implementation details

- `src/capsuleV2/ruleoutSufficiency.ts`: pure trigger, prompt, metadata, and compliance reclassification.
- `run_stage5_vexp_swe_bench_smoke.ts`: default-off CLI flag, post-first-pass artifact persistence, and optional M13 compliance integration.
- `_ruleout_sufficiency_check.json`: additive decision metadata when enabled.
- `_ruleout_sufficiency_corrective_prompt.md`: written only when the checker triggers.

## 3. Checker decision model

The checker requires a paired same-operation semantic hypothesis, a non-empty first-pass patch editing one implementation but not its pair, evidence that the pair was surfaced/read/mentioned, an explicit rule-out, crash/no-exception/safe-empty reasoning, and no concrete repository evidence of output or behavior preservation. Any missing condition produces no trigger.

## 4. Sphinx offline validation

| label | flag enabled? | fired? | original decision | effective decision | paired operation | edited implementation | ruled-out implementation | prompt safe? |
|---|---:|---:|---|---|---|---|---|---:|
| eval-m46-control-sphinx-7462-r1 | yes | yes | ruledOut | unclear | unparse | sphinx/domains/python.py::unparse | sphinx/pycode/ast.py::unparse | yes |
| eval-m46-control-sphinx-7462-r2 | yes | yes | ruledOut | unclear | unparse | sphinx/domains/python.py::unparse | sphinx/pycode/ast.py::unparse | yes |
| eval-m46-control-sphinx-7462-r3 | yes | yes | ruledOut | unclear | unparse | sphinx/domains/python.py::unparse | sphinx/pycode/ast.py::unparse | yes |
| eval-m46-treatment-sphinx-7462-r1 | yes | yes | ruledOut | unclear | unparse | sphinx/domains/python.py::unparse | sphinx/pycode/ast.py::unparse | yes |
| eval-m46-treatment-sphinx-7462-r2 | yes | yes | ruledOut | unclear | unparse | sphinx/domains/python.py::unparse | sphinx/pycode/ast.py::unparse | yes |
| eval-m46-treatment-sphinx-7462-r3 | yes | yes | ruledOut | unclear | unparse | sphinx/domains/python.py::unparse | sphinx/pycode/ast.py::unparse | yes |

Disabled replay: 0/6 triggered and 0/6 produced a corrective prompt preview.

## 5. Negative validation

| instance/fixture | decision | reason | prompt emitted? |
|---|---|---|---:|
| mwaskom__seaborn-3187 | no trigger | paired same-operation semantic hypothesis | no |
| django__django-13195 | no trigger | paired same-operation semantic hypothesis | no |
| pydata__xarray-3677 | no trigger | paired same-operation semantic hypothesis | no |
| django__django-10880 | no trigger | paired same-operation semantic hypothesis | no |
| accepted synthetic output-preserving rule-out | no trigger | rule-out for b.py::render contains concrete output-preserving evidence | no |

## 6. Leakage audit

The checker decision used no gold patches, hidden tests, `FAIL_TO_PASS`, `PASS_TO_PASS`, resolved status, or benchmark labels. Captured labels above are report identities only and are not inputs to the decision function.

| prohibited input | used? |
|---|---:|
| gold patches | no |
| hidden tests | no |
| FAIL_TO_PASS | no |
| PASS_TO_PASS | no |
| resolved status | no |
| benchmark labels as decision input | no |

## 7. Artifact/metadata examples

```json
{
  "enabled": true,
  "triggered": true,
  "triggerKind": "cross_implementation_output_ruleout_insufficient",
  "oracleFree": true,
  "originalDecision": "ruledOut",
  "effectiveDecision": "unclear",
  "pairedOperation": "unparse",
  "canonicalReplaced": false,
  "adoptionEligible": false
}
```

## 8. Safety/adoption boundary

`canonicalReplaced=false` and `adoptionEligible=false` are invariant. The checker writes a prompt request only; it performs no automatic replacement, Docker verification, diagnostic verification, shadow evaluation, or adoption.

## 9. Next recommendation

**A. M50 run a tiny live corrective-prompt dry-run on sphinx with checker enabled, no auto-adoption.**
