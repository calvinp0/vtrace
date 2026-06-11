# Stage 5 generated-parser repair conversion: shape-gated attempt

_Generated: 2026-06-11T21:15:01.758Z_

_Benchmark-only, single-instance. Reuses the isolated repaired-patch evaluator for Docker; adds generated-parser patch-shape analysis, recovery-cost accounting, and a conversion verdict. Read-only: no raw artifact is modified and NO policy accounting row is added._

## Summary

Gated generated-parser repair CONVERTED the Astropy protocol run from unresolved to resolved (Docker resolved=true).

- source run: `eval-strictv2-artifacts-protocol-vtrace-astropy-14369`
- instance: `astropy__astropy-14369`
- sourcePatchResolved=**false**
- repairedPatchResolved=**true**
- convertedUnresolvedToResolved=**true**
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
| repairOutName | stage5_generated_parser_astropy_repair_attempt_shape_gate |
| repairedPatchHash | 467265ddf3855f72928bd3577804a9fd54a91ffcdb17dbf316a09428beb12e14 |
| validPatch | true |
| changedPatch | true |
| failedOpen | false |
| liveCriticRepairRequired | true |
| agreementWithDeterministic | true |

## Repaired patch shape

| field | value |
| --- | --- |
| repairedPatchFilesChanged | astropy/units/format/cds.py, astropy/units/format/cds_parsetab.py |
| changedLineCount | 62 |
| generatedParserTablesDeletedByRepair | false |
| generatedParserTablesUpdatedByRepair | astropy/units/format/cds_parsetab.py |
| broadGrammarRewriteDetectedInRepair | true |
| narrowGrammarReorderDetected | true |
| generatedParserRepairShapeAccepted | true |

The accepted repaired patch changed both the grammar source (`cds.py`) and the generated parser table (`cds_parsetab.py`), passed the post-repair shape gate (shapeAccepted=true), deletes no generated parser tables, and updates the expected generated table consistently with the grammar reorder.

Note: `broadGrammarRewriteDetectedInRepair` is a changed-line-count heuristic over the WHOLE diff. It reads true here only because regenerating the parser table (`cds_parsetab.py`) necessarily touches many lines — that is the REQUIRED consistent-table update, not a broad grammar rewrite. The authoritative grammar-shape check is the post-repair shape gate, which relocates no productions and was accepted.

## Docker evaluation

| field | value |
| --- | --- |
| evaluationMethod | isolated_derived_jsonl_external_evaluate |
| evaluationRan | true |
| dockerUsed | true |
| repairedPatchResolved | true |
| evaluationError | — |
| derived JSONL | `benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-strictv2-artifacts-protocol-vtrace-astropy-14369/raw/vtrace/repair_eval/_repaired_eval_input.jsonl` |

The repaired patch was evaluated against an isolated derived JSONL whose only change is `modelPatch=repaired diff` (resolved reset), via the existing external `evaluate` step. The original JSONL was never passed to the evaluator.

Command: `node dist/cli.js evaluate /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/runs/eval-strictv2-artifacts-protocol-vtrace-astropy-14369/raw/vtrace/repair_eval/_repaired_eval_input.jsonl --mode docker --timeout 1800 (cwd: /home/calvin/code/vexp-swe-bench)`

## Conversion result

sourcePatchResolved=**false** and repairedPatchResolved=**true**, so convertedUnresolvedToResolved=**true**.

The accepted generated-parser repair converted astropy__astropy-14369 from unresolved to resolved. The successful repaired patch changed both cds.py and cds_parsetab.py, passed the generated-parser shape gate, and did not delete generated parser tables. This is a single-instance verified repair conversion, not an aggregate score and not a policy-accounting update.

## Recovery cost

Recovery-side cost (live critic + repair), kept SEPARATE from policy accounting.

| leg | cost |
| --- | --- |
| live critic | $0.1858 |
| repair | $2.8185 |
| **total recovery** | **$3.0043** |

## Cost-cap caveat

| field | value |
| --- | --- |
| repairCostCapUsd | $0.4000 |
| repairCostUsd | $2.8185 |
| repairCostExceededCap | true |

The configured repair cost cap was $0.4000, but the actual repair call cost was $2.8185. This report records the conversion result but does not audit or fix cost-cap enforcement. The cost-cap discrepancy is logged as a follow-up audit item only.

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

