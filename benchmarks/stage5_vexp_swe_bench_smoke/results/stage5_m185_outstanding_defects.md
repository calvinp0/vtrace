# M185 — outstanding defects and debt

M185 changed no product source. Everything below is recorded, not fixed.

## Blocking a future experiment

### The M183 harness could not run the repositories' own tests

`stage5_m185_validation_audit.json`. Across all sixty arms:

    attempted the repository's test suite     14 / 60
    actually executed it                       5 / 60
    never attempted                           46 / 60
    attempts refused by the environment        9

The refusals are `No module named pytest`, `pip: command not found`,
`ModuleNotFoundError: No module named 'django'`, `No test runner found`. The
agents were not declining to validate; they were being refused.

Consequence: M185 cannot distinguish `VALIDATION_SELECTION` failures from
environment failures, and **no validation-stage intervention can be evaluated on
this harness**. Any future counterfactual experiment that touches validation must
first give the agent a working test environment. This is the single most
actionable defect M185 found, and it is a harness defect, not a product one.

### `exitCode` is null for every captured Bash call

All 335 Bash calls in M183 record `exitCode: null` and `success` that does not
track the command result. A "did it work" metric keyed on the exit code returns
zero for everything and reads as a finding. M185's first pass made exactly that
mistake and it was caught only by looking at the outputs. The execution criterion
in `run_stage5_m185_behavior.ts` is therefore output-based, and this is the same
family as the M164 standing finding about truncated-output classifiers failing
open.

## Recorded, not actionable

### `focusIsGoldFile` overstates localization quality

`mwaskom__seaborn-3187` counts as a correct focus because the focus file
`seaborn/utils.py` is a gold file. The focused **symbol** was `move_legend` —
relocating a legend — while the symbol the task needed, in the same file, was
`locator_to_legend_entries`. The metric credits a lexical coincidence on the word
"legend". M183's own gold-symbol diagnostic (2/30) already says the symbol-level
picture is much weaker than the file-level one; M185 adds a concrete case where
the difference decides the task.

Not a defect in the metric's definition — M183 declared it — but any future report
quoting "19/30 focus was a gold file" should quote the 2/30 beside it.

### Index CLI failure-count semantics (§52, `INDEX_CLI_FAILURE_COUNT_SEMANTICS_STALE_OR_MISLEADING`)

M184's headline reported "indexed with 506 failures" on a 1,257-file scan. M185
did not reproduce that shape. Indexing `django/django` at base commit
`156a2138` — 2,687 files at the same product HEAD — reports:

    totalParseFailures                    0
    coverage.filesFailed                  0
    totalSkippedUnregisteredLanguage     35   (JavaScript, correctly `skipped`)

So on the closest comparable evidence the indexer distinguishes `failed` from
`skipped`/`unregistered_language` correctly, and M185 has no evidence that 506
supported-file parse failures exist. Recorded as reporting debt; **not** fixed,
and not expanded into parser work.

What matters for M185's own validity is narrower and is directly verified: every
candidate-evidence symbol this audit depended on was present in the offline index
— `seaborn/utils.py::locator_to_legend_entries`, `sphinx/pycode/ast.py::unparse`,
`tests/test_requests.py::TestPreparingURLs.test_preparing_url`. Index coverage
did not cause any of the six failures.

### `modelVisibleEstimatedTokens`

Still record-only, still not renamed. M183's live token accounting remains
authoritative for the benchmark. Untouched by M185.

### `VTRACE_TOOLING_AUDIT.md`

Untracked, pre-existing, stale. M185 did not take ownership of it and did not
edit it.

### Incidental: `bun test` from inside the benchmark directory

Running `bun test m185Audit.test.ts` with the working directory set to
`benchmarks/stage5_vexp_swe_bench_smoke/` fails with `EMFILE` — the scan walks the
enormous untracked `results/` tree. The same command from the repository root
passes 18/18. Harness ergonomics, not a defect in anything shipped; noted so the
next agent does not spend time on it.

## Two M183 grader observations worth carrying forward

- **Five of the six correct-focus failures produced the identical grader result in
  both arms** — same FAIL_TO_PASS failures, same PASS_TO_PASS breakage, and in
  `django__django-13195` byte-identical patches. Whatever these tasks are hard for,
  it is not something the treatment changed.

- **`psf__requests-5414` is the only cohort-A case where the arms diverged**, and
  it diverged because the treatment's patch broke eight existing
  `TestPreparingURLs` tests that the baseline's patch left alone. Neither arm ran
  them.
