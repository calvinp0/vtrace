# M214 — Baseline vs VTRACE causal preregistration, with the VEXP published result as an external reference

## 1. Executive verdict

```text
M214 — INCOMPLETE
TWO_ARM_CAUSAL_BENCHMARK_PREREGISTERED
EXTERNAL_VEXP_REFERENCE_FROZEN
TASK_POPULATION_FROZEN
RUN_MANIFEST_FROZEN
ANALYSIS_PLAN_FROZEN
STOPPING_RULE_FROZEN
PATCH_CAPTURE_REPAIR_VERIFIED
M214_SCOPED_TYPECHECK_VERIFIED
M214_FALSIFICATION_SUITE_PASSED
M213_PREREGISTRATION_UNMODIFIED
PAID_RUNS_NOT_STARTED
PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY
```

`INCOMPLETE`, not `PASS`, because launch readiness was a stated M214 objective and
one gate is genuinely not closed: **no launch executor exists**. The design is
finished — all 30 preregistration gates pass, 58 of 58 falsification controls are
satisfied, and both harness asymmetries M213 found are repaired and the repair is
demonstrated on real repositories. What does not exist is the component that would
create the containers, run the per-run lifecycle and bind this preregistration's
hash before the first paid call. M213 listed building it as outstanding
infrastructure work; M214's commit structure does not include it.

`preregistrationComplete = true`, `launchAuthorized = false`. Those are two
different facts and the gate table now says which is which.

```text
preregistration hash   3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4
run manifest hash      549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1   (200 rows)
external reference     822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b

benchmark-task live-agent runs   0
live model spend                 $0
src/ product changes             0
```

## 2. Starting repository state

Recorded mechanically before anything was modified:

```text
git branch --show-current          main
git rev-parse HEAD                 28c8a03442d3e5ceb2962cb238e926151f6d7790
git rev-list --left-right --count  0  229        (origin/main ... HEAD)
git diff --check                   clean
git status --short                 213 entries, of which 2 tracked:
                                     M results/stage5_outcome_ledger.json
                                     M results/stage5_outcome_ledger.md
```

Both tracked-dirty files predate this milestone and were not touched. The 211
untracked entries are historical benchmark output and working documents; none was
staged. No `git reset --hard`, no `git clean`, no worktree removal, no push.

The treatment's identity is frozen at the **src tree**, not only the commit:

```text
git rev-parse HEAD:src              b3b3e439f10c6c526cafc6001d25dd0e7552ce6d
git rev-parse a4cd9122:src          b3b3e439f10c6c526cafc6001d25dd0e7552ce6d   (M213)
```

Identical. That is what lets M213's twelve-repository executability evidence
transfer to M214 without re-running it, and it is a stronger pin than a commit
SHA, which moves on every benchmark-only commit.

## 3. Why M214 exists

M213 preregistered the ideal experiment — baseline, VTRACE and VEXP under one
identical harness — and then found the third arm unrunnable. Its blockers, carried
forward verbatim and not softened:

- the installed CLI (2.0.24) refuses every invocation with an update-required notice, so no VEXP command can run on this host as it stands
- no licence is present in `~/.vexp`, so the effective plan is FREE
- the free plan admits 1 repository, and the frozen population spans 12
- the free plan caps the graph at 2,000 nodes, and the largest repository in the population (django/django) carries 41,032 indexed symbols
- the platform core binary (`@vexp/core-<platform>`) is not installed, and it is the component that both indexes and enforces the plan

```text
VEXP_TREATMENT_NOT_EXECUTABLE
```

That is a procurement and licensing fact, not a VTRACE engineering defect. M214
does not work around it, does not imitate VEXP, and does not substitute a
VTRACE-authored reconstruction of VEXP for the real product.

## 4. M213 immutability and lineage

| property | value |
| --- | --- |
| parent experiment | `VTRACE_VEXP_CAUSAL_100` |
| parent verdict | M213 — INCOMPLETE |
| parent arms / intended runs | 3 / 300 |
| parent hash, recorded | `5d90eddb9cc4759acf6a6fbc033d54ee0d5aea589a92c169daa7dca8d9c568c8` |
| parent hash, recomputed from committed bytes | **matches** |
| parent `armCount` still 3 | yes |
| parent `launchAuthorized` still false | yes |
| M214 hash | `3cd3b3d2…8dcbfea4` |

M214's digest is **domain-separated** by its experiment name: the hash input is
`"VTRACE_EXTERNAL_VEXP_100\n"` followed by the canonical JSON. Even a hypothetical
M214 document identical to M213's would hash differently, so the two experiments
can never be confused by digest and a launch harness that verifies the wrong one
fails closed. That makes "do not reuse M213's hash" a structural property rather
than a promise.

M213's artifacts were read and never written. F1 exercises this: mutating the
committed document to `armCount: 2` makes the guard fire; the committed bytes make
it silent.

## 5. Frozen task population

```text
artifact   /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl
sha256     7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d
vendor     Vexp-ai/vexp-swe-bench @ 880e486 (checkout d658e345)
instances  100 across 12 repositories
median complexity 22, ceiling 247
```

Verified again mechanically: 100 instances, all twelve repositories present, the
per-repository distribution matching the vendor's published `docs/TASK_SELECTION.md`
table exactly, the documented complexity ceiling respected, and the digest matching.

The population is inherited by **importing M213's loader and digest constant**
rather than re-declaring them, so "the exact same 100 tasks" is a mechanical fact
about one code path, not a claim two modules could drift apart on.

## 6. The vendor's script does not reproduce the vendor's subset

Re-derived by M214 rather than transcribed from M213, by running the vendor's own
`scripts/select-subset.py` unmodified, under their own venv interpreter, against
SWE-bench Verified materialised from the local HuggingFace cache (500 rows):

```text
overlap with the shipped artifact       22 / 100
tasks a script-based reproduction would run instead   78
rows passing the documented complexity ceiling (≤250) 494 of 500
```

| repository | script | artifact |
| --- | ---: | ---: |
| django/django | 42 | 44 |
| sympy/sympy | 14 | 17 |
| scikit-learn/scikit-learn | 6 | 2 |
| sphinx-doc/sphinx | 8 | 7 |
| matplotlib/matplotlib | 5 | 7 |
| pydata/xarray | 4 | 6 |
| psf/requests | 5 | 4 |
| pytest-dev/pytest | 5 | 4 |
| pylint-dev/pylint | 3 | 2 |
| mwaskom/seaborn | 2 | 1 |

The script also omits the `complexity ≤ 250` filter its own documentation lists as
step 1.

```text
EXACT_VEXP_SUBSET_AVAILABLE_AS_ARTIFACT
EXACT_VEXP_SUBSET_NOT_SCRIPT_REPRODUCIBLE
```

This is load-bearing for the external comparison: anyone who "reproduces VEXP's
subset" from the published script benchmarks a different 78 tasks and cannot
legitimately compare against the published 73/100. M214 freezes the artifact,
which is the population that number was computed on. The script-derived id list is
committed as `stage5_m214_vendor_script_subset.json` and is the wrong artifact that
falsification control F2 swaps in.

## 7. Experiment identity

```text
name          VTRACE_EXTERNAL_VEXP_100
seed          M214-VTRACE-EXTERNAL-VEXP-100-v1
arms          2
tasks         100
planned runs  200
```

Distinct from M213's blocked three-arm `VTRACE_VEXP_CAUSAL_100` in name, seed, arm
structure, run count and hash.

## 8. Arm definitions

| | Arm A — BASELINE | Arm B — BASELINE + VTRACE |
| --- | --- | --- |
| native tools | Edit, Write, Bash, Read, Glob, Grep, TodoWrite | identical |
| MCP servers | none | `vtrace` |
| treatment tools | none | 14, the product default |
| treatment instruction | none | none |
| `.vtrace` in workspace | forbidden | created by treatment setup |
| `.vexp` in workspace | forbidden | forbidden |
| `VTRACE_*` / `VEXP_*` env | forbidden | `VEXP_*` forbidden |
| agent, model, prompts, budgets, container, evaluator | one frozen record | the same record |

Everything except VTRACE exposure is the *same object*, not a copy: the native
tools, agent, model and budget are shared frozen constants, so an arm-specific
value cannot be expressed without editing the preregistration and changing its hash.

Neither arm carries a treatment instruction. Telling the VTRACE arm to "always use
VTRACE first" would measure a mandate rather than a product, and M169 already
established that mandatory invocation is not licensed; the intended production
integration is a tool the agent may call, so that is what is exposed.

## 9. Agent identity

```text
implementation   Anthropic Claude Code CLI, headless
version          2.1.260   (present on this host; asserted before every run)
system prompt    CLI default; no --append-system-prompt, no --system-prompt
user prompt      vexp-swe-bench src/harness/loader.ts buildPrompt, verbatim
output format    stream-json --verbose
turn loop        the CLI's own, unchanged
```

One implementation for both arms. There is no baseline agent and no
VTRACE-specialised agent.

## 10. Model identity

```text
provider    Anthropic
model       claude-opus-4-5-20251101
alias       claude-opus-4-5
thinking    0
temperature provider default (not exposed by the CLI)
```

**Availability, established without spending.** M213 recorded this as "not
verified" because verifying it requires a paid call. M214 gets closer at zero cost:
Claude Code 2.1.260's own bundled model registry carries a complete entry for
`claude-opus-4-5` — first-party id `claude-opus-4-5-20251101`, a 200,000-token
window, `pricing: tier_5_25`, provider ids across all five routes, `max_output_tokens`
32,000/64,000 — sitting beside newer families with **no deprecation, retirement or
sunset marker**. Classified honestly:

```text
PRESENT_IN_AGENT_MODEL_REGISTRY_NOT_PROVIDER_CONFIRMED
```

The residual — a provider round trip — is closed by the launch harness reading the
provider-returned identity from each run's own `init` event, which is the first
moment it can be closed without spending. If the identity ever differs from the
pin, the cohort stops; runs from before and after are never mixed.

If the model turns out to be unavailable at launch, the **causal** experiment is not
cancelled: baseline vs VTRACE remains valid under any single model used identically
by both arms. What weakens is the external comparison, and pinning a different model
must be recorded as a `DIFFERS` row before any run.

## 11. Published-condition match matrix

| condition | VEXP published | M214 | match |
| --- | --- | --- | --- |
| task artifact | `data/swe-bench-100.jsonl` @ 880e486 | the identical file, sha256-pinned | **MATCH** |
| model | Claude Opus 4.5 | `claude-opus-4-5-20251101` | **MATCH** |
| agent | Claude Code | Claude Code CLI 2.1.260, headless | **APPROXIMATE** |
| turn cap | 250 | 250 | **MATCH** |
| cost cap | $3/task | $3.50/task | **DIFFERS** |
| container / evaluator | not published | swebench 4.1.0, one container per run | **UNKNOWN** |
| network policy | not published | the container's own posture, identical in both arms | **UNKNOWN** |
| native tool catalogue | not published | Edit, Write, Bash, Read, Glob, Grep, TodoWrite | **APPROXIMATE** |
| repetitions per task | pass@1, not stated | one run per arm per task | **UNKNOWN** |

Four rows are UNKNOWN and one DIFFERS, so the honest label is

```text
same-task published-condition external replication
```

and never "exact VEXP replication", "head-to-head benchmark against VEXP", or
"apples-to-apples comparison with VEXP". Those four phrases are enumerated in the
preregistration as refused, and the wording auditor rejects the sentences that
would use them.

The cost-cap row is the one deliberate difference, and it is stated rather than
buried: $3.00 truncates real runs on this model (the most expensive arm ever
recorded cost $3.0384), so both arms get $3.50. The causal comparison is unaffected
because both arms share the raised cap; the external comparison inherits a small
upward bias in our favour, and is reported with that said.

## 12. Budget object

```text
max turns                   250
per-run cost cap            $3.50
wall clock per run          3600 s
tool call timeout           600 s
repository command timeout  600 s
intended runs               200
total spend cap             $700
budget identity             bf705ec05d41d8f9
```

One object, shared by both arms, carried as a **digest on every manifest row** — so
two rows agreeing on `maxTurns` and `perRunCostCapUsd` is not enough; the timeouts
are in the digest too. There is no per-arm budget field, and no treatment-specific
grace.

**What the cap counts** (frozen now, because "did the treatment cost more?" has a
different answer depending on it): provider-reported model cost for the agent run,
and nothing else. Setup is not counted — VTRACE index construction runs before the
agent starts and consumes no model tokens, and charging it to the model budget would
let a cheap local computation shrink one arm's turn budget. Cached input is counted
because the provider bills it. Tool CPU is not. A provider-side retry that produced
billed tokens is counted; a harness relaunch after infrastructure failure starts a
new row. Index build time and size are reported as separate numbers and are never
summed into a cost-per-task in either direction.

## 13. Native tools

`Edit, Write, Bash, Read, Glob, Grep, TodoWrite` — vexp-swe-bench's shipped
`DEFAULT_ALLOWED_TOOLS`, identical in both arms. Neither arm is narrowed: M168-E
measured that denying `Grep`/`Glob` is itself a treatment that lost two tasks and
won none, so the question here is whether VTRACE helps a competent native-search
agent, not whether it can replace grep.

## 14. VTRACE treatment catalogue

Read from the product at generation time via
`defaultMcpToolRegistry.listMetadata()` — the exact surface `vtrace mcp-serve --repo
<workspace>` serves with no `--tools` flag — and asserted equal to the frozen list.

```text
get_code_context   run_pipeline        index_repo         check_capsule_staleness
get_context_capsule get_impact_graph   search_logic_flow  get_skeleton
index_status       workspace_setup     get_session_context search_memory
save_observation   expand_vexp_ref
```

Each tool's description and input-schema digest and its required inputs are recorded
in the preregistration, so a reworded description after the first paid run changes
the treatment identity visibly.

**The §11 audit question — are any of these internal benchmarking or debug tools
exposed merely because they exist? — answers no.** All fourteen carry task-facing
descriptions addressed to a coding agent, not to a benchmark. The registry already
hides its non-default surface (`search_symbols`, `build_capsule`, `build_handoff`,
`route_query` and the rest remain resolvable by exact id and absent from
`tools/list`), and M214 exposes none of it. Nothing is added for the benchmark and
nothing is removed for it: the treatment is the product default or it is not the
product.

## 15. Baseline contamination protection

`auditBaselineIsolation` fails the baseline arm on any of: a configured MCP server,
a model-visible tool outside the native seven, a `VTRACE_`/`VEXP_`-prefixed
environment variable, `.vtrace` or `.vexp` anywhere at the workspace root (checked
by path prefix, so `.vtrace/index.sqlite` is caught as well as `.vtrace`), an
injected context document, a reachable treatment daemon socket, or a system-prompt
appendix. It also fails a baseline that is **missing** a native tool — a narrowed
control is as much a confound as a widened one.

The baseline workspace is never indexed. F3 injects all of it at once and the guard
fires; F3_CLEAN confirms a compliant baseline is silent.

On the CLI binary: the launch harness keeps it out of the baseline image, and the
guard records the fact rather than depending on it. An installed-but-uninvoked
binary with no daemon, no MCP configuration and no state directory leaves the agent
no VTRACE information to find, but stronger isolation is cheap and is preferred.

## 16. VTRACE indexing and source-state protection

Treatment initialisation may create untracked metadata; it may not mutate tracked
source. Measured on both sides of initialisation:

```text
trackedSourceDigestBeforeTreatment  7f4d4083…c5eb1874
trackedSourceDigestAfterTreatment   7f4d4083…c5eb1874     identical
```

on both probe routes, consistent with M213's measurement across all twelve
population repositories. F5 injects a digest change and the guard fires.

The per-run assertion — that each of the 200 runs starts at the frozen base commit
with the canonical tracked source — is gate **G14**, classified RUNTIME and deferred
to the launch executor, which will call `auditSourceStateEquivalence`. Deferral is
recorded as a commitment with an address, not as a gap.

## 17. Patch capture repair

### 17.1 The defect, reproduced

The vendor harness's own pathspecs, extracted from its shipped JavaScript rather
than transcribed:

```text
capturePatch excludes : .bench-mcp-config.json, .claude, .vexp
clean preserves       : .bench-mcp-config.json, .claude, .vexp
```

`.vtrace` appears in neither. Reproduced on two real Git repositories with a real
VTRACE index over each, running both capture mechanisms against the same working
tree:

| initialisation route | vendor capture, no source change | derived capture, no source change | derived capture, one edit |
| --- | --- | --- | --- |
| `init_then_index` | 0 bytes (empty) | 0 bytes | `pkg/core.py` |
| `index_only` | **6,378 bytes** over `.vtrace/index.meta.json`, `.vtrace/index.sqlite`, `.vtrace/session.sqlite` | 0 bytes | `pkg/core.py` |

The three leaked paths are exactly the three M213 named on its flask checkout, where
the same defect produced 105,321 bytes.

### 17.2 A finding M214's own probe forced

The first run of the probe produced 0 bytes on *both* mechanisms, which looked like
the defect had evaporated. It had not:

> **`vtrace init` appends `/.vtrace/` to `.git/info/exclude`. `vtrace index` alone
> does not.**

With that entry present, `.vtrace` is invisible to `git ls-files --others
--exclude-standard` and to `git add -A`, and the vendor's hardcoded list happens to
be harmless. With it absent, every `.vtrace` file is captured as agent output. So
whether the competitor's harness would have polluted every VTRACE-arm patch depended
on **which entry point happened to initialise the treatment** — a benchmark whose
fairness turns on that is not fair, and neither outcome was anyone's design.

This forced a real change to the guard. "Is the treatment state excluded?" has two
correct answers, and a guard accepting only one of them would either fail a
compliant run or pass a broken one:

```text
DERIVED_SNAPSHOT_EXCLUSION   the path was in the pre-agent snapshot
NOT_ENUMERABLE_BY_GIT        git cannot enumerate it at all
UNCOVERED                    enumerable and missing from the snapshot  → fails
```

Both routes are accepted and **recorded**; neither is trusted. Relying on
`NOT_ENUMERABLE_BY_GIT` alone would mean relying on the treatment to keep writing a
git exclude entry for itself, which is a courtesy no benchmark's fairness should
depend on.

### 17.3 The repair

```text
the agent's patch  =  what changed, minus what was already there before the agent started
```

No product name appears in that rule. `.vtrace` is excluded because it was present
at the snapshot, exactly as `.vexp` would be, exactly as a treatment invented
tomorrow would be. Mechanically: `git diff --no-renames HEAD` for tracked bytes plus
a `git ls-files --others --exclude-standard` untracked lane, both restricted by a
pathspec derived from the snapshot. It never stages and never resets, so unlike the
vendor's `git add -A` → `git diff --cached` → `git reset` it does not destroy the
agent's index while measuring it.

Both falsifiable properties hold on both routes:

```text
no-source-change run  →  EMPTY source patch
one-file-edit run     →  exactly that one file, nothing else
PATCH_CAPTURE_REPAIR_VERIFIED
```

The hardcoded-list auditor reports a hardcoded list as a defect **even when the list
is complete**, because completeness today is not the property that matters.

## 18. Reset and warm-index policy

```text
regime                          COLD_UNIFORM
survives between runs           nothing, for either arm
index built before agent start  yes
index build charged to model budget   no
baseline is ever indexed        no
```

Every run gets a fresh container and a fresh checkout, so nothing survives *by
construction* rather than by a clean rule someone has to maintain. The product-use
scenario this matches is an agent arriving at a repository it has not indexed —
which is what a SWE-bench instance is.

`.vtrace` persistence is never a side effect of a generic `git clean`: the policy
states that nothing persists, for either arm, instead of letting clean flags imply
it. The generic form of the vendor's defect is checked without naming a vendor —
under a cold policy a reset may not preserve *any* treatment state — and the
vendor's `-e .vexp` fails it (F20). A preserve list that differs *between arms* is
rejected separately (F19), even when nothing was actually inherited, because the two
have different fixes.

**Lifecycle order**, executed on real repositories by the probe and audited from the
trace it emitted rather than asserted from the constant:

```text
CONTAINER_START
SOURCE_CHECKOUT_AT_BASE_COMMIT
SOURCE_STATE_DIGEST_BEFORE_TREATMENT
TREATMENT_INITIALISATION
SOURCE_STATE_DIGEST_AFTER_TREATMENT
PRE_AGENT_UNTRACKED_SNAPSHOT      ← after initialisation; this is what makes G16 hold
AGENT_RUN
PATCH_CAPTURE
EVALUATION
```

Reordering the snapshot before initialisation makes `auditLifecycleOrder` fire by
name (F26). This closes what M213 had to leave open as "a property of a launch
harness that does not exist yet": the *ordering* is now executed and verified, even
though the container-side executor still is not.

## 19. Run manifest

200 rows, all `PLANNED`, generated before any execution, hashed
`549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1`.

Each row carries `runId`, `instanceId`, `repo`, `baseCommit`, `arm`, `pairedTaskId`,
`armOrder`, `armOrderIndex`, `executionOrder`, `seed`, `agentVersion`, `model`,
`vtraceCommit`, `vtraceProductTreeSha`, `containerImage`, `budgetIdentity`,
`maxTurns`, `perRunCostCapUsd`, `status`.

There is **no VEXP row**. The vendor's published result is not a run: it has no
container, no budget and no execution order, and giving it a manifest row would be
the first step toward its appearing in a paired table. It lives in
`stage5_m214_external_reference.json`.

## 20. Execution-order randomisation

```text
seed      M214-VTRACE-EXTERNAL-VEXP-100-v1
method    rank by sha256(seed + " " + instance_id); rank parity selects the order
balance   baseline>vtrace  50
          vtrace>baseline  50
```

Exactly 50/50. The ranking is arbitrary with respect to repository, difficulty and
every historical outcome, so provider drift, machine load and cache effects cannot
align with the arm under test. Baseline is never systematically first.

## 21. Primary causal estimand

```text
ΔVTRACE = outcome(VTRACE) − outcome(BASELINE),  on paired tasks
```

Two-sided. M183 observed exact resolution parity on 30 paired tasks, so a one-sided
favourable hypothesis is not supported by anything this programme has measured.

The comparator is **our own baseline, run in this harness**. `VTRACE − 73` is not a
causal quantity: without a matched baseline, an absolute pass rate above or below 73
could equally reflect our harness, our agent version or our container substrate.
The baseline arm is mandatory and is never skipped.

## 22. Primary statistical analysis

Paired; both arms on the same 100 tasks. Exact McNemar (binomial) on discordant
pairs, with a 95% paired bootstrap CI (10,000 resamples, resampling by task so both
arms of a task move together).

Always reported, whether or not any p-value crosses a threshold: both resolved,
VTRACE only, baseline only, neither, baseline pass rate, VTRACE pass rate, absolute
paired delta, discordant count difference, exact McNemar p-value, 95% bootstrap CI.

`p < 0.05` is not the definition of success. Absolute delta, discordant counts and
interval width are reported first; a +1/100 and a +10/100 result are described
differently even when neither is conventionally significant.

Refused: changing the analysis after seeing outcomes; reporting aggregates without
the paired table; choosing the highlighted efficiency metric after seeing which one
favours an arm; pooling with M183; computing any paired statistic against the
vendor's published number.

## 23. Secondary token and cost metrics

Input, output, cached and total model tokens; provider-reported cost; turns;
wall-clock. Paired differences reported with **median and mean both**, each with a
95% paired bootstrap CI — M174 showed a two-run tail can carry 95.7% of a cost
premium, and a mean alone would have hidden it. Cost is deduplicated on
`message.id`, because M169 found the raw row token fields inflated by re-counting
streamed messages.

Index build wall-clock, index size on disk and summed treatment latency are reported
separately and never folded into model cost.

## 24. Tool-use metrics

Native search calls, glob/find invocations, file reads, git commands, test
executions, files inspected, files edited; turn of first edit; turn of first read of
a file the gold patch touches.

Gold-relative timing is computed after the fact from the frozen dataset. The
eventual outcome never classifies pre-decision relevance — M185 and M189 both showed
that letting it do so manufactures an effect. Gold patches, gold file lists and
FAIL_TO_PASS never enter any agent's context; F22 injects them and the guard fires.

## 25. ITT policy

Primary analysis is **intention-to-treat**: every launched valid run is analysed
under its assigned arm. Treatment uptake — exposed, invoked, first-invocation turn,
invocation count, tools used, tokens returned, latency, invoked before first edit —
is recorded and analysed as a mediator, and never conditions the primary comparison.

A run where VTRACE was exposed and never invoked **stays in the VTRACE arm** (F15
confirms it is a valid, issue-free run). Non-use is a consequence of the treatment;
dropping those runs would convert an ITT estimate into a self-selected one that can
only flatter the treatment.

A VTRACE initialisation failure is never silently converted to a baseline run. If
the surface did not come up, the run is excluded as
`TREATMENT_INITIALISATION_FAILURE` before the model is called and stays visible in
the accounting with its arm and repository. A failure discovered *after* the model
started is retained under ITT and flagged treatment-invalid.

## 26. Invalid-run policy

Legitimate (infrastructure) exclusions, frozen: `CONTAINER_CANNOT_START`,
`SOURCE_REVISION_UNAVAILABLE`, `BENCHMARK_INSTANCE_MALFORMED`,
`ENVIRONMENT_IRREPRODUCIBLE`, `TREATMENT_INITIALISATION_FAILURE`,
`AGENT_INFRASTRUCTURE_FAILURE_BEFORE_TREATMENT_EXPOSURE`, `MODEL_SERVICE_FAILURE`,
`MODEL_IDENTITY_DRIFT`, `PATCH_EXTRACTION_FAILURE`, `EVALUATOR_INFRA_FAILURE`,
`TELEMETRY_CORRUPT`, `TREATMENT_CONTAMINATION`, `ARM_CONFIGURATION_WRONG`.

Never exclusions: the agent failed the task; never used VTRACE; made a bad patch;
ran out of turns; hit the cost cap; a test failed; produced no patch; the run was
expensive; the task is hard; the task is a known VTRACE loss; the run is
inconvenient. A test asserts that no never-exclusion also appears as a legitimate
category.

An exclusion removes one **run**, not the task. A task with one valid arm
contributes to neither the paired table nor either pass rate and is reported as an
incomplete pair with its reason. Retries are limited to four infrastructure
categories, at most two attempts, and both attempts stay in the ledger.

## 27. Fixed-N stopping

100 tasks × 2 arms = 200 outcome-bearing runs. No interim analysis, no adaptive
continuation, no early stop. Refused as inputs to stopping: VTRACE looks neutral /
winning / losing; token savings look obvious; an early p-value crossed a threshold;
the discordant table looks favourable; the absolute pass rate already exceeds 73.

The only legitimate early termination is **abandonment** — discarding the cohort on
a comparability-invalidating defect and restarting from zero under a new
preregistration hash. Favourable partial results are never retained. The $700 total
cap is an infrastructure guard: if it binds, the cohort is incomplete and is
reported as incomplete.

## 28. External VEXP reference

| property | value |
| --- | --- |
| evidence class | `EXTERNAL_VENDOR_REFERENCE` |
| system | vexp + Claude Code |
| published pass@1 | **73 / 100** |
| published $/task | **$0.67** |
| published model | Claude Opus 4.5 |
| published turn budget | 250 |
| published cost limit | $3/task |
| repositories represented | 12 |
| per-task outcomes published | **no** |
| task artifact | `7bd07d5e…53971d7d` |
| snapshot hash | `822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b` |

Sources, each pinned to a vendor commit and a file digest so "what the vendor
published" is a fact about bytes rather than a recollection of a web page:

- `README.md` @ `d658e3457b82` (sha256 `e743e1483aa24a92…`), retrieved 2026-09-04 —
  `| **vexp + Claude Code** | **73.0%** | **$0.67** | 7–10 |`
- `README.md`, same commit — "All agents use Claude Opus 4.5 for a fair,
  apples-to-apples comparison."
- `README.md`, same commit — "The defaults are aligned with mini-SWE-agent v2: 250
  turns, $3/task cost limit, no global timeout."
- `docs/TASK_SELECTION.md` @ `d658e3457b82` (sha256 `6718013fcf3873d9…`) — the
  per-repository distribution of the published subset.

Recorded caveats: VEXP was not executed in the M214 harness; no per-task VEXP
outcomes are published, so no paired table against it can exist even in principle;
M188 found their benchmark contains no orientation intervention it could identify
(their `buildPrompt` injects nothing and their tool fired on 5 of 100 tasks), so
the published 73/100 is not itself clean causal evidence for the VEXP treatment;
their agent version, container substrate, network policy and repetitions per task
are all unknown.

If the vendor changes their site or repository later, M214 stays tied to **this**
snapshot. F24 edits the published score and the snapshot guard fires; a moved vendor
number requires a new preregistration, not a silent update.

## 29. External-comparison language

The separation is enforced in code, not by convention, because the realistic failure
is not a bad intention — it is a correct analysis rendered into a table with one row
too many.

- `auditPairedComparison` accepts only the two executed arms as operands. Passing
  the external reference is rejected, and so is a bare `"vexp"` string with no
  evidence class attached.
- `auditCausalTableMembership` rejects any row carrying `EXTERNAL_VENDOR_REFERENCE`.
- `auditEvidenceClassLabel` rejects relabelling it "experimental arm", "Arm C",
  "third arm", "paired observation", "causal head-to-head result", and others.
- `auditExternalComparisonWording` rejects "VTRACE beat(s) VEXP", "outperformed
  VEXP", "VTRACE vs VEXP", "we beat VEXP", "head-to-head"/"apples-to-apples" with
  VEXP, and "exact replication"; and **requires** a cross-study qualifier in any
  passage that puts a number of ours beside the vendor's.
- `renderExternalComparison` generates the published sentence, so the qualifier
  cannot be forgotten, and its output is checked by the same auditor — the
  discipline is exercised on the real text, not only on fixtures.

**Permitted** (both directions, in the same voice):

> VTRACE achieved 76% on the exact published task population, compared descriptively
> with VEXP's published 73%. This 3-point cross-study difference is not a causal
> head-to-head comparison.

> VTRACE's observed absolute pass rate was 3 points below VEXP's published result;
> because the systems were not run in the same harness, this difference is
> descriptive rather than causal.

**Forbidden**: "VTRACE beats VEXP by 3%."

The causal sentence is chosen by the sign of the delta and nothing else, and never
mentions the vendor:

```text
Δ > 0   VTRACE improved resolution relative to its matched baseline by Δ on this frozen population.
Δ = 0   No resolution benefit was observed relative to the matched baseline.
Δ < 0   VTRACE reduced resolution relative to the matched baseline under these conditions.
```

Six outcome interpretations are frozen before any outcome exists, including the two
the programme would rather not have and the two that are easy to misreport — an
absolute rate above 73 with a zero causal delta says something about our substrate
and **nothing** about VTRACE; a positive causal delta below 73 means both things are
true and neither cancels the other.

## 30. Falsification F0–F27

**58 of 58 controls satisfied.** F1–F24 are the prompt's; F25–F27 are additions
M214's own audit forced. Every `GUARD_FIRES` control fires with a specific message,
and every `GUARD_SILENT` negative control is silent — a suite without those would
be passed by a guard that rejects everything.

| control | what it breaks | expectation |
| --- | --- | --- |
| `F0_CLEAN_BASELINE` / `F0_CLEAN_VTRACE` | nothing | silent |
| `F0_CLEAN_TASKSET` / `_RANDOMIZATION` / `_HASHES` / `_LIFECYCLE` | nothing | silent |
| `F1` | M213's artifact edited to `armCount: 2` | fires |
| `F1_CLEAN` | committed M213 bytes, M214 hash distinct | silent |
| `F2` | the vendor selection-script subset swapped in | fires |
| `F2_ARTIFACT` | a task artifact with the wrong digest | fires |
| `F2_CLEAN` | the frozen artifact | silent |
| `F3` | VTRACE server, tool, env var, `.vtrace`, daemon socket in baseline | fires |
| `F3_CLEAN` | an isolated baseline | silent |
| `F4` | `.vtrace` files in the captured patch | fires |
| `F4_HARDCODED` | the vendor's real hardcoded list | fires |
| `F4_ORDERING` | snapshot taken before treatment init | fires |
| `F4_CLEAN` / `F4_ORDERING_CLEAN` / `F4_NOT_ENUMERABLE_CLEAN` | the three compliant cases | silent |
| `F5` | tracked source mutated during indexing | fires |
| `F5_CLEAN` | observational indexing | silent |
| `F6` | VTRACE arm given 400 turns | fires |
| `F6_MANIFEST` | two budget identities in one manifest | fires |
| `F6_CLEAN` | the frozen manifest | silent |
| `F7` | `Grep` removed from the baseline | fires |
| `F8` | model changed to `claude-opus-5` | fires |
| `F9` | system-prompt appendix + altered user prompt | fires |
| `F10` | VTRACE commit and product tree changed | fires |
| `F11` / `F11_REMOVED` | one task added / removed | fires |
| `F12` / `F12_SEED` | arm orders / seed changed | fires |
| `F13` | finalising at 148 of 200 runs | fires |
| `F13_CLEAN` | a complete cohort | silent |
| `F14` | excluding `AGENT_FAILED_TASK` | fires |
| `F14_UNUSED` | excluding `TREATMENT_NEVER_INVOKED` | fires |
| `F14_CLEAN` | `CONTAINER_CANNOT_START` | silent |
| `F15` | VTRACE exposed, never invoked | **silent — a valid ITT run** |
| `F16` | 73/100 passed to the paired-comparison entry point | fires |
| `F16_TABLE` | external row added to the causal table | fires |
| `F16_CLEAN` | baseline vs VTRACE | silent |
| `F17` | reference labelled "Arm C — experimental arm" | fires |
| `F17_WORDING` | "VTRACE beat VEXP by 3 points" | fires |
| `F17_CLEAN` | the generated sentence, audited | silent |
| `F18` | reference applied to a different artifact | fires |
| `F19` | one arm warm under COLD_UNIFORM | fires |
| `F19_CLEAN` | a uniformly cold cohort | silent |
| `F20` | the vendor's `-e .vexp` preserve list | fires |
| `F20_CLEAN` | a reset preserving no treatment state | silent |
| `F21` | a type error injected into an M214-owned file | fires |
| `F22` | gold patch + FAIL_TO_PASS in agent context | fires |
| `F23` | VTRACE run seeded from the baseline transcript and patch | fires |
| `F24` | published score edited after the snapshot | fires |
| `F24_CLEAN` | the frozen snapshot | silent |
| `F25_ARM_CROSS_CONTAMINATION` | `.vexp` and `VEXP_LICENSE` in the VTRACE arm | fires |
| `F25_CLEAN` | a compliant VTRACE arm | silent |
| `F26_LIFECYCLE_ORDER` | snapshot reordered before treatment init | fires |
| `F27_EXTERNAL_HASH_STABLE` | the recorded external digest | silent |

The suite is itself falsifiable: a test injects a tampered preregistration hash, a
vendor list that already excluded `.vtrace`, a symmetric vendor clean policy, a
scoped typecheck that misses its injected error, and a script subset that happened
to match — and asserts the corresponding control becomes unsatisfied in each case.

## 31. Launch gates

30 of 32 pass. **All 30 preregistration gates pass.**

| gate | class | status | requirement |
| --- | --- | --- | --- |
| G1 | PREREG | PASS | M214 preregistration committed |
| G2 | PREREG | PASS | M214 preregistration hash recorded |
| G3 | PREREG | PASS | M213 remains immutable |
| G4 | PREREG | PASS | exact VEXP 100-task artifact verified |
| G5 | PREREG | PASS | 100 task ids frozen |
| G6 | PREREG | PASS | 200-run manifest frozen |
| G7 | PREREG | PASS | baseline is treatment-free |
| G8 | PREREG | PASS | VTRACE treatment executable (12/12 repositories, tree unchanged) |
| G9 | PREREG | PASS | VTRACE identity frozen (commit + src tree) |
| G10 | PREREG | PASS | agent identity frozen |
| G11 | PREREG | PASS | model identity frozen |
| G12 | PREREG | PASS | native tools identical across arms |
| G13 | PREREG | PASS | budgets identical across arms |
| **G14** | **RUNTIME** | **DEFERRED_TO_LAUNCH** | source states equivalent before each arm starts |
| G15 | PREREG | PASS | indexing is observational on tracked source |
| G16 | PREREG | PASS | `.vtrace` excluded from patch capture |
| G17 | PREREG | PASS | metadata reset / warm policy symmetric and verified |
| G18 | PREREG | PASS | execution-order randomisation frozen |
| G19 | PREREG | PASS | evaluator validated (swebench 4.1.0) |
| G20 | PREREG | PASS | primary paired analysis frozen |
| G21 | PREREG | PASS | efficiency analysis frozen |
| G22 | PREREG | PASS | invalid-run rules frozen |
| G23 | PREREG | PASS | fixed-N stopping frozen |
| G24 | PREREG | PASS | external VEXP reference frozen |
| G25 | PREREG | PASS | external reference cannot enter causal analysis |
| G26 | PREREG | PASS | M214 falsification suite passes |
| G27 | PREREG | PASS | no frozen-population outcome-bearing agent run has occurred |
| G28 | PREREG | PASS | live model spend is $0 during preregistration |
| G29 | PREREG | PASS | M214-owned harness and tests are typechecked |
| G30 | PREREG | PASS | model availability established (registry evidence) |
| G31 | PREREG | PASS | treatment lifecycle ordering executed and verified |
| **G32** | **INFRA** | **FAIL** | a launch executor exists that can run the frozen manifest |

G29–G32 are additions M214's own work forced; G1–G28 are the prompt's verbatim.

**Why the gate table has three classes.** M213's table conflated two kinds of
condition: some gates ask "is the design frozen and correct?", which a
preregistration can answer, and others ask "was this run configured correctly?",
which nothing can answer before runs exist. Marking every unanswerable one BLOCKED
produces a table where scheduling facts look like defects. M214 separates
PREREGISTRATION (must pass now), RUNTIME (asserted per run by the launch executor,
each naming the guard that will assert it) and INFRASTRUCTURE (does the asserting
thing exist at all). A RUNTIME gate's status is supplied by the caller, so
`launchAuthorized` is reachable once an executor asserts it — a gate table that can
never approve anything is not a gate table.

**The two open cells.**

- **G14** is deferred, not failed. `auditSourceStateEquivalence` exists, is tested,
  and its mechanism is measured; per-run equality across 200 runs can only be
  asserted when the runs exist.
- **G32** is the real blocker, named rather than dissolved into G14. Nothing exists
  that would create the containers, run the lifecycle per run and verify this
  preregistration's hash before the first paid call. M213 listed building it as
  outstanding infrastructure work and M214's scope does not include it.

## 32. Preregistration hash

```text
rule    sha256 over "VTRACE_EXTERNAL_VEXP_100\n" + canonical (recursively key-sorted)
        JSON of every field except preregistrationHash, preregistrationHashRule and
        generatedAt

value   3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4
```

Self-checked against the **written file**, not the in-memory object, so a
serialisation that lost a field would be caught: read back, recompute, confirm it
matches; confirm a tampered field changes it; confirm it differs from M213's. The
generator throws if any of the three fails.

`generatedAt` is excluded deliberately: a hash that moved on every regeneration
would flag an unchanged design as mutated, and a guard that cries wolf on a no-op is
one people learn to override. Every field carrying an experimental commitment stays
inside the digest — verified by tests that move it on task set, arms, budget and
name changes, and hold it stable across key reordering and a changed timestamp.

## 33. Manifest hash

```text
549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1   over 200 PLANNED rows
```

Tests confirm it moves when any row's budget changes and when a row is dropped.

## 34. M214 scoped typecheck

```text
M214_NEW_TYPECHECK_ERRORS                 0
PREEXISTING_BENCHMARK_TEST_TYPE_ERRORS    59   (outside M214 scope)
M214_SCOPED_TYPECHECK_VERIFIED
```

`tsconfig.benchmarks.json` excludes `benchmarks/**/*.test.ts`, so no benchmark test
file has ever been typechecked — M213 found this when a test's object literal kept
fields a refactor had removed and `bun run lint` did not notice. Enabling the
exclusion repo-wide surfaces **59 pre-existing errors** in unrelated historical
benchmark tests, and M214 is not authorised to clean them up.

`tsconfig.m214.json` narrows the same strict settings to this milestone's files —
`m214*.ts` including its tests, `run_stage5_m214_*.ts`, and everything they
transitively import. **Repository-wide benchmark tests remain untypechecked and M214
does not claim otherwise.**

A config that *includes* files and a config that *checks* them are different claims,
so the runner proves the target can fail: it writes a deliberate type error into a
file the globs cover, confirms the target reports it, removes the file, and confirms
the target is clean again. The scoped target caught a real error on its first run
(a misapplied `as const` in `m214ExternalReference.ts`), which is what it is for.

## 35. Standard verification

```text
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun run lint                   clean (both of the above)
tsc -p tsconfig.m214.json      clean  (M214 scoped, includes M214 test files)
git diff --check               clean
bun test                       full suite, see §36
```

## 36. Repository state / SHAs

```text
branch                    main (no feature branch; not pushed)
HEAD at milestone start   28c8a03442d3e5ceb2962cb238e926151f6d7790
commit 1 (harness)        f37dc003bb0b323f34d351b5cea77c8a66f32450
frozen vtraceCommit       f37dc003bb0b323f34d351b5cea77c8a66f32450
src tree (treatment)      b3b3e439f10c6c526cafc6001d25dd0e7552ce6d  — unchanged since M213
src/ product changes      0
pre-existing tracked dirt preserved (stage5_outcome_ledger.json/.md)
untracked dirt            preserved; nothing unrelated staged
```

M214 makes no `src/` change. The treatment is frozen at the tree M213 measured. No
residual from the standing programme was repaired here — impact fanout, A13
non-prefix observations and the cross-repo Top-1 regression are all untouched, on
purpose: a repaired treatment is a different treatment and would need a new frozen
identity.

## 37. Authorisation conclusion

```text
PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY
```

No run has started. No model has been called by any M214 script. Starting the cohort
requires G32 closed (a launch executor), G14 asserted per run by that executor, and
an explicit spending authorisation for the frozen $700 ceiling — none of which this
document grants.

## 38. Standing findings

- **A benchmark harness's fairness must not depend on which entry point ran.**
  `vtrace init` writes `/.vtrace/` into `.git/info/exclude`; `vtrace index` alone
  does not. Whether the competitor's hardcoded `capturePatch` list would have
  polluted every VTRACE-arm patch turned entirely on that difference — 0 bytes on
  one route, 6,378 on the other, from the same index. Neither outcome was designed.
  A hardcoded exclusion list is a defect even when it is complete today, and the
  auditor reports it as one.

- **A gate that can never pass before launch is not a gate.** M213 marked per-run
  conditions BLOCKED and got a table where scheduling facts read as defects. Splitting
  gates into PREREGISTRATION / RUNTIME / INFRASTRUCTURE lets an honest NOT_READY say
  which kind of unready it is — here, a finished design waiting on an executor — and
  makes each deferred gate name the guard that will close it.

- **Separating an external reference from a causal arm has to be executable.** The
  realistic failure is not a bad claim; it is a correct paired analysis rendered into
  a table with a third row for context. Making the paired-statistics entry point
  reject non-arm operands, making the table auditor reject the evidence class, and
  generating the comparison sentence rather than writing it are three different
  places the mistake is caught, and the generated sentence is checked by the same
  auditor that rejects the forbidden phrasings.

- **The vendor's script still does not reproduce the vendor's subset**, re-derived
  independently: 22/100 overlap, django 42 vs 44, sympy 14 vs 17, scikit-learn 6 vs
  2. Any future comparison against a published competitor number must verify by hash
  that the population it runs is the population that number was computed on.

- **Next-step recommendation.** Two things close M214's residual, in order:
  (1) build the launch executor — per-instance containers, the frozen lifecycle in
  the frozen order, the pre-agent snapshot after treatment initialisation, per-run
  assertion of `auditSourceStateEquivalence` and of the provider-returned model
  identity, and a hard abort if the committed preregistration hash does not
  recompute; (2) obtain explicit authorisation for the frozen $700 ceiling. Neither
  requires touching the product, and neither should change anything above: the
  design is frozen and its hash is the check on that.

  If a VEXP licence with an unlimited repository ceiling is ever obtained, the
  correct move is to run M213's three-arm preregistration as written — not to bolt a
  third arm onto M214, whose external-reference machinery exists precisely because
  that arm could not be run.

  `ENGINE QUALITY != CODING-AGENT UTILITY` and
  `CONTEXT_COMPILER_PRODUCT_UTILITY_NOT_ESTABLISHED` both still govern. Nothing in
  M214 measured utility; it only made a measurement of it possible to trust.
