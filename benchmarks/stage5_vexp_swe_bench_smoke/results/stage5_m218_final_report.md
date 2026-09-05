# M218 — pre-launch retry-reserve amendment, authoritative /tmp lifecycle,
# and final spend-authorization readiness

## 1. Executive verdict

```text
M218 — PASS

PRE_OUTCOME_FINANCIAL_AMENDMENT_COMMITTED
RETRY_RESERVE_10_ATTEMPTS
HARD_SPEND_CEILING_$735

TMP_LIFECYCLE_CENSUS_COMPLETE
RUN_OWNED_TMP_NAMESPACE_ENFORCED
AGENT_TMP_ISOLATED_PER_ATTEMPT
RUN_TMP_CLEANUP_VERIFIED
STALE_TMP_RECOVERY_VERIFIED
TMP_CAPACITY_GATE_VERIFIED
TMP_CLEANUP_PART_OF_CONTINUATION_SAFETY
TMP_PATH_SAFETY_VERIFIED

M218_FALSIFICATION_SUITE_PASSED
M218_SUITE_IS_FALSIFYING
M218_SCOPED_TYPECHECK_VERIFIED

TECHNICAL_EXECUTOR_READY

SPEND_AUTHORIZATION_PENDING
PAID_RUNS_NOT_STARTED
LIVE_MODEL_SPEND_$0
```

M217 left the technical executor ready and the launch blocked on one human answer: authorise the
frozen $700 with a $0 retry reserve. M218 does two things before that answer is given. It records a
separately hashed pre-outcome amendment that adds a fixed ten-attempt, $35 infrastructure-retry
reserve — usable only for the retry classes M214 already authorised — so the executable authority
becomes M214 + A1 with a $735 hard ceiling and the same 200 intended valid outcomes. And it makes
temporary-space ownership part of execution correctness: every attempt claims an owned directory
before it exists, the coding agent's /tmp IS that directory (bound by bwrap, not an anonymous
RAM tmpfs), evidence is copied out and digest-verified before cleanup, cleanup never follows a
symlink or leaves the marked namespace, a capacity gate refuses an attempt the host cannot hold, and
residue of any kind blocks the next row through the M217 interlock.

## 2. Starting repository state

```text
branch            main
HEAD at start     9eb8689a71cac1c193ee081e15301c0cd1477a04 (M217)
HEAD when generated  a5c1204c6d9afcf2b010e318d1715840a4976460
ahead/behind      0	246 (left origin/main, right HEAD)
pushed            no

M218 commits so far:
  a5c1204c Prove scratch absence by entries as well as bytes, recover only what the registry owns, and kill the agent's whole process group
  d7df3a02 Bind the executor and launcher to M214 + A1 and make the ten-attempt reserve act
  78cb2653 Own the benchmark's scratch before deleting it, and bind the agent's /tmp to it
  ec34e0ef Amend the frozen spend envelope with a ten-attempt retry reserve before any outcome exists
```

Pre-existing dirt — `stage5_outcome_ledger.{json,md}` and the historical untracked benchmark
results — was preserved; nothing was reset, cleaned or unstaged; nothing under the shared /tmp was
deleted by any M218 script except the research namespaces M218 itself created.

## 3. Frozen experiment identities

```text
preregistration      3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4  VERIFIED
manifest             549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1  VERIFIED
externalReference    822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b  VERIFIED
amendment A1         0ed156bc924a4817122c46b5c9fc0334e5f046c2dce0547eef2573b2483b76c1  VERIFIED (pinned true)
executable authority 782f8a94e5d6bb8e09000b16c37a1037d72cb40537523ab61db0c53fa80ef086  = M214 + A1
```

The experiment is unchanged: 100 tasks x 2 arms = 200 intended valid outcomes, arms BASELINE and
VTRACE, VEXP an EXTERNAL_VENDOR_REFERENCE, no third arm, same task order, agent, model target,
treatment identity, native tools, per-run budget, primary outcome, analysis, stopping target, ITT
semantics and retry eligibility.

## 4. Why the amendment is allowed

```text
outcome-bearing runs before the amendment   0
treatment results before the amendment      0
causal results before the amendment         0
```

No frozen task has ever been run by this executor (M215–M218 accounting: 0 frozen instances
touched, $0 spend, 0 provider calls). The amendment cannot be outcome-informed because there is no
outcome to inform it; the amendment document records this as `outcomeBearingRunsBeforeAmendment: 0`
and its audit refuses a document that does not.

## 5. Original spend policy (M214, unchanged)

```text
200 intended valid runs x $3.50 maximum ordinary exposure = $700
frozen global ceiling                                    = $700
paid retry reserve                                       = $0
retry eligibility  MODEL_SERVICE_FAILURE, CONTAINER_CANNOT_START, EVALUATOR_INFRA_FAILURE, TELEMETRY_CORRUPT; maxAttemptsPerRun 2
```

## 6. Amendment A1 — M214_A1_RETRY_RESERVE

```text
ordinary exposure     $700   (200 x $3.50; unchanged)
retry reserve          $35   (10 attempts x $3.50)
hard ceiling          $735
maximum paid retries  10
manifest rows         200   (not regenerated)
intended outcomes     200   (not 210: retries are attempts on existing rows)
```

Why ten: 10 / 200 = 5% is an OPERATIONAL RESERVE POLICY, not an estimated expected failure rate. The purpose is bounded resilience: a small, fixed number of infrastructure retries can be funded without making fixed-N completion impossible. The choice was made before any outcome-bearing run, before any treatment result and before any causal result, and therefore cannot be treatment-outcome-driven.

Slot accounting: a slot is consumed by every retry attempt STARTED (attempt > 1), whatever it later costs; dollars are consumed by the retry attempt's provider-reported cost, charged at the per-attempt cap when the provider reports none

## 7. Retry semantics preserved

Retry eligibility is M214's, restated in the amendment and compared field by field by
`auditAmendment`: the four rerunnable classes, `maxAttemptsPerRun` 2, both attempts remaining in the
ledger, and preregistered infrastructure-invalid retries remaining permissible. No retry class was
created (control F124: a `PATCH_EXTRACTION_FAILURE` retry is refused with the whole reserve intact).
M217's PERMIT-and-DECLARE binding is unchanged and now declares against the $735 ceiling.

Exhaustion: After the tenth retry attempt, or once the remaining reserve dollars cannot fund another allowed retry at its cap, or once cumulative spend plus one attempt at cap would exceed the hard ceiling, no further paid retry is permitted. The operator is never asked dynamically to raise the budget; a further increase requires another explicit preregistration amendment.

## 8. Amendment identity / hash

```text
file                 stage5_m214_a1_retry_reserve_amendment.json
hash domain          "M214_A1_RETRY_RESERVE\n"
recorded             0ed156bc924a4817122c46b5c9fc0334e5f046c2dce0547eef2573b2483b76c1
recomputed           0ed156bc924a4817122c46b5c9fc0334e5f046c2dce0547eef2573b2483b76c1
pinned in code       0ed156bc924a4817122c46b5c9fc0334e5f046c2dce0547eef2573b2483b76c1  (M218_FROZEN_AMENDMENT_HASH)
executable authority 782f8a94e5d6bb8e09000b16c37a1037d72cb40537523ab61db0c53fa80ef086  (domain "M218_EXECUTABLE_AUTHORITY\n" over M214's three digests + A1)
```

Lineage: M214 → A1 (financial retry reserve only) → launchable experiment authority = M214 + A1.

## 9. Original M214 immutability

```text
stage5_m213_preregistration.json           UNCHANGED  508b19766b12d1e8
stage5_m213_run_manifest.json              UNCHANGED  5c4207e9d196f2fe
stage5_m214_preregistration.json           UNCHANGED  e57ec71f7ca4a668
stage5_m214_run_manifest.json              UNCHANGED  a81ab4a4861c5fc7
stage5_m214_external_reference.json        UNCHANGED  f974b8d25bf66345
stage5_m214_preregistration_hash.json      UNCHANGED  cf6da9e32172bf4c
stage5_m213_preregistration_hash.json      UNCHANGED  e90029967f58f3c3
```

All seven frozen artifacts are byte-identical to the M217 HEAD blobs (F118); the M214 digest
recomputes unchanged and is the amendment's parent (F119); the M214 hash record agrees
(parentRecordAgrees true).

## 10. /tmp incident history motivating the lifecycle work

- **M212** exhausted the tmpfs quota by copying corpora into a fresh /tmp scratch; the census still
  finds those copies: 5 entries under m210-*/m211-*/m212-*/m213-* holding 3.87 GiB.
- **M217** found a 13-hour-old research container bound to a work directory that no longer
  existed (`stage5_m217_field_witness.json`).
- **M218 census**: the coding agent's /tmp was an anonymous bwrap tmpfs — RAM-backed, unbounded,
  invisible to the executor — and the ONLY copy of the raw agent transcript lived inside the arm
  root that teardown deleted.
- **Host /tmp today**: 68827 top-level entries on a 31.30 GiB tmpfs, 12.62 GiB used, 1,187,614 inodes used; the dominant inode consumer is unit-test fixture leakage.

## 11. Temporary-space census

Verdict: **M218_TMP_LIFECYCLE_CENSUS_COMPLETE** — lifetimes {"RUN_OWNED":8,"TASK_OWNED":0,"COHORT_OWNED":3,"EXTERNAL_SHARED_CACHE":3,"UNKNOWN":1}.

| component | current temp location | owner authority | lifetime |
| --- | --- | --- | --- |
| container setup (image tree extraction) | <workRoot>/<instance>--<arm>/testbed (docker cp of /testbed); staging container m193-<instance>-stage removed immediately | M193Container.setup (m193_container_adapter.py:164) | RUN_OWNED |
| run container | docker container m193-<instance> bind-mounting the testbed at /testbed; its own /tmp holds the M193A source-version probe | M193Container.setup / teardown | RUN_OWNED |
| repo copy / worktree | none beyond the docker cp above (no git worktree, no clone) | M193 | RUN_OWNED |
| VTRACE index scratch (treatment) | <hostMount>/.vtrace (index.sqlite, session.sqlite, daemon.sock) inside the testbed | vtrace index <hostMount> (M216ContainerAdapter.initialiseTreatment) | RUN_OWNED |
| coding agent (Claude Code CLI) private configuration | <armRoot>/claude-config-<arm>-<nonce> (M193A CLAUDE_CONFIG_DIR redirect) | constructArmEnvironment (m193aArmEnvironment.ts) | RUN_OWNED |
| coding agent /tmp | BEFORE M218: bwrap --tmpfs /tmp (RAM-backed, unbounded, invisible to the executor). AFTER M218: <attempt>/tmp bound at /tmp inside the namespace | sandbox_prefix (run_stage5_m194_acquire.py) via m216_substrate_bridge.py agent.run agentTmp | RUN_OWNED |
| MCP server (vtrace mcp-serve, treatment arm) | child of the CLI inside the same namespace: writes /testbed/.vtrace and its /tmp is the agent's /tmp | same as the coding agent | RUN_OWNED |
| agent stream / telemetry | <armRoot>/raw/<attemptId>.agent_stream.jsonl (+ .abort sentinel) | M216AgentAdapter.run | RUN_OWNED |
| result and operations ledgers | <cohortDir>/cohort_ledger.json, cohort_operations.json | run_stage5_m215_launch.ts persistLedger/persistOperations | COHORT_OWNED |
| patch snapshot | in memory via the bridge; text lands in <workRoot>/evaluation/<runId>_preds.jsonl and the swebench log directory | M216EvaluatorAdapter / m216_substrate_bridge.py evaluator.evaluate | COHORT_OWNED |
| evaluator (swebench run_evaluation) | /home/calvin/code/vexp-swe-bench/logs/run_evaluation/<run_id>/<run_id>/<instance>/ (~2.5 MB each) plus sweb.eval.<instance>.<run_id> containers it removes itself | swebench.harness.run_evaluation, cwd = vexp checkout | EXTERNAL_SHARED_CACHE |
| Docker image / layer store | /var/lib/docker (root filesystem); 141.6 GB, 95.6 GB reclaimable per docker system df | Docker engine; swebench --cache_level instance keeps instance images | EXTERNAL_SHARED_CACHE |
| download / package caches | ~/.local/share/claude/versions (agent binary), bun cache, pip inside images | external tools | EXTERNAL_SHARED_CACHE |
| misc harness (research controls) | results/_m216_work, results/_m217_work, results/_m216_research/fixtures, mkdtemp m216-git-* under /tmp | M216/M217 runners | COHORT_OWNED |
| historical benchmark scratch under /tmp | /tmp/m<NNN>-*, /tmp/stage5-*, /tmp/stage4-*, /tmp/vtrace-*, /tmp/m210-*/m211-* corpus copies, ... | NONE (no ownership manifest); name prefixes are attributable to unit-test fixtures and earlier milestone runners by source grep | UNKNOWN |

Host /tmp by prefix (attributed to source; NONE proven owned; NONE deleted):

| prefix | producer | entries | bytes | inodes |
| --- | --- | --- | --- | --- |
| (unclassified) | unattributed; not benchmark-owned by any known source | 5794 | 5023039488 | 403010 |
| m210-*/m211-*/m212-*/m213-* | run_stage5_m210_*.ts, run_stage5_m211_*.ts, run_stage5_m212_*.ts, run_stage5_m213_*.ts def | 5 | 4154064896 | 28878 |
| system / browser | EXTERNAL system and browser temp (never benchmark-owned) | 1267 | 1610403840 | 27045 |
| claude-1000 | Claude Code CLI session scratchpads (EXTERNAL; not benchmark-owned) | 1 | 596299776 | 23072 |
| m0xx-* | not a Stage 5 producer (other project prefixes, e.g. m010/m020 model-training scratch) | 328 | 493584384 | 4629 |
| m1xx-* (M100–M159) | run_stage5_m1xx_*.test.ts / *.ts mkdtemp fixtures (e.g. m155-cap-, m150-*, m142-*, m153-*) | 17343 | 397987840 | 210322 |
| vtrace-capsulev2-* | src/capsuleV2/__fixtures__/capsuleV2Fixture.ts mkdtemp (bun test fixtures, never removed) | 8055 | 198299648 | 86439 |
| vtrace-* (other) | src/workspace/workspaceFixture.ts and benchmark runners (mkdtemp prefixes) | 4279 | 189771776 | 71632 |
| m*-* (other) | benchmark runners; see grep in the M218 report | 2929 | 188203008 | 26681 |
| pivot-*/pilot-*/loc-signals*/capsule-v*/gp-critic*/astropy-diag* | src/**/__tests__ and benchmark unit-test fixtures (mkdtemp) | 10304 | 182358016 | 107198 |
| stage5-* | benchmark unit-test fixtures (stage5-aggregate-, ...) | 10962 | 179773440 | 78372 |
| m19x-* | run_stage5_m193a_isolation_evidence.ts, run_stage5_m195a_separation.ts mkdtemp | 756 | 111132672 | 40389 |

Historical scratch cleaned by M218: **0**. M218 cleans historical scratch only when ownership can be PROVEN (§24); a name prefix plus a source line is attribution, not proof (§12). Nothing under the shared /tmp was deleted by this census.

Operator recommendation (not executed): The dominant inode consumer is unit-test fixture leakage (mkdtemp without cleanup) and the dominant byte consumer is M210/M211 corpus copies under /tmp/m210-*, /tmp/m211-*. An operator may remove them by name after reviewing this census; the paid benchmark no longer writes to the shared /tmp.

## 12. Ownership model

```text
namespace   <cohortDir>/_work carrying .m218-scratch-namespace.json (experiment, cohortDir, establisher)
claim       <cohortDir>/_scratch_registry/<claimId>.json written BEFORE the attempt directory is used:
            experiment, runId, manifest row, instance, arm, attempt, attemptId, path, agentTmp, rawDir,
            hostMount, lifetime RUN_OWNED, creator {pid, /proc start ticks, hostname, executor version},
            free bytes at claim, state CLAIMED|RELEASED, release reason, cleanup report
evidence    <cohortDir>/evidence/<claimId>/ (raw stream, captured.patch, evaluation.json, manifest.json)
rule        no claim → no destructive cleanup; registry and evidence live OUTSIDE the namespace
```

## 13. Run scratch namespace

```text
<cohortDir>/_work/<instance>--<arm>/            the attempt path (armRoot), claimed per attempt
<cohortDir>/_work/<instance>--<arm>/testbed/    the docker-cp'd tree, bind-mounted at /testbed
<cohortDir>/_work/<instance>--<arm>/tmp/        the agent's /tmp (bwrap --bind <this> /tmp)
<cohortDir>/_work/<instance>--<arm>/raw/        agent stream + abort sentinel
<cohortDir>/_work/<instance>--<arm>/claude-config-*  M193A private configuration
<cohortDir>/_work/evaluation/                   COHORT_OWNED (evaluator preds files)
```

The cohort namespace is on the root filesystem under the results directory, not on the tmpfs /tmp.
The existing M215–M217 work-root authority was kept; M218 marks it and owns it.

## 14. Agent /tmp behavior

**AGENT_TMP_ISOLATED_PER_ATTEMPT is achieved by the real namespace.** `sandbox_prefix` now takes
`agent_tmp` and emits `--bind <attempt>/tmp /tmp` instead of `--tmpfs /tmp`; the bridge binds
exactly what the executor claimed. On the real substrate (F173) the spawned bwrap argv contained
`--bind /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/_m218_work/_work/pylint-dev__pylint-7080--baseline/tmp /tmp`; the agent saw an ordinary `/tmp` (`readlink -f /tmp` = `/tmp`, a bind mount, not a symlink),
the flood a later row wrote to /tmp was measured by the executor's monitor under the owned path (40550400 bytes), the marker was gone with the attempt, and the unrelated host sentinel survived.
Fresh before the attempt (claimed empty), private to it, deleted after it, measurable by the
executor, and identical for both arms.

## 15. Baseline / VTRACE equivalence

F142 (pure) and F175 (real): after normalising the attempt path, the two arms' bwrap argv are
identical and their TMP-related environment names are identical; the scratch policy has no arm
field. The treatment difference remains the MCP config only.

## 16. Cleanup lifecycle

```text
try:     claim → container start → checkpoints (AFTER_CONTAINER_SETUP, AFTER_TREATMENT_INITIALISATION,
         AFTER_AGENT_COMPLETION, AFTER_EVALUATION) → ... → finalize (result ledger)
finally: BEFORE_CLEANUP checkpoint → persist evidence (digest-verified) → container.stop (container
         + mount) → scratch.cleanup (refuse if container not removed / live process / mount /
         container binding the path; ownership re-checked; symlink-safe walk; verify 0 bytes,
         0 entries) → M217 enumeration (Docker + /proc + owned bytes/entries + any container
         bound into the work root) → ROW_TEARDOWN event carrying the §40 scratch record
```

## 17. Interrupt / failure cleanup

- Exception mid-attempt (F143): evidence persisted, teardown, scratch cleaned, SAFE.
- Live process holding the path (F131 pure, F168 host, F176 real): cleanup refuses, result stands,
  next row BLOCKED; the process is killed by the predeclared remediation (F144, F177).
- Container not removed (F132): cleanup refuses, BLOCKED.
- Emergency abort (F151 pure, F180 real): see §26.
- Executor crash (F134 pure, F170 host): the resumed sweep proves the creator dead by pid + start
  ticks, finds no live reference, records evidence, cleans.

## 18. Startup stale-scratch recovery

```text
ACTIVE            registered claim CLAIMED and creator pid alive with matching start ticks → blocks
STALE_CLEANABLE   creator dead or claim RELEASED, no live process/mount/container → removed, released, recorded
STALE_UNSAFE      owner gone but a live reference remains → blocks
UNKNOWN           no registered claim → never deleted → blocks
```

Age is recorded as a diagnostic only (F133). The sweep is an operational event
(`SCRATCH_STALE_SWEEP`) and a blocking sweep moves continuation to BLOCKED (F150).

## 19. Path and symlink safety

`assertDeletableOwnedPath` is the only function that may authorise a recursive deletion: structural
refusal of /, /tmp, $HOME, an empty or relative path and kernel filesystems; the marker must exist;
the target must not be a symlink; its realpath must be a strict descendant of the realpath of the
namespace root (never a prefix coincidence, never the root itself). The walker lstat's every entry,
unlinks symlinks without following them, and re-resolves every subdirectory before descending
(F146 pure, F167 host; F147, F169).

## 20. Real-host control

```text
namespace on the shared tmpfs /tmp: 7/7 controls
subprocess wrote 50331654 bytes; free before 20493320192 → during 20442984448 → after 20493320192
capacity gate on a tmpfs-hosted namespace: REFUSED (namespace filesystem has 20493303808 bytes free; the policy requires 34484901888 (32337418240 host reserve + 2147483648 )
capacity gate on the cohort filesystem: PASS (336442322944 free vs 34484901888 required)
```

## 21. Real-container control

```text
controls 11/11; containers started 5, torn down 5; frozen touched 0; instances pylint-dev__pylint-6903, pylint-dev__pylint-7080
preflight: sweep pass true, capacity pass true (336487477248 bytes free), isolation SUBSTRATE_CLEAN
holder pid 2206616 listed by the real enumeration with 45056 bytes / 9 entries of owned residue
recovery actions: ownership of /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/_m218_work/_work/pylint-dev__pylint-6903--vtrace proven by scratch claim c1c368ccb8d9910ae8596794 | removed owned scratch /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/_m218_work/_work/pylint-dev__pylint-6903--vtrace (28672 bytes, claim c1c368ccb8d9910ae8596794 released) | killed pid 2206
```

## 22. Pair contamination control

Both orders on the real substrate: baseline → vtrace (F174) and vtrace → baseline (F178) reported
the previous arm's sentinel ABSENT from the new arm's /tmp; pure F141 covers both orders with a
second sentinel mechanism.

## 23. Free-space / inode gate

`P13_SCRATCH_CAPACITY` is on the frozen required-gate list. Below the derived threshold (F137) or
on low inodes (F139) the attempt is refused before any container or claim; at the threshold it is
accepted (F138). The shared /tmp floor is checked too.

## 24. Threshold derivation

```text
projected attempt scratch  = max(4 x (largest checkout 285146397 + index 40646988 + stream max 2603053), 2 GiB) = 2147483648 (floor binds)
projected attempt inodes   = max(4 x 14239, 250 000) = 250000
host safety reserve        = 2 x largest frozen image (10800000000) + 10 GiB = 32337418240 (30.12 GiB)
host reserve inodes        = 1250000 (~1% of the root filesystem's table)
required free              = 34484901888 bytes (32.12 GiB)
shared /tmp floor          = 1073741824 bytes / 100000 inodes (host operability; the benchmark writes nothing there)
warning / hard per attempt = 2147483648 / 8589934592
```

Every observed input is a census measurement (policyInputsAgree true); the paid agent's private /tmp usage is UNKNOWN before the paid cohort and is labelled so. The policy does not depend on benchmark outcomes and is frozen before any outcome-bearing run; it has no arm field.

## 25. Scratch high-water observations

PRE-LAUNCH OBSERVED INFRASTRUCTURE HIGH-WATER (research instances, replay agent; the paid agent's /tmp usage is unknown):

| attempt | cleanup | high-water bytes | checkpoints (bytes) |
| --- | --- | --- | --- |
| pylint-dev__pylint-7080:baseline#a1#0937d9c71d56 | CLEANED | 34271232 | AFTER_CONTAINER_SETUP 34271232; AFTER_TREATMENT_INITIALISATION 34230272; AFTER_AGENT_COMPLETION 34263040; AFTER_EVALUATION 34263040; BEFORE_CLEANUP 34263040 |
| pylint-dev__pylint-7080:vtrace#a1#4a6e25a20e30 | CLEANED | 95531008 | AFTER_CONTAINER_SETUP 34271232; AFTER_TREATMENT_INITIALISATION 95498240; AFTER_AGENT_COMPLETION 95531008; AFTER_EVALUATION 95531008; BEFORE_CLEANUP 95531008 |
| pylint-dev__pylint-6903:vtrace#a1#a425f7b7ecbf | REFUSED_LIVE_OWNER | 90247168 | AFTER_CONTAINER_SETUP 30691328; AFTER_TREATMENT_INITIALISATION 90214400; AFTER_AGENT_COMPLETION 90247168; AFTER_EVALUATION 90247168; BEFORE_CLEANUP 90247168 |
| pylint-dev__pylint-6903:baseline#a1#4f5383ee028d | CLEANED | 30691328 | AFTER_CONTAINER_SETUP 30691328; AFTER_TREATMENT_INITIALISATION 30650368; AFTER_AGENT_COMPLETION 30683136; AFTER_EVALUATION 30683136; BEFORE_CLEANUP 30683136 |

These are research rows with a replay agent; they justify the conservative floor, not a future
guarantee.

## 26. Cleanup / continuation-safety integration

The M217 principle `VALID RESULT != SAFE TO CONTINUE` now covers scratch: the substrate probe reports
owned bytes AND entries remaining and any container of any name bound into the work root; a refused
or unverified cleanup leaves the path, the enumeration reports it, `classifyTeardown` blocks, and
only `--recover-isolation` — whose probe now refuses to remediate a path the registry does not own
and removes owned residue through the same ownership-checked deletion — resumes (F135, F136, F176,
F177). The emergency monitor (30000 ms cadence, warning 2147483648, hard 8589934592) aborts through the adapter's signal and the bridge watchdog; the aborted attempt is
INFRASTRUCTURE_INVALID / ENVIRONMENT_IRREPRODUCIBLE (not rerunnable; no new retry class), charged at cap, and recorded as SCRATCH_EMERGENCY_ABORT (F151, F180: 40550400 bytes high-water, HARNESS_ABORT).

## 27. Evidence persistence before cleanup

The raw agent stream(s), the captured patch, the evaluator's raw result and a result reference are
copied to `<cohortDir>/evidence/<claimId>/` and each file's digest is recomputed before cleanup may
run; a persistence failure skips cleanup and blocks. The persisted patch hashes to the ledger's
`capturedPatchSha256` (F140); the cleanup authority refuses the evidence directory structurally.

## 28. Operations ledger

New event kinds: `SCRATCH_STALE_SWEEP`, `SCRATCH_CAPACITY_GATE` (blocking when they fail),
`SCRATCH_EMERGENCY_ABORT`, `COHORT_HALTED_RETRY_RESERVE_EXHAUSTED`. Every `ROW_TEARDOWN` carries the
§40 record (scratch_path, free_bytes_before, scratch_high_water_bytes, free_bytes_before_cleanup,
scratch_bytes_after_cleanup, free_bytes_after_cleanup, cleanup_status, checkpoints, emergency).
The chain is append-only and hash-verifiable; a mutated cleanup record is detected (F149, F181).

## 29. Spend reserve interlock

```text
P12_EXECUTABLE_AUTHORITY  COHORT requires M214 + A1 bound with matching lineage (F125B fires without it)
P7_SPEND_AUTHORIZATION    the operator's ceiling must equal the ACTIVE $735 (F125C fires on $700)
P8 / cohort loop          the active ceiling
P11_RETRY_SPEND_RESERVE   + admission: frozen class, slot, reserve dollars at cap, ceiling headroom;
                          records retry ordinal, parent row, reason, class, prior spend, new maximum
                          exposure, remaining reserve (slots/$), remaining global reserve
RETRY_RESERVE_EXHAUSTED   the eleventh retry: refused by P11, and the cohort loop halts as
                          COHORT_HALTED_RETRY_RESERVE_EXHAUSTED (F123); no runtime budget request
```

Up to 10 preregistered infrastructure retries can be funded at the $3.5 cap without making completion of all 200 intended runs impossible under the $735 hard ceiling. An eleventh needed retry, or a reserve that cannot fund one more retry at cap, halts the cohort with COHORT_HALTED_RETRY_RESERVE_EXHAUSTED; the rows that never ran stay PLANNED and the cohort is reported as incomplete. No outcome is fabricated and no budget is raised at runtime.

## 30. M218 falsification suite

Pure 38/38 (9 GUARD_FIRES, 29 GUARD_SILENT); real-host 7/7; real-container 11/11. Brief ids A1–A8 = F118–F125, T1–T25 = F126–F150 (each control records its brief id).

| id | brief | control | expectation | substrate | result |
| --- | --- | --- | --- | --- | --- |
| F118 | A1 | the original M214 preregistration, manifest, external reference and hash record (and M213) are byte-identical to the M217 HEAD blobs | GUARD_SILENT | PURE | satisfied |
| F119 | A2 | the M214 preregistration hash recomputes unchanged and is the amendment's parent | GUARD_SILENT | PURE | satisfied |
| F120 | A3 | an amendment that names a task, model, analysis, turn budget or arm set is refused by the audit, cannot bind as an authority, and a forged digest is refused by P12 | GUARD_FIRES | PURE | satisfied |
| F121 | A4 | the frozen manifest remains 200 rows with its frozen digest, and the amendment declares 200 intended valid outcomes, not 210 | GUARD_SILENT | PURE | satisfied |
| F122 | A5 | the committed amendment verifies to the pinned digest and states 10 attempts x $3.50 = $35 over $700 = $735, decided before any outcome | GUARD_SILENT | PURE | satisfied |
| F123 | A6 | after ten maximum-cost retries the eleventh is refused RETRY_RESERVE_EXHAUSTED by the accounting, by P11 on direct selection, and the cohort loop halts as its own end state without asking for more budget | GUARD_FIRES | PURE | satisfied |
| F124 | A7 | a retry whose prior failure is not on M214's rerunnable list is refused even though the whole reserve remains | GUARD_FIRES | PURE | satisfied |
| F125 | A8 | the external VEXP reference digest is unchanged and is the amendment's parent; the amendment neither cites nor alters it | GUARD_SILENT | PURE | satisfied |
| F125B | — | a COHORT row with no executable authority bound (M214's $700 alone) is refused by P12 before a container starts | GUARD_FIRES | PURE | satisfied |
| F125C | — | an operator authorisation of the original $700 ceiling is refused by P7 once A1 is the active authority ($735) | GUARD_FIRES | PURE | satisfied |
| F126 | T1 | a normal attempt claims owned scratch, records checkpoints, and cleanup leaves 0 run-owned bytes, a released claim, TEARDOWN_CLEAN and SAFE continuation | GUARD_SILENT | PURE | satisfied |
| F127 | T2 | a file the agent creates in its private /tmp lives inside the owned attempt path and is removed after the attempt | GUARD_SILENT | PURE | satisfied |
| F128 | T3 | a substantial nested tree (hundreds of entries, megabytes) is removed completely and its high-water is recorded | GUARD_SILENT | PURE | satisfied |
| F129 | T4 | a path under the namespace with no registered claim is classified UNKNOWN, blocks launch, and is never deleted, even by a forged claim | GUARD_SILENT | PURE | satisfied |
| F130 | T5 | an unrelated user temporary directory beside the namespace is untouched by attempts, sweeps and a direct cleanup request | GUARD_SILENT | PURE | satisfied |
| F145 | T20 | a path outside the namespace is structurally undeletable by the cleanup authority | GUARD_FIRES | PURE | satisfied |
| F145B | T20 | the refused deletion did not touch the target | GUARD_SILENT | PURE | satisfied |
| F131 | T6 | a live process referencing the owned scratch makes cleanup refuse destructive deletion, the valid result stands, and continuation is BLOCKED until the owner is handled | GUARD_SILENT | PURE | satisfied |
| F144 | T19 | once the owning child is gone, the predeclared recovery removes the owned scratch through the ownership-checked path, releases the claim, and the next row runs without rerunning the valid one | GUARD_SILENT | PURE | satisfied |
| F132 | T7 | a teardown that could not remove the container leaves the bind-mounted tree in place, cleanup refuses, and continuation is BLOCKED | GUARD_SILENT | PURE | satisfied |
| F133 | T8 | stale owned scratch whose creator is dead and which nothing references is classified by ownership facts (registry, pid, references; age diagnostic only), removed, and released | GUARD_SILENT | PURE | satisfied |
| F134 | T9 | after a simulated executor crash the resumed sweep records path, size, ownership evidence, live checks and the reason cleanup was safe, then cleans | GUARD_SILENT | PURE | satisfied |
| F150 | T25 | the startup sweep removes safe stale paths and, for an unsafe or unknown path, blocks launch: the first row is refused by P10 | GUARD_SILENT | PURE | satisfied |
| F135 | T10 | a valid result whose scratch cleanup failed is retained unchanged while the next row is blocked | GUARD_SILENT | PURE | satisfied |
| F136 | T11 | after the residue is cleaned and re-probed, the cohort continues at the next row without rerunning the prior valid result | GUARD_SILENT | PURE | satisfied |
| F149 | T24 | the cleanup record rides the append-only, hash-chained operations ledger with the §40 fields, and a mutation is detected | GUARD_SILENT | PURE | satisfied |
| F137 | T12 | with free space one byte below the derived threshold the attempt is refused by P13 before any container or claim | GUARD_FIRES | PURE | satisfied |
| F138 | T13 | with free space at the threshold the valid run path is accepted | GUARD_SILENT | PURE | satisfied |
| F139 | T14 | a low free-inode condition fires the gate even with ample bytes | GUARD_FIRES | PURE | satisfied |
| F140 | T15 | the raw stream, patch and evaluation are persisted outside scratch and digest-verified before cleanup; cleanup cannot reach them and they survive with their digests | GUARD_SILENT | PURE | satisfied |
| F141 | T16 | in both arm orders, a sentinel written by arm 1 into its private /tmp is not visible to arm 2, whose private /tmp is a different owned path | GUARD_SILENT | PURE | satisfied |
| F142 | T17 | baseline and vtrace receive the same private-/tmp shape (<attempt>/tmp) under the same frozen scratch policy; only the attempt path differs | GUARD_SILENT | PURE | satisfied |
| F143 | T18 | an exception thrown during the attempt still persists evidence, tears down and cleans the owned scratch, and continuation is SAFE | GUARD_SILENT | PURE | satisfied |
| F146 | T21 | symlinks inside owned scratch pointing outside (a directory, a file, the home directory) are unlinked never followed, and a claim path that is itself a symlink is refused | GUARD_SILENT | PURE | satisfied |
| F147 | T22 | cleanup of /, /tmp, an empty string, the home directory, the namespace root itself, a relative path and a kernel filesystem is structurally refused, as is establishing a namespace there | GUARD_FIRES | PURE | satisfied |
| F148 | T23 | cleaning run A's owned scratch cannot touch run B's concurrently claimed scratch | GUARD_SILENT | PURE | satisfied |
| F151 | — | an attempt whose owned scratch crosses the frozen hard threshold trips the emergency monitor, which is recorded as SCRATCH_EMERGENCY_ABORT with the high-water, and the scratch is still cleaned | GUARD_SILENT | PURE | satisfied |
| F152 | — | the operational view carries scratch health (free space, owned bytes, stale paths, cleanup failures) and the retry reserve, and names no arm's performance | GUARD_SILENT | PURE | satisfied |
| F166 | T1 | on the real shared /tmp filesystem, owned scratch is created, a real subprocess writes ~48 MiB into it, cleanup executes through the ownership-checked path, free space is recovered, and an unrelated temp sentinel remains | GUARD_SILENT | REAL_PROCESS | satisfied |
| F167 | T21 | on the real filesystem, symlinks from owned scratch to a sibling directory, a file, the home directory and an unrelated /tmp directory are unlinked and their targets untouched | GUARD_SILENT | REAL_PROCESS | satisfied |
| F168 | T6 | a real detached process whose cwd and argv hold the owned path makes the real liveness probe refuse cleanup; once the process is killed, cleanup completes | GUARD_SILENT | REAL_PROCESS | satisfied |
| F169 | T22 | cleanup of /, /tmp, an empty path, the home directory, the namespace root and an unrelated /tmp directory is refused on the real host and nothing is touched | GUARD_FIRES | REAL_PROCESS | satisfied |
| F170 | T9 | on the real host, scratch left by a dead creator with no live reference is recognised by the registry and the real pid check, recorded, and removed by the startup sweep | GUARD_SILENT | REAL_PROCESS | satisfied |
| F171 | T12 | the frozen capacity policy refuses a namespace hosted on the shared tmpfs /tmp: its whole size is below the host reserve plus one projected attempt | GUARD_FIRES | REAL_PROCESS | satisfied |
| F171B | T13 | the same policy passes for a namespace on the cohort's real filesystem (the results directory), with the shared /tmp floor also satisfied | GUARD_SILENT | REAL_PROCESS | satisfied |
| F172 | — | before the first row the real namespace is swept clean, the real host passes the frozen capacity gate, and the substrate enumeration is empty | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F173 | T2 | on the real substrate the agent's /tmp is the attempt's owned directory bound by bwrap; the marker it writes there is removed with the attempt, the raw stream is persisted, the claim is released, and an unrelated host /tmp sentinel survives | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F174 | T16 | baseline → vtrace: the sentinel baseline left in its private /tmp is not visible to the vtrace arm of the same task | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F175 | T17 | baseline and vtrace received identical bwrap tmp configuration and TMP-related environment after normalising the attempt path; the treatment difference is elsewhere | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F176 | T6 | a real detached process spawned inside the agent's namespace keeps the owned scratch alive: the container is gone, cleanup refuses, the real enumeration lists the process and the residue bytes, the valid result stands, and continuation is BLOCKED | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F177 | T19 | while blocked the next row is refused by P10; the predeclared recovery kills the real holder, removes the owned scratch through the ownership-checked authority, releases the claim, and re-proves isolation | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F178 | T11 | vtrace → baseline: after recovery the baseline arm runs without seeing vtrace's sentinel and without the held row being rerun; four rows, four results | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F179 | — | every real row records scratch checkpoints at container setup, agent completion, evaluation and before cleanup, and a positive high-water | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F180 | — | a real attempt whose private /tmp crosses a research hard threshold is aborted through the adapter's signal and the bridge's watchdog, classified ENVIRONMENT_IRREPRODUCIBLE (not rerunnable), charged at cap, recorded as SCRATCH_EMERGENCY_ABORT, and its scratch is still cleaned | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F181 | — | the real cohort's operational view with scratch health names no arm's performance and its operations chain recomputes | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F182 | T25 | after every row the namespace holds nothing owned: the final sweep finds only the marker and the COHORT_OWNED evaluation directory | GUARD_SILENT | REAL_CONTAINER | satisfied |

## 31. Intentional guard breaks

Verdict: **M218_SUITE_IS_FALSIFYING**; sources restored intact: true; restored pure 38/38, restored host 7/7.

| breakage | guard | file | expected | observed | missed | unexpected |
| --- | --- | --- | --- | --- | --- | --- |
| B1_OWNERSHIP_VALIDATION_ACCEPTS_ANY_PATH | scratch ownership / path validation | m218ScratchLifecycle.ts | pure [F130, F140, F145, F145B] host [F169] | pure [F130, F140, F145, F145B] host [F169] | [] | [] |
| B2_CAPACITY_GATE_ALWAYS_PASSES | pre-run free-space gate | m218ScratchLifecycle.ts | pure [F137, F139] host [F171] | pure [F137, F139] host [F171] | [] | [] |
| B3_RETRY_RESERVE_NEVER_EXHAUSTED | retry-reserve ceiling | m218SpendAuthority.ts | pure [F123] host [] | pure [F123] host [] | [] | [] |

Deliberately unaffected, with the mechanism:

- F147: every target it tries (/, /tmp, an empty path, $HOME, a relative path, a kernel filesystem, the namespace root itself) is refused by forbiddenRootReason or by the root-identity check, both of which B1 leaves intact; the first guard-break run predicted it would fall and was wrong for exactly this reason
- F146: symlink refusal happens on lstat of the target before the descendant check, and symlinks inside a tree are unlinked by the walker; B1 does not reach either
- F129: the unregistered path lies INSIDE the namespace; B1 removes the outside check, which that control does not exercise
- F138: B2 makes the gate pass, and F138 expects a pass
- F124: a non-preregistered class is refused before the reserve is consulted; B3 cannot reach it
- F125B: P12 reads the binding, not the accounting

## 32. Preservation of M215–M217 controls

```text
M215 pure   66/66
M216 real   73/73  (re-run under the M218 adapters and bridge)
M217 pure   23/23
M217 real   15/15  (re-run; its research work root now carries a namespace marker so the hardened remediation can prove ownership)
M217 TECHNICAL_EXECUTOR_READY re-derived: true
```

## 33. Scoped typecheck

```text
tsconfig.m218.json  clean 0; injected 1; after removal 0; m217 scope 0
M218_NEW_TYPECHECK_ERRORS = 0   M218_SCOPED_TYPECHECK_VERIFIED
```

The ~59 pre-existing benchmark-test errors remain outside this milestone and are not claimed.

## 34. Standard verification

See the M218 ledger row: `bun run typecheck`, `bun run typecheck:benchmarks`, `bun run lint`,
`bun test`, `git diff --check`, the secret scan, and the M214–M218 scoped typecheck were run after the
final commit and recorded there.

## 35. Frozen artifact integrity

```text
stage5_m213_preregistration.json           UNCHANGED  508b19766b12d1e8
stage5_m213_run_manifest.json              UNCHANGED  5c4207e9d196f2fe
stage5_m214_preregistration.json           UNCHANGED  e57ec71f7ca4a668
stage5_m214_run_manifest.json              UNCHANGED  a81ab4a4861c5fc7
stage5_m214_external_reference.json        UNCHANGED  f974b8d25bf66345
stage5_m214_preregistration_hash.json      UNCHANGED  cf6da9e32172bf4c
stage5_m213_preregistration_hash.json      UNCHANGED  e90029967f58f3c3
A15 / deterministic scorers   src/ tree unchanged (below)
```

## 36. Product immutability

```text
HEAD:src        b3b3e439f10c6c526cafc6001d25dd0e7552ce6d
9eb8689a:src  b3b3e439f10c6c526cafc6001d25dd0e7552ce6d
src/ diff       0 (none)
```

## 37. Zero-spend evidence

```text
provider calls       0
frozen live tasks    0
model spend          $0
```

## 38. Container usage

Research only: 5 containers on pylint-dev__pylint-6903, pylint-dev__pylint-7080 (SWE-bench Verified complement), all torn down; the M216 and M217 suites were re-run once each for preservation. 0 frozen instances.

## 39. Launch gate table

| gate | status | requirement |
| --- | --- | --- |
| G1 | PASS | M214 preregistration committed |
| G2 | PASS | M214 preregistration hash recorded |
| G3 | PASS | M213 remains immutable |
| G4 | PASS | exact VEXP 100-task artifact verified |
| G5 | PASS | 100 task ids frozen |
| G6 | PASS | 200-run manifest frozen |
| G7 | PASS | baseline is treatment-free |
| G8 | PASS | VTRACE treatment executable |
| G9 | PASS | VTRACE identity frozen |
| G10 | PASS | agent identity frozen |
| G11 | PASS | model identity frozen |
| G12 | PASS | native tools identical across arms |
| G13 | PASS | budgets identical across arms |
| G14 | DEFERRED_TO_LAUNCH | source states equivalent before each arm starts |
| G15 | PASS | indexing is observational on tracked source |
| G16 | PASS | .vtrace excluded from patch capture |
| G17 | PASS | metadata reset / warm policy symmetric and verified |
| G18 | PASS | execution-order randomisation frozen |
| G19 | PASS | evaluator validated |
| G20 | PASS | primary paired analysis frozen |
| G21 | PASS | efficiency analysis frozen |
| G22 | PASS | invalid-run rules frozen |
| G23 | PASS | fixed-N stopping frozen |
| G24 | PASS | external VEXP reference frozen |
| G25 | PASS | external reference cannot enter causal analysis |
| G26 | PASS | M214 falsification suite passes |
| G27 | PASS | no frozen-population outcome-bearing agent run has occurred |
| G28 | PASS | live model spend is $0 during preregistration |
| G29 | PASS | M214-owned harness and tests are typechecked |
| G30 | PASS | model availability established |
| G31 | PASS | treatment lifecycle ordering executed and verified |
| G32 | PASS | a launch executor exists that can run the frozen manifest |
| G33 | PASS | LAUNCH_EXECUTOR_IMPLEMENTED: one executor runs any frozen manifest row through the frozen lifecycle under runtime enforcement |
| G34 | PASS | LAUNCH_EXECUTOR_FALSIFIED: the enforcement is exercised by controls that fail when the guards are removed |
| G35 | PASS | an adapter binding exists that can produce authoritative outcomes on the real substrate |
| G36 | FAIL | explicit operator authorisation of the frozen $700 ceiling exists (M218: the amount awaiting authorisation is the $735 hard ceiling under M214 + M214_A1_RETRY_R |
| G37 | PASS | patch capture is unambiguous on both treatment-state routes, against real git |
| G38 | PASS | the cohort survives interruption with no duplicate and no reordered outcome |
| G39 | PASS | M215-owned harness and tests are typechecked |
| G40 | PASS | the frozen VTRACE treatment tree is unchanged |
| G41 | PASS | M214's frozen authorities are unmodified |
| G42 | PASS | no frozen-population outcome-bearing run occurred and live model spend is $0 during M215 |
| G43 | PASS | M216_SUBSTRATE_REDUCTION_COMPLETE: every obligation M215's interfaces impose is matched to an existing authority or named as a missing primitive |
| G44 | PASS | REAL_CONTAINER_ADAPTER_BOUND: the production container adapter exists and started real containers |
| G45 | PASS | REAL_AGENT_ADAPTER_BOUND: the production argv, environment and process reach a real child, and the two arms differ only in MCP configuration |
| G46 | PASS | REAL_EVALUATOR_ADAPTER_BOUND: the official swebench evaluator is invoked and infrastructure failure stays distinct from an unresolved task |
| G47 | PASS | REAL_SOURCE_STATE_AUTHORITY_VERIFIED: source identity is measured, moves when source moves, and is equal across both arms of a pair |
| G48 | PASS | REAL_PATCH_CAPTURE_VERIFIED: the derived rule is unambiguous on both treatment routes, captures real edits exactly, and excludes treatment state written during  |
| G49 | PASS | REAL_PAIR_ISOLATION_VERIFIED: both arm orders run on the real substrate with no treatment state surviving between them |
| G50 | PASS | MODEL_IDENTITY_RUNTIME_GATE_BOUND: the production agent path aborts on a wrong or absent provider identity, and accepts a recorded correct one |
| G51 | PASS | REAL_RESUME_PATH_VERIFIED: a ledger restores in another process, a decided row is refused rather than rerun, and no duplicate outcome is possible |
| G52 | PASS | M216_FALSIFICATION_SUITE_PASSED: every real-substrate control is satisfied and the suite carries both expectations |
| G53 | PASS | no frozen task was touched by the real substrate and live model spend is $0 |
| G54 | PASS | SPEND_PROJECTION_RECONCILED: the mathematically possible cohort is reconciled with the frozen ceiling, retry exposure included |
| G55 | PASS | M216-owned harness, adapters and tests are typechecked |
| G56 | PASS | TEARDOWN_RESULT_VALIDITY_SEPARATED_FROM_CONTINUATION_SAFETY: a completed result keeps its status, bytes and digest across a teardown failure, a halt and a recov |
| G57 | PASS | TEARDOWN_ISOLATION_INTERLOCK_IMPLEMENTED: every teardown is followed by an enumeration; residue of any class blocks, absence proves, a failed probe blocks |
| G58 | PASS | COHORT_HALT_ON_ISOLATION_RISK_VERIFIED: with isolation unproven no next row launches, no container starts, and no flag or direct selection can force one |
| G59 | PASS | ISOLATION_RECOVERY_PATH_VERIFIED: the predeclared path removes exactly the residue, re-proves by a second enumeration, resumes at the next unstarted row and rer |
| G60 | PASS | FROZEN_SPEND_ARITHMETIC_VERIFIED and ZERO_RETRY_HEADROOM_RECORDED: 200 x the frozen cap equals the frozen ceiling, and the launch-risk artifact records the $0 r |
| G61 | PASS | RETRY_SPEND_INTERLOCK_VERIFIED: before a paid retry the three numbers are computed, the frozen policy is applied, the declaration is recorded, and a spend halt  |
| G62 | PASS | OUTCOME_BLIND_OPERATIONS: halt, spend and isolation status expose no arm's performance |
| G63 | PASS | M217_FALSIFICATION_SUITE_PASSED and M217_SUITE_IS_FALSIFYING: both suites satisfied, both expectations present, and the two new guards demonstrably load-bearing |
| G64 | PASS | M217-owned harness and tests are typechecked |
| G65 | PASS | LAUNCHER_BINDING_RESOLUTION: the launcher resolves the DOCKER_SWEBENCH adapters through one factory that the real-substrate controls also ran a full row through |
| G66 | PASS | no frozen task was touched and live model spend is $0 during M217 |
| G67 | PASS | M215 and M216 controls preserved: the predecessor suites still pass in full |
| G68 | PASS | PRE_OUTCOME_FINANCIAL_AMENDMENT_COMMITTED: M214's bytes and digests are untouched, the committed A1 recomputes to the pinned digest, its parent is M214, and it  |
| G69 | PASS | RETRY_RESERVE_10_ATTEMPTS and HARD_SPEND_CEILING_$735: the reserve is exactly 10 x $3.50 = $35 over $700, the eleventh retry is refused RETRY_RESERVE_EXHAUSTED, |
| G70 | PASS | EXECUTABLE_AUTHORITY_BINDING: the launcher and executor require M214 + A1; M214's $700 authority alone and a $700 authorisation are refused by name |
| G71 | PASS | TMP_LIFECYCLE_CENSUS_COMPLETE: every producer on the paid path is attributed and classified, the policy's observed inputs agree with the census, and no historic |
| G72 | PASS | RUN_OWNED_TMP_NAMESPACE_ENFORCED: every attempt claims an owned path under the marked namespace before use, no attempt inherits scratch, unregistered paths are  |
| G73 | PASS | AGENT_TMP_ISOLATED_PER_ATTEMPT: the real bwrap namespace binds the attempt's owned directory at /tmp, the agent's marker is removed with the attempt, and a sent |
| G74 | PASS | BASELINE_VTRACE_TMP_EQUIVALENCE: both arms receive the same private-/tmp configuration and policy, differing only in the attempt path |
| G75 | PASS | RUN_TMP_CLEANUP_VERIFIED: cleanup runs after the container is gone, is verified by measurement to 0 bytes, survives an exception, and removes large nested trees |
| G76 | PASS | STALE_TMP_RECOVERY_VERIFIED: stale owned scratch is classified by ownership facts, never by age, cleaned when safe, blocked when unsafe or unknown, and a crashe |
| G77 | PASS | TMP_CAPACITY_GATE_VERIFIED: P13 refuses below the derived threshold or on low inodes before any container or claim, accepts above it, refuses a tmpfs-hosted nam |
| G78 | PASS | TMP_CLEANUP_PART_OF_CONTINUATION_SAFETY: a live process, mount or container makes cleanup refuse; the valid result stands; the next row is blocked; the predecla |
| G79 | PASS | TMP_PATH_SAFETY_VERIFIED: deletion never follows a symlink, never leaves the canonical namespace, and /, /tmp, $HOME, an empty path and the namespace root are s |
| G80 | PASS | EVIDENCE_PERSISTED_BEFORE_CLEANUP: the raw stream, patch and evaluation are copied out and digest-verified before cleanup and cannot be reached by it |
| G81 | PASS | SCRATCH_EMERGENCY_AND_STATUS: the per-attempt emergency threshold aborts through the real adapter and the bridge watchdog under the frozen infrastructure class, |
| G82 | PASS | M218_FALSIFICATION_SUITE_PASSED and M218_SUITE_IS_FALSIFYING: all three suites satisfied with both expectations present, and the three new guards demonstrably l |
| G83 | PASS | M218-owned harness and tests are typechecked |
| G84 | PASS | no frozen task was touched and live model spend is $0 during M218 |
| G85 | PASS | M215, M216 and M217 controls preserved: the predecessor suites still pass in full under the M218 adapters, bridge and executor |

Required pre-launch gates: P1_PREREGISTRATION_HASH, P2_MANIFEST_HASH, P3_EXTERNAL_REFERENCE_HASH, P4_ROW_IS_FROZEN, P5_NO_RUNTIME_OVERRIDES, P6_EXECUTION_ORDER, P7_SPEND_AUTHORIZATION, P8_SPEND_CEILING, P9_LEDGER_INTEGRITY, P10_CONTINUATION_SAFETY, P11_RETRY_SPEND_RESERVE, P12_EXECUTABLE_AUTHORITY, P13_SCRATCH_CAPACITY.

## 40. Technical readiness

```text
TECHNICAL_EXECUTOR_READY
```

## 41. Human authorization status

```text
SPEND_AUTHORIZATION_PENDING
```

## 42. Proposed authorization amount

```text
$735 hard ceiling  ($700 ordinary + $35 infrastructure-retry reserve, 10 attempts)
```

M218 does not authorise it. Two operational preconditions are reported with the decision: 64 of
100 frozen images are absent from the local Docker store (36/100 present) and M193 does not pull, so pre-pulling is an operator step the launcher now refuses to start without; and the historical /tmp scratch is an operator decision the census documents.

## 43. Repository state / SHAs

```text
HEAD              a5c1204c6d9afcf2b010e318d1715840a4976460
HEAD:src          b3b3e439f10c6c526cafc6001d25dd0e7552ce6d
amendment         0ed156bc924a4817122c46b5c9fc0334e5f046c2dce0547eef2573b2483b76c1
executable auth   782f8a94e5d6bb8e09000b16c37a1037d72cb40537523ab61db0c53fa80ef086
```

## 44. Final principle

The paid benchmark must leave the machine ready for the next run. For every attempt: the agent runs,
evidence persists, processes and containers stop, owned temporary data is removed, filesystem
capacity is rechecked, isolation is proven, and only then may the next row begin. Never clean an
arbitrary /tmp; own the scratch first; isolate the agent's temporary namespace; delete only owned
state; verify it is gone; halt rather than fill the host. And amend the envelope before any outcome
exists: $700 + $35 = $735. Do not spend yet.

