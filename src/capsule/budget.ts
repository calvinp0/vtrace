import {
  CapsuleBudgetModel,
  CapsuleContentMode,
  CapsuleInclusionReasonKind,
  type Capsule,
  type CapsuleBudget,
  type CapsuleBudgetUsage,
  type CapsuleItem,
  type CapsuleInclusionReason,
  type CapsuleMemoryInclusionReason,
  type CapsuleMemoryItem,
} from "./types";

export function createCharacterBudget(maxCharacters: number): CapsuleBudget {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 0) {
    throw new Error("maxCharacters must be a non-negative integer");
  }

  return {
    model: CapsuleBudgetModel.CharacterCount,
    maxCharacters,
  };
}

export function computeCapsuleItemCost(item: CapsuleItem): number {
  return (
    item.symbolId.length
    + item.filePath.length
    + item.fqName.length
    + item.localName.length
    + item.kind.length
    + item.role.length
    + computeContentCost(item.content)
    + item.inclusionReasons.reduce((sum, reason) => sum + computeInclusionReasonCost(reason), 0)
    + computeOptionalNumberCost(item.lexicalScore)
    + computeOptionalNumberCost(item.graphScore)
    + computeOptionalNumberCost(item.finalScore)
  );
}

export function computeCapsuleMemoryItemCost(item: CapsuleMemoryItem): number {
  return (
    item.observationId.length
    + item.kind.length
    + item.headline.length
    + String(item.createdAtMs).length
    + String(item.isStale).length
    + item.staleReasons.reduce((sum, reason) => sum + reason.length, 0)
    + item.inclusionReasons.reduce((sum, reason) => sum + computeMemoryInclusionReasonCost(reason), 0)
  );
}

export function computeTotalCapsuleCost(
  capsule: Pick<Capsule, "query" | "pivots" | "supportingItems"> & {
    readonly memories?: readonly CapsuleMemoryItem[];
  },
): number {
  return capsule.query.length + listCapsuleItems(capsule).reduce(
    (sum, item) => sum + item.budgetCost,
    0,
  ) + (capsule.memories ?? []).reduce(
    (sum, memory) => sum + computeCapsuleMemoryItemCost(memory),
    0,
  );
}

export function computeCapsuleBudgetUsage(
  capsule: Pick<Capsule, "query" | "pivots" | "supportingItems"> & {
    readonly memories?: readonly CapsuleMemoryItem[];
  },
  budget: CapsuleBudget,
): CapsuleBudgetUsage {
  const usedCharacters = computeTotalCapsuleCost(capsule);

  return {
    model: budget.model,
    maxCharacters: budget.maxCharacters,
    usedCharacters,
    remainingCharacters: Math.max(0, budget.maxCharacters - usedCharacters),
  };
}

export function wouldExceedBudget(
  currentCost: number,
  nextItemOrCost: CapsuleItem | number,
  budget: CapsuleBudget,
): boolean {
  const nextCost = typeof nextItemOrCost === "number"
    ? nextItemOrCost
    : nextItemOrCost.budgetCost;

  if (!Number.isInteger(currentCost) || currentCost < 0) {
    throw new Error("currentCost must be a non-negative integer");
  }

  if (!Number.isInteger(nextCost) || nextCost < 0) {
    throw new Error("nextCost must be a non-negative integer");
  }

  return currentCost + nextCost > budget.maxCharacters;
}

export function canAddCapsuleItem(
  currentCost: number,
  item: CapsuleItem,
  budget: CapsuleBudget,
): boolean {
  return !wouldExceedBudget(currentCost, item, budget);
}

function computeContentCost(itemContent: CapsuleItem["content"]): number {
  switch (itemContent.mode) {
    case CapsuleContentMode.Full:
      return itemContent.mode.length + itemContent.source.length;
    case CapsuleContentMode.Skeleton:
      return itemContent.mode.length
        + itemContent.detail.length
        + JSON.stringify(itemContent.file).length;
    case CapsuleContentMode.SignatureOnly:
      return itemContent.mode.length + itemContent.signature.length;
    case CapsuleContentMode.Summary:
      return itemContent.mode.length
        + itemContent.summary.length
        + (itemContent.signature?.length ?? 0);
    case CapsuleContentMode.Stub:
      return itemContent.mode.length + itemContent.stub.length;
  }
}

function computeInclusionReasonCost(reason: CapsuleInclusionReason): number {
  switch (reason.kind) {
    case CapsuleInclusionReasonKind.LexicalMatch:
      return reason.kind.length + reason.matchedFields.reduce(
        (sum, field) => sum + field.length,
        0,
      );
    case CapsuleInclusionReasonKind.GraphConnection:
      return reason.kind.length
        + reason.graphSignals.reduce((sum, signal) => sum + signal.length, 0)
        + (reason.relatedSymbolIds?.reduce((sum, symbolId) => sum + symbolId.length, 0) ?? 0);
    case CapsuleInclusionReasonKind.StructuralSupport:
      return reason.kind.length
        + reason.edgeType.length
        + reason.relatedSymbolIds.reduce((sum, symbolId) => sum + symbolId.length, 0);
    case CapsuleInclusionReasonKind.QueryCoverage:
      return reason.kind.length + reason.note.length;
    case CapsuleInclusionReasonKind.BudgetCompression:
      return reason.kind.length
        + reason.originalMode.length
        + reason.appliedMode.length;
  }
}

function computeMemoryInclusionReasonCost(reason: CapsuleMemoryInclusionReason): number {
  return reason.kind.length + reason.matchedValues.reduce(
    (sum, value) => sum + value.length,
    0,
  );
}

function computeOptionalNumberCost(value: number | undefined): number {
  return value === undefined ? 0 : String(value).length;
}

function listCapsuleItems(
  capsule: Pick<Capsule, "pivots" | "supportingItems">,
): CapsuleItem[] {
  return [...capsule.pivots, ...capsule.supportingItems];
}
