// Nested linked-worktree exclusion for repository enumeration.
//
// WHY THIS EXISTS
// ----------------
// Git linked worktrees are ordinary directories on disk. When one is created
// BENEATH the checkout it was linked from — `ARC/feature_docker_ux`,
// `ARC/.claude/worktrees/<agent>` — the parent scan descends into it and indexes
// a second, complete copy of the same repository. Retrieval then selects the same
// logical symbol twice under two paths and downstream reasoning reads that as two
// architectural modules ("a fix that crosses file boundaries"). The conclusion is
// fabricated from an indexing artifact; the two paths are one repository.
//
// A name blocklist cannot fix this: worktree directories are named by whoever
// created them. The authoritative source is Git's own worktree registry, which
// every linked worktree is recorded in and no submodule or unrelated nested
// repository ever appears in.
//
// POLICY (deliberate, see the M132 audit)
// ----------------
// - registered linked worktree strictly beneath the requested root -> EXCLUDED.
// - the requested root itself -> never excluded, even though it is registered.
// - submodule -> UNCHANGED. Its `.git` file points into `<super>/.git/modules/...`
//   and it is absent from `git worktree list`, so this rule never sees it.
// - unregistered nested Git repository (a plain clone dropped inside) -> UNCHANGED
//   for the same reason. Excluding those is a separate policy question with its
//   own evidence requirement.
//
// Exclusion is keyed on repo-relative POSIX directory paths so the scanner can
// test membership with a Set lookup per directory, and so a symlinked root cannot
// produce two spellings of the same worktree.

import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** One registered worktree root, as reported by `git worktree list --porcelain`. */
export interface RegisteredWorktree {
  /** Canonical absolute path of the worktree root. */
  readonly root: string;
  /** Repo-relative POSIX path from the requested root, when it is a descendant. */
  readonly relativePath: string | null;
  /** True when this entry IS the requested root. */
  readonly isRequestedRoot: boolean;
  /** True when this entry lies strictly beneath the requested root. */
  readonly isNested: boolean;
}

/**
 * The exclusion decision for one requested root. `excludedRelativeDirs` holds
 * normalized repo-relative POSIX directory paths; the scanner tests each
 * directory it is about to descend into against this set.
 */
export interface WorktreeExclusionSet {
  /** Canonical absolute path the exclusions are relative to. */
  readonly root: string;
  /** Repo-relative POSIX directories to skip entirely. Sorted, de-duplicated. */
  readonly excludedRelativeDirs: ReadonlySet<string>;
  /** Every registered worktree Git reported, for diagnostics. */
  readonly registered: readonly RegisteredWorktree[];
  /** True when Git answered; false for non-Git roots or a failed/absent Git. */
  readonly gitAvailable: boolean;
}

export const EMPTY_WORKTREE_EXCLUSIONS: WorktreeExclusionSet = Object.freeze({
  root: "",
  excludedRelativeDirs: new Set<string>(),
  registered: [],
  gitAvailable: false,
});

/** Compact diagnostics shape for indexing/routing observability. */
export interface WorktreeExclusionDiagnostics {
  readonly nestedWorktreesDiscovered: number;
  readonly nestedWorktreesExcluded: number;
  readonly excludedPathsCount: number;
  /** Repo-relative paths only — never machine-specific absolute paths. */
  readonly excludedRelativePaths: readonly string[];
}

export function summarizeWorktreeExclusions(
  exclusions: WorktreeExclusionSet,
): WorktreeExclusionDiagnostics {
  const excluded = [...exclusions.excludedRelativeDirs].sort();
  return {
    nestedWorktreesDiscovered: exclusions.registered.filter((entry) => entry.isNested).length,
    nestedWorktreesExcluded: excluded.length,
    excludedPathsCount: excluded.length,
    excludedRelativePaths: excluded,
  };
}

/**
 * Discover the registered linked worktrees nested beneath `repoRoot` and build the
 * exclusion set for a scan of that root. One `git worktree list` per call — never
 * per directory. A non-Git root, a missing `git`, or any Git failure yields an
 * empty exclusion set: enumeration must degrade to today's behaviour, never fail.
 */
export async function resolveWorktreeExclusions(
  repoRoot: string,
): Promise<WorktreeExclusionSet> {
  const root = await canonicalPath(repoRoot);
  const roots = await listRegisteredWorktreeRoots(root);

  if (roots === undefined) {
    return { root, excludedRelativeDirs: new Set(), registered: [], gitAvailable: false };
  }

  const registered: RegisteredWorktree[] = [];
  const excludedRelativeDirs = new Set<string>();

  for (const raw of roots) {
    const canonical = await canonicalPath(raw);
    const isRequestedRoot = canonical === root;
    const relativePath = isRequestedRoot ? null : relativeDescendantPath(root, canonical);
    const isNested = !isRequestedRoot && relativePath !== null;

    registered.push({ root: canonical, relativePath, isRequestedRoot, isNested });

    if (isNested && relativePath !== null) {
      excludedRelativeDirs.add(relativePath);
    }
  }

  registered.sort((left, right) => left.root.localeCompare(right.root));

  return { root, excludedRelativeDirs, registered, gitAvailable: true };
}

/**
 * True when `relativeDir` (a repo-relative POSIX directory path) is an excluded
 * nested worktree root. Only the root itself is tested: the scanner never
 * descends past it, so its children are unreachable by construction.
 */
export function isExcludedWorktreeDirectory(
  exclusions: WorktreeExclusionSet,
  relativeDir: string,
): boolean {
  if (exclusions.excludedRelativeDirs.size === 0) return false;
  return exclusions.excludedRelativeDirs.has(normalizeRelative(relativeDir));
}

/**
 * True when `relativePath` lies inside any excluded nested worktree. Used by
 * consumers that receive already-collected paths (a previous index snapshot, a
 * Git status entry) rather than walking the tree themselves.
 */
export function isPathInsideExcludedWorktree(
  exclusions: WorktreeExclusionSet,
  relativePath: string,
): boolean {
  if (exclusions.excludedRelativeDirs.size === 0) return false;
  const normalized = normalizeRelative(relativePath);
  for (const excluded of exclusions.excludedRelativeDirs) {
    if (normalized === excluded || normalized.startsWith(`${excluded}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * The repo-relative POSIX path of `candidate` under `root`, or null when it is
 * not a STRICT descendant. Segment-aware: `/code/ARC.worktrees/x` is not under
 * `/code/ARC` even though the string prefix matches, and `..` never escapes.
 */
export function relativeDescendantPath(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (relative.length === 0) return null;
  if (path.isAbsolute(relative)) return null;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return normalizeRelative(relative);
}

/**
 * A stable fingerprint of the nested-worktree topology, over repo-relative paths
 * only. Two checkouts of the same repository at different absolute locations
 * produce the same fingerprint, so it can be compared across machines and is safe
 * to place in a semantic hash.
 */
export function computeWorktreeTopologyFingerprint(
  exclusions: WorktreeExclusionSet,
): string {
  return [...exclusions.excludedRelativeDirs].sort().join("\n");
}

async function listRegisteredWorktreeRoots(
  cwd: string,
): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFile("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      // A repository with hundreds of worktrees still produces tens of KB; the
      // default 1 MB buffer is ample, but be explicit rather than truncate.
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseWorktreePorcelain(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Parse `git worktree list --porcelain`. Records are separated by blank lines and
 * begin with a `worktree <absolute path>` line; every other attribute line is
 * ignored here. Exported for direct testing against captured Git output.
 */
export function parseWorktreePorcelain(stdout: string): string[] {
  const roots: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.startsWith("worktree ")) continue;
    const value = rawLine.slice("worktree ".length).trim();
    if (value.length > 0) roots.push(value);
  }
  return roots;
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

async function canonicalPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}
