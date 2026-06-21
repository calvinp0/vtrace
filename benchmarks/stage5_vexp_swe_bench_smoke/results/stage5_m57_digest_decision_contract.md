# Stage 5 M57 Digest Decision Contract

Offline, tested change that turns the enriched digest from a *surfacing* device into an
**action-binding decision contract**, and adds a separate default-off **compact**
injection mode to cut the duplicated guidance M56C flagged. No live agents, no Docker,
no API spend, no A/B, no retrieval/scoring/ranking change.

## Summary

- **Flags added (both default-off):**
  - `--digest-decision-contract` — with `--inject-capsule-digest` + `--capsule-engine v2`,
    injects a sentinel-wrapped contract right after the digest requiring an explicit
    EDIT / RULE_OUT decision per required target.
  - `--compact-digest-injection` — with `--inject-capsule-digest` + v2, suppresses the
    `## VTRACE inspect-first` block (a re-ranked restatement of the digest).
- **Did default behavior change?** **No.** With neither flag the injected context is
  byte-identical to pre-M57. Both flags are off in `DEFAULT_CONFIG`, gated behind
  `--inject-capsule-digest` + v2, and have no effect on baseline or legacy-engine runs.
- **How required targets are selected (bounded):** lead pivot (`pivots[0]`); the first
  non-lead pivot that is **hidden/non-traceback** (its `role_reason` lacks
  `"source line anchor"`); then up to **2** impact representatives that are **cross-file**
  (a different file from every already-selected target) and **not duplicate** identities.
- **Required target cap:** **4** (`MAX_DIGEST_DECISION_TARGETS`); impact reps capped at 2
  (`MAX_DIGEST_DECISION_IMPACT_TARGETS`). Extra candidates are simply not promoted to
  required decisions (they remain visible in the digest as optional context). This
  directly guards against the M56C cost explosion.
- **Compact mode behavior:** removes exactly one demonstrably-duplicated section
  (`## VTRACE inspect-first`); preserves the digest, the decision contract, the focused
  source bodies in `renderCapsuleV2Human`, the pivot neighborhood, and all safety blocks
  (`PIVOT_CHECK` / `EDIT_GUARD` / `PATCH_VERIFY` / token-discipline).
- **Future live validation unblocked?** **Yes** — the experimental condition
  `--inject-capsule-digest --digest-decision-contract --compact-digest-injection` is now
  expressible and fully offline-tested. No live run was performed in this milestone (out
  of scope).

## Guidance Stack Before/After

Two assembly stages (confirmed by source trace):
- **Stage A — `classifyCapsuleV2Output`** builds the per-instance capsule body:
  `context = [digestBlock, inspectFirstText, rendered, neighborhoodText]`.
- **Stage B — `buildVtraceContextMarkdown`** wraps each body with instance headers and
  appends `PIVOT_CHECK` → `EDIT_GUARD` → `PATCH_VERIFY` → `STAGE5_TOKEN_DISCIPLINE`.

**Current injected sections (top → bottom), `--inject-capsule-digest` on:**
1. `## Instance` / `## vtrace context` headers
2. (opt-in M12) `## Required pivot check before final patch`
3. Capsule body:
   a. `<VTRACE_CAPSULE_V2_DIGEST_*>` digest (●/○/→ role hierarchy + why + budget)
   b. **`## VTRACE inspect-first`** (likely-first file + related + avoid-first)
   c. `renderCapsuleV2Human` (intent/strategy/budget, "## Multiple edit targets",
      pivot inspection contract, actionability hints, **pivot focused source bodies**,
      "hidden candidate" notes, edit-risk directives, support bodies)
   d. `## Pivot neighborhood`
4. `## PIVOT_CHECK` → `## EDIT_GUARD` → `## PATCH_VERIFY` → `## STAGE5_TOKEN_DISCIPLINE`

**Duplicated sections found** (same facts re-rendered up to ~6 surfaces):
- *Pivot identity + why-reason*: digest line ↔ inspect-first "Likely first/Related" ↔
  renderHuman item header + Multi-Pivot Action Plan + pivot inspection contract ↔
  PIVOT_CHECK table row.
- *Hidden / non-traceback framing*: renderHuman "hidden candidate" + "## Multiple edit
  targets" prose ↔ PIVOT_CHECK `anyHidden` warning.
- *Inspect-or-rule-out guidance*: renderHuman "Before editing" + pivot inspection
  contract ↔ inspect-first ↔ PIVOT_CHECK ↔ (now) the M57 decision contract.
- *Least duplicative*: pivot neighborhood (pointers only, bodies not re-dumped).

**What M57 adds:** the decision contract (3a→**3a′**, immediately after the digest) — a
single compact action-binding restatement keyed to ≤4 targets.

**What compact mode changes:** drops **3b** (`## VTRACE inspect-first`) — the section
most fully subsumed by the digest (lead/related pivots) and now by the contract.

**What remains unchanged for safety:** `renderCapsuleV2Human`'s unique **focused source
bodies** (the actual code) are never dropped; the pivot neighborhood is kept; and the
entire Stage-B safety stack (PIVOT_CHECK/EDIT_GUARD/PATCH_VERIFY/token-discipline) is
untouched. Compact mode only removes a pure-guidance restatement, not content.

## Decision Contract Format

- **Sentinels:** `<VTRACE_DIGEST_DECISION_CONTRACT_START>` /
  `<VTRACE_DIGEST_DECISION_CONTRACT_END>` (exact constants in
  `src/capsuleV2/digestDecisionContract.ts`). Presence detection requires BOTH sentinels
  — generic digest glyphs (●/○/→) and `budget:` lines never count.

Example (lead pivot + hidden co-pivot + one cross-file impact rep):

```
<VTRACE_DIGEST_DECISION_CONTRACT_START>
Before finalizing your patch, every REQUIRED DIGEST TARGET below must be either edited or explicitly ruled out.

Required targets:
1. PIVOT sphinx/pycode/ast.py::unparse
   decision: EDIT | RULE_OUT
   reason: actionable function — exercised by a failing test; 9 dependents
2. PIVOT sphinx/domains/python.py::_parse_annotation
   decision: EDIT | RULE_OUT
   reason: source line anchor in the issue points at this symbol
3. IMPACT tests/test_domain_py.py::test_parse_annotation
   decision: EDIT | RULE_OUT
   reason: dependent of a pivot — verify whether this co-edit is required

Rules:
- Do not ignore required targets.
- A Search/Grep hit is not enough; inspect/read the file or explain why it is ruled out.
- If the patch does not touch a required target, state why preserving it is correct.
- Prefer small edits. Do not edit non-gold/non-relevant impact rows just because they are listed.
<VTRACE_DIGEST_DECISION_CONTRACT_END>
```

- **Required target examples:** PIVOT targets use the digest's stable identity
  (`fqName` | `path::symbol` | `path`); IMPACT targets use `path::symbol` from the typed
  impact seam (`CapsuleV2DigestImpactSeam.representative`). Target identities are
  byte-consistent with the digest because both derive from the same
  `toCapsuleV2ProductResponse(result)` projection.

## Classification

Post-hoc, deterministic, **no second model call** (`classifyDigestDecisionContract`).
Inputs: the structured required targets, the ordered tool-call trace
(`{category, path}`), the final patch's edited files, and the agent's final text.
Per-target decision precedence:

- **EDITED** — target path modified, with a read preceding the edit.
- **EDITED_WITHOUT_INSPECTION** — modified with no prior read of the target.
- **RULED_OUT** — agent text refers to the target AND gives a behavioral reason
  (reuses the M13 rule-out concept: a rule-out must be grounded, not a bare assertion).
- **INVALID_RULE_OUT** — rule-out text refers to the target but gives no behavioral
  reason.
- **INSPECTED_ONLY** — read/opened but neither edited nor ruled out.
- **IGNORED** — shown in the contract but never read/edited/ruled out. (A Search/Grep hit
  is explicitly *not* inspection.)

Counts emitted: `decisionContractPresent`, `requiredTargetCount`,
`requiredTargetInspectedCount`, `requiredTargetEditedCount`,
`requiredTargetRuledOutCount`, `requiredTargetIgnoredCount`,
`requiredTargetInvalidDecisionCount` (+ `requiredTargetEditedWithoutInspectionCount`).
The five outcome buckets (edited / ruled_out / inspected_only / ignored / invalid)
partition the targets (tested).

- **Path matching:** absolute `…/.bench-repos/<repo>/<rel>` tool-call paths are
  normalized to repo-relative before comparison (suffix-tolerant).
- **Why a focused classifier (not the M13 `pivotInspectionCompliance`):** M13 consumes
  pre-extracted edited/inspected file sets over the M12 pivot contract and cannot make
  the IGNORED-vs-INSPECTED_ONLY-vs-EDITED_WITHOUT_INSPECTION distinctions this milestone
  requires (those need the raw ordered tool-call trace). The M57 classifier operates on
  that trace directly while reusing M13's rule-out-validity concept; it does not fork the
  M13 contract semantics.
- **Limitations:** rule-out / invalid-rule-out detection is text-heuristic (regex over
  rule-out + behavioral-reason patterns scoped per sentence), so it is best-effort on
  free-form agent prose; it is exact on the structured cases the tests cover. Per-edge
  call-site precision and a `RULE_OUT:`-marker grammar remain future work.

## Tests

New offline tests (no live agents):
- `src/capsuleV2/digestDecisionContract.test.ts` (13): lead pivot always required;
  hidden co-pivot included; impact rep included when impact exists; cap ≤4 enforced;
  duplicate lead/impact not repeated; empty contract when no pivots; sentinels present
  exactly once + rules rendered; parse detects contract & targets; **generic glyphs do
  NOT count**; classifier EDITED vs EDITED_WITHOUT_INSPECTION, INSPECTED_ONLY vs IGNORED,
  search-hit-is-not-inspection, RULED_OUT vs INVALID_RULE_OUT, counts partition.
- `benchmarks/stage5_vexp_swe_bench_smoke/digest_decision_contract_injection.test.ts`
  (4): contract **absent by default**; **appears exactly once** with both sentinels when
  enabled (after the digest, lead pivot present); **compact absent by default**
  (inspect-first present); **compact suppresses inspect-first** while preserving digest +
  contract + focused source.

Verification results: `bun run typecheck` ✓, `bun run typecheck:benchmarks` ✓,
`bun test` ✓ (**3074 pass / 0 fail**, +17 new vs the 3057 pre-M57 baseline),
`git diff --check` ✓.

## Next Recommended Validation

A ≤6-live-run A+D confirmation **only after this commit**, reusing the M56C harness and
the same 3 cases (sphinx-7462, django-11820, django-13195), with:

```
--inject-capsule-digest
--digest-decision-contract
--compact-digest-injection
```

Hypothesis to test: the decision contract converts M56C's *surfaced-but-not-acted*
co-edit targets (django-13195 edited 1/3 surfaced gold) into edits or explicit
rule-outs, while compact mode offsets the contract's added tokens so the M56C cost
regression (pooled +107% tokens) does not recur. Measure with the post-hoc decision
classifier (edited/ruled_out/ignored per required target) plus the standard
token/cost/resolution deltas. Keep the same ≤6-run hard cap; no broad sweep.
