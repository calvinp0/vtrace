# M193 — telemetry contract

Schema version `stage5.m193.acquisition.v1`. Frozen before the first live agent
call. The types live in `benchmarks/stage5_vexp_swe_bench_smoke/m193Acquisition.ts`;
this document says what each field means and why it exists.

The organising principle: **capture once, analyse later** (§16). I6 is the
immediate unresolved hypothesis, but nothing here is shaped to it. Every field is
neutral state that a separately preregistered analysis could read.

## 1. Per-arm record

```
instanceId, repo, baseCommit
imageKey, containerId, hostMount, workdir
agent { model, cliVersion, maxTurns, allowedTools, promptSha256,
        mcpConfig, settingsSha256, samplingConfiguration }
preflight { verdict, checks, provenanceRobustness, moduleFile,
            moduleFileNeutralCwd, preexistingUntracked,
            bytecodeStalenessHazard, bytecodeCacheCount }
events[]            ordered trace  (§2 below)
snapshots[]         diff snapshots (§3 below)
finalPatch, finalPatchHash, finalAgentResponse
usage { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
        costUsd, numTurns, wallMs }
outcome { termination, runValidity, invalidReasons, exclusion,
          evaluatorRan, resolved }
treatmentAudit { verdict, blockingFindings, benchmarkNativeInstructionFiles }
```

## 2. Ordered trace (§17, §19)

Every event carries a dense, strictly increasing `ordinal` assigned by the
harness, plus an ISO timestamp, an event type and the `stateHash` of the working
tree as of that event.

```
TraceEvent {
  ordinal          0,1,2,… dense; asserted by traceOrderingIsWellFormed()
  ts               ISO 8601
  type             agent_start | tool_call | patch_snapshot
                   | assistant_text | agent_end
  toolName         Read | Edit | Write | Bash | Grep | Glob | TodoWrite
  toolInput        the tool's arguments, verbatim
  stateHash        sha256 of the normalised diff at this point
  validation?      present on every Bash event (§4)
  snapshot?        present on every patch_snapshot event (§3)
}
```

`tracePrefix(events, n)` returns the events through ordinal `n` and nothing
later. A `DecisionPointEvidence` for any future analysis is exactly such a
prefix, so no analysis can accidentally see the future.

Ordering is never reconstructed from interleaved log strings. If ordinals are not
dense the arm is `TRACE_ORDERING_CORRUPT` and `RUN_INVALID`.

The `stream-json` transcript is preserved too, but it is not the source of
ordering: structured telemetry is (§17).

## 3. Diff snapshots (§18)

Captured at deterministic boundaries, invisible to the agent — the recording
hooks emit no additional context and no output the model can see.

| boundary | when |
|---|---|
| `SETUP` | after the base checkout, before the agent starts |
| `AFTER_EDIT` | after every successful `Edit`/`Write`, and after any Bash command that changed the tree |
| `BEFORE_VALIDATION` | immediately before a validation command |
| `AFTER_VALIDATION` | immediately after a validation command |
| `BEFORE_SUBMIT` | at `Stop` |

Each snapshot records `ordinal`, `boundary`, `diffHash` (sha256 over the
normalised diff), `diffBytes`, and the full patch where storage permits. The
purpose is to reconstruct what code existed at each decision point, so a later
analysis can ask what the agent was looking at rather than what it ended with.

## 4. Validation events

Every Bash event carries a `ValidationRecord`. `isValidationAttempt` marks
whether the command was a test invocation; the other fields are recorded either
way so the classification can be revisited without re-running anything.

### 4.1 Shell termination and semantic result are separate (§22)

```
shell {
  processStarted   false when the exec produced no process at all
  exitCode         verbatim; null for a command that has not ended
  timedOut
  signal
  durationMs
}
runnerStarted        did a TEST RUNNER start, as distinct from the shell succeeding
semanticTestResult   PASSED | FAILED | MIXED | NO_TESTS_RAN | UNKNOWN
```

Neither is derived from the other. M192's trap is the reason: swebench's own eval
script ends with `git checkout` and exits 0 while the test it ran failed. A
taxonomy that reads exit status as a verdict records that as a pass.

`semanticTestResult` is read only from the runner's own summary. Absent a
recognisable summary the answer is `UNKNOWN`, which makes the episode unusable
rather than silently counting as a pass. `Ran 0 tests … OK` is `NO_TESTS_RAN`,
never `PASSED`.

### 4.2 Streams (§23)

```
streams {
  stdout                raw, separated, verbatim
  stderr                raw, separated, verbatim
  mergedStream          ordered interleaving
  mergedStreamComplete
}
```

All three are built from the **same** multiplexed docker frame sequence, so they
cannot disagree about what happened and no shell-level `tee` can race.

Classification always reads `classificationText()`, which prefers the merged
stream and falls back to `stdout + stderr` — never `stdout` alone. M192 found the
runner markers surfacing on stderr while results went to stdout; a classifier
reading one stream makes an entire test execution disappear. A synthetic fixture
(`F10`) reproduces exactly that split and is asserted in the test suite.

### 4.3 Source provenance (§20)

```
workdir                  the workdir the command actually ran in
moduleFile               <pkg>.__file__ measured out-of-band, same container,
                         same workdir, immediately after the command
moduleFileNeutralCwd     the same measurement from / with no cwd advantage
provenanceRobustness     EDITABLE_INSTALL | CWD_DEPENDENT | UNKNOWN
provenance               EDITED_CHECKOUT_CONFIRMED | INSTALLED_COPY_CONFIRMED
                         | AMBIGUOUS_SOURCE | RUNNER_NOT_STARTED | NOT_APPLICABLE
```

The witness is a separate command run after the agent's, so nothing is injected
into the agent's process and no runtime instrumentation is added (§45).

`classifyValidationProvenance()` fails closed. A module path under the checkout
root is not sufficient on its own: the install must be genuinely editable, or the
command must demonstrably have run with the workdir pinned to the checkout root.
`psf/requests` is `CWD_DEPENDENT` — from a neutral working directory it resolves
`/opt/miniconda3/envs/testbed/lib/python3.9/site-packages/requests/__init__.py`,
not the checkout — and that is measured per instance, not assumed per benchmark.

**`INSTALLED_COPY_CONFIRMED` and `AMBIGUOUS_SOURCE` make the validation event
unusable.** They are never treated as ordinary test results, and they remain
visible in the corpus accounting as `wrongSourceEvents` and
`ambiguousSourceEvents`.

### 4.4 A known hazard this contract records rather than suppresses

CPython validates a cached `.pyc` against its source's `(mtime_seconds, size)`.
An edit that preserves file size within the same second is therefore invisible to
the interpreter, while every path witness still correctly reports
`EDITED_CHECKOUT_CONFIRMED`. This is not hypothetical: it was measured on
`psf/requests-1142`, where writing `= 1` and then `= 2` produced two identical
reads, and it initially fooled this milestone's own dry run.

It is a fourth failure mode alongside M192's three, and it is **not** suppressed.
Setting `PYTHONDONTWRITEBYTECODE` would change the environment the baseline agent
faces, which §15 and §45 forbid. Instead:

* the preflight measures it per instance (`bytecodeStalenessHazard`), and
* every validation event records `bytecodeCacheCount`, the number of compiled
  caches inside the checkout at that moment.

A later analysis can therefore identify episodes where the condition was possible.
M193 does not analyse it.

## 5. Cost and tokens (§46)

```
usage { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
        costUsd, numTurns, wallMs }
```

Taken from the provider-reported usage in the `stream-json` result event, never
inferred from transcript character counts. M169 established that per-row token
fields in the historical Stage 5 ledgers are inflated because assistant messages
were counted more than once; the acquisition deduplicates on `message.id` before
summing, and records the raw events so the sum can be recomputed.

`costUsd` is the figure the per-run cap and the total-spend stopping rule act on.

## 6. Container and workdir identity

```
imageKey, containerId, hostMount, workdir, condaEnv
execPath                the exact docker API seam used, recorded per command
routedTo                container | host  (always "container" under §25)
```

`execPath` is recorded so the "no privileged bypass" claim is checkable rather
than asserted: every command the harness issues goes through the same seam the
agent's commands do.

## 7. What is deliberately absent

No coverage tracing, variable tracing, dynamic slicing, debugger hook or custom
instrumentation (§45). No context-reduction denominators or hypothetical read
volumes (§47). No I6 feature extraction. The corpus is a recording of ordinary
behaviour; the analyses come later, under their own preregistrations.
