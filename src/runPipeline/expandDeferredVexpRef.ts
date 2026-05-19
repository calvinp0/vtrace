import type { Database } from "bun:sqlite";

import {
  isPersistentDeferredVexpRefExpired,
  resolvePersistentDeferredVexpRef,
} from "../db/repositories/deferredVexpRefsRepository";
import {
  type DeferredVexpEntry,
  type DeferredVexpStore,
} from "./deferredVexpStore";

export type DeferredVexpResolution =
  | {
    readonly resolved: true;
    readonly entry: DeferredVexpEntry;
    readonly source: "process" | "persistent";
  }
  | {
    readonly resolved: false;
    readonly reason: "expired" | "unknown_hash";
  };

export function resolveDeferredVexpRef(input: {
  readonly hash: string;
  readonly store: DeferredVexpStore;
  readonly db?: Database;
}): DeferredVexpResolution {
  const processEntry = input.store.resolve(input.hash);

  if (processEntry !== null) {
    const persistentEntry = input.db === undefined
      ? null
      : resolvePersistentDeferredVexpRef(input.db, input.hash);

    if (persistentEntry !== null && !deferredEntriesMatch(processEntry, persistentEntry)) {
      return {
        resolved: true,
        entry: persistentEntry,
        source: "persistent",
      };
    }

    return {
      resolved: true,
      entry: processEntry,
      source: "process",
    };
  }

  if (input.db !== undefined) {
    const persistentEntry = resolvePersistentDeferredVexpRef(input.db, input.hash);

    if (persistentEntry !== null) {
      return {
        resolved: true,
        entry: persistentEntry,
        source: "persistent",
      };
    }
  }

  if (
    input.store.isExpired(input.hash)
    || (input.db !== undefined && isPersistentDeferredVexpRefExpired(input.db, input.hash))
  ) {
    return {
      resolved: false,
      reason: "expired",
    };
  }

  return {
    resolved: false,
    reason: "unknown_hash",
  };
}

function deferredEntriesMatch(left: DeferredVexpEntry, right: DeferredVexpEntry): boolean {
  return left.stableId === right.stableId
    && left.category === right.category
    && JSON.stringify(left.content) === JSON.stringify(right.content)
    && JSON.stringify(left.metadata) === JSON.stringify(right.metadata);
}
