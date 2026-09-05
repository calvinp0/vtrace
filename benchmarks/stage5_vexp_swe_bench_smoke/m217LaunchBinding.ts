/**
 * M217 §4 (reproduced gap) — how the launcher obtains the DOCKER_SWEBENCH
 * adapters.
 *
 * M216 bound the production adapters and ran them through `executeManifestRow`
 * from its own runner. The launcher entry point, `run_stage5_m215_launch.ts`,
 * still resolved a binding's adapters through a property no binding declares,
 * so a COHORT launch would have passed every refusal and then thrown
 * "declares no adapters". That is a launch-critical implementation gap of the
 * kind §28 says TECHNICAL_EXECUTOR_READY excludes, and it is closed here with
 * one factory the launcher and the real-substrate controls both call.
 *
 * Every value that could differ between arms comes from the frozen manifest
 * row (repository, base commit, image) or the frozen dataset (problem
 * statement). The factory adds the substrate mode, the provider boundary and
 * the work root, and nothing an arm could see.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import type { AgentRunSpec } from "./m215LaunchExecutor";
import {
  ArmEnvironmentRegistry,
  M216AgentAdapter,
  M216ContainerAdapter,
  M216EvaluatorAdapter,
} from "./m216ProductionAdapters";
import {
  type ProviderBoundary,
  type SubstrateMode,
  M216_BRIDGE_SCRIPT,
  SubstrateBridge,
} from "./m216SubstrateBridge";
import type { IsolationProbe } from "./m217ContinuationSafety";
import { M217IsolationProbe } from "./m217IsolationProbe";
import { ScratchAwareIsolationProbe } from "./m218IsolationProbe";
import type { ScratchAuthority } from "./m218ScratchLifecycle";

export const M217_LAUNCH_BINDING_VERSION = "stage5.m217.launch-binding.v1" as const;

/** M214's declared task artifact; the bridge's own default, restated so the launcher names it. */
export const M217_FROZEN_DATASET_PATH = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl" as const;

export interface ProblemStatements {
  readonly path: string;
  readonly forInstance: (instanceId: string) => string;
  readonly count: number;
}

/** Problem statements from a SWE-bench jsonl; nothing else is read out of it. */
export function loadProblemStatements(path: string): ProblemStatements {
  if (!existsSync(path)) throw new Error(`frozen dataset absent: ${path}`);
  const statements = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { instance_id?: unknown; problem_statement?: unknown };
    if (typeof row.instance_id === "string") {
      statements.set(row.instance_id, String(row.problem_statement ?? ""));
    }
  }
  return {
    path,
    count: statements.size,
    forInstance: (instanceId) => {
      const statement = statements.get(instanceId);
      if (statement === undefined) {
        throw new Error(`no problem statement for ${instanceId} in ${path}`);
      }
      return statement;
    },
  };
}

export interface ProductionBindingOptions {
  readonly bridge: SubstrateBridge;
  readonly mode: SubstrateMode;
  readonly providerBoundary: ProviderBoundary;
  readonly workRoot: string;
  readonly manifest: readonly RunManifestRow[];
  readonly problemStatements: ProblemStatements;
  readonly datasetPath: string;
  readonly spendAuthorized: boolean;
  /** Research controls only: the lowest provider boundary, replaced by a recorded source. */
  readonly providerSubstitution?: (argv: readonly string[], spec: AgentRunSpec) => readonly string[];
  /** M218 — the scratch authority; when bound, the probe refuses to remediate unowned scratch. */
  readonly scratch?: ScratchAuthority;
}

export interface ProductionBinding {
  readonly container: M216ContainerAdapter;
  readonly agent: M216AgentAdapter;
  readonly evaluator: M216EvaluatorAdapter;
  readonly probe: IsolationProbe;
  readonly workRoot: string;
}

/**
 * The three production adapters and the isolation probe, over one bridge.
 *
 * Instance facts are read from the manifest row by id, so a row the manifest
 * does not carry cannot be started — the same population lock the bridge
 * enforces, applied one layer earlier.
 */
export function productionBinding(options: ProductionBindingOptions): ProductionBinding {
  const byInstance = new Map(options.manifest.map((row) => [row.instanceId, row] as const));
  const instanceFacts = (instanceId: string) => {
    const row = byInstance.get(instanceId);
    if (row === undefined) throw new Error(`${instanceId} is not a row of the bound manifest`);
    return { repo: row.repo, baseCommit: row.baseCommit, image: row.containerImage };
  };
  const armEnvironments = new ArmEnvironmentRegistry();
  const container = new M216ContainerAdapter({
    bridge: options.bridge, mode: options.mode, workRoot: options.workRoot, armEnvironments, instanceFacts,
  });
  const agent = new M216AgentAdapter({
    bridge: options.bridge,
    mode: options.mode,
    providerBoundary: options.providerBoundary,
    workRoot: options.workRoot,
    problemStatement: (instanceId) => options.problemStatements.forInstance(instanceId),
    // M218 — the claimed path when the executor claimed one; the same
    // derivation the container adapter uses otherwise.
    armRootFor: (spec) => spec.scratch?.path ?? join(options.workRoot, `${spec.row.instanceId}--${spec.row.arm}`),
    hostMountFor: (spec) => container.hostMountFor(spec.row.runId),
    armEnvironments: container.armEnvironments,
    spendAuthorized: options.spendAuthorized,
    ...(options.providerSubstitution === undefined ? {} : { providerSubstitution: options.providerSubstitution }),
  });
  const evaluator = new M216EvaluatorAdapter({
    bridge: options.bridge, mode: options.mode, workRoot: options.workRoot, dataset: options.datasetPath,
  });
  const substrateProbe = new M217IsolationProbe(options.bridge);
  return {
    container, agent, evaluator,
    probe: options.scratch === undefined
      ? substrateProbe
      : new ScratchAwareIsolationProbe(substrateProbe, options.scratch),
    workRoot: options.workRoot,
  };
}

export interface StartedProductionBinding extends ProductionBinding {
  readonly bridge: SubstrateBridge;
}

/**
 * Start a bridge bound to the frozen manifest and build the COHORT binding.
 *
 * This is the launcher's path. It is COHORT mode with a LIVE provider
 * boundary, and nothing in this milestone calls it: the bridge refuses LIVE
 * without spend authorisation, and the launcher refuses to reach this point
 * without `--authorize-spend`.
 */
export async function startCohortBinding(options: {
  readonly benchmarkDir: string;
  readonly manifestPath: string;
  readonly manifest: readonly RunManifestRow[];
  readonly workRoot: string;
  readonly datasetPath?: string;
  /** M218 — required by the launcher; a COHORT binding without it cannot claim scratch. */
  readonly scratch?: ScratchAuthority;
}): Promise<StartedProductionBinding> {
  const datasetPath = options.datasetPath ?? M217_FROZEN_DATASET_PATH;
  const bridge = await SubstrateBridge.start({
    benchmarkDir: options.benchmarkDir, manifestPath: options.manifestPath, dataset: datasetPath,
  });
  const binding = productionBinding({
    bridge,
    mode: "COHORT",
    providerBoundary: "LIVE",
    workRoot: options.workRoot,
    manifest: options.manifest,
    problemStatements: loadProblemStatements(datasetPath),
    datasetPath,
    spendAuthorized: true,
    ...(options.scratch === undefined ? {} : { scratch: options.scratch }),
  });
  return { ...binding, bridge };
}

export { M216_BRIDGE_SCRIPT };
