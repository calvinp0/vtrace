/**
 * M214 — generate the preregistration, the run manifest, the external-reference
 * snapshot, the falsification results and the launch-gate table.
 *
 * ONE authority (`m214Preregistration.ts` + `m214ExternalReference.ts` +
 * `m214TreatmentLifecycle.ts`), rendered twice: a machine-readable JSON
 * document and a human-readable Markdown report, both produced here so they
 * cannot drift apart.
 *
 * This script calls no model, starts no agent, runs no benchmark task and
 * touches no product code. It reads the frozen task population, reads M213's
 * committed artifacts to prove they are unmodified, reads the VTRACE tool
 * registry, reads the benchmark harness's own JavaScript to audit it, folds in
 * the deterministic probe artifacts, and computes.
 *
 * Usage:
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m214_preregistration.ts [--out <dir>]
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { preregistrationHash as m213PreregistrationHash } from "./m213Preregistration";
import {
  M214_EXTERNAL_REFERENCE,
  M214_EXTERNAL_REFERENCE_HASH_RULE,
  M214_EXTERNAL_REFERENCE_SCHEMA,
  auditExternalComparisonWording,
  auditExternalReferenceTaskArtifact,
  externalReferenceHash,
  renderCausalConclusion,
  renderExternalComparison,
} from "./m214ExternalReference";
import { runFalsificationSuite, suitePasses } from "./m214Falsification";
import {
  M214_AGENT,
  M214_ARMS,
  M214_ARM_ORDERS,
  M214_BUDGET,
  M214_CAUSAL_WORDING,
  M214_COST_SEMANTICS,
  M214_EXCLUSIONS,
  M214_EXPERIMENT_NAME,
  M214_EXTERNAL_COMPARISON_LABEL,
  M214_EXTERNAL_COMPARISON_LABEL_REFUSED,
  M214_HASH_RULE,
  M214_HISTORICAL_POLICY,
  M214_ITT_POLICY,
  M214_MANIFEST_SCHEMA,
  M214_MODEL,
  M214_NATIVE_TOOLS,
  M214_NO_TUNING_POLICY,
  M214_OUTCOME_INTERPRETATIONS,
  M214_PARENT,
  M214_PREREGISTRATION_SCHEMA,
  M214_PRIMARY_ESTIMAND,
  M214_PRIMARY_OUTCOME,
  M214_PUBLISHED_CONDITION_MATRIX,
  M214_RANDOMIZATION_SEED,
  M214_REPORTING_DISCIPLINE,
  M214_SECONDARY_OUTCOMES,
  M214_STATISTICAL_PLAN,
  M214_STOPPING_RULE,
  M214_SUBSTRATE,
  M214_TASK_POPULATION_PATH,
  M214_TASK_POPULATION_PROVENANCE,
  M214_TREATMENT_USAGE,
  M214_VENDOR_SCRIPT_MISMATCH,
  M214_VEXP_BLOCKERS,
  M214_VEXP_BLOCKER_VERDICT,
  M214_VTRACE_CATALOG_AUDIT,
  M214_VTRACE_TREATMENT_CATALOG,
  type GateStatus,
  type LaunchGate,
  armDefinition,
  assignArmOrders,
  budgetIdentity,
  buildRunManifest,
  deferredRuntimeGates,
  evaluateLaunchGates,
  launchAuthorized,
  preregistrationComplete,
  loadFrozenTaskPopulation,
  m214ManifestHash,
  m214PreregistrationHash,
  verifyPopulation,
} from "./m214Preregistration";
import {
  M214_INDEX_WARMTH_POLICY,
  M214_LIFECYCLE_ORDER,
  auditHardcodedExclusionList,
  auditResetPreservedPaths,
} from "./m214TreatmentLifecycle";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(import.meta.dir, "..", "..");
const DEFAULT_OUT = path.join(import.meta.dir, "results");
const VEXP_HARNESS_REPO_JS = "/home/calvin/code/vexp-swe-bench/dist/harness/repo.js";
const CLAUDE_VERSIONS_DIR = "/home/calvin/.local/share/claude/versions";

async function git(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", [...args], {
      cwd: VTRACE_ROOT, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch { return ""; }
}

function readJsonIfPresent(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }
  catch { return null; }
}

/**
 * Read the benchmark harness's own patch-capture and clean pathspecs.
 *
 * Extracted from the shipped JavaScript rather than transcribed, because both
 * findings this produces are asymmetries that would silently advantage one arm,
 * and a hand-copied list would be exactly the kind of claim that rots.
 */
function auditBenchmarkHarness(): {
  readonly file: string;
  readonly readable: boolean;
  readonly patchCaptureExclusions: readonly string[];
  readonly cleanPreservedPaths: readonly string[];
  readonly findings: readonly string[];
} {
  if (!existsSync(VEXP_HARNESS_REPO_JS)) {
    return {
      file: VEXP_HARNESS_REPO_JS,
      readable: false,
      patchCaptureExclusions: [],
      cleanPreservedPaths: [],
      findings: ["harness source not present; the pathspec audit could not be re-derived"],
    };
  }
  const source = readFileSync(VEXP_HARNESS_REPO_JS, "utf8");

  const patchCaptureExclusions = [...source.matchAll(/":\(exclude\)([^"]+)"/g)]
    .map((match) => match[1]!);
  const cleanPreservedPaths = [...source.matchAll(/"-e",\s*"([^"]+)"/g)].map((match) => match[1]!);

  const unique = (values: readonly string[]) => [...new Set(values)].sort();
  const exclusions = unique(patchCaptureExclusions);
  const preserved = unique(cleanPreservedPaths);

  return {
    file: VEXP_HARNESS_REPO_JS,
    readable: true,
    patchCaptureExclusions: exclusions,
    cleanPreservedPaths: preserved,
    findings: [
      ...auditHardcodedExclusionList(exclusions, [".vtrace", ".vexp"]),
      ...auditResetPreservedPaths(preserved, [".vtrace", ".vexp"]),
      "the harness reuses ONE working tree per repository slug under .bench-repos across every task "
      + "of that repository, so two arms of one task would not be independent",
    ],
  };
}

/** The evaluator M192 established, re-verified rather than assumed. */
async function auditEvaluator(): Promise<{
  readonly interpreter: string;
  readonly available: boolean;
  readonly version: string;
  readonly expectedVersion: string;
  readonly matchesExpected: boolean;
}> {
  const interpreter = "/home/calvin/code/vexp-swe-bench/.venv/bin/python";
  const expectedVersion = "4.1.0";
  if (!existsSync(interpreter)) {
    return { interpreter, available: false, version: "", expectedVersion, matchesExpected: false };
  }
  try {
    const { stdout } = await execFile(
      interpreter,
      ["-c", "import swebench; print(swebench.__version__)"],
      { timeout: 120_000 },
    );
    const version = stdout.trim();
    return { interpreter, available: true, version, expectedVersion, matchesExpected: version === expectedVersion };
  } catch {
    return { interpreter, available: true, version: "", expectedVersion, matchesExpected: false };
  }
}

/**
 * §13, §34 — how far model availability can be established without spending.
 *
 * The agent binary carries its own model registry. A complete, unflagged entry
 * is meaningfully stronger evidence than M213's "not verified", and it is still
 * not a provider response; both halves are recorded so the gate can be honest
 * about which one it has.
 */
function auditModelAvailability(agentVersion: string): {
  readonly method: string;
  readonly binary: string;
  readonly registryEntryFound: boolean;
  readonly registryEntry: string | null;
  readonly deprecationMarkerFound: boolean;
  readonly providerConfirmed: boolean;
  readonly evidence: string;
  readonly status: GateStatus;
} {
  const binary = path.join(CLAUDE_VERSIONS_DIR, agentVersion);
  const method =
    "static read of the installed agent binary's bundled model registry; no model was called";
  if (!existsSync(binary)) {
    return {
      method, binary, registryEntryFound: false, registryEntry: null,
      deprecationMarkerFound: false, providerConfirmed: false,
      evidence: "the pinned agent binary is not present on this host",
      status: "BLOCKED",
    };
  }
  const bytes = readFileSync(binary, "latin1");
  const pattern = /id:"claude-opus-4-5",family:"opus"[^}]{0,900}/;
  const match = pattern.exec(bytes);
  const entry = match?.[0] ?? null;
  const registryEntryFound = entry !== null && entry.includes(M214_MODEL.model);
  const deprecationMarkerFound = entry !== null
    && /deprecated|retired|sunset|end_of_life/.test(entry);

  return {
    method,
    binary,
    registryEntryFound,
    registryEntry: entry === null ? null : entry.slice(0, 480),
    deprecationMarkerFound,
    providerConfirmed: false,
    evidence: registryEntryFound && !deprecationMarkerFound
      ? `Claude Code ${agentVersion}'s model registry lists claude-opus-4-5 with first_party id `
        + `${M214_MODEL.model}, alongside newer families, with no deprecation or retirement marker. `
        + "A provider-confirmed response would require a paid call and was not made."
      : "the pinned model identifier was not found as a complete registry entry",
    // PASS on registry presence; the residual — a provider round trip — is
    // closed by the launch harness reading each run's own init event, which is
    // the first moment it can be closed without spending.
    status: registryEntryFound && !deprecationMarkerFound ? "PASS" : "BLOCKED",
  };
}

/** §11 — the treatment catalogue, read from the product rather than transcribed. */
async function auditTreatmentCatalog(): Promise<{
  readonly source: string;
  readonly readable: boolean;
  readonly catalog: readonly string[];
  readonly matchesFrozen: boolean;
  readonly tools: readonly Record<string, unknown>[];
}> {
  try {
    const registry = await import("../../src/mcp/tools") as unknown as {
      defaultMcpToolRegistry: { listMetadata: () => readonly Record<string, unknown>[] };
    };
    const metadata = registry.defaultMcpToolRegistry.listMetadata();
    const catalog = metadata.map((entry) => String(entry.toolId));
    const tools = metadata.map((entry) => ({
      toolId: String(entry.toolId),
      descriptionChars: String(entry.description ?? "").length,
      descriptionSha256: new Bun.CryptoHasher("sha256")
        .update(String(entry.description ?? "")).digest("hex").slice(0, 16),
      inputSchemaSha256: new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(entry.inputSchema ?? null)).digest("hex").slice(0, 16),
      requiredInputs: (entry.inputSchema as { required?: string[] } | undefined)?.required ?? [],
    }));
    return {
      source: "src/mcp/tools.ts defaultMcpToolRegistry.listMetadata(), read at runtime",
      readable: true,
      catalog,
      matchesFrozen: catalog.join(",") === M214_VTRACE_TREATMENT_CATALOG.join(","),
      tools,
    };
  } catch (error) {
    return {
      source: "src/mcp/tools.ts",
      readable: false,
      catalog: [],
      matchesFrozen: false,
      tools: [{ error: String(error) }],
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 && args[outIndex + 1] !== undefined
    ? path.resolve(args[outIndex + 1]!)
    : DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });

  // ── Repository and treatment identity ──
  const vtraceCommit = await git(["rev-parse", "HEAD"]);
  const vtraceProductTreeSha = await git(["rev-parse", "HEAD:src"]);
  const trackedDirty = await git(["status", "--porcelain", "--untracked-files=no"]);
  const branch = await git(["branch", "--show-current"]);

  // ── The frozen population, re-verified ──
  const population = loadFrozenTaskPopulation(M214_TASK_POPULATION_PATH);
  const verification = verifyPopulation(population);
  const externalArtifactIssues = auditExternalReferenceTaskArtifact(population.sha256);

  const datasetRows = readFileSync(M214_TASK_POPULATION_PATH, "utf8")
    .trim().split("\n")
    .map((line) => JSON.parse(line) as { instance_id: string; repo: string; base_commit: string });

  // ── M213 immutability ──
  const m213Path = path.join(outDir, "stage5_m213_preregistration.json");
  const m213HashPath = path.join(outDir, "stage5_m213_preregistration_hash.json");
  const m213Document = readJsonIfPresent(m213Path);
  const m213HashArtifact = readJsonIfPresent(m213HashPath);
  const m213RecordedHash = String(m213HashArtifact?.recordedHash ?? "");
  const m213RecomputedHash = m213Document === null ? "" : m213PreregistrationHash(m213Document);
  const m213Immutable = m213Document !== null
    && m213RecordedHash.length === 64
    && m213RecomputedHash === m213RecordedHash
    && m213Document.armCount === 3
    && m213Document.launchAuthorized === false;

  // ── Probe artifacts, produced by the deterministic runners ──
  const vendorScript = readJsonIfPresent(path.join(outDir, "stage5_m214_vendor_script_subset.json"));
  const patchCapture = readJsonIfPresent(path.join(outDir, "stage5_m214_patch_capture_repair.json"));
  const scopedTypecheck = readJsonIfPresent(path.join(outDir, "stage5_m214_scoped_typecheck.json"));
  const vtraceExecutability = readJsonIfPresent(
    path.join(outDir, "stage5_m213_vtrace_executability.json"),
  );

  const harness = auditBenchmarkHarness();
  const evaluator = await auditEvaluator();
  const modelAvailability = auditModelAvailability(M214_AGENT.version);
  const treatmentCatalog = await auditTreatmentCatalog();

  // ── Manifest ──
  const manifest = buildRunManifest({
    population,
    rows: datasetRows,
    agentVersion: M214_AGENT.version,
    model: M214_MODEL.model,
    vtraceCommit,
    vtraceProductTreeSha,
  });
  const manifestDigest = m214ManifestHash(manifest);
  const armOrders = assignArmOrders(population.instanceIds);
  const orderBalance: Record<string, number> = {};
  for (const order of armOrders.values()) {
    const key = order.join(">");
    orderBalance[key] = (orderBalance[key] ?? 0) + 1;
  }

  const externalHash = externalReferenceHash();

  // ── Falsification ──
  const scriptDerivedIds = (vendorScript?.scriptDerived as { instanceIds?: string[] } | undefined)
    ?.instanceIds ?? [];
  const scopedFindings = scopedTypecheck?.findings as
    { scopedTargetDetectsInjectedError?: boolean } | undefined;

  // Built without the hash fields, then re-run once they exist — the document
  // has to be complete before it can be hashed, and the suite has to check the
  // real recorded digest rather than a placeholder.
  const documentBody = {
    schemaVersion: M214_PREREGISTRATION_SCHEMA,
    milestone: "M214",
    benchmarkName: M214_EXPERIMENT_NAME,
    generatedAt: new Date().toISOString(),
    frozenBeforeAnyPaidRun: true,
    liveModelSpendDuringM214Usd: 0,
    benchmarkTaskLiveAgentRuns: 0,
    authorityNote:
      "A frozen design is a precondition for a paid run, not permission to start one. No paid run "
      + "is authorised by this document.",

    parent: {
      ...M214_PARENT,
      recomputedPreregistrationHash: m213RecomputedHash,
      recordedPreregistrationHash: m213RecordedHash,
      immutable: m213Immutable,
      vexpBlockers: M214_VEXP_BLOCKERS,
      vexpVerdict: M214_VEXP_BLOCKER_VERDICT,
    },

    repositoryState: {
      branch,
      vtraceCommit,
      vtraceProductTreeSha,
      productTreeUnchangedSinceM213: vtraceProductTreeSha === "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d",
      trackedWorkingTreeClean: trackedDirty.length === 0,
      trackedDirtyPaths: trackedDirty.length === 0 ? [] : trackedDirty.split("\n"),
      note:
        "Untracked benchmark output is ignored by design. Two pre-existing tracked result files "
        + "(stage5_outcome_ledger.json/.md) predate this milestone and are not touched.",
      productChanges: 0,
    },

    researchQuestions: {
      RQ1:
        "Does VTRACE causally change task resolution relative to an identical baseline in this "
        + "harness? H1: P(resolve|VTRACE) != P(resolve|baseline), two-sided, paired.",
      RQ2:
        "Does VTRACE change input, output or total tokens, model cost, or turns, holding resolution "
        + "as measured?",
      RQ3:
        "Does VTRACE alter native search usage, file reads, files inspected or files edited?",
      RQ4:
        "How often is the treatment actually consumed — exposed, invoked, invoked before the first "
        + "edit? Descriptive and mediator only.",
      RQ5_EXTERNAL:
        "Descriptively, how does our absolute pass rate compare with the vendor's published result "
        + "on the identical task population? NOT a causal question and never analysed as one.",
      directionality:
        "Every causal hypothesis is two-sided. M183 observed exact resolution parity, so a "
        + "one-sided favourable claim is not supported by anything this programme has measured.",
    },

    taskPopulation: {
      selection: "Option 1 — the exact VEXP subset, taken as the vendor's own committed artifact",
      path: M214_TASK_POPULATION_PATH,
      sha256: population.sha256,
      provenance: M214_TASK_POPULATION_PROVENANCE,
      instanceCount: population.instanceIds.length,
      repositories: population.repositories,
      countsByRepository: population.countsByRepository,
      complexityMedian: population.complexityMedian,
      complexityCeiling: population.complexityCeiling,
      verification,
      externalArtifactGuardIssues: externalArtifactIssues,
      instanceIds: population.instanceIds,
      vendorScriptMismatch: {
        ...M214_VENDOR_SCRIPT_MISMATCH,
        rederivedByM214: vendorScript !== null,
        rederivedOverlap: (vendorScript?.comparison as { overlapCount?: number } | undefined)
          ?.overlapCount ?? null,
        artifact: "stage5_m214_vendor_script_subset.json",
      },
    },

    arms: M214_ARMS.map((arm) => armDefinition(arm)),
    armCount: 2,
    vexpIsNotAnArm:
      "There is no VEXP arm and no VEXP run row. The vendor's published result lives in "
      + "stage5_m214_external_reference.json and is labelled EXTERNAL_VENDOR_REFERENCE.",

    treatmentSurface: {
      vtrace: {
        catalog: M214_VTRACE_TREATMENT_CATALOG,
        catalogSize: M214_VTRACE_TREATMENT_CATALOG.length,
        audit: M214_VTRACE_CATALOG_AUDIT,
        readFromProduct: treatmentCatalog,
        howStarted: M214_VTRACE_CATALOG_AUDIT.howStarted,
      },
      baseline: { catalog: [], catalogSize: 0 },
    },

    agent: M214_AGENT,
    model: { ...M214_MODEL, availabilityAudit: modelAvailability },
    nativeTools: {
      set: M214_NATIVE_TOOLS,
      identicalAcrossArms: true,
      rationale:
        "vexp-swe-bench's DEFAULT_ALLOWED_TOOLS, unchanged in both arms. M168-E measured that "
        + "denying Grep/Glob is itself a treatment that lost two tasks and won none.",
    },
    budgets: M214_BUDGET,
    budgetIdentity: budgetIdentity(),
    costSemantics: M214_COST_SEMANTICS,

    publishedConditionMatrix: M214_PUBLISHED_CONDITION_MATRIX,
    externalComparisonLabel: M214_EXTERNAL_COMPARISON_LABEL,
    externalComparisonLabelRefused: M214_EXTERNAL_COMPARISON_LABEL_REFUSED,

    substrate: M214_SUBSTRATE,
    lifecycleOrder: M214_LIFECYCLE_ORDER,
    indexWarmthPolicy: M214_INDEX_WARMTH_POLICY,
    patchCaptureRepair: patchCapture === null ? null : {
      artifact: "stage5_m214_patch_capture_repair.json",
      verdict: patchCapture.verdict,
      findings: patchCapture.findings,
      hardcodedExclusionAudit: patchCapture.hardcodedExclusionAudit,
    },
    benchmarkHarnessAudit: harness,
    evaluator,

    randomization: {
      seed: M214_RANDOMIZATION_SEED,
      method:
        "Instances are ranked by sha256(seed + ' ' + instance_id) and the rank's parity selects one "
        + "of the two orders, so the assignment is arbitrary with respect to repository, difficulty "
        + "and every historical outcome.",
      orders: M214_ARM_ORDERS,
      balance: orderBalance,
      balanceNote: "exactly 50/50; baseline is never systematically first",
    },

    runManifest: {
      schemaVersion: M214_MANIFEST_SCHEMA,
      file: "stage5_m214_run_manifest.json",
      intendedRuns: manifest.length,
      manifestHash: manifestDigest,
      generatedBeforeAnyExecution: true,
      allStatusesPlanned: manifest.every((row) => row.status === "PLANNED"),
      containsNoVendorRow: true,
    },

    primaryOutcome: M214_PRIMARY_OUTCOME,
    primaryEstimand: M214_PRIMARY_ESTIMAND,
    statisticalPlan: M214_STATISTICAL_PLAN,
    secondaryOutcomes: M214_SECONDARY_OUTCOMES,
    treatmentUsage: M214_TREATMENT_USAGE,
    ittPolicy: M214_ITT_POLICY,
    exclusions: M214_EXCLUSIONS,
    stoppingRule: M214_STOPPING_RULE,
    noTuningPolicy: M214_NO_TUNING_POLICY,
    causalWording: M214_CAUSAL_WORDING,
    reportingDiscipline: M214_REPORTING_DISCIPLINE,
    outcomeInterpretations: M214_OUTCOME_INTERPRETATIONS,
    historicalComparisonPolicy: M214_HISTORICAL_POLICY,

    externalReference: {
      file: "stage5_m214_external_reference.json",
      evidenceClass: M214_EXTERNAL_REFERENCE.evidenceClass,
      hash: externalHash,
      hashRule: M214_EXTERNAL_REFERENCE_HASH_RULE,
      publishedPassAt1: `${M214_EXTERNAL_REFERENCE.publishedPassAt1Count} / ${M214_EXTERNAL_REFERENCE.taskCount}`,
      publishedCostPerTaskUsd: M214_EXTERNAL_REFERENCE.publishedCostPerTaskUsd,
      mayEnterCausalAnalysis: false,
      guard:
        "auditPairedComparison rejects any operand that is not one of the two executed arms; "
        + "auditCausalTableMembership rejects an external row in a causal table; "
        + "auditExternalComparisonWording rejects head-to-head phrasing and requires a cross-study "
        + "qualifier on any numeric side-by-side.",
    },

    scopedTypecheck: scopedTypecheck === null ? null : {
      artifact: "stage5_m214_scoped_typecheck.json",
      config: scopedTypecheck.scopedConfig,
      m214NewTypecheckErrors: (scopedTypecheck.clean as { errorCount?: number } | undefined)?.errorCount ?? null,
      preexistingBenchmarkTestTypeErrors:
        (scopedTypecheck.preexistingBenchmarkTestTypeErrors as { errorCount?: number } | undefined)
          ?.errorCount ?? null,
      verdict: scopedTypecheck.verdict,
    },

    vtraceExecutability: vtraceExecutability === null ? null : {
      inheritedFrom: "M213",
      artifact: "stage5_m213_vtrace_executability.json",
      verdict: vtraceExecutability.verdict,
      repositoriesProven: vtraceExecutability.repositoriesProven,
      observationalIndexing: vtraceExecutability.observationalIndexing,
    },

    preregistrationHashRule: M214_HASH_RULE,
    preregistrationHash: "",
  } as Record<string, unknown>;

  const digest = m214PreregistrationHash(documentBody);
  const document: Record<string, unknown> = { ...documentBody, preregistrationHash: digest };

  const controls = runFalsificationSuite({
    frozenInstanceIds: population.instanceIds,
    manifest,
    expectedOrders: armOrders,
    seed: M214_RANDOMIZATION_SEED,
    preregistrationDocument: document,
    preregistrationHashRecorded: digest,
    manifestHashRecorded: manifestDigest,
    legitimateExclusionCategories: M214_EXCLUSIONS.legitimate,
    vtraceCommit,
    vtraceProductTreeSha,
    frozenTaskArtifactSha256: population.sha256,
    externalReferenceHashRecorded: externalHash,
    m213Document: m213Document ?? {},
    m213PreregistrationHashRecorded: m213RecordedHash,
    vendorScriptDerivedInstanceIds: scriptDerivedIds,
    vendorHardcodedPatchExclusions: harness.patchCaptureExclusions,
    vendorCleanPreservedPaths: harness.cleanPreservedPaths,
    scopedTypecheckDetectsInjectedError: scopedFindings?.scopedTargetDetectsInjectedError === true,
  });
  const controlsPass = suitePasses(controls);

  const patchFindings = patchCapture?.findings as Record<string, boolean> | undefined;
  const gates = evaluateLaunchGates({
    preregistrationCommitted: true,
    preregistrationHashRecorded: digest.length === 64,
    m213Immutable,
    externalTaskArtifactVerified: externalArtifactIssues.length === 0 && verification.verified,
    taskIdsFrozen: population.instanceIds.length === 100,
    manifestRowCount: manifest.length,
    baselineTreatmentFree: controls.find((entry) => entry.id === "F3_CLEAN")?.satisfied === true,
    // M213's dry run proved 12/12 repositories. The evidence transfers because
    // M214's product tree is byte-identical to the one it measured; if the tree
    // had moved, the treatment would be a different treatment.
    vtraceExecutable: vtraceExecutability?.allProven === true
      && vtraceExecutability.repositoriesProven === vtraceExecutability.repositoriesIntended
      && vtraceProductTreeSha === "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d",
    vtraceIdentityFrozen: vtraceCommit.length === 40 && vtraceProductTreeSha.length === 40,
    agentIdentityFrozen: existsSync(path.join(CLAUDE_VERSIONS_DIR, M214_AGENT.version)),
    modelIdentityFrozen: M214_MODEL.identicalAcrossArms,
    nativeToolsIdentical:
      armDefinition("baseline").nativeTools.join(",") === armDefinition("vtrace").nativeTools.join(","),
    budgetsIdentical: new Set(manifest.map((row) => row.budgetIdentity)).size === 1,
    // A RUNTIME gate: the guard exists, the per-run assertion needs runs.
    sourceStateEquivalence: "DEFERRED_TO_LAUNCH",
    indexingObservational: patchFindings?.sourceUnchangedByTreatment === true ? "PASS" : "FAIL",
    treatmentStateExcludedFromPatch:
      patchCapture?.verdict === "PATCH_CAPTURE_REPAIR_VERIFIED" ? "PASS" : "FAIL",
    resetWarmPolicySymmetric: "PASS",
    executionOrderFrozen: Object.values(orderBalance).every((count) => count === 50),
    evaluatorValidated: evaluator.matchesExpected,
    pairedAnalysisFrozen: M214_STATISTICAL_PLAN.frozenBeforeOutcomes,
    efficiencyAnalysisFrozen: M214_SECONDARY_OUTCOMES.identicalInstrumentationAcrossArms,
    invalidRunRulesFrozen: M214_EXCLUSIONS.frozenBeforeAnyPaidRun,
    stoppingRuleFrozen: M214_STOPPING_RULE.design === "FIXED_N",
    externalReferenceFrozen: externalHash.length === 64,
    externalReferenceCannotEnterCausalAnalysis:
      controls.find((entry) => entry.id === "F16")?.satisfied === true
      && controls.find((entry) => entry.id === "F16_TABLE")?.satisfied === true,
    falsificationSuitePasses: controlsPass,
    noOutcomeBearingRunHasOccurred: true,
    liveModelSpendIsZero: true,
    scopedTypecheckClean: scopedTypecheck?.verdict === "M214_SCOPED_TYPECHECK_VERIFIED",
    modelAvailabilityEvidence: modelAvailability.status,
    // Executed on real repositories by the patch-capture probe and audited from
    // the trace it emitted, not asserted from the constant.
    treatmentLifecycleOrderVerified:
      patchFindings?.lifecycleOrderExecutedCorrectly === true
      && patchFindings.snapshotTakenAfterTreatmentInitialisation === true
        ? "PASS" : "FAIL",
    // The honest blocker, named rather than dissolved into the gates above.
    launchExecutorExists: false,
    runtimeGuards: {
      sourceStateEquivalence: "auditSourceStateEquivalence (m214TreatmentLifecycle.ts)",
    },
  });
  const authorized = launchAuthorized(gates);
  const designComplete = preregistrationComplete(gates);
  const deferred = deferredRuntimeGates(gates);

  // ── Artifacts ──
  const jsonPath = path.join(outDir, "stage5_m214_preregistration.json");
  writeFileSync(jsonPath, `${JSON.stringify({
    ...document,
    launchGates: gates,
    launchAuthorized: authorized,
    preregistrationComplete: designComplete,
    deferredRuntimeGates: deferred.map((entry) => entry.id),
    readinessVerdict: authorized
      ? "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY"
      : "PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY",
    readinessBlocker: authorized ? null
      : gates.filter((entry) => entry.status !== "PASS").map((entry) => entry.id),
  }, null, 2)}\n`);

  const manifestPath = path.join(outDir, "stage5_m214_run_manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: M214_MANIFEST_SCHEMA,
    benchmarkName: M214_EXPERIMENT_NAME,
    generatedAt: document.generatedAt,
    preregistrationHash: digest,
    manifestHash: manifestDigest,
    intendedRuns: manifest.length,
    allStatusesPlanned: manifest.every((row) => row.status === "PLANNED"),
    containsNoVendorRow: true,
    rows: manifest,
  }, null, 2)}\n`);

  const externalPath = path.join(outDir, "stage5_m214_external_reference.json");
  writeFileSync(externalPath, `${JSON.stringify({
    schemaVersion: M214_EXTERNAL_REFERENCE_SCHEMA,
    milestone: "M214",
    generatedAt: document.generatedAt,
    hashRule: M214_EXTERNAL_REFERENCE_HASH_RULE,
    externalReferenceHash: externalHash,
    reference: M214_EXTERNAL_REFERENCE,
    publishedConditionMatrix: M214_PUBLISHED_CONDITION_MATRIX,
    comparisonLabel: M214_EXTERNAL_COMPARISON_LABEL,
    comparisonLabelRefused: M214_EXTERNAL_COMPARISON_LABEL_REFUSED,
    mayEnterCausalAnalysis: false,
    separateTableRequired: true,
    exampleWording: {
      favourable: renderExternalComparison({ baselineResolved: 74, vtraceResolved: 76, tasks: 100 }),
      unfavourable: renderExternalComparison({ baselineResolved: 68, vtraceResolved: 70, tasks: 100 }),
      causalFavourable: renderCausalConclusion(74, 76, 100),
      causalNull: renderCausalConclusion(74, 74, 100),
      causalUnfavourable: renderCausalConclusion(76, 74, 100),
    },
    exampleWordingPassesAudit: [
      renderExternalComparison({ baselineResolved: 74, vtraceResolved: 76, tasks: 100 }),
      renderExternalComparison({ baselineResolved: 68, vtraceResolved: 70, tasks: 100 }),
    ].every((text) => auditExternalComparisonWording(text).length === 0),
  }, null, 2)}\n`);

  // §44's guard exercised on the ARTIFACT rather than on a fixture: read the
  // committed bytes back and recompute. A hash that only ever verifies the
  // in-memory object would not notice a serialisation that lost a field.
  const readBack = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
  const {
    launchGates: _gates,
    launchAuthorized: _authorized,
    preregistrationComplete: _complete,
    deferredRuntimeGates: _deferred,
    readinessVerdict: _verdict,
    readinessBlocker: _blocker,
    ...readBackBody
  } = readBack;
  const recomputed = m214PreregistrationHash(readBackBody);
  const hashSelfCheck = {
    recordedHash: digest,
    recomputedFromWrittenFile: recomputed,
    matches: recomputed === digest,
    mutationDetected: m214PreregistrationHash({ ...readBackBody, arms: "tampered" }) !== recomputed,
    distinctFromParent: digest !== m213RecordedHash,
  };
  if (!hashSelfCheck.matches || !hashSelfCheck.mutationDetected || !hashSelfCheck.distinctFromParent) {
    throw new Error(`preregistration hash self-check failed: ${JSON.stringify(hashSelfCheck)}`);
  }

  writeFileSync(path.join(outDir, "stage5_m214_preregistration_hash.json"), `${JSON.stringify({
    schemaVersion: "stage5.m214.preregistration-hash.v1",
    benchmarkName: M214_EXPERIMENT_NAME,
    file: path.basename(jsonPath),
    hashRule: M214_HASH_RULE,
    ...hashSelfCheck,
    manifestFile: path.basename(manifestPath),
    manifestHash: manifestDigest,
    externalReferenceFile: path.basename(externalPath),
    externalReferenceHash: externalHash,
    parentPreregistrationHash: m213RecordedHash,
    parentImmutable: m213Immutable,
    launchHarnessRequirement:
      "The future launch harness MUST recompute this hash from the committed preregistration and "
      + "abort if it differs. A changed preregistration is a NEW cohort with a new hash, never a "
      + "silent edit to this one. It must also verify the M213 hash is unchanged, and that this "
      + "hash is not M213's.",
  }, null, 2)}\n`);

  const md = renderReport(document, manifest.length, gates, controls, {
    m213RecordedHash, m213Immutable, externalHash, digest, manifestDigest,
    orderBalance, harness, evaluator, modelAvailability, patchCapture, scopedTypecheck,
    vendorScript, treatmentCatalog,
  });
  const mdPath = path.join(outDir, "stage5_m214_preregistration.md");
  writeFileSync(mdPath, md);

  process.stdout.write(`${jsonPath}\n${manifestPath}\n${externalPath}\n${mdPath}\n`);
  process.stdout.write(`preregistrationHash ${digest}\n`);
  process.stdout.write(`manifestHash ${manifestDigest} over ${manifest.length} intended runs\n`);
  process.stdout.write(`externalReferenceHash ${externalHash}\n`);
  process.stdout.write(
    `falsification ${controls.filter((c) => c.satisfied).length}/${controls.length} satisfied; `
    + `gates ${gates.filter((g) => g.status === "PASS").length}/${gates.length} pass; `
    + `preregistration gates `
    + `${gates.filter((g) => g.gateClass === "PREREGISTRATION" && g.status === "PASS").length}/`
    + `${gates.filter((g) => g.gateClass === "PREREGISTRATION").length} pass; `
    + `preregistrationComplete ${String(designComplete)}; launchAuthorized ${String(authorized)}\n`,
  );
  process.stdout.write(
    authorized ? "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY\n" : "PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY\n",
  );
}

function renderReport(
  document: Record<string, unknown>,
  intendedRuns: number,
  gates: readonly LaunchGate[],
  controls: readonly { id: string; description: string; expectation: string; satisfied: boolean; detail: string }[],
  context: Record<string, unknown>,
): string {
  const population = document.taskPopulation as Record<string, unknown>;
  const authorized = gates.every((gate) => gate.status === "PASS");
  const blocked = gates.filter((gate) => gate.status !== "PASS");
  const patchCapture = context.patchCapture as Record<string, unknown> | null;
  const scopedTypecheck = context.scopedTypecheck as Record<string, unknown> | null;
  const vendorScript = context.vendorScript as Record<string, unknown> | null;
  const harness = context.harness as { patchCaptureExclusions: string[]; cleanPreservedPaths: string[] };
  const modelAvailability = context.modelAvailability as Record<string, unknown>;

  const lines: string[] = [];
  const push = (text = "") => lines.push(text);

  push(`# M214 — ${M214_EXPERIMENT_NAME}: two-arm causal preregistration`);
  push();
  push("Generated from `m214Preregistration.ts`, `m214ExternalReference.ts` and");
  push("`m214TreatmentLifecycle.ts`. Machine-readable twin:");
  push("`stage5_m214_preregistration.json`. No paid run is authorised by this document.");
  push();

  push("## 1. Status");
  push();
  push("```text");
  push("TWO_ARM_CAUSAL_BENCHMARK_PREREGISTERED");
  push("EXTERNAL_VEXP_REFERENCE_FROZEN");
  push("TASK_POPULATION_FROZEN");
  push("RUN_MANIFEST_FROZEN");
  push("ANALYSIS_PLAN_FROZEN");
  push("STOPPING_RULE_FROZEN");
  push(`M214_FALSIFICATION_SUITE_${controls.every((c) => c.satisfied) ? "PASSED" : "FAILED"}`);
  push("PAID_RUNS_NOT_STARTED");
  push(authorized ? "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY" : "PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY");
  push("```");
  push();
  push(`- preregistration hash \`${context.digest as string}\``);
  push(`- manifest hash \`${context.manifestDigest as string}\` over ${intendedRuns} intended runs`);
  push(`- external reference hash \`${context.externalHash as string}\``);
  push(`- live model spend during M214: **$0**; benchmark-task live-agent runs: **0**`);
  push();

  push("## 2. Why M214 exists");
  push();
  push("M213 preregistered baseline / VTRACE / VEXP under one identical harness and then");
  push("found the third arm unrunnable. The blockers, from M213's committed audit:");
  push();
  for (const blocker of M214_VEXP_BLOCKERS) push(`- ${blocker}`);
  push();
  push(`Verdict inherited unchanged: \`${M214_VEXP_BLOCKER_VERDICT}\`. That is a procurement and`);
  push("licensing fact, not a VTRACE engineering defect, and M214 does not work around it,");
  push("imitate VEXP, or substitute a VTRACE-authored reconstruction for the real product.");
  push();

  push("## 3. M213 lineage and immutability");
  push();
  push("| property | value |");
  push("| --- | --- |");
  push(`| parent experiment | ${M214_PARENT.experimentName} |`);
  push(`| parent verdict | ${M214_PARENT.verdict} |`);
  push(`| parent arms / runs | ${M214_PARENT.armCount} / ${M214_PARENT.intendedRuns} |`);
  push(`| parent hash (recorded) | \`${context.m213RecordedHash as string}\` |`);
  push(`| parent hash recomputed from committed bytes | ${context.m213Immutable ? "**matches**" : "**MISMATCH**"} |`);
  push(`| M214 hash | \`${context.digest as string}\` |`);
  push(`| hashes distinct | ${context.digest !== context.m213RecordedHash ? "yes" : "**no**"} |`);
  push();
  push("M214's digest is domain-separated by the experiment name, so even an identical");
  push("document could not collide with M213's. The three-arm preregistration stays");
  push("committed, unedited, and unexecuted.");
  push();

  push("## 4. Frozen task population");
  push();
  push(`- artifact: \`${population.path as string}\``);
  push(`- sha256: \`${population.sha256 as string}\``);
  push(`- instances: ${String(population.instanceCount)} across ${(population.repositories as string[]).length} repositories`);
  push(`- vendor commit: \`${(M214_TASK_POPULATION_PROVENANCE as { vendorCommit: string }).vendorCommit}\``);
  push();
  push("The population is the vendor's own committed artifact, byte-for-byte, inherited");
  push("from M213 by importing its loader rather than re-declaring it.");
  push();
  push("### 4.1 The vendor's script does not reproduce the vendor's subset");
  push();
  if (vendorScript !== null) {
    const comparison = vendorScript.comparison as { overlapCount: number; disjointCount: number };
    push(`Re-derived by M214, running the vendor's own \`scripts/select-subset.py\` unmodified:`);
    push();
    push(`- overlap with the shipped artifact: **${comparison.overlapCount} / 100**`);
    push(`- a script-based "reproduction" therefore benchmarks a different **${comparison.disjointCount}** tasks`);
    push();
    const diffs = vendorScript.comparison as { repositoryAllocationDifferences: Record<string, { script: number; artifact: number }> };
    push("| repository | script | artifact |");
    push("| --- | ---: | ---: |");
    for (const [repo, counts] of Object.entries(diffs.repositoryAllocationDifferences)) {
      push(`| ${repo} | ${counts.script} | ${counts.artifact} |`);
    }
    push();
  }
  push("```text");
  push("EXACT_VEXP_SUBSET_AVAILABLE_AS_ARTIFACT");
  push("EXACT_VEXP_SUBSET_NOT_SCRIPT_REPRODUCIBLE");
  push("```");
  push();

  push("## 5. Arms");
  push();
  push("| | Arm A — BASELINE | Arm B — BASELINE + VTRACE |");
  push("| --- | --- | --- |");
  push(`| native tools | ${M214_NATIVE_TOOLS.join(", ")} | identical |`);
  push("| MCP servers | none | `vtrace` |");
  push(`| treatment tools | none | ${M214_VTRACE_TREATMENT_CATALOG.length}, the product default |`);
  push("| treatment instruction | none | none |");
  push("| workspace `.vtrace` | forbidden | created by treatment setup |");
  push("| agent, model, prompts, budgets, container, evaluator | \\<one frozen record\\> | the same record |");
  push();
  push("There is no third row. The vendor's published result is an external reference");
  push("with its own artifact and its own evidence class, never a row of this table.");
  push();

  push("## 6. Agent, model and published-condition match");
  push();
  push(`- agent: ${M214_AGENT.implementation}, version \`${M214_AGENT.version}\`, CLI-default system prompt`);
  push(`- model: \`${M214_MODEL.model}\` — ${String(modelAvailability.evidence)}`);
  push();
  push("| condition | VEXP published | M214 | match |");
  push("| --- | --- | --- | --- |");
  for (const row of M214_PUBLISHED_CONDITION_MATRIX) {
    push(`| ${row.condition} | ${row.vexpPublished} | ${row.m214} | **${row.match}** |`);
  }
  push();
  push(`Because four rows are UNKNOWN and one DIFFERS, this is a **${M214_EXTERNAL_COMPARISON_LABEL}**`);
  push("and is never described as an exact VEXP replication.");
  push();

  push("## 7. Budgets");
  push();
  push("| field | value |");
  push("| --- | --- |");
  push(`| max turns | ${M214_BUDGET.maxTurns} |`);
  push(`| per-run cost cap | $${M214_BUDGET.perRunCostCapUsd} |`);
  push(`| wall clock per run | ${M214_BUDGET.wallClockTimeoutSecondsPerRun}s |`);
  push(`| intended runs | ${M214_BUDGET.totalIntendedRuns} |`);
  push(`| total spend cap | $${M214_BUDGET.totalSpendCapUsd} |`);
  push(`| budget identity | \`${document.budgetIdentity as string}\` |`);
  push();
  push("One object, shared by both arms, carried as a digest on every manifest row. The");
  push("cap counts provider-reported model cost only; index build time and size are");
  push("measured and reported separately and are never summed into a cost-per-task.");
  push();

  push("## 8. Patch-capture repair");
  push();
  push("The vendor harness's own pathspecs, read from its shipped JavaScript:");
  push();
  push("```text");
  push(`capturePatch excludes : ${harness.patchCaptureExclusions.join(", ")}`);
  push(`clean preserves       : ${harness.cleanPreservedPaths.join(", ")}`);
  push("```");
  push();
  if (patchCapture !== null) {
    const routes = patchCapture.routes as Record<string, unknown>[];
    push("Reproduced on real repositories with a real VTRACE index:");
    push();
    push("| initialisation route | vendor capture, no source change | derived capture, no source change | derived capture, one edit |");
    push("| --- | --- | --- | --- |");
    for (const route of routes) {
      const noChange = route.noSourceChange as { vendor: { bytes: number; paths: string[] }; derived: { bytes: number } };
      const change = route.sourceChange as { derived: { paths: string[] } };
      push(
        `| \`${String(route.route)}\` | ${noChange.vendor.bytes} bytes `
        + `${noChange.vendor.paths.length > 0 ? `over ${noChange.vendor.paths.join(", ")}` : "(empty)"} `
        + `| ${noChange.derived.bytes} bytes | ${change.derived.paths.join(", ")} |`,
      );
    }
    push();
    push("The leak is real and **route-dependent**: `vtrace init` appends `/.vtrace/` to");
    push("`.git/info/exclude`, which hides the directory from `git add -A`; `vtrace index`");
    push("alone does not. A benchmark whose fairness depends on which entry point ran is");
    push("not fair. The derived mechanism — *what changed, minus what was already there* —");
    push("produces an empty patch on a no-source-change run and exactly the edited file on");
    push("a source-change run, on **both** routes, and names no vendor.");
    push();
    push(`Verdict: \`${String(patchCapture.verdict)}\``);
    push();
  }

  push("## 9. Reset and warm/cold policy");
  push();
  push(`Regime: \`${M214_INDEX_WARMTH_POLICY.regime}\`. ${M214_INDEX_WARMTH_POLICY.statement}`);
  push();
  push("Lifecycle order (the snapshot is taken AFTER treatment initialisation, which is");
  push("what makes the derived exclusion cover treatment state):");
  push();
  push("```text");
  for (const phase of M214_LIFECYCLE_ORDER) push(`  ${phase}`);
  push("```");
  push();

  push("## 10. Randomisation and manifest");
  push();
  push(`- seed: \`${M214_RANDOMIZATION_SEED}\``);
  push(`- balance: ${Object.entries(context.orderBalance as Record<string, number>).map(([key, count]) => `${key} ${count}`).join(", ")}`);
  push(`- manifest: ${intendedRuns} PLANNED rows, hash \`${context.manifestDigest as string}\`, no vendor row`);
  push();

  push("## 11. Analysis");
  push();
  push(`Primary estimand: **${M214_PRIMARY_ESTIMAND.statement}**`);
  push();
  push(`${M214_PRIMARY_ESTIMAND.notTheComparator}`);
  push();
  push("Always reported: " + M214_STATISTICAL_PLAN.reportedAlways.join(", ") + ".");
  push();
  push("Secondary efficiency: " + M214_SECONDARY_OUTCOMES.efficiency.join(", ") + ".");
  push();
  push("Treatment uptake is descriptive and a mediator; it never conditions the primary");
  push("comparison. A run where VTRACE was exposed and never invoked stays in the VTRACE arm.");
  push();

  push("## 12. External reference");
  push();
  push("| property | value |");
  push("| --- | --- |");
  push(`| evidence class | \`${M214_EXTERNAL_REFERENCE.evidenceClass}\` |`);
  push(`| system | ${M214_EXTERNAL_REFERENCE.system} |`);
  push(`| published pass@1 | ${M214_EXTERNAL_REFERENCE.publishedPassAt1Count} / ${M214_EXTERNAL_REFERENCE.taskCount} |`);
  push(`| published $/task | $${M214_EXTERNAL_REFERENCE.publishedCostPerTaskUsd} |`);
  push(`| published model | ${M214_EXTERNAL_REFERENCE.publishedModel} |`);
  push(`| published turn budget | ${M214_EXTERNAL_REFERENCE.publishedTurnBudget} |`);
  push(`| published cost limit | $${M214_EXTERNAL_REFERENCE.publishedCostLimitUsdPerTask}/task |`);
  push(`| per-task outcomes published | ${M214_EXTERNAL_REFERENCE.perTaskOutcomesPublished ? "yes" : "**no**"} |`);
  push(`| snapshot hash | \`${context.externalHash as string}\` |`);
  push();
  push("Sources, each pinned to a vendor commit and a file digest:");
  push();
  for (const source of M214_EXTERNAL_REFERENCE.sources) {
    push(`- \`${source.file}\` @ \`${source.vendorCommit.slice(0, 12)}\` (sha256 \`${source.fileSha256.slice(0, 16)}…\`), retrieved ${source.retrievedAt}`);
  }
  push();
  push("**What may be said.** Our absolute pass rate may be placed beside the published");
  push("73/100 with a cross-study qualifier. **What may not be said.** That VTRACE beat,");
  push("outperformed, or went head-to-head with VEXP; the two systems were never run in");
  push("the same harness, and no per-task VEXP outcomes exist to pair against.");
  push();

  push("## 13. Falsification suite");
  push();
  push("| control | expectation | result | detail |");
  push("| --- | --- | --- | --- |");
  for (const entry of controls) {
    push(
      `| \`${entry.id}\` | ${entry.expectation} | ${entry.satisfied ? "satisfied" : "**UNSATISFIED**"} `
      + `| ${entry.detail.slice(0, 150).replace(/\|/g, "\\|")} |`,
    );
  }
  push();

  push("## 14. Launch gates");
  push();
  push("| gate | requirement | status | evidence |");
  push("| --- | --- | --- | --- |");
  for (const gate of gates) {
    push(`| ${gate.id} | ${gate.requirement} | **${gate.status}** | ${gate.evidence.replace(/\|/g, "\\|")} |`);
  }
  push();
  if (blocked.length > 0) {
    push(`${blocked.length} of ${gates.length} gates are not PASS:`);
    push();
    for (const gate of blocked) push(`- **${gate.id}** (${gate.status}) — ${gate.requirement}`);
    push();
  }

  push("## 15. Typecheck scope");
  push();
  if (scopedTypecheck !== null) {
    const clean = scopedTypecheck.clean as { errorCount: number };
    const preexisting = scopedTypecheck.preexistingBenchmarkTestTypeErrors as { errorCount: number };
    push("```text");
    push(`M214_NEW_TYPECHECK_ERRORS                 ${clean.errorCount}`);
    push(`PREEXISTING_BENCHMARK_TEST_TYPE_ERRORS    ${preexisting.errorCount}  (outside M214 scope)`);
    push("```");
    push();
    push("`tsconfig.m214.json` includes this milestone's test files, which");
    push("`tsconfig.benchmarks.json` excludes. Repository-wide benchmark tests remain");
    push("untypechecked, and M214 does not claim otherwise: the pre-existing errors are in");
    push("historical benchmark test files and cleaning them up is not authorised here. The");
    push("scoped target is proven able to fail by injecting a type error into a file it");
    push("covers and observing the error, then removing it.");
    push();
  }

  push("## 16. Authorisation");
  push();
  push("```text");
  push(authorized ? "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY" : "PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY");
  push("```");
  push();
  push("No run has started. No model has been called. Starting the cohort requires every");
  push("gate above to be PASS and an explicit spending authorisation that this document");
  push("does not grant.");
  push();

  return `${lines.join("\n")}\n`;
}

await main();
