import { runMcpServerCli } from "../../mcp/startServer";
import type { CliOptions, CommandResult } from "../types";

export async function runMcpServeCommand(
  args: readonly string[],
  options: CliOptions = {},
): Promise<CommandResult> {
  const exitCode = await runMcpServerCli(args, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });

  void options;

  return {
    exitCode,
    stdout: "",
    stderr: "",
  };
}
