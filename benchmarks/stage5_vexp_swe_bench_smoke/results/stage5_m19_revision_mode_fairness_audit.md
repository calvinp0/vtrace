# Stage 5 — M19 revision-evaluation fairness audit

## 1. Executive summary

The pivot-revision chain (M14–M18) can now produce a revised patch, decide whether it is a
*candidate*, and verify whether it *resolves* via a read-only shadow Docker eval (M17/M18).
The shadow eval is sound diagnostic evidence, but it consumes the **SWE-bench
evaluator / FAIL_TO_PASS test oracle**. A real VTRACE product run does not get to ask the
benchmark's own grader "did this patch pass?" before choosing which patch to submit.

**Core fairness issue:** any patch-selection or adoption decision that depends on the
shadow-eval outcome is *oracle-assisted*. Reporting such a decision as a product benchmark
score would be **evaluator leakage** — it would credit VTRACE with information the deployed
system cannot have. M18's `replacementRecommended` is exactly such an oracle-derived
signal: it is a correct *diagnostic*, but not a fair *product policy*.

The fix is conceptual, not code: keep the oracle-derived signals (`replacementRecommended`,
shadow resolution) strictly as diagnostics/upper-bounds, keep `canonicalReplaced=false` by
default, and require a **non-oracle** adoption signal before any revision-enabled condition
can be scored as product performance.

## 2. Current revision chain (M14–M18)

| milestone | what it added |
| --------- | ------------- |
| **M14** | Revision-pass scaffold: gated second corrective pass; PURE core (decide/prompt/record); off by default (needs `--pivot-revision-pass` + `--pivot-inspection-enforcement`). |
| **M15** | Evidence enrichment: first-pass PIVOT_DECISION markers, FAIL_TO_PASS / problem-statement test-expectation context, bounded source excerpts fed into the revision prompt. |
| **M16** | Test-expectation-aware rule-out conflict guardrail: a grounded RULED_OUT is *not* credited when the ruled-out pivot token matches a FAIL_TO_PASS method leaf. |
| **M17** | Read-only shadow eval (`--mode evaluate-revised-patch`): evaluates a COPY of the canonical row with the revised patch swapped in; before/after hashing proves canonical artifacts untouched. First measured a revised patch that genuinely resolves (sphinx r2). |
| **M18** | Replacement/adoption guardrail: `decideRevisionAdoption` gates `replacementRecommended` on the shadow-eval outcome (not on compliance); corrected `replacedFinalPatch` to mean *actually replaced* (mirrors `canonicalReplaced`, false in live wiring); compliance improvement now only sets `revisionCandidate`. |

Key empirical facts carried forward:
- sphinx r1 and r2 had **identical compliance verdicts** and identical legacy
  `replacedFinalPatch=true`, yet only r2 resolved in shadow eval (M17.1). The *only* thing
  that distinguished them was the test oracle.
- seaborn r2's revised patch was identical to the original ⇒ skipped, not a candidate.

So today we have exactly **one** resolving revision example, and **no non-oracle signal**
has been shown to separate a resolving revision (r2) from a non-resolving one (r1).

## 3. Mode taxonomy

### Mode A — baseline VTRACE first-pass (FAIR)
VTRACE injects context; the agent produces one patch; canonical evaluation scores that
patch. No revision, no oracle peek. This is the fair product benchmark.

### Mode B — revision-candidate diagnostic (FAIR as telemetry only)
VTRACE runs the revision pass and records original/revised patches, compliance verdicts,
markers, prompts, and `revisionCandidate`. It does **not** replace the canonical patch and
makes **no** resolution claim unless separately shadow-evaluated. Fair as telemetry; not a
resolution score.

### Mode C — shadow-eval diagnostic / oracle (DIAGNOSTIC ONLY)
VTRACE evaluates the revised patch separately with SWE-bench Docker and uses the outcome to
set `replacementRecommended`. Useful for development and upper-bound estimation, but
oracle-assisted. Must **not** be reported as a fair product benchmark score.

### Mode D — revision-enabled product-like condition (POTENTIALLY FAIR, NOT YET)
VTRACE runs the revision pass and adopts the revised patch using **non-oracle signals
only** (patch non-empty, not over-edited, compliance improved, first-pass
markers/conflicts, and — if and only if the agent genuinely ran them inside its allowed
loop — its own self-run tests). Potentially fair, but **risky**: M17.1 proved compliance
improvement alone is unsafe, and no other non-oracle signal has yet been shown to
discriminate r1 from r2.

### Mode E — explicit oracle condition (ALLOWED ONLY IF LABELED)
VTRACE uses the shadow-eval outcome to *select* original-vs-revised. Permissible only when
explicitly labeled as an oracle / upper-bound / diagnostic ceiling — never as product
performance.

## 4. Claim table

| mode | uses revised patch? | uses SWE-bench/evaluator oracle? | fair product benchmark? | valid diagnostic? | allowed claim | forbidden claim |
| ---- | ------------------- | -------------------------------- | ----------------------- | ----------------- | ------------- | --------------- |
| **A** baseline first-pass | no | no (normal scoring) | **yes** | yes | "VTRACE first-pass resolves X%" | — |
| **B** revision-candidate diagnostic | recorded, not submitted | no | n/a (no score) | yes | "revision produced a candidate; compliance went unclear→edited"; telemetry on prompts/markers | "the revision improved resolution"; any pass/fail number |
| **C** shadow-eval diagnostic | yes (in a copy) | **yes** | **no** | yes | "revised patch *can* resolve (sphinx r2)"; "shadow upper-bound = N"; replacementRecommended as a diagnostic flag | "VTRACE+revision resolves X%"; counting shadow resolutions in the product score |
| **D** revision-enabled product-like | yes (adopted) | **no** (by construction) | **only if** the adoption policy is proven non-oracle | yes | (once validated) "revision-enabled VTRACE resolves X%" | claiming fairness before a non-oracle adoption policy is validated |
| **E** explicit oracle select | yes (oracle-chosen) | **yes** | **no** | yes (upper bound) | "oracle upper bound for revision = N (best-of original/revised)" | presenting E as achievable product performance |

## 5. Required conclusions

1. **What can we fairly claim today?**
   - Mode A first-pass resolution numbers.
   - Mode B telemetry: the revision pass runs, produces candidates, and improves the
     *compliance shape* (e.g. unclear→edited); markers/conflict-guardrail behavior.
   - Mode C/E **diagnostics**, explicitly labeled as oracle-assisted: "a revised patch can
     resolve where the first pass did not (sphinx r2)" and a shadow/oracle **upper bound**.

2. **What can we NOT claim?**
   - Any product-performance / resolution-rate improvement from revision. We have one
     oracle-confirmed resolving example and no non-oracle signal that distinguishes it from
     a non-resolving revision (r1).
   - That `replacementRecommended` reflects product behavior — it is computed from the
     evaluator oracle.
   - That compliance improvement implies resolution (M17.1 disproved this).

3. **What is needed before a revision-enabled condition (Mode D) is fair?**
   A **non-oracle adoption policy** that demonstrably separates resolving from
   non-resolving revisions *without* the SWE-bench grader — either (a) a signal the
   deployed agent legitimately has (e.g. tests the agent itself chose to run inside its
   allowed turn loop, with the cost budgeted and no FAIL_TO_PASS leakage), or (b) a
   structural policy validated to be safe on held-out cases. Until such a signal exists and
   is validated on more than one example, Mode D cannot be scored as product performance.

4. **Should `replacementRecommended` be used in normal benchmark scoring?**
   **No.** It is shadow-eval (oracle) derived. It stays a diagnostic flag only.

5. **Should `canonicalReplaced` remain false by default?**
   **Yes.** No oracle-derived decision should mutate the canonical submitted patch. It
   flips true only behind a future, validated, non-oracle adoption policy.

## 6. Recommendation

**Path D — investigate whether allowed in-loop test execution can provide a fair
verification signal.**

Rationale: M17.1/M18 established that the *only* signal proven to separate a resolving
revision (r2) from a non-resolving one (r1) is the test oracle. A non-oracle adoption
policy built on the signals we already have (compliance, markers, over-edit) is therefore
unsupported by evidence (Path A is premature). Pure safeguards/labeling (Path C) and
"return to first-pass context" (Path B) are both correct *postures* but neither moves us
toward a fair revision-enabled condition. Path D is the only direction that could yield a
verification signal a deployed agent actually has — tests the agent itself runs within its
allowed loop — provided we can show those runs do not leak FAIL_TO_PASS and that their cost
is budgeted into the comparison. The investigation is design/measurement first (does the
agent run tests at all? which? at what cost?), so it respects the "no implementation yet"
posture.

Until Path D produces a validated non-oracle signal, the default state remains Path B's
posture: revision is diagnostic-only, `replacementRecommended` is a flag, and
`canonicalReplaced=false`.

*(Not recommended yet: 30/100 sweeps.)*

## 7. Scope / safety

- Report-only. No live agents, no Docker, no 30/100 sweep, no canonical replacement, no
  retrieval/ranking/scoring/candidate changes. Revision pass remains off by default.
