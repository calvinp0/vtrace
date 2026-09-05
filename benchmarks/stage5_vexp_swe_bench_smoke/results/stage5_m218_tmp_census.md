# M218 — temporary-space census (measured; nothing deleted)

Verdict: **M218_TMP_LIFECYCLE_CENSUS_COMPLETE** — every producer on the paid path is attributed to source and classified; the one UNKNOWN class (historical /tmp scratch with no ownership manifest) is understood by producer but cannot be proven owned to the §12 standard, so it is recorded and left in place

## Producers on the paid path

| component | current temp location | owner authority | lifetime | M218 disposition |
| --- | --- | --- | --- | --- |
| container setup (image tree extraction) | <workRoot>/<instance>--<arm>/testbed (docker cp of /testbed); staging container m193-<instance>-stage removed immediately | M193Container.setup (m193_container_adapter.py:164) | RUN_OWNED | inside the claimed attempt path; removed by the scratch authority after the container is gone; verified by measurement |
| run container | docker container m193-<instance> bind-mounting the testbed at /testbed; its own /tmp holds the M193A source-version probe | M193Container.setup / teardown | RUN_OWNED | removed at teardown (M216 stop); any container of any name still bound into the work root is now enumerated as residue |
| repo copy / worktree | none beyond the docker cp above (no git worktree, no clone) | M193 | RUN_OWNED | as container setup |
| VTRACE index scratch (treatment) | <hostMount>/.vtrace (index.sqlite, session.sqlite, daemon.sock) inside the testbed | vtrace index <hostMount> (M216ContainerAdapter.initialiseTreatment) | RUN_OWNED | inside the claimed attempt path; excluded from patch capture by derivation; removed with the tree |
| coding agent (Claude Code CLI) private configuration | <armRoot>/claude-config-<arm>-<nonce> (M193A CLAUDE_CONFIG_DIR redirect) | constructArmEnvironment (m193aArmEnvironment.ts) | RUN_OWNED | inside the claimed attempt path |
| coding agent /tmp | BEFORE M218: bwrap --tmpfs /tmp (RAM-backed, unbounded, invisible to the executor). AFTER M218: <attempt>/tmp bound at /tmp inside the namespace | sandbox_prefix (run_stage5_m194_acquire.py) via m216_substrate_bridge.py agent.run agentTmp | RUN_OWNED | AGENT_TMP_ISOLATED_PER_ATTEMPT: fresh before, private to the attempt, deleted after, measurable; identical for both arms |
| MCP server (vtrace mcp-serve, treatment arm) | child of the CLI inside the same namespace: writes /testbed/.vtrace and its /tmp is the agent's /tmp | same as the coding agent | RUN_OWNED | covered by the attempt path and the private /tmp |
| agent stream / telemetry | <armRoot>/raw/<attemptId>.agent_stream.jsonl (+ .abort sentinel) | M216AgentAdapter.run | RUN_OWNED | BEFORE M218 the only raw transcript copy was deleted at teardown; now copied to <cohortDir>/evidence/<claimId>/raw and digest-verified before cleanup |
| result and operations ledgers | <cohortDir>/cohort_ledger.json, cohort_operations.json | run_stage5_m215_launch.ts persistLedger/persistOperations | COHORT_OWNED | persistent evidence, outside the namespace, never scratch |
| patch snapshot | in memory via the bridge; text lands in <workRoot>/evaluation/<runId>_preds.jsonl and the swebench log directory | M216EvaluatorAdapter / m216_substrate_bridge.py evaluator.evaluate | COHORT_OWNED | the evaluation/ directory is the one named COHORT_OWNED entry under the namespace; the patch is also persisted to evidence |
| evaluator (swebench run_evaluation) | /home/calvin/code/vexp-swe-bench/logs/run_evaluation/<run_id>/<run_id>/<instance>/ (~2.5 MB each) plus sweb.eval.<instance>.<run_id> containers it removes itself | swebench.harness.run_evaluation, cwd = vexp checkout | EXTERNAL_SHARED_CACHE | never deleted by M218 (external checkout); bounded growth ~2.5 MB x 200 = ~0.5 GB, recorded; stale sweb.eval.* containers are M217 residue |
| Docker image / layer store | /var/lib/docker (root filesystem); 141.6 GB, 95.6 GB reclaimable per docker system df | Docker engine; swebench --cache_level instance keeps instance images | EXTERNAL_SHARED_CACHE | never pruned by M218 (§33); its growth is reported separately; 64 of 100 frozen images are absent and M193 does not pull, so pre-pulling is an operator step |
| download / package caches | ~/.local/share/claude/versions (agent binary), bun cache, pip inside images | external tools | EXTERNAL_SHARED_CACHE | untouched |
| misc harness (research controls) | results/_m216_work, results/_m217_work, results/_m216_research/fixtures, mkdtemp m216-git-* under /tmp | M216/M217 runners | COHORT_OWNED | research-only; the M217 work root now carries a namespace marker so its recovery path proves ownership; m216-git-* is ~50 KB per run and is the one remaining research mkdtemp under /tmp |
| historical benchmark scratch under /tmp | /tmp/m<NNN>-*, /tmp/stage5-*, /tmp/stage4-*, /tmp/vtrace-*, /tmp/m210-*/m211-* corpus copies, ... | NONE (no ownership manifest); name prefixes are attributable to unit-test fixtures and earlier milestone runners by source grep | UNKNOWN | UNDERSTOOD but NOT cleaned: ownership cannot be proven to the §12 standard; recorded with bytes, inodes and age as the auditable input to an operator decision |

## Host /tmp right now

```text
filesystem      /tmp: 18.7 GiB free of 31.3 GiB; 3006690 of 4194304 inodes free
top-level entries 68827 (measured 68827)
```

| prefix | producer (source) | entries | bytes | inodes | oldest (d) | newest (d) |
| --- | --- | --- | --- | --- | --- | --- |
| (unclassified) | unattributed; not benchmark-owned by any known source | 5794 | 5023039488 | 403010 | 1324.2 | 0 |
| m210-*/m211-*/m212-*/m213-* | run_stage5_m210_*.ts, run_stage5_m211_*.ts, run_stage5_m212_*.ts, run_stage5_m213_*.ts default --scratch/--work paths (corpus copies; the M212 quota-exhaustion source) | 5 | 4154064896 | 28878 | 1.2 | 0.9 |
| system / browser | EXTERNAL system and browser temp (never benchmark-owned) | 1267 | 1610403840 | 27045 | 34.3 | 0 |
| claude-1000 | Claude Code CLI session scratchpads (EXTERNAL; not benchmark-owned) | 1 | 596299776 | 23072 | 1.2 | 1.2 |
| m0xx-* | not a Stage 5 producer (other project prefixes, e.g. m010/m020 model-training scratch) | 328 | 493584384 | 4629 | 32.9 | 1.9 |
| m1xx-* (M100–M159) | run_stage5_m1xx_*.test.ts / *.ts mkdtemp fixtures (e.g. m155-cap-, m150-*, m142-*, m153-*) | 17343 | 397987840 | 210322 | 26.9 | 0 |
| vtrace-capsulev2-* | src/capsuleV2/__fixtures__/capsuleV2Fixture.ts mkdtemp (bun test fixtures, never removed) | 8055 | 198299648 | 86439 | 3 | 0 |
| vtrace-* (other) | src/workspace/workspaceFixture.ts and benchmark runners (mkdtemp prefixes) | 4279 | 189771776 | 71632 | 3 | 0 |
| m*-* (other) | benchmark runners; see grep in the M218 report | 2929 | 188203008 | 26681 | 31.6 | 0 |
| pivot-*/pilot-*/loc-signals*/capsule-v*/gp-critic*/astropy-diag* | src/**/__tests__ and benchmark unit-test fixtures (mkdtemp) | 10304 | 182358016 | 107198 | 31 | 0 |
| stage5-* | benchmark unit-test fixtures (stage5-aggregate-, ...) | 10962 | 179773440 | 78372 | 2.9 | 0 |
| m19x-* | run_stage5_m193a_isolation_evidence.ts, run_stage5_m195a_separation.ts mkdtemp | 756 | 111132672 | 40389 | 2.9 | 0 |
| stage4-* | benchmarks/arc_stage4_* runner fixtures | 4774 | 92807168 | 49566 | 21.8 | 0 |
| arc-stage* | benchmarks/arc_stage3_* fixtures | 1302 | 72884224 | 24304 | 21.8 | 0 |
| vtrace-admindocs-* | src/capsuleV2/__fixtures__/admindocsFixture.ts mkdtemp (bun test fixtures) | 728 | 8945664 | 5824 | 3 | 0 |

Historical scratch cleaned by M218: **0 bytes, 0 entries** — M218 cleans historical scratch only when ownership can be PROVEN (§24); a name prefix plus a source line is attribution, not proof (§12). Nothing under the shared /tmp was deleted by this census.

## Policy inputs (PRE-LAUNCH OBSERVED INFRASTRUCTURE HIGH-WATER)

```json
{
  "largestFrozenRepositoryCheckoutBytes": {
    "policy": 285146397,
    "measured": 285146397,
    "repo": "django__django"
  },
  "largestFrozenRepositoryCheckoutInodes": {
    "policy": 14239,
    "measured": 14239
  },
  "treatmentIndexBytesObserved": {
    "policy": 40646988,
    "measured": 40646988
  },
  "agentStreamBytesP90": {
    "policy": 563927,
    "measured": 563927
  },
  "agentStreamBytesMax": {
    "policy": 2603053,
    "measured": 2603053
  },
  "largestFrozenImageBytes": {
    "policy": 10800000000,
    "measured": {
      "name": "swebench/sweb.eval.x86_64.matplotlib_1776_matplotlib-25332:latest",
      "size": "10.8GB"
    }
  },
  "evaluatorLogBytesPerEvaluation": {
    "policy": 67302,
    "measured": 67302
  }
}
```

policyInputsAgree: true

## Image store (EXTERNAL_SHARED_CACHE; reported, never pruned)

```text
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          75        7         141.6GB   95.59GB (67%)
Containers      14        7         9.212MB   36.86kB (0%)
Local Volumes   28        12        1.533GB   1.029GB (67%)
Build Cache     196       0         33.1GB    1.835GB
frozen manifest images present 36/100; missing 64
```

