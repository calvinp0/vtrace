# Stage 5 — M43: Gated revision / enforcement path audit (post first-pass-text failure)

**Date:** 2026-06-18
**Type:** Audit / design milestone. **No live agents, no Docker, no SWE-bench eval, no diagnostic verifier.**
Evidence is drawn entirely from existing reports/artifacts (M12–M30 + M38–M42) and source modules.
**Anchor instance:** `sphinx-doc__sphinx-7462`.
**Prompted by:** M42 — the end-of-context edit-sufficiency checklist changed *reasoning* but not *edits*
(ast.py edit rate 0/3 both arms; resolved 0/3 both arms). Conclusion was to stop first-pass text prompts
and re-examine the gated revision/enforcement branch for a *fair, non-oracle* signal.

---

## 1. Executive verdict

- **What branch should we pursue next?** A **fair, static, non-oracle rule-out-evidence guardrail** built on
  the components that already exist and are already fair: M12 pivot-inspection enforcement + the
  `PIVOT_DECISION` marker contract + the M13 static compliance checker (`unclear` → corrective prompt). These
  already turn *"a pivot was seen but not edited"* into *"edit it or justify the rule-out with source-grounded
  evidence"* **with zero oracle input.** The only missing teeth is catching a rule-out that is *grounded but
  wrong*. The one fair lever that could add those teeth — a **static cross-implementation output-divergence
  check** on the shared edited branch — is **not yet built** and has real feasibility/false-positive
  questions. So the next step is to **spec it narrowly before coding** (see §7), not to implement blind.
- **What should we stop doing?** (a) First-pass *text-prompt* persuasion for sphinx — exhausted (M38–M42).
  (b) Treating the **revision / shadow-eval / verifier** path as a route to a *product* score: every version
  that produced or separated the ast.py edit used the **oracle** (injected FAIL_TO_PASS) or a **Docker test
  environment**; the fair verifier is non-discriminative and environment-bound. That path stays
  **diagnostic-only, off by default.**
- **Is there a fair non-oracle gated path?** **Partially, and not for this instance's resolution.** A fair
  gated path can reliably force *"edit-or-justify-with-evidence"* (M12+M13+markers, already fair). But it
  **cannot fairly force the *correct* ast.py edit for sphinx-7462**, because the deciding fact — *an empty
  tuple must render as `"()"`* — exists **only in the hidden test** `test_unparse[()-()]`. The problem
  statement asks only that "docs are built … with valid type annotations" (i.e. no crash), which the
  python.py-only fix satisfies. **No non-oracle signal grounds the missing fact for this instance** short of
  a per-instance test environment. This is the central honest finding of M43.

---

## 2. M38–M42 first-pass branch conclusion (why first-pass text is exhausted)

| milestone | first-pass mechanism (text only) | ast.py: surfaced / inspected / ruled-out / edited |
|---|---|---|
| M38 | sphinx edit-sufficiency audit (offline) | surfaced ✓ / — / wrongly ruled out / — |
| M39 | semantic edit hypothesis (render, top of context) | surfaced ✓ / — / — / — (offline design) |
| M40 | semantic hypothesis live A/B (n=3) | surfaced 3/3 / inspected 3/3 / ruled out / **edited 0/3** |
| M41 | + end-of-context edit-sufficiency checklist (render) | offline: renders, names both unparse sites |
| M42 | hypothesis + checklist live A/B (n=3) | surfaced 3/3 / inspected 3/3 / ruled out 3/3 / **edited 0/3** |

The progression moved the agent **all the way to the edit boundary** and no further:

- It is **surfaced** (secondary pivot, every run), **inspected** (read/grep, 3/3 in M40 and M42), and
  **explicitly deliberated** — by M42 the agent *completes a co-edit checklist and reasons about output
  correctness*, not just crashes.
- But the rule-out **survives every text intervention** because it is *plausible and issue-consistent*: the
  agent concludes `", ".join([]) == ""` is "correct output for an empty tuple, no crash" and rules ast.py
  out. Relative to the **problem statement** this conclusion is *defensible*; it is only wrong relative to the
  **hidden test**.
- **Why more first-pass text is exhausted:** stronger prompts can change *what the agent considers* (M42
  proved it now considers output correctness) but cannot supply the *ground-truth fact* the agent is missing.
  Adding text cannot make the issue text demand a rendering it never demanded. The remaining gap is factual,
  not rhetorical — so it is out of reach of any first-pass text prompt.

---

## 3. Historical gated-branch evidence (sphinx-doc__sphinx-7462)

| milestone | mechanism | ast.py edited? | resolved / shadow-resolved? | oracle contamination? | fair / product-like? | reusable part |
|---|---|---|---|---|---|---|
| M12 | pivot-inspection enforcement block (`EDITED`/`RULED_OUT` table) | **no** — `enforcement_no_effect`, agent still rules out | canonical 0/3 | **none** | **yes** (render-only, opt-in, no oracle) | the enforcement block itself + decision contract |
| M12 | `PIVOT_DECISION` markers | n/a | n/a | none | **yes** (agent-emitted format + static parser) | the marker contract |
| M13 | static compliance checker (edited/ruledOut/unclear/missing) | n/a (post-hoc audit) | n/a | **none** | fair, but **diagnostic_only** (doesn't re-prompt live) | `unclear`→`buildCorrectivePrompt` gate core |
| M14 | revision 2nd pass, **no** test context | **no** (empty patch; "inspected it and wrongly ruled it out") | n/a | none | fair **but ineffective** | gated trigger seam (`spawnHardGatePhase`) |
| M15 | revision 2nd pass **+ FAIL_TO_PASS in prompt** | **YES** (revised patch adds gold ast.py hunk, r2) | not yet evaluated | **YES** (injected `test_unparse[()-()]`) | **no** | revision scaffold (only fair *without* the oracle text) |
| M16 | rule-out conflict guardrail (symbol vs FAIL_TO_PASS test leaf) | **YES** (revised, r1+r2) | not yet evaluated | **YES** (consumes FAIL_TO_PASS labels) | **no** in default wiring | the *concept* of flagging a test-anchored rule-out |
| M17 | read-only shadow Docker eval | (revised) | **r2 RESOLVES in shadow**, r1 `shadow_no_effect` | **YES** (grader/oracle) | **no** (oracle-derived) | shadow harness (diagnostic, never wired to canonical) |
| M17.1 | sphinx revision split diagnosis | r2 also rewrote python.py; r1 did not | explains r2-only resolution | — | — | per-case split analysis |
| M18 | replacement / adoption guardrail | (revised) | r2 `replacementRecommended=true` | **YES** (recommendation is oracle-derived) | **no** — `canonicalReplaced=false` always | replacement-gate concept (kept off) |
| M19 | revision-mode fairness audit | — | — | **names the leakage**: only the oracle separated r1 vs r2 | — | the fairness taxonomy itself |
| M23 / M28.x | fair test discovery (sanitized prompt, output-grounded search) | **no** — agent **rules out** ast.py, keeps `_parse_annotation` | — | non-oracle **by M28.7** | fair **but needs_test_environment** | output-grounded discovery + provenance gate |
| M29 / M30 | isolated agent-selected test verifier | — | **non_discriminative_both_pass** (passes on original *and* revised) | **none** (`oracleGradingUsed=false`) | **diagnostic_only**, needs Docker, too expensive for default | the fair verifier seam |

**Net:** the canonical first-pass patch for sphinx-7462 **never resolved** (0) anywhere. The ast.py edit was
produced **only** by the opt-in second pass when the **hidden FAIL_TO_PASS test was injected** into the
revision prompt (M15/M16); it **shadow-resolved only once** (M17, r2, and only because r2 also rewrote
python.py); it was **never canonical and never adopted** (M18). The fair test-discovery/verifier arc
(M23–M30) reached genuinely non-oracle behavior but, for this instance, (a) only ran inside a Docker test
environment, (b) attached to `test_parse_annotation`/`python.py` while **ast.py was ruled out**, and (c) when
finally executed fairly, **did not discriminate** revised vs original. No fair mechanism ever reproduced the
oracle-only r1-vs-r2 separation, and none ever produced or verified the ast.py edit.

---

## 4. Component fairness classification

| component | classification | basis |
|---|---|---|
| pivot-inspection enforcement (M12) | **fair_product_like** | render-only, opt-in, no oracle, nothing project-specific (`pivotInspectionContract.ts`); but `enforcement_no_effect` on sphinx — shapes inspection/diff, not the edit |
| `PIVOT_DECISION` markers (M12 contract) | **fair_product_like** | agent-emitted output format + static tolerant parser (`parsePivotDecisionMarkers`, never throws); identical in a deployed run |
| static compliance checker (M13) | **diagnostic_only** (fair, non-oracle) | post-hoc; reads only observable run facts (edited/inspected/artifact files) + optional markers; "does NOT re-prompt a live agent." Becomes the *fair gate core* only when wired into a live loop |
| rule-out conflict detector (M16) | **oracle_contaminated** (default wiring) | detection logic is static/pure, but its trigger input is the withheld `failToPass` labels; the module itself flags evidence strings as "NOT prompt-safe." Has a fair-policy/`overlaps` path (M28.2) + problem-statement fallback — but for sphinx the problem statement lacks the fact, so the fair fallback has **no signal** |
| revision prompt (M14/M15) | **oracle_contaminated** as built; fair version **ineffective** | M15's effective prompt carries the `## Test expectation` = injected FAIL_TO_PASS; M14 without it produced an empty patch (wrong rule-out re-derived) |
| revision patch replacement (M18) | **unsafe_to_auto_adopt** | `canonicalReplaced=false` by policy everywhere; "No oracle-derived decision should mutate the canonical submitted patch" |
| shadow-eval adoption (M17/M18) | **oracle_contaminated** + diagnostic_only | shadow resolution is the benchmark grader; "must not be reported as a fair product benchmark score" (M19) |
| fair test discovery (M23/M28) | **fair_product_like** in mechanism, **needs_test_environment** in practice | sanitization works (no label reaches prompt by M28.3); behavior fair by M28.6/M28.7 — but the honest signal needs the per-instance Docker env; on host "both passes errored on import" (M23.1/M24) |
| isolated agent-selected test verifier (M25/M27/M29/M30) | **diagnostic_only** + **needs_test_environment** + **too_expensive_for_default** | runs end-to-end non-oracle (`oracleGradingUsed=false`) but only inside a multi-GB Docker image; **non-discriminative** on sphinx (M30); always `replacementRecommended=false`, `canonicalReplaced=false` |

**Dominant reusable component:** the **M12 enforcement block + `PIVOT_DECISION` markers + M13 `unclear`→corrective-prompt
gate** — the only cluster that is simultaneously *fair, static, non-oracle, environment-free, and already
implemented*, and that already produces *"edit it or justify with evidence"* for ast.py on sphinx-7462 with
no oracle. Its limitation is precisely the M43 gap: it credits any *grounded* rule-out, including the wrong
one the agent gives.

---

## 5. Candidate next mechanisms

| candidate | fair / non-oracle? | needs test env? | can it ground "empty tuple → `()`" for sphinx? | verdict |
|---|---|---|---|---|
| **A. agent-discovered test evidence** | yes if no labels leak (M28.7 reached it) | **yes** — the deciding test (`test_unparse[()-()]`) must be found, read, AND run; host env can't run it (M24); also non-discriminative when it does (M30) | only via the hidden test, and only in Docker | **blocked** by environment + cost + non-discrimination; stays diagnostic |
| **B. static output-equivalence / cross-impl divergence** | **yes** — pure source semantics, no oracle, no env | no | **partially**: can fairly flag "two same-name `unparse` impls diverge on the empty-`Tuple` branch you're editing — verify the divergence is intended"; it **does not supply `"()"`**, only raises the rule-out evidence bar | **most promising fair lever, but unbuilt + feasibility-uncertain** (needs real branch-level semantic analysis, FP controls) |
| **C. contradiction detector (rule-out vs issue demand)** | yes (if grounded in issue text, not test) | no | **no** — the sphinx issue demands only "no crash / valid annotations"; it never demands a rendering, so there is no contradiction to detect fairly | **structurally blocked for this instance** |
| **D. gated second-pass revision** (trigger: seen + ruled-out + checklist + no edit) | trigger is fair; **prompt is the problem** | no (trigger) | **no** without oracle: M14 (fair prompt, no test) re-derived the wrong rule-out → empty patch | fair as a *trigger*, but the fair revision prompt is **ineffective** (M14); effective only with oracle (M15) |
| **E. manual / diagnostic branch only** | n/a | n/a | n/a | the correct status for the revision/verifier sub-branch (keep off by default, research artifact) |

Only **B** is both fair and not yet exhausted. But B yields a *flag/obligation*, not the missing fact, so even
B cannot *guarantee* the ast.py edit — it can only make a same-name-sibling rule-out harder to assert without
checking output equivalence. Its feasibility (cheap static analysis vs. an LLM judge) and false-positive
behavior across the benchmark are genuinely open. That is why §7 recommends specifying B before building it.

---

## 6. Accounting bug status — **investigated; NOT fixed (documented + M44 task), root cause corrected**

The M42 report described this as *"vtraceContextChars is stamped before the checklist is appended."* That
framing is **imprecise**. The true root cause, verified from the M42 treatment artifacts:

- `vtraceContextMaxChars = 12000` is a **hard injection budget** (`run_stage5_…ts:866`). The capsule context
  section is passed through `truncateContext(rawContext, 12000, …)` (`:5534`), which clips to 12000 chars and
  appends `[truncated to 12000 chars]`.
- **Control** capsule context = 11561 chars → under budget → `truncated=false`, neighborhood intact (43 tail lines).
- **Treatment** adds the semantic hypothesis (~466 chars) + edit-sufficiency checklist (~765 chars), pushing
  the section over 12000 → `truncated=true`; `vtraceContextChars = 12027` ≈ budget + marker. The injected
  snapshot carries `[truncated to 12000 chars]` **inside the pivot-neighborhood block** — the neighborhood
  tail (lead-pivot support symbols) is **evicted** (treatment neighborhood tail 36 lines vs control 43).
- So `vtraceContextChars` **does** include the checklist (it sits at snapshot line 256, before the cut at line
  274); it is *not* an uncounted-append bug. The real issue is that **enabling the M39/M41 sections near the
  budget evicts downstream neighborhood content** — a *content-budget interaction*, not a counter bug. (The
  13673-char snapshot vs 12027 measured is reconciled by the `STAGE5_TOKEN_DISCIPLINE` footer appended after
  the truncated section.)

**Why not fixed here:** this is **not** a low-risk accounting tweak. It touches the shared 12000-char injection
budget that governs *what content reaches the agent for every instance*. Any change (raise budget, render
hypothesis/checklist outside the budget, reorder so neighborhood is not evicted, or split the cap) alters
injected context → agent behavior → **not byte-identical** for flagged runs, and risks perturbing the
injected capsule body broadly. The M43 constraints forbid changing capsule output / candidate behavior as a
side effect, and this is a report-primary milestone. The interaction only manifests with the **default-off**
experimental flags enabled, so default behavior is already byte-identical and unaffected.

### Precise M44 follow-up task (accounting/instrumentation)

> **M44-ACCT.** Make the M39/M41 sections budget-safe and properly accounted, without changing default-off output.
> 1. Add additive char buckets to run telemetry: `semanticEditHypothesisChars`, `editSufficiencyChecklistChars`
>    (rendered-section lengths), and `capsuleContextBudgetTruncated` (bool) + `capsuleContextEvictedChars`.
>    These are observe-only and must be `0`/`false`/identical when both flags are off.
> 2. Decide and implement budget policy so enabling the sections does **not silently evict** the pivot
>    neighborhood: options to evaluate — (a) raise `vtraceContextMaxChars` by the rendered-section size *only
>    when a section is enabled*; (b) render the checklist *after/outside* the truncated capsule body so it
>    cannot displace neighborhood; (c) account the sections in a separate budget. Pick the one that keeps
>    default-off byte-identical and does not reorder the default capsule body.
> 3. Tests (required because code changes): (i) `vtraceContextChars`/buckets include hypothesis+checklist when
>    enabled; (ii) default-off rendered context byte-identical to current; (iii) char buckets sum consistently
>    with the section render lengths; (iv) no retrieval/candidate mutation (retrieval eval byte-identical);
>    (v) existing M39/M41/renderHuman tests still pass.
> 4. Run the deterministic retrieval no-change proof (rendering/accounting touched).

---

## 7. Recommended next milestone

**E. M44 — write a narrower implementation spec before coding.**

Specifically: spec a **fair, static, non-oracle "rule-out evidence guardrail"** (candidate B — static
cross-implementation output-divergence) that raises the bar on ruling out a *same-name sibling pivot* without
checking output equivalence on the branch being edited. The spec must close the questions the M12–M30 arc kept
hitting *before* any code is written:

1. **Fire conditions.** Exactly when does it trigger? (proposed: two surfaced pivots share a symbol name, the
   agent edits one and emits a `RULED_OUT` for the other, and both implement the same input branch the edit
   touches.) Must be derivable from surfaced pivots + the agent's `PIVOT_DECISION` markers — **no oracle, no
   FAIL_TO_PASS, no test execution.**
2. **The divergence check.** How to *fairly* determine the two implementations diverge on the relevant
   empty/edge input — cheap static heuristic vs. an LLM judge over the two source bodies — and how to bound
   false positives (siblings that legitimately differ).
3. **Action.** It produces a *flag / obligation* ("verify these siblings agree on empty-container output, or
   justify the divergence"), **not** an auto-edit and **not** an oracle-graded gate. It must remain advisory
   and default-off.
4. **Offline validation method.** How to validate *without Docker and without oracle* — e.g. replay against
   captured M40/M42 sphinx artifacts + the seaborn-3187 negative control (must **not** fire) — since the arc
   repeatedly burned milestones by coding before the fairness/over-edit boundary was defined.
5. **Recorded scope limit.** The spec must state explicitly that **sphinx-7462's resolving fact is
   oracle-only** (problem statement demands no rendering), so this guardrail is expected to *improve rule-out
   discipline generally*, **not** to resolve sphinx-7462; and that the revision/shadow/verifier path stays
   **diagnostic-only, off by default** (the M44-ACCT item is independent instrumentation).

Why **E** and not the others:
- **Not A** (implement contradiction detector): the issue-grounded contradiction (candidate C) is structurally
  blocked for sphinx; the only viable variant is the static divergence check (B), whose feasibility/FP
  behavior is unproven — spec first.
- **Not B** (agent-discovered test gate): blocked by test-environment dependency, cost, and the M30
  non-discrimination result; it is oracle-free but cannot run fairly off-Docker and adds no separation here.
- **Not C** (accounting first): the accounting interaction is real but default-off-only and already captured
  as M44-ACCT; it should not gate the design question and is not on the critical path.
- **Not D** (declare the whole branch diagnostic-only): correct for the *revision/verifier sub-branch*, but
  too defeatist for the whole milestone — one genuinely fair, unbuilt lever (B) remains worth specifying.

---

## 8. Risks

- **Oracle leakage.** The single biggest historical trap: every effective revision used injected FAIL_TO_PASS
  (M15/M16), and M28.1 caught a literal `test_unparse[()-()]` leaking into a "clean" prompt. Any M44 mechanism
  must be provably free of withheld test labels (static input audit, like M28.2/M28.3).
- **Over-editing.** M12's enforcement already warns "do not add files merely because listed." A divergence
  flag that fires too readily would push agents to edit correct siblings (e.g. seaborn-3187's non-gold
  `relational.py`) — false positives directly cost resolution. FP control is a first-class spec requirement.
- **Cost.** First-pass text additions are cheap and bounded (M42: +298 deterministic tokens) — but they evict
  neighborhood at the 12000 budget (§6). A divergence check done by an LLM judge adds real per-pivot cost;
  keep it static if possible, and default-off regardless.
- **Test-environment dependency.** Any test-execution-based signal needs the per-instance Docker image (M24);
  it cannot run in the agent's host loop and is too expensive for a default. This rules test-execution out of
  the *product* path and confines it to diagnostics.
- **Stochasticity.** The revision pass is stochastic on the same instance (M29.2: one run no-op, siblings
  produced deltas). Any gate evaluated live must be assessed over replicates, not a single run, and offline
  replay should be preferred for validation.
- **Auto-adoption safety.** Even a clean fair pass is not adoption evidence (M30 non-discriminative; M19/M18).
  `canonicalReplaced` must stay `false`; no mechanism should mutate the submitted patch on a non-oracle signal
  whose resolution effect is unproven.

---

## Appendix — provenance & guardrails

- **No code changed** this milestone — report/design + accounting investigation only. No retrieval / ranking /
  scoring / candidate-generation / rendering touched, so the deterministic retrieval no-change proof is N/A.
- **No live agents, no Docker, no SWE-bench canonical evaluation, no diagnostic verifier, no
  `--allow-docker-verify`.** Pivot revision and pivot-inspection enforcement remain **off by default**.
- Evidence sources: reports `stage5_m12…m30…`, `stage5_m38…m42…`; modules `pivotInspectionContract.ts`,
  `pivotInspectionCompliance.ts`, `pivotRevisionPass.ts`, `semanticEditHypothesis.ts`, `renderHuman.ts`;
  runner injection/budget path (`run_stage5_vexp_swe_bench_smoke.ts:866,5510-5538`); M42 captured artifacts
  under `results/runs/eval-m42-*/` (untracked; not staged).
- Structured companion: `stage5_m43_gated_revision_enforcement_audit.json`.
