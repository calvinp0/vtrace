/**
 * M148-A: where the additive access-path migration meets the index lifecycle.
 *
 * M147 shipped the migration itself (`./symbolNameAccessPath`) and proved it
 * additive, atomic, idempotent and content-preserving — but nothing in the
 * product ever called it. A user with a perfectly compatible index had no way to
 * gain the physical name access path, and a freshly built index left the
 * indexing lifecycle without one. This module is the policy layer that closes
 * that gap, and it is deliberately separate from the migration primitive for
 * one reason:
 *
 *   THE MIGRATION DECIDES WHAT `CREATE INDEX` TO RUN.
 *   THIS DECIDES WHAT A FAILURE TO RUN IT MEANS.
 *
 * WHY IT LIVES HERE AND NOT IN `src/indexer`
 * ------------------------------------------
 * `src/indexer/indexProject.ts` is a fingerprint root: M146-A's closure guard
 * walks its value imports and demands that everything reachable either feed a
 * derivation fingerprint or carry a written exemption. Calling this from there
 * would drag a physical access path into the SEMANTIC derivation closure and
 * need an exemption to excuse it. Calling it from the lifecycle ABOVE the
 * indexer — `src/runtime/reindexRepo.ts`, where the CLI, the MCP tool and the
 * watcher already converge on a writable handle inside the worktree index lock
 * — needs no exemption, because the dependency never points that way:
 *
 *   index lifecycle  ->  semantic index build  ->  ensure access capability
 *
 * The distinction the whole workstream rests on:
 *
 *   LOGICAL INDEX CONTENT and PHYSICAL DATABASE ACCESS PATH
 *   ARE NOT THE SAME VERSIONING DOMAIN.
 *
 * FAILURE IS NOT UNREADINESS
 * --------------------------
 * A read-only filesystem, a full disk or a busy writer can all stop the access
 * path being installed. None of them makes the semantic index wrong: the same
 * membership statement returns the same rows either way, only slower. So a
 * failure here is reported and never thrown — turning "we could not optimise
 * this" into "your index is unusable" would be a lie with an expensive remedy.
 */
import type { Database } from "bun:sqlite";

import {
  applySymbolNameAccessPath,
  inspectSymbolNameAccessPath,
  SYMBOL_NAME_ACCESS_PATH_VERSION,
} from "./symbolNameAccessPath";

/**
 * How this index answers an exact-name membership question. Deliberately NOT a
 * readiness word: `fallback` is a performance mode, not a compatibility
 * complaint, and the router draws that line too (M147's `MembershipAccessPath`).
 */
export const NameLookupAccess = Object.freeze({
  /** A name index exists; membership is a b-tree lookup. */
  Indexed: "indexed",
  /** No name index; membership scans the symbol table. Same answer, slower. */
  Fallback: "fallback",
  /** The database could not be inspected, so the mode is not known. */
  Unknown: "unknown",
});

export type NameLookupAccess = (typeof NameLookupAccess)[keyof typeof NameLookupAccess];

export interface IndexAccessCapabilityState {
  readonly version: number;
  readonly nameLookupAccess: NameLookupAccess;
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

const UNKNOWN_STATE: IndexAccessCapabilityState = Object.freeze({
  version: SYMBOL_NAME_ACCESS_PATH_VERSION,
  nameLookupAccess: NameLookupAccess.Unknown,
  present: Object.freeze([]),
  missing: Object.freeze([]),
});

/**
 * Read-only. What the database catalogue says it HAS — never what a counter
 * claims was once installed, and never a mutation: `index_status` must be able
 * to report this without a read path acquiring the right to write.
 */
export function inspectIndexAccessCapability(db: Database): IndexAccessCapabilityState {
  try {
    const state = inspectSymbolNameAccessPath(db);
    return {
      version: state.version,
      nameLookupAccess: state.installed ? NameLookupAccess.Indexed : NameLookupAccess.Fallback,
      present: state.present,
      missing: state.missing,
    };
  } catch {
    // An unreadable catalogue is not a fallback verdict. Saying `fallback` here
    // would report a measured mode that was never measured.
    return UNKNOWN_STATE;
  }
}

export interface EnsureIndexAccessCapabilityOutcome {
  /** False only when ensuring was disabled by the caller. */
  readonly attempted: boolean;
  /** True when this call created an access path. False when already installed. */
  readonly applied: boolean;
  readonly created: readonly string[];
  /** Catalogue state AFTER the attempt. The authority on what exists. */
  readonly state: IndexAccessCapabilityState;
  readonly durationMs: number;
  /** Non-null when the migration failed. The index remains semantically usable. */
  readonly error: string | null;
}

const NOT_ATTEMPTED: EnsureIndexAccessCapabilityOutcome = Object.freeze({
  attempted: false,
  applied: false,
  created: Object.freeze([]),
  state: UNKNOWN_STATE,
  durationMs: 0,
  error: null,
});

/**
 * Ensure this index carries the physical access paths the current runtime wants,
 * additively. Safe on an already-installed index (creates nothing), safe on a
 * `ready` index (no row is written), and safe to fail (reported, never thrown).
 *
 * Call it where an authoritative index has just finished being written and the
 * caller already holds the worktree index lock. Do NOT call it from a query
 * path: a read that repairs the database makes cost depend on who asked first,
 * and M146-A's lifecycle truth is explicit precisely so that cannot happen.
 */
export function ensureIndexAccessCapability(
  db: Database,
  options: { readonly enabled?: boolean } = {},
): EnsureIndexAccessCapabilityOutcome {
  if (options.enabled === false) return NOT_ATTEMPTED;

  const started = performance.now();
  try {
    const migration = applySymbolNameAccessPath(db);
    return {
      attempted: true,
      applied: migration.applied,
      created: migration.created,
      // Re-read rather than trusting the migration's own report: the catalogue
      // is the fact, and this is the value a later `index_status` will show.
      state: inspectIndexAccessCapability(db),
      durationMs: +(performance.now() - started).toFixed(3),
      error: null,
    };
  } catch (error) {
    return {
      attempted: true,
      applied: false,
      created: [],
      state: inspectIndexAccessCapability(db),
      durationMs: +(performance.now() - started).toFixed(3),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
