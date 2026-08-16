// Test-side construction of the two stores M152 separated.
//
// Before the split a test wrote `openIndexerDatabase()` and got one handle that
// happened to answer both repository and product questions. That convenience is
// exactly what made the mixed layout survive so long, so the helper here is
// deliberately explicit: it hands back a pair, and the caller can see which half
// each assertion is about.

import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import {
  createEphemeralSessionDatabase,
  type WritableProductStores,
  type WritableSessionDatabase,
} from "../session/sessionStore";

export interface TestProductStores extends WritableProductStores {
  readonly index: Database;
  readonly session: WritableSessionDatabase;
  close(): void;
}

/**
 * An in-memory index paired with an in-memory session store. Neither reaches
 * disk, so a test can exercise the real product functions without needing a
 * `.vtrace` directory.
 */
export function createTestProductStores(indexDb?: Database): TestProductStores {
  const index = indexDb ?? openIndexerDatabase();
  const session = createEphemeralSessionDatabase();

  return {
    index,
    session,
    close(): void {
      try {
        session.close();
      } catch {
        // Closing a test handle must never mask the assertion that failed.
      }
      if (indexDb === undefined) {
        try {
          index.close();
        } catch {
          // As above.
        }
      }
    },
  };
}

/** A session-only handle, for tests that assert on product state alone. */
export function createTestSessionDatabase(): WritableSessionDatabase {
  return createEphemeralSessionDatabase();
}
