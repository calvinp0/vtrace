// Stage 5 M155-B2 — fail-closed index derivation gate for the deterministic suites.
//
// WHY THIS EXISTS
// ----------------
// The committed regression baselines scored current retrieval code against
// workspace indexes built once on 2026-06-08, 491 commits earlier. Those indexes
// carried `index_format_version: 1` against a supported set of `{5}` and a
// `parser_incompatible` derivation — meaning VTRACE's OWN authority would have
// rejected them outright. The benchmark never asked: it called
// `openIndexerDatabase`, the schema migrated on open, the new feature tables were
// created EMPTY, and the suite reported an authoritative "unchanged" for lanes
// whose evidence did not exist in the corpus.
//
// So this module asks. It is a thin adapter over the product's existing
// derivation authority (`resolveDerivationRebuildReason` +
// `computeIndexFingerprints`), NOT a parallel one — M155 §18 requires reusing the
// existing machinery, and a second opinion about index validity is exactly the
// kind of thing that drifts.
//
// It differs from the product authority in one deliberate way: a MISSING
// `index.meta.json` is invalid here. `resolveDerivationRebuildReason` returns
// `undefined` ("no rebuild needed") when nothing is stored, which is the right
// call for a product deciding whether to discard content, and the wrong one for a
// benchmark deciding whether evidence is trustworthy. An index that cannot say
// what produced it cannot be an authoritative baseline.

import { existsSync } from "node:fs";
import path from "node:path";

import {
  SUPPORTED_INDEX_FORMAT_VERSIONS,
} from "../../src/indexer/indexReadiness";
import {
  computeIndexFingerprints,
  readIndexMeta,
  resolveDerivationRebuildReason,
  resolveIndexDbPath,
  type IndexFingerprint,
} from "../../src/indexer/indexMeta";

export type DerivationInvalidReason =
  | "index_missing"
  | "meta_missing"
  | "schema_unsupported"
  | "parser_incompatible"
  | "configuration_incompatible"
  | "derivation_incompatible"
  | "schema_incompatible";

export interface DerivationVerdict {
  readonly valid: boolean;
  readonly reason: DerivationInvalidReason | "derivation_agrees";
  readonly workspace: string;
  readonly storedVtraceCommit: string | null;
  readonly storedFormatVersion: number | null;
  readonly storedIndexerFingerprint: string | null;
  readonly expectedIndexerFingerprint: string;
  readonly expectedFormatVersion: number;
  /** Human-readable, safe to put straight into a benchmark row's failure reason. */
  readonly detail: string;
}

/** Expected derivation identity of the implementation currently executing. */
export async function expectedDerivation(): Promise<IndexFingerprint> {
  return computeIndexFingerprints();
}

/**
 * Decide whether `workspace`'s stored index is derivation-valid evidence for the
 * currently executing implementation. Fails closed on every uncertainty.
 */
export async function gateIndexDerivation(
  workspace: string,
  expected?: IndexFingerprint,
): Promise<DerivationVerdict> {
  const resolvedExpected = expected ?? (await expectedDerivation());
  const root = path.resolve(workspace);
  const base = {
    workspace: root,
    expectedIndexerFingerprint: resolvedExpected.indexer_fingerprint,
    expectedFormatVersion: resolvedExpected.index_format_version,
  };

  if (!existsSync(resolveIndexDbPath(root))) {
    return {
      ...base, valid: false, reason: "index_missing",
      storedVtraceCommit: null, storedFormatVersion: null, storedIndexerFingerprint: null,
      detail: `no index at ${path.join(".vtrace", "index.sqlite")}`,
    };
  }

  const stored = await readIndexMeta(root);
  if (stored === undefined) {
    // Fail closed. See module header: the product's "nothing stored, nothing to
    // discard" is not a statement that the contents are trustworthy.
    return {
      ...base, valid: false, reason: "meta_missing",
      storedVtraceCommit: null, storedFormatVersion: null, storedIndexerFingerprint: null,
      detail: "index has no index.meta.json, so it cannot state what derivation produced it",
    };
  }

  const storedFacts = {
    storedVtraceCommit: stored.vtrace_commit ?? null,
    storedFormatVersion: stored.index_format_version ?? null,
    storedIndexerFingerprint: stored.indexer_fingerprint ?? null,
  };

  if (!SUPPORTED_INDEX_FORMAT_VERSIONS.has(stored.index_format_version)) {
    return {
      ...base, ...storedFacts, valid: false, reason: "schema_unsupported",
      detail: `index_format_version ${stored.index_format_version} is not in the supported set `
        + `{${[...SUPPORTED_INDEX_FORMAT_VERSIONS].join(", ")}}`,
    };
  }

  const rebuild = resolveDerivationRebuildReason(stored, resolvedExpected);
  if (rebuild !== undefined) {
    return {
      ...base, ...storedFacts, valid: false, reason: rebuild,
      detail: `stored index derivation disagrees with the implementation under evaluation (${rebuild}); `
        + `stored indexer ${(storedFacts.storedIndexerFingerprint ?? "none").slice(0, 12)}, `
        + `expected ${resolvedExpected.indexer_fingerprint.slice(0, 12)}`,
    };
  }

  return {
    ...base, ...storedFacts, valid: true, reason: "derivation_agrees",
    detail: "stored index was produced by a derivation this implementation agrees with",
  };
}
