// Stage 5 Capsule v2 artifact persistence.
//
// When a Stage 5 VTRACE run uses Capsule v2, the runner builds (in a subprocess)
// a complete `CapsuleV2Result` — pivots/support with full scorecards, evidence,
// budget, diagnostics, and the pivot-ranking v2 metadata
// (`pivot_rank_score`/`signals`/`penalties`/`reason`/`version`). Today only a
// reduced audit (path/symbol/reason/tokens) reaches `_run.meta.json`, and the
// live pivot ORDER and ranking rationale are dropped. That made the strict-v2
// Astropy validation unable to claim pivot-ranking v2 caused the fix.
//
// This module turns that already-built result into three lossless raw artifacts
// next to the run's other raw VTRACE evidence, so future runs can be audited
// causally from the run directory:
//
//   _capsule_v2_manifest.json  — full manifest + per-item ranking metadata
//   _capsule_v2_context.md     — the EXACT Markdown Capsule v2 injected
//   _capsule_v2_ranking.json   — compact ranking-only view for quick reports
//
// It is evidence persistence only: it reuses the Capsule v2 result the runner
// already produced for the prompt and never re-runs retrieval, ranking, or
// Capsule generation.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_PIVOT_RANKING_VERSION,
  type PivotRankingVersion,
} from "./pivotRankingV2";
import {
  CapsuleV2ContentMode,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";

// ---------------------------------------------------------------------------
// Artifact filenames (canonical names persisted into raw/vtrace/)
// ---------------------------------------------------------------------------

export const CAPSULE_V2_MANIFEST_FILENAME = "_capsule_v2_manifest.json";
export const CAPSULE_V2_CONTEXT_FILENAME = "_capsule_v2_context.md";
export const CAPSULE_V2_RANKING_FILENAME = "_capsule_v2_ranking.json";

export const CAPSULE_V2_MANIFEST_SCHEMA = "stage5-capsule-v2-manifest/v1";
export const CAPSULE_V2_RANKING_SCHEMA = "stage5-capsule-v2-ranking/v1";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// One run's Capsule v2 evidence: the instance it was built for, the full result
// the subprocess returned, and the exact Markdown the runner injected (the
// `renderCapsuleV2Human` output, BEFORE any Stage 5 wrapper instructions).
export interface CapsuleV2ArtifactBundle {
  readonly instanceId: string;
  readonly result: CapsuleV2Result;
  readonly contextMarkdown: string;
}

// Run-level context that is not part of the capsule itself.
export interface CapsuleV2ArtifactRunContext {
  readonly runLabel: string | null;
  readonly generatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Manifest / ranking shapes
// ---------------------------------------------------------------------------

export interface CapsuleV2ManifestItem {
  readonly role: "pivot" | "support";
  readonly path: string;
  readonly symbol: string;
  readonly kind: string | null;
  readonly contentMode: string | null;
  readonly tokenEstimate: number | null;
  // A "deferred" item's full body was NOT inlined (signature/skeleton content
  // mode) — it is referenced rather than expanded, so the agent must open it.
  readonly deferred: boolean;
  readonly isNonSourceExample: boolean | null;
  // Pivot-ranking metadata (present on ranked pivots; null on support/legacy).
  readonly pivotRankingVersion: PivotRankingVersion | null;
  readonly pivotRankScore: number | null;
  readonly pivotRankSignals: readonly string[];
  readonly pivotRankPenalties: readonly string[];
  readonly pivotRankReason: string | null;
}

// A referenced-but-not-expanded item (compact view used in the manifest).
export interface CapsuleV2DeferredRef {
  readonly role: "pivot" | "support";
  readonly path: string;
  readonly symbol: string;
  readonly kind: string | null;
  readonly contentMode: string | null;
  readonly tokenEstimate: number | null;
}

export interface CapsuleV2Manifest {
  readonly schema: typeof CAPSULE_V2_MANIFEST_SCHEMA;
  readonly generatedAt: string | null;
  readonly runLabel: string | null;
  readonly instanceId: string;
  readonly capsuleEngine: "v2";
  readonly capsuleIntent: string | null;
  readonly capsuleActualMode: string | null;
  readonly capsuleBudget: {
    readonly maxTokens: number | null;
    readonly estimatedTokens: number | null;
    readonly usedPercent: number | null;
  };
  readonly capsuleTokenEstimate: number | null;
  readonly pivotRankingVersion: PivotRankingVersion;
  readonly items: readonly CapsuleV2ManifestItem[];
  readonly deferredRefs: readonly CapsuleV2DeferredRef[];
  // Lossless audit tail: the raw diagnostics and discarded candidates exactly as
  // the engine emitted them, so the manifest is sufficient to reconstruct the run.
  readonly diagnostics: CapsuleV2Result["diagnostics"] | null;
  readonly discarded: CapsuleV2Result["discarded"];
}

export interface CapsuleV2RankingTopItem {
  readonly rank: number;
  readonly path: string;
  readonly symbol: string;
  readonly kind: string | null;
  readonly tokenEstimate: number | null;
  readonly pivotRankScore: number | null;
  readonly pivotRankSignals: readonly string[];
  readonly pivotRankPenalties: readonly string[];
  readonly pivotRankReason: string | null;
}

export interface CapsuleV2RankingSummary {
  readonly schema: typeof CAPSULE_V2_RANKING_SCHEMA;
  readonly generatedAt: string | null;
  readonly runLabel: string | null;
  readonly instanceId: string;
  readonly pivotRankingVersion: PivotRankingVersion;
  readonly topItems: readonly CapsuleV2RankingTopItem[];
  // Referenced-but-not-expanded item count vs. items whose body WAS inlined
  // (content_mode "full"). These let a report see how much of the capsule was
  // deferred to agent navigation rather than provided up front.
  readonly deferredRefCount: number;
  readonly expandedDeferredRefCount: number;
}

// The metadata fields merged into `_run.meta.json` to record what was persisted.
export interface CapsuleV2ArtifactMeta {
  readonly capsuleV2ArtifactsPersisted: boolean;
  readonly capsuleV2ManifestFile: string | null;
  readonly capsuleV2ContextFile: string | null;
  readonly capsuleV2RankingFile: string | null;
  readonly capsuleEngine: "v2" | null;
  readonly pivotRankingVersion: PivotRankingVersion | null;
  readonly capsuleV2ArtifactInstanceCount: number;
  // Only set when artifacts were NOT persisted (e.g. legacy engine, no result).
  readonly capsuleV2ArtifactsMissingReason: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// An item is "deferred" when its body was not inlined as full focused source.
export function isDeferredItem(item: CapsuleV2Item): boolean {
  return item.content_mode !== CapsuleV2ContentMode.Full;
}

// The pivot-ranking version actually applied to this result: the version stamped
// on the first ranked pivot, else the build-time default. (Items only carry a
// version when the v2 ranker scored them; legacy stamps "legacy".)
export function pivotRankingVersionOf(result: CapsuleV2Result): PivotRankingVersion {
  const pivots = Array.isArray(result.pivots) ? result.pivots : [];
  for (const pivot of pivots) {
    if (pivot.pivot_ranking_version === "legacy" || pivot.pivot_ranking_version === "v2") {
      return pivot.pivot_ranking_version;
    }
  }
  return DEFAULT_PIVOT_RANKING_VERSION;
}

function toManifestItem(item: CapsuleV2Item): CapsuleV2ManifestItem {
  return {
    role: item.role,
    path: item.path,
    symbol: item.symbol,
    kind: asStringOrNull(item.kind),
    contentMode: asStringOrNull(item.content_mode),
    tokenEstimate: asNumberOrNull(item.estimated_tokens),
    deferred: isDeferredItem(item),
    isNonSourceExample: typeof item.is_non_source_example === "boolean" ? item.is_non_source_example : null,
    pivotRankingVersion:
      item.pivot_ranking_version === "legacy" || item.pivot_ranking_version === "v2"
        ? item.pivot_ranking_version
        : null,
    pivotRankScore: asNumberOrNull(item.pivot_rank_score),
    pivotRankSignals: Array.isArray(item.pivot_rank_signals) ? [...item.pivot_rank_signals] : [],
    pivotRankPenalties: Array.isArray(item.pivot_rank_penalties) ? [...item.pivot_rank_penalties] : [],
    pivotRankReason: asStringOrNull(item.pivot_rank_reason),
  };
}

// Build the full lossless manifest from a Capsule v2 result + run context.
export function buildCapsuleV2Manifest(
  bundle: CapsuleV2ArtifactBundle,
  ctx: CapsuleV2ArtifactRunContext,
): CapsuleV2Manifest {
  const result = bundle.result;
  const pivots = Array.isArray(result.pivots) ? result.pivots : [];
  const support = Array.isArray(result.support) ? result.support : [];
  const items = [...pivots, ...support].map(toManifestItem);
  const deferredRefs: CapsuleV2DeferredRef[] = items
    .filter((item) => item.deferred)
    .map((item) => ({
      role: item.role,
      path: item.path,
      symbol: item.symbol,
      kind: item.kind,
      contentMode: item.contentMode,
      tokenEstimate: item.tokenEstimate,
    }));
  const budget = result.budget ?? null;
  return {
    schema: CAPSULE_V2_MANIFEST_SCHEMA,
    generatedAt: ctx.generatedAt,
    runLabel: ctx.runLabel,
    instanceId: bundle.instanceId,
    capsuleEngine: "v2",
    capsuleIntent: asStringOrNull(result.intent),
    capsuleActualMode: asStringOrNull(result.actual_mode),
    capsuleBudget: {
      maxTokens: asNumberOrNull(budget?.max_tokens),
      estimatedTokens: asNumberOrNull(budget?.estimated_tokens),
      usedPercent: asNumberOrNull(budget?.used_percent),
    },
    capsuleTokenEstimate: asNumberOrNull(budget?.estimated_tokens),
    pivotRankingVersion: pivotRankingVersionOf(result),
    items,
    deferredRefs,
    diagnostics: result.diagnostics ?? null,
    discarded: Array.isArray(result.discarded) ? result.discarded : [],
  };
}

// Build the compact ranking-only summary. `topItems` are the pivots in their
// surfaced order (the live ordering pivot-ranking v2 produced), with their
// rank rationale; `rank` is 1-based position in that order.
export function buildCapsuleV2RankingSummary(
  bundle: CapsuleV2ArtifactBundle,
  ctx: CapsuleV2ArtifactRunContext,
): CapsuleV2RankingSummary {
  const result = bundle.result;
  const pivots = Array.isArray(result.pivots) ? result.pivots : [];
  const support = Array.isArray(result.support) ? result.support : [];
  const all = [...pivots, ...support];
  const topItems: CapsuleV2RankingTopItem[] = pivots.map((item, index) => ({
    rank: index + 1,
    path: item.path,
    symbol: item.symbol,
    kind: asStringOrNull(item.kind),
    tokenEstimate: asNumberOrNull(item.estimated_tokens),
    pivotRankScore: asNumberOrNull(item.pivot_rank_score),
    pivotRankSignals: Array.isArray(item.pivot_rank_signals) ? [...item.pivot_rank_signals] : [],
    pivotRankPenalties: Array.isArray(item.pivot_rank_penalties) ? [...item.pivot_rank_penalties] : [],
    pivotRankReason: asStringOrNull(item.pivot_rank_reason),
  }));
  const deferredRefCount = all.filter(isDeferredItem).length;
  const expandedDeferredRefCount = all.length - deferredRefCount;
  return {
    schema: CAPSULE_V2_RANKING_SCHEMA,
    generatedAt: ctx.generatedAt,
    runLabel: ctx.runLabel,
    instanceId: bundle.instanceId,
    pivotRankingVersion: pivotRankingVersionOf(result),
    topItems,
    deferredRefCount,
    expandedDeferredRefCount,
  };
}

// The meta fields recorded when Capsule v2 artifacts were NOT persisted (legacy
// engine, no v2 result, or no context). Keeps the "missing" claim explicit so a
// report never reads absence as a persisted-but-empty manifest.
export function capsuleV2ArtifactsNotPersistedMeta(reason: string): CapsuleV2ArtifactMeta {
  return {
    capsuleV2ArtifactsPersisted: false,
    capsuleV2ManifestFile: null,
    capsuleV2ContextFile: null,
    capsuleV2RankingFile: null,
    capsuleEngine: null,
    pivotRankingVersion: null,
    capsuleV2ArtifactInstanceCount: 0,
    capsuleV2ArtifactsMissingReason: reason,
  };
}

// ---------------------------------------------------------------------------
// IO: write the three artifacts into a run's raw/vtrace directory
// ---------------------------------------------------------------------------

// Injectable writer so tests can capture writes without a real fs if desired.
export type ArtifactWriter = (filePath: string, contents: string) => Promise<void>;

const defaultWriter: ArtifactWriter = (filePath, contents) => writeFile(filePath, contents);

// Filenames for a bundle at position `index`. The primary (first) bundle uses the
// canonical names; any additional instances in a multi-instance run get
// instance-suffixed names so nothing is overwritten. Smoke runs are
// single-instance, so the canonical names are the common case.
function fileNamesFor(index: number, instanceId: string): {
  manifest: string;
  context: string;
  ranking: string;
} {
  if (index === 0) {
    return {
      manifest: CAPSULE_V2_MANIFEST_FILENAME,
      context: CAPSULE_V2_CONTEXT_FILENAME,
      ranking: CAPSULE_V2_RANKING_FILENAME,
    };
  }
  const safe = instanceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    manifest: `_capsule_v2_manifest.${safe}.json`,
    context: `_capsule_v2_context.${safe}.md`,
    ranking: `_capsule_v2_ranking.${safe}.json`,
  };
}

// Persist the Capsule v2 artifacts for a run into `dir` (the run's raw/vtrace
// directory). Returns the meta fields to merge into `_run.meta.json`. When no
// bundle is supplied (legacy engine / no v2 result), nothing is written and the
// returned meta records the explicit missing reason.
export async function writeCapsuleV2Artifacts(
  dir: string,
  bundles: readonly CapsuleV2ArtifactBundle[],
  ctx: CapsuleV2ArtifactRunContext,
  writer: ArtifactWriter = defaultWriter,
): Promise<CapsuleV2ArtifactMeta> {
  if (bundles.length === 0) {
    return capsuleV2ArtifactsNotPersistedMeta("capsule-engine-not-v2");
  }

  let primary: { manifest: string; context: string; ranking: string } | null = null;
  let pivotRankingVersion: PivotRankingVersion = DEFAULT_PIVOT_RANKING_VERSION;

  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index]!;
    const names = fileNamesFor(index, bundle.instanceId);
    const manifest = buildCapsuleV2Manifest(bundle, ctx);
    const ranking = buildCapsuleV2RankingSummary(bundle, ctx);
    await writer(path.join(dir, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
    await writer(path.join(dir, names.context), `${bundle.contextMarkdown}\n`);
    await writer(path.join(dir, names.ranking), `${JSON.stringify(ranking, null, 2)}\n`);
    if (index === 0) {
      primary = names;
      pivotRankingVersion = manifest.pivotRankingVersion;
    }
  }

  return {
    capsuleV2ArtifactsPersisted: true,
    capsuleV2ManifestFile: primary === null ? null : path.join(dir, primary.manifest),
    capsuleV2ContextFile: primary === null ? null : path.join(dir, primary.context),
    capsuleV2RankingFile: primary === null ? null : path.join(dir, primary.ranking),
    capsuleEngine: "v2",
    pivotRankingVersion,
    capsuleV2ArtifactInstanceCount: bundles.length,
    capsuleV2ArtifactsMissingReason: null,
  };
}
