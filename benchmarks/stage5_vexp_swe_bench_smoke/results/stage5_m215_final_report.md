# M215 — Launch executor, runtime-gate enforcement, and zero-spend readiness

## 1. Executive verdict

```
M215 — INCOMPLETE
LAUNCH_EXECUTOR_IMPLEMENTED
LAUNCH_EXECUTOR_FALSIFIED
RUNTIME_GATE_ENFORCEMENT_VERIFIED
PATCH_CAPTURE_REPAIR_PRESERVED
SOURCE_STATE_EQUIVALENCE_GUARD_IMPLEMENTED
PAIR_INDEPENDENCE_VERIFIED
RESULT_IMMUTABILITY_VERIFIED
RESUME_SEMANTICS_VERIFIED
MODEL_IDENTITY_RUNTIME_GATE_IMPLEMENTED
SPEND_GUARD_IMPLEMENTED
M215_FALSIFICATION_SUITE_PASSED
M215_SCOPED_TYPECHECK_VERIFIED
PREREGISTRATION_UNCHANGED
MANIFEST_UNCHANGED
EXTERNAL_REFERENCE_UNCHANGED
VTRACE_PRODUCT_UNCHANGED
PAID_RUNS_NOT_STARTED
LIVE_MODEL_SPEND_$0
SUBSTRATE_ADAPTER_BINDING_NOT_IMPLEMENTED
TECHNICAL_EXECUTOR_NOT_READY
SPEND_AUTHORIZATION_PENDING
```

The executor exists, runs any frozen manifest row through the frozen lifecycle
under 24 asserted gates, and is falsified by 66 controls that fail when its
guards are removed. What it cannot do is start a container, launch a real agent
process or invoke the real evaluator: those three are interfaces, and the only
binding implemented is the synthetic one.

That is a deliberate refusal, not an oversight. The alternative was to write a
Docker + Claude-Code-CLI + swebench binding that nothing in this milestone could
execute — no image pulled, no provider contacted, no evaluation run — and to
report the executor as ready on the strength of code that had never run once.
M213 refused that trade for its licence blocker and M214 refused it for its
missing executor; a $700 cohort is not where to start accepting it.

So the residual is one named gate with an address, G35, exactly as M214 made its
own residual G32 rather than a vagueness spread across the table. **INCOMPLETE,
not FAIL**: nothing below is broken. Everything M215 was scoped to enforce is
enforced and falsified.

`ENGINE QUALITY != CODING-AGENT UTILITY` and
`CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` both still govern. M215
measured no utility. It built the thing that would make measuring it trustworthy.

## 2. Starting state

```
branch                  main
HEAD at start           c4ba71f4d0408ba677448b5cdeeea3d041238712
                        "Freeze the two-arm experiment, and say plainly which
                         kind of not-ready it is"
predecessor (harness)    f37dc003bb0b323f34d351b5cea77c8a66f32450
predecessor (evidence)   c4ba71f4d0408ba677448b5cdeeea3d041238712
origin/main              0 behind, 231 ahead — never pushed
git diff --check         clean
git status --short       213 entries, all pre-existing and all preserved
```

The two expected M214 predecessor commits were recovered mechanically and match.
The pre-existing dirt — `stage5_outcome_ledger.json`, `stage5_outcome_ledger.md`
and the untracked historical benchmark result trees — was not touched, not
staged and not cleaned. No `git reset --hard`, no `git clean`, no worktree
removal, no push.

## 3. Frozen M214 authorities

All three recompute from the committed bytes:

| artifact | frozen digest | recomputed | verified |
| --- | --- | --- | --- |
| `stage5_m214_preregistration.json` | `3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4` | identical | yes |
| `stage5_m214_run_manifest.json` | `549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1` | identical | yes |
| `stage5_m214_external_reference.json` | `822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b` | identical | yes |

None was regenerated. None was edited.

### 3.1 A finding: M214's published hash rule is incomplete

M214's `hashRule` string says the digest is taken over the canonical document
"except `preregistrationHash`, `preregistrationHashRule` and `generatedAt`".
Its generator excludes **nine** fields, not three. The six extra —
`launchGates`, `launchAuthorized`, `preregistrationComplete`,
`deferredRuntimeGates`, `readinessVerdict`, `readinessBlocker` — are outputs
DERIVED from the document and written into the same file after hashing.

Recomputing with only the documented three yields
`eca0c012a96f7a64fc4d5e384c79b97af1f1b04fe2b7089821b00b8acde4631c`. An executor
that implemented the prose would fail closed on the unmodified committed
artifact and no run would ever start.

The frozen artifact is NOT edited to correct its own prose: that would change
the digest it froze, which is the one thing this whole chain exists to prevent.
The executor reproduces the generator's actual rule, the exclusion set is
declared as `M215_PREREGISTRATION_HASH_EXCLUDED_FIELDS` with the reason attached,
and the discrepancy is recorded in `stage5_m215_launch_gates.json` under
`documentedExclusionsAreIncomplete`.

## 4. Executor architecture

`m215LaunchExecutor.ts` — one authority, no versioned siblings.

```
frozen preregistration + frozen manifest row + runtime environment
        │
        ├─ P1..P9   prelaunch gates      (before any container exists)
        │
        ├─ CONTAINER_START
        ├─ SOURCE_CHECKOUT_AT_BASE_COMMIT
        ├─ SOURCE_STATE_DIGEST_BEFORE_TREATMENT
        ├─ TREATMENT_INITIALISATION
        ├─ SOURCE_STATE_DIGEST_AFTER_TREATMENT
        ├─ PRE_AGENT_UNTRACKED_SNAPSHOT      ← after initialisation, deliberately
        │
        ├─ R1..R11  preflight gates      (before any model token is spent)
        │
        ├─ AGENT_RUN                     → R12 provider model identity
        ├─ PATCH_CAPTURE                 → R13 derived exclusions
        ├─ EVALUATION                    → R14 lifecycle order, R15 evaluator
        │
        ├─ gate coverage: every REQUIRED gate PRESENT, not merely passing
        └─ immutable result record → digest → append-only ledger
```

There is no `launchBaseline` and no `launchVtrace`. An arm is a manifest row
field that selects an `armDefinition`, and both arms traverse the same
orchestration. The three arm-conditional points are all data-driven:
`definition.treatmentStatePaths.length > 0` decides whether a treatment is
initialised, `definition.mcpServers` decides what the agent process is given,
and `definition.modelVisibleToolNames` is what the surface is checked against.

The permanent architecture rule holds by construction: same executor, same
agent record, same native-tool authority, same budget object, same evaluator,
and VTRACE exposure as the only difference — because there is nowhere else for a
difference to live.

## 5. Cohort launcher

`runCohort` loads the frozen manifest, verifies experiment identity, asks
`selectNextRow` for the next permitted row, checks the spend ceiling, executes,
records, and advances. The operator never chooses a row: that is what removes
outcome-driven scheduling without requiring anyone to resist it.

`run_stage5_m215_launch.ts` is the entry point. `--plan` prints what the paid
cohort would be and runs nothing; a real launch needs `--authorize-spend` and an
authoritative binding, and today has neither.

## 6. Manifest-row enforcement

A selector may only ADDRESS a row (`--row <runId>`, or an instance/arm/ordinal
triple). Every outcome-affecting property comes from the manifest: task, repo,
base commit, arm, paired task, arm order, execution order, seed, agent version,
model, VTRACE identity, container image, budget identity, turns, cost cap.

`resolveManifestRow` refuses a selector matching zero rows (a task outside the
frozen 100) and refuses one matching several (an ambiguous address). Twenty-five
frozen property names are refused as runtime arguments by
`auditRuntimeOverrides`, and the launcher's parser rejects them by name before
anything else runs:

```
$ ... run_stage5_m215_launch.ts --plan --model claude-sonnet-5
error: --model would override the frozen property 'model'. Frozen values come
from the preregistration and the manifest; changing one is a new cohort with a
new hash, not a command-line argument.
```

Unknown flags are rejected rather than ignored. There is no `--force-any-task`.

## 7. Runtime gate architecture

M214's three classes are preserved and each gate record carries
`gateId`, `gateClass`, `required`, `status`, `evidence`, `failureReason` and
`assertedAt`. The launch decision is `requiredGatesPass`, derived mechanically.

**Prelaunch (9, all required)** — asserted before a container is created:

| id | asserts |
| --- | --- |
| P1 | the preregistration recomputes to its frozen digest |
| P2 | the 200-row manifest recomputes to its frozen digest |
| P3 | the external reference recomputes (identity only; influences nothing) |
| P4 | the row came from the frozen manifest rather than being constructed |
| P5 | no runtime override of a frozen property |
| P6 | the frozen execution order permits this row now |
| P7 | explicit spend authorisation exists for a COHORT run |
| P8 | one more run at its cap stays inside the authorised ceiling |
| P9 | the existing ledger's digests and chain still recompute |

**Runtime (15, all required)** — R1 arm admissibility, R2 agent identity,
R3 native-tool authority, R4 treatment catalogue, R5 arm isolation,
R6 source-state equivalence, R7 reset/warmth policy, R8 gold leakage,
R9 budget symmetry, R10 treatment identity, R11 secret hygiene,
R12 provider model identity, R13 patch capture, R14 lifecycle order,
R15 evaluator authority.

**Coverage.** `auditRuntimeGateCoverage` checks that every required gate is
PRESENT, not merely that every present gate passes — because §31's failure mode
is subtraction, and `requiredGatesPass` over a table missing a row is trivially
true. A run cannot become a valid outcome without full coverage.

## 8. Agent identity

Frozen from M214 and asserted per run: binary `/home/calvin/.local/bin/claude`,
version `2.1.260` (verified present on this machine), CLI-default system prompt,
and the vendor's `buildPrompt` text verbatim. `auditAgentIdentity` compares the
exact version string — `2.1.261` fails (F7). The result record carries
`systemPromptSha256`, `nativeToolCatalogSha256` and `userPromptTemplateSha256`,
so drift is detectable after the fact as well as before it.

**Limitation, stated rather than papered over.** The pin is the CLI's reported
version string. M194's own harness resolves the versioned binary under
`~/.local/share/claude/versions/` rather than the `claude` symlink, which is the
stronger immutable identity available here; wiring that is part of G35's
outstanding work, and until then the version string is what the gate compares.

## 9. Model identity enforcement

| | |
| --- | --- |
| registry target | `claude-opus-4-5-20251101` |
| M214's evidence | `PRESENT_IN_AGENT_MODEL_REGISTRY_NOT_PROVIDER_CONFIRMED` |
| runtime authority | the provider-returned identity in the run's own init event |
| on mismatch | throw, abort the run, classify `MODEL_IDENTITY_DRIFT` |
| on absence | the same — silence is not confirmation |

The assertion rides a hook, not a post-hoc read:
`AgentAdapter.run(spec, hooks)` receives `hooks.assertProviderModelIdentity`, and
the adapter calls it during initialisation before producing any telemetry.
Throwing from there aborts the run before it can accumulate anything that would
tempt someone to keep it. `auditProviderModelIdentity` rejects `null`, `""`, a
different model, and the CLI **alias** `claude-opus-4-5` — the alias is not the
identity.

No provider was contacted in M215 (§45). The gate is proven to execute and to
abort, against a fake provider that reports another model (F6), and against one
that reports nothing (F32). Actual provider confirmation remains
`FIRST_PAID_RUN_RUNTIME_GATE`, and the executor fails the run before counting it
if the assertion fails.

## 10. Native tool equality

One authority, `nativeToolCatalogSha256(M214_NATIVE_TOOLS)`, and both arms are
compared against it rather than against each other. The distinction matters:
two arms that drifted IDENTICALLY would pass a pairwise check and do fail this
one (asserted in `m215LaunchExecutor.test.ts`). Treatment tools are added
separately as `mcp__vtrace__*` names and never enter the native catalogue.
Removing `Grep` from one arm fails (F8).

## 11. Baseline contamination guard

R5 routes the baseline through M214's `auditBaselineIsolation`, which examines
MCP servers, the model-visible tool schema list, environment variable names,
workspace root entries, injected context documents, reachable daemon sockets,
treatment binaries on PATH, and the system-prompt appendix. Contamination is
observable, not asserted away from `arm === "baseline"`.

Three separate contamination routes are falsified: one VTRACE tool in the
surface (F12), a `VTRACE_`-prefixed environment variable (F12B), and a reachable
`vtrace.sock` with no tool configured at all (F12C).

## 12. VTRACE treatment identity

Pinned by **product tree**, not repository HEAD. Every `vtrace` manifest row
declares `vtraceProductTreeSha = b3b3e439f10c6c526cafc6001d25dd0e7552ce6d`, and
`HEAD:src` is that same tree after all of M215's commits — which is the point of
M214's choice: harness and evidence commits do not mutate the treatment.
`auditFrozenTreatmentTree` fails on any other tree (F10) and is silent on this
one (F10B). The treatment catalogue is checked in both directions: an
unexpected tool fails, a missing tool fails (F11).

## 13. Source-state authority

R6 calls M214's own `auditSourceStateEquivalence` on values the container
reports, per run:

- HEAD at agent start equals the frozen base commit (F13B),
- the tracked-source digest is unchanged across treatment initialisation —
  indexing is observational (F13),
- that digest equals the canonical state for the instance,
- no untracked source-affecting path exists at agent start.

Index metadata is not source: the treatment may create `.vtrace`, and does, and
the digest is over tracked source only.

## 14. Reset / warm-index lifecycle

The frozen policy is `COLD_UNIFORM` and R7 implements exactly it, rather than
letting `git clean` flags imply it. Two distinct failures are separated because
they have different fixes: state INHERITED from a previous run (F40B) and a
reset that PRESERVES treatment state (F40). `auditResetPreservedPaths` is the
generic form of the vendor's `resetRepo` defect, checked without naming a vendor.

## 15. Paired-run independence

Nothing is shared between a task's two arms: fresh container, fresh checkout,
fresh agent process. The result record carries no conversation, patch or
treatment-result seed, and M214's `auditRun` fails a run that declares one
(F17, F18, F18B). Under the frozen cold policy the permitted shared substrate is
empty, and R7 enforces that.

## 16. Execution-order enforcement

`auditRowPermitted` refuses two distinct violations, and they protect different
things. A pair's second arm before its first (F19) would give one arm a
systematic position advantage the 50/50 randomisation exists to remove. An
operator selecting a later row while an earlier one is unfinished (F36) is how
outcome-driven selection enters a cohort with no interim analysis.
`selectNextRow` offers the lowest-ordinal non-terminal row and nothing else
(F36B).

## 17. Patch capture

Derived, never a hardcoded vendor name. The pre-agent untracked snapshot is
taken AFTER treatment initialisation, `derivePatchCaptureExclusions` turns it
into a pathspec, and `auditCapturedPatch` fails any captured path the exclusions
cover.

Both routes, against REAL git on a scratch repository outside the frozen 100
(D4):

| scenario | route | derived exclusions | captured |
| --- | --- | --- | --- |
| D4a no source edit | `vtrace init` writes `.git/info/exclude` | `[]` | `[]`, 0 bytes |
| D4b no source edit | `vtrace index` only, no exclude entry | `[.vtrace]` | `[]`, 0 bytes |
| D4c one source edit | index only | `[.vtrace]` | exactly `pkg/core.py` |
| D4f legacy vendor rule | index only, no source edit | `[.vexp]` | 3 `.vtrace` files — **leaks** |

The invariants hold on both routes, and the pre-repair rule fails the control the
repaired one passes.

### 17.1 A finding: the snapshot's granularity is load-bearing

D4d and D4e differ in one thing — whether the pre-agent snapshot is taken with
`git ls-files --others --exclude-standard` or with `--directory` — and a
treatment file written DURING the agent run decides the difference:

| snapshot granularity | derived exclusions | `.vtrace/wal.sqlite` written during the run |
| --- | --- | --- |
| `--directory` | `.vtrace` | excluded |
| file-level | the three files that existed at snapshot time | **captured as agent output** |

The production authority `m193c_patch_snapshot.py` enumerates without
`--directory`. On this evidence a file created inside the treatment directory
after the snapshot would be attributed to the agent — the same leak M213 found,
arriving through the snapshot instead of through the pathspec. The executor's
`ContainerAdapter.untrackedPaths` contract therefore specifies DIRECTORY
granularity, and it is written into G35's outstanding work so the real binding
cannot quietly inherit the file-level command.

## 18. Budget enforcement

One frozen budget object with `budgetIdentity` `bf705ec05d41d8f9` carried on all
200 rows; `auditRowBudget` verifies every row against it. 250 turns, $3.50 per
run, 3600s wall clock. There is no per-arm budget field, so an arm-specific cap
cannot be expressed without changing the preregistration hash — and a manifest
mutated to give VTRACE 50 extra turns fails the launch of every row (F34), not
only that one.

VTRACE gets no extra turns for tool calls. Index build time and size are
recorded as local compute (`indexBuildSeconds`, `indexSizeBytes`) and never
summed into model cost, per M214's frozen cost semantics.

## 19. Spend guard

The ceiling binds on the PROJECTION, not the running total: `cumulative +
remainingRuns × $3.50 ≤ $700`. Checking only what has been spent would let the
cohort start a run that cannot finish inside the budget, which is how a hard
ceiling becomes an apology. Before every model call, `auditSpendCeiling` refuses
if one more run at its cap could cross the ceiling (F27), and the projection is
shown to exceed the running total (F27B).

Authorisation is a separate object from readiness. It must be affirmative, name
an operator, and name the frozen $700 — an authorisation for a different ceiling
is refused (F28B). A COHORT launch without one is refused before a container
starts (F28, F28C).

## 20. Resume semantics

Statuses: `PLANNED`, `STARTED`, `VALID_RESOLVED`, `VALID_UNRESOLVED`,
`INFRASTRUCTURE_INVALID`; retryability is derived rather than stored.
`COMPLETED` is deliberately absent — it is a state in which a reader cannot tell
whether the run counts.

Measured (F35, and again in the dry run): six rows, persist, restore, continue
for four more. Ordinals completed `0..9`, duplicate attempts 0, restore issues
0, integrity issues 0. A valid outcome is never rerun; a prior valid result is
never overwritten. The launcher additionally refuses to resume a cohort produced
by a different executor version (§40).

## 21. Exactly-once result semantics

At most one VALID terminal outcome per `(instanceId, arm)`. A second is a
`CohortIntegrityError`, not a newer result — "latest run wins" is precisely how
an unfavourable outcome gets rerun. F20 attempts it and is refused; F20B
confirms the original is still the only entry. An attempt id cannot be recorded
twice. An invalid attempt does not block a later valid one, and both stay in the
ledger.

## 22. Raw result authority

`RunResultRecord` carries experiment identity, all three frozen hashes, manifest
row id and ordinal, run/attempt ids, instance, repo, arm, paired task, arm order,
agent identity (three digests), model target, provider-returned identity, VTRACE
identity, source state (four digests plus untracked paths), container identity,
budgets, timing, termination reason, tokens, cost, turn count, treatment
telemetry, ordered telemetry, patch digest/bytes/paths/exclusions, observed
lifecycle phases, evaluation, redacted environment, the gate table, and the
validity classification.

No interpretation. `validity` says what happened and why; it does not say what it
means.

## 23. Result hashes and integrity

Per-record domain-separated sha256 over the canonicalised record, plus a chain:
`chainDigest(previous, digest)`, genesis `0×64`. `verifyIntegrity` recomputes
every digest and every link. A finalised record is never edited; a metadata
repair appends a `CorrectionRecord` naming the field and retaining the superseded
digest, leaving the original bytes recoverable and still hashed (F30B).
Mutating one field changes the digest and fails replay (F30).

## 24. Evaluator authority

R15. `resolved` comes from the evaluator, never from the agent's own claim. The
record keeps the command, the evaluator identity (`swebench==4.1.0`), the exit
status, a digest of the raw result, and `evaluatorRan`.

An evaluation that did not run is `EVALUATOR_INFRA_FAILURE`, never an implied
unresolved task (F33). Collapsing the two would score infrastructure failures as
agent failures — on whichever arm happened to break.

## 25. Gold-leakage protection

R8 fails preflight, before the model is called, if any gold patch, reference
solution, evaluation-only file or post-hoc label is reachable from the agent's
context (F26). The check is on the observed surface, not on an assumption about
how the container was built.

## 26. Ordered telemetry

`TelemetryEvent[]` with an explicit ordinal: `AGENT_INIT`, `MODEL_IDENTITY`,
`NATIVE_TOOL_CALL`, `TREATMENT_TOOL_CALL`, `SHELL_COMMAND`, `FILE_READ`, `EDIT`,
`TEST_RUN`, `TERMINATION`, each with turn, name, detail, output bytes and
latency. Ordered rather than aggregated, because M189 and M194 both needed to
reconstruct WHEN a thing happened and aggregate counts could not answer it —
`invokedBeforeFirstEdit` is computed from ordinals, and no count could give it.

## 27. ITT and treatment-use behaviour

Recorded: exposed, initialised, catalogue digest, first invocation turn, tool
names, invocation count, output bytes, latency, index build seconds, index size,
and whether the treatment was invoked before the first edit.

Invocation is not required for validity. A treatment-exposed run the agent never
called is a VALID intention-to-treat outcome (F24, and D3's three cases all
valid). Excluding it would change the estimand from "does offering the treatment
help" to "does it help when the agent likes it" — a different question, and an
unblinded one.

## 28. Retry classification

Read from M214's frozen `retryPolicy` rather than restated, so a category
invented later cannot become retryable without changing the preregistration hash.
Rerunnable: `MODEL_SERVICE_FAILURE`, `CONTAINER_CANNOT_START`,
`EVALUATOR_INFRA_FAILURE`, `TELEMETRY_CORRUPT`. Max 2 attempts, both retained.

Measured (D2): `EVALUATOR_INFRA_FAILURE` → retry permitted, original retained,
attempt numbering advances (F21). `MODEL_IDENTITY_DRIFT` → not retryable.
`TREATMENT_INITIALISATION_FAILURE` → not retryable. A valid unresolved run is
refused by both the policy and the executor (F22). An invented category cannot
classify a run at all (F22B).

## 29. Outcome-blind operational monitoring

`renderProgress` returns planned/terminal/valid counts, infrastructure-invalid
count, current run, cumulative spend, projected maximum, ceiling, ledger chain
head and runtime errors. It has no per-arm field, no pass rate and no test
statistic, and F38C asserts that none of its keys are outcome-shaped. An operator
watching a running cohort has no legitimate use for the comparison and a strong
temptation to intervene on it, so the dashboard cannot compute one.

`canFinalizeCausalReport` refuses a partial cohort (F23) and refuses a SYNTHETIC
ledger unconditionally (F23B). At 100/200 rows it says so and reports the reason.

## 30. Dry-run evidence

No frozen task was executed with a live model. No provider was contacted. No
Docker container was started.

- **D1** — full executor path, both arms. 24 gates each, all PASS, coverage
  clean, the observed lifecycle equal to the frozen order, `.vtrace` excluded on
  the treatment arm and no exclusions on the baseline, ledger integrity clean,
  finalisation correctly refused.
- **D2** — three infrastructure failures, all classified into the frozen
  category, with the retry decision each one earns.
- **D3** — treatment invoked before the first edit, after it, and never; all
  three valid under ITT, with the telemetry distinguishing them.
- **D4** — real git, scratch repository outside the frozen 100, six scenarios,
  all six invariants hold (§17).
- **Resume** — 6 rows, persist, restore, 4 more; 0 duplicates, ordinals `0..9`.

## 31. Historical defect controls

§54's requirement is that the OLD behaviour fails a control the M215 path
passes, so the executor cannot bypass M214's repair with every other control
green.

| control | reproduces | old behaviour | M215 path |
| --- | --- | --- | --- |
| H1 | M213's `.vtrace` patch leak | hardcoded vendor pathspec captures 3 treatment files as agent output; the run is rejected `PATCH_EXTRACTION_FAILURE` | empty patch on both routes (F14, F15) |
| H2 | the vendor's `resetRepo` asymmetry | a reset preserving the vendor's own state directory fails the cold policy | nothing preserved, both arms |
| H3 | snapshot-before-initialisation | `auditLifecycleOrder` names the reordering | the executor's own observed phases pass (H3B) |

D4f reproduces H1 against real git as well as against the simulation.

## 32. Falsification F1–F40+

**66 controls, 66 satisfied. 44 GUARD_FIRES, 22 GUARD_SILENT.**

| id | control | expectation | fired |
| --- | --- | --- | --- |
| F0_CLEAN_BASELINE | compliant baseline run | SILENT | no |
| F0_CLEAN_VTRACE | compliant vtrace run | SILENT | no |
| F0_CLEAN_AUDIT_RUN | M214's auditor on the executor's observed config | SILENT | no |
| F1 | preregistration mutation | FIRES | yes |
| F2 | manifest mutation (one row) | FIRES | yes |
| F3 | external-reference mutation | FIRES | yes |
| F4 | arm = VEXP | FIRES | yes |
| F5 | task outside the manifest | FIRES | yes |
| F6 | provider reports another model | FIRES | yes |
| F6B | classified `MODEL_IDENTITY_DRIFT`, not unresolved | SILENT | no |
| F7 | agent version mismatch | FIRES | yes |
| F8 | native-tool drift | FIRES | yes |
| F9 | prompt drift | FIRES | yes |
| F10 | VTRACE product-tree drift | FIRES | yes |
| F10B | the frozen tree is the observed tree | SILENT | no |
| F11 | missing treatment tool | FIRES | yes |
| F12 | baseline contamination (one tool) | FIRES | yes |
| F12B | baseline contamination (env var) | FIRES | yes |
| F12C | baseline contamination (daemon socket) | FIRES | yes |
| F13 | treatment mutated tracked source | FIRES | yes |
| F13B | HEAD is not the base commit | FIRES | yes |
| F14 | `.vtrace` leak, init route, no source edit | SILENT | no |
| F15 | `.vtrace` leak, index-only route, no source edit | SILENT | no |
| F16 | one real source edit captured exactly | SILENT | no |
| F17 | conversation reuse | FIRES | yes |
| F18 | patch reuse | FIRES | yes |
| F18B | treatment-result reuse | FIRES | yes |
| F19 | execution-order violation | FIRES | yes |
| F20 | duplicate valid outcome | FIRES | yes |
| F20B | the original outcome is retained | SILENT | no |
| F21 | permitted infrastructure retry | SILENT | no |
| F22 | retry of a valid outcome refused | FIRES | yes |
| F22B | invented exclusion category | FIRES | yes |
| F23 | final analysis at 50% | FIRES | yes |
| F23B | synthetic ledger never final | FIRES | yes |
| F24 | treatment exposed, never used → valid ITT | SILENT | no |
| F25 | treatment initialisation failure classified | SILENT | no |
| F26 | gold leakage | FIRES | yes |
| F27 | spend ceiling | FIRES | yes |
| F27B | projection binds, not the running total | SILENT | no |
| F28 | no spend authorisation | FIRES | yes |
| F28B | authorisation for a different ceiling | FIRES | yes |
| F28C | unauthorised COHORT launch starts no container | FIRES | yes |
| F29 | synthetic mode isolation | FIRES | yes |
| F30 | result mutation | FIRES | yes |
| F30B | correction is append-only | SILENT | no |
| F31 | runtime gate omission | FIRES | yes |
| F31B | a compliant run carries every required gate | SILENT | no |
| F32 | provider identity absent | FIRES | yes |
| F33 | evaluation failure is not unresolved | SILENT | no |
| F34 | arm budget asymmetry | FIRES | yes |
| F35 | resume | SILENT | no |
| F36 | operator row selection | FIRES | yes |
| F36B | the scheduler picks the frozen next row | SILENT | no |
| F37 | secret leakage | SILENT | no |
| F37B | the secret scanner detects a real leak | FIRES | yes |
| F38 | result arm mismatch | FIRES | yes |
| F38C | outcome-blind dashboard | SILENT | no |
| F39 | external VEXP in a paired analysis | FIRES | yes |
| F39B | the two arms remain a legitimate pair | SILENT | no |
| F40 | reset preserves treatment state | FIRES | yes |
| F40B | warm state inherited | FIRES | yes |
| H1 | legacy patch capture leaks | FIRES | yes |
| H2 | legacy reset asymmetry | FIRES | yes |
| H3 | snapshot before initialisation | FIRES | yes |
| H3B | the executor uses the repaired order | SILENT | no |

### 32.1 The suite is falsifying, and it was checked

Two guards were deliberately broken —
`auditProviderModelIdentity` forced to return no issues, and
`auditRowPermitted`'s earlier-unfinished check removed — and the suite dropped to
**61/66**, failing exactly F6, F6B, F32, F19 and F36. The guards were restored
and the suite returned to 66/66. A suite that only ever passes is
indistinguishable from one that cannot fail; this one can.

### 32.2 Two defects the suite found in M215's own code

**The lifecycle gate was asserted mid-lifecycle.** R14 originally ran before
`EVALUATION` was pushed onto the phase list, so `auditLifecycleOrder` reported
the phase it had not reached yet as missing and every compliant run was
classified `TELEMETRY_CORRUPT`. Because that category is on M214's rerunnable
list, the cohort then offered row 0 again — which is how one badly ordered
assertion becomes a scheduler that never advances. Nine controls failed together
and named it. Fixed by asserting the gate after the last phase.

**Five controls were vacuous.** F6, F20, F22, F28C and F32 reported "the
executor ACCEPTED this" as an issue, which made them satisfied whether the guard
fired or not. Any `GUARD_FIRES` control built that way cannot fail. They now
report issues only on an actual refusal, and `attemptIssues` documents why it
returns empty when a run is accepted.

## 33. M215 scoped typecheck

```
tsconfig.m215.json      extends M214's scope to m215*.ts (incl. *.test.ts)
                        and run_stage5_m215_*.ts, keeping M214's files inside
                        it because the executor imports them

clean as committed      0 errors
injected probe          1 error, naming m215InjectedTypeErrorProbe.ts
after removal           0 errors
probe file removed      true
M214's own scope        0 errors, still

M215_NEW_TYPECHECK_ERRORS               0
PREEXISTING_BENCHMARK_TEST_TYPE_ERRORS  ~59, measured by M214, NOT fixed
                                        and NOT claimed to be fixed
```

Repository-wide benchmark tests remain untypechecked. That cleanup is outside
M215's authorised scope and no historical error was touched.

## 34. Standard verification

```
bun test                    6514 pass, 49 skip, 0 fail (394 files)
bun run typecheck           clean
bun run typecheck:benchmarks clean
bun run lint                clean (both typechecks)
git diff --check            clean
tsc -p tsconfig.m214.json   0 errors
tsc -p tsconfig.m215.json   0 errors
M215 falsification suite    66/66
M215 dry-run suite          D1–D4 + resume, all invariants hold
57 new tests across m215CohortLedger.test.ts, m215LaunchExecutor.test.ts and
m215Falsification.test.ts
```

## 35. Zero-spend evidence

```
frozen benchmark-task live-agent runs   0
live model spend                        $0.00
provider calls of any kind              0
Docker containers started               0
VEXP processes started                  0
src/ files changed                      0
```

Deterministic work only: six throwaway git repositories under `mktemp -d`
(created and removed by D4), and eight `tsc` invocations. No accidental provider
call was made; had one been, it would be reported here.

## 36. Launch gates

| gate | class | status | requirement |
| --- | --- | --- | --- |
| G1–G13 | PREREG | PASS | M214's design gates, re-derived unchanged |
| G14 | RUNTIME | DEFERRED_TO_LAUNCH | source states equivalent before each arm starts — the guard now exists (R6) and names itself; per-run assertion needs runs |
| G15–G31 | PREREG | PASS | M214's design gates, re-derived unchanged |
| **G32** | INFRA | **FAIL** | a launch executor exists that can run the frozen manifest — now derived as G33 ∧ G35 rather than judged |
| G33 | INFRA | PASS | `LAUNCH_EXECUTOR_IMPLEMENTED` |
| G34 | INFRA | PASS | `LAUNCH_EXECUTOR_FALSIFIED` — 66/66 |
| **G35** | INFRA | **FAIL** | an adapter binding that can produce authoritative outcomes on the real substrate |
| **G36** | INFRA | **FAIL** | explicit operator authorisation of the frozen $700 ceiling |
| G37 | INFRA | PASS | patch capture unambiguous on both routes, against real git |
| G38 | INFRA | PASS | the cohort survives interruption with no duplicate and no reordering |
| G39 | INFRA | PASS | M215-owned harness and tests are typechecked |
| G40 | PREREG | PASS | the frozen VTRACE treatment tree is unchanged |
| G41 | PREREG | PASS | M214's frozen authorities are unmodified |
| G42 | INFRA | PASS | 0 frozen-population runs, $0 live model spend |

Every one is derived from an artifact, none is markable by hand. G32 is computed
as the conjunction of "the orchestration exists" and "a substrate binding
exists", so it stays FAIL for a stated reason rather than a judgement, and M215
does not award itself the gate it was scoped to close.

M214's own table was re-derived from its committed document and is **unchanged
apart from G32** — M215 did not relax a preregistration gate on its way to
reporting readiness. `preregistrationComplete` remains true.

## 37. Spend authorization status

```
TECHNICAL_EXECUTOR_NOT_READY     (G32, G35 — the substrate binding)
SPEND_AUTHORIZATION_PENDING      (G36 — no authorisation was requested or given)
```

These are separate facts and neither implies the other. No money was authorised
by anyone, none was asked for, and none was spent. Building the executor is not
authorisation, and the launcher enforces that: a COHORT run without
`--authorize-spend "<operator>"` is refused before a container starts.

## 38. Repository state

```
starting SHA         c4ba71f4d0408ba677448b5cdeeea3d041238712
commit 1 (executor)  2ba7672c
commit 2 (falsify)   7b4d21ba
commit 3 (evidence)  this commit
branch               main (no feature branch)
ahead / behind       234 ahead, 0 behind origin/main
pushed               no
pre-existing dirt    preserved: stage5_outcome_ledger.{json,md} and the untracked
                     historical result trees are exactly as they were
src/ diff            none
```

## 39. Final authorization statement

```
TECHNICAL_EXECUTOR_NOT_READY
```

The executor's orchestration, enforcement, ledger, resume and spend guard are
implemented and falsified. It cannot yet run a paid row because no adapter
binding to real containers, a real agent process and the real evaluator exists;
that is G35, it is named, and its outstanding work is enumerated in
`m215AdapterBindings.ts` rather than left to be rediscovered.

```
SPEND_AUTHORIZATION_PENDING
```

Separately and independently: no operator has authorised the frozen $700
ceiling, M215 did not ask for one, and $0 was spent.

**Next step, in order.** (1) Implement the `DOCKER_SWEBENCH` binding over M193's
container authority, the pinned Claude Code CLI and swebench 4.1.0, and prove it
with a zero-cost Docker smoke on a task OUTSIDE the frozen 100 — that closes G35
and, with G33, closes G32. Take the snapshot at DIRECTORY granularity (§17.1).
(2) Obtain explicit authorisation for the $700 ceiling — that closes G36.
Neither touches the product, and neither may change anything frozen: the
preregistration hash is the check on that.
