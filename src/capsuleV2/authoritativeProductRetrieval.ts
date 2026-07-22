import type { Database } from "bun:sqlite";

import { listSymbolsByFqName, listSymbolsForFile } from "../db/repositories/symbolsRepository";
import {
  CapsuleBudgetModel,
  CapsuleContentMode,
  CapsuleFileRepresentationMode,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type Capsule,
  type CapsuleItemContent,
  type PivotCapsuleItem,
  type SupportCapsuleItem,
} from "../capsule/types";
import { RunPipelinePresetIntent, type RunPipelineConcretePreset } from "../runPipeline/types";
import { SymbolKind } from "../domain/types";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { CapsuleIntent, CapsuleV2ContentMode, type CapsuleV2Item, type CapsuleV2Result } from "./types";

export const PRODUCT_RETRIEVAL_AUTHORITY = "product-retrieval-v2" as const;
export const PRODUCT_RETRIEVAL_RANKING_VERSION = "hybrid-shared-core+routed-rescue-v1" as const;
export const PRODUCT_RETRIEVAL_CHARS_PER_TOKEN = 4;

export interface AuthoritativeProductRetrieval {
  readonly version: typeof PRODUCT_RETRIEVAL_AUTHORITY;
  readonly rankingVersion: typeof PRODUCT_RETRIEVAL_RANKING_VERSION;
  readonly result: CapsuleV2Result;
  readonly capsule: Capsule;
}

/**
 * One authoritative retrieval/role/packing seam for the product tools.
 *
 * Capsule v2 owns the proven hybrid candidate union, score attribution, role
 * refinement, and compressed-cost packing. The adapter only projects that exact
 * selection into the historical Capsule response shape; it never re-ranks or
 * independently selects candidates.
 */
export function buildAuthoritativeProductRetrieval(
  db: Database,
  repoRoot: string,
  input: {
    query: string;
    preset: RunPipelineConcretePreset;
    maxBudgetCharacters: number;
  },
): AuthoritativeProductRetrieval {
  const maxTokens = Math.max(1, Math.floor(input.maxBudgetCharacters / PRODUCT_RETRIEVAL_CHARS_PER_TOKEN));
  const result = buildCapsuleV2({
    db,
    repoRoot,
    task: input.query,
    intent: capsuleIntentForPreset(input.preset),
    maxTokens,
  });
  return {
    version: PRODUCT_RETRIEVAL_AUTHORITY,
    rankingVersion: PRODUCT_RETRIEVAL_RANKING_VERSION,
    result,
    capsule: projectAuthoritativeCapsule(db, input.query, input.maxBudgetCharacters, result),
  };
}

function capsuleIntentForPreset(preset: RunPipelineConcretePreset): CapsuleIntent {
  switch (preset) {
    case RunPipelinePresetIntent.Debug:
      return CapsuleIntent.Debug;
    case RunPipelinePresetIntent.Modify:
      return CapsuleIntent.Modify;
    case RunPipelinePresetIntent.Refactor:
      return CapsuleIntent.Refactor;
    case RunPipelinePresetIntent.Explore:
      return CapsuleIntent.Explain;
  }
}

function projectAuthoritativeCapsule(
  db: Database,
  query: string,
  maxCharacters: number,
  result: CapsuleV2Result,
): Capsule {
  const pivots = result.pivots.flatMap((item) => {
    const projected = projectItem(db, item, CapsuleItemRole.Pivot);
    return projected === undefined ? [] : [projected];
  });
  const supportingItems = result.support.flatMap((item) => {
    const projected = projectItem(db, item, CapsuleItemRole.Support);
    return projected === undefined ? [] : [projected];
  });
  const usedCharacters = Math.min(
    maxCharacters,
    query.length + [...pivots, ...supportingItems].reduce((sum, item) => sum + item.budgetCost, 0),
  );
  return {
    query,
    pivots,
    supportingItems,
    budget: {
      model: CapsuleBudgetModel.CharacterCount,
      maxCharacters,
      usedCharacters,
      remainingCharacters: Math.max(0, maxCharacters - usedCharacters),
    },
    truncated: result.discarded.length > 0,
    compressed: [...pivots, ...supportingItems].some((item) => item.compressed),
  };
}

function projectItem(
  db: Database,
  item: CapsuleV2Item,
  role: CapsuleItemRole.Pivot,
): PivotCapsuleItem | undefined;
function projectItem(
  db: Database,
  item: CapsuleV2Item,
  role: CapsuleItemRole.Support,
): SupportCapsuleItem | undefined;
function projectItem(
  db: Database,
  item: CapsuleV2Item,
  role: CapsuleItemRole,
): PivotCapsuleItem | SupportCapsuleItem | undefined {
  const symbol = listSymbolsByFqName(db, item.fq_name).find((entry) => entry.filePath === item.path)
    ?? listSymbolsForFile(db, item.path).find((entry) => entry.localName === item.symbol);
  const content = projectContent(item);
  const budgetCost = Math.max(1, item.estimated_tokens * PRODUCT_RETRIEVAL_CHARS_PER_TOKEN);
  return {
    role,
    symbolId: symbol?.id ?? `product-v2:${item.path}::${item.symbol}`,
    filePath: item.path,
    fqName: item.fq_name,
    localName: item.symbol,
    // Documentation sections have no symbol row; the historical capsule shape
    // has no file-only item, so use its least-actionable module-level kind.
    kind: symbol?.kind ?? SymbolKind.ModuleAlias,
    inclusionReasons: [{
      kind: CapsuleInclusionReasonKind.QueryCoverage,
      note: item.role_reason,
    }],
    content,
    budgetCost,
    compressed: content.mode !== CapsuleContentMode.Full,
    sourceBacked: typeof item.source === "string",
    lexicalScore: item.scorecard.lexical,
    graphScore: item.scorecard.graph_proximity,
    finalScore: item.scorecard.final,
  };
}

function projectContent(item: CapsuleV2Item): CapsuleItemContent {
  if (item.content_mode === CapsuleV2ContentMode.Full && typeof item.source === "string") {
    return { mode: CapsuleContentMode.Full, source: item.source };
  }
  if (typeof item.signature === "string" && item.signature.length > 0) {
    return { mode: CapsuleContentMode.SignatureOnly, signature: item.signature };
  }
  return { mode: CapsuleContentMode.Stub, stub: item.symbol };
}
