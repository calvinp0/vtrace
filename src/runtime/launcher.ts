import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LauncherCommand {
  command: string;
  args: string[];
}

export function resolveVexbRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(modulePath), "..", "..");
}

export function resolveStableLauncherPath(): string {
  return path.join(resolveVexbRoot(), "bin", "vexb");
}

export function buildStableMcpLauncher(repoRoot: string): LauncherCommand {
  return {
    command: "bash",
    args: [
      resolveStableLauncherPath(),
      "mcp-serve",
      "--repo",
      path.resolve(repoRoot),
    ],
  };
}

export function buildDaemonRunnerLauncher(repoRoot: string): LauncherCommand {
  return {
    command: "bash",
    args: [
      resolveStableLauncherPath(),
      "daemon-runner",
      "--repo",
      path.resolve(repoRoot),
    ],
  };
}
