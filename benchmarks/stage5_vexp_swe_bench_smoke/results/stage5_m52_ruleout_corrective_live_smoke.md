# M52 rule-out corrective second-pass live smoke

Date: 2026-06-20

Instance: `sphinx-doc__sphinx-7462`

Label: `eval-m52-ruleout-corrective-sphinx-7462-r1`

Condition: `vtrace-indexed + --ruleout-sufficiency-corrective-pass`

Classification: **`candidate_ast_edit`**

## 1. Executive verdict

- Did the live corrective second-pass call execute? **Yes.**
- Did it produce a revised candidate? **Yes.**
- Did the candidate edit `sphinx/pycode/ast.py`? **Yes.**
- Was canonical patch safety preserved? **Yes.**

The M49 checker fired after the first pass, wrote its safe corrective prompt,
and M51 executed one separate live corrective model call. The resulting
candidate changed both `sphinx/domains/python.py` and
`sphinx/pycode/ast.py`. It remained a separate candidate artifact; the
canonical first-pass JSONL and `modelPatch` were unchanged.

No Docker, canonical SWE-bench evaluation, diagnostic verifier, shadow
evaluation, pivot-revision pass, or adoption path ran.

## 2. Run artifact summary

| artifact | present | finding |
|---|---:|---|
| `_run.meta.json` | yes | valid injected treatment; exit code 0; pivot check disabled |
| canonical `swebench-2026-06-20.jsonl` / `modelPatch` | yes | first-pass patch changes only `sphinx/domains/python.py` |
| `_ruleout_sufficiency_check.json` | yes | checker enabled and triggered |
| `_ruleout_sufficiency_corrective_prompt.md` | yes | written and safe |
| `_ruleout_sufficiency_corrective_response.txt` | yes | live corrective response persisted |
| `_ruleout_sufficiency_revised.patch` | yes | candidate changes `python.py` and `ast.py` |
| `_ruleout_sufficiency_corrective_result.json` | yes | model call/candidate/hash/safety metadata recorded |
| corrective phase canonical JSONL | yes | stored under `raw/vtrace_ruleout_sufficiency_corrective/`; not used as canonical first-pass output |

Required run fields:

| field | value |
|---|---|
| label | `eval-m52-ruleout-corrective-sphinx-7462-r1` |
| valid | yes |
| first-pass patch produced | yes |
| first-pass changed files | `sphinx/domains/python.py` |
| first-pass edits python.py | yes |
| first-pass edits ast.py | no |
| checker triggered | yes |
| corrective prompt written | yes |
| corrective prompt safe | yes |
| second model call executed | yes |
| corrective response written | yes |
| revised patch produced | yes |
| revised patch changed files | `sphinx/domains/python.py`, `sphinx/pycode/ast.py` |
| revised patch edits python.py | yes |
| revised patch edits ast.py | yes |
| canonical modelPatch hash unchanged | yes |
| `canonicalReplaced` | `false` |
| `adoptionEligible` | `false` |
| forbidden leakage | none |

## 3. First-pass vs revised candidate

The first-pass patch changed only `sphinx/domains/python.py`. It guarded
`result.pop()` for empty list and tuple nodes, preventing the crash, but its
empty tuple branch still returned an empty rendered result.

The revised candidate:

- preserves the empty-list guard in `sphinx/domains/python.py`;
- changes the empty tuple branch in `sphinx/domains/python.py` to render `()`;
- adds an empty tuple branch in `sphinx/pycode/ast.py::unparse` that returns
  `"()"`.

Candidate excerpt:

```diff
 elif isinstance(node, ast.Tuple):
+    if not node.elts:
+        return "()"
     return ", ".join(unparse(e) for e in node.elts)
```

The corrective response explicitly recognized the distinction between
crash-safety and output correctness: joining an empty tuple does not crash but
would otherwise produce an empty string rather than `()`.

This is structural candidate analysis only. The candidate was not evaluated and
must not be described as resolved.

## 4. Safety/leakage audit

The corrective prompt, response, result JSON, and revised patch were scanned
case-insensitively for:

- `FAIL_TO_PASS`
- `PASS_TO_PASS`
- `test_unparse[()-()]`
- `gold patch`
- `hidden test`
- `resolved=true`
- `benchmark expected`

No forbidden string was present.

The corrective result records:

- `oracleFree=true`
- `forbiddenLeakageDetected=false`
- `canonicalReplaced=false`
- `adoptionEligible=false`
- `canonicalPatchUnchanged=true`
- identical canonical results-file SHA-256 before and after
- recorded first-pass patch SHA-256 matches the canonical `modelPatch`

No automatic replacement or evaluation occurred.

## 5. Next recommendation

**A. M53 run 3-rep live candidate-generation validation, still no
Docker/eval/adoption.**
