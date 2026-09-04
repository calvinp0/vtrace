/**
 * M213 — the preregistration authority for `VTRACE_VEXP_CAUSAL_100`.
 *
 * ONE authority, two renderings. The machine-readable preregistration, the
 * human-readable report and the run manifest are all generated from this
 * module, so the specification cannot silently fork into two documents that
 * disagree (§37).
 *
 * This module is PURE: it reads the frozen task population off disk and
 * otherwise computes. It contains no product behaviour, is never imported by
 * `src/`, spawns nothing, and calls no model.
 *
 * The experiment it freezes is causal, not architectural:
 *
 *     Under identical agent, model, repository, native tools, budget and
 *     evaluator, what changes because VTRACE or VEXP is present?
 *
 * Nothing here authorises spending. A frozen design is a precondition for a
 * paid run, not permission to start one.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ── Identity ────────────────────────────────────────────────────────

export const M213_EXPERIMENT_NAME = "VTRACE_VEXP_CAUSAL_100" as const;
export const M213_PREREGISTRATION_SCHEMA = "stage5.m213.preregistration.v1" as const;
export const M213_MANIFEST_SCHEMA = "stage5.m213.run-manifest.v1" as const;

/**
 * The randomisation seed, fixed and committed before any paid run (§16).
 *
 * A string rather than an integer so it is legible in the artifact and cannot
 * be confused with an index, a count or a version.
 */
export const M213_RANDOMIZATION_SEED = "M213-VTRACE-VEXP-CAUSAL-100-v1" as const;

// ── Task population (§5) ────────────────────────────────────────────

/**
 * VEXP's own committed 100-task subset, at the initial-release commit of their
 * public benchmark repository. This is the EXACT published population, taken as
 * an artifact rather than reconstructed — which is strictly stronger than
 * re-deriving it, and is why §5 Option 1 applies.
 */
export const M213_TASK_POPULATION_PATH =
  "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";

export const M213_TASK_POPULATION_SHA256 =
  "7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d" as const;

export const M213_TASK_POPULATION_PROVENANCE = Object.freeze({
  source: "https://github.com/Vexp-ai/vexp-swe-bench",
  file: "data/swe-bench-100.jsonl",
  vendorCommit: "880e486",
  vendorCommitSubject: "Initial release: vexp-swe-bench benchmark harness",
  checkoutHead: "d658e3457b82b5cb041f586093cc5002008a8cea",
  fileCleanInVendorCheckout: true,
  parentDataset: "princeton-nlp/SWE-bench_Verified (500 instances)",
});

export interface FrozenTaskPopulation {
  readonly path: string;
  readonly sha256: string;
  readonly instanceIds: readonly string[];
  readonly repositories: readonly string[];
  readonly countsByRepository: Readonly<Record<string, number>>;
  readonly complexityByInstance: Readonly<Record<string, number>>;
  readonly complexityCeiling: number;
  readonly complexityMedian: number;
}

/**
 * VEXP's own complexity proxy, reimplemented from their published
 * `scripts/select-subset.py`, so the population's documented properties can be
 * checked against the artifact rather than taken on trust.
 */
export function vexpComplexityScore(row: {
  FAIL_TO_PASS?: unknown;
  patch?: string;
}): number {
  let failToPass: unknown[] = [];
  const raw = row.FAIL_TO_PASS;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) failToPass = parsed;
    } catch { failToPass = []; }
  } else if (Array.isArray(raw)) {
    failToPass = raw;
  }
  const patchLines = (row.patch ?? "")
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .length;
  return failToPass.length * 10 + patchLines;
}

export function loadFrozenTaskPopulation(
  populationPath: string = M213_TASK_POPULATION_PATH,
): FrozenTaskPopulation {
  const bytes = readFileSync(populationPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const rows = bytes.toString("utf8").trim().split("\n").map((line) =>
    JSON.parse(line) as { instance_id: string; repo: string; FAIL_TO_PASS?: unknown; patch?: string });

  const instanceIds = rows.map((row) => row.instance_id).sort();
  const countsByRepository: Record<string, number> = {};
  const complexityByInstance: Record<string, number> = {};
  for (const row of rows) {
    countsByRepository[row.repo] = (countsByRepository[row.repo] ?? 0) + 1;
    complexityByInstance[row.instance_id] = vexpComplexityScore(row);
  }
  const complexities = Object.values(complexityByInstance).sort((a, b) => a - b);
  const middle = complexities.length >> 1;
  const complexityMedian = complexities.length % 2 === 1
    ? complexities[middle]!
    : (complexities[middle - 1]! + complexities[middle]!) / 2;

  return {
    path: populationPath,
    sha256,
    instanceIds,
    repositories: Object.keys(countsByRepository).sort(),
    countsByRepository,
    complexityByInstance,
    complexityCeiling: complexities[complexities.length - 1] ?? 0,
    complexityMedian,
  };
}

/**
 * VEXP's published claims about their own subset, checked against the bytes.
 *
 * Recorded because a population inherited from a competitor is only usable if
 * its documented properties survive contact with the artifact — and because one
 * of these checks does NOT pass, which is itself preregistration-relevant.
 */
export interface PopulationVerification {
  readonly instanceCount: number;
  readonly instanceCountIs100: boolean;
  readonly repositoryCount: number;
  readonly allTwelveRepositoriesPresent: boolean;
  readonly distributionMatchesPublishedTable: boolean;
  readonly publishedTable: Readonly<Record<string, number>>;
  readonly complexityCeilingRespected: boolean;
  readonly complexityMedianMatchesPublished: boolean;
  readonly sha256Matches: boolean;
  readonly verified: boolean;
}

/** The repository table published in `docs/TASK_SELECTION.md`. */
export const VEXP_PUBLISHED_DISTRIBUTION: Readonly<Record<string, number>> = Object.freeze({
  "django/django": 44,
  "sympy/sympy": 17,
  "sphinx-doc/sphinx": 7,
  "matplotlib/matplotlib": 7,
  "scikit-learn/scikit-learn": 2,
  "astropy/astropy": 5,
  "pydata/xarray": 6,
  "pytest-dev/pytest": 4,
  "pylint-dev/pylint": 2,
  "psf/requests": 4,
  "mwaskom/seaborn": 1,
  "pallets/flask": 1,
});

export function verifyPopulation(population: FrozenTaskPopulation): PopulationVerification {
  const distributionMatches = Object.keys(VEXP_PUBLISHED_DISTRIBUTION).every((repo) =>
    population.countsByRepository[repo] === VEXP_PUBLISHED_DISTRIBUTION[repo])
    && Object.keys(population.countsByRepository).length
      === Object.keys(VEXP_PUBLISHED_DISTRIBUTION).length;

  const checks = {
    instanceCount: population.instanceIds.length,
    instanceCountIs100: population.instanceIds.length === 100,
    repositoryCount: population.repositories.length,
    allTwelveRepositoriesPresent: population.repositories.length === 12,
    distributionMatchesPublishedTable: distributionMatches,
    publishedTable: VEXP_PUBLISHED_DISTRIBUTION,
    complexityCeilingRespected: population.complexityCeiling <= 250,
    complexityMedianMatchesPublished: population.complexityMedian === 22,
    sha256Matches: population.sha256 === M213_TASK_POPULATION_SHA256,
  };
  return {
    ...checks,
    verified: checks.instanceCountIs100
      && checks.allTwelveRepositoriesPresent
      && checks.distributionMatchesPublishedTable
      && checks.complexityCeilingRespected
      && checks.complexityMedianMatchesPublished
      && checks.sha256Matches,
  };
}

// ── Arms (§3, §12) ──────────────────────────────────────────────────

export type M213Arm = "baseline" | "vtrace" | "vexp";

export const M213_ARMS: readonly M213Arm[] = Object.freeze(["baseline", "vtrace", "vexp"]);

/**
 * The MODEL-VISIBLE catalogue each arm receives.
 *
 * Both treatment catalogues are the PRODUCT DEFAULT of their own tool, read
 * mechanically, not a hand-picked parity set. They are deliberately unequal in
 * size — VTRACE lists fourteen, VEXP three — because the causal question is
 * what each product actually gives an agent, and normalising them would be a
 * VTRACE-authored competitor proxy of exactly the kind M212 invalidated.
 */
export const VTRACE_DEFAULT_TOOL_CATALOG: readonly string[] = Object.freeze([
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

export const VEXP_DEFAULT_TOOL_CATALOG_3_1_1: readonly string[] = Object.freeze([
  "run_pipeline",
  "get_skeleton",
  "verify_done",
]);

export const VEXP_DEFAULT_TOOL_CATALOG_2_0_24: readonly string[] = Object.freeze([
  "run_pipeline",
  "get_skeleton",
  "index_status",
  "expand_vexp_ref",
]);

/**
 * The ordinary coding tools, identical in all three arms (§11).
 *
 * vexp-swe-bench's `DEFAULT_ALLOWED_TOOLS`, unchanged. M168-E measured that
 * denying `Grep`/`Glob` is itself a treatment that lost two tasks and won none,
 * so no arm is narrowed: the question is whether the treatment helps a
 * competent native-search agent, not whether it can replace grep.
 */
export const M213_NATIVE_TOOLS: readonly string[] = Object.freeze([
  "Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite",
]);

export interface ArmDefinition {
  readonly arm: M213Arm;
  readonly label: string;
  readonly nativeTools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly treatmentToolCatalog: readonly string[];
  readonly modelVisibleToolNames: readonly string[];
  readonly treatmentInstruction: string | null;
  readonly forbiddenArtifacts: readonly string[];
}

/** Claude Code namespaces MCP tools as `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, toolId: string): string {
  return `mcp__${server}__${toolId}`;
}

export function armDefinition(arm: M213Arm): ArmDefinition {
  if (arm === "baseline") {
    return {
      arm,
      label: "Arm A — BASELINE",
      nativeTools: M213_NATIVE_TOOLS,
      mcpServers: [],
      treatmentToolCatalog: [],
      modelVisibleToolNames: M213_NATIVE_TOOLS,
      treatmentInstruction: null,
      forbiddenArtifacts: [".vtrace", ".vexp", "VTRACE_*", "VEXP_*", "vtrace daemon socket"],
    };
  }
  if (arm === "vtrace") {
    return {
      arm,
      label: "Arm B — VTRACE",
      nativeTools: M213_NATIVE_TOOLS,
      mcpServers: ["vtrace"],
      treatmentToolCatalog: VTRACE_DEFAULT_TOOL_CATALOG,
      modelVisibleToolNames: [
        ...M213_NATIVE_TOOLS,
        ...VTRACE_DEFAULT_TOOL_CATALOG.map((toolId) => mcpToolName("vtrace", toolId)),
      ],
      treatmentInstruction: null,
      forbiddenArtifacts: [".vexp", "VEXP_*", "vexp daemon socket"],
    };
  }
  return {
    arm,
    label: "Arm C — VEXP",
    nativeTools: M213_NATIVE_TOOLS,
    mcpServers: ["vexp"],
    treatmentToolCatalog: VEXP_DEFAULT_TOOL_CATALOG_3_1_1,
    modelVisibleToolNames: [
      ...M213_NATIVE_TOOLS,
      ...VEXP_DEFAULT_TOOL_CATALOG_3_1_1.map((toolId) => mcpToolName("vexp", toolId)),
    ],
    treatmentInstruction: null,
    forbiddenArtifacts: [".vtrace", "VTRACE_*", "vtrace daemon socket"],
  };
}

// ── Randomisation (§16) ─────────────────────────────────────────────

/** The six orders of three arms, in a fixed canonical sequence. */
export const M213_ARM_ORDERS: readonly (readonly M213Arm[])[] = Object.freeze([
  Object.freeze<M213Arm[]>(["baseline", "vtrace", "vexp"]),
  Object.freeze<M213Arm[]>(["baseline", "vexp", "vtrace"]),
  Object.freeze<M213Arm[]>(["vtrace", "baseline", "vexp"]),
  Object.freeze<M213Arm[]>(["vtrace", "vexp", "baseline"]),
  Object.freeze<M213Arm[]>(["vexp", "baseline", "vtrace"]),
  Object.freeze<M213Arm[]>(["vexp", "vtrace", "baseline"]),
]);

function seededRank(seed: string, instanceId: string): string {
  return createHash("sha256").update(`${seed} ${instanceId}`).digest("hex");
}

/**
 * Assign each task one of the six arm orders, balanced by construction.
 *
 * Instances are ranked by a seeded digest — which is arbitrary with respect to
 * repository, difficulty and every historical outcome — and the rank's residue
 * modulo six picks the order. With 100 tasks that is 17/17/17/17/16/16, so no
 * order is over-represented and baseline is never systematically first (§16).
 */
export function assignArmOrders(
  instanceIds: readonly string[],
  seed: string = M213_RANDOMIZATION_SEED,
): ReadonlyMap<string, readonly M213Arm[]> {
  const ranked = [...instanceIds].sort((left, right) => {
    const a = seededRank(seed, left);
    const b = seededRank(seed, right);
    return a < b ? -1 : a > b ? 1 : left < right ? -1 : 1;
  });
  const assignment = new Map<string, readonly M213Arm[]>();
  ranked.forEach((instanceId, rank) => {
    assignment.set(instanceId, M213_ARM_ORDERS[rank % M213_ARM_ORDERS.length]!);
  });
  return assignment;
}

// ── Run manifest (§39) ──────────────────────────────────────────────

export interface RunManifestRow {
  readonly runId: string;
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly arm: M213Arm;
  readonly armOrderIndex: number;
  readonly armOrder: readonly M213Arm[];
  readonly seed: string;
  readonly agentVersion: string;
  readonly model: string;
  readonly vtraceCommit: string | null;
  readonly vexpVersion: string | null;
  readonly containerImage: string;
  readonly maxTurns: number;
  readonly perRunCostCapUsd: number;
  readonly status: "PLANNED";
}

export interface ManifestInputs {
  readonly population: FrozenTaskPopulation;
  readonly rows: readonly { instance_id: string; repo: string; base_commit: string }[];
  readonly agentVersion: string;
  readonly model: string;
  readonly vtraceCommit: string;
  readonly vexpVersion: string | null;
  readonly seed?: string;
}

export function instanceImageKey(instanceId: string): string {
  return `swebench/sweb.eval.x86_64.${instanceId.toLowerCase().replace("__", "_1776_")}:latest`;
}

/**
 * Every intended run, generated before any of them executes.
 *
 * Emitting all 300 rows in advance is what proves the population was fixed:
 * a task added or dropped later changes the manifest digest, and §38's hash
 * guard turns that into a new cohort rather than a silent edit.
 */
export function buildRunManifest(input: ManifestInputs): readonly RunManifestRow[] {
  const seed = input.seed ?? M213_RANDOMIZATION_SEED;
  const orders = assignArmOrders(input.population.instanceIds, seed);
  const byId = new Map(input.rows.map((row) => [row.instance_id, row] as const));

  const manifest: RunManifestRow[] = [];
  for (const instanceId of input.population.instanceIds) {
    const row = byId.get(instanceId);
    if (row === undefined) throw new Error(`Instance missing from population rows: ${instanceId}`);
    const order = orders.get(instanceId);
    if (order === undefined) throw new Error(`Instance has no arm order: ${instanceId}`);
    order.forEach((arm, armOrderIndex) => {
      manifest.push({
        runId: `${M213_EXPERIMENT_NAME}:${instanceId}:${arm}`,
        instanceId,
        repo: row.repo,
        baseCommit: row.base_commit,
        arm,
        armOrderIndex,
        armOrder: order,
        seed,
        agentVersion: input.agentVersion,
        model: input.model,
        vtraceCommit: arm === "vtrace" ? input.vtraceCommit : null,
        vexpVersion: arm === "vexp" ? input.vexpVersion : null,
        containerImage: instanceImageKey(instanceId),
        maxTurns: M213_BUDGET.maxTurns,
        perRunCostCapUsd: M213_BUDGET.perRunCostCapUsd,
        status: "PLANNED",
      });
    });
  }
  return manifest;
}

// ── Budgets (§10) ───────────────────────────────────────────────────

/**
 * Identical for every arm, by construction: the fields are scalars on one
 * frozen object, so an arm-specific budget cannot be expressed without editing
 * the preregistration and changing its hash.
 *
 * The per-run cost cap is M193's, derived from the untreated stratum of
 * historical arms on this exact model, and sits strictly above the most
 * expensive arm ever recorded ($3.0384). vexp's shipped $3.00 default would
 * have truncated a real run, so it is not adopted merely because it was
 * published.
 */
export const M213_BUDGET = Object.freeze({
  maxTurns: 250,
  perRunCostCapUsd: 3.5,
  wallClockTimeoutSecondsPerRun: 3_600,
  toolCallTimeoutSeconds: 600,
  repositoryCommandTimeoutSeconds: 600,
  maxOutputTokensPerTurn: "provider default; not exposed by the Claude Code CLI",
  totalIntendedRuns: 300,
  totalSpendCapUsd: 1_050,
  totalSpendCapRationale:
    "300 runs at the $3.50 per-run ceiling. A cohort that hits this is one where every single "
    + "run cost more than any run ever observed; at the untreated historical mean of $0.6604 the "
    + "projection is $198.12, and at the untreated p90 of $1.2392 it is $371.76.",
  projectedTotalUsdAtUntreatedMean: 198.12,
  projectedTotalUsdAtUntreatedP90: 371.76,
});

// ── Agent and model identity (§8, §9) ───────────────────────────────

export const M213_AGENT = Object.freeze({
  implementation: "Anthropic Claude Code CLI, headless",
  binary: "/home/calvin/.local/bin/claude",
  version: "2.1.260",
  versionPinNote:
    "M193 pinned 2.1.251; that version is no longer installed on this host, so M213 re-pins to the "
    + "currently installed 2.1.260 rather than claiming continuity it does not have. The launch "
    + "harness must assert this exact string and abort the cohort on any difference.",
  systemPrompt: "CLI default; no --append-system-prompt and no --system-prompt in any arm",
  userPromptSource: "vexp-swe-bench src/harness/loader.ts buildPrompt, verbatim, identical in all three arms",
  userPromptText:
    "You are working on the {repo} repository (Python).\n"
    + "Fix the following issue by making the necessary code changes.\n"
    + "Do NOT write or modify tests — only fix the source code.\n\n"
    + "{problem_statement}",
  userPromptContainsTreatmentInstruction: false,
  outputFormat: "stream-json --verbose",
  turnLoop: "the Claude Code CLI's own; unchanged and identical across arms",
  terminationLogic: "CLI default termination, bounded by --max-turns and the per-run cost cap",
  errorRetryBehaviour: "CLI default; harness-level retry restricted to the infrastructure categories in §8 of the preregistration",
});

export const M213_MODEL = Object.freeze({
  provider: "Anthropic",
  model: "claude-opus-4-5-20251101",
  rationale:
    "The model VEXP's published benchmark used (README: 'All agents use Claude Opus 4.5 for a fair, "
    + "apples-to-apples comparison'), and the model every untreated historical VTRACE baseline arm "
    + "used, so the frozen cost ceilings are derived from this model's own economics.",
  temperature: "not exposed by the Claude Code CLI; provider default",
  thinkingBudget: 0,
  effortFlag: "omitted",
  maxOutputTokens: "provider default",
  identityVerification:
    "The launch harness must read the provider-returned model identity from each run's stream-json "
    + "init event and abort the cohort if it differs from the pin. Availability of this exact model "
    + "id was NOT verified during M213, because verifying it requires a paid call.",
  availabilityVerified: false,
});

// ── Outcome and analysis (§18–§21, §44–§45) ─────────────────────────

export const M213_PRIMARY_OUTCOME = Object.freeze({
  measure: "SWE-bench resolved",
  encoding: "binary; 1 = resolved, 0 = unresolved",
  evaluator: "the official SWE-bench evaluator (swebench==4.1.0) against the frozen FAIL_TO_PASS and PASS_TO_PASS sets",
  refusedSubstitutes: [
    "a patch was produced",
    "tests appeared to pass in the agent's own transcript",
    "the agent declared success",
    "the patch touched a gold file",
  ],
});

export const M213_COMPARISON_STRUCTURE = Object.freeze({
  primary: "VTRACE vs baseline (B − A)",
  keySecondary: ["VEXP vs baseline (C − A)", "VTRACE vs VEXP (B − C)"],
  multiplicity:
    "ONE primary comparison plus two key secondary comparisons. The primary is not multiplicity-"
    + "adjusted. The two key secondary comparisons are reported with Holm correction across the pair, "
    + "and every comparison is reported with its absolute delta, discordant-pair counts and interval "
    + "whether or not any p-value crosses a threshold.",
  rationale:
    "Co-primary status for all three would make the headline claim depend on a correction chosen "
    + "after the fact. The programme's own question is whether VTRACE helps, so that is the primary; "
    + "VEXP's causal effect and the head-to-head are exactly as preregistered but explicitly secondary.",
});

export const M213_STATISTICAL_PLAN = Object.freeze({
  design: "paired — every task is run under all three arms",
  binaryMethod: "exact McNemar (binomial) on discordant pairs, with a paired bootstrap CI on the pass-rate difference",
  bootstrapResamples: 10_000,
  bootstrapUnit: "task (all three of a task's arms resample together, preserving pairing)",
  intervalLevel: 0.95,
  reportedPerComparison: [
    "both resolve",
    "treatment only",
    "comparator only",
    "neither",
    "absolute pass-rate delta",
    "relative pass-rate delta",
    "95% bootstrap CI on the absolute delta",
    "exact McNemar p-value",
  ],
  continuousMethod:
    "paired differences on tokens, cost, turns and tool counts; median and mean both reported with "
    + "a 95% paired bootstrap CI, because M174 showed a two-run tail can carry 95.7% of a cost premium "
    + "and a mean alone would have hidden it",
  effectSizeDiscipline:
    "p < 0.05 is not the definition of success. Absolute delta, discordant counts and interval width "
    + "are reported first; a +1/100 result and a +10/100 result are described differently even when "
    + "neither is conventionally significant.",
  refused: [
    "reporting aggregate percentages without the paired table",
    "choosing the highlighted efficiency metric after seeing which one favours a treatment",
    "pooling these results statistically with M183 or with VEXP's published number",
  ],
});

export const M213_SECONDARY_OUTCOMES = Object.freeze({
  efficiency: [
    "input tokens", "output tokens", "cached tokens", "total model tokens",
    "provider-reported cost", "wall-clock duration", "turns",
  ],
  costSource:
    "provider-reported cost, taken from the run's own telemetry. A price table is used only if the "
    + "provider reports none, in which case the table and its retrieval date are frozen in the "
    + "artifact before any run.",
  behaviour: [
    "grep/ripgrep invocations", "glob/find invocations", "file reads", "git commands",
    "test commands", "turn count", "files inspected", "files edited",
    "turn of first edit", "turn of first read of a file the gold patch touches",
  ],
  behaviourInstrumentation:
    "ordered tool telemetry from the stream-json transcript, classified by tool name only. No "
    + "outcome label may enter the classification of pre-decision evidence (M185/M189).",
  goldRelativeMetricsAreEvaluationOnly:
    "Gold-relative timing metrics are computed after the fact from the frozen dataset. Gold patches, "
    + "gold file lists and FAIL_TO_PASS never enter any agent's context (§18 falsification control).",
  uptake: [
    "treatment surface exposed",
    "treatment tool invoked at least once",
    "number of treatment invocations",
    "tokens returned by the treatment",
    "turn of first treatment invocation",
    "treatment invoked before the first edit",
    "treatment invoked before the first read of a file the patch later touches",
  ],
  uptakeIsAMediator:
    "Uptake is post-treatment behaviour. It is described and may be analysed as a mediator, and it "
    + "NEVER conditions the primary comparison (§25).",
});

// ── Validity, exclusions, ITT (§6, §7, §25) ─────────────────────────

export const M213_TREATMENT_VALIDITY = Object.freeze({
  recordedPerRun: [
    "assigned arm",
    "treatment surface available",
    "treatment initialisation succeeded",
    "treatment index ready",
    "treatment tool schema visible in tools/list",
    "treatment invocation possible (a deterministic probe call succeeded)",
  ],
  primaryAnalysis: "INTENTION_TO_TREAT — every launched run is analysed under its assigned arm",
  secondaryAnalysis: "TREATMENT_VALID / per-protocol, restricted to runs where all six fields above hold",
  initialisationFailurePolicy:
    "A VTRACE or VEXP initialisation failure is NEVER silently converted to baseline. The run is "
    + "launched only if the treatment surface came up; if it did not, the run is excluded as "
    + "TREATMENT_INITIALISATION_FAILURE before the model is called, is replaced by nothing, and stays "
    + "visible in the accounting with its arm and repository. A failure discovered AFTER the model "
    + "started is retained under intention-to-treat and flagged treatment-invalid.",
});

export const M213_EXCLUSIONS = Object.freeze({
  legitimate: [
    "CONTAINER_CANNOT_START",
    "SOURCE_REVISION_UNAVAILABLE",
    "BENCHMARK_INSTANCE_MALFORMED",
    "ENVIRONMENT_IRREPRODUCIBLE",
    "TREATMENT_INITIALISATION_FAILURE",
    "AGENT_INFRASTRUCTURE_FAILURE_BEFORE_TREATMENT_EXPOSURE",
    "MODEL_SERVICE_FAILURE",
    "PATCH_EXTRACTION_FAILURE",
    "EVALUATOR_INFRA_FAILURE",
    "TELEMETRY_CORRUPT",
    "TREATMENT_CONTAMINATION",
  ],
  neverExclusions: [
    "the task failed",
    "the agent got confused",
    "the treatment was not used",
    "the treatment's output was poor",
    "a test failed",
    "the model produced no patch",
    "the run was expensive",
    "the run is inconvenient",
  ],
  exclusionsRemainVisible: true,
  frozenBeforeAnyPaidRun: true,
  statement:
    "An exclusion category not on this list cannot be created after outcomes exist. Every excluded "
    + "run keeps its arm, repository and category in the corpus accounting, so a drift toward "
    + "excluding one arm would be readable rather than hidden.",
  retryPolicy: Object.freeze({
    rerunnable: ["MODEL_SERVICE_FAILURE", "CONTAINER_INFRA_FAILURE", "EVALUATOR_INFRA_FAILURE", "TELEMETRY_CORRUPT"],
    notRerunnable: [
      "a bad patch", "turn exhaustion", "hitting the cost cap", "agent timeout",
      "the evaluator judging the task unresolved", "the agent choosing not to test",
    ],
    maxAttemptsPerRun: 2,
    bothAttemptsRemainInLedger: true,
  }),
});

// ── Stopping rule (§29) and no-tuning policy (§30) ──────────────────

export const M213_STOPPING_RULE = Object.freeze({
  design: "FIXED_N",
  intendedRuns: 300,
  statement:
    "All 100 tasks × 3 arms = 300 runs. The cohort is complete when every planned run has reached a "
    + "terminal state. There is no interim analysis, no adaptive continuation and no early stop.",
  refusedInputs: [
    "VTRACE looks better", "VTRACE looks worse", "VEXP looks better",
    "cost is disappointing", "an early p-value crossed a threshold",
    "the discordant table looks favourable",
  ],
  onlyLegitimateEarlyTermination:
    "The cohort may be ABANDONED — not analysed — if a defect invalidating comparability is found "
    + "(§30). Abandonment discards the cohort; it never yields a reported result.",
  budgetInterlock:
    "The $1,050 total cap is an infrastructure guard, not a stopping rule. If it binds, the cohort is "
    + "incomplete and is reported as incomplete; a partial cohort is never analysed as if it were the "
    + "preregistered experiment.",
});

export const M213_NO_TUNING_POLICY = Object.freeze({
  frozenAtFirstPaidRun: [
    "VTRACE product commit", "VEXP version", "agent version", "model", "prompts",
    "tool catalogues", "budgets", "task set", "randomisation", "harness", "evaluator",
    "stopping rule", "analysis plan",
  ],
  onCriticalDefect: "STOP, declare the cohort invalid, fix, restart from zero",
  refused: "patching halfway through and retaining earlier outcomes",
});

// ── Historical comparison policy (§47) ──────────────────────────────

export const M213_HISTORICAL_POLICY = Object.freeze({
  comparableHistory: [
    {
      source: "M183",
      result: "30 paired tasks, 60 runs; baseline 19/30, VTRACE 19/30; both 17, VTRACE-only 2, baseline-only 2, neither 9; McNemar p = 1.0",
      label: "historical/non-identical",
    },
    {
      source: "VEXP published benchmark",
      result: "a reported pass rate on this exact 100-task subset",
      label: "historical/non-identical; NOT a causal treatment effect — it has no same-run control",
    },
  ],
  poolingProhibited: true,
  statement:
    "Historical results may be cited beside the new experiment and must be labelled "
    + "historical/non-identical. They are never pooled statistically with it. The three-arm benchmark "
    + "is the authoritative causal comparison.",
});

export const M213_REPORTING_DISCIPLINE = Object.freeze({
  acceptableOutcomes: [
    "No detectable resolution improvement, with lower token use.",
    "No detectable difference in either resolution or efficiency.",
    "VEXP improved resolution; VTRACE did not.",
    "VTRACE and VEXP both improved resolution similarly.",
    "VTRACE improved resolution; VEXP did not.",
  ],
  successCriterion: "a valid experiment completed",
  refusedSuccessCriterion: "VTRACE wins",
  nullResultWording:
    "A null result is stated as a null result, with its interval, and is not reworded into a "
    + "directional claim the interval does not support.",
});

// ── Canonical serialisation and hashing (§38) ───────────────────────

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

export const M213_HASH_RULE: string =
  "sha256 over the canonical (recursively key-sorted) JSON of every field except "
  + "preregistrationHash, preregistrationHashRule and generatedAt";

/**
 * The digest of the DESIGN, not of the moment it was rendered.
 *
 * `generatedAt` is excluded deliberately. A hash that moved every time the
 * generator ran would flag an unchanged design as mutated, and a guard that
 * cries wolf on a no-op is a guard people learn to override. Excluding a pure
 * timestamp costs nothing: it carries no experimental commitment, and every
 * field that does — task ids, arms, budgets, seed, analysis plan, treatment
 * identities — stays inside the digest.
 *
 * Regenerating an unchanged design is therefore idempotent, and any edit to any
 * committing field still changes the hash.
 */
export function preregistrationHash(document: Record<string, unknown>): string {
  const {
    preregistrationHash: _ignored,
    preregistrationHashRule: _rule,
    generatedAt: _generatedAt,
    ...rest
  } = document;
  return createHash("sha256").update(JSON.stringify(canonicalize(rest))).digest("hex");
}

export function manifestHash(rows: readonly RunManifestRow[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(rows))).digest("hex");
}

// ── Substrate and patch capture (§13, §14, §15, §17) ────────────────

/**
 * The execution substrate, inherited from M192/M193 rather than from the
 * vendor's benchmark harness.
 *
 * The difference is load-bearing. vexp-swe-bench keeps ONE working tree per
 * repository slug and reuses it across every task of that repository, then
 * captures a patch with a HARDCODED exclusion list naming `.vexp` and not
 * `.vtrace`. M213's substrate gives every run its own container and checkout,
 * and derives its exclusion from a snapshot of untracked state taken before the
 * agent starts — so it is treatment-agnostic by construction and no vendor's
 * directory name appears in it.
 */
export const M213_SUBSTRATE = Object.freeze({
  inheritedFrom: "M192 / M193",
  harness: "swebench==4.1.0 official per-instance evaluation images",
  perInstanceContainers: true,
  freshCheckoutPerRun: true,
  authoritativeCheckout: "SINGLE_BIND_MOUNTED_TREE",
  patchCaptureMechanism:
    "m193c_patch_snapshot: `git diff --no-renames HEAD` for tracked bytes plus a `git ls-files "
    + "--others --exclude-standard` untracked lane, both restricted by a pathspec that excludes every "
    + "path already untracked before the agent started. Non-mutating: it never stages and never resets.",
  patchCaptureIsTreatmentAgnostic: true,
  patchCaptureNamesNoVendorDirectory: true,
  indexWarmthRegime: "COLD_UNIFORM",
  indexWarmthRationale:
    "Every run gets a fresh checkout, so neither treatment carries an index into the next task. "
    + "§13's cold and warm regimes are not mixed: this cohort is cold throughout, and is reported as "
    + "cold.",
  residualNotVerifiable: [
    "Treatment state that lives OUTSIDE the workspace is not covered by a fresh checkout. VTRACE "
    + "writes only `<repo>/.vtrace` (measured: the executability dry run created exactly that one "
    + "path and nothing else). VEXP keeps state under ~/.vexp and runs a daemon, so whether a VEXP "
    + "arm is genuinely cold cannot be established until the VEXP arm is executable at all.",
    "The ordering requirement — that the pre-agent untracked snapshot is taken AFTER treatment "
    + "initialisation, so treatment state is excluded rather than attributed to the agent — is a "
    + "property of a launch harness that does not exist yet.",
  ],
});

// ── Launch gates (§42) ──────────────────────────────────────────────

export type GateStatus = "PASS" | "FAIL" | "BLOCKED";

export interface LaunchGate {
  readonly id: string;
  readonly requirement: string;
  readonly status: GateStatus;
  readonly evidence: string;
}

export interface GateInputs {
  readonly preregistrationCommitted: boolean;
  readonly preregistrationHashRecorded: boolean;
  readonly populationVerified: boolean;
  readonly manifestRowCount: number;
  readonly vtraceExecutable: boolean;
  readonly vexpExecutable: boolean;
  readonly baselineContaminationGuardPasses: boolean;
  readonly treatmentContaminationGuardsPass: boolean;
  readonly identicalAgentVerified: boolean;
  readonly identicalModelVerified: boolean;
  readonly identicalBudgetsVerified: boolean;
  readonly identicalNativeToolsVerified: boolean;
  readonly repositoryStateEquivalenceVerified: boolean;
  readonly evaluatorValidated: boolean;
  readonly exclusionRulesFrozen: boolean;
  readonly statisticalPlanFrozen: boolean;
  readonly stoppingRuleFrozen: boolean;
  readonly randomizationFrozen: boolean;
  readonly falsificationControlsPass: boolean;
  readonly noOutcomeBearingRunHasOccurred: boolean;
  readonly treatmentStatePatchNeutrality: GateStatus;
  readonly warmColdIndexSymmetry: GateStatus;
  /** What the vendor harness's own pathspecs do, measured. Evidence, not a gate input. */
  readonly vendorHarnessPatchCaptureIsSymmetric: boolean;
  readonly vendorHarnessIndexWarmthIsSymmetric: boolean;
}

/**
 * G1–G20 are the prompt's gates verbatim. G21 and G22 are additions M213's own
 * harness audit forced: both are real, measured defects in the benchmark
 * harness that would have silently advantaged one arm, and neither is covered
 * by G1–G20.
 */
export function evaluateLaunchGates(input: GateInputs): readonly LaunchGate[] {
  const gate = (id: string, requirement: string, ok: boolean, evidence: string): LaunchGate => ({
    id, requirement, status: ok ? "PASS" : "FAIL", evidence,
  });
  return Object.freeze([
    gate("G1", "preregistration committed", input.preregistrationCommitted,
      "stage5_m213_preregistration.json generated from the committed authority module"),
    gate("G2", "preregistration hash recorded", input.preregistrationHashRecorded,
      "sha256 over the canonical document, printed in the artifact and in the report"),
    gate("G3", "task population frozen", input.populationVerified,
      "VEXP's own 100 instance ids, sha256-pinned, verified against their published table"),
    gate("G4", "run manifest frozen", input.manifestRowCount === 300,
      `${input.manifestRowCount} planned rows generated before any execution`),
    gate("G5", "VTRACE treatment executable", input.vtraceExecutable,
      "offline per-repository index + tools/list + deterministic query dry run"),
    gate("G6", "VEXP treatment executable", input.vexpExecutable,
      "installed CLI runnability, licence state and plan capacity against the population's repositories"),
    gate("G7", "baseline contamination guard passes", input.baselineContaminationGuardPasses,
      "F1 control"),
    gate("G8", "treatment contamination guards pass", input.treatmentContaminationGuardsPass,
      "F2 and F3 controls"),
    gate("G9", "identical agent verified", input.identicalAgentVerified,
      "one frozen agent record shared by all three arm definitions"),
    gate("G10", "identical model verified", input.identicalModelVerified,
      "one frozen model record shared by all three arm definitions"),
    gate("G11", "identical budgets verified", input.identicalBudgetsVerified,
      "F7 control over the manifest's per-row budget fields"),
    gate("G12", "identical native tools verified", input.identicalNativeToolsVerified,
      "F17 control over the arm definitions"),
    gate("G13", "repository-state equivalence verified", input.repositoryStateEquivalenceVerified,
      "F8 control plus the measured tracked-source digest before/after indexing"),
    gate("G14", "evaluator validated", input.evaluatorValidated,
      "swebench==4.1.0 official evaluator, the same harness M192 established"),
    gate("G15", "exclusion rules frozen", input.exclusionRulesFrozen, "M213_EXCLUSIONS"),
    gate("G16", "statistical plan frozen", input.statisticalPlanFrozen, "M213_STATISTICAL_PLAN"),
    gate("G17", "stopping rule frozen", input.stoppingRuleFrozen, "M213_STOPPING_RULE"),
    gate("G18", "randomisation frozen", input.randomizationFrozen,
      "seeded balanced arm-order assignment, seed committed"),
    gate("G19", "all falsification controls pass", input.falsificationControlsPass, "F1–F22"),
    gate("G20", "no benchmark-task outcome-bearing live run has occurred",
      input.noOutcomeBearingRunHasOccurred, "M213 spend accounting"),
    {
      id: "G21",
      requirement: "treatment-generated state cannot enter a captured patch",
      status: input.treatmentStatePatchNeutrality,
      evidence:
        `vendor harness capture symmetric: ${String(input.vendorHarnessPatchCaptureIsSymmetric)}; `
        + "M213's adopted substrate excludes pre-agent untracked paths and names no vendor directory, "
        + "but the ordering that makes that hold belongs to a launch harness that does not exist yet",
    },
    {
      id: "G22",
      requirement: "index warmth is symmetric across treatment arms",
      status: input.warmColdIndexSymmetry,
      evidence:
        `vendor harness warmth symmetric: ${String(input.vendorHarnessIndexWarmthIsSymmetric)}; `
        + "M213's substrate is COLD_UNIFORM by fresh checkout, but VEXP keeps state outside the "
        + "workspace and cannot be shown cold while the VEXP arm is not executable",
    },
  ]);
}

export function launchAuthorized(gates: readonly LaunchGate[]): boolean {
  return gates.every((entry) => entry.status === "PASS");
}
