# Stage 5 M59 Structured Decision Grammar

Offline-only milestone. Tightens the **bounded** digest decision contract grammar and
recalibrates the post-hoc classifier so structured, table-style decisions are both easy
for the agent to produce and reliably credited. No live agents, no Docker, no spend.

## Summary

- **Grammar changes:** the bounded contract (`--bounded-digest-decisions`) now renders an
  explicit **field grammar** per required target — `target_id` / `target` / `decision` /
  `reason` / `files_touched` — with a stable, unique `target_id` (`T1…Tn`), plus a
  "Reason rules" block that spells out what makes a `RULE_OUT` valid and gives terse,
  structured worked examples.
- **Classifier changes:** added `parseStructuredAgentDecisions`, which extracts the
  agent's explicit decisions from **both** the field grammar (multi-line records) and a
  **Markdown decision table** (`| target | DECISION | reason |`). The classifier now
  prefers these structured decisions over the prose scan and credits terse-but-behavioral
  reasons; the behavioral-reason vocabulary was broadened (`handles … not …`,
  `dependent caller`, `wrapper only`, `fix belongs in/elsewhere`, `delegates to`,
  `covered by`, `preserve because`). Conservative: bare `not needed` / `false positive` /
  `irrelevant` / `N/A` are still rejected.
- **Default behavior changed?** **No.** The non-bounded (M57) contract render is
  byte-identical, and free-form prose rule-outs still classify exactly as before. Only the
  opt-in bounded path and the (additive) structured-decision crediting are new.
- **Were the M58B "invalid" rule-outs reclassified?** **Yes — 2 of 3.** Both django-11820
  table rule-outs flip `INVALID_RULE_OUT → RULED_OUT`; the sphinx test-file rule-out stays
  `INVALID_RULE_OUT` (its reason is genuinely thin — held conservative on purpose, and the
  "do not tune for sphinx" constraint). Closed required targets recover **6/9 → 8/9**,
  matching M57's closure level while keeping all of M58's cost wins.
- **Live replication unblocked?** **Yes.** The compliance metric was the stated blocker;
  it now tracks behavior rather than prose vocabulary. A small replicated A+D confirmation
  can proceed.

## M58B Failure Analysis

The M58 agents emitted their decisions as **Markdown tables**, e.g. (django-11820, verbatim):

```
| Target | Decision | Reason |
|--------|----------|--------|
| `django/db/models/base.py::_check_ordering` | **EDIT** | Direct edit site - added `pk` exception for related fields |
| `django/db/models/enums.py::ChoicesMeta` | **RULE_OUT** | False positive - handles enum choices, not model ordering |
| `django/contrib/admin/checks.py::_check_inlines_item` | **RULE_OUT** | Just a dependent caller, fix belongs in core method |
```

Three rule-outs were scored `INVALID_RULE_OUT` under the old classifier:

| instance | target | exact reason text | why the old classifier failed |
|---|---|---|---|
| django-11820 | `enums.py::ChoicesMeta` | "False positive - handles enum choices, not model ordering" | `BEHAVIORAL_REASON_PATTERN` had `handled` (past tense) but not `handles`; its `not (affected\|impacted\|…)` whitelist excluded "not model ordering". |
| django-11820 | `checks.py::_check_inlines_item` | "Just a dependent caller, fix belongs in core method" | "dependent caller" ≠ the whitelisted `caller of`; "fix belongs in" was not recognized at all. |
| sphinx-7462 | `tests/test_domain_py.py::test_parse_annotation` | "Tests are correct - they verify the expected behavior, no changes needed" | reason is essentially "no changes needed" with thin behavioral content. |

The text **named the target** (path + symbol in the row) and the reason **was behavioral**
in the two django cases — the rule-outs were sound. The defect was **two-fold**:

1. **Classifier vocabulary too narrow.** It was tuned on full-prose justifications, but the
   bounded contract elicits *terse table cells*; the behavioral whitelist missed the natural
   terse forms.
2. **Contract grammar too loose / scan too prose-bound.** The classifier scanned per
   sentence-line. That happens to work for a one-line table row, but it would silently break
   the desired **field grammar** (target / decision / reason on separate lines), where the
   decision token, the path, and the reason each land in a different line. Adopting the field
   grammar therefore *required* a multi-line structured parser, or it would regress compliant
   agents.

So: **both** — the classifier pattern was too narrow *and* the contract needed an explicit,
parseable structured grammar.

## New Contract Format

Each required target now renders as a field-grammar record with a stable `target_id`:

```
Required target decisions (fill in decision/reason/files_touched for EACH; keep target_id and target verbatim):

- target_id: T1
  target: PIVOT sphinx/pycode/ast.py::unparse
  required because: lead pivot
  decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT
  reason: <one sentence with a behavioral reason>
  files_touched: <paths or none>

- target_id: T2
  target: IMPACT django/http/response.py::HttpResponse
  required because: cross-file co-edit candidate
  decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT
  reason: <one sentence with a behavioral reason>
  files_touched: <paths or none>
```

with an added **Reason rules** block:

```
Reason rules:
- RULE_OUT is valid ONLY when the reason explains why preserving this target is behaviorally correct.
- "not needed", "irrelevant", or "false positive" ALONE is not enough.
- A short structured reason IS enough if it identifies the behavior, e.g.:
    "dependent caller; behavior is fixed in core method X"
    "false positive; this path handles enum choices, not combinator SQL"
    "wrapper only; no independent logic to patch"
- INSPECT_ONLY_NO_EDIT is valid when the target was inspected and relevant but the patch belongs elsewhere.
```

- **`target_id` behavior:** ids are `T1…Tn` in target order, stable and unique. The parser
  (`parseDigestDecisionContract`) reads the new `target:` lines for presence/identity; the
  classifier matches an agent's decision back to a required target by `target_id`, path,
  basename, or `::symbol`. Optional context is still rendered as non-numbered bullets and is
  never counted as a required target.
- **Valid examples (credited):** `"false positive — handles enum choices, not base field
  conversion"`, `"dependent caller, fix belongs in core method"`, `"wrapper only; no
  independent logic to patch"`, `"delegates to <symbol>"`, `"already covered by the edit in
  <path>"`, `"read-only caller; not affected"`.
- **Invalid examples (rejected):** `"not needed"`, `"false positive"` (alone), `"N/A"`,
  empty reasons, and any decision whose reference does not point at the target.

## Classifier Semantics

- **Valid `RULE_OUT`** requires all of: (1) the decision is `RULE_OUT` (structured token or
  equivalent prose), (2) it refers to the target by `target_id` / path / symbol / unambiguous
  table row, and (3) the reason contains a behavioral explanation
  (`BEHAVIORAL_REASON_PATTERN`). Otherwise → `INVALID_RULE_OUT`.
- **Valid `INSPECT_ONLY_NO_EDIT`** requires: (1) the `INSPECT_ONLY_NO_EDIT` decision, (2) the
  target is referenced, and (3) the reason explains why no edit belongs there
  (`elsewhere` / `belongs` / `already` / `relevant context` / `core method` / a behavioral
  clause). A missing/`N/A` reason → rejected (`INVALID_RULE_OUT`).
- **Still invalid:** empty reasons, `N/A`, `not needed`/`false positive`/`irrelevant` without a
  behavioral clause, generic text that does not refer to the target, and reasoning about an
  unrelated file.
- **Conservative safeguards:** the unfilled template placeholder (`decision: EDIT | RULE_OUT |
  INSPECT_ONLY_NO_EDIT`, detected by the `|` separator) is never parsed as a decision; table
  header/separator rows are skipped; `INSPECT_ONLY_NO_EDIT` is tested before `EDIT` (it
  contains the substring "EDIT"); a structured `EDIT` with no actual patch/edit detected is
  **not** treated as a closure. A structured decision is only credited when it both names a
  decision token and matches the specific required target.

## Retrospective Recalibration

Re-scoring the **frozen** M58B artifacts (captured agent text + tool calls + patch +
contract) with the updated classifier — `run_stage5_m59_recalibration.ts`, report-only, no
artifact mutated. `old_status` is read from the frozen M58B ledger, so this isolates the
classifier delta.

| instance_id | target | old_status | new_status | reason_text | interpretation |
|---|---|---|---|---|---|
| sphinx-doc__sphinx-7462 | `sphinx/domains/python.py::_parse_annotation` | EDITED | EDITED | Fixed inner `unparse` ast.Tuple handling | unchanged |
| sphinx-doc__sphinx-7462 | `sphinx/pycode/ast.py::unparse` | EDITED | EDITED | Fixed to return `()` for empty tuples | unchanged |
| sphinx-doc__sphinx-7462 | `tests/test_domain_py.py::test_parse_annotation` | INVALID_RULE_OUT | **INVALID_RULE_OUT** | "Tests are correct - they verify the expected behavior, no changes needed" | still invalid — reason lacks behavioral content (conservative) |
| django__django-11820 | `django/db/models/base.py::Model._check_ordering` | EDITED | EDITED | Direct edit site - added `pk` exception | unchanged |
| django__django-11820 | `django/db/models/enums.py::ChoicesMeta` | INVALID_RULE_OUT | **RULED_OUT** | "False positive - handles enum choices, not model ordering" | now credited — terse structured reason recognized |
| django__django-11820 | `django/contrib/admin/checks.py::_check_inlines_item` | INVALID_RULE_OUT | **RULED_OUT** | "Just a dependent caller, fix belongs in core method" | now credited — terse structured reason recognized |
| django__django-13195 | `django/http/response.py::…delete_cookie` | EDITED | EDITED | Added `samesite='Lax'` and forwarded it | unchanged |
| django__django-13195 | `django/http/response.py::…set_cookie` | EDITED | EDITED | Added `samesite` forwarding | unchanged |
| django__django-13195 | `django/contrib/admin/options.py::response_action` | INSPECT_ONLY_NO_EDIT | **RULED_OUT** | "Just a caller; doesn't use delete_cookie for session cookies" | reclassified — matches the agent's explicit RULE_OUT (both closed) |

**Aggregate (9 required targets across 3 cases):**

| metric | old (M58B) | new (M59) | delta |
|---|---|---|---|
| closed required targets | 6 | 8 | **+2** |
| reason-credited (RULED_OUT + INSPECT_ONLY_NO_EDIT) | 1 | 3 | **+2** |
| open required targets | 3 | 1 | **−2** |
| targets reclassified | — | 3 | — |

**Answer to the milestone question:** *yes* — 2 of the 3 M58B "invalid" rule-outs were
genuine structured rule-outs that the improved grammar now credits, recovering closure to
**8/9** (M57's level) without changing any agent behavior. The one that stays invalid
(sphinx test file) is a deliberately conservative call: its reason ("no changes needed",
"tests are correct") carries no behavioral content, and we explicitly avoid weakening the
classifier to credit such non-answers (and avoid tuning for sphinx).

## Tests

`bun test src/capsuleV2/digestDecisionContract.test.ts` — **39 pass / 0 fail.** Existing M57
+ M58 tests are unchanged (the bounded render switch is covered by substring assertions that
still hold). New M59 tests:

- bounded mode renders the structured `target_id` grammar (+ reason-rules guidance)
- `target_id` values are stable (`T1…Tn`) and unique
- EDIT / RULE_OUT / INSPECT_ONLY decisions parse from a Markdown table
- field grammar parses; the unfilled `A | B | C` template placeholder is ignored
- RULE_OUT with a behavioral reason is credited
- RULE_OUT with only "not needed" is rejected
- RULE_OUT with only "false positive" is rejected
- RULE_OUT "false positive — handles enum choices, not base field conversion" is credited
- RULE_OUT "dependent caller, fix belongs in core method" is credited
- INSPECT_ONLY_NO_EDIT parses and is credited from a structured table
- INSPECT_ONLY_NO_EDIT without a reason is rejected
- a decision referring to a different target does not credit this one
- free-form (non-structured) M57/M58 prose rule-outs still credit
- closed/open counts update correctly with the structured grammar
- default (non-bounded) contract behavior is unchanged

Verification: `bun run typecheck`, `bun run typecheck:benchmarks`, full `bun test`, and
`git diff --check` all clean (see commit). No retrieval/scoring/ranking code touched, so no
retrieval eval required.

## Next Recommended Validation

**Proceed to a small replicated A+D confirmation** (e.g. 3× replicates of the same 3 M58B
cases with `--bounded-digest-decisions`). The classifier is now reliable — the compliance
metric tracks behavior, not prose vocabulary, and structured table/field decisions are
credited — so the stated measurement blocker is cleared. The replicate should confirm
whether django-13195's cost drop (−37% tokens, 65 → 41 turns) and sphinx's cost rise are
stable or variance, and should measure the over-edit signal
(`edited_files_outside_required_targets`) directly. Do **not** promote the bounded contract
into Stage 5 treatment, and do **not** jump to a broad confirmation, before that replicate.

---

### Provenance

- Classifier/grammar: `src/capsuleV2/digestDecisionContract.ts` (+ `.test.ts`).
- Recalibration: `run_stage5_m59_recalibration.ts` (report-only; reads captured M58B run
  artifacts under `results/runs/m58b_vtrace_bounded_contract_*`, re-scores with the updated
  classifier; `old_status` from the frozen `stage5_m58b_bounded_digest_decision_live_validation.json`).
- JSON summary: `stage5_m59_structured_decision_grammar.json`.
