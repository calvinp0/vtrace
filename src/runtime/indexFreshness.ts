import { readGitHead } from "../fs/git";
import { captureRepoSourceSnapshot } from "../fs/scanRepo";
import type { LastIndexSnapshot, ObservedFileChangeState } from "../setup/types";

export type IndexFreshnessState = "fresh" | "possibly_stale" | "unknown";

export type IndexFreshnessReasonCode =
  | "last_index_metadata_missing_or_incomplete"
  | "current_source_snapshot_unavailable"
  | "indexed_source_file_count_differs"
  | "indexed_source_fingerprint_differs"
  | "file_changes_detected";

export interface IndexFreshnessReason {
  code: IndexFreshnessReasonCode;
  count?: number;
  firstChangedAtMs?: number;
  lastChangedAtMs?: number;
  changedFiles?: readonly string[];
}

export interface IndexFreshnessResult {
  state: IndexFreshnessState;
  isStale: boolean;
  summary: string;
  reasons: IndexFreshnessReason[];
  whyItMatters?: string;
  recommendedAction?: string;
  observedFileChanges: ObservedFileChangeState | null;
  snapshot: {
    lastIndexedAtMs: number | null;
    lastIndexedHead: string | null;
    lastIndexedSourceFileCount: number | null;
    lastIndexedSourceFingerprint: string | null;
  };
  currentHead: string | null;
  comparison: {
    currentSourceFileCount: number | null;
    fingerprintMatches: boolean | null;
  };
}

export async function inspectIndexFreshness(input: {
  repoRoot: string;
  lastIndexSnapshot?: LastIndexSnapshot;
  observedFileChanges?: ObservedFileChangeState;
}): Promise<IndexFreshnessResult> {
  const snapshot = input.lastIndexSnapshot;
  const observedFileChanges = input.observedFileChanges;

  if (!hasCompleteSnapshot(snapshot)) {
    return buildUnknownFreshness({
      snapshot,
      observedFileChanges,
      reasons: [
        { code: "last_index_metadata_missing_or_incomplete" },
        ...observedFreshnessReasons(observedFileChanges),
      ],
    });
  }

  const [currentHead, currentSourceSnapshot] = await Promise.all([
    readGitHead(input.repoRoot),
    readCurrentSourceSnapshot(input.repoRoot),
  ]);

  if (currentSourceSnapshot === undefined) {
    return buildUnknownFreshness({
      snapshot,
      currentHead,
      observedFileChanges,
      reasons: [
        { code: "current_source_snapshot_unavailable" },
        ...observedFreshnessReasons(observedFileChanges),
      ],
    });
  }

  const reasons: IndexFreshnessReason[] = [];
  const fingerprintMatches = currentSourceSnapshot.fingerprint === snapshot.lastIndexedSourceFingerprint;

  reasons.push(...observedFreshnessReasons(observedFileChanges));

  if (currentSourceSnapshot.fileCount !== snapshot.lastIndexedSourceFileCount) {
    reasons.push({ code: "indexed_source_file_count_differs" });
  }

  if (!fingerprintMatches) {
    reasons.push({ code: "indexed_source_fingerprint_differs" });
  }

  if (reasons.length === 0) {
    return {
      state: "fresh",
      isStale: false,
      summary: "The current repo appears consistent with the last indexed snapshot.",
      reasons,
      observedFileChanges: null,
      recommendedAction: "No re-index is recommended right now.",
      snapshot: buildSnapshotView(snapshot),
      currentHead: currentHead ?? null,
      comparison: {
        currentSourceFileCount: currentSourceSnapshot.fileCount,
        fingerprintMatches,
      },
    };
  }

  return {
    state: "possibly_stale",
    isStale: true,
    summary: observedFileChanges === undefined
      ? "Vtrace detected likely drift since the last indexed snapshot."
      : "Vtrace observed source file changes since the last indexed snapshot.",
    reasons,
    whyItMatters: "Retrieval, skeletons, impact graphs, and pipeline output may reflect older structure in changed areas.",
    recommendedAction: "Re-index this repo before relying on vtrace for fresh structural guidance.",
    observedFileChanges: observedFileChanges ?? null,
    snapshot: buildSnapshotView(snapshot),
    currentHead: currentHead ?? null,
    comparison: {
      currentSourceFileCount: currentSourceSnapshot.fileCount,
      fingerprintMatches,
    },
  };
}

function buildUnknownFreshness(input: {
  snapshot?: LastIndexSnapshot;
  currentHead?: string;
  observedFileChanges?: ObservedFileChangeState;
  reasons: IndexFreshnessReason[];
}): IndexFreshnessResult {
  return {
    state: "unknown",
    isStale: input.observedFileChanges !== undefined,
    summary: "Vtrace could not determine whether the current repo matches the last indexed snapshot.",
    reasons: input.reasons,
    whyItMatters: "Vtrace may still work, but freshness could not be verified.",
    recommendedAction: "Re-index if you want a fresh, explicit trust point.",
    observedFileChanges: input.observedFileChanges ?? null,
    snapshot: buildSnapshotView(input.snapshot),
    currentHead: input.currentHead ?? null,
    comparison: {
      currentSourceFileCount: null,
      fingerprintMatches: null,
    },
  };
}

function buildSnapshotView(
  snapshot?: LastIndexSnapshot,
): IndexFreshnessResult["snapshot"] {
  return {
    lastIndexedAtMs: snapshot?.lastIndexedAtMs ?? null,
    lastIndexedHead: snapshot?.lastIndexedHead ?? null,
    lastIndexedSourceFileCount: snapshot?.lastIndexedSourceFileCount ?? null,
    lastIndexedSourceFingerprint: snapshot?.lastIndexedSourceFingerprint ?? null,
  };
}

function hasCompleteSnapshot(
  snapshot?: LastIndexSnapshot,
): snapshot is LastIndexSnapshot & {
  lastIndexedSourceFileCount: number;
  lastIndexedSourceFingerprint: string;
} {
  return snapshot !== undefined
    && typeof snapshot.lastIndexedAtMs === "number"
    && typeof snapshot.lastIndexedSourceFileCount === "number"
    && typeof snapshot.lastIndexedSourceFingerprint === "string"
    && snapshot.lastIndexedSourceFingerprint.length > 0;
}

async function readCurrentSourceSnapshot(
  repoRoot: string,
) {
  try {
    return await captureRepoSourceSnapshot(repoRoot);
  } catch {
    return undefined;
  }
}

function observedFreshnessReasons(
  observedFileChanges: ObservedFileChangeState | undefined,
): IndexFreshnessReason[] {
  if (observedFileChanges === undefined) {
    return [];
  }

  return [{
    code: "file_changes_detected",
    count: observedFileChanges.changedFileCount,
    firstChangedAtMs: observedFileChanges.firstChangedAtMs,
    lastChangedAtMs: observedFileChanges.lastChangedAtMs,
    changedFiles: [...observedFileChanges.changedFiles],
  }];
}
