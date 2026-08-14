// M145 Workstream C: which registered worktree owns a path that arrived as TEXT?
//
// WHY THIS REPLACES A BOOLEAN
// ----------------
// M144 asked one repository "could this path name a file here?" and a yes/no
// answer was enough, because there was only ever one repository to ask. In a
// workspace the same question has answers a boolean cannot express:
//
//   workspace/a/src/foo/bar.py
//   workspace/b/src/foo/bar.py     evidence: src/foo/bar.py
//
// Both repositories answer yes. A boolean forces the caller to pick one, and
// whichever tiebreak it invents — registration order, alias, shortest path — is
// a semantic decision dressed up as a lookup. M145 does not make that decision:
// ambiguity is a status, and it fails closed.
//
// WHAT THE STATUSES MEAN
// ----------------
//   exact             the hint is an absolute path INSIDE one worktree and names
//                     an indexed file there. Filesystem identity, no heuristic.
//   unique_resolved   the hint matches indexed files in exactly one worktree, on
//                     a path-segment boundary. Resolution, NOT identity: the
//                     reporter's `/Users/hwkns/test_requests.py` never existed on
//                     this machine, and M144's note applies unchanged — a match
//                     says "could name a file here", not "the author meant here".
//   ambiguous         two or more worktrees could own it. §30/§31: never pick.
//   external          nothing in the workspace could own it, and the hint named
//                     an absolute location — CPython's `httplib.py` under an
//                     interpreter prefix is the archetype.
//   unresolved        nothing matched and the hint was too weak to call external
//                     (a bare relative fragment names no location at all).
//
// WHAT A SUFFIX MATCH STILL CANNOT DO. Segment-boundary matching is an existence
// test over indexed paths. M144 recorded that `site-packages` cannot decide
// externality in either direction — `django-12774`'s frames run through an
// installed copy of the very repository under test — so no prefix stereotype
// appears here. The only thing that decides membership is whether a registered
// worktree actually indexes such a file.

import { normalizeFilePath } from "../domain/types";

export const PathMembershipStatus = Object.freeze({
  Exact: "exact",
  UniqueResolved: "unique_resolved",
  Ambiguous: "ambiguous",
  External: "external",
  Unresolved: "unresolved",
});

export type PathMembershipStatus =
  (typeof PathMembershipStatus)[keyof typeof PathMembershipStatus];

/**
 * How a path relates to the ONE worktree a request was routed to. Distinct from
 * the workspace-wide status because §100's case is real and must stay sayable:
 * a frame can be external to the selected repository while another registered
 * repository owns it, and M145 reports that without retrieving from there.
 */
export const SelectedPathMembership = Object.freeze({
  Member: "member",
  ExternalToSelected: "external_to_selected_repository",
  Ambiguous: "ambiguous",
  External: "external",
  Unresolved: "unresolved",
});

export type SelectedPathMembership =
  (typeof SelectedPathMembership)[keyof typeof SelectedPathMembership];

export interface PathMembershipScope {
  readonly worktreeId: string;
  readonly repositoryId: string;
  /** Display name for diagnostics only. Never an identity or a tiebreak. */
  readonly alias: string;
  readonly worktreeRoot: string;
  /** Read lazily: a task with no path evidence must not pay for a table scan. */
  readonly indexedPaths: () => readonly string[];
}

export interface PathMembershipMatch {
  readonly worktreeId: string;
  readonly repositoryId: string;
  readonly alias: string;
  readonly kind: "exact" | "suffix";
  /** Indexed paths in this worktree the hint could name. Bounded for reporting. */
  readonly matchedPaths: readonly string[];
}

export interface PathMembershipResolution {
  readonly status: PathMembershipStatus;
  /** The hint after shape normalization, as matched. */
  readonly normalizedHint: string;
  readonly matches: readonly PathMembershipMatch[];
  /** Set only when exactly one worktree matched. */
  readonly worktreeId: string | null;
  readonly selected: SelectedPathMembership;
}

/** Most matched paths reported per worktree. Diagnostics stay bounded (§103). */
const MAX_REPORTED_MATCHES = 4;

/** Strip drive letters, backslashes, `./` and leading `/` so shapes compare. */
export function normalizePathHint(pathHint: string): string {
  return normalizeFilePath(
    pathHint.replace(/\\/g, "/").replace(/^[A-Za-z]:\//, "").replace(/^\.\//, "").replace(/^\/+/, ""),
  );
}

/**
 * Do two paths name the same file, allowing either to carry extra leading
 * segments? Anchored on `/` in both directions, so `related.py` never matches
 * `unrelated.py` and `a/widgets.py` never matches `b/widgets.py`.
 */
export function pathsShareSuffixBoundary(left: string, right: string): boolean {
  const a = normalizePathHint(left);
  const b = normalizePathHint(right);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Did the hint name a location at all, or just a fragment of one? */
function namesAnAbsoluteLocation(pathHint: string): boolean {
  const raw = pathHint.trim().replace(/\\/g, "/");
  return raw.startsWith("/") || /^[A-Za-z]:\//.test(raw);
}

function lastSegment(value: string): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? value : value.slice(index + 1);
}

/**
 * A scope prepared for repeated lookups.
 *
 * The index is keyed on last path segment, which is a NECESSARY condition for a
 * segment-boundary match in either direction: if either path is a segment-suffix
 * of the other, their final segments are equal. So the bucket can never miss a
 * match the linear scan would have found, and §118's "for every path, for every
 * repository, scan every indexed file" never happens.
 */
interface PreparedScope {
  readonly scope: PathMembershipScope;
  readonly byLastSegment: () => Map<string, string[]>;
}

function prepareScope(scope: PathMembershipScope): PreparedScope {
  let index: Map<string, string[]> | undefined;
  return {
    scope,
    byLastSegment: (): Map<string, string[]> => {
      if (index === undefined) {
        index = new Map();
        for (const indexed of scope.indexedPaths()) {
          const key = lastSegment(normalizePathHint(indexed));
          const bucket = index.get(key);
          if (bucket === undefined) index.set(key, [indexed]);
          else bucket.push(indexed);
        }
      }
      return index;
    },
  };
}

export interface PathMembershipResolver {
  readonly resolve: (pathHint: string) => PathMembershipResolution;
  /** True once any scope's path list has actually been read — the §74 counter. */
  readonly materialized: () => boolean;
}

/**
 * Build a resolver over the registered scopes. `selectedWorktreeId` is the
 * worktree the request routed to; membership is still computed workspace-wide so
 * §100's "external to the selected repository, internal to another" is a
 * reportable fact rather than an invisible one.
 */
export function createPathMembershipResolver(
  scopes: readonly PathMembershipScope[],
  selectedWorktreeId?: string | null,
): PathMembershipResolver {
  const prepared = scopes.map(prepareScope);
  const cache = new Map<string, PathMembershipResolution>();
  let touched = false;

  const resolve = (pathHint: string): PathMembershipResolution => {
    const normalized = normalizePathHint(pathHint);
    const absolute = namesAnAbsoluteLocation(pathHint);
    const cacheKey = `${absolute ? "1" : "0"}\0${normalized}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const resolution = computeResolution(
      prepared,
      pathHint,
      normalized,
      absolute,
      selectedWorktreeId ?? null,
      () => { touched = true; },
    );
    cache.set(cacheKey, resolution);
    return resolution;
  };

  return { resolve, materialized: (): boolean => touched };
}

function computeResolution(
  prepared: readonly PreparedScope[],
  rawHint: string,
  normalized: string,
  absolute: boolean,
  selectedWorktreeId: string | null,
  markTouched: () => void,
): PathMembershipResolution {
  if (normalized.length === 0) {
    return {
      status: PathMembershipStatus.Unresolved,
      normalizedHint: normalized,
      matches: [],
      worktreeId: null,
      selected: SelectedPathMembership.Unresolved,
    };
  }

  const matches: PathMembershipMatch[] = [];
  for (const entry of prepared) {
    markTouched();
    const bucket = entry.byLastSegment().get(lastSegment(normalized));
    if (bucket === undefined || bucket.length === 0) continue;
    const matchedPaths = bucket.filter((indexed) => pathsShareSuffixBoundary(indexed, normalized));
    if (matchedPaths.length === 0) continue;

    matches.push({
      worktreeId: entry.scope.worktreeId,
      repositoryId: entry.scope.repositoryId,
      alias: entry.scope.alias,
      kind: isExactWithin(entry.scope, rawHint, absolute, matchedPaths) ? "exact" : "suffix",
      matchedPaths: matchedPaths.slice(0, MAX_REPORTED_MATCHES),
    });
  }

  const status = matches.length === 0
    ? (absolute ? PathMembershipStatus.External : PathMembershipStatus.Unresolved)
    : matches.length > 1
      ? PathMembershipStatus.Ambiguous
      : matches[0]!.kind === "exact"
        ? PathMembershipStatus.Exact
        : PathMembershipStatus.UniqueResolved;

  return {
    status,
    normalizedHint: normalized,
    matches,
    worktreeId: matches.length === 1 ? matches[0]!.worktreeId : null,
    selected: describeSelected(status, matches, selectedWorktreeId),
  };
}

/**
 * An absolute hint that lies INSIDE this worktree and names an indexed file is
 * filesystem-exact — no suffix reasoning was needed to reach it.
 */
function isExactWithin(
  scope: PathMembershipScope,
  rawHint: string,
  absolute: boolean,
  matchedPaths: readonly string[],
): boolean {
  // An empty root is the single-repository scope, which names no location and
  // therefore can never make a filesystem-exact claim.
  if (!absolute || scope.worktreeRoot.trim().length === 0) return false;
  const root = normalizePathHint(scope.worktreeRoot);
  const hint = normalizePathHint(rawHint);
  if (root.length === 0 || !hint.startsWith(`${root}/`)) return false;
  const relative = hint.slice(root.length + 1);
  return matchedPaths.some((indexed) => normalizePathHint(indexed) === relative);
}

function describeSelected(
  status: PathMembershipStatus,
  matches: readonly PathMembershipMatch[],
  selectedWorktreeId: string | null,
): SelectedPathMembership {
  if (status === PathMembershipStatus.Unresolved) return SelectedPathMembership.Unresolved;
  if (status === PathMembershipStatus.External) return SelectedPathMembership.External;
  if (selectedWorktreeId === null) {
    return status === PathMembershipStatus.Ambiguous
      ? SelectedPathMembership.Ambiguous
      : SelectedPathMembership.Member;
  }
  if (matches.some((match) => match.worktreeId === selectedWorktreeId)) {
    return SelectedPathMembership.Member;
  }
  // Another registered repository owns it. M145 says so and stops there: pulling
  // that repository's context into an A-routed answer is M146's question.
  return SelectedPathMembership.ExternalToSelected;
}
