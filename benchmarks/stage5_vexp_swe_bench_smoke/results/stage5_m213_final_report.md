# M213 — final report: exact baseline vs VTRACE vs VEXP causal benchmark preregistration

## 1. Executive verdict

```text
M213 — INCOMPLETE

CAUSAL_BENCHMARK_PREREGISTERED
TASK_POPULATION_FROZEN
RUN_MANIFEST_FROZEN
ANALYSIS_PLAN_FROZEN
STOPPING_RULE_FROZEN
M213_FALSIFICATION_SUITE_PASSED

VTRACE_TREATMENT_EXECUTABLE
VEXP_TREATMENT_NOT_EXECUTABLE

TREATMENT_IDENTITIES_FROZEN_EXCEPT_VEXP_RUNTIME
PAID_RUNS_NOT_STARTED
PAID_CAUSAL_BENCHMARK_NOT_READY
```

`INCOMPLETE`, not `PASS`, and the reason is the one §49 anticipates: the VEXP arm
cannot be executed on this host, and M213 will not substitute an imitation of it.
Everything else the milestone was asked to freeze is frozen, hashed and testable.

Two further gates are open, and they are M213's own findings rather than
inherited constraints — see §29.

The historical position is unchanged and is not rewritten anywhere in this work:

```text
Frozen historical parity:        14 / 15
A15:                             historically BELOW, and
                                 A15_PARITY_GAP_INVALIDATED (M212)
```

## 2. Starting repository state

```text
branch                main
HEAD                  fe40e4ae0dd8a53cd817b96add51ee5f11893822
                      "Find that the fifteenth cell was never a measurement of the competitor"  (M212)
origin/main...HEAD    0 behind, 227 ahead  (local-only; nothing pushed)
tracked dirty         2 files — stage5_outcome_ledger.json, stage5_outcome_ledger.md
                      pre-existing, predate this work, untouched
git diff --check      clean
```

211 untracked benchmark-output paths were present at start and are preserved. No
reset, no clean, no worktree removal, no push.

## 3. Historical evidence motivating the experiment

The deterministic phase asked whether VTRACE could reproduce the architectural
capabilities thought to distinguish VEXP. It substantially could. That is not the
question that matters:

```text
ENGINE QUALITY != CODING-AGENT UTILITY
```

Three standing results shape this design, and none is reinterpreted here.

**M183** — 30 paired live SWE-bench tasks, 60 runs. Baseline 19/30, VTRACE 19/30;
both 17, VTRACE-only 2, baseline-only 2, neither 9; McNemar p = 1.0. Tokens
favoured VTRACE by roughly 5% with an interval crossing zero.
`OBSERVED_RESOLUTION_PARITY`, `CURRENT_PRODUCT_UTILITY_NEUTRAL`.

**M188 / M168** — VEXP's published whole-agent benchmark cannot by itself show
that its repository-intelligence intervention caused its reported number: it has
no same-run control, and their tool fired rarely relative to native search. The
published pass rate is not a causal treatment effect, and this preregistration
never treats it as one.

**M212** — frozen A15 was a VTRACE-authored operationalisation wearing a
competitor's name, superseded by absence rather than by VEXP moving. The
methodological lesson governs M213 directly: *do not substitute a hand-authored
proxy for a treatment that can be executed* — and, when it cannot be executed,
say so rather than reconstructing it.

M213 improves on M183 in four specific ways: three arms instead of two, 100 tasks
instead of 30, a competitor arm that has never been run under identical
conditions, and a design frozen and hashed before the first dollar is spent.

## 4. Research questions

All two-sided. M183 observed exact resolution parity, so a one-sided favourable
hypothesis is not historically justified and is not preregistered.

| | question |
|---|---|
| RQ1 | Does VTRACE causally improve resolution vs baseline? `P(resolve\|VTRACE) != P(resolve\|baseline)` |
| RQ2 | Does VEXP causally improve resolution vs the same baseline? |
| RQ3 | Which treatment produces the larger causal delta from baseline? |
| RQ4 | Does either treatment reduce input / output / total tokens or cost at approximately constant resolution? |
| RQ5 | How do treatments alter native search, reads, turns, files inspected, files edited? |
| RQ6 | How often is the treatment actually consumed — exposed, invoked, invoked before the first edit? |

## 5. Task population

**Option 1, in its strongest form.** The exact VEXP subset is not reconstructed —
it is taken as the vendor's own committed artifact:

```text
file      /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl
sha256    7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d
origin    github.com/Vexp-ai/vexp-swe-bench, commit 880e486
          "Initial release: vexp-swe-bench benchmark harness"
state     clean in the vendor checkout (the checkout is dirty; this file is not)
```

100 instances, 12 repositories, all instance ids committed in the preregistration
and the manifest.

**The vendor's published properties were checked against the bytes, and hold:**

| published claim | measured |
|---|---|
| all 12 repositories represented | 12 |
| per-repository table (django 44, sympy 17, sphinx 7, matplotlib 7, astropy 5, xarray 6, pytest 4, requests 4, sklearn 2, pylint 2, seaborn 1, flask 1) | reproduced exactly, every cell |
| subset median complexity 22 | 22 |
| complexity ceiling ≤ 250 | max 247, 0 over |
| ceiling removes ~1% of the full 500 | 6 / 500 = 1.2% |

### 5.1 A finding: the vendor's own selection script does not reproduce the vendor's own subset

`scripts/select-subset.py` was run against SWE-bench Verified (500), materialised
from the local HuggingFace cache:

| input ordering | overlap with the shipped subset |
|---|---|
| natural parquet order | **22 / 100** |
| instance-id order | **22 / 100** |
| with the documented `complexity ≤ 250` filter applied first | **26 / 100** |

Its repository allocation differs materially too — django 42 vs 44, sympy 14 vs
17, scikit-learn 6 vs 2, sphinx 8 vs 7. The script also omits the ≤ 250 filter
its own documentation lists as step 1.

```text
EXACT_VEXP_SUBSET_AVAILABLE_AS_ARTIFACT
EXACT_VEXP_SUBSET_NOT_SCRIPT_REPRODUCIBLE
```

The consequence is not academic: anyone who "reproduces VEXP's subset" from the
published script benchmarks a **different 78 tasks** and cannot legitimately
compare against VEXP's published number. M213 freezes the artifact, which is the
population VEXP actually reported on.

## 6. Sampling / reconstruction method

None. The population is inherited byte-for-byte, which removes analyst discretion
entirely. No task was selected, dropped, reordered or weighted by anything —
least of all by historical VTRACE wins or losses, which never entered this
milestone's selection path at any point.

## 7. Arm definitions

| | Arm A — BASELINE | Arm B — VTRACE | Arm C — VEXP |
|---|---|---|---|
| MCP servers | none | `vtrace` | `vexp` |
| treatment tools | 0 | 14 | 3 |
| native tools | 7 | 7 | 7 |
| treatment-specific prompt | none | none | none |
| forbidden artifacts | `.vtrace`, `.vexp`, `VTRACE_*`, `VEXP_*` | `.vexp`, `VEXP_*` | `.vtrace`, `VTRACE_*` |

Primary comparison **B − A**; key secondary **C − A** and **B − C**.

## 8. Agent identity

```text
implementation   Anthropic Claude Code CLI, headless
version          2.1.260
system prompt    CLI default; no --append-system-prompt in any arm
user prompt      vexp-swe-bench buildPrompt, verbatim, IDENTICAL in all three arms
max turns        250
output           stream-json --verbose
```

M193 pinned 2.1.251. That version is no longer installed on this host — the
oldest present is 2.1.252 — so M213 re-pins to 2.1.260 rather than claiming a
continuity it does not have. The launch harness must assert the exact string and
abort the cohort on any difference.

## 9. Model identity

```text
provider   Anthropic
model      claude-opus-4-5-20251101
```

The model VEXP's published benchmark used — their README states "All agents use
Claude Opus 4.5 for a fair, apples-to-apples comparison" and their CLI defaults to
this exact id — and the model every untreated historical VTRACE baseline arm used,
so the frozen cost ceilings derive from this model's own economics.

**Availability was not verified**, because verifying it requires a paid call.
Recorded as `availabilityVerified: false`. The launch harness must read the
provider-returned model identity from each run's stream-json init event and abort
the cohort if it differs.

## 10. Native tool equality

`Edit, Write, Bash, Read, Glob, Grep, TodoWrite` — vexp-swe-bench's
`DEFAULT_ALLOWED_TOOLS`, unchanged, in all three arms. M168-E measured that
denying `Grep`/`Glob` is itself a treatment that lost two tasks and won none. The
question is whether the treatment helps a competent native-search agent, not
whether it can replace grep.

## 11. VTRACE treatment surface

The product default, read at runtime from
`defaultMcpToolRegistry.listMetadata()` — 14 tools:

```text
get_code_context  run_pipeline  index_repo  check_capsule_staleness
get_context_capsule  get_impact_graph  search_logic_flow  get_skeleton
index_status  workspace_setup  get_session_context  search_memory
save_observation  expand_vexp_ref
```

Started as `vtrace mcp-serve --repo <workspace>` with **no** `--tools` flag: the
arm must be what a user's agent would actually get. Seven further tools are
registered but hidden from `tools/list` (`search_symbols`, `build_capsule`,
`build_handoff`, `route_query`, `list_runs`, `list_sessions`, `read_session`) and
are **not** exposed — the arm is the product, not the research surface.

## 12. VEXP treatment surface

vexp-cli **3.1.1**'s actual default catalogue, extracted statically with M212's
tested extractor:

```text
run_pipeline   get_skeleton   verify_done
```

Nine tools are gated out of the default, `get_impact_graph` among them. It is
**not** added. M212 established that measuring against a VEXP surface VEXP's own
agents are never shown produces a VTRACE-authored proxy rather than a measurement
of the competitor, and that is precisely the error M213 must not repeat.

**The 14-versus-3 asymmetry is deliberate and preserved.** Normalising the
catalogues would replace both treatments with a construct neither vendor ships.
M166 measured that tool schemas are model-visible and billed every turn, so the
cost of a larger catalogue is part of what the experiment measures — not a
confound to engineer away.

## 13. Treatment version pins

| | |
|---|---|
| VTRACE | git SHA, recorded in the manifest, asserted per run |
| VEXP | `vexp-cli` package version — **3.1.1** read from the bundle |

A run whose VEXP version is null or drifts fails the audit (control F20). VTRACE's
identity is pinned per row and appears only on VTRACE rows.

## 14. Container / repository equality

The M192/M193 substrate, not the vendor's working trees:

```text
harness                swebench==4.1.0 official per-instance evaluation images
per-instance containers yes
fresh checkout per run  yes
authoritative checkout  SINGLE_BIND_MOUNTED_TREE
patch capture           git diff --no-renames HEAD  +  untracked lane, both
                        restricted by a pathspec excluding every path already
                        untracked before the agent started; never stages, never resets
```

The capture mechanism names **no vendor directory**: it excludes whatever was
untracked pre-agent, which covers `.vtrace`, `.vexp` or anything else
symmetrically. That is why M213 adopts it — see §29 for what the alternative does.

**Indexing was proven observational, not assumed.** Across all twelve
repositories, the tracked-source digest (`git ls-files -s`) was byte-identical
before and after indexing, and the only path indexing created was `.vtrace`.

## 15. Budget equality

```text
max turns                    250
per-run cost cap             $3.50
wall-clock timeout per run   3600 s
tool-call timeout            600 s
repository command timeout   600 s
total intended runs          300
total spend cap              $1,050
```

Identical in every arm by construction: the budget is scalar fields on one frozen
object, so an arm-specific budget cannot be expressed without editing the
preregistration and changing its hash.

The per-run cap is M193's, derived from the untreated stratum of historical arms
on this exact model, and sits strictly above the most expensive arm ever recorded
($3.0384). VEXP's shipped $3.00 default would have truncated a real run and is
**not** adopted merely because it was published. Projection at the untreated
historical mean ($0.6604) is **$198.12**; at p90 ($1.2392), **$371.76**. The
$1,050 ceiling is the arithmetic worst case, not the expectation.

## 16. Randomisation

```text
seed          M213-VTRACE-VEXP-CAUSAL-100-v1     (committed literal)
method        rank instances by sha256(seed + instance_id); rank mod 6 selects
              one of the six arm orders
balance       17 / 17 / 17 / 17 / 16 / 16
```

Baseline is first on 34 of 100 tasks and last on 33 — never systematically first,
which is what protects against machine-load, provider-latency, cache and operator
drift. The ranking key is arbitrary with respect to repository, difficulty and
every historical outcome.

## 17. Run manifest

```text
intended runs   300   (100 tasks × 3 arms)
every row       status = PLANNED
manifest hash   0001072171e0e3aa4242a6865a7bf144cb3ffba145c89aeee27de99b18cbe9d9
```

All 300 rows were generated before any execution, each carrying instance id,
repo, base commit, arm, arm-order index, order, seed, agent version, model,
treatment identity, container image and budget. Dropping one task, adding one, or
reordering changes the hash.

## 18. Primary outcome

SWE-bench `resolved`, binary, from the official evaluator (swebench 4.1.0,
verified present at that exact version; M192's wheel-integrity audit of seven
load-bearing harness files found 0 modified). Explicitly refused as substitutes:
a patch was produced, tests appeared to pass in the transcript, the agent declared
success, the patch touched a gold file.

## 19. Statistical analysis

Paired, because every task is run under all three arms.

```text
binary      exact McNemar on discordant pairs
interval    95% paired bootstrap, 10,000 resamples, resampled BY TASK so all
            three arms of a task move together
reported    both / treatment-only / comparator-only / neither, absolute delta,
            relative delta, CI, p-value — for each of B-A, C-A, B-C
continuous  paired differences; median AND mean, both with CIs
```

Multiplicity: **one primary** (B − A), **two key secondary** (C − A, B − C) with
Holm correction across the pair. Co-primary status for all three would make the
headline claim depend on a correction chosen after the fact.

`p < 0.05` is not the definition of success. `+1/100` and `+10/100` are described
differently even when neither is conventionally significant. Means alone are
banned for cost: M174 found a two-run tail carrying 95.7% of a cost premium.

## 20. Secondary efficiency metrics

Input, output, cached and total tokens; provider-reported cost; wall-clock; turns.
Cost comes from provider telemetry, never a recomputed price table — and if a
table is ever needed, it is frozen with its retrieval date before any run.

Initialisation cost is reported **separately** from model cost, and the cold and
warm regimes are never mixed. This cohort is cold throughout. The measured cold
cost of the VTRACE treatment, from M213's own dry run:

| repository | symbols | relationships | files | index time | index size |
|---|---|---|---|---|---|
| django/django | 41,032 | 83,460 | 2,970 | 38.6 s | 156.0 MB |
| sympy/sympy | 25,979 | 59,257 | 1,118 | 25.3 s | 115.6 MB |
| astropy/astropy | 25,141 | 36,956 | 1,138 | 22.0 s | 90.2 MB |
| matplotlib/matplotlib | 18,938 | 25,441 | 1,177 | 13.3 s | 62.7 MB |
| scikit-learn/scikit-learn | 12,268 | 22,819 | 801 | 13.7 s | 51.7 MB |
| sphinx-doc/sphinx | 10,938 | 13,990 | 600 | 7.6 s | 34.0 MB |
| pylint-dev/pylint | 8,639 | 9,157 | 814 | 5.2 s | 26.9 MB |
| pydata/xarray | 5,529 | 12,674 | 179 | 4.1 s | 23.5 MB |
| pytest-dev/pytest | 5,403 | 9,632 | 266 | 3.0 s | 19.6 MB |
| mwaskom/seaborn | 3,326 | 7,108 | 162 | 2.5 s | 13.3 MB |
| pallets/flask | 1,167 | 1,609 | 116 | 0.9 s | 4.4 MB |
| psf/requests | 834 | 1,219 | 75 | 0.9 s | 4.7 MB |

## 21. Tool-use metrics

Ordered tool telemetry from the stream-json transcript, classified **by tool name
only**. No outcome label may enter the classification of pre-decision evidence —
M185 and M189 both produced conclusions that did not survive when that rule was
applied retroactively.

Gold-relative timing metrics (turn of first read of a file the gold patch touches,
turn of first edit to one) are computed after the fact from the frozen dataset and
are evaluation-only. Gold patches, gold file lists and `FAIL_TO_PASS` never enter
any agent's context; control F18 exists to catch it if they do.

## 22. Treatment validity and ITT

Six fields recorded per run: assigned arm, surface available, initialisation
succeeded, index ready, tool schema visible in `tools/list`, invocation possible.

```text
primary     INTENTION_TO_TREAT — every launched run analysed under its assigned arm
secondary   TREATMENT_VALID / per-protocol
```

A treatment that fails to initialise is **never silently converted to baseline**
(control F13). If it fails before the model is called, the run is excluded as
`TREATMENT_INITIALISATION_FAILURE` and stays visible with its arm and repository.
If it fails after, the run is retained under ITT and flagged treatment-invalid.

Uptake is post-treatment behaviour: it is a mediator and a descriptive variable,
and it never conditions the primary comparison. A treatment arm where the agent
never touches the tool stays in the experiment (control F12).

## 23. Exclusion policy

Eleven infrastructure categories, frozen. Eight explicit non-exclusions: the task
failed, the agent got confused, the treatment was not used, the treatment's output
was poor, a test failed, no patch was produced, the run was expensive, the run is
inconvenient. **Those are outcomes.**

Every excluded run keeps its arm, repository and category in the accounting, so a
drift toward excluding one arm would be readable rather than hidden. Retry is
limited to four infrastructure categories, at most once, both attempts retained.

## 24. Stopping rule

```text
FIXED_N = 300
```

No interim analysis, no adaptive continuation, no early stop. The rule cannot see
resolution, cost, discordant counts or any p-value. The only legitimate early
termination is **abandonment** under §30 — which discards the cohort and never
yields a reported result. If the spend cap binds, the cohort is reported as
incomplete; a partial cohort is never analysed as if it were the preregistered
experiment.

## 25. No-tuning policy

At the first paid run, thirteen things freeze: VTRACE commit, VEXP version, agent
version, model, prompts, tool catalogues, budgets, task set, randomisation,
harness, evaluator, stopping rule, analysis plan. On a critical defect: **stop,
declare the cohort invalid, fix, restart from zero.** Patching halfway and
retaining earlier outcomes is refused.

## 26. VTRACE executable evidence

```text
VTRACE_TREATMENT_EXECUTABLE     12 / 12 repositories
```

One instance per repository, selected outcome-blind (lexicographically first
frozen instance whose eval image was already cached — an infrastructure
constraint, recorded as one). For each: checkout materialised from the cached
image, `base_commit` checked out, tracked-source digest taken, indexed, digest
retaken, MCP server started at the product default, `initialize` + `tools/list` +
one real `get_code_context` call issued.

```text
index succeeded              12 / 12
tools/list returned 14       12 / 12
deterministic query returned 12 / 12   (8-18 items per packet)
tracked source unchanged     12 / 12
paths created by indexing    .vtrace   (and nothing else, anywhere)
errors                       0
total index time             137 s across all twelve
```

No model, no agent, no gold data, no test run, no image pull.

## 27. VEXP executable evidence

```text
VEXP_TREATMENT_NOT_EXECUTABLE
```

Five independent blockers, none of which is an engineering problem:

1. The installed CLI (**2.0.24**) refuses every invocation — including
   `vexp --version` and `vexp --help` — with an update-required notice. No VEXP
   command runs on this host as it stands.
2. No licence exists in `~/.vexp` (contents: `update-check.json` only), so the
   effective plan is **free**.
3. The free plan admits **1 repository**. The frozen population spans **12**.
4. The free plan caps the graph at **2,000 nodes**. The largest repository in the
   population carries **41,032** indexed symbols. *(A VTRACE symbol count is not a
   VEXP node count; it is reported to indicate scale. The repository-count blocker
   above needs no such caveat and is decisive on its own.)*
5. `@vexp/core-<platform>` — the component that both indexes and enforces the
   plan — is not installed.

Of the vendor's own published tiers, only those with an unlimited repository
ceiling could cover a 12-repository benchmark:

| plan | max repos | max nodes | covers 12 repos |
|---|---|---|---|
| free | 1 | 2,000 | no |
| tier1 | 1 | 10,000 | no |
| pro | 3 | 50,000 | **no** |
| tier2 | 3 | 50,000 | **no** |
| tier3 | 0 = unlimited | 100,000 | yes |
| team / tier4 | 0 = unlimited | 0 = unlimited | yes |

So the arm needs a `tier3`, `team` or `tier4` licence. **`pro` is not sufficient.**
That is a procurement decision, not an engineering one, and it is not one this
milestone can make. Note also that these ceilings are what the vendor's own JS
client displays; the bundle states limits are "enforced directly by the Rust
daemon", which is not installed and was not read.

Per §33 and §49, the arm is reported as not executable. A static reconstruction of
VEXP's behaviour is **not** substituted for it — that is the exact error M212
identified in frozen A15.

## 28. Contamination guards

Audited per run: system prompt, initial user prompt, tool schemas, environment
variables, workspace root entries at agent start, `CLAUDE.md`/`AGENTS.md`
reachable from the workspace or its ancestors, MCP configuration, PATH, daemon
sockets, generated context files.

Instruction files native to the benchmark repository at its base commit are the
benchmark's normal condition, preserved identically in all three arms, and
recorded separately from experimental injection so the two can never be confused.

**One trap worth naming.** VTRACE's own product default ships a tool called
`expand_vexp_ref`, whose model-visible name is `mcp__vtrace__expand_vexp_ref`. A
contamination guard asking "does any tool name contain `vexp`?" would report the
VTRACE arm as contaminated on **every single run**. The guards therefore compare
server names and whole catalogues, never substrings, and a test pins that.

## 29. Falsification F1–F22

```text
29 controls, 29 satisfied
```

F1–F20 are the prompt's controls. **F21 and F22 are additions this milestone's own
harness audit forced**, and both fire against measured reality rather than a
hypothetical.

| id | control | expects | result |
|---|---|---|---|
| F0 ×3 | a fully compliant baseline / VTRACE / VEXP run | silent | silent |
| F1 | VTRACE tool injected into baseline | fires | fires |
| F2 | VEXP exposed in the VTRACE arm | fires | fires |
| F3 | VTRACE exposed in the VEXP arm | fires | fires |
| F4 | VTRACE commit drifts after manifest generation | fires | fires |
| F5 | one arm runs a different model id | fires | fires |
| F6 | treatment-specific instruction appended to a prompt | fires | fires |
| F7 | one arm given a larger turn and cost budget | fires | fires |
| F8 | source modified before one arm starts | fires | fires |
| F9 | a task removed from the manifest after preregistration | fires | fires |
| F10 | the arm-order seed changed | fires | fires |
| F11 | an unresolved run excluded with no infrastructure reason | fires | fires |
| F12 | treatment exposed, agent never invokes it | **silent** | silent |
| F13 | init failure classified; no silent baseline substitution | both | both |
| F14 | preregistration edited after its hash was recorded | fires | fires |
| F15 | cohort finalised at 180 of 300 | fires | fires |
| F16 | tasks dropped because a treatment lost them | fires | fires |
| F17 | Grep removed from one arm | fires | fires |
| F18 | gold patch reachable from agent context | fires | fires |
| F19 | a later arm reuses the previous arm's conversation and patch | fires | fires |
| F20 | VEXP version cannot be pinned | fires | fires |
| F21 | treatment state can enter a captured patch | fires | **fires** |
| F22 | index warmth asymmetric between treatments | fires | **fires** |

The suite includes real negative controls. A guard that rejected everything would
pass F1–F22 and be worthless, so `F0_CLEAN_*`, `F12`, `F13_CLASSIFIED`,
`F21_CLEAN` and `F22_CLEAN` must all stay **silent**, and do.

### 29.1 What F21 and F22 found

Auditing the benchmark harness before inheriting it produced two defects that
would have advantaged the competitor's arm invisibly.

**H1 — asymmetric patch capture (launch-blocking).**
`vexp-swe-bench`'s `capturePatch` runs

```text
git add -A -- . :(exclude).vexp :(exclude).claude :(exclude).bench-mcp-config.json
```

It excludes the competitor's generated state and does **not** exclude `.vtrace`.
Reproduced directly: on a flask checkout where the agent had changed nothing, the
captured patch contained `.vtrace/index.meta.json`, `.vtrace/index.sqlite` and
`.vtrace/session.sqlite` — **105,321 bytes of diff, 1,848 lines** of VTRACE index
metadata including absolute host paths and indexer fingerprints. Every VTRACE-arm
patch would have been polluted, could have failed to apply, and could have
exhausted the capture's 10 MB buffer — producing `PATCH_EXTRACTION_FAILURE`
exclusions concentrated in one arm for a reason having nothing to do with utility.

**H2 — asymmetric index warmth (launch-blocking).**
`resetRepo` and `setupRepo` run `git clean -fdx -e .vexp -e .claude -e
.bench-mcp-config.json` between tasks. `.vexp` survives; `.vtrace` would be
deleted. The competitor's index would be warm across all 44 django tasks while
VTRACE paid a cold rebuild on each — a systematic setup-cost and latency
advantage that §20's cold/warm accounting would then have reported as a property
of the products.

**H3 — shared working trees (design-relevant).**
One tree per repository slug under `.bench-repos`, reused across every task of
that repository. Three arms of one task would not be independent, and runs within
a repository could not overlap.

M213 does not adopt that harness. The M192/M193 substrate removes all three
structurally: per-instance containers, a fresh checkout per run, and a capture
whose exclusion is derived from a pre-agent untracked snapshot rather than from a
hardcoded list naming one vendor.

## 30. Launch gates

```text
19 PASS   1 FAIL   2 BLOCKED   →  launchAuthorized = false
```

| gate | requirement | status |
|---|---|---|
| G1 | preregistration committed | PASS |
| G2 | preregistration hash recorded | PASS |
| G3 | task population frozen | PASS |
| G4 | run manifest frozen (300 rows) | PASS |
| G5 | VTRACE treatment executable | PASS |
| G6 | **VEXP treatment executable** | **FAIL** |
| G7 | baseline contamination guard passes | PASS |
| G8 | treatment contamination guards pass | PASS |
| G9 | identical agent verified | PASS |
| G10 | identical model verified | PASS |
| G11 | identical budgets verified | PASS |
| G12 | identical native tools verified | PASS |
| G13 | repository-state equivalence verified | PASS |
| G14 | evaluator validated | PASS |
| G15 | exclusion rules frozen | PASS |
| G16 | statistical plan frozen | PASS |
| G17 | stopping rule frozen | PASS |
| G18 | randomisation frozen | PASS |
| G19 | all falsification controls pass | PASS |
| G20 | no outcome-bearing benchmark run has occurred | PASS |
| G21 | **treatment state cannot enter a captured patch** | **BLOCKED** |
| G22 | **index warmth symmetric across arms** | **BLOCKED** |

G9–G18 are derived from evidence, not asserted: G9 and G10 from the manifest's own
uniqueness plus the absence of any treatment-specific instruction, G11 from budget
uniqueness across all 300 rows, G12 from the arm definitions, G14 from the
evaluator actually reporting version 4.1.0, G18 from every row's seed and
arm-order index agreeing with the frozen assignment.

G21 and G22 are `BLOCKED` rather than `FAIL` for a reason worth stating precisely:
the adopted substrate's mechanism is correct by construction, but what makes it
hold is an **ordering** — the pre-agent untracked snapshot must be taken *after*
treatment initialisation — and that ordering belongs to a launch harness that does
not exist yet. G22 additionally cannot be closed while VEXP is not executable:
VEXP keeps state under `~/.vexp` and runs a daemon, so a fresh checkout does not
by itself establish that a VEXP arm is cold. Neither gate can be closed by
argument; both need the launch harness, and G22 needs a working VEXP.

## 31. Preregistration hash

```text
preregistration   5d90eddb9cc4759acf6a6fbc033d54ee0d5aea589a92c169daa7dca8d9c568c8
manifest          0001072171e0e3aa4242a6865a7bf144cb3ffba145c89aeee27de99b18cbe9d9
rule              sha256 over the canonical (recursively key-sorted) JSON of every
                  field except preregistrationHash, preregistrationHashRule and generatedAt
```

`generatedAt` is excluded deliberately: a hash that moved every time the generator
ran would flag an unchanged design as mutated, and a guard that cries wolf on a
no-op is one people learn to override. Verified idempotent — two consecutive
regenerations produce the identical digest — while any edit to any committing
field still changes it.

The guard is exercised on the **artifact**, not on a fixture: the written JSON is
read back from disk, rehashed, and a tampered copy is confirmed to hash
differently. The generator throws rather than emitting a document whose hash does
not verify.

**Which VTRACE commit the manifest binds.** Every VTRACE row carries
`a4cd91225c2a4196cdffb265ddbc2390a9bf38b5` — the commit that introduced the
preregistration authority. The evidence commit that records these artifacts is
necessarily later, so the manifest binds its predecessor, exactly as M193's
SHA-record convention does. The launch harness must therefore check two things,
not one: that the preregistration hash still verifies, **and** that the VTRACE
build it is about to run matches the commit each VTRACE row names. A cohort run
from a different build is a different treatment.

The future launch harness must recompute this hash from the committed
preregistration and abort if it differs. A changed preregistration is a **new
cohort with a new hash**, never a silent edit to this one.

## 32. Dry-run evidence

```text
docker containers created           12   (create + cp + rm; none executed a test)
repositories indexed                12
MCP servers started                 12
deterministic MCP queries issued    12
VEXP processes started               0   (2.0.24 refuses to run; 3.1.1 never executed)
images pulled                        0   (cached images only)
agents run                           0
model calls                          0
```

Selection of the twelve probe instances used repository, instance id and local
image availability only. Gold patches, `FAIL_TO_PASS`, historical resolution and
prior VTRACE attention were never read.

### 29.2 Defects M213's own instruments had

Recorded because each was caught before it reached a claim, and one of them says
something about the repository rather than about this milestone.

1. **The executability probe piped `index --json`**, and the two largest
   repositories truncated the summary mid-string. That read back as *null
   symbols* rather than as an error — a silent "this repository has no symbols"
   for django and matplotlib. Now written to a file, and a parse failure is
   reported as a parse failure.
2. **Its query reader looked for keys the orientation packet does not have**
   (`items`, `files`, `results`) and recorded a null item count for all twelve.
   The packet is `{boundary, focus, related, schemaVersion}`.
3. **A first VEXP catalogue extractor used a text window** and returned all
   twelve tools as "default", which would have made the VEXP arm four times the
   surface VEXP ships. Replaced by delegation to M212's tested extractor, which
   returns the correct three. M212's own unit test had already caught the
   window-reading failure mode once; writing a second, looser reader
   reintroduced it.
4. **A substring contamination check flags the VTRACE arm on every run.**
   `mcp__vtrace__expand_vexp_ref` contains `vexp`. Caught by a test, not by
   inspection; the guards compare server names and whole catalogues, and a test
   now pins the trap.
5. **A stale `GateInputs` literal in a test survived `bun run lint`.** When G21
   and G22 became tri-state, the test's input object kept the old boolean fields.
   `tsc` should have caught it; it did not, because `tsconfig.benchmarks.json`
   **excludes `benchmarks/**/*.test.ts`**. Benchmark test files are never
   typechecked, and `bun test` is their only check — which is how a type error
   reached a full-suite run. Enabling that typecheck across the repository
   surfaces **60 pre-existing errors** in other benchmark test files, so it is a
   separate cleanup and M213 does not attempt it. The M213 files themselves were
   verified against a strict config that *does* include their tests: 0 errors.

## 33. Verification

```text
bun run typecheck              pass
bun run typecheck:benchmarks   pass
bun run lint                   pass  (both typechecks)
bun test                       6321 pass, 49 skip, 0 fail  (387 files)
git diff --check               clean
```

```text
benchmark-task live-agent runs     0
live model spend                   $0
VTRACE product changes             0
VEXP product changes               0
frozen A1-A15 scorer changes       0
src/ changes                       0
```

`src/` is byte-unchanged: every file this milestone added lives under
`benchmarks/stage5_vexp_swe_bench_smoke/`.

## 34. Repository state / SHAs

```text
start          fe40e4ae0dd8a53cd817b96add51ee5f11893822   (M212)
authority      a4cd91225c2a4196cdffb265ddbc2390a9bf38b5   (commit 1; bound by every VTRACE manifest row)
evidence       this commit
```

Commits are recorded in the ledger row. The two pre-existing dirty ledger files
were not touched; no untracked benchmark output was staged; nothing was pushed.

## 35. Authorisation conclusion

```text
PAID_CAUSAL_BENCHMARK_NOT_READY
```

The blocker is not the design. The design is frozen, hashed, falsified against 29
controls and executable on the VTRACE side across all twelve repositories. The
blocker is that **one of the three arms cannot be run at all**, and two harness
gates need a launch harness that does not exist yet.

Three things would close it, in order:

1. **A VEXP licence with an unlimited repository ceiling** (`tier3`, `team` or
   `tier4`; `pro`'s 3-repository ceiling is not enough), plus `vexp-cli` upgraded
   to 3.1.1 and its platform core installed. Then re-run the G6 probe.
2. **A launch harness** that takes the pre-agent untracked snapshot after
   treatment initialisation and resets treatment-external state between runs,
   closing G21 and G22 against measurement rather than argument.
3. **Explicit spend authorisation** for the frozen $1,050 ceiling.

If a VEXP licence is not obtainable, the honest options are to report
`VEXP_TREATMENT_NOT_EXECUTABLE` and stop, or to preregister a *separate*, clearly
two-arm experiment. Silently running A/B and describing it as the three-arm
benchmark is not one of them. That choice is the project owner's, and this
milestone does not make it.

No paid run was started. No model was called on any benchmark task.

## 36. Final principle, restated

M213 succeeds methodologically, not directionally. Its success condition was never
"VTRACE wins" — the preregistration lists five acceptable outcomes, including two
in which VTRACE does not. What it buys is that the future result becomes hard to
manipulate: the tasks are the competitor's own bytes, the arms are each vendor's
own default surface, the orders are seeded and balanced, the budgets are one
shared object, the analysis is fixed, the stopping rule is blind, and every one of
those facts is inside a hash that the launch harness must check before it spends a
dollar.
