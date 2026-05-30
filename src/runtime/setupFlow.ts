import path from "node:path";

import type { ProgressReporter } from "../cli/progress";
import { nullProgressReporter } from "../cli/progress";
import { initRepo } from "../setup/initRepo";
import { detectRepoRoot } from "../setup/repoState";
import {
  ProductShellAgentId,
  resolveProductShellAgent,
  type AgentConfigInstallResult,
} from "./agents";
import {
  VtraceGuidanceTarget,
  writeVtraceAgentGuidanceBlock,
  type AgentGuidanceInstallResult,
} from "./agentGuidance";
import {
  startRuntimeDaemon,
  type RuntimeDaemonActionResult,
} from "./daemon";
import {
  inspectProductShellStatus,
  type ProductShellStatus,
} from "./status";

export interface SetupFlowResult {
  requestedPath: string;
  repoRoot: string;
  detectionMode: ProductShellStatus["detectionMode"];
  detectionMarker?: ProductShellStatus["detectionMarker"];
  selectedAgent: ProductShellAgentId;
  initAction: "initialized" | "reused_existing_ready_state";
  readiness: NonNullable<ProductShellStatus["readiness"]>;
  latestRunId: number | null;
  agentConfig: AgentConfigInstallResult;
  agentGuidance: AgentGuidanceInstallResult;
  runtime: RuntimeDaemonActionResult["status"] & {
    action: RuntimeDaemonActionResult["action"] | "not_requested";
  };
  launcher: ProductShellStatus["launcher"];
  nextSteps: string[];
}

export async function runSetupFlow(options: {
  repoPath?: string;
  cwd?: string;
  startRuntime?: boolean;
  agent?: string;
  onProgress?: ProgressReporter;
} = {}): Promise<SetupFlowResult> {
  const resolvedCwd = path.resolve(options.cwd ?? process.cwd());
  const requestedPath = path.resolve(resolvedCwd, options.repoPath ?? ".");
  const progress = options.onProgress ?? nullProgressReporter;

  progress.report({ kind: "phase_begin", phase: "detect_repo", label: "Detecting repo root" });
  const detection = await detectRepoRoot(requestedPath);
  const agent = resolveProductShellAgent(options.agent);
  const initialStatus = await inspectProductShellStatus({
    repoPath: detection.repoRoot,
    cwd: resolvedCwd,
    agent: agent.id,
  });
  progress.report({ kind: "phase_end", phase: "detect_repo", note: detection.repoRoot });

  const initAction = !initialStatus.repoLocal.initialized
    || initialStatus.readiness?.status !== "ready"
    ? "initialized"
    : "reused_existing_ready_state";

  if (initAction === "initialized") {
    await initRepo({
      repoPath: detection.repoRoot,
      cwd: resolvedCwd,
      onProgress: progress,
    });
  }

  progress.report({ kind: "phase_begin", phase: "agent_config", label: `Installing ${agent.id} config` });
  const agentConfig = await agent.writeConfig(detection.repoRoot);
  progress.report({ kind: "phase_end", phase: "agent_config" });

  const guidanceTarget = agent.id === ProductShellAgentId.ClaudeCode
    ? VtraceGuidanceTarget.ClaudeMd
    : VtraceGuidanceTarget.AgentsMd;
  progress.report({
    kind: "phase_begin",
    phase: "agent_guidance",
    label: `Updating ${guidanceTarget}`,
  });
  const agentGuidance = await writeVtraceAgentGuidanceBlock(
    detection.repoRoot,
    guidanceTarget,
  );
  progress.report({
    kind: "phase_end",
    phase: "agent_guidance",
    note: agentGuidance.action,
  });

  let runtimeAction: RuntimeDaemonActionResult | undefined;
  if (options.startRuntime === true) {
    progress.report({ kind: "phase_begin", phase: "runtime_daemon", label: "Starting runtime daemon" });
    runtimeAction = await startRuntimeDaemon({
      repoPath: detection.repoRoot,
      cwd: resolvedCwd,
    });
    progress.report({ kind: "phase_end", phase: "runtime_daemon", note: runtimeAction.action });
  }
  const finalStatus = await inspectProductShellStatus({
    repoPath: detection.repoRoot,
    cwd: resolvedCwd,
    agent: agent.id,
  });

  progress.report({ kind: "done", summary: `setup ${initAction}` });

  if (finalStatus.readiness === null) {
    throw new Error(`Repo readiness is unavailable after setup: ${detection.repoRoot}`);
  }

  return {
    requestedPath,
    repoRoot: finalStatus.repoRoot,
    detectionMode: finalStatus.detectionMode,
    ...(finalStatus.detectionMarker === undefined
      ? {}
      : { detectionMarker: finalStatus.detectionMarker }),
    selectedAgent: agent.id,
    initAction,
    readiness: finalStatus.readiness,
    latestRunId: finalStatus.latestRunId,
    agentConfig,
    agentGuidance,
    runtime: {
      ...(runtimeAction === undefined
        ? {
          action: "not_requested" as const,
          ...finalStatus.runtime,
        }
        : {
          action: runtimeAction.action,
          ...runtimeAction.status,
        }),
    },
    launcher: finalStatus.launcher,
    nextSteps: finalStatus.nextSteps,
  };
}
