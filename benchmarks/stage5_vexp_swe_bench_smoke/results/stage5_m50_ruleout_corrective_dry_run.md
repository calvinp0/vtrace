# M50 rule-out corrective dry-run

Date: 2026-06-20

Instance: `sphinx-doc__sphinx-7462`

Condition: `vtrace-indexed + --ruleout-sufficiency-check`

The original `eval-m50-ruleout-sphinx-7462-r1` label was preserved after its
2026-06-18 pre-model rate-limit failure. Its replacement replicate uses
`eval-m50-ruleout-sphinx-7462-r1-retry1`; the requested `r2` and `r3` labels were
unused and retained.

## 1. Executive verdict

- Did the checker fire live? **Yes: 3/3 valid runs.**
- Did it produce a safe corrective prompt? **Yes: 3/3 runs.**
- Did it produce a revised patch candidate? **No: 0/3.**
- Did any candidate edit `sphinx/pycode/ast.py`? **No candidate existed.**
- Was canonical patch replacement avoided? **Yes: 3/3 recorded
  `canonicalReplaced=false` and `adoptionEligible=false`.**

All three runs are classified as **`corrective_prompt_only`**. M49 executes a
post-first-pass static check and writes additive artifacts. Under the requested
flags it does not make a second model call. The only existing second-pass path
is behind the separately prohibited pivot-revision flags.

This milestone does not establish resolution. No Docker evaluation, shadow
evaluation, diagnostic verifier, or revised-patch evaluation ran.

## 2. Run matrix

| label | valid | canonical patch | first-pass files | python.py | ast.py | checker enabled / fired | prompt | second call | revised candidate | classification |
|---|---:|---:|---|---:|---:|---|---:|---:|---:|---|
| `eval-m50-ruleout-sphinx-7462-r1-retry1` | yes | yes | `sphinx/domains/python.py` | yes | no | yes / yes | yes | no | no | `corrective_prompt_only` |
| `eval-m50-ruleout-sphinx-7462-r2` | yes | yes | `sphinx/domains/python.py` | yes | no | yes / yes | yes | no | no | `corrective_prompt_only` |
| `eval-m50-ruleout-sphinx-7462-r3` | yes | yes | `sphinx/domains/python.py` | yes | no | yes / yes | yes | no | no | `corrective_prompt_only` |

### Per-run checker fields

The following values were identical across all three valid runs:

| field | value |
|---|---|
| `originalDecision` | `ruledOut` |
| `effectiveDecision` | `unclear` |
| `pairedOperation` | `unparse` |
| `editedImplementation` | `sphinx/domains/python.py::unparse` |
| `ruledOutImplementation` | `sphinx/pycode/ast.py::unparse` |
| `correctivePromptWritten` | `true` |
| `corrective model call executed` | `false` |
| `revised patch candidate produced` | `false` |
| `revised patch changed files` | none |
| `revised patch edits ast.py` | no candidate |
| `canonicalReplaced` | `false` |
| `adoptionEligible` | `false` |
| `oracleFree` | `true` |
| forbidden label leakage | none |

Each `_run.meta.json` records a valid injected treatment, exit code 0, pivot
check disabled, and one persisted first-pass stream. Each first-pass stream has
one terminal model result. No pivot-revision, corrective-response, revised-patch,
or standalone patch artifact was produced.

## 3. Corrective prompt safety

Safe excerpt:

> Your rule-out explains why the paired implementation may not crash, but it
> does not explain why its output or behavior is correct for the same edge case.

The complete `_ruleout_sufficiency_check.json` and
`_ruleout_sufficiency_corrective_prompt.md` artifacts for all three runs were
scanned case-insensitively. None contained:

- `FAIL_TO_PASS`
- `PASS_TO_PASS`
- `test_unparse[()-()]`
- `gold patch`
- `hidden test`
- `resolved=true`
- `benchmark expected`

The checker JSON used only first-pass patch shape, surfaced paired
implementation information, inspected/mentioned source, and sanitized
first-pass reasoning. All three artifacts report `oracleFree=true`.

## 4. Patch/candidate analysis

All three canonical first-pass patches changed only
`sphinx/domains/python.py`. Each guarded an empty collection before `pop()`:

- r1-retry1 guarded the list branch and made the tuple branch return an empty
  result when `node.elts` is empty.
- r2 guarded the list branch with `node.elts` and the tuple branch with
  `result`.
- r3 guarded both branches with `node.elts`.

No first-pass patch edited `sphinx/pycode/ast.py`. The checker consistently
identified `sphinx/pycode/ast.py::unparse` as the surfaced paired implementation
whose crash-only rule-out lacked output-preserving repository evidence.

No corrective candidate was generated, so the core behavioral question—whether
the corrective prompt causes a revised candidate to edit `ast.py`—was not
exercised. The secondary structural-shape question is likewise unanswered.
There was no candidate to compare, and no gold patch or hidden evaluator labels
were used.

## 5. Adoption boundary

Across all three runs:

- `canonicalReplaced=false`
- `adoptionEligible=false`
- no automatic replacement
- no Docker evaluation
- no shadow evaluation
- no diagnostic verifier
- no revision verification policy
- no pivot revision pass
- no pivot-inspection enforcement

The canonical JSONL `modelPatch` remained the first-pass patch.

## 6. Failure/regression analysis

The live checker integration behaved consistently with M49's documented scope:
it fired after a valid first-pass patch, reclassified the paired implementation
from `ruledOut` to `unclear`, and persisted a safe corrective prompt.

The missing behavior is not a runtime failure in M49. The requested flag has no
gated model-execution wiring, so a prompt artifact alone cannot influence a
patch. Consequently M50 cannot measure corrective edit behavior or structural
improvement yet.

No source code changed for M50, so retrieval evaluation was not required.

## 7. Next recommendation

**B. M51 implement default-off corrective second-pass call, no auto-adoption.**

The second pass should consume the M49 oracle-free corrective prompt, persist
its response and revised candidate separately, and retain
`canonicalReplaced=false` and `adoptionEligible=false` until a separately
designed fair verification/adoption policy exists.
