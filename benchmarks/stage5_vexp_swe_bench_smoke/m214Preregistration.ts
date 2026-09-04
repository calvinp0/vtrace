/**
 * M214 — the preregistration authority for `VTRACE_EXTERNAL_VEXP_100`.
 *
 * M213 preregistered the ideal experiment: baseline, VTRACE and VEXP under one
 * identical harness. It then discovered that the VEXP arm cannot be executed —
 * the installed CLI refuses to run, there is no licence, and the vendor's own
 * repository ceilings do not admit a twelve-repository population without a
 * purchase. That preregistration is FROZEN and remains committed exactly as it
 * was, as evidence that the direct comparison was designed before it was found
 * to be procurement-blocked.
 *
 * M214 is the strongest experiment available without that licence:
 *
 *     Arm A  BASELINE            ─────────────────►  Arm B  BASELINE + VTRACE
 *                                 paired causal
 *
 *                                       │  external reference, not an arm
 *                                       ▼
 *                          VEXP published 73 / 100
 *
 * Two evidentiary questions that must never be conflated:
 *
 *   CAUSAL    Does VTRACE change resolution relative to an identical baseline
 *             run in this harness? Answered by B − A on paired tasks.
 *   EXTERNAL  How does our absolute pass rate compare, descriptively, with the
 *             vendor's published number on the same frozen task population?
 *             Answered by placing two numbers side by side and saying so.
 *
 * The external number is never a paired observation, never an arm, and never
 * enters a causal statistic. That separation is enforced in code
 * (`m214ExternalReference.ts`), not by convention.
 *
 * This module is PURE: it reads the frozen task population off disk and
 * otherwise computes. It contains no product behaviour, is never imported by
 * `src/`, spawns nothing, and calls no model.
 *
 * Nothing here authorises spending. A frozen design is a precondition for a
 * paid run, not permission to start one.
 */

import { createHash } from "node:crypto";

import {
  M213_TASK_POPULATION_PATH,
  M213_TASK_POPULATION_PROVENANCE,
  M213_TASK_POPULATION_SHA256,
  VEXP_PUBLISHED_DISTRIBUTION,
  canonicalize,
  loadFrozenTaskPopulation,
  verifyPopulation,
} from "./m213Preregistration";

/**
 * M213 is imported, never edited.
 *
 * Re-deriving the population loader would let M214's copy drift from the one
 * that produced the frozen artifact, and re-declaring the artifact's digest
 * would let a typo silently redefine "the same population". Reading M213's
 * definitions is what makes "the exact same 100 tasks" a mechanical fact rather
 * than a claim. Every M214-specific commitment below is declared fresh.
 */
export {
  M213_TASK_POPULATION_PATH,
  M213_TASK_POPULATION_SHA256,
  VEXP_PUBLISHED_DISTRIBUTION,
  loadFrozenTaskPopulation,
  verifyPopulation,
};

// ── Identity (§5) ───────────────────────────────────────────────────

export const M214_EXPERIMENT_NAME = "VTRACE_EXTERNAL_VEXP_100" as const;
export const M214_PREREGISTRATION_SCHEMA = "stage5.m214.preregistration.v1" as const;
export const M214_MANIFEST_SCHEMA = "stage5.m214.run-manifest.v1" as const;

/**
 * A NEW seed, not M213's.
 *
 * Reusing M213's would make the two experiments' execution orders correlated
 * for no benefit, and would blur the line M214 exists to draw: this is a
 * different experiment with a different arm structure, not a subset of the
 * blocked one.
 */
export const M214_RANDOMIZATION_SEED = "M214-VTRACE-EXTERNAL-VEXP-100-v1" as const;

/**
 * The lineage M214 must never lose (§3, §44).
 *
 * Recorded values are asserted against the committed M213 artifacts by the
 * generator; the constants here are the expectation, not the source of truth.
 */
export const M214_PARENT = Object.freeze({
  milestone: "M213",
  experimentName: "VTRACE_VEXP_CAUSAL_100",
  preregistrationFile: "stage5_m213_preregistration.json",
  preregistrationHash: "5d90eddb9cc4759acf6a6fbc033d54ee0d5aea589a92c169daa7dca8d9c568c8",
  manifestFile: "stage5_m213_run_manifest.json",
  manifestHash: "0001072171e0e3aa4242a6865a7bf144cb3ffba145c89aeee27de99b18cbe9d9",
  armCount: 3,
  intendedRuns: 300,
  verdict: "M213 — INCOMPLETE",
  status: [
    "CAUSAL_BENCHMARK_PREREGISTERED",
    "TASK_POPULATION_FROZEN",
    "RUN_MANIFEST_FROZEN",
    "ANALYSIS_PLAN_FROZEN",
    "STOPPING_RULE_FROZEN",
    "VTRACE_TREATMENT_EXECUTABLE",
    "VEXP_TREATMENT_NOT_EXECUTABLE",
    "M213_FALSIFICATION_SUITE_PASSED",
    "PAID_RUNS_NOT_STARTED",
    "PAID_CAUSAL_BENCHMARK_NOT_READY",
  ],
  immutabilityRule:
    "M213's artifacts are read-only for every later milestone. M214 does not rewrite M213 as PASS, "
    + "does not remove the three-arm preregistration, and does not reuse its hash. A change to any "
    + "M213 artifact is a defect, not an update.",
  whyM214Exists:
    "The VEXP arm is blocked by product availability and licensing, not by a VTRACE engineering "
    + "defect. The three-arm design stays frozen and unexecuted; M214 preregisters the two-arm "
    + "causal experiment that CAN run, plus a clearly separated external reference to the vendor's "
    + "published result on the identical task population.",
});

/**
 * The blockers, recorded verbatim from M213's committed executability audit
 * (§4). They are not softened, re-researched or worked around, and M214 never
 * substitutes a VTRACE-authored reconstruction of VEXP for the real thing.
 */
export const M214_VEXP_BLOCKERS: readonly string[] = Object.freeze([
  "the installed CLI (2.0.24) refuses every invocation with an update-required notice, so no VEXP command can run on this host as it stands",
  "no licence is present in ~/.vexp, so the effective plan is FREE",
  "the free plan admits 1 repository, and the frozen population spans 12",
  "the free plan caps the graph at 2,000 nodes, and the largest repository in the population (django/django) carries 41,032 indexed symbols",
  "the platform core binary (@vexp/core-<platform>) is not installed, and it is the component that both indexes and enforces the plan",
]);

export const M214_VEXP_BLOCKER_VERDICT = "VEXP_TREATMENT_NOT_EXECUTABLE" as const;

// ── Task population (§6) ────────────────────────────────────────────

/**
 * The SAME artifact M213 froze: the vendor's own committed 100-task file.
 *
 * §42's guard is this constant. The vendor's published 73/100 is a statement
 * about THIS population; if the artifact's digest ever differs, the external
 * comparison is void until deliberately re-preregistered, because the published
 * number would then describe a different set of tasks.
 *
 * The population is NOT regenerated from the vendor's selection script. Their
 * script does not reproduce their own artifact — 22/100 overlap, independently
 * re-derived by M214 — so a "reproduction" from the script benchmarks a
 * different 78 tasks and cannot be compared with the published figure at all.
 */
export const M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256 = M213_TASK_POPULATION_SHA256;

/** The same file, under an M214 name, so callers need not reach into M213. */
export const M214_TASK_POPULATION_PATH = M213_TASK_POPULATION_PATH;

export const M214_TASK_POPULATION_PROVENANCE = Object.freeze({
  ...M213_TASK_POPULATION_PROVENANCE,
  inheritedFrom: "M213",
  regeneratedFromVendorScript: false,
  regenerationRefusedBecause:
    "the vendor's scripts/select-subset.py selects a different 100 tasks than the artifact shipped "
    + "beside it; the artifact is what the published 73/100 was computed on",
});

/**
 * M213's finding, re-derived by M214 rather than transcribed.
 *
 * The generator runs the vendor's own script against SWE-bench Verified and
 * records the ids it produces, so the overlap below is a measurement this
 * milestone made, and the script-derived set is available as the wrong-artifact
 * fixture F2 swaps in.
 */
export const M214_VENDOR_SCRIPT_MISMATCH = Object.freeze({
  script: "scripts/select-subset.py",
  scriptSeed: 42,
  overlapWithShippedArtifact: 22,
  overlapWithShippedArtifactUnderDocumentedComplexityFilter: 26,
  documentedFilterOmittedByScript: "complexity ≤ 250, listed as step 1 in the vendor's own docs",
  allocationDifferences: [
    "django/django 42 (script) vs 44 (artifact)",
    "sympy/sympy 14 vs 17",
    "scikit-learn/scikit-learn 6 vs 2",
    "sphinx-doc/sphinx 8 vs 7",
    "matplotlib/matplotlib 5 vs 7",
    "pydata/xarray 4 vs 6",
    "pylint-dev/pylint 3 vs 2",
    "psf/requests 5 vs 4",
    "mwaskom/seaborn 2 vs 1",
  ],
  status: [
    "EXACT_VEXP_SUBSET_AVAILABLE_AS_ARTIFACT",
    "EXACT_VEXP_SUBSET_NOT_SCRIPT_REPRODUCIBLE",
  ],
});

// ── Arms (§9–§11) ───────────────────────────────────────────────────

export type M214Arm = "baseline" | "vtrace";

export const M214_ARMS: readonly M214Arm[] = Object.freeze(["baseline", "vtrace"]);

/**
 * The ordinary coding tools, identical in both arms (§12).
 *
 * vexp-swe-bench's `DEFAULT_ALLOWED_TOOLS`, unchanged. M168-E measured that
 * denying `Grep`/`Glob` is itself a treatment that lost two tasks and won none,
 * so neither arm is narrowed: the question is whether VTRACE helps a competent
 * native-search agent, not whether it can replace grep.
 */
export const M214_NATIVE_TOOLS: readonly string[] = Object.freeze([
  "Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite",
]);

/**
 * The VTRACE treatment surface: `defaultMcpToolRegistry`'s model-visible
 * catalogue, which is exactly what `vtrace mcp-serve --repo <workspace>` serves
 * with no `--tools` flag.
 *
 * §11 asked whether any of these are internal benchmarking or debug tools
 * exposed merely because they exist. The generator answers it mechanically by
 * reading the registry and recording each tool's description and input-schema
 * digest; the audit's conclusion is that all fourteen are product-default,
 * agent-facing tools with task-facing descriptions, and that the registry
 * already hides its non-default surface (`search_symbols`, `build_capsule`,
 * `build_handoff`, `route_query` and the rest remain resolvable by id but
 * absent from `tools/list`). Nothing is added for the benchmark and nothing is
 * removed for it: the treatment is the product default or it is not the
 * product.
 */
export const M214_VTRACE_TREATMENT_CATALOG: readonly string[] = Object.freeze([
  "get_code_context",
  "run_pipeline",
  "index_repo",
  "check_capsule_staleness",
  "get_context_capsule",
  "get_impact_graph",
  "search_logic_flow",
  "get_skeleton",
  "index_status",
  "workspace_setup",
  "get_session_context",
  "search_memory",
  "save_observation",
  "expand_vexp_ref",
]);

export const M214_VTRACE_CATALOG_AUDIT = Object.freeze({
  source: "src/mcp/tools.ts defaultMcpToolRegistry.listMetadata(), read at runtime by the generator",
  howStarted: "vtrace mcp-serve --repo <workspace>, with NO --tools flag",
  catalogSize: 14,
  isProductDefault: true,
  benchmarkOnlyToolsIncluded: 0,
  debugOnlyToolsIncluded: 0,
  auditedFields: ["toolId", "description", "input schema", "required inputs"],
  conclusion:
    "All fourteen are agent-facing product tools whose descriptions address a coding task rather "
    + "than a benchmark. The registry's hidden surface is not exposed, and no tool is added, "
    + "removed or reworded for this experiment.",
  frozenAtFirstPaidRun: true,
});

export interface ArmDefinition {
  readonly arm: M214Arm;
  readonly label: string;
  readonly nativeTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly treatmentToolCatalog: readonly string[];
  readonly modelVisibleToolNames: readonly string[];
  readonly treatmentInstruction: string | null;
  /** Workspace entries this arm must not see at agent start (§10, §30). */
  readonly forbiddenWorkspaceEntries: readonly string[];
  /** Environment-variable prefixes this arm must not carry (§30). */
  readonly forbiddenEnvironmentPrefixes: readonly string[];
  /** Workspace state this arm's own treatment initialisation legitimately creates (§31). */
  readonly treatmentStatePaths: readonly string[];
}

/** Claude Code namespaces MCP tools as `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, toolId: string): string {
  return `mcp__${server}__${toolId}`;
}

/**
 * The two arms.
 *
 * Everything except VTRACE exposure is the same object, not a copy: the native
 * tools, the agent record, the model record and the budget are shared frozen
 * constants, so an arm-specific value cannot be expressed without editing the
 * preregistration and changing its hash.
 *
 * Neither arm carries a treatment instruction. Telling the VTRACE arm to
 * "always use VTRACE first" would measure a mandate rather than the product,
 * and M169 already established that mandatory invocation is not licensed; the
 * intended production integration is a tool the agent may call, so that is what
 * is exposed.
 */
export function armDefinition(arm: M214Arm): ArmDefinition {
  if (arm === "baseline") {
    return {
      arm,
      label: "Arm A — BASELINE",
      nativeTools: M214_NATIVE_TOOLS,
      mcpServers: [],
      treatmentToolCatalog: [],
      modelVisibleToolNames: M214_NATIVE_TOOLS,
      treatmentInstruction: null,
      forbiddenWorkspaceEntries: [".vtrace", ".vexp"],
      forbiddenEnvironmentPrefixes: ["VTRACE_", "VEXP_"],
      treatmentStatePaths: [],
    };
  }
  return {
    arm,
    label: "Arm B — BASELINE + VTRACE",
    nativeTools: M214_NATIVE_TOOLS,
    mcpServers: ["vtrace"],
    treatmentToolCatalog: M214_VTRACE_TREATMENT_CATALOG,
    modelVisibleToolNames: [
      ...M214_NATIVE_TOOLS,
      ...M214_VTRACE_TREATMENT_CATALOG.map((toolId) => mcpToolName("vtrace", toolId)),
    ],
    treatmentInstruction: null,
    forbiddenWorkspaceEntries: [".vexp"],
    forbiddenEnvironmentPrefixes: ["VEXP_"],
    treatmentStatePaths: [".vtrace"],
  };
}

// ── Randomisation (§26) ─────────────────────────────────────────────

/** The two orders of two arms. Baseline is never systematically first. */
export const M214_ARM_ORDERS: readonly (readonly M214Arm[])[] = Object.freeze([
  Object.freeze<M214Arm[]>(["baseline", "vtrace"]),
  Object.freeze<M214Arm[]>(["vtrace", "baseline"]),
]);

function seededRank(seed: string, instanceId: string): string {
  return createHash("sha256").update(`${seed} ${instanceId}`).digest("hex");
}

/**
 * Assign each task one of the two orders, balanced by construction.
 *
 * Instances are ranked by a seeded digest — arbitrary with respect to
 * repository, difficulty and every historical outcome — and the rank's parity
 * picks the order. With 100 tasks that is exactly 50/50, so provider drift,
 * machine load and cache effects cannot align with the arm under test.
 */
export function assignArmOrders(
  instanceIds: readonly string[],
  seed: string = M214_RANDOMIZATION_SEED,
): ReadonlyMap<string, readonly M214Arm[]> {
  const ranked = [...instanceIds].sort((left, right) => {
    const a = seededRank(seed, left);
    const b = seededRank(seed, right);
    return a < b ? -1 : a > b ? 1 : left < right ? -1 : 1;
  });
  const assignment = new Map<string, readonly M214Arm[]>();
  ranked.forEach((instanceId, rank) => {
    assignment.set(instanceId, M214_ARM_ORDERS[rank % M214_ARM_ORDERS.length]!);
  });
  return assignment;
}

// ── Budgets (§15, §35) ──────────────────────────────────────────────

/**
 * ONE budget object, shared by both arms.
 *
 * The turn cap and the vendor's published $3 cost limit were verified against
 * the vendor's own README before adoption. The per-run cap is raised to $3.50
 * for the same reason M213 raised it: the most expensive arm ever recorded on
 * this model cost $3.0384, and a $3.00 ceiling would have truncated a real run
 * — a truncation that would land on whichever arm happens to be more expensive
 * and would look like a difference in capability.
 */
export const M214_BUDGET = Object.freeze({
  maxTurns: 250,
  perRunCostCapUsd: 3.5,
  wallClockTimeoutSecondsPerRun: 3_600,
  toolCallTimeoutSeconds: 600,
  repositoryCommandTimeoutSeconds: 600,
  maxOutputTokensPerTurn: "provider default; not exposed by the Claude Code CLI",
  totalIntendedRuns: 200,
  totalSpendCapUsd: 700,
  totalSpendCapRationale:
    "200 runs at the $3.50 per-run ceiling. At the untreated historical mean of $0.6604 the "
    + "projection is $132.08 and at the untreated p90 of $1.2392 it is $247.84; the cap is an "
    + "infrastructure guard, not an expectation.",
  projectedTotalUsdAtUntreatedMean: 132.08,
  projectedTotalUsdAtUntreatedP90: 247.84,
  identicalAcrossArms: true,
  noTreatmentSpecificGrace:
    "There is no per-arm budget field. An arm-specific cap cannot be expressed without editing this "
    + "object, which changes the preregistration hash.",
});

/**
 * What the per-task cost cap actually counts (§35).
 *
 * Frozen now, because "did the treatment cost more?" has a different answer
 * depending on whether indexing time is inside the number, and choosing after
 * seeing results is exactly the tuning this preregistration exists to prevent.
 */
export const M214_COST_SEMANTICS = Object.freeze({
  capAppliesTo: "provider-reported model cost for the agent run, and nothing else",
  setupCounted: false,
  setupRationale:
    "VTRACE index construction happens before the agent starts and consumes no model tokens. "
    + "Charging it to the model budget would let a cheap local computation shrink the turn budget "
    + "of one arm.",
  cachedInputCounted: true,
  cachedInputRationale: "the provider bills it, so the experiment counts it",
  toolCpuCounted: false,
  modelRetryCounted: true,
  modelRetryRationale:
    "a provider-side retry that produced billed tokens is part of what the run cost; a harness-level "
    + "relaunch after an infrastructure failure starts a new run row",
  localComputeReportedSeparately: true,
  localComputeFields: [
    "index build wall-clock seconds",
    "index size on disk",
    "treatment tool latency, summed",
  ],
  mixingProhibited:
    "Model cost and local compute are reported as two numbers and never summed into one "
    + "'cost per task'. Preprocessing cost is not hidden inside model cost in either direction.",
});

// ── Agent and model identity (§12, §13, §34) ────────────────────────

export const M214_AGENT = Object.freeze({
  implementation: "Anthropic Claude Code CLI, headless",
  binary: "/home/calvin/.local/bin/claude",
  version: "2.1.260",
  versionPinNote:
    "The launch harness must assert this exact string before every run and abort the cohort on any "
    + "difference. One agent implementation serves both arms; there is no baseline agent and no "
    + "VTRACE-specialised agent.",
  systemPrompt: "CLI default; no --append-system-prompt and no --system-prompt in either arm",
  userPromptSource: "vexp-swe-bench src/harness/loader.ts buildPrompt, verbatim, identical in both arms",
  userPromptText:
    "You are working on the {repo} repository (Python).\n"
    + "Fix the following issue by making the necessary code changes.\n"
    + "Do NOT write or modify tests — only fix the source code.\n\n"
    + "{problem_statement}",
  userPromptContainsTreatmentInstruction: false,
  treatmentInstructionPolicy:
    "Neither arm receives a treatment-specific instruction. 'Always use VTRACE first' is not the "
    + "intended production integration and would measure a mandate rather than the product.",
  outputFormat: "stream-json --verbose",
  turnLoop: "the Claude Code CLI's own; unchanged and identical across arms",
  terminationLogic: "CLI default termination, bounded by --max-turns and the per-run cost cap",
  errorRetryBehaviour: "CLI default; harness-level retry restricted to the infrastructure categories in M214_EXCLUSIONS",
  editMechanism: "the CLI's own Edit/Write tools, identical in both arms",
  turnAccounting: "the CLI's own turn counter, read from the stream-json transcript",
});

/**
 * The model, and an honest account of how far its availability was established
 * without spending (§13, §34).
 *
 * `claude-opus-4-5-20251101` is the model the vendor's published benchmark used
 * and the model every untreated historical VTRACE baseline arm used, so the
 * frozen cost ceilings are derived from its economics. The agent binary's own
 * model registry still carries a complete, unflagged entry for it — pricing
 * tier, 200k window, provider ids across all five routes — which is stronger
 * evidence than M213 had, and is still not a provider-confirmed response. The
 * launch harness closes the gap at zero marginal cost by reading the
 * provider-returned identity from each run's own init event.
 */
export const M214_MODEL = Object.freeze({
  provider: "Anthropic",
  model: "claude-opus-4-5-20251101",
  alias: "claude-opus-4-5",
  rationale:
    "The model VEXP's published benchmark used ('All agents use Claude Opus 4.5 for a fair, "
    + "apples-to-apples comparison'), which is what keeps the external comparison as close to "
    + "like-for-like as a cross-study comparison can be.",
  temperature: "not exposed by the Claude Code CLI; provider default",
  thinkingBudget: 0,
  effortFlag: "omitted",
  maxOutputTokens: "provider default (registry: 32000 default, 64000 upper)",
  identicalAcrossArms: true,
  availabilityEvidence: "PRESENT_IN_AGENT_MODEL_REGISTRY_NOT_PROVIDER_CONFIRMED",
  availabilityEvidenceDetail:
    "Claude Code 2.1.260's bundled model registry lists id 'claude-opus-4-5' with first_party "
    + "provider id 'claude-opus-4-5-20251101', a 200000-token window, pricing tier_5_25 and no "
    + "deprecation or retirement marker, alongside newer families. No paid call was made to confirm "
    + "the provider still serves it.",
  identityVerification:
    "The launch harness reads the provider-returned model identity from each run's stream-json init "
    + "event and aborts the cohort on any difference from the pin (§34).",
  driftPolicy:
    "If the provider-returned identity changes materially mid-cohort, STOP the cohort. Runs from "
    + "before and after the change are never mixed; the cohort is declared invalid and restarted "
    + "from zero under a new preregistration hash.",
  ifUnavailableAtLaunch:
    "The causal experiment is NOT cancelled. Baseline vs VTRACE remains valid under any single "
    + "model used identically by both arms. What weakens is the EXTERNAL comparison: pinning a "
    + "different model must be recorded as a DIFFERS row in the published-condition matrix, and the "
    + "vendor's 73/100 may then be cited only with the model-identity caveat attached. A newer model "
    + "is never used silently and the result is never described as an exact VEXP replication.",
});

// ── Published-condition audit (§14) ─────────────────────────────────

export type ConditionMatch = "MATCH" | "APPROXIMATE" | "UNKNOWN" | "DIFFERS";

export interface PublishedConditionRow {
  readonly condition: string;
  readonly vexpPublished: string;
  readonly m214: string;
  readonly match: ConditionMatch;
  readonly note: string;
}

/**
 * How close the external comparison actually is.
 *
 * Written before any run, and deliberately unflattering where the honest answer
 * is UNKNOWN. Four rows are unknowable from a published README, which is why
 * §14's phrase is "same-task published-condition external replication" and not
 * "exact VEXP replication" — and why the label cannot be upgraded later without
 * evidence that changes one of these rows.
 */
export const M214_PUBLISHED_CONDITION_MATRIX: readonly PublishedConditionRow[] = Object.freeze([
  {
    condition: "task artifact",
    vexpPublished: "data/swe-bench-100.jsonl at vendor commit 880e486",
    m214: "the identical file, sha256-pinned",
    match: "MATCH",
    note: "byte-for-byte the same artifact; verified by digest, not by re-running the vendor's sampler",
  },
  {
    condition: "model",
    vexpPublished: "Claude Opus 4.5",
    m214: "claude-opus-4-5-20251101",
    match: "MATCH",
    note: "same model family and version; the vendor published no dated identifier, so an exact snapshot match is assumed rather than proven",
  },
  {
    condition: "agent",
    vexpPublished: "Claude Code",
    m214: "Claude Code CLI 2.1.260, headless",
    match: "APPROXIMATE",
    note: "the vendor published no CLI version or date; agent versions differ in tool loop and defaults, and this one postdates their run",
  },
  {
    condition: "turn cap",
    vexpPublished: "250",
    m214: "250",
    match: "MATCH",
    note: "verified in the vendor README's own defaults section",
  },
  {
    condition: "cost cap",
    vexpPublished: "$3/task",
    m214: "$3.50/task",
    match: "DIFFERS",
    note: "raised deliberately: the most expensive historical arm on this model cost $3.0384, so $3.00 truncates real runs. Both M214 arms share the raised cap, so the causal comparison is unaffected; the external comparison inherits a small upward bias in our favour and is reported with that stated",
  },
  {
    condition: "container / evaluator",
    vexpPublished: "not published",
    m214: "swebench==4.1.0 official per-instance evaluation images, one container per run",
    match: "UNKNOWN",
    note: "the vendor's harness reuses one working tree per repository slug across tasks; whether their published run did the same is not stated",
  },
  {
    condition: "network policy",
    vexpPublished: "not published",
    m214: "the container's own posture, identical in both arms",
    match: "UNKNOWN",
    note: "unknowable from published material",
  },
  {
    condition: "native tool catalogue",
    vexpPublished: "not published; the harness ships DEFAULT_ALLOWED_TOOLS",
    m214: "Edit, Write, Bash, Read, Glob, Grep, TodoWrite",
    match: "APPROXIMATE",
    note: "the vendor's shipped default is adopted unchanged, but the published run's actual catalogue is not stated",
  },
  {
    condition: "repetitions per task",
    vexpPublished: "pass@1, repetitions not stated",
    m214: "one run per arm per task",
    match: "UNKNOWN",
    note: "a best-of-n reported as pass@1 would not be comparable; nothing published rules it in or out",
  },
]);

export const M214_EXTERNAL_COMPARISON_LABEL =
  "same-task published-condition external replication" as const;

export const M214_EXTERNAL_COMPARISON_LABEL_REFUSED: readonly string[] = Object.freeze([
  "exact VEXP replication",
  "head-to-head benchmark against VEXP",
  "apples-to-apples comparison with VEXP",
  "we reran VEXP's benchmark",
]);

// ── Run manifest (§25) ──────────────────────────────────────────────

export interface RunManifestRow {
  readonly runId: string;
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly arm: M214Arm;
  readonly pairedTaskId: string;
  readonly armOrderIndex: number;
  readonly armOrder: readonly M214Arm[];
  readonly executionOrder: number;
  readonly seed: string;
  readonly agentVersion: string;
  readonly model: string;
  readonly vtraceCommit: string | null;
  readonly vtraceProductTreeSha: string | null;
  readonly containerImage: string;
  readonly budgetIdentity: string;
  readonly maxTurns: number;
  readonly perRunCostCapUsd: number;
  readonly status: "PLANNED";
}

export interface ManifestInputs {
  readonly population: { readonly instanceIds: readonly string[] };
  readonly rows: readonly { instance_id: string; repo: string; base_commit: string }[];
  readonly agentVersion: string;
  readonly model: string;
  readonly vtraceCommit: string;
  readonly vtraceProductTreeSha: string;
  readonly seed?: string;
}

export function instanceImageKey(instanceId: string): string {
  return `swebench/sweb.eval.x86_64.${instanceId.toLowerCase().replace("__", "_1776_")}:latest`;
}

/**
 * A stable identity for the shared budget, carried on every row.
 *
 * Two rows agreeing on `maxTurns` and `perRunCostCapUsd` would still leave the
 * timeouts unchecked; one digest over the whole frozen object makes any
 * arm-specific budget visible in the manifest itself.
 */
export function budgetIdentity(): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(M214_BUDGET)))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Every intended run, generated before any of them executes.
 *
 * There is no VEXP row. The vendor's published result is not a run, has no
 * container, no budget and no execution order, and giving it a manifest row
 * would be the first step toward its appearing in a paired table.
 */
export function buildRunManifest(input: ManifestInputs): readonly RunManifestRow[] {
  const seed = input.seed ?? M214_RANDOMIZATION_SEED;
  const orders = assignArmOrders(input.population.instanceIds, seed);
  const byId = new Map(input.rows.map((row) => [row.instance_id, row] as const));
  const identity = budgetIdentity();

  const manifest: RunManifestRow[] = [];
  let executionOrder = 0;
  for (const instanceId of input.population.instanceIds) {
    const row = byId.get(instanceId);
    if (row === undefined) throw new Error(`Instance missing from population rows: ${instanceId}`);
    const order = orders.get(instanceId);
    if (order === undefined) throw new Error(`Instance has no arm order: ${instanceId}`);
    order.forEach((arm, armOrderIndex) => {
      manifest.push({
        runId: `${M214_EXPERIMENT_NAME}:${instanceId}:${arm}`,
        instanceId,
        repo: row.repo,
        baseCommit: row.base_commit,
        arm,
        pairedTaskId: instanceId,
        armOrderIndex,
        armOrder: order,
        executionOrder: executionOrder++,
        seed,
        agentVersion: input.agentVersion,
        model: input.model,
        vtraceCommit: arm === "vtrace" ? input.vtraceCommit : null,
        vtraceProductTreeSha: arm === "vtrace" ? input.vtraceProductTreeSha : null,
        containerImage: instanceImageKey(instanceId),
        budgetIdentity: identity,
        maxTurns: M214_BUDGET.maxTurns,
        perRunCostCapUsd: M214_BUDGET.perRunCostCapUsd,
        status: "PLANNED",
      });
    });
  }
  return manifest;
}

// ── Outcome and analysis (§16, §17, §22, §23) ───────────────────────

export const M214_PRIMARY_OUTCOME = Object.freeze({
  measure: "SWE-bench resolved",
  encoding: "binary; 1 = resolved, 0 = unresolved",
  evaluator:
    "the official SWE-bench evaluator (swebench==4.1.0) against the frozen FAIL_TO_PASS and "
    + "PASS_TO_PASS sets",
  refusedSubstitutes: [
    "a patch was produced",
    "tests appeared to pass in the agent's own transcript",
    "the agent declared success",
    "the patch touched a gold file",
    "a locally-run test passed",
  ],
});

export const M214_PRIMARY_ESTIMAND = Object.freeze({
  statement: "ΔVTRACE = outcome(VTRACE) − outcome(BASELINE), on paired tasks",
  design: "paired — every task is run under both arms",
  directionality:
    "two-sided. M183 observed exact resolution parity on 30 paired tasks, so a one-sided favourable "
    + "hypothesis is not supported by anything this programme has measured.",
  comparator: "our own baseline, run in this harness",
  notTheComparator:
    "the vendor's published 73/100. VTRACE − 73 is not a causal quantity: without a matched "
    + "baseline, an absolute pass rate above or below 73 could equally reflect our harness, our "
    + "agent version or our container substrate.",
  baselineIsMandatory: true,
});

export const M214_STATISTICAL_PLAN = Object.freeze({
  design: "paired — both arms on the same 100 tasks",
  binaryMethod: "exact McNemar (binomial) on discordant pairs, with a paired bootstrap CI on the pass-rate difference",
  bootstrapResamples: 10_000,
  bootstrapUnit: "task (both of a task's arms resample together, preserving pairing)",
  intervalLevel: 0.95,
  reportedAlways: [
    "both resolved",
    "VTRACE only",
    "baseline only",
    "neither",
    "baseline pass rate",
    "VTRACE pass rate",
    "absolute paired delta",
    "discordant count difference",
    "exact McNemar p-value",
    "95% paired bootstrap CI on the absolute delta",
  ],
  continuousMethod:
    "paired differences on tokens, cost, turns and tool counts; median AND mean both reported with "
    + "a 95% paired bootstrap CI, because M174 showed a two-run tail can carry 95.7% of a cost "
    + "premium and a mean alone would have hidden it",
  effectSizeDiscipline:
    "p < 0.05 is not the definition of success. Absolute delta, discordant counts and interval width "
    + "are reported first; a +1/100 result and a +10/100 result are described differently even when "
    + "neither is conventionally significant.",
  frozenBeforeOutcomes: true,
  refused: [
    "changing the analysis after seeing outcomes",
    "reporting aggregate percentages without the paired table",
    "choosing the highlighted efficiency metric after seeing which one favours an arm",
    "pooling these results statistically with M183",
    "computing any paired statistic against the vendor's published number",
  ],
});

export const M214_SECONDARY_OUTCOMES = Object.freeze({
  efficiency: [
    "input tokens", "output tokens", "cached tokens", "total model tokens",
    "provider-reported cost", "turns", "wall-clock duration",
  ],
  behaviour: [
    "native search calls (grep/ripgrep)", "glob/find invocations", "file reads",
    "git commands", "test executions", "files inspected", "files edited",
  ],
  timing: [
    "turn of first edit",
    "turn of first read of a file the gold patch touches",
  ],
  timingCaveat:
    "Gold-relative timing is computed after the fact from the frozen dataset. The eventual outcome "
    + "NEVER classifies pre-decision relevance: M185 and M189 both showed that letting it do so "
    + "manufactures an effect. Gold patches, gold file lists and FAIL_TO_PASS never enter any "
    + "agent's context.",
  costSource:
    "provider-reported cost from the run's own telemetry, deduplicated on message.id — M169 found "
    + "the raw row token fields inflated by re-counting streamed messages.",
  identicalInstrumentationAcrossArms: true,
});

export const M214_TREATMENT_USAGE = Object.freeze({
  recorded: [
    "VTRACE exposed",
    "VTRACE invoked at least once",
    "turn of first invocation",
    "number of invocations",
    "which tools were invoked",
    "tokens and characters returned by the treatment",
    "treatment latency, summed",
    "invoked before the first edit",
  ],
  analysisRole: "descriptive and mediator only",
  neverConditionsPrimary: true,
  statement:
    "Uptake is post-treatment behaviour. A run where VTRACE was exposed and never invoked stays in "
    + "the VTRACE arm: non-use is a consequence of the treatment, and dropping those runs would "
    + "convert an intention-to-treat estimate into a self-selected one that can only flatter the "
    + "treatment.",
});

export const M214_ITT_POLICY = Object.freeze({
  primaryAnalysis: "INTENTION_TO_TREAT — every launched valid run is analysed under its assigned arm",
  secondaryAnalysis:
    "TREATMENT_VALID / per-protocol, restricted to runs where the surface came up, the index was "
    + "ready and the tool schema was visible. Reported beside the ITT result, never instead of it.",
  neverExcludedForBehaviour: [
    "the treatment was exposed but never invoked",
    "the treatment's output was poor",
    "the agent ignored the treatment",
  ],
  initialisationFailurePolicy:
    "A VTRACE initialisation failure is NEVER silently converted to a baseline run. If the surface "
    + "did not come up, the run is excluded as TREATMENT_INITIALISATION_FAILURE before the model is "
    + "called and stays visible in the accounting with its arm and repository. A failure discovered "
    + "AFTER the model started is retained under ITT and flagged treatment-invalid.",
});

// ── Exclusions and stopping (§24, §36, §37) ─────────────────────────

export const M214_EXCLUSIONS = Object.freeze({
  legitimate: [
    "CONTAINER_CANNOT_START",
    "SOURCE_REVISION_UNAVAILABLE",
    "BENCHMARK_INSTANCE_MALFORMED",
    "ENVIRONMENT_IRREPRODUCIBLE",
    "TREATMENT_INITIALISATION_FAILURE",
    "AGENT_INFRASTRUCTURE_FAILURE_BEFORE_TREATMENT_EXPOSURE",
    "MODEL_SERVICE_FAILURE",
    "MODEL_IDENTITY_DRIFT",
    "PATCH_EXTRACTION_FAILURE",
    "EVALUATOR_INFRA_FAILURE",
    "TELEMETRY_CORRUPT",
    "TREATMENT_CONTAMINATION",
    "ARM_CONFIGURATION_WRONG",
  ],
  neverExclusions: [
    "the agent failed the task",
    "the agent never used VTRACE",
    "the agent made a bad patch",
    "the agent ran out of turns",
    "the agent hit the cost cap",
    "a test failed",
    "the model produced no patch",
    "the run was expensive",
    "the task is hard",
    "the task is a known VTRACE loss",
    "the run is inconvenient",
  ],
  exclusionsRemainVisible: true,
  frozenBeforeAnyPaidRun: true,
  statement:
    "An exclusion category not on this list cannot be created after outcomes exist. Every excluded "
    + "run keeps its arm, repository and category in the corpus accounting, so a drift toward "
    + "excluding one arm would be readable rather than hidden.",
  pairingRule:
    "An exclusion removes one RUN, not the task. A task with one valid arm contributes to neither "
    + "the paired table nor either pass rate, and is reported as an incomplete pair with its reason.",
  retryPolicy: Object.freeze({
    rerunnable: [
      "MODEL_SERVICE_FAILURE", "CONTAINER_CANNOT_START", "EVALUATOR_INFRA_FAILURE", "TELEMETRY_CORRUPT",
    ],
    notRerunnable: [
      "a bad patch", "turn exhaustion", "hitting the cost cap", "agent timeout",
      "the evaluator judging the task unresolved", "the agent choosing not to test",
      "the agent choosing not to invoke VTRACE",
    ],
    maxAttemptsPerRun: 2,
    bothAttemptsRemainInLedger: true,
  }),
});

export const M214_STOPPING_RULE = Object.freeze({
  design: "FIXED_N",
  tasks: 100,
  arms: 2,
  intendedRuns: 200,
  statement:
    "All 100 tasks × 2 arms = 200 outcome-bearing runs. The cohort is complete when every planned "
    + "run has reached a terminal state. There is no interim analysis, no adaptive continuation and "
    + "no early stop.",
  refusedInputs: [
    "VTRACE looks neutral",
    "VTRACE is winning",
    "VTRACE is losing",
    "token savings look obvious",
    "an early p-value crossed a threshold",
    "the discordant table looks favourable",
    "the absolute pass rate already exceeds 73",
  ],
  onlyLegitimateEarlyTermination:
    "The cohort may be ABANDONED — not analysed — if a defect invalidating comparability is found. "
    + "Abandonment discards the cohort and restarts from zero under a new preregistration hash; "
    + "favourable partial results are never retained.",
  budgetInterlock:
    "The $700 total cap is an infrastructure guard, not a stopping rule. If it binds, the cohort is "
    + "incomplete and is reported as incomplete.",
});

export const M214_NO_TUNING_POLICY = Object.freeze({
  frozenAtFirstPaidRun: [
    "VTRACE product commit and src tree", "agent version", "model", "prompts",
    "tool catalogues", "budgets", "task set", "randomisation", "harness", "evaluator",
    "warm/cold policy", "patch-capture policy", "stopping rule", "analysis plan",
    "external reference",
  ],
  onCriticalDefect: "STOP, declare the cohort invalid, fix, restart from zero",
  refused: "patching halfway through and retaining earlier outcomes",
  productChangesDuringPreregistration: 0,
  productChangeStatement:
    "M214 makes no src/ change. The treatment is frozen at the tree M213 measured. If the harness "
    + "exposes a genuine treatment-breaking product bug, it is REPORTED; it is not silently repaired "
    + "while the preregistration continues, because a repaired treatment is a different treatment "
    + "and needs a new frozen identity.",
});

// ── Reporting discipline (§18–§20, §41) ─────────────────────────────

export const M214_CAUSAL_WORDING = Object.freeze({
  ifBetter:
    "VTRACE improved resolution relative to its matched baseline by Δ on this frozen population.",
  ifEqual:
    "No resolution benefit was observed relative to the matched baseline.",
  ifWorse:
    "VTRACE reduced resolution relative to the matched baseline under these conditions.",
  softeningProhibited:
    "An unfavourable result is stated in the same voice as a favourable one. A null result is "
    + "stated as a null result, with its interval, and is not reworded into a directional claim the "
    + "interval does not support.",
  frozenBeforeOutcomes: true,
});

/**
 * The interpretations, frozen before any outcome exists (§41).
 *
 * Success is a valid experiment, not a VTRACE win. Two of these six are results
 * the programme would rather not have, and they are written out in full so that
 * meeting one is a reportable finding rather than an occasion for a new frame.
 */
export const M214_OUTCOME_INTERPRETATIONS: readonly {
  readonly outcome: string;
  readonly means: string;
}[] = Object.freeze([
  {
    outcome: "VTRACE improves resolution (CI excludes 0, positive)",
    means: "the treatment causally helped this agent on this population; the size of the help is the interval, not the point estimate",
  },
  {
    outcome: "resolution unchanged, tokens or cost reduced",
    means: "no capability effect, a measurable efficiency effect; a legitimate and reportable product claim that is NOT a resolution claim",
  },
  {
    outcome: "resolution unchanged, cost unchanged",
    means: "the treatment did not change what this agent does on this population; consistent with M173, M183 and M185",
  },
  {
    outcome: "VTRACE reduces resolution",
    means: "the treatment causally hurt; reported plainly, with the per-task losses examined and not explained away as variance without evidence",
  },
  {
    outcome: "absolute pass rate exceeds the published 73 but the causal delta is zero",
    means: "our harness, agent or substrate is stronger than the vendor's published cohort; it says nothing about VTRACE, and must not be reported as a VTRACE result",
  },
  {
    outcome: "causal delta is positive but absolute pass rate is below the published 73",
    means: "VTRACE helped our agent, and our agent or substrate is weaker than the vendor's published cohort; both are true and neither cancels the other",
  },
]);

export const M214_REPORTING_DISCIPLINE = Object.freeze({
  successCriterion: "a valid experiment completed",
  refusedSuccessCriterion: "VTRACE wins",
  separateTablesRequired:
    "Baseline and VTRACE appear in the paired causal table. The vendor's published result appears "
    + "only in a separate external-reference table. They are never rows of one table.",
  interpretations: M214_OUTCOME_INTERPRETATIONS,
});

// ── Historical comparison policy ────────────────────────────────────

export const M214_HISTORICAL_POLICY = Object.freeze({
  comparableHistory: [
    {
      source: "M183",
      result:
        "30 paired tasks, 60 runs; baseline 19/30, VTRACE 19/30; both 17, VTRACE-only 2, "
        + "baseline-only 2, neither 9; McNemar p = 1.0",
      label: "historical/non-identical",
    },
  ],
  poolingProhibited: true,
  statement:
    "Historical results may be cited beside the new experiment and must be labelled "
    + "historical/non-identical. They are never pooled statistically with it.",
});

// ── Canonical serialisation and hashing (§43, §44) ──────────────────

/**
 * M214's hash is DOMAIN-SEPARATED from M213's.
 *
 * The prefix is what makes "do not reuse M213's hash" a structural guarantee
 * rather than a promise: even a hypothetical M214 document identical to M213's
 * hashes differently, so the two experiments can never be confused by digest,
 * and a launch harness that verifies the wrong one fails closed.
 *
 * `generatedAt` is excluded deliberately. A hash that moved every time the
 * generator ran would flag an unchanged design as mutated, and a guard that
 * cries wolf on a no-op is a guard people learn to override. Every field that
 * carries an experimental commitment stays inside the digest.
 */
export const M214_HASH_DOMAIN = `${M214_EXPERIMENT_NAME}\n` as const;

export const M214_HASH_RULE: string =
  `sha256 over "${M214_EXPERIMENT_NAME}\\n" followed by the canonical (recursively key-sorted) JSON `
  + "of every field except preregistrationHash, preregistrationHashRule and generatedAt";

export function m214PreregistrationHash(document: Record<string, unknown>): string {
  const {
    preregistrationHash: _ignored,
    preregistrationHashRule: _rule,
    generatedAt: _generatedAt,
    ...rest
  } = document;
  return createHash("sha256")
    .update(M214_HASH_DOMAIN)
    .update(JSON.stringify(canonicalize(rest)))
    .digest("hex");
}

export function m214ManifestHash(rows: readonly RunManifestRow[]): string {
  return createHash("sha256")
    .update(M214_HASH_DOMAIN)
    .update(JSON.stringify(canonicalize(rows)))
    .digest("hex");
}

export { canonicalize };

// ── Substrate (§27–§29, §32) ────────────────────────────────────────

export const M214_SUBSTRATE = Object.freeze({
  inheritedFrom: "M192 / M193",
  harness: "swebench==4.1.0 official per-instance evaluation images",
  perInstanceContainers: true,
  freshCheckoutPerRun: true,
  authoritativeCheckout: "SINGLE_BIND_MOUNTED_TREE",
  patchCaptureMechanism:
    "m193c_patch_snapshot: `git diff --no-renames HEAD` for tracked bytes plus a `git ls-files "
    + "--others --exclude-standard` untracked lane, both restricted by a pathspec derived from the "
    + "untracked paths present before the agent started. Non-mutating: it never stages and never "
    + "resets.",
  patchCaptureIsTreatmentAgnostic: true,
  patchCaptureNamesNoVendorDirectory: true,
  vendorHarnessNotAdopted:
    "vexp-swe-bench keeps ONE working tree per repository slug under .bench-repos and reuses it "
    + "across every task of that repository; its capturePatch hardcodes `:(exclude).vexp` and does "
    + "not exclude `.vtrace`; its resetRepo runs `git clean -fdx -e .vexp`. All three are removed "
    + "structurally rather than patched.",
  indexWarmthRegime: "COLD_UNIFORM",
  indexWarmthRationale:
    "Every run gets a fresh container and checkout, so no treatment state survives into the next "
    + "task. Cold and warm regimes are not mixed: this cohort is cold throughout and is reported as "
    + "cold. Index build time and size are measured and reported separately from model cost, so "
    + "preprocessing is neither hidden nor charged to the agent's turn budget.",
  indexingIsObservational:
    "Treatment initialisation may create untracked metadata; it may not mutate tracked source. The "
    + "tracked-source digest is taken before and after initialisation for every run, and a "
    + "difference fails the launch gate rather than being tolerated.",
  baselineReceivesNoTreatmentState:
    "The baseline arm's workspace is never indexed and never carries .vtrace, VTRACE environment "
    + "variables, a daemon socket, or any VTRACE-generated file.",
});

// ── Launch gates (§46) ──────────────────────────────────────────────

export type GateStatus = "PASS" | "FAIL" | "BLOCKED" | "DEFERRED_TO_LAUNCH";

/**
 * Which question a gate answers.
 *
 * M213's gate table conflated two kinds of condition and paid for it: some
 * gates ask "is the design frozen and correct?", which a preregistration can
 * answer, and others ask "was this run configured correctly?", which nothing
 * can answer before runs exist. Marking every unanswerable one BLOCKED makes a
 * table where the blocked cells look like defects rather than like the
 * scheduling fact they are.
 *
 * PREREGISTRATION gates must all PASS now. RUNTIME gates are asserted per run
 * by the launch executor, and each names the guard that will assert it — so
 * "deferred" is a commitment with an address, not a gap. INFRASTRUCTURE gates
 * ask whether the thing that would do the asserting exists at all; separating
 * them is what lets an honest NOT_READY say which kind of unready it is.
 */
export type GateClass = "PREREGISTRATION" | "RUNTIME" | "INFRASTRUCTURE";

export interface LaunchGate {
  readonly id: string;
  readonly requirement: string;
  readonly gateClass: GateClass;
  readonly status: GateStatus;
  readonly evidence: string;
}

export interface GateInputs {
  readonly preregistrationCommitted: boolean;
  readonly preregistrationHashRecorded: boolean;
  readonly m213Immutable: boolean;
  readonly externalTaskArtifactVerified: boolean;
  readonly taskIdsFrozen: boolean;
  readonly manifestRowCount: number;
  readonly baselineTreatmentFree: boolean;
  readonly vtraceExecutable: boolean;
  readonly vtraceIdentityFrozen: boolean;
  readonly agentIdentityFrozen: boolean;
  readonly modelIdentityFrozen: boolean;
  readonly nativeToolsIdentical: boolean;
  readonly budgetsIdentical: boolean;
  readonly sourceStateEquivalence: GateStatus;
  readonly indexingObservational: GateStatus;
  readonly treatmentStateExcludedFromPatch: GateStatus;
  readonly resetWarmPolicySymmetric: GateStatus;
  readonly executionOrderFrozen: boolean;
  readonly evaluatorValidated: boolean;
  readonly pairedAnalysisFrozen: boolean;
  readonly efficiencyAnalysisFrozen: boolean;
  readonly invalidRunRulesFrozen: boolean;
  readonly stoppingRuleFrozen: boolean;
  readonly externalReferenceFrozen: boolean;
  readonly externalReferenceCannotEnterCausalAnalysis: boolean;
  readonly falsificationSuitePasses: boolean;
  readonly noOutcomeBearingRunHasOccurred: boolean;
  readonly liveModelSpendIsZero: boolean;
  /** G29–G31: additions M214's own audit forced. */
  readonly scopedTypecheckClean: boolean;
  readonly modelAvailabilityEvidence: GateStatus;
  readonly treatmentLifecycleOrderVerified: GateStatus;
  /** G32: whether an executor exists that can run the frozen manifest at all. */
  readonly launchExecutorExists: boolean;
  /** The guard the launch executor will call for each RUNTIME gate. */
  readonly runtimeGuards: Readonly<Record<string, string>>;
}

/**
 * G1–G28 are the prompt's gates verbatim. G29–G31 are additions M214's own work
 * forced, and each is a real condition that G1–G28 does not cover: a scoped
 * typecheck that actually sees this milestone's test files, the honest state of
 * model availability, and the ORDERING that makes patch-capture neutrality hold
 * — which was M213's unclosed G21 residual and is the one thing a correct
 * pathspec alone cannot guarantee.
 */
export function evaluateLaunchGates(input: GateInputs): readonly LaunchGate[] {
  const gate = (id: string, requirement: string, ok: boolean, evidence: string): LaunchGate => ({
    id, requirement, gateClass: "PREREGISTRATION", status: ok ? "PASS" : "FAIL", evidence,
  });
  const tri = (id: string, requirement: string, status: GateStatus, evidence: string): LaunchGate => ({
    id, requirement, gateClass: "PREREGISTRATION", status, evidence,
  });
  const infra = (id: string, requirement: string, ok: boolean, evidence: string): LaunchGate => ({
    id, requirement, gateClass: "INFRASTRUCTURE", status: ok ? "PASS" : "FAIL", evidence,
  });
  // A RUNTIME gate takes its status from the caller: DEFERRED_TO_LAUNCH while
  // no run exists, and PASS or FAIL once the launch executor has asserted it.
  // Hardcoding the deferral would make `launchAuthorized` unreachable forever,
  // which is a gate table that can never approve anything.
  const runtime = (
    id: string, requirement: string, status: GateStatus, guardKey: string, evidence: string,
  ): LaunchGate => ({
    id,
    requirement,
    gateClass: "RUNTIME",
    status,
    evidence: `${evidence}; asserted per run by ${input.runtimeGuards[guardKey] ?? "an unnamed guard"}`,
  });
  return Object.freeze([
    gate("G1", "M214 preregistration committed", input.preregistrationCommitted,
      "stage5_m214_preregistration.json generated from the committed authority module"),
    gate("G2", "M214 preregistration hash recorded", input.preregistrationHashRecorded,
      "domain-separated sha256 over the canonical document, recomputed from the written file"),
    gate("G3", "M213 remains immutable", input.m213Immutable,
      "M213's committed preregistration rehashes to its recorded digest under M213's own rule"),
    gate("G4", "exact VEXP 100-task artifact verified", input.externalTaskArtifactVerified,
      "sha256 of the vendor's own committed jsonl, plus their published distribution table"),
    gate("G5", "100 task ids frozen", input.taskIdsFrozen,
      "the instance ids are committed in the preregistration before any run"),
    gate("G6", "200-run manifest frozen", input.manifestRowCount === 200,
      `${input.manifestRowCount} planned rows generated before any execution, hashed`),
    gate("G7", "baseline is treatment-free", input.baselineTreatmentFree,
      "F3 control: no VTRACE server, tool, env var, workspace entry or generated file"),
    gate("G8", "VTRACE treatment executable", input.vtraceExecutable,
      "M213's per-repository index + tools/list + deterministic query dry run, 12/12 repositories"),
    gate("G9", "VTRACE identity frozen", input.vtraceIdentityFrozen,
      "commit SHA and src tree SHA both recorded; the tree is unchanged since M213 measured it"),
    gate("G10", "agent identity frozen", input.agentIdentityFrozen,
      "one frozen agent record shared by both arm definitions"),
    gate("G11", "model identity frozen", input.modelIdentityFrozen,
      "one frozen model record shared by both arm definitions"),
    gate("G12", "native tools identical across arms", input.nativeToolsIdentical,
      "F7 control over the arm definitions"),
    gate("G13", "budgets identical across arms", input.budgetsIdentical,
      "F6 control plus one budget-identity digest carried on every manifest row"),
    runtime("G14", "source states equivalent before each arm starts",
      input.sourceStateEquivalence, "sourceStateEquivalence",
      "the guard exists and its mechanism is measured (indexing is observational on tracked "
      + "source across 12 repositories); per-run equality can only be asserted when runs exist"),
    tri("G15", "indexing is observational on tracked source", input.indexingObservational,
      "F5 control: tracked-source digest measured before and after treatment initialisation"),
    tri("G16", ".vtrace excluded from patch capture", input.treatmentStateExcludedFromPatch,
      "F4 control, reproduced against a real index: the old capture leaks, the new one is empty"),
    tri("G17", "metadata reset / warm policy symmetric and verified", input.resetWarmPolicySymmetric,
      "F19 and F20 controls over the frozen COLD_UNIFORM policy"),
    gate("G18", "execution-order randomisation frozen", input.executionOrderFrozen,
      "seeded 50/50 arm-order assignment, seed committed, orders in the manifest"),
    gate("G19", "evaluator validated", input.evaluatorValidated,
      "swebench==4.1.0 official evaluator, the harness M192 established and M213 re-verified"),
    gate("G20", "primary paired analysis frozen", input.pairedAnalysisFrozen, "M214_STATISTICAL_PLAN"),
    gate("G21", "efficiency analysis frozen", input.efficiencyAnalysisFrozen, "M214_SECONDARY_OUTCOMES"),
    gate("G22", "invalid-run rules frozen", input.invalidRunRulesFrozen, "M214_EXCLUSIONS"),
    gate("G23", "fixed-N stopping frozen", input.stoppingRuleFrozen, "M214_STOPPING_RULE"),
    gate("G24", "external VEXP reference frozen", input.externalReferenceFrozen,
      "published figures, sources, retrieval date and source digest committed before any run"),
    gate("G25", "external reference cannot enter causal analysis",
      input.externalReferenceCannotEnterCausalAnalysis,
      "F16 and F17 controls: the paired-statistics entry point rejects a non-arm operand"),
    gate("G26", "M214 falsification suite passes", input.falsificationSuitePasses, "F0–F24"),
    gate("G27", "no frozen-population outcome-bearing agent run has occurred",
      input.noOutcomeBearingRunHasOccurred, "M214 spend accounting"),
    gate("G28", "live model spend is $0 during preregistration", input.liveModelSpendIsZero,
      "no model was called by any M214 script"),
    gate("G29", "M214-owned harness and tests are typechecked", input.scopedTypecheckClean,
      "tsconfig.m214.json includes this milestone's test files, which the repo-wide benchmark "
      + "config excludes"),
    tri("G30", "model availability established", input.modelAvailabilityEvidence,
      "the agent binary's own model registry carries a complete unflagged entry; a "
      + "provider-confirmed response would require a paid call"),
    tri("G31", "treatment lifecycle ordering executed and verified",
      input.treatmentLifecycleOrderVerified,
      "the pre-agent untracked snapshot is taken AFTER treatment initialisation — executed on real "
      + "repositories by the patch-capture probe and audited from the resulting trace, which is "
      + "what makes G16 hold"),
    infra("G32", "a launch executor exists that can run the frozen manifest",
      input.launchExecutorExists,
      "the component that would create the containers, run the lifecycle per run and bind this "
      + "preregistration's hash before the first paid call; M213 listed building it as the "
      + "outstanding infrastructure work and M214 is not scoped to build it"),
  ]);
}

export function launchAuthorized(gates: readonly LaunchGate[]): boolean {
  return gates.every((entry) => entry.status === "PASS");
}

/**
 * Whether the DESIGN is finished, separately from whether it can be executed.
 *
 * Reported alongside `launchAuthorized` so an honest NOT_READY says which of
 * the two it is: a preregistration with a hole in it, or a finished
 * preregistration waiting on infrastructure.
 */
export function preregistrationComplete(gates: readonly LaunchGate[]): boolean {
  return gates
    .filter((entry) => entry.gateClass === "PREREGISTRATION")
    .every((entry) => entry.status === "PASS");
}

/** RUNTIME gates the launch executor must assert before the first paid call. */
export function deferredRuntimeGates(gates: readonly LaunchGate[]): readonly LaunchGate[] {
  return gates.filter((entry) => entry.gateClass === "RUNTIME");
}
