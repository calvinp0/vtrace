// Keeping vtrace's own generated state out of the user's commits.
//
// WHY THIS EXISTS
// ----------------
// Indexing a repository creates `<repo>/.vtrace/` and fills it with `index.sqlite`
// and `session.sqlite`. Nothing in the repository ignores that directory, so it is
// untracked-and-not-ignored — the one state in which `git add -A` sweeps it into
// the user's commit. An M154 probe reproduced exactly that in a plain checkout and
// in a linked worktree: `git add -n -A` reported both SQLite files. A tool that
// silently makes a working tree unsafe to stage is not safe to put in front of a
// coding agent, which stages far more casually than a human does.
//
// WHERE THE PATTERN HAS TO GO (measured, not assumed)
// ----------------
// In a linked worktree Git splits the directory in two, and only one half is read
// for exclusions:
//
//   $GIT_DIR         .git/worktrees/<name>   ← worktree-private. `info/exclude`
//                                              placed here is NEVER consulted.
//   $GIT_COMMON_DIR  .git                    ← shared. `info/exclude` here DOES
//                                              apply inside every linked worktree.
//
// Both were measured directly (M154-B probe); the worktree-private file had no
// effect on `git check-ignore` or on `git add -n -A`. So the authority is always
// `--git-common-dir`, and an implementation reaching for the more obvious
// `--git-dir` would do nothing in precisely the linked-worktree case that motivated
// this work. The patterns are root-anchored, so one shared line covers each
// worktree's own `.vtrace/` without leaking across them.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------
// It never touches a TRACKED file: not the repository's `.gitignore`, not any
// project source. It never touches global Git configuration. It writes one
// commented line to a local, untracked exclude file, and it writes nothing at all
// when some existing rule already covers the directory. When the repository tracks
// content under `.vtrace/`, it refuses and explains rather than quietly layering an
// ignore over a path the project deliberately versions.

import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { REPO_LOCAL_STATE_DIRNAME } from "./types";

const execFile = promisify(execFileCallback);

/** The comment vtrace owns. Only the line following it is ours to rewrite. */
export const GENERATED_STATE_EXCLUDE_COMMENT =
  "# vtrace: local index/session state (generated, not part of this project)";

export const GeneratedStateExclusionStatus = Object.freeze({
  /** vtrace appended its pattern to the local exclude file. */
  Established: "established",
  /** Some pre-existing rule already covers the directory; nothing was written. */
  AlreadyIgnored: "already_ignored",
  /** No Git metadata. Indexing proceeds; there is nothing that could stage it. */
  NotAGitRepository: "not_a_git_repository",
  /** The repository versions content under `.vtrace/`. Refused on purpose. */
  TrackedPathsPresent: "tracked_paths_present",
  /** Git is present but the exclude file could not be read or written. */
  Unavailable: "unavailable",
});

export type GeneratedStateExclusionStatus =
  (typeof GeneratedStateExclusionStatus)[keyof typeof GeneratedStateExclusionStatus];

export interface GeneratedStateExclusionResult {
  readonly status: GeneratedStateExclusionStatus;
  /** The root-anchored pattern, e.g. `/.vtrace/`. Null when nothing applies. */
  readonly pattern: string | null;
  /** Absolute path of the exclude file consulted or written. */
  readonly excludeFilePath: string | null;
  /** True only when bytes were actually written this call. Idempotence probe. */
  readonly wroteFile: boolean;
  /** Which rule already ignores the directory, as `git check-ignore -v` reports it. */
  readonly ignoredBy: string | null;
  /** Tracked paths under `.vtrace/`, bounded. Non-empty only when refusing. */
  readonly trackedPaths: readonly string[];
  /** Set whenever generated state remains stageable, so a caller can surface it. */
  readonly remediation: string | null;
}

/** Tracked paths named in a refusal. Enough to act on, never a full listing. */
const MAX_REPORTED_TRACKED_PATHS = 4;

/**
 * Make `<repoRoot>/.vtrace/` unstageable by ordinary `git add -A`, using only
 * local untracked Git state.
 *
 * Never throws and never fails an index: every failure mode degrades to a status
 * plus a `remediation` string. A repository that could not gain the exclusion is
 * still fully indexable — it just stages unsafely, which the caller reports.
 */
export async function ensureGeneratedStateExcluded(
  repoRoot: string,
): Promise<GeneratedStateExclusionResult> {
  const resolvedRepoRoot = path.resolve(repoRoot);

  const topLevel = await gitOutput(resolvedRepoRoot, ["rev-parse", "--show-toplevel"]);
  const commonDir = await gitOutput(resolvedRepoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);

  if (topLevel === undefined || commonDir === undefined) {
    return notAGitRepository();
  }

  // The pattern is anchored at the repository that would do the staging, which is
  // not always the directory being indexed: `detectRepoRoot` can settle on a
  // non-Git marker inside a larger checkout. Anchoring to the indexed directory's
  // position keeps one repository's rule from hiding another's files.
  const relativeFromTopLevel = path.relative(topLevel, resolvedRepoRoot);
  if (relativeFromTopLevel.startsWith("..") || path.isAbsolute(relativeFromTopLevel)) {
    return notAGitRepository();
  }

  const pattern = buildPattern(relativeFromTopLevel);
  const stateDirRelative = relativeFromTopLevel.length === 0
    ? REPO_LOCAL_STATE_DIRNAME
    : `${toPosix(relativeFromTopLevel)}/${REPO_LOCAL_STATE_DIRNAME}`;
  const excludeFilePath = path.join(commonDir, "info", "exclude");

  // A repository that versions something under `.vtrace/` has made a deliberate
  // choice. Layering an ignore over it would not untrack those files — Git ignores
  // nothing it already tracks — but it would change what `git add` does with new
  // siblings, silently, in a directory the project curates. Refuse and say so.
  const trackedPaths = await listTrackedPaths(resolvedRepoRoot, topLevel, stateDirRelative);
  if (trackedPaths.length > 0) {
    return {
      status: GeneratedStateExclusionStatus.TrackedPathsPresent,
      pattern: null,
      excludeFilePath,
      wroteFile: false,
      ignoredBy: null,
      trackedPaths,
      remediation:
        `This repository tracks ${trackedPaths.length} path(s) under ${stateDirRelative}/, so vtrace did not add an ignore rule for it. `
        + `vtrace's generated ${REPO_LOCAL_STATE_DIRNAME}/index.sqlite and ${REPO_LOCAL_STATE_DIRNAME}/session.sqlite can still be staged by \`git add -A\`. `
        + `Add the specific generated files to .gitignore, or exclude them locally in ${excludeFilePath}.`,
    };
  }

  const ignoredBy = await checkIgnoredBy(resolvedRepoRoot, `${REPO_LOCAL_STATE_DIRNAME}/index.sqlite`);
  if (ignoredBy !== undefined) {
    return {
      status: GeneratedStateExclusionStatus.AlreadyIgnored,
      pattern,
      excludeFilePath,
      wroteFile: false,
      ignoredBy,
      trackedPaths: [],
      remediation: null,
    };
  }

  const existing = await readTextFileIfPresent(excludeFilePath);
  if (existing === undefined) {
    return unavailable(excludeFilePath, pattern, "could not be read");
  }

  // Reached only when `check-ignore` says the directory is NOT ignored, so a
  // pattern line already sitting here would have to be inert. Honour it anyway
  // rather than appending a second copy: repeated indexing must not grow the file.
  if (containsPatternLine(existing, pattern)) {
    return {
      status: GeneratedStateExclusionStatus.AlreadyIgnored,
      pattern,
      excludeFilePath,
      wroteFile: false,
      ignoredBy: `${excludeFilePath}:${pattern}`,
      trackedPaths: [],
      remediation: null,
    };
  }

  const next = appendManagedBlock(existing, pattern);
  try {
    await writeFile(excludeFilePath, next);
  } catch {
    return unavailable(excludeFilePath, pattern, "is not writable");
  }

  return {
    status: GeneratedStateExclusionStatus.Established,
    pattern,
    excludeFilePath,
    wroteFile: true,
    ignoredBy: null,
    trackedPaths: [],
    remediation: null,
  };
}

/**
 * Append vtrace's block, preserving every existing byte ahead of it. Existing
 * content keeps its own formatting and comments; the only normalisation is the
 * newline that has to separate the last existing line from ours.
 */
function appendManagedBlock(existing: string, pattern: string): string {
  const block = `${GENERATED_STATE_EXCLUDE_COMMENT}\n${pattern}\n`;
  if (existing.length === 0) return block;
  return existing.endsWith("\n") ? `${existing}${block}` : `${existing}\n${block}`;
}

function containsPatternLine(content: string, pattern: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === pattern);
}

/**
 * `/.vtrace/` at a repository root; `/sub/dir/.vtrace/` when the indexed directory
 * sits below one. Leading slash anchors the rule so it cannot match a same-named
 * directory elsewhere in the tree, and the trailing slash keeps it to directories.
 */
function buildPattern(relativeFromTopLevel: string): string {
  const prefix = relativeFromTopLevel.length === 0 ? "" : `${toPosix(relativeFromTopLevel)}/`;
  return `/${prefix}${REPO_LOCAL_STATE_DIRNAME}/`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function notAGitRepository(): GeneratedStateExclusionResult {
  return {
    status: GeneratedStateExclusionStatus.NotAGitRepository,
    pattern: null,
    excludeFilePath: null,
    wroteFile: false,
    ignoredBy: null,
    trackedPaths: [],
    remediation: null,
  };
}

function unavailable(
  excludeFilePath: string,
  pattern: string,
  problem: string,
): GeneratedStateExclusionResult {
  return {
    status: GeneratedStateExclusionStatus.Unavailable,
    pattern,
    excludeFilePath,
    wroteFile: false,
    ignoredBy: null,
    trackedPaths: [],
    remediation:
      `${excludeFilePath} ${problem}, so vtrace could not exclude its generated state locally. `
      + `\`git add -A\` can stage ${REPO_LOCAL_STATE_DIRNAME}/. Add \`${pattern}\` to that file or to .gitignore.`,
  };
}

/** Paths Git tracks under the state directory, bounded. Empty for the normal case. */
async function listTrackedPaths(
  cwd: string,
  topLevel: string,
  stateDirRelative: string,
): Promise<readonly string[]> {
  const stdout = await gitOutput(cwd, [
    "-c",
    "core.quotepath=off",
    "ls-files",
    "--",
    path.join(topLevel, stateDirRelative),
  ]);
  if (stdout === undefined || stdout.length === 0) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_REPORTED_TRACKED_PATHS);
}

/**
 * The `git check-ignore -v` source line when `relativePath` is ignored, else
 * undefined. Reading the reason (rather than just the exit status) is what lets a
 * caller distinguish "the project ignores this" from "we ignored it ourselves".
 */
async function checkIgnoredBy(cwd: string, relativePath: string): Promise<string | undefined> {
  const stdout = await gitOutput(cwd, ["check-ignore", "-v", "--no-index", "--", relativePath]);
  if (stdout === undefined || stdout.length === 0) return undefined;
  return stdout.split("\n")[0]?.trim();
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", [...args], { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function readTextFileIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    return undefined;
  }
}
