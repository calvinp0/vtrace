import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPO_LOCAL_STATE_DIRNAME } from "../setup/types";
import { resolveWorktreeIdentity } from "./worktreeIdentity";

const LOCK_DIRNAME = "index.lock";
const OWNER_FILENAME = "owner.json";

/**
 * Who holds the lock. The worktree id is what makes the claim checkable: a lock
 * directory reached by copying somebody else's `.vtrace` names a worktree that
 * is not this one, and before M145 that value was written and never read (§69).
 */
interface LockOwner {
  pid: number;
  startedAt: string;
  worktreeId: string;
}

export class WorktreeIndexLockError extends Error {
  readonly code: "index_in_progress" | "lock_timeout";
  readonly worktreeRoot: string;
  /** Which process and which worktree the blocking claim belongs to. */
  readonly owner: { readonly pid: number | null; readonly worktreeId: string | null };
  /** How long acquisition actually waited before giving up. Never unbounded. */
  readonly waitedMs: number;

  constructor(
    code: "index_in_progress" | "lock_timeout",
    worktreeRoot: string,
    detail: {
      readonly owner?: { pid: number | null; worktreeId: string | null };
      readonly waitedMs?: number;
    } = {},
  ) {
    super(code === "index_in_progress"
      ? `Indexing is already in progress for ${worktreeRoot}`
      : `Timed out waiting for the index lock for ${worktreeRoot}`);
    this.name = "WorktreeIndexLockError";
    this.code = code;
    this.worktreeRoot = worktreeRoot;
    this.owner = detail.owner ?? { pid: null, worktreeId: null };
    this.waitedMs = detail.waitedMs ?? 0;
  }
}

/** Why an existing lock was cleared. Recovery is always attributed, never quiet. */
export type StaleLockKind = "dead_owner" | "unreadable_owner" | "foreign_worktree";

export interface WorktreeIndexLockResult<T> {
  value: T;
  staleLockRecovered: boolean;
  staleLockKind?: StaleLockKind;
}

export async function withWorktreeIndexLock<T>(input: {
  repoRoot: string;
  waitMs?: number;
  operation: () => Promise<T>;
}): Promise<WorktreeIndexLockResult<T>> {
  const identity = await resolveWorktreeIdentity(input.repoRoot);
  const lockPath = path.join(identity.worktree.worktreeRoot, REPO_LOCAL_STATE_DIRNAME, LOCK_DIRNAME);
  const ownerPath = path.join(lockPath, OWNER_FILENAME);
  const startedWaitingAt = Date.now();
  const deadline = startedWaitingAt + (input.waitMs ?? 0);
  let staleLockRecovered = false;
  let staleLockKind: StaleLockKind | undefined;

  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      const owner: LockOwner = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        worktreeId: identity.worktree.worktreeId,
      };
      await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await mkdir(path.dirname(lockPath), { recursive: true });
        continue;
      }
      if (code !== "EEXIST") {
        throw error;
      }

      const owner = await readOwner(ownerPath);
      const recoverable = classifyRecoverableLock(owner, identity.worktree.worktreeId);
      if (recoverable !== undefined) {
        await rm(lockPath, { recursive: true, force: true });
        staleLockRecovered = true;
        staleLockKind = recoverable;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new WorktreeIndexLockError(
          input.waitMs === undefined || input.waitMs === 0 ? "index_in_progress" : "lock_timeout",
          identity.worktree.worktreeRoot,
          {
            owner: { pid: owner?.pid ?? null, worktreeId: owner?.worktreeId ?? null },
            waitedMs: Date.now() - startedWaitingAt,
          },
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }

  try {
    return {
      value: await input.operation(),
      staleLockRecovered,
      ...(staleLockKind === undefined ? {} : { staleLockKind }),
    };
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

/**
 * May this lock be cleared, and on what grounds?
 *
 * Never on age (§66): a long index is not an abandoned one. Every admissible
 * ground is a statement about OWNERSHIP.
 *
 * A claim naming a different worktree never owned this index. It arrives by
 * copying a `.vtrace` directory, and its process — alive or not — is writing to
 * its own worktree's lock path, not to this one. §69 is explicit that a sibling
 * worktree's lock must not imply this worktree is busy, so the claim is cleared
 * on the strength of the mismatch rather than on the owner's liveness. This is
 * not the stealing §70 rules out: that is about two claims on ONE write target,
 * and this claim was never on this target at all.
 */
function classifyRecoverableLock(
  owner: LockOwner | null,
  worktreeId: string,
): StaleLockKind | undefined {
  if (owner === null) return "unreadable_owner";
  if (owner.worktreeId !== worktreeId) return "foreign_worktree";
  if (!isProcessActive(owner.pid)) return "dead_owner";
  return undefined;
}

async function readOwner(ownerPath: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(value.pid) && typeof value.startedAt === "string" && typeof value.worktreeId === "string"
      ? value as LockOwner
      : null;
  } catch {
    return null;
  }
}

function isProcessActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
