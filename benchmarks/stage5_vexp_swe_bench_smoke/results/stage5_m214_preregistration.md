# M214 — VTRACE_EXTERNAL_VEXP_100: two-arm causal preregistration

Generated from `m214Preregistration.ts`, `m214ExternalReference.ts` and
`m214TreatmentLifecycle.ts`. Machine-readable twin:
`stage5_m214_preregistration.json`. No paid run is authorised by this document.

## 1. Status

```text
TWO_ARM_CAUSAL_BENCHMARK_PREREGISTERED
EXTERNAL_VEXP_REFERENCE_FROZEN
TASK_POPULATION_FROZEN
RUN_MANIFEST_FROZEN
ANALYSIS_PLAN_FROZEN
STOPPING_RULE_FROZEN
M214_FALSIFICATION_SUITE_PASSED
PAID_RUNS_NOT_STARTED
PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY
```

- preregistration hash `3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4`
- manifest hash `549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1` over 200 intended runs
- external reference hash `822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b`
- live model spend during M214: **$0**; benchmark-task live-agent runs: **0**

## 2. Why M214 exists

M213 preregistered baseline / VTRACE / VEXP under one identical harness and then
found the third arm unrunnable. The blockers, from M213's committed audit:

- the installed CLI (2.0.24) refuses every invocation with an update-required notice, so no VEXP command can run on this host as it stands
- no licence is present in ~/.vexp, so the effective plan is FREE
- the free plan admits 1 repository, and the frozen population spans 12
- the free plan caps the graph at 2,000 nodes, and the largest repository in the population (django/django) carries 41,032 indexed symbols
- the platform core binary (@vexp/core-<platform>) is not installed, and it is the component that both indexes and enforces the plan

Verdict inherited unchanged: `VEXP_TREATMENT_NOT_EXECUTABLE`. That is a procurement and
licensing fact, not a VTRACE engineering defect, and M214 does not work around it,
imitate VEXP, or substitute a VTRACE-authored reconstruction for the real product.

## 3. M213 lineage and immutability

| property | value |
| --- | --- |
| parent experiment | VTRACE_VEXP_CAUSAL_100 |
| parent verdict | M213 — INCOMPLETE |
| parent arms / runs | 3 / 300 |
| parent hash (recorded) | `5d90eddb9cc4759acf6a6fbc033d54ee0d5aea589a92c169daa7dca8d9c568c8` |
| parent hash recomputed from committed bytes | **matches** |
| M214 hash | `3cd3b3d2d665c559fdb66e7274e809245e82ea7373344cf32614833b8dcbfea4` |
| hashes distinct | yes |

M214's digest is domain-separated by the experiment name, so even an identical
document could not collide with M213's. The three-arm preregistration stays
committed, unedited, and unexecuted.

## 4. Frozen task population

- artifact: `/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl`
- sha256: `7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d`
- instances: 100 across 12 repositories
- vendor commit: `880e486`

The population is the vendor's own committed artifact, byte-for-byte, inherited
from M213 by importing its loader rather than re-declaring it.

### 4.1 The vendor's script does not reproduce the vendor's subset

Re-derived by M214, running the vendor's own `scripts/select-subset.py` unmodified:

- overlap with the shipped artifact: **22 / 100**
- a script-based "reproduction" therefore benchmarks a different **78** tasks

| repository | script | artifact |
| --- | ---: | ---: |
| django/django | 42 | 44 |
| matplotlib/matplotlib | 5 | 7 |
| mwaskom/seaborn | 2 | 1 |
| psf/requests | 5 | 4 |
| pydata/xarray | 4 | 6 |
| pylint-dev/pylint | 3 | 2 |
| pytest-dev/pytest | 5 | 4 |
| scikit-learn/scikit-learn | 6 | 2 |
| sphinx-doc/sphinx | 8 | 7 |
| sympy/sympy | 14 | 17 |

```text
EXACT_VEXP_SUBSET_AVAILABLE_AS_ARTIFACT
EXACT_VEXP_SUBSET_NOT_SCRIPT_REPRODUCIBLE
```

## 5. Arms

| | Arm A — BASELINE | Arm B — BASELINE + VTRACE |
| --- | --- | --- |
| native tools | Edit, Write, Bash, Read, Glob, Grep, TodoWrite | identical |
| MCP servers | none | `vtrace` |
| treatment tools | none | 14, the product default |
| treatment instruction | none | none |
| workspace `.vtrace` | forbidden | created by treatment setup |
| agent, model, prompts, budgets, container, evaluator | \<one frozen record\> | the same record |

There is no third row. The vendor's published result is an external reference
with its own artifact and its own evidence class, never a row of this table.

## 6. Agent, model and published-condition match

- agent: Anthropic Claude Code CLI, headless, version `2.1.260`, CLI-default system prompt
- model: `claude-opus-4-5-20251101` — Claude Code 2.1.260's model registry lists claude-opus-4-5 with first_party id claude-opus-4-5-20251101, alongside newer families, with no deprecation or retirement marker. A provider-confirmed response would require a paid call and was not made.

| condition | VEXP published | M214 | match |
| --- | --- | --- | --- |
| task artifact | data/swe-bench-100.jsonl at vendor commit 880e486 | the identical file, sha256-pinned | **MATCH** |
| model | Claude Opus 4.5 | claude-opus-4-5-20251101 | **MATCH** |
| agent | Claude Code | Claude Code CLI 2.1.260, headless | **APPROXIMATE** |
| turn cap | 250 | 250 | **MATCH** |
| cost cap | $3/task | $3.50/task | **DIFFERS** |
| container / evaluator | not published | swebench==4.1.0 official per-instance evaluation images, one container per run | **UNKNOWN** |
| network policy | not published | the container's own posture, identical in both arms | **UNKNOWN** |
| native tool catalogue | not published; the harness ships DEFAULT_ALLOWED_TOOLS | Edit, Write, Bash, Read, Glob, Grep, TodoWrite | **APPROXIMATE** |
| repetitions per task | pass@1, repetitions not stated | one run per arm per task | **UNKNOWN** |

Because four rows are UNKNOWN and one DIFFERS, this is a **same-task published-condition external replication**
and is never described as an exact VEXP replication.

## 7. Budgets

| field | value |
| --- | --- |
| max turns | 250 |
| per-run cost cap | $3.5 |
| wall clock per run | 3600s |
| intended runs | 200 |
| total spend cap | $700 |
| budget identity | `bf705ec05d41d8f9` |

One object, shared by both arms, carried as a digest on every manifest row. The
cap counts provider-reported model cost only; index build time and size are
measured and reported separately and are never summed into a cost-per-task.

## 8. Patch-capture repair

The vendor harness's own pathspecs, read from its shipped JavaScript:

```text
capturePatch excludes : .bench-mcp-config.json, .claude, .vexp
clean preserves       : .bench-mcp-config.json, .claude, .vexp
```

Reproduced on real repositories with a real VTRACE index:

| initialisation route | vendor capture, no source change | derived capture, no source change | derived capture, one edit |
| --- | --- | --- | --- |
| `init_then_index` | 0 bytes (empty) | 0 bytes | pkg/core.py |
| `index_only` | 6378 bytes over .vtrace/index.meta.json, .vtrace/index.sqlite, .vtrace/session.sqlite | 0 bytes | pkg/core.py |

The leak is real and **route-dependent**: `vtrace init` appends `/.vtrace/` to
`.git/info/exclude`, which hides the directory from `git add -A`; `vtrace index`
alone does not. A benchmark whose fairness depends on which entry point ran is
not fair. The derived mechanism — *what changed, minus what was already there* —
produces an empty patch on a no-source-change run and exactly the edited file on
a source-change run, on **both** routes, and names no vendor.

Verdict: `PATCH_CAPTURE_REPAIR_VERIFIED`

## 9. Reset and warm/cold policy

Regime: `COLD_UNIFORM`. Source checkout is reset identically for both arms. Treatment index construction happens outside the source reset, after checkout and before the agent starts, and is measured rather than charged. `.vtrace` persistence is never a side effect of a generic `git clean`: nothing persists, for either arm, and the policy says so rather than the clean flags implying it.

Lifecycle order (the snapshot is taken AFTER treatment initialisation, which is
what makes the derived exclusion cover treatment state):

```text
  CONTAINER_START
  SOURCE_CHECKOUT_AT_BASE_COMMIT
  SOURCE_STATE_DIGEST_BEFORE_TREATMENT
  TREATMENT_INITIALISATION
  SOURCE_STATE_DIGEST_AFTER_TREATMENT
  PRE_AGENT_UNTRACKED_SNAPSHOT
  AGENT_RUN
  PATCH_CAPTURE
  EVALUATION
```

## 10. Randomisation and manifest

- seed: `M214-VTRACE-EXTERNAL-VEXP-100-v1`
- balance: baseline>vtrace 50, vtrace>baseline 50
- manifest: 200 PLANNED rows, hash `549df54b0f48b59a2bc13da2acf27cbf2469f416d90018c3d48dd87219f77ff1`, no vendor row

## 11. Analysis

Primary estimand: **ΔVTRACE = outcome(VTRACE) − outcome(BASELINE), on paired tasks**

the vendor's published 73/100. VTRACE − 73 is not a causal quantity: without a matched baseline, an absolute pass rate above or below 73 could equally reflect our harness, our agent version or our container substrate.

Always reported: both resolved, VTRACE only, baseline only, neither, baseline pass rate, VTRACE pass rate, absolute paired delta, discordant count difference, exact McNemar p-value, 95% paired bootstrap CI on the absolute delta.

Secondary efficiency: input tokens, output tokens, cached tokens, total model tokens, provider-reported cost, turns, wall-clock duration.

Treatment uptake is descriptive and a mediator; it never conditions the primary
comparison. A run where VTRACE was exposed and never invoked stays in the VTRACE arm.

## 12. External reference

| property | value |
| --- | --- |
| evidence class | `EXTERNAL_VENDOR_REFERENCE` |
| system | vexp + Claude Code |
| published pass@1 | 73 / 100 |
| published $/task | $0.67 |
| published model | Claude Opus 4.5 |
| published turn budget | 250 |
| published cost limit | $3/task |
| per-task outcomes published | **no** |
| snapshot hash | `822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b` |

Sources, each pinned to a vendor commit and a file digest:

- `README.md` @ `d658e3457b82` (sha256 `e743e1483aa24a92…`), retrieved 2026-09-04
- `README.md` @ `d658e3457b82` (sha256 `e743e1483aa24a92…`), retrieved 2026-09-04
- `README.md` @ `d658e3457b82` (sha256 `e743e1483aa24a92…`), retrieved 2026-09-04
- `docs/TASK_SELECTION.md` @ `d658e3457b82` (sha256 `6718013fcf3873d9…`), retrieved 2026-09-04

**What may be said.** Our absolute pass rate may be placed beside the published
73/100 with a cross-study qualifier. **What may not be said.** That VTRACE beat,
outperformed, or went head-to-head with VEXP; the two systems were never run in
the same harness, and no per-task VEXP outcomes exist to pair against.

## 13. Falsification suite

| control | expectation | result | detail |
| --- | --- | --- | --- |
| `F0_CLEAN_BASELINE` | GUARD_SILENT | satisfied | no issue reported |
| `F0_CLEAN_VTRACE` | GUARD_SILENT | satisfied | no issue reported |
| `F0_CLEAN_TASKSET` | GUARD_SILENT | satisfied | no issue reported |
| `F0_CLEAN_RANDOMIZATION` | GUARD_SILENT | satisfied | no issue reported |
| `F0_CLEAN_HASHES` | GUARD_SILENT | satisfied | no issue reported |
| `F0_CLEAN_LIFECYCLE` | GUARD_SILENT | satisfied | no issue reported |
| `F1` | GUARD_FIRES | satisfied | M213 preregistration has been modified: recorded 5d90eddb9cc4759acf6a6fbc033d54ee0d5aea589a92c169daa7dca8d9c568c8, computed 57d7be232a461f6cdd5e5e84b8 |
| `F1_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F2` | GUARD_FIRES | satisfied | manifest contains non-frozen instance astropy__astropy-14365; manifest contains non-frozen instance astropy__astropy-14369; manifest contains non-froz |
| `F2_ARTIFACT` | GUARD_FIRES | satisfied | external-reference task artifact drift: the published 73/100 describes artifact 7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d, but  |
| `F2_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F3` | GUARD_FIRES | satisfied | baseline arm has MCP servers configured: vtrace; baseline arm exposes non-native tools: mcp__vtrace__get_code_context; baseline arm carries treatment  |
| `F3_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F4` | GUARD_FIRES | satisfied | captured patch contains pre-agent path .vtrace/index.meta.json; it existed before the agent started and is not an agent change; captured patch contain |
| `F4_HARDCODED` | GUARD_FIRES | satisfied | patch capture does not exclude .vtrace; that treatment's generated state would enter its patch; patch capture uses a hardcoded exclusion list [.bench- |
| `F4_ORDERING` | GUARD_FIRES | satisfied | treatment state .vtrace is enumerable by git and is not covered by the derived patch exclusion; the pre-agent snapshot was taken before treatment init |
| `F4_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F4_ORDERING_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F4_NOT_ENUMERABLE_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F5` | GUARD_FIRES | satisfied | treatment initialisation mutated tracked source in the vtrace arm: canonical-digest → mutated-digest; vtrace arm tracked source differs from the canon |
| `F5_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F6` | GUARD_FIRES | satisfied | turn budget drift: expected 250, observed 400 |
| `F6_MANIFEST` | GUARD_FIRES | satisfied | manifest carries 2 distinct budget identities; exactly one is allowed; manifest carries 2 distinct cost caps |
| `F6_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F7` | GUARD_FIRES | satisfied | native tool set differs from the frozen set: observed [Bash,Edit,Glob,Read,TodoWrite,Write]; model-visible tool surface differs from the baseline arm  |
| `F8` | GUARD_FIRES | satisfied | model drift: expected claude-opus-4-5-20251101, observed claude-opus-5 |
| `F9` | GUARD_FIRES | satisfied | system prompt carries an appendix; both arms must use the CLI default; user prompt drift: the prompt template differs from the frozen text |
| `F10` | GUARD_FIRES | satisfied | VTRACE identity drift: expected f37dc003bb0b323f34d351b5cea77c8a66f32450, observed 0000000000000000000000000000000000000000; VTRACE product tree drift |
| `F11` | GUARD_FIRES | satisfied | frozen instance missing from manifest: django__django-99999; manifest has 200 rows, expected 202 |
| `F11_REMOVED` | GUARD_FIRES | satisfied | manifest contains non-frozen instance astropy__astropy-14365; manifest has 200 rows, expected 198 |
| `F12` | GUARD_FIRES | satisfied | arm order drift for astropy__astropy-14369: baseline>vtrace vs vtrace>baseline; arm order index mismatch for VTRACE_EXTERNAL_VEXP_100:astropy__astropy |
| `F12_SEED` | GUARD_FIRES | satisfied | run VTRACE_EXTERNAL_VEXP_100:astropy__astropy-14365:baseline carries seed some-other-seed, expected M214-VTRACE-EXTERNAL-VEXP-100-v1; run VTRACE_EXTER |
| `F13` | GUARD_FIRES | satisfied | cohort is not finalisable: 148 of 200 planned runs are terminal |
| `F13_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F14` | GUARD_FIRES | satisfied | exclusion category AGENT_FAILED_TASK is not preregistered; outcomes are not exclusions |
| `F14_UNUSED` | GUARD_FIRES | satisfied | exclusion category TREATMENT_NEVER_INVOKED is not preregistered; outcomes are not exclusions |
| `F14_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F15` | GUARD_SILENT | satisfied | no issue reported |
| `F16` | GUARD_FIRES | satisfied | paired analysis operand (right) "vexp_published" carries evidence class EXTERNAL_VENDOR_REFERENCE; external references have no per-task paired outcome |
| `F16_TABLE` | GUARD_FIRES | satisfied | causal table contains external vendor reference "VEXP published"; it belongs in a separate external-reference table |
| `F16_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F17` | GUARD_FIRES | satisfied | the external vendor reference is labelled "Arm C — experimental arm (VEXP)"; it is not an experimental arm, a paired observation or a causal comparato |
| `F17_WORDING` | GUARD_FIRES | satisfied | forbidden external claim "VTRACE beat VEXP": 'beats' asserts a head-to-head result; the systems were never run in the same harness; a numeric comparis |
| `F17_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F18` | GUARD_FIRES | satisfied | external-reference task artifact drift: the published 73/100 describes artifact 7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d, but  |
| `F19` | GUARD_FIRES | satisfied | vtrace arm inherited treatment state under a COLD_UNIFORM policy: .vtrace; reset policy is asymmetric across arms: baseline preserve [nothing]; vtrace |
| `F19_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F20` | GUARD_FIRES | satisfied | reset preserves treatment state .vexp under a COLD_UNIFORM policy; that treatment would be warm on the next task while any treatment not on the preser |
| `F20_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F21` | GUARD_FIRES | satisfied | tsconfig.m214.json reports an error for the injected fault |
| `F22` | GUARD_FIRES | satisfied | evaluation artifacts reachable from agent context: /testbed/.gold.patch, /testbed/FAIL_TO_PASS.json |
| `F23` | GUARD_FIRES | satisfied | conversation state reused from astropy__astropy-14365:baseline; patch state reused from astropy__astropy-14365:baseline |
| `F24` | GUARD_FIRES | satisfied | external reference snapshot changed: recorded 822c4c5fb69dc21b8ada04189e73fcadb3e5ab1bf7c06a855dd4582a6ec7834b, computed eca30cc89ce6b973d15ef646ae357 |
| `F24_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F25_ARM_CROSS_CONTAMINATION` | GUARD_FIRES | satisfied | vtrace arm carries forbidden environment variables: VEXP_LICENSE; vtrace arm workspace contains forbidden entry .vexp at agent start |
| `F25_CLEAN` | GUARD_SILENT | satisfied | no issue reported |
| `F26_LIFECYCLE_ORDER` | GUARD_FIRES | satisfied | lifecycle phase out of order: TREATMENT_INITIALISATION occurs after a later phase; the pre-agent untracked snapshot is taken BEFORE treatment initiali |
| `F27_EXTERNAL_HASH_STABLE` | GUARD_SILENT | satisfied | no issue reported |

## 14. Launch gates

| gate | requirement | status | evidence |
| --- | --- | --- | --- |
| G1 | M214 preregistration committed | **PASS** | stage5_m214_preregistration.json generated from the committed authority module |
| G2 | M214 preregistration hash recorded | **PASS** | domain-separated sha256 over the canonical document, recomputed from the written file |
| G3 | M213 remains immutable | **PASS** | M213's committed preregistration rehashes to its recorded digest under M213's own rule |
| G4 | exact VEXP 100-task artifact verified | **PASS** | sha256 of the vendor's own committed jsonl, plus their published distribution table |
| G5 | 100 task ids frozen | **PASS** | the instance ids are committed in the preregistration before any run |
| G6 | 200-run manifest frozen | **PASS** | 200 planned rows generated before any execution, hashed |
| G7 | baseline is treatment-free | **PASS** | F3 control: no VTRACE server, tool, env var, workspace entry or generated file |
| G8 | VTRACE treatment executable | **PASS** | M213's per-repository index + tools/list + deterministic query dry run, 12/12 repositories |
| G9 | VTRACE identity frozen | **PASS** | commit SHA and src tree SHA both recorded; the tree is unchanged since M213 measured it |
| G10 | agent identity frozen | **PASS** | one frozen agent record shared by both arm definitions |
| G11 | model identity frozen | **PASS** | one frozen model record shared by both arm definitions |
| G12 | native tools identical across arms | **PASS** | F7 control over the arm definitions |
| G13 | budgets identical across arms | **PASS** | F6 control plus one budget-identity digest carried on every manifest row |
| G14 | source states equivalent before each arm starts | **DEFERRED_TO_LAUNCH** | the guard exists and its mechanism is measured (indexing is observational on tracked source across 12 repositories); per-run equality can only be asserted when runs exist; asserted per run by auditSourceStateEquivalence (m214TreatmentLifecycle.ts) |
| G15 | indexing is observational on tracked source | **PASS** | F5 control: tracked-source digest measured before and after treatment initialisation |
| G16 | .vtrace excluded from patch capture | **PASS** | F4 control, reproduced against a real index: the old capture leaks, the new one is empty |
| G17 | metadata reset / warm policy symmetric and verified | **PASS** | F19 and F20 controls over the frozen COLD_UNIFORM policy |
| G18 | execution-order randomisation frozen | **PASS** | seeded 50/50 arm-order assignment, seed committed, orders in the manifest |
| G19 | evaluator validated | **PASS** | swebench==4.1.0 official evaluator, the harness M192 established and M213 re-verified |
| G20 | primary paired analysis frozen | **PASS** | M214_STATISTICAL_PLAN |
| G21 | efficiency analysis frozen | **PASS** | M214_SECONDARY_OUTCOMES |
| G22 | invalid-run rules frozen | **PASS** | M214_EXCLUSIONS |
| G23 | fixed-N stopping frozen | **PASS** | M214_STOPPING_RULE |
| G24 | external VEXP reference frozen | **PASS** | published figures, sources, retrieval date and source digest committed before any run |
| G25 | external reference cannot enter causal analysis | **PASS** | F16 and F17 controls: the paired-statistics entry point rejects a non-arm operand |
| G26 | M214 falsification suite passes | **PASS** | F0–F24 |
| G27 | no frozen-population outcome-bearing agent run has occurred | **PASS** | M214 spend accounting |
| G28 | live model spend is $0 during preregistration | **PASS** | no model was called by any M214 script |
| G29 | M214-owned harness and tests are typechecked | **PASS** | tsconfig.m214.json includes this milestone's test files, which the repo-wide benchmark config excludes |
| G30 | model availability established | **PASS** | the agent binary's own model registry carries a complete unflagged entry; a provider-confirmed response would require a paid call |
| G31 | treatment lifecycle ordering executed and verified | **PASS** | the pre-agent untracked snapshot is taken AFTER treatment initialisation — executed on real repositories by the patch-capture probe and audited from the resulting trace, which is what makes G16 hold |
| G32 | a launch executor exists that can run the frozen manifest | **FAIL** | the component that would create the containers, run the lifecycle per run and bind this preregistration's hash before the first paid call; M213 listed building it as the outstanding infrastructure work and M214 is not scoped to build it |

2 of 32 gates are not PASS:

- **G14** (DEFERRED_TO_LAUNCH) — source states equivalent before each arm starts
- **G32** (FAIL) — a launch executor exists that can run the frozen manifest

## 15. Typecheck scope

```text
M214_NEW_TYPECHECK_ERRORS                 0
PREEXISTING_BENCHMARK_TEST_TYPE_ERRORS    59  (outside M214 scope)
```

`tsconfig.m214.json` includes this milestone's test files, which
`tsconfig.benchmarks.json` excludes. Repository-wide benchmark tests remain
untypechecked, and M214 does not claim otherwise: the pre-existing errors are in
historical benchmark test files and cleaning them up is not authorised here. The
scoped target is proven able to fail by injecting a type error into a file it
covers and observing the error, then removing it.

## 16. Authorisation

```text
PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY
```

No run has started. No model has been called. Starting the cohort requires every
gate above to be PASS and an explicit spending authorisation that this document
does not grant.

