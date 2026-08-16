# Stage 5 M155-A — benchmark CLI inventory

Recovered by reading the runners, not from conversation history. Every flag below
was read out of the parser or usage block of the named script at candidate commit
`051a7c559efcc90848390922b8a42293fb66dba5`.

## 1. Authoritative live/agent runner

`benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts` (10,949 lines).
A thin wrapper around the EXTERNAL `vexp-swe-bench` harness, which owns the agent
turn loop and final-patch extraction.

### Modes (`--mode`)

| Mode | Purpose |
| --- | --- |
| `prepare` | materialize workspaces for the named instances |
| `run-baseline` | agent run, NO vtrace context |
| `run-vtrace` | agent run, vtrace context injected |
| `run-vexp` | VEXP arm (requires `--allow-vexp`) |
| `run-protocol` | drive one or more conditions via `--protocol` |
| `evaluate` | SWE-bench grading (`--eval-mode docker` is the only real signal) |
| `evaluate-revised-patch` | shadow evaluation of an M14/M15 revised patch |
| `plan-agent-test-command` / `verify-agent-test-command` | non-oracle agent-test seam |
| `ingest` / `report` / `aggregate-runs` | artifact ingestion and reporting |
| `install-vtrace-patch` / `verify-vtrace-patch` | adapter patch management |

### Conditions and protocols

```text
Stage5Condition = "baseline" | "vtrace" | "vexp"
Stage5Protocol  = "baseline" | "vtrace-indexed" | "vexp" | "all"
```

`--protocol all` runs baseline + vtrace-indexed, and vexp ONLY with `--allow-vexp`.
This is the paired arm M155-D requires; it already exists and needs no new wrapper.

### Task selection

`--instances id1,id2,id3`, `--instances-file <path>`, `--run-label <label>`
(isolates runs under `results/runs/<label>/`), `--run-labels a,b,c` (with
`--mode aggregate-runs`).

### Budgets, timeouts, environment

`--timeout`, `--budget`, `--eval-timeout <seconds>`, `--eval-dataset`,
`--eval-mode docker|lightweight`, `--reuse-workspace`,
`--index-policy auto|always|reuse`.

Model selection is NOT a flag of this runner. The model is owned by the external
harness / `claude` CLI credentials (see §3 of the protocol audit).

### Mandatory safety guards (fail-closed since M89/M90A)

`--stage5-env-guard`, `--stage5-env-drift-check`, `--expected-testbed-prefix <path>`,
`--stage5-agent-shell-guard`, `--stage5-host-pip-firewall`.
Escape hatches `--allow-unguarded-live-env`, `--disable-agent-shell-guard`,
`--disable-host-pip-firewall` exist for test/emergency only and are never
benchmark-valid.

### Context / capsule configuration

`--context-policy auto|force-inject|force-no-context`, `--capsule-engine legacy|v2`,
`--capsule-intent`, `--capsule-budget`, `--vtrace-method`, `--vtrace-context-max-chars`,
`--vtrace-context-max-items`, `--vtrace-index-args`, `--vtrace-query-args`,
`--capture-product-v2-accounting`.

### Default-off experimental arms

`--inject-capsule-digest`, `--digest-decision-contract`, `--bounded-digest-decisions`,
`--compact-digest-injection`, `--pivot-confidence-gate`, `--pivot-check-policy`,
`--pivot-check-gate`, `--pivot-inspection-enforcement`, `--pivot-revision-pass`,
`--ruleout-sufficiency-check`, `--ruleout-sufficiency-corrective-pass`,
`--revision-verification-policy`, `--tool-loop-guard*`, `--cost-guard*`.

## 2. Deterministic retrieval runners (no agent, no Docker, no API)

| Script | Flags |
| --- | --- |
| `run_stage5_retrieval_eval.ts` | `--retrieval-fixture` `--report-name` `--out` `--fixture` `--mode` `--artifact-state` |
| `build_stage5_retrieval_fixture.ts` | `--instances` `--base-fixture` `--budget` `--cross-repo` `--cross-repo-30` `--label-source` `--out` `--results-root` `--swe-bench-data` |
| `prepare_stage5_workspaces.ts` | `--instances` `--bench-repo` `--bench-repos-root` `--cross-repo` `--cross-repo-30` `--depth` `--out-root` `--swe-bench-data` `--quiet` |
| `run_stage5_m134_prepare_targets.ts` | `--vtrace-root` `--fixture` `--out-root` `--out-fixture` `--report` |
| `run_stage5_m134_historical_replay.ts` | `--vtrace-root` `--fixture` `--milestone` `--out` |
| `run_stage5_m134_paired_comparison.ts` | `--predecessor-root` `--candidate-root` `--predecessor-fixture` `--candidate-fixture` `--fixture-identity` `--report-name` `--out` |
| `run_stage5_m140_paired_benchmark.ts` | `--predecessor-root` `--candidate-root` `--predecessor-label` `--candidate-label` `--suites` `--report-prefix` `--out-dir` |
| `run_stage5_m148_paired_benchmark.ts` | `--predecessor-root` `--candidate-root` `--report-prefix` `--out-dir` `--porcelain` |
| `run_stage5_m103_deterministic_scoreboard.ts` | `--swe-bench-data` |
| `run_stage5_m122_product_retrieval_eval.ts` | `--metamorphic-only` `--product-timings-only` `--rescore-only` `--tckdb` `--tckdb-only` |

### The authoritative deterministic comparison path

`run_stage5_m140_paired_benchmark.ts` is the correct M155-B/C driver. Per suite it
emits exactly the metrics §20/§68 require — `top1GoldFile`, `top3GoldFile`,
`goldFileAnywhere`, `goldSymbolAnywhere`, `missingGold`, `meanPivotCount`,
`meanSupportCount`, `meanEstimatedTokens` — for BOTH sides, plus
`provenanceValid`, `sameFixtureHash`, `isolatedIndexes` and a changed-case list.

Its contract: *"only the declared implementation root and its own independently
prepared index differ per side"*. Index isolation is asserted, not assumed.

## 3. Index preparation

`run_stage5_m134_prepare_targets.ts` copies each fixture workspace (excluding
`.git` and `.vtrace`) into an isolated root and indexes it with the DECLARED
implementation's `bin/vtrace`, retrying up to 8 times while quarantining files the
historical parser cannot read. This retry loop is mandatory, not defensive: a bare
`bin/vtrace index` aborts the whole run on a single unparseable file (measured —
see protocol audit §4).

## 4. Provenance

`benchmarkProvenance.ts` (`stage5.benchmark-provenance.v1`) binds: vtrace
commit/tree/sourceFingerprint/dirty, runner fingerprint + `protocolVersion`,
fixture name/hash/caseCount/taskOrderHash/goldLabelHash, target-corpus
hash/manifestHash/per-repository commit+`indexedSourceFingerprint`, schema
versions, `semanticHashVersion`, `resultSemanticHash`, `metricSummaryHash`.

`comparePairedArtifacts` fails closed on provenance mismatch.
