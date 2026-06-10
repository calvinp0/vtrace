# Stage 5 live critic high-risk comparison

_Generated: 2026-06-10T16:51:48.564Z_

_Reporting/analysis only. This report runs no agents, no live critic, and no Docker; it implements no repair and modifies no patch, workspace, or raw artifact. It only reads the artifacts the six gated live-critic observation calls already wrote._

## Summary

Across 6 gated high-risk live critic calls, the critic was a reliable structured-output observer: 6/6 valid reports, 0/6 failed-open. It agreed with the deterministic critic's repair_required on 4/6 runs (2 disagreements). Agreement was defect-class dependent: wrong_scope agreed, broad_rewrite_minimality agreed, missing_failing_behavior disagreed. Total cost $0.7102 (mean $0.1184/run; 25874 in / 13710 out tokens).

| metric | value |
| --- | --- |
| runsAnalyzed | 6 |
| validReportCount | 6 |
| failedOpenCount | 0 |
| agreementCount | 4 |
| disagreementCount | 2 |
| liveRepairRequiredCount | 4 |
| deterministicRepairRequiredCount | 6 |
| totalCostUsd | $0.7102 |
| meanCostUsd | $0.1184 |
| totalInputTokens | 25874 |
| totalOutputTokens | 13710 |

## Method

For each of the six runs that have live critic artifacts, this report reads `_patch_critic.meta.json` and `_patch_critic_report.json` (and `_patch_critic_input.json` / `_first_patch.diff` for safety checks), then compares the live critic's `repair_required` and per-field verdicts against the deterministic critic, grouped by defect class. Agreement is the milestone definition: `deterministicRepairRequired === liveRepairRequired`. No model is called; Docker resolution remains the only ground truth and is not consulted here.

## Runs included

| run | instance | defect class | det repair | live repair | agree | live risk | live conf | cost | valid | failed-open |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eval-patchverify-before-sympy-16766 | sympy__sympy-16766 | wrong_scope | true | true | true | medium | medium | $0.1218 | true | false |
| eval-editguard-before-matplotlib-22719 | matplotlib__matplotlib-22719 | missing_failing_behavior | true | false | false | low | medium | $0.0960 | true | false |
| eval-patchverify-after-matplotlib-22719 | matplotlib__matplotlib-22719 | missing_failing_behavior | true | false | false | low | medium | $0.0984 | true | false |
| eval-editguard-before-requests-5414 | psf__requests-5414 | broad_rewrite_minimality | true | true | true | medium | medium | $0.1380 | true | false |
| eval-editguard-after-requests-5414 | psf__requests-5414 | broad_rewrite_minimality | true | true | true | medium | medium | $0.1195 | true | false |
| eval-patchverify-before-requests-5414 | psf__requests-5414 | broad_rewrite_minimality | true | true | true | medium | medium | $0.1365 | true | false |

## Agreement with deterministic critic

Overall: 4/6 agreed; 2 disagreed.

| defect class | runs | agree | disagree | agreement rate | live repair_required | det repair_required |
| --- | --- | --- | --- | --- | --- | --- |
| wrong_scope | 1 | 1 | 0 | 100% | 1 | 1 |
| missing_failing_behavior | 2 | 0 | 2 | 0% | 0 | 2 |
| broad_rewrite_minimality | 3 | 3 | 0 | 100% | 3 | 3 |

## Results by defect class

### wrong_scope

- instances: sympy__sympy-16766
- runs: 1  ·  agree: 1  ·  disagree: 0  ·  live repair_required: 1/1
- note: Both critics agreed; live critic's instruction is actionable.

### missing_failing_behavior

- instances: matplotlib__matplotlib-22719
- runs: 2  ·  agree: 0  ·  disagree: 2  ·  live repair_required: 0/2
- note: The disagreement points to the deterministic probe being over-conservative (string matching), not obviously to the live critic under-calling. But the live critic's 'handled' verdict is unverified without executable reproduction; treat this class as undecided.

### broad_rewrite_minimality

- instances: psf__requests-5414
- runs: 3  ·  agree: 3  ·  disagree: 0  ·  live repair_required: 3/3
- note: All three requests runs agreed; live critic instructions are actionable.

## Added value over deterministic probes

**wrong_scope** (justifies cost: yes)

- deterministic probes already knew: inserted_method_scope probe FAILED (high): _print_Indexed landed in AbstractPythonCodePrinter, not PythonCodePrinter; repair required.
- live critic added: Human-readable synthesis plus a concrete move/re-indent repair instruction (relocate the method, preserving implementation/indentation).

**missing_failing_behavior** (justifies cost: uncertain)

- deterministic probes already knew: failing_behavior_pattern probe FAILED (medium): none of the literal tokens [values.size == 0, return, empty] matched the added code; deterministic critic requested repair.
- live critic added: Recognized a semantically-equivalent truthiness guard (`values.size`) the literal probe missed, judged the failing behavior handled, and DECLINED repair — contradicting the deterministic critic.

**broad_rewrite_minimality** (justifies cost: yes)

- deterministic probes already knew: minimality_rewrite_risk probe FAILED (high): broad control-flow rewrite (deletions / deleted control-flow lines); repair required.
- live critic added: Concrete regression-risk explanation (removing the unicode_is_ascii gate routes all ASCII hosts through IDNA, risking rejection of previously-valid hosts) plus concrete restore-and-narrow-guard repair instructions.

## Cost and token impact

| metric | value |
| --- | --- |
| total cost (USD) | $0.7102 |
| mean cost/run (USD) | $0.1184 |
| total input tokens | 25874 |
| total output tokens | 13710 |

| run | cost | input tok | output tok |
| --- | --- | --- | --- |
| eval-patchverify-before-sympy-16766 | $0.1218 | 4343 | 2487 |
| eval-editguard-before-matplotlib-22719 | $0.0960 | 4268 | 1413 |
| eval-patchverify-after-matplotlib-22719 | $0.0984 | 4234 | 1524 |
| eval-editguard-before-requests-5414 | $0.1380 | 4343 | 3005 |
| eval-editguard-after-requests-5414 | $0.1195 | 4343 | 2288 |
| eval-patchverify-before-requests-5414 | $0.1365 | 4343 | 2993 |

## Repair-instruction quality

Classification: `none` (no repair requested) · `generic` · `concrete` · `actionable`.

| run | defect class | live repair | instruction quality |
| --- | --- | --- | --- |
| eval-patchverify-before-sympy-16766 | wrong_scope | true | actionable |
| eval-editguard-before-matplotlib-22719 | missing_failing_behavior | false | none |
| eval-patchverify-after-matplotlib-22719 | missing_failing_behavior | false | none |
| eval-editguard-before-requests-5414 | broad_rewrite_minimality | true | actionable |
| eval-editguard-after-requests-5414 | broad_rewrite_minimality | true | actionable |
| eval-patchverify-before-requests-5414 | broad_rewrite_minimality | true | actionable |

SymPy (wrong_scope) and the three Requests (broad_rewrite_minimality) runs produced **actionable** repair instructions; Matplotlib (missing_failing_behavior) produced **none** because the live critic did not request repair.

## Safety properties

| property | value |
| --- | --- |
| observation only | true |
| repair performed | false |
| Docker run | false |
| failed-open count | 0 |
| valid report count | 6 |
| all patches unchanged | true |

## Interpretation

The live critic was reliable as a structured-output observer (6/6 valid, 0 failed-open) and agreed with the deterministic critic on 4/6 high-risk runs. Agreement was defect-class dependent: it agreed on every wrong_scope and broad_rewrite_minimality run, and disagreed on both missing_failing_behavior (Matplotlib) runs, where it did not request repair.

On the Matplotlib disagreement, the available evidence points to the **deterministic probe being over-conservative** rather than the live critic clearly under-calling: `failing_behavior_pattern` is a literal token matcher looking for `[values.size == 0, return, empty]`, and the patch implements a semantically-equivalent truthiness guard (`and values.size` / `if values.size else False`) that the probe could not match. The live critic recognized the equivalent guard and judged the failing behavior handled. However, missing-behavior defects are genuinely harder to judge without executable reproduction or issue-specific expectations, and the live critic's 'handled' verdict is itself unverified here. So the honest read is: the deterministic signal for this class is unreliable (string match), and the live correction is plausible but unconfirmed — the class is undecided, not resolved.

Net: the live critic looks useful for scope/minimality problems (agreement + actionable repair instructions) and should not be trusted to drive repair on missing-behavior defects until those defects have stronger executable evidence.

## Recommended next step

**Primary:** Implement a gated one-repair-attempt mode ONLY for live critic reports where liveRepairRequired=true, validReport=true, failedOpen=false, defectClass is wrong_scope or broad_rewrite_minimality, and repairInstructions are concrete/actionable. Exclude missing_failing_behavior for now.

Eligibility criteria:

- liveRepairRequired === true
- validReport === true
- failedOpen === false
- defectClass ∈ {wrong_scope, broad_rewrite_minimality}
- instructionQuality ∈ {concrete, actionable}

Runs eligible under these criteria today: eval-patchverify-before-sympy-16766, eval-editguard-before-requests-5414, eval-editguard-after-requests-5414, eval-patchverify-before-requests-5414.

**Secondary:** Add executable / narrow reproduction probes (or issue-specific expectations) for missing_failing_behavior before allowing repair on that class, since the deterministic signal there is a literal pattern match and the live critic's contradicting 'handled' verdict is unverified.

## Non-claims

- This report does not run agents, Docker, live critic calls, or repair.
- This report does not modify patches or workspaces.
- This report does not prove repair would improve SWE-bench resolution.
- This report does not justify always-on live critic usage.
- This report does not compare VTRACE against VEXP.
- This is a six-call high-risk observation, not a statistical benchmark.

