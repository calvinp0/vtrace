# M194 — frozen baseline observational acquisition

**Verdict: M194 — PASS. Corpus: `I6_OBSERVATIONAL_CORPUS_ADEQUATE`. Live model spend: $24.7218 of a $90.0000 ceiling.**

M194 executed the experiment M193C froze, and did not design one. The manifest
recomputed to its published hash before the first paid call, the task fixture
recomputed to its published hash, the model and CLI matched their pins exactly,
and no preregistered threshold moved after any result was seen. What M194 added
was the execution seam the frozen design described but had never been built: a
PreToolUse router into the instance container, a snapshot recorder at the frozen
boundaries, and the per-validation provenance probes. That seam was proven on a
real container, across 28 checks, before any model was launched.

## 1. Frozen authority

| field | value |
|---|---|
| starting SHA | `f76fd1b7e10e6a641a721fc540083142ac30fd67` |
| branch | `main` |
| manifest hash expected | `f735786bf7d3437a095abdcc7e8704cb6769fd32eb46b37ad8fc373850282204` |
| manifest hash observed | `f735786bf7d3437a095abdcc7e8704cb6769fd32eb46b37ad8fc373850282204` |
| manifest matched | **true** |
| task fixture sha256 | `e79843d3b93d4c77551911a92eed9b316c57b5045ff7e7ef75018efb2e9aaca4` |
| fixture matched | **true** |
| model | `claude-opus-4-5-20251101` |
| CLI | `/home/calvin/.local/share/claude/versions/2.1.251` reporting `2.1.251` |
| turn limit | 250 |
| per-run cap | $3.5000 |
| total cap | $90.0000 |
| arm bounds | 20..40 |
| concurrency | 3 |
| frozen sources drifted | 0 of 24 |
| gates | 53/53 |

The user-facing `claude` symlink on this host had moved on to
`2.1.252`. The manifest pins a *versioned binary*, so the
acquisition launched `/home/calvin/.local/share/claude/versions/2.1.251` directly and asserted its
self-reported version before every arm. Using the symlink would have silently
run a different CLI than the one that was frozen.

## 2. Acquisition execution

| quantity | value |
|---|---|
| fixture size | 40 |
| preflight attempts | 35 |
| preflight failures | 1 |
| replacements (NEXT_IN_FROZEN_ORDER) | 1 |
| pre-launch isolation refusals | 1 |
| paid arms launched | 33 |
| paid arms completed | 33 |
| retries | 0 |
| repositories represented | 12 |

Preflight failures, with the checks that failed:

- `psf__requests-1724` — PREFLIGHT_FAILED: ['P9_import_resolves_under_checkout', 'P11_edited_checkout_is_what_executes', 'P15_bytecode_hazard_measured']

## 3. Spend

| quantity | value |
|---|---|
| total live spend | **$24.7218** |
| median per-arm | $0.4452 |
| p90 per-arm | $1.9581 |
| max per-arm | $2.7134 |
| per-run cap violations | 0 |
| total-cap violation | false |

## 4. Run validity

| quantity | value |
|---|---|
| valid runs | **33** |
| invalid runs | 0 |

No run was invalid.

Agent terminations:

- `COMPLETED` — 33

## 5. Natural validation behaviour

Descriptive counts only. No mechanism interpretation is offered or licensed (§6).

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

## 6. Provenance and source-version accounting

| verdict | events |
|---|---|
| usable (EDITED_CHECKOUT_CONFIRMED + CURRENT_EDITED_STATE_CONFIRMED) | 57 |
| wrong source (INSTALLED_COPY_CONFIRMED) | 2 |
| ambiguous source | 0 |
| SOURCE_VERSION_AMBIGUOUS | 5 |
| STALE_EXECUTION_CONFIRMED | 4 |
| UNKNOWN / instrument failure | 0 |

## 7. I6 usability

| quantity | value |
|---|---|
| I6-usable arms | **13** |
| repositories among them | **8** |

Repositories: `django/django`, `matplotlib/matplotlib`, `mwaskom/seaborn`, `pydata/xarray`, `pylint-dev/pylint`, `pytest-dev/pytest`, `scikit-learn/scikit-learn`, `sphinx-doc/sphinx`.

Reasons an arm was not I6-usable:

- `NO_POST_EDIT_VALIDATION_ATTEMPT` — 13
- `NO_TRUSTWORTHY_VALIDATION_RESULT` — 7

## 8. Runtime-diagnosis capability label

Frozen capability label only. It is recorded so a separately preregistered study
could later use the corpus; it is not analysed here and authorises nothing (§28, §46).

| quantity | value |
|---|---|
| runtime-diagnosis-usable arms | 7 |
| repositories among them | 5 |

## 9. Official resolution

Descriptive only, and deliberately not compared against VTRACE (§10).

| quantity | value |
|---|---|
| resolved | 23 |
| unresolved | 10 |
| unknown | 0 |
| resolution rate among valid runs | 69.7% |

Patch identity (§26): 33 of 33 paid arms produced a final patch
byte-identical, under M193's normalisation, to the patch the official evaluator
applied. 0 differed.

## 10. Stopping rule

Fired: `STOP_TARGET_MET`.

| input | value | threshold |
|---|---|---|
| arms launched | 33 | 40 max, 20 min before adequacy stop |
| spend | $24.7218 | $90.0000 |
| I6-usable arms | 13 | 12 |
| repositories among them | 8 | 6 |

The rule reads exactly those four inputs. It cannot see task resolution, whether
I6 looks promising, or whether a preferred mechanism appeared.

## 11. Corpus adequacy

`I6_OBSERVATIONAL_CORPUS_ADEQUATE`

ADEQUATE requires all three:

- I6-usable arms: need 12, have 13 — PASS
- repositories among them: need 6, have 8 — PASS
- valid runs: need 30, have 33 — PASS

PARTIAL requires all three:

- I6-usable arms: need 6, have 13 — PASS
- repositories among them: need 4, have 8 — PASS
- valid runs: need 15, have 33 — PASS

## 12. Hard falsification checks (§51)

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

All 18 checks pass.

## 13. Instrument defects found and corrected

M194 §32 requires an instrument defect to be reported rather than patched
silently. Three were found. None could affect an acquired run, and all three
were found before or without any arm being mis-recorded.

1. **Empty trace timestamps (accounting-side).** The first live arm classified
   `TRACE_ORDERING_CORRUPT` because the accounting stamped structural events
   with an empty string, and the frozen well-formedness rule requires a real
   timestamp. The rule was right; the accounting was wrong. Every trace event
   now carries an observed instant — the adapter stamps its own events, the CLI
   stamps its assistant turns, and the two structural events take the nearest
   real observation on the correct side of them. The correction is a pure
   function of preserved raw artefacts: the arm was reclassified without
   re-spending, and no preregistered threshold, task, prompt, model, cap or
   stopping-rule input changed.

2. **An abandoned CLI config lock tripping the isolation gate.** Run three CLIs
   concurrently, each against its own private configuration directory, and one
   leaves `.claude.json.lock` behind permanently — an empty mkdir mutex, no pid,
   no content. The frozen audit correctly reported it as a file outside the
   baseline allow-list. The audit was not relaxed; the instrument now cleans up
   its own litter before asking whether the directory is clean, and only when
   the lock is provably an empty directory. This gate fails *closed*: it refused
   to launch when isolation was in fact intact, so it cost coverage
   (1 arm) and could never have admitted a contaminated run.

3. **A removal call that could not remove.** The first version of that cleanup
   used `rmSync` without `recursive`, which throws on a directory, so the fix
   silently did nothing. It now uses `rmdirSync`, which refuses anything that is
   not an empty directory — the condition is enforced by the call rather than
   only by the check in front of it. Caught by forcing the race rather than by
   waiting for it.

## 14. Integrity verification

| question | answer |
|---|---|
| manifest changed after start? | no |
| manual task changes | 0 (1 replacement, all NEXT_IN_FROZEN_ORDER) |
| manual retries | 0 |
| treatment contamination among valid runs | 0 |
| VTRACE treatment calls | 0 |
| tools used outside the frozen set | 0 |
| permission denials | 0 |
| source observer mutations | 0 |
| patch observer mutations | 0 |
| budget violations | 0 |
| threshold changes | 0 |

## 15. Reproduction

```bash
# frozen authority (must pass before any spend)
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_verify.ts

# the execution seam, on a real container, no model
<vexp>/.venv/bin/python benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_adapter_control.py \
    --instance pallets__flask-5014 --out results/stage5_m194_adapter_control.json

# the corpus accounting, regenerated from raw artefacts alone
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_account.ts \
    --out benchmarks/stage5_vexp_swe_bench_smoke/results/m194

# the committed reports
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_report.ts \
    --out benchmarks/stage5_vexp_swe_bench_smoke/results/m194
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m194_final_report.ts \
    --out benchmarks/stage5_vexp_swe_bench_smoke/results/m194
```

## 16. Authorizations

OFFLINE_I6_MECHANISM_AUDIT_LICENSED
NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED

A future milestone may perform a frozen, gold-blind and outcome-blind offline mechanism audit over this corpus. It must separately freeze the I6 mechanism definitions, the decision-point evidence, the blindness criteria, the success-witness criteria, the failure classification, the false-positive accounting, the cross-repository threshold and the product-authorization threshold BEFORE inspecting the corpus. M194 does not start that audit.
