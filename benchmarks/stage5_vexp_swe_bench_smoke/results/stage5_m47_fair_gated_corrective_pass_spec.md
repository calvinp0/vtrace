# Stage 5 — M47: Fair gated corrective-pass spec

**Type:** design / spec milestone (no implementation, no live agents, no Docker, no canonical eval).
**Predecessor:** M46 (`bc7d2f3`) confirmed first-pass text is exhausted for sphinx even with the M45 budget fix.
**Case under study:** `sphinx-doc__sphinx-7462` — gold edits BOTH `sphinx/domains/python.py` AND `sphinx/pycode/ast.py::unparse` (empty `Tuple[()]` must render `"()"`). The agent surfaces `ast.py::unparse` as pivot #2 every run, then rules it out with a *grounded-but-wrong* reason.

---

## 1. Executive verdict

**Should we implement a fair gated corrective pass next?** Yes — but only as a **detector + corrective prompt**, never as a resolver or auto-adopter. The fair mechanism's realistic ceiling for sphinx is *"surface that the rule-out is insufficient and demand explicit behavior-correctness evidence"* — it cannot manufacture the hidden `"()"` fact.

**Which option is best?** **Option B — rule-out sufficiency checker.** It is the smallest mechanism that can actually *fire* on sphinx **without** an oracle. Option A (pure M12/M13 compliance) cannot fire on a *grounded* rule-out unless it borrows M16's FAIL_TO_PASS leaf-matching, which is oracle-adjacent. Option C (test-discovery) already hit the M30 `non_discriminative_both_pass` wall. Option D is the safe fallback, not progress. Option E (stop) is too pessimistic — B is viable as a detector even if it can't resolve sphinx.

**What should remain diagnostic-only?** Shadow eval (M17), the isolated in-loop verifier (M27/M29), every FAIL_TO_PASS/PASS_TO_PASS-derived signal (including M16's conflict detector *in its current oracle-adjacent form*), and any canonical patch replacement. These stay upper-bound diagnostics; none may set `canonicalReplaced` or feed product scoring.

**Sequencing.** Because the whole M-series discipline is *validate offline before any live run* (and §9 demands exactly that), the recommended **next milestone is E: build the offline validator first** (M48), then implement Option B behind a default-off flag (M49). M47 itself ships no code.

---

## 2. Why first-pass text is exhausted (M38–M46)

| M | Lever (all non-oracle, all default-off) | ast.py edit | resolved | Outcome |
|---|---|---|---|---|
| M38 | root cause: `seen_but_deemed_unnecessary` — pivot #2 surfaced with full source + edit/rule-out obligation; agent rules it out with the same grounded-but-wrong reason (`", ".join([])` is empty-safe → "no fix needed"), framing the bug as the *crash symptom* not the *required output*. | — | — | The only mechanism that ever flipped it (M14–M16) did so **by leaking the oracle**. No fair first-pass precedent exists. |
| M39 | top-of-context **semantic edit hypothesis** (reads only inlined candidate source; detects empty-collection/`join()`/`.pop()` output-shape trap). | — | — | Built; placed at top to survive truncation. |
| M40 | M39 live A/B | 0/3 both | 0/3 both | Raised inspection 2/3→3/3; never converted to an edit. Rec B: strengthen into end-of-context checklist. |
| M41 | bounded **edit-sufficiency checklist** at end of context. | — | — | Built, default-off. |
| M42 | M41 live A/B | 0/3 both | 0/3 both | Checklist reliably reframed rule-out into an output-correctness judgment — **agent answered wrong every time** (judged `""` correct for empty tuple). **Rec C: stop first-pass text.** |
| M44-ACCT | found truncation was **section-blind** — optional sections evicted the essential pivot-neighborhood (62% clipped in M42 treatment). A confound. | — | — | Measurement only. |
| M45 | **section-priority truncation** — drop optional/advisory before clipping essential evidence. | — | — | `essentialSectionsEvicted=false`; under-budget byte-identical. |
| M46 | budget-fixed edit-sufficiency A/B (re-run M42 with M45) | **0/3 both** | **0/3 both** | Even with essentials preserved 3/3, no edit. (Caveat: M41 checklist itself was budget-dropped; treatment = delivered portion only.) **Rec C confirmed.** |

**Conclusion:** three escalating, budget-protected, non-oracle first-pass text prompts all *reframed the reasoning* but never produced the ast.py edit. The decisive `"()"` fact is **hidden-test-only**; no amount of first-pass prose injects it fairly. **Stop first-pass text-prompt approaches for sphinx.** Return to the gated revision/enforcement/verification branch. Do not refit or rerun more first-pass text (M42 already showed the fully-injected checklist failed too).

---

## 3. Historical gated-branch lessons

| Milestone | Mechanism | Fair? | Oracle-contaminated? | Produced ast.py edit? | Product-like? | Reusable piece |
|---|---|---|---|---|---|---|
| M12 | `--pivot-inspection-enforcement` render block (EDITED/RULED_OUT obligation per non-lead pivot) | ✅ (injected guidance) | ❌ | No (guidance only) | ⚠️ off-by-default audit | **enforcement block + `PIVOT_DECISION` marker contract** |
| M13 | `computePivotInspectionCompliance` static checker + `buildCorrectivePrompt` | ✅ | ❌ | No (no live re-prompt) | ⚠️ would-fire only | **compliance verdict + corrective-prompt generator** |
| M14 | gated revision pass (`--pivot-revision-pass`); pure decide/prompt/record | ✅ | ❌ | No (scaffold) | ❌ never default | `decideRevisionPass` gate; conservative `decideReplacement` |
| M15 | revision-prompt enrichment (FAIL_TO_PASS + excerpts) | ⚠️ | **⚠️ FAIL_TO_PASS in prompt = leak seam** | (enabling) | ❌ | bounded excerpt builder; first-pass marker parse |
| M16 | `detectRuleOutConflict` — don't credit a grounded rule-out whose symbol/stem matches a FAIL_TO_PASS method leaf | ⚠️ detector | **✅ uses FAIL_TO_PASS leaf** | Triggers revision for sphinx-r1 | ❌ | conflict-overlap *structure* (sanitizable); the **trigger idea** |
| M17 | read-only shadow eval (revised patch in Docker copy; canonical untouched) | ❌ | **✅ Docker resolution** | r2 revision RESOLVES | ❌ diagnostic | hash-based canonical-untouched proof |
| M18 | adoption guardrail: split `revisionCandidate` / `replacementRecommended` / `canonicalReplaced` | ✅ (semantics) | reads oracle outcome | (records) | ❌ | **the boundary: diagnostic/shadow success ≠ product success** |
| M19 | revision-mode fairness taxonomy (Mode A/B/oracle) | ✅ analysis | flags the leak | — | ✅ defines product line | **`replacementRecommended` is oracle-derived → not fair product policy** |
| M23/M28 | agent-discovered-tests policy; prompt sanitization (`assertNoWithheldTestLabels`); `agent_discovered_hidden_match` provenance | ✅ | ❌ (labels withheld) | No | ⚠️ scaffold | **fair-policy prompt path + label-leak guard** |
| M25/M27/M29 | isolated in-loop verifier — build/apply/exec, STOP before grading.py | ✅ | ❌ (no grading) | (verification only) | ⚠️ diagnostic | non-oracle sandbox seam; `commandSafety`/`fairProvenance` |
| M30 | original-vs-revised fair comparison | ✅ | ❌ | — | ⚠️ | **the non-oracle limit: agent ran a fair test that passes under BOTH patches → `non_discriminative_both_pass`** |
| M44-spec | cross-implementation guardrail (paired-symbol join) — *spec only* | ✅ static | ❌ | (corrective obligation) | ⚠️ design | classify crash-avoidance-shaped rule-out; **NOT to be built yet** |

**Two boundaries the table establishes:**
- **M18→M19:** any adoption/selection that consumes a shadow-eval/Docker outcome is oracle-assisted. Keep it strictly diagnostic; require a *non-oracle* signal before scoring as product performance.
- **M30:** even a fully fair, agent-discovered, sandboxed command can be *non-discriminative* — so fair verification is necessary but not sufficient for sphinx, and certainly cannot be the *resolver*.

---

## 4. Candidate options

### Option A — compliance-only corrective prompt
Reuse M12/M13: require `PIVOT_DECISION` markers, parse first-pass decisions, corrective-prompt when a required pivot is unedited and not convincingly ruled out. No hidden tests, no auto-adoption.
- **Fairness:** ✅ fully fair (only the agent's own markers + observed edited/inspected files).
- **Expected benefit:** Low *for sphinx specifically*. A grounded rule-out is credited as `ruledOut` and **does not fire** — unless A borrows M16's conflict detector, which is FAIL_TO_PASS-keyed (oracle-adjacent). Without that, A fires only on `missing`/`unclear`/non-grounded rule-outs (seaborn-style under-edits), not sphinx's confident grounded wrong rule-out.
- **Risk:** false-quiet on the exact failure shape we care about.
- **Cost / complexity:** ~zero new code; the machinery exists.
- **Helps sphinx?** ❌ (silent on a grounded rule-out).
- **Generalizes?** ✅ catches honest skips / under-edits broadly.

### Option B — rule-out sufficiency checker  ★ recommended
Extend M13: classify a rule-out reason that explains **crash absence** but **not output correctness** as *insufficient* → mark `unclear` (not `ruledOut`) → route to corrective prompt. Make no claim that the hidden behavior is known.
- **Fairness:** ✅ fair — inputs are the agent's own rule-out evidence string + the M39 non-oracle output-shape signal (already inlined source). No FAIL_TO_PASS, no labels.
- **Expected benefit:** Medium. It is the *only* fair option that **fires on sphinx's grounded-but-wrong rule-out** ("`", ".join([])` is empty-safe" is crash-shaped, silent on what `unparse` should *return*). It cannot supply `"()"`, but it can force the agent to justify behavior-correctness from repo evidence or revise.
- **Risk:** over-firing on legitimately sufficient rule-outs (mitigated: conservative crash-vocabulary classifier; fire `unclear` not a hard reject; keep the M11/M12 anti-over-edit guardrail). False fire wastes one pass, never worsens the diff (M14 `decideReplacement` keeps the original).
- **Cost / complexity:** Low–medium — a pure classifier (`classifyRuleOutSufficiency`) over the rule-out evidence string + the existing `semanticEditHypothesis`. No new oracle plumbing.
- **Helps sphinx?** ⚠️ Fires correctly; resolution still bounded by the hidden fact (honest ceiling).
- **Generalizes?** ✅ any "fixed the crash, ignored the output" rule-out.
- **Note:** this is the *precursor* to — and strictly narrower than — the M44 cross-implementation guardrail (which adds paired-symbol grouping). Per non-goals, the cross-implementation guardrail is **not built here**; B classifies a *single* rule-out's reasoning only.

### Option C — fair test-discovery gated revision
Corrective prompt asks the agent to discover relevant repo tests (no hidden names), use only agent-discovered tests as verification, no Docker by default, no canonical replacement.
- **Fairness:** ✅ (M23/M28 already withhold labels and sanitize prompts).
- **Expected benefit:** Low for sphinx — **M30 already ran this end-to-end and got `non_discriminative_both_pass`**: the agent picked `test_parse_annotation`, which passes under both patches. The agent doesn't pick the discriminating `test_unparse[()-()]`.
- **Risk:** false confidence from a passing-but-irrelevant test; environment failures on old-dependency instances (M24).
- **Cost / complexity:** High — needs the M25/M27 sandbox seam live; heaviest path.
- **Helps sphinx?** ❌ (proven non-discriminative).
- **Generalizes?** ⚠️ only where the agent reliably finds the discriminating test.

### Option D — diagnostic-only revision branch
Keep revision purely as a research/upper-bound tool; never product-like, never used for benchmark claims.
- **Fairness:** N/A (explicitly diagnostic).
- **Benefit:** preserves the M17/M27 upper-bound measurements; no product progress.
- **Risk:** none new; just no forward motion.
- **This is the fallback if B fails offline validation.**

### Option E — stop this branch
Return to the broader-context benchmark if no fair path is strong enough.
- Premature: B is a viable *detector* even though it can't resolve sphinx. Reserve E for after B is offline-validated and shown to add nothing.

---

## 5. Recommended architecture

**Mechanism: a fair, static, non-oracle *rule-out sufficiency* gate that routes to a corrective prompt (Option B).** Built entirely on already-fair primitives (M12 enforcement block + `PIVOT_DECISION` markers, M13 `computePivotInspectionCompliance`, M39 `semanticEditHypothesis`). It is a **detector**, not a resolver, and never adopts a patch.

- **Trigger conditions (ALL must hold):**
  1. `--pivot-inspection-enforcement` on (the M13 checker is active) **and** a new `--ruleout-sufficiency-check` flag on (default-off).
  2. Capsule v2 context was injected (not baseline / no_context skip / v1).
  3. A required non-lead pivot / co-edit candidate exists, is **not edited**, and carries a **grounded** `RULED_OUT` marker (i.e. M13 would currently credit it as `ruledOut`).
  4. `classifyRuleOutSufficiency(evidence, semanticEditHypothesis)` returns `insufficient` — the rule-out reason is *crash-avoidance-shaped* (e.g. "won't raise", "empty-safe", "no `.pop()` on empty", "guard already handles None") and does **not** assert anything about the produced output/return value for the paired symbol the hypothesis flags.
  - Explicitly **no** FAIL_TO_PASS, PASS_TO_PASS, gold patch, or benchmark label is consulted at any step.

- **Inputs:** the M13 `PivotInspectionCompliance` verdict; parsed first-pass `PIVOT_DECISION` markers (evidence strings); the run's `semanticEditHypothesis` (non-oracle, already in context); edited/inspected file lists. No oracle inputs.

- **Outputs:** a re-classification of the affected candidate from `ruledOut` → `unclear` *with reason `insufficient_ruleout`* (keeping the run corrective-prompt-triggering), plus a corrective prompt (§6). The mechanism produces **no patch and no adoption decision**.

- **Prompt shape:** the §6 template, appended through the existing `buildCorrectivePrompt` / `buildRevisionPrompt` path under `verificationPolicy` left at `none` (no test-discovery block required for B). Carries only repo-evidence language; never names a test or expected output.

- **Artifact outputs (all `_`-prefixed, never staged):** reuse `REVISION_ARTIFACT_FILES`; add `_ruleout_sufficiency.json` (the classifier verdict + which candidate + reason). A live corrective turn, if ever wired, reuses the `_pivot_revision_*` artifacts. None match `swebench-*.jsonl`, so ingest/report never treat them as canonical.

- **Metadata fields:** see §8.

- **Default flags:** `--ruleout-sufficiency-check` **off**. Requires `--pivot-inspection-enforcement` (also off by default). Does **not** enable `--pivot-revision-pass`. No Docker, no `--allow-docker-verify`.

- **Adoption / replacement policy:** see §7 — **no automatic canonical replacement, ever, by default.** `canonicalReplaced` is hard-`false`.

- **Fairness boundary:** the gate consumes only (a) the agent's own rule-out evidence and (b) the non-oracle semantic hypothesis. It asserts *"this rule-out does not address output correctness,"* **never** *"the correct output is X."* It cannot and must not resolve sphinx by itself — the decisive `"()"` fact stays hidden-test-only.

---

## 6. Non-oracle corrective prompt shape (draft template)

```text
VTRACE could not confirm one of your pivot decisions.

Your first-pass patch edited one implementation but left a surfaced paired pivot unedited:
  - {candidate_id}

Your rule-out explains why that code may not crash, but it does not explain why its
output or return value is correct for the inputs the edited implementation now handles.

Either:
  (a) revise the patch so the paired pivot produces the correct output, OR
  (b) provide a concrete, behavior-preserving reason — grounded ONLY in repository
      evidence you can cite (source lines, docstrings, existing call sites) — for why
      its current output is already correct.

Rules:
  - Do not edit a file merely because it is listed. Inspect it and decide.
  - Prefer the minimal final diff; preserve already-correct changes.
  - If you keep the rule-out, cite concrete source evidence in a PIVOT_DECISION block.
```

**Allowed language** (mirrors the brief): "edited one implementation but left a surfaced paired pivot unedited"; "explains why it may not crash, but does not explain why its output/behavior is correct"; "revise the patch or provide a concrete behavior-preserving reason based only on repository evidence."

**Forbidden language (must never appear):** hidden tests, FAIL_TO_PASS, PASS_TO_PASS, `test_unparse[()-()]`, gold patch, or any expected output sourced from the benchmark. Enforced mechanically by reusing `assertNoWithheldTestLabels` over the rendered prompt whenever any test-expectation context is in scope.

---

## 7. Verification / adoption policy

- **No automatic canonical replacement by default.** `canonicalReplaced` is hard-`false`; the canonical artifacts are the first-pass `modelPatch`, unchanged.
- A revised patch (if a corrective turn is ever wired) may be **recorded as a candidate** (`revisionCandidate`) — telemetry only.
- **Adoption requires fair evidence**, exactly one of:
  - an **agent-discovered**, repo-justified, *discriminating* test that passes under the revised and fails under the original (M23/M28 provenance; M30 showed this is rare — `non_discriminative_both_pass` is the common outcome, and that is **not** adoption-eligible); or
  - **static repository evidence** the agent cites that a neutral reviewer could check; or
  - **explicit user approval.**
- **Shadow eval (M17) and the isolated verifier (M27/M29) remain diagnostic-only** — upper-bound measurement, never an adoption signal, never product scoring. This preserves the **M18 boundary: diagnostic/shadow success is not product success** (M19: `replacementRecommended` derived from a Docker outcome is oracle-assisted and not a fair product policy).

---

## 8. Metadata / accounting

Recorded in `_ruleout_sufficiency.json` and surfaced in the run meta (adapted to the existing `PivotRevisionRecord` / compliance shapes):

```ts
interface RuleOutSufficiencyAccounting {
  correctivePassTriggered: boolean;     // gate fired (insufficient grounded rule-out found)
  triggerKind: "insufficient_ruleout";  // the only kind this milestone introduces
  triggerEvidence: string[];            // label-free: candidate id + crash-vocab matched + hypothesis tag
  oracleFree: true;                     // invariant for this mechanism; asserted, never computed from FAIL_TO_PASS
  revisedPatchProduced: boolean;        // false unless a corrective turn is wired (off by default)
  canonicalReplaced: false;             // hard invariant
  adoptionEligible: boolean;            // false unless fair evidence per §7
  adoptionReason?: string;              // e.g. "not_verified" | "agent_discovered_discriminating" | "user_approved"
}
```

`triggerEvidence` is built from `RuleOutConflictOverlap`-style label-free facts (candidate symbol/stem + matched crash-vocabulary token), **never** a test node. `oracleFree` is an asserted invariant: the code path that sets `correctivePassTriggered` must not read any FAIL_TO_PASS/expectation field — a unit test pins this.

---

## 9. Offline validation plan (before any live run)

Pure-replay over captured M38–M46 sphinx artifacts (`results/runs/*/raw/`); no agents, no Docker, no grading.

1. **Replay existing M38–M46 sphinx artifacts** — feed each captured run's compliance verdict + first-pass `PIVOT_DECISION` evidence + `semanticEditHypothesis` into `classifyRuleOutSufficiency`.
2. **Confirm the trigger fires** on the insufficient ast.py rule-out (`ast.py::unparse` grounded as "empty-safe / no `.pop()`" → `insufficient` → `unclear` → corrective).
3. **Confirm no hidden labels leak** — run `assertNoWithheldTestLabels` over every rendered corrective prompt; assert the classifier reads no FAIL_TO_PASS/PASS_TO_PASS field (code-path test + grep guard).
4. **Confirm no trigger on an accepted concrete rule-out fixture** — a rule-out that *does* assert output correctness with cited source must stay `ruledOut` (no false fire); add the seaborn grounded-rule-out fixture as a negative.
5. **Confirm no trigger on no-context / traceback-localized cases** — baseline / `no_context` skip / single-pivot runs produce an empty verdict and never fire (gate clauses 1–3).
6. **Confirm budget metadata unaffected** — `vtraceContextBudget` / `essentialSectionsEvicted` byte-identical to M45 (this mechanism is finalize-time, post-injection; it must not touch retrieval, ranking, scoring, candidate generation, or truncation). Prove with the deterministic retrieval no-change CSV diff if any `src/` file changes.

Acceptance: trigger fires on sphinx, stays quiet on the negatives, leaks nothing, retrieval byte-identical. Only then consider a flag-gated live corrective turn (separate approval).

---

## 10. Next milestone recommendation

> **E. M48 — build offline validator before any implementation.**

Rationale: M47's recommended *architecture* is **Option B** (rule-out sufficiency checker), but the M-series discipline is unbroken — every mechanism is offline-validated against captured artifacts before a single live token is spent (§9, and the whole M13/M16/M40/M46 pattern). So the correct immediately-next step is the **offline validator** that proves B's trigger fires on the sphinx insufficient rule-out, stays quiet on the concrete-rule-out and no-context negatives, and leaks no labels. A subsequent **M49** then implements Option B behind a default-off `--ruleout-sufficiency-check` flag, corrective-prompt-only, no auto-adoption. If the M48 validator shows B cannot fire fairly or only false-fires, fall back to **D** (keep revision diagnostic-only) and return to the broader-context benchmark.

---

### Constraints honored
Spec-only; stayed on `main`; no productization, no UX polish; no live agents, no Docker, no SWE-bench canonical eval, no diagnostic verifier, no `--allow-docker-verify`; pivot revision and pivot-inspection enforcement remain default-off; no retrieval/ranking/scoring/candidate-generation change; no new first-pass prompt section; **cross-implementation guardrail explicitly deferred**; no raw artifacts staged; no unrelated dirty files touched.
