import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { listGitStatusEntries } from "../fs/git";
import { hashFile } from "../fs/hashFile";
import { isRecognizedRepoSourcePath } from "../fs/scanRepo";

const execFile = promisify(execFileCallback);

/**
 * Instance-fingerprint algorithm tag. Comparisons are only made between equal
 * tags, so a future algorithm never silently reinterprets an older value.
 */
const INSTANCE_FINGERPRINT_VERSION = "fs1" as const;

export interface RepositoryIdentity {
  readonly gitCommonDir: string | null;
  readonly repositoryId: string;
  readonly isGitRepository: boolean;
  /**
   * Which physical Git object store currently sits at `gitCommonDir` (M145).
   *
   * `repositoryId` is a hash of that PATH, so it answers "which location" and
   * not "which repository": deleting a clone and putting an unrelated one at the
   * same path yields an identical `repositoryId`. Measured, not assumed — the
   * M145-A probe recorded `sameRepository=true, sameWorktree=true` across
   * exactly that replacement.
   *
   * The fingerprint is filesystem instance evidence about the common dir, so a
   * replacement is a different directory and reads differently, while a moved
   * checkout keeps its inode and stays the same repository. `null` outside Git,
   * where no such evidence exists; two `null`s are never a match.
   */
  readonly instanceFingerprint: string | null;
}

export interface WorktreeIdentity {
  readonly repositoryId: string;
  readonly worktreeRoot: string;
  readonly worktreeGitDir: string | null;
  readonly worktreeId: string;
  readonly isGitWorktree: boolean;
  /**
   * The same evidence for THIS worktree's own git dir. Sibling worktrees share a
   * common dir and therefore a repository fingerprint, but each linked worktree
   * has its own `.git/worktrees/<name>` directory and its own fingerprint.
   */
  readonly instanceFingerprint: string | null;
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
      repository: {
        gitCommonDir: null,
        repositoryId,
        isGitRepository: false,
        instanceFingerprint: null,
      },
      worktree: {
        repositoryId,
        worktreeRoot: requestedRoot,
        worktreeGitDir: null,
        worktreeId: stableId("non-git-worktree", requestedRoot),
        isGitWorktree: false,
        instanceFingerprint: null,
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
  const [headCommit, branch, dirtyState, repositoryInstance, worktreeInstance] = await Promise.all([
    gitOutputOrNull(worktreeRoot, ["rev-parse", "HEAD"]),
    gitOutputOrNull(worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    computeDirtyFingerprint(worktreeRoot),
    resolveInstanceFingerprint(gitCommonDir),
    resolveInstanceFingerprint(worktreeGitDir),
  ]);

  return {
    repository: {
      gitCommonDir,
      repositoryId,
      isGitRepository: true,
      instanceFingerprint: repositoryInstance,
    },
    worktree: {
      repositoryId,
      worktreeRoot,
      worktreeGitDir,
      worktreeId,
      isGitWorktree: true,
      instanceFingerprint: worktreeInstance,
    },
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

/**
 * Filesystem instance evidence for a Git directory: which device, which inode,
 * and when that directory was created. Creation time disambiguates the one case
 * inode numbers cannot — a freed inode reused by a later directory at the same
 * path — and is dropped when the filesystem does not record it rather than
 * being faked as 0.
 *
 * ~0.007 ms per call (M145-A measurement), so this is affordable on the identity
 * path that already spends three Git subprocesses.
 */
export async function resolveInstanceFingerprint(gitDir: string | null): Promise<string | null> {
  if (gitDir === null) return null;
  try {
    const stats = await stat(gitDir);
    const birth = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
      ? String(Math.round(stats.birthtimeMs))
      : "-";
    return `${INSTANCE_FINGERPRINT_VERSION}:${stats.dev}:${stats.ino}:${birth}`;
  } catch {
    return null;
  }
}

/**
 * Does instance evidence CONTRADICT a match? Three-valued on purpose.
 *
 * `null` means "no claim": one side predates the fingerprint, or the root is not
 * a Git worktree. M132 settled the policy for exactly this shape — an artifact
 * that makes no claim must not be read as making a failing one — so a missing
 * fingerprint can never manufacture a mismatch, and two missing fingerprints are
 * not evidence of sameness either.
 */
export function compareInstanceFingerprints(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean | null {
  if (typeof left !== "string" || typeof right !== "string") return null;
  if (!left.startsWith(`${INSTANCE_FINGERPRINT_VERSION}:`) || !right.startsWith(`${INSTANCE_FINGERPRINT_VERSION}:`)) {
    return null;
  }
  return left === right;
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
