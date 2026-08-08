import type { EdgeCallSite, EdgeRecord } from "../domain/types";

/**
 * Attach one parser-observed occurrence to an edge, keeping the occurrence list
 * deduplicated and in source order.
 *
 * Edges are identified by (source, target, type), so repeated calls to the same
 * callee collapse into one edge. Recording each occurrence is what lets flow
 * evidence say "line 1724" and mean it, and what lets it say "and 2 more"
 * instead of silently presenting one site as the whole truth (M131).
 */
export function withCallSite(edge: EdgeRecord, site: EdgeCallSite): EdgeRecord {
  const existing = edge.callSites ?? [];

  if (existing.some((candidate) => sameSite(candidate, site))) {
    return edge;
  }

  return {
    ...edge,
    callSites: [...existing, site].sort(compareCallSites),
  };
}

export function compareCallSites(left: EdgeCallSite, right: EdgeCallSite): number {
  return left.startLine - right.startLine
    || left.startColumn - right.startColumn
    || left.endLine - right.endLine
    || left.endColumn - right.endColumn;
}

function sameSite(left: EdgeCallSite, right: EdgeCallSite): boolean {
  return compareCallSites(left, right) === 0 && left.precision === right.precision;
}
