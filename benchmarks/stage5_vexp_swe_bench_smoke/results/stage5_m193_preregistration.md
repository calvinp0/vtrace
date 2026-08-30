# M193 — preregistration: baseline-only observational corpus

Frozen before any live agent has run against this design. The purpose of the
document is to make it impossible to choose, after seeing results, what the
experiment was going to be.

## 1. Where the programme actually is

| line of evidence | state |
|---|---|
| I1 initial orientation | M183: no demonstrated incremental utility |
| downstream repository context | M185: no repeated causal mechanism |
| VEXP contradiction | M188: removed |
| I5 diff-derived edit-set intelligence | M189 partial signal, M190 falsified out of sample — **CLOSED** |
| I6 validation intelligence | historical corpus confounded; M191 blocked; M192 substrate established — **UNTESTED FAIRLY** |
| runtime-grounded repair diagnosis | externally promising, never tested here |

M193 reopens none of these. It exists only so that the *next* corpus is worth
collecting.

## 2. The question M193 answers

> Can we freeze a small, fair, baseline-only observational experiment such that
> later live runs naturally expose edit → validation → result → revision behaviour
> without VTRACE treatment, while preserving enough neutral telemetry to support
> subsequent gold-blind mechanism analysis?

M193 does **not** answer whether I6 works, and does not answer whether runtime
diagnosis works.

## 3. The single condition

```
BASELINE_ONLY
```

A strong coding agent with its normal unrestricted tools, on the M192 per-instance
container substrate. No orientation, no MCP, no hook that speaks to the model, no
test recommendation, no forced validation, no workflow mandate. There is no
treatment arm; a comparison is not what is being bought.

**Validation is not required and is not encouraged.** Whether an agent tests at
all is part of the measurement. M191 observed 318 of 807 healthy unguarded arms
attempting validation — 39.4% — and if the rate under a genuinely working
environment turns out to be low, that is a finding, not a problem to engineer
around. No prompt text tells the agent to run tests.

## 4. Model and agent, pinned

| | |
|---|---|
| agent | Claude Code CLI, headless, version `2.1.251` |
| model | `claude-opus-4-5-20251101` |
| max turns | 250 (vexp's shipped default; the most turn-hungry untreated arm on record used 94) |
| tools | `Edit, Write, Bash, Read, Glob, Grep, TodoWrite` — vexp's `DEFAULT_ALLOWED_TOOLS`, unchanged |
| MCP | empty config with `--strict-mcp-config` |
| system prompt | CLI default; no `--append-system-prompt` |
| user prompt | vexp `buildPrompt`, verbatim, copied as literal text into the manifest |
| sampling | temperature not exposed by the CLI; `thinkingBudget = 0`; no `--effort` |

The tool set is not narrowed. M168-E showed that denying `Grep`/`Glob` is itself a
treatment that lost two tasks and won none.

The prompt is copied into the manifest as literal text rather than imported,
because the VEXP checkout it came from is dirty and carries VTRACE's own Stage 5
injection patches; an edit there must not be able to change the acquisition's
prompt silently.

## 5. Task fixture

Frozen at `stage5_m193_task_fixture.json`, 40 instances across all 12
repositories in `swe-bench-100.jsonl`
(sha256 `7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d`).

**Selection rule.** Stratified round-robin: repositories lexicographic,
instances lexicographic within a repository, emitted rank-1-of-every-repository
first, then rank-2, and so on. Every prefix of the ordering is therefore maximally
cross-repository, so a truncated acquisition is still broad, and §32 gets a single
deterministic "next instance" with no analyst discretion.

**Inputs the rule uses:** repository, instance id, dataset membership.
**Inputs it refuses:** gold patch topology, `FAIL_TO_PASS` content, historical
resolution, M189/M190 attention, known multi-file tasks, whether the Docker image
happens to be pulled locally, anything an agent has ever produced.

That last refusal costs something. Only 14 instance images are cached on this
host; the other 26 arms will pull. That is the correct trade: choosing tasks by
what is already on disk would bias the corpus toward environments earlier
milestones happened to touch.

## 6. Size, spend and stopping

Derived in `stage5_m193_spend_model.json` from the **untreated** stratum of
historical baseline arms on the pinned model. This stratification is load-bearing:
of 334 arms sitting in directories named `baseline`, 269 record an injected
tool-use-discipline block or M163 trigger in their own metadata. Their cost is not
baseline cost.

| | untreated stratum, n = 54 |
|---|---|
| median | $0.4440 |
| p90 | $1.2392 |
| p95 | $1.4959 |
| max | $3.0384 |
| mean | $0.6604 |

```
per-run cost cap        $3.50     truncates 0 / 54 untreated arms
                                  and 0 / 334 across every stratum
total spend cap        $90.00
maximum arms               40
minimum arms               20
max concurrent arms         3
```

The per-run cap sits strictly above the most expensive arm ever recorded, so no
run resembling anything observed is truncated. A cap at the untreated p95, or at
vexp's shipped $3.00 default, would have truncated real runs.

Projected total spend: **$26.41** at the untreated mean over 40 arms; $49.57 if
every arm cost p90; $59.83 if every arm cost p95. The $90 ceiling covers the
p95-everywhere case with headroom and binds only on a regression well beyond
anything on record.

**Stopping rule** — `stopDecision()`, outcome-independent:

```
STOP_SPEND_CAP    total spend >= $90
STOP_MAX_ARMS     arms launched >= 40
STOP_TARGET_MET   arms launched >= 20
                  AND >= 12 I6-usable arms
                  AND those span >= 6 repositories
otherwise CONTINUE
```

It cannot see task resolution, whether I6 looks promising, whether runtime
diagnosis looks promising, or whether a preferred mechanism appeared. The minimum
of 20 exists so a lucky early run of usable episodes cannot yield a corpus too
small to describe.

**Sizing sanity.** At M191's healthy-population attempt rate of 39.4%, and with
the repaired substrate starting a runner far more reliably than the host
environment did, 40 arms projects to roughly 15 I6-usable episodes against a
target of 12. That margin is thin, which is why the target is a stopping
condition and the adequacy rule below reports `PARTIAL` honestly rather than
rounding up.

## 7. Corpus adequacy, frozen

Expressed in lifecycle events. Pass rate cannot reach `ADEQUATE` on its own.

| verdict | requires all of |
|---|---|
| `ADEQUATE` | ≥ 12 I6-usable arms, spanning ≥ 6 repositories, with ≥ 30 valid runs |
| `PARTIAL` | ≥ 6 I6-usable arms, spanning ≥ 4 repositories, with ≥ 15 valid runs |
| `INADEQUATE` | anything below `PARTIAL` |

**I6-usable** (frozen now, §43): a valid run, with ≥ 1 source edit, ≥ 1 post-edit
validation attempt, runner-start truth known, a validation event whose provenance
is `EDITED_CHECKOUT_CONFIRMED`, a semantic result that is not `UNKNOWN`, and
ordered trace and diff state preserved. Post-validation revision is deliberately
**not** part of this bar; it is counted separately, so a stronger sub-analysis can
be defined later without moving the definition retroactively.

**Runtime-diagnosis-usable** (§44): a valid run with a source edit, a trustworthy
validation whose semantic result is `FAILED` or `MIXED`, failure evidence and diff
state preserved at the moment of failure, and at least one subsequent observable
agent decision. A capability label only — no hypothesis is being tested and no
instrumentation is added.

## 8. Preflight, replacement, retry

**Preflight** (`run_stage5_m193_preflight.py`) runs before every paid arm, is
deterministic and model-free, and never sees gold data. It checks image
availability, container start, checkout root, base-commit reachability and
checkout, workdir, host-side writability, cross-boundary mutation visibility in
both directions, import resolution under the checkout, provenance robustness, the
execution witness, runner availability, the bytecode-staleness hazard, clean
restoration, and free disk. **A failure means the model is never launched.**

M192 probed one instance per repository. Instance images differ within a
repository, so readiness is re-established per instance rather than inherited.

**Replacement**: `NEXT_IN_FROZEN_ORDER`. A `PREFLIGHT_FAILED` instance is replaced
by the next unattempted instance in the frozen reserve ordering; no manual
selection. A preflight failure costs $0 and so does not consume a live arm slot,
but every failure stays in the ledger with its repository, so a drift toward easy
environments would be readable rather than hidden. Capped at 15.

**Retry**: only `MODEL_SERVICE_FAILURE`, `CONTAINER_INFRA_FAILURE`,
`EVALUATOR_INFRA_FAILURE` and `TELEMETRY_CORRUPT`, at most once, both attempts
kept in the ledger. Not rerunnable: a bad patch, choosing not to test, turn
exhaustion, hitting the cost cap, agent timeout, or the evaluator judging the task
unresolved. Selective reruns of substantive failures would be a treatment.

## 9. Validity is not resolution

A run is `RUN_VALID` when the instance and environment were right, the agent
started, one authoritative checkout was maintained, the treatment audit passed,
telemetry is complete and well-ordered, a final patch was extractable (a truthful
empty patch counts), the official evaluator ran, and nothing terminated on
infrastructure. **A validation attempt is not required.** A valid run may fail the
benchmark, and failed patches are not rerun.

## 10. Frozen exclusions (§49)

`PREFLIGHT_FAILED`, `MODEL_SERVICE_FAILURE`, `CONTAINER_INFRA_FAILURE`,
`TELEMETRY_CORRUPT`, `PATCH_EXTRACTION_FAILURE`, `EVALUATOR_INFRA_FAILURE`,
`TREATMENT_CONTAMINATION`. No exclusion may be invented after seeing outcomes, and
every excluded arm stays visible in the corpus accounting.

## 11. Analysis boundary

M194 may execute this manifest after explicit authorisation, ingest the artifacts
through the frozen classifier, and report the preregistered accounting. M194 may
not perform I6 mechanism analysis, may not perform runtime-repair analysis, may
not reopen I5, may not add or remove instances, and may not relax preflight, caps
or the stopping rule.

If a classifier defect is found after live data exists, the defect, the corrected
code, and the before/after counts for every affected arm must be reported
together, and the synthetic fixtures must gain a case reproducing the defect.

## 12. What M193 spent, honestly

The acquisition design cost **$0** in live model spend: no agent ran on any
benchmark task, and the dry run contains no LLM call.

Separately, and against §6, **one accidental live model call was made during this
milestone** — a `claude -p "say OK"` issued in `/tmp` to test whether the CLI
still accepts `--max-turns`, which should have been answered by inspecting the
binary. It cost **$0.1204** (20 input, 62 output, 27,226 cache-read, 16,822
cache-write tokens). It touched no benchmark repository, produced no outcome-like
evidence, and influenced neither the fixture, the caps, nor the classifier — but
§6 admits no de minimis exception and it is recorded here rather than rounded off.

## 13. Ordering of this milestone's own work

The classifier, the synthetic fixtures and their frozen expectations were written
before any dry-run artifact existed. The task fixture derives from the dataset
alone; the caps derive from historical untreated arms; neither derives from
anything M193 produced. Containers were started during M193 to build and verify
the harness, which is what §29 asks for — but no live result of any kind, from any
agent, informed the frozen design.
