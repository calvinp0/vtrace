# M217 — teardown isolation interlock, retry-spend semantics, and the final
# launch authorization gate

## 1. Executive verdict

```text
M217 — PASS

TEARDOWN_RESULT_VALIDITY_SEPARATED_FROM_CONTINUATION_SAFETY
TEARDOWN_ISOLATION_INTERLOCK_IMPLEMENTED
COHORT_HALT_ON_ISOLATION_RISK_VERIFIED
ISOLATION_RECOVERY_PATH_VERIFIED

FROZEN_SPEND_ARITHMETIC_VERIFIED
ZERO_RETRY_HEADROOM_RECORDED
RETRY_SPEND_INTERLOCK_VERIFIED

M217_FALSIFICATION_SUITE_PASSED
M217_SUITE_IS_FALSIFYING
M217_SCOPED_TYPECHECK_VERIFIED

TECHNICAL_EXECUTOR_READY

SPEND_AUTHORIZATION_PENDING
PAID_RUNS_NOT_STARTED
LIVE_MODEL_SPEND_$0
```

M216 left one launch-critical mechanism unimplemented: a teardown failure after a valid result
let the result stand — correctly — and let the next row start regardless. M217 separates the
two questions. A result ledger says what happened on a task; a second, append-only operations
ledger says whether the substrate is proven clean enough for the next task. The cohort launcher
consumes the second and the executor's P10 gate refuses any row while it is BLOCKED. Isolation
is proven by ABSENCE — a real Docker and /proc enumeration after every teardown — never by an
argument that present residue would not matter.

The second objective is the $0 retry reserve. 200 x $3.50 = $700 = the frozen ceiling. The
executor now computes, before any attempt, current spend + this attempt's cap + every remaining
required attempt at cap, applies the FROZEN retry policy recovered from M214, records the
declaration as an operational event, and halts with COHORT_HALTED_SPEND_CEILING when the ceiling
binds. The launch-risk artifact states the consequence for the human decision.

## 2. Starting repository state

```text
branch            main
HEAD at start     26d0243ac75cd3702435683258c5d8eea88fff6b (M216)
HEAD when generated  f9b00d3447ebb2dc8ac9ef8dd3a976456649d1a6
ahead/behind      0	241 (left origin/main, right HEAD)
pushed            no

M217 commits so far:
  f9b00d34 Make the zero retry reserve act before it spends
  697a4c9e Separate whether a result is valid from whether the next row may begin
```

The M216 commits d9822a63, 29f8712d, 46c397a7, 99ae21b6 and 26d0243a are present and unmodified.
Pre-existing dirt — `stage5_outcome_ledger.{json,md}` and the historical untracked benchmark
results — was preserved; nothing was reset, cleaned or unstaged.

## 3. Frozen experiment identities

```text
preregistration      3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4  VERIFIED
manifest             549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1  VERIFIED
externalReference    822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b  VERIFIED
preregistrationHashExcludedFields undefined  NOT VERIFIED
documentedExclusionsAreIncomplete undefined  NOT VERIFIED
documentedExclusionNote undefined  NOT VERIFIED
```

All recompute from the committed bytes; §20 compares every frozen file byte-for-byte against the
M216 HEAD blob. The experiment is unchanged: 100 tasks x 2 arms = 200 intended runs, arms
BASELINE and VTRACE, VEXP an EXTERNAL_VENDOR_REFERENCE, no third arm.

## 4. M216 unresolved issues, reproduced

Two, one named by M216 and one it did not see.

**Halt-on-isolation-risk was unimplemented.** `M216ContainerAdapter.stop` called
`container.stop` on the bridge and discarded the answer: the bridge returned
`{stopped: false, containerRemoveError: ...}` and nothing read it, so a container that survived
removal was indistinguishable from one that did not, and `runCohort` selected the next row
either way. That is not hypothetical. Before M217 started any container, its probe found residue
on this machine left by a PREVIOUS session (`stage5_m217_field_witness.json`):

```text
m193-psf__requests-2317  running  9c1edbb80030  created 2026-09-04T21:04:18.171249865Z  swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest
  mount /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/_m216_work/baseline_first/psf__requests-2317--baseline/testbed -> /testbed (bind, rw)
  M216's abandoned psf/requests research attempt (M216 report §8): the runner was stopped when the official evaluator blocked on live HTTP, and this container survived; M216's later suite runs re-created the work root and counted only the containers they started
  observed 2026-09-05T10:40:39Z; recovery ISOLATION_RECOVERY_VERIFIED: removed container m193-psf__requests-2317 (9c1edbb80030)
```

It was the container M216's abandoned psf/requests attempt had started, still running thirteen
hours later, bind-mounted to a work directory that no longer existed. M216 reported "10 torn
down" and was right about the ten it counted; this one predated the final suite run and nothing
in the harness could see it. The M217 launch preflight classified it BLOCKING and the recovery
path removed it; the current evidence document's own preflight (§10) then found
0 item(s), because the guard-break's restored re-run came after the clean-up. The
witness is kept in its own artifact for exactly that reason, and the runner now writes it there.

**The launcher could not construct the production adapters.** `run_stage5_m215_launch.ts`
resolved a binding's adapters through `(binding as {adapters?: never}).adapters`, a property no
binding declares. M216's end-to-end rows went through `executeManifestRow` from its own runner, so
a COHORT launch would have passed every refusal and then thrown "declares no adapters". §28 says
TECHNICAL_EXECUTOR_READY excludes exactly this kind of gap; it is closed by one factory
(`m217LaunchBinding.ts`) that the launcher and the real-substrate controls both call (G65).

## 5. Teardown lifecycle architecture

Recovered from the substrate rather than designed:

```text
container.start   M193Container.setup(): force-remove any container named m193-<instance>,
                  rmtree the host mount, docker cp /testbed out of the image, create+start a
                  new container over the bind mount, checkout the base commit
agent.run         Popen(bwrap ... claude ...) on the HOST; bwrap binds the arm's tree at
                  /testbed; no --die-with-parent, no --unshare-pid; the MCP server (vtrace
                  mcp-serve) is a child of the CLI inside that namespace
evaluator         swebench run_evaluation creates sweb.eval.<instance>.<run_id> and removes it
container.stop    M193Container.teardown(): remove(force=True) reported as containerRemoved /
                  containerRemoveError; rmtree(host_mount, ignore_errors) as mountRemoved;
                  then the TS adapter rmSync's the arm root
```

So every row gets a new container and a freshly extracted tree BY CONSTRUCTION, and M217 records
that (F115) — but does not rely on it. A container that survived teardown also implies a process
that may still be running against a mount the next row's timing shares, and an arm root that
survived means a retry's M193A configuration directory already exists. Freshness of the next
container is not a proof that the previous row is gone.

## 6. Result validity vs continuation safety

```text
RESULT ledger      m215CohortLedger      what happened on this task   append-only, hash-chained
OPERATIONS ledger  m217ContinuationSafety  may the next task begin      append-only, hash-chained
```

The executor's `finally` now tears down and REPORTS, then hands the report to the operations
authority together with the result's digest, read from the result ledger. The authority
enumerates the substrate, classifies, and appends `ROW_TEARDOWN` (plus
`COHORT_HALTED_ISOLATION_RISK` when blocked). It has no method that produces or alters a result
record: an operational event can point at a result and cannot be anything a result reader
consults. F87/F95 (pure) and F108 (real) hold the digest, bytes and status of a valid row fixed
across a teardown failure, a halt and a recovery.

## 7. Isolation proof

Proven by absence, enumerated by the substrate bridge's `substrate.residualState`:

```text
harnessContainers    docker containers named m193-*           (running or not)
evaluatorContainers  docker containers named sweb.eval.*
liveProcesses        /proc/*/cmdline containing the cohort work root
                     (agent, bwrap namespace, MCP server, evaluator subprocess)
armRootPresent       the row's <workRoot>/<instance>--<arm>
hostMountPresent     the row's extracted /testbed tree
openBridgeHandles    container handles the bridge still holds
probeErrors          a probe that could not look proves nothing
```

Classification is a function of (what the adapter reported, what is actually there); the second
input decides continuation and the first only names the case:

| report | enumeration | classification | continuation |
| --- | --- | --- | --- |
| clean | empty | TEARDOWN_CLEAN | SAFE |
| failed | empty | TEARDOWN_FAILURE_ISOLATION_PROVEN | SAFE |
| failed | residue | TEARDOWN_FAILURE_ISOLATION_UNPROVEN | BLOCKED |
| clean | residue | RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN | BLOCKED |
| any | probe error | ISOLATION_PROBE_FAILED | BLOCKED |

## 8. Halt mechanism

One authority, two consumers. `launchPreconditionGates` gains `P10_CONTINUATION_SAFETY`, required,
which fails while the operations ledger's state is BLOCKED or its chain does not recompute; it is
on the frozen required-gate list, so a result whose evidence lacks it cannot become valid.
`runCohort` checks the state BEFORE selecting a row and stops with COHORT_HALTED_ISOLATION_RISK.
In COHORT mode a missing authority fails P10 closed (F101). The launcher accepts no `--force`
and refuses every unknown flag by name; `--row` goes through the same P10 (F85, F109).

## 9. Recovery mechanism

```text
1. the cohort loop stops; no next row is selected
2. an operator invokes the launcher's --recover-isolation action (no other flag reaches BLOCKED state)
3. the probe enumerates residual substrate state under the cohort work root
4. the probe remediates exactly what it enumerated: harness containers, evaluator containers, processes referencing the work root, the stale arm root
5. the probe enumerates again and the second enumeration must be empty
6. ISOLATION_RECOVERY_VERIFIED is appended and continuation returns to CONTINUATION_SAFE
7. the operator relaunches with --resume; selectNextRow resumes at the next unstarted row in frozen order, and a row with a valid outcome is refused rather than rerun
```

`recover()` is defined only from BLOCKED, is reachable only through `--recover-isolation`, runs no
row, and appends ISOLATION_RECOVERY_VERIFIED only when the SECOND enumeration is empty; a
remediation that reported success and removed nothing is ISOLATION_RECOVERY_FAILED and the cohort
stays halted (F100). Remediation is bounded to what enumeration lists: the two container prefixes,
processes matching the work root, and directories under the work root.

## 10. Real-substrate teardown test

```text
bridge         stage5.m216.substrate-bridge.v1   docker 29.6.2   swebench 4.1.0
containers     4 created, 4 started, 3 torn down by the adapter (one by remediation)
instances      pylint-dev__pylint-6903, pylint-dev__pylint-7080   frozen touched 0
```

Sequence, all through the launcher's own adapter factory and M215's `executeManifestRow`:

| step | what | result |
| --- | --- | --- |
| preflight | enumerate before any M217 container | no residue; SAFE (this run followed the guard-break's clean-up; the first run's witness is in §4) |
| row 0 | baseline pylint-dev__pylint-7080 | VALID_UNRESOLVED; gates P1_PREREGISTRATION_HASH=PASS, P10_CONTINUATION_SAFETY=PASS, P11_RETRY_SPEND_RESERVE=PASS |
| row 1 | vtrace pylint-dev__pylint-7080 | VALID_UNRESOLVED; gates P1_PREREGISTRATION_HASH=PASS, P10_CONTINUATION_SAFETY=PASS, P11_RETRY_SPEND_RESERVE=PASS |
| row 2 | baseline pylint-dev__pylint-6903 | VALID_UNRESOLVED; gates P1_PREREGISTRATION_HASH=PASS, P10_CONTINUATION_SAFETY=PASS, P11_RETRY_SPEND_RESERVE=PASS |
| row 1 teardown | SKIPPED by the control | real enumeration listed the container, the arm root and the bridge handle; TEARDOWN_FAILURE_ISOLATION_UNPROVEN; BLOCKED |
| row 2 attempt | while blocked | refused by P10, no container created; runCohort stopped with COHORT_HALTED_ISOLATION_RISK |
| recovery | --recover-isolation path | ISOLATION_RECOVERY_VERIFIED: removed container m193-pylint-dev__pylint-7080 (d165a44c730d); removed arm root /home/calvin/code/vtrace/benchmarks/stage5_vexp_swe_bench_smoke/results/_m217_work/pylint-dev__pylint-7080--vtrace; dropped stale bridge handle m216-pylint-dev__pylint-7080-d165a44c730d |
| row 2 | after recovery | ran to a valid outcome; row 1 not rerun; 3 entries |
| process witness | python3 sleep referencing the work root (pid 1678786) | listed [1678786]; BLOCKED; remediation killed it; SAFE |
| evaluator witness | docker container named sweb.eval.m217-witness.* | listed; BLOCKED; remediation removed it; SAFE |
| false failure | container removed out from under the adapter | adapter reported "container.stop reported stopped=false: unknown handle"; enumeration empty; ISOLATION_PROVEN; SAFE |

Operational events, in order:

```text
 0  LAUNCH_ISOLATION_PREFLIGHT       CONTINUATION_SAFE      
 1  ROW_TEARDOWN                     CONTINUATION_SAFE      TEARDOWN_CLEAN
 2  ROW_TEARDOWN                     CONTINUATION_BLOCKED   TEARDOWN_FAILURE_ISOLATION_UNPROVEN
 3  COHORT_HALTED_ISOLATION_RISK     CONTINUATION_BLOCKED   TEARDOWN_FAILURE_ISOLATION_UNPROVEN
 4  ISOLATION_RECOVERY_VERIFIED      CONTINUATION_SAFE      
 5  ROW_TEARDOWN                     CONTINUATION_SAFE      TEARDOWN_CLEAN
 6  ROW_TEARDOWN                     CONTINUATION_BLOCKED   RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN
 7  COHORT_HALTED_ISOLATION_RISK     CONTINUATION_BLOCKED   RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN
 8  ISOLATION_RECOVERY_VERIFIED      CONTINUATION_SAFE      
 9  ROW_TEARDOWN                     CONTINUATION_BLOCKED   RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN
10  COHORT_HALTED_ISOLATION_RISK     CONTINUATION_BLOCKED   RESIDUAL_STATE_AFTER_REPORTED_CLEAN_TEARDOWN
11  ISOLATION_RECOVERY_VERIFIED      CONTINUATION_SAFE      
12  ROW_TEARDOWN                     CONTINUATION_SAFE      TEARDOWN_FAILURE_ISOLATION_PROVEN
```

The final status of that research cohort was
`EXPERIMENT_COMPLETED_FIXED_N` with continuation `CONTINUATION_SAFE`; its
cumulative spend of $0.897126 is the cost field of the RECORDED init fixture M216
captured, replayed at the REPLAY boundary — no provider was contacted.

## 11. Spend arithmetic

```text
planned ordinary rows:
200

per-row cap:
$3.5

maximum ordinary exposure:
$700

frozen global ceiling:
$700

retry reserve:
$0

mathematical maximum (every row retried once): $1400
frozen N consistent (M214_BUDGET, M214_STOPPING_RULE, manifest): true
```

Recomputed from `M214_BUDGET` and the committed manifest (F89); M216's shorthand was exact.

## 12. Retry policy interaction

Frozen binding: `PERMIT_RETRY_AND_DECLARE_COMPLETION_NOT_GUARANTEED`, read from:

```text
M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun = 2
M214_EXCLUSIONS.retryPolicy.bothAttemptsRemainInLedger = true
M214_STOPPING_RULE.budgetInterlock = "The $700 total cap is an infrastructure guard, not a stopping rule. If it binds, the cohort is incomplete and is reported as incomplete."
```

A rerunnable infrastructure failure is entitled to a second attempt; the failed attempt's cost stays in the cumulative total; and if the ceiling binds the cohort is INCOMPLETE and is reported as incomplete. M214 contains no rule that prefers completing first attempts over honouring a permitted retry, so refusing the retry to protect completion would be a new scheduling rule. The frozen binding therefore PERMITS a retry that fits under the ceiling and DECLARES, mechanically and before the retry begins, that fixed-N completion is no longer guaranteed. The ceiling itself remains the refusal that binds.

The refusing branch exists in code and is controlled, so a later preregistration amendment could select it; selecting it here would be a policy decision this milestone is not authorised to make.

Mechanically, before every attempt `P11_RETRY_SPEND_RESERVE` computes
`cumulative + this attempt's cap + (remaining required attempts x cap)` against the ceiling and
records `FIXED_N_COMPLETION_GUARANTEED` or `FIXED_N_COMPLETION_NOT_GUARANTEED`; a retry additionally
appends a `RETRY_RESERVE_DECISION` operational event before the container starts. The brief's
F83 asked for refusal when the reserve is exceeded; the generic guard implements and controls that
branch (F91), and the frozen binding permits-and-declares (F91B), because M214 explicitly allows
an incomplete cohort and contains no completion-preference rule. The brief's own escape clause
("unless the frozen policy explicitly allows sacrificing cohort completion") is the one taken.

**Reported for the launch decision, not resolved here.** Under the frozen binding, a retry that
consumes reserve trades the LAST rows of the randomised order for the retried cell; under the
refusing branch it trades the retried cell for the tail. Both are arm-blind. Choosing the
refusing branch is a preregistration amendment, not code.

## 13. Incomplete-cohort behavior

```text
EXPERIMENT_COMPLETED_FIXED_N     every planned run reached a terminal state (M214's definition)
COHORT_HALTED_SPEND_CEILING      the ceiling binds; unstarted rows stay PLANNED; reported incomplete
COHORT_HALTED_ISOLATION_RISK     isolation unproven; no next row; recovery path only
COHORT_IN_PROGRESS / COHORT_NOT_STARTED
```

F93 drives a COHORT-mode loop at $699 spent: it halts before selecting a row, appends
COHORT_HALTED_SPEND_CEILING, writes nothing to the result ledger, leaves every row PLANNED, and the
finaliser refuses. No missing run is manufactured.

## 14. Outcome-blind operational status

`renderProgress` and `cohortOperationalStatus` expose rows planned/terminal/remaining, rows
requiring an attempt, spend consumed, maximum remaining exposure, completion reserve, isolation
state and halt reason. F94 (pure) and F116 (real) test every key against
`/win|passRate|resolved|pValue|mcnemar|discordant|byArm|baseline|vtrace|delta|treatmentEffect/i`
and the halt text against outcome language; nothing leaks.

## 15. Falsification suite

M216 ended at F81, so the brief's F74–F90 are realised as F82–F98 with the brief id recorded on
each control; ids past F98 are controls the implementation needed.

**Pure: 23/23** (4 GUARD_FIRES, 19 GUARD_SILENT); failures [none].

| id | brief | claim | expectation | substrate | result |
| --- | --- | --- | --- | --- | --- |
| F82 | F74 | a valid result followed by a clean teardown is retained, continuation is SAFE, and the next row is permitted | GUARD_SILENT | PURE | satisfied |
| F83 | F75 | a valid result whose teardown reported a failure is retained, and continuation is allowed only because the enumeration proved the substrate empty | GUARD_SILENT | PURE | satisfied |
| F84 | F76 | a valid result whose teardown left a harness container behind is retained, continuation is BLOCKED, and the next row is refused before any container starts | GUARD_SILENT | PURE | satisfied |
| F85 | F77 | a blocked continuation cannot be forced: every force-shaped flag is refused by name, a direct row selection is refused by P10, and the completed row cannot be re-selected | GUARD_FIRES | PURE | satisfied |
| F86 | F78 | after remediation the preflight re-proves a clean substrate, the next unstarted row is permitted, and the previous valid row is not rerun | GUARD_SILENT | PURE | satisfied |
| F87 | F79 | a teardown failure, the halt and the recovery leave the prior valid row's status, record bytes and digest untouched | GUARD_SILENT | PURE | satisfied |
| F96 | F88 | both ledgers restore in another process after recovery, the correct next manifest row runs, and no completed row acquires a duplicate result | GUARD_SILENT | PURE | satisfied |
| F88 | F80 | a run that never reached an authoritative outcome keeps M214's invalid-run semantics when the substrate also fails; continuation safety does not redefine its validity | GUARD_SILENT | PURE | satisfied |
| F89 | F81 | 200 x the frozen per-row cap equals the frozen global ceiling exactly, so the paid retry reserve is $0 and every frozen N agrees | GUARD_SILENT | PURE | satisfied |
| F90 | F82 | a retry after a failed attempt that provably cost $0 fits inside the completion reserve under the frozen ceiling and is permitted under both policies | GUARD_SILENT | PURE | satisfied |
| F91 | F83 | the generic guard refuses a paid retry whose worst case, plus every remaining required attempt, exceeds the frozen ceiling (policy REFUSE_RETRY_WHEN_COMPLETION_RESERVE_EXCEEDED) | GUARD_FIRES | PURE | satisfied |
| F91B | F83 | under the frozen binding the same retry is permitted, FIXED_N_COMPLETION_NOT_GUARANTEED is recorded as an operational event before it begins, and the status view says so | GUARD_SILENT | PURE | satisfied |
| F92 | F84 | with ten rows under-spent at $0.66, a paid retry fits inside the completion reserve under the FROZEN $700 ceiling (no synthetic ceiling needed) and the strict guard accepts it | GUARD_SILENT | PURE | satisfied |
| F93 | F85 | when the ceiling binds the cohort halts with COHORT_HALTED_SPEND_CEILING, the unstarted rows stay PLANNED, nothing is written to the result ledger and the finaliser refuses | GUARD_SILENT | PURE | satisfied |
| F94 | F86 | the halt and spend status views name rows completed, rows remaining, spend, exposure, isolation state and halt reason, and no arm's performance | GUARD_SILENT | PURE | satisfied |
| F95 | F87 | an operational teardown event references the result digest read-only; mutating the event is detected by the operations chain and cannot reach the result ledger | GUARD_SILENT | PURE | satisfied |
| F97 | F89 | residual state capable of contaminating the next row — an evaluator container, a harness container, a live treatment process, an open bridge handle — blocks continuation even when the teardown reported clean | GUARD_SILENT | PURE | satisfied |
| F98 | F90 | a cleanup failure whose enumeration proves the substrate empty ("No such container") does not deadlock the cohort: isolation is proven by absence and the next rows run | GUARD_SILENT | PURE | satisfied |
| F99 | — | an isolation probe that cannot enumerate the substrate blocks continuation rather than assuming it clean | GUARD_SILENT | PURE | satisfied |
| F100 | — | a recovery whose post-remediation enumeration is not empty is recorded as failed and the cohort stays halted | GUARD_SILENT | PURE | satisfied |
| F101 | — | a COHORT-mode row with no continuation-safety authority bound is refused by P10 before a container starts | GUARD_FIRES | PURE | satisfied |
| F102 | — | an operations ledger whose chain no longer recomputes fails P10, so a forged SAFE state cannot admit a row | GUARD_FIRES | PURE | satisfied |
| F103 | — | the launch preflight refuses to start a cohort over a stale harness container, and the same recovery path clears it | GUARD_SILENT | PURE | satisfied |

**Real substrate: 15/15** (2 GUARD_FIRES, 13 GUARD_SILENT); failures [none].

| id | brief | claim | expectation | substrate | result |
| --- | --- | --- | --- | --- | --- |
| F104 | — | the launch preflight enumerates the real substrate before any row, blocks over residue left by a previous session if any, and the recovery path leaves it provably clean | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F106 | F74 | on the real substrate, a row run through the launcher's own adapter factory reaches a valid outcome, its real teardown is classified TEARDOWN_CLEAN by a real Docker/proc enumeration, and continuation is SAFE | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F107B | F76 | the real enumeration FIRES on the residue the skipped teardown left behind | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F107 | F76 | a valid result whose real teardown was skipped is retained, the real enumeration lists the surviving container, arm root and bridge handle, and continuation is BLOCKED | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F109B | F77 | P10 FIRES on the next row while the real substrate is unproven | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F109 | F77 | while blocked, the next research row is refused by P10 with no container created, and the cohort loop stops with COHORT_HALTED_ISOLATION_RISK | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F110 | F78 | the predeclared recovery path removes exactly the real residue, the second real enumeration is empty, and continuation returns to SAFE | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F111 | F88 | after recovery the cohort resumes at the next unstarted manifest row, which runs to a valid outcome, with no duplicate result for any completed row | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F108 | F79 | the skipped teardown, the halt, the refusal and the recovery leave row 1's status, bytes and digest untouched on the real substrate | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F115 | — | every row received its own arm root and host mount (M193 re-extracts the tree and creates a new container per start); freshness is recorded, and is NOT what continuation relies on | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F112 | F89 | a live host process referencing the cohort work root blocks continuation even after a clean teardown report, and the real remediation terminates it | GUARD_SILENT | REAL_PROCESS | satisfied |
| F113 | F89 | a stale evaluator container (swebench's own naming) blocks continuation after a clean teardown report, and the real remediation removes it | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F114 | F90 | a real teardown that reports a failure ("unknown handle") because the container was already gone is classified ISOLATION_PROVEN by the real enumeration, and does not deadlock the cohort | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F116 | F86 | the operational status of a real cohort that halted and recovered names no arm's performance | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F117 | — | the real operations ledger chain recomputes | GUARD_SILENT | REAL_CONTAINER | satisfied |

## 16. Intentional guard break

**M217_SUITE_IS_FALSIFYING**

| breakage | class | file | expected pure failures | expected real failures |
| --- | --- | --- | --- | --- |
| B1_CONTINUATION_SAFETY_IGNORES_RESIDUE | continuation safety | `m217ContinuationSafety.ts` | F84, F85, F86, F88, F94, F96, F97, F100 | F107, F109, F109B, F110, F111, F112, F113 |
| B2_RETRY_RESERVE_ALWAYS_WITHIN | retry spend reserve | `m217RetryReserve.ts` | F91, F91B | — |

```text
pure   clean 23/23   broken 13/23 failing [F100, F84, F85, F86, F88, F91, F91B, F94, F96, F97]   restored 23/23
real   clean 15/15   broken 8/15 failing [F107, F109, F109B, F110, F111, F112, F113]   restored 15/15
unexpected [none]   missed [none]   sources restored byte-identical true
```

Controls deliberately NOT expected to fall, and why:

- **F107B** — it asserts the real PROBE's enumeration fires on the residue, which B1 does not touch; B1 makes the CLASSIFIER ignore that enumeration, which F107 catches
- **F99** — a probe failure is checked before residue is consulted, so ignoring residue cannot reach it
- **F103** — the launch preflight reads residualStateIssues directly rather than through classifyTeardown
- **F104** — same as F103, on the real substrate
- **F114** — a false cleanup failure is PROVEN whether or not residue is consulted, because there is none
- **F89** — the frozen arithmetic does not go through retryReserveDecision

The first guard-break run mispredicted two controls, and both corrections are mechanism rather
than fitting: F96 falls under B1 because F85's direct row selection is no longer refused and
actually runs a row, moving the resume point; F107B does NOT fall because it asserts the real
probe's enumeration, which B1 leaves intact — B1 makes the classifier ignore it, which F107 catches.

## 17. Preservation of M216 controls

```text
M215 falsification     66/66   (44 GUARD_FIRES, 22 GUARD_SILENT)
M216 real substrate    73/73   (24 GUARD_FIRES, 49 GUARD_SILENT), re-run after M217's changes
M216 readiness         TECHNICAL_EXECUTOR_READY
```

One M215 test assertion was extended, not weakened: the hardcoded required-prelaunch gate list in
`m215LaunchExecutor.test.ts` now includes P10 and P11, because a valid result must carry them.
M216's suite was not modified; its three adapter constructors, argv, environment, parser and
evaluator paths are unchanged, and `stop()` now returns a report instead of discarding one.

## 18. Scoped typecheck

```text
M217_NEW_TYPECHECK_ERRORS = 0
scoped clean            0
with injected error     1
after removal           0
M216's own scope        0
M217_SCOPED_TYPECHECK_VERIFIED
```

`tsconfig.m217.json` keeps M214–M216 in scope and adds M217's files and tests. The ~59 historical
benchmark-test errors outside this scope are unchanged and NOT claimed fixed.

## 19. Standard verification

```text
bun run typecheck                 clean
bun run typecheck:benchmarks      clean
bun run lint                      clean
bun test                          6617 pass, 49 skip, 0 fail (397 files), full suite at commit 2 + evidence
git diff --check                  clean
M217 scoped typecheck             M217_SCOPED_TYPECHECK_VERIFIED
M215 falsification suite          66/66
M216 real-substrate suite         73/73
M217 pure suite                   23/23
M217 real-substrate suite         15/15
M217 guard-break                  M217_SUITE_IS_FALSIFYING
secret scan                       0 leaks (both M217 evidence documents scanned before persist)
```

## 20. Frozen artifact immutability

```text
stage5_m213_preregistration.json           UNCHANGED  508b19766b12d1e8
stage5_m213_run_manifest.json              UNCHANGED  5c4207e9d196f2fe
stage5_m214_preregistration.json           UNCHANGED  e57ec71f7ca4a668
stage5_m214_run_manifest.json              UNCHANGED  a81ab4a4861c5fc7
stage5_m214_external_reference.json        UNCHANGED  f974b8d25bf66345
stage5_m214_preregistration_hash.json      UNCHANGED  cf6da9e32172bf4c
stage5_m213_preregistration_hash.json      UNCHANGED  e90029967f58f3c3
```

Compared byte for byte against the M216 HEAD blobs. VTRACE treatment identity:

```text
HEAD:src        b3b3e439f10c6c526cafc6001d25dd0e7552ce6d
26d0243a:src    b3b3e439f10c6c526cafc6001d25dd0e7552ce6d   UNCHANGED
```

## 21. Product immutability

```text
src/ diff vs M216 HEAD: 0 files
```

No VTRACE retrieval, index, impact, parity or treatment change. No product change was needed.

## 22. Zero-spend evidence

```text
provider calls                   0
live model spend                 $0
frozen task live-agent runs      0
frozen tasks touched             0
real containers                  4 (research instances only) + 1 evaluator-named witness container
```

Every agent process was the production launch path ending at the REPLAY boundary; the bridge
refuses LIVE outside COHORT mode and COHORT mode was never entered.

## 23. Final launch gates

| gate | class | status | requirement |
| --- | --- | --- | --- |
| G1 | PREREGISTRATION | PASS | M214 preregistration committed |
| G2 | PREREGISTRATION | PASS | M214 preregistration hash recorded |
| G3 | PREREGISTRATION | PASS | M213 remains immutable |
| G4 | PREREGISTRATION | PASS | exact VEXP 100-task artifact verified |
| G5 | PREREGISTRATION | PASS | 100 task ids frozen |
| G6 | PREREGISTRATION | PASS | 200-run manifest frozen |
| G7 | PREREGISTRATION | PASS | baseline is treatment-free |
| G8 | PREREGISTRATION | PASS | VTRACE treatment executable |
| G9 | PREREGISTRATION | PASS | VTRACE identity frozen |
| G10 | PREREGISTRATION | PASS | agent identity frozen |
| G11 | PREREGISTRATION | PASS | model identity frozen |
| G12 | PREREGISTRATION | PASS | native tools identical across arms |
| G13 | PREREGISTRATION | PASS | budgets identical across arms |
| G14 | RUNTIME | DEFERRED_TO_LAUNCH | source states equivalent before each arm starts |
| G15 | PREREGISTRATION | PASS | indexing is observational on tracked source |
| G16 | PREREGISTRATION | PASS | .vtrace excluded from patch capture |
| G17 | PREREGISTRATION | PASS | metadata reset / warm policy symmetric and verified |
| G18 | PREREGISTRATION | PASS | execution-order randomisation frozen |
| G19 | PREREGISTRATION | PASS | evaluator validated |
| G20 | PREREGISTRATION | PASS | primary paired analysis frozen |
| G21 | PREREGISTRATION | PASS | efficiency analysis frozen |
| G22 | PREREGISTRATION | PASS | invalid-run rules frozen |
| G23 | PREREGISTRATION | PASS | fixed-N stopping frozen |
| G24 | PREREGISTRATION | PASS | external VEXP reference frozen |
| G25 | PREREGISTRATION | PASS | external reference cannot enter causal analysis |
| G26 | PREREGISTRATION | PASS | M214 falsification suite passes |
| G27 | PREREGISTRATION | PASS | no frozen-population outcome-bearing agent run has occurred |
| G28 | PREREGISTRATION | PASS | live model spend is $0 during preregistration |
| G29 | PREREGISTRATION | PASS | M214-owned harness and tests are typechecked |
| G30 | PREREGISTRATION | PASS | model availability established |
| G31 | PREREGISTRATION | PASS | treatment lifecycle ordering executed and verified |
| G32 | INFRASTRUCTURE | PASS | a launch executor exists that can run the frozen manifest |
| G33 | INFRASTRUCTURE | PASS | LAUNCH_EXECUTOR_IMPLEMENTED: one executor runs any frozen manifest row through the frozen lifecycle under runtime enforcement |
| G34 | INFRASTRUCTURE | PASS | LAUNCH_EXECUTOR_FALSIFIED: the enforcement is exercised by controls that fail when the guards are removed |
| G35 | INFRASTRUCTURE | PASS | an adapter binding exists that can produce authoritative outcomes on the real substrate |
| G36 | INFRASTRUCTURE | FAIL | explicit operator authorisation of the frozen $700 ceiling exists |
| G37 | INFRASTRUCTURE | PASS | patch capture is unambiguous on both treatment-state routes, against real git |
| G38 | INFRASTRUCTURE | PASS | the cohort survives interruption with no duplicate and no reordered outcome |
| G39 | INFRASTRUCTURE | PASS | M215-owned harness and tests are typechecked |
| G40 | PREREGISTRATION | PASS | the frozen VTRACE treatment tree is unchanged |
| G41 | PREREGISTRATION | PASS | M214's frozen authorities are unmodified |
| G42 | INFRASTRUCTURE | PASS | no frozen-population outcome-bearing run occurred and live model spend is $0 during M215 |
| G43 | INFRASTRUCTURE | PASS | M216_SUBSTRATE_REDUCTION_COMPLETE: every obligation M215's interfaces impose is matched to an existing authority or named as a missing primitive |
| G44 | INFRASTRUCTURE | PASS | REAL_CONTAINER_ADAPTER_BOUND: the production container adapter exists and started real containers |
| G45 | INFRASTRUCTURE | PASS | REAL_AGENT_ADAPTER_BOUND: the production argv, environment and process reach a real child, and the two arms differ only in MCP configuration |
| G46 | INFRASTRUCTURE | PASS | REAL_EVALUATOR_ADAPTER_BOUND: the official swebench evaluator is invoked and infrastructure failure stays distinct from an unresolved task |
| G47 | INFRASTRUCTURE | PASS | REAL_SOURCE_STATE_AUTHORITY_VERIFIED: source identity is measured, moves when source moves, and is equal across both arms of a pair |
| G48 | INFRASTRUCTURE | PASS | REAL_PATCH_CAPTURE_VERIFIED: the derived rule is unambiguous on both treatment routes, captures real edits exactly, and excludes treatment state written during the run |
| G49 | INFRASTRUCTURE | PASS | REAL_PAIR_ISOLATION_VERIFIED: both arm orders run on the real substrate with no treatment state surviving between them |
| G50 | INFRASTRUCTURE | PASS | MODEL_IDENTITY_RUNTIME_GATE_BOUND: the production agent path aborts on a wrong or absent provider identity, and accepts a recorded correct one |
| G51 | INFRASTRUCTURE | PASS | REAL_RESUME_PATH_VERIFIED: a ledger restores in another process, a decided row is refused rather than rerun, and no duplicate outcome is possible |
| G52 | INFRASTRUCTURE | PASS | M216_FALSIFICATION_SUITE_PASSED: every real-substrate control is satisfied and the suite carries both expectations |
| G53 | INFRASTRUCTURE | PASS | no frozen task was touched by the real substrate and live model spend is $0 |
| G54 | INFRASTRUCTURE | PASS | SPEND_PROJECTION_RECONCILED: the mathematically possible cohort is reconciled with the frozen ceiling, retry exposure included |
| G55 | INFRASTRUCTURE | PASS | M216-owned harness, adapters and tests are typechecked |
| G56 | INFRASTRUCTURE | PASS | TEARDOWN_RESULT_VALIDITY_SEPARATED_FROM_CONTINUATION_SAFETY: a completed result keeps its status, bytes and digest across a teardown failure, a halt and a recovery |
| G57 | INFRASTRUCTURE | PASS | TEARDOWN_ISOLATION_INTERLOCK_IMPLEMENTED: every teardown is followed by an enumeration; residue of any class blocks, absence proves, a failed probe blocks |
| G58 | INFRASTRUCTURE | PASS | COHORT_HALT_ON_ISOLATION_RISK_VERIFIED: with isolation unproven no next row launches, no container starts, and no flag or direct selection can force one |
| G59 | INFRASTRUCTURE | PASS | ISOLATION_RECOVERY_PATH_VERIFIED: the predeclared path removes exactly the residue, re-proves by a second enumeration, resumes at the next unstarted row and reruns nothing |
| G60 | INFRASTRUCTURE | PASS | FROZEN_SPEND_ARITHMETIC_VERIFIED and ZERO_RETRY_HEADROOM_RECORDED: 200 x the frozen cap equals the frozen ceiling, and the launch-risk artifact records the $0 reserve |
| G61 | INFRASTRUCTURE | PASS | RETRY_SPEND_INTERLOCK_VERIFIED: before a paid retry the three numbers are computed, the frozen policy is applied, the declaration is recorded, and a spend halt fabricates nothing |
| G62 | INFRASTRUCTURE | PASS | OUTCOME_BLIND_OPERATIONS: halt, spend and isolation status expose no arm's performance |
| G63 | INFRASTRUCTURE | PASS | M217_FALSIFICATION_SUITE_PASSED and M217_SUITE_IS_FALSIFYING: both suites satisfied, both expectations present, and the two new guards demonstrably load-bearing |
| G64 | INFRASTRUCTURE | PASS | M217-owned harness and tests are typechecked |
| G65 | INFRASTRUCTURE | PASS | LAUNCHER_BINDING_RESOLUTION: the launcher resolves the DOCKER_SWEBENCH adapters through one factory that the real-substrate controls also ran a full row through |
| G66 | INFRASTRUCTURE | PASS | no frozen task was touched and live model spend is $0 during M217 |
| G67 | INFRASTRUCTURE | PASS | M215 and M216 controls preserved: the predecessor suites still pass in full |

Blockers: G36.
Deferred to launch: G14.

Technical set: G32, G33, G34, G35, G37, G38, G39, G43, G44, G45, G46, G47, G48, G49, G50, G51, G52, G53, G54, G55, G56, G57, G58, G59, G60, G61, G62, G63, G64, G65, G66, G67. G36 (spend authorisation) is deliberately outside it.

M217 gate evidence:

- **G56** PASS — controls pure [F87, F88, F95]; real [F108] all satisfied
- **G57** PASS — controls pure [F82, F83, F84, F97, F98, F99, F101, F102]; real [F106, F107, F107B, F112, F113, F114, F115, F117] all satisfied
- **G58** PASS — controls pure [F84, F85, F103]; real [F104, F109, F109B] all satisfied
- **G59** PASS — controls pure [F86, F96, F100]; real [F110, F111] all satisfied
- **G60** PASS — controls pure [F89] all satisfied
- **G61** PASS — controls pure [F90, F91, F91B, F92, F93] all satisfied
- **G62** PASS — controls pure [F94]; real [F116] all satisfied
- **G63** PASS — pure 23/23; real 15/15; guard-break M217_SUITE_IS_FALSIFYING (pure broken failing [F100, F84, F85, F86, F88, F91, F91B, F94, F96, F97], real broken failing [F107, F109, F109B, F110, F111, F112, F113], missed [], unexpected [])
- **G64** PASS — tsconfig.m217.json: 0 errors; M217_SCOPED_TYPECHECK_VERIFIED
- **G65** PASS — stage5.m217.launch-binding.v1; launcher calls startCohortBinding; real F106 satisfied
- **G66** PASS — real: frozen touched 0, provider calls 0, spend $0, containers 4; pure: provider calls 0
- **G67** PASS — M215 66/66; M216 real 73/73

## 24. Technical readiness

```text
TECHNICAL_EXECUTOR_READY
```

Derived, never assigned: the conjunction of the technical gates, each read out of an evidence
artifact by control id. Per §28 it now includes: continuation after each row requires isolation
proof; spend ceiling enforceable; retry exposure accounted; resume deterministic; the launcher
resolves its adapters; no known launch-critical implementation gap.

## 25. Financial status

```text
SPEND_AUTHORIZATION_PENDING
```

## 26. Launch-risk statement

```text
Ceiling awaiting authorisation:                $700
Maximum planned exposure for 200 ordinary rows: $700
Paid retry reserve:                             $0
```

> Any infrastructure failure that consumes paid budget before a retry may make completion of all 200 intended runs impossible under the frozen $700 ceiling. The executor will permit such a retry when it fits under the ceiling, will record FIXED_N_COMPLETION_NOT_GUARANTEED before it begins, and will halt with COHORT_HALTED_SPEND_CEILING when the ceiling binds; the rows that never ran stay PLANNED and the cohort is reported as incomplete.

See `stage5_m217_launch_risk.md`. Informational; no authorisation is requested here.

## 27. Repository state / SHAs

```text
starting SHA        26d0243ac75cd3702435683258c5d8eea88fff6b
commit 2            f9b00d34 Make the zero retry reserve act before it spends
commit 1            697a4c9e Separate whether a result is valid from whether the next row may begin
HEAD at generation  f9b00d3447ebb2dc8ac9ef8dd3a976456649d1a6
branch              main
ahead/behind        0	241
pushed              no
pre-existing dirt   preserved
```

## 28. Final principle

A valid result answers what happened on this task. A clean teardown answers whether the next
task can be trusted. M217 makes both executable and keeps them apart: no valid result is erased
because cleanup failed afterward, and no row launches merely because the previous result was
valid. Likewise a $700 authorisation contains no retry capacity when the planned maximum is $700,
and the executor now says so before it spends.

Do not launch. The only remaining pre-launch decision is human.

