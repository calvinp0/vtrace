// Test-only fixtures for M145 workspace identity work.
//
// The collision cases are the point of the milestone, so the builders make them
// easy to construct deliberately: two repositories with the same relative paths,
// the same symbol names, the same directory basename, or byte-identical content
// at the same commit. None of those may let one repository answer for another.

import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  WORKSPACE_CONFIG_SCHEMA_VERSION,
  writeWorkspaceConfig,
  type ResolvedWorkspaceConfig,
  type WorkspaceRepoConfig,
} from "./config";
import { captureRepoIdentityRecord } from "./registry";

const execFile = promisify(execFileCallback);

const GIT_IDENTITY = [
  "-c", "user.email=m145@test",
  "-c", "user.name=m145",
  "-c", "commit.gpgsign=false",
] as const;

export interface FixtureRepoOptions {
  /** Relative path -> file contents. Defaults to one `src/utils.py`. */
  readonly files?: Readonly<Record<string, string>>;
  /** Skip `git init`, producing a plain directory with path-only identity. */
  readonly withoutGit?: boolean;
}

const roots: string[] = [];

export async function makeWorkspaceRoot(prefix = "m145-ws-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export async function cleanupWorkspaceFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function makeFixtureRepo(
  repoRoot: string,
  options: FixtureRepoOptions = {},
): Promise<string> {
  const files = options.files ?? { "src/utils.py": "def parse():\n    return 1\n" };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(repoRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  if (options.withoutGit !== true) {
    await execFile("git", ["init", "-q", "-b", "main", repoRoot]);
    await execFile("git", ["-C", repoRoot, "add", "-A"]);
    await execFile("git", ["-C", repoRoot, ...GIT_IDENTITY, "commit", "-qm", "init"]);
  }
  return repoRoot;
}

/** A linked worktree of `repoRoot`: same repository, different working tree. */
export async function addSiblingWorktree(
  repoRoot: string,
  worktreePath: string,
  branch = "sibling",
): Promise<string> {
  await execFile("git", ["-C", repoRoot, "worktree", "add", "-q", "-b", branch, worktreePath]);
  return worktreePath;
}

/** An independent clone: same lineage and same HEAD, different repository. */
export async function cloneFixtureRepo(source: string, destination: string): Promise<string> {
  await execFile("git", ["clone", "-q", source, destination]);
  return destination;
}

/** A byte-for-byte directory copy, Git metadata included. */
export async function copyFixtureRepo(source: string, destination: string): Promise<string> {
  await cp(source, destination, { recursive: true });
  return destination;
}

export async function gitOutput(repoRoot: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoRoot, ...GIT_IDENTITY, ...args]);
  return stdout.trim();
}

/**
 * Write a workspace config registering `repos` in the given ORDER, capturing
 * each entry's identity exactly as `vtrace workspace add` would. Order is a
 * parameter because §91 requires proving it does not matter.
 */
export async function writeFixtureWorkspace(input: {
  readonly configPath: string;
  readonly repos: readonly { alias: string; rootPath: string; enabled?: boolean }[];
  readonly primaryRepoAlias?: string;
  /** Omit recorded identity, reproducing a pre-M145 workspace file. */
  readonly withoutIdentity?: boolean;
}): Promise<ResolvedWorkspaceConfig> {
  const repos: WorkspaceRepoConfig[] = [];
  for (const repo of input.repos) {
    repos.push({
      alias: repo.alias,
      rootPath: repo.rootPath,
      enabled: repo.enabled !== false,
      ...(input.withoutIdentity === true ? {} : await captureRepoIdentityRecord(repo.rootPath)),
    });
  }

  return writeWorkspaceConfig(input.configPath, {
    schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
    primaryRepoAlias: input.primaryRepoAlias ?? repos[0]!.alias,
    repos,
  });
}
