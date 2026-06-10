# Stage 5 live critic smoke comparison

_Generated: 2026-06-10T16:33:46.283Z_

_Reporting/analysis only. This report runs no agents, no live critic, and no Docker; it implements no repair and modifies no patch, workspace, or raw artifact. It only reads the artifacts a single gated live-critic smoke run already wrote and renders this comparison._

Run: `eval-patchverify-before-sympy-16766`  ·  instance: `sympy__sympy-16766`  ·  status: `ok`

## Summary

The live critic smoke succeeded technically and semantically: valid schema, no fail-open, agreement with the deterministic critic on repair_required, the same wrong-scope diagnosis (_print_Indexed in AbstractPythonCodePrinter), a concrete move/re-indent repair instruction, and no patch modification. This is one live critic call only: it does not prove resolution improvement, does not prove repair would succeed, and does not justify always-on critic usage.

| metric | value |
| --- | --- |
| status | ok |
| live report valid | true |
| failed-open | false |
| repair_required agreement | true |
| same core defect | true |

## Smoke setup

A single gated, cost-capped, observation-only live critic call was run manually:

```
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_patch_critic_live.ts \
  --results benchmarks/stage5_vexp_swe_bench_smoke/results \
  --enable-patch-critic \
  --run-label eval-patchverify-before-sympy-16766 \
  --max-critic-runs 1 \
  --only-deterministic-repair-required \
  --critic-cost-cap-usd 0.25 \
  --out-name stage5_patch_critic_live_smoke_sympy
```

The live critic is disabled by default; it was reached only via the injectable caller, on exactly one run the deterministic critic had already flagged `repair_required`, and bounded by a single-call and cost cap. No repair, no patch modification, and no Docker were involved.

## Deterministic critic result

| field | value |
| --- | --- |
| scope_ok | false |
| risk | high |
| repair_required | true |
| confidence | high |

**inserted_method_scope probe**: `fail` (high) — Full-file reconstruction: inserted method(s) _print_Indexed in AbstractPythonCodePrinter (line 349) landed outside the expected class PythonCodePrinter. Resolved from the reconstructed file's indentation structure, not just the diff window.

**repair_reason**: inserted method(s) landed outside the expected class (high-confidence scope fail).

**repair_instructions**: Move the inserted _print_* methods into PythonCodePrinter; the diff shows them landing outside the intended class. Reconstruct full file scope to confirm placement before re-evaluating.


## Live critic result

| field | value |
| --- | --- |
| ran | true |
| validReport | true |
| failedOpen | false |
| scope_ok | false |
| failing_behavior_handled | true |
| minimality_ok | true |
| test_evidence_ok | — |
| risk | medium |
| repair_required | true |
| confidence | medium |

**scope_evidence**: inserted_method_scope (high) shows _print_Indexed was inserted into AbstractPythonCodePrinter (line 349), not the expected PythonCodePrinter class, resolved from full-file indentation reconstruction. The target file (sympy/printing/pycode.py) is correct, but the class placement is wrong relative to the expected scope.

**repair_reason**: Wrong scope: _print_Indexed landed in AbstractPythonCodePrinter rather than PythonCodePrinter (inserted_method_scope=fail, high), broadening the behavior to all subclasses beyond the intended printer class.

**repair_instructions**: Relocate the existing _print_Indexed method out of AbstractPythonCodePrinter and into the PythonCodePrinter class body, preserving the same implementation and indentation. This is a move/re-indent of the already-correct method, not a rewrite or new edit.


## Agreement analysis

Agreement metric: `deterministicRepairRequired === liveRepairRequired`.

| dimension | deterministic | live | agree |
| --- | --- | --- | --- |
| repair_required | true | true | true |
| risk | high | medium | false |
| confidence | high | medium | false |
| same core defect | — | — | true |

**Core defect (both)**: _print_Indexed inserted into AbstractPythonCodePrinter rather than the expected PythonCodePrinter (wrong class scope)

**Note**: Agreement is on repair_required only. The live critic gave a LOWER risk (medium vs high), reasoning the method is functionally inherited via AbstractPythonCodePrinter while still being too broad in scope.

## Added value over deterministic probes

Deterministic probes already knew:

- inserted_method_scope probe FAILED (high confidence)
- expected class was PythonCodePrinter
- actual class was AbstractPythonCodePrinter (line 349)
- repair was required (risk=high, confidence=high)

Live critic added:

- human-readable synthesis of the wrong-scope defect
- explicit risk framing (downgraded to medium with reasoning)
- a concrete move/re-indent repair instruction (relocate the method, not rewrite it)
- the observation that the behavior is functionally inherited but too broad in scope

The live critic added interpretive value (synthesis, risk reasoning, a concrete bounded repair instruction) but did not surface a defect the deterministic probes had missed. The defect, target class, and repair_required were already known deterministically; the live critic's contribution is the explanation and the actionable, minimal repair framing.

## Cost and token impact

| metric | value |
| --- | --- |
| critic cost (USD) | $0.1218 |
| input tokens | 4343 |
| output tokens | 2487 |
| cost cap (USD) | $0.2500 |
| within cost cap | true |

Cost is acceptable for a risk-gated critic that runs on at most one deterministic `repair_required` run and stops at the cap: $0.1218 against a $0.2500 cap. This says nothing about always-on cost, which is out of scope and not justified by one call.

## Safety properties

| property | value |
| --- | --- |
| observation only | true |
| repair performed | false |
| Docker run | false |
| patch unchanged | true |
| failed-open | false |
| live report valid | true |

The patch recorded in the critic input matches `_first_patch.diff` byte-for-byte (modulo trailing whitespace): the live critic preserved the no-patch-modification property.

## Recommended next step

**Run no-repair live critic observation over the remaining deterministic high-risk runs (still gated and cost-capped), before implementing repair.**

One gated live critic call is not enough signal to either implement repair or expand to low-risk runs. Extend the same observation-only, cost-capped harness to the remaining deterministic repair_required runs to see whether agreement and core-defect identification hold across instances and treatments. Do not implement repair and do not include low-risk runs yet.

Suggested run labels (deterministic repair_required, excluding the already-smoked run and all low-risk runs):

- eval-editguard-before-matplotlib-22719
- eval-patchverify-after-matplotlib-22719
- eval-editguard-before-requests-5414
- eval-editguard-after-requests-5414
- eval-patchverify-before-requests-5414

## Non-claims

- This report does not run agents, Docker, or repair.
- This report does not modify patches or workspaces.
- This report does not prove the critic improves SWE-bench resolution.
- This report does not prove a repair would succeed.
- This report does not justify always-on critic usage.
- This report does not compare VTRACE against VEXP.
- This is a one-call smoke result, not a benchmark.
- Agreement here is repair_required equality only; risk/confidence differ and per-field agreement is not asserted.

