# Stage 5 repair conversion evidence: SymPy

_Generated: 2026-06-10T17:52:19.361Z_

_Curated, committed evidence. Read-only: this report re-runs nothing (no agent, no live critic, no repair, no Docker) and only re-states immutable artifacts from one run._

## Summary

First observed Stage 5 loss recovery: an unresolved VTRACE first patch became RESOLVED after critic-guided one-repair mode (Docker resolved=true).

- run: `eval-patchverify-before-sympy-16766`
- instance: `sympy__sympy-16766`
- firstPatchResolved=**false**
- repairedPatchResolved=**true**
- convertedUnresolvedToResolved=**true**
- evaluationRan=**true**, dockerUsed=**true**, evaluationError=**null**

## Pipeline

1. VTRACE first patch was **unresolved**.
2. Deterministic probes found a **wrong-scope** defect.
3. Live critic **agreed** and produced an actionable move/re-indent instruction.
4. One repair attempt produced a **changed, valid** patch.
5. Docker evaluation of a derived JSONL using **only the repaired modelPatch** **resolved** the instance.

## First patch

| field | value |
| --- | --- |
| firstPatchHash | 428bc414f215b92ce1db8bd1366af22018cc2b4dc1bf6fa5051b81b65a18e0be |
| resolved | false |

The first patch inserted `_print_Indexed` in the wrong class scope (into `AbstractPythonCodePrinter`, before `class PythonCodePrinter`), and Docker recorded it as **unresolved**.

## Critic finding

| field | value |
| --- | --- |
| scope_ok | false |
| defect class | wrong_scope |
| risk | medium |
| confidence | medium |
| repair_required | true |
| liveRepairRequired | true |
| agreementWithDeterministic | true |

**Repair reason:** Wrong scope: _print_Indexed landed in AbstractPythonCodePrinter rather than PythonCodePrinter (inserted_method_scope=fail, high), broadening the behavior to all subclasses beyond the intended printer class.

**Repair instructions:** Relocate the existing _print_Indexed method out of AbstractPythonCodePrinter and into the PythonCodePrinter class body, preserving the same implementation and indentation. This is a move/re-indent of the already-correct method, not a rewrite or new edit.

## Repair

| field | value |
| --- | --- |
| defect class | wrong_scope |
| instruction quality | actionable |
| validPatch | true |
| changedPatch | true |
| failedOpen | false |
| repairedPatchHash | c3abb49e99bbd71788f3ddf96fe735695ed830ebb08660683587335e996ac2ee |

Exactly one bounded repair attempt relocated `_print_Indexed` into the `PythonCodePrinter` class body (a move/re-indent of the already-correct method).

## Repaired-patch evaluation

| field | value |
| --- | --- |
| evaluationRan | true |
| dockerUsed | true |
| resolved | true |
| evaluationError | null |

Command: `node dist/cli.js evaluate /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-patchverify-before-sympy-16766/raw/vtrace/repair_eval/_repaired_eval_input.jsonl --mode docker --timeout 1800 (cwd: /home/calvin/code/vexp-swe-bench)`

## Conversion claim

firstPatchResolved=**false** and repairedPatchResolved=**true**, so convertedUnresolvedToResolved=**true**.

## Cost and token accounting

Additive recovery-path cost (critic + repair), kept separate from the original agent cost.

| leg | cost | input tok | output tok |
| --- | --- | --- | --- |
| live critic | $0.1218 | 4343 | 2487 |
| repair | $0.2076 | 6021 | 1396 |
| **total critic+repair** | **$0.3294** | — | — |

_Original agent cost (separate, NOT part of the recovery path): $0.3719 (claude-opus-4-5-20251101)._

## Safety properties

| property | value |
| --- | --- |
| original swebench JSONL modified | false |
| original first patch modified | false |
| repaired patch modified during evaluation | false |
| original workspace modified | false |
| evaluation used derived JSONL under repair_eval/ | true |
| first patch re-evaluated | false |

## Why this matters

This is the first observed Stage 5 loss recovery for VTRACE: an unresolved first patch became resolved after critic-guided one-repair mode. It demonstrates the full chain — deterministic probe → live-critic agreement → one bounded repair → Docker-confirmed resolution — end to end on a real SWE-bench instance.

## Non-claims

- This is ONE instance (sympy__sympy-16766); it does NOT prove aggregate improvement.
- It does NOT justify always-on repair; gated one-repair mode stays disabled by default.
- It does NOT compare VTRACE to VEXP.
- Evidence-only: this report re-runs nothing and only re-states immutable artifacts from one run.
- Conversion is claimed ONLY because the first patch was observed unresolved AND the repaired patch observed resolved under Docker.
- The original swebench JSONL, first patch, repaired patch, and workspace were never modified; the first patch was not re-evaluated.

