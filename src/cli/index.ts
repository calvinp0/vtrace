import type { CliOptions, CommandResult } from "./types";
import { runCheckCapsuleCommand } from "./commands/checkCapsuleCommand";
import { runCapsuleCommand } from "./commands/capsuleCommand";
import { runClaudeConfigCommand } from "./commands/claudeConfigCommand";
import { runDaemonCommand, runDaemonRunnerCommand } from "./commands/daemonCommand";
import { runHandoffCommand } from "./commands/handoffCommand";
import { runInitCommand } from "./commands/initCommand";
import { runIndexCommand } from "./commands/indexCommand";
import { runIntentCommand } from "./commands/intentCommand";
import { runInspectFileCommand } from "./commands/inspectFileCommand";
import { runImpactGraphCommand } from "./commands/impactGraphCommand";
import { runInspectSymbolCommand } from "./commands/inspectSymbolCommand";
import { runMcpServeCommand } from "./commands/mcpServeCommand";
import { runRunsCommand } from "./commands/runsCommand";
import { runRunPipelineCommand } from "./commands/runPipelineCommand";
import { runExpandVexpRefCommand } from "./commands/expandVexpRefCommand";
import { runSkeletonCommand } from "./commands/skeletonCommand";
import { runSetupCommand } from "./commands/setupCommand";
import { runStatusCommand } from "./commands/statusCommand";
import { runWorkspaceCommand } from "./commands/workspaceCommand";

const CLI_USAGE = [
  "Usage:",
  "  vexb setup [repo] [--start-runtime] [--agent <name>] [--json]",
  "  vexb status [repo] [--agent <name>] [--json]",
  "  vexb doctor [repo] [--agent <name>] [--json]",
  "  vexb claude-config [repo] [--dry-run] [--agent <name>] [--json]",
  "  vexb daemon <start|stop|status|logs> [repo] [--json]",
  "  vexb workspace <init|add|list|status> ...",
  "  vexb mcp-serve --repo <repo>",
  "",
  "Core inspection commands:",
  "  vexb init <repo>",
  "  vexb index <repo>",
  "  vexb intent <repo> <query>",
  "  vexb capsule <repo> <query>",
  "  vexb run-pipeline <repo> <query> [--intent <auto|explore|debug|modify|refactor>] [--session-id ID]",
  "  vexb expand-vexp-ref <repo> <hash> [--query <query>] [--session-id ID]",
  "  vexb skeleton <repo> <file> [--detail <minimal|standard|detailed>]",
  "  vexb impact-graph <repo> <symbol-fqn> [--depth <n>] [--format <list|tree|mermaid>]",
  "  vexb handoff <repo> <query>",
  "  vexb runs <repo>",
  "  vexb check-capsule <repo> <manifest-id> <comparison-run-id>",
  "",
  "Repeated setup is safe. Supported shell agents: claude-code (default), codex. See README.md and docs/getting_started.md for setup, CLI usage, MCP reference, and the tool cheat sheet.",
].join("\n");

export async function runCli(
  argv: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const [command, ...args] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    return {
      exitCode: 0,
      stdout: `${CLI_USAGE}\n`,
      stderr: "",
    };
  }

  switch (command) {
    case "capsule":
      return runCapsuleCommand(args, options);
    case "check-capsule":
      return runCheckCapsuleCommand(args, options);
    case "claude-config":
      return runClaudeConfigCommand(args, options);
    case "handoff":
      return runHandoffCommand(args, options);
    case "daemon":
      return runDaemonCommand(args, options);
    case "daemon-runner":
      return runDaemonRunnerCommand(args, options);
    case "doctor":
      return runStatusCommand(args, options, "doctor");
    case "init":
      return runInitCommand(args, options);
    case "index":
      return runIndexCommand(args, options);
    case "intent":
      return runIntentCommand(args, options);
    case "impact-graph":
      return runImpactGraphCommand(args, options);
    case "inspect-file":
      return runInspectFileCommand(args, options);
    case "inspect-symbol":
      return runInspectSymbolCommand(args, options);
    case "mcp-serve":
      return runMcpServeCommand(args, options);
    case "runs":
      return runRunsCommand(args, options);
    case "run-pipeline":
      return runRunPipelineCommand(args, options);
    case "expand-vexp-ref":
      return runExpandVexpRefCommand(args, options);
    case "skeleton":
      return runSkeletonCommand(args, options);
    case "setup":
      return runSetupCommand(args, options);
    case "status":
      return runStatusCommand(args, options);
    case "workspace":
      return runWorkspaceCommand(args, options);
    default:
      return {
        exitCode: 1,
        stdout: "",
        stderr: `${CLI_USAGE}\n`,
      };
  }
}

if (import.meta.main) {
  installShutdownHandlers();

  const result = await runCli(process.argv.slice(2), {
    dbPath: process.env.VEXB_DB_PATH,
  });

  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }

  process.exit(result.exitCode);
}

function installShutdownHandlers(): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      process.exit(130);
    }
    shuttingDown = true;

    if (process.stderr.isTTY) {
      process.stderr.write(`\n${signal} received, aborting…\n`);
    }

    const exitCode = signal === "SIGINT" ? 130 : 143;
    setImmediate(() => process.exit(exitCode));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
