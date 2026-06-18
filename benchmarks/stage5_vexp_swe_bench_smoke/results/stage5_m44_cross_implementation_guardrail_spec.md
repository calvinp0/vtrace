# Stage 5 — M44: Cross-implementation output-divergence rule-out guardrail (SPEC)

**Date:** 2026-06-18
**Type:** Specification milestone. **No implementation.** No live agents, no Docker, no SWE-bench
canonical evaluation, no diagnostic verifier, no `--allow-docker-verify`. No source code changed.
**Anchor instance (worked example):** `sphinx-doc__sphinx-7462`.
**Prompted by:** M43 — first-pass text prompts are exhausted (M38–M42); the only fair, unbuilt lever
is a static cross-implementation output-divergence check. M43 recommended **spec before code**. This is
that spec.

> **Non-oracle constraint (binding for the whole spec).** The guardrail MUST NOT use, read, or depend on:
> gold patches · hidden test names · FAIL_TO_PASS / PASS_TO_PASS · benchmark labels · Docker · shadow eval ·
> the diagnostic verifier · automatic canonical-patch replacement · any default-on behavior. It is a *static*,
> *pure*, *advisory*, *flag-gated* projection over evidence the capsule already computed plus observable run
> facts. Everything below is constrained by this paragraph.

---

## 1. Executive verdict

- **Is a fair static cross-implementation guardrail feasible?** **Yes — narrowly, and as a corrective-prompt
  obligation, not a resolver.** All of its inputs already exist in fair, non-oracle form: the
  `semanticEditHypothesis` builder already detects same-name operation-like implementations across files and an
  empty-container/`join()`/`.pop()` output-shape signal (`src/capsuleV2/semanticEditHypothesis.ts`); the M12
  enforcement block already elicits machine-readable `PIVOT_DECISION` markers; the M13 compliance checker already
  parses them and routes `unclear` candidates into a corrective prompt
  (`src/capsuleV2/pivotInspectionCompliance.ts`). The only genuinely new logic is **classifying a rule-out's
  *reason* as crash-avoidance-shaped** and **joining that rule-out to an existing paired-symbol group**. Both are
  small, pure, string-level operations.
- **What can it detect?** A *suspicious* rule-out: the agent edited one implementation of a shared
  operation-like symbol, **ruled out** the paired implementation in a different file, and the rule-out reason is
  grounded **only in crash/exception avoidance** while the paired implementation contains output-producing
  constructs that can return empty/default output for the same edge case. It converts such a rule-out from
  *credited* (`ruledOut`, compliant) to *suspicious* (`unclear`, corrective-prompt-triggering).
- **What can it NOT prove?** It cannot prove the paired implementation is actually wrong, cannot supply the
  missing behavioral fact, and **cannot resolve sphinx-7462.** For sphinx the deciding fact — *an empty tuple
  must render as `"()"`* — lives only in a hidden test; the public problem statement demands only "no crash /
  valid annotations" (M43 §1, §2). The guardrail can only raise the *evidence bar* on the rule-out ("explain why
  the output is correct, not just that it does not crash"); it cannot decide the output is wrong.
- **Should we implement it next?** **Spec-then-validate, not spec-then-build.** The mechanism is feasible and
  small, but its value is dominated by its **false-positive rate** on same-name siblings that legitimately
  differ (e.g. seaborn-3187's non-gold `relational.py`). Therefore the recommended next milestone (§11) is **C —
  build the offline validator first** against the false-positive audit set (§8), *then* implement as a
  flag-gated, corrective-prompt-only addition (§9). Do not implement the guardrail in this milestone.

---

## 2. Problem boundary

This guardrail **is not an oracle.** Stated explicitly, as required:

- It MUST NOT know or read **gold patches, hidden tests, FAIL_TO_PASS, PASS_TO_PASS, or any benchmark labels.**
- It MUST NOT run Docker, shadow eval, the diagnostic verifier, or any test.
- It MUST NOT mutate the canonical submitted patch (no auto-adoption, no revision-pass dependency).
- It MUST be **default-off** and flag-gated; default behavior must remain byte-identical.
- It **should not claim sphinx-7462 is fully solvable without hidden-test evidence.** The honest M43 finding
  stands: the resolving fact is oracle-only for this instance. The guardrail's purpose is to **improve rule-out
  discipline generally**, not to resolve sphinx-7462.

What it *is*: a static detector of a **specific suspicious shape** — "I edited one renderer, ruled out its
twin because the twin does not crash, but the twin still produces output that may diverge on the same edge
case." It raises that as an `unclear` obligation and asks for an *output-preserving* justification. That is the
entire claim.

---

## 3. Trigger conditions

The guardrail fires **only when ALL of A–G hold.** Conjunctive by design (conservative; better to miss than to
over-fire and push a correct sibling edit — M43 §8 over-edit risk).

- **A. Shared operation-like symbol.** Two surfaced candidates define the SAME operation-like symbol name. This
  reuses `isOperationLikeName` and the same-name-across-files grouping already implemented in
  `buildSemanticEditHypothesis` (a `SemanticSymbolGroup` with ≥2 distinct-file targets). Operation-like =
  parse/unparse/render/format/serialize/encode/decode/stringify/dump/load/… or a `to_/from_/as_` shape; dunders
  and generic verbs are excluded.
- **B. Different files/modules.** The two implementations are in different files (already guaranteed by the
  builder's "≥2 DISTINCT files" rule).
- **C. One file edited.** Exactly one of the paired files appears in the first-pass final patch (`editedFiles`).
- **D. Paired file NOT edited.** The other paired file does **not** appear in the first-pass patch.
- **E. Explicit rule-out of the paired file.** The agent emitted a `RULED_OUT` `PIVOT_DECISION` marker for the
  paired file (parsed by `parsePivotDecisionMarkers`). *(In a future live wiring, free-text rule-out reasoning
  could also be read, but the captured Stage 5 artifacts only persist the final patch + markers, so the marker
  is the only observable rule-out reason — see §6 / M13 header note. The guardrail keys off the marker.)*
- **F. Rule-out reason is crash-avoidance-shaped.** The marker's `evidence` string is dominated by
  crash/exception-avoidance language and lacks any output-correctness assertion. This is the one **new**
  classifier (§9). Crash-avoidance lexicon (case-insensitive, conservative): `does not crash`, `won't crash`,
  `no crash`, `avoids the crash`, `no exception`, `does not raise`, `won't raise`, `no IndexError /
  KeyError / …`, `handles empty … safely`, `guards against`, `no error`. The reason must contain such a phrase
  **and** must NOT contain an output-correctness assertion (see §4 non-trigger d for the exemption lexicon).
- **G. Paired implementation can return empty/default output.** The paired (ruled-out) implementation's inlined
  source body contains an output-producing construct that can return empty/default output for the edge case.
  Reuse the existing `hasEmptyContainerSignal` evidence plus a small output-construct scan over the *paired
  file's* surfaced source body. Output-producing constructs (conservative whitelist):

  ```text
  join(...)            # ", ".join([]) -> ""
  return ""            # empty-string default
  return []            # empty-list default
  return None          # null default
  format/render/unparse/serialize/stringify call paths
  empty-container branch (if not <x>: return <empty/default>)
  ```

Keep this conservative: if any of A–G is uncertain, **do not fire.**

---

## 4. Non-trigger conditions

The guardrail MUST NOT fire when:

- **a.** There is no paired same-operation candidate (no `SemanticSymbolGroup` with ≥2 distinct files).
- **b.** The paired candidate **was edited** (it is handled; nothing to flag).
- **c.** The paired candidate was **not surfaced / not inspected** — the guardrail only reasons about a
  candidate VTRACE actually surfaced and the agent actually addressed via a marker. (No marker + not surfaced ⇒
  out of scope; that is an ordinary `missing`/`unclear` case for M13, not a divergence flag.)
- **d.** The rule-out gives a **concrete output-preserving reason.** If the marker evidence asserts output
  equivalence — lexicon: `returns the same`, `produces the same output`, `output is identical / unchanged`,
  `renders … correctly`, `same result`, `equivalent output`, `produces "()"`-style explicit token claims,
  `already handles the empty case correctly` — then the rule-out is **credited as `ruledOut`** and the guardrail
  is silent. (The guardrail's whole job is to demand exactly this kind of reason; if it is already present, it
  must not fire.)
- **e.** The shared operation is **not output/render/parse/serialize-like** (fails `isOperationLikeName` and no
  output-construct in the paired body — i.e. G is unmet).
- **f.** Only **same-file** duplicates exist (a nested helper of the same name in one file — already excluded by
  the builder's distinct-file rule).
- **g.** Only **lexical support overlap** with no operation pairing (the name matched but is not operation-like,
  or no pivot file defines it — already excluded by builder rule #3).
- **h.** **No first-pass patch exists** (nothing was edited; C/D undefined). The guardrail needs an edited
  implementation to contrast against.
- **i.** *(Belt-and-suspenders)* The paired file is covered by a generated-artifact obligation
  (`generatedArtifactFiles`) — those are not normal pivot-inspection requirements (mirrors
  `requiredCandidatesFromContract`).

---

## 5. Guardrail output

The guardrail emits zero or more **risk records** (one per offending paired group). Shape (TypeScript; this is
the proposed interface, not yet implemented):

```ts
interface CrossImplementationOutputDivergenceRisk {
  kind: "cross_implementation_output_divergence_risk";
  /** Always "unclear": routes into the M13 unclear/corrective-prompt path. Never "blocking". */
  severity: "unclear";
  /** `path::symbol` of the implementation that WAS edited in the first-pass patch. */
  editedImplementation: string;   // e.g. "sphinx/domains/python.py::unparse"
  /** `path::symbol` of the paired implementation that was ruled out, not edited. */
  ruledOutImplementation: string; // e.g. "sphinx/pycode/ast.py::unparse"
  /** The shared operation-like symbol name. */
  sharedOperation: string;        // e.g. "unparse"
  /** Label-free, non-oracle evidence bullets (safe to render into a prompt). */
  evidence: string[];
  /** The corrective ask. Output-correctness framed; NO hidden-test language. */
  correctiveAction: string;
}
```

Example (sphinx-7462; non-oracle):

```ts
{
  kind: "cross_implementation_output_divergence_risk",
  severity: "unclear",
  editedImplementation: "sphinx/domains/python.py::unparse",
  ruledOutImplementation: "sphinx/pycode/ast.py::unparse",
  sharedOperation: "unparse",
  evidence: [
    "same operation-like symbol name across files",
    "edited one implementation, not the other",
    "rule-out reason relied on crash avoidance",
    "paired implementation returns output text (join over container elements)"
  ],
  correctiveAction:
    "Your rule-out explains why the paired implementation may not crash, but it does not "
    + "explain why its output is correct for the same edge case. Either edit the paired "
    + "implementation or give a concrete output-preserving reason."
}
```

**Routing:** each risk record contributes its `ruledOutImplementation` id to the M13 `unclear` set (downgrading
it from `ruledOut`) so the existing `correctivePromptSent` gate fires and `buildCorrectivePrompt` lists it. The
record's `correctiveAction` is folded into the corrective prompt's per-candidate section. The guardrail produces
**no** auto-edit, **no** revision trigger, **no** gate, and **no** patch mutation.

---

## 6. Relationship to existing components

| Component | How M44 integrates | Constraint |
|---|---|---|
| **M12 `PIVOT_DECISION` markers** (`pivotInspectionContract.ts`) | Source of the rule-out reason (`evidence`). Trigger E reads `RULED_OUT` markers via `parsePivotDecisionMarkers`. No change to the enforcement block needed. | Requires `--pivot-inspection-enforcement` (off by default) to elicit markers. The guardrail is silent without markers. |
| **M13 compliance checker** (`pivotInspectionCompliance.ts`) | The guardrail is a **new pure predicate** that reclassifies a would-be-`ruledOut` candidate as `unclear` when the divergence shape holds — structurally identical to how the **M16** `detectRuleOutConflict` already downgrades a test-anchored rule-out, but using **no oracle input**. Its records flow into `ruleOutConflicts`-style detail and into the corrective prompt. | Must keep `computePivotInspectionCompliance` pure and inactive unless `enabled`. |
| **M16 rule-out conflict detector** | **Sibling, not dependency.** M16 downgrades a rule-out using withheld FAIL_TO_PASS labels (**oracle-contaminated**, M43 §4). M44 reaches a *similar* "do not credit this rule-out" verdict from **source semantics only**. M44 is the fair counterpart of M16 and must run **independently** of any FAIL_TO_PASS input. | M44 MUST NOT read `testExpectation`/`failToPass`. |
| **M39 semantic hypothesis** (`semanticEditHypothesis.ts`) | **Primary reused detector.** `buildSemanticEditHypothesis` already produces the paired `SemanticSymbolGroup`s (triggers A/B) and `hasEmptyContainerSignal` (part of G). M44 consumes its output rather than re-detecting. | M39 is render-only/default-off; M44 reuses the *builder* (pure), not the rendering. |
| **M41 edit-sufficiency checklist** | Same builder output. M41 is the *first-pass advisory* version of this idea ("don't rule out only because it avoids the crash"); M44 is the *post-hoc compliance* version that fires when the agent did it anyway. Complementary. | Both default-off; M44 does not require M41 to be on. |
| **M34 accounting/reporting** (`m34_accounting.ts`) | If M44 ever renders prompt text, its rendered chars are attributed like M39/M41 sections (a new char bucket). For the corrective-prompt-only design, the prompt is built post-hoc and is not part of the 12000-char injection budget, so it does not interact with §10. | Report-only; observe-only buckets must be `0` when the flag is off. |

Explicit non-dependencies (required): the guardrail **must not require** pivot revision, shadow eval, Docker, or
hidden tests, and **must not** mutate the canonical patch.

---

## 7. Sphinx-7462 worked example (non-oracle)

All inputs below are available to VTRACE *without* any oracle. No gold patch, no hidden test name, no
FAIL_TO_PASS appears anywhere in this reasoning.

**Inputs available to VTRACE (fair):**
- Two surfaced pivots define an operation-like symbol `unparse` in different files:
  `sphinx/domains/python.py::unparse` and `sphinx/pycode/ast.py::unparse` (paired group from
  `buildSemanticEditHypothesis`; the secondary is surfaced in 24/24 runs per M38).
- The paired `ast.py::unparse` body contains a `", ".join(...)` over container elements
  (`hasEmptyContainerSignal` / output-construct scan → trigger G).
- First-pass patch edits `python.py` only (trigger C/D).
- The agent's `PIVOT_DECISION` marker for `ast.py`: `decision: RULED_OUT`, `evidence:` *"uses `', '.join()` so it
  does not crash on an empty tuple; no fix needed"* (crash-avoidance-shaped, no output assertion → trigger F).

**What the agent edited:** `sphinx/domains/python.py::unparse`.

**What the agent ruled out:** `sphinx/pycode/ast.py::unparse`, on the grounds that `", ".join([])` does not
raise.

**Why the guardrail marks the rule-out as insufficient:** all of A–G hold. The rule-out reason is *crash-only*
("does not crash") and the paired body is *output-producing* (`join` over elements, which returns `""` for an
empty container). The guardrail does not assert the output is wrong — it asserts the **rule-out evidence does
not address output**, so it cannot be credited as a source-grounded rule-out. The candidate is downgraded
`ruledOut → unclear`.

**Corrective prompt (non-oracle; the allowed framing):**

> Your rule-out explains why the paired renderer may not crash, but it does not explain why its output is correct
> for the same edge case. Either edit the paired implementation or give a concrete output-preserving reason.

This uses **none** of the forbidden phrasings (no `test_unparse[()-()]`, no FAIL_TO_PASS, no "the gold patch
changes ast.py", no expected output from hidden tests).

**What the guardrail still cannot prove:** it cannot prove the empty tuple must render as `"()"`, cannot supply
that fact, and **cannot guarantee the ast.py edit or resolve sphinx-7462.** A determined agent can answer the
prompt with a *new* output-preserving claim ("`", ".join([])` returns `""`, which is the correct rendering for
an empty annotation") that is still wrong relative to the hidden test — and the guardrail has no fair way to
refute it, because the refuting fact is oracle-only (M43 §1). The guardrail raises the bar; it does not close
the gap.

---

## 8. False-positive audit plan

**Method:** offline replay only. No Docker, no oracle, no live agent. Build fixtures from captured run artifacts
(M40/M42 sphinx runs under `results/runs/…`, untracked — read, never stage) plus small synthetic capsule
fixtures, and assert the guardrail's fire/no-fire verdict per case. This mirrors how `pivotInspectionContract`/
`semanticEditHypothesis` are already unit-tested against captured-manifest-shaped inputs.

Minimum validation set (each is an assertion the offline validator must encode):

| Case | Expected | Why |
|---|---|---|
| `sphinx-doc__sphinx-7462` | **SHOULD fire** | The canonical positive: paired `unparse`, edited python.py, ruled-out ast.py on crash-avoidance grounds, join() output construct. All of A–G hold. |
| `mwaskom__seaborn-3187` | **SHOULD NOT fire** *(unless evidence shows a same-operation edited/ruled-out pair)* | Negative control / over-edit guard. Its non-gold sibling (`relational.py::scatterplot`) is NOT an operation-like name and is not a same-name paired implementation; A fails. If a future capsule *does* surface a genuine same-operation pair with a crash-only rule-out, firing is correct — but the default expectation is silence. |
| `django__django-13195` | **SHOULD NOT fire** *(unless an exact operation-pair rule-out exists)* | Confirms the conjunctive trigger does not fire on ordinary multi-file edits without a same-operation crash-avoidance rule-out. |
| `xarray-3677` | **SHOULD NOT fire** | Gold-proxy mismatch / resolved via a non-gold file (per project memory). No clean same-operation edited/ruled-out divergence pair; firing here would be a false positive. |
| `django-10880` (safe no-context) | **SHOULD NOT fire** | Single-target aggregates task; no paired operation surfaced. Confirms silence on the simplest safe case. |
| **synthetic safe rule-out** | **SHOULD NOT fire** | Construct a fixture where a same-operation pair exists, the paired file is not edited, **but** the rule-out marker gives a concrete output-preserving reason (non-trigger d). Confirms the output-preserving exemption suppresses the flag. This is the single most important false-positive guard. |

**Acceptance criterion for proceeding to implementation:** the guardrail fires on exactly the SHOULD-fire cases
and is silent on all SHOULD-NOT cases across this set, with the synthetic safe-rule-out case proving the
output-preserving exemption works. If any SHOULD-NOT case fires, tighten F/G (the classifier or the
output-construct whitelist) before implementing live.

**Recorded coverage limit (no silent caps):** this set is small and sphinx-anchored. It validates *precision*
(no false positives on the controls) but not *recall* across the benchmark. The validator must log that it
covers 6 cases, not the full dataset, so "passes the audit" is never mistaken for "validated benchmark-wide."

---

## 9. Implementation sketch

**Files likely to change (precise, from repo inspection):**

1. **`src/capsuleV2/pivotInspectionCompliance.ts`** — *primary home.* Add a pure function, structurally parallel
   to the existing `detectRuleOutConflict` (M16), e.g.:

   ```ts
   // NON-ORACLE sibling of detectRuleOutConflict. Reads source semantics only; never failToPass.
   export function detectCrossImplementationOutputDivergence(
     candidate: RequiredPivotCandidate,
     editedFiles: readonly string[],
     decisions: readonly PivotDecisionMarker[],
     pairedGroups: readonly SemanticSymbolGroup[],   // from buildSemanticEditHypothesis
     pairedBodies: ReadonlyMap<string, string>,      // file -> surfaced source body (for G)
   ): CrossImplementationOutputDivergenceRisk | null
   ```

   New, small, pure helpers in the same file: `isCrashAvoidanceReason(evidence)` (trigger F lexicon + the
   output-preserving exemption from non-trigger d) and `hasOutputProducingConstruct(body)` (trigger G
   whitelist). Wire the verdict into `computePivotInspectionCompliance`: when a candidate would be `ruledOut`,
   run this detector (alongside M16) and, if it returns a record, push the id to `unclear` and the record into a
   new `crossImplementationRisks` field on `PivotInspectionCompliance`. Extend `buildCorrectivePrompt` to render
   the record's `correctiveAction` (output-correctness framing; no hidden-test language).

2. **`src/capsuleV2/semanticEditHypothesis.ts`** — *reuse, minimal/no change.* `buildSemanticEditHypothesis`
   already yields the paired `SemanticSymbolGroup`s and `hasEmptyContainerSignal`. Expose the per-file source
   bodies for G if not already reachable (they are derivable from the same `CapsuleV2Item.source` the builder
   reads). Prefer adding a tiny exported helper here over duplicating the def/name scan in the compliance module.

3. **`src/capsuleV2/renderHuman.ts`** — *no change for the corrective-prompt-only design.* The guardrail does not
   add an injected context section (that would re-enter the §10 budget problem). It only augments the post-hoc
   corrective prompt. Touch this file only if a future variant renders a first-pass advisory line.

4. **`benchmarks/stage5_vexp_swe_bench_smoke/*` analysis/report helpers** — a new offline audit script
   (`run_stage5_m45_*` pattern, like `run_stage5_m1{3,4,5}_*.ts`) that reads captured manifests + markers and
   prints the fire/no-fire verdict per §8 case. Report-only; reads artifacts, runs no agents.

**Posture (required choice):** **corrective-prompt only, flag-gated, no automatic patch replacement** — the
preferred initial implementation. Concretely:
- **Report-only first** inside the offline validator (§8) — verdicts printed, nothing wired to a prompt.
- Then **corrective-prompt only**, gated behind a new default-off flag (e.g.
  `--cross-impl-divergence-guardrail` / `VTRACE_ENABLE_CROSS_IMPL_DIVERGENCE`), reusing the existing
  `--pivot-inspection-enforcement` marker plumbing.
- **NOT** revision-triggering and **NOT** enforcement-blocking. It never spawns a revision pass, never gates
  finalization, never mutates the canonical patch.

**Cost:** pure string/source analysis, O(candidates × markers); no model call, no env, negligible. Keep it
static — do **not** introduce an LLM judge over the two bodies (M43 §8 cost risk).

**Is the implementation "trivial"?** It is *small* but **not trivial**: the F classifier (crash-avoidance vs
output-preserving language) and the G output-construct whitelist are the false-positive-bearing surfaces and
need the §8 validator to tune. Per the task's instruction, the spec does **not** conclude it is trivial, so **no
implementation is requested in this milestone.**

---

## 10. Accounting / truncation appendix (separate task — NOT solved here)

This is the M43 §6 finding, restated as a **distinct** task. It is **not** part of the guardrail and must not be
fixed inside the guardrail spec.

**The issue is context budget / truncation, not a counter bug:**
- `vtraceContextMaxChars = 12000` is a hard injection budget; the capsule context section is passed through
  `truncateContext(rawContext, 12000, …)`, which clips to 12000 chars and appends `[truncated to 12000 chars]`.
- Enabling the **M39 semantic hypothesis** (~466 chars) + **M41 edit-sufficiency checklist** (~765 chars) pushes
  the rendered capsule section **over** 12000 (control 11561 → treatment 12027).
- `truncateContext` then **clips the tail** and **evicts the pivot-neighborhood block** (treatment neighborhood
  tail 36 lines vs control 43). `vtraceContextChars` *does* count the checklist — it is a **content-budget
  interaction**, not an uncounted-append bug.
- This manifests **only with the default-off experimental flags enabled**, so default behavior is already
  byte-identical and unaffected.

**Separate task — M44-ACCT (≡ M43 §6 follow-up; tracked, not solved here):**
> Make the M39/M41 sections budget-safe and properly accounted, without changing default-off output.
> 1. Add observe-only char buckets to run telemetry: `semanticEditHypothesisChars`,
>    `editSufficiencyChecklistChars`, `capsuleContextBudgetTruncated` (bool), `capsuleContextEvictedChars` —
>    all `0`/`false`/identical when both flags are off.
> 2. Pick a budget policy so enabling the sections does not silently evict the pivot neighborhood — options:
>    (a) raise `vtraceContextMaxChars` by the rendered-section size *only when a section is enabled*; (b) render
>    the checklist *after/outside* the truncated capsule body; (c) account the sections in a separate budget.
>    Choose the one that keeps default-off byte-identical and does not reorder the default capsule body.
> 3. Tests (code changes ⇒ required): buckets include hypothesis+checklist when enabled; default-off rendered
>    context byte-identical; buckets sum consistently; no retrieval/candidate mutation (retrieval eval
>    byte-identical); existing M39/M41/renderHuman tests pass.
> 4. Run the deterministic retrieval no-change proof (rendering/accounting touched).

**Note on independence:** the M44 guardrail as specced is **corrective-prompt only** (post-hoc), so it adds
**no** injected-context chars and does **not** interact with this 12000-char budget. The two tasks are
orthogonal and can be ordered independently (§11).

---

## 11. Recommended next milestone

**C. M45 — build the offline validator for the guardrail before implementing it.**

Rationale:
- The mechanism is feasible and small (§9), but its entire value rides on **false-positive control** (§1, §8).
  The M12–M30 arc repeatedly burned milestones by coding before the fairness/over-edit boundary was pinned down
  (M43 §7). Building the §8 offline validator first — report-only, no live agents, no Docker — lets us prove
  precision on the sphinx positive and the seaborn/django/xarray/django-10880/synthetic negatives **before** any
  flag-gated prompt change ships.
- **Not A** (implement corrective-prompt guardrail now): premature — the F classifier and G whitelist are
  exactly the false-positive surfaces and need the validator to tune; implementing first risks an over-firing
  guardrail that costs resolution on correct siblings.
- **Not B** (fix context-budget/truncation first): real but **default-off-only** and already captured as
  M44-ACCT (§10); it is orthogonal to the guardrail and not on its critical path. It can proceed in parallel or
  after, on its own schedule.
- **Not D** (keep revision/enforcement diagnostic-only and stop): correct for the *revision/shadow/verifier
  sub-branch* (it stays diagnostic-only, off by default — unchanged by this spec), but too defeatist for the
  whole milestone: the static cross-implementation guardrail is a genuinely fair, unbuilt lever worth
  validating.
- **Not E** (need another feasibility audit): feasibility is settled here — yes, narrowly, corrective-prompt
  only. No further audit is needed before the validator.

After C passes its acceptance criterion (§8), the natural follow-on is the **corrective-prompt-only, flag-gated**
implementation of §9 (a subsequent milestone, with explicit approval).

---

## Constraints honored (required statement)

This spec and the mechanism it specifies require:

- **No gold patches.**
- **No hidden test names.**
- **No FAIL_TO_PASS / PASS_TO_PASS.**
- **No benchmark labels.**
- **No Docker.**
- **No shadow eval.**
- **No diagnostic verifier.**
- **No automatic canonical patch replacement.**
- **No default-on behavior.**

---

## Appendix — provenance & guardrails

- **No code changed** this milestone — specification only. No retrieval / ranking / scoring /
  candidate-generation / rendering touched, so the deterministic retrieval no-change proof is **N/A**.
- **No live agents, no Docker, no SWE-bench canonical evaluation, no diagnostic verifier, no
  `--allow-docker-verify`.** Pivot revision and pivot-inspection enforcement remain **off by default**.
- **The guardrail is NOT implemented** in this milestone (spec does not conclude it is trivial; §9).
- Evidence sources: `stage5_m43_gated_revision_enforcement_audit.{md,json}`, `stage5_m38…m42…` reports; modules
  `src/capsuleV2/semanticEditHypothesis.ts`, `src/capsuleV2/pivotInspectionCompliance.ts`,
  `src/capsuleV2/pivotInspectionContract.ts`, `src/capsuleV2/renderHuman.ts`; runner injection/budget path
  (`run_stage5_vexp_swe_bench_smoke.ts`).
- Structured companion: `stage5_m44_cross_implementation_guardrail_spec.json`.
</content>
</invoke>
