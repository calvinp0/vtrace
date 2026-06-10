# Stage 5 patch critic / repair loop design

_Design / spec only. No agents, no Docker, no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY behavior changes, and no raw-artifact mutation. This document proposes a benchmark-only mechanism; nothing here is implemented yet._

_Companion machine-readable spec: `stage5_patch_critic_repair_loop_design.json`._

## Summary

Two passive prompt mechanisms have now been tested on top of PIVOT_CHECK against the same three known VTRACE losses (`sympy__sympy-16766`, `matplotlib__matplotlib-22719`, `psf__requests-5414`), all originally classified `patch_mistake_despite_good_context`:

- **EDIT_GUARD** (`c71232f`, compared in `9962b8b`): 0/3 → 0/3 resolved, 0 conversions, cost/tokens up.
- **PATCH_VERIFY** (`4cf9d95`, compared in `37eda12`): 0/3 → 0/3 resolved, 0 conversions, mean Δcost +$0.0736 and mean Δtokens +188,833, and verification behavior was **not observable** from artifacts (the harness captures the progress stream and the final patch, but not the agent's reasoning / final response).

In both experiments retrieval was not the bottleneck, pivot inspection was not the bottleneck, and edited-file / hidden-pivot engagement stayed stable. Passive prose changed patch *shape* (e.g. on `requests`, PATCH_VERIFY moved the patch toward a minimal/additive form) but converted **no** task to resolved.

This document specifies an **active patch critic / repair loop**: after the agent produces its first patch, run deterministic patch probes and an explicit critic that emits a *structured, visible* report; if the critic flags a high-confidence defect, allow exactly one bounded repair attempt; then evaluate the final patch with Docker as usual. The key difference from PATCH_VERIFY is that the verification is **externalized into inspectable artifacts** (critic input, critic report, repair attempt, first/final diffs) instead of living in hidden model reasoning, and that it can **act** (one repair) rather than only advise.

## Why passive prompt blocks were not enough

1. **Not observable.** PATCH_VERIFY asked the agent to self-verify, but the artifacts contain no evidence of whether it did. We could not distinguish "ignored the checklist" from "followed it but it was insufficient." A design that produces no inspectable signal cannot be debugged or trusted.
2. **No corrective action.** Both EDIT_GUARD and PATCH_VERIFY are advisory text injected *before* the agent finalizes. Once the model commits to a patch shape (wrong class scope, missing empty-array branch, broad rewrite), more prose in the same turn did not pull it back across the bar.
3. **Cost without conversion.** Both mechanisms strictly increased cost and tokens with zero resolution payoff on these three cases. Adding a third passive block is the same bet at higher stakes.
4. **The failures are patch-quality failures, not context failures.** Localization was already correct in all three. The remaining gap is between "a plausible edit in the right file" and "an edit that passes the hidden tests" — exactly the gap a *second-stage review with the power to request one fix* is meant to close.

## Design goals

The loop must make the three observed defects **visible before Docker evaluation**, each via a dedicated critic dimension backed by a deterministic probe where possible:

- **`sympy__sympy-16766` — wrong class/function/class-scope placement.** New printer methods landed in `AbstractPythonCodePrinter` instead of `PythonCodePrinter`. Goal: detect, from the diff + AST, *which* class/function each inserted method lands in, and surface a `scope_ok=false` with the enclosing-scope name when it is not the intended pivot class.
- **`matplotlib__matplotlib-22719` — failing empty-array behavior not fully handled.** The patch narrowed a deprecation-warning guard but never added the empty-array early return. Goal: surface `failing_behavior_handled=false` when the issue text names a concrete failing input (empty array) and the patch contains no guard/branch addressing it.
- **`psf__requests-5414` — broad control-flow rewrite instead of minimal additive validation.** Goal: surface `minimality_ok=false` when the patch deletes/restructures an existing branch where a small additive guard would suffice (large-deletion / rewrite heuristics).

Additional goals:

- Externalize verification into structured artifacts (inspectable, diffable, testable).
- Be conservative: at most one repair, and never force a repair on weak evidence.
- Be cheap by default: deterministic probes run first; the critic LLM call is bounded; repair is single-shot.
- Keep first-patch and final-patch outcomes **separately recorded** so we can measure the loop's marginal effect, not just the final number.

## Non-goals

- This does not improve retrieval.
- This does not change Capsule v2 ranking.
- This does not force editing every pivot.
- This does not claim VEXP parity.
- This does not replace Docker evaluation (the probes are warning signals, not correctness oracles).
- This does not make a statistical claim from three cases.

## Proposed run flow

```text
1. Run normal VTRACE treatment (PIVOT_CHECK, force-inject, Capsule v2, intent debug, budget 8000)
   and collect the FIRST patch + the usual run artifacts.
2. Run deterministic patch probes over the first patch + edited files + issue text
   (cheap, no Docker, no LLM): diff parse, AST/scope detection, minimality heuristics,
   failing-behavior pattern probes, narrow-test capture.
3. Run the critic over a BOUNDED input contract (issue text, first patch, edited-file
   snippets, capsule pivots, tool-call summary, probe output). The critic emits a strict
   structured report (see Critic output contract).
4. Decide repair (see Repair policy):
   - repair_required = true  -> proceed to step 5
   - repair_required = false -> skip to step 6 with final_patch := first_patch
5. Allow ONE repair attempt. The repair agent receives the critic report + first patch +
   bounded context and must MODIFY the existing patch (not restart the task). Capture the
   repaired patch.
6. final_patch := repaired_patch (if repair ran and produced a valid diff) else first_patch.
   Persist _first_patch.diff and _final_patch.diff and _patch_repair.meta.json.
7. Evaluate the FINAL patch with Docker as usual. Record first_patch_resolved (if separately
   evaluated) and final_patch_resolved.
```

The loop sits entirely between "agent produced a patch" and "Docker evaluation." It changes no retrieval, no Capsule, and none of the existing passive mechanisms.

## Critic input contract

The critic receives a single bounded JSON object. **Included fields:**

| field | description |
| --- | --- |
| `instance_id` | SWE-bench instance id (e.g. `sympy__sympy-16766`). |
| `repo` | Repository slug. |
| `issue_text` | The task / issue statement given to the agent. |
| `first_patch` | The agent's first patch as a unified diff. |
| `edited_files` | List of files touched by the first patch. |
| `capsule_pivots` | Capsule v2 pivots (path, symbol, roleReason, estimatedTokens) as injected. |
| `hidden_pivot_engagement` | Count/summary of hidden pivots read or edited per the ordered tool log. |
| `ordered_tool_calls_summary` | Deterministic summary of tool calls (categories + counts + key paths), not the raw stream. |
| `relevant_file_snippets` | Bounded snippets around each edited hunk and each known pivot symbol. |
| `tests_run_by_agent` | Whether/which test or repro commands the agent ran (from tool log). |
| `test_or_probe_output` | Captured narrow-test / probe output, truncated to a bound. |
| `treatment_metadata` | Treatment flags (pivot-check / edit-guard / patch-verify injected, capsule engine, budget). |
| `deterministic_probe_results` | The output of the deterministic probes (see below) so the critic reasons over facts, not guesses. |

**Excluded / bounded:**

- No full repository dump.
- No unrestricted giant context.
- Snippets are bounded around edited hunks and known pivots (e.g. ±N lines per hunk, one symbol body per pivot, with a total char cap).
- Prefer deterministic summaries over raw full streams (tool-call summary, not the raw agent stream).
- `test_or_probe_output` is truncated to a fixed cap with a marker when elided.

## Critic output contract

The critic MUST return exactly this schema. It must not silently pass: every boolean dimension must carry an `*_evidence` string, and a `true`/`null` with empty evidence is itself treated as `repair_required` per the repair policy.

```json
{
  "scope_ok": true,
  "scope_evidence": "Inserted method _print_Indexed lands in class PythonCodePrinter (line 357), matching pivot symbol.",
  "failing_behavior_handled": false,
  "failing_behavior_evidence": "Issue names empty-array input; patch narrows the warning guard but adds no empty-array branch/return.",
  "minimality_ok": true,
  "minimality_evidence": "Patch is additive: +5/-0 lines, no existing branch deleted.",
  "test_evidence_ok": false,
  "test_evidence": "No narrow test or repro command observed in the tool log.",
  "risk": "medium",
  "repair_required": true,
  "repair_reason": "failing_behavior_handled=false with high confidence; empty-array path unaddressed.",
  "repair_instructions": "Add an early return for empty input arrays before the deprecation-warning guard; do not change the existing guard.",
  "confidence": "high"
}
```

Field rules:

- `scope_ok`, `failing_behavior_handled`, `minimality_ok`, `test_evidence_ok`: `true | false | null`. `null` means "could not determine" (e.g. scope not readable from the diff alone) and is explicitly *not* a pass.
- Each dimension has a required non-empty `*_evidence` string referencing concrete patch lines / probe results.
- `risk`: `"low" | "medium" | "high" | "unknown"`.
- `repair_required`: `true | false`.
- `repair_reason`: required non-empty when `repair_required=true`.
- `repair_instructions`: required non-empty when `repair_required=true`; must describe a *modification* to the existing patch, not a restart.
- `confidence`: `"low" | "medium" | "high"`.

A report that fails schema validation (missing evidence, contradictory fields) is rejected and re-requested once; a second failure is recorded as `critic_invalid` and the run proceeds with `final_patch := first_patch` (fail-open, no repair).

## Deterministic patch probes

Cheap signals that run without Docker and without an LLM. They feed `deterministic_probe_results` into the critic and also gate the repair policy. They are **warning signals, not correctness checks.**

| probe | output | targets |
| --- | --- | --- |
| diff parser | edited files, inserted/deleted line counts, hunk headers, per-hunk enclosing context line | all |
| Python AST parse check | does each edited file still parse after the patch is applied to a snapshot? | all (catches broken edits) |
| class/function scope detection | for each inserted method/def, the enclosing class/function name (from AST over the patched snapshot) | sympy (wrong class scope) |
| minimality heuristic | flags large deletions / rewrites (deleted-line ratio, deletion of an existing `if`/branch, net-negative hunks) | requests (broad rewrite) |
| failing-behavior pattern probe | when the issue text names a concrete failing input (e.g. "empty array"), check the added lines for a guard/branch matching a per-case pattern | matplotlib (empty-array) |
| narrow-test capture | extract any test/repro command the agent ran and its captured output from the tool log | all (test evidence) |

Probes are intentionally conservative: a flag is a hint for the critic, and probes never by themselves mark a patch as correct. Per-case patterns (e.g. the empty-array regex) live in a small registry keyed by instance/issue features so the probe set is data-driven, not hard-coded into control flow.

## Repair policy

Conservative, single-shot:

- **At most one repair attempt** per instance.
- The repair agent receives the **critic report + first patch + bounded context** (the same bounded snippets, not a fresh full task context).
- The repair must **modify the existing patch**, not restart the whole task. Output is a new unified diff over the same base.
- **Do not force repair when evidence is weak:** if critic `confidence` is `low` AND no deterministic probe failed, `repair_required` is overridden to `false`.
- **Request repair when a defect is high-confidence:** wrong scope, missing failing behavior, broad rewrite, or no test evidence — each, at high confidence (and/or a corroborating failed probe) — sets `repair_required=true`.
- If the repair produces an invalid diff, a non-applying patch, or an empty change, discard it and keep the first patch (`final_patch := first_patch`), recording `repair_attempted=true, repair_changed_patch=false`.
- The loop is **fail-open**: any critic/repair error degrades to evaluating the first patch, never to a worse-than-baseline state.

## Telemetry and artifacts

New per-run artifacts (written into the run's `raw/vtrace/` dir alongside existing ones; none overwrite existing artifacts):

| artifact | contents |
| --- | --- |
| `_patch_critic_input.json` | the exact bounded critic input contract object |
| `_patch_critic_report.json` | the critic's structured report (output contract) |
| `_patch_repair_attempt.json` | repair input + raw repair response (when repair ran) |
| `_first_patch.diff` | the agent's first patch |
| `_final_patch.diff` | the patch actually evaluated by Docker |
| `_patch_repair.meta.json` | rolled-up loop metadata (the fields below) |

Suggested metadata fields (in `_patch_repair.meta.json`, mirrored into the run meta for the ledger):

```text
vtracePatchCriticEnabled          # was the loop turned on for this run
vtracePatchCriticRan              # did the critic actually produce a (valid) report
vtracePatchCriticRepairRequired   # critic's repair_required decision (post-policy)
vtracePatchRepairAttempted        # did a repair attempt run
vtracePatchRepairChangedFiles     # did the repaired patch change the edited-file set
vtracePatchRepairChangedPatch     # did the repaired patch differ from the first patch
vtraceFirstPatchResolved          # docker result of the first patch (if separately evaluated; else null)
vtraceFinalPatchResolved          # docker result of the final patch
vtracePatchCriticCostUsd          # cost attributable to the critic call
vtracePatchRepairCostUsd          # cost attributable to the repair call
```

These are specified here only; no implementation is required now. The existing outcome-ledger and comparison scripts can later read these fields the same way they read `vtracePatchVerifyInjected` today.

## Experiment plan

First experiment on the **same three known losses**, with a clean two-arm split:

```text
before = PIVOT_CHECK only
after  = PIVOT_CHECK + PATCH_CRITIC_REPAIR
```

Do **not** include EDIT_GUARD or PATCH_VERIFY in either arm initially — isolate the critic/repair loop on top of PIVOT_CHECK alone, exactly as the PATCH_VERIFY experiment isolated PATCH_VERIFY.

Measure:

- **resolution conversion** (before→after resolved transitions; the primary signal).
- **patch-shape improvement** (reuse the existing patch-shape classifier vocabulary).
- **known defect fixed** (per-case probe: scope landed / empty-array handled / minimal-additive).
- **cost/token overhead** (critic + repair cost vs the passive baselines).
- **first patch vs repaired patch difference** (did repair change the patch; how).
- **critic precision** — did it flag *real* defects? (compare critic flags against the known per-case defects).
- **critic false positives** — did it demand repair where the first patch was actually fine?
- **repair success/failure** — did the one repair attempt produce a better (ideally resolving) patch?

**Preserve the current passive-prompt experiments as negative baselines.** The EDIT_GUARD and PATCH_VERIFY comparison reports (`stage5_edit_guard_3_loss_comparison.*`, `stage5_patch_verify_3_loss_comparison.*`) stay in place and are cited as the "passive guidance, 0 conversions" control against which the active loop is judged.

## Risks

- **Cost increase.** The loop adds a critic call plus (sometimes) a repair call on top of the agent run. Mitigation: deterministic probes first; bounded critic input; single-shot repair; report critic/repair cost separately so the overhead is explicit.
- **Critic hallucination.** The critic may invent evidence or misread the diff. Mitigation: feed it deterministic probe results and require concrete `*_evidence` referencing patch lines; reject schema-invalid / evidence-free reports.
- **Repair making the patch worse.** A repair could break a previously-plausible patch. Mitigation: AST-parse and apply-check the repaired patch; discard and fall back to the first patch on any failure; record `first` vs `final` separately so regressions are visible.
- **Overfitting to three cases.** Per-case probes (empty-array pattern, etc.) risk being tuned to these instances. Mitigation: keep probes generic where possible, keep per-case patterns in a clearly-labeled registry, and validate on additional losses before any generalization.
- **Benchmark contamination.** The critic must not see gold patches, hidden tests, or post-hoc loss analyses. Mitigation: the input contract excludes all of these; only issue text, the agent's own patch, bounded repo snippets, and probe output are allowed.
- **Hard-to-compare first vs final patch.** If only the final patch is Docker-evaluated, first-patch resolution is unknown. Mitigation: optionally Docker-evaluate the first patch too (more cost) or, at minimum, record `vtraceFirstPatchResolved=null` honestly and rely on the existing before-arm as the first-patch proxy.
- **Docker still required.** Probes are warning signals, not correctness oracles; final judgment remains Docker resolution. The loop does not change that.

## Recommended implementation milestones

Small, independently-committable steps; each is benchmark-only and disabled by default until the experiment.

1. **Design doc only** (this document + companion JSON).
2. **Patch probe utilities** over existing artifacts: diff parser, AST/scope detection, minimality heuristics, failing-behavior pattern registry, narrow-test capture — pure functions with unit tests, run over the existing six passive-experiment runs as fixtures.
3. **Critic input/report schema + report-only dry run.** Define and validate the input/output contracts; run the critic in *report-only* mode (no repair, no behavior change) over the existing six passive experiments to sanity-check precision/false-positives before wiring anything live.
4. **Critic prompt/invocation behind a disabled-by-default benchmark flag** (e.g. `--enable-patch-critic`), writing `_patch_critic_input.json` / `_patch_critic_report.json` but taking no repair action.
5. **One-repair-attempt harness path behind a disabled-by-default flag** (e.g. `--enable-patch-repair`), writing `_first_patch.diff` / `_final_patch.diff` / `_patch_repair.meta.json`, with the fail-open guarantees above.
6. **Three-case controlled experiment + comparison report** (`PIVOT_CHECK` vs `PIVOT_CHECK + PATCH_CRITIC_REPAIR`), in the same style as the EDIT_GUARD / PATCH_VERIFY comparisons.

## Non-claims

- This is a design proposal, not an implementation.
- It does not run agents or Docker.
- It does not prove a critic loop will improve resolution.
- It does not compare against VEXP.
- It does not change current benchmark results.
- It is motivated by three targeted losses plus two negative passive-guidance experiments (EDIT_GUARD, PATCH_VERIFY).
