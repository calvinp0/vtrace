# M51 rule-out corrective second pass

Date: 2026-06-20

## 1. Executive verdict

- Default-off corrective second pass implemented: **yes**.
- Canonical patch safety preserved: **yes**.
- Revised candidate produced in validation: **yes, through the deterministic
  stubbed model-call test**. No live model call was run in M51.

The new path is candidate-only. It executes one additional external-harness
model call only after the M49 checker fires with a readable, safe prompt and a
valid first-pass patch. It writes separate response, patch, and result artifacts
without modifying the canonical SWE-bench JSONL or its `modelPatch`.

## 2. Implementation details

Changed files:

- `src/capsuleV2/ruleoutCorrectivePass.ts`
  - pure scheduling decision and leakage gate;
  - safe second-pass prompt construction;
  - candidate metadata, patch hashing, changed-file detection, and paired-target
    edit detection;
  - additive artifact names.
- `src/capsuleV2/ruleoutCorrectivePass.test.ts`
  - focused scheduling, leakage, prompt, metadata, and adoption-boundary tests.
- `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts`
  - CLI flag and default;
  - post-M49 integration;
  - second model call through the existing external-harness phase seam;
  - canonical JSONL before/after hashing and additive artifact persistence.
- `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.test.ts`
  - flag behavior, checker-only no-call, artifact isolation, canonical
    preservation, and fail-closed tests.
- `benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_live_capsule_precheck.ts`
  - explicit default-off value in its `CliConfig` constructor.

The implementation does not use the pivot-revision compliance/adoption path and
does not load SWE-bench evaluator metadata. The second-pass instruction file
contains only the M49 safe corrective prompt, the complete first-pass diff, and
repository-evidence/minimal-revision guidance.

## 3. Flag behavior

- `--ruleout-sufficiency-check`
  - unchanged M49 behavior;
  - runs the static checker and may write the corrective prompt;
  - does not execute a second model call.
- `--ruleout-sufficiency-corrective-pass`
  - default off;
  - automatically enables `--ruleout-sufficiency-check`;
  - executes at most one candidate-only corrective model call after all safety
    gates pass.

Automatic checker enablement was chosen over a parser error because the
corrective pass cannot operate without the checker and the implication is
deterministic. The corrective result artifact records whether the checker
triggered, whether the prompt was safe, and whether the model call executed.

## 4. Safety boundary

The implementation enforces:

- `canonicalReplaced=false`
- `adoptionEligible=false`
- canonical `modelPatch` unchanged
- canonical results-file SHA-256 recorded before and after
- first-pass and revised patch SHA-256 recorded separately
- revised patch persisted only as a candidate artifact
- no Docker, verifier, canonical evaluation, shadow evaluation, or adoption path
- no pivot-revision or pivot-inspection-enforcement implication

If the canonical results-file hash changes during the corrective operation, the
runner writes the result and throws a safety error.

If leakage is detected in the model response or candidate diff, the original
response is withheld, the candidate patch is not persisted, and
`revisedPatchProduced=false`.

## 5. Artifact examples

Additive per-run artifacts:

- `_ruleout_sufficiency_corrective_response.txt`
- `_ruleout_sufficiency_revised.patch`
- `_ruleout_sufficiency_corrective_result.json`

Key result metadata:

```json
{
  "correctiveModelCallExecuted": true,
  "revisedPatchProduced": true,
  "revisedPatchChangedFiles": ["sphinx/pycode/ast.py"],
  "revisedPatchEditsRuledOutImplementation": true,
  "canonicalReplaced": false,
  "adoptionEligible": false,
  "oracleFree": true,
  "forbiddenLeakageDetected": false,
  "canonicalPatchUnchanged": true
}
```

The example is the schema/shape exercised by the stubbed executor test, not a
claim about a live Sphinx candidate.

## 6. Offline validation

The three valid M50 labels were replayed read-only:

- `eval-m50-ruleout-sphinx-7462-r1-retry1`
- `eval-m50-ruleout-sphinx-7462-r2`
- `eval-m50-ruleout-sphinx-7462-r3`

For all 3/3:

- checker JSON readable;
- corrective prompt readable;
- existing corrective prompt passed leakage checks;
- new full second-pass prompt passed leakage checks;
- corrective flag enabled would schedule the second pass;
- corrective flag disabled would not schedule the second pass.

Unit/integration validation also proved:

- checker-only mode makes zero corrective model calls;
- missing checker/prompt/patch fails closed;
- unsafe checker/prompt content makes zero corrective model calls;
- a stubbed candidate writes changed-file metadata and separate artifacts;
- canonical JSONL content and hash remain unchanged;
- adoption fields remain false.

Verification results:

- `bun run typecheck`: pass
- `bun run typecheck:benchmarks`: pass
- `bun test`: 3,021 pass, 0 fail across 180 files
- `git diff --check`: pass
- expanded retrieval CSV: byte-identical to the working baseline
  (20/20 evaluated; top-1 80.0%, top-3 95.0%, pivot 85.0%, missing 0.0%)
- cross-repo retrieval CSV: byte-identical to the working baseline
  (30/30 evaluated; top-1 53.3%, top-3 76.7%, pivot 73.3%, missing 13.3%)

## 7. Tiny live validation

No live validation run in M51; next milestone should run one.

## 8. Leakage audit

The checker artifact, M49 prompt, generated second-pass prompt, model response,
and revised diff are all checked before candidate acceptance/persistence.

The prohibited evaluator-label and grading cues are absent from all three M50
replay prompts and their generated M51 second-pass prompts. The second-pass
prompt asks for repository-visible evidence without injecting evaluator
metadata, grading outcomes, or benchmark expectations.

## 9. Next recommendation

**A. M52 run tiny live validation, 1 sphinx replicate, no Docker, no
auto-adoption.**
