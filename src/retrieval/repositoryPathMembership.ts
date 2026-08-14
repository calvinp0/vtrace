// Repository membership for a path that arrived as TEXT (M144).
//
// WHY THIS EXISTS
// ----------------
// A task can name a file in several shapes that all mean the same file, and in
// several more that mean a file this repository has never contained:
//
//   ./sympy/core/evalf.py                                    repo-relative
//   \path\to\site-packages\sphinx\domains\python.py          Windows, installed
//   /app/venv/lib/python3.8/site-packages/django/db/…/query.py   installed copy
//   /usr/lib/python3.10/sre_parse.py                         standard library
//   /Users/hwkns/test_requests.py                            the reporter's laptop
//
// The first three name code that IS in the repository; the last two do not. No
// prefix rule separates them — `site-packages` appears in both a project's own
// installed copy and an unrelated dependency — so membership is decided by
// matching against the indexed file list on a path-SEGMENT boundary.
//
// That boundary is the same rule the benchmark harness uses to compare gold
// paths, and M143 recorded what happens without it: comparing repo-relative and
// workspace-relative paths literally scored three correct leads as wrong and
// inverted a milestone's conclusion. One rule, one place.
//
// NOTE ON WHAT THIS CANNOT DO. A segment-boundary match is an existence test,
// not proof of identity: `/Users/hwkns/test_requests.py` is a file on the
// reporter's machine that happens to share its full last segment with the
// repository's own `test_requests.py`, and this returns true for it. Membership
// answers "could this path name a file here", which is the right question for
// REJECTING foreign frames; it is not a licence to treat the match as the
// author's intent.
//
// M145 (§97). The rule now lives in `src/workspace/pathMembership.ts`, which
// answers for a set of registered worktrees and distinguishes a unique
// resolution from an ambiguous one. This module is the single-repository view of
// that resolver, and the collapse is exact rather than approximate: with one
// scope `ambiguous` cannot arise, and `exact` implies a suffix match, so
// `exact | unique_resolved` is precisely the set the M144 boolean called true.

import type { Database } from "bun:sqlite";

import { listAllFilePaths } from "../db/repositories/filesRepository";
import {
  createPathMembershipResolver,
  PathMembershipStatus,
  normalizePathHint,
  pathsShareSuffixBoundary,
  type PathMembershipScope,
} from "../workspace/pathMembership";

export { normalizePathHint, pathsShareSuffixBoundary };

/** The single-repository scope M144's callers imply: one unnamed worktree. */
function singleRepositoryScope(indexedPaths: () => readonly string[]): PathMembershipScope {
  return {
    worktreeId: "active",
    repositoryId: "active",
    alias: "active",
    worktreeRoot: "",
    indexedPaths,
  };
}

/** Membership predicate over an already-materialized indexed path list. */
export function createRepositoryPathPredicate(
  indexedPaths: readonly string[],
): (pathHint: string) => boolean {
  const resolver = createPathMembershipResolver([singleRepositoryScope(() => indexedPaths)]);
  return (pathHint: string): boolean => isMember(resolver.resolve(pathHint).status);
}

function isMember(status: PathMembershipStatus): boolean {
  return status === PathMembershipStatus.Exact || status === PathMembershipStatus.UniqueResolved;
}

/**
 * The same predicate, but the indexed path list is read on FIRST USE.
 *
 * Most tasks carry no traceback path at all (44 of the frozen 50), and a task
 * with nothing to resolve must not pay for a table scan to learn that — §74's
 * "no additional queries when there is no evidence" is a property of the
 * capability, not an aspiration.
 */
export function createLazyRepositoryPathPredicate(
  db: Database,
  counters?: { queries: number },
): RepositoryPathAccess {
  let paths: readonly string[] | undefined;
  const indexedPaths = (): readonly string[] => {
    if (paths === undefined) {
      paths = listAllFilePaths(db);
      if (counters !== undefined) counters.queries += 1;
    }
    return paths;
  };
  const resolver = createPathMembershipResolver([singleRepositoryScope(indexedPaths)]);
  return {
    isRepositoryPath: (pathHint: string): boolean => isMember(resolver.resolve(pathHint).status),
    indexedPaths,
    /** True once the path list has actually been read — the §74 counter. */
    materialized: (): boolean => paths !== undefined,
  };
}

export interface RepositoryPathAccess {
  readonly isRepositoryPath: (pathHint: string) => boolean;
  /** The indexed path list, read once and shared with other consumers. */
  readonly indexedPaths: () => readonly string[];
  readonly materialized: () => boolean;
}
