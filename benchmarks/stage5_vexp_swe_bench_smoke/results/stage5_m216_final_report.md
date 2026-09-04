# M216 — real Stage-5 substrate binding, end-to-end executor validation,
# and zero-spend launch readiness

## 1. Executive verdict

```text
M216 — PASS

M216_SUBSTRATE_REDUCTION_COMPLETE
REAL_CONTAINER_ADAPTER_BOUND
REAL_AGENT_ADAPTER_BOUND
REAL_EVALUATOR_ADAPTER_BOUND
REAL_SOURCE_STATE_AUTHORITY_VERIFIED
REAL_PATCH_CAPTURE_VERIFIED
REAL_PAIR_ISOLATION_VERIFIED
REAL_EVALUATOR_PATH_VERIFIED
MODEL_IDENTITY_RUNTIME_GATE_BOUND
REAL_RESUME_PATH_VERIFIED
M216_FALSIFICATION_SUITE_PASSED

TECHNICAL_EXECUTOR_READY

SPEND_AUTHORIZATION_PENDING
PAID_RUNS_NOT_STARTED
LIVE_MODEL_SPEND_$0
```

M215 built the executor and refused to ship a binding nobody had run. M216 built that
binding over the Stage-5 machinery that already existed, and ran it: 10 real SWE-bench containers,
the real Claude Code launch path, the official swebench evaluator, and the whole of M215's
executeManifestRow end to end on 4 rows — with no frozen task touched, no provider
contacted and no money spent.

The binding's status is not a literal anyone typed. `DOCKER_SWEBENCH` resolves to
IMPLEMENTED only while the three adapter constructors exist AND an evidence document shows
the controls passing, containers actually started, no frozen task touched and $0 spent.
Delete the evidence and the gate table goes back to TECHNICAL_EXECUTOR_NOT_READY.

## 2. Starting repository state

```text
branch            main
HEAD at start     71f79238f55d3c63a3998505f2f005220b7dcf01 (M215)
HEAD when generated  46c397a7fcfae4d1691c73d75aefd894fa4f5afa
ahead/behind      0	237 (left origin/main, right HEAD)
pushed            no

M216 commits so far:
  46c397a7 Let the real substrate find eight defects, and prove the suite can still fail
  29f8712d Bind the executor to the real containers, the real agent and the real evaluator
  d9822a63 Ask what the real substrate already does, before writing anything that does it again
```

This report is generated from the evidence artifacts, so it names the HEAD it was generated
at; the commit carrying the report itself follows it.

The M215 predecessor commits `2ba7672c`, `7b4d21ba` and `71f79238` are present and unmodified.
Pre-existing dirt — `stage5_outcome_ledger.{json,md}` and the historical untracked benchmark
results — was preserved; nothing was reset, cleaned or unstaged.

## 3. Frozen experiment identities

```text
preregistration      3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4  VERIFIED
manifest             549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1  VERIFIED
externalReference    822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b  VERIFIED
```

All three recompute from the committed bytes. Nothing frozen was regenerated, and the
`m214TableUnchangedApartFromG32` re-derivation is true.

## 4. M215's blocker, reproduced

M215 closed with G32, G35 and G36 failing. G35 was the substrate binding, and it was
`DECLARED_UNIMPLEMENTED` as a string literal in `m215AdapterBindings.ts`, with its outstanding
work enumerated. The adapters genuinely did not exist: `ContainerAdapter`, `AgentAdapter` and
`EvaluatorAdapter` had exactly one implementation between them and it was the synthetic one in
`m215Fixtures.ts`. `authoritativeBindingAvailable()` returned false, `assertBindingUsable`
threw, and G32 — the conjunction of "the orchestration exists" and "a substrate binding
exists" — was false by construction.

That is still checkable rather than historical. `dockerSwebenchBindingEvidence` is injectable:
hand it a missing adapter, or point it at a directory with no evidence, and it reports
`exercised: false` with the reason. Controls F41, F42 and F43 do exactly that.

## 5. The existing Stage-5 substrate

M193 and M194 already contained working real-substrate logic, in Python, against the Docker
SDK and the swebench package:

```text
m193_container_adapter.py     image lookup, one docker-cp extraction of /testbed, one
                              bind-mounted container over that tree, safe.directory, the
                              base-commit ancestry check M192's V2 correction added, the
                              pre-existing untracked record, and one execution seam whose
                              workdir is always pinned
m193b_changed_source.py       the changed-source enumeration, --no-renames so a move keeps
                              both halves
m193c_patch_snapshot.py       the read-only patch authority: diff HEAD vs the working tree
                              plus a --no-index untracked lane, no index write
m193a_source_version_probe.py the wrong-source and bytecode-staleness instruments
run_stage5_m194_acquire.py    the agent launch (bwrap namespace, Popen, stream sink, timeout
                              kill), the frozen termination categories, and the official
                              evaluator over swebench.harness.run_evaluation
m193aArmEnvironment.ts        the arm's private configuration directory and environment
                              allowlist, including the finding that an empty --mcp-config does
                              not by itself remove the account's own connectors
```

Rewriting any of that in TypeScript would have produced a second implementation of code that
M192's workdir finding, M193's ancestry correction and bytecode-staleness hazard, M193B's
rename loss, M193C's index-destroying snapshot and M194's termination categories were all
written against. Every one of those defects would be re-openable in the copy.

## 6. Substrate reduction table

**M216_SUBSTRATE_REDUCTION_COMPLETE** — 5 DIRECT_REUSE, 5 THIN_ADAPTER, 2 MISSING_PRIMITIVE, 0 unclassified.

| obligation | M215 interface | existing authority | strategy |
| --- | --- | --- | --- |
| container setup | `ContainerAdapter.start` | m193_container_adapter.M193Container.setup() | DIRECT_REUSE |
| repository reset | `ContainerAdapter.resetToBaseCommit` | M193Container.exec_raw + git checkout -f / git clean -xdff | THIN_ADAPTER |
| source snapshot / source identity | `ContainerAdapter.trackedSourceDigest, untrackedPaths, untrackedSourceAffectingPaths` | m193b_changed_source.py enumeration semantics; M193C's status regions | THIN_ADAPTER |
| pre-agent untracked snapshot granularity | `ContainerAdapter.untrackedPaths` | git ls-files --others --exclude-standard --directory | THIN_ADAPTER |
| agent launch | `AgentAdapter.run` | run_stage5_m194_acquire.launch_agent + m193aArmEnvironment.constructArmEnvironment | THIN_ADAPTER |
| ordered telemetry | `AgentRunOutcome.telemetry` | M194's stream-json result/tool_use extraction and termination categories | THIN_ADAPTER |
| patch capture | `ContainerAdapter.capturePatch` | m193c_patch_snapshot.patch_snapshot_command + parse_patch_snapshot_output | DIRECT_REUSE |
| evaluation | `EvaluatorAdapter.evaluate` | run_stage5_m194_acquire.evaluate_arm over swebench.harness.run_evaluation | DIRECT_REUSE |
| teardown | `ContainerAdapter.stop` | M193Container.teardown() | DIRECT_REUSE |
| wrong-source detection | `preflightGates R6_SOURCE_STATE_EQUIVALENCE` | run_stage5_m192_wrong_source_control.py; m193a_source_version_probe.py | DIRECT_REUSE |
| treatment initialisation and catalogue | `ContainerAdapter.initialiseTreatment, inspectArmSurface` | none — the VTRACE arm has never been executed | MISSING_PRIMITIVE |
| provider-model identity assertion during initialisation | `AgentRunHooks.assertProviderModelIdentity` | none — M194 read the init event after the fact | MISSING_PRIMITIVE |

The two MISSING_PRIMITIVE rows are honest rather than embarrassing. M193/M194 acquired ONE
untreated arm, so there was no prior authority for building the treatment index before the
agent starts, and M194 read the init event after the process exited — which puts the
model-identity check after the money. Both are implemented here.

## 7. Adapter architecture

```text
  m215LaunchExecutor.executeManifestRow      <- unchanged, still the only executor
        |                                       manifest, gates, arm identity, ordering,
        |                                       spend, result authority, retry, exactly-once
        v
  m216ProductionAdapters.ts                  <- argv, environment, arm MCP config, model
        |  ContainerAdapter/AgentAdapter/       target, budgets, stream parser, termination
        |  EvaluatorAdapter                     classification
        v   {"op": ..., "params": ...}
  m216_substrate_bridge.py                   <- Docker, swebench, process spawn, bwrap
        |                                       NOTHING that decides what runs next
        v
  m193_container_adapter / m193c_patch_snapshot / run_stage5_m194_acquire.sandbox_prefix
```

The split is deliberate and one-directional. Anything needing Docker, swebench or a
long-lived process lives in Python where the audited code already is; anything that decides
what the experiment IS lives in TypeScript beside the executor that enforces it, because a
value the substrate could choose is a value that can differ between arms. The bridge has no
operation that names a task, an arm, a retry or a validity.

## 8. Real container binding

```text
bridge            stage5.m216.substrate-bridge.v1
python            3.12.12
docker SDK        7.1.0   server 29.6.2
swebench          4.1.0
container         m193_container_adapter.M193Container
containers        10 started, 10 torn down
frozen touched    0
non-frozen        pylint-dev__pylint-6903, pylint-dev__pylint-7080
```

The research instances are drawn from SWE-bench Verified's complement — the 400 tasks M214 did
NOT freeze — so they are real instances with real images and a real evaluator verdict:

```text
pylint-dev__pylint-7080    pylint-dev/pylint  3c5eca2ded3dd2b59ebaf23eb289453b5d2930f0
pylint-dev__pylint-6903    pylint-dev/pylint  ca80f03a43bc39e4cc2c67dc99817b3c9f13b8a6
```

`NOT_IN_M214_FROZEN_POPULATION` is asserted from the committed manifest before a container is
started, and again inside the bridge on every real operation (§35).

The first choice was psf/requests, on the reasoning that M192 found it is the repository whose
installed copy an unpinned workdir silently resolves. Its container controls passed and then
the official evaluator sat at 0% CPU for fifteen minutes: `test_requests.py` makes live HTTP
calls, so the evaluation blocks on the network until swebench's own timeout kills it. A
research instance whose evaluation cannot finish cannot demonstrate that the evaluator works,
so the fixture was changed. That is a property of the fixture, not of the binding.

## 9. Real source reset

§13 asks for source state to be ESTABLISHED rather than inherited. M193's `setup()` checks out
the base commit once, at creation; the reset is its own operation and runs per row:

```text
git checkout -f <base commit>      restore the benchmark base state
git clean -xdff                    remove untracked and ignored paths, so a previous step's
                                   residue cannot become this run's starting state
git rev-parse HEAD                 verify the base commit
git status --porcelain             enumerate tracked changes and untracked source
git ls-files | git hash-object     compute source identity over WORKING-TREE bytes
```

The digest is over `hash-object` of the working tree, not `ls-files -s`: index blobs do not
change when a file is edited, so a digest built from them would be a constant dressed as a
measurement. F70 shows it stable across repeated reads and F71 shows it moving when a tracked
file (`doc/conf.py`) changes.

Pair-level equality is the claim that matters, and it is not a tautology about one run's own
digest: the container adapter records the canonical digest for a task when the FIRST arm runs
and the second arm is compared against it. F50 passes in both orders.

## 10. The `--directory` finding

M215 measured that the granularity of one enumeration decides whether treatment metadata
written DURING the agent run is attributed to the agent. M216 reproduces it on real Git:

```text
P1                     INIT/DIRECTORY   exclusions []
                                        captured   []
P2                     INDEX/DIRECTORY  exclusions [".vtrace"]
                                        captured   []
P3                     INDEX/DIRECTORY  exclusions [".vtrace"]
                                        captured   []
P3_FILE_GRANULARITY    INDEX/FILE       exclusions [".vtrace/config.json",".vtrace/index.sqlite"]
                                        captured   [".vtrace/session.sqlite"]
P4                     INDEX/DIRECTORY  exclusions [".vtrace"]
                                        captured   ["source.py"]
P5                     INDEX/DIRECTORY  exclusions [".vtrace"]
                                        captured   ["new_module.py"]
P6_UNKNOWN_VENDOR      INDEX/DIRECTORY  exclusions [".vtrace"]
                                        captured   [".someothertool/state"]
```

`m193c_patch_snapshot.py` enumerates WITHOUT `--directory`, and it is right to: that is the
CAPTURE lane, which has to reach each untracked file individually to diff it. The SNAPSHOT is
a different question asked of the same command. M216 adds a separate benchmark-owned snapshot
at DIRECTORY granularity (`untracked_snapshot_command`) and does NOT modify M193C, whose
behaviour five milestones of controls were written against.

On the real substrate the pre-agent snapshot reads `[".vtrace"]` — the directory, not the files inside
it (F75) — and a treatment file written after the snapshot stays out of the captured patch
(F47R) while the same real state IS captured when the derived exclusions are dropped (F47RB),
so the exclusion is demonstrably doing the work rather than git.

## 11. Patch capture

Both VTRACE setup routes and a real source edit, on real Git and on the real substrate:

| control | claim | result |
| --- | --- | --- |
| F41P1 | no source change, `vtrace init` route → empty patch | empty |
| F41P2 | no source change, `vtrace index` route → empty patch | empty |
| F47 | treatment file created during the run → not agent output | excluded |
| F41P4 | one tracked source edit → exactly that file | exact |
| F41P5 | one untracked source file the agent created → captured | captured |
| F41P6 | an unknown vendor's directory appearing after the snapshot → captured | captured |
| F72 | real container, real edit → exactly the edited file | exact |

P5 deserves a sentence, because it is the one whose answer had to be recovered rather than
assumed. M214's rule is "what changed, minus what already existed before the agent ran", so a
NEW source file is agent output and IS captured; only pre-existing untracked state is excluded.

§16's requirement is met by construction: F41P6 creates `.someothertool/` — a directory no
part of this harness has heard of — after the snapshot, and it is captured. Correctness rests
on the before/after derivation, not on a list of brand names. No vendor path is named in the
capture rule at all.

The end-to-end rows captured real patches through the whole executor:

```text
BASELINE_FIRST  baseline  pylint-dev__pylint-7080  patch ["pylint/__init__.py"]
BASELINE_FIRST  vtrace    pylint-dev__pylint-7080  patch ["pylint/__init__.py"]
VTRACE_FIRST    vtrace    pylint-dev__pylint-6903  patch ["pylint/__init__.py"]
VTRACE_FIRST    baseline  pylint-dev__pylint-6903  patch ["pylint/__init__.py"]
```

## 12. The M214 hash-rule mismatch

M214's published `hashRule` names three excluded fields — `preregistrationHash`,
`preregistrationHashRule`, `generatedAt`. Its generator excludes nine: the six extra are
outputs DERIVED from the document and written into it after hashing (`launchGates`,
`launchAuthorized`, `preregistrationComplete`, `deferredRuntimeGates`, `readinessVerdict`,
`readinessBlocker`).

The frozen artifact is still not edited to correct its own prose, because that would change
the digest it froze. M216 makes the discrepancy EXECUTABLE instead:

```text
F64  the 3-field prose rule does not reproduce the frozen digest   confirmed
F65  the 9-field generator rule reproduces it from the committed   confirmed
     bytes, unmodified
```

`FROZEN_HASH_RULE_PROSE_MISMATCH_PRESERVED_AND_EXECUTABLE`. There is no third interpretation:
the executor reproduces the generator's rule and nothing else.

## 13. Real agent-process binding

```text
agent executable  /home/calvin/.local/bin/claude (M214's declared path)
launched          /home/calvin/.local/share/claude/versions/<version> (the pinned binary)
agent version     2.1.260
model target      claude-opus-4-5-20251101
system prompt     CLI default; no --append-system-prompt and no --system-prompt in either arm
native tools      Edit,Write,Bash,Read,Glob,Grep,TodoWrite
MCP config        baseline {"mcpServers":{}}; vtrace one server, --strict-mcp-config both
turn limit        250
cost limit        $3.5 via --max-budget-usd
working directory /testbed, on both sides of the container boundary
environment       M193A's allowlist; a private CLAUDE_CONFIG_DIR per arm
telemetry         stream-json --verbose, parsed into M215's ordered event model
wall clock        3600s
```

Two findings here that the integration run produced rather than the design anticipated.

**The arm environment was being constructed twice.** The container adapter built it to
inspect the arm surface and the agent adapter built it again to launch. M193A's constructor
refuses a configuration directory it did not create, so the run failed loudly — but the
refusal was the smaller half. The larger half is that a second construction would have made
the surface R5 audits a DIFFERENT directory from the one the agent is handed, so the isolation
proof would have been about a directory nothing ran in. One registry now builds it once per
run and both adapters read that.

**The argv named the symlink, not the pinned binary.** M214 froze two things that can
disagree: `binary`, which is the `claude` symlink, and `version`, which is 2.1.260.
M194 recorded why that matters — the symlink follows whatever was installed last. Asserting
the version and then launching the symlink leaves a window between the two. The adapter now
spawns the VERSIONED binary and requires M214's declared symlink to report the same version,
which satisfies both frozen fields and is strictly stronger than either alone.

**The agent had no /testbed to run in.** The first integration attempt spawned with
`cwd=/testbed`, which does not exist on the host. M194's `sandbox_prefix` — the bwrap mount
namespace that binds the arm's tree at /testbed so the host file tools and the container's
interpreter address ONE tree at ONE path — is now imported and reused rather than reproduced.

## 14. Agent identity

```text
frozen pin           2.1.260
pinned binary        reports the frozen version
declared symlink     reports the frozen version
launched executable  the versioned binary, not the symlink
wrong pin refused    yes, before launch
```

The installed identity matches M214's frozen authority, so nothing about the preregistration
needed updating and nothing was updated.

## 15. Model identity runtime hook

The assertion is a HOOK that fires during initialisation, not a field read afterwards. Events
cross the substrate boundary AS THEY ARRIVE, the adapter parses each line, and on the
`system/init` event it calls `hooks.assertProviderModelIdentity`. Throwing from there writes
an abort sentinel that a watchdog inside the bridge acts on, killing the process — because a
hook that only labelled the run afterwards would put the check after the money.

The recorded fixture is a genuine Claude Code transcript whose init event carries
`claude-opus-4-5-20251101`. The three variants are that same stream with exactly one thing changed.

| control | condition | expected | result |
| --- | --- | --- | --- |
| F55 | recorded correct provider init | gate passes | passed |
| F53 | init names a different model | issues raised | raised |
| F54 | no identity at all | issues raised | raised |
| F53R | wrong model, through the REAL agent adapter | run aborts, MODEL_IDENTITY_DRIFT | aborted |
| F54R | absent model, through the REAL agent adapter | run aborts, MODEL_IDENTITY_DRIFT | aborted |

In both R-variants the record is INFRASTRUCTURE_INVALID with category `MODEL_IDENTITY_DRIFT`
and no authoritative outcome exists. Absence is a failure, not a pass: M214 could only
establish `PRESENT_IN_AGENT_MODEL_REGISTRY_NOT_PROVIDER_CONFIRMED`, and a gate that treated
silence as confirmation would leave the cohort with exactly the evidence M214 already had.

§60's condition is met, so the residual is correctly classified rather than counted as a
defect: the production adapter is bound, the authoritative init event is wired, and a wrong or
missing identity aborts before any valid result. Actual provider confirmation remains
`PENDING_AT_FIRST_PAID_RUN`.

## 16. Native-tool equality

Both arms are launched through one argv builder from one frozen constant. The end-to-end rows
prove it at the process boundary rather than in memory: the replay process records the argv it
actually received, and the two arms' recorded argv are compared element by element.

```text
F26_BASELINE_FIRST   arms differ ONLY at --mcp-config
F26_VTRACE_FIRST     arms differ ONLY at --mcp-config
F59_BASELINE_FIRST   both arms carry the frozen model, tools and budgets
F59_VTRACE_FIRST     both arms carry the frozen model, tools and budgets
```

Ordering is not merely set equality here: the comparison is positional over the recorded argv
arrays, so a reordering would show as a difference.

## 17. VTRACE treatment catalogue

**Scope note.** The comparison is a SET comparison: M215's `treatmentCatalogSha256` sorts
before hashing, so a reordering of the served catalogue would pass. Ordering is not asserted
here and is not claimed.

Read from the server that would actually serve it, by speaking MCP to `vtrace mcp-serve --repo
<workspace>` and taking `tools/list` — not from the configuration file that was supposed to
start it.

```text
served tools        14 (the frozen catalogue)
index build         9.103s, 40646973 bytes on disk
initialised         true
F52A frozen 14      exact
F52  one missing    detected
F52B one extra      detected (search_symbols)
```

A defect the suite found in M216's own code: the adapter had defined its OWN catalogue digest
formula, while `auditTreatmentIdentity` compares against M215's `treatmentCatalogSha256`. Two
authorities for one digest is one too many, and the one that loses is whichever the gate does
not use — every vtrace row failed R10_TREATMENT_IDENTITY until the duplicate was deleted.

## 18. Baseline contamination

Measured off the real arm surface, not inferred from configuration generation:

```text
MCP servers                []
model-visible tools        ["Edit","Write","Bash","Read","Glob","Grep","TodoWrite"]
environment variables      ["CLAUDE_CONFIG_DIR","HOME","LANG","LOGNAME","PATH","SHELL","TERM","USER"]
VTRACE daemon sockets      []
injected context documents []
gold artifacts in context  []
treatment binaries on PATH ["/home/calvin/.npm-global/bin/vexp"]
```

Zero VTRACE tools, zero MCP servers, no `VTRACE_`/`VEXP_`/`ANTHROPIC_` variable, no `.vtrace`
in the workspace, no daemon socket, no injected context document.

One residual is recorded rather than claimed away: a `vexp` binary is present on the arm's
inherited PATH. M214's `auditBaselineIsolation` treats `treatmentBinariesOnPath` as a recorded
field rather than an automatic failure, on the stated reasoning that a binary whose daemon is
not running, whose MCP server is not configured and whose state directory is absent leaves the
agent nothing to find. `vtrace` itself is not on that PATH. This is unchanged from M214 and is
reported, not resolved.

## 19. Pair isolation, both orders

| order | rows | source digests equal | treatment inherited | teardown removed the arm root |
| --- | --- | --- | --- | --- |
| baseline → vtrace | 2 | yes | none | yes |
| vtrace → baseline | 2 | yes | none | yes |

The inheritance check is asserted through R7_RESET_WARMTH_POLICY — the gate that would
actually stop a contaminated run — rather than through a separate copy of the observation, so
a control cannot pass while the guard is broken. The frozen regime is COLD_UNIFORM: a fresh
container and a fresh checkout per run, the index built before the agent starts and measured
separately from the model budget, and nothing preserved across runs for either arm.

## 20. Real telemetry integration

The parser is PURE — bytes in, telemetry out, no clock and no filesystem — which is what makes
§49 checkable. Wall-clock latency is reported as zero rather than measured, because a field
that varied between two parses of the same bytes would make a run's semantic digest depend on
when it was read. M211's determinism lesson applies directly.

```text
AGENT_INIT        agent version and MCP servers from the init event
MODEL_IDENTITY    its own event, so 'the provider never told us' is a visible absence
NATIVE_TOOL_CALL  / FILE_READ / EDIT / SHELL_COMMAND / TEST_RUN
TREATMENT_TOOL_CALL  mcp__vtrace__* only
TERMINATION       subtype, provider-reported cost, usage
```

F69: three parses of the same recorded stream produced byte-identical telemetry, model
identity, usage and termination — stable.

M194's frozen termination categories are restated against M215's enum rather than copied: a
non-zero exit is not one thing, and a turn limit, a budget stop, a crash and a killed process
have different validity consequences.

## 21. Real evaluator binding

```text
implementation   swebench.harness.run_evaluation
version          swebench 4.1.0
python           /home/calvin/code/vexp-swe-bench/.venv/bin/python
command          python -m swebench.harness.run_evaluation -p <preds> -d <dataset> -id <run>
                 --max_workers 1 --timeout 1800 --cache_level instance --clean False
outcome          report.json's own `resolved`, never the agent's opinion
```

The evaluator identity, package version, instance, container and command are recorded on every
result, so evaluator drift after the cohort begins is detectable rather than invisible.

All 4 end-to-end rows reached EVALUATION and were graded by the real harness.

## 22. Evaluator failure distinctions

| case | expected | observed |
| --- | --- | --- |
| E1 empty patch | ordinary unresolved, evaluator not invoked | as expected |
| F56 unappliable patch | evaluator RUNS, ordinary unresolved | as expected |
| F56B report does not contain the instance | infrastructure failure, NOT unresolved | as expected |
| F57 evaluator identity recorded | version present on the result | recorded |

### 22.1 The launch-critical finding

swebench 4.1.0 writes NO `report.json` when the model patch does not apply. It raises
`EvaluationError`, logs `>>>>> Patch Apply Failed:` and leaves only `patch.diff` and
`run_instance.log`. The first version of this adapter read that absence as "the evaluator did
not run" and returned `EVALUATOR_INFRA_FAILURE` — an EXCLUSION category.

That would have excluded a run for the reason M214 puts at the top of its `neverExclusions`
list: "the agent made a bad patch". And it would have done so asymmetrically, on whichever arm
produced worse diffs, which is precisely the shape of bias a preregistered causal experiment
cannot survive. On a 200-run cohort it would have silently removed the arm that was losing.

The adapter now reads swebench's own marker: a patch that failed to apply is an ORDINARY
unresolved outcome with `evaluatorRan: true` and `patchApplied: false`, and only an absence
with no such marker is an infrastructure failure.

This finding was itself hidden for one run by the stale-log-directory defect below: the
control appeared to pass because it read a previous evaluation's report. Two defects, and the
second was masking the first.

F56 is worth stating plainly because it reverses the naive expectation: a patch that fails to
apply is an ordinary agent failure under M214's rules — "the agent made a bad patch" is on the
neverExclusions list — so the evaluator is supposed to run and report unresolved. The genuine
infrastructure case is F56B, and writing that control found a defect in the binding: the
adapter read the instance's row out of report.json with `report.get(id, {})`, so a report that
existed but did not MENTION the instance came back as `resolved: false` — an evaluation that
never happened wearing an ordinary unresolved outcome's clothes, which is exactly the collapse
the evaluator interface exists to prevent. Membership is now required, and the case stays
`EVALUATOR_INFRA_FAILURE` with `evaluatorRan: false`.

§28's E3 was deliberately not run. Evaluating a gold patch would add nothing the other three
cases do not already establish about the binding, and gold artifacts stay entirely outside any
path an arm can read: the research dataset that carries them is generated into an untracked
directory and is never mounted into an agent's workspace (F77).

## 23. End-to-end non-frozen dry run

4 rows, both arm orders, through M215's own `executeManifestRow` with the REAL
container adapter, the REAL agent adapter and the REAL evaluator adapter:

| order | arm | instance | status | argv | model | patch | evaluator | treatment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BASELINE_FIRST | baseline | pylint-dev__pylint-7080 | VALID_UNRESOLVED | 17 args | claude-opus-4-5-20251101 | ["pylint/__init__.py"] | ran=true resolved=false | exposed=false |
| BASELINE_FIRST | vtrace | pylint-dev__pylint-7080 | VALID_UNRESOLVED | 17 args | claude-opus-4-5-20251101 | ["pylint/__init__.py"] | ran=true resolved=false | exposed=true |
| VTRACE_FIRST | vtrace | pylint-dev__pylint-6903 | VALID_UNRESOLVED | 17 args | claude-opus-4-5-20251101 | ["pylint/__init__.py"] | ran=true resolved=false | exposed=true |
| VTRACE_FIRST | baseline | pylint-dev__pylint-6903 | VALID_UNRESOLVED | 17 args | claude-opus-4-5-20251101 | ["pylint/__init__.py"] | ran=true resolved=false | exposed=false |

Every lifecycle phase was reached in the frozen order, every required runtime gate was present
(F31 in both orders), and the only thing replaced was the executable the constructed argv
finally names. The production argv, environment, sandbox, spawn, streaming, parser, identity
hook, termination classification and cost accounting are the same code the paid path runs.

This is deliberately NOT M215's fake agent. M215 already proved the executor against fakes;
repeating that would test the interfaces again, which is not what M216 was uncertain about.

## 24. Resume semantics

```text
F61A  a ledger written by one process restores in another, chain and digests recomputed  verified
F61   a row that already has a valid outcome is refused rather than rerun                refused
F62   the completed arm's scratch root is gone, so the next row cannot inherit it        removed
```

Exercised on the real container substrate with a synthetic research manifest, never with a
frozen manifest row.

## 25. Exactly-once semantics

`F58`: a research result offered to a COHORT ledger is refused — on its mode AND on its
manifest digest, two independent locks rather than one. Research results are produced in
SYNTHETIC mode against a manifest whose hash is not M214's, so they are structurally incapable
of entering the 200-run causal dataset. §35's population guard is a third, separate lock, and
it fires inside the bridge on every real operation (F44).

## 26. Spend projection, including retries

```text
planned runs                 200
per-run cap                  $3.5
first-attempt maximum        $700
authorised ceiling           $700
retry headroom               $0
max attempts per run         2
rerunnable categories        MODEL_SERVICE_FAILURE, CONTAINER_CANNOT_START, EVALUATOR_INFRA_FAILURE, TELEMETRY_CORRUPT
mathematical maximum         $1400
```

200 × $3.50 is $700, which is exactly the ceiling: first attempts fit with ZERO headroom. A
fully retried cohort would be $1400, twice the ceiling. That is not a policy inconsistency,
and it matters to say why. M214 resolves it in two places — `bothAttemptsRemainInLedger` puts
a failed attempt's cost into the cumulative total, and `budgetInterlock` states that the cap
is an infrastructure guard rather than a stopping rule, so if it binds the cohort is
INCOMPLETE and is reported as incomplete. The executor refuses to BEGIN a run whose worst case
would breach the ceiling. Actual spend is bounded at $700; COMPLETION is not guaranteed once
retry budget is consumed.

§39's question — whether provider spend may already have occurred for a retryable class — has
one answer that mattered. Of the four rerunnable categories, only `MODEL_SERVICE_FAILURE` can
have already cost money, and it is precisely the case where the CLI produced no result event
and therefore no provider-reported cost. Recording that as $0 would make it the one way real
spend escapes the ceiling, so the production agent adapter charges an attempt with no reported
cost at its per-run cap instead. That is conservative for the guard and changes nothing about
the analysis, which reads provider-reported cost.

**Reported ambiguity, not resolved here:** M214 does not say whether the per-task ceiling
resets on a retry. The executor's answer is that it does not — `--max-budget-usd` is per
process, so a second attempt can spend up to the cap again, and both attempts' costs sum into
the cumulative total the ceiling guards. That is the only reading consistent with
`bothAttemptsRemainInLedger`, but it is an inference and is recorded as one.

## 27. Spend guard

```text
F66   cumulative one dollar under the ceiling, one more run at cap  refused
F66A  the first-attempt projection fits the ceiling                 fits
F66B  an empty cohort's guard stays silent                          silent
F66C  the projection charges every remaining run at its cap         confirmed
F67   a COHORT launch without authorisation                         refused
F78   a LIVE provider boundary outside COHORT mode                  refused
```

F78 is the substrate's own guard rather than the executor's, and it refuses regardless of what
authorisation the caller claims to carry. A paid provider call is not an infrastructure
operation.

## 28. Outcome-blind status

`F68`: the operational progress view was inspected key by key for anything matching an outcome
word — pass rate, resolved counts, per-arm wins, McNemar, discordant pairs, delta — and
exposes none. It reports planned/terminal/valid run counts, infrastructure failures, the
current run, cumulative and projected spend, the ledger chain head and runtime errors. An
operator watching a running cohort has no legitimate use for the outcome comparison and a
strong temptation to intervene on it, so the dashboard cannot compute one.

## 29. Secret handling

```text
F63   a credential VALUE reaching a persisted artifact  detected
F63B  an artifact carrying only the credential NAME     clean
```

The real-substrate evidence document is scanned against the process environment before it is
written, and the runner refuses to persist it on any hit. The arm environment allowlist drops
every `ANTHROPIC_`, `VTRACE_`, `VEXP_` and `CLAUDE_` variable, and M193A's configuration hash
is taken over `name:size` pairs rather than file content precisely because the one file in
that directory is a credential. Result: 0 leaks.

## 30. Real-substrate falsification

**73/73 controls satisfied** (24 GUARD_FIRES, 49 GUARD_SILENT); failures [none].

Numbering continues M215's rather than restarting, and the per-order controls carry the order
in their id: the milestone brief's F59/F60 pair ("pair order A→B" and "pair order B→A") is
realised as `F59_BASELINE_FIRST` and `F59_VTRACE_FIRST`, with `F26_*`, `F31_*`, `F49_*` and
`F50_*` likewise doubled so each order's evidence is separately readable.

| id | claim | expectation | substrate | result |
| --- | --- | --- | --- | --- |
| F44A | every research instance is outside M214's frozen 100 | GUARD_SILENT | PURE | satisfied |
| F41 | a missing production container adapter makes the DOCKER_SWEBENCH binding unusable | GUARD_FIRES | PURE | satisfied |
| F42 | a missing production agent adapter makes the DOCKER_SWEBENCH binding unusable | GUARD_FIRES | PURE | satisfied |
| F43 | a missing production evaluator adapter makes the DOCKER_SWEBENCH binding unusable | GUARD_FIRES | PURE | satisfied |
| F64 | implementing M214's PROSE hash rule (3 excluded fields) fails to reproduce the frozen digest; the generator excludes 9 | GUARD_FIRES | PURE | satisfied |
| F65 | the actual generator field-exclusion authority reproduces the frozen digest from the unmodified committed artifact | GUARD_SILENT | PURE | satisfied |
| F55 | a recorded REAL provider init event carrying the frozen model identity passes the gate | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F53 | an init event naming a different model aborts before a valid outcome can exist | GUARD_FIRES | REAL_AGENT_PATH | satisfied |
| F54 | an absent provider model identity is a failure, not a pass | GUARD_FIRES | REAL_AGENT_PATH | satisfied |
| F69 | parsing the same recorded stream three times yields byte-identical telemetry, model identity, usage and termination | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F63 | a credential value that reached a persisted artifact is detected | GUARD_FIRES | PURE | satisfied |
| F63B | an artifact carrying only the NAME of a credential is clean | GUARD_SILENT | PURE | satisfied |
| F67 | a COHORT launch without explicit spend authorisation is refused | GUARD_FIRES | PURE | satisfied |
| F66A | the first-attempt cohort projection fits inside the frozen ceiling | GUARD_SILENT | PURE | satisfied |
| F66 | with cumulative spend one dollar under the ceiling, one more run at its cap is refused | GUARD_FIRES | PURE | satisfied |
| F66B | an empty cohort's projection is inside the ceiling and the guard stays silent | GUARD_SILENT | PURE | satisfied |
| F66C | the projection charges every remaining run at its cap, so the ceiling binds on what the cohort could cost rather than on what it has cost | GUARD_SILENT | PURE | satisfied |
| F68 | the operational progress view exposes no per-arm outcome, pass rate or test statistic | GUARD_SILENT | PURE | satisfied |
| F41P1 | no source change on the vtrace-init route captures an empty patch | GUARD_SILENT | REAL_GIT | satisfied |
| F41P2 | no source change on the vtrace-index route captures an empty patch | GUARD_SILENT | REAL_GIT | satisfied |
| F47 | treatment metadata created during the run does not enter the source patch | GUARD_SILENT | REAL_GIT | satisfied |
| F48 | the historical FILE-granularity snapshot captures a treatment file written during the run; the corrected DIRECTORY invocation does not | GUARD_FIRES | REAL_GIT | satisfied |
| F41P4 | one tracked source edit is captured exactly | GUARD_SILENT | REAL_GIT | satisfied |
| F41P5 | an untracked source file the agent created IS captured; the exclusion covers only pre-existing untracked state | GUARD_SILENT | REAL_GIT | satisfied |
| F41P6 | a treatment directory the harness has never heard of is captured when it appears after the snapshot, proving the rule is derivation and not a vendor allowlist | GUARD_FIRES | REAL_GIT | satisfied |
| F51A | the production argv is exactly the frozen invocation | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F51 | altering one frozen agent argument is detected | GUARD_FIRES | REAL_AGENT_PATH | satisfied |
| F52A | the real vtrace MCP server serves exactly the frozen 14-tool treatment catalogue | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F52 | a treatment catalogue missing one tool is detected | GUARD_FIRES | REAL_AGENT_PATH | satisfied |
| F52B | an extra debug tool in the treatment catalogue is detected | GUARD_FIRES | REAL_AGENT_PATH | satisfied |
| F26 | the baseline arm exposes zero treatment tools | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F26B | a baseline arm that could see one treatment tool is detected | GUARD_FIRES | REAL_AGENT_PATH | satisfied |
| F21 | the pinned binary and M214's declared symlink both report the frozen version 2.1.260 | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F21B | a version pin the installed binary does not satisfy is refused before launch | GUARD_FIRES | REAL_AGENT_PATH | satisfied |
| F79 | the launched executable is the VERSIONED binary, not the symlink that follows whatever was installed last | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F44 | the real substrate refuses a frozen task in research mode, including 'just for infrastructure' | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F45 | a container whose checkout does not land on the declared base commit is refused | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F46A | the started container's /testbed exists and is writable | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F46 | a checkout root that is not there is refused by the same probe | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F45B | after reset the real container HEAD is the declared base commit | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F70 | the tracked-source digest is stable across repeated reads of an unchanged tree | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F71 | the tracked-source digest changes when a tracked file changes, so source identity is a measurement and not a constant | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F72 | the real patch snapshot captures exactly the edited tracked file | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F73 | a real VTRACE index is built in the real checkout before the agent starts, and it serves the frozen catalogue | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F74 | building the treatment index leaves tracked source byte-identical, so indexing is observational | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F75 | the pre-agent snapshot names the treatment DIRECTORY, not the files inside it | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F47R | on the REAL substrate, treatment state written during the run does not enter the captured source patch | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F47RB | the same real state IS captured when the derived exclusions are dropped, so the exclusion is doing the work rather than git | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F76 | the baseline arm's real environment carries no VTRACE or VEXP variable and no MCP server | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F77 | no evaluation artifact is reachable from the real agent workspace | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F59_BASELINE_FIRST | both arms of the BASELINE_FIRST order reach a real child process with the frozen model, native tools and budgets | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F26_BASELINE_FIRST | the two arms' invocations differ only in the MCP configuration document | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F50_BASELINE_FIRST | both arms of the pair started from an identical tracked-source digest | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F49_BASELINE_FIRST | the arm that ran second inherited no treatment state from the first, as measured by the COLD_UNIFORM gate that would have stopped it | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F31_BASELINE_FIRST | every required runtime gate is present in both records | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F59_VTRACE_FIRST | both arms of the VTRACE_FIRST order reach a real child process with the frozen model, native tools and budgets | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F26_VTRACE_FIRST | the two arms' invocations differ only in the MCP configuration document | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F50_VTRACE_FIRST | both arms of the pair started from an identical tracked-source digest | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F49_VTRACE_FIRST | the arm that ran second inherited no treatment state from the first, as measured by the COLD_UNIFORM gate that would have stopped it | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F31_VTRACE_FIRST | every required runtime gate is present in both records | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F53R | a wrong provider model identity aborts the real agent path before an outcome exists | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F54R | an absent provider model identity aborts the real agent path | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| E1 | an empty patch is an ordinary unresolved outcome, and the evaluator says so rather than failing | GUARD_SILENT | REAL_EVALUATOR | satisfied |
| F56 | an unappliable patch is graded by the real evaluator as an ordinary unresolved outcome, not as an infrastructure failure | GUARD_SILENT | REAL_EVALUATOR | satisfied |
| F56B | an evaluation whose report does not contain the instance is an infrastructure failure, never an unresolved task | GUARD_SILENT | REAL_EVALUATOR | satisfied |
| F57 | the real evaluator's identity is recorded so drift after the cohort begins is detectable | GUARD_SILENT | REAL_EVALUATOR | satisfied |
| F61A | a ledger written by one process restores in another with its chain and digests recomputed | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F61 | after resume, a row that already has a valid outcome is refused rather than rerun | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F58 | a research result is refused by a COHORT ledger, on its mode and on its manifest digest | GUARD_FIRES | REAL_CONTAINER | satisfied |
| F62 | teardown removed the completed arm's scratch root, so the next row cannot inherit its treatment state | GUARD_SILENT | REAL_CONTAINER | satisfied |
| F80 | an agent process that cannot be spawned is an infrastructure failure before treatment exposure, not an unresolved task | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F81 | an agent that ran and produced no result event is a model-service failure, not an unresolved task | GUARD_SILENT | REAL_AGENT_PATH | satisfied |
| F78 | a LIVE provider boundary is refused outside COHORT mode, whatever authorisation the caller claims | GUARD_FIRES | REAL_AGENT_PATH | satisfied |

### 30.1 Defects the suite found in M216's own code

Nine, each caught by a control rather than by reading. The first is the one that would have
damaged the experiment:

1. **An unappliable patch was going to be EXCLUDED from the cohort** (§22.1) — an agent failure
   M214 forbids excluding, removed asymmetrically on whichever arm produced worse diffs.
2. **The evaluator turned a missing report row into an unresolved task** (§22) — the mirror
   image, scoring an infrastructure failure as an agent failure.
3. **The evaluator could read a PREVIOUS evaluation's verdict.** swebench keys its log
   directory by run id, and the adapter derived that id from the manifest row alone — so the
   same row evaluated twice wrote to and read from one directory. The control that asked for
   an instance outside the dataset got back the earlier successful evaluation's report. In a
   cohort this is a retried run inheriting the first attempt's outcome. The id now carries the
   patch and the invocation, and the bridge refuses a log directory that already exists.
4. **The untracked-snapshot parser failed closed on every clean checkout.** When git
   enumerates nothing the payload is empty and the line is `" 0"` — a leading space carrying a
   real exit status — and `strip()` ate the separator, turning the healthiest possible answer
   into an unparseable one. Every reset reported `complete: false`.
5. **The arm environment was constructed twice** (§13 above), so the audited surface was not
   the launched environment.
6. **The agent had no /testbed to run in**, because the bwrap namespace M194 established had
   not been carried across the new boundary.
7. **A second treatment-catalogue digest authority** existed in the adapter, disagreeing with
   the one `auditTreatmentIdentity` uses, so every vtrace row failed R10.
8. **Every agent failure was being called MODEL_IDENTITY_DRIFT.** A run that produced no init
   event had its identity asserted against `null` and threw, so a missing binary and a crashed
   process were both blamed on the provider. A process that started and said NOTHING never
   reached the treatment; a process that spoke and never named a model is the case the identity
   gate exists for. The two are separate now, and F80 and F81 are the controls that say so.
9. **The suite was not idempotent.** The evaluator's swebench run id was derived from the
   manifest row alone, so a second run collided with the first's log directories. Only the
   guard-break's restored re-run could find it; see §32.

Two further defects were in CONTROLS rather than in the binding, and both are worth recording
because they are the shape of mistake that makes a suite look healthier than it is: the
"baseline sees no treatment" check was handed a vtrace row and correctly reported fourteen
tools, and several controls gave their container adapter and their agent adapter different
registries — defect 4 arriving through a second door, after it had already been fixed once.
The repair for that is structural rather than careful: the registry now belongs to the
container adapter and the agent reads it off that adapter, so there is no longer a place for
a caller to supply two.

## 31. M215's falsification, preserved

M215's suite still reports **66/66** (44 GUARD_FIRES, 22 GUARD_SILENT), failures [none].

Three assertions in `m215Falsification.test.ts` were updated, and it is worth being precise
about why that is not a weakening. They asserted a LITERAL — that `DOCKER_SWEBENCH` is
`DECLARED_UNIMPLEMENTED` — which was M215's honest residual and is now a stale fact. What
replaces them asserts that the status FOLLOWS its evidence in both directions, plus two new
tests that a missing adapter or missing evidence makes the binding unusable. The guard M215
built still fails closed, and is now checked to do so on a real input rather than on a
constant.

## 32. Intentional guard-break evidence

**M216_SUITE_IS_FALSIFYING**

Three guards, one from each class §52 names, were broken simultaneously and the full
real-substrate suite was re-run:

| breakage | class | file | expected failures |
| --- | --- | --- | --- |
| B1_SOURCE_STATE_SNAPSHOT_GRANULARITY | source state | `m216ProductionAdapters.ts` | F75, F47R |
| B2_ADAPTER_IDENTITY_VERSION_PIN | adapter identity | `m216ProductionAdapters.ts` | F21B |
| B3_PATCH_CAPTURE_DERIVED_EXCLUSIONS | patch capture | `m216RealSubstrate.ts` | F41P2, F41P4, F47 |

```text
clean      73/73
broken     67/73  failing [F21B, F41P2, F41P4, F47, F47R, F75]
restored   73/73  failing [none]
unexpected none
missed     none
sources restored byte-identical  true
```

One control is deliberately NOT expected to fall, and saying so is part of the evidence:

- **F41P1** — the vtrace-init route is protected by git's own .git/info/exclude entry, not by the derived exclusions, so emptying them cannot reach it

The guards were restored and the suite returned to its clean count. A suite that only ever
passes is indistinguishable from one that cannot fail; this one can, on the real substrate.

The restored re-run was not ceremony. It found the ninth defect: the evaluator's swebench run
id was derived from the manifest row and the invocation counter alone, so a SECOND run of the
same controls produced the same ids, collided with the log directories the first run had left,
and the fail-closed guard correctly refused every evaluation. The suite was not idempotent, and
only running it twice could show that. The id now carries a per-process nonce.

## 33. Scoped typecheck

```text
M216_NEW_TYPECHECK_ERRORS = 0
scoped clean            0
with injected error     1
after removal           0
M215's own scope        0
M216_SCOPED_TYPECHECK_VERIFIED
```

`tsconfig.m216.json` keeps M214's and M215's files inside the scope — the adapters implement
M215's interfaces over M214's frozen constants, so a scope that dropped either would stop
checking exactly the boundary the paid path runs on — and adds M216's own plus
`m193aArmEnvironment.ts`. The config INCLUDES files and the config CHECKS them are different
claims, so a deliberate error is injected into a path only M216's globs match and the target
is required to report it.

`PREEXISTING_BENCHMARK_TEST_TYPE_ERRORS` — the ~59 errors in historical benchmark test files
that enabling benchmark tests repo-wide would surface — are historical, unchanged, outside
this milestone's scope, and are NOT claimed to be fixed.

## 34. Standard verification

```text
bun run typecheck                 clean
bun run typecheck:benchmarks      clean
bun run lint                      clean
bun test                          6548 pass, 49 skip, 0 fail (395 files)
git diff --check                  clean
M216 scoped typecheck             M216_SCOPED_TYPECHECK_VERIFIED
M215 falsification suite          66/66
M216 real-substrate suite         73/73
M216 guard-break                  M216_SUITE_IS_FALSIFYING
secret scan                       0 leaks
```

## 35. Container usage

```text
containers created/started   10
containers torn down         10
non-frozen task ids used     pylint-dev__pylint-6903, pylint-dev__pylint-7080
frozen task ids used         0
```

Plus the swebench evaluation containers the official harness creates and removes itself, one
per evaluation. Docker use is expected in M216; model spend is not.

**Teardown-failure semantics — reported ambiguity (§48).** Neither M214 nor M215 says whether
a teardown failure after an otherwise valid evaluated result invalidates that result. The
binding's current behaviour is that teardown reports rather than throws and the completed
result stands, which matches the reasoning that a cleanup failure should not erase a valid
outcome. What is NOT implemented is the other half: if a teardown failure threatens the
isolation of future rows, halting the cohort would be more appropriate than rewriting the
completed result, and no such halt exists. This is named as an open question for the launch
decision rather than answered by invention.

## 36. Zero-spend evidence

```text
frozen tasks with a live agent   0
provider calls                   0
live model spend                 $0
```

No provider request occurred, accidentally or otherwise. The substrate refuses a LIVE provider
boundary outside COHORT mode (F78), and COHORT mode additionally requires spend authorisation
that does not exist. Every agent process in this milestone was the production launch path
ending at a recorded event source.

## 37. Frozen artifact immutability

```text
stage5_m213_preregistration.json       UNCHANGED  508b19766b12d1e8
stage5_m214_preregistration.json       UNCHANGED  e57ec71f7ca4a668
stage5_m214_run_manifest.json          UNCHANGED  a81ab4a4861c5fc7
stage5_m214_external_reference.json    UNCHANGED  f974b8d25bf66345
stage5_m214_preregistration_hash.json  UNCHANGED  cf6da9e32172bf4c
```

Compared byte for byte against the committed blobs, not asserted. All three experiment digests
also recompute from those bytes (§3). The frozen A1-A15 scorers are untouched: M216 changed no
scorer, no parity input and no matrix cell.

## 38. Product immutability

```text
src/ diff = 0
HEAD:src  = b3b3e439f10c6c526cafc6001d25dd0e7552ce6d
```

The tree every vtrace manifest row declares. M216 changed no `src/` file, so the frozen
treatment identity is intact. No production defect blocked execution.

## 39. Launch gates

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

Blockers: G36.
Deferred to launch: G14.

The technical set is G32, G33, G34, G35, G37, G38, G39, G43, G44, G45, G46, G47, G48, G49, G50, G51, G52, G53, G54, G55. G36 is deliberately outside it:
spend authorisation is a separate fact from technical readiness in both directions, and this
milestone neither has it nor requests it.

## 40. Technical readiness verdict

```text
TECHNICAL_EXECUTOR_READY
```

Derived, never assigned: `technicalExecutorReady` is the conjunction of the technical gates,
each of which is read out of an evidence artifact by control id.

## 41. Spend status

```text
SPEND_AUTHORIZATION_PENDING
```

No authorisation was requested and none was given. Building and exercising the binding is not
authorisation.

## 42. Repository state

```text
starting SHA        71f79238f55d3c63a3998505f2f005220b7dcf01
commit 1            d9822a63 Ask what the real substrate already does, before writing anything that does it again
commit 2            29f8712d Bind the executor to the real containers, the real agent and the real evaluator
commit 3            46c397a7 Let the real substrate find eight defects, and prove the suite can still fail
HEAD at generation  46c397a7fcfae4d1691c73d75aefd894fa4f5afa
ahead/behind        0	237
pushed              no
pre-existing dirt   preserved (stage5_outcome_ledger.{json,md} and the historical untracked
                    benchmark results are untouched)
```

## 43. Strategic conclusion

The frozen Baseline vs VTRACE causal experiment is technically executable. No outcome-bearing
benchmark run has occurred. The only remaining pre-launch human decision is whether to
authorize the frozen spend ceiling; live provider model identity remains a mandatory
first-run runtime assertion.

Two things a reader should carry forward. The retry headroom is exactly zero, so a cohort that
consumes any retry budget cannot also finish 200 runs — that is M214's stated interlock, not a
defect, but it means "incomplete" is a reachable ending that the authorisation decision should
price in. And the teardown-failure question in §35 is open: it needs an answer before launch,
and the answer should come from a preregistration-compatible clarification rather than from
whatever the code happens to do.

`ENGINE QUALITY != CODING-AGENT UTILITY` and
`CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` both still govern. Nothing in M216 measured
the product; it measured whether the experiment that would can actually be run.

Do not launch.

