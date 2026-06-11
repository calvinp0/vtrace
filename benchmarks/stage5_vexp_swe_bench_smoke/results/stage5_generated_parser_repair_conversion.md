# Stage 5 generated-parser repair conversion

_Generated: 2026-06-11T19:58:33.081Z_

_Benchmark-only, single-instance. Reuses the isolated repaired-patch evaluator for Docker; adds generated-parser patch-shape analysis, recovery-cost accounting, and a conversion verdict. Read-only: no raw artifact is modified and NO policy accounting row is added._

## Summary

Gated generated-parser repair produced a narrower patch but did NOT resolve the instance under Docker.

- source run: `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`
- instance: `astropy__astropy-14369`
- sourcePatchResolved=**false**
- repairedPatchResolved=**false**
- convertedUnresolvedToResolved=**false**
- evaluationRan=**true**, dockerUsed=**true**, evaluationError=**null**

## Source run

| field | value |
| --- | --- |
| sourceRunLabel | `eval-strictv2-artifacts-protocol-vtrace-astropy-14369` |
| instanceId | astropy__astropy-14369 |
| firstPatchHash | f9038460cf149ef95604a6d8f7adb3d51d23f4d1f6bcf0fc9d73692969a22b00 |
| sourcePatchResolved | false |

The source (first) patch was recorded **unresolved** in the original run JSONL row (read-only).

## Repair attempt

| field | value |
| --- | --- |
| repairOutName | stage5_generated_parser_astropy_repair_attempt |
| repairedPatchHash | 89005e0472afa446f6d13b9cc678edd8966350b4e370fd96bcd897891b1c4b9e |
| validPatch | true |
| changedPatch | true |
| failedOpen | false |
| liveCriticRepairRequired | true |
| agreementWithDeterministic | true |

## Repaired patch shape

| field | value |
| --- | --- |
| repairedPatchFilesChanged | astropy/units/format/cds.py |
| changedLineCount | 2 |
| generatedParserTablesDeletedByRepair | false |
| broadGrammarRewriteDetectedInRepair | false |
| narrowGrammarReorderDetected | true |

The repaired patch is a narrow grammar-production reorder confined to a single file; it deletes no generated parser tables and does not broadly rewrite unrelated grammar functions.

## Docker evaluation

| field | value |
| --- | --- |
| evaluationMethod | isolated_derived_jsonl_external_evaluate |
| evaluationRan | true |
| dockerUsed | true |
| repairedPatchResolved | false |
| evaluationError | — |
| derived JSONL | `benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-strictv2-artifacts-protocol-vtrace-astropy-14369/raw/vtrace/repair_eval/_repaired_eval_input.jsonl` |

The repaired patch was evaluated against an isolated derived JSONL whose only change is `modelPatch=repaired diff` (resolved reset), via the existing external `evaluate` step. The original JSONL was never passed to the evaluator.

Command: `node dist/cli.js evaluate /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-strictv2-artifacts-protocol-vtrace-astropy-14369/raw/vtrace/repair_eval/_repaired_eval_input.jsonl --mode docker --timeout 2400 (cwd: /home/calvin/code/vexp-swe-bench)`

## Conversion result

sourcePatchResolved=**false** and repairedPatchResolved=**false**, so convertedUnresolvedToResolved=**false**.

The gated generated-parser repair produced a narrower patch but did not convert the instance under Docker. This remains a patch-quality failure and should not be counted as a conversion.

## Cost accounting

Recovery-side cost (live critic + repair), kept SEPARATE from policy accounting.

| leg | cost |
| --- | --- |
| live critic | $0.1858 |
| repair | $0.2560 |
| **total recovery** | **$0.4418** |

## Policy accounting boundary

No Stage 5 policy accounting row was added or modified.
This report records single-instance repair conversion evidence only.
policyAccountingUpdated=**false**.

## Non-claims

- Single-instance evidence only; this does NOT prove aggregate improvement and is NOT a policy-accounting update.
- No Stage 5 policy accounting row was added or modified by this report.
- Docker is opt-in; without --run-evaluation no evaluator runs, resolved stays null, and NO resolution is claimed.
- Evaluation runs ONLY against a derived JSONL whose sole change is modelPatch=repaired diff (resolved reset); the original JSONL, first patch, repaired patch, raw artifacts, and workspace are never modified.
- The first patch is NOT re-evaluated here; its resolution is read from the existing original run JSONL row.
- convertedUnresolvedToResolved is true ONLY when the first patch was observed unresolved AND the repaired patch observed resolved under Docker.
- Recovery cost (critic + repair) is recorded separately and is NOT merged into policy accounting.
- This runs no agent, no live critic, and no repair, and changes no retrieval / Capsule v2 / PIVOT_CHECK / EDIT_GUARD / PATCH_VERIFY / probe / critic / repair / evaluator / telemetry / policy-accounting behavior.

