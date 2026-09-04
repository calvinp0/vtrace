# M216 — substrate reduction audit

**M216_SUBSTRATE_REDUCTION_COMPLETE**

Before any adapter was written, every obligation M215's three interfaces impose was matched
to the authority that already satisfies it. The point is to make one mistake hard:
reimplementing M193/M194's audited Python in TypeScript because the executor happens to be
TypeScript. That would produce a second implementation of code that M192's workdir finding,
M193's ancestry correction and bytecode-staleness hazard, M193B's rename loss, M193C's
index-destroying snapshot and M194's termination categories were all written against, and
every one of those defects would be re-openable in the copy.

- DIRECT_REUSE: 5
- THIN_ADAPTER: 5
- MISSING_PRIMITIVE: 2

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

## Notes

### container setup

Image lookup, one docker-cp extraction of /testbed to the host, one bind-mounted container over that tree, safe.directory, the base-commit ancestry check M192's V2 correction added, and the pre-existing untracked record. Called unchanged; M216 adds only the /testbed writability probe M215's contract asks for.

### repository reset

M193's setup() checks out the base commit once, at creation. §13 requires source state to be ESTABLISHED deliberately for each run rather than inherited from whatever the previous step left, so the reset is its own operation: checkout, a clean that removes untracked and ignored paths, then re-observation of HEAD, tracked changes and untracked state. It reports the state it reached instead of asserting success.

### source snapshot / source identity

M193B answers 'what changed', not 'what is the source right now', and M215's contract needs the second. The digest is git hash-object over tracked working-tree bytes — index blobs would not change when a file is edited. The pre-agent snapshot is the same enumeration M193B and M193C run, asked at DIRECTORY granularity; see the --directory row.

### pre-agent untracked snapshot granularity

M215's D4 measured that this flag decides whether a treatment file written DURING the run is attributed to the agent. m193c_patch_snapshot.py enumerates WITHOUT it, and is right to: that is the CAPTURE lane, which must reach each untracked file to diff it. M216 adds a separate benchmark-owned snapshot command at the coarser granularity and does not modify M193C, whose behaviour five milestones of controls were written against.

### agent launch

The process mechanics — bwrap namespace, Popen, stderr drain, timeout kill, stream sink — are M194's and are reused. What moves to TypeScript is what DEFINES the experiment: argv, environment, arm MCP configuration, model target, budgets. A substrate that could choose any of those would be a place for an arm difference to hide.

### ordered telemetry

M194 extracted a flat tool_use list and a result event. M215's ledger needs an ORDERED, kinded event stream, so the parser is reimplemented against M194's frozen categories rather than its data shape, and it is pure: bytes in, telemetry out, no clock, so §49's determinism requirement is checkable.

### patch capture

Called with the exclusion list the EXECUTOR derived from its own pre-agent snapshot. Nothing in the substrate names a vendor directory: M214's rule is 'what changed minus what already existed', and brand names are defence in depth, never the semantics.

### evaluation

The official harness, its report.json, and M194's separation of 'the evaluator did not run' from 'the task did not resolve'. The dataset is a parameter so a non-frozen research instance can be evaluated without the frozen dataset being involved.

### teardown

Container removal plus host-mount removal. M216 additionally removes the arm's own scratch root, which is where the treatment index and the agent's private configuration directory live, because §43 asks that neither survive into the paired arm.

### wrong-source detection

M192 established that an unpinned workdir silently resolves an installed copy, which is why every exec pins its cwd. The gate itself is M214's own auditSourceStateEquivalence, called by M215 on digests M216 supplies.

### treatment initialisation and catalogue

M193/M194 acquired ONE untreated arm. There is no prior authority for building the index before the agent starts, for measuring it separately from the model budget, or for reading the served tool catalogue back. M216 implements it, and reads the catalogue from the server that would actually serve it rather than from the configuration that was meant to start it.

### provider-model identity assertion during initialisation

M194 parsed the stream after the process exited, which puts the check after the money. M216 streams events across the boundary as they arrive so the hook fires on the init event, and a failed assertion writes an abort sentinel a watchdog acts on.

