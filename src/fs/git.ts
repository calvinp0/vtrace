import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { normalizeFilePath } from "../domain/types";

const execFile = promisify(execFileCallback);

export interface GitStatusEntry {
  status: string;
  path: string;
  originalPath?: string;
}

export async function readGitHead(
  repoRoot: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const head = stdout.trim();
    return head.length > 0 ? head : undefined;
  } catch {
    return undefined;
  }
}

export async function listGitStatusEntries(
  repoRoot: string,
): Promise<GitStatusEntry[] | undefined> {
  try {
    const { stdout } = await execFile(
      "git",
      ["-c", "core.quotepath=off", "status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    return parseGitStatusEntries(stdout);
  } catch {
    return undefined;
  }
}

function parseGitStatusEntries(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (line.length < 3) {
      continue;
    }

    const status = line.slice(0, 2);
    const pathPart = line.slice(3);

    if (status.includes("R") || status.includes("C")) {
      const separatorIndex = pathPart.indexOf(" -> ");

      if (separatorIndex === -1) {
        entries.push({
          status,
          path: normalizeFilePath(pathPart),
        });
        continue;
      }

      entries.push({
        status,
        originalPath: normalizeFilePath(pathPart.slice(0, separatorIndex)),
        path: normalizeFilePath(pathPart.slice(separatorIndex + 4)),
      });
      continue;
    }

    entries.push({
      status,
      path: normalizeFilePath(pathPart),
    });
  }

  return entries;
}
