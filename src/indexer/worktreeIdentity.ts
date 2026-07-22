import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { listGitStatusEntries } from "../fs/git";
import { hashFile } from "../fs/hashFile";
import { isRecognizedRepoSourcePath } from "../fs/scanRepo";

const execFile = promisify(execFileCallback);

export interface RepositoryIdentity {
  readonly gitCommonDir: string | null;
  readonly repositoryId: string;
  readonly isGitRepository: boolean;
}

export interface WorktreeIdentity {
  readonly repositoryId: string;
  readonly worktreeRoot: string;
  readonly worktreeGitDir: string | null;
  readonly worktreeId: string;
  readonly isGitWorktree: boolean;
}

export interface WorktreeSnapshot {
  readonly headCommit: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly dirtyFingerprint: string | null;
}

export interface ResolvedWorktreeIdentity {
  readonly repository: RepositoryIdentity;
  readonly worktree: WorktreeIdentity;
  readonly snapshot: WorktreeSnapshot;
}

export class WorktreeResolutionError extends Error {
  readonly code = "not_git_worktree";

  constructor(root: string) {
    super(`Cannot resolve a Git worktree at ${root}`);
    this.name = "WorktreeResolutionError";
  }
}

export async function resolveWorktreeIdentity(repoRoot: string): Promise<ResolvedWorktreeIdentity> {
  const requestedRoot = await canonicalPath(repoRoot);
  let topLevel: string;
  let gitDir: string;
  let commonDir: string;

  try {
    [topLevel, gitDir, commonDir] = await Promise.all([
      gitOutput(requestedRoot, ["rev-parse", "--show-toplevel"]),
      gitOutput(requestedRoot, ["rev-parse", "--absolute-git-dir"]),
      gitOutput(requestedRoot, ["rev-parse", "--git-common-dir"]),
    ]);
  } catch {
    const repositoryId = stableId("non-git-repository", requestedRoot);
    return {
      repository: { gitCommonDir: null, repositoryId, isGitRepository: false },
      worktree: {
        repositoryId,
        worktreeRoot: requestedRoot,
        worktreeGitDir: null,
        worktreeId: stableId("non-git-worktree", requestedRoot),
        isGitWorktree: false,
      },
      snapshot: {
        headCommit: null,
        branch: null,
        detached: false,
        dirty: false,
        dirtyFingerprint: null,
      },
    };
  }

  const worktreeRoot = await canonicalPath(topLevel);
  const worktreeGitDir = await canonicalPath(resolveGitPath(worktreeRoot, gitDir));
  const gitCommonDir = await canonicalPath(resolveGitPath(worktreeRoot, commonDir));
  const repositoryId = stableId("repository", gitCommonDir);
  const worktreeId = stableId("worktree", `${gitCommonDir}\0${worktreeRoot}`);
  const [headCommit, branch, dirtyState] = await Promise.all([
    gitOutputOrNull(worktreeRoot, ["rev-parse", "HEAD"]),
    gitOutputOrNull(worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    computeDirtyFingerprint(worktreeRoot),
  ]);

  return {
    repository: { gitCommonDir, repositoryId, isGitRepository: true },
    worktree: { repositoryId, worktreeRoot, worktreeGitDir, worktreeId, isGitWorktree: true },
    snapshot: {
      headCommit,
      branch,
      detached: branch === null,
      dirty: dirtyState !== null,
      dirtyFingerprint: dirtyState,
    },
  };
}

/**
 * Fingerprint only dirty paths relevant to VTRACE's source scanner. Git status
 * supplies staged/unstaged/delete/rename state; current content hashes make a
 * second edit distinguishable without depending on mtimes. Ignored paths never
 * appear, and non-indexable files are excluded.
 */
export async function computeDirtyFingerprint(repoRoot: string): Promise<string | null> {
  const entries = await listGitStatusEntries(repoRoot);
  if (entries === undefined) {
    return null;
  }

  const relevant = entries.filter((entry) => (
    isRecognizedRepoSourcePath(entry.path)
    || (entry.originalPath !== undefined && isRecognizedRepoSourcePath(entry.originalPath))
  ));
  if (relevant.length === 0) {
    return null;
  }

  relevant.sort((left, right) => (
    `${left.originalPath ?? ""}\0${left.path}\0${left.status}`
      .localeCompare(`${right.originalPath ?? ""}\0${right.path}\0${right.status}`)
  ));
  const digest = createHash("sha256");
  for (const entry of relevant) {
    digest.update(entry.status);
    digest.update("\0");
    digest.update(entry.originalPath ?? "");
    digest.update("\0");
    digest.update(entry.path);
    digest.update("\0");
    try {
      digest.update(await hashFile(path.join(repoRoot, entry.path)));
    } catch {
      digest.update("<missing>");
    }
    digest.update("\n");
  }
  return digest.digest("hex");
}

async function canonicalPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function resolveGitPath(worktreeRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(worktreeRoot, value);
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", [...args], { cwd, encoding: "utf8" });
  const result = stdout.trim();
  if (result.length === 0) {
    throw new Error(`git ${args.join(" ")} returned no output`);
  }
  return result;
}

async function gitOutputOrNull(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await gitOutput(cwd, args);
  } catch {
    return null;
  }
}

function stableId(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex").slice(0, 24);
}
