/**
 * M216 §30, §51 — the real-substrate exercise, and the evidence it writes.
 *
 * This is the runner that makes the DOCKER_SWEBENCH binding real. It starts real
 * containers, resets real checkouts, builds a real VTRACE index, constructs the
 * real production argv and environment, spawns real child processes, captures
 * real patches, invokes the real swebench evaluator, and drives all of it
 * through M215's own `executeManifestRow`.
 *
 * What it never does: run one of M214's frozen 100, or contact a provider. The
 * research population is SWE-bench Verified's complement, the manifest is a
 * research manifest with its own digest, and the only substitution is at the
 * lowest provider boundary — the executable the production argv finally names.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m216_real_substrate.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { M214Arm, RunManifestRow } from "./m214Preregistration";
import { M214_AGENT, M214_BUDGET, M214_MODEL, M214_NATIVE_TOOLS } from "./m214Preregistration";
import {
  type ExecutionResult,
  type FrozenAuthorities,
  M215_EXTERNAL_REFERENCE_FILE,
  M215_MANIFEST_FILE,
  M215_PREREGISTRATION_FILE,
  auditRuntimeGateCoverage,
  auditSerializedArtifactForSecrets,
  executeManifestRow,
  verifyFrozenAuthorities,
} from "./m215LaunchExecutor";
import { CohortLedger, type RunResultRecord } from "./m215CohortLedger";
import {
  type M216Control,
  auditSpendProjection,
  configurationControls,
  pureControls,
  realGitPatchControls,
  replaySubstitution,
  researchDeps,
  spendControls,
  suitePasses,
  writeAgentFixtures,
} from "./m216RealSubstrate";
import {
  ArmEnvironmentRegistry,
  M216ContainerAdapter,
  M216EvaluatorAdapter,
  assertTestbedUsable,
} from "./m216ProductionAdapters";
import { M216_SUBSTRATE_PYTHON, SubstrateBridge, SubstrateRefusedError } from "./m216SubstrateBridge";
import {
  M216_RESEARCH_INSTANCES,
  buildResearchManifest,
  frozenInstanceIds,
  loadResearchDataset,
  researchAuthorities,
} from "./m216ResearchFixture";
import { reductionVerdict } from "./m216SubstrateAudit";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m216_real_substrate.json");
const WORK_ROOT = join(RESULTS_DIR, "_m216_work");
const FIXTURE_DIR = join(RESULTS_DIR, "_m216_research", "fixtures");
const REPLAY_SCRIPT = join(import.meta.dir, "m216_replay_agent.py");
const RECORDED = join(import.meta.dir, "m216RecordedInit.jsonl");

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")) as Record<string, unknown>;
}

function control(
  id: string, description: string,
  expectation: "GUARD_FIRES" | "GUARD_SILENT",
  substrate: M216Control["substrate"], issues: readonly string[],
): M216Control {
  const fired = issues.length > 0;
  return {
    id, description, expectation, fired, substrate,
    satisfied: expectation === "GUARD_FIRES" ? fired : !fired,
    detail: fired ? issues.join(" | ") : "no issue reported",
  };
}

function instanceFacts(instanceId: string) {
  const pinned = M216_RESEARCH_INSTANCES.find((entry) => entry.instanceId === instanceId);
  if (pinned === undefined) throw new Error(`unknown research instance: ${instanceId}`);
  return { repo: pinned.repo, baseCommit: pinned.baseCommit, image: pinned.image };
}

async function main(): Promise<void> {
  const controls: M216Control[] = [];
  const notes: Record<string, unknown> = {};

  // ── frozen authorities, verified before anything is touched ──────
  const frozen = verifyFrozenAuthorities(
    readJson(M215_PREREGISTRATION_FILE),
    readJson(M215_MANIFEST_FILE) as unknown as { rows: RunManifestRow[]; manifestHash: string },
    readJson(M215_EXTERNAL_REFERENCE_FILE),
  );
  if (!frozen.verified) {
    throw new Error(`frozen authorities do not verify: ${frozen.issues.join("; ")}`);
  }
  const frozenIds = frozenInstanceIds(frozen.manifest);

  // §12 — asserted before a container is started, not after.
  const overlap = M216_RESEARCH_INSTANCES
    .filter((entry) => frozenIds.has(entry.instanceId)).map((entry) => entry.instanceId);
  controls.push(control(
    "F44A", "every research instance is outside M214's frozen 100",
    "GUARD_SILENT", "PURE", overlap.map((id) => `${id} is a frozen task`),
  ));
  if (overlap.length > 0) throw new Error(`research population overlaps the frozen 100: ${overlap}`);
  notes.researchPopulation = {
    instances: M216_RESEARCH_INSTANCES.map((entry) => entry.instanceId),
    notInM214FrozenPopulation: true,
    source: "SWE-bench Verified complement (400 tasks M214 did not freeze)",
  };

  rmSync(WORK_ROOT, { recursive: true, force: true });
  mkdirSync(WORK_ROOT, { recursive: true });

  const dataset = loadResearchDataset(RESULTS_DIR);
  if (!dataset.present) {
    throw new Error(
      "the research dataset is absent; run run_stage5_m216_research_dataset.py first",
    );
  }
  const fixtures = writeAgentFixtures(RECORDED, FIXTURE_DIR);

  // ── pure and real-git controls (no container needed) ─────────────
  controls.push(...pureControls(frozen.preregistration, RESULTS_DIR));
  controls.push(...spendControls(frozen));
  const git = realGitPatchControls();
  controls.push(...git.controls);
  notes.patchControlOutcomes = git.outcomes;
  notes.spendProjection = auditSpendProjection();

  const configurationRow = buildResearchManifest(
    [[M216_RESEARCH_INSTANCES[0]!.instanceId, ["vtrace", "baseline"] as readonly M214Arm[]]],
    "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
  ).rows[0]!;
  controls.push(...configurationControls(configurationRow, join(WORK_ROOT, "configuration")));

  // ── the real substrate ───────────────────────────────────────────
  const bridge = await SubstrateBridge.start({
    benchmarkDir: import.meta.dir,
    manifestPath: join(RESULTS_DIR, M215_MANIFEST_FILE),
    dataset: dataset.path,
  });
  const identity = await bridge.identity();
  notes.substrateIdentity = identity;

  const armEnvironments = new ArmEnvironmentRegistry();
  const session = {
    bridge, armEnvironments, workRoot: WORK_ROOT, dataset, frozen, frozenIds, fixtures,
    resultsDir: RESULTS_DIR,
  };

  const executed: Record<string, unknown>[] = [];
  let containersStarted = 0;

  try {
    // F44 — a frozen task refused by the real substrate in research mode.
    let refusal: string[] = [];
    try {
      await bridge.call("container.start", {
        mode: "RESEARCH", instanceId: frozen.manifest[0]!.instanceId,
        repo: frozen.manifest[0]!.repo, baseCommit: frozen.manifest[0]!.baseCommit,
        image: frozen.manifest[0]!.containerImage, hostRoot: join(WORK_ROOT, "refused"),
      });
    } catch (error) {
      refusal = [(error as Error).message];
    }
    controls.push(control(
      "F44", "the real substrate refuses a frozen task in research mode, including 'just for "
      + "infrastructure'", "GUARD_FIRES", "REAL_CONTAINER", refusal,
    ));

    // F45 — wrong HEAD on a non-frozen container.
    let wrongHead: string[] = [];
    {
      const adapter = new M216ContainerAdapter({
        bridge, mode: "RESEARCH", workRoot: join(WORK_ROOT, "wronghead"),
        armEnvironments: new ArmEnvironmentRegistry(),
        instanceFacts: (id) => ({ ...instanceFacts(id), baseCommit: "0".repeat(40) }),
      });
      try {
        await adapter.start(configurationRow);
      } catch (error) {
        wrongHead = [(error as Error).message];
      }
      containersStarted += 1;
    }
    controls.push(control(
      "F45", "a container whose checkout does not land on the declared base commit is refused",
      "GUARD_FIRES", "REAL_CONTAINER", wrongHead,
    ));

    // ── one real container, reused for the cheap container controls ─
    //
    // Explicitly the BASELINE arm. The first version of this block reused the
    // configuration row, which is a vtrace row, so the control that claimed to
    // show "the baseline arm sees no treatment" was inspecting the treated arm
    // and correctly reported fourteen tools. A control that names an arm has to
    // be handed that arm.
    const probeRow = buildResearchManifest(
      [[M216_RESEARCH_INSTANCES[0]!.instanceId, ["baseline", "vtrace"] as readonly M214Arm[]]],
      "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
    ).rows[0]!;
    const probeAdapter = new M216ContainerAdapter({
      bridge, mode: "RESEARCH", workRoot: join(WORK_ROOT, "probe"), instanceFacts,
      armEnvironments: new ArmEnvironmentRegistry(),
    });
    const probeHandle = await probeAdapter.start(probeRow);
    containersStarted += 1;
    const bridgeHandle = (probeHandle as unknown as { bridgeHandle: string }).bridgeHandle;
    try {
      controls.push(control(
        "F46A", "the started container's /testbed exists and is writable",
        "GUARD_SILENT", "REAL_CONTAINER",
        await assertTestbedUsable(bridge, bridgeHandle, probeHandle.workingDirectory),
      ));
      controls.push(control(
        "F46", "a checkout root that is not there is refused by the same probe",
        "GUARD_FIRES", "REAL_CONTAINER",
        await assertTestbedUsable(bridge, bridgeHandle, "/testbed_does_not_exist"),
      ));

      await probeAdapter.resetToBaseCommit(probeHandle, probeRow);
      const head = await probeAdapter.head(probeHandle);
      controls.push(control(
        "F45B", "after reset the real container HEAD is the declared base commit",
        "GUARD_SILENT", "REAL_CONTAINER",
        head === probeRow.baseCommit ? [] : [`HEAD ${head} != ${probeRow.baseCommit}`],
      ));

      const digestOne = await probeAdapter.trackedSourceDigest(probeHandle);
      const digestTwo = await probeAdapter.trackedSourceDigest(probeHandle);
      controls.push(control(
        "F70", "the tracked-source digest is stable across repeated reads of an unchanged tree",
        "GUARD_SILENT", "REAL_CONTAINER",
        digestOne === digestTwo ? [] : [`${digestOne} != ${digestTwo}`],
      ));

      // The file to perturb is DERIVED from the repository rather than named,
      // so the control does not silently stop editing anything if a research
      // instance is swapped for one with a different layout.
      const firstTracked = (await bridge.call<{ stdout: string }>("container.exec", {
        handle: bridgeHandle, label: "first_tracked_file",
        command: "git ls-files -- '*.py' | head -1",
      })).stdout.trim();
      if (firstTracked.length === 0) throw new Error("the research checkout has no tracked source");
      notes.perturbedFile = firstTracked;
      await bridge.call("container.exec", {
        handle: bridgeHandle, label: "control_edit",
        command: `printf '\\n# m216 control edit\\n' >> ${firstTracked}`,
      });
      const digestThree = await probeAdapter.trackedSourceDigest(probeHandle);
      controls.push(control(
        "F71", "the tracked-source digest changes when a tracked file changes, so source identity "
        + "is a measurement and not a constant",
        "GUARD_FIRES", "REAL_CONTAINER",
        digestThree === digestOne ? [] : [`digest moved ${digestOne} -> ${digestThree}`],
      ));

      const capturedEdit = await probeAdapter.capturePatch(probeHandle, []);
      controls.push(control(
        "F72", "the real patch snapshot captures exactly the edited tracked file",
        "GUARD_SILENT", "REAL_CONTAINER",
        JSON.stringify(capturedEdit.paths) === JSON.stringify([firstTracked])
          ? []
          : [`captured ${JSON.stringify(capturedEdit.paths)}, expected ["${firstTracked}"]`],
      ));

      // §17 P1/P2 on the REAL substrate: a real vtrace index in a real checkout.
      await bridge.call("container.exec", {
        handle: bridgeHandle, label: "restore", command: `git checkout -f -- ${firstTracked}`,
      });
      const vtraceRow = { ...probeRow, arm: "vtrace" as M214Arm };
      const treatment = await probeAdapter.initialiseTreatment(probeHandle, vtraceRow);
      notes.treatmentInitialisation = {
        initialised: treatment.initialised,
        indexBuildSeconds: treatment.indexBuildSeconds,
        indexSizeBytes: treatment.indexSizeBytes,
        exposedToolCount: treatment.exposedToolNames.length,
      };
      controls.push(control(
        "F73", "a real VTRACE index is built in the real checkout before the agent starts, and it "
        + "serves the frozen catalogue",
        "GUARD_SILENT", "REAL_CONTAINER",
        treatment.initialised && treatment.exposedToolNames.length === 14
          ? []
          : [`initialised=${treatment.initialised}, tools=${treatment.exposedToolNames.length}`],
      ));

      const digestAfterTreatment = await probeAdapter.trackedSourceDigest(probeHandle);
      controls.push(control(
        "F74", "building the treatment index leaves tracked source byte-identical, so indexing is "
        + "observational", "GUARD_SILENT", "REAL_CONTAINER",
        digestAfterTreatment === digestOne
          ? []
          : [`tracked source moved from ${digestOne} to ${digestAfterTreatment}`],
      ));

      const snapshot = await probeAdapter.untrackedPaths(probeHandle);
      notes.preAgentUntrackedSnapshot = snapshot;
      controls.push(control(
        "F75", "the pre-agent snapshot names the treatment DIRECTORY, not the files inside it",
        "GUARD_SILENT", "REAL_CONTAINER",
        snapshot.includes(".vtrace") && !snapshot.some((p) => p.startsWith(".vtrace/"))
          ? []
          : [`snapshot ${JSON.stringify(snapshot)} is not at directory granularity`],
      ));

      // A treatment file written AFTER the snapshot must stay out of the patch.
      await bridge.call("container.exec", {
        handle: bridgeHandle, label: "treatment_write_during_run",
        command: "printf 'written during the run' > .vtrace/session-written-during-run.bin",
      });
      const capturedAfter = await probeAdapter.capturePatch(
        probeHandle, [...snapshot],
      );
      controls.push(control(
        "F47R", "on the REAL substrate, treatment state written during the run does not enter the "
        + "captured source patch", "GUARD_SILENT", "REAL_CONTAINER",
        capturedAfter.paths.filter((p) => p.startsWith(".vtrace")),
      ));
      controls.push(control(
        "F47RB", "the same real state IS captured when the derived exclusions are dropped, so the "
        + "exclusion is doing the work rather than git",
        "GUARD_FIRES", "REAL_CONTAINER",
        (await probeAdapter.capturePatch(probeHandle, [])).paths.filter((p) => p.startsWith(".vtrace")),
      ));

      // §41 — what a BASELINE arm can actually see, read off the real surface.
      const baselineSurface = await probeAdapter.inspectArmSurface(probeHandle, probeRow);
      notes.baselineSurface = {
        mcpServers: baselineSurface.mcpServers,
        modelVisibleToolNames: baselineSurface.modelVisibleToolNames,
        environmentVariableNames: baselineSurface.environmentVariableNames,
        treatmentBinariesOnPath: baselineSurface.treatmentBinariesOnPath,
        daemonSocketsReachable: baselineSurface.daemonSocketsReachable,
        injectedContextDocuments: baselineSurface.injectedContextDocuments,
        goldArtifactsInAgentContext: baselineSurface.goldArtifactsInAgentContext,
      };
      controls.push(control(
        "F76", "the baseline arm's real environment carries no VTRACE or VEXP variable and no "
        + "MCP server", "GUARD_SILENT", "REAL_AGENT_PATH",
        [
          ...baselineSurface.environmentVariableNames
            .filter((name) => /^(VTRACE|VEXP)/.test(name))
            .map((name) => `baseline environment carries ${name}`),
          ...baselineSurface.mcpServers.map((name) => `baseline arm registers MCP server ${name}`),
          ...baselineSurface.modelVisibleToolNames
            .filter((name) => name.startsWith("mcp__vtrace__"))
            .map((name) => `baseline arm can see ${name}`),
        ],
      ));
      controls.push(control(
        "F77", "no evaluation artifact is reachable from the real agent workspace",
        "GUARD_SILENT", "REAL_CONTAINER", baselineSurface.goldArtifactsInAgentContext,
      ));
    } finally {
      await probeAdapter.stop(probeHandle);
    }

    // ── §30 end-to-end, both arm orders (§44) ────────────────────────
    for (const [label, order] of [
      ["BASELINE_FIRST", ["baseline", "vtrace"] as readonly M214Arm[]],
      ["VTRACE_FIRST", ["vtrace", "baseline"] as readonly M214Arm[]],
    ] as const) {
      const instance = label === "BASELINE_FIRST"
        ? M216_RESEARCH_INSTANCES[0]!
        : M216_RESEARCH_INSTANCES[1]!;
      const manifest = buildResearchManifest(
        [[instance.instanceId, order]],
        "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d",
        "f37dc003bb0b323f34d351b5cea77c8a66f32450",
      );
      const authorities = researchAuthorities(frozen, manifest);
      const ledger = new CohortLedger(
        "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
      );
      const container = new M216ContainerAdapter({
        bridge, mode: "RESEARCH", workRoot: join(WORK_ROOT, label.toLowerCase()), instanceFacts,
        armEnvironments,
      });
      const results: ExecutionResult[] = [];
      for (const row of manifest.rows) {
        const argvOut = join(WORK_ROOT, label.toLowerCase(), `${row.arm}.argv.json`);
        // An APPEND to a tracked source file, not an overwrite and not a new
        // file at the repository root. The first version of this control
        // replaced setup.py wholesale — a real agent-shaped change that also
        // breaks the package install, so the evaluator sat in a reinstall loop.
        // The second wrote a new .py at the root, which pylint's own
        // recursive-path tests would then see. The point of the edit is to give
        // patch capture and the evaluator a tree that genuinely changed, not to
        // change what the task's tests measure.
        const edit = `${TREATMENT_EDIT_TARGET}::\\n# m216 ${label} ${row.arm} replayed change\\n`;
        const deps = researchDeps(
          session, authorities, ledger, "REPLAY",
          replaySubstitution({
            python: M216_SUBSTRATE_PYTHON, script: REPLAY_SCRIPT,
            fixture: fixtures.correct, argvOut, appendFiles: [edit],
          }),
          container, join(WORK_ROOT, label.toLowerCase()),
        );
        const executedRow = await executeManifestRow(deps, { runId: row.runId });
        results.push(executedRow);
        containersStarted += 1;
        const spawned = existsSync(argvOut)
          ? (JSON.parse(readFileSync(argvOut, "utf8")) as { argv: string[] }).argv
          : null;
        executed.push({
          order: label, arm: row.arm, instanceId: row.instanceId,
          status: executedRow.record.validity.status,
          infrastructureCategory: executedRow.record.validity.infrastructureCategory,
          reason: executedRow.record.validity.reason.slice(0, 400),
          phases: executedRow.record.lifecyclePhasesObserved,
          spawnedArgvLength: spawned?.length ?? null,
          spawnedModelFlag: spawned?.[spawned.indexOf("--model") + 1] ?? null,
          capturedPatchPaths: executedRow.record.capturedPatchPaths,
          evaluatorRan: executedRow.record.evaluation?.evaluatorRan ?? null,
          resolved: executedRow.record.evaluation?.resolved ?? null,
          treatmentToolsExposed: executedRow.record.treatment.exposed,
        });
        // A row whose agent never launched cannot answer the argv controls, and
        // saying so is better than a control that quietly reads a stale file.
        if (spawned === null) {
          controls.push(control(
            `F59_${label}_${row.arm}`,
            "the production argv reached a real child process for this row",
            "GUARD_SILENT", "REAL_AGENT_PATH",
            [`no child process was spawned: ${executedRow.record.validity.reason.slice(0, 300)}`],
          ));
        }
      }

      // The production argv reached a real child process unaltered.
      const argvChecks = manifest.rows.map((row) => {
        const path = join(WORK_ROOT, label.toLowerCase(), `${row.arm}.argv.json`);
        if (!existsSync(path)) return [`${row.arm} spawned no child process`];
        const spawned = (JSON.parse(readFileSync(path, "utf8")) as { argv: string[] }).argv;
        const issues: string[] = [];
        if (spawned[spawned.indexOf("--model") + 1] !== M214_MODEL.model) {
          issues.push(`${row.arm} spawned with model ${spawned[spawned.indexOf("--model") + 1]}`);
        }
        if (spawned[spawned.indexOf("--allowedTools") + 1] !== M214_NATIVE_TOOLS.join(",")) {
          issues.push(`${row.arm} native tools differ from the frozen catalogue`);
        }
        if (spawned[spawned.indexOf("--max-turns") + 1] !== String(M214_BUDGET.maxTurns)) {
          issues.push(`${row.arm} turn budget differs`);
        }
        if (spawned[spawned.indexOf("--max-budget-usd") + 1] !== String(M214_BUDGET.perRunCostCapUsd)) {
          issues.push(`${row.arm} cost cap differs`);
        }
        if (!spawned.includes("--strict-mcp-config")) issues.push(`${row.arm} is not strict-mcp`);
        return issues;
      }).flat();
      controls.push(control(
        `F59_${label}`, `both arms of the ${label} order reach a real child process with the frozen `
        + "model, native tools and budgets", "GUARD_SILENT", "REAL_AGENT_PATH", argvChecks,
      ));

      // §26 — the two arms' native-tool argument is identical, and only the MCP
      // configuration differs.
      const spawnedArgv = manifest.rows.map((row) => {
        const path = join(WORK_ROOT, label.toLowerCase(), `${row.arm}.argv.json`);
        return existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as { argv: string[] }).argv
          : [];
      });
      const differing = spawnedArgv[0]!
        .map((value, index) => (spawnedArgv[1]![index] === value ? null : index))
        .filter((index): index is number => index !== null);
      const differingFlags = differing.map((index) => {
        for (let cursor = index; cursor >= 0; cursor -= 1) {
          if (spawnedArgv[0]![cursor]!.startsWith("--")) return spawnedArgv[0]![cursor]!;
        }
        return `argv[${index}]`;
      });
      controls.push(control(
        `F26_${label}`, "the two arms' invocations differ only in the MCP configuration document",
        "GUARD_SILENT", "REAL_AGENT_PATH",
        [...new Set(differingFlags)].filter((flag) => flag !== "--mcp-config")
          .map((flag) => `arms differ at ${flag}`),
      ));

      // §44 — source identity at each agent start is equal across the pair.
      const digests = results.map(
        (entry) => entry.record.sourceState.trackedSourceDigestBeforeTreatment,
      );
      controls.push(control(
        `F50_${label}`, "both arms of the pair started from an identical tracked-source digest",
        "GUARD_SILENT", "REAL_CONTAINER",
        new Set(digests).size === 1 ? [] : [`digests differ: ${JSON.stringify(digests)}`],
      ));

      // §43 — no treatment state survived into the arm that ran second.
      //
      // Asserted through the gate rather than through a field on the record: R7
      // is the guard that would actually stop a contaminated run, so a control
      // that read a separate copy of the observation could pass while the guard
      // was broken.
      const second = results[1]!.record;
      const warmth = second.runtimeGates.find((gate) => gate.gateId === "R7_RESET_WARMTH_POLICY");
      controls.push(control(
        `F49_${label}`, "the arm that ran second inherited no treatment state from the first, as "
        + "measured by the COLD_UNIFORM gate that would have stopped it",
        "GUARD_SILENT", "REAL_CONTAINER",
        warmth === undefined
          ? ["the warmth gate was not emitted for the second arm"]
          : warmth.status === "PASS" ? [] : [warmth.failureReason ?? "warmth gate failed"],
      ));

      // Gate coverage: a valid outcome requires every required gate PRESENT.
      controls.push(control(
        `F31_${label}`, "every required runtime gate is present in both records",
        "GUARD_SILENT", "REAL_AGENT_PATH",
        results.flatMap((entry) => auditRuntimeGateCoverage(entry.record.runtimeGates)),
      ));
    }

    // ── F53/F54 through the REAL agent adapter ──────────────────────
    for (const [id, fixture, description] of [
      ["F53R", fixtures.wrongModel,
        "a wrong provider model identity aborts the real agent path before an outcome exists"],
      ["F54R", fixtures.missingModel,
        "an absent provider model identity aborts the real agent path"],
    ] as const) {
      const manifest = buildResearchManifest(
        [[M216_RESEARCH_INSTANCES[0]!.instanceId, ["baseline"] as readonly M214Arm[]]],
        "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
      );
      const authorities = researchAuthorities(frozen, manifest);
      const ledger = new CohortLedger(
        "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
      );
      const dir = join(WORK_ROOT, `identity_${id.toLowerCase()}`);
      const deps = researchDeps(
        session, authorities, ledger, "REPLAY",
        replaySubstitution({
          python: M216_SUBSTRATE_PYTHON, script: REPLAY_SCRIPT, fixture,
          argvOut: join(dir, "argv.json"),
        }),
        new M216ContainerAdapter({
          bridge, mode: "RESEARCH", workRoot: dir, instanceFacts,
          armEnvironments: new ArmEnvironmentRegistry(),
        }),
        dir,
      );
      const result = await executeManifestRow(deps, { runId: manifest.rows[0]!.runId });
      containersStarted += 1;
      const issues: string[] = [];
      if (result.record.validity.valid) issues.push("the run produced a VALID outcome");
      if (result.record.validity.infrastructureCategory !== "MODEL_IDENTITY_DRIFT") {
        issues.push(`category ${String(result.record.validity.infrastructureCategory)}`);
      }
      controls.push(control(
        id, description, "GUARD_SILENT", "REAL_AGENT_PATH", issues,
      ));
    }

    // ── §28 evaluator controls on a non-frozen instance ─────────────
    const evaluator = new M216EvaluatorAdapter({
      bridge, mode: "RESEARCH", workRoot: join(WORK_ROOT, "evaluator"), dataset: dataset.path,
    });
    const evalRow = buildResearchManifest(
      [[M216_RESEARCH_INSTANCES[0]!.instanceId, ["baseline"] as readonly M214Arm[]]],
      "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
    ).rows[0]!;

    const e1 = await evaluator.evaluate(evalRow, "");
    controls.push(control(
      "E1", "an empty patch is an ordinary unresolved outcome, and the evaluator says so rather "
      + "than failing", "GUARD_SILENT", "REAL_EVALUATOR",
      e1.evaluatorRan && !e1.resolved ? [] : [`ran=${e1.evaluatorRan} resolved=${e1.resolved}`],
    ));

    // A patch that does not apply is an ordinary agent failure under M214's
    // rules — "the agent made a bad patch" is on the neverExclusions list — so
    // the evaluator is expected to RUN and report unresolved.
    const malformed = "diff --git a/nope b/nope\n@@ this is not a patch @@\n";
    const e2 = await evaluator.evaluate(evalRow, malformed);
    notes.evaluatorMalformed = {
      evaluatorRan: e2.evaluatorRan, exitStatus: e2.exitStatus, resolved: e2.resolved,
      rawResult: e2.rawResult.slice(0, 300),
    };
    controls.push(control(
      "F56", "an unappliable patch is graded by the real evaluator as an ordinary unresolved "
      + "outcome, not as an infrastructure failure", "GUARD_SILENT", "REAL_EVALUATOR",
      e2.evaluatorRan && !e2.resolved
        ? []
        : [`evaluatorRan=${e2.evaluatorRan} resolved=${e2.resolved}`],
    ));

    // The other half of §47, which the malformed-patch case does NOT establish:
    // an evaluation that never produced a report must stay distinguishable from
    // a task the tests judged unresolved. Falsified by asking the real evaluator
    // for an instance its dataset does not contain.
    const decoyDataset = join(WORK_ROOT, "decoy_dataset.jsonl");
    writeFileSync(decoyDataset, `${readFileSync(dataset.path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.includes(evalRow.instanceId))
      .join("\n")}\n`);
    const e3 = await new M216EvaluatorAdapter({
      bridge, mode: "RESEARCH", workRoot: join(WORK_ROOT, "evaluator_infra"),
      dataset: decoyDataset,
    }).evaluate(evalRow, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n");
    notes.evaluatorInfraFailure = {
      evaluatorRan: e3.evaluatorRan, exitStatus: e3.exitStatus, resolved: e3.resolved,
    };
    controls.push(control(
      "F56B", "an evaluation whose report does not contain the instance is an infrastructure "
      + "failure, never an unresolved task", "GUARD_SILENT", "REAL_EVALUATOR",
      e3.evaluatorRan
        ? ["the evaluator was reported as having run, so this would become an unresolved outcome"]
        : [],
    ));

    const gold = dataset.instances
      .find((entry) => entry.instanceId === evalRow.instanceId);
    notes.evaluatorIdentity = await bridge.call("evaluator.identity", {});
    controls.push(control(
      "F57", "the real evaluator's identity is recorded so drift after the cohort begins is "
      + "detectable", "GUARD_SILENT", "REAL_EVALUATOR",
      typeof (notes.evaluatorIdentity as { version?: unknown }).version === "string"
        ? []
        : ["the evaluator did not report a version"],
    ));
    void gold;

    // ── §33 resume, on the real substrate ───────────────────────────
    {
      const instance = M216_RESEARCH_INSTANCES[0]!;
      const manifest = buildResearchManifest(
        [[instance.instanceId, ["baseline", "vtrace"] as readonly M214Arm[]]],
        "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
      );
      const authorities = researchAuthorities(frozen, manifest);
      const dir = join(WORK_ROOT, "resume");
      const first = new CohortLedger(
        "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
      );
      const resumeEnvironments = new ArmEnvironmentRegistry();
      const container = new M216ContainerAdapter({
        bridge, mode: "RESEARCH", workRoot: dir, instanceFacts,
        armEnvironments: resumeEnvironments,
      });
      const deps = researchDeps(
        session, authorities, first, "REPLAY",
        replaySubstitution({
          python: M216_SUBSTRATE_PYTHON, script: REPLAY_SCRIPT, fixture: fixtures.correct,
          argvOut: join(dir, "argv.json"),
        }),
        container, dir,
      );
      const rowOne = await executeManifestRow(deps, { runId: manifest.rows[0]!.runId });
      containersStarted += 1;

      // The launcher process dies here. Everything it knew is in the ledger.
      const persisted = JSON.stringify({
        records: first.records, entries: first.entries,
      });
      const restored = CohortLedger.restore(
        "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
        (JSON.parse(persisted) as { records: RunResultRecord[] }).records,
        (JSON.parse(persisted) as { entries: Parameters<typeof CohortLedger.restore>[4] }).entries,
      );
      const resumeIssues = [...restored.issues];
      if (restored.ledger.statusFor(rowOne.record.instanceId, rowOne.record.arm)
        !== rowOne.record.validity.status) {
        resumeIssues.push("the restored ledger disagrees about the completed row's status");
      }
      controls.push(control(
        "F61A", "a ledger written by one process restores in another with its chain and digests "
        + "recomputed", "GUARD_SILENT", "REAL_CONTAINER", resumeIssues,
      ));

      // Re-running the completed row must be refused, not repeated.
      let duplicate: string[] = [];
      try {
        const resumed = researchDeps(
          session, authorities, restored.ledger, "REPLAY",
          replaySubstitution({
            python: M216_SUBSTRATE_PYTHON, script: REPLAY_SCRIPT, fixture: fixtures.correct,
            argvOut: join(dir, "argv2.json"),
          }),
          container, dir,
        );
        await executeManifestRow(resumed, { runId: manifest.rows[0]!.runId });
        containersStarted += 1;
      } catch (error) {
        duplicate = [(error as Error).message];
      }
      controls.push(control(
        "F61", "after resume, a row that already has a valid outcome is refused rather than rerun",
        "GUARD_FIRES", "REAL_CONTAINER", duplicate,
      ));

      // F58 — a research result cannot enter a COHORT ledger.
      let rejected: string[] = [];
      try {
        const cohort = new CohortLedger(
          "COHORT", frozen.preregistrationHash.actual, frozen.manifestHash.actual,
        );
        cohort.append(rowOne.record, new Date().toISOString());
      } catch (error) {
        rejected = [(error as Error).message];
      }
      controls.push(control(
        "F58", "a research result is refused by a COHORT ledger, on its mode and on its manifest "
        + "digest", "GUARD_FIRES", "REAL_CONTAINER", rejected,
      ));

      // F62 — the arm root the previous row used is gone, so the next row
      // cannot inherit its treatment state or its configuration directory.
      controls.push(control(
        "F62", "teardown removed the completed arm's scratch root, so the next row cannot inherit "
        + "its treatment state", "GUARD_SILENT", "REAL_CONTAINER",
        existsSync(join(dir, `${manifest.rows[0]!.instanceId}--${manifest.rows[0]!.arm}`))
          ? ["the previous arm's root survived teardown"]
          : [],
      ));
    }

    // ── §46 agent-process failure classification ────────────────────
    //
    // A non-zero exit is not one thing, and the two cases below have different
    // validity consequences: a process that never started never reached the
    // treatment, while one that ran and produced no result event may have cost
    // money at the provider.
    for (const [id, description, substitution, expectedCategory] of [
      [
        "F80",
        "an agent process that cannot be spawned is an infrastructure failure before treatment "
        + "exposure, not an unresolved task",
        (argv: readonly string[]) => [join(WORK_ROOT, "no-such-agent-binary"), ...argv.slice(1)],
        "AGENT_INFRASTRUCTURE_FAILURE_BEFORE_TREATMENT_EXPOSURE",
      ],
      [
        "F81",
        "an agent that ran and produced no result event is a model-service failure, not an "
        + "unresolved task",
        replaySubstitution({
          python: M216_SUBSTRATE_PYTHON, script: REPLAY_SCRIPT, fixture: fixtures.noResult,
          argvOut: join(WORK_ROOT, "no_result", "argv.json"),
        }),
        "MODEL_SERVICE_FAILURE",
      ],
    ] as const) {
      const manifest = buildResearchManifest(
        [[M216_RESEARCH_INSTANCES[0]!.instanceId, ["baseline"] as readonly M214Arm[]]],
        "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d", "f37dc003bb0b323f34d351b5cea77c8a66f32450",
      );
      const authorities = researchAuthorities(frozen, manifest);
      const dir = join(WORK_ROOT, id.toLowerCase());
      const result = await executeManifestRow(
        researchDeps(
          session, authorities,
          new CohortLedger(
            "SYNTHETIC", authorities.preregistrationHash.actual, authorities.manifestHash.actual,
          ),
          "REPLAY", substitution,
          new M216ContainerAdapter({
            bridge, mode: "RESEARCH", workRoot: dir, instanceFacts,
            armEnvironments: new ArmEnvironmentRegistry(),
          }),
          dir,
        ),
        { runId: manifest.rows[0]!.runId },
      );
      containersStarted += 1;
      const issues: string[] = [];
      if (result.record.validity.valid) issues.push("the run produced a VALID outcome");
      if (result.record.validity.infrastructureCategory !== expectedCategory) {
        issues.push(
          `category ${String(result.record.validity.infrastructureCategory)}, expected `
          + expectedCategory,
        );
      }
      controls.push(control(id, description, "GUARD_SILENT", "REAL_AGENT_PATH", issues));
    }

    // §20 — a LIVE provider boundary is refused outside COHORT mode.
    let liveRefusal: string[] = [];
    try {
      await bridge.call("agent.run", {
        mode: "RESEARCH", providerBoundary: "LIVE", spendAuthorized: true,
        instanceId: M216_RESEARCH_INSTANCES[0]!.instanceId,
        argv: ["/bin/true"], env: {}, cwd: WORK_ROOT,
        streamPath: join(WORK_ROOT, "never.jsonl"), timeoutSeconds: 5,
      });
    } catch (error) {
      liveRefusal = [(error as Error).message];
    }
    controls.push(control(
      "F78", "a LIVE provider boundary is refused outside COHORT mode, whatever authorisation the "
      + "caller claims", "GUARD_FIRES", "REAL_AGENT_PATH", liveRefusal,
    ));
  } finally {
    const accounting = await bridge.shutdown();
    notes.substrateAccounting = accounting;
    notes.containersStartedByRunner = containersStarted;
  }

  const accounting = notes.substrateAccounting as {
    containersStarted: number; containersTornDown: number;
    frozenInstancesTouched: string[]; nonFrozenInstancesTouched: string[];
  } | null;

  const document = {
    schemaVersion: M216_SUITE_VERSION_LABEL,
    milestone: "M216",
    generatedAt: new Date().toISOString(),
    substrateReduction: reductionVerdict(),
    controlCount: controls.length,
    satisfied: controls.filter((entry) => entry.satisfied).length,
    failures: controls.filter((entry) => !entry.satisfied).map((entry) => entry.id),
    guardFiresControls: controls.filter((entry) => entry.expectation === "GUARD_FIRES").length,
    guardSilentControls: controls.filter((entry) => entry.expectation === "GUARD_SILENT").length,
    suitePasses: suitePasses(controls),
    containersStarted: accounting?.containersStarted ?? 0,
    containersTornDown: accounting?.containersTornDown ?? 0,
    frozenInstancesTouched: accounting?.frozenInstancesTouched ?? [],
    nonFrozenInstancesTouched: accounting?.nonFrozenInstancesTouched ?? [],
    liveModelSpendUsd: 0,
    providerCalls: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    executedRows: executed,
    controls,
    notes,
  };

  // §50 — the artifact this milestone persists carries no credential value.
  const secretIssues = auditSerializedArtifactForSecrets(
    JSON.stringify(document), process.env as Record<string, string>,
  );
  if (secretIssues.length > 0) {
    throw new Error(`refusing to persist the evidence: ${secretIssues.join("; ")}`);
  }

  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${document.satisfied}/${document.controlCount} controls satisfied `
    + `(${document.guardFiresControls} GUARD_FIRES, ${document.guardSilentControls} GUARD_SILENT); `
    + `failures [${document.failures.join(", ") || "none"}]\n`,
  );
  process.stdout.write(
    `containers started ${document.containersStarted}, torn down ${document.containersTornDown}, `
    + `frozen tasks touched ${document.frozenInstancesTouched.length}, spend $0\n`,
  );
  process.stdout.write(`wrote ${OUTPUT}\n`);
}

const M216_SUITE_VERSION_LABEL = "stage5.m216.real-substrate.v1";

/** A tracked source file in the research repository, appended to rather than replaced. */
const TREATMENT_EDIT_TARGET = "/testbed/pylint/__init__.py";

await main();
