import { createHash } from "node:crypto";

/**
 * Deferred V-REF store.
 *
 * Process-local, in-memory mapping from the public 12-hex V-REF hash to the
 * stable deferred record emitted by run_pipeline. The store is the single
 * source of truth for expand_vexp_ref: it holds the exact payload snapshotted
 * at run_pipeline time so expansion returns stored truth, never a
 * recomputation.
 */

export const DeferredVexpCategory = Object.freeze({
  ContextCapsule: "context_capsule",
  ImpactGraph: "impact_graph",
  LogicFlow: "logic_flow",
  SessionContext: "session_context",
  DurableMemory: "durable_memory",
});

export type DeferredVexpCategory =
  (typeof DeferredVexpCategory)[keyof typeof DeferredVexpCategory];

export const DEFERRED_VEXP_SUPPORTED_CATEGORIES = Object.freeze([
  DeferredVexpCategory.ContextCapsule,
  DeferredVexpCategory.ImpactGraph,
  DeferredVexpCategory.LogicFlow,
  DeferredVexpCategory.SessionContext,
  DeferredVexpCategory.DurableMemory,
] as const);

export const DEFERRED_VEXP_HASH_PATTERN = /^[0-9a-f]{12}$/;

export type DeferredVexpContent =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "text"; readonly mimeType: string; readonly text: string };

export interface DeferredVexpEntryInput {
  readonly stableId: string;
  readonly category: DeferredVexpCategory;
  readonly content: DeferredVexpContent;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DeferredVexpEntry extends DeferredVexpEntryInput {
  readonly hash: string;
  readonly createdAtMs: number;
}

export interface DeferredVexpStore {
  publish(entry: DeferredVexpEntryInput): DeferredVexpEntry;
  resolve(hash: string): DeferredVexpEntry | null;
  isExpired(hash: string): boolean;
  expire(hash: string): boolean;
  clear(): void;
  size(): number;
}

const DEFAULT_CAPACITY = 256;

export function computeDeferredVexpHash(stableId: string): string {
  return computeDeferredVexpHashFromParts(stableId);
}

export function computeDeferredVexpHashFromParts(
  stableId: string,
  payload?: unknown,
): string {
  const hash = createHash("sha256");

  hash.update(stableId);

  if (payload !== undefined) {
    hash.update("\0");
    hash.update(stableStringify(payload));
  }

  return hash.digest("hex").slice(0, 12);
}

export function isValidDeferredVexpHash(value: unknown): value is string {
  return typeof value === "string" && DEFERRED_VEXP_HASH_PATTERN.test(value);
}

export function isSupportedDeferredVexpCategory(
  value: string,
): value is DeferredVexpCategory {
  return (DEFERRED_VEXP_SUPPORTED_CATEGORIES as readonly string[]).includes(value);
}

export function createDeferredVexpStore(
  options: { readonly capacity?: number; readonly now?: () => number } = {},
): DeferredVexpStore {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  const now = options.now ?? Date.now;

  // Insertion-ordered Map gives us FIFO eviction under capacity pressure.
  const entries = new Map<string, DeferredVexpEntry>();
  const expiredHashes = new Set<string>();

  function evictIfNeeded(): void {
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      entries.delete(oldest.value);
      expiredHashes.add(oldest.value);
    }
  }

  return {
    publish(input) {
      const hash = computeDeferredVexpHashFromParts(input.stableId, input.content);
      const entry: DeferredVexpEntry = {
        stableId: input.stableId,
        category: input.category,
        content: input.content,
        metadata: input.metadata,
        hash,
        createdAtMs: now(),
      };
      // Re-publish refreshes position and clears any prior expired mark.
      entries.delete(hash);
      entries.set(hash, entry);
      expiredHashes.delete(hash);
      evictIfNeeded();
      return entry;
    },
    resolve(hash) {
      return entries.get(hash) ?? null;
    },
    isExpired(hash) {
      return expiredHashes.has(hash);
    },
    expire(hash) {
      const had = entries.delete(hash);
      expiredHashes.add(hash);
      return had;
    },
    clear() {
      entries.clear();
      expiredHashes.clear();
    },
    size() {
      return entries.size;
    },
  };
}

let sharedStore: DeferredVexpStore | null = null;

export function getSharedDeferredVexpStore(): DeferredVexpStore {
  if (sharedStore === null) {
    sharedStore = createDeferredVexpStore();
  }
  return sharedStore;
}

/** Test-only helper — resets the process-shared store to a clean state. */
export function resetSharedDeferredVexpStoreForTests(
  options: { readonly capacity?: number; readonly now?: () => number } = {},
): void {
  sharedStore = createDeferredVexpStore(options);
}

export function stableStringifyDeferredVexpPayload(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyDeferredVexpPayload).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => {
    return `${JSON.stringify(key)}:${stableStringifyDeferredVexpPayload(record[key])}`;
  }).join(",")}}`;
}

function stableStringify(value: unknown): string {
  return stableStringifyDeferredVexpPayload(value);
}
