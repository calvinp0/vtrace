# M194 — frozen baseline observational acquisition: corpus accounting

Generated from the preserved per-arm artefacts by
`run_stage5_m194_account.ts`. No model call, no manual transcription (§49).

## Frozen authority

| field | value |
|---|---|
| manifest sha256 | `f735786bf7d3437a095abdcc7e8704cb6769fd32eb46b37ad8fc373850282204` |
| manifest matched | true |
| task fixture sha256 | `e79843d3b93d4c77551911a92eed9b316c57b5045ff7e7ef75018efb2e9aaca4` |
| fixture matched | true |
| model | `claude-opus-4-5-20251101` |
| CLI | `/home/calvin/.local/share/claude/versions/2.1.251` reporting 2.1.251 |
| turn limit | 250 |
| per-run cap | $3.5000 |
| total cap | $90.0000 |
| concurrency | 3 |

## Acquisition

| quantity | value |
|---|---|
| fixture size | 40 |
| paid arms launched | 33 |
| paid arms completed | 33 |
| preflight failures | 1 |
| replacements | 1 |
| retries | 0 |
| repositories represented | 12 |

## Spend

| quantity | value |
|---|---|
| total live spend | $24.7218 |
| median per-arm | $0.4452 |
| p90 per-arm | $1.9581 |
| max per-arm | $2.7134 |
| per-run cap violations | 0 |
| total cap violation | false |

## Run validity

| quantity | value |
|---|---|
| valid runs | 33 |
| invalid runs | 0 |

No invalid runs.

## Natural validation behaviour

Descriptive only. No mechanism interpretation (§6).

| quantity | value |
|---|---|
| runs with a source edit | 33 |
| post-edit validation attempts | 117 |
| runner starts | 76 |
| trustworthy validation results | 57 |
| validation passes | 37 |
| validation failures | 19 |
| post-validation revisions | 8 |
| arms with multiple validation cycles | 10 |
| arms with an empty final patch | 0 |

## Patch identity (§26)

| quantity | value |
|---|---|
| extracted patch identical to evaluated patch | 33 |
| differing | 0 |

## Provenance and source version

| verdict | events |
|---|---|
| EDITED_CHECKOUT_CONFIRMED + CURRENT_EDITED_STATE_CONFIRMED (usable) | 57 |
| wrong source (INSTALLED_COPY_CONFIRMED) | 2 |
| ambiguous source | 0 |
| SOURCE_VERSION_AMBIGUOUS | 5 |
| STALE_EXECUTION_CONFIRMED | 4 |
| UNKNOWN / instrument failure | 0 |

## I6 usability

| quantity | value |
|---|---|
| I6-usable arms | 13 |
| repositories among them | 8 |

Reasons an arm was not I6-usable:

- `NO_POST_EDIT_VALIDATION_ATTEMPT` — 13
- `NO_TRUSTWORTHY_VALIDATION_RESULT` — 7

## Runtime-diagnosis capability label

Frozen capability label only; not analysed (§28).

| quantity | value |
|---|---|
| runtime-diagnosis-usable arms | 7 |
| repositories among them | 5 |

## Official resolution

Descriptive only. Not compared against VTRACE (§10).

| quantity | value |
|---|---|
| resolved | 23 |
| unresolved | 10 |
| unknown | 0 |
| resolution rate among valid runs | 69.7% |

## Per repository

| repository | arms | valid | I6-usable | resolved |
|---|---|---|---|---|
| astropy/astropy | 4 | 4 | 0 | 2 |
| django/django | 4 | 4 | 1 | 4 |
| matplotlib/matplotlib | 4 | 4 | 4 | 2 |
| mwaskom/seaborn | 1 | 1 | 1 | 1 |
| pallets/flask | 1 | 1 | 0 | 1 |
| psf/requests | 3 | 3 | 0 | 1 |
| pydata/xarray | 3 | 3 | 1 | 3 |
| pylint-dev/pylint | 2 | 2 | 2 | 0 |
| pytest-dev/pytest | 3 | 3 | 2 | 3 |
| scikit-learn/scikit-learn | 2 | 2 | 1 | 2 |
| sphinx-doc/sphinx | 3 | 3 | 1 | 1 |
| sympy/sympy | 3 | 3 | 0 | 3 |

## Stopping rule

Fired: `STOP_TARGET_MET`

State at stopping:

| input | value |
|---|---|
| arms launched | 33 |
| spend | $24.7218 |
| I6-usable arms | 13 |
| repositories among them | 8 |

## Corpus adequacy

`I6_OBSERVATIONAL_CORPUS_ADEQUATE`

ADEQUATE requires all three:

- I6-usable arms: need 12, have 13 PASS
- repositories among I6-usable: need 6, have 8 PASS
- valid runs: need 30, have 33 PASS

PARTIAL requires all three:

- I6-usable arms: need 6, have 13 PASS
- repositories among I6-usable: need 4, have 8 PASS
- valid runs: need 15, have 33 PASS

## Hard falsification checks (§51)

| check | claim | observed | verdict |
|---|---|---|---|
| `manifest_hash_matched` | manifest hash matched before the first paid call | f735786bf7d3437a095abdcc7e8704cb6769fd32eb46b37ad8fc373850282204 | PASS |
| `fixture_hash_matched` | task fixture hash matched | e79843d3b93d4c77551911a92eed9b316c57b5045ff7e7ef75018efb2e9aaca4 | PASS |
| `model_matched` | model exactly matched | claude-opus-4-5-20251101 | PASS |
| `cli_matched` | CLI version exactly matched | 2.1.251 | PASS |
| `turn_limit_unchanged` | turn limit unchanged | 250 | PASS |
| `per_run_cap` | per-run cost cap never exceeded | max $2.7134 of $3.5000 | PASS |
| `total_cap` | total spend <= $90 | $24.7218 | PASS |
| `arm_cap` | max paid arms <= 40 | 33 | PASS |
| `no_contamination` | treatment contamination = 0 among valid runs | 0 | PASS |
| `all_bash_routed` | every Bash call routed into the container | 0 unrouted | PASS |
| `no_adapter_errors` | adapter recorded no internal failures | 0 errors | PASS |
| `manual_replacement` | manual task replacement = 0 | 1 replacements, all NEXT_IN_FROZEN_ORDER | PASS |
| `manual_retry` | manual retry = 0 | 0 | PASS |
| `vtrace_arms` | VTRACE treatment arms = 0 | 0 | PASS |
| `patch_identity` | the extracted patch is the patch the evaluator applied | 33 identical, 0 differing, 0 empty | PASS |
| `tools_within_frozen_set` | the agent used no tool outside the frozen set | none | PASS |
| `no_permission_denials` | no tool call was refused by the permission layer | 0 | PASS |
| `threshold_changes` | post-result threshold changes = 0 | adequate 12/6/30 | PASS |

All falsification checks pass.
