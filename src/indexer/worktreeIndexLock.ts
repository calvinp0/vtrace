import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REPO_LOCAL_STATE_DIRNAME } from "../setup/types";
import { resolveWorktreeIdentity } from "./worktreeIdentity";

const LOCK_DIRNAME = "index.lock";
const OWNER_FILENAME = "owner.json";

interface LockOwner {
  pid: number;
  startedAt: string;
  worktreeId: string;
}

export class WorktreeIndexLockError extends Error {
  readonly code: "index_in_progress" | "lock_timeout";
  readonly worktreeRoot: string;

  constructor(code: "index_in_progress" | "lock_timeout", worktreeRoot: string) {
    super(code === "index_in_progress"
      ? `Indexing is already in progress for ${worktreeRoot}`
      : `Timed out waiting for the index lock for ${worktreeRoot}`);
    this.name = "WorktreeIndexLockError";
    this.code = code;
    this.worktreeRoot = worktreeRoot;
  }
}

export interface WorktreeIndexLockResult<T> {
  value: T;
  staleLockRecovered: boolean;
}

export async function withWorktreeIndexLock<T>(input: {
  repoRoot: string;
  waitMs?: number;
  operation: () => Promise<T>;
}): Promise<WorktreeIndexLockResult<T>> {
  const identity = await resolveWorktreeIdentity(input.repoRoot);
  const lockPath = path.join(identity.worktree.worktreeRoot, REPO_LOCAL_STATE_DIRNAME, LOCK_DIRNAME);
  const ownerPath = path.join(lockPath, OWNER_FILENAME);
  const deadline = Date.now() + (input.waitMs ?? 0);
  let staleLockRecovered = false;

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
      if (owner !== null && !isProcessActive(owner.pid)) {
        await rm(lockPath, { recursive: true, force: true });
        staleLockRecovered = true;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new WorktreeIndexLockError(input.waitMs === undefined || input.waitMs === 0
          ? "index_in_progress"
          : "lock_timeout", identity.worktree.worktreeRoot);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }

  try {
    return { value: await input.operation(), staleLockRecovered };
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
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
