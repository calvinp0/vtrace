# VTRACE Architecture and Live Debugging Manual

> Ownership + live-debug reference for the product owner. Written from static
> inspection of `src/` and `benchmarks/stage5_vexp_swe_bench_smoke/` at the
> post-M92 state (`4b662e6`). Companion machine map:
> [`stage5_m93a_architecture_map.json`](../benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m93a_architecture_map.json).
> This document changes no code and no retrieval/scoring/ranking/Capsule behavior.

---

## 1. Product Mental Model

**What VTRACE does.** VTRACE builds a deterministic, repo-local AST/symbol index of
a codebase and, on request, returns a small, inspectable *context capsule* — the
smallest useful slice of code evidence for a task — instead of dumping whole files
or broad grep output. It exposes this through a CLI (`vtrace …`), an MCP server (for
Claude Code / Codex), and a VS Code surface. The headline goal is **fewer first-pass
tokens for a coding agent** by handing it the right pivot symbols up front.

**What VTRACE does *not* do.** It does not run code, edit code, apply patches, or
evaluate correctness. It is *structural only*: outputs come from the indexed AST —
no runtime tracing, no dataflow inference, no fuzzy architectural guessing. It does
not decide whether a patch is right; it only supplies context.

**What the coding agent does.** In the Stage 5 benchmark, the external
`vexp-swe-bench` harness owns a real Claude Code agent: it runs the turn loop, calls
tools (read/search/edit/bash), writes the patch, and extracts the final `modelPatch`.
VTRACE only *injects context* into that agent's first prompt. The agent's tool calls
and conversation are where the tokens are actually spent.

**What the Stage 5 harness does.** `run_stage5_vexp_swe_bench_smoke.ts` is a thin
wrapper around the external harness. It reproduces a task workspace at the gold base
commit, indexes it, queries VTRACE for a capsule, injects that capsule into the
agent prompt (via a local patch to the external adapter), captures every artifact,
then (separately) runs Docker evaluation and builds reports. It is *internal
benchmark/engineering machinery*, not a user-facing product feature.

**What the safety guards do.** They protect the operator's machine and the
benchmark's validity while a real agent runs shell commands. The **M89 env guard**
refuses to spawn unless the agent will use a disposable testbed interpreter. The
**M90A shell guard / host-pip firewall** sanitizes the agent's `PATH`/env and blocks
host/base Python mutation (`pip install`, `conda install`, …). They are safety
infrastructure, mandatory and fail-closed — *not* behavioral experiments.

---

## 2. End-to-End Data Flow

```
task text (problem_statement, FAIL_TO_PASS, hints)
   │   run_stage5_vexp_swe_bench_smoke.ts (run-vtrace / run-protocol vtrace-indexed)
   ▼
repo / index  ──────────────► indexProject()               src/indexer/indexProject.ts:38
   │   scanRepo()  src/fs/scanRepo.ts:55                     (SQLite .vtrace/index.sqlite)
   │   parsers     src/parsers/*Parser.ts
   ▼
retrieval  ─────────────────► hybridRetrieve()              src/retrieval/hybridRetrieval.ts:143
   │   scoring     hybridScoring.ts::combineFinalScore:162
   │   pivots      microTargets.ts:96 / assignCandidateRoles.ts:61
   ▼
capsule  ───────────────────► buildCapsuleV2()              src/capsuleV2/buildCapsuleV2.ts:130
   │   budget tiers  budgetAllocator.ts::allocateBudget:49
   ▼
digest / contract  ─────────► renderCapsuleV2Digest()       src/capsuleV2/productAdapter.ts:516
   │   compact header compactDigestHeader:350
   │   decision       buildDigestDecisionContract:589 (+ confidence gate:291)
   │   truncation      sectionBudgetAccounting.ts::truncateContextByPriority:358
   │   stage5 seams    run_stage5…ts::buildStage5DigestEnrichments:4817
   ▼
agent prompt  ──────────────► _vtrace_instructions.md  +  local-patch injection into
   │                            the external Claude Code adapter (VTRACE_AGENT_INSTRUCTIONS_FILE)
   ▼
agent tool calls  ──────────► external vexp-swe-bench turn loop (real Claude agent)
   │   captured as             raw/vtrace/_tool_calls.json
   ▼
patch  ─────────────────────► modelPatch in raw/vtrace/swebench-*.jsonl
   │                            (runCondition spawns the agent — run_stage5…ts:7984)
   ▼
Docker eval  ───────────────► --mode evaluate --eval-mode docker
   │   node dist/cli.js evaluate <jsonl>  → mutates `resolved` in place, writes _eval.meta.json
   ▼
metrics / report  ──────────► --mode ingest → CSV/JSON/MD + m34_accounting.ts token attribution
```

Every arrow's responsible code is named above. The single point where a real agent
is spawned is `runCondition()` (`run_stage5_vexp_swe_bench_smoke.ts:7984`); the
safety-guard gate sits immediately before that spawn.

---

## 3. Repository Indexing

**Entrypoint.** `indexProject(options)` — `src/indexer/indexProject.ts:38`. The
pipeline is: scan → read → parse → persist → prune deleted → resolve inter-file
edges → record run state. The CLI wrapper is
`runIndexCommand` (`src/cli/commands/indexCommand.ts:15`) →
`reindexRepoAndRefreshState` (`src/runtime/reindexRepo.ts:51`).

**File discovery.** `scanRepo(repoRoot)` — `src/fs/scanRepo.ts:55` — recursively
walks the tree and returns sorted `FileRecord[]` (path, language, contentHash,
sizeBytes).

**Ignore rules.**
- Hardcoded directory skips in `scanRepo.ts` (`.git`, `.vtrace`, `node_modules`,
  `dist`, `build`, `__pycache__`, `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`,
  `target`, `.idea`, `.vscode`, `vendor`, …).
- Per-directory ignore files via `src/fs/ignoreRules.ts`:
  `loadIgnoreRulesForDirectory` (line 29) reads `.gitignore` / `.ignore` /
  `.vtraceignore` (last has highest precedence); `isPathIgnored` (line 238) supports
  `**` globs and negation (`!pattern`) re-includes.
- Language filter: `detectLanguage` (`src/fs/languageDetection.ts:10`) — files whose
  extension is unknown are skipped.

**Parser responsibilities.** Dispatch via `createParserRegistry`
(`src/parsers/LanguageParser.ts:23`).
- **TypeScript/JavaScript** — `createTypeScriptParser` (`typescriptParser.ts:44`):
  functions, classes, interfaces, type aliases, class methods.
- **Python** — `createPythonParser` (`pythonParser.ts`): spawns a CPython subprocess
  running the `ast` module; functions (sync/async), classes, methods, module-level
  assignments (constant/variable/alias). Export indexes are content-cached to avoid
  O(n²) subprocess spawns.
- **Cython** — `createCythonParser` (`cythonParser.ts:109`): Python-plus-typed, with
  `cimport` and `.pxd` header support; cross-links Python↔Cython exports.

**Symbols and relations recorded.** `SymbolKind` ∈ {Function, Class, Method,
Interface, TypeAlias, ModuleConstant, ModuleVariable, ModuleAlias}. `EdgeType` ∈
{**Contains** (class→method), **Imports**, **Calls**, **References**}, each with a
`[0,1]` confidence. Distinctive *body literals* (diagnostic codes like `TS2345`,
`ERR_INVALID_ARG_TYPE`, quoted error messages) are extracted by
`buildSymbolBodyLiterals` (`extractBodyLiterals.ts:127`) for bug-report recovery.

**Where the index is stored.** `.vtrace/index.sqlite` (opened by
`openIndexerDatabase`, `src/db/sqlite.ts:5`; schema in `src/db/schema.ts`). Core
tables: `files`, `symbols`, `edges`, `index_runs`, `file_run_states`,
`symbol_run_states`. FTS5 virtual tables: `symbol_search_fts`,
`symbol_body_literals_fts`. Freshness metadata: `.vtrace/index.meta.json`.

**Stale / deleted files.** `pruneRemovedFiles` (`indexProject.ts:344`) diffs scanned
files against the DB and cascades deletes of stale files + their symbols/edges +
FTS rows. `checkIndexFreshness` (`indexMeta.ts:163`) compares six fingerprints —
index format version, schema (DDL hash), parser fingerprint, indexer fingerprint,
scan-config hash, and git HEAD — so a change to the parser or scan config
invalidates the index. `vtrace watch` marks stale on file change; `--auto-reindex`
is explicit opt-in. Inter-file edges are only inserted when both endpoints resolve
(`persistResolvableInterFileEdges`).

**Languages supported.** TypeScript, JavaScript, Python, Cython. (`calls` edges are
extracted for Python, TypeScript, and Cython.)

---

## 4. Retrieval and Pivot Selection

**Task text → candidates.** `hybridRetrieve()` — `src/retrieval/hybridRetrieval.ts:143`
— runs six independent, union-pooled candidate generators:
1. **Lexical** (`lexicalCandidates`, line 183) → `searchSymbols()` FTS5 + heuristics.
2. **Symbol/path** (line 212) → symbols/files implied by query shaping.
3. **Failing-test** (line 256) → test imports/calls → implementation symbols.
4. **Body-literal** (line 298) → distinctive task literals (error codes/messages)
   found in symbol source.
5. **Graph expansion** (line 392) → bounded BFS (≤2 hops, cap 24) over neighbors.
6. **Same-module** siblings (bundled into graph expansion).

**Scoring/ranking.** `assemble()` (line 422) normalizes raw signals to `[0,1]` and
`combineFinalScore()` (`hybridScoring.ts:162`) takes a weighted sum:
`lexical·1.0 + symbol·1.2 + path·0.8 + domain·0.9 + testToImpl·1.3 + graph·1.0 +
centrality·0.5 + bodyLiteral·1.4`. Two corrective penalties run before sorting:
`evaluateHub` (line 225) strips graph+centrality from high-degree framework roots
that lack local evidence; `evaluateActionability` (line 295) strips graph+domain
from non-function/method/class symbols (module vars/constants) without direct
evidence. Note centrality is the *weakest* weight (0.5) by design — it never wins
alone.

**Pivot selection.** `recoverMicroCapsule` (`src/capsule/microTargets.ts:96`) runs
retrieval and caps pivots (default 1). `assignCandidateRoles`
(`src/capsule/assignCandidateRoles.ts:61`) applies the *micro-policy bar* to label
each candidate **pivot / support / discard**. A candidate is a pivot iff it is
actionable (function/method/class, not a module var), has direct evidence
(symbol/path/testToImpl > 0 or lexical ≥ 0.5), has local evidence ≥ 0.3, is not
hub-penalized, and is not a framework hub. `detectPivotAmbiguity` (line 95) flags
ambiguity when the runner-up ≥ 85% of the leader's score.

**Confidence gate** (`--pivot-confidence-gate`, M68).
`classifyDigestPivotConfidence` (`src/capsuleV2/digestDecisionContract.ts:291`) is a
pure function that keeps a pivot **REQUIRED** only when the evidence text is strong
(source-line anchor, exercised by a failing test, explicit edit-site, direct
graph/import/call edge, or issue-domain overlap). Weak evidence (lexical-only,
facade/wrapper hub, test-file-without-test-issue, unknown) **demotes** the pivot to
optional. If *every* candidate demotes, the contract emits the zero-required marker
`<VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET>` (line 42) so an intentional
empty-required contract is distinguishable from an accidental miss. The gate is
opt-in and operates only on the bounded contract's required pivots.

**Why impact reps are optional/FYI.** Impact representatives are cross-file
dependents of the lead pivot (`impactDigestSeam.ts:25`, max 3). The M65 audit found
required impact reps were **edited 0/24** across a validation set — they are never a
*reason* to edit, only context — so they were demoted to the optional/FYI section
(coverage rose 88.7%→93.6%, ignored fell 5.6%→4.3%). See
[project_real_10880 / M65 notes] and the digest contract source (lines 217–238).

**Common failure modes** (all mitigated in `hybridScoring.ts`):
- *Symptom latch* — exception names tokenize to symptom nouns (`IndexError`→`index`)
  matching symptom-named symbols. Mitigation: exception-symptom de-anchoring
  (lines 462–508).
- *Generic-word over-rank* — a candidate matched only by a generic word rides to
  pivot. Mitigation: 0.25× down-weight (`analyzeLexicalGenericMatch`, line 524).
- *Hub over-rank* — a framework root (e.g. Django `Model`) with centrality 1.0
  outranks the real target. Mitigation: hub penalty.
- *Low-actionability over-rank* — module-level config var ranks high. Mitigation:
  actionability penalty.
- *Test-file retention* — a test file surfaces as edit target. Mitigation: failing-
  test expansion + micro discards test symbols.

---

## 5. Capsule v2 and Digest Injection

**What Capsule v2 contains.** `buildCapsuleV2(input)` —
`src/capsuleV2/buildCapsuleV2.ts:130` — returns a `CapsuleV2Result`
(`src/capsuleV2/types.ts`) with: `intent`, `actual_mode` (tier), `budget`,
`pivots[]` and `support[]` (each a `CapsuleV2Item` with path/symbol/roleReason/
estimatedTokens), `discarded[]`, and `diagnostics`. Each pivot is rendered on a
**ladder** (full source → signature-only → skeleton/name-only) and greedily filled
to fit the budget; the lead pivot is always rendered at least as a skeleton. If no
high-confidence pivots are found, the capsule is intentionally empty (not padded).

**Budget tiers.** `allocateBudget` (`budgetAllocator.ts:49`): **micro** (<1,500 tok →
1 pivot, 1 support), **standard** (1,500–12,000 → 2 pivots, 4 support), **full**
(≥12,000 → 5 pivots, 10 support, still bounded by the token budget). Stage 5 default
budget is 8,000 (standard).

**Compact digest injection** (`--compact-digest-injection` /
`--inject-capsule-digest`). `renderCapsuleV2Digest` (`productAdapter.ts:516`) with
`compactDigestHeader` (line 350) renders a bounded action-map view of the capsule:
the query is truncated to 800 chars (head/tail excerpt, not the whole issue body),
and each item reason is collapsed to a single line ≤100 chars. This exists because
M61B/M62 found an 8K+ raw header could crowd out the decision contract.

**Digest decision contract** (`--digest-decision-contract`).
`buildDigestDecisionContract` (`digestDecisionContract.ts:589`) asks the agent to
make an explicit, machine-readable decision for each target
(`EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT` with a reason and files touched), wrapped
in `DIGEST_DECISION_CONTRACT_START/END` sentinels. This forces the agent to close
the loop on each pivot rather than silently ignore it.

**Bounded decisions** (`--bounded-digest-decisions`).
`selectBoundedDigestDecisionTargets` (line 320) caps the contract at **4** targets
(lead pivot → hidden co-pivot → up to 2 cross-file impact reps),
`renderBoundedDigestDecisionContractText` (line 474) renders them with anti-over-edit
guardrails. The runner enforces the prerequisite chain: `--bounded-digest-decisions`
requires both `--inject-capsule-digest` and `--digest-decision-contract`.

**Required vs optional targets & zero-required markers.** `required[]` = lead +
hidden co-pivot (load-bearing, an EDIT decision is expected); `optional[]` = impact
reps and demoted pivots (INSPECT/RULE_OUT is fine). When the confidence gate demotes
every candidate, `noHighConfidenceRequired` is set and the
`NO_HIGH_CONFIDENCE_REQUIRED_MARKER` is emitted — an explicit "no required target"
signal, not an empty contract by accident.

**Section-priority truncation.** `truncateContextByPriority`
(`sectionBudgetAccounting.ts:358`) enforces the char budget by **dropping whole
non-essential sections in priority order** (diagnostic → optional → important),
preserving *essential* pivot-neighborhood source, and only falling back to a legacy
head-slice if essential sections alone exceed budget. It records a `VtraceContextBudget`
(`truncationOccurred`, `essentialSectionsEvicted`, `optionalSectionsDropped`, …).
This was the M45 fix for the earlier global head-slice that could evict the pivot
neighborhood — see [[project_capsule_truncation_section_blind]].

**How this reduces tokens.** Four layers compound: (1) laddered rendering drops deep
source to signatures/skeletons under a tight budget; (2) tier caps force single-
target precision at the micro tier; (3) section-priority truncation removes advisory
scaffolding while keeping code evidence; (4) compact digest bounds the header even
when the issue text is huge. The *product* claim is smaller first-pass injected
context — but see §9: on Stage 5 the injected capsule is a small share of total
spend, so most measured reduction actually comes from the agent needing fewer tool
calls / less conversation replay.

**Stage 5 injection seams.** `buildStage5DigestEnrichments`
(`run_stage5_vexp_swe_bench_smoke.ts:4817`) folds three extra optional seams into the
digest — impact (`buildStage5ImpactSeam`), project rules
(`buildStage5RulesSeam`), and session memory (`buildStage5MemorySeam`).

---

## 6. Stage 5 Harness

**Why it lives under `benchmarks/stage5…`.** Stage 5 is *external benchmark
validation*, not product code. It wraps the third-party `vexp-swe-bench` harness
(which owns the agent loop and patch extraction) and is deliberately isolated from
`src/` so it can never be mistaken for the shipped product surface. It has its own
typecheck project (`tsconfig.benchmarks.json`).

**What `run_stage5_vexp_swe_bench_smoke.ts` does.** One big multi-mode runner. Modes
(from the README + `--help`): `prepare`, `run-baseline`, `run-vtrace`, `run-vexp`
(gated behind `--allow-vexp`), `run-protocol` (`baseline|vtrace-indexed|vexp|all`),
`evaluate`, `ingest`, `report`, `aggregate-runs`, `install-vtrace-patch`,
`verify-vtrace-patch`. For the vtrace condition it reproduces the workspace at the
gold `base_commit`, indexes it, runs `vtrace capsule <workspace> "<task>"`, writes a
per-instance context block to `results/_vtrace_instructions.md`, and injects it via
the installed local patch — always with `--no-vexp` (baseline agent vs same agent +
VTRACE, never vexp-vs-vtrace).

**Key capsule/digest flags** (parsed in the arg loop ending at `--help`, line 10760):
`--context-policy force-inject`, `--capsule-engine v2|v1`, `--capsule-intent`
(default `auto`), `--capsule-budget` (default `8000`), `--inject-capsule-digest`,
`--digest-decision-contract`, `--bounded-digest-decisions`,
`--compact-digest-injection`, `--pivot-confidence-gate`, `--capture-product-v2-accounting`,
`--disable-pivot-check`, `--pivot-inspection-enforcement`, `--pivot-revision-pass`,
`--run-label`, `--out`.

**What `runCondition` does.** `runCondition()`
(`run_stage5_vexp_swe_bench_smoke.ts:7984`) is the *single* function that spawns a
real agent. Since M89 it **fails closed before spawn**: it creates the run dir (so
failure metadata can be written), then requires the env guard + drift check enabled,
an expected testbed prefix resolved, and the prefix preflight `pass`; since M90A it
also requires the shell guard + host-pip firewall materialized. Any miss throws
*before* any model call, Docker eval, or external-harness mutation. Offline modes
(ingest/report/replay/preflight) never call `runCondition`, so they are exempt.

**Run labels → artifacts.** `rawConditionDir` (line 1386) maps a `--run-label` to
`results/runs/<label>/raw/<condition>/` (or the legacy `results/raw/<condition>/`
with no label). Each labelled run holds:
- `raw/vtrace/swebench-*.jsonl` — canonical row (`modelPatch`, `resolved`,
  `instanceId`, `costUsd`, `numTurns`, token fields).
- `raw/vtrace/_run.meta.json` — engine/injection/guard/telemetry meta (written at
  line 8318; **camelCase** keys such as `vtraceEffectiveCapsuleEngine`,
  `vtraceContextInjected`, `vtraceCapsulePivots`, `stage5_env_guard_status`).
- `raw/vtrace/_tool_calls.json` — ordered read/search/edit tool calls.
- `raw/vtrace/_eval.meta.json` — post-evaluate evidence.
- `runs/<label>/_vtrace_instructions.snapshot.md` — immutable snapshot of the
  injected context (`vtraceInstructionsSha256` in the meta).

**Where prompt/context artifacts live.** Latest injected block:
`results/_vtrace_instructions.md` (overwritten per run — lives at the results root,
*not* under `raw/vtrace/`, because the external `run` clears its own output dir).
Immutable per-run copy: the snapshot above.

**Where eval results live.** `evaluate --eval-mode docker` runs
`node dist/cli.js evaluate <jsonl>` in the external checkout, which mutates
`resolved` in place in the same JSONL and writes `_eval.meta.json`. `lightweight`
mode only checks patch non-emptiness and is **not** a pass/fail signal. Resolution
requires **all** FAIL_TO_PASS tests to pass — a partially correct patch reports
`resolved=0`.

**How Docker evals are launched/scored.** Two-step by design: `run` produces the
patch with `resolved:null`; `evaluate` runs the real SWE-bench suite in Docker
(`pip install swebench` + dataset) and fills `resolved`. Docker eval is isolated from
the host, so canonical resolution is unaffected by host/base contamination.

---

## 7. Safety Infrastructure

These layers are **mandatory and fail-closed** for live runs. They protect the
*operator's machine and benchmark validity*; they change no VTRACE
retrieval/scoring/Capsule behavior.

**M89 env guard** (`envIsolationGuard.ts`, `envIsolationProbe.ts`,
`stage5EnvGuardIntegration.ts`). `evaluateMandatoryLiveEnvGuard`
(`stage5EnvGuardIntegration.ts:149`) refuses to spawn unless `--stage5-env-guard`
and `--stage5-env-drift-check` are on, an expected testbed prefix resolves
(`resolveExpectedTestbedPrefix`, line 92: CLI flag → `$VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX`
→ else fail closed), and `evaluatePrefixGuard` (`envIsolationGuard.ts:251`) passes 7
read-only checks (testbed interpreter exists; `sys.prefix`/pip-prefix/`CONDA_PREFIX`
match; base/dev prefixes protected). `probePython`/`probePackageRecords` are
read-only snapshots for before/after drift. Mandatory since M89
([[project_m89_mandatory_env_guard]]).

**M90A shell guard** (`agentShellGuard.ts`, `stage5AgentShellGuardIntegration.ts`).
`materializeAgentShellGuard` (`stage5AgentShellGuardIntegration.ts:105`) writes a
wrapper `bin` dir (`_vtrace_agent_bin`) that shadows `pip/pip3/python/python3/conda/
uv/poetry/pipx`; `sanitizeAgentPath` (line 89) drops conda entries and prepends the
wrapper bin first; `scrubAgentCondaEnv` (line 141) blanks `CONDA_PREFIX`/
`VIRTUAL_ENV`/`PYTHONPATH` and sets `PYTHONNOUSERSITE=1` +
`PIP_REQUIRE_VIRTUALENV=true`. `evaluateMandatoryAgentShellGuard`
(`agentShellGuard.ts:387`) fails closed unless the guard + firewall are enabled and
the wrapper bin is materialized.

**Host-pip firewall.** The wrappers **block** host/base mutation (`pip install/
uninstall/download`, `python -m pip/ensurepip`, `conda install/remove/update`,
editable installs, `uv/poetry/pipx` mutation) with exit code 97 and log each block to
`_blocked_host_package_commands.jsonl`; they **allow** read-only ops (`pip
list/show/freeze/--version`, `conda info/list`) and delegate them to the real
interpreter.

**Drift checker.** `--stage5-env-drift-check` takes a read-only before/after package
snapshot (mtimes, pip/conda mismatch) around the run. It never mutates an
environment; it only reports whether a protected prefix changed.

**What they protect / do not protect.** They protect the operator's conda base/dev
prefixes from an agent's stray `pip install`, and they keep a run *benchmark-valid*.
They do **not** change resolution (Docker isolates that), do **not** sanitize inside
the Docker eval, and the env guard watches the *testbed* prefix only — it did not
catch the historical miniforge-*base* contamination (that motivated M90A). The escape
hatch `--allow-unguarded-live-env` exists for test/emergency only and permanently
marks the run **not benchmark-valid**.

**Why mandatory.** They close the M86/M90A hole where a bare `pip install -e .` inside
`.bench-repos` mutated host/base Python. Safety infra should be always-on; behavioral
experiments should be opt-in (§8). See [[project_m86_env_isolation_guard]].

---

## 8. Behavioral Guards

**V4 tool-loop guard** (`toolLoopGuard.ts`, `toolLoopGuardRuntime.ts`,
`toolLoopGuardHook.ts`). `runToolLoopGuard` (`toolLoopGuard.ts:274`) is a detector
over the tool-event stream with six triggers (repeated_failed_command,
repeated_command_family_error, repeated_read, repeated_search, repeated_edit_failure,
repeated_read_window). The **v4** calibration gates read-family triggers on prior
progress so it does not fire on legitimate early reading. When enabled in `inject`
mode it registers a PostToolUse hook (`buildToolLoopGuardHookSettings`, line 255) and
injects a recovery nudge mid-loop. **Default-off** (`DEFAULT_TOOL_LOOP_GUARD_CONFIG`
`enabled:false`, line 92).

**C7_D cost guard** (`costGuard.ts`, `costGuardRuntime.ts`, `costGuardHook.ts`).
`runCostGuard` (`costGuard.ts:245`) fires on high_tool_count / high_turn_count /
edit_verify_churn / no_patch_drift / repeated_verification_no_progress /
cost_cap_approaching, gated by `minToolCallsBeforeFire=25` and `minTurnsBeforeFire=8`.
The **c7d** calibration lowers `editVerifyChurnThreshold` 3→2 so it fires earlier.
**Default-off** (`DEFAULT_COST_GUARD_CONFIG` `enabled:false`, line 111). It shares one
combined PostToolUse hook with V4 (cost message prioritized near budget).

**Why default-off.** Per M85/M88/M90/M91 ([[project_m91_m90_attribution_policy]]),
both guards are *harmless but show no resolution benefit*: V4 fires are reactive
recovery nudges on already-thrashing runs (one fired and the case still resolved);
C7_D fires are neutral-late on cap targets (turns 25–32, all unresolved regardless).
Promoting them would only add injected-message noise and confound a clean
token-reduction measurement.

**How to enable for diagnostics only.**
`--tool-loop-guard --tool-loop-guard-mode inject --tool-loop-guard-calibration v4`
and/or `--cost-guard --cost-guard-mode inject --cost-guard-calibration c7d`. Use
`--tool-loop-guard-mode observe` / `--cost-guard-mode observe` for post-run analysis
with no mid-loop injection.

**Why they are not part of the core token-reduction story.** M92 deliberately ran
with both **disabled** so the measured reduction is attributable to the core VTRACE
capsule/digest treatment, not to behavioral nudges. They are opt-in diagnostics,
never headline levers.

---

## 9. Token and Cost Accounting

**Where the numbers come from.** The external `vexp-swe-bench` JSONL row carries the
agent's token usage and cost (from the Claude API usage records). The runner
tolerantly parses them via field aliases
(`run_stage5_vexp_swe_bench_smoke.ts:1726+`): `input_tokens`, `output_tokens`,
`cache_read_tokens` (aka `cache_read_input_tokens`), `cache_creation_tokens` (aka
`cache_write`). `total_tokens = input + output + cache_read + cache_creation`. The
capsule-attributable side is computed offline by `m34_accounting.ts` using the shared
`chars/4` estimator (`src/capsuleV2/tokens.ts`) — an approximation, never a real
tokenizer count, and the `accountingMethod` field says so.

**What the categories mean.**
- **input_tokens** — fresh prompt tokens the model reads uncached.
- **output_tokens** — tokens the model generates.
- **cache_read_tokens** — previously-cached prompt tokens re-read on later turns
  (cheap per-token, but they accumulate every turn as the conversation grows).
- **cache_write / cache_creation_tokens** — tokens written into the prompt cache.

**Why cache-read dominated M92.** In the M92 50-task run, **cache_read_tokens =
94.73%** of all tokens (input 0.02%, output 0.01%, cache_write 5.25%). A long agent
run replays its whole growing conversation (system prompt + injected context + every
prior tool result) on every turn; those replays hit the cache and are billed as
cache-read. So total token spend is driven by **how many turns / how much tool output**
the agent accumulates, not by the one-time injected capsule (mean injected context
≈ 11,560 chars ≈ a few thousand tokens).

**How to find per-run token spend.** Read
`results/runs/<label>/raw/vtrace/swebench-*.jsonl` (`total_tokens`, `costUsd`,
`numTurns`) or the ingested CSV/JSON report (`stage5_vexp_swe_bench_smoke.{csv,json}`,
per-condition `mean_total_tokens`).

**How to identify token-heavy cases.** The M92 attribution
(`stage5_m92_token_attribution.json`) already ranks them: `top10_cost_heavy`,
`high_cost_unresolved`, `top10_context_heavy`. The top-10 cost-heavy cases account for
**65.72%** of total spend; the heaviest is `django-16263` ($3.03, 4.57M tokens, 97
turns, unresolved).

**Why reduction is mostly conversation/tool-output, not smaller capsules.** Because
cache-read (conversation replay) is 94.7% of spend and the capsule is a small fixed
header, the −25% cost / −26.7% token reduction vs the M73 baseline tracks the −30.2%
**tool-call** reduction far more than any change in capsule size. The token-reduction
lever is *getting the agent to the right edit in fewer turns/tool calls*, which a good
capsule enables — not shrinking the capsule itself.

---

## 10. Live Debug Playbook

Exact templates. Set once:

```bash
RUNNER=benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts
VEXP=/home/calvin/code/vexp-swe-bench
OUT=benchmarks/stage5_vexp_swe_bench_smoke/results
PREFIX=/home/calvin/miniforge3/envs/vexp_swebench
INSTANCE=django__django-16263      # example
LABEL=debug-16263
```

**A. Pick an instance.** Choose from the M92 run matrix
(`stage5_m92_core_reduction50_validation.md`) — prefer a high-cost or discordant case
you want to understand.

**B. Preflight only (no agent).**

```bash
# Runner help — enumerate supported flags/modes
bun "$RUNNER" --help

# No-agent preflight: validity + guard config for the slice (M92 preflight script)
bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m92_preflight.ts
```

> The runner itself has **no** `--dry-run` flag; the safe no-agent equivalents are
> `--help`, the `run_stage5_m*_preflight.ts` scripts, and the offline capsule
> inspection in step C. Any offline mode (`ingest`/`report`/`aggregate-runs`) also
> never spawns an agent.

**C. Inspect the capsule / digest offline (no agent, no tokens).**

```bash
# Reproduce/refresh the workspace index, then render the capsule that WOULD be injected
bun src/cli/index.ts index "$OUT/workspaces/$LABEL/$INSTANCE"
bun src/cli/index.ts capsule "$OUT/workspaces/$LABEL/$INSTANCE" \
  "<problem statement text>" --intent auto --budget 8000 --pivot-neighborhood --json
```

Read the JSON: are the gold file(s) in `pivots[]`? Is the lead pivot REQUIRED?

**D. Confirm safety guards.** Verify `--stage5-env-guard`, `--stage5-env-drift-check`,
`--expected-testbed-prefix "$PREFIX"` are present and the shell guard/firewall are on
(default). A missing guard makes the run fail closed — that is the intended floor.

**E. Run ONE live treatment (only after explicit approval — spends money).**

```bash
bun "$RUNNER" --mode run-protocol --protocol vtrace-indexed \
  --vexp-swe-bench-dir "$VEXP" --instances "$INSTANCE" \
  --capsule-engine v2 --capsule-intent auto --capsule-budget 8000 \
  --inject-capsule-digest --digest-decision-contract --bounded-digest-decisions \
  --compact-digest-injection --pivot-confidence-gate \
  --capture-product-v2-accounting --disable-pivot-check \
  --stage5-env-guard --stage5-env-drift-check --expected-testbed-prefix "$PREFIX" \
  --stage5-agent-shell-guard --stage5-host-pip-firewall \
  --run-label "$LABEL" --out "$OUT"
```

**F. Inspect `_run.meta.json`** (`$OUT/runs/$LABEL/raw/vtrace/_run.meta.json`, camelCase):
`vtraceContextInjected`, `vtraceEffectiveCapsuleEngine`,
`vtraceCapsulePivots`/`vtraceCapsuleSupport`, `stage5_env_guard_status`,
`stage5_blocked_unsafe_pip_command_count`.

**G. Inspect prompt/digest artifacts.** `runs/$LABEL/_vtrace_instructions.snapshot.md`
(exact injected block) and `results/_vtrace_instructions.md` (latest).

**H. Inspect the agent stream / tool calls.** `raw/vtrace/_tool_calls.json` (ordered
read/search/edit) and the `swebench-*.jsonl` row (`numTurns`, token fields).

**I. Inspect the patch.** `modelPatch` in `raw/vtrace/swebench-*.jsonl` — which files
did it touch? Compare against the gold spans.

**J. Run / read Docker eval (needs approval).**

```bash
bun "$RUNNER" --mode evaluate --eval-mode docker \
  --vexp-swe-bench-dir "$VEXP" --run-label "$LABEL" --out "$OUT"
# then read raw/vtrace/_eval.meta.json (resolvedCount, evaluationRan)
```

**K. Compare to baseline / prior run.** `--mode ingest --run-label "$LABEL"`, then diff
the report against the M92 row for the same instance (cost, tokens, tools, resolved).

**L. Classify the failure mode.** Use §11's decision tree: retrieval issue vs capsule
issue vs prompt issue vs agent variance vs environment.

---

## 11. Common Debug Questions

- **Why did VTRACE pick this file?** Read the capsule `roleReason` and the retrieval
  signals. A pivot is chosen by `combineFinalScore` (`hybridScoring.ts:162`) after
  hub/actionability penalties; the reason phrase (`describeSignals`,
  `assignCandidateRoles.ts:209`) tells you *which* signal won (lexical, symbol,
  test→impl, graph, body-literal).
- **Why was the obvious file missing?** Usually a retrieval miss: no lexical/graph
  path reached it, or it was hub- or actionability-penalized, or a
  symptom-latch/generic-word decoy outranked it. Re-run step C and inspect
  `discarded[]` + `diagnostics`.
- **Did the capsule get injected?** `vtraceContextInjected` in `_run.meta.json`; a
  `no_context` policy decision is valid (small/local task) and shows
  `vtrace_context_injected=false`, `vtrace_treatment_valid=true`.
- **Did the agent ignore the required target?** Check the digest decision markers /
  `PIVOT_DECISION` compliance (`pivotInspectionCompliance.ts`). If the required pivot
  got no EDIT decision, that is a context-to-action gap, not a retrieval miss.
- **Did token reduction come from fewer tool calls or smaller context?** Almost
  always fewer tool calls — cache-read (conversation replay) is ~95% of spend (§9);
  compare `tool_calls` and `numTurns`, not capsule size.
- **Did safety guards block anything?** `stage5_blocked_unsafe_pip_command_count` and
  `_blocked_host_package_commands.jsonl`. In M92 this was 0 across all 50 — no
  task-critical command was blocked.
- **Did Docker eval fail because of patch quality or environment?** If `_eval.meta.json`
  ran and FAIL_TO_PASS still failed, it is patch quality. Infra failures (API 529,
  clone failure) are flagged as `infra_failed` / `api_error_status` and excluded from
  resolution — rerun, never read as a loss.
- **Is this a retrieval, capsule, prompt, or agent-variance issue?** Retrieval = gold
  file absent from `pivots[]`/`discarded[]`. Capsule = gold present but truncated out
  (`essentialSectionsEvicted`) or demoted below required. Prompt = injected but the
  agent got a weak/ambiguous decision contract. Agent variance = context correct,
  required target edited, but a single-sample flip (the M91 profile — expect this on
  B/E cohorts).

---

## 12. Current Product State After M92

**Stable / shipped.** The core VTRACE product surface: repo-local AST indexing,
hybrid retrieval, Capsule v2 with compact digest injection, section-priority
truncation, session memory, CLI + MCP. These are unchanged by the M9x guard work.

**Mandatory.** M89 env guard (+ drift check) and M90A shell guard / host-pip firewall
for every live Stage 5 run — fail-closed, benchmark-invalidating if bypassed.

**Experimental / opt-in.** V4 tool-loop guard and C7_D cost guard (default-off
diagnostics); the pivot-inspection enforcement block (M12), the M14/M15 corrective
revision pass, and the `--pivot-check-gate hard` two-phase path (diagnostic-only).

**Should not be promoted.** V4/C7_D to default-on (no demonstrated resolution
benefit, M85/M88/M90/M91); the revision pass as a canonical-patch replacement (it is
a separate second pass, recovery cost tracked apart); any Stage 5 control-loop
machinery as a user-facing product setting.

**Evidence we have.** M92: 50 live runs on the frozen M90 slice, all env+shell-guard
clean (0 drift, 0 escape hatch, 0 task-critical blocks), behavioral guards provably
off, resolution 20/50 = M73 baseline, cost −25.0% and total tokens −26.7% vs baseline
with full token attribution (`stage5_m92_token_attribution.json`). Verdict PASS.

**Evidence we still lack.** A 100-task confirmation; VEXP parity or any public
SWE-bench claim; statistical superiority (single-sample per case, so B/E flips are
unseparated from agent non-determinism); turn-level attribution of the cache-read
spend; a bounded B-cohort variance replicate.

---

## 13. Next Optimization Targets

Ranked using the M92 attribution:

1. **cache-read / tool-output accounting.** `cache_read_tokens` = 94.73% of spend.
   The biggest lever is reducing *turns and tool output replayed each turn*, not
   shrinking the capsule. Do turn-level attribution on the heavy cases before
   optimizing blind.
2. **High-cost unresolved cases.** Top-10 cost-heavy = 65.72% of total spend
   ($23.88); e.g. `django-16263` (97 turns, unresolved), `sympy-20428`,
   `pydata-xarray-6599`. These are where a better first pivot could cut the most cost.
3. **Capsule / digest packing.** All 10 top context-heavy runs hit the 11,994-char
   truncation ceiling — verify the required pivot neighborhood survives truncation
   (`essentialSectionsEvicted` should stay false) rather than assuming smaller = better.
4. **Retrieval / pivot misses.** Cohorts A (1/14) and C (0/10) resolve poorly; audit
   whether the gold pivot neighborhood was even injected on their losses.
5. **Context-to-action gaps.** Correlate required-target decision-contract compliance
   with resolution — does forcing an EDIT decision on the required pivot actually move
   resolution, or is it presentation-only?

**Recommended next milestone — M93B:** *offline turn-level token attribution on the
top-10 M92 cost-heavy cases.* Replay the captured `_tool_calls.json` + stream to
localize where the cache-read/tool-output tokens accumulate (which turns, which tool
outputs), so the next behavioral change targets the proven 65.72%-of-spend tail
before committing to any live 100-task confirmation run. This spends no API money and
no Docker time, and directly attacks target #1.
