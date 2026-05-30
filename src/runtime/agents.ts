import type { LauncherCommand } from "./launcher";
import {
  getClaudeCodeConfigStatus,
  writeClaudeCodeConfig,
} from "./claudeCodeConfig";
import {
  getCodexConfigStatus,
  writeCodexConfig,
} from "./codexConfig";

export const ProductShellAgentId = Object.freeze({
  ClaudeCode: "claude-code",
  Codex: "codex",
});

export type ProductShellAgentId =
  (typeof ProductShellAgentId)[keyof typeof ProductShellAgentId];

export interface AgentConfigStatus {
  agentId: ProductShellAgentId;
  displayName: string;
  repoRoot: string;
  configPath: string;
  launcher: LauncherCommand;
  installed: boolean;
  matchesExpected: boolean;
  error?: string;
}

export interface AgentConfigInstallResult extends AgentConfigStatus {
  action: "created" | "updated" | "unchanged";
  dryRun: boolean;
}

export interface ProductShellAgent {
  id: ProductShellAgentId;
  displayName: string;
  getStatus(repoRoot: string): Promise<AgentConfigStatus>;
  writeConfig(
    repoRoot: string,
    options?: {
      dryRun?: boolean;
    },
  ): Promise<AgentConfigInstallResult>;
}

const CLAUDE_CODE_AGENT: ProductShellAgent = {
  id: ProductShellAgentId.ClaudeCode,
  displayName: "Claude Code",
  async getStatus(repoRoot) {
    const status = await getClaudeCodeConfigStatus(repoRoot);

    return {
      agentId: ProductShellAgentId.ClaudeCode,
      displayName: "Claude Code",
      repoRoot: status.repoRoot,
      configPath: status.configPath,
      launcher: structuredClone(status.launcher),
      installed: status.installed,
      matchesExpected: status.matchesExpected,
      ...(status.error === undefined ? {} : { error: status.error }),
    };
  },
  async writeConfig(repoRoot, options = {}) {
    const result = await writeClaudeCodeConfig(repoRoot, options);

    return {
      agentId: ProductShellAgentId.ClaudeCode,
      displayName: "Claude Code",
      repoRoot: result.repoRoot,
      configPath: result.configPath,
      launcher: structuredClone(result.launcher),
      installed: result.installed,
      matchesExpected: result.matchesExpected,
      action: result.action,
      dryRun: result.dryRun,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  },
};

const CODEX_AGENT: ProductShellAgent = {
  id: ProductShellAgentId.Codex,
  displayName: "Codex",
  async getStatus(repoRoot) {
    const status = await getCodexConfigStatus(repoRoot);

    return {
      agentId: ProductShellAgentId.Codex,
      displayName: "Codex",
      repoRoot: status.repoRoot,
      configPath: status.configPath,
      launcher: structuredClone(status.launcher),
      installed: status.installed,
      matchesExpected: status.matchesExpected,
      ...(status.error === undefined ? {} : { error: status.error }),
    };
  },
  async writeConfig(repoRoot, options = {}) {
    const result = await writeCodexConfig(repoRoot, options);

    return {
      agentId: ProductShellAgentId.Codex,
      displayName: "Codex",
      repoRoot: result.repoRoot,
      configPath: result.configPath,
      launcher: structuredClone(result.launcher),
      installed: result.installed,
      matchesExpected: result.matchesExpected,
      action: result.action,
      dryRun: result.dryRun,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  },
};

export function resolveProductShellAgent(
  agentId: string | undefined,
): ProductShellAgent {
  if (
    agentId === undefined
    || agentId === ProductShellAgentId.ClaudeCode
    || agentId === "claude"
  ) {
    return CLAUDE_CODE_AGENT;
  }

  if (agentId === ProductShellAgentId.Codex) {
    return CODEX_AGENT;
  }

  throw new Error(
    `Unsupported agent: ${agentId}. Supported agents: ${listSupportedProductShellAgents().join(", ")}.`,
  );
}

export function listSupportedProductShellAgents(): readonly ProductShellAgentId[] {
  return [ProductShellAgentId.ClaudeCode, ProductShellAgentId.Codex];
}
