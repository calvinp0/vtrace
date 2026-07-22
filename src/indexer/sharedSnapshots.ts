import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FileRecord } from "../domain/types";
import { isValidSnapshotSet, type IndexedFileSnapshotSet } from "./incrementalIndex";
import { resolveRepositoryParseCacheRoot } from "./parseCache";
import type { ResolvedWorktreeIdentity } from "./worktreeIdentity";

export interface ReusableSnapshotRecord {
  readonly schemaVersion: 1;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreeRoot: string;
  readonly headCommit: string | null;
  readonly parserVersion: string;
  readonly parserConfigFingerprint: string;
  readonly snapshot: IndexedFileSnapshotSet;
}

export async function recordReusableSnapshot(
  identity: ResolvedWorktreeIdentity,
  record: Omit<ReusableSnapshotRecord, "schemaVersion" | "repositoryId" | "worktreeId" | "worktreeRoot" | "headCommit">,
): Promise<void> {
  const value: ReusableSnapshotRecord = {
    schemaVersion: 1,
    repositoryId: identity.repository.repositoryId,
    worktreeId: identity.worktree.worktreeId,
    worktreeRoot: identity.worktree.worktreeRoot,
    headCommit: identity.snapshot.headCommit,
    ...record,
  };
  const directory = snapshotsRoot(identity);
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${identity.worktree.worktreeId}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, destination);
}

export async function selectReusableSnapshot(input: {
  readonly identity: ResolvedWorktreeIdentity;
  readonly currentFiles: readonly FileRecord[];
  readonly parserVersion: string;
  readonly parserConfigFingerprint: string;
}): Promise<ReusableSnapshotRecord | undefined> {
  let names: string[];
  try {
    names = (await readdir(snapshotsRoot(input.identity))).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return undefined;
  }
  const currentByPath = new Map(input.currentFiles.map((file) => [file.path, file.contentHash]));
  const candidates: Array<{ record: ReusableSnapshotRecord; exactHead: boolean; shared: number }> = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await readFile(path.join(snapshotsRoot(input.identity), name), "utf8")) as ReusableSnapshotRecord;
      if (!isReusableRecord(record, input)) continue;
      const shared = record.snapshot.files.reduce((count, file) => count + (currentByPath.get(file.relativePath) === file.contentHash ? 1 : 0), 0);
      candidates.push({ record, exactHead: record.headCommit === input.identity.snapshot.headCommit, shared });
    } catch {
      // Corrupt registry metadata is not a parse-cache failure and is ignored.
    }
  }
  candidates.sort((a, b) => Number(b.exactHead) - Number(a.exactHead) || b.shared - a.shared || a.record.worktreeId.localeCompare(b.record.worktreeId));
  return candidates[0]?.record;
}

function isReusableRecord(
  value: ReusableSnapshotRecord,
  input: Pick<Parameters<typeof selectReusableSnapshot>[0], "identity" | "parserVersion" | "parserConfigFingerprint">,
): boolean {
  return value?.schemaVersion === 1
    && value.repositoryId === input.identity.repository.repositoryId
    && value.parserVersion === input.parserVersion
    && value.parserConfigFingerprint === input.parserConfigFingerprint
    && isValidSnapshotSet(value.snapshot);
}

function snapshotsRoot(identity: ResolvedWorktreeIdentity): string {
  return path.join(path.dirname(resolveRepositoryParseCacheRoot(identity)), "snapshots");
}
