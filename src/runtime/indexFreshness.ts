import { readGitHead } from "../fs/git";
import { captureRepoSourceSnapshot } from "../fs/scanRepo";
import type { IndexReadinessSummary } from "../indexer/indexReadiness";
import type {
  LastIndexSnapshot,
  ObservedFileChangeState,
  RepoFileWatcherState,
} from "../setup/types";

export type IndexFreshnessState = "fresh" | "possibly_stale" | "unknown";

export type IndexFreshnessReasonCode =
  | "last_index_metadata_missing_or_incomplete"
  | "current_source_snapshot_unavailable"
  | "indexed_source_file_count_differs"
  | "indexed_source_fingerprint_differs"
  | "file_changes_detected"
  // M141: runtime-compatibility causes. Source freshness alone never made an
  // index usable, but before M141 only the product tools knew that.
  | "index_schema_incompatible"
  | "index_capability_missing"
  | "index_repository_mismatch"
  | "index_worktree_mismatch"
  | "index_missing"
  | "index_unreadable";

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
  /**
   * The authoritative runtime-readiness verdict, when the caller supplied one.
   * `isStale` above is reconciled against it: a source-fresh snapshot backed by
   * an index this runtime cannot read is reported stale, not fresh.
   */
  readiness: IndexReadinessSummary | null;
  autoReindex: {
    enabled: boolean;
    state: NonNullable<RepoFileWatcherState["reindexState"]>;
    lastStartedAtMs: number | null;
    lastFinishedAtMs: number | null;
    lastFailedAtMs: number | null;
    lastError: string | null;
    pendingChangedFileCount: number;
    changedFiles: readonly string[];
  };
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
  fileWatcher?: RepoFileWatcherState;
  /**
   * M141: the authoritative readiness verdict from `evaluateIndexReadiness`.
   * Callers that omit it get the pre-M141 source-only view, which is why every
   * product surface now supplies it.
   */
  readiness?: IndexReadinessSummary;
}): Promise<IndexFreshnessResult> {
  const snapshot = input.lastIndexSnapshot;
  const observedFileChanges = input.observedFileChanges;
  const autoReindex = buildAutoReindexFreshness(input.fileWatcher, observedFileChanges);
  const readiness = input.readiness ?? null;

  if (!hasCompleteSnapshot(snapshot)) {
    return buildUnknownFreshness({
      snapshot,
      observedFileChanges,
      autoReindex,
      readiness,
      reasons: [
        { code: "last_index_metadata_missing_or_incomplete" },
        ...readinessReasons(readiness),
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
      autoReindex,
      readiness,
      reasons: [
        { code: "current_source_snapshot_unavailable" },
        ...readinessReasons(readiness),
        ...observedFreshnessReasons(observedFileChanges),
      ],
    });
  }

  const reasons: IndexFreshnessReason[] = [];
  const fingerprintMatches = currentSourceSnapshot.fingerprint === snapshot.lastIndexedSourceFingerprint;

  // Compatibility causes come first: they are the ones that make an otherwise
  // source-fresh index unusable, and they are what the product tools act on.
  reasons.push(...readinessReasons(readiness));
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
      readiness,
      autoReindex,
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
    summary: summarizeDrift(readiness, observedFileChanges),
    reasons,
    whyItMatters: "Retrieval, skeletons, impact graphs, and pipeline output may reflect older structure in changed areas.",
    recommendedAction: describeRecommendedAction(readiness),
    observedFileChanges: observedFileChanges ?? null,
    readiness,
    autoReindex,
    snapshot: buildSnapshotView(snapshot),
    currentHead: currentHead ?? null,
    comparison: {
      currentSourceFileCount: currentSourceSnapshot.fileCount,
      fingerprintMatches,
    },
  };
}

/**
 * Compatibility failures the source-snapshot comparison cannot see. Without
 * these, `index_status` reported `fresh / no rebuild needed` for an index the
 * next product request refused outright.
 */
function readinessReasons(readiness: IndexReadinessSummary | null): IndexFreshnessReason[] {
  if (readiness === null || readiness.ready) {
    return [];
  }
  switch (readiness.state) {
    case "schema_incompatible":
      return [{ code: "index_schema_incompatible" }];
    case "capability_incompatible":
      return [{ code: "index_capability_missing" }];
    case "repository_mismatch":
      return [{ code: "index_repository_mismatch" }];
    case "worktree_mismatch":
      return [{ code: "index_worktree_mismatch" }];
    case "index_missing":
      return [{ code: "index_missing" }];
    case "index_corrupt":
      return [{ code: "index_unreadable" }];
    case "source_stale":
      // Already expressed by the source-snapshot and watcher reasons, but the
      // readiness verdict must still force `isStale` when those miss it (for
      // example a HEAD move with no content change).
      return [{ code: "indexed_source_fingerprint_differs" }];
    default:
      return [];
  }
}

function summarizeDrift(
  readiness: IndexReadinessSummary | null,
  observedFileChanges: ObservedFileChangeState | undefined,
): string {
  if (readiness !== null && !readiness.ready && readiness.state !== "source_stale") {
    return `Vtrace cannot use the stored index: ${readiness.reason}.`;
  }
  return observedFileChanges === undefined
    ? "Vtrace detected likely drift since the last indexed snapshot."
    : "Vtrace observed source file changes since the last indexed snapshot.";
}

function describeRecommendedAction(readiness: IndexReadinessSummary | null): string {
  switch (readiness?.recommendedAction) {
    case "full_rebuild":
      return "Rebuild this repo's index (`index_repo` with mode `full`) before relying on vtrace.";
    case "unsupported_runtime_upgrade":
      return "This index was written by a newer vtrace; upgrade the runtime or rebuild the index.";
    case "inspect_index":
      return "The stored index belongs to a different repository or worktree; select the correct worktree.";
    default:
      return "Re-index this repo before relying on vtrace for fresh structural guidance.";
  }
}

function buildUnknownFreshness(input: {
  snapshot?: LastIndexSnapshot;
  currentHead?: string;
  observedFileChanges?: ObservedFileChangeState;
  readiness?: IndexReadinessSummary | null;
  autoReindex: IndexFreshnessResult["autoReindex"];
  reasons: IndexFreshnessReason[];
}): IndexFreshnessResult {
  const readiness = input.readiness ?? null;
  return {
    state: "unknown",
    isStale: input.observedFileChanges !== undefined || (readiness !== null && !readiness.ready),
    summary: "Vtrace could not determine whether the current repo matches the last indexed snapshot.",
    reasons: input.reasons,
    whyItMatters: "Vtrace may still work, but freshness could not be verified.",
    recommendedAction: readiness !== null && !readiness.ready
      ? describeRecommendedAction(readiness)
      : "Re-index if you want a fresh, explicit trust point.",
    observedFileChanges: input.observedFileChanges ?? null,
    readiness,
    autoReindex: input.autoReindex,
    snapshot: buildSnapshotView(input.snapshot),
    currentHead: input.currentHead ?? null,
    comparison: {
      currentSourceFileCount: null,
      fingerprintMatches: null,
    },
  };
}

function buildAutoReindexFreshness(
  watcher: RepoFileWatcherState | undefined,
  observedFileChanges: ObservedFileChangeState | undefined,
): IndexFreshnessResult["autoReindex"] {
  return {
    enabled: watcher?.autoReindexEnabled ?? false,
    state: watcher?.reindexState ?? (observedFileChanges === undefined ? "idle" : "pending_changes"),
    lastStartedAtMs: watcher?.lastAutoReindexStartedAtMs ?? null,
    lastFinishedAtMs: watcher?.lastAutoReindexFinishedAtMs ?? null,
    lastFailedAtMs: watcher?.lastAutoReindexFailedAtMs ?? null,
    lastError: watcher?.lastAutoReindexError ?? null,
    pendingChangedFileCount: observedFileChanges?.changedFileCount ?? watcher?.pendingChangedFileCount ?? 0,
    changedFiles: observedFileChanges?.changedFiles ?? watcher?.changedFiles ?? [],
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
