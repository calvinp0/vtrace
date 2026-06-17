# Stage 5 — M28.2 fair-policy prompt sanitization audit

**Date:** 2026-06-17
**Milestone:** M28.2 (sanitize fair-policy FAIL_TO_PASS leak in conflict-evidence rendering)
**Follows:** M28.1 live validation (`4cf3508`) which observed the leak on `sphinx-doc__sphinx-7462`.

## Problem

Under `--revision-verification-policy agent-discovered-tests`, the M28 fair-verification
block correctly withheld FAIL_TO_PASS labels in the **test-expectation** section, but the
revision prompt still leaked a literal evaluator test node through an **older M12/M13
rule-out conflict-evidence path**:

```
Conflict evidence: symbol "unparse" matches FAIL_TO_PASS test test_unparse[()-()]
```

`buildCorrectivePrompt` rendered `RuleOutConflict.evidence` verbatim, and that string is
built in `detectRuleOutConflict` as `… matches FAIL_TO_PASS test ${shortTestName(ftp)}` —
i.e. it embeds the literal evaluator-selected test node.

## Fix (structured, not regex)

- `src/capsuleV2/pivotInspectionCompliance.ts`
  - `RuleOutConflict` now carries a label-free `overlaps: RuleOutConflictOverlap[]`
    (`{ what: "symbol"|"file"; token; against: "test_expectation"|"problem_statement" }`)
    in addition to the literal `evidence[]` (kept for internal report/telemetry).
  - `detectRuleOutConflict` populates `overlaps` alongside `evidence` (in lockstep).
  - `buildCorrectivePrompt(compliance, { fairPolicy })`: under `fairPolicy` the rule-out
    conflict section is rendered from `overlaps` (candidate symbol/path overlap + an
    explicit "the exact evaluator test label is withheld" line) and the section header
    reads "(withheld) benchmark test expectation". Default (no opts / `fairPolicy:false`)
    renders the literal `evidence` verbatim — **byte-identical to prior behavior**.
  - `shortTestName` exported (used by the defensive assertion below).
- `src/capsuleV2/pivotRevisionPass.ts`
  - `buildRevisionPrompt` passes `fairPolicy` (derived from `verificationPolicy ===
    "agent_discovered"`) into `buildCorrectivePrompt`.
  - New `assertNoWithheldTestLabels(prompt, failToPass)` runs at the end of a fair-policy
    build and throws if any FAIL_TO_PASS node id — full `path::node` or its `::`-leaf
    short form (e.g. `test_unparse[()-()]`) — survives into the rendered prompt. A
    belt-and-suspenders guard against any future un-sanitized prompt path.

**The M16 rule-out conflict guardrail is unchanged**: detection, the conflicted-`unclear`
classification, `ruleOutConflicts`, and `correctivePromptSent` all behave exactly as
before. Only the **prompt rendering** is sanitized.

## Audit

Rendered offline from the real modules (no live agent, no Docker) for a sphinx-style
conflicted verdict with two withheld tests
(`tests/test_pycode_ast.py::test_unparse[()-()]`,
`tests/test_domain_py.py::test_parse_annotation`); candidate ruled-out pivot
`sphinx/pycode/ast.py::unparse`.

| # | Audit check | Result |
| --- | --- | --- |
| 1 | Default/none prompt still contains existing diagnostic detail | **PASS** — default still renders `Conflict evidence: symbol "unparse" matches FAIL_TO_PASS test test_unparse[()-()]` and the `FAIL_TO_PASS:` list |
| 2 | Fair-policy prompt does NOT contain `test_parse_annotation` | **PASS** — absent |
| 3 | Fair-policy prompt does NOT contain `test_unparse[()-()]` | **PASS** — absent (and no bare `test_unparse`) |
| 4 | Fair-policy prompt has no literal FAIL_TO_PASS label lines revealing node ids | **PASS** — no `FAIL_TO_PASS:` list, no `matches FAIL_TO_PASS test …` line |
| 5 | Fair-policy prompt still states a conflict exists but labels are withheld | **PASS** — "rule-out conflicts with the (withheld) benchmark test expectation" + "The exact evaluator test label is withheld under the fair verification policy" |
| 6 | M16 rule-out conflict still triggers revision internally | **PASS** — `ruleOutConflicts.length === 1`, candidate stays `unclear`, `correctivePromptSent === true` |

Additional (not over-sanitized): the candidate's own symbol `unparse`, its `::unparse`
id, and the repository path `sphinx/pycode/ast.py` are all still present under fair policy.

### Rendered fair-policy conflict section (evidence)

```
The first pass ruled out the following pivot(s), but that rule-out conflicts with the (withheld) benchmark test expectation:
  - Candidate: sphinx/pycode/ast.py::unparse
    - Conflict evidence: candidate symbol "unparse" overlaps withheld benchmark test-expectation metadata.
    - The exact evaluator test label is withheld under the fair verification policy.
```

### Machine check output

```
DEFAULT_CHECKS {"has_test_unparse_node":true,"has_test_parse_annotation":true,"has_fail_to_pass_list":true,"has_matches_fail_to_pass":true,"has_candidate_symbol_unparse":true,"has_candidate_path":true,"has_conflict_exists":true,"has_withheld_note":false,"conflict_triggered":true}
FAIR_CHECKS    {"has_test_unparse_node":false,"has_test_parse_annotation":false,"has_fail_to_pass_list":false,"has_matches_fail_to_pass":false,"has_candidate_symbol_unparse":true,"has_candidate_path":true,"has_conflict_exists":true,"has_withheld_note":true,"conflict_triggered":true}
```

## Tests

Added (all pure, no fs/spawn/model):

- `pivotInspectionCompliance.test.ts`
  - default corrective prompt keeps the literal FAIL_TO_PASS conflict evidence (and
    `evidence`/`overlaps` are both populated internally);
  - fair-policy corrective prompt withholds the literal test label, keeps candidate
    symbol overlap + conflict existence + withholding note, M16 guardrail unaffected;
  - fair-policy renders a file-stem overlap label-free.
- `pivotRevisionPass.test.ts`
  - default revision prompt still leaks the literal label;
  - fair-policy suppresses `test_unparse[()-()]` + the FAIL_TO_PASS list;
  - fair-policy keeps candidate symbol/path + conflict existence;
  - fair-policy suppresses `test_parse_annotation`;
  - `assertNoWithheldTestLabels` guards full id and `::`-leaf short forms;
  - multiple withheld tests sanitized while unrelated repo paths/symbols are preserved.

## Verification

- `bun run typecheck` — clean.
- `bun run typecheck:benchmarks` — clean.
- `bun test` — **2810 pass, 0 fail** (170 files).
- `git diff --check` — clean.
- Retrieval no-change proof — `stage5_retrieval_eval_expanded.csv` and
  `stage5_retrieval_eval_cross_repo_30.csv` **byte-identical** to baselines (no
  retrieval/ranking/scoring/candidate-generation change).

## Scope

No live agents, no Docker, no agent-command execution, no sweeps. Revision pass remains
off by default; revised patches are not wired into canonical evaluation. Pivot selection
unchanged.
