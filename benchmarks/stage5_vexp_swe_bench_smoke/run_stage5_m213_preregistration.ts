/**
 * M213 — generate the preregistration, the run manifest, the falsification
 * results, the harness audit and the launch-gate table.
 *
 * ONE authority (`m213Preregistration.ts`), rendered twice: a machine-readable
 * JSON document and a human-readable Markdown report, both produced here so
 * they cannot drift apart (§37).
 *
 * This script calls no model, starts no agent, runs no benchmark task and
 * touches no product code. It reads the frozen task population, reads the
 * benchmark harness's own JavaScript to audit it, and computes.
 *
 * Usage:
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m213_preregistration.ts [--out <dir>]
 */

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  M213_AGENT,
  M213_ARMS,
  M213_ARM_ORDERS,
  M213_BUDGET,
  M213_COMPARISON_STRUCTURE,
  M213_EXCLUSIONS,
  M213_EXPERIMENT_NAME,
  M213_HASH_RULE,
  M213_HISTORICAL_POLICY,
  M213_MANIFEST_SCHEMA,
  M213_MODEL,
  M213_NATIVE_TOOLS,
  M213_NO_TUNING_POLICY,
  M213_PREREGISTRATION_SCHEMA,
  M213_PRIMARY_OUTCOME,
  M213_RANDOMIZATION_SEED,
  M213_REPORTING_DISCIPLINE,
  M213_SECONDARY_OUTCOMES,
  M213_STATISTICAL_PLAN,
  M213_STOPPING_RULE,
  M213_SUBSTRATE,
  M213_TASK_POPULATION_PROVENANCE,
  M213_TREATMENT_VALIDITY,
  VEXP_DEFAULT_TOOL_CATALOG_3_1_1,
  VTRACE_DEFAULT_TOOL_CATALOG,
  armDefinition,
  assignArmOrders,
  buildRunManifest,
  evaluateLaunchGates,
  launchAuthorized,
  loadFrozenTaskPopulation,
  manifestHash,
  preregistrationHash,
  verifyPopulation,
} from "./m213Preregistration";
import { runFalsificationSuite, suitePasses } from "./m213Falsification";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(import.meta.dir, "..", "..");
const DEFAULT_OUT = path.join(import.meta.dir, "results");
const VEXP_HARNESS_REPO_JS = "/home/calvin/code/vexp-swe-bench/dist/harness/repo.js";

async function git(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", [...args], { cwd: VTRACE_ROOT, timeout: 60_000 });
    return stdout.trim();
  } catch { return ""; }
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
  readonly repositoryReuse: string;
} {
  if (!existsSync(VEXP_HARNESS_REPO_JS)) {
    return {
      file: VEXP_HARNESS_REPO_JS, readable: false,
      patchCaptureExclusions: [], cleanPreservedPaths: [],
      repositoryReuse: "unknown",
    };
  }
  const source = readFileSync(VEXP_HARNESS_REPO_JS, "utf8");

  const captureBody = /export async function capturePatch[\s\S]{0,1200}?\n\}/.exec(source)?.[0] ?? "";
  const patchCaptureExclusions = [...captureBody.matchAll(/:\(exclude\)([^"']+)/g)]
    .map((match) => match[1]!.trim()).sort();

  const cleanPreservedPaths = [...new Set(
    [...source.matchAll(/"clean",\s*"-fdx",([\s\S]{0,240}?)\]/g)]
      .flatMap((match) => [...match[1]!.matchAll(/"-e",\s*"([^"]+)"/g)].map((entry) => entry[1]!)),
  )].sort();

  const repositoryReuse = /BENCH_REPOS_DIR = join\(process\.cwd\(\), "\.bench-repos"\)/.test(source)
    ? "ONE working tree per repository slug under .bench-repos, reused across every task of that "
      + "repository — 44 django tasks share one directory"
    : "unknown";

  return {
    file: VEXP_HARNESS_REPO_JS, readable: true,
    patchCaptureExclusions, cleanPreservedPaths, repositoryReuse,
  };
}

const SWEBENCH_VENV_PYTHON = "/home/calvin/code/vexp-swe-bench/.venv/bin/python";

/** The official evaluator, verified present at the pinned version (§18, G14). */
async function auditEvaluator(): Promise<{
  readonly interpreter: string;
  readonly available: boolean;
  readonly version: string | null;
  readonly expectedVersion: string;
  readonly matchesExpected: boolean;
  readonly integrityAudit: string;
}> {
  const expectedVersion = "4.1.0";
  let version: string | null = null;
  try {
    const { stdout } = await execFile(SWEBENCH_VENV_PYTHON, [
      "-c", "import importlib.metadata as m; print(m.version('swebench'))",
    ], { timeout: 120_000 });
    version = stdout.trim();
  } catch { version = null; }
  return {
    interpreter: SWEBENCH_VENV_PYTHON,
    available: version !== null,
    version,
    expectedVersion,
    matchesExpected: version === expectedVersion,
    integrityAudit:
      "M192 hashed seven load-bearing swebench harness files against the wheel and found 0 modified; "
      + "that audit is inherited, not repeated here.",
  };
}

function readJsonIfPresent(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return null; }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--out");
  const outDir = at >= 0 && argv[at + 1] !== undefined ? String(argv[at + 1]) : DEFAULT_OUT;
  mkdirSync(outDir, { recursive: true });

  const population = loadFrozenTaskPopulation();
  const verification = verifyPopulation(population);
  const rows = readFileSync(population.path, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { instance_id: string; repo: string; base_commit: string });

  const vtraceCommit = await git(["rev-parse", "HEAD"]);
  const vtraceTracked = await git(["status", "--porcelain", "--untracked-files=no"]);

  const vtraceExec = readJsonIfPresent(path.join(outDir, "stage5_m213_vtrace_executability.json"));
  const vexpExec = readJsonIfPresent(path.join(outDir, "stage5_m213_vexp_executability.json"));
  const harness = auditBenchmarkHarness();
  const evaluator = await auditEvaluator();

  const vexpVersion = (vexpExec?.newestBundleRead as string | null) ?? null;
  const manifest = buildRunManifest({
    population, rows,
    agentVersion: M213_AGENT.version,
    model: M213_MODEL.model,
    vtraceCommit,
    vexpVersion,
  });
  const manifestDigest = manifestHash(manifest);
  const orders = assignArmOrders(population.instanceIds);

  const controls = runFalsificationSuite({
    frozenInstanceIds: population.instanceIds,
    manifest,
    expectedOrders: orders,
    seed: M213_RANDOMIZATION_SEED,
    preregistrationDocument: { placeholder: "hashed below" },
    preregistrationHashRecorded: preregistrationHash({ placeholder: "hashed below" }),
    manifestHashRecorded: manifestDigest,
    legitimateExclusionCategories: M213_EXCLUSIONS.legitimate,
    vtraceCommit,
    vexpVersion,
    observedPatchCaptureExclusions: harness.patchCaptureExclusions,
    observedCleanPreservedPaths: harness.cleanPreservedPaths,
  });
  const controlsPass = suitePasses(controls);

  const gates = evaluateLaunchGates({
    preregistrationCommitted: true,
    preregistrationHashRecorded: true,
    populationVerified: verification.verified,
    manifestRowCount: manifest.length,
    vtraceExecutable: vtraceExec?.allProven === true && vtraceExec.observationalIndexing === true,
    vexpExecutable: vexpExec?.verdict === "VEXP_TREATMENT_EXECUTABLE",
    baselineContaminationGuardPasses: controls.filter((c) => c.id === "F1").every((c) => c.satisfied),
    treatmentContaminationGuardsPass: controls.filter((c) => c.id === "F2" || c.id === "F3")
      .every((c) => c.satisfied),
    // Derived, not asserted: one frozen agent record, one agent version across
    // every manifest row, and no arm carrying a treatment-specific instruction.
    identicalAgentVerified:
      new Set(manifest.map((row) => row.agentVersion)).size === 1
      && manifest.every((row) => row.agentVersion === M213_AGENT.version)
      && M213_ARMS.every((arm) => armDefinition(arm).treatmentInstruction === null),
    identicalModelVerified:
      new Set(manifest.map((row) => row.model)).size === 1
      && manifest.every((row) => row.model === M213_MODEL.model),
    identicalBudgetsVerified: new Set(manifest.map((row) =>
      `${row.maxTurns}:${row.perRunCostCapUsd}`)).size === 1,
    identicalNativeToolsVerified: M213_ARMS.every((arm) =>
      armDefinition(arm).nativeTools.join(",") === M213_NATIVE_TOOLS.join(",")),
    repositoryStateEquivalenceVerified: vtraceExec?.observationalIndexing === true,
    evaluatorValidated: evaluator.available && evaluator.matchesExpected,
    exclusionRulesFrozen:
      M213_EXCLUSIONS.legitimate.length > 0
      && M213_EXCLUSIONS.neverExclusions.length > 0
      && M213_EXCLUSIONS.frozenBeforeAnyPaidRun,
    statisticalPlanFrozen:
      M213_STATISTICAL_PLAN.reportedPerComparison.length >= 8
      && M213_COMPARISON_STRUCTURE.primary.length > 0,
    stoppingRuleFrozen:
      M213_STOPPING_RULE.design === "FIXED_N" && M213_STOPPING_RULE.intendedRuns === manifest.length,
    randomizationFrozen:
      new Set(manifest.map((row) => row.seed)).size === 1
      && manifest.every((row) => row.seed === M213_RANDOMIZATION_SEED)
      && manifest.every((row) => row.armOrder[row.armOrderIndex] === row.arm),
    falsificationControlsPass: controlsPass,
    noOutcomeBearingRunHasOccurred: true,
    // Both are BLOCKED, not FAIL: the adopted substrate's mechanism is correct
    // by construction, but the ordering guarantee belongs to a launch harness
    // that does not exist yet, and VEXP's out-of-workspace state cannot be shown
    // cold while the VEXP arm is not executable at all.
    treatmentStatePatchNeutrality: "BLOCKED",
    warmColdIndexSymmetry: "BLOCKED",
    vendorHarnessPatchCaptureIsSymmetric:
      harness.readable && harness.patchCaptureExclusions.includes(".vtrace"),
    vendorHarnessIndexWarmthIsSymmetric:
      harness.readable
      && harness.cleanPreservedPaths.includes(".vtrace") === harness.cleanPreservedPaths.includes(".vexp"),
  });

  const document: Record<string, unknown> = {
    schemaVersion: M213_PREREGISTRATION_SCHEMA,
    milestone: "M213",
    benchmarkName: M213_EXPERIMENT_NAME,
    generatedAt: new Date().toISOString(),
    frozenBeforeAnyPaidRun: true,
    liveModelSpendDuringM213Usd: 0,
    benchmarkTaskLiveAgentRuns: 0,
    authorityNote:
      "A frozen design is a precondition for a paid run, not permission to start one. No paid run is "
      + "authorised by the existence of this document; the launch gates below decide that, and one of "
      + "them does not pass.",
    repositoryState: {
      vtraceCommit,
      trackedWorkingTreeClean: vtraceTracked.length === 0,
      note: "Untracked benchmark output is ignored by design; only tracked state is asserted clean.",
    },

    researchQuestions: {
      RQ1: "Does VTRACE causally improve task resolution relative to baseline? H1: P(resolve|VTRACE) != P(resolve|baseline), two-sided.",
      RQ2: "Does VEXP causally improve task resolution relative to the same baseline? H2: P(resolve|VEXP) != P(resolve|baseline), two-sided.",
      RQ3: "Under identical conditions, which treatment produces the larger causal delta from baseline?",
      RQ4: "Does either treatment reduce input, output or total tokens, or model cost, holding resolution approximately constant?",
      RQ5: "How do treatments alter native search usage, file reads, symbol lookup, turn count, files inspected and files edited?",
      RQ6: "How often is the treatment actually consumed — exposed, invoked, invoked before the first edit?",
      directionality:
        "Every hypothesis is two-sided. M183 observed exact resolution parity, so a one-sided "
        + "favourable claim is not historically justified and is not preregistered.",
    },

    taskPopulation: {
      selectionOption: "Option 1 — the exact VEXP subset, taken as the vendor's own committed artifact",
      path: population.path,
      sha256: population.sha256,
      provenance: M213_TASK_POPULATION_PROVENANCE,
      instanceCount: population.instanceIds.length,
      repositories: population.repositories,
      countsByRepository: population.countsByRepository,
      complexityMedian: population.complexityMedian,
      complexityCeiling: population.complexityCeiling,
      verification,
      instanceIds: population.instanceIds,
      reproducibilityFinding: {
        exactSubsetAvailable: true,
        reproducibleFromVendorScript: false,
        statement:
          "The vendor's shipped scripts/select-subset.py does NOT reproduce their shipped "
          + "data/swe-bench-100.jsonl. Run against SWE-bench Verified (500) in natural parquet order it "
          + "selects a set overlapping the shipped subset in 22 of 100 instances; in instance-id order, "
          + "also 22; with the documented complexity<=250 filter applied first, 26. Its repository "
          + "allocation differs materially too (django 42 vs 44, sympy 14 vs 17, scikit-learn 6 vs 2). "
          + "The script also omits the <=250 filter its own documentation describes as step 1.",
        consequence:
          "The ARTIFACT is authoritative and is what M213 freezes; the script is not. Anyone "
          + "'reproducing' VEXP's subset from the published script would benchmark a different 100 "
          + "tasks and could not legitimately compare against VEXP's published number.",
        artifactMatchesPublishedProperties:
          "All twelve repositories present, the per-repository table matches docs/TASK_SELECTION.md "
          + "exactly, median complexity is 22 as published, and the maximum is 247, inside the "
          + "documented <=250 ceiling. 6 of the full 500 exceed 250 (1.2%), matching the published '~1%'.",
      },
    },

    arms: M213_ARMS.map((arm) => armDefinition(arm)),
    armCount: 3,
    treatmentSurfaces: {
      vtrace: {
        catalog: VTRACE_DEFAULT_TOOL_CATALOG,
        catalogSize: VTRACE_DEFAULT_TOOL_CATALOG.length,
        source: "src/mcp/tools.ts defaultMcpToolRegistry.listMetadata(), read at runtime",
        howStarted: "vtrace mcp-serve --repo <workspace>, with NO --tools flag",
        rationale:
          "The product default. Seven further tools (search_symbols, build_capsule, build_handoff, "
          + "route_query, list_runs, list_sessions, read_session) are registered but hidden from "
          + "tools/list and are NOT exposed: the arm is the product we would genuinely offer an agent, "
          + "not every research tool that exists.",
      },
      vexp: {
        catalog: VEXP_DEFAULT_TOOL_CATALOG_3_1_1,
        catalogSize: VEXP_DEFAULT_TOOL_CATALOG_3_1_1.length,
        source: "vexp-cli 3.1.1 mcp/mcp-server.cjs, read statically via M212's extractor",
        rationale:
          "VEXP's ACTUAL default agent-facing surface. get_impact_graph is NOT in it and is not added: "
          + "M212 established that measuring VTRACE against a VEXP surface VEXP's own agents are never "
          + "shown produces a VTRACE-authored proxy, not a measurement of the competitor.",
      },
      asymmetryIsDeliberate:
        "Fourteen tools versus three is a real difference between the two products and is preserved. "
        + "Normalising the catalogues would replace both treatments with a construct neither vendor "
        + "ships. The cost of a larger catalogue — M166 measured tool schemas as model-visible and "
        + "billed every turn — is part of what the experiment measures, not a confound to remove.",
    },

    agent: M213_AGENT,
    model: M213_MODEL,
    nativeTools: {
      set: M213_NATIVE_TOOLS,
      identicalAcrossArms: true,
      rationale:
        "vexp-swe-bench's DEFAULT_ALLOWED_TOOLS, unchanged in every arm. M168-E measured that denying "
        + "Grep/Glob is itself a treatment that lost two tasks and won none. The question is whether "
        + "the treatment helps a competent native-search agent, not whether it can replace grep.",
    },
    budgets: M213_BUDGET,

    substrate: {
      ...M213_SUBSTRATE,
      imageNamespace: "swebench",
      instanceImageTag: "latest",
      checkoutRoot: "/testbed",
      whyNotTheVendorHarnessWorkingTrees:
        "vexp-swe-bench keeps ONE working tree per repository slug under .bench-repos and reuses it "
        + "across every task of that repository. Per-instance containers give §14 repository-state "
        + "equality and §17 independence by construction instead of by discipline.",
      networkPolicy:
        "The agent has the container's own network posture, identical in all three arms. No arm "
        + "receives treatment-specific external knowledge.",
    },

    randomization: {
      seed: M213_RANDOMIZATION_SEED,
      method:
        "Instances are ranked by sha256(seed + instance_id) and the rank's residue modulo six selects "
        + "one of the six arm orders. Arbitrary with respect to repository, difficulty and every "
        + "historical outcome.",
      orders: M213_ARM_ORDERS,
      balance: (() => {
        const counts: Record<string, number> = {};
        for (const [, order] of orders) {
          const key = order.join(">");
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
      })(),
      balanceNote: "17/17/17/17/16/16 across the six orders; baseline is never systematically first.",
    },

    runManifest: {
      schemaVersion: M213_MANIFEST_SCHEMA,
      file: "stage5_m213_run_manifest.json",
      intendedRuns: manifest.length,
      manifestHash: manifestDigest,
      generatedBeforeAnyExecution: true,
    },

    primaryOutcome: M213_PRIMARY_OUTCOME,
    comparisonStructure: M213_COMPARISON_STRUCTURE,
    statisticalPlan: M213_STATISTICAL_PLAN,
    secondaryOutcomes: M213_SECONDARY_OUTCOMES,
    treatmentValidity: M213_TREATMENT_VALIDITY,
    exclusions: M213_EXCLUSIONS,
    stoppingRule: M213_STOPPING_RULE,
    noTuningPolicy: M213_NO_TUNING_POLICY,
    historicalComparisonPolicy: M213_HISTORICAL_POLICY,
    reportingDiscipline: M213_REPORTING_DISCIPLINE,

    failureTaxonomy: {
      purpose: "post-hoc description only; it never alters a primary outcome",
      categories: [
        "NEVER_FOUND_RELEVANT_CODE", "FOUND_CODE_WRONG_DIAGNOSIS", "CROSS_FILE_CONTRACT_FAILURE",
        "INCORRECT_PATCH", "TEST_OR_VALIDATION_FAILURE", "ENVIRONMENT_FAILURE",
        "BUDGET_EXHAUSTION", "NO_PATCH",
      ],
      rubricDiscipline:
        "Evidence-based classification with arm labels blinded where practical. M185 and M189 both "
        + "showed anecdotal stage labels supporting conclusions the data did not; a taxonomy count is "
        + "never evidence of treatment effectiveness on its own.",
    },

    patchQuality: {
      recorded: ["files changed", "lines added", "lines removed", "edit attempts", "test runs", "final patch size"],
      interpretation: "descriptive only; a smaller patch is not assumed to be a better one",
    },

    initializationAccounting: {
      recordedSeparatelyFromModelCost: true,
      fields: ["index build wall time", "index storage bytes", "indexing failures", "workspace setup time", "daemon startup time"],
      regimes: ["cold single-task", "warm reused repository"],
      mixingProhibited: "The two regimes are reported separately and never combined into one metric.",
      measuredColdIndexCost: vtraceExec === null ? null : {
        note: "from the M213 VTRACE executability dry run, one instance per repository",
        source: "stage5_m213_vtrace_executability.json",
      },
    },

    benchmarkHarnessAudit: {
      ...harness,
      findings: [
        {
          id: "H1",
          severity: "LAUNCH_BLOCKING",
          statement:
            "capturePatch stages `git add -A -- . :(exclude).vexp :(exclude).claude "
            + ":(exclude).bench-mcp-config.json`. It excludes the competitor's generated state and does "
            + "NOT exclude .vtrace. Reproduced directly: on a flask checkout where the agent changed "
            + "nothing, the captured patch contained .vtrace/index.meta.json, .vtrace/index.sqlite and "
            + ".vtrace/session.sqlite — 105,321 bytes of diff, 1,848 lines of VTRACE index metadata "
            + "including absolute host paths and indexer fingerprints.",
          consequence:
            "Every VTRACE-arm patch would be polluted, could fail to apply, and could exhaust the "
            + "capture's 10 MB buffer — producing PATCH_EXTRACTION_FAILURE exclusions concentrated in "
            + "one arm for a reason unrelated to utility.",
          requiredRemedy:
            "The exclusion must be symmetric: every treatment's generated state directory is excluded, "
            + "or none is. Enforced by control F21 and gate G21.",
        },
        {
          id: "H2",
          severity: "LAUNCH_BLOCKING",
          statement:
            "resetRepo and setupRepo run `git clean -fdx -e .vexp -e .claude -e .bench-mcp-config.json` "
            + "between tasks. .vexp survives; .vtrace would be deleted.",
          consequence:
            "The competitor's index is warm across all 44 django tasks while VTRACE pays a cold rebuild "
            + "on every one — a systematic latency and setup-cost advantage to one arm that §13's "
            + "cold/warm accounting would then report as a property of the products.",
          requiredRemedy:
            "Either regime is defensible; a mixed one is not. Enforced by control F22 and gate G22.",
        },
        {
          id: "H3",
          severity: "DESIGN_RELEVANT",
          statement: harness.repositoryReuse,
          consequence:
            "Shared working trees make three arms of the same task non-independent and prevent "
            + "concurrent execution within a repository.",
          requiredRemedy:
            "M213 adopts the M192 per-instance container substrate instead, which removes the hazard "
            + "structurally rather than by scheduling discipline.",
        },
      ],
      note:
        "These are findings about the BENCHMARK HARNESS, not about VEXP's product. They are recorded "
        + "because a preregistration that inherited them silently would have produced a "
        + "competitor-favouring result the analysis could not have detected.",
    },

    evaluator,

    executability: {
      vtrace: vtraceExec === null ? null : {
        verdict: vtraceExec.allProven === true ? "VTRACE_TREATMENT_EXECUTABLE" : "VTRACE_TREATMENT_NOT_EXECUTABLE",
        repositoriesProven: vtraceExec.repositoriesProven,
        repositoriesIntended: vtraceExec.repositoriesIntended,
        observationalIndexing: vtraceExec.observationalIndexing,
        pathsIndexingCreates: vtraceExec.pathsIndexingCreates,
        artifact: "stage5_m213_vtrace_executability.json",
      },
      vexp: vexpExec === null ? null : {
        verdict: vexpExec.verdict,
        blockers: vexpExec.blockers,
        artifact: "stage5_m213_vexp_executability.json",
      },
    },

    contaminationGuards: {
      baseline: armDefinition("baseline").forbiddenArtifacts,
      vtrace: armDefinition("vtrace").forbiddenArtifacts,
      vexp: armDefinition("vexp").forbiddenArtifacts,
      audited: [
        "system prompt", "initial user prompt", "tool schemas", "environment variables",
        "workspace root entries at agent start", "CLAUDE.md / AGENTS.md reachable from the workspace or its ancestors",
        "MCP configuration", "PATH", "daemon sockets", "generated context files",
      ],
      benchmarkNativeInstructionFiles:
        "Instruction files belonging to the benchmark repository at its base commit are the "
        + "benchmark's normal condition, are preserved identically in all three arms, and are recorded "
        + "separately from experimental injection so the two are never confused.",
    },

    falsification: {
      controls,
      controlCount: controls.length,
      allSatisfied: controlsPass,
      negativeControlIncluded: true,
      negativeControlNote:
        "F0_CLEAN_* and the GUARD_SILENT controls exist because a guard that rejects everything would "
        + "pass F1–F22 and be worthless.",
    },

    launchGates: gates,
    launchAuthorized: launchAuthorized(gates),

    preregistrationHashRule: M213_HASH_RULE,
  };

  document.preregistrationHash = preregistrationHash(document);

  const jsonPath = path.join(outDir, "stage5_m213_preregistration.json");
  writeFileSync(jsonPath, `${JSON.stringify(document, null, 2)}\n`);

  const manifestPath = path.join(outDir, "stage5_m213_run_manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: M213_MANIFEST_SCHEMA,
    benchmarkName: M213_EXPERIMENT_NAME,
    generatedAt: document.generatedAt,
    preregistrationHash: document.preregistrationHash,
    manifestHash: manifestDigest,
    intendedRuns: manifest.length,
    allStatusesPlanned: manifest.every((row) => row.status === "PLANNED"),
    rows: manifest,
  }, null, 2)}\n`);

  // §38's guard exercised on the ARTIFACT rather than on a fixture: read the
  // committed bytes back and recompute. A hash that only ever verifies the
  // in-memory object would not notice a serialisation that lost a field.
  const readBack = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
  const recomputed = preregistrationHash(readBack);
  const hashSelfCheck = {
    recordedHash: String(document.preregistrationHash),
    recomputedFromWrittenFile: recomputed,
    matches: recomputed === document.preregistrationHash,
    mutationDetected: preregistrationHash({ ...readBack, arms: "tampered" }) !== recomputed,
  };
  if (!hashSelfCheck.matches || !hashSelfCheck.mutationDetected) {
    throw new Error(`preregistration hash self-check failed: ${JSON.stringify(hashSelfCheck)}`);
  }
  writeFileSync(
    path.join(outDir, "stage5_m213_preregistration_hash.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m213.preregistration-hash.v1",
      benchmarkName: M213_EXPERIMENT_NAME,
      file: path.basename(jsonPath),
      hashRule: M213_HASH_RULE,
      ...hashSelfCheck,
      manifestFile: path.basename(manifestPath),
      manifestHash: manifestDigest,
      launchHarnessRequirement:
        "The future launch harness MUST recompute this hash from the committed preregistration and "
        + "abort if it differs. A changed preregistration is a NEW cohort with a new hash, never a "
        + "silent edit to this one.",
    }, null, 2)}\n`,
  );

  const md = renderReport(document, manifest.length, gates, controls);
  const mdPath = path.join(outDir, "stage5_m213_preregistration.md");
  writeFileSync(mdPath, md);

  process.stdout.write(`${jsonPath}\n${manifestPath}\n${mdPath}\n`);
  process.stdout.write(`preregistrationHash ${String(document.preregistrationHash)}\n`);
  process.stdout.write(`manifestHash ${manifestDigest} over ${manifest.length} intended runs\n`);
  process.stdout.write(
    `falsification ${controls.filter((c) => c.satisfied).length}/${controls.length} satisfied; `
    + `gates ${gates.filter((g) => g.status === "PASS").length}/${gates.length} pass; `
    + `launchAuthorized ${String(document.launchAuthorized)}\n`,
  );
}

function renderReport(
  document: Record<string, unknown>,
  intendedRuns: number,
  gates: readonly { id: string; requirement: string; status: string; evidence: string }[],
  controls: readonly { id: string; description: string; expectation: string; satisfied: boolean }[],
): string {
  const population = document.taskPopulation as Record<string, unknown>;
  const gateRows = gates.map((gate) =>
    `| ${gate.id} | ${gate.requirement} | **${gate.status}** |`).join("\n");
  const controlRows = controls.map((control) =>
    `| ${control.id} | ${control.description} | ${control.expectation} | ${control.satisfied ? "satisfied" : "**UNSATISFIED**"} |`).join("\n");

  return `# M213 — preregistration: ${String(document.benchmarkName)}

Generated from \`m213Preregistration.ts\` together with the JSON document. The
JSON is authoritative; this file is a rendering of it and is never edited by hand.

\`\`\`text
preregistration hash   ${String(document.preregistrationHash)}
manifest hash          ${String((document.runManifest as Record<string, unknown>).manifestHash)}
intended runs          ${intendedRuns}
live model spend       $0
launch authorised      ${String(document.launchAuthorized)}
\`\`\`

## 1. The question

${String((document.researchQuestions as Record<string, string>).RQ1)}

Under identical agent, model, repository, native tools, budget and evaluator,
what changes because VTRACE or VEXP is present? Three arms, one hundred tasks,
three hundred runs, every task run under all three arms.

## 2. Task population

The exact VEXP subset, taken as the vendor's own committed artifact rather than
reconstructed: \`${String(population.path)}\`, sha256 \`${String(population.sha256)}\`.
${String(population.instanceCount)} instances across ${String((population.repositories as string[]).length)} repositories,
median complexity ${String(population.complexityMedian)}, maximum ${String(population.complexityCeiling)}.

**The vendor's own selection script does not reproduce their own subset** — 22 of
100 instances overlap. The artifact is authoritative; the script is not.

## 3. Arms

| arm | MCP servers | treatment tools | native tools |
|---|---|---|---|
| A — baseline | none | 0 | 7 |
| B — VTRACE | vtrace | 14 (product default) | 7 |
| C — VEXP | vexp | 3 (product default) | 7 |

The catalogue asymmetry is deliberate and preserved: each arm is what that
product actually gives an agent.

## 4. Launch gates

| gate | requirement | status |
|---|---|---|
${gateRows}

## 5. Falsification suite

| control | what it breaks | expectation | result |
|---|---|---|---|
${controlRows}

## 6. Spend

\`\`\`text
benchmark-task live-agent runs   0
live model spend                 $0
VTRACE product changes           0
VEXP product changes             0
frozen A1-A15 scorer changes     0
\`\`\`

No paid run is authorised by this document. The launch gates decide that.
`;
}

await main();
